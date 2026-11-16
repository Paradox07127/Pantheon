import type { ProjectHeatmap, ProjectTrace, SessionTrace, TraceStats } from '@pantheon/protocol';
import type { DaemonEvent } from '../../data/sync';
import { toolLabel } from '../../data/tool-calls';
import { currentLocale } from '../../i18n';
import { timeAxis } from '../../lib/time-axis';

export type TraceLaneView = ProjectTrace['lanes'][number];
export type TraceTurn = TraceLaneView['turns'][number];
export type TraceBucket = ProjectTrace['buckets'][number];
export type TraceSpan = SessionTrace['spans'][number];
export type HeatCommit = ProjectHeatmap['commits'][number];

export interface HeatCell {
  day: string;
  /** Model plus tool calls. */
  calls: number;
  /** 0 without calls, else the quartile of calls among all non-zero cells, 1 to 4. */
  level: 0 | 1 | 2 | 3 | 4;
  error: boolean;
  errors: number;
  commits: number;
}

export interface HourCell {
  /** Local hour, 0 to 23. */
  hour: number;
  calls: number;
  errors: number;
  level: HeatCell['level'];
}

export interface LaneAnalysis {
  tools: { name: string; count: number }[];
  files: { path: string; count: number }[];
  /** Newest first. */
  commits: HeatCommit[];
}

export interface TraceWindow {
  from: number;
  to: number;
}

export type TraceRow =
  | { kind: 'session'; key: string; lane: TraceLaneView; stats: TraceStats }
  | { kind: 'turn'; key: string; lane: TraceLaneView; turn: TraceTurn }
  | {
      kind: 'step';
      key: string;
      lane: TraceLaneView;
      turn: TraceTurn;
      span: TraceSpan;
      depth: number;
    };

/** The steps of the one turn whose rows are open, by the key of that turn's row. */
export interface TraceSteps {
  turnKey: string;
  spans: TraceSpan[];
}

export type TraceEventKind = 'approval' | 'gate' | 'merge' | 'plan' | 'model' | 'session';
/** Filter order. */
export const TRACE_EVENT_KINDS: readonly TraceEventKind[] = [
  'approval',
  'gate',
  'merge',
  'plan',
  'model',
  'session',
];

export type TraceEventWhat =
  | 'asked'
  | 'allowed'
  | 'allowed_session'
  | 'denied'
  | 'withdrawn'
  | 'gate_passed'
  | 'gate_failed'
  | 'merged'
  | 'merge_blocked'
  | 'planned'
  | 'dispatched'
  | 'question'
  | 'model_changed'
  | 'opened'
  | 'closed';

/** One row of the event table and the activity list. */
export interface TraceEvent {
  id: string;
  at: number;
  sessionId: string;
  kind: TraceEventKind;
  what: TraceEventWhat;
  /**
   * The tool asked for, the failed check, the merged commit, why a merge stopped, the plan's
   * headline, the lead's question or the model chosen.
   */
  detail: string | null;
  /** The key argument of the tool an approval asked for, such as its command. */
  input?: string | null;
  /** How long an approval or a lead's question waited for its answer; null while it waits. */
  waitedMs?: number | null;
  /** How the checks of a gate run went. */
  checks?: { passed: number; failed: number; skipped: number };
  /** How many tasks a plan holds. */
  tasks?: number;
  /** Lines a merge added and removed. */
  added?: number;
  removed?: number;
  /** Which of its session's gate runs this was, from 1. */
  run?: number;
}

export type TracePreset = '1h' | '24h' | '7d' | '30d';

export type ReplaySpeed = 1 | 4 | 16;

/** Height of one lane row, px. */
export const ROW_HEIGHT = 30;
/** Rows mounted beyond each edge of the viewport. */
const OVERSCAN = 8;
/** Idle stretches longer than this are cut from the trace axis. */
const IDLE_MS = 60_000;
/** Share of the window an idle stretch must pass to be cut. */
const GAP_SHARE = 0.05;
/** Shortest window zooming reaches. */
export const MIN_VIEW_MS = 60_000;
/** Deepest indent of a step row. */
const MAX_DEPTH = 2;
/** How long a replay at 1x takes to cross the whole view. */
export const REPLAY_MS = 60_000;

/**
 * A turn's interval clipped to the window; null when it has no start or lies outside. Without an
 * end, a running turn runs to the window's end and any other ends with its last segment.
 */
export function turnSpan(turn: TraceTurn, window: TraceWindow): [number, number] | null {
  if (turn.start === null) return null;
  const end =
    turn.end ??
    (turn.status === 'running'
      ? window.to
      : Math.max(turn.start, ...turn.segments.map((seg) => seg.to)));
  if (end < window.from || turn.start > window.to) return null;
  return [Math.max(turn.start, window.from), Math.min(end, window.to)];
}

/** A turn that failed or holds a failed step. */
const failed = (turn: TraceTurn) =>
  turn.status === 'error' || turn.segments.some((seg) => seg.kind === 'error');

/**
 * The lanes with only their turns in the window, emptied lanes dropped; a turn without a start
 * goes by its end, kept when that is unknown too. A cut lane recounts its turns and errors.
 */
export function windowLanes(trace: ProjectTrace, window: TraceWindow): ProjectTrace {
  const lanes = trace.lanes.flatMap((lane) => {
    const turns = lane.turns.filter((turn) =>
      turn.start === null
        ? turn.end === null || (turn.end >= window.from && turn.end <= window.to)
        : turnSpan(turn, window),
    );
    if (turns.length === lane.turns.length) return [lane];
    const stats = { ...lane.stats, turns: turns.length, error: turns.filter(failed).length };
    return turns.length ? [{ ...lane, stats, turns }] : [];
  });
  return { ...trace, lanes };
}

/**
 * The window's axis with idle stretches between the turns longer than a minute and than a
 * twentieth of the window cut to break marks, each carrying the length it cuts.
 */
export function traceAxis(trace: ProjectTrace, window: TraceWindow) {
  const busy = trace.lanes.flatMap((lane) =>
    lane.turns.flatMap((turn) => {
      const span = turnSpan(turn, window);
      return span ? [span] : [];
    }),
  );
  return timeAxis(
    busy,
    window.from,
    window.to,
    Math.max(IDLE_MS, (window.to - window.from) * GAP_SHARE),
  );
}

/**
 * A view as long as the current one, else a tenth of full and at least a minute, centred on at
 * and kept inside full; null at full.
 */
export function eventWindow(
  at: number,
  view: TraceWindow | null,
  full: TraceWindow,
): TraceWindow | null {
  const length = view ? view.to - view.from : Math.max(MIN_VIEW_MS, (full.to - full.from) / 10);
  if (length >= full.to - full.from) return null;
  const from = Math.min(full.to - length, Math.max(full.from, at - length / 2));
  return { from, to: from + length };
}

/** The event kinds the event table and the activity list show, by their filter. */
const EVENT_KIND: Record<string, TraceEventKind> = {
  'agent.permission.requested': 'approval',
  'agent.permission.resolved': 'approval',
  'session.gate_checked': 'gate',
  'session.merged': 'merge',
  'session.merge_blocked': 'merge',
  'board.plan_updated': 'plan',
  'task.dispatched': 'plan',
  'lead.question_asked': 'plan',
  'lead.question_answered': 'plan',
  'session.model_changed': 'model',
  'session.opened': 'session',
  'session.closed': 'session',
};

export const isTraceEvent = (event: Pick<DaemonEvent, 'kind'>): boolean =>
  Object.hasOwn(EVENT_KIND, event.kind);

const field = (payload: unknown, key: string): unknown =>
  payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[key] : undefined;
const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;
const count = (value: unknown): number | null => (typeof value === 'number' ? value : null);

type GateResult = { name?: unknown; exit_code?: unknown; timed_out?: unknown; skipped?: unknown };

/**
 * The events the trace lists, newest first; a plan only when its task count changed. An asked
 * approval or question carries how long it waited, and an approval's answer the tool and input.
 */
export function traceEvents(events: readonly DaemonEvent[]): TraceEvent[] {
  const rows: TraceEvent[] = [];
  const asked = new Map<string, TraceEvent>();
  const runs = new Map<string, number>();
  const planTasks = new Map<string, number>();
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    const kind = Object.hasOwn(EVENT_KIND, event.kind) ? EVENT_KIND[event.kind]! : null;
    if (!kind) continue;
    const p = event.payload;
    const sessionId = text(field(p, 'session_id')) ?? event.aggregate_id;
    const row = (what: TraceEventWhat, detail: string | null): TraceEvent => ({
      id: event.event_id,
      at: event.created_at,
      sessionId,
      kind,
      what,
      detail,
    });
    switch (event.kind) {
      case 'agent.permission.requested': {
        const tool = text(field(p, 'tool'));
        const input = tool ? toolLabel(tool, field(field(p, 'detail'), 'input')).detail : '';
        const next = { ...row('asked', tool), input: input || null, waitedMs: null };
        const request = text(field(p, 'request_id'));
        if (request) asked.set(`${sessionId}:${request}`, next);
        rows.push(next);
        break;
      }
      case 'agent.permission.resolved': {
        const request = asked.get(`${sessionId}:${text(field(p, 'request_id'))}`);
        if (request) request.waitedMs = event.created_at - request.at;
        const decision = field(p, 'decision');
        const what: TraceEventWhat =
          field(p, 'cancelled') === true
            ? 'withdrawn'
            : decision === 'allow'
              ? 'allowed'
              : decision === 'allow_session'
                ? 'allowed_session'
                : 'denied';
        rows.push({ ...row(what, request?.detail ?? null), input: request?.input ?? null });
        break;
      }
      case 'session.gate_checked': {
        const results = (
          Array.isArray(field(p, 'results')) ? field(p, 'results') : []
        ) as GateResult[];
        const failed = results.find(
          (r) => r.skipped !== true && (r.timed_out === true || r.exit_code !== 0),
        );
        const run = (runs.get(sessionId) ?? 0) + 1;
        runs.set(sessionId, run);
        const skipped = results.filter((r) => r.skipped === true).length;
        const failures = results.filter(
          (r) => r.skipped !== true && (r.timed_out === true || r.exit_code !== 0),
        ).length;
        rows.push({
          ...row(failed ? 'gate_failed' : 'gate_passed', failed ? text(failed.name) : null),
          run,
          checks: { passed: results.length - skipped - failures, failed: failures, skipped },
        });
        break;
      }
      case 'session.merged': {
        const sha = text(field(p, 'to_sha'));
        const added = count(field(p, 'additions'));
        const removed = count(field(p, 'deletions'));
        rows.push({
          ...row('merged', sha && sha.slice(0, 7)),
          ...(added !== null && removed !== null && { added, removed }),
        });
        break;
      }
      case 'session.merge_blocked':
        rows.push(row('merge_blocked', text(field(p, 'reason'))));
        break;
      case 'board.plan_updated': {
        const tasks = field(p, 'tasks');
        const n = Array.isArray(tasks) ? tasks.length : 0;
        if (n > 0 && planTasks.get(sessionId) !== n)
          rows.push({ ...row('planned', text(field(p, 'headline'))), tasks: n });
        planTasks.set(sessionId, n);
        break;
      }
      case 'task.dispatched':
        rows.push(row('dispatched', null));
        break;
      case 'lead.question_asked': {
        const next = { ...row('question', text(field(p, 'question'))), waitedMs: null };
        asked.set(`${sessionId}:question:${text(field(p, 'id'))}`, next);
        rows.push(next);
        break;
      }
      case 'lead.question_answered': {
        const question = asked.get(`${sessionId}:question:${text(field(p, 'id'))}`);
        if (question) question.waitedMs = event.created_at - question.at;
        break;
      }
      case 'session.model_changed':
        rows.push(row('model_changed', text(field(p, 'model'))));
        break;
      default:
        rows.push(row(event.kind === 'session.opened' ? 'opened' : 'closed', null));
    }
  }
  return rows.reverse();
}

/** A local YYYY-MM-DD day of an epoch-ms time. */
export function dayOf(at: number): string {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Newest-first rows by local day, the newest day first. */
export function eventDays(rows: readonly TraceEvent[]): { day: string; rows: TraceEvent[] }[] {
  const days: { day: string; rows: TraceEvent[] }[] = [];
  for (const row of rows) {
    const day = dayOf(row.at);
    const last = days.at(-1);
    if (last?.day === day) last.rows.push(row);
    else days.push({ day, rows: [row] });
  }
  return days;
}

/** A turn's steps without the turn span, by start with unstarted ones last, ties by id. */
export function stepRows(
  spans: readonly TraceSpan[],
  turnId: string,
): { span: TraceSpan; depth: number }[] {
  const steps = spans.filter((span) => span.kind !== 'turn');
  const byId = new Map(steps.map((span) => [span.id, span]));
  const depthOf = (span: TraceSpan) => {
    let depth = 0;
    for (let at = span; depth < MAX_DEPTH; depth++) {
      const parent = at.parent === null || at.parent === turnId ? undefined : byId.get(at.parent);
      if (!parent) break;
      at = parent;
    }
    return depth;
  };
  return steps
    .sort(
      (a, b) =>
        (a.start ?? Infinity) - (b.start ?? Infinity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .map((span) => ({ span, depth: depthOf(span) }));
}

/**
 * One row per lane in lane order, each open lane followed by one row per turn, and the turn
 * whose steps are given followed by one row per step.
 */
export function traceRows(
  trace: ProjectTrace,
  open: ReadonlySet<string>,
  steps: TraceSteps | null = null,
): TraceRow[] {
  return trace.lanes.flatMap((lane): TraceRow[] => {
    const key = lane.lane.key;
    const head: TraceRow = { kind: 'session', key, lane, stats: lane.stats };
    if (!open.has(key)) return [head];
    return [
      head,
      ...lane.turns.flatMap((turn): TraceRow[] => {
        const row: TraceRow = { kind: 'turn', key: `${key}/${turn.id}`, lane, turn };
        if (!steps || row.key !== steps.turnKey) return [row];
        return [
          row,
          ...stepRows(steps.spans, turn.id).map(({ span, depth }): TraceRow => ({
            kind: 'step',
            key: `${row.key}/${span.id}`,
            lane,
            turn,
            span,
            depth,
          })),
        ];
      }),
    ];
  });
}

/**
 * The view scaled by factor, kept between a minute and full, with the time at where it was on
 * the trace's axis; null at full.
 */
export function zoomWindow(
  view: TraceWindow,
  full: TraceWindow,
  at: number,
  factor: number,
  trace: ProjectTrace,
): TraceWindow | null {
  const fullLength = full.to - full.from;
  const next = Math.min(fullLength, Math.max(MIN_VIEW_MS, (view.to - view.from) * factor));
  if (next >= fullLength) return null;
  const share = traceAxis(trace, view).position(at);
  // Each window cuts its own idle stretches; at moves left on the axis as the window moves right.
  const placed = (from: number) => traceAxis(trace, { from, to: from + next }).position(at);
  let lo = full.from;
  let hi = full.to - next;
  if (placed(lo) <= share) hi = lo;
  else if (placed(hi) >= share) lo = hi;
  while (hi - lo > 0.01) {
    const mid = (lo + hi) / 2;
    if (placed(mid) > share) lo = mid;
    else hi = mid;
  }
  return { from: lo, to: lo + next };
}

/** A view framing [start, end] with a twentieth of its length each side, at least a minute, inside full; null at full. */
export function turnWindow(start: number, end: number, full: TraceWindow): TraceWindow | null {
  const length = Math.max(MIN_VIEW_MS, (end - start) * 1.1);
  if (length >= full.to - full.from) return null;
  const from = Math.min(full.to - length, Math.max(full.from, (start + end - length) / 2));
  return { from, to: from + length };
}

/** The view moved by deltaMs, stopped at the edges of full. */
export function panWindow(view: TraceWindow, full: TraceWindow, deltaMs: number): TraceWindow {
  const length = view.to - view.from;
  const from = Math.min(full.to - length, Math.max(full.from, view.from + deltaMs));
  return { from, to: from + length };
}

/** The playhead's share of the axis dtMs later; null once it reaches the end. */
export function replayStep(share: number, dtMs: number, speed: ReplaySpeed): number | null {
  const next = share + dtMs / (REPLAY_MS / speed);
  return next >= 1 ? null : next;
}

/** Start and bucket of a preset window up to now; the start holds still within a bucket. */
export function presetWindow(preset: TracePreset, now: number): { from: number; bucketMs: number } {
  const floor = (ms: number, step: number) => Math.floor(ms / step) * step;
  const daysBack = (days: number) => {
    const from = new Date(now);
    from.setHours(0, 0, 0, 0);
    from.setDate(from.getDate() - days);
    return from.getTime();
  };
  switch (preset) {
    case '1h':
      return { from: floor(now - 3_600_000, 60_000), bucketMs: 60_000 };
    case '24h':
      return { from: floor(now - 86_400_000, 900_000), bucketMs: 900_000 };
    case '7d':
      return { from: daysBack(6), bucketMs: 3_600_000 };
    case '30d':
      return { from: daysBack(29), bucketMs: 14_400_000 };
  }
}

/** The first and last row index to mount, both inclusive; last is below first when there are no rows. */
export function visibleWindow(
  count: number,
  scrollTop: number,
  viewportHeight: number,
): { first: number; last: number } {
  const first = Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN;
  const last = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) - 1 + OVERSCAN;
  return {
    first: Math.min(Math.max(0, first), Math.max(0, count - 1)),
    last: Math.max(-1, Math.min(count - 1, last)),
  };
}

/**
 * The turn that failed or holds a failed step and starts first across all lanes, else the first
 * lane that counts an error no turn shows (turnId null); null when none.
 */
export function firstError(trace: ProjectTrace): { laneKey: string; turnId: string | null } | null {
  let found: { laneKey: string; turnId: string; start: number } | null = null;
  for (const lane of trace.lanes)
    for (const turn of lane.turns) {
      if (!failed(turn)) continue;
      const start = turn.start ?? Infinity;
      if (!found || start < found.start) found = { laneKey: lane.lane.key, turnId: turn.id, start };
    }
  if (found) return { laneKey: found.laneKey, turnId: found.turnId };
  const lane = trace.lanes.find((lane) => lane.stats.error > 0);
  return lane ? { laneKey: lane.lane.key, turnId: null } : null;
}

/** Stacked llm and tool heights per bucket against the busiest bucket, and whether it has an error. */
export function stripBars(
  buckets: readonly TraceBucket[],
  maxHeight: number,
): { at: number; llm: number; tool: number; error: boolean }[] {
  const max = Math.max(0, ...buckets.map((b) => b.llm + b.tool));
  const scale = (n: number) => (max ? (n / max) * maxHeight : 0);
  return buckets.map((b) => ({
    at: b.at,
    llm: scale(b.llm),
    tool: scale(b.tool),
    error: b.error > 0,
  }));
}

/** The q-quantile of sorted values, interpolated between neighbours. */
const quantile = (sorted: readonly number[], q: number) => {
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  return sorted[low]! + (sorted[Math.min(low + 1, sorted.length - 1)]! - sorted[low]!) * (at - low);
};

/** A count's level: 0 for zero, else its quartile among the non-zero values, 1 to 4. */
export function levels(values: readonly number[]): (n: number) => HeatCell['level'] {
  const sorted = values.filter((n) => n > 0).sort((a, b) => a - b);
  const cuts = sorted.length ? [0.25, 0.5, 0.75].map((q) => quantile(sorted, q)) : [];
  return (n) => (n === 0 ? 0 : ((cuts.filter((cut) => n > cut).length + 1) as HeatCell['level']));
}

/** One row of day cells per lane with its call level, and the project's commits per day. */
export function heatCells(heatmap: ProjectHeatmap): {
  days: string[];
  lanes: { key: string; title: string; cells: HeatCell[] }[];
  commits: { day: string; count: number }[];
} {
  const level = levels(
    heatmap.lanes.flatMap((lane) => lane.cells.map((cell) => cell.llm + cell.tool)),
  );
  const lanes = heatmap.lanes.map((lane) => {
    const byDay = new Map(lane.cells.map((cell) => [cell.day, cell]));
    return {
      key: lane.key,
      title: lane.title,
      cells: heatmap.days.map((day): HeatCell => {
        const cell = byDay.get(day);
        const n = cell ? cell.llm + cell.tool : 0;
        return {
          day,
          calls: n,
          level: level(n),
          error: (cell?.error ?? 0) > 0,
          errors: cell?.error ?? 0,
          commits: cell?.commits ?? 0,
        };
      }),
    };
  });
  const perDay = new Map<string, number>();
  for (const commit of heatmap.commits) perDay.set(commit.day, (perDay.get(commit.day) ?? 0) + 1);
  return {
    days: heatmap.days,
    lanes,
    commits: heatmap.days.map((day) => ({ day, count: perDay.get(day) ?? 0 })),
  };
}

/** The project's 24 local hours per day with their call level across all days. */
export function hourCells(heatmap: ProjectHeatmap): {
  days: string[];
  hours: { day: string; cells: HourCell[] }[];
} {
  const level = levels(heatmap.hours.flatMap((day) => day.calls));
  return {
    days: heatmap.days,
    hours: heatmap.hours.map((day) => ({
      day: day.day,
      cells: Array.from({ length: 24 }, (_, hour): HourCell => {
        const calls = day.calls[hour] ?? 0;
        return { hour, calls, errors: day.errors[hour] ?? 0, level: level(calls) };
      }),
    })),
  };
}

/** The keys counted most often, ties by key ascending. */
const top = (counts: Map<string, number>, n: number) =>
  [...counts].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0)).slice(0, n);

const bump = (counts: Map<string, number>, key: string) =>
  counts.set(key, (counts.get(key) ?? 0) + 1);

/** A lane's busiest tools and files and its commits. */
export function laneAnalysis(
  spans: readonly TraceSpan[],
  commits: readonly HeatCommit[],
  laneKey: string,
): LaneAnalysis {
  const turns = new Set(spans.filter((span) => span.kind === 'turn').map((span) => span.id));
  const tools = new Map<string, number>();
  const files = new Map<string, number>();
  for (const span of spans) {
    // Steps a Codex call runs hang under that call, not under the turn.
    if (
      (span.kind === 'tool' || span.kind === 'subagent') &&
      (span.parent === null || turns.has(span.parent))
    )
      bump(tools, span.name);
    for (const path of span.files ?? []) bump(files, path);
  }
  return {
    tools: top(tools, 5).map(([name, count]) => ({ name, count })),
    files: top(files, 10).map(([path, count]) => ({ path, count })),
    commits: commits
      .filter((commit) => commit.lane_key === laneKey)
      .sort((a, b) => b.at - a.at || (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0)),
  };
}

/** Totals over one lane's spans like the project trace's, a running turn ending at now. */
export function laneStats(spans: readonly TraceSpan[], now: number): TraceStats {
  const turns = spans.filter((span) => span.kind === 'turn');
  const steps = spans.filter((span) => span.kind !== 'turn');
  const stats: TraceStats = {
    sessions: 1,
    turns: turns.length,
    llm: steps.filter((span) => span.kind === 'llm').length,
    tool: steps.filter((span) => span.kind === 'tool' || span.kind === 'subagent').length,
    error: spans.filter((span) => span.status === 'error').length,
    tokens: { input: 0, output: 0 },
    active_ms: 0,
    commits: steps.filter((span) => span.commit).length,
  };
  for (const turn of turns) {
    const own = turn.tokens
      ? [turn.tokens]
      : steps.flatMap((span) =>
          span.turn === turn.id && span.kind === 'llm' && span.tokens ? [span.tokens] : [],
        );
    for (const tokens of own) {
      stats.tokens.input += tokens.input;
      stats.tokens.output += tokens.output;
    }
  }
  const intervals = turns
    .flatMap((turn) => {
      const end = turn.end ?? (turn.status === 'running' ? now : null);
      return turn.start === null || end === null ? [] : [[turn.start, end] as const];
    })
    .filter(([a, b]) => a < b)
    .sort((a, b) => a[0] - b[0]);
  let reached = -Infinity;
  for (const [a, b] of intervals) {
    const start = Math.max(a, reached);
    if (b > start) stats.active_ms += b - start;
    reached = Math.max(reached, b);
  }
  return stats;
}

/** Local midnight of a YYYY-MM-DD day to the next midnight, epoch ms. */
export function dayWindow(day: string): TraceWindow {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return { from: new Date(y, m - 1, d).getTime(), to: new Date(y, m - 1, d + 1).getTime() };
}

/** A local hour of a YYYY-MM-DD day to the next hour, epoch ms. */
export function hourWindow(day: string, hour: number): TraceWindow {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return {
    from: new Date(y, m - 1, d, hour).getTime(),
    to: new Date(y, m - 1, d, hour + 1).getTime(),
  };
}

/** A heatmap column head: the day of the month, with the month on the first. */
export function dayLabel(day: string): string {
  const [, , d] = day.split('-').map(Number) as [number, number, number];
  return d === 1 ? dayName(day) : String(d);
}

/** A local day for screen readers, such as 11月11日 or Nov 11. */
export function dayName(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(currentLocale(), { month: 'short', day: 'numeric' }).format(
    new Date(y, m - 1, d),
  );
}
