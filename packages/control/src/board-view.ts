import { requireThat } from '@pantheon/domain';
import { waitingStep } from './merge-review.js';
import type {
  LandingItem,
  AgentEvent,
  Approval,
  BoardPlan,
  ChangeStory,
  Event,
  LeadNote,
  LeadQuestion,
  NeedsYouItem,
  Principal,
  Project,
  ProjectBoard,
  Retrospective,
  Review,
  Session,
  SessionTurn,
  StepRun,
  Workspace,
} from '@pantheon/domain';
import type {
  BoardActivity,
  BoardBlocker,
  BoardModel,
  BoardTaskState,
  BoardTaskStatus,
  BoardWaiting,
  WorkbenchSession,
} from '@pantheon/protocol';
import { projectAccess, type ControlContext } from './context.js';
import { milestoneExtras, statusLineOf, taskExtras } from './board-view-task-extras.js';
import { taskEvidenceLevel } from './evidence-level.js';
import { effectiveDepth, laneHeld } from './lane-stops.js';
import { estimateLane } from './plan-estimate.js';
import {
  awaitingChange,
  boardTaskId,
  currentAcceptance,
  currentDirectMerge,
  currentBinding,
  ownEntry,
  pendingProposals,
  taskGeneration,
  taskState,
} from './board-plan.js';
import { itemTask, latestExecuted, leadTurnFailed, needsYou } from './needs-you.js';
import { projectFacts } from './project-facts.js';
import { chainDepth, PROGRESS_KINDS, quiet, verifiedProgressReader } from './progress.js';
import { runPhase } from './run-state.js';
import {
  dispatchQueue,
  placedTaskSessions,
  taskPath,
  taskPlaces,
  type DispatchWait,
} from './task-dispatch.js';
import { cachedReady, sessionList } from './workbench-session.js';
import { ITERATION_DAYS } from './project-board.js';
import { reviewExecutionReader, reviewTimeReader, reviewerVerdict } from './review.js';
import { runGit } from './git.js';
import { gateFailed } from './landing.js';
import { doneReported } from './task-tracking.js';
import { cacheReadShare } from './trace-view.js';
import { gateFirstPass, latestRetrospectives } from './retrospective.js';
import { taskBudgetUse } from './task-budget.js';
import { taskRung, taskRungFacts } from './task-rung.js';

const TASK_STATUS: Record<WorkbenchSession['state'], BoardTaskStatus> = {
  starting: 'running',
  running: 'running',
  idle: 'idle',
  waiting: 'waiting',
  ready: 'ready',
  merging: 'ready',
  merged: 'done',
  failed: 'failed',
  discarded: 'discarded',
  done: 'done',
};

type TaskTotals = BoardModel['task_progress']['totals'];

interface WalkedCommit {
  sha: string;
  parents: string[];
  branch: string;
  refs: string[];
  /** Committer time in seconds. */
  time: number;
  reverts: string[];
}
/** A repository's last revert walk, keyed by the walked branch names, their tips and the base. */
interface RevertWalk {
  key?: string;
  // Undefined until a walk completes, and after one failed.
  commits?: WalkedCommit[];
  refresh?: Promise<boolean>;
}
// By project and repository, as prefetchRevertWalks read them over all of each project's merges.
const revertWalks = new WeakMap<ControlContext, Map<string, RevertWalk>>();

type MergeEntry = { session_id: string; at: number; payload: MergedPayload };

/** The merges by the repository each landed in: project roots can be separate repositories. */
function mergeRepositories(ctx: ControlContext, projectId: string, merges: MergeEntry[]) {
  const repositories = new Map<string, MergeEntry[]>();
  for (const merge of merges) {
    const session = ctx.store.get<Session>('sessions', merge.session_id),
      workspace =
        session?.workspace_id && ctx.store.get<Workspace>('workspaces', session.workspace_id),
      source = workspace
        ? (workspace.source ?? workspace.path)
        : ctx.store.must<Project>('projects', projectId).roots[0]!;
    repositories.set(source, [...(repositories.get(source) ?? []), merge]);
  }
  return repositories;
}

const mergedBranches = (merges: MergeEntry[]) => [
  ...new Set(
    merges.map((merge) => (merge.payload.branch ? `refs/heads/${merge.payload.branch}` : 'HEAD')),
  ),
];

/** Walks the merges' branches back to the oldest merge's start, unless their tips are as `known` walked. */
async function readRevertWalk(
  source: string,
  merges: MergeEntry[],
  known: RevertWalk | undefined,
): Promise<RevertWalk> {
  const branches = mergedBranches(merges);
  // The oldest merge's start bounds the walk, so commits dated before a range still link up.
  const oldest = merges.reduce((a, b) => (b.at < a.at ? b : a)).payload,
    base = oldest.from_sha ?? oldest.to_sha;
  const resolved = await runGit(
      source,
      ['cat-file', '--batch-check'],
      Buffer.from(branches.map((branch) => `${branch}\n`).join('')),
      true,
    ),
    key =
      resolved.exit_code === 0
        ? JSON.stringify([branches, resolved.stdout.toString(), base])
        : undefined;
  if (key !== undefined && known?.key === key) return { key, commits: known.commits };
  const log = await runGit(
    source,
    [
      'log',
      '--source',
      '--decorate=full',
      '--ignore-missing',
      '--format=%H%x00%P%x00%S%x00%D%x00%ct%x00%B%x00',
      ...branches,
      `^${base}`,
      '--',
    ],
    undefined,
    true,
  );
  if (log.exit_code !== 0) return {};
  const fields = log.stdout.toString().split('\0'),
    walked: WalkedCommit[] = [];
  for (let index = 0; index + 5 < fields.length; index += 6)
    walked.push({
      sha: fields[index]!.trim(),
      parents: fields[index + 1]!.split(' ').filter(Boolean),
      branch: fields[index + 2]!,
      refs: fields[index + 3]!.split(', '),
      time: Number(fields[index + 4]),
      reverts: [...fields[index + 5]!.matchAll(/This reverts commit ([a-f0-9]{40,64})\b/g)].map(
        (match) => match[1]!,
      ),
    });
  return { key, commits: walked };
}

/**
 * Reads asynchronously the revert walks of the repositories the project's merges landed in, which
 * boardView counts reverts from alone; emits workspace.repository_changed when a walk moved.
 */
export function prefetchRevertWalks(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
): Promise<void> {
  projectAccess(ctx, p, projectId, 'project.read');
  const walks = revertWalks.get(ctx) ?? new Map<string, RevertWalk>();
  revertWalks.set(ctx, walks);
  const merges = boardEvents(ctx, projectId, ['session.merged']).map((event) => ({
    session_id: event.aggregate_id,
    at: event.created_at,
    payload: event.payload as MergedPayload,
  }));
  const reads = [...mergeRepositories(ctx, projectId, merges)].map(([source, sourceMerges]) => {
    const id = JSON.stringify([projectId, source]),
      known = walks.get(id);
    if (known?.refresh) return known.refresh;
    const refresh = readRevertWalk(source, sourceMerges, known).then((walk) => {
      walks.set(id, walk);
      return (
        walk.commits !== known?.commits &&
        JSON.stringify(walk.commits) !== JSON.stringify(known?.commits)
      );
    });
    walks.set(id, { ...known, refresh });
    return refresh;
  });
  const work: Promise<void> = Promise.all(reads)
    .then((moved) => {
      if (ctx.closing || !moved.includes(true)) return;
      // Clients read the board again only after an event.
      ctx.store.event(
        'workspace.repository_changed',
        ctx.store.must<Project>('projects', projectId),
        projectId,
        {},
      );
      ctx.changed();
    })
    .finally(() => ctx.completions.delete(work));
  ctx.completions.add(work);
  return work;
}

/** A lead's board state from its listed state; a lead not listed is closed. */
function leadState(
  listed: WorkbenchSession['state'] | undefined,
  turnFailed: () => boolean,
): NonNullable<BoardModel['leads']>[number]['state'] {
  if (!listed || ['merged', 'discarded', 'failed'].includes(listed)) return 'closed';
  if (listed === 'waiting') return 'waiting';
  if (turnFailed()) return 'failed';
  return listed === 'running' ? 'running' : 'idle';
}

const QUEUED_TEXT: Record<DispatchWait, string> = {
  upstream: 'Queued: waiting for dependencies',
  scope: 'Queued: waiting for the scope to free up',
  plan_review: 'Queued: waiting for plan review',
  retry: 'Queued: waiting to retry',
  budget: 'Queued: project over budget',
  capacity: 'Queued: waiting for a free slot',
  runtime_limited: 'Queued: waiting for runtime quota',
  runtime_capacity: 'Queued: waiting for runtime capacity',
  device_offline: 'Queued: waiting for the device to come online',
  device_capacity: 'Queued: waiting for a free session on the device',
  device_resource: 'Queued: waiting for a device resource',
  paused: 'Queued: dispatch is paused',
  answer: 'Queued: waiting for an answer',
  approval: 'Queued: waiting for your approval',
  plan_approval: 'Queued: waiting for your plan approval',
};

const PLANNED_FIELDS = [
  'runtime',
  'model',
  'effort',
  'kind',
  'route_reason',
  'priority',
  'device',
  'device_reason',
  'needs',
  'uses',
] as const;

// Cycle buckets: up to 15m, 30m, 1h, 2h, 4h, 8h, 1d, then over 1d.
const CYCLE_BOUNDS = [15, 30, 60, 120, 240, 480, 1440].map((minutes) => minutes * 60 * 1000);

const waitingOf = (approval: Approval): BoardWaiting => ({
  kind: approval.tool === 'AskUserQuestion' && approval.questions ? 'input' : 'approval',
  summary: (approval.input_summary ?? approval.tool ?? '').slice(0, 140),
  approval_id: approval.id,
  since: approval.created_at,
  ...(approval.tool === 'AskUserQuestion' &&
  approval.questions?.length === 1 &&
  !approval.questions[0]!.multiSelect
    ? { options: approval.questions[0]!.options.slice(0, 6).map(({ label }) => label.slice(0, 60)) }
    : {}),
});

const pad = (n: number) => String(n).padStart(2, '0');
/** Local calendar date of an epoch time, as YYYY-MM-DD. */
export const dayKey = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
/** Local midnight `days` days after the day of `at`. */
export const midnight = (at: number, days = 0) => {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d.getTime();
};

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b),
    mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Store.eventSpan of each aggregate with events, and whether a turn.running event is among them, in one read. */
function eventSpans(
  ctx: ControlContext,
  ids: string[],
): Map<string, { first: number; last: number; ran: boolean }> {
  const rows = ctx.store.db
    .prepare(
      "SELECT aggregate_id AS id, min(created_at) AS first, max(created_at) AS last, max(kind='turn.running') AS ran FROM events WHERE aggregate_id IN (SELECT value FROM json_each(?)) GROUP BY aggregate_id",
    )
    .all(JSON.stringify(ids)) as { id: string; first: number; last: number; ran: number }[];
  return new Map(rows.map((row) => [row.id, { first: row.first, last: row.last, ran: !!row.ran }]));
}

/**
 * The project's board.plan_updated and board.plan_transferred events in order. An update carries
 * the whole plan; its payload keeps only the plan fields the board reads, a field it lacks as null.
 * json() keeps a subquery's array an array: SQLite may drop the JSON subtype across a subquery.
 */
function planHistory(ctx: ControlContext, projectId: string): Event[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT sequence, event_id, kind, aggregate_id, aggregate_revision, project_id, causation_id, created_at,
         CASE WHEN kind='board.plan_updated' THEN json_object(
           'tasks', json((SELECT json_group_array(json_object('id', value->'$.id',
             'depends_on', value->'$.depends_on', 'iteration', value->'$.iteration',
             'estimate', value->'$.estimate', 'kind', value->'$.kind', 'done_when', value->'$.done_when'))
             FROM json_each(payload, '$.tasks'))),
           'retired', payload->'$.retired', 'generations', payload->'$.generations',
           'pending_edits', json((SELECT json_group_array(json_object('edit_id', value->'$.edit_id',
             'status', value->'$.status')) FROM json_each(payload, '$.pending_edits')))
         ) ELSE payload END AS payload
       FROM events INDEXED BY events_project_kind
       WHERE project_id=? AND kind IN ('board.plan_updated', 'board.plan_transferred') ORDER BY sequence`,
    )
    .all(projectId) as unknown as (Omit<Event, 'payload'> & { payload: string })[];
  return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
}

/**
 * Store.kindEvents without the input of an agent.tool.started payload: the board reads the input
 * only of a collabAgentToolCall, which keeps it.
 */
function boardEvents(ctx: ControlContext, projectId: string, kinds: string[]): Event[] {
  const rows = ctx.store
    .statement(
      `SELECT sequence, event_id, kind, aggregate_id, aggregate_revision, project_id, causation_id, created_at,
         CASE WHEN kind='agent.tool.started' AND payload->>'$.name' IS NOT 'collabAgentToolCall'
           THEN json_remove(payload, '$.input') ELSE payload END AS payload
       FROM events INDEXED BY events_project_kind
       WHERE project_id=? AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY sequence`,
    )
    .all(projectId, ...kinds) as unknown as (Omit<Event, 'payload'> & { payload: string })[];
  return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
}

type WaitReason = keyof NonNullable<BoardModel['counts']['wait_by_reason_ms']>;
type TimePart = 'working_ms' | 'waiting_ms' | 'gate_ms' | 'queue_ms';

function sessionTimeSlices(events: Event[], first: number, end: number) {
  const slices: { from: number; to: number; part: TimePart; reason?: WaitReason }[] = [];
  const running = new Set<string>(),
    approvals = new Map<string, WaitReason>(),
    questions = new Set<string>();
  let ready = false,
    gating = false,
    merging = false,
    last = first;
  for (const event of [...events, undefined]) {
    const at = event?.created_at ?? end;
    const reason: WaitReason | undefined = [...approvals.values()].includes('approval')
      ? 'approval'
      : approvals.size || questions.size
        ? 'question'
        : ready && !running.size && !gating && !merging
          ? 'review'
          : undefined;
    const part: TimePart = reason
      ? 'waiting_ms'
      : gating || merging
        ? 'gate_ms'
        : running.size
          ? 'working_ms'
          : 'queue_ms';
    if (at > last) slices.push({ from: last, to: at, part, ...(reason ? { reason } : {}) });
    last = at;
    if (!event) break;
    if (event.kind === 'turn.queued') ready = false;
    else if (event.kind === 'turn.running') {
      running.add(event.aggregate_id);
      ready = false;
    } else if (['turn.completed', 'turn.failed', 'turn.cancelled'].includes(event.kind)) {
      running.delete(event.aggregate_id);
      ready = event.kind === 'turn.completed';
    } else if (event.kind === 'approval.requested')
      approvals.set(
        event.aggregate_id,
        (event.payload as Approval).tool === 'AskUserQuestion' ? 'question' : 'approval',
      );
    else if (event.kind.startsWith('approval.')) approvals.delete(event.aggregate_id);
    else if (event.kind === 'lead.question_asked')
      questions.add((event.payload as LeadQuestion).id);
    else if (event.kind === 'lead.question_answered')
      questions.delete((event.payload as LeadQuestion).id);
    else if (event.kind === 'session.gate_started') gating = true;
    else if (
      ['session.gate_checked', 'session.gate_run_cancelled', 'session.gate_run_failed'].includes(
        event.kind,
      )
    )
      gating = false;
    else if (event.kind === 'session.merge_started') merging = true;
    else if (['session.merge_blocked', 'session.merge_cancelled'].includes(event.kind))
      merging = false;
    else if (['session.merged', 'session.discarded', 'session.closed'].includes(event.kind)) {
      ready = gating = merging = false;
      running.clear();
      approvals.clear();
      questions.clear();
    }
  }
  return slices;
}

export interface MergedPayload {
  from_sha?: string;
  branch?: string;
  to_sha: string;
  additions?: number;
  deletions?: number;
}

// Completion takes precedence over waiting, blocked merges, active work and the dispatch queue.
export function planTaskState(
  ctx: ControlContext,
  plan: BoardPlan,
  task: BoardPlan['tasks'][number],
  sessions: Session[],
  waiting: ReadonlySet<string>,
  turns: ReadonlyMap<string, SessionTurn[]>,
  dispatched: ReadonlySet<string>,
  wait: DispatchWait | undefined,
  // By session, whether its worktree is clean with commits past its base; absent while no read says.
  ready: ReadonlyMap<string, boolean>,
): BoardTaskState {
  if (
    taskState(
      plan,
      task.id,
      sessions.filter((session) => session.outcome !== 'discarded'),
    ) === 'done'
  )
    return 'merged';
  const open = sessions.filter((session) => session.state !== 'closed');
  if (
    open.some((session) => waiting.has(session.id) || session.merge?.reason === 'workflow_approval')
  )
    return 'waiting_approval';
  if (
    open.some(
      (session) =>
        session.state === 'reconciling' ||
        (session.merge?.state === 'blocked' && session.merge.reason !== 'cancelled'),
    )
  )
    return 'blocked';
  if (open.some((session) => session.merge?.state === 'running')) return 'gating';
  if (
    task.done_when === 'report' &&
    doneReported(ctx, plan, task.id) &&
    !sessions.some((session) =>
      turns.get(session.id)!.some((turn) => turn.state === 'queued' || turn.state === 'running'),
    )
  )
    return 'awaiting_acceptance';
  if (
    open.length &&
    open.every(
      (session) =>
        ready.get(session.id) === true &&
        !turns.get(session.id)!.some((turn) => turn.state === 'queued' || turn.state === 'running'),
    )
  )
    return 'awaiting_merge';
  if (
    open.length &&
    open.every(
      (session) =>
        dispatched.has(session.id) &&
        ready.has(session.id) &&
        !turns.get(session.id)!.some((turn) => turn.state === 'queued' || turn.state === 'running'),
    ) &&
    open.some((session) => turns.get(session.id)!.length)
  )
    return 'needs_attention';
  if (
    open.some(
      (session) =>
        !dispatched.has(session.id) ||
        turns.get(session.id)!.some((turn) => turn.state !== 'queued'),
    )
  )
    return 'running';
  if (open.length) return 'claimed';
  // Not done with every session closed: a part that did not merge failed the task.
  if (sessions.some((session) => session.outcome !== 'merged') && !ownEntry(plan.dispatch, task.id))
    return 'failed';
  return wait === 'upstream' ? 'waiting_upstream' : 'todo';
}

/**
 * The project board over the chosen local days. Each task of a lead plan is one task made of the
 * sessions opened from it; every other workbench session is a task of its own, except leads that
 * wrote a plan.
 */
export function boardView(
  ctx: ControlContext,
  principal: Principal,
  projectId: string,
  days: number | 'all',
  until?: string,
  sessions: WorkbenchSession[] = sessionList(ctx, principal, projectId),
  // The project's needsYou items, when the caller already read them.
  needItems?: NeedsYouItem[],
): BoardModel {
  const listed = sessions.filter((session) => session.workspace_id);
  const now = ctx.store.now();
  requireThat(
    until === undefined || days !== 'all',
    'invalid_input',
    'All time cannot have an end day',
  );
  requireThat(
    until === undefined || until <= dayKey(now),
    'invalid_input',
    'The end day is after today',
  );
  const rangeEnd =
      until === undefined ? now : midnight(new Date(`${until}T00:00:00`).getTime(), 1) - 1,
    since =
      days === 'all'
        ? midnight(ctx.store.eventSpan(projectId)!.first)
        : midnight(rangeEnd, 1 - days),
    presentSince = days === 'all' ? since : midnight(now, 1 - days),
    inRange = (at: number) => at >= since && at <= rangeEnd;
  // A lead merges once per direct task: `merged` keeps each session's newest, `mergeList` all.
  const merged = new Map<string, { at: number; payload: MergedPayload }>(),
    mergeList: { session_id: string; at: number; payload: MergedPayload }[] = [],
    discarded = new Map<string, number>(),
    gated = new Set<string>(),
    gateStarted = new Map<string, number>(),
    mergeStarted = new Map<string, number>(),
    runtimeChanges = new Map<string, { at: number; from: string }[]>(),
    dispatched = new Set<string>(),
    dispatchTimes = new Map<string, number>();
  let boardAt: number | null = null;
  const events = boardEvents(ctx, projectId, [
    'session.merged',
    'session.discarded',
    'session.gate_checked',
    'session.gate_started',
    'session.merge_started',
    'session.runtime_changed',
    'session.model_changed',
    'agent.tool.started',
    'review.requested',
    'project.board_updated',
    'task.dispatched',
    'task.claimed',
    'session.pr_created',
    ...PROGRESS_KINDS,
    'session.opened',
    'session.closed',
    'session.merge_blocked',
    'session.merge_cancelled',
    'session.gate_run_cancelled',
    'session.gate_run_failed',
    'turn.queued',
    'approval.requested',
    'approval.approved',
    'approval.rejected',
    'approval.void',
    'approval.resolved',
    'lead.question_asked',
    'lead.question_answered',
  ]);
  for (const event of events) {
    if (event.kind === 'session.merged') {
      const merge = { at: event.created_at, payload: event.payload as MergedPayload };
      merged.set(event.aggregate_id, merge);
      mergeList.push({ session_id: event.aggregate_id, ...merge });
    } else if (event.kind === 'session.discarded')
      discarded.set(event.aggregate_id, event.created_at);
    else if (event.kind === 'session.gate_checked') gated.add(event.aggregate_id);
    else if (event.kind === 'session.gate_started')
      gateStarted.set(event.aggregate_id, event.created_at);
    else if (event.kind === 'session.merge_started')
      mergeStarted.set(event.aggregate_id, event.created_at);
    else if (event.kind === 'session.runtime_changed')
      runtimeChanges.set(event.aggregate_id, [
        ...(runtimeChanges.get(event.aggregate_id) ?? []),
        { at: event.created_at, from: (event.payload as { from: string }).from },
      ]);
    else if (event.kind === 'task.dispatched') {
      const payload = event.payload as { session_id: string; session_ids?: string[] };
      for (const sessionId of payload.session_ids ?? [payload.session_id]) {
        dispatched.add(sessionId);
        if (!dispatchTimes.has(sessionId)) dispatchTimes.set(sessionId, event.created_at);
      }
    } else if (event.kind === 'project.board_updated') boardAt = event.created_at;
  }
  /** The runtime a turn whose last event is at `at` ran on: a change comes only between turns. */
  const runtimeAt = (session: Session, at: number) =>
    runtimeChanges.get(session.id)?.find((change) => change.at >= at)?.from ?? session.runtime;
  const turnsOf = new Map<string, SessionTurn[]>(listed.map((session) => [session.id, []]));
  const allTurns = ctx.store.list<SessionTurn>('session_turns');
  for (const turn of allTurns) turnsOf.get(turn.session_id)?.push(turn);
  // Commits record no event of their own; a merge or a turn end stands for them.
  const sessionOfTurn = new Map(
    [...turnsOf].flatMap(([sessionId, turns]) =>
      turns.map((turn) => [turn.id, sessionId] as const),
    ),
  );
  const progressed = new Map<string, number>(),
    turnErrors = new Map<string, string | undefined>();
  for (const event of events) {
    if (!PROGRESS_KINDS.includes(event.kind)) continue;
    const sessionId = sessionOfTurn.get(event.aggregate_id) ?? event.aggregate_id;
    progressed.set(sessionId, Math.max(progressed.get(sessionId) ?? 0, event.created_at));
    // The turn row does not keep its error.
    if (event.kind === 'turn.failed')
      turnErrors.set(event.aggregate_id, (event.payload as { error?: string }).error);
  }
  const runningTurns = new Map<string, SessionTurn>();
  for (const [sessionId, turns] of turnsOf) {
    const running = turns.findLast((turn) => turn.state === 'running');
    if (running) runningTurns.set(sessionId, running);
  }
  // Each session's oldest pending request.
  const requests = new Map<string, Approval>();
  for (const approval of ctx.store.list<Approval>('approvals')) {
    if (
      approval.project_id !== projectId ||
      approval.kind !== 'permission' ||
      approval.state !== 'pending' ||
      !approval.session_id
    )
      continue;
    const oldest = requests.get(approval.session_id);
    if (!oldest || approval.created_at < oldest.created_at)
      requests.set(approval.session_id, approval);
  }

  const previous: BoardModel['counts']['previous'] =
    days === 'all' ? undefined : { tokens: 0, cost_usd: null, merged: 0, median_ms: null };
  const counts: BoardModel['counts'] = {
    running: 0,
    waiting: 0,
    ready: 0,
    failed: 0,
    merged: 0,
    reverted: 0,
    median_ms: null,
    tokens: 0,
    tokens_by_runtime: {},
    cost_usd: null,
    ...(previous ? { previous } : {}),
  };
  const ranges = [
    {
      since,
      end: rangeEnd,
      counts,
      cycles: [] as number[],
      times: [] as Record<TimePart, number>[],
      input: 0,
      cache: 0,
    },
    ...(days === 'all'
      ? []
      : [
          {
            since: midnight(since, -days),
            end: since - 1,
            counts: previous!,
            cycles: [] as number[],
            times: [] as Record<TimePart, number>[],
            input: 0,
            cache: 0,
          },
        ]),
  ];
  const sessionOf = new Map(
    allTurns
      .filter((turn) => turn.project_id === projectId)
      .map((turn) => [turn.id, turn.session_id]),
  );
  const timeEvents = new Map<string, Event[]>();
  for (const event of events) {
    if (
      [
        'agent.tool.completed',
        'agent.tool.started',
        'review.requested',
        'session.model_changed',
        'session.runtime_changed',
        'project.board_updated',
        'task.dispatched',
      ].includes(event.kind)
    )
      continue;
    const sessionId = event.kind.startsWith('approval.')
      ? (event.payload as Approval).session_id
      : (sessionOf.get(event.aggregate_id) ?? event.aggregate_id);
    if (!sessionId) continue;
    const history = timeEvents.get(sessionId) ?? [];
    history.push(event);
    timeEvents.set(sessionId, history);
  }
  const waitEnd = until === undefined ? now : rangeEnd + 1;
  const waitByReason: NonNullable<BoardModel['counts']['wait_by_reason_ms']> = {};
  const sessionTimes = new Map<string, Record<TimePart, number>>();
  // An ended turn alone does not say a session has a change to review: only a merged session and one that is ready now count.
  const reviewable = new Set(
    sessions
      .filter((session) => session.state === 'ready' || session.state === 'merging')
      .map((session) => session.id),
  );
  const spans = eventSpans(ctx, [
    ...timeEvents.keys(),
    ...[...turnsOf].flatMap(([sessionId, turns]) => [sessionId, ...turns.map((turn) => turn.id)]),
  ]);
  for (const [sessionId, history] of timeEvents) {
    history.sort((a, b) => a.created_at - b.created_at || a.sequence - b.sequence);
    const first = spans.get(sessionId)?.first;
    if (first === undefined) continue;
    const parts: Record<TimePart, number> = {
      working_ms: 0,
      waiting_ms: 0,
      gate_ms: 0,
      queue_ms: 0,
    };
    const merge = merged.get(sessionId);
    for (const slice of sessionTimeSlices(
      history.filter((event) => event.created_at <= now),
      first,
      now,
    )) {
      if (merge)
        parts[slice.part] += Math.max(
          0,
          Math.min(slice.to, merge.at) - Math.max(slice.from, first),
        );
      if (slice.reason && (slice.reason !== 'review' || merge || reviewable.has(sessionId))) {
        const ms = Math.max(0, Math.min(slice.to, waitEnd) - Math.max(slice.from, since));
        if (ms) waitByReason[slice.reason] = (waitByReason[slice.reason] ?? 0) + ms;
      }
    }
    if (merge) sessionTimes.set(sessionId, parts);
  }
  if (Object.keys(waitByReason).length) counts.wait_by_reason_ms = waitByReason;
  const compacted = new Set(
    ctx.store
      .kindEvents(projectId, ['agent.context.compacted'])
      .filter((event) => inRange(event.created_at))
      .map((event) => event.aggregate_id),
  );
  const compactedSessions = listed.filter((session) => compacted.has(session.id)).length;
  if (compactedSessions) counts.compacted_sessions = compactedSessions;
  const gateCommands = new Map<
    string,
    { failed_runs: number; runs: number; commits: Map<string, Set<boolean>> }
  >();
  const worktreeSessions = new Set(listed.map((session) => session.id));
  for (const event of events) {
    if (event.kind !== 'session.gate_checked') continue;
    if (!inRange(event.created_at) || !worktreeSessions.has(event.aggregate_id)) continue;
    const run = event.payload as {
      commit?: string;
      results?: NonNullable<LandingItem['gate_results']>;
    };
    for (const result of run.results ?? []) {
      if (result.carried) continue;
      let command = gateCommands.get(result.name);
      if (!command) {
        command = { failed_runs: 0, runs: 0, commits: new Map() };
        gateCommands.set(result.name, command);
      }
      const failed = gateFailed(result);
      command.runs++;
      if (failed) command.failed_runs++;
      if (run.commit) {
        let outcomes = command.commits.get(run.commit);
        if (!outcomes) command.commits.set(run.commit, (outcomes = new Set()));
        outcomes.add(failed);
      }
    }
  }
  const gateFailures = [...gateCommands]
    .filter(([, command]) => command.failed_runs >= 2)
    .map(([name, command]) => ({
      name,
      failed_runs: command.failed_runs,
      runs: command.runs,
      flaky: [...command.commits.values()].some((outcomes) => outcomes.size === 2),
    }))
    .sort((a, b) => b.failed_runs - a.failed_runs || a.name.localeCompare(b.name))
    .slice(0, 10);
  type Task = BoardModel['tasks'][number];
  // Every session's own row, whether or not its task row is shown.
  const rows = new Map<string, Task>(),
    shown = new Set<string>(),
    stored = new Map<string, Session>(),
    usage = new Map<string, BoardModel['usage'][number]>(),
    models = new Map<string, BoardModel['models'][number]>(),
    started = new Map<string, number>();
  for (const listedSession of listed) {
    const session = ctx.store.must<Session>('sessions', listedSession.id),
      model = listedSession.model,
      latestTurn = latestExecuted(ctx, turnsOf.get(session.id)!),
      // An open session whose newest turn failed stays failed until a new turn starts.
      turnFailed =
        (listedSession.state === 'idle' || listedSession.state === 'ready') &&
        latestTurn?.state === 'failed',
      listedStatus = TASK_STATUS[listedSession.state],
      status = turnFailed ? 'failed' : listedStatus,
      span = spans.get(session.id),
      merge = merged.get(session.id);
    const blockers: string[] = [],
      blockerCodes: BoardBlocker[] = [];
    if (
      listedSession.merge?.state === 'blocked' &&
      !['cancelled', 'workflow_approval'].includes(listedSession.merge.reason ?? '')
    ) {
      const { reason, conflicts = [] } = listedSession.merge;
      blockers.push(
        `Merge blocked${reason ? `: ${reason}` : ''}, ${conflicts.length} conflicting files`,
      );
      blockerCodes.push({
        code: 'merge_blocked',
        ...(reason ? { reason } : {}),
        conflicts: conflicts.length,
      });
    }
    if (turnFailed) {
      const error = turnErrors.get(latestTurn!.id)?.slice(0, 120);
      blockers.push(error ? `Turn failed: ${error}` : 'Turn failed');
      blockerCodes.push({ code: 'turn_failed', ...(error ? { error } : {}) });
    }
    stored.set(session.id, session);
    if (span) started.set(session.id, span.first);
    let tokens = 0;
    const silentRows = new Set<string>(),
      silentRuntimes = new Set<string>();
    for (const turn of turnsOf.get(session.id)!) {
      const at = spans.get(turn.id)?.last;
      const unreported =
        turn.state !== 'queued' &&
        turn.state !== 'running' &&
        !!spans.get(turn.id)?.ran &&
        (!turn.usage || !!turn.usage.tokens_unreported);
      if ((!turn.usage && !unreported) || at === undefined) continue;
      const turnTokens = turn.usage ? turn.usage.input_tokens + turn.usage.output_tokens : 0,
        turnModel = turn.model === undefined ? model : turn.model,
        runtime = runtimeAt(session, at),
        modelKey = `${runtime}\0${turnModel ?? ''}`;
      tokens += turnTokens;
      const seen = models.get(modelKey);
      if (!seen || at < seen.first_seen)
        models.set(modelKey, { runtime, model: turnModel, first_seen: at });
      const range = ranges.find((range) => at >= range.since && at <= range.end);
      if (!range) continue;
      range.counts.tokens += turnTokens;
      if (turn.usage?.cost_usd !== undefined)
        range.counts.cost_usd = (range.counts.cost_usd ?? 0) + turn.usage.cost_usd;
      if (turn.usage?.cached_input_tokens !== undefined) {
        range.input += turn.usage.input_tokens;
        range.cache += turn.usage.cached_input_tokens;
      }
      if (range.counts !== counts) continue;
      counts.tokens_by_runtime[runtime] = (counts.tokens_by_runtime[runtime] ?? 0) + turnTokens;
      const key = `${dayKey(at)}\0${modelKey}`,
        row = usage.get(key) ?? {
          day: dayKey(at),
          runtime,
          model: turnModel,
          tokens: 0,
          cost_usd: null,
        };
      row.tokens += turnTokens;
      if (turn.usage?.cost_usd !== undefined)
        row.cost_usd = (row.cost_usd ?? 0) + turn.usage.cost_usd;
      usage.set(key, row);
      if (unreported) {
        silentRows.add(key);
        silentRuntimes.add(runtime);
      }
    }
    for (const key of silentRows) {
      const row = usage.get(key)!;
      row.sessions_without_usage = (row.sessions_without_usage ?? 0) + 1;
    }
    if (silentRuntimes.size > 0) {
      counts.sessions_without_usage = (counts.sessions_without_usage ?? 0) + 1;
      const byRuntime = (counts.sessions_without_usage_by_runtime ??= {});
      for (const runtime of silentRuntimes) byRuntime[runtime] = (byRuntime[runtime] ?? 0) + 1;
    }
    if (merge && span) {
      const range = ranges.find((range) => merge.at >= range.since && merge.at <= range.end);
      if (range) {
        range.cycles.push(merge.at - span.first);
        range.times.push(sessionTimes.get(session.id)!);
      }
    }
    const ended =
      listedStatus === 'done'
        ? (merge?.at ?? null)
        : listedStatus === 'discarded'
          ? (discarded.get(session.id) ?? null)
          : listedStatus === 'failed'
            ? (span?.last ?? null)
            : null;
    const changes = status === 'done' ? null : listedSession.changes;
    rows.set(session.id, {
      id: session.id,
      ...(session.forked_from ? { forked_from: session.forked_from } : {}),
      title: listedSession.title,
      goal: turnsOf.get(session.id)![0]?.input.slice(0, 200) ?? '',
      scope: [],
      lane_id: null,
      milestone_id: null,
      status,
      blockers,
      blocker_codes: blockerCodes,
      segments: [
        {
          id: session.id,
          session_id: session.id,
          title: listedSession.title,
          runtime: session.runtime,
          model,
          status,
          started_at: span?.first ?? null,
          ended_at: ended,
          tokens,
          ...(merge?.payload.additions !== undefined
            ? { additions: merge.payload.additions }
            : changes
              ? { additions: changes.additions }
              : {}),
          ...(merge?.payload.deletions !== undefined
            ? { deletions: merge.payload.deletions }
            : changes
              ? { deletions: changes.deletions }
              : {}),
        },
      ],
      additions: merge ? (merge.payload.additions ?? 0) : (changes?.additions ?? null),
      deletions: merge ? (merge.payload.deletions ?? 0) : (changes?.deletions ?? null),
      checks:
        listedSession.state === 'merging' ||
        ['running', 'cancelling'].includes(listedSession.gate?.state ?? '')
          ? 'running'
          : listedSession.merge?.reason === 'gate_failed' || listedSession.gate?.state === 'failed'
            ? 'fail'
            : (status === 'done' && gated.has(session.id)) || listedSession.gate?.state === 'passed'
              ? 'pass'
              : 'none',
      started_at: span?.first ?? null,
      ended_at: ended,
      last_progress_at: progressed.get(session.id) ?? null,
      blocked_since: null,
      turn_running: listedSession.state === 'running',
    });
    // A past range also keeps the rows that ended within it; the counts stay the present ones.
    const present = ended === null || ended >= presentSince;
    if (!present && !inRange(ended!)) continue;
    shown.add(session.id);
    if (
      present &&
      (status === 'running' || status === 'waiting' || status === 'ready' || status === 'failed')
    )
      counts[status]++;
  }
  const titles = new Map(listed.map((session) => [session.id, session.title]));
  // A lead merges more than once, so a story belongs to the merge whose commits it explains.
  const storyKey = (sessionId: string, from: string, to: string) =>
    JSON.stringify([sessionId, from, to]);
  const stories = new Map<string, ChangeStory>();
  for (const story of ctx.store.list<ChangeStory>('change_stories')) {
    const sessionId = story.workbench_session_id;
    if (story.project_id !== projectId || story.state !== 'ready' || !sessionId) continue;
    // Keyed by range, and by session alone for the newest story of the session.
    for (const key of [storyKey(sessionId, story.from_sha, story.to_sha), sessionId]) {
      const newest = stories.get(key);
      if (!newest || story.created_at > newest.created_at) stories.set(key, story);
    }
  }
  const mergesOf = new Map<string, number>();
  for (const merge of mergeList)
    mergesOf.set(merge.session_id, (mergesOf.get(merge.session_id) ?? 0) + 1);
  const merges: BoardModel['merges'] = mergeList
    .filter((merge) => inRange(merge.at))
    .sort((a, b) => b.at - a.at)
    .map((merge) => ({
      session_id: merge.session_id,
      title: titles.get(merge.session_id) ?? '',
      merged_at: merge.at,
      from_sha: merge.payload.from_sha ?? null,
      sha: merge.payload.to_sha,
      additions: merge.payload.additions ?? 0,
      deletions: merge.payload.deletions ?? 0,
      // A story written before the merge covers the worktree's range, which a rebase moves.
      story_id:
        (merge.payload.from_sha &&
          stories.get(storyKey(merge.session_id, merge.payload.from_sha, merge.payload.to_sha))
            ?.id) ||
        (mergesOf.get(merge.session_id) === 1 ? stories.get(merge.session_id)?.id : undefined) ||
        null,
    }));
  for (const range of ranges) {
    range.counts.merged = mergeList.filter(
      (merge) => merge.at >= range.since && merge.at <= range.end,
    ).length;
    range.counts.median_ms = median(range.cycles);
    if (range.times.length)
      range.counts.session_time = {
        sessions: range.times.length,
        working_ms: median(range.times.map((time) => time.working_ms))!,
        waiting_ms: median(range.times.map((time) => time.waiting_ms))!,
        gate_ms: median(range.times.map((time) => time.gate_ms))!,
        queue_ms: median(range.times.map((time) => time.queue_ms))!,
      };
    Object.assign(range.counts, cacheReadShare(range.input, range.cache));
  }

  for (const [source, rangedMerges] of mergeRepositories(
    ctx,
    projectId,
    mergeList.filter((merge) => inRange(merge.at)),
  )) {
    const branches = mergedBranches(rangedMerges);
    // A walk not read yet, or of a repository moved or deleted since, leaves its merges uncounted.
    const walk = revertWalks.get(ctx)?.get(JSON.stringify([projectId, source]))?.commits;
    if (!walk) continue;
    const commits = new Map<string, { parents: string[]; reverts: string[] }>(),
      tips = new Map<string, string>();
    for (const { sha, parents, branch, refs, time, reverts } of walk) {
      // As git log --until would: a commit dated after the range is left out, its ancestors are not.
      if (time * 1000 > rangeEnd) continue;
      commits.set(sha, { parents, reverts });
      if (!tips.has(branch)) tips.set(branch, sha);
      for (const ref of refs) if (branches.includes(ref)) tips.set(ref, sha);
    }
    const ancestors = (tip: string) => {
      const found = new Set<string>(),
        pending = [tip];
      while (pending.length) {
        const sha = pending.pop()!;
        if (found.has(sha)) continue;
        found.add(sha);
        pending.push(...(commits.get(sha)?.parents ?? []));
      }
      return found;
    };
    for (const merge of rangedMerges) {
      const before = merge.payload.from_sha ? ancestors(merge.payload.from_sha) : new Set<string>(),
        landed = merge.payload.from_sha
          ? ancestors(merge.payload.to_sha)
          : new Set([merge.payload.to_sha]),
        branch = merge.payload.branch ? `refs/heads/${merge.payload.branch}` : 'HEAD',
        tip = tips.get(branch);
      for (const sha of before) landed.delete(sha);
      if (
        tip &&
        [...ancestors(tip)].some((sha) => {
          const commit = commits.get(sha);
          return (
            commit?.reverts.some((reverted) => landed.has(reverted)) &&
            sha !== merge.payload.to_sha &&
            ancestors(sha).has(merge.payload.to_sha)
          );
        })
      )
        counts.reverted++;
    }
  }

  const burnup: BoardModel['burnup'] = [];
  for (let day = since; day <= rangeEnd; day = midnight(day, 1)) {
    const end = midnight(day, 1);
    // In tasks, as done counts them: each merge is one, as is a kept session with none yet.
    const landed = (sessionId: string) =>
      mergeList.filter((merge) => merge.session_id === sessionId && merge.at < end).length;
    burnup.push({
      day: dayKey(day),
      scope: listed.reduce(
        (scope, session) =>
          scope +
          ((started.get(session.id) ?? end) >= end
            ? 0
            : (discarded.get(session.id) ?? end) < end
              ? landed(session.id)
              : Math.max(1, landed(session.id))),
        0,
      ),
      done: mergeList.filter((merge) => merge.at < end).length,
    });
  }

  const board = ctx.store.get<ProjectBoard>('project_boards', projectId),
    facts = projectFacts(ctx, projectId),
    plans = ctx.store
      .list<BoardPlan>('board_plans')
      .filter((plan) => plan.project_id === projectId);
  const leadMilestones = new Map(
    facts.milestones
      .filter((view) => view.milestone.owner_session_id)
      .map((view) => [
        `${view.milestone.owner_session_id}:${view.milestone.key}`,
        view.milestone.id,
      ]),
  );
  // Each update event carries the whole plan; a transfer moves a plan to another lead's id.
  const planEvents = planHistory(ctx, projectId),
    transfers = new Map<string, string>(),
    versions = new Map<
      string,
      {
        at: number;
        created: boolean;
        tasks: BoardPlan['tasks'];
        generations?: BoardPlan['generations'];
      }[]
    >();
  for (const event of planEvents)
    if (event.kind === 'board.plan_transferred')
      transfers.set((event.payload as { from: string }).from, event.aggregate_id);
  for (const event of planEvents) {
    if (event.kind !== 'board.plan_updated') continue;
    let lead = event.aggregate_id;
    while (transfers.has(lead)) lead = transfers.get(lead)!;
    const history = versions.get(lead) ?? [];
    history.push({
      at: event.created_at,
      created: event.aggregate_revision === 1,
      tasks: (event.payload as BoardPlan).tasks,
      generations: (event.payload as BoardPlan).generations,
    });
    versions.set(lead, history);
  }
  /**
   * The plan task ids just before `at`, each with its generation then; null when a plan's history
   * before then is not stored.
   */
  const plannedBefore = (at: number): Map<string, number> | null => {
    const keys = new Map<string, number>();
    for (const plan of plans) {
      const history = versions.get(plan.id) ?? [],
        known = history.filter((version) => version.at < at);
      // Without a version yet, a plan whose creation is stored did not exist.
      if (!known.length && history[0]?.created) continue;
      if (!known.length) return null;
      const version = known.at(-1)!;
      for (const task of version.tasks)
        keys.set(
          boardTaskId(plan.id, task.id),
          ownEntry(version.generations, task.id)?.generation ?? 1,
        );
    }
    return keys;
  };
  // The newest direct merge and the first claim of each lead's task generation.
  const directMerges = new Map<string, Event>(),
    claims = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== 'session.merged' && event.kind !== 'task.claimed') continue;
    const payload = event.payload as {
        direct?: boolean;
        task_id?: string;
        generation?: number;
      } | null,
      key = JSON.stringify([event.aggregate_id, payload?.task_id, payload?.generation]);
    if (event.kind === 'session.merged') {
      if (payload?.direct) directMerges.set(key, event);
    } else if (!claims.has(key)) claims.set(key, event.created_at);
  }
  const firstOpened = new Map<string, number>(),
    firstDone = new Map<string, number>(),
    doneByGeneration = new Map<string, Map<number, number>>();
  const markDone = (key: string, generation: number, at: number) => {
    const generations = doneByGeneration.get(key) ?? new Map<number, number>();
    generations.set(generation, Math.min(generations.get(generation) ?? at, at));
    doneByGeneration.set(key, generations);
  };
  const generationSessions = new Map<string, Session[]>();
  for (const [sessionId, session] of stored) {
    if (!session.task) continue;
    const plan = plans.find((each) => each.id === session.task!.lead_session_id);
    const key = boardTaskId(session.task.lead_session_id, session.task.id),
      generation = session.task.generation ?? 1,
      opened = started.get(sessionId),
      merge = merged.get(sessionId),
      id = JSON.stringify([key, generation]);
    generationSessions.set(id, [...(generationSessions.get(id) ?? []), session]);
    // A session of a removed task does not count for a new task that reuses its id.
    if (generation <= (ownEntry(plan?.retired, session.task.id) ?? 0)) continue;
    if (opened !== undefined)
      firstOpened.set(key, Math.min(firstOpened.get(key) ?? opened, opened));
    if (merge) firstDone.set(key, Math.min(firstDone.get(key) ?? merge.at, merge.at));
  }
  // The trend counts a generation done once every session of it not discarded merged.
  for (const [id, sessions] of generationSessions) {
    const live = sessions.filter((session) => session.outcome !== 'discarded');
    if (!live.length || !live.every((session) => merged.has(session.id))) continue;
    const [key, generation] = JSON.parse(id) as [string, number];
    markDone(key, generation, Math.max(...live.map((session) => merged.get(session.id)!.at)));
  }
  for (const merge of directMerges.values()) {
    const { task_id: taskId, generation } = merge.payload as {
        task_id: string;
        generation: number;
      },
      key = boardTaskId(merge.aggregate_id, taskId);
    markDone(key, generation, merge.created_at);
    const plan = plans.find((each) => each.id === merge.aggregate_id);
    if (generation <= (ownEntry(plan?.retired, taskId) ?? 0)) continue;
    firstDone.set(key, Math.min(firstDone.get(key) ?? merge.created_at, merge.created_at));
  }
  // An accepted report task is done when the lead accepted it, even once the plan dropped it.
  for (const event of ctx.store.kindEvents(projectId, ['task.accepted'])) {
    const { task_id: taskId, generation = 1 } = event.payload as {
      task_id: string;
      generation?: number;
    };
    let lead = event.aggregate_id;
    while (transfers.has(lead)) lead = transfers.get(lead)!;
    const key = boardTaskId(lead, taskId);
    markDone(key, generation, event.created_at);
    const plan = plans.find((each) => each.id === lead);
    if (generation <= (ownEntry(plan?.retired, taskId) ?? 0)) continue;
    firstDone.set(key, Math.min(firstDone.get(key) ?? event.created_at, event.created_at));
  }
  for (const plan of plans)
    for (const task of plan.tasks) {
      const key = boardTaskId(plan.id, task.id),
        accepted = currentAcceptance(plan, task.id);
      if (!accepted) continue;
      firstDone.set(key, Math.min(firstDone.get(key) ?? accepted.at, accepted.at));
      markDone(key, accepted.generation ?? 1, accepted.at);
    }
  // Each plan task's session rows and its status over the ones not discarded.
  const planned = new Set<string>(),
    taskRows = new Map<string, { bound: Task[]; live: Task[]; status: BoardTaskStatus }>();
  for (const plan of plans) {
    planned.add(plan.id);
    for (const task of plan.tasks) {
      // As taskSessions, a session a changed contract has yet to reach stays on the card.
      const bound = [...rows.values()].filter((row) => {
        const session = stored.get(row.id)!,
          binding = session.task;
        return (
          binding?.lead_session_id === plan.id &&
          binding.id === task.id &&
          (currentBinding(plan, binding) || (!session.outcome && awaitingChange(plan, session)))
        );
      });
      // The lead's claim of this generation stands as the task's session, as a task session would.
      const lead = stored.get(plan.id),
        leadRow = rows.get(plan.id),
        directKey = JSON.stringify([plan.id, task.id, taskGeneration(plan, task.id)]),
        directMerge = currentDirectMerge(plan, task.id) && directMerges.get(directKey),
        claimed =
          lead?.direct_task?.id === task.id &&
          lead.direct_task.generation === taskGeneration(plan, task.id);
      // A claim stands as a session from the claim to its merge, or to now while it is held.
      if ((claimed || directMerge) && leadRow) {
        const payload = !claimed && directMerge ? (directMerge.payload as MergedPayload) : null,
          claimedAt = claims.get(directKey) ?? null,
          until = payload ? directMerge!.created_at : now,
          // The worktree's changes may hold work from before the claim, so a held claim shows none.
          diff = payload
            ? { additions: payload.additions ?? 0, deletions: payload.deletions ?? 0 }
            : {},
          // The lead's other work is not this task's: only what happened from the claim on.
          within = (at: number | undefined) =>
            claimedAt !== null && at !== undefined && at >= claimedAt && at <= until,
          turns = turnsOf.get(plan.id)!.filter((turn) => within(spans.get(turn.id)?.last)),
          newest = turns.at(-1),
          progress = events
            .filter(
              (event) =>
                PROGRESS_KINDS.includes(event.kind) &&
                (sessionOfTurn.get(event.aggregate_id) ?? event.aggregate_id) === plan.id &&
                within(event.created_at),
            )
            .map((event) => event.created_at),
          gateEvent = (kinds: string[]) =>
            events.some(
              (event) =>
                kinds.includes(event.kind) &&
                event.aggregate_id === plan.id &&
                within(event.created_at),
            );
        const { additions: _additions, deletions: _deletions, ...segment } = leadRow.segments[0]!;
        bound.push({
          ...leadRow,
          ...(payload ? { status: 'done' as const, blockers: [], blocker_codes: [] } : {}),
          segments: [
            {
              ...segment,
              runtime: newest ? runtimeAt(lead!, spans.get(newest.id)!.last) : null,
              model: newest?.model ?? null,
              ...(payload ? { status: 'done' as const } : {}),
              started_at: claimedAt,
              ended_at: payload ? until : null,
              tokens: turns.reduce(
                (sum, turn) =>
                  sum + (turn.usage ? turn.usage.input_tokens + turn.usage.output_tokens : 0),
                0,
              ),
              ...diff,
            },
          ],
          additions: diff.additions ?? null,
          deletions: diff.deletions ?? null,
          checks: payload
            ? gateEvent(['session.gate_checked'])
              ? 'pass'
              : 'none'
            : gateEvent(['session.gate_started', 'session.gate_checked'])
              ? leadRow.checks
              : 'none',
          started_at: claimedAt,
          ended_at: payload ? until : null,
          last_progress_at: progress.length ? Math.max(...progress) : null,
          turn_running: payload ? false : leadRow.turn_running,
        });
      }
      for (const row of bound) planned.add(row.id);
      const live = bound.filter((row) => row.status !== 'discarded');
      const unfinished = (['waiting', 'failed', 'running', 'idle', 'ready'] as const).find(
        (candidate) => live.some((row) => row.status === candidate),
      );
      const status: BoardTaskStatus =
        currentAcceptance(plan, task.id) || (currentDirectMerge(plan, task.id) && !unfinished)
          ? 'done'
          : !live.length
            ? 'todo'
            : (unfinished ??
              // A report task is done only once accepted, however its sessions ended.
              (taskState(
                plan,
                task.id,
                live.filter((row) => row.id !== plan.id).map((row) => stored.get(row.id)!),
                lead,
              ) === 'done'
                ? 'done'
                : 'idle'));
      taskRows.set(boardTaskId(plan.id, task.id), { bound, live, status });
    }
  }
  const sampleTasks = new Map<
    string,
    { plan: BoardPlan; task: BoardPlan['tasks'][number]; generation: number }
  >();
  for (const plan of plans)
    for (const snapshot of [...(versions.get(plan.id) ?? []), plan])
      for (const task of snapshot.tasks) {
        const generation = ownEntry(snapshot.generations, task.id)?.generation ?? 1;
        sampleTasks.set(`${boardTaskId(plan.id, task.id)}:${generation}`, {
          plan,
          task,
          generation,
        });
      }
  const durations = [...sampleTasks.values()].flatMap(({ plan, task, generation }) => {
    const direct = directMerges.get(JSON.stringify([plan.id, task.id, generation])),
      bound = [...stored.values()].filter(
        (session) =>
          session.task?.lead_session_id === plan.id &&
          session.task.id === task.id &&
          (session.task.generation ?? 1) === generation,
      ),
      live = bound.filter((session) => session.outcome !== 'discarded');
    let first: number | undefined, end: number | undefined;
    if (direct) {
      first = claims.get(JSON.stringify([plan.id, task.id, generation]));
      end = direct.created_at;
    } else if (live.length && live.every((session) => merged.has(session.id))) {
      first = Math.min(
        ...bound.map((session) => dispatchTimes.get(session.id) ?? started.get(session.id)!),
      );
      end = Math.max(...live.map((session) => merged.get(session.id)!.at));
    }
    return first !== undefined &&
      end !== undefined &&
      end >= now - 90 * 24 * 60 * 60 * 1000 &&
      end <= now
      ? [{ estimate: task.estimate ?? 1, domain: task.kind?.domain, ms: end - first }]
      : [];
  });
  const estimates = new Map<string, number>();
  for (const plan of plans)
    for (const task of plan.tasks) {
      const points = durations.filter((sample) => sample.estimate === (task.estimate ?? 1)),
        domain = task.kind && points.filter((sample) => sample.domain === task.kind!.domain),
        samples = domain && domain.length >= 5 ? domain : points;
      if (samples.length >= 3)
        estimates.set(boardTaskId(plan.id, task.id), median(samples.map((sample) => sample.ms))!);
    }
  const taskDone = (key: string) => taskRows.get(key)?.status === 'done';
  /** The upstream task ids not yet done of a task not done itself. */
  const unmetOf = (plan: BoardPlan, task: BoardPlan['tasks'][number]) =>
    taskDone(boardTaskId(plan.id, task.id))
      ? []
      : task.depends_on.filter((dependency) => !taskDone(boardTaskId(plan.id, dependency)));
  const blockedSince = (plan: BoardPlan, task: BoardPlan['tasks'][number]) => {
    const unmet = unmetOf(plan, task).map((dependency) => {
      let from: number | null = null;
      for (const version of versions.get(plan.id) ?? [])
        from = version.tasks.some(
          (candidate) => candidate.id === task.id && candidate.depends_on.includes(dependency),
        )
          ? (from ?? version.at)
          : null;
      return from ?? plan.updated_at;
    });
    return unmet.length ? Math.min(...unmet) : null;
  };
  const queued = new Map(
    dispatchQueue(ctx, projectId).map(({ plan, task, wait }) => {
      const entry = ownEntry(plan.dispatch, task.id)!;
      // A task waiting for nothing opens on the next tick.
      const text = wait ? QUEUED_TEXT[wait] : 'Queued';
      return [
        boardTaskId(plan.id, task.id),
        {
          text: entry.error ? `${text} (the session could not open: ${entry.error.message})` : text,
          code: {
            code: 'queued',
            ...(entry.error ? { error: entry.error.message } : {}),
          } satisfies BoardBlocker,
          at: entry.requested_at,
          wait,
        },
      ];
    }),
  );
  const listedOf = new Map(listed.map((session) => [session.id, session])),
    planOf = new Map(plans.map((plan) => [plan.id, plan])),
    verify = verifiedProgressReader(ctx);
  /** What the session is doing now, counted as one attempt. */
  const activityOf = (sessionId: string): BoardActivity => {
    const listedSession = listedOf.get(sessionId)!,
      // A lead's own plan keeps the alerts of its turns.
      plan = planOf.get(stored.get(sessionId)!.task?.lead_session_id ?? sessionId),
      latestTurn = latestExecuted(ctx, turnsOf.get(sessionId)!),
      running = runningTurns.get(sessionId),
      request = requests.get(sessionId);
    const { phase, since, tool, activity } = runPhase(
      ctx,
      sessionId,
      listedSession,
      turnsOf.get(sessionId)!,
      request,
      {
        opened: started.get(sessionId),
        progressed: progressed.get(sessionId),
        merge_started: mergeStarted.get(sessionId),
        gate_started: gateStarted.get(sessionId),
      },
      now,
    );
    // The tracker keeps the alerts of running turns, and a loop across ended turns by session id.
    const alerts = [
      ...(running ? (ownEntry(plan?.alerted, running.id) ?? []) : []),
      ...(ownEntry(plan?.alerted, sessionId) ?? []),
    ];
    const waiting = request ? waitingOf(request) : undefined,
      error = latestTurn?.state === 'failed' ? turnErrors.get(latestTurn.id) : undefined,
      handedBack = [...new Set(ownEntry(plan?.handed_back, sessionId))],
      depth = chainDepth(ctx, latestTurn, stored.get(sessionId)!.task, verify);
    return {
      phase,
      since,
      ...(tool ? { tool } : {}),
      ...(waiting ? { waiting } : {}),
      ...(error ? { turn_error: error.slice(0, 200) } : {}),
      health: alerts.includes('looping')
        ? 'looping'
        : alerts.includes('stalled')
          ? 'stalled'
          : activity && quiet(activity, now)
            ? 'quiet'
            : 'fresh',
      attempt: 1,
      ...(handedBack?.length ? { handed_back: handedBack } : {}),
      ...(depth ? { causal_depth: depth } : {}),
    };
  };
  const retrospectives = latestRetrospectives(
    ctx.store.list<Retrospective>('retrospectives'),
    projectId,
  );
  for (const range of ranges) {
    const gate = gateFirstPass(retrospectives.values(), range.since, range.end);
    if (gate) range.counts.gate_first_pass = gate;
  }
  const totals: TaskTotals = {
    done: 0,
    running: 0,
    waiting: 0,
    idle: 0,
    ready: 0,
    failed: 0,
    discarded: 0,
    not_started: 0,
  };
  const tasks: Task[] = [],
    currentSessions = new Map<string, string>();
  const waitingSessions = new Set(requests.keys());
  const readySessions = new Map<string, boolean>();
  for (const session of listed) {
    const ready = cachedReady(
      ctx,
      stored.get(session.id)!,
      ctx.store.must<Workspace>('workspaces', session.workspace_id!),
      waitingSessions.has(session.id),
    );
    if (ready !== undefined) readySessions.set(session.id, ready);
  }
  // Startup retires the runs of other step kinds, so the runs not retired are reviews.
  const stepRuns = ctx.store
    .list<StepRun>('workflow_step_runs')
    .filter((run) => run.project_id === projectId && run.state !== 'retired')
    .sort((a, b) => a.created_at - b.created_at);
  const reviewersOf = (reviewId: string) => {
    const review = ctx.store.get<Review>('reviews', reviewId);
    return (review?.session_ids ?? []).map((id, index) => {
      const runtime = ctx.store.get<Session>('sessions', id)?.runtime ?? review!.runtimes[index]!;
      const given = reviewerVerdict(review!, id, runtime);
      return given ? { runtime, verdict: given.verdict, summary: given.summary } : { runtime };
    });
  };
  const total = (values: (number | null)[]) => {
    const known = values.filter((value) => value !== null);
    return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
  };
  for (const plan of plans) {
    for (const [order, task] of plan.tasks.entries()) {
      const { bound, live, status } = taskRows.get(boardTaskId(plan.id, task.id))!;
      const ends = live.flatMap((row) => (row.ended_at === null ? [] : [row.ended_at])),
        starts = bound.flatMap((row) => (row.started_at === null ? [] : [row.started_at]));
      // An accepted task ended when accepted, though its session may stay open.
      const accepted = currentAcceptance(plan, task.id),
        ended =
          status !== 'done'
            ? null
            : accepted
              ? accepted.at
              : ends.length
                ? Math.max(...ends)
                : null;
      // A task is counted by the status of all its parts; one whose sessions were all discarded as discarded.
      totals[
        status === 'todo'
          ? bound.some((row) => row.status === 'discarded')
            ? 'discarded'
            : 'not_started'
          : status
      ]++;
      if (ended !== null && ended < presentSince && !inRange(ended)) continue;
      const progress = bound.flatMap((row) =>
        row.last_progress_at === null ? [] : [row.last_progress_at],
      );
      // Each parallel part is its newest session; a task without parts has one.
      const parts = new Map<number | undefined, Task>();
      for (const row of live) {
        const part = stored.get(row.id)!.task?.parallel_index,
          seen = parts.get(part);
        if (!seen || (row.started_at ?? 0) >= (seen.started_at ?? 0)) parts.set(part, row);
      }
      const partRows = [...parts.values()],
        newestOf = (rows: Task[]) =>
          rows.reduce<Task | undefined>(
            (latest, row) =>
              !latest || (row.started_at ?? 0) >= (latest.started_at ?? 0) ? row : latest,
            undefined,
          );
      // The card follows the part most in need, so one ahead of the rest does not hide it.
      const newestLive =
        (['waiting', 'failed', 'running', 'idle', 'ready'] as const)
          .map((candidate) => newestOf(partRows.filter((row) => row.status === candidate)))
          .find((row) => row !== undefined) ?? newestOf(partRows);
      if (newestLive) currentSessions.set(boardTaskId(plan.id, task.id), newestLive.id);
      const waiting = queued.get(boardTaskId(plan.id, task.id));
      const step = waitingStep(ctx, plan, task);
      const runs = stepRuns.filter(
        (run) =>
          run.lead_session_id === plan.id &&
          run.task_id === task.id &&
          run.generation === taskGeneration(plan, task.id),
      );
      const state = planTaskState(
        ctx,
        plan,
        task,
        bound.map((row) => stored.get(row.id)!),
        waitingSessions,
        turnsOf,
        dispatched,
        waiting?.wait,
        readySessions,
      );
      const claimRow = live
        .filter((row) => row.id === plan.id || currentBinding(plan, stored.get(row.id)!.task!))
        .reduce<Task | undefined>(
          (latest, row) =>
            !latest || (row.started_at ?? 0) >= (latest.started_at ?? 0) ? row : latest,
          undefined,
        );
      const claim = claimRow && stored.get(claimRow.id)!;
      const recap = newestLive && stored.get(newestLive.id)!.recap;
      const retrospective = retrospectives.get(boardTaskId(plan.id, task.id));
      const budget =
        state === 'merged' || state === 'failed'
          ? undefined
          : taskBudgetUse(ctx, plan, task.id, now);
      const rung =
        state === 'merged'
          ? undefined
          : taskRung(
              taskRungFacts(
                ctx,
                plan,
                task.id,
                live
                  .filter((row) => row.id !== plan.id)
                  .sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0))
                  .map((row) => stored.get(row.id)!),
                now,
              ),
            );
      const unmetTitles = unmetOf(plan, task).map(
        (dependency) => plan.tasks.find((each) => each.id === dependency)?.title ?? dependency,
      );
      const blockers = [
        ...(waiting ? [waiting.text] : []),
        ...unmetTitles.map((title) => `Dependency “${title}” is not finished`),
        ...partRows.flatMap((row) => row.blockers),
      ].slice(0, 3);
      const blockerCodes = [
        ...(waiting ? [waiting.code] : []),
        ...unmetTitles.map((title): BoardBlocker => ({ code: 'upstream', title })),
        ...partRows.flatMap((row) => row.blocker_codes ?? []),
      ].slice(0, 3);
      tasks.push({
        id: boardTaskId(plan.id, task.id),
        owner_session_id: plan.id,
        order,
        ...(plan.order_lock?.includes(task.id) ? { order_locked: true as const } : {}),
        ...(task.parallel
          ? {
              parallel: task.parallel.map((part, index) => {
                const row = live.find(
                  (each) => stored.get(each.id)?.task?.parallel_index === index,
                );
                return {
                  title: part.title,
                  ...(row ? { session_id: row.id, status: row.status } : {}),
                };
              }),
            }
          : {}),
        ...(estimates.has(boardTaskId(plan.id, task.id))
          ? { estimate_ms: estimates.get(boardTaskId(plan.id, task.id))! }
          : {}),
        ...(task.priority ? { priority: task.priority } : {}),
        ...(task.kind ? { kind: task.kind } : {}),
        ...(task.task_type ? { task_type: task.task_type } : {}),
        ...(task.token_budget !== undefined ? { token_budget: task.token_budget } : {}),
        ...(budget
          ? {
              budget: {
                ratio: budget.ratio,
                input_tokens: budget.input_tokens,
                wall_ms: budget.wall_ms,
                limit: budget.limit,
              },
            }
          : {}),
        ...(rung ? { rung } : {}),
        scope: task.scope,
        ...(task.route_reason ? { route_reason: task.route_reason } : {}),
        ...(task.device ? { device: task.device } : {}),
        ...(task.device_reason ? { device_reason: task.device_reason } : {}),
        ...(task.needs ? { needs: task.needs } : {}),
        ...(task.uses ? { uses: task.uses } : {}),
        path: taskPath(ctx, projectId, task),
        title: task.title,
        goal: task.goal,
        lane_id: `${plan.id}:${task.lane}`,
        iteration_id: task.iteration !== undefined ? boardTaskId(plan.id, task.iteration) : null,
        estimate: task.estimate ?? 1,
        milestone_id: task.milestone
          ? (leadMilestones.get(`${plan.id}:${task.milestone}`) ?? null)
          : null,
        status,
        acceptance_checks: task.acceptance.map((text) => ({
          text,
          state: state === 'merged' ? 'passed' : 'pending',
        })),
        successors: plan.tasks.filter((candidate) => candidate.depends_on.includes(task.id)).length,
        blockers,
        blocker_codes: blockerCodes,
        segments: bound.flatMap((row) => row.segments),
        additions: total(bound.map((row) => row.additions)),
        deletions: total(bound.map((row) => row.deletions)),
        // A failing or running part outweighs a passed one.
        checks: partRows.length
          ? ((['fail', 'running', 'pass'] as const).find((check) =>
              partRows.some((row) => row.checks === check),
            ) ?? 'none')
          : (bound.at(-1)?.checks ?? 'none'),
        started_at: starts.length ? Math.min(...starts) : null,
        ended_at: ended,
        last_progress_at: progress.length ? Math.max(...progress) : null,
        blocked_since: blockedSince(plan, task),
        turn_running: bound.some((row) => row.turn_running),
        state,
        ...(state === 'merged'
          ? {
              done_by: currentAcceptance(plan, task.id)
                ? ('accepted' as const)
                : ('merged' as const),
            }
          : {}),
        ...(waiting?.wait ? { dispatch_wait: waiting.wait } : {}),
        ...(step ? { waiting_step: step } : {}),
        ...(runs.length
          ? {
              step_runs: runs.map((run) => ({
                id: run.id,
                slot: run.slot,
                step_id: run.step.id,
                title: run.step.title,
                kind: run.step.kind.type,
                state: run.state as Exclude<StepRun['state'], 'retired'>,
                ...(run.reason === undefined ? {} : { reason: run.reason }),
                ...(run.session_id === undefined ? {} : { session_id: run.session_id }),
                created_at: run.created_at,
                ...(run.finished_at === undefined ? {} : { finished_at: run.finished_at }),
                ...(run.review_id ? { reviewers: reviewersOf(run.review_id) } : {}),
              })),
            }
          : {}),
        depends_on: task.depends_on,
        planned: Object.fromEntries(
          PLANNED_FIELDS.flatMap((field) =>
            task[field] === undefined ? [] : [[field, task[field]]],
          ),
        ) as NonNullable<Task['planned']>,
        ...(claim
          ? {
              claim: {
                session_id: claim.id,
                runtime: claim.runtime,
                model: claim.reported_model ?? claim.requested_model ?? null,
                ...(claim.requested_effort ? { effort: claim.requested_effort } : {}),
              },
            }
          : {}),
        pending_edit: plan.pending_edits.some(
          (edit) => edit.status === 'pending' && edit.task_ids.includes(task.id),
        ),
        ...(retrospective
          ? {
              retrospective: {
                id: retrospective.id,
                outcome: retrospective.outcome,
                recorded_at: retrospective.recorded_at,
                ...(retrospective.runtime_findings?.length
                  ? { runtime_findings: retrospective.runtime_findings.length }
                  : {}),
                ...(retrospective.gate_passed_on_attempt === undefined
                  ? {}
                  : { gate_passed_on_attempt: retrospective.gate_passed_on_attempt }),
                handbacks: retrospective.handbacks?.length ?? 0,
                ...(retrospective.lead_wakes === undefined
                  ? {}
                  : { lead_wakes: retrospective.lead_wakes }),
                ...(retrospective.task_usage
                  ? {
                      tokens:
                        retrospective.task_usage.input_tokens +
                        retrospective.task_usage.output_tokens,
                    }
                  : {}),
                ...(retrospective.budget_ratio === undefined
                  ? {}
                  : { budget_ratio: retrospective.budget_ratio }),
              },
            }
          : {}),
        ...(waiting
          ? {
              activity: {
                phase: 'queued' as const,
                since: waiting.at,
                health: 'fresh' as const,
                attempt: Math.max(1, bound.length),
              },
            }
          : newestLive
            ? { activity: { ...activityOf(newestLive.id), attempt: bound.length } }
            : {}),
        ...(recap ? { recap } : {}),
        ...taskExtras(ctx, plan, task, newestLive && stored.get(newestLive.id)!),
      });
    }
  }
  const daily: BoardModel['task_progress']['daily'] = [];
  let before = plannedBefore(since);
  for (let day = since; day <= rangeEnd; day = midnight(day, 1)) {
    const end = midnight(day, 1),
      after = plannedBefore(end);
    daily.push({
      day: dayKey(day),
      scope: after ? after.size : null,
      // A day counts only the generation its plan version held.
      done: after
        ? [...after].filter(
            ([key, generation]) => (doneByGeneration.get(key)?.get(generation) ?? end) < end,
          ).length
        : [...firstDone.values()].filter((at) => at < end).length,
      added: after && before ? [...after.keys()].filter((key) => !before!.has(key)).length : null,
      removed: after && before ? [...before.keys()].filter((key) => !after.has(key)).length : null,
    });
    before = after;
  }
  const samples = plans
    .flatMap((plan) =>
      plan.tasks.flatMap((task) => {
        const key = boardTaskId(plan.id, task.id),
          done = firstDone.get(key),
          opened = firstOpened.get(key);
        return done !== undefined && opened !== undefined && inRange(done) ? [done - opened] : [];
      }),
    )
    .sort((a, b) => a - b);
  const nearestRank = (percent: number) =>
    samples.length ? samples[Math.ceil((percent * samples.length) / 100) - 1]! : null;
  for (const row of rows.values()) {
    if (!shown.has(row.id) || planned.has(row.id)) continue;
    row.milestone_id =
      facts.milestones.find((view) => view.milestone.required_sessions.includes(row.id))?.milestone
        .id ?? null;
    const recap = stored.get(row.id)!.recap;
    tasks.push({ ...row, activity: activityOf(row.id), ...(recap ? { recap } : {}) });
  }
  const listedById = new Map(listed.map((session) => [session.id, session]));
  const executions = reviewExecutionReader(ctx, projectId),
    reviewTimes = reviewTimeReader(ctx, projectId);
  const pullRequests = new Map<string, { number: number; url: string }>();
  for (const event of events)
    if (event.kind === 'session.pr_created') {
      const { number, url } = event.payload as { number: number; url: string };
      pullRequests.set(event.aggregate_id, { number, url });
    }
  const latestReviews = new Map<string, Review>();
  const reviews = ctx.store
    .list<Review>('reviews')
    .filter((review) => review.project_id === projectId);
  for (const review of reviews)
    if (review.session_id && review.round > (latestReviews.get(review.session_id)?.round ?? 0))
      latestReviews.set(review.session_id, review);
  const gateEvents = ctx.store.kindEvents(projectId, [
    'session.gate_started',
    'session.gate_checked',
    'session.gate_step_checked',
    'session.gate_run_cancelled',
    'session.gate_run_failed',
  ]);
  const subagents = ctx.trace?.subagentCounts(projectId);
  const failures = new Map<string, string>(),
    latestGate = new Map<string, Event>();
  for (const event of gateEvents)
    if (event.kind === 'session.gate_started' || event.kind === 'session.gate_checked')
      latestGate.set(event.aggregate_id, event);
  for (const session of listed) {
    const gate = latestGate.get(session.id);
    if (
      gate?.kind === 'session.gate_checked' &&
      (session.gate?.state === 'failed' || session.merge?.reason === 'gate_failed')
    ) {
      const { results } = gate.payload as { results: NonNullable<LandingItem['gate_results']> };
      const names = new Set(results.filter(gateFailed).map((result) => result.name));
      if (names.size) failures.set(session.id, `gate:${JSON.stringify([...names].sort())}`);
    } else if (session.last_turn?.state === 'failed' && session.last_turn.error_code) {
      failures.set(session.id, `turn:${session.last_turn.error_code}`);
    }
  }
  const reviewFailed = (review: Review) =>
    review.state === 'failed' ||
    executions(review).some((execution) => ['failed', 'cancelled'].includes(execution.state)) ||
    review.findings.some(
      (finding) => finding.status === 'open' && finding.blocking && !finding.resolution,
    );
  for (const task of tasks) {
    const sessionId = task.owner_session_id
      ? currentSessions.get(task.id)
      : task.segments.at(-1)?.session_id;
    if (!sessionId) continue;
    const pr = pullRequests.get(sessionId);
    if (pr) task.pr = pr;
    const count = subagents?.get(sessionId);
    if (count !== undefined) task.subagents = count;
    const review = latestReviews.get(sessionId);
    if (task.owner_session_id) {
      const failure = failures.get(sessionId);
      if (failure && task.activity && task.activity.phase !== 'queued') {
        const attempts = [...task.segments].sort(
          (a, b) => (a.started_at ?? 0) - (b.started_at ?? 0),
        );
        const previous =
          attempts[attempts.findIndex((segment) => segment.session_id === sessionId) - 1];
        if (previous?.session_id)
          task.activity.repeated_failure = failure === failures.get(previous.session_id);
      }
      const usage = turnsOf
        .get(sessionId)!
        .findLast((turn) => turn.usage?.context_tokens !== undefined)?.usage;
      if (usage?.context_window !== undefined)
        task.context = {
          used_tokens: usage.context_tokens!,
          window_tokens: usage.context_window,
        };
      const gates = gateEvents.filter((event) => event.aggregate_id === sessionId);
      if (gates.length) {
        // The newest run's commands and the results its steps checked so far.
        let commands: { name: string }[] | undefined,
          results: NonNullable<LandingItem['gate_results']> | undefined,
          ended = false;
        for (const event of gates)
          if (event.kind === 'session.gate_started') {
            commands = (event.payload as { commands: { name: string }[] }).commands;
            results = undefined;
            ended = false;
          } else if (
            event.kind === 'session.gate_step_checked' ||
            event.kind === 'session.gate_checked'
          ) {
            // A check with no start of its own names its steps by its results.
            if (ended) commands = undefined;
            results = (event.payload as { results: NonNullable<LandingItem['gate_results']> })
              .results;
            ended = event.kind === 'session.gate_checked';
          } else ended = true;
        task.gate_steps = (commands ?? results ?? []).map(({ name }, index) => {
          const result = results?.[index];
          return {
            name,
            ...(result?.tests ? { tests: result.tests } : {}),
            ...(result?.carried ? { carried: true } : {}),
            state: !result
              ? 'pending'
              : result.state === 'skipped'
                ? 'skipped'
                : result.exit_code === 0 && !result.timed_out
                  ? 'passed'
                  : 'failed',
          };
        });
      }
      if (review) {
        const failed = reviewFailed(review);
        const open = review.findings.filter(
          (finding) =>
            finding.round === review.round && finding.status === 'open' && !finding.resolution,
        );
        const blocking = open.filter((finding) => finding.blocking).length;
        task.external_review = {
          rounds: review.round,
          ...reviewTimes(review),
          verdict: review.state === 'running' ? 'pending' : failed ? 'failed' : 'passed',
          ...(review.state === 'running'
            ? {}
            : { findings: { blocking, other: open.length - blocking } }),
        };
      }
    }
    task.evidence = {
      session_id: sessionId,
      ...(listedById.get(sessionId)?.gate ? { gate: listedById.get(sessionId)!.gate } : {}),
      ...(review
        ? {
            review: {
              id: review.id,
              state: review.state,
              range: review.range,
              executions: executions(review),
            },
          }
        : {}),
    };
  }
  // Read after the pass above, which sets the gate steps a level stands on.
  const milestoneLevels = new Map<string, NonNullable<Task['evidence_level']>[]>();
  for (const task of tasks) {
    if (!task.owner_session_id) continue;
    const sessionId = currentSessions.get(task.id),
      review = sessionId === undefined ? undefined : latestReviews.get(sessionId);
    Object.assign(
      task,
      taskEvidenceLevel({
        merged: task.state === 'merged',
        gate_steps: task.gate_steps,
        ...(review
          ? { review: { failed: reviewFailed(review), verdicts: review.verdicts ?? [] } }
          : {}),
        writers: task.segments.flatMap((segment) =>
          segment.status !== 'discarded' && segment.runtime ? [segment.runtime] : [],
        ),
      }),
    );
    if (task.evidence_level && task.milestone_id)
      milestoneLevels.set(task.milestone_id, [
        ...(milestoneLevels.get(task.milestone_id) ?? []),
        task.evidence_level,
      ]);
  }
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const edgeBetween = (
    plan: BoardPlan,
    dependency: string,
    taskId: string,
  ): BoardModel['edges'] => {
    const from = byId.get(boardTaskId(plan.id, dependency)),
      to = byId.get(boardTaskId(plan.id, taskId));
    if (!from || !to) return [];
    const state =
      from.status === 'done'
        ? ('met' as const)
        : ['running', 'waiting', 'idle', 'ready'].includes(from.status) && to.status === 'todo'
          ? ('active' as const)
          : ('pending' as const);
    return [{ from: from.id, to: to.id, state }];
  };
  const edges: BoardModel['edges'] = plans.flatMap((plan) =>
    plan.tasks.flatMap((task) =>
      task.depends_on.flatMap((dependency) => edgeBetween(plan, dependency, task.id)),
    ),
  );
  const proposedEdges: BoardModel['edges'] = [];
  for (const plan of plans)
    for (const proposal of plan.pending_proposals ?? []) {
      if (proposal.status !== 'pending') continue;
      for (const op of proposal.ops) {
        if (op.type !== 'set_dependencies') continue;
        for (const dependency of op.depends_on)
          for (const edge of edgeBetween(plan, dependency, op.task_id))
            if (
              ![...edges, ...proposedEdges].some(
                (existing) => existing.from === edge.from && existing.to === edge.to,
              )
            )
              proposedEdges.push(edge);
      }
    }
  const newest = plans.reduce<BoardPlan | undefined>(
    (latest, plan) => (!latest || plan.updated_at > latest.updated_at ? plan : latest),
    undefined,
  );
  // The task ids of each user edit the lead was told of, by plan.
  const userEdits = new Map<
    string,
    { edit_id: string; at: number; task_ids: string[]; note: LeadNote; cause: string }[]
  >();
  for (const event of ctx.store.kindEvents(projectId, ['lead.note_added'])) {
    const edit = (event.payload as LeadNote).edit;
    if (!edit) continue;
    let leadId = event.aggregate_id;
    while (transfers.has(leadId)) leadId = transfers.get(leadId)!;
    userEdits.set(leadId, [
      ...(userEdits.get(leadId) ?? []),
      {
        edit_id: edit.edit_id,
        note: event.payload as LeadNote,
        cause: event.causation_id,
        at: (event.payload as LeadNote).at,
        task_ids: edit.ops.flatMap((op) =>
          op.type === 'add_task'
            ? [op.task.id]
            : op.type === 'resolve_edit' ||
                op.type === 'set_iterations' ||
                op.type === 'set_milestone' ||
                op.type === 'unlock_order'
              ? []
              : op.type === 'lock_order'
                ? op.task_ids
                : [op.task_id],
        ),
      },
    ]);
  }
  const editApplications = ctx.store.kindEvents(projectId, ['board.user_edit_applied']),
    contractReceipts = ctx.store.kindEvents(projectId, ['session.contract_notified']),
    turnStarts = new Map<string, Event>();
  for (const event of ctx.store.kindEvents(projectId, ['turn.running']))
    if (!turnStarts.has(event.aggregate_id)) turnStarts.set(event.aggregate_id, event);
  // Only today's hand-backs and sends are read.
  const handbackEvents = ctx.store.kindEventsSince(projectId, ['task.handed_back'], midnight(now)),
    queuedToday = ctx.store
      .kindEventsSince(projectId, ['turn.queued'], midnight(now))
      .filter((event) => event.created_at <= now);
  const completions = new Map<string, number>();
  for (const event of ctx.store.kindEvents(projectId, ['task.accepted', 'session.merged'])) {
    const payload = event.payload as { task_id?: string; generation?: number; direct?: boolean };
    if (event.kind !== 'task.accepted' && !payload.direct) continue;
    let owner = event.aggregate_id;
    while (transfers.has(owner)) owner = transfers.get(owner)!;
    completions.set(
      `${boardTaskId(owner, payload.task_id!)}:${payload.generation ?? 1}`,
      event.created_at,
    );
  }
  for (const plan of plans) {
    for (const [taskId, accepted] of Object.entries(plan.accepted ?? {}))
      completions.set(`${boardTaskId(plan.id, taskId)}:${accepted.generation ?? 1}`, accepted.at);
    for (const [taskId, direct] of Object.entries(plan.direct_merged ?? {}))
      completions.set(`${boardTaskId(plan.id, taskId)}:${direct.generation}`, direct.at);
  }
  const completedBy = (
    leadId: string,
    task: BoardPlan['tasks'][number],
    generation: number,
    end: number,
  ) => {
    const at = completions.get(`${boardTaskId(leadId, task.id)}:${generation}`);
    if (at !== undefined && at < end) return true;
    if (task.done_when === 'report') return false;
    const bound = [...stored.values()].filter(
      (session) =>
        session.task?.lead_session_id === leadId &&
        session.task.id === task.id &&
        (session.task.generation ?? 1) === generation &&
        (started.get(session.id) ?? end) < end &&
        !((discarded.get(session.id) ?? end) < end),
    );
    return bound.length > 0 && bound.every((session) => (merged.get(session.id)?.at ?? end) < end);
  };
  const slotLimit = taskPlaces(ctx, projectId),
    placedCount = placedTaskSessions(ctx, projectId).length;
  const iterations: NonNullable<BoardModel['iterations']> = plans.flatMap((plan) =>
    (plan.iterations ?? []).map((iteration) => {
      const tasks = plan.tasks.filter((task) => task.iteration === iteration.id),
        days: NonNullable<BoardModel['iterations']>[number]['days'] = [],
        last = iteration.ends_on < dayKey(now) ? iteration.ends_on : dayKey(now);
      // A stored iteration longer than a plan may now hold shows only its last days.
      for (
        let day = Math.max(
          new Date(`${iteration.starts_on}T00:00:00`).getTime(),
          midnight(new Date(`${last}T00:00:00`).getTime(), 1 - ITERATION_DAYS),
        );
        dayKey(day) <= last;
        day = midnight(day, 1)
      ) {
        const end = Math.min(midnight(day, 1), now + 1),
          history = versions.get(plan.id) ?? [],
          snapshot = history.findLast((version) => version.at < end),
          scoped = (snapshot?.tasks ?? (history.length ? [] : plan.tasks)).filter(
            (task) => task.iteration === iteration.id,
          );
        days.push({
          date: dayKey(day),
          scope: scoped.reduce((sum, task) => sum + (task.estimate ?? 1), 0),
          done: scoped.reduce(
            (sum, task) =>
              sum +
              (completedBy(
                plan.id,
                task,
                ownEntry(snapshot?.generations ?? plan.generations, task.id)?.generation ?? 1,
                end,
              )
                ? (task.estimate ?? 1)
                : 0),
            0,
          ),
        });
      }
      const open = tasks.filter((task) => !taskDone(boardTaskId(plan.id, task.id))),
        times = open.flatMap((task) => {
          const ms = estimates.get(boardTaskId(plan.id, task.id));
          return ms === undefined ? [] : [ms];
        });
      let forecast: { forecast_done_at?: number; capacity?: number } = {};
      if (open.length && times.length === open.length) {
        const work = times.reduce((sum, ms) => sum + ms, 0),
          end = midnight(new Date(`${iteration.ends_on}T00:00:00`).getTime(), 1);
        // forecast = now + open time / slots; capacity = floor(((end - now) * slots - open time) / median task time), clamped at 0.
        forecast = {
          forecast_done_at: now + work / slotLimit,
          capacity: Math.max(0, Math.floor(((end - now) * slotLimit - work) / median(times)!)),
        };
      }
      return {
        ...iteration,
        ...forecast,
        id: boardTaskId(plan.id, iteration.id),
        planned: tasks.reduce((sum, task) => sum + (task.estimate ?? 1), 0),
        done: tasks.reduce(
          (sum, task) =>
            sum +
            (completedBy(plan.id, task, taskGeneration(plan, task.id), now + 1)
              ? (task.estimate ?? 1)
              : 0),
          0,
        ),
        days,
      };
    }),
  );
  type Lead = NonNullable<BoardModel['leads']>[number];
  type LeadEvent = NonNullable<Lead['events_today']>[number];
  const todayStart = midnight(now),
    today = (at: number) => at >= todayStart && at <= now;
  const subagentCalls = new Map<
    string,
    Map<string, { at: number; turn_id?: string; completed: boolean }>
  >();
  const collaborationCounts = new Map<
    string,
    { subagents: number; reviews: number; gates: number }
  >();
  const runningGates = new Set<string>();
  const modelSelectors = new Map<string, string | null>();
  const dailyEvents: LeadEvent[] = handbackEvents
    .filter((event) => today(event.created_at))
    .map((event) => ({
      at: event.created_at,
      kind: 'handback',
      session_id: (event.payload as { session_id: string }).session_id,
    }));
  for (const event of queuedToday) {
    const turn = event.payload as SessionTurn;
    if (turn.origin === 'tracker')
      dailyEvents.push({ at: event.created_at, kind: 'handback', session_id: turn.session_id });
  }
  for (const event of events) {
    if (event.kind === 'session.opened') {
      const session = event.payload as Session;
      if (session.runtime !== undefined)
        modelSelectors.set(session.id, session.requested_model ?? null);
    } else if (event.kind === 'session.runtime_changed') modelSelectors.delete(event.aggregate_id);
    else if (event.kind === 'session.model_changed') {
      const { model } = event.payload as { model: string | null };
      if (today(event.created_at) && modelSelectors.get(event.aggregate_id) !== model)
        dailyEvents.push({
          at: event.created_at,
          kind: 'model_change',
          session_id: event.aggregate_id,
        });
      modelSelectors.set(event.aggregate_id, model);
    } else if (event.kind === 'agent.tool.started') {
      const call = event.payload as Extract<AgentEvent, { kind: 'tool.started' }>;
      if (
        call.name !== 'Agent' &&
        call.name !== 'Task' &&
        !(
          call.name === 'collabAgentToolCall' &&
          (call.input as { tool: string }).tool === 'spawnAgent'
        )
      )
        continue;
      const calls = subagentCalls.get(event.aggregate_id) ?? new Map();
      if (!calls.has(call.tool_call_id))
        calls.set(call.tool_call_id, {
          at: event.created_at,
          turn_id: call.turn_id,
          completed: false,
        });
      subagentCalls.set(event.aggregate_id, calls);
    } else if (event.kind === 'agent.tool.completed') {
      const call = event.payload as Extract<AgentEvent, { kind: 'tool.completed' }>;
      const started = subagentCalls.get(event.aggregate_id)?.get(call.tool_call_id);
      if (started) started.completed = true;
    } else if (event.kind === 'session.gate_started' || event.kind === 'review.requested') {
      const sessionId =
        event.kind === 'review.requested'
          ? (event.payload as Review).session_id
          : event.aggregate_id;
      if (!sessionId) continue;
      if (event.kind === 'session.gate_started') runningGates.add(sessionId);
      if (!today(event.created_at)) continue;
      const counts = collaborationCounts.get(sessionId) ?? { subagents: 0, reviews: 0, gates: 0 };
      counts[event.kind === 'review.requested' ? 'reviews' : 'gates']++;
      collaborationCounts.set(sessionId, counts);
    } else if (
      ['session.gate_checked', 'session.gate_run_cancelled', 'session.gate_run_failed'].includes(
        event.kind,
      )
    )
      runningGates.delete(event.aggregate_id);
  }
  for (const [sessionId, calls] of subagentCalls) {
    const counts = collaborationCounts.get(sessionId) ?? { subagents: 0, reviews: 0, gates: 0 };
    counts.subagents = [...calls.values()].filter((call) => today(call.at)).length;
    collaborationCounts.set(sessionId, counts);
  }
  const runningReviews = new Set(
    reviews.filter((review) => review.state === 'running').map((review) => review.session_id),
  );
  const milestoneIdOf = new Map(
    facts.milestones.flatMap((view) =>
      view.milestone.owner_session_id && view.milestone.key
        ? [[`${view.milestone.owner_session_id}:${view.milestone.key}`, view.milestone.id]]
        : [],
    ),
  );
  // Edits are kept oldest first, so the newest refute of an assumption wins.
  const refutedBy = new Map(
    plans.map((plan) => [
      plan.id,
      new Map(
        plan.pending_edits.flatMap((edit) =>
          (edit.refutes ?? []).map(
            (refute) =>
              [
                refute.assumption_id,
                {
                  edit_id: edit.edit_id,
                  instead: refute.instead,
                  state: edit.status,
                  ...(edit.reason ? { reason: edit.reason } : {}),
                },
              ] as const,
          ),
        ),
      ),
    ]),
  );
  const leads: NonNullable<BoardModel['leads']> = plans.map((plan) => {
    const lead = ctx.store.get<Session>('sessions', plan.id),
      request = requests.get(plan.id),
      latest = latestExecuted(
        ctx,
        allTurns.filter((turn) => turn.session_id === plan.id),
      );
    const usage = allTurns
      .filter((turn) => turn.session_id === plan.id)
      .findLast((turn) => turn.usage?.context_tokens !== undefined)?.usage;
    const taskSessionIds = new Set(
      [...stored.values()]
        .filter((session) => session.task?.lead_session_id === plan.id)
        .map((session) => session.id),
    );
    const eventsToday = dailyEvents
      .filter((event) => taskSessionIds.has(event.session_id))
      .sort((a, b) => a.at - b.at)
      .slice(-200);
    return {
      session_id: plan.id,
      ...(eventsToday.length ? { events_today: eventsToday } : {}),
      ...(usage?.context_window !== undefined
        ? { context: { used_tokens: usage.context_tokens!, window_tokens: usage.context_window } }
        : {}),
      title: lead?.title ?? '',
      state: leadState(listedOf.get(plan.id)?.state, () => leadTurnFailed(ctx, lead!, latest)),
      inbox: plan.inbox.length,
      ...statusLineOf(ctx, lead),
      messages_today: [...stored.values()]
        .filter((session) => session.task?.lead_session_id === plan.id)
        .map((session) => {
          const sent = queuedToday
              .map((event) => event.payload as SessionTurn)
              .filter((turn) => turn.session_id === session.id),
            userHandbacks = handbackEvents.filter(
              (event) =>
                event.created_at >= midnight(now) &&
                event.created_at <= now &&
                (event.payload as { session_id: string }).session_id === session.id,
            ).length;
          const counts = collaborationCounts.get(session.id);
          const inFlight: NonNullable<NonNullable<Lead['messages_today']>[number]['in_flight']> =
            [];
          if (
            turnsOf
              .get(session.id)
              ?.some(
                (turn) =>
                  (turn.origin === 'lead' ||
                    (dispatched.has(session.id) && turn.id === turnsOf.get(session.id)?.[0]?.id)) &&
                  ['pending', 'queued'].includes(turn.delivery),
              )
          )
            inFlight.push('lead');
          if (
            [...(subagentCalls.get(session.id)?.values() ?? [])].some(
              (call) =>
                !call.completed &&
                (call.turn_id
                  ? runningTurns.get(session.id)?.id === call.turn_id
                  : runningTurns.has(session.id)),
            )
          )
            inFlight.push('subagent');
          if (runningReviews.has(session.id)) inFlight.push('review');
          if (runningGates.has(session.id)) inFlight.push('gate');
          return {
            session_id: session.id,
            ...(counts?.subagents ? { subagents: counts.subagents } : {}),
            ...(counts?.reviews ? { reviews: counts.reviews } : {}),
            ...(counts?.gates ? { gates: counts.gates } : {}),
            ...(inFlight.length ? { in_flight: inFlight } : {}),
            lead: sent.filter((turn) => turn.origin === 'lead').length,
            tracker: sent.filter((turn) => turn.origin === 'tracker').length,
            handbacks: userHandbacks + sent.filter((turn) => turn.origin === 'tracker').length,
          };
        }),
      ...(request ? { waiting: waitingOf(request) } : {}),
      updated_at: plan.updated_at,
      plan_version: plan.plan_version,
      assumptions: plan.assumptions.map((assumption) => {
        const milestoneId = milestoneIdOf.get(`${plan.id}:${assumption.milestone}`);
        return {
          ...(assumption.id ? { id: assumption.id } : {}),
          text: assumption.text,
          affects: (assumption.affects ?? []).map((taskId) => boardTaskId(plan.id, taskId)),
          ...(milestoneId ? { milestone: milestoneId } : {}),
        };
      }),
      recent_edits: (userEdits.get(plan.id) ?? [])
        .filter(
          (edit) =>
            edit.at >= now - 24 * 60 * 60 * 1000 &&
            !plan.pending_edits.some(
              (pending) =>
                pending.edit_id === edit.edit_id &&
                ['rejected', 'withdrawn'].includes(pending.status),
            ),
        )
        .map((edit) => {
          const application = editApplications.find(
            (event) => (event.payload as { edit_id: string }).edit_id === edit.edit_id,
          );
          const written =
            application ??
            planEvents.find((event) => {
              if (event.kind !== 'board.plan_updated') return false;
              const snapshot = event.payload as Partial<BoardPlan>;
              return edit.note.edit!.applied
                ? event.causation_id === edit.cause
                : snapshot.pending_edits?.some(
                    (pending) => pending.edit_id === edit.edit_id && pending.status === 'applied',
                  );
            });
          const affected = (application?.payload as { session_ids: string[] } | undefined)
            ?.session_ids;
          const receipts = affected?.map((sessionId) =>
            contractReceipts.find((event) => {
              const receipt = event.payload as { plan_sequence: number };
              return (
                event.aggregate_id === sessionId && receipt.plan_sequence >= application!.sequence
              );
            }),
          );
          const read = allTurns.flatMap((turn) => {
            const started = turnStarts.get(turn.id);
            return edit.note.id && turn.lead_note_ids?.includes(edit.note.id) && started
              ? [started.created_at]
              : [];
          });
          return {
            id: edit.edit_id,
            created_at: edit.at,
            plan_written_at: written?.created_at ?? null,
            lead_read_at: read.length ? Math.min(...read) : null,
            sessions_notified_at:
              !application || receipts?.some((receipt) => !receipt)
                ? null
                : Math.max(
                    application.created_at,
                    ...receipts!.map((receipt) => receipt!.created_at),
                  ),
          };
        }),
      pending_proposals: pendingProposals(plan),
      pending_edits: plan.pending_edits
        .filter((edit) => edit.status === 'pending')
        .map((edit) => ({
          id: edit.edit_id,
          task_ids: edit.task_ids,
          summary: edit.ops
            .map((op) =>
              op.type === 'set_iterations'
                ? op.type
                : op.type === 'set_milestone'
                  ? `${op.type} ${op.milestone_id}`
                  : `${op.type} ${op.type === 'add_task' ? op.task.id : op.task_id}`,
            )
            .join(', '),
          state: 'pending' as const,
          ops: edit.ops,
          base_version: edit.base_version,
          created_at: edit.created_at,
          ...(edit.refutes ? { refutes: edit.refutes } : {}),
        })),
      // A user edit at or after the rejection that names one of its tasks supersedes it.
      rejected_edits: plan.pending_edits
        .filter(
          (edit) =>
            edit.status === 'rejected' &&
            !(userEdits.get(plan.id) ?? []).some(
              (later) =>
                later.edit_id !== edit.edit_id &&
                later.at >= edit.resolved_at! &&
                later.task_ids.some((taskId) => edit.task_ids.includes(taskId)),
            ),
        )
        .reverse()
        .sort((a, b) => b.resolved_at! - a.resolved_at!)
        .slice(0, 20)
        .map((edit) => ({
          id: edit.edit_id,
          task_ids: edit.task_ids,
          ops: edit.ops,
          ...(edit.reason ? { reason: edit.reason } : {}),
          resolved_at: edit.resolved_at!,
        })),
      ...(listedOf.has(plan.id) ? { activity: activityOf(plan.id) } : {}),
    };
  });
  // needsYou serves only user and planner principals.
  const needs: NonNullable<BoardModel['needs']> = (
    principal.role === 'user' || principal.role === 'planner'
      ? (needItems ?? needsYou(ctx, principal, projectId).items)
      : []
  ).map((item) => {
    const bound = itemTask(ctx, item, planOf);
    return {
      ...item,
      ...(bound ? { task_id: boardTaskId(bound.plan.id, bound.taskId) } : {}),
      unblocks: item.blocks,
    };
  });
  const findings: BoardModel['findings'] = ctx.store
    .list<Review>('reviews')
    .filter((review) => review.project_id === projectId)
    .flatMap((review) => {
      // A plan review has no session of its own; its findings belong to the lead whose plan it is.
      const sessionId = review.session_id ?? review.requester?.lead_session_id;
      if (!sessionId) return [];
      return review.findings
        .filter((finding) => finding.status === 'open')
        .map((finding) => {
          const place = /^(.+?):(\d+)(?:-\d+)?$/.exec(finding.location);
          return {
            id: finding.id,
            review_id: finding.review_id,
            review_revision: review.revision,
            session_id: sessionId,
            reviewer: finding.runtime,
            text: finding.impact,
            severity: finding.blocking ? ('blocker' as const) : ('minor' as const),
            path: place ? place[1]! : finding.location,
            line: place ? Number(place[2]) : null,
            state: finding.resolution?.outcome ?? ('open' as const),
          };
        });
    });
  return {
    since,
    now,
    headline: newest
      ? {
          text: newest.headline,
          updated_at: newest.updated_at,
          by_session: newest.id,
        }
      : board?.headline
        ? {
            text: board.headline,
            updated_at: boardAt ?? board.updated_at,
            by_session: null,
          }
        : null,
    counts,
    ...(gateFailures.length ? { gate_failures: gateFailures } : {}),
    lanes: plans.flatMap((plan) =>
      plan.lanes.map((lane) => {
        const stop = ownEntry(plan.lane_stops, lane.id),
          depth = effectiveDepth(plan, lane),
          held = laneHeld(plan, lane.id);
        return {
          id: `${plan.id}:${lane.id}`,
          title: lane.title,
          ...(lane.fanout_reason ? { fanout_reason: lane.fanout_reason } : {}),
          ...(depth
            ? {
                depth,
                depth_by: stop?.user_depth
                  ? ('user' as const)
                  : lane.depth
                    ? ('lead' as const)
                    : ('pantheon' as const),
              }
            : {}),
          ...(lane.depth_reason ? { depth_reason: lane.depth_reason } : {}),
          ...(stop?.held_at === undefined
            ? {}
            : held
              ? { stop: { state: 'waiting' as const, at: stop.held_at } }
              : {
                  stop: {
                    state: 'approved' as const,
                    at: stop.approved_at!,
                    ...(stop.approved_by ? { by: stop.approved_by } : {}),
                  },
                }),
          ...(held ? { estimate: estimateLane(ctx, plan, lane.id) } : {}),
        };
      }),
    ),
    tasks,
    iterations,
    slots: {
      limit: slotLimit,
      used: placedCount,
      queued: queued.size,
    },
    leads,
    task_places: {
      used: placedCount,
      limit: taskPlaces(ctx, projectId),
    },
    needs,
    edges,
    proposed_edges: proposedEdges,
    milestones: facts.milestones.map((view) => {
      // The commitment hash covers the criteria, so completed means their text is the one checked.
      const criteria = view.milestone.criteria.map((text, index) => ({
        text,
        accepted:
          view.status === 'completed' &&
          (view.milestone.acceptance?.criteria_checked?.includes(index) ?? true),
      }));
      return view.milestone.owner_session_id
        ? {
            id: view.milestone.id,
            title: view.milestone.title,
            session_ids: view.required_sessions,
            merged: view.merged_total,
            status: view.status,
            criteria,
            owner_session_id: view.milestone.owner_session_id,
            tasks: view.tasks!,
            ...(view.milestone.due_on ? { due_on: view.milestone.due_on } : {}),
            ...milestoneExtras(
              ctx,
              view,
              milestoneLevels.get(view.milestone.id) ?? [],
              planOf.get(view.milestone.owner_session_id),
              refutedBy.get(view.milestone.owner_session_id),
            ),
          }
        : {
            id: view.milestone.id,
            title: view.milestone.title,
            session_ids: view.milestone.required_sessions,
            merged: view.merged_total,
            status: view.status,
            criteria,
            ...milestoneExtras(ctx, view, milestoneLevels.get(view.milestone.id) ?? []),
          };
    }),
    goals: facts.goals.map(({ goal, milestone_ids, milestones, tasks }) => ({
      id: goal.id,
      text: goal.text,
      order: goal.order,
      revision: goal.revision,
      milestone_ids,
      milestones,
      tasks,
      needs: needs.filter((item) =>
        milestone_ids.includes(
          item.source.table === 'milestones'
            ? item.source.id
            : (byId.get(item.task_id ?? '')?.milestone_id ?? ''),
        ),
      ).length,
    })),
    burnup,
    task_progress: {
      totals,
      daily,
      cycle: {
        median_ms: nearestRank(50),
        p90_ms: nearestRank(90),
        sample_count: samples.length,
        buckets: [...CYCLE_BOUNDS, null].map((upper, index) => ({
          upper_ms: upper,
          count: samples.filter(
            (cycle) =>
              (upper === null || cycle <= upper) &&
              (index === 0 || cycle > CYCLE_BOUNDS[index - 1]!),
          ).length,
        })),
      },
    },
    usage: [...usage.values()].sort((a, b) => a.day.localeCompare(b.day)),
    models: [...models.values()].sort((a, b) => a.first_seen - b.first_seen),
    merges,
    findings: findings
      .filter((f) => f.state === 'open')
      .concat(findings.filter((f) => f.state !== 'open')),
    risks: [
      ...plans.flatMap((plan) => [
        ...plan.risks.map((risk) => ({ text: risk.text, kind: 'risk' as const })),
        ...plan.assumptions.map((assumption) => ({
          text: assumption.text,
          kind: 'assumption' as const,
        })),
      ]),
      ...(board
        ? [
            ...board.findings
              .filter((finding) => finding.severity === 'risk')
              .map((finding) => ({ text: finding.text, kind: 'risk' as const })),
            ...board.assumptions.map((assumption) => ({
              text: assumption.text,
              kind: 'assumption' as const,
            })),
          ]
        : []),
    ],
  };
}
