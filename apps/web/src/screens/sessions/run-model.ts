import { contextShare } from '../../data/logs';
import type { ToolItem, TurnView } from '../../data/transcript';
import { BREAK_SHARE, timeAxis } from '../../lib/time-axis';
import { t } from '../../i18n';

export type RunTone = 'ok' | 'bad' | 'idle' | 'run' | 'wait';

/** The colour of a turn: by its end, else running, or waiting while queued or asking. */
export function turnTone(view: TurnView): RunTone {
  const state = view.end?.state ?? view.turn.state;
  if (state === 'completed') return 'ok';
  if (state === 'failed') return 'bad';
  if (state === 'queued') return 'wait';
  if (state === 'running')
    return view.items.some((item) => item.kind === 'request' && !item.outcome) ? 'wait' : 'run';
  return 'idle';
}

export interface PackSpan {
  id: string;
  parent?: string;
  from: number;
  to: number;
}

/**
 * The sub-row of each span, in input order: overlapping spans take different rows, and a span
 * with a parent among them takes a row below its parent's.
 */
export function packRows(spans: readonly PackSpan[]): number[] {
  const index = new Map(spans.map((span, i) => [span.id, i]));
  const parentOf = (i: number) => {
    const j = index.get(spans[i]!.parent ?? '');
    return j === undefined || j === i ? undefined : j;
  };
  const depth = (i: number): number => {
    let d = 0;
    for (let j = parentOf(i); j !== undefined && d < spans.length; j = parentOf(j)) d++;
    return d;
  };
  const order = spans
    .map((_, i) => i)
    .sort((a, b) => depth(a) - depth(b) || spans[a]!.from - spans[b]!.from);
  const taken: PackSpan[][] = [];
  const rows = new Array<number>(spans.length).fill(0);
  for (const i of order) {
    const span = spans[i]!;
    const parent = parentOf(i);
    let row = parent === undefined ? 0 : rows[parent]! + 1;
    while (taken[row]?.some((o) => span.from < o.to && o.from < span.to)) row++;
    (taken[row] ??= []).push(span);
    rows[i] = row;
  }
  return rows;
}

export interface RunSpan {
  id: string;
  name: string;
  row: number;
  from: number;
  to: number;
  /** A missing start or completion: drawn hatched over the time it may have taken. */
  unknown: boolean;
  ok: boolean | undefined;
}

export interface RunLane {
  id: string;
  tone: RunTone;
  from: number;
  to: number;
  unknown: boolean;
  /** Sub-rows of tool spans. */
  rows: number;
  spans: RunSpan[];
}

/** An idle stretch cut out of the axis, drawn as a break mark `BREAK_SHARE` wide. */
export interface AxisBreak {
  /** Share of the axis where the mark starts. */
  at: number;
  /** The idle time it stands for. */
  ms: number;
}

export interface RunWaterfall {
  from: number;
  to: number;
  lanes: RunLane[];
  breaks: AxisBreak[];
  /** Share of the axis, 0 to 1, where a time sits. */
  position: (t: number) => number;
}

/** Narrowest span as a share of the axis; spans are packed at least this wide. */
export const MIN_SHARE = 0.01;
/** Idle stretches between turns longer than this are cut from the axis. */
export const GAP_MS = 5 * 60_000;
export { BREAK_SHARE };

const known = (values: (number | null | undefined)[]) =>
  values.filter((v): v is number => typeof v === 'number');

/** One lane per turn with its tool spans on a time axis shared by all turns. */
export function runWaterfall(turns: readonly TurnView[], now: number): RunWaterfall {
  const parts = turns.map((view) => {
    const tone = turnTone(view);
    const live = !view.end && (tone === 'run' || tone === 'wait');
    const tools = view.items.filter((item): item is ToolItem => item.kind === 'tool');
    const times = known(tools.flatMap((t) => [t.started_at, t.completed_at]));
    return {
      view,
      tone,
      tools,
      times,
      start: view.started_at ?? view.at,
      end: view.ended_at ?? (live ? now : null),
    };
  });
  const starts = known(parts.flatMap((p) => [p.start, ...p.times]));
  const ends = known(parts.flatMap((p) => [p.end, ...p.times]));
  const from = starts.length ? Math.min(...starts) : ends.length ? Math.min(...ends) : now;
  const to = Math.max(from, ...starts, ...ends);

  const timed = parts.map(({ view, tone, tools, times, start, end }) => {
    const laneFrom = start ?? (times.length ? Math.min(...times) : from);
    const laneTo = Math.max(laneFrom, end ?? (times.length ? Math.max(...times) : to));
    const placed = tools.map((t) => {
      const spanFrom = t.started_at ?? laneFrom;
      return {
        id: t.id,
        parent: t.parent,
        name: t.name,
        ok: t.ok,
        unknown: t.started_at === undefined || t.completed_at === undefined,
        from: spanFrom,
        to: Math.max(spanFrom, t.completed_at ?? laneTo),
      };
    });
    return { view, tone, start, end, laneFrom, laneTo, placed };
  });
  const axis = timeAxis(
    timed.flatMap(({ laneFrom, laneTo, placed }) => [
      [laneFrom, laneTo] as [number, number],
      ...placed.map((s) => [s.from, s.to] as [number, number]),
    ]),
    from,
    to,
    GAP_MS,
  );
  const min = MIN_SHARE / axis.unit;

  const lanes = timed.map(({ view, tone, start, end, laneFrom, laneTo, placed }): RunLane => {
    const rows = packRows(placed.map((s) => ({ ...s, to: Math.max(s.to, s.from + min) })));
    return {
      id: view.turn.id,
      tone,
      from: laneFrom,
      to: laneTo,
      unknown: start === null || end === null,
      rows: placed.length ? Math.max(...rows) + 1 : 0,
      spans: placed.map(({ id, name, ok, unknown, from, to }, i) => ({
        id,
        name,
        ok,
        unknown,
        from,
        to,
        row: rows[i]!,
      })),
    };
  });
  return { from, to, lanes, breaks: axis.breaks, position: axis.position };
}

/** The result of a tool call as the trace words it. */
export function callResult(ok: boolean | undefined): string {
  return ok === undefined
    ? t({ id: 'sessions.run.call.unfinished', defaultMessage: 'Not finished' })
    : ok
      ? t({ id: 'sessions.run.call.ok', defaultMessage: 'Succeeded' })
      : t({ id: 'sessions.run.call.failed', defaultMessage: 'Failed' });
}

/** Bar heights of the buckets against the largest one; all zero when every bucket is empty. */
export function sparkBars(
  values: readonly number[],
  height: number,
): { max: number; heights: number[] } {
  const max = Math.max(0, ...values);
  return { max, heights: values.map((v) => (max ? (v / max) * height : 0)) };
}

export type RingTone = 'none' | 'ac2' | 'wait' | 'bad';

export function ringTone(ratio: number | null): RingTone {
  if (ratio === null) return 'none';
  if (ratio >= 0.95) return 'bad';
  if (ratio >= 0.8) return 'wait';
  return 'ac2';
}

export interface RingView {
  tone: RingTone;
  /** Share of the ring to fill, capped at 1. */
  sweep: number;
  text: string;
  used: number | null;
  window: number | null;
}

/** Context occupancy of a usage payload as a ring; 未知 without a context window. */
export function contextRing(usage: unknown): RingView {
  const share = contextShare(usage);
  const ratio = share?.ratio ?? null;
  return {
    tone: ringTone(ratio),
    sweep: ratio === null ? 0 : Math.min(ratio, 1),
    text:
      ratio === null
        ? t({ id: 'sessions.run.unknown', defaultMessage: 'Unknown' })
        : `${Math.round(ratio * 100)}%`,
    used: share?.used ?? null,
    window: share?.window ?? null,
  };
}
