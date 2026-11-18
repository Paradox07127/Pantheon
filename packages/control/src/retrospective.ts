import {
  TASK_TIERS,
  type Approval,
  type BoardPlan,
  type GateFailureClass,
  type Improvement,
  type LeadNote,
  type Principal,
  type Project,
  type Retrospective,
  type Session,
  type SessionTurn,
  type StepRun,
  type TaskBudget,
  type TaskKind,
} from '@pantheon/domain';
import type { GateFirstPass } from '@pantheon/protocol';
import { projectAccess, type ControlContext } from './context.js';
import {
  awaitingChange,
  boardTaskId,
  currentAcceptance,
  currentBinding,
  currentDirectMerge,
  ownEntry,
  taskGeneration,
  taskState,
} from './board-plan.js';
import { INBOX_HEADER } from './lead-inbox.js';
import { finishingMerge } from './project-facts.js';
import { taskPath } from './task-dispatch.js';
import { RUNTIME_LOOKBACK_MS, runtimeDiagnostics } from './runtime-findings.js';
import { TURN_ENDS } from './workbench-session.js';
import { workflowPolicy } from './workflow-policy.js';

type PlanTask = BoardPlan['tasks'][number];
type Tokens = NonNullable<Retrospective['task_usage']>;
const SLOT_STAGES = {
  before_dispatch: 'dispatch_wait',
  before_merge: 'gate_and_merge',
  after_merge: 'merge_to_acceptance',
} as const;
interface EventRow {
  sequence: number;
  kind: string;
  aggregate_id: string;
  created_at: number;
  payload: Record<string, unknown>;
}

const LIST_LIMIT = 200;

export function latestRetrospectives(rows: Retrospective[], projectId: string) {
  const latest = new Map<string, Retrospective>();
  for (const row of rows) {
    const key = boardTaskId(row.lead_session_id, row.task_id),
      newest = latest.get(key);
    if (row.project_id === projectId && (!newest || row.recorded_at > newest.recorded_at))
      latest.set(key, row);
  }
  return latest;
}

/** The newest record of each task decides, including tasks that never passed a gate. */
export function gateFirstPass(
  rows: Iterable<Retrospective>,
  since: number,
  until: number,
): GateFirstPass | undefined {
  let counts: GateFirstPass | undefined;
  for (const row of rows) {
    if (row.recorded_at < since || row.recorded_at > until) continue;
    counts ??= { tasks: 0, passed: 0 };
    counts.tasks++;
    if (row.gate_passed_on_attempt === 1) counts.passed++;
  }
  return counts;
}

/** One row per task generation, so a task is recorded once however often it is seen done. */
const retrospectiveId = (leadId: string, taskId: string, generation: number) =>
  `${leadId}:${taskId}:${generation}`;

/** The events of these kinds on these aggregates, in order. */
function eventsOf(ctx: ControlContext, aggregates: string[], kinds: string[]): EventRow[] {
  if (!aggregates.length) return [];
  const rows = ctx.store.db
    .prepare(
      `SELECT sequence, kind, aggregate_id, created_at, payload FROM events WHERE aggregate_id IN (${aggregates.map(() => '?').join(',')}) AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY sequence`,
    )
    .all(...aggregates, ...kinds) as unknown as (Omit<EventRow, 'payload'> & {
    payload: string;
  })[];
  return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
}

const generationIn = (plan: Partial<BoardPlan>, taskId: string) =>
  ownEntry(plan.generations, taskId)?.generation ?? 1;

/** The task as the plan write holds it in the generation; undefined when it holds another or none. */
function writtenTask(event: EventRow, taskId: string, generation: number): PlanTask | undefined {
  const written = (event.payload.tasks as PlanTask[]).find((task) => task.id === taskId);
  return written && generationIn(event.payload, taskId) === generation ? written : undefined;
}

/** When a plan write first held the generation of the task; undefined before one did. */
export function firstPlannedAt(
  ctx: ControlContext,
  plan: BoardPlan,
  taskId: string,
  generation: number,
): number | undefined {
  return eventsOf(ctx, [plan.id], ['board.plan_updated']).find((event) =>
    writtenTask(event, taskId, generation),
  )?.created_at;
}

function tokens(turns: SessionTurn[]): Tokens {
  const sum: Tokens = { input_tokens: 0, output_tokens: 0 };
  for (const { usage } of turns) {
    if (!usage) continue;
    sum.input_tokens += usage.input_tokens;
    sum.output_tokens += usage.output_tokens;
    if (usage.cached_input_tokens !== undefined)
      sum.cached_input_tokens = (sum.cached_input_tokens ?? 0) + usage.cached_input_tokens;
    if (usage.cache_write_input_tokens !== undefined)
      sum.cache_write_input_tokens =
        (sum.cache_write_input_tokens ?? 0) + usage.cache_write_input_tokens;
  }
  return sum;
}

type GateResult = {
  state?: string;
  name: string;
  exit_code?: number | null;
  timed_out?: boolean;
  failure_class?: GateFailureClass;
};
const gateFailure = (payload: Record<string, unknown>) =>
  (payload.results as GateResult[]).find(
    (result) => result.state !== 'skipped' && (result.exit_code !== 0 || result.timed_out),
  );

const HOUR_MS = 3_600_000;
/** The measured tier raised by how long execution took, as the routing design rates time. */
function tierAfter(kind: TaskKind, executionMs: number | undefined): TaskKind {
  const byTime =
    executionMs === undefined ? 0 : executionMs > HOUR_MS ? 2 : executionMs >= HOUR_MS / 4 ? 1 : 0;
  return { ...kind, tier: TASK_TIERS[Math.max(TASK_TIERS.indexOf(kind.tier), byTime)]! };
}

/**
 * The lead turns that woke it with notes, the first of them about the task: a wake that carried
 * notes about several tasks counts for one of them. Any lead turn takes the notes before it.
 */
export function leadWakes(
  ctx: ControlContext,
  plan: BoardPlan,
  taskId: string,
  since: number,
): string[] {
  let first: { task_id: string; at: number } | undefined;
  const wakes: string[] = [];
  for (const event of ctx.store.kindEvents(plan.project_id, ['lead.note_added', 'turn.queued'])) {
    if (event.kind === 'lead.note_added') {
      const note = event.payload as LeadNote;
      if (event.aggregate_id === plan.id && note.task_id)
        first ??= { task_id: note.task_id, at: event.created_at };
      continue;
    }
    const turn = event.payload as SessionTurn;
    if (turn.session_id !== plan.id) continue;
    if (first?.task_id === taskId && first.at >= since && turn.origin === 'tracker')
      wakes.push(turn.id);
    first = undefined;
  }
  return wakes;
}

/** Events of the lead's plan that are its decisions; its notes and refused wakes are not. */
export const DECISIONS = [
  'board.plan_updated',
  'task.start_requested',
  'task.stop_requested',
  'task.accepted',
];

/** How many of the lead turns ended with no decision and no message to a task of the lead. */
function wakesWithoutDecision(ctx: ControlContext, plan: BoardPlan, turnIds: string[]): number {
  if (!turnIds.length) return 0;
  const taskSessions = ctx.store
    .list<Session>('sessions')
    .filter((session) => session.task?.lead_session_id === plan.id)
    .map((session) => session.id);
  const decided = [
    ...eventsOf(ctx, [plan.id], DECISIONS),
    ...eventsOf(ctx, taskSessions, ['task.messaged']),
  ].map((event) => event.sequence);
  const spans = new Map<string, { queued?: number; running?: number; end?: number }>();
  for (const event of eventsOf(ctx, turnIds, ['turn.queued', 'turn.running', ...TURN_ENDS])) {
    const span = spans.get(event.aggregate_id) ?? {};
    spans.set(event.aggregate_id, span);
    if (event.kind === 'turn.queued') span.queued ??= event.sequence;
    else if (event.kind === 'turn.running') span.running ??= event.sequence;
    else span.end ??= event.sequence;
  }
  return turnIds.filter((id) => {
    const span = spans.get(id),
      start = span?.running ?? span?.queued ?? 0,
      end = span?.end ?? Infinity;
    return !decided.some((sequence) => sequence > start && sequence < end);
  }).length;
}

/** The stalled and looping notes about the sessions, once per turn: a later one of a turn is a reminder. */
function turnAlerts(
  ctx: ControlContext,
  plan: BoardPlan,
  ids: ReadonlySet<string>,
  turns: SessionTurn[],
): { stalls: number; loops: number } {
  const sessionOf = new Map(turns.map((turn) => [turn.id, turn.session_id])),
    runningTurn = new Map<string, string>(),
    told = new Set<string>();
  const counts = { stalls: 0, loops: 0 };
  for (const event of eventsOf(
    ctx,
    [plan.id, ...sessionOf.keys()],
    ['lead.note_added', 'turn.running'],
  )) {
    if (event.kind === 'turn.running') {
      runningTurn.set(sessionOf.get(event.aggregate_id)!, event.aggregate_id);
      continue;
    }
    const note = event.payload as unknown as LeadNote;
    if (!ids.has(note.session_id) || (note.kind !== 'stalled' && note.kind !== 'looping')) continue;
    const key = `${note.kind}:${note.session_id}:${runningTurn.get(note.session_id)}`;
    if (told.has(key)) continue;
    told.add(key);
    counts[note.kind === 'stalled' ? 'stalls' : 'loops']++;
  }
  return counts;
}

const APPROVAL_OUTCOMES = [
  'approval.approved',
  'approval.rejected',
  'approval.void',
  'approval.resolved',
];

/** Milliseconds the sessions' permission requests waited for their first outcome; undefined when none has one. */
function approvalWait(ctx: ControlContext, ids: ReadonlySet<string>): number | undefined {
  const approvals = ctx.store
    .list<Approval>('approvals')
    .filter((approval) => approval.session_id !== undefined && ids.has(approval.session_id));
  const answered = new Map<string, number>();
  for (const event of eventsOf(
    ctx,
    approvals.map((approval) => approval.id),
    APPROVAL_OUTCOMES,
  ))
    if (!answered.has(event.aggregate_id)) answered.set(event.aggregate_id, event.created_at);
  if (!answered.size) return;
  return approvals.reduce(
    (sum, approval) =>
      sum + (answered.has(approval.id) ? answered.get(approval.id)! - approval.created_at : 0),
    0,
  );
}

/** The policy version and experiences in force at the first event of the sessions; empty without sessions. */
function exposure(
  ctx: ControlContext,
  projectId: string,
  sessionIds: string[],
): Pick<Retrospective, 'policy_version' | 'experience_ids'> {
  if (!sessionIds.length) return {};
  const first = ctx.store.db
    .prepare(
      `SELECT sequence, created_at FROM events WHERE aggregate_id IN (${sessionIds.map(() => '?').join(',')}) ORDER BY sequence LIMIT 1`,
    )
    .get(...sessionIds) as { sequence: number; created_at: number } | undefined;
  if (!first) return {};
  const changed = ctx.store
    .kindEvents(projectId, ['workflow.policy_changed'])
    .filter((event) => event.sequence < first.sequence)
    .at(-1);
  const ended = (row: Improvement) =>
    (row.status === 'reverted' || row.status === 'rejected') &&
    row.decided_at !== undefined &&
    row.decided_at <= first.created_at;
  return {
    policy_version:
      (changed?.payload as { policy_version?: number } | undefined)?.policy_version ?? 0,
    experience_ids: ctx.store
      .list<Improvement>('improvements')
      .filter(
        (row) =>
          row.project_id === projectId &&
          row.change.type === 'experience' &&
          row.trial_started_at !== undefined &&
          row.trial_started_at <= first.created_at &&
          !ended(row),
      )
      .map((row) => row.id),
  };
}

const MERGE_EVENTS = [
  'session.merge_started',
  'session.merge_blocked',
  'session.gate_checked',
  'session.merged',
  'agent.turn.completed',
];

/** What the merge events tell of the work: its gate runs, scope refusals, merge and failed turns. */
function mergeFacts(events: EventRow[]) {
  let mergeStartedAt: number | undefined,
    mergedAt: number | undefined,
    gateRuns = 0,
    gatePassedOn: number | undefined,
    mergedKind: TaskKind | undefined,
    scopeViolations = 0,
    lastTurnEndedAt: number | undefined;
  const failureCodes = new Map<string, string>(),
    gateFailures: GateFailureClass[] = [],
    gateChecks: string[] = [];
  for (const event of events) {
    if (event.kind === 'session.merge_started') mergeStartedAt ??= event.created_at;
    else if (event.kind === 'session.merge_blocked') {
      if (event.payload.reason === 'out_of_scope') scopeViolations++;
    } else if (event.kind === 'session.merged') {
      mergedAt = event.created_at;
      mergedKind = event.payload.measured_kind as TaskKind | undefined;
    } else if (event.kind === 'session.gate_checked') {
      gateRuns++;
      const failure = gateFailure(event.payload);
      if (failure) {
        gateFailures.push(failure.failure_class ?? 'code');
        gateChecks.push(failure.name);
      } else gatePassedOn ??= gateRuns;
    } else {
      lastTurnEndedAt = event.created_at;
      if (typeof event.payload.error_code === 'string')
        failureCodes.set(event.payload.turn_id as string, event.payload.error_code);
    }
  }
  return {
    mergeStartedAt,
    mergedAt,
    gatePassedOn,
    mergedKind,
    scopeViolations,
    lastTurnEndedAt,
    failureCodes,
    gateFailures,
    gateChecks,
  };
}

/** The lead's events from its last claim of the direct task's generation to its merge of it; undefined without both. */
function directEvents(
  ctx: ControlContext,
  leadId: string,
  taskId: string,
  generation: number,
): EventRow[] | undefined {
  const events = eventsOf(ctx, [leadId], ['task.claimed', 'task.reported', ...MERGE_EVENTS]);
  const of = (event: EventRow) =>
    event.payload.task_id === taskId && event.payload.generation === generation;
  const merged = events.findLastIndex(
    (event) => event.kind === 'session.merged' && event.payload.direct === true && of(event),
  );
  const claimed = events
    .slice(0, Math.max(merged, 0))
    .findLastIndex((event) => event.kind === 'task.claimed' && of(event));
  return merged < 0 || claimed < 0 ? undefined : events.slice(claimed, merged + 1);
}

/** The lead's turns that ended within the events, and how many turns queued within them were hand-backs. */
export function leadTurnsWithin(
  ctx: ControlContext,
  leadId: string,
  allTurns: SessionTurn[],
  events: EventRow[],
): { ended: SessionTurn[]; handedBack: number } {
  const from = events[0]!.sequence,
    to = events.at(-1)!.sequence,
    turns = allTurns.filter((turn) => turn.session_id === leadId);
  const within = (kinds: string[]) =>
    new Set(
      eventsOf(
        ctx,
        turns.map((turn) => turn.id),
        kinds,
      )
        .filter((event) => event.sequence > from && event.sequence < to)
        .map((event) => event.aggregate_id),
    );
  const ended = within(TURN_ENDS),
    queued = within(['turn.queued']);
  return {
    ended: turns.filter((turn) => ended.has(turn.id)),
    // The tracker's other turns are wakes, whose input starts with the inbox header.
    handedBack: turns.filter(
      (turn) =>
        queued.has(turn.id) && turn.origin === 'tracker' && !turn.input.startsWith(INBOX_HEADER),
    ).length,
  };
}

/** The ratio of the spending to the budget. */
export function ratioToBudget(inputTokens: number, wallMs: number, budget: TaskBudget): number {
  // Either limit alone makes the task over budget, so the larger ratio decides.
  return Math.max(inputTokens / budget.input_tokens, wallMs / budget.wall_ms);
}

/** The task's ratio to the budget of its tier and path; undefined when that cell has none. */
function budgetRatio(ctx: ControlContext, row: Retrospective): number | undefined {
  const kind = row.measured_kind ?? row.planned_kind;
  const budget =
    kind && row.path && workflowPolicy(ctx, row.project_id).budget[kind.tier]?.[row.path];
  if (!budget) return;
  // A direct task has only the lead's usage; a dispatched one adds its task sessions'.
  const input = (row.lead_usage?.input_tokens ?? 0) + (row.task_usage?.input_tokens ?? 0);
  const wall = Object.entries(row.stage_ms ?? {})
    .filter(([stage]) => stage !== 'step_approval')
    .reduce((sum, [, ms]) => sum + ms, 0);
  return ratioToBudget(input, wall, budget);
}

/**
 * The generation's waits for the user on an approval or an inconclusive prompt, oldest first, each
 * from where the earlier waits of its slot end; a wait still open lasts until `until`, or is left out.
 */
export function stepWaits(
  ctx: ControlContext,
  plan: BoardPlan,
  taskId: string,
  generation: number,
  until?: number,
): { from: number; to: number; slot: StepRun['slot'] }[] {
  const runIds = new Set(
    ctx.store
      .list<StepRun>('workflow_step_runs')
      .filter(
        (run) =>
          run.lead_session_id === plan.id &&
          run.task_id === taskId &&
          run.generation === generation &&
          (run.step.kind.type === 'approval' || run.step.kind.type === 'prompt'),
      )
      .map((run) => run.id),
  );
  const waitingSince = new Map<string, { at: number; slot: StepRun['slot'] }>(),
    waits: { from: number; to: number; slot: StepRun['slot'] }[] = [];
  for (const event of ctx.store.kindEvents(plan.project_id, ['workflow.step_changed'])) {
    if (!runIds.has(event.aggregate_id)) continue;
    const payload = event.payload as { state: StepRun['state']; slot: StepRun['slot'] };
    const since = waitingSince.get(event.aggregate_id);
    if (payload.state === 'waiting' || payload.state === 'inconclusive')
      waitingSince.set(event.aggregate_id, { at: event.created_at, slot: payload.slot });
    else if (since !== undefined) {
      waitingSince.delete(event.aggregate_id);
      waits.push({ from: since.at, to: event.created_at, slot: payload.slot });
    }
  }
  if (until !== undefined)
    for (const { at, slot } of waitingSince.values()) waits.push({ from: at, to: until, slot });
  // Waits that overlap in one slot count once.
  waits.sort((a, b) => a.from - b.from);
  return waits.map((wait, i) => {
    const covered = Math.max(
      wait.from,
      ...waits.slice(0, i).flatMap((each) => (each.slot === wait.slot ? [each.to] : [])),
    );
    return { from: Math.min(covered, wait.to), to: wait.to, slot: wait.slot };
  });
}

function record(
  ctx: ControlContext,
  plan: BoardPlan,
  taskId: string,
  generation: number,
  outcome: Retrospective['outcome'],
  sessions: Session[],
  planned: PlanTask | undefined,
  /** The revision of the failed record this one replaces; absent for a first record. */
  replaces?: number,
): void {
  const planEvents = eventsOf(
    ctx,
    [plan.id],
    [
      'board.plan_updated',
      'task.start_requested',
      'task.dispatched',
      'task.claimed',
      'task.reported',
      'task.accepted',
    ],
  );
  const ids = new Set(sessions.map((session) => session.id));
  let plannedAt: number | undefined,
    requestedAt: number | undefined,
    dispatchedAt: number | undefined,
    claimedAt: number | undefined,
    reportedAt: number | undefined,
    acceptedAt: number | undefined;
  for (const event of planEvents) {
    const p = event.payload;
    if (event.kind === 'board.plan_updated') {
      // A removed task is planned only in the plans written before its removal.
      const written = writtenTask(event, taskId, generation);
      if (!written) continue;
      plannedAt ??= event.created_at;
      if (outcome === 'removed') planned = written;
    } else if (event.created_at < (plannedAt ?? 0)) continue;
    else if (event.kind === 'task.start_requested') {
      if ((p.task_ids as string[]).includes(taskId)) requestedAt ??= event.created_at;
    } else if (event.kind === 'task.dispatched') {
      if (p.task_id === taskId && ids.has(p.session_id as string))
        dispatchedAt ??= event.created_at;
    } else if (event.kind === 'task.claimed') {
      if (p.task_id === taskId && p.generation === generation) claimedAt ??= event.created_at;
    } else if (event.kind === 'task.reported') {
      const note = p as unknown as LeadNote;
      if (note.kind === 'done' && ids.has(note.session_id)) reportedAt ??= event.created_at;
    } else if (
      event.kind === 'task.accepted' &&
      p.task_id === taskId &&
      ((p.generation as number | undefined) ?? 1) === generation
    )
      acceptedAt = event.created_at;
  }
  // A direct task has no task session: the lead did it between its claim and its merge.
  const direct =
    outcome !== 'removed' && currentDirectMerge(plan, taskId)
      ? directEvents(ctx, plan.id, taskId, generation)
      : undefined;
  const lead = direct && ctx.store.get<Session>('sessions', plan.id);
  const {
    mergeStartedAt,
    mergedAt,
    gatePassedOn,
    mergedKind,
    scopeViolations,
    lastTurnEndedAt,
    failureCodes,
    gateFailures,
    gateChecks,
  } = mergeFacts(
    direct?.filter((each) => MERGE_EVENTS.includes(each.kind)) ??
      eventsOf(ctx, [...ids], MERGE_EVENTS),
  );
  const allTurns = ctx.store.list<SessionTurn>('session_turns');
  const turns = allTurns.filter((turn) => ids.has(turn.session_id));
  // A wake yet to end has no decision or usage to count.
  const woken = leadWakes(ctx, plan, taskId, plannedAt ?? 0),
    wakeTurns = allTurns.filter(
      (turn) => woken.includes(turn.id) && !['queued', 'running'].includes(turn.state),
    ),
    wakes = wakeTurns.map((turn) => turn.id),
    approvalWaitMs = approvalWait(ctx, ids);
  const leadWork = direct && leadTurnsWithin(ctx, plan.id, allTurns, direct),
    leadTurns = [
      ...wakeTurns,
      ...(leadWork?.ended ?? []).filter((turn) => !wakes.includes(turn.id)),
    ];
  const last = sessions.at(-1);
  const span = (from: number | undefined, to: number | undefined) =>
    from !== undefined && to !== undefined && to >= from ? to - from : undefined;
  // The first done report of a direct task ends its work; a hand-back after it is gate and merge time.
  // The lead's plan also carries the reports of its task sessions.
  const directReportedAt = direct?.find(
    (event) =>
      event.kind === 'task.reported' &&
      event.payload.direct === true &&
      event.payload.task_id === taskId &&
      event.payload.generation === generation,
  )?.created_at;
  const stages: NonNullable<Retrospective['stage_ms']> = direct
    ? {
        execution: span(direct[0]!.created_at, directReportedAt),
        gate_and_merge: span(directReportedAt, mergedAt),
      }
    : {
        planning: span(plannedAt, requestedAt),
        dispatch_wait: span(requestedAt, dispatchedAt),
        // A task that failed before it reported ran until its last turn ended.
        execution: span(
          dispatchedAt,
          mergeStartedAt ?? reportedAt ?? (outcome === 'failed' ? lastTurnEndedAt : undefined),
        ),
        gate_and_merge: span(mergeStartedAt, mergedAt),
        merge_to_acceptance: span(mergedAt, acceptedAt),
      };
  // Each wait for the user on an approval or an inconclusive prompt leaves the stage it fell in.
  for (const wait of stepWaits(ctx, plan, taskId, generation)) {
    const ms = wait.to - wait.from,
      stage = SLOT_STAGES[wait.slot];
    stages.step_approval = (stages.step_approval ?? 0) + ms;
    if (stages[stage] !== undefined) stages[stage] = Math.max(0, stages[stage] - ms);
  }
  const model = direct
    ? (leadWork!.ended.findLast((turn) => turn.reported_model)?.reported_model ??
      lead?.reported_model ??
      lead?.requested_model)
    : (turns.findLast((turn) => turn.reported_model)?.reported_model ??
      last?.reported_model ??
      last?.requested_model ??
      planned?.model);
  const runtime = direct ? lead?.runtime : (last?.runtime ?? planned?.runtime),
    effort = direct ? lead?.requested_effort : (last?.requested_effort ?? planned?.effort);
  // Hand-backs of a direct task are counted by lead and task across generations; these are the latest.
  const directHandbacks = leadWork?.handedBack
    ? (ownEntry(plan.handed_back, `${plan.id}:${taskId}`) ?? []).slice(-leadWork.handedBack)
    : [];
  const starts = [claimedAt, dispatchedAt].filter((at) => at !== undefined);
  const row: Retrospective = {
    id: retrospectiveId(plan.id, taskId, generation),
    revision: 1,
    project_id: plan.project_id,
    lead_session_id: plan.id,
    task_id: taskId,
    session_ids: direct ? [plan.id] : sessions.map((session) => session.id),
    outcome,
    ...(outcome === 'failed' && last?.stop_requested ? { stopped_by: last.stop_requested.by } : {}),
    recorded_at: ctx.store.now(),
    ...(planned?.kind ? { planned_kind: planned.kind } : {}),
    ...(mergedKind ? { measured_kind: tierAfter(mergedKind, stages.execution) } : {}),
    ...(direct
      ? { path: 'direct' as const }
      : sessions.length
        ? {
            path:
              planned && taskPath(ctx, plan.project_id, planned) === 'review_loop'
                ? ('review_loop' as const)
                : ('dispatch' as const),
          }
        : {}),
    ...(runtime ? { runtime } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    handbacks: direct
      ? directHandbacks.map((reason) => ({ reason }))
      : sessions.flatMap((session) => [
          ...(ownEntry(plan.handed_back, session.id) ?? []).map((reason) => ({ reason })),
          ...ctx.store
            .kindEvents(plan.project_id, ['task.handed_back'])
            .filter((event) => (event.payload as { session_id: string }).session_id === session.id)
            .map((event) => ({ reason: (event.payload as { reason: string }).reason })),
        ]),
    ...(gatePassedOn !== undefined ? { gate_passed_on_attempt: gatePassedOn } : {}),
    ...(gateFailures.length ? { gate_failures: gateFailures, gate_failed_checks: gateChecks } : {}),
    ...(sessions.length
      ? { scope_violations: scopeViolations, ...turnAlerts(ctx, plan, ids, turns) }
      : {}),
    ...(approvalWaitMs !== undefined ? { approval_wait_ms: approvalWaitMs } : {}),
    // A turn that failed without a runtime error code, as on a daemon restart, counts as unknown.
    turn_failure_codes: turns
      .filter((turn) => turn.state === 'failed')
      .map((turn) => failureCodes.get(turn.id) ?? 'unknown'),
    lead_wakes: wakes.length,
    lead_wakes_without_decision: wakesWithoutDecision(ctx, plan, wakes),
    ...(leadTurns.length ? { lead_usage: tokens(leadTurns) } : {}),
    ...(sessions.length ? { task_usage: tokens(turns) } : {}),
    stage_ms: Object.fromEntries(
      Object.entries(stages).filter(([, ms]) => ms !== undefined),
    ) as Retrospective['stage_ms'],
    ...(starts.length ? { started_at: Math.min(...starts) } : {}),
    ...exposure(ctx, plan.project_id, [...ids]),
  };
  try {
    const evidence = runtimeDiagnostics(
      ctx,
      row.project_id,
      Math.max(
        0,
        row.recorded_at - RUNTIME_LOOKBACK_MS,
        claimedAt ?? requestedAt ?? plannedAt ?? 0,
      ),
      row.recorded_at,
      {
        scope: { leadId: plan.id, taskId, sessions: new Set(row.session_ids) },
        limit: 6,
        live: false,
      },
    ).findings;
    if (evidence.length) row.runtime_findings = evidence;
  } catch {
    // Preserve the task retrospective if optional telemetry is unavailable.
  }
  const ratio = budgetRatio(ctx, row);
  if (ratio !== undefined) row.budget_ratio = ratio;
  const stored =
    replaces === undefined
      ? ctx.store.insert('retrospectives', row)
      : ctx.store.update('retrospectives', { ...row, revision: replaces }, replaces);
  ctx.store.event('retrospective.recorded', stored, row.project_id, {
    retrospective_id: row.id,
    project_id: row.project_id,
    lead_session_id: row.lead_session_id,
    task_id: row.task_id,
  });
}

/** The task id of a row that records a session the user opened outside any plan task. */
const SESSION_TASK = 'session';

/** Records a session the user opened outside any plan task, once it landed its work. */
function recordSession(ctx: ControlContext, session: Session): void {
  const events = eventsOf(ctx, [session.id], ['session.opened', ...MERGE_EVENTS]);
  const openedAt = events.find((event) => event.kind === 'session.opened')?.created_at;
  const {
    mergeStartedAt,
    mergedAt,
    gatePassedOn,
    mergedKind,
    failureCodes,
    gateFailures,
    gateChecks,
  } = mergeFacts(events.filter((event) => MERGE_EVENTS.includes(event.kind)));
  const turns = ctx.store
    .list<SessionTurn>('session_turns')
    .filter((turn) => turn.session_id === session.id);
  const span = (from: number | undefined, to: number | undefined) =>
    from !== undefined && to !== undefined && to >= from ? to - from : undefined;
  // A folder session lands without a merge start, so its work runs until it landed.
  const stages: NonNullable<Retrospective['stage_ms']> = {
    execution: span(openedAt, mergeStartedAt ?? mergedAt),
    gate_and_merge: span(mergeStartedAt, mergedAt),
  };
  const model =
    turns.findLast((turn) => turn.reported_model)?.reported_model ??
    session.reported_model ??
    session.requested_model;
  const approvalWaitMs = approvalWait(ctx, new Set([session.id]));
  const row: Retrospective = {
    id: retrospectiveId(session.id, SESSION_TASK, 1),
    revision: 1,
    project_id: session.project_id,
    lead_session_id: session.id,
    task_id: SESSION_TASK,
    session_ids: [session.id],
    outcome: 'merged',
    origin: 'session',
    recorded_at: ctx.store.now(),
    ...(mergedKind ? { measured_kind: tierAfter(mergedKind, stages.execution) } : {}),
    runtime: session.runtime,
    ...(model ? { model } : {}),
    ...(session.requested_effort ? { effort: session.requested_effort } : {}),
    ...(gatePassedOn !== undefined ? { gate_passed_on_attempt: gatePassedOn } : {}),
    ...(gateFailures.length ? { gate_failures: gateFailures, gate_failed_checks: gateChecks } : {}),
    ...(approvalWaitMs !== undefined ? { approval_wait_ms: approvalWaitMs } : {}),
    turn_failure_codes: turns
      .filter((turn) => turn.state === 'failed')
      .map((turn) => failureCodes.get(turn.id) ?? 'unknown'),
    task_usage: tokens(turns),
    stage_ms: Object.fromEntries(
      Object.entries(stages).filter(([, ms]) => ms !== undefined),
    ) as Retrospective['stage_ms'],
    ...(openedAt !== undefined ? { started_at: openedAt } : {}),
    ...exposure(ctx, session.project_id, [session.id]),
  };
  const stored = ctx.store.insert('retrospectives', row);
  ctx.store.event('retrospective.recorded', stored, row.project_id, {
    retrospective_id: row.id,
    project_id: row.project_id,
    lead_session_id: row.lead_session_id,
    task_id: row.task_id,
  });
}

/**
 * By context, this connection's write count and the count of other connections' commits when the
 * last completed scan began. The scan reads only the database, never the clock, so while both counts
 * stay the same it would find nothing new.
 */
const scanned = new WeakMap<ControlContext, string>();

/** Forgets the last scan: a rollback of its transaction undoes writes without lowering the count. */
export const forgetRetrospectiveScan = (ctx: ControlContext): void => void scanned.delete(ctx);

/**
 * Records each task that merged, was accepted, failed or was removed, and each session outside a
 * task that landed its work, that has no retrospective yet.
 */
export function recordRetrospectives(ctx: ControlContext): void {
  const { stamp } = ctx.store.db
    .prepare(
      "SELECT total_changes() || ':' || (SELECT data_version FROM pragma_data_version) AS stamp",
    )
    .get() as { stamp: string };
  if (scanned.get(ctx) === stamp) return;
  recordUnrecorded(ctx);
  scanned.set(ctx, stamp);
}

function recordUnrecorded(ctx: ControlContext): void {
  const plans = ctx.store.list<BoardPlan>('board_plans');
  const recorded = new Map(
    (
      ctx.store.db
        .prepare(
          "SELECT id, revision, data ->> '$.outcome' AS outcome, json_array_length(data -> '$.session_ids') AS sessions FROM retrospectives",
        )
        .all() as {
        id: string;
        revision: number;
        outcome: Retrospective['outcome'];
        sessions: number;
      }[]
    ).map((row) => [row.id, row]),
  );
  const onTasks = new Map<string, Session[]>(),
    landed: Session[] = [];
  for (const session of ctx.store.list<Session>('sessions'))
    if (session.workspace_id && session.task) {
      const key = `${session.task.lead_session_id}\0${session.task.id}`;
      onTasks.set(key, [...(onTasks.get(key) ?? []), session]);
    } else if (
      !session.task &&
      session.outcome === 'merged' &&
      !recorded.has(retrospectiveId(session.id, SESSION_TASK, 1))
    )
      landed.push(session);
  const wakeOpen = ctx.store.db.prepare(
    "SELECT 1 FROM session_turns WHERE data ->> '$.session_id' = ? AND data ->> '$.origin' = 'tracker' AND data ->> '$.state' IN ('queued', 'running') LIMIT 1",
  );
  // The record of a finished task counts the lead's wake about it, so it waits for that wake to end.
  const waking = (plan: BoardPlan, taskId: string) =>
    ctx.store.get<Session>('sessions', plan.id)?.state !== 'closed' &&
    (plan.inbox.some((note) => note.task_id === taskId && !finishingMerge(ctx, plan, note)) ||
      !!wakeOpen.get(plan.id));
  for (const plan of plans) {
    const bound = (taskId: string) => onTasks.get(`${plan.id}\0${taskId}`) ?? [];
    for (const task of plan.tasks) {
      const generation = taskGeneration(plan, task.id);
      const prior = recorded.get(retrospectiveId(plan.id, task.id, generation));
      // A stopped task starts again in the same generation, so its failed record is not final.
      if (prior && prior.outcome !== 'failed') continue;
      const sessions = bound(task.id);
      // As taskSessions in board-plan, from the sessions listed once.
      const current = sessions.filter((session) =>
        currentBinding(plan, session.task!)
          ? session.outcome !== 'discarded'
          : !session.outcome && awaitingChange(plan, session),
      );
      const ofGeneration = sessions.filter(
        (session) => (session.task!.generation ?? 1) === generation || current.includes(session),
      );
      const outcome = currentAcceptance(plan, task.id)
        ? 'accepted'
        : taskState(plan, task.id, current) === 'done'
          ? 'merged'
          : ofGeneration.length &&
              ofGeneration.every(
                (session) => session.state === 'closed' && session.outcome !== 'merged',
              ) &&
              !ownEntry(plan.dispatch, task.id)
            ? 'failed'
            : undefined;
      // A task that failed again over other sessions may have another stopper.
      const failedAgain =
        outcome === 'failed' &&
        prior?.outcome === 'failed' &&
        ofGeneration.length !== prior.sessions;
      if (
        outcome &&
        (outcome !== prior?.outcome || failedAgain) &&
        !(outcome !== 'failed' && waking(plan, task.id))
      )
        record(ctx, plan, task.id, generation, outcome, ofGeneration, task, prior?.revision);
    }
    for (const [taskId, generation] of Object.entries(plan.retired ?? {})) {
      if (recorded.has(retrospectiveId(plan.id, taskId, generation))) continue;
      const sessions = bound(taskId).filter(
        (session) => (session.task!.generation ?? 1) === generation,
      );
      record(ctx, plan, taskId, generation, 'removed', sessions, undefined);
    }
  }
  for (const session of landed) recordSession(ctx, session);
}

/** The project's retrospectives, newest first, of one task when taskId is given. */
export function retrospectiveList(
  ctx: ControlContext,
  principal: Principal,
  projectId: string,
  taskId?: string,
): Retrospective[] {
  projectAccess(ctx, principal, projectId, 'retrospective.list');
  ctx.store.must<Project>('projects', projectId);
  return (
    ctx.store.db
      .prepare(
        "SELECT data FROM retrospectives WHERE json_extract(data,'$.project_id')=? ORDER BY rowid",
      )
      .all(projectId) as { data: string }[]
  )
    .map((row) => JSON.parse(row.data) as Retrospective)
    .filter((row) => taskId === undefined || row.task_id === taskId)
    .sort((a, b) => b.recorded_at - a.recorded_at)
    .slice(0, LIST_LIMIT);
}
