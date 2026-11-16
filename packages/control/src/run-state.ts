import type { Approval, Session, SessionTurn } from '@pantheon/domain';
import type { BoardActivity, WorkbenchSession } from '@pantheon/protocol';
import type { ControlContext } from './context.js';
import { longBackground, PROGRESS_KINDS, turnActivity, type TurnActivity } from './progress.js';

type Run = NonNullable<WorkbenchSession['run']>;
type Wait = NonNullable<Run['wait']>;

// Input fields that name what a tool call works on, in the order they are tried.
const TOOL_TARGETS = [
  'command',
  'cmd',
  'file_path',
  'path',
  'pattern',
  'url',
  'query',
  'description',
];

/** The first command, path or the like of a tool input, on one line of at most 80 characters. */
function toolTarget(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return;
  for (const field of TOOL_TARGETS) {
    const value = (input as Record<string, unknown>)[field],
      text = Array.isArray(value)
        ? value.filter((part) => typeof part === 'string').join(' ')
        : value;
    if (typeof text === 'string' && text.trim())
      return text.replace(/\s+/g, ' ').trim().slice(0, 80);
  }
}

/** When the session's phases began, epoch milliseconds; a phase without its time counts from the newest progress. */
export interface RunTimes {
  /** The session's first event. */
  opened?: number;
  /** The session's newest progress event. */
  progressed?: number;
  merge_started?: number;
  gate_started?: number;
}

export interface RunPhase {
  phase: BoardActivity['phase'];
  since: number;
  tool?: BoardActivity['tool'];
  /** The running turn's activity since it started. */
  activity?: TurnActivity;
}

/** What the session is doing now as the board's activity phase; `request` is its oldest pending permission request. */
export function runPhase(
  ctx: ControlContext,
  sessionId: string,
  listed: Pick<WorkbenchSession, 'state' | 'gate'>,
  turns: Pick<SessionTurn, 'id' | 'state'>[],
  request: Approval | undefined,
  times: RunTimes,
  now: number,
): RunPhase {
  const running = turns.findLast((turn) => turn.state === 'running'),
    progress = times.progressed ?? times.opened ?? now,
    activity = running ? turnActivity(ctx, sessionId, running.id) : undefined;
  const open = activity?.open_call;
  const target = open ? toolTarget(open.input) : undefined;
  const [phase, since]: [BoardActivity['phase'], number] =
    listed.state === 'merging'
      ? ['merging', times.merge_started ?? progress]
      : listed.state === 'starting'
        ? ['starting', times.opened ?? progress]
        : request
          ? [
              request.tool === 'AskUserQuestion' && request.questions
                ? 'waiting_input'
                : 'waiting_approval',
              request.created_at,
            ]
          : open
            ? ['tool', open.at]
            : running
              ? [
                  'thinking',
                  activity ? Math.max(activity.started_at, activity.tool_ended_at ?? 0) : progress,
                ]
              : listed.state === 'running'
                ? // The turn is queued and has not started running yet; it may be a steer.
                  [
                    'starting',
                    ctx.store.eventSpan(turns.find((turn) => turn.state === 'queued')?.id ?? '')
                      ?.first ?? progress,
                  ]
                : ['running', 'cancelling'].includes(listed.gate?.state ?? '')
                  ? ['gate', times.gate_started ?? progress]
                  : ['idle', progress];
  return {
    phase,
    since,
    ...(open ? { tool: { name: open.name, ...(target ? { target } : {}) } } : {}),
    ...(activity ? { activity } : {}),
  };
}

/** Each session's run times from the project's events; `sessionOf` maps turn ids to their sessions. */
export function runTimes(
  ctx: ControlContext,
  projectId: string,
  sessionOf: Map<string, string>,
): Map<string, RunTimes> {
  const kinds = [
    ...PROGRESS_KINDS,
    'session.opened',
    'session.merge_started',
    'session.gate_started',
  ];
  const rows = ctx.store.db
    .prepare(
      `SELECT aggregate_id, kind, max(created_at) AS at FROM events INDEXED BY events_project_kind WHERE project_id=? AND kind IN (${kinds.map(() => '?').join(',')}) GROUP BY aggregate_id, kind`,
    )
    .all(projectId, ...kinds) as { aggregate_id: string; kind: string; at: number }[];
  const times = new Map<string, RunTimes>();
  for (const row of rows) {
    const sessionId = sessionOf.get(row.aggregate_id) ?? row.aggregate_id,
      entry = times.get(sessionId) ?? {};
    if (row.kind === 'session.opened') entry.opened = row.at;
    else if (row.kind === 'session.merge_started') entry.merge_started = row.at;
    else if (row.kind === 'session.gate_started') entry.gate_started = row.at;
    else entry.progressed = Math.max(entry.progressed ?? 0, row.at);
    times.set(sessionId, entry);
  }
  return times;
}

/** The newest event time of these kinds on the aggregate. */
function newestAt(ctx: ControlContext, aggregateId: string, kinds: string[]): number | undefined {
  const row = ctx.store.db
    .prepare(
      `SELECT max(created_at) AS at FROM events WHERE aggregate_id=? AND kind IN (${kinds.map(() => '?').join(',')})`,
    )
    .get(aggregateId, ...kinds) as { at: number | null };
  return row.at ?? undefined;
}

/**
 * compacting: the running turn's newest compaction has not ended; retrying: no tool call or text
 * followed the turn's newest retry.
 */
function turnPause(
  ctx: ControlContext,
  sessionId: string,
  turnId: string,
): { phase: 'compacting' | 'retrying'; since: number } | undefined {
  const rows = ctx.store.db
    .prepare(
      `SELECT kind, max(sequence) AS sequence, created_at FROM events WHERE aggregate_id=? AND kind IN ('agent.context.compacting','agent.context.compacted','agent.turn.retrying','agent.tool.started','agent.tool.completed','agent.message.delta') AND json_extract(payload,'$.turn_id')=? AND sequence>(SELECT coalesce(max(sequence),0) FROM events WHERE aggregate_id=? AND kind='turn.running') GROUP BY kind`,
    )
    .all(sessionId, turnId, turnId) as { kind: string; sequence: number; created_at: number }[];
  const of = (kind: string) => rows.find((row) => row.kind === kind);
  const newest = (...kinds: string[]) =>
    Math.max(0, ...kinds.map((kind) => of(kind)?.sequence ?? 0));
  const compacting = of('agent.context.compacting'),
    retrying = of('agent.turn.retrying');
  if (compacting && compacting.sequence > newest('agent.context.compacted'))
    return { phase: 'compacting', since: compacting.created_at };
  if (
    retrying &&
    retrying.sequence > newest('agent.tool.started', 'agent.tool.completed', 'agent.message.delta')
  )
    return { phase: 'retrying', since: retrying.created_at };
}

/**
 * The first of what the session waits on: an answer to its pending permission requests (question
 * when every one is an AskUserQuestion), the review of its baseline, a blocked merge, a failed
 * gate, reconciliation, or a background task running for BACKGROUND_LONG_MS.
 */
function runWait(
  ctx: ControlContext,
  session: Session,
  listed: Pick<WorkbenchSession, 'state' | 'gate' | 'merge'>,
  requests: Approval[],
  oldest: Approval | undefined,
  progress: number,
): Wait | undefined {
  if (oldest)
    return {
      reason: requests.every(
        (approval) => approval.tool === 'AskUserQuestion' && approval.questions,
      )
        ? 'question'
        : 'approval',
      since: oldest.created_at,
    };
  if (listed.state === 'waiting' && session.baseline)
    return {
      reason: 'baseline_review',
      since:
        newestAt(ctx, session.baseline.baseline_id, ['project.baseline_submitted']) ?? progress,
    };
  if (listed.merge?.state === 'blocked')
    return {
      reason: 'merge_blocked',
      since:
        newestAt(ctx, session.id, ['session.merge_blocked', 'session.merge_cancelled']) ?? progress,
    };
  if (listed.gate?.state === 'failed')
    return {
      reason: 'gate_failed',
      since: listed.gate.finished_at
        ? Date.parse(listed.gate.finished_at)
        : (newestAt(ctx, session.id, ['session.gate_checked', 'session.gate_run_failed']) ??
          progress),
    };
  if (session.state === 'reconciling')
    return {
      reason: 'reconciling',
      since:
        newestAt(ctx, session.id, [
          'session.reconciling',
          'session.handoff_delivery_unknown',
          'session.resume_failed',
        ]) ?? progress,
    };
  const background = longBackground(ctx, session.id);
  if (background.length)
    return {
      reason: 'long_background',
      since: Math.min(...background.map((task) => task.started_at)),
    };
}

/** What the session is doing now and what it waits on; `requests` are its pending permission requests. */
export function sessionRun(
  ctx: ControlContext,
  session: Session,
  listed: Pick<WorkbenchSession, 'state' | 'gate' | 'merge'>,
  turns: Pick<SessionTurn, 'id' | 'state'>[],
  requests: Approval[],
  times: RunTimes,
  now: number,
): Run {
  const request = requests.reduce<Approval | undefined>(
    (first, approval) => (!first || approval.created_at < first.created_at ? approval : first),
    undefined,
  );
  const { phase, since, tool, activity } = runPhase(
    ctx,
    session.id,
    listed,
    turns,
    request,
    times,
    now,
  );
  const running = turns.findLast((turn) => turn.state === 'running');
  const pause =
    phase === 'thinking' && activity && running
      ? turnPause(ctx, session.id, running.id)
      : undefined;
  const wait = runWait(
    ctx,
    session,
    listed,
    requests,
    request,
    times.progressed ?? times.opened ?? now,
  );
  return {
    ...(pause ?? { phase, since }),
    ...(tool ? { tool } : {}),
    ...(wait ? { wait } : {}),
  };
}
