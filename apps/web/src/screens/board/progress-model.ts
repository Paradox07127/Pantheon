import type { BoardModel } from '@pantheon/protocol';
import { t } from '../../i18n';
import { durationText, type BoardTask } from './panels-model';

type TaskProgress = BoardModel['task_progress'];

/* Task completion bar */

export type TotalKey = keyof TaskProgress['totals'];

// Getters, so each label is read in the language loaded by then.
export const TOTAL_LABEL: Record<TotalKey, string> = {
  get done() {
    return t({ id: 'board.taskTotals.done', defaultMessage: 'Done' });
  },
  get running() {
    return t({ id: 'board.taskTotals.running', defaultMessage: 'In progress' });
  },
  get waiting() {
    return t({ id: 'board.taskTotals.waiting', defaultMessage: 'Waiting' });
  },
  get idle() {
    return t({ id: 'board.taskTotals.idle', defaultMessage: 'Idle' });
  },
  get ready() {
    return t({ id: 'board.taskTotals.ready', defaultMessage: 'Ready to merge' });
  },
  get failed() {
    return t({ id: 'board.taskTotals.failed', defaultMessage: 'Failed' });
  },
  get discarded() {
    return t({ id: 'board.taskTotals.discarded', defaultMessage: 'Discarded' });
  },
  get not_started() {
    return t({ id: 'board.taskTotals.notStarted', defaultMessage: 'Not started' });
  },
};

/* Banner progress strip */

const BANNER_KEYS = ['done', 'running', 'waiting', 'failed'] as const;
type BannerKey = (typeof BANNER_KEYS)[number] | 'other';
const BANNER_MAX = 4;

export interface BannerSegment {
  key: BannerKey;
  label: string;
  count: number;
}

/**
 * The nonzero totals as at most four parts: done, running, waiting and failed, the other states
 * as 其他; with five parts the smallest open state joins 其他.
 */
export function bannerSegments(totals: TaskProgress['totals']): BannerSegment[] {
  const parts: BannerSegment[] = BANNER_KEYS.map((key) => ({
    key,
    label: TOTAL_LABEL[key],
    count: totals[key],
  }));
  let other = totals.idle + totals.ready + totals.discarded + totals.not_started;
  let shown = parts.filter((p) => p.count > 0);
  while (shown.length + (other > 0 ? 1 : 0) > BANNER_MAX) {
    const smallest = shown
      .filter((p) => p.key !== 'done')
      .reduce((a, b) => (b.count < a.count ? b : a));
    other += smallest.count;
    shown = shown.filter((p) => p !== smallest);
  }
  return other > 0
    ? [
        ...shown,
        {
          key: 'other',
          label: t({ id: 'board.taskTotals.other', defaultMessage: 'Other' }),
          count: other,
        },
      ]
    : shown;
}

/* Task burn-up */

export interface BurnupPoint {
  index: number;
  value: number;
}
export interface ScopeTick {
  index: number;
  added: number;
  removed: number;
  title: string;
}
export interface BurnupPoints {
  /** One per day. */
  done: number[];
  /** Runs of consecutive days that have a scope. */
  scope: BurnupPoint[][];
  /** Days where tasks joined or left the plan. */
  ticks: ScopeTick[];
  max: number;
}

export function burnupPoints(daily: TaskProgress['daily']): BurnupPoints {
  const scope: BurnupPoint[][] = [];
  const ticks: ScopeTick[] = [];
  daily.forEach((d, index) => {
    if (d.scope != null) {
      const run = scope.at(-1);
      if (run && run.at(-1)!.index === index - 1) run.push({ index, value: d.scope });
      else scope.push([{ index, value: d.scope }]);
    }
    const added = d.added ?? 0;
    const removed = d.removed ?? 0;
    if (added > 0 || removed > 0)
      ticks.push({ index, added, removed, title: `+${added} / −${removed}` });
  });
  const max = Math.max(0, ...daily.map((d) => Math.max(d.done, d.scope ?? 0)));
  return { done: daily.map((d) => d.done), scope, ticks, max };
}

/* Cycle time histogram */

export interface HistogramBar {
  label: string;
  count: number;
  /** Fraction of the tallest bar. */
  height: number;
}
export interface HistogramMarker {
  /** In bucket widths from the left edge: bucket k spans [k, k + 1). */
  at: number;
  label: string;
}

function markerAt(buckets: TaskProgress['cycle']['buckets'], ms: number): number {
  let lower = 0;
  for (const [k, bucket] of buckets.entries()) {
    if (bucket.upper_ms == null) return k + 0.5;
    if (ms <= bucket.upper_ms) return k + (ms - lower) / (bucket.upper_ms - lower);
    lower = bucket.upper_ms;
  }
  return buckets.length;
}

export function cycleHistogram(cycle: TaskProgress['cycle']) {
  const tallest = Math.max(0, ...cycle.buckets.map((b) => b.count));
  const bars: HistogramBar[] = cycle.buckets.map((b, k) => ({
    label:
      b.upper_ms == null
        ? `> ${durationText(cycle.buckets[k - 1]?.upper_ms ?? 0)}`
        : durationText(b.upper_ms),
    count: b.count,
    height: tallest ? b.count / tallest : 0,
  }));
  const marker = (ms: number | null, name: string): HistogramMarker | null =>
    ms == null ? null : { at: markerAt(cycle.buckets, ms), label: `${name} ${durationText(ms)}` };
  return {
    bars,
    median: marker(cycle.median_ms, t({ id: 'board.cycle.median', defaultMessage: 'Median' })),
    p90: marker(cycle.p90_ms, 'p90'),
  };
}

/* Blocked and stalled tasks */

/** A turn without a progress event or a tool call under way for this long is stalled, as the tracker judges it. */
export const STALL_MS = 10 * 60_000;

export interface StallRow {
  task: BoardTask;
  kind: 'blocked' | 'stalled';
  /** Since blocked_since or last_progress_at. */
  ms: number;
  /** Fraction of the longest row. */
  share: number;
}

/**
 * Blocked tasks, and tasks whose turn the tracker marked stalled or that has gone STALL_MS without
 * progress or a tool call under way since the board was read; longest first.
 */
export function stallRows(model: Pick<BoardModel, 'tasks' | 'now'>): StallRow[] {
  const rows = model.tasks.flatMap((task): Omit<StallRow, 'share'>[] => {
    if (task.blocked_since != null)
      return [{ task, kind: 'blocked', ms: model.now - task.blocked_since }];
    const a = task.activity;
    const last = task.last_progress_at;
    if (a?.health === 'stalled')
      return [{ task, kind: 'stalled', ms: model.now - (last ?? a.since) }];
    if (task.turn_running && !a?.tool && last != null && model.now - last > STALL_MS)
      return [{ task, kind: 'stalled', ms: model.now - last }];
    return [];
  });
  const longest = Math.max(0, ...rows.map((r) => r.ms));
  return rows
    .sort((a, b) => b.ms - a.ms)
    .map((r) => ({ ...r, share: longest ? r.ms / longest : 0 }));
}

/* Chart labels */

/** A YYYY-MM-DD day as the axis shows it. */
export const dayTick = (day: string) => day.slice(5);

// Estimated rendered width at --fs-xs: CJK glyphs about 12px, others about 7px.
const labelWidth = (text: string) =>
  [...text].reduce((w, c) => w + (/[　-鿿]/.test(c) ? 12 : 7), 0);

/**
 * Marker labels start right of their line unless that would pass `right`; a label that would
 * overlap the one before it on the same row drops to the next row.
 */
export function markerPlacement(
  markers: readonly { x: number; label: string }[],
  right: number,
): { anchor: 'start' | 'end'; row: number }[] {
  const ends: number[] = [];
  return markers.map(({ x, label }) => {
    const w = labelWidth(label) + 4;
    const anchor = x + w > right ? 'end' : 'start';
    const from = anchor === 'start' ? x : x - w;
    let row = 0;
    while ((ends[row] ?? -Infinity) > from) row++;
    ends[row] = from + w;
    return { anchor, row };
  });
}
