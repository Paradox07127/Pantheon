import { toolCommand, toolFiles, toolInputSummary, reportedToolTokens } from '@pantheon/adapters';
import {
  requireThat,
  canonical,
  type AgentEvent,
  type BoardPlan,
  type LeadNote,
  type Event,
  type Principal,
  type Project,
  type Session,
  type SessionTurn,
  type TraceLane,
  type TraceSpan,
  type TraceTimeAllocation,
  type Workspace,
} from '@pantheon/domain';
import type {
  ProjectHeatmap,
  ProjectCollab,
  SessionStepDiff,
  ProjectTrace,
  SessionTrace,
  TitledTraceLane,
  TraceStats,
  ToolCall,
  ProjectTraceStats,
} from '@pantheon/protocol';
import { createHash } from 'node:crypto';
import { projectAccess, userOnly, type ControlContext } from './context.js';
import { runGit } from './git.js';
import { stepFiles } from './step-diff.js';
import type { TraceProject } from './trace-index.js';
import { runtimeDiagnostics } from './runtime-findings.js';
import { reflectionLeads, reflectionRuntimes, runtimeReviewHistory } from './runtime-review.js';
import { baselineStart, TURN_ENDS } from './workbench-session.js';
import { allocationOf, laneEvents, TIME_EVENTS } from './trace-time.js';

const SCAN_MS = 300;
// The daemon scans this often and announces what changed, so a query reads a scan this recent as it is.
const FRESH_MS = 2000;
// A turn is taken to last less than this, so the spans of a turn crossing the window edge are read with it.
const TURN_REACH_MS = 24 * 60 * 60 * 1000;
const GIT_JOBS = 4;
// Commit histories kept, by root and since.
const LOGS_KEPT = 16;
const MAX_BUCKETS = 2000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type Lane = TitledTraceLane;
interface MergedLane {
  lane: Lane;
  /** Turn spans ordered by start. */
  turns: TraceSpan[];
  /** Every other span, each pointing at one of turns. */
  spans: TraceSpan[];
}
type Segment = ProjectTrace['lanes'][number]['turns'][number]['segments'][number];

const TURN_STATUS: Record<SessionTurn['state'], TraceSpan['status']> = {
  completed: 'ok',
  failed: 'error',
  cancelled: 'ok',
  queued: 'running',
  running: 'running',
};
const SEGMENT_KINDS: Segment['kind'][] = ['wait', 'tool', 'llm', 'subagent', 'error'];

const timeOf = (span: TraceSpan): number | null => span.start ?? span.end;
const byTime = (a: TraceSpan, b: TraceSpan) => (timeOf(a) ?? Infinity) - (timeOf(b) ?? Infinity);
const isTool = (span: TraceSpan) => span.kind === 'tool' || span.kind === 'subagent';

/** Every project, so a transcript is placed in the project that owns it. */
export function traceProjects(ctx: ControlContext): TraceProject[] {
  const sessions = ctx.store.list<Session>('sessions'),
    workspaces = ctx.store.list<Workspace>('workspaces');
  return ctx.store.list<Project>('projects').map((project) => ({
    id: project.id,
    roots: project.roots,
    workspaces: workspaces
      .filter((workspace) => workspace.project_id === project.id)
      .map((workspace) => workspace.path),
    sessions: sessions
      .filter((session) => session.project_id === project.id && session.native_id)
      .map((session) => ({
        session_id: session.id,
        runtime: session.runtime,
        native_id: session.native_id!,
      })),
  }));
}

/** Indexes native transcripts for at most SCAN_MS; the query then reads what is indexed. */
function scan(ctx: ControlContext): Promise<{ done_files: number; total_files: number }> | null {
  if (!ctx.trace) return null;
  const last = ctx.trace.lastScan;
  if (
    last &&
    last.progress.done_files === last.progress.total_files &&
    Date.now() - last.at < FRESH_MS
  )
    return Promise.resolve(last.progress);
  return ctx.trace.scan(traceProjects(ctx), SCAN_MS);
}

/** The first index whose item passes, for a test that stays true once it is. */
function firstIndex<T>(items: T[], test: (item: T) => boolean): number {
  let low = 0,
    high = items.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (test(items[middle]!)) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** The turn a span falls in: the first containing it, else the latest started before it, else the first. */
function placer(turns: TraceSpan[]): (time: number | null) => TraceSpan {
  // Turns are ordered by start, so the started ones before a time are a prefix of these.
  const started = turns.filter((turn) => turn.start !== null);
  // The latest end among the turns up to each one; the first containing turn is the first reaching the time.
  const reach: number[] = [];
  for (const turn of started) reach.push(Math.max(reach.at(-1) ?? -Infinity, turn.end ?? Infinity));
  return (time) => {
    if (time !== null) {
      const count = firstIndex(started, (turn) => turn.start! > time),
        containing = firstIndex(reach, (end) => time <= end);
      const turn = containing < count ? started[containing] : started[count - 1];
      if (turn) return turn;
    }
    return turns[0]!;
  };
}

/** Runs each job with at most limit running at once; the results keep the order of the items. */
async function limited<T, R>(
  items: T[],
  limit: number,
  job: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await job(items[index]!);
      }
    }),
  );
  return results;
}

function merged(event: TraceSpan, native: TraceSpan): TraceSpan {
  return {
    ...event,
    ...native,
    name: native.name || event.name,
    start: native.start ?? event.start,
    end: native.end ?? event.end,
    native_interval: native.start !== null && native.end !== null,
    timing: native.start === null && native.end === null ? event.timing : 'native',
    status:
      event.status === 'error' || native.status === 'error'
        ? 'error'
        : native.status === 'unknown'
          ? event.status
          : native.status,
  };
}

const TOOL_KINDS = ['agent.tool.started', 'agent.tool.completed'];

/** The project's events of these kinds created between from and to, or only the aggregate's, in order. */
function eventsOf(
  ctx: ControlContext,
  projectId: string,
  kinds: string[],
  aggregateId?: string,
  from = Number.MIN_SAFE_INTEGER,
  to = Number.MAX_SAFE_INTEGER,
): Event[] {
  const filter = `project_id=? AND kind IN (${kinds.map(() => '?').join(',')}) AND created_at BETWEEN ? AND ?`;
  const rows = (aggregateId === undefined
    ? ctx.store.db
        .prepare(
          `SELECT * FROM events INDEXED BY events_diagnostic_window WHERE ${filter} ORDER BY sequence`,
        )
        .all(projectId, ...kinds, from, to)
    : ctx.store.db
        .prepare(
          `SELECT * FROM events INDEXED BY events_aggregate WHERE aggregate_id=? AND ${filter} ORDER BY sequence`,
        )
        .all(aggregateId, projectId, ...kinds, from, to)) as unknown as (Omit<Event, 'payload'> & {
    payload: string;
  })[];
  return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
}

type EventTime = Pick<Event, 'kind' | 'aggregate_id' | 'created_at' | 'sequence'>;

/** The project's turn events without their payloads, or only those of the session's turns, in order. */
function turnEvents(ctx: ControlContext, projectId: string, sessionId?: string): EventTime[] {
  const turnKinds = ['turn.queued', 'turn.running', ...TURN_ENDS],
    kinds = turnKinds.map(() => '?').join(',');
  return (sessionId === undefined
    ? ctx.store.db
        .prepare(
          `SELECT kind, aggregate_id, created_at, sequence FROM events INDEXED BY events_project_kind
            WHERE project_id=? AND kind IN (${kinds}) ORDER BY sequence`,
        )
        .all(projectId, ...turnKinds)
    : ctx.store.db
        .prepare(
          `SELECT kind, aggregate_id, created_at, sequence FROM events INDEXED BY events_aggregate
            WHERE aggregate_id IN (SELECT id FROM session_turns WHERE data ->> '$.session_id'=?)
            AND project_id=? AND kind IN (${kinds}) ORDER BY sequence`,
        )
        .all(sessionId, projectId, ...turnKinds)) as unknown as EventTime[];
}

/**
 * Each session of the project as a lane of its turns, tool calls and native spans, then the
 * external lanes; laneKey builds only that lane.
 */
function projectLanes(
  ctx: ControlContext,
  projectId: string,
  from?: number,
  to?: number,
  bounded?: {
    laneKey?: string;
    native: ReturnType<NonNullable<ControlContext['trace']>['lanes']>;
    events: Event[];
  },
  laneKey = bounded?.laneKey,
): MergedLane[] {
  const native = new Map(
    (bounded?.native ?? ctx.trace?.lanes(projectId, from, to, laneKey) ?? []).map((entry) => [
      entry.lane.key,
      entry,
    ]),
  );
  const project = ctx.store.must<Project>('projects', projectId);
  const sessions = (
    laneKey
      ? [ctx.store.get<Session>('sessions', laneKey)].filter((row) => row !== undefined)
      : ctx.store.list<Session>('sessions')
  ).filter(
    (session) =>
      session.project_id === projectId && (!bounded || bounded.laneKey || !session.runtime_review),
  );
  const turnsOf = new Map(sessions.map((session) => [session.id, [] as SessionTurn[]]));
  const turnsInWindow = bounded
    ? new Set(
        bounded.events.flatMap((event) =>
          event.kind.startsWith('turn.') ? [event.aggregate_id] : [],
        ),
      )
    : null;
  const sessionTurns = turnsInWindow
    ? [...turnsInWindow].flatMap((key) => ctx.store.get<SessionTurn>('session_turns', key) ?? [])
    : laneKey
      ? (
          ctx.store.db
            .prepare(
              "SELECT data FROM session_turns WHERE data ->> '$.session_id'=? ORDER BY rowid",
            )
            .all(laneKey) as { data: string }[]
        ).map((row) => JSON.parse(row.data) as SessionTurn)
      : ctx.store.list<SessionTurn>('session_turns');
  for (const turn of sessionTurns) turnsOf.get(turn.session_id)?.push(turn);
  const times = new Map<string, { running?: number; queued?: number; end?: number }>();
  type Recorded = { at: number; sequence: number; payload: ToolPayload };
  const tools = new Map<string, Map<string, { started?: Recorded; completed?: Recorded }>>();
  const record = (event: EventTime & { payload?: unknown }) => {
    if (event.kind.startsWith('agent.tool.')) {
      const payload = event.payload as ToolPayload;
      const calls = tools.get(event.aggregate_id) ?? new Map();
      tools.set(event.aggregate_id, calls);
      const call = calls.get(payload.tool_call_id) ?? {};
      calls.set(payload.tool_call_id, call);
      const recorded = { at: event.created_at, sequence: event.sequence, payload };
      if (event.kind === 'agent.tool.started') call.started ??= recorded;
      else call.completed ??= recorded;
      return;
    }
    if (!event.kind.startsWith('turn.') || event.kind === 'turn.prepare_started') return;
    const turn = times.get(event.aggregate_id) ?? {};
    times.set(event.aggregate_id, turn);
    if (event.kind === 'turn.running') turn.running ??= event.created_at;
    else if (event.kind === 'turn.queued') turn.queued ??= event.created_at;
    else turn.end ??= event.created_at;
  };
  for (const event of bounded?.events ?? turnEvents(ctx, projectId, laneKey)) record(event);
  if (!bounded) {
    // Tool events are read only around the window, but as far as every turn it overlaps reaches,
    // so such a turn keeps all its calls.
    let low = from === undefined ? undefined : from - TURN_REACH_MS,
      high = to === undefined ? undefined : to + TURN_REACH_MS;
    for (const at of times.values()) {
      const start = at.running;
      if (start === undefined || (to !== undefined && start > to)) continue;
      if (from !== undefined && at.end !== undefined && at.end < from) continue;
      if (low !== undefined) low = Math.min(low, start);
      if (high !== undefined) high = at.end === undefined ? undefined : Math.max(high, at.end);
    }
    for (const event of eventsOf(ctx, projectId, TOOL_KINDS, laneKey, low, high)) record(event);
  }

  const lanes = sessions.map((session): MergedLane => {
    const nativeLane = native.get(session.id);
    const workspace = session.workspace_id
      ? ctx.store.get<Workspace>('workspaces', session.workspace_id)
      : undefined;
    const lane: Lane = {
      key: session.id,
      source: 'pantheon',
      runtime: nativeLane?.lane.runtime ?? (session.runtime as TraceLane['runtime']),
      session_id: session.id,
      native_id: nativeLane?.lane.native_id ?? session.native_id ?? '',
      title: session.title ?? '',
      ...baselineStart(ctx, session),
      cwd: nativeLane?.lane.cwd ?? workspace?.path ?? project.roots[0] ?? '',
    };
    const turns = turnsOf
      .get(session.id)!
      // A steer that never ran on its own was delivered into the running turn.
      .filter((turn) => turn.kind !== 'steer' || times.get(turn.id)?.running !== undefined)
      .map((turn): TraceSpan => {
        const at = times.get(turn.id);
        return {
          id: turn.id,
          parent: null,
          turn: turn.id,
          kind: 'turn',
          name: '',
          start: at?.running ?? at?.queued ?? null,
          end: at?.end ?? null,
          status: TURN_STATUS[turn.state],
          timing: 'daemon',
          // A turn that never ran spent nothing; one that ran without counts is unknown.
          ...(!turn.usage && at?.running === undefined
            ? { tokens: { input: 0, output: 0 } }
            : turn.usage && !turn.usage.tokens_unreported
              ? {
                  tokens: {
                    input: turn.usage.input_tokens,
                    output: turn.usage.output_tokens,
                    ...(turn.usage.cached_input_tokens !== undefined
                      ? { cache_read: turn.usage.cached_input_tokens }
                      : {}),
                  },
                }
              : {}),
          ...(turn.usage?.cost_usd !== undefined ? { cost_usd: turn.usage.cost_usd } : {}),
        };
      })
      .sort(byTime)
      .map((turn, index) => ({ ...turn, name: `turn ${index + 1}` }));
    if (turns.length === 0) {
      const spans = nativeLane?.spans ?? [];
      return {
        lane,
        turns: spans.filter((span) => span.kind === 'turn' && (!bounded || span.parent === null)),
        spans: spans.filter((span) => span.kind !== 'turn' || (bounded && span.parent !== null)),
      };
    }
    const turnById = new Map(turns.map((turn) => [turn.id, turn]));
    const placed = placer(turns);
    const spans = new Map<string, TraceSpan>();
    const previousCalls = new Map<
      string,
      { signature?: string; span: TraceSpan; completed?: Recorded }
    >();
    const calls = [...(tools.get(session.id) ?? [])].sort(
      (a, b) => (a[1].started?.sequence ?? Infinity) - (b[1].started?.sequence ?? Infinity),
    );
    for (const [id, call] of calls) {
      const payload = { ...call.completed?.payload, ...call.started?.payload };
      const turn =
        (payload.turn_id === undefined ? undefined : turnById.get(payload.turn_id)) ??
        placed(call.started?.at ?? call.completed?.at ?? null);
      const summary = toolInputSummary(call.started?.payload.input);
      const files = toolFiles(call.started?.payload.input);
      const output = call.completed?.payload.output;
      const tokens = reportedToolTokens(output?.usage);
      const signature =
        call.started?.payload.input === undefined
          ? undefined
          : canonical([turn.id, payload.name, call.started.payload.input]);
      const previous = previousCalls.get(turn.id);
      const retry =
        signature !== undefined &&
        previous?.signature === signature &&
        previous?.span.status === 'error' &&
        previous.completed &&
        call.started &&
        previous.completed.sequence < call.started.sequence
          ? (previous.span.retry_count ?? 0) + 1
          : 0;
      const span: TraceSpan = {
        id,
        parent: payload.parent_tool_use_id ?? turn.id,
        turn: turn.id,
        kind: 'tool',
        name: call.started?.payload.name ?? '',
        start: call.started?.at ?? null,
        end: call.completed?.at ?? null,
        status: call.completed
          ? call.completed.payload.ok === false
            ? 'error'
            : 'ok'
          : turn.status === 'running'
            ? 'running'
            : 'unknown',
        timing: 'daemon',
        duration_ms: payload.duration_ms,
        ...(summary !== undefined ? { input_summary: summary } : {}),
        ...(files ? { files } : {}),
        ...(tokens ? { tokens } : {}),
        ...(retry > 0 ? { retry_count: retry } : {}),
        ...(typeof output?.exitCode === 'number' ? { exit_code: output.exitCode } : {}),
      };
      spans.set(id, span);
      previousCalls.set(turn.id, { signature, span, completed: call.completed });
    }
    const nativeTurns = new Map(
      (nativeLane?.spans ?? [])
        .filter((span) => span.kind === 'turn')
        .map((span) => [span.id, span]),
    );
    for (const span of nativeLane?.spans ?? []) {
      if (span.kind === 'turn') continue;
      const event = spans.get(span.id);
      const turn = event?.turn ?? placed(timeOf(span)).id;
      // A subagent's turn hangs under the tool call that spawned it.
      const nativeParent = span.parent === null ? undefined : nativeTurns.get(span.parent);
      const moved: TraceSpan = {
        ...span,
        turn,
        parent: nativeParent ? (nativeParent.parent ?? turn) : span.parent,
      };
      const paired = event ? merged(event, moved) : moved;
      spans.set(
        span.id,
        bounded &&
          event &&
          paired.native_interval === false &&
          event.start !== null &&
          event.end !== null
          ? {
              ...paired,
              start: event.start,
              end: event.end,
              timing: 'daemon',
              native_interval: undefined,
            }
          : paired,
      );
    }
    return { lane, turns, spans: [...spans.values()].sort(byTime) };
  });
  for (const entry of native.values())
    if (entry.lane.source === 'external')
      lanes.push({
        lane: entry.lane,
        turns: entry.spans
          .filter((span) => span.kind === 'turn' && (!bounded || span.parent === null))
          .sort(byTime),
        spans: entry.spans.filter(
          (span) => span.kind !== 'turn' || (bounded && span.parent !== null),
        ),
      });
  const first = (lane: MergedLane) => (lane.turns[0] ? timeOf(lane.turns[0]) : null) ?? Infinity;
  return lanes.sort((a, b) => first(a) - first(b));
}

interface ToolPayload {
  tool_call_id: string;
  turn_id?: string;
  name?: string;
  ok?: boolean;
  duration_ms?: number;
  parent_tool_use_id?: string;
  input?: unknown;
  output?: { exitCode?: unknown; usage?: unknown };
}

const childrenOf = (spans: TraceSpan[]): Map<string, TraceSpan[]> => {
  const children = new Map<string, TraceSpan[]>();
  for (const span of spans) {
    const own = children.get(span.turn) ?? [];
    children.set(span.turn, own);
    own.push(span);
  }
  return children;
};

/** A turn's own tokens, else the sum of its model calls. */
function turnTokens(turn: TraceSpan, children: TraceSpan[]): NonNullable<TraceSpan['tokens']> {
  if (turn.tokens) return turn.tokens;
  const tokens: NonNullable<TraceSpan['tokens']> = { input: 0, output: 0 };
  for (const span of children)
    if (span.kind === 'llm' && span.tokens) {
      tokens.input += span.tokens.input;
      tokens.output += span.tokens.output;
      if (span.tokens.cache_read !== undefined)
        tokens.cache_read = (tokens.cache_read ?? 0) + span.tokens.cache_read;
    }
  return tokens;
}

function statsOf(
  sessions: number,
  turns: TraceSpan[],
  allSpans: TraceSpan[],
  from: number,
  to: number,
): TraceStats {
  // A turn crossing the window's edge keeps its spans outside the window; they are not counted.
  const spans = allSpans.filter((span) => {
    const at = timeOf(span);
    return at === null || (at >= from && at <= to);
  });
  const children = childrenOf(spans);
  const stats: TraceStats = {
    sessions,
    turns: turns.length,
    llm: spans.filter((span) => span.kind === 'llm').length,
    tool: spans.filter(isTool).length,
    error: [...turns, ...spans].filter((span) => span.status === 'error').length,
    tokens: { input: 0, output: 0 },
    active_ms: 0,
    commits: spans.filter((span) => span.commit).length,
  };
  let unreported = 0;
  for (const turn of turns) {
    const own = children.get(turn.id) ?? [];
    if (!turn.tokens && !own.some((span) => span.kind === 'llm' && span.tokens)) unreported += 1;
    const tokens = turnTokens(turn, own);
    stats.tokens.input += tokens.input;
    stats.tokens.output += tokens.output;
    if (tokens.cache_read !== undefined)
      stats.tokens.cache_read = (stats.tokens.cache_read ?? 0) + tokens.cache_read;
  }
  if (unreported > 0) stats.turns_without_usage = unreported;
  const durations = spans
    .filter(isTool)
    .flatMap((span) => {
      if (span.duration_ms !== undefined) return [span.duration_ms];
      return span.start !== null && span.end !== null ? [span.end - span.start] : [];
    })
    .sort((a, b) => a - b);
  if (durations.length > 0) {
    const middle = Math.floor(durations.length / 2);
    stats.tool_duration_p50_ms =
      durations.length % 2 === 0
        ? (durations[middle - 1]! + durations[middle]!) / 2
        : durations[middle]!;
    stats.tool_duration_p95_ms = durations[Math.ceil(durations.length * 0.95) - 1]!;
  }
  const intervals = turns
    .flatMap((turn) =>
      turn.start === null ? [] : [[Math.max(turn.start, from), Math.min(turn.end ?? to, to)]],
    )
    .filter(([a, b]) => a! < b!)
    .sort((a, b) => a[0]! - b[0]!);
  let reached = -Infinity;
  for (const [a, b] of intervals) {
    const start = Math.max(a!, reached);
    if (b! > start) stats.active_ms += b! - start;
    reached = Math.max(reached, b!);
  }
  return stats;
}

function segmentsOf(turn: TraceSpan, children: TraceSpan[], to: number): Segment[] {
  if (turn.start === null) return [];
  const start = turn.start,
    end = turn.end ?? to;
  const points: { at: number; rank: number; step: number }[] = [];
  for (const span of children) {
    if (span.start === null) continue;
    const rank =
      span.status === 'error'
        ? 4
        : span.kind === 'subagent'
          ? 3
          : span.kind === 'llm'
            ? 2
            : span.kind === 'tool'
              ? 1
              : 0;
    const a = Math.max(span.start, start),
      b = Math.min(span.end ?? end, end);
    if (rank > 0 && a < b) points.push({ at: a, rank, step: 1 }, { at: b, rank, step: -1 });
  }
  points.sort((a, b) => a.at - b.at);
  const active = SEGMENT_KINDS.map(() => 0),
    segments: Segment[] = [];
  let cursor = start,
    next = 0;
  while (cursor < end) {
    for (; next < points.length && points[next]!.at <= cursor; next += 1)
      active[points[next]!.rank]! += points[next]!.step;
    const until = Math.min(points[next]?.at ?? end, end);
    const kind =
      SEGMENT_KINDS[
        Math.max(
          0,
          active.findLastIndex((count) => count > 0),
        )
      ]!;
    const last = segments.at(-1);
    if (last?.kind === kind) last.to = until;
    else segments.push({ from: cursor, to: until, kind });
    cursor = until;
  }
  return segments;
}

export async function projectTrace(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
  fromIso: string | undefined,
  toIso: string | undefined,
  bucketMs: number,
): Promise<ProjectTrace> {
  projectAccess(ctx, p, projectId, 'project.read');
  ctx.store.must<Project>('projects', projectId);
  const indexing = await scan(ctx);
  const to = toIso === undefined ? ctx.store.now() : Date.parse(toIso),
    from = fromIso === undefined ? to - WEEK_MS : Date.parse(fromIso);
  const inWindow = (turn: TraceSpan) => {
    const at = timeOf(turn);
    return at !== null && at <= to && (turn.end ?? to) >= from;
  };
  const kept = projectLanes(ctx, projectId, from - TURN_REACH_MS, to + TURN_REACH_MS).flatMap(
    (entry) => {
      const turns = entry.turns.filter(inWindow);
      if (turns.length === 0) return [];
      const ids = new Set(turns.map((turn) => turn.id));
      return [{ ...entry, turns, spans: entry.spans.filter((span) => ids.has(span.turn)) }];
    },
  );
  const lanes = kept.map(({ lane, turns, spans }) => {
    const children = childrenOf(spans);
    return {
      lane,
      stats: statsOf(1, turns, spans, from, to),
      turns: turns.map((turn) => ({
        id: turn.id,
        start: turn.start,
        end: turn.end,
        status: turn.status,
        ...(turn.tokens || children.get(turn.id)?.some((span) => span.kind === 'llm' && span.tokens)
          ? { tokens: turnTokens(turn, children.get(turn.id) ?? []) }
          : {}),
        ...(turn.cost_usd !== undefined ? { cost_usd: turn.cost_usd } : {}),
        segments: segmentsOf(turn, children.get(turn.id) ?? [], to),
      })),
    };
  });
  const turns = kept.flatMap((entry) => entry.turns),
    spans = kept.flatMap((entry) => entry.spans);
  const width =
    Math.ceil((to - from) / bucketMs) > MAX_BUCKETS
      ? Math.ceil((to - from) / MAX_BUCKETS)
      : bucketMs;
  const buckets = Array.from({ length: Math.max(1, Math.ceil((to - from) / width)) }, (_, i) => ({
    at: from + i * width,
    llm: 0,
    tool: 0,
    error: 0,
  }));
  for (const span of [...turns, ...spans]) {
    if (span.start === null || span.start < from || span.start > to) continue;
    const bucket = buckets[Math.min(buckets.length - 1, Math.floor((span.start - from) / width))]!;
    if (span.kind === 'llm') bucket.llm += 1;
    if (isTool(span)) bucket.tool += 1;
    if (span.status === 'error') bucket.error += 1;
  }
  return {
    epoch: ctx.trace?.epoch ?? null,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    indexing,
    diagnostics: runtimeDiagnostics(ctx, projectId, from, to, {
      native: kept,
      excludeLanes: ctx.store
        .list<Session>('sessions')
        .filter((row) => row.project_id === projectId && row.runtime_review)
        .map((row) => row.id),
      live: toIso === undefined,
      nativeState: !indexing
        ? 'unavailable'
        : indexing.done_files < indexing.total_files
          ? 'indexing'
          : 'included',
    }),
    ...(p.role === 'user'
      ? {
          reflection_leads: reflectionLeads(ctx, projectId),
          reflection_runtimes: reflectionRuntimes(ctx, projectId),
          runtime_reviews: runtimeReviewHistory(ctx, projectId),
        }
      : {}),
    stats: statsOf(lanes.length, turns, spans, from, to),
    lanes,
    buckets,
  };
}

export async function sessionTrace(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
  laneKey: string,
  turn?: string,
): Promise<SessionTrace> {
  projectAccess(ctx, p, projectId, 'project.read');
  ctx.store.must<Project>('projects', projectId);
  await scan(ctx);
  const entry = projectLanes(ctx, projectId, undefined, undefined, undefined, laneKey).find(
    ({ lane }) => lane.key === laneKey,
  );
  requireThat(entry, 'not_found', `Not found: trace lane ${laneKey}`);
  const snapshots = eventsOf(
    ctx,
    projectId,
    ['agent.usage.updated', 'session.gate_checked', 'session.gate_run_failed'],
    laneKey,
  ).sort((a, b) => a.created_at - b.created_at || a.sequence - b.sequence);
  let next = 0;
  let usage: Extract<AgentEvent, { kind: 'usage.updated' }> | undefined;
  let gate: NonNullable<TraceSpan['gate_state']> = 'none';
  return {
    lane: entry.lane,
    spans: [...entry.turns, ...entry.spans]
      .filter((span) => turn === undefined || span.turn === turn)
      .sort(byTime)
      .map((span): TraceSpan => {
        if (span.start === null) return { ...span, gate_state: 'none' };
        while (next < snapshots.length && snapshots[next]!.created_at <= span.start) {
          const event = snapshots[next++]!;
          if (event.kind === 'agent.usage.updated') usage = event.payload as typeof usage;
          else if (event.kind === 'session.gate_run_failed') gate = 'failed';
          else {
            const { results } = event.payload as {
              results: { exit_code: number | null; timed_out: boolean; state?: string }[];
            };
            gate = results.every(
              (result) =>
                result.state === 'skipped' || (result.exit_code === 0 && !result.timed_out),
            )
              ? 'passed'
              : 'failed';
          }
        }
        return {
          ...span,
          gate_state: gate,
          ...(usage?.context_tokens === undefined ? {} : { context_tokens: usage.context_tokens }),
          ...(usage?.context_window === undefined ? {} : { context_window: usage.context_window }),
        };
      }),
  };
}

export async function sessionStepDiff(
  ctx: ControlContext,
  p: Principal,
  sessionId: string,
  turnId: string,
  spanId: string,
): Promise<SessionStepDiff> {
  const session = ctx.store.must<Session>('sessions', sessionId);
  projectAccess(ctx, p, session.project_id, 'project.read');
  const entry = projectLanes(
    ctx,
    session.project_id,
    undefined,
    undefined,
    undefined,
    sessionId,
  ).find(({ lane }) => lane.key === sessionId);
  const span = [...(entry?.turns ?? []), ...(entry?.spans ?? [])].find(
    (span) => span.id === spanId && span.turn === turnId,
  );
  requireThat(span, 'not_found', `Not found: trace span ${spanId} in turn ${turnId}`);
  let input = ctx.trace?.toolInput(session.project_id, sessionId, spanId);
  if (input === undefined) {
    const event = eventsOf(ctx, session.project_id, ['agent.tool.started'], sessionId).find(
      (event) =>
        (event.payload as ToolPayload).tool_call_id === spanId &&
        ((event.payload as ToolPayload).turn_id === undefined ||
          (event.payload as ToolPayload).turn_id === turnId),
    );
    input = (event?.payload as ToolPayload | undefined)?.input;
  }
  return {
    session_id: sessionId,
    turn_id: turnId,
    span_id: spanId,
    files: span.kind === 'tool' ? stepFiles(span.name, input) : [],
  };
}

export async function projectCollab(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
  since: number,
  until: number,
): Promise<ProjectCollab> {
  projectAccess(ctx, p, projectId, 'project.read');
  ctx.store.must<Project>('projects', projectId);
  await scan(ctx);
  const events = ctx.store.kindEvents(projectId, [
    'session.opened',
    'turn.queued',
    'session.turn.delivery',
    'lead.note_added',
    'task.reported',
    'task.handed_back',
    'session.model_changed',
    'session.runtime_changed',
  ]);
  const handbacks = new Set(
    events.filter((event) => event.kind === 'task.handed_back').map((event) => event.causation_id),
  );
  const sessions = new Map(
    ctx.store
      .list<Session>('sessions')
      .filter((session) => session.project_id === projectId)
      .map((session) => [session.id, session]),
  );
  const turns = new Map<string, SessionTurn>();
  const deliveries = new Map<string, SessionTurn['delivery']>();
  const notes = new Map<string, { note: LeadNote; cause: string }[]>();
  const models = new Map<string, string | null>();
  const result: ProjectCollab = { messages: [], in_flight: [], subagents: [], model_changes: [] };
  const counts = new Map<string, ProjectCollab['messages'][number]>();
  const sent: {
    sender: string;
    receiver: string;
    at: number;
    direction: ProjectCollab['messages'][number]['direction'];
    turn?: string;
    note?: string;
  }[] = [];
  for (const event of events) {
    if (event.kind === 'session.opened') {
      const session = event.payload as Session;
      // Purpose-only opening events do not identify a model selector.
      if (session.runtime !== undefined) {
        if (!sessions.has(event.aggregate_id)) sessions.set(event.aggregate_id, session);
        models.set(event.aggregate_id, session.requested_model ?? null);
      }
    } else if (event.kind === 'turn.queued') {
      const turn = event.payload as SessionTurn;
      turns.set(turn.id, turn);
      deliveries.set(turn.id, turn.delivery);
      const lead = sessions.get(turn.session_id)?.task?.lead_session_id;
      if (turn.origin === 'lead' && lead)
        sent.push({
          sender: lead,
          receiver: turn.session_id,
          at: event.created_at,
          direction: 'lead_to_worker',
          turn: turn.id,
        });
    } else if (event.kind === 'session.turn.delivery') {
      deliveries.set(
        event.aggregate_id,
        (event.payload as { delivery: SessionTurn['delivery'] }).delivery,
      );
    } else if (event.kind === 'lead.note_added') {
      const note = event.payload as LeadNote;
      const key = JSON.stringify([event.aggregate_id, note.session_id, note.at, note.kind]);
      notes.set(key, [...(notes.get(key) ?? []), { note, cause: event.causation_id }]);
    } else if (event.kind === 'task.reported') {
      const report = event.payload as LeadNote;
      if (
        !report.session_id ||
        report.session_id === event.aggregate_id ||
        handbacks.has(event.causation_id)
      )
        continue;
      const key = JSON.stringify([event.aggregate_id, report.session_id, report.at, report.kind]);
      const note = notes.get(key)?.find((entry) => entry.cause === event.causation_id)?.note;
      sent.push({
        sender: report.session_id,
        receiver: event.aggregate_id,
        at: event.created_at,
        direction: 'worker_to_lead',
        note: note?.id,
      });
    } else if (event.kind === 'session.runtime_changed') {
      models.delete(event.aggregate_id);
    } else if (event.kind === 'session.model_changed') {
      const change = event.payload as { model: string | null };
      const before = models.get(event.aggregate_id);
      if (event.created_at >= since && event.created_at <= until && before !== change.model)
        result.model_changes.push({
          session_id: event.aggregate_id,
          at: event.created_at,
          ...(before === undefined ? {} : { before }),
          after: change.model,
        });
      models.set(event.aggregate_id, change.model);
    }
  }
  for (const turn of ctx.store.list<SessionTurn>('session_turns'))
    if (turn.project_id === projectId) {
      turns.set(turn.id, turn);
      deliveries.set(turn.id, turn.delivery);
    }
  const pendingNotes = new Set(
    ctx.store
      .list<BoardPlan>('board_plans')
      .filter((plan) => plan.project_id === projectId)
      .flatMap((plan) => plan.inbox.flatMap((note) => (note.id === undefined ? [] : [note.id]))),
  );
  for (const turn of turns.values())
    if (deliveries.get(turn.id) === 'pending' || deliveries.get(turn.id) === 'queued')
      for (const noteId of turn.lead_note_ids ?? []) pendingNotes.add(noteId);
  const deliveredNotes = new Set(
    [...turns.values()].flatMap((turn) =>
      deliveries.get(turn.id) === 'delivered' ? (turn.lead_note_ids ?? []) : [],
    ),
  );
  for (const message of sent) {
    if (message.at >= since && message.at <= until) {
      const key = JSON.stringify([message.sender, message.receiver]);
      const count = counts.get(key) ?? {
        sender: message.sender,
        receiver: message.receiver,
        direction: message.direction,
        count: 0,
      };
      count.count += 1;
      counts.set(key, count);
    }
    const delivery = message.turn === undefined ? undefined : deliveries.get(message.turn);
    if (
      (message.turn !== undefined && (delivery === 'pending' || delivery === 'queued')) ||
      (message.note !== undefined &&
        pendingNotes.has(message.note) &&
        !deliveredNotes.has(message.note))
    )
      result.in_flight.push({
        sender: message.sender,
        receiver: message.receiver,
        sent_at: message.at,
      });
  }
  result.messages = [...counts.values()];
  for (const { lane, spans } of projectLanes(ctx, projectId)) {
    if (!lane.session_id) continue;
    for (const span of spans) {
      if (
        span.kind !== 'subagent' ||
        span.start === null ||
        span.start < since ||
        span.start > until
      )
        continue;
      const duration = span.duration_ms ?? (span.end === null ? undefined : span.end - span.start);
      result.subagents.push({
        session_id: lane.session_id,
        span_id: span.id,
        name: span.name,
        start: span.start,
        ...(duration === undefined ? {} : { duration_ms: duration }),
        status: span.status,
      });
    }
  }
  return result;
}

export async function toolCalls(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
  command?: string,
  limit = 50,
): Promise<ToolCall[]> {
  projectAccess(ctx, p, projectId, 'project.read');
  ctx.store.must<Project>('projects', projectId);
  await scan(ctx);
  const matches =
    command === undefined ? undefined : ctx.trace?.matchingCommands(projectId, command);
  const recorded = new Map<string, Set<string>>();
  if (command !== undefined)
    for (const event of ctx.store.kindEvents(projectId, ['agent.tool.started'])) {
      const payload = event.payload as ToolPayload;
      if (!toolCommand(payload.input)?.includes(command)) continue;
      const ids = recorded.get(event.aggregate_id) ?? new Set<string>();
      ids.add(payload.tool_call_id);
      recorded.set(event.aggregate_id, ids);
    }
  return projectLanes(ctx, projectId)
    .flatMap(({ lane, spans }) =>
      spans
        .filter(isTool)
        .filter(
          (span) =>
            command === undefined ||
            span.name.includes(command) ||
            matches?.get(lane.key)?.has(span.id) ||
            recorded.get(lane.key)?.has(span.id),
        )
        .map((span): ToolCall => ({
          session_id: lane.key,
          session_title: lane.title,
          turn_id: span.turn,
          span_id: span.id,
          tool_name: span.name,
          ...(span.input_summary !== undefined
            ? { input_summary: span.input_summary }
            : span.files?.length
              ? { input_summary: Array.from(span.files.join(', ')).slice(0, 200).join('') }
              : {}),
          start: span.start,
          ...(span.duration_ms !== undefined
            ? { duration_ms: span.duration_ms }
            : span.start !== null && span.end !== null
              ? { duration_ms: span.end - span.start }
              : {}),
          status: span.status,
          ...(span.exit_code !== undefined ? { exit_code: span.exit_code } : {}),
          ...(span.retry_count !== undefined ? { retry_count: span.retry_count } : {}),
        })),
    )
    .sort(
      (a, b) =>
        (b.start ?? -Infinity) - (a.start ?? -Infinity) || a.span_id.localeCompare(b.span_id),
    )
    .slice(0, limit);
}

/** Cache reads / input tokens from turns that report cache reads. */
export const cacheReadShare = (
  input: number,
  cache: number,
): Pick<ProjectTraceStats, 'cache_read_share'> =>
  input > 0 ? { cache_read_share: cache / input } : {};

export async function projectTraceStats(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
  since: number,
  until: number,
): Promise<ProjectTraceStats> {
  projectAccess(ctx, p, projectId, 'project.read');
  ctx.store.must<Project>('projects', projectId);
  await scan(ctx);
  const lanes = projectLanes(ctx, projectId, since, until + TURN_REACH_MS);
  const inside = (span: TraceSpan) =>
    span.start !== null && span.start >= since && span.start <= until;
  const turns = lanes.flatMap((lane) => lane.turns).filter(inside);
  const tools = lanes
    .flatMap((lane) => lane.spans)
    .filter(isTool)
    .filter(inside);
  const percentiles = (spans: TraceSpan[]) => {
    const samples = spans
      .flatMap((span) => {
        if (span.status === 'running' || span.end === null) return [];
        if (span.duration_ms !== undefined) return [span.duration_ms];
        return span.start === null ? [] : [span.end - span.start];
      })
      .sort((a, b) => a - b);
    if (samples.length < 5) return;
    const middle = Math.floor(samples.length / 2);
    return {
      p50:
        samples.length % 2 === 0 ? (samples[middle - 1]! + samples[middle]!) / 2 : samples[middle]!,
      p95: samples[Math.ceil(samples.length * 0.95) - 1]!,
    };
  };
  const turnDurations = percentiles(turns),
    toolDurations = percentiles(tools);
  let input = 0,
    cache = 0;
  for (const lane of lanes) {
    const children = childrenOf(lane.spans);
    for (const turn of lane.turns.filter(inside)) {
      const tokens = turnTokens(turn, children.get(turn.id) ?? []);
      if (tokens.cache_read === undefined) continue;
      input += tokens.input;
      cache += tokens.cache_read;
    }
  }
  return {
    ...(turnDurations
      ? { turn_duration_p50_ms: turnDurations.p50, turn_duration_p95_ms: turnDurations.p95 }
      : {}),
    ...(toolDurations
      ? { tool_duration_p50_ms: toolDurations.p50, tool_duration_p95_ms: toolDurations.p95 }
      : {}),
    ...cacheReadShare(input, cache),
    failed_tool_calls: tools.filter((span) => span.status === 'error').length,
  };
}

const TIME_LIMIT = 8192;

/** Summarizes already indexed observations. A chart read never triggers a transcript scan. */
export function traceTime(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
  laneKey?: string,
  fromIso?: string,
  toIso?: string,
): TraceTimeAllocation {
  userOnly(p);
  projectAccess(ctx, p, projectId, 'project.read');
  ctx.store.must<Project>('projects', projectId);
  const now = ctx.store.now();
  const to = Math.min(now, toIso === undefined ? now : Date.parse(toIso));
  const from = Math.max(
    0,
    fromIso === undefined ? (laneKey ? 0 : to - WEEK_MS) : Date.parse(fromIso),
  );
  requireThat(from <= to, 'invalid_input', 'The time range starts after it ends');
  const start = Math.max(0, from - TURN_REACH_MS);
  const stop = Math.min(now, to + TURN_REACH_MS);
  const cached = ctx.trace?.timeLanes(projectId, start, stop, TIME_LIMIT, laneKey);
  const rows = ctx.store.windowEvents(projectId, TIME_EVENTS, start, stop, TIME_LIMIT + 1, laneKey);
  const events = rows.slice(-TIME_LIMIT);
  const lanes = projectLanes(ctx, projectId, undefined, undefined, {
    laneKey,
    events,
    native: cached?.lanes ?? [],
  });
  requireThat(
    !laneKey || lanes.some(({ lane }) => lane.key === laneKey),
    'not_found',
    'Trace session unavailable',
  );
  const index = ctx.trace?.lastScan?.progress;
  const native = !ctx.trace
    ? 'unavailable'
    : !index || index.done_files < index.total_files
      ? 'indexing'
      : 'included';
  const partial = !!cached?.partial || rows.length > TIME_LIMIT;
  const byLane = laneKey === undefined ? laneEvents(lanes, events) : undefined;
  return {
    ...allocationOf(lanes, events, from, to, native, partial),
    ...(byLane
      ? {
          by_lane: Object.fromEntries(
            lanes.map((lane) => [
              lane.lane.key,
              allocationOf([lane], byLane.get(lane.lane.key)!, from, to, native, partial),
            ]),
          ),
        }
      : {}),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
const dayOf = (ms: number) => {
  const at = new Date(ms);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
};
/** Local midnight of the day of ms, moved by days. */
const midnight = (ms: number, days = 0) => {
  const at = new Date(ms);
  return new Date(at.getFullYear(), at.getMonth(), at.getDate() + days).getTime();
};

type Commit = ProjectHeatmap['commits'][number];

/** Commit histories by root and since, each kept while the tips it was read from stay the same. */
const logs = new Map<string, { tips: string; commits: Commit[] | null }>();

/** The commits of a root since a time, null when the root is no Git repository. */
async function rootCommits(root: string, since: number | undefined): Promise<Commit[] | null> {
  // Checkpoints and landing candidates under refs/pantheon are not project history.
  const exclude = '--exclude=refs/pantheon/*';
  // The commits git log --all starts from, with the detached HEAD of each session worktree.
  const listed = await runGit(root, ['rev-list', exclude, '--all', '--no-walk'], undefined, true);
  const tips =
      listed.exit_code === 0 ? createHash('sha1').update(listed.stdout).digest('hex') : undefined,
    key = `${root}\0${since ?? ''}`;
  const cached = logs.get(key);
  if (tips !== undefined && cached?.tips === tips) return cached.commits;
  const log = await runGit(
    root,
    [
      'log',
      exclude,
      '--all',
      '--numstat',
      '--format=%H%x09%ct%x09%s',
      ...(since === undefined ? [] : [`--since=${new Date(since).toISOString()}`]),
    ],
    undefined,
    true,
  );
  let commits: Commit[] | null = null;
  if (log.exit_code === 0) {
    commits = [];
    let current: Commit | undefined;
    for (const line of log.stdout.toString().split('\n')) {
      const header = /^([0-9a-f]{40,64})\t(\d+)\t(.*)$/.exec(line);
      if (header) {
        const at = Number(header[2]) * 1000;
        current = {
          sha: header[1]!,
          at,
          day: dayOf(at),
          lane_key: null,
          via: null,
          added: 0,
          removed: 0,
          subject: header[3]!,
        };
        commits.push(current);
        continue;
      }
      const stat = /^(\d+|-)\t(\d+|-)\t/.exec(line);
      if (stat && current) {
        current.added += stat[1] === '-' ? 0 : Number(stat[1]);
        current.removed += stat[2] === '-' ? 0 : Number(stat[2]);
      }
    }
  }
  if (tips !== undefined) {
    logs.delete(key);
    logs.set(key, { tips, commits });
    if (logs.size > LOGS_KEPT) logs.delete(logs.keys().next().value!);
  }
  return commits;
}

/** Commits of every root that is a Git repository, once each, and the roots that are. */
async function commitsOf(
  roots: string[],
  since: number | undefined,
): Promise<{ commits: Commit[]; repositories: string[] }> {
  const commits = new Map<string, Commit>(),
    repositories: string[] = [];
  for (const root of roots) {
    const listed = await rootCommits(root, since);
    if (listed === null) continue;
    repositories.push(root);
    for (const commit of listed) if (!commits.has(commit.sha)) commits.set(commit.sha, commit);
  }
  return { commits: [...commits.values()].sort((a, b) => a.at - b.at), repositories };
}

export async function projectHeatmap(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
  range: '7' | '30' | '90' | 'all',
): Promise<ProjectHeatmap> {
  projectAccess(ctx, p, projectId, 'project.read');
  const project = ctx.store.must<Project>('projects', projectId);
  await scan(ctx);
  const now = ctx.store.now(),
    today = midnight(now);
  let first = range === 'all' ? undefined : midnight(now, 1 - Number(range));
  const lanes = projectLanes(
    ctx,
    projectId,
    first === undefined ? undefined : first - TURN_REACH_MS,
  );
  const { commits, repositories } = await commitsOf(project.roots, first);
  if (first === undefined) {
    let earliest = now;
    for (const entry of lanes)
      for (const span of [...entry.turns, ...entry.spans]) {
        const at = timeOf(span);
        if (at !== null && at < earliest) earliest = at;
      }
    for (const commit of commits) earliest = Math.min(earliest, commit.at);
    first = midnight(earliest);
  }
  const days: string[] = [];
  for (let day = first; day <= today; day = midnight(day, 1)) days.push(dayOf(day));
  const dayIndex = new Map(days.map((day, index) => [day, index]));

  const mergeEvents = ctx.store.kindEvents(projectId, ['session.merged']);
  const merges = mergeEvents.flatMap((event) => {
    const range = event.payload as { from_sha?: string; to_sha?: string };
    if (!range.from_sha || !range.to_sha || range.from_sha === range.to_sha) return [];
    return repositories.map((root) => ({
      root,
      range: `${range.from_sha}..${range.to_sha}`,
      session: event.aggregate_id,
    }));
  });
  const revisions = await limited(merges, GIT_JOBS, ({ root, range }) =>
    runGit(root, ['rev-list', range], undefined, true),
  );
  const mergedBy = new Map<string, string>();
  for (const [index, { session }] of merges.entries())
    if (revisions[index]!.exit_code === 0)
      for (const sha of revisions[index]!.stdout.toString().split('\n'))
        if (sha) mergedBy.set(sha, session);
  // Each named sha with the first lane naming it, in lane and span order.
  const committed = new Map<string, { lane: string; order: number }>();
  for (const { lane, spans } of lanes)
    for (const span of spans)
      if (span.commit && !committed.has(span.commit.sha))
        committed.set(span.commit.sha, { lane: lane.key, order: committed.size });
  const lengths = [...new Set([...committed.keys()].map((sha) => sha.length))];
  const shown = commits
    .filter((commit) => dayIndex.has(commit.day))
    .map((commit): Commit => {
      const merge = mergedBy.get(commit.sha);
      if (merge) return { ...commit, lane_key: merge, via: 'merge' };
      // A commit line in Bash output names the commit by an abbreviated sha.
      let output: { lane: string; order: number } | undefined;
      for (const length of lengths) {
        const named = committed.get(commit.sha.slice(0, length));
        if (named && (!output || named.order < output.order)) output = named;
      }
      return output ? { ...commit, lane_key: output.lane, via: 'bash_output' } : commit;
    });

  const hours = days.map((day) => ({
    day,
    calls: Array<number>(24).fill(0),
    errors: Array<number>(24).fill(0),
  }));
  const rows = lanes.flatMap(({ lane, turns, spans }) => {
    const cells = days.map((day) => ({ day, llm: 0, tool: 0, error: 0, tokens: 0, commits: 0 }));
    const cellAt = (at: number | null) =>
      at === null ? undefined : cells[dayIndex.get(dayOf(at)) ?? -1];
    let active = false;
    for (const span of [...turns, ...spans]) {
      const at = timeOf(span);
      const cell = cellAt(at);
      if (!cell) continue;
      active = true;
      const hour = new Date(at!).getHours(),
        project = hours[dayIndex.get(dayOf(at!))!]!;
      if (span.kind === 'llm') cell.llm += 1;
      if (isTool(span)) cell.tool += 1;
      if (span.kind === 'llm' || isTool(span)) project.calls[hour]! += 1;
      if (span.status === 'error') {
        cell.error += 1;
        project.errors[hour]! += 1;
      }
    }
    if (!active) return [];
    const children = childrenOf(spans);
    const addTokens = (span: TraceSpan) => {
      const cell = cellAt(timeOf(span));
      if (cell && span.tokens) cell.tokens += span.tokens.input + span.tokens.output;
    };
    for (const turn of turns)
      if (turn.tokens) addTokens(turn);
      else for (const span of children.get(turn.id) ?? []) if (span.kind === 'llm') addTokens(span);
    for (const commit of shown)
      if (commit.lane_key === lane.key) cells[dayIndex.get(commit.day)!]!.commits += 1;
    return [
      {
        key: lane.key,
        title: lane.title,
        ...(lane.baseline_started_at === undefined
          ? {}
          : { baseline_started_at: lane.baseline_started_at }),
        cells,
      },
    ];
  });
  return {
    days,
    lanes: rows,
    hours,
    commits: shown,
    merges: mergeEvents
      .filter((event) => dayIndex.has(dayOf(event.created_at)))
      .map((event) => ({
        id: event.event_id,
        session_id: event.aggregate_id,
        at: event.created_at,
        day: dayOf(event.created_at),
      })),
  };
}
