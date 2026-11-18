import {
  DomainError,
  requireThat,
  type Approval,
  type BackgroundTask,
  type BoardPlan,
  type LeadNote,
  type Principal,
  type Project,
  type ProjectBaseline,
  type Session,
  type SessionTurn,
  type TurnSkill,
  type Workspace,
} from '@pantheon/domain';
import { inputSchemas, type Command } from '@pantheon/protocol';
import {
  gitFolderAsync,
  insert,
  projectAccess,
  userOnly,
  type ControlContext,
  type Handler,
  type Handlers,
} from './context.js';
import { autoMerge } from './user-config.js';
import { gateCommands } from './landing.js';
import { relayingQuestion } from './approvals.js';
import { charterMode } from './charter.js';
import { runGit, type GitResult } from './git.js';
import {
  appendNote,
  blockedReport,
  contractMoveWaits,
  DIGEST_BUDGET,
  foldDigest,
  followContractModel,
  followContractRuntime,
  recordNote,
  takeContractChange,
  takeInbox,
} from './lead-inbox.js';
import { openResident } from './resident.js';
import { wrapUpOverBudget } from './budget-wrap-up.js';
import { usageLimitWaiting, usageResetAt } from './continuation.js';
import {
  currentAcceptance,
  currentBinding,
  ownEntry,
  planViews,
  retiredBinding,
  taskGeneration,
  taskSessions,
  taskState,
  transferPlan,
} from './board-plan.js';
import {
  causeTurn,
  chainDepth,
  LOOP_CALLS,
  longBackground,
  nextDepth,
  sessionLoop,
  STALL_MS,
  stalled,
  turnActivity,
  turnLoop,
  type TurnLoop,
} from './progress.js';
import {
  acceptInput,
  advanceQueuedHandoffs,
  queuedTurn,
  releaseIdleConversation,
  taskReportGeneration,
  unsnooze,
} from './session.js';
import {
  dispatchQueue,
  dispatchTasks,
  placedTaskSessions,
  placementRows,
  selectedParts,
  taskPlaces,
} from './task-dispatch.js';
import { executed, stuckMerge } from './needs-you.js';
import { finishingMerge } from './project-facts.js';
import { finishStops } from './workbench-session.js';
import { projectOverBudget, workflowPolicy } from './workflow-policy.js';
import {
  advanceSteps,
  afterMergeHolds,
  readMergeConditions,
  type ConditionAnswers,
} from './workflow-engine.js';

type Tracked = BoardPlan['notified'][string];
type Alert = NonNullable<BoardPlan['alerted']>[string][number];

const TRACKED_TEXT: Record<Tracked | 'stalled' | 'looping', string> = {
  merged: 'The session merged into its source.',
  blocked: 'The merge of the session is blocked.',
  failed: 'The session ended without a merge.',
  waiting: 'The session waits for the user to answer a permission request.',
  turn_failed: 'The latest turn of the session failed.',
  no_changes: 'The session ended its turn again without commits to merge.',
  stalled: 'The running turn of the session makes no progress.',
  looping: 'The running turn of the session repeats a failing tool call.',
};
const INBOX_LIMIT = 32;
/** While another task session works, a wake for merges waits this long after the first, so close merges share one turn. */
const MERGE_WAKE_MS = 30_000;
/** Tracker turns one lead may be given within WAKE_WINDOW_MS; later wakes wait in the inbox. */
const WAKE_LIMIT = 10;
/** The window of WAKE_LIMIT, in milliseconds. */
const WAKE_WINDOW_MS = 10 * 60_000;
/** Merge problems a task session is given turns to fix before the lead hears of them. */
const HANDED_BACK = [
  'rebase_conflict',
  'gate_failed',
  'uncommitted_changes',
  'no_changes',
  'out_of_scope',
  'protected_paths',
  'merge_commits',
];
/** Merge problems of its direct task a lead is given turns to fix; after a fix it reports the task again. */
const DIRECT_HANDED_BACK = [...HANDED_BACK, 'head_moved', 'verification_changed'];
/** A permission request unanswered this long, in milliseconds, is escalated once: the user and the lead are reminded. */
const ESCALATION_MS = 10 * 60_000;
const BACKGROUND_TEXT: Record<BackgroundTask['kind'], string> = {
  shell: 'command',
  agent: 'agent',
  other: 'task',
};
const INTERRUPTED_TEXT =
  '[Pantheon] Your direct task was released, and your runtime cannot take write access from a running turn, so Pantheon interrupted that turn. Go on with the rest of it: your turns are read-only until you start a task again.';
const LOOP_TEXT: Record<TurnLoop['form'], string> = {
  failing: 'repeats a failing tool call',
  repeating: 'repeats a tool call with no other progress',
  alternating: 'alternates between two failing tool calls',
};

const reportDone = (plan: BoardPlan, note: Pick<LeadNote, 'kind' | 'task_id'>) =>
  note.kind === 'done' &&
  plan.tasks.find((task) => task.id === note.task_id)?.done_when === 'report';

/** True when a task session reported the task's current generation done. */
export function doneReported(ctx: ControlContext, plan: BoardPlan, taskId: string): boolean {
  const rows = ctx.store.db
    .prepare(
      "SELECT payload FROM events WHERE project_id=? AND kind='task.reported' AND json_extract(payload,'$.kind')='done' AND json_extract(payload,'$.task_id')=? AND coalesce(json_extract(payload,'$.generation'),1)=?",
    )
    .all(plan.project_id, taskId, taskGeneration(plan, taskId)) as { payload: string }[];
  return rows.some((row) => {
    const note = JSON.parse(row.payload) as LeadNote;
    const reporter = ctx.store.get<Session>('sessions', note.session_id),
      binding = reporter?.task;
    return (
      // A report from stopped work is no evidence.
      reporter?.outcome !== 'discarded' &&
      !reporter?.stop_requested &&
      binding?.lead_session_id === plan.id &&
      binding.id === taskId &&
      currentBinding(plan, binding)
    );
  });
}

/** A note that wakes the lead instead of waiting for its next message. */
const wakingNote = (plan: BoardPlan, note: LeadNote) =>
  note.kind in TRACKED_TEXT ||
  note.kind === 'requirement' ||
  note.kind === 'answer' ||
  note.kind === 'worker_question' ||
  note.kind === 'external' ||
  note.kind === 'follow_up' ||
  note.kind === 'routine' ||
  note.kind === 'agent_proposal' ||
  note.kind === 'agent_report' ||
  note.kind === 'signal' ||
  note.kind === 'usage_reset' ||
  note.kind === 'dispatch_failed' ||
  note.kind === 'review_completed' ||
  note.kind === 'review_failed' ||
  note.kind === 'plan_review_completed' ||
  note.kind === 'plan_review_failed' ||
  (note.kind === 'user_edit' && (note.edit?.wake === true || note.edit?.applied === false)) ||
  reportDone(plan, note);

/** True while the task waits for a session, or has one that has neither merged nor been discarded. */
function taskUnderWay(ctx: ControlContext, plan: BoardPlan, taskId: string): boolean {
  if (currentAcceptance(plan, taskId)) return false;
  if (ownEntry(plan.dispatch, taskId)) return true;
  return ctx.store
    .list<Session>('sessions')
    .some(
      (session) =>
        session.workspace_id &&
        session.task?.lead_session_id === plan.id &&
        session.task.id === taskId &&
        !retiredBinding(plan, session) &&
        !session.outcome,
    );
}

/**
 * True when the plan has waking notes other than merges, or merges the workflow policy wakes the
 * lead for: at once while no other task session of the plan runs a turn or merges, else once the
 * first is MERGE_WAKE_MS old. With milestone wakes, a merge waits while a task of its milestone is
 * under way; a task the lead has not started holds no wake, since only the lead starts it.
 */
function wakeDue(ctx: ControlContext, plan: BoardPlan): boolean {
  const waking = plan.inbox.filter(
    (note) =>
      wakingNote(plan, note) &&
      !finishingMerge(ctx, plan, note) &&
      !((note.kind === 'merged' || reportDone(plan, note)) && afterMergeHolds(ctx, plan, note)),
  );
  if (!waking.length) return false;
  if (waking.some((note) => note.kind !== 'merged')) return true;
  const merges =
    workflowPolicy(ctx, plan.project_id).acceptance_wake === 'milestone'
      ? waking.filter((note) => {
          const milestone = plan.tasks.find((task) => task.id === note.task_id)?.milestone;
          return (
            !milestone ||
            plan.tasks.every(
              (task) => task.milestone !== milestone || !taskUnderWay(ctx, plan, task.id),
            )
          );
        })
      : waking;
  if (!merges.length) return false;
  const busy = ctx.store
    .list<Session>('sessions')
    .some(
      (session) =>
        session.task?.lead_session_id === plan.id &&
        session.workspace_id &&
        !session.outcome &&
        (session.state === 'running' || session.merge?.state === 'running'),
    );
  return !busy || ctx.store.now() - Math.min(...merges.map((note) => note.at)) >= MERGE_WAKE_MS;
}

/** The state the lead hears of, by the rules of sessionList without reading Git. */
function trackedState(
  ctx: ControlContext,
  session: Session,
  waiting: ReadonlySet<string | undefined>,
  latestTurns: ReadonlyMap<string, SessionTurn>,
  skipped: string | undefined,
): Tracked | undefined {
  if (session.outcome) return session.outcome === 'merged' ? 'merged' : undefined;
  // The turn a stop ends is no failure; the discard that follows tells the lead if it did not ask.
  if (session.stop_requested) return;
  if (session.merge?.state === 'running') return;
  if (session.merge?.state === 'blocked')
    return ['cancelled', 'workflow_approval'].includes(session.merge.reason ?? '')
      ? undefined
      : 'blocked';
  const workspace = ctx.store.get<Workspace>('workspaces', session.workspace_id!),
    // A folder session is never provisioned.
    provisioning = workspace?.kind === 'in_place' ? 'ready' : workspace?.provisioning?.state;
  if (provisioning === 'failed' || provisioning === 'cancelled' || session.state === 'closed')
    return 'failed';
  if (provisioning !== 'ready') return;
  if (skipped) return skipped === 'no_changes' ? 'no_changes' : 'blocked';
  if (
    session.state === 'open' &&
    latestTurns.get(session.id)?.state === 'failed' &&
    !usageLimitWaiting(ctx, session.id)
  )
    return 'turn_failed';
  return waiting.has(session.id) ? 'waiting' : undefined;
}

function trackedText(
  ctx: ControlContext,
  session: Session,
  state: Tracked,
  latestTurns: ReadonlyMap<string, SessionTurn>,
  skipped: string | undefined,
): string {
  const reason =
    state === 'blocked'
      ? (session.merge?.reason ?? skipped)
      : state === 'turn_failed'
        ? turnError(ctx, latestTurns.get(session.id)!)
        : undefined;
  const gate = session.merge?.gate;
  if (state === 'blocked' && session.merge?.failure_class === 'environment' && gate)
    return `${TRACKED_TEXT[state]} Reason: ${reason}. The gate command "${gate.name}" failed because of the environment it ran in (it timed out, could not start or was killed), also when run again on the same commit; the session was not asked to fix it.`;
  if (
    state === 'turn_failed' &&
    turnErrorCode(ctx, latestTurns.get(session.id)!) === 'turn_deadline'
  )
    return `${TRACKED_TEXT[state]}${reason ? ` Reason: ${reason}.` : ''} The turn reached its wall-clock time limit. The uncommitted changes in its worktree are still there; another message to the session continues where it stopped.`;
  const mergedBy =
    state === 'blocked' && session.merge?.conflict_tasks?.length
      ? `; the conflicting files were merged by ${session.merge.conflict_tasks.map((taskId) => taskLabel(ctx, taskId, readerPlan(session))).join(', ')}`
      : '';
  if (state === 'blocked' && reason === 'out_of_scope')
    return `${TRACKED_TEXT[state]} Reason: out_of_scope${mergedBy}. To merge the files anyway, call merge_task with allow_out_of_scope and the reason; or widen the scope of the task with update_board; or stop it with stop_task.`;
  if (state === 'blocked' && reason === 'verification_changed')
    return `${TRACKED_TEXT[state]} Reason: verification_changed. The diff weakens tests or changes acceptance inputs or gate/CI configuration. Revert these changes, or explicitly list the files in the task scope with update_board before merging: ${(session.merge?.conflicts ?? []).join(', ')}.`;
  return reason ? `${TRACKED_TEXT[state]} Reason: ${reason}${mergedBy}` : TRACKED_TEXT[state];
}

/** The error code the runtime gave when the turn ended; the turn row does not keep it. */
function turnErrorCode(ctx: ControlContext, turn: SessionTurn): string | undefined {
  const row = ctx.store.db
    .prepare(
      "SELECT payload FROM events WHERE aggregate_id=? AND kind='agent.turn.completed' AND json_extract(payload,'$.turn_id')=? ORDER BY sequence DESC LIMIT 1",
    )
    .get(turn.session_id, turn.id) as { payload: string } | undefined;
  return row && (JSON.parse(row.payload) as { error_code?: string }).error_code;
}

/** The error in the turn's latest turn.failed event; the turn row does not keep it. */
function turnError(ctx: ControlContext, turn: SessionTurn): string | undefined {
  const event = latestEvent(ctx, turn.id, 'turn.failed');
  return (event?.payload as { error?: string } | undefined)?.error;
}

/** The aggregate's latest event of kind. */
function latestEvent(
  ctx: ControlContext,
  aggregateId: string,
  kind: string,
): { sequence: number; created_at: number; payload: unknown } | undefined {
  const row = ctx.store.db
    .prepare(
      'SELECT sequence, created_at, payload FROM events WHERE aggregate_id=? AND kind=? ORDER BY sequence DESC LIMIT 1',
    )
    .get(aggregateId, kind) as
    { sequence: number; created_at: number; payload: string } | undefined;
  return row && { ...row, payload: JSON.parse(row.payload) };
}

/** The merge the automatic merge skipped after the session's latest turn, while it stays idle. */
function skippedMerge(
  ctx: ControlContext,
  plan: BoardPlan,
  session: Session,
  turn: SessionTurn | undefined,
): string | undefined {
  if (
    !turn ||
    turn.state !== 'completed' ||
    session.state !== 'open' ||
    session.merge ||
    session.outcome ||
    plan.tasks.find((task) => task.id === session.task!.id)?.done_when === 'report'
  )
    return;
  const skip = latestEvent(ctx, session.id, 'session.merge_skipped')?.payload as
    { reason: string; turn_id: string } | undefined;
  return skip?.turn_id === turn.id ? skip.reason : undefined;
}

/** The session's latest merge was the automatic one; a merge the user started stays the user's to follow up. */
function startedByDaemon(ctx: ControlContext, session: Session): boolean {
  const started = latestEvent(ctx, session.id, 'session.merge_started');
  return !!started && (started.payload as { auto?: boolean }).auto === true;
}

/** The merge the automatic merge skipped after the latest turn, and the problem the tracker follows up: that skip or a block of the merge it started. */
export function mergeProblem(
  ctx: ControlContext,
  plan: BoardPlan,
  session: Session,
  latestTurn: SessionTurn | undefined,
): { skipped: string | undefined; problem: string | undefined } {
  const skipped = skippedMerge(ctx, plan, session, latestTurn);
  return {
    skipped,
    problem:
      session.merge?.state === 'blocked' && !session.outcome && startedByDaemon(ctx, session)
        ? session.merge.reason
        : skipped,
  };
}

export interface HandBackCheck {
  allowed: boolean;
  /** Hand-backs of this problem to the session so far. */
  used: number;
  limit: number;
  held?: 'usage_limit' | 'project_budget';
}

/** Whether the tracker hands the merge problem back to the session; an allowed one is held while a turn would fail or spend over the budget. */
export function handBackAllowed(
  ctx: ControlContext,
  plan: BoardPlan,
  session: Session,
  problem: string,
  lastHandBackText: string | undefined,
  latestTurn: SessionTurn | undefined,
): HandBackCheck {
  const policy = workflowPolicy(ctx, plan.project_id),
    used = (ownEntry(plan.handed_back, session.id) ?? []).filter(
      (reason) => reason === problem,
    ).length,
    limit = policy.handback_limit;
  const allowed =
    HANDED_BACK.includes(problem) &&
    !(problem === 'gate_failed' && policy.gate_on_fail === 'stop') &&
    used < limit &&
    !(
      (problem === 'no_changes' || problem === 'uncommitted_changes') &&
      reportedRequirement(ctx, plan, session, latestTurn)
    ) &&
    // A gate that failed because of its environment is no fault of the session's change.
    !(problem === 'gate_failed' && session.merge?.failure_class === 'environment') &&
    // The same text again means the last hand-back made no progress.
    handBackText(ctx, session, problem) !== lastHandBackText;
  if (!allowed) return { allowed, used, limit };
  // A turn before the usage limit resets would fail the same way, and one over the project
  // budget would spend more, so the hand-back waits.
  const held = usageLimitWaiting(ctx, session.id)
    ? 'usage_limit'
    : projectOverBudget(ctx, plan.project_id)
      ? 'project_budget'
      : undefined;
  return held ? { allowed, used, limit, held } : { allowed, used, limit };
}

/** The task session reported a requirement after its turn started, so it waits for the lead's answer. */
function reportedRequirement(
  ctx: ControlContext,
  plan: BoardPlan,
  session: Session,
  turn: SessionTurn | undefined,
): boolean {
  const started = turn ? latestEvent(ctx, turn.id, 'turn.running') : undefined;
  if (!started) return false;
  const rows = ctx.store.db
    .prepare(
      "SELECT payload FROM events WHERE aggregate_id=? AND kind='task.reported' AND sequence>?",
    )
    .all(plan.id, started.sequence) as { payload: string }[];
  return rows.some((row) => {
    const note = JSON.parse(row.payload) as LeadNote;
    return note.session_id === session.id && note.kind === 'requirement';
  });
}

/** The plan whose task ids the session knows: its lead's, or its own for a lead. */
const readerPlan = (session: Session) => session.task?.lead_session_id ?? session.id;

/** The board task as a reader of the plan names it, with its title. */
function taskLabel(ctx: ControlContext, boardTaskId: string, planId: string): string {
  const split = boardTaskId.indexOf(':'),
    leadId = boardTaskId.slice(0, split),
    taskId = boardTaskId.slice(split + 1),
    title = ctx.store
      .get<BoardPlan>('board_plans', leadId)
      ?.tasks.find((task) => task.id === taskId)?.title;
  return `task ${leadId === planId ? taskId : boardTaskId}${title ? ` "${title}"` : ''}`;
}

/** The message that hands a merge problem back to the task session. */
function handBackText(ctx: ControlContext, session: Session, reason: string): string {
  const merge = session.merge;
  if (reason === 'rebase_conflict') {
    const source = ctx.store.get<Workspace>('workspaces', session.workspace_id!)?.source;
    return [
      `[Pantheon] Your merge stopped on a rebase conflict. Rebase this worktree onto the current HEAD of the source repository${source ? ` ${source}` : ''}, resolve the conflicts in these files and commit:`,
      ...(merge?.conflicts ?? []).map((file) => `- ${file}`),
      ...(merge?.conflict_commits?.length
        ? [
            'These commits of the source changed those files since your worktree started:',
            ...merge.conflict_commits.map((title) => `- ${title}`),
          ]
        : []),
      ...(merge?.conflict_tasks?.length
        ? [
            'These tasks merged those commits:',
            ...merge.conflict_tasks.map(
              (taskId) => `- ${taskLabel(ctx, taskId, readerPlan(session))}`,
            ),
          ]
        : []),
    ].join('\n');
  }
  if (reason === 'gate_failed')
    return [
      `[Pantheon] Your merge stopped because the gate command ${merge?.gate ? `"${merge.gate.name}" ` : ''}failed. Fix the cause and commit.`,
      ...(merge?.gate
        ? [
            'The last 20 lines of its output:',
            ...merge.gate.output.trimEnd().split('\n').slice(-20),
          ]
        : []),
    ].join('\n');
  if (reason === 'out_of_scope')
    return [
      "[Pantheon] Your merge stopped because these files are outside your task's scope. Revert your changes to them and commit, or report a requirement asking your lead to change the task's scope:",
      ...(merge?.conflicts ?? []).map((file) => `- ${file}`),
    ].join('\n');
  if (reason === 'protected_paths')
    return [
      '[Pantheon] Your merge stopped because your commits change agent configuration, which a session may not merge. Revert your changes to these files and commit, or report a requirement asking your lead to have the user change them:',
      ...(merge?.conflicts ?? []).map((file) => `- ${file}`),
    ].join('\n');
  if (reason === 'merge_commits')
    return '[Pantheon] Your merge stopped because your commits include a merge commit, whose own changes a rebase onto the source would drop. Replace the merge with a rebase onto the current HEAD of the source repository, keeping the changes made in the merge, and commit.';
  if (reason === 'uncommitted_changes')
    return '[Pantheon] Your worktree cannot merge while it has uncommitted or untracked files. Commit them or delete them.';
  return '[Pantheon] Your turn ended without commits to merge. Commit your changes, or use report to explain why there are none.';
}

/** The merge problem of the lead's direct task: a block of the merge Pantheon started, or a skip after its latest turn. */
function directMergeProblem(
  ctx: ControlContext,
  lead: Session,
  latestTurns: ReadonlyMap<string, SessionTurn>,
): { reason: string; skipped: boolean } | undefined {
  if (lead.merge?.state === 'blocked')
    return lead.merge.reason && startedByDaemon(ctx, lead)
      ? { reason: lead.merge.reason, skipped: false }
      : undefined;
  const turn = latestTurns.get(lead.id);
  if (!turn || turn.state !== 'completed' || lead.state !== 'open' || lead.merge) return;
  const skip = latestEvent(ctx, lead.id, 'session.merge_skipped')?.payload as
    { reason: string; turn_id: string } | undefined;
  return skip?.turn_id === turn.id ? { reason: skip.reason, skipped: true } : undefined;
}

/** The message that hands a merge problem of its direct task back to the lead, which commits and reports again itself. */
function directHandBackText(
  ctx: ControlContext,
  lead: Session,
  taskId: string,
  reason: string,
): string {
  const again = `Then call report with kind done again; Pantheon merges task ${taskId} when your turn ends.`,
    files = (lead.merge?.conflicts ?? []).map((file) => `- ${file}`);
  if (reason === 'head_moved')
    return `[Pantheon] Your worktree has commits after you reported task ${taskId} done, so Pantheon did not merge it. Once all the commits of the task are in, call report with kind done again.`;
  if (reason === 'no_changes')
    return `[Pantheon] You reported task ${taskId} done, but your worktree has no commits since your last merge. Commit the changes of the task. ${again} If the task needs no change, stop it with stop_task.`;
  if (reason === 'out_of_scope')
    return [
      `[Pantheon] The merge of task ${taskId} stopped because these files are outside its scope. Revert your changes to them and commit, or, if the task needs them, stop it with stop_task, add them to its scope with update_board and start it again. ${again}`,
      ...files,
    ].join('\n');
  if (reason === 'verification_changed')
    return [
      `[Pantheon] The merge of task ${taskId} stopped. Reason: verification_changed. The diff weakens tests or changes acceptance inputs or gate/CI configuration. Revert these changes, or explicitly list these files in the task scope with update_board. ${again}`,
      ...files,
    ].join('\n');
  if (reason === 'protected_paths')
    return [
      `[Pantheon] The merge of task ${taskId} stopped because your commits change agent configuration, which a session may not merge. Revert your changes to these files and commit, and ask the user to change them. ${again}`,
      ...files,
    ].join('\n');
  return `${handBackText(ctx, lead, reason)}\n${again}`;
}

/** Gives the idle lead a turn to fix the merge of its direct task; false when it takes no input now. */
function handBackToLead(ctx: ControlContext, lead: Session, taskId: string, text: string): boolean {
  try {
    acceptInput(ctx, lead, 'send');
  } catch (error) {
    if (error instanceof DomainError) return false;
    throw error;
  }
  queueTurn(ctx, lead, text, 'tracker', '', {
    causal_depth: nextDepth(ctx, lead.id, { lead_session_id: lead.id, id: taskId }),
  });
  return true;
}

/**
 * Queues the input on the task session with its task's pending contract change, after moving it to
 * the runtime and model its task names; undefined while the idle session waits for its native
 * process to close for that move.
 */
function queueTaskTurn(
  ctx: ControlContext,
  session: Session,
  input: string,
  origin: NonNullable<SessionTurn['origin']>,
  cause: string,
  causalDepth: number,
  skills?: TurnSkill[],
): SessionTurn | undefined {
  const moved = followContractRuntime(ctx, session, cause);
  if (contractMoveWaits(ctx, moved.session)) return;
  const next = followContractModel(ctx, moved.session, cause);
  const notice = takeContractChange(ctx, next, false);
  return queueTurn(
    ctx,
    next,
    [input, notice].filter((part) => part !== undefined).join('\n\n'),
    origin,
    cause,
    { handoff: moved.handoff, causal_depth: causalDepth, ...(skills ? { skills } : {}) },
  );
}

/**
 * Queues a workflow step's input on a task session or a lead; undefined while it takes no input or
 * the project is over its budget.
 */
export function queueStepTurn(
  ctx: ControlContext,
  session: Session,
  taskId: string,
  input: string,
  skills?: TurnSkill[],
): SessionTurn | undefined {
  if (projectOverBudget(ctx, session.project_id)) return;
  try {
    acceptInput(ctx, session, session.state === 'running' ? 'steer' : 'send');
  } catch (error) {
    if (error instanceof DomainError) return;
    throw error;
  }
  const depth = nextDepth(ctx, session.id, {
    lead_session_id: session.task?.lead_session_id ?? session.id,
    id: taskId,
  });
  return session.task
    ? queueTaskTurn(ctx, session, input, 'tracker', '', depth, skills)
    : queueTurn(ctx, session, input, 'tracker', '', {
        causal_depth: depth,
        ...(skills ? { skills } : {}),
      });
}

/** Gives the idle task session a turn to fix the problem; false when it takes no input now. */
function handBack(ctx: ControlContext, session: Session, reason: string): boolean {
  try {
    acceptInput(ctx, session, 'send');
  } catch (error) {
    if (error instanceof DomainError) return false;
    throw error;
  }
  return !!queueTaskTurn(
    ctx,
    session,
    handBackText(ctx, session, reason),
    'tracker',
    '',
    nextDepth(ctx, session.id, session.task),
  );
}

/** The first note of kind the lead was left of the session since the turn started. */
function firstNote(
  ctx: ControlContext,
  plan: BoardPlan,
  sessionId: string,
  kind: LeadNote['kind'],
  turn: SessionTurn,
): { sequence: number; created_at: number } | undefined {
  const started = latestEvent(ctx, turn.id, 'turn.running');
  if (!started) return;
  return ctx.store.db
    .prepare(
      "SELECT sequence, created_at FROM events WHERE aggregate_id=? AND kind='lead.note_added' AND sequence>? AND json_extract(payload,'$.session_id')=? AND json_extract(payload,'$.kind')=? ORDER BY sequence LIMIT 1",
    )
    .get(plan.id, started.sequence, sessionId, kind) as
    { sequence: number; created_at: number } | undefined;
}

/** True when a note of the running turn already told the lead of the alert; a still_looping one is its second looping note. */
function toldInTurn(
  ctx: ControlContext,
  plan: BoardPlan,
  sessionId: string,
  alert: { kind: Alert },
  turn: SessionTurn,
): boolean {
  if (alert.kind === 'stalled' || alert.kind === 'looping')
    return !!firstNote(ctx, plan, sessionId, alert.kind, turn);
  if (alert.kind !== 'still_looping') return false;
  const started = latestEvent(ctx, turn.id, 'turn.running');
  if (!started) return false;
  const { count } = ctx.store.db
    .prepare(
      "SELECT count(*) AS count FROM events WHERE aggregate_id=? AND kind='lead.note_added' AND sequence>? AND json_extract(payload,'$.session_id')=? AND json_extract(payload,'$.kind')='looping'",
    )
    .get(plan.id, started.sequence, sessionId) as { count: number };
  return count >= 2;
}

const inputText = (call: Record<string, unknown>) =>
  JSON.stringify(call.input ?? null).slice(0, 200);

/** What the loop's latest calls were. */
function loopDetail(loop: TurnLoop): string {
  const count = loop.calls.length,
    name = String(loop.call.name);
  if (loop.form === 'alternating')
    return `Its last ${count} calls took turns between ${name} with the input ${inputText(loop.call)} and ${String(loop.other!.name)} with the input ${inputText(loop.other!)}, each failing.`;
  return `Its last ${count} calls of ${name} ${loop.form === 'failing' ? 'failed' : 'succeeded'}, each with the input ${inputText(loop.call)}.`;
}

/**
 * The stall and loop of the session's running turn, each with the text for the lead; a loop that
 * goes on for LOOP_CALLS calls after the lead's note, and a stall the lead did not act on for
 * STALL_MS after its note.
 */
function turnAlerts(
  ctx: ControlContext,
  plan: BoardPlan,
  sessionId: string,
  turn: SessionTurn,
): { kind: Alert; text: string }[] {
  const activity = turnActivity(ctx, sessionId, turn.id);
  if (!activity) return [];
  const alerts: { kind: Alert; text: string }[] = [];
  const now = ctx.store.now();
  if (stalled(activity, now)) {
    const open = activity.open_call;
    alerts.push({
      kind: 'stalled',
      text: open
        ? `${TRACKED_TEXT.stalled} Its tool call ${open.name} has been open for ${Math.floor((now - open.at) / 60_000)} minutes, with the input ${inputText(open)}.`
        : `${TRACKED_TEXT.stalled} No progress for ${Math.floor((now - activity.acted_at) / 60_000)} minutes and no tool call is under way.`,
    });
    const told = firstNote(ctx, plan, sessionId, 'stalled', turn);
    // A message from the lead to the session is its action on the stall.
    if (
      told &&
      now - told.created_at > STALL_MS &&
      !ctx.store.db
        .prepare(
          "SELECT 1 FROM events WHERE aggregate_id=? AND kind='task.messaged' AND sequence>? LIMIT 1",
        )
        .get(sessionId, told.sequence)
    )
      alerts.push({ kind: 'stall_unanswered', text: '' });
  }
  const loop = turnLoop(activity);
  if (loop) {
    alerts.push({
      kind: 'looping',
      text: `The running turn of the session ${LOOP_TEXT[loop.form]}. ${loopDetail(loop)}`,
    });
    const told = firstNote(ctx, plan, sessionId, 'looping', turn);
    const since = told
      ? loop.calls.filter((entry) => (entry.sequence ?? 0) > told.sequence).length
      : 0;
    if (since >= LOOP_CALLS)
      alerts.push({
        kind: 'still_looping',
        text: `The running turn of the session still ${LOOP_TEXT[loop.form]} after you were told: ${since} more calls of the loop since. ${loopDetail(loop)} The user is told too.`,
      });
  }
  return alerts;
}

/** The tasks that wait for a place while the session holds one, as a sentence; empty otherwise. */
function placeWaiters(ctx: ControlContext, plan: BoardPlan, session: Session): string {
  const rows = placementRows(ctx);
  if (!placedTaskSessions(ctx, session.project_id, rows).some((other) => other.id === session.id))
    return '';
  const waiting = dispatchQueue(ctx, session.project_id, rows)
    .filter((entry) => entry.wait === 'capacity')
    .map((entry) =>
      entry.plan.id === plan.id ? entry.task.id : `${entry.plan.id}:${entry.task.id}`,
    );
  return waiting.length
    ? ` The session holds one of the project's ${taskPlaces(ctx, session.project_id)} task places. Tasks that wait for a place: ${waiting.join(', ')}.`
    : '';
}

/**
 * Why a done report needs the lead's check: a merge task without commits while auto-merge is off,
 * or a worktree with uncommitted files; undefined otherwise.
 */
function uncheckedDone(
  ctx: ControlContext,
  plan: BoardPlan,
  session: Session,
  [status, count]: GitResult[],
): string | undefined {
  if (status?.exit_code !== 0 || count?.exit_code !== 0) return;
  const clean = status.stdout.toString().trim() === '',
    commits = Number(count.stdout.toString().trim());
  const unmerged =
    !commits &&
    plan.tasks.find((task) => task.id === session.task!.id)?.done_when !== 'report' &&
    !autoMerge(ctx, ctx.store.must<Project>('projects', plan.project_id));
  if (clean && !unmerged) return;
  return `The session reported done, but its worktree has ${clean ? 'no commits since it started and auto-merge is off, so nothing merges it' : 'uncommitted files, which a merge leaves out'}. Commits since it started: ${commits}; worktree clean: ${clean ? 'yes' : 'no'}.`;
}

/** The lead reports its direct task done with the commit its worktree is at; it leaves itself no note. */
function reportDirectTask(
  ctx: ControlContext,
  leadId: string,
  report: ReturnType<(typeof inputSchemas)['task.report']['parse']>,
  commandId: string,
  parsed: GitResult | undefined,
  conditions: ConditionAnswers,
): { task_id: string; reported_head: string; next: string } {
  const lead = ctx.store.must<Session>('sessions', leadId),
    claimed = lead.direct_task;
  requireThat(
    claimed,
    'invalid_state',
    'You work on no direct task; start one with start_task before you report it',
  );
  requireThat(
    report.kind === 'done',
    'invalid_input',
    `Report your direct task ${claimed.id} with kind done; tell the user anything else`,
  );
  const head = parsed?.stdout.toString().trim() ?? '';
  // Without a head the merge after the turn would have nothing to check and skip silently.
  requireThat(
    parsed?.exit_code === 0 && /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(head),
    'git_failed',
    `Pantheon could not read the commit your worktree is at, so task ${claimed.id} is not reported: ${parsed?.stderr.toString().trim() || parsed?.error || 'no commit'}`,
  );
  const next = ctx.store.update(
    'sessions',
    { ...lead, direct_task: { ...claimed, reported_head: head, reported_at: ctx.store.now() } },
    lead.revision,
  );
  ctx.store.event(
    'task.reported',
    next,
    lead.project_id,
    {
      status: report.status ?? 'done',
      task_id: claimed.id,
      generation: claimed.generation,
      direct: true,
    },
    commandId,
  );
  // As autoMergeAfterTurn decides once this turn ends.
  const project = ctx.store.must<Project>('projects', lead.project_id),
    workspace = ctx.store.must<Workspace>('workspaces', lead.workspace_id!),
    merges =
      autoMerge(ctx, project) && !!gateCommands(ctx, project, workspace, next, conditions)?.length;
  return {
    task_id: claimed.id,
    reported_head: head,
    next: merges
      ? 'Pantheon now runs the gates and merges these commits once this turn ends; tell the user so.'
      : 'Auto-merge is off, so these commits wait for the user to merge them from your session; tell the user so.',
  };
}

export function tickTaskTracking(ctx: ControlContext): void {
  // Every tick runs this, so the stops of all worktree sessions carry on here too.
  finishStops(ctx);
  advanceQueuedHandoffs(ctx);
  // A merge that gets stuck records nothing itself, so open views hear of it from this event, once per stop.
  for (const session of ctx.store.list<Session>('sessions')) {
    const progress = stuckMerge(ctx, session);
    if (
      progress &&
      (latestEvent(ctx, session.id, 'session.merge_stuck')?.sequence ?? 0) < progress.sequence
    )
      ctx.store.event('session.merge_stuck', session, session.project_id, {});
  }
  // The event marks the request escalated for needs-you, once; the lead of a task session hears of it below.
  const escalated = new Map<string | undefined, number>();
  for (const approval of ctx.store.list<Approval>('approvals')) {
    const waited = ctx.store.now() - approval.created_at;
    if (
      approval.kind !== 'permission' ||
      approval.state !== 'pending' ||
      waited <= ESCALATION_MS ||
      latestEvent(ctx, approval.id, 'approval.escalated') ||
      relayingQuestion(ctx, approval)
    )
      continue;
    ctx.store.event('approval.escalated', approval, approval.project_id, { waited_ms: waited });
    escalated.set(approval.session_id, waited);
  }
  wrapUpOverBudget(ctx);
  const plans = ctx.store.list<BoardPlan>('board_plans');
  if (!plans.length) return;
  const sessions = ctx.store
    .list<Session>('sessions')
    .filter((session) => session.workspace_id && session.task);
  const waiting = new Set(
    ctx.store
      .list<Approval>('approvals')
      .filter(
        (approval) =>
          approval.kind === 'permission' &&
          approval.state === 'pending' &&
          // The lead was told of this question with a worker_question note instead.
          !(
            relayingQuestion(ctx, approval) &&
            charterMode(ctx, approval.project_id, 'answer_worker_questions') === 'on'
          ),
      )
      .map((approval) => approval.session_id),
  );
  const latestTurns = new Map<string, SessionTurn>(),
    runningTurns = new Map<string, SessionTurn>(),
    endedTurns = new Map<string, SessionTurn[]>(),
    lastHandBack = new Map<string, string>();
  for (const turn of ctx.store.list<SessionTurn>('session_turns')) {
    if (executed(ctx, turn)) latestTurns.set(turn.session_id, turn);
    if (turn.state === 'running') runningTurns.set(turn.session_id, turn);
    if (turn.state !== 'queued' && turn.state !== 'running') {
      const ended = endedTurns.get(turn.session_id);
      if (ended) ended.push(turn);
      else endedTurns.set(turn.session_id, [turn]);
    }
    if (turn.origin === 'tracker') lastHandBack.set(turn.session_id, turn.input);
  }
  for (const plan of plans) {
    const notified = { ...plan.notified },
      handedBack = { ...plan.handed_back },
      alerted: NonNullable<BoardPlan['alerted']> = {},
      notes: LeadNote[] = [];
    let changed = false;
    /**
     * Keeps the alerts the running turn has now, which needs-you reads, and returns those that are
     * new since the last tick and that no note of this turn told the lead before.
     */
    const newAlerts = (sessionId: string, turn: SessionTurn) => {
      const before = ownEntry(plan.alerted, turn.id) ?? [],
        active = turnAlerts(ctx, plan, sessionId, turn);
      if (active.length) alerted[turn.id] = active.map((alert) => alert.kind);
      if (active.length !== before.length || active.some((alert) => !before.includes(alert.kind)))
        changed = true;
      return active.filter(
        (alert) => !before.includes(alert.kind) && !toldInTurn(ctx, plan, sessionId, alert, turn),
      );
    };
    for (const session of sessions) {
      // The lead hears nothing of a removed task's sessions, whose id a new task may reuse.
      if (session.task!.lead_session_id !== plan.id || retiredBinding(plan, session)) continue;
      if (blockedReport(ctx, session)) continue;
      const waited = escalated.get(session.id);
      if (waited !== undefined) {
        notes.push(
          recordNote(ctx, plan, {
            at: ctx.store.now(),
            session_id: session.id,
            task_id: session.task!.id,
            kind: 'waiting',
            text: `The session has waited ${Math.floor(waited / 60_000)} minutes for the user to answer a permission request; the user was reminded.${placeWaiters(ctx, plan, session)}`,
          }),
        );
        changed = true;
      }
      // Kept by session id while its last ended turns repeat the loop, so the lead hears of it once.
      const repeated =
        !session.outcome && sessionLoop(ctx, session.id, endedTurns.get(session.id) ?? []);
      if (repeated) {
        alerted[session.id] = ['looping'];
        if (!ownEntry(plan.alerted, session.id)) {
          notes.push(
            recordNote(ctx, plan, {
              at: ctx.store.now(),
              session_id: session.id,
              task_id: session.task!.id,
              kind: 'looping',
              text: `The session repeats a failing tool call across turns. In each of its last ${repeated.turns} turns, ${String(repeated.call.name)} failed with the input ${inputText(repeated.call)}.`,
            }),
          );
          changed = true;
        }
      }
      // Kept by task and background task while it runs, so the lead hears of each once.
      for (const background of longBackground(ctx, session.id)) {
        const key = `${session.task!.id}:${background.id}`;
        alerted[key] = ['background_long'];
        if (ownEntry(plan.alerted, key)) continue;
        notes.push(
          recordNote(ctx, plan, {
            at: ctx.store.now(),
            session_id: session.id,
            task_id: session.task!.id,
            kind: 'background_long',
            text: `The background ${BACKGROUND_TEXT[background.kind]} "${background.description}" (background_id ${background.id}) of the session has run for ${Math.floor((ctx.store.now() - background.started_at) / 60_000)} minutes. Stop it with stop_background, or wait for it.`,
          }),
        );
        changed = true;
      }
      const { skipped, problem } = mergeProblem(ctx, plan, session, latestTurns.get(session.id));
      const check = problem
        ? handBackAllowed(
            ctx,
            plan,
            session,
            problem,
            lastHandBack.get(session.id),
            latestTurns.get(session.id),
          )
        : undefined;
      if (problem && check?.allowed) {
        if (check.held) continue;
        if (handBack(ctx, session, problem)) {
          handedBack[session.id] = [...(ownEntry(handedBack, session.id) ?? []), problem];
          changed = true;
          continue;
        }
      }
      const running = runningTurns.get(session.id);
      if (running)
        for (const alert of newAlerts(session.id, running)) {
          // An unanswered stall goes to needs-you, not to the lead.
          if (alert.kind === 'stall_unanswered') continue;
          notes.push(
            recordNote(ctx, plan, {
              at: ctx.store.now(),
              session_id: session.id,
              task_id: session.task!.id,
              kind: alert.kind === 'still_looping' ? 'looping' : alert.kind,
              text:
                alert.kind === 'stalled'
                  ? alert.text + placeWaiters(ctx, plan, session)
                  : alert.text,
            }),
          );
        }
      const state = trackedState(ctx, session, waiting, latestTurns, skipped),
        last = notified[session.id];
      if (state === last) continue;
      if (state) {
        notified[session.id] = state;
        const landed =
          state === 'merged'
            ? (latestEvent(ctx, session.id, 'session.merged')?.payload as
                { branch?: string; to_sha?: string } | undefined)
            : undefined;
        notes.push(
          recordNote(ctx, plan, {
            at: ctx.store.now(),
            session_id: session.id,
            task_id: session.task!.id,
            kind: state,
            text:
              trackedText(ctx, session, state, latestTurns, skipped) +
              (state === 'waiting' ? placeWaiters(ctx, plan, session) : ''),
            ...(landed?.to_sha ? { commit: landed.to_sha } : {}),
            ...(landed?.branch ? { source_branch: landed.branch } : {}),
          }),
        );
        changed = true;
      } else if (
        last === 'waiting' ||
        last === 'blocked' ||
        last === 'turn_failed' ||
        last === 'no_changes'
      ) {
        // Forgetting it lets a second wait, block, failed turn or turn without commits be reported too.
        delete notified[session.id];
        if (last === 'waiting')
          notes.push(
            recordNote(ctx, plan, {
              at: ctx.store.now(),
              session_id: session.id,
              task_id: session.task!.id,
              kind: 'wait_ended',
              text: 'The session no longer waits for a permission request.',
            }),
          );
        changed = true;
      }
    }
    const lead = ctx.store.get<Session>('sessions', plan.id),
      claimed = lead?.workspace_id ? lead.direct_task : undefined,
      direct = claimed && directMergeProblem(ctx, lead!, latestTurns);
    if (
      direct &&
      DIRECT_HANDED_BACK.includes(direct.reason) &&
      !(
        direct.reason === 'gate_failed' &&
        workflowPolicy(ctx, plan.project_id).gate_on_fail === 'stop'
      ) &&
      !(direct.reason === 'gate_failed' && lead!.merge?.failure_class === 'environment') &&
      !usageLimitWaiting(ctx, lead!.id) &&
      !projectOverBudget(ctx, plan.project_id)
    ) {
      // Counted by lead and task, apart from the hand-backs to task sessions.
      const key = `${lead!.id}:${claimed.id}`,
        text = directHandBackText(ctx, lead!, claimed.id, direct.reason),
        exhausted =
          (ownEntry(handedBack, key) ?? []).filter((reason) => reason === direct.reason).length >=
            workflowPolicy(ctx, plan.project_id).handback_limit ||
          text === lastHandBack.get(lead!.id);
      if (!exhausted && handBackToLead(ctx, lead!, claimed.id, text)) {
        handedBack[key] = [...(ownEntry(handedBack, key) ?? []), direct.reason];
        changed = true;
      } else if (exhausted && direct.skipped) {
        // The lead has no one above it, so the merge it did not fix waits in needs-you.
        const next = ctx.store.update(
          'sessions',
          { ...lead!, merge: { state: 'blocked' as const, reason: direct.reason } },
          lead!.revision,
        );
        ctx.store.event('session.merge_blocked', next, next.project_id, next.merge);
        unsnooze(ctx, next.id, 'merge_blocked');
      }
    }
    // The lead has no one above it; the user hears of a stall or loop of its turn from needs-you.
    const leadTurn = runningTurns.get(plan.id);
    if (leadTurn) newAlerts(plan.id, leadTurn);
    // The alerts of turns that have ended are dropped.
    if (Object.keys(plan.alerted ?? {}).some((turnId) => !Object.hasOwn(alerted, turnId)))
      changed = true;
    // A wake the lead refused stays in the inbox and is tried again on later ticks.
    if (!changed) {
      if (wakeDue(ctx, plan)) wakeLead(ctx, plan, '');
      continue;
    }
    // A hand-back may update the task session or its plan while preparing its next turn.
    const latest = ctx.store.must<BoardPlan>('board_plans', plan.id);
    const next = ctx.store.update(
      'board_plans',
      {
        ...latest,
        inbox: [...latest.inbox, ...notes],
        notified,
        handed_back: handedBack,
        alerted,
      },
      latest.revision,
    );
    if (wakeDue(ctx, next)) wakeLead(ctx, next, '');
  }
  tellChangedContracts(ctx);
  advanceSteps(ctx);
  dispatchTasks(ctx);
}

/** Sends each idle task session its changed contract; a running one gets it once idle. */
function tellChangedContracts(ctx: ControlContext): void {
  // Read at the first changed contract, before the loop writes.
  let turns: SessionTurn[] | undefined;
  for (const plan of ctx.store.list<BoardPlan>('board_plans'))
    for (const sessionId of plan.contract_changed ?? []) {
      const session = ctx.store.get<Session>('sessions', sessionId);
      if (
        !session ||
        session.state !== 'open' ||
        session.stop_pending ||
        session.merge?.reason === 'cancelled' ||
        // The change waits for the user to raise the budget.
        projectOverBudget(ctx, session.project_id) ||
        (turns ??= ctx.store.list<SessionTurn>('session_turns')).some(
          (turn) =>
            turn.session_id === session.id && (turn.state === 'queued' || turn.state === 'running'),
        )
      )
        continue;
      // A session that holds no place, as an accepted report task's, waits for one like a task that starts.
      const placed = placedTaskSessions(ctx, session.project_id);
      if (
        !placed.some((other) => other.id === session.id) &&
        placed.length >= taskPlaces(ctx, session.project_id)
      )
        continue;
      try {
        acceptInput(ctx, session, 'send');
      } catch (error) {
        if (error instanceof DomainError) continue;
        throw error;
      }
      const moved = followContractRuntime(ctx, session, '');
      const next = followContractModel(ctx, moved.session, '');
      const notice = takeContractChange(ctx, next, false);
      // A session moving to another runtime closes its idle process first, and moves on a later tick.
      if (notice === undefined) {
        releaseIdleConversation(ctx, next);
        continue;
      }
      queueTurn(ctx, next, notice, 'lead', '', {
        handoff: moved.handoff,
        causal_depth: nextDepth(ctx, plan.id, next.task),
      });
    }
}

/** A resident lead's notes wait this long after its last tracker turn, so they come as one turn. */
const RESIDENT_WAKE_MS = 60_000;

/** When the newest tracker turn of the lead was queued; 0 when it has none. */
function lastWake(ctx: ControlContext, leadId: string): number {
  const { at } = ctx.store.db
    .prepare(
      "SELECT max(created_at) AS at FROM events WHERE kind='turn.queued' AND json_extract(payload,'$.session_id')=? AND json_extract(payload,'$.origin')='tracker'",
    )
    .get(leadId) as { at: number | null };
  return at ?? 0;
}

/** Tracker turns queued for the lead within WAKE_WINDOW_MS. */
function recentWakes(ctx: ControlContext, leadId: string): number {
  const { count } = ctx.store.db
    .prepare(
      "SELECT count(*) AS count FROM events WHERE kind='turn.queued' AND json_extract(payload,'$.session_id')=? AND json_extract(payload,'$.origin')='tracker' AND created_at>?",
    )
    .get(leadId, ctx.store.now() - WAKE_WINDOW_MS) as { count: number };
  return count;
}

/** Sends the lead its unread notes as a turn after any running one; never steers. */
export function wakeLead(ctx: ControlContext, plan: BoardPlan, cause: string): void {
  const lead = ctx.store.get<Session>('sessions', plan.id);
  if (!lead || !plan.inbox.length) return;
  // A turn before the usage limit resets would fail the same way; the resume wakes it.
  if (usageLimitWaiting(ctx, lead.id)) return;
  // The notes wait in the inbox; a later tick wakes the lead once the user raises or clears the budget.
  if (projectOverBudget(ctx, lead.project_id)) return;
  const running = lead.state === 'running';
  try {
    acceptInput(ctx, lead, running ? 'steer' : 'send');
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    // A closed lead takes no turn again, so the refusal stays on the plan for the user; the next
    // resident.open hands a resident's plan to a new session instead.
    const current = ctx.store.must<BoardPlan>('board_plans', plan.id);
    if (
      lead.state === 'closed' &&
      !lead.resident &&
      current.wake_failed?.reason !== 'lead_closed'
    ) {
      const refused = ctx.store.update(
        'board_plans',
        { ...current, wake_failed: { reason: 'lead_closed' as const, at: ctx.store.now() } },
        current.revision,
      );
      ctx.store.event('board.lead_wake_failed', refused, refused.project_id, {}, cause);
    }
    return;
  }
  const waiting = running
    ? ctx.store
        .list<SessionTurn>('session_turns')
        .find(
          (turn) =>
            turn.session_id === lead.id &&
            turn.state === 'queued' &&
            turn.delivery === 'pending' &&
            turn.origin === 'tracker',
        )
    : undefined;
  // A resident gathers the notes of a whole window into its next turn instead of hitting the limit.
  if (!waiting && lead.resident && ctx.store.now() - lastWake(ctx, lead.id) < RESIDENT_WAKE_MS)
    return;
  // Notes folded into the queued turn add no turn, so only a new one counts against the limit.
  if (!waiting && !lead.resident && recentWakes(ctx, lead.id) >= WAKE_LIMIT) {
    const current = ctx.store.must<BoardPlan>('board_plans', plan.id);
    if (current.wake_failed?.reason !== 'wake_limit') {
      const held = ctx.store.update(
        'board_plans',
        { ...current, wake_failed: { reason: 'wake_limit' as const, at: ctx.store.now() } },
        current.revision,
      );
      ctx.store.event(
        'board.lead_wake_failed',
        held,
        held.project_id,
        { reason: 'wake_limit' },
        cause,
      );
    }
    return;
  }
  const { wake_failed, ...rest } = ctx.store.must<BoardPlan>('board_plans', plan.id);
  if (wake_failed) ctx.store.update('board_plans', rest, rest.revision);
  // A wake follows from the deepest turn its notes came from; a note without a session, from the lead's.
  const depth =
    Math.max(
      ...rest.inbox.map(
        (note) =>
          note.causal_depth ??
          chainDepth(ctx, causeTurn(ctx, note.session_id || plan.id), {
            lead_session_id: plan.id,
            id: note.task_id,
          }),
      ),
    ) + 1;
  // The queued turn and the notes folded into it share one digest budget; what does not fit waits.
  const digest = takeInbox(
    ctx,
    lead.id,
    waiting ? DIGEST_BUDGET - waiting.input.length : DIGEST_BUDGET,
  );
  if (digest === undefined) return;
  if (waiting) {
    const folded = ctx.store.update(
      'session_turns',
      {
        ...waiting,
        input: foldDigest(waiting.input, digest.text),
        lead_note_ids: [...(waiting.lead_note_ids ?? []), ...digest.note_ids],
        causal_depth: Math.max(waiting.causal_depth ?? 0, depth),
        wake: wakeOf(digest.notes, waiting.wake),
      },
      waiting.revision,
    );
    ctx.store.event(
      'session.turn.notes_folded',
      folded,
      folded.project_id,
      { session_id: lead.id, note_ids: digest.note_ids },
      cause,
    );
    return;
  }
  queueTurn(ctx, lead, digest.text, 'tracker', cause, {
    causal_depth: depth,
    lead_note_ids: digest.note_ids,
    wake: wakeOf(digest.notes, undefined),
  });
}

/** The kinds and routine ids of the turn's earlier notes and of the notes it now delivers, each once in order. */
function wakeOf(notes: LeadNote[], earlier: SessionTurn['wake']): NonNullable<SessionTurn['wake']> {
  const causes = [...new Set([...(earlier?.causes ?? []), ...notes.map((note) => note.kind)])],
    routineIds = [
      ...new Set([
        ...(earlier?.routine_ids ?? []),
        ...notes.flatMap((note) => (note.routine_id ? [note.routine_id] : [])),
      ]),
    ];
  return routineIds.length ? { causes, routine_ids: routineIds } : { causes };
}

/**
 * Queues the turn that goes on after the lead's writable turn was interrupted because its direct
 * task was released; it starts read-only once the interrupted turn ends.
 */
export function continueInterruptedLead(ctx: ControlContext, leadId: string, cause: string): void {
  const lead = ctx.store.must<Session>('sessions', leadId);
  try {
    acceptInput(ctx, lead, lead.state === 'running' ? 'steer' : 'send');
  } catch (error) {
    if (error instanceof DomainError) return;
    throw error;
  }
  queueTurn(ctx, lead, INTERRUPTED_TEXT, 'tracker', cause, {
    causal_depth: nextDepth(ctx, lead.id, undefined),
  });
}

/** Starts the turn on an idle session; on a running one it waits, outside the outbox, for that turn to end. */
export function queueTurn(
  ctx: ControlContext,
  session: Session,
  input: string,
  origin: NonNullable<SessionTurn['origin']>,
  cause: string,
  extras?: Pick<
    SessionTurn,
    | 'attachments'
    | 'skills'
    | 'refs'
    | 'reference_context'
    | 'handoff'
    | 'causal_depth'
    | 'lead_note_ids'
    | 'wake'
  >,
): SessionTurn {
  const turn: SessionTurn = { ...queuedTurn(session, input, 'send', extras), origin };
  if (session.state !== 'running') {
    const { archived_at, ...rest } = session;
    const next = ctx.store.update(
      'sessions',
      { ...rest, state: 'running' as const, turn_count: session.turn_count + 1, merge: undefined },
      session.revision,
    );
    if (archived_at) ctx.store.event('session.unarchived', next, next.project_id, {}, cause);
    ctx.store.enqueue('session.turn', { turn_id: turn.id });
  } else
    ctx.store.update(
      'sessions',
      { ...session, turn_count: session.turn_count + 1 },
      session.revision,
    );
  insert(ctx, 'session_turns', turn, 'turn.queued', session.project_id, cause);
  ctx.store.event('session.turn.delivery', turn, turn.project_id, { delivery: 'pending' }, cause);
  return turn;
}

/**
 * The plan with each task's state and sessions and the recent commits of each git folder; a lead
 * that cannot write its plan is not asked to rewrite it.
 */
export function syncBrief(
  ctx: ControlContext,
  plan: BoardPlan | undefined,
  logs: [string, GitResult][],
  readOnly = false,
): string {
  const lines = readOnly
    ? [
        'Below are your plan with the state and sessions of each task, and the recent commits of each git folder of the project; check them before you go on within your role.',
      ]
    : [
        'Sync the board with the project as it is now.',
        'Below are your plan with the state and sessions of each task, and the recent commits of each git folder of the project. Rewrite your plan from them and send it with update_board: keep the ids of tasks that still apply, add tasks for work that is under way without one, and remove tasks that are no longer needed.',
        'Do not implement anything; when the plan is written, end your turn.',
      ];
  if (plan) {
    lines.push(`Your plan: ${plan.headline}`);
    for (const task of plan.tasks) {
      const sessions = taskSessions(ctx, plan.id, task.id);
      const listed = sessions.length
        ? sessions
            .map(
              (session) =>
                `${session.id} ${session.state}${session.outcome ? `/${session.outcome}` : ''}`,
            )
            .join(', ')
        : 'none';
      lines.push(
        `- ${task.id} "${task.title}": ${taskState(plan, task.id, sessions, ctx.store.get<Session>('sessions', plan.id))}; sessions: ${listed}`,
      );
    }
  } else lines.push('You have no plan yet; read project_read for the plans of other leads.');
  for (const [root, log] of logs) {
    lines.push(`Recent commits in ${root}:`);
    if (log.exit_code !== 0) lines.push('- none');
    else
      for (const line of log.stdout.toString().split('\n').filter(Boolean)) lines.push(`- ${line}`);
  }
  return lines.join('\n');
}

export const TAKEOVER_TEXT =
  'You take over the plan of an earlier lead session that has ended; project_read shows it as yours.';

function boardSync(ctx: ControlContext, p: Principal, c: Command, logs: [string, GitResult][]) {
  const input = inputSchemas['board.sync'].parse(c.input);
  projectAccess(ctx, p, input.project_id, c.type);
  if (p.role === 'lead')
    return {
      brief: syncBrief(ctx, ctx.store.get<BoardPlan>('board_plans', p.session_id!), logs),
    };
  userOnly(p);
  const baseline = ctx.store
    .list<ProjectBaseline>('project_baselines')
    .filter((entry) => entry.project_id === input.project_id)
    .at(-1);
  // Confirming the baseline opens the lead that plans the board.
  requireThat(
    baseline?.state !== 'running' && baseline?.state !== 'submitted',
    'invalid_state',
    'A baseline of this project is running or waiting for confirmation; update the board after it is confirmed',
  );
  // Read before the sync opens or briefs a session, so only an earlier sync or baseline turn counts.
  const turns = ctx.store.list<SessionTurn>('session_turns');
  const pending = (sessionId: string) =>
    turns.some(
      (turn) =>
        turn.session_id === sessionId &&
        (turn.origin === 'sync' || turn.origin === 'baseline') &&
        (turn.state === 'queued' || turn.state === 'running'),
    );
  const sessionIds: string[] = [];
  for (const plan of ctx.store.list<BoardPlan>('board_plans')) {
    if (plan.project_id !== input.project_id) continue;
    const lead = ctx.store.get<Session>('sessions', plan.id);
    if (!lead) continue;
    if (!pending(lead.id)) {
      try {
        acceptInput(ctx, lead, lead.state === 'running' ? 'steer' : 'send');
      } catch (error) {
        if (error instanceof DomainError) continue;
        throw error;
      }
      queueTurn(ctx, lead, syncBrief(ctx, plan, logs), 'sync', c.command_id);
    }
    sessionIds.push(lead.id);
  }
  if (!sessionIds.length) {
    const resident = openResident(ctx, p, input.project_id, 'assistant', c.command_id);
    const own = ctx.store.get<BoardPlan>('board_plans', resident.id);
    const ended = ctx.store
      .list<BoardPlan>('board_plans')
      .filter((plan) => {
        const lead = ctx.store.get<Session>('sessions', plan.id);
        return plan.project_id === input.project_id && lead?.state === 'closed' && !lead.resident;
      })
      .sort((a, b) => b.updated_at - a.updated_at)[0];
    let text: string;
    if (!own && ended) {
      // The resident takes over the newest plan of an ended lead, so its tasks are not planned twice.
      transferPlan(ctx, ended, resident.id, c.command_id);
      text = `${TAKEOVER_TEXT}\n${syncBrief(ctx, ctx.store.must<BoardPlan>('board_plans', resident.id), logs)}`;
    } else {
      const lead = ended && ctx.store.get<Session>('sessions', ended.id);
      const unfinished = (ended?.tasks ?? []).filter(
        (task) => taskState(ended, task.id, taskSessions(ctx, ended!.id, task.id), lead) !== 'done',
      );
      text = [
        syncBrief(ctx, own, logs),
        ...(unfinished.length
          ? [
              `An ended lead session left these tasks of its plan ${ended!.id} unfinished; add the ones that still apply to your plan:`,
              ...unfinished.map((task) => `- ${task.id} "${task.title}"`),
            ]
          : []),
      ].join('\n');
    }
    if (!pending(resident.id)) {
      const next = ctx.store.must<Session>('sessions', resident.id);
      acceptInput(ctx, next, next.state === 'running' ? 'steer' : 'send');
      queueTurn(ctx, next, text, 'sync', c.command_id);
    }
    sessionIds.push(resident.id);
  }
  return { session_ids: sessionIds };
}

/** Reads the recent commits of the project's git folders once, before board.sync's transaction. */
export function prepareBoardSync(ctx: ControlContext, p: Principal, c: Command): Promise<Handler> {
  const input = inputSchemas['board.sync'].parse(c.input);
  projectAccess(ctx, p, input.project_id, c.type);
  const roots = ctx.store.must<Project>('projects', input.project_id).roots;
  return (async () => {
    const git = await Promise.all(roots.map(gitFolderAsync));
    const logs = await Promise.all(
      roots
        .filter((_, index) => git[index])
        .map(async (root): Promise<[string, GitResult]> => [
          root,
          await runGit(root, ['log', '-20', '--format=%h %cs %s'], undefined, true),
        ]),
    );
    return (ctx: ControlContext, p: Principal, c: Command) => boardSync(ctx, p, c, logs);
  })();
}

// Blocked and requirement reports, and the done report of a report task, wake the lead.
function taskReport(
  ctx: ControlContext,
  p: Principal,
  c: Command,
  git: GitResult[],
  conditions: ConditionAnswers = new Map(),
) {
  const input = inputSchemas['task.report'].parse(c.input);
  requireThat(
    input.kind !== 'blocked' || input.reason,
    'invalid_input',
    'A blocked report requires a reason category',
  );
  projectAccess(ctx, p, input.project_id, c.type);
  requireThat(
    p.role !== 'lead' || !ctx.store.must<Session>('sessions', p.session_id!).resident,
    'permission_denied',
    'A resident lead works on no task itself, so it has nothing to report; its task sessions report',
  );
  if (p.role === 'lead')
    return reportDirectTask(ctx, p.session_id!, input, c.command_id, git[0], conditions);
  requireThat(p.role === 'worker', 'permission_denied', 'Worker session required');
  // A worker credential is only issued to a session opened from a task.
  const task = ctx.store.must<Session>('sessions', p.session_id!).task!;
  const plan = ctx.store.get<BoardPlan>('board_plans', task.lead_session_id);
  requireThat(plan, 'not_found', `Not found: board plan ${task.lead_session_id}`);
  requireThat(
    input.text.length <= 400 || reportDone(plan, { kind: input.kind, task_id: task.id }),
    'invalid_input',
    `text: only the done report of a report task may be longer than 400 characters; task ${task.id} is done when its worktree merges`,
  );
  requireThat(
    input.kind === 'blocked' || plan.inbox.length < INBOX_LIMIT,
    'resource_busy',
    `The lead has ${INBOX_LIMIT} unread notes; report again after it reads them`,
  );
  const note: LeadNote = {
    at: ctx.store.now(),
    session_id: p.session_id!,
    task_id: task.id,
    kind: input.kind,
    text: input.text,
    ...(input.kind === 'done' ? { status: input.status ?? ('done' as const) } : {}),
    ...(input.kind === 'blocked' ? { reason: input.reason } : {}),
    // The turn a blocked or requirement report holds the session in, until a later one starts.
    ...(input.kind === 'blocked' || input.kind === 'requirement'
      ? { turn_id: causeTurn(ctx, p.session_id!)?.id }
      : {}),
    // The generation tells task.accept whether the report predates a contract change.
    generation: taskReportGeneration(ctx, ctx.store.must<Session>('sessions', p.session_id!)),
  };
  let next = appendNote(ctx, plan, note, c.command_id);
  ctx.store.event('task.reported', next, input.project_id, note, c.command_id);
  const unchecked =
    note.kind === 'done'
      ? uncheckedDone(ctx, plan, ctx.store.must<Session>('sessions', p.session_id!), git)
      : undefined;
  if (unchecked)
    next = appendNote(
      ctx,
      next,
      {
        at: note.at,
        session_id: note.session_id,
        task_id: note.task_id,
        kind: 'no_changes',
        text: unchecked,
      },
      c.command_id,
    );
  if (
    note.kind !== 'requirement' &&
    note.kind !== 'blocked' &&
    // As in wakeDue, a done report waits for the task's after-merge steps.
    !(reportDone(plan, note) && !afterMergeHolds(ctx, plan, note)) &&
    !unchecked
  )
    return { pending: next.inbox.length };
  wakeLead(ctx, next, c.command_id);
  return { pending: ctx.store.must<BoardPlan>('board_plans', next.id).inbox.length };
}

/**
 * Reads the worktree a done report checks before task.report's transaction: a lead's HEAD, or a
 * worker's status and commits since its base.
 */
export function prepareTaskReport(
  ctx: ControlContext,
  p: Principal,
  c: Command,
): Handler | Promise<Handler> {
  const input = inputSchemas['task.report'].parse(c.input);
  projectAccess(ctx, p, input.project_id, c.type);
  const session = p.session_id ? ctx.store.get<Session>('sessions', p.session_id) : undefined,
    workspace = session?.workspace_id
      ? ctx.store.get<Workspace>('workspaces', session.workspace_id)
      : undefined;
  const reads =
    input.kind !== 'done' || !workspace
      ? []
      : p.role === 'lead'
        ? session!.direct_task
          ? [['rev-parse', '--verify', 'HEAD^{commit}']]
          : []
        : p.role === 'worker' && workspace.base_sha
          ? [
              ['status', '--porcelain=v1'],
              ['rev-list', '--count', `${workspace.base_sha}..HEAD`],
            ]
          : [];
  if (!reads.length) return (ctx, p, c) => taskReport(ctx, p, c, []);
  return Promise.all([
    Promise.all(reads.map((args) => runGit(workspace!.path, args, undefined, true))),
    // A lead's report says whether its gate merges the task, which its conditions decide.
    p.role === 'lead' ? readMergeConditions(ctx, session!.id) : new Map(),
  ]).then(
    ([git, conditions]): Handler =>
      (ctx, p, c) =>
        taskReport(ctx, p, c, git, conditions),
  );
}

export const taskTrackingHandlers: Handlers = {
  'task.handback': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['task.handback'].parse(c.input),
      plan = ctx.store.must<BoardPlan>('board_plans', input.lead_session_id);
    projectAccess(ctx, p, plan.project_id, c.type);
    const unfinished = taskSessions(ctx, plan.id, input.task_id).filter(
      (session) => !session.outcome && session.state !== 'closed',
    );
    requireThat(
      unfinished.length,
      'invalid_state',
      `Task ${input.task_id} has no unfinished session`,
    );
    for (const session of unfinished) {
      const note: LeadNote = {
        at: ctx.store.now(),
        session_id: session.id,
        task_id: input.task_id,
        kind: 'blocked',
        text: `The user handed this task back to you: ${input.reason}`,
        turn_id: causeTurn(ctx, session.id)?.id,
        generation: taskReportGeneration(ctx, session),
      };
      const next = appendNote(
        ctx,
        ctx.store.must<BoardPlan>('board_plans', plan.id),
        note,
        c.command_id,
      );
      ctx.store.event('task.reported', next, plan.project_id, note, c.command_id);
      ctx.store.event(
        'task.handed_back',
        next,
        plan.project_id,
        { session_id: session.id, task_id: input.task_id, reason: input.reason },
        c.command_id,
      );
    }
    wakeLead(ctx, ctx.store.must<BoardPlan>('board_plans', plan.id), c.command_id);
    return { session_ids: unfinished.map((session) => session.id) };
  },
  // Each lead owns its own plan row, so messages take no expected revision.
  'task.message': (ctx, p, c) => {
    const input = inputSchemas['task.message'].parse(c.input);
    projectAccess(ctx, p, input.project_id, c.type);
    requireThat(p.role === 'lead', 'permission_denied', 'Lead session required');
    const plan = ctx.store.get<BoardPlan>('board_plans', p.session_id!);
    requireThat(plan, 'not_found', 'Write a plan with update_board first');
    requireThat(
      plan.tasks.some((task) => task.id === input.task_id),
      'not_found',
      `Not found: task ${input.task_id} in your plan`,
    );
    requireThat(
      !currentAcceptance(plan, input.task_id),
      'task_accepted',
      `Task ${input.task_id} is accepted; change its contract or stop it with stop_task to reopen it`,
    );
    const open = selectedParts(
      taskSessions(ctx, plan.id, input.task_id).filter((candidate) => candidate.state !== 'closed'),
      input,
    ).at(-1);
    requireThat(
      open,
      'invalid_state',
      `Task ${input.task_id} has no open session; start it with start_task first`,
    );
    const resetAt = usageResetAt(ctx, open.id);
    requireThat(
      resetAt === undefined,
      'resource_busy',
      `The session of task ${input.task_id} waits for its usage limit to reset; Pantheon resumes it at ${new Date(resetAt ?? 0).toISOString()}, so send the message after that`,
    );
    acceptInput(ctx, open, open.state === 'running' ? 'steer' : 'send');
    const turn = queueTaskTurn(
      ctx,
      open,
      `[Lead] ${input.text}`,
      'lead',
      c.command_id,
      nextDepth(ctx, plan.id, { lead_session_id: plan.id, id: input.task_id }),
    );
    requireThat(
      turn,
      'resource_busy',
      `The session of task ${input.task_id} is moving to the runtime or model you changed; send the message again in a moment`,
    );
    const session = ctx.store.must<Session>('sessions', turn.session_id);
    ctx.store.event(
      'task.messaged',
      session,
      input.project_id,
      { task_id: input.task_id, turn_id: turn.id },
      c.command_id,
    );
    return turn;
  },
  // Each lead owns its own plan row, so acceptances take no expected revision.
  'task.accept': (ctx, p, c) => {
    const input = inputSchemas['task.accept'].parse(c.input);
    projectAccess(ctx, p, input.project_id, c.type);
    requireThat(p.role === 'lead', 'permission_denied', 'Lead session required');
    const plan = ctx.store.get<BoardPlan>('board_plans', p.session_id!);
    requireThat(plan, 'not_found', 'Write a plan with update_board first');
    const task = plan.tasks.find((candidate) => candidate.id === input.task_id);
    requireThat(task, 'not_found', `Not found: task ${input.task_id} in your plan`);
    requireThat(
      task.done_when === 'report',
      'invalid_state',
      `Task ${task.id} is done when its sessions merge, not when you accept it`,
    );
    const generation = taskGeneration(plan, task.id);
    requireThat(
      doneReported(ctx, plan, task.id),
      'invalid_state',
      `Task ${task.id} has no done report since its contract last changed to accept`,
    );
    requireThat(
      !afterMergeHolds(ctx, plan, { task_id: task.id }),
      'invalid_state',
      `Task ${task.id} waits for its after-merge workflow steps; accept it once they pass`,
    );
    const accepted = { at: ctx.store.now(), evidence: input.evidence, generation };
    const next = ctx.store.update(
      'board_plans',
      { ...plan, accepted: { ...plan.accepted, [task.id]: accepted } },
      plan.revision,
    );
    ctx.store.event(
      'task.accepted',
      next,
      input.project_id,
      { task_id: task.id, ...accepted },
      c.command_id,
    );
    return planViews(ctx, input.project_id)
      .find((view) => view.lead_session_id === plan.id)!
      .tasks.find((view) => view.id === task.id)!;
  },
};
