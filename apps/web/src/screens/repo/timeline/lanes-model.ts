import type { RepoLane, RepoTimeline } from '@pantheon/protocol';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

export type TimelineZoom = 'quarter' | 'fortnight' | 'today';
export type TimelineGroup = 'workstream' | 'branch' | 'author';

/** How long each zoom's range is and what its lanes are grouped by until a grouping is picked. */
export const ZOOMS: Record<TimelineZoom, { span: number; group: TimelineGroup }> = {
  quarter: { span: 90 * DAY, group: 'workstream' },
  fortnight: { span: 14 * DAY, group: 'workstream' },
  today: { span: 4 * HOUR, group: 'branch' },
};

/** The stored zoom; anything else is two weeks. */
export const readTimelineZoom = (raw: string | null): TimelineZoom =>
  raw === 'quarter' || raw === 'today' ? raw : 'fortnight';

/** The stored grouping; null when none was picked, so the zoom's grouping applies. */
export const readTimelineGroup = (raw: string | null): TimelineGroup | null =>
  raw === 'workstream' || raw === 'branch' || raw === 'author' ? raw : null;

/** The longest range repo.timeline reads. */
const MAX_RANGE = 400 * DAY;

/** The range from the history's first commit through its last, cut to the longest range ending at the last. */
export function fittedRange(extent: { first: number; last: number }) {
  const to = extent.last + 1;
  return { from: Math.max(extent.first, to - MAX_RANGE), to };
}

/** Rows one lane stacks its spans on; spans that fit on none are counted, not drawn. */
export const SPAN_ROWS = 3;
/** Share of the track under which a span shows no name. */
export const NAMED_SHARE = 0.07;

export type LaneSpan = RepoLane['spans'][number];

/** Each span on the first row free at its start, oldest first. */
export function stackSpans(spans: readonly LaneSpan[], to: number) {
  const ends: number[] = [];
  const placed: { span: LaneSpan; row: number }[] = [];
  let hidden = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const free = ends.findIndex((end) => end <= span.start);
    const row = free >= 0 ? free : ends.length;
    if (row >= SPAN_ROWS) {
      hidden++;
      continue;
    }
    ends[row] = span.end ?? to;
    placed.push({ span, row });
  }
  return { placed, rows: ends.length, hidden };
}

/** Top of each band of a lane's track, in px; null for a band the lane has nothing in. */
export function laneBands(lane: RepoLane, spanRows: number) {
  let y = 8;
  const band = (present: boolean, height: number) => {
    if (!present) return null;
    const top = y;
    y += height;
    return top;
  };
  const turns = band(!!lane.turns?.length, 12);
  const spans = band(spanRows > 0, spanRows * 20);
  const points = band(!!lane.points?.length, 12);
  const gates = band(lane.gates.length > 0, 12);
  const bins = band(!!lane.bins?.length, 32);
  return { turns, spans, points, gates, bins, height: Math.max(44, y + 4) };
}

/** Where a time falls along [from, to), from 0 to 1. */
export const share = (at: number, from: number, to: number) =>
  Math.min(1, Math.max(0, (at - from) / Math.max(1, to - from)));

/** Axis ticks: hours over a day or less, every other midnight up to a month, else month starts. */
export function axisTicks(from: number, to: number) {
  const span = to - from;
  const unit = span <= DAY ? 'hour' : span <= 31 * DAY ? 'day' : 'month';
  const d = new Date(from);
  if (unit === 'hour') d.setMinutes(0, 0, 0);
  else d.setHours(0, 0, 0, 0);
  if (unit === 'month') d.setDate(1);
  const step = () => {
    if (unit === 'hour') d.setHours(d.getHours() + 1);
    else if (unit === 'day') d.setDate(d.getDate() + 2);
    else d.setMonth(d.getMonth() + 1);
  };
  while (d.getTime() < from) step();
  const at: number[] = [];
  for (; d.getTime() < to; step()) at.push(d.getTime());
  return { unit, at } as const;
}

/** The time span the overview strip covers: the whole history up to now and the range. */
export function overviewDomain(
  overview: RepoTimeline['overview'],
  from: number,
  to: number,
  now: number,
) {
  const last = overview.at(-1);
  return {
    lo: Math.min(overview[0]?.start ?? from, from),
    hi: Math.max(now, to, last ? last.start + WEEK : to),
  };
}

/** The range's end moved by `by` ms, kept inside the domain. */
export const shiftedEnd = (
  end: number,
  span: number,
  by: number,
  domain: { lo: number; hi: number },
) => Math.min(domain.hi, Math.max(domain.lo + span, end + by));
