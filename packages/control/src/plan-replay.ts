import type { BoardPlan, LeadQuestion, Milestone, PlanProposal, Principal } from '@pantheon/domain';
import type { PlanReplay, PlanReplayFrame, PlanReplayTaskStatus } from '@pantheon/protocol';
import { projectAccess, type ControlContext } from './context.js';
import { taskGeneration } from './board-plan.js';
import { triggerText, type ReplanFired } from './replan.js';

const REPLAY_KINDS: PlanReplayFrame['kind'][] = [
  'board.plan_updated',
  'board.replan_triggered',
  'lead.question_asked',
  'lead.question_answered',
  'lead.question_overruled',
  'board.plan_proposed',
  'board.plan_proposal_resolved',
  'board.plan_proposal_withdrawn',
  'task.dispatched',
  'session.merged',
  'task.accepted',
  'milestone.accepted',
];

type Statuses = Map<string, { status: PlanReplayTaskStatus; generation: number }>;

/**
 * The lead's plan events in sequence order, each with the plan's task statuses at that point: the
 * first `limit` after `after`, or the last `limit` before `before` when it is given.
 */
export function planReplay(
  ctx: ControlContext,
  principal: Principal,
  leadId: string,
  after: number,
  limit: number,
  before?: number,
): PlanReplay {
  const projectId = ctx.store.must<BoardPlan>('board_plans', leadId).project_id;
  projectAccess(ctx, principal, projectId, 'project.read');
  let plan: BoardPlan | undefined;
  // By task id, with the task generation the status was reached in; replaced, not changed, so a frame keeps its own.
  let statuses: Statuses = new Map();
  // The dispatched sessions of each task not merged yet, and the task each session was opened for.
  const parts = new Map<string, Set<string>>(),
    sessionTask = new Map<string, string>(),
    frames: (Omit<PlanReplayFrame, 'tasks'> & { plan?: BoardPlan; statuses: Statuses })[] = [];
  for (const event of ctx.store.kindEvents(projectId, REPLAY_KINDS)) {
    const p = event.payload as Record<string, unknown>,
      onPlan = event.aggregate_id === leadId;
    let taskId: string | undefined,
      text: string | undefined,
      sessionId: string | undefined,
      decision: PlanReplayFrame['decision'];
    if (event.kind === 'board.plan_updated') {
      if (!onPlan) continue;
      plan = event.payload as BoardPlan;
      text = plan.headline;
    } else if (event.kind === 'board.replan_triggered') {
      if (!onPlan) continue;
      text = triggerText(event.payload as ReplanFired);
    } else if (event.kind.startsWith('lead.question_')) {
      if (!onPlan) continue;
      const question = event.payload as LeadQuestion;
      text = event.kind === 'lead.question_asked' ? question.question : question.answer?.text;
    } else if (event.kind.startsWith('board.plan_propos')) {
      if (!onPlan) continue;
      const proposal = event.payload as PlanProposal;
      text = proposal.reason;
      if (event.kind === 'board.plan_proposal_resolved')
        decision = proposal.status as PlanReplayFrame['decision'];
    } else if (event.kind === 'task.dispatched') {
      if (!onPlan) continue;
      taskId = p.task_id as string;
      sessionId = p.session_id as string;
      const sessions = (p.session_ids as string[] | undefined) ?? [sessionId];
      for (const id of sessions) sessionTask.set(id, taskId);
      parts.set(taskId, new Set(sessions));
      statuses = new Map(statuses).set(taskId, {
        status: 'dispatched',
        generation: taskGeneration(plan, taskId),
      });
    } else if (event.kind === 'session.merged') {
      sessionId = event.aggregate_id;
      if (onPlan && p.direct === true) {
        taskId = p.task_id as string;
        statuses = new Map(statuses).set(taskId, {
          status: 'merged',
          generation: p.generation as number,
        });
      } else {
        taskId = sessionTask.get(event.aggregate_id);
        if (!taskId) continue;
        const open = parts.get(taskId)!;
        open.delete(event.aggregate_id);
        const status = statuses.get(taskId)!;
        if (!open.size) statuses = new Map(statuses).set(taskId, { ...status, status: 'merged' });
      }
    } else if (event.kind === 'task.accepted') {
      if (!onPlan) continue;
      taskId = p.task_id as string;
      statuses = new Map(statuses).set(taskId, {
        status: 'accepted',
        generation: (p.generation as number | undefined) ?? 1,
      });
    } else {
      const milestone = event.payload as Milestone;
      if (milestone.owner_session_id !== leadId) continue;
      text = milestone.title;
    }
    frames.push({
      sequence: event.sequence,
      at: event.created_at,
      kind: event.kind as PlanReplayFrame['kind'],
      ...(taskId ? { task_id: taskId } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(event.kind === 'board.plan_updated' && p.trigger_event ? { replan: true as const } : {}),
      ...(decision ? { decision } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
      plan,
      statuses,
    });
  }
  const page =
    before === undefined
      ? frames.filter((frame) => frame.sequence > after).slice(0, limit)
      : frames.filter((frame) => frame.sequence < before).slice(-limit);
  const last = page.at(-1);
  return {
    frames: page.map(({ plan, statuses, ...frame }) => ({
      ...frame,
      tasks: (plan?.tasks ?? []).map((task) => {
        const reached = statuses.get(task.id);
        return {
          id: task.id,
          title: task.title,
          lane: task.lane,
          depends_on: task.depends_on,
          status:
            reached && reached.generation === taskGeneration(plan, task.id)
              ? reached.status
              : 'planned',
        };
      }),
    })),
    next_after: last && last !== frames.at(-1) ? last.sequence : null,
    total: frames.length,
    last_at: frames.at(-1)?.at ?? null,
  };
}
