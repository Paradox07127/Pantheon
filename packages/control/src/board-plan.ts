import {
  requireThat,
  type BoardPlan,
  type BoardPlanView,
  type Milestone,
  type PlanProposalView,
  type Session,
} from '@pantheon/domain';
import { ownEntry, type ControlContext } from './context.js';
import { moveTaskMemory } from './memory-access.js';
import { dispatchQueue } from './task-dispatch.js';
import { waitingStep } from './merge-review.js';

export const boardTaskId = (lead: string, id: string): string => `${lead}:${id}`;

/** The plan and task a global board task id names, within one project. */
export function boardTask(
  ctx: ControlContext,
  projectId: string,
  globalId: string,
): { plan: BoardPlan; task: BoardPlan['tasks'][number] } {
  const split = globalId.indexOf(':');
  const plan =
    split > 0 ? ctx.store.get<BoardPlan>('board_plans', globalId.slice(0, split)) : undefined;
  const task = plan?.tasks.find((candidate) => candidate.id === globalId.slice(split + 1));
  requireThat(plan && task, 'not_found', `Not found: board task ${globalId}`);
  requireThat(
    plan.project_id === projectId,
    'scope_violation',
    `Board task ${globalId} belongs to another project`,
  );
  return { plan, task };
}

/** The task's current generation; plans and sessions written before generations are in the first. */
export const taskGeneration = (plan: BoardPlan | undefined, taskId: string): number =>
  ownEntry(plan?.generations, taskId)?.generation ?? 1;

/** True when the session works on the current generation of its task. */
export const currentBinding = (plan: BoardPlan | undefined, task: NonNullable<Session['task']>) =>
  (task.generation ?? 1) === taskGeneration(plan, task.id);

/**
 * True while a change of the task's contract has yet to reach the session: it keeps the generation
 * it works on until the change is delivered to it.
 */
export function awaitingChange(plan: BoardPlan | undefined, session: Session): boolean {
  const task = session.task;
  if (!task || !plan?.contract_changed?.includes(session.id)) return false;
  const generation = task.generation ?? 1;
  return (
    plan.tasks.some((candidate) => candidate.id === task.id) &&
    generation > (ownEntry(plan.retired, task.id) ?? 0) &&
    generation < taskGeneration(plan, task.id)
  );
}

/** True when the session works on a removed generation of its task, even if a new task reuses the id. */
export function retiredBinding(plan: BoardPlan | undefined, session: Session): boolean {
  const task = session.task;
  if (!task) return false;
  return (
    (task.generation ?? 1) <= (ownEntry(plan?.retired, task.id) ?? 0) ||
    (!currentBinding(plan, task) && !awaitingChange(plan, session))
  );
}

/** The lead's acceptance of the task's current generation, if any. */
export function currentAcceptance(
  plan: BoardPlan | undefined,
  taskId: string,
): NonNullable<BoardPlan['accepted']>[string] | undefined {
  const accepted = ownEntry(plan?.accepted, taskId);
  return accepted && (accepted.generation ?? 1) === taskGeneration(plan, taskId)
    ? accepted
    : undefined;
}

/** The lead's direct merge of the task's current generation, if any. */
export function currentDirectMerge(
  plan: BoardPlan | undefined,
  taskId: string,
): NonNullable<BoardPlan['direct_merged']>[string] | undefined {
  const merged = ownEntry(plan?.direct_merged, taskId);
  return merged && merged.generation === taskGeneration(plan, taskId) ? merged : undefined;
}

/**
 * Workbench sessions opened from the task's current generation, without discarded ones, and those
 * without an outcome that a change of its contract has yet to reach.
 */
export function taskSessions(
  ctx: ControlContext,
  leadId: string,
  taskId: string,
  sessions: Session[] = ctx.store.list<Session>('sessions'),
  // The lead's stored plan, when the caller read it since the last write.
  plan: BoardPlan | undefined = ctx.store.get<BoardPlan>('board_plans', leadId),
): Session[] {
  return sessions.filter(
    (session) =>
      session.task?.lead_session_id === leadId &&
      session.task.id === taskId &&
      (currentBinding(plan, session.task)
        ? session.outcome !== 'discarded'
        : !session.outcome && awaitingChange(plan, session)),
  );
}

/** A parallel session works on its assigned part of the parent task's contract. */
export function sessionPlanTask(plan: BoardPlan, session: Session) {
  const task = plan.tasks.find((task) => task.id === (session.task ?? session.direct_task)?.id);
  const part =
    session.task?.parallel_index === undefined
      ? undefined
      : task?.parallel?.[session.task.parallel_index];
  return task && part ? { ...task, ...part } : task;
}

/**
 * A report task is done once the lead accepts it, whatever its sessions; a direct task once the lead
 * merged it, and active while the plan's lead works on it; others once all their sessions merged.
 */
export function taskState(
  plan: BoardPlan | undefined,
  taskId: string,
  sessions: Session[],
  lead?: Session,
): 'todo' | 'active' | 'done' {
  if (currentAcceptance(plan, taskId)) return 'done';
  // A session opened to follow up on the merge keeps the task under way until it ends.
  if (currentDirectMerge(plan, taskId))
    return sessions.some((session) => session.task && !session.outcome) ? 'active' : 'done';
  if (
    lead?.direct_task?.id === taskId &&
    lead.direct_task.generation === taskGeneration(plan, taskId)
  )
    return 'active';
  if (!sessions.length) return 'todo';
  if (plan?.tasks.find((task) => task.id === taskId)?.done_when === 'report') return 'active';
  return sessions.every((session) => session.outcome === 'merged') ? 'done' : 'active';
}

/** True when the session owns a board plan with a task that is not done. */
export function planUnfinished(ctx: ControlContext, leadId: string): boolean {
  const plan = ctx.store.get<BoardPlan>('board_plans', leadId),
    lead = ctx.store.get<Session>('sessions', leadId);
  return !!plan?.tasks.some(
    (task) => taskState(plan, task.id, taskSessions(ctx, leadId, task.id), lead) !== 'done',
  );
}

export function pendingProposals(plan: BoardPlan): PlanProposalView[] {
  return (plan.pending_proposals ?? [])
    .filter((proposal) => proposal.status === 'pending')
    .map((proposal) => ({
      id: proposal.proposal_id,
      lead_session_id: plan.id,
      reason: proposal.reason,
      ops: proposal.ops,
      base_version: proposal.base_version,
      created_at: proposal.created_at,
      task_ids: [
        ...new Set(
          proposal.ops.flatMap((op) =>
            op.type === 'set_iterations' || op.type === 'set_milestone'
              ? []
              : [op.type === 'add_task' ? op.task.id : op.task_id],
          ),
        ),
      ].filter((id) => plan.tasks.some((task) => task.id === id)),
    }));
}

export function planViews(ctx: ControlContext, projectId: string): BoardPlanView[] {
  const waiting = new Map(
    dispatchQueue(ctx, projectId).map(({ plan, task, wait }) => [
      boardTaskId(plan.id, task.id),
      wait,
    ]),
  );
  const listed = ctx.store.list<Session>('sessions');
  return ctx.store
    .list<BoardPlan>('board_plans')
    .filter((plan) => plan.project_id === projectId)
    .map((plan) => ({
      lead_session_id: plan.id,
      lead_title: ctx.store.get<Session>('sessions', plan.id)?.title ?? '',
      headline: plan.headline,
      plan_version: plan.plan_version,
      pending_edits: [],
      lanes: plan.lanes,
      iterations: plan.iterations ?? [],
      tasks: plan.tasks.map((task) => {
        const sessions = taskSessions(ctx, plan.id, task.id, listed, plan);
        const wait = waiting.get(boardTaskId(plan.id, task.id));
        const step = waitingStep(ctx, plan, task);
        return {
          ...task,
          session_ids: sessions.map((session) => session.id),
          ...(wait ? { dispatch_wait: wait } : {}),
          ...(step ? { waiting_step: step } : {}),
          state: taskState(plan, task.id, sessions, ctx.store.get<Session>('sessions', plan.id)),
        };
      }),
      risks: plan.risks,
      assumptions: plan.assumptions,
      ...(plan.paused ? { paused: { at: plan.paused.at } } : {}),
      ...(plan.reassessment ? { reassessment: plan.reassessment } : {}),
      updated_at: plan.updated_at,
    }));
}

/** Moves an ended lead's plan, its milestones and its task sessions to another lead. */
export function transferPlan(
  ctx: ControlContext,
  plan: BoardPlan,
  to: string,
  cause: string,
): void {
  ctx.store.remove('board_plans', plan.id, plan.revision);
  const moved = ctx.store.insert<BoardPlan>('board_plans', { ...plan, id: to, revision: 1 });
  for (const milestone of ctx.store.list<Milestone>('milestones'))
    if (milestone.owner_session_id === plan.id)
      ctx.store.update('milestones', { ...milestone, owner_session_id: to }, milestone.revision);
  for (const session of ctx.store.list<Session>('sessions'))
    if (session.task?.lead_session_id === plan.id)
      ctx.store.update(
        'sessions',
        { ...session, task: { ...session.task, lead_session_id: to } },
        session.revision,
      );
  moveTaskMemory(ctx, plan.project_id, plan.id, to);
  ctx.store.event('board.plan_transferred', moved, plan.project_id, { from: plan.id }, cause);
}
