import {
  DomainError,
  requireThat,
  type Approval,
  type BoardPlan,
  type NeedsYouItem,
  type Principal,
  type Project,
  type Session,
  type SessionTurn,
} from '@pantheon/domain';
import type { ControlContext } from './context.js';
import {
  awaitingChange,
  boardTaskId,
  currentBinding,
  taskGeneration,
  taskSessions,
  taskState,
} from './board-plan.js';
import { usageLimitWaiting } from './continuation.js';
import { pendingApprovalItems, settledApprovalItems } from './needs-you-approvals.js';
import { sessionItems } from './needs-you-sessions.js';
import { milestoneItems, planItems } from './needs-you-plans.js';
import {
  agentProposalItems,
  definitionTrialItems,
  improvementItems,
  projectBudgetItems,
  stepRunItems,
} from './needs-you-workflow.js';

/** A running merge with no progress event for this long is stuck; each gate command has a timeout. */
const MERGE_STUCK_MS = 30 * 60_000;
const MERGE_PROGRESS = ['session.merge_started', 'session.gate_started', 'session.gate_checked'];

/** A stop whose process has not confirmed it stopped for this long needs the user. */
export const STOP_UNCONFIRMED_MS = 2 * 60_000;

/** Session items listed under the session.failed kind, told apart by their reason. */
export type SessionAttention =
  | 'merge_stuck'
  | 'lead_turn_failed'
  | 'continuation_limit_reached'
  | 'workspace_reconciling'
  | 'stop_unconfirmed'
  | 'task_retired'
  | 'task_turn_looping'
  | 'task_turn_stalled'
  | 'lead_turn_looping'
  | 'lead_turn_stalled'
  | 'usage_limit_waiting'
  | 'background_task_long';

export const NEXT_STEP: Record<
  | SessionAttention
  | 'lead_closed'
  | 'lead_wake_limited'
  | 'task_dispatch_failed'
  | 'task_upstream_stuck'
  | 'lead_permission'
  | 'milestone_ready_for_acceptance'
  | 'improvement_awaiting_decision'
  | 'plan_proposal_awaiting_decision'
  | 'agent_proposal_awaiting_decision',
  string
> = {
  merge_stuck: 'The user checks the stuck merge and cancels it if needed.',
  stop_unconfirmed:
    "The session's process has not confirmed it stopped; the user confirms the process stopped, or retries the stop.",
  workspace_reconciling:
    'A daemon restart interrupted the workspace setup, so whether its Git processes stopped is unknown; the user reconciles: once no Git process is still running in the workspace, discard this session.',
  continuation_limit_reached:
    'The automatic continuations are used up; the user sends the session a message to go on.',
  lead_turn_failed: 'The user retries, or sends the lead a message to go on.',
  lead_closed:
    'The lead is closed; the user reopens it, or hands the plan to a new lead with a board sync.',
  lead_wake_limited:
    'Board updates woke the lead too often in a short time, so Pantheon stopped waking it; the updates stay in its inbox and waking resumes in a few minutes. The user checks whether the lead is spinning and, if needed, sends it a message to correct course.',
  usage_limit_waiting:
    'The session used up its subscription limit; Pantheon has it go on once the limit resets and opens no new turn until then. The user waits for the reset, or moves it to another runtime.',
  task_dispatch_failed:
    "Pantheon retries with backoff; the lead can change the task's runtime, and the user can check why this runtime is unavailable.",
  task_upstream_stuck:
    'The queued task waits on a dependency nobody moves forward, and the lead was reminded; the user checks why the dependency stopped and has the lead restart or change it, or stops the queued task.',
  task_retired:
    "The lead removed the session's task from the plan (the same id may now be a new task), so its changes no longer merge; the user checks the changes, then discards this session.",
  task_turn_looping:
    "The task session's turn still repeats the same tool call after the lead was reminded; the user interrupts the turn, or sends the lead a message to correct course.",
  task_turn_stalled:
    "The task session's turn stalled and the lead has not handled it since it was reminded; the user interrupts the turn, or sends the lead a message to handle it.",
  lead_turn_looping:
    "The lead's turn repeats the same tool call; the user interrupts the turn, then sends the lead a message to correct course.",
  lead_turn_stalled:
    "The lead's turn has made no progress for a long time, or a tool call never ended; the user interrupts the turn, then sends the lead a message to go on.",
  lead_permission:
    "This is the lead's own permission request; its turn waits for the answer and gets no task session reports meanwhile. The lead goes on once the user allows or denies it.",
  milestone_ready_for_acceptance:
    "The milestone's tasks are all done; the user checks its acceptance criteria and accepts it, or tells the lead what is still missing.",
  improvement_awaiting_decision:
    'The improvement proposal awaits the user; the user confirms it to start a trial, or rejects it.',
  plan_proposal_awaiting_decision:
    'The plan proposal awaits the user; the user accepts it, changes its ops before accepting, or rejects it.',
  agent_proposal_awaiting_decision:
    'An agent proposes to create or change an agent; the user creates it, edits its fields before creating it, or declines it.',
  background_task_long:
    'A background command or agent of the session has run for 30 minutes; the user stops it, or waits for it to end.',
};

/** The aggregate's latest event of kind. */
export function latestEvent(
  ctx: ControlContext,
  aggregateId: string,
  kind: string,
): { sequence: number; created_at: number; payload: string } | undefined {
  return ctx.store.db
    .prepare(
      'SELECT sequence, created_at, payload FROM events WHERE aggregate_id=? AND kind=? ORDER BY sequence DESC LIMIT 1',
    )
    .get(aggregateId, kind) as
    { sequence: number; created_at: number; payload: string } | undefined;
}

/** The latest progress event of the session's running merge, when it is old enough to be stuck. */
export function stuckMerge(
  ctx: ControlContext,
  session: Session,
): { sequence: number; created_at: number } | undefined {
  if (session.merge?.state !== 'running') return;
  const progress = ctx.store.db
    .prepare(
      `SELECT sequence, created_at FROM events WHERE aggregate_id=? AND kind IN (${MERGE_PROGRESS.map(() => '?').join(',')}) ORDER BY sequence DESC LIMIT 1`,
    )
    .get(session.id, ...MERGE_PROGRESS) as { sequence: number; created_at: number } | undefined;
  return progress && ctx.store.now() - progress.created_at > MERGE_STUCK_MS ? progress : undefined;
}

/** The skip that hit the continuation limit, while the session has had no turn since. */
export function continuationLimit(
  ctx: ControlContext,
  sessionId: string,
): { created_at: number } | undefined {
  const skip = ctx.store.db
    .prepare(
      "SELECT sequence, created_at FROM events WHERE aggregate_id=? AND kind='session.continuation_skipped' AND json_extract(payload,'$.reason')='limit_reached' ORDER BY sequence DESC LIMIT 1",
    )
    .get(sessionId) as { sequence: number; created_at: number } | undefined;
  if (!skip) return;
  const later = ctx.store.db
    .prepare(
      "SELECT 1 FROM events WHERE kind='turn.queued' AND json_extract(payload,'$.session_id')=? AND sequence>? LIMIT 1",
    )
    .get(sessionId, skip.sequence);
  return later ? undefined : skip;
}

/** True once the turn started running. */
export function ran(ctx: ControlContext, turn: SessionTurn): boolean {
  return latestEvent(ctx, turn.id, 'turn.running') !== undefined;
}

/** A steer delivered into a running turn, or refused by it, never runs as a turn of its own. */
export function executed(ctx: ControlContext, turn: SessionTurn): boolean {
  return turn.kind !== 'steer' || ran(ctx, turn);
}

/** The session's latest turn that runs or ran as a turn of its own. */
export function latestExecuted(ctx: ControlContext, turns: SessionTurn[]): SessionTurn | undefined {
  return turns.findLast((turn) => executed(ctx, turn));
}

/** A failed lead turn is not replayed; the lead waits for its next message. */
export function leadTurnFailed(
  ctx: ControlContext,
  lead: Session,
  latest: SessionTurn | undefined,
): boolean {
  return lead.state === 'open' && latest?.state === 'failed' && !usageLimitWaiting(ctx, lead.id);
}

/** The command as an action, disabled with the code of the error its check throws. */
export function action(command: string, check: () => void): NeedsYouItem['actions'][number] {
  try {
    check();
    return { command, allowed: true };
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return { command, allowed: false, disabled_reason: error.code };
  }
}

/** A lost request stays open until its session starts a turn after the one that raised it. */
export function lostRequestOpen(ctx: ControlContext, approval: Approval): boolean {
  const session = ctx.store.get<Session>('sessions', approval.session_id ?? '');
  if (!approval.turn_id || !session || session.archived_at || session.outcome) return false;
  const turns = ctx.store
    .list<SessionTurn>('session_turns')
    .filter((turn) => turn.session_id === session.id);
  return !turns
    .slice(turns.findIndex((turn) => turn.id === approval.turn_id) + 1)
    .some((turn) => turn.state !== 'queued' && turn.state !== 'cancelled' && executed(ctx, turn));
}

/** What every builder reads: who asks, and which projects are listed. */
export interface NeedsYouScope {
  principal: Principal;
  projectId: string | undefined;
  removed: Set<string>;
  listedProject: (id: string) => boolean;
}

/** An item as a builder makes it; needsYou counts the tasks it blocks. */
export type NeedsYouDraft = Omit<NeedsYouItem, 'blocks'>;

/** The plan task an item is about: its own task, else its session's task, else its lead's direct task. */
export function itemTask(
  ctx: ControlContext,
  item: Pick<NeedsYouItem, 'source' | 'session_id' | 'task_id'>,
  planOf: Map<string, BoardPlan>,
): { plan: BoardPlan; taskId: string } | undefined {
  const sessionId = item.source.table === 'sessions' ? item.source.id : item.session_id,
    session = sessionId ? ctx.store.get<Session>('sessions', sessionId) : undefined,
    named = item.task_id
      ? [...planOf.values()].flatMap((plan) =>
          plan.tasks
            .filter((task) => boardTaskId(plan.id, task.id) === item.task_id)
            .map((task) => ({ lead_session_id: plan.id, id: task.id })),
        )[0]
      : undefined,
    direct =
      session?.direct_task &&
      session.direct_task.generation ===
        taskGeneration(planOf.get(session.id), session.direct_task.id)
        ? { lead_session_id: session.id, id: session.direct_task.id }
        : undefined,
    binding = item.task_id ? named : (session?.task ?? direct),
    plan = binding ? planOf.get(binding.lead_session_id) : undefined;
  if (
    !binding ||
    !plan ||
    !plan.tasks.some((task) => task.id === binding.id) ||
    // A worker of a removed task is not the task that reuses its id.
    (binding === session?.task &&
      !currentBinding(plan, session.task) &&
      !(!session.outcome && awaitingChange(plan, session)))
  )
    return;
  return { plan, taskId: binding.id };
}

/** Counts the plan tasks not done that wait on an item: those that depend on its task, and those its lead question holds. */
function blockedTasks(
  ctx: ControlContext,
  planOf: Map<string, BoardPlan>,
): (item: NeedsYouDraft) => number {
  const sessions = ctx.store.list<Session>('sessions'),
    done = new Map<string, boolean>();
  const open = (plan: BoardPlan, taskId: string) => {
    const key = boardTaskId(plan.id, taskId);
    if (!done.has(key))
      done.set(
        key,
        taskState(
          plan,
          taskId,
          taskSessions(ctx, plan.id, taskId, sessions, plan),
          ctx.store.get<Session>('sessions', plan.id),
        ) === 'done',
      );
    return !done.get(key);
  };
  return (item) => {
    const waiting = new Set<string>(),
      bound = itemTask(ctx, item, planOf),
      asked = item.question && planOf.get(item.source.id);
    if (bound)
      for (const task of bound.plan.tasks)
        if (task.depends_on.includes(bound.taskId) && open(bound.plan, task.id))
          waiting.add(boardTaskId(bound.plan.id, task.id));
    if (asked)
      for (const task of asked.tasks)
        if (item.question!.blocks.includes(task.id) && open(asked, task.id))
          waiting.add(boardTaskId(asked.id, task.id));
    return waiting.size;
  };
}

export function needsYou(
  ctx: ControlContext,
  principal: Principal,
  projectId?: string,
): { items: NeedsYouItem[] } {
  requireThat(
    (principal.role === 'user' || principal.role === 'planner') &&
      (!principal.expires_at || principal.expires_at > ctx.store.now()),
    'permission_denied',
    'User or planner principal required',
  );
  if (principal.role === 'planner') {
    projectId ??= principal.project_id;
    requireThat(
      projectId && projectId === principal.project_id,
      'permission_denied',
      'Project principal required',
    );
  }
  const items: NeedsYouDraft[] = [];
  const removed = new Set(
    ctx.store
      .list<Project>('projects')
      .filter((project) => project.removed_at !== undefined)
      .map((project) => project.id),
  );
  const listedProject = (id: string) => !removed.has(id) && (!projectId || id === projectId);
  const scope: NeedsYouScope = { principal, projectId, removed, listedProject };
  const plans = ctx.store
    .list<BoardPlan>('board_plans')
    .filter(
      (plan) => !removed.has(plan.project_id) && (!projectId || plan.project_id === projectId),
    );
  const planOf = new Map(plans.map((plan) => [plan.id, plan]));
  items.push(...pendingApprovalItems(ctx, scope));
  if (principal.role === 'user') {
    items.push(...settledApprovalItems(ctx, scope));
    const sessions = ctx.store
      .list<Session>('sessions')
      .filter(
        (s) =>
          !s.archived_at &&
          !s.outcome &&
          !removed.has(s.project_id) &&
          (!projectId || s.project_id === projectId),
      );
    items.push(
      ...sessionItems(ctx, scope, sessions, plans, planOf),
      ...planItems(ctx, scope, plans, sessions),
      ...milestoneItems(ctx, scope, planOf),
      ...stepRunItems(ctx, scope, planOf),
      ...definitionTrialItems(ctx, scope),
      ...improvementItems(ctx, scope),
      ...agentProposalItems(ctx, scope),
      ...projectBudgetItems(ctx, scope),
    );
  }
  const blocked = blockedTasks(ctx, planOf);
  // Most tasks blocked first, then the longest waiting.
  return {
    items: items
      .map((item) => ({ ...item, blocks: blocked(item) }))
      .sort(
        (a, b) =>
          b.blocks - a.blocks ||
          a.created_at - b.created_at ||
          a.source.id.localeCompare(b.source.id),
      ),
  };
}
