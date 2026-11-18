import type { VisualContent } from '@pantheon/domain';
import { currentLocale } from '../../i18n';

export type TimelineSpec = Extract<VisualContent, { kind: 'timeline' }>['spec'];
export type TimelineItem = TimelineSpec['items'][number];

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface TextLine {
  x: number;
  y: number;
  text: string;
  anchor: 'start' | 'middle' | 'end';
}
export interface LaidLane {
  id: string;
  label: TextLine;
  y: number;
  height: number;
}
export interface LaidEvent {
  item: TimelineItem;
  /** The series colour, 1-6; 0 for an item outside every declared group. */
  series: number;
  x: number;
  y: number;
  title: TextLine;
  lines: TextLine[];
  /** The title, point and detail together; no two events' boxes meet. */
  box: Box;
  at: string;
}
export interface LaidSpan {
  item: TimelineItem;
  series: number;
  depth: number;
  /** The row's top. */
  y: number;
  bar: Box;
  label: TextLine;
  /** Inside the bar's end where the label would leave the drawing beside it. */
  duration: TextLine & { inside: boolean };
  box: Box;
  from: string;
  to: string;
  length: string;
}
export interface TimelineLayout {
  width: number;
  height: number;
  plot: { left: number; right: number; top: number; bottom: number };
  /** The axis reads a clock in `zone`, or ms or s from 0. */
  axis: { unit: 'time' | 'ms' | 's'; zone?: string; y: number };
  ticks: { x: number; label: string; width: number }[];
  lanes: LaidLane[];
  events: LaidEvent[];
  spans: LaidSpan[];
  legend: { id: string; label: string; series: number; count: number }[];
  range: { from: string; to: string };
}

/** Room around the drawing. */
export const PAD = 16;
const LINE = 16;
const ROW_GAP = 8;
const LANE_PAD = 8;
const BAR = 24;
const BAR_ROW = 32;
const INDENT = 16;
const TITLE_MAX = 240;
const DETAIL_MAX = 176;
const LABEL_MAX = 200;
const TICK_GAP = 8;
const MAX_TICKS = 8;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const CLOCK_STEPS = [
  ...[1, 2, 5, 10, 15, 30].map((n) => n * SECOND),
  ...[1, 2, 5, 10, 15, 30].map((n) => n * MINUTE),
  ...[1, 2, 3, 6, 12].map((n) => n * HOUR),
  ...[1, 2, 7, 14, 30, 91, 365, 730, 1825, 3650].map((n) => n * DAY),
];

/** Estimated advance of 12px text: wide (CJK) characters take a full em. */
const charWidth = (c: string, narrow: number) => (c.charCodeAt(0) > 0x2e7f ? 12 : narrow);
const textWidth = (text: string, narrow = 6.8): number =>
  [...text].reduce((width, c) => width + charWidth(c, narrow), 0);
const digitsWidth = (text: string) => textWidth(text, 7.2);

/** The text cut with an ellipsis to fit `max`. */
function fit(text: string, max: number): string {
  if (textWidth(text) <= max) return text;
  const chars = [...text];
  let width = textWidth('…');
  let end = 0;
  while (end < chars.length && width + charWidth(chars[end]!, 6.8) <= max)
    width += charWidth(chars[end++]!, 6.8);
  return `${chars.slice(0, end).join('').trimEnd()}…`;
}

/** At most `count` lines of `max` px, broken at spaces where it can; the last line is cut. */
function wrap(text: string, max: number, count: number): string[] {
  const lines: string[] = [];
  let rest = text.trim().replace(/\s+/g, ' ');
  while (rest) {
    if (textWidth(rest) <= max || lines.length === count - 1) {
      lines.push(fit(rest, max));
      break;
    }
    const chars = [...rest];
    let end = 0;
    let width = 0;
    while (end < chars.length && width + charWidth(chars[end]!, 6.8) <= max)
      width += charWidth(chars[end++]!, 6.8);
    let cut = end;
    if (chars[end] !== ' ') {
      const space = chars.lastIndexOf(' ', end - 1);
      if (space > 0) cut = space;
    }
    lines.push(chars.slice(0, Math.max(cut, 1)).join('').trimEnd());
    rest = chars.slice(Math.max(cut, 1)).join('').trimStart();
  }
  return lines;
}

const timeValue = (time: string | number): number =>
  typeof time === 'number' ? time : Date.parse(time);

/** How far the wall clock of `zone`, else of this machine, is ahead of UTC at `at`. */
function zoneOffset(at: number, zone: string | undefined): number {
  if (zone === undefined) return -new Date(at).getTimezoneOffset() * MINUTE;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  return wall - Math.floor(at / SECOND) * SECOND;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Tick labels of a clock axis in wall-clock ms, formatted to the step. */
function clockLabels(walls: number[], step: number): string[] {
  const days = new Set(walls.map((wall) => Math.floor(wall / DAY))).size > 1;
  const date = new Intl.DateTimeFormat(
    currentLocale(),
    step >= 30 * DAY
      ? { timeZone: 'UTC', year: 'numeric', month: 'short' }
      : { timeZone: 'UTC', month: 'short', day: 'numeric' },
  );
  return walls.map((wall) => {
    const at = new Date(wall);
    const clock =
      `${pad2(at.getUTCHours())}:${pad2(at.getUTCMinutes())}` +
      (step < MINUTE ? `:${pad2(at.getUTCSeconds())}` : '');
    if (step >= DAY || (days && wall % DAY === 0)) return date.format(wall);
    return days ? `${date.format(wall)} ${clock}` : clock;
  });
}

const numberText = (value: number) =>
  new Intl.NumberFormat(currentLocale(), { maximumFractionDigits: 3, useGrouping: false }).format(
    value,
  );

/** A length of time in the largest unit that keeps it at one or more. */
function durationText(ms: number): string {
  const [unit, size] =
    ms < SECOND
      ? (['millisecond', 1] as const)
      : ms < MINUTE
        ? (['second', SECOND] as const)
        : ms < HOUR
          ? (['minute', MINUTE] as const)
          : ms < DAY
            ? (['hour', HOUR] as const)
            : (['day', DAY] as const);
  return new Intl.NumberFormat(currentLocale(), {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    maximumFractionDigits: 1,
    useGrouping: false,
  }).format(ms / size);
}

/** Steps to try for a span of `span`, smallest first. */
function steps(unit: 'time' | 'ms', span: number): number[] {
  if (unit === 'time') return CLOCK_STEPS;
  const from = Math.floor(Math.log10(span / MAX_TICKS)) - 1;
  return Array.from({ length: 8 }, (_, k) => 10 ** (from + k)).flatMap((base) =>
    [1, 2, 5].map((n) => n * base),
  );
}

/**
 * The ticks for the domain: the smallest nice step whose labels keep `TICK_GAP` apart across
 * `width`, with at most `MAX_TICKS` of them. The domain grows to the outer ticks.
 */
function pickTicks(
  unit: 'time' | 'ms',
  min: number,
  max: number,
  width: number,
  label: (values: number[], step: number) => string[],
) {
  let chosen: { lo: number; hi: number; step: number; labels: string[] } | undefined;
  for (const step of steps(unit, max - min)) {
    const lo = Math.floor(min / step) * step;
    const hi = Math.max(Math.ceil(max / step) * step, lo + step);
    const count = Math.round((hi - lo) / step) + 1;
    if (count > MAX_TICKS) continue;
    const values = Array.from({ length: count }, (_, i) => lo + i * step);
    const labels = label(values, step);
    chosen = { lo, hi, step, labels };
    const widest = Math.max(...labels.map(digitsWidth));
    if (width / (count - 1) >= widest + TICK_GAP) break;
  }
  return chosen ?? { lo: min, hi: max, step: max - min, labels: label([min, max], max - min) };
}

/** The series colour of each group, in declared order, from the six series tokens. */
const seriesOf = (spec: TimelineSpec) => {
  const index = new Map(spec.groups?.map((group, i) => [group.id, (i % 6) + 1]));
  return (item: TimelineItem) =>
    item.group !== undefined ? (index.get(item.group) ?? 0) : spec.groups?.length ? 0 : 1;
};

/** Lays events out in lanes above, spans as a waterfall below, on one axis across `width`. */
export function layoutTimeline(spec: TimelineSpec, width: number): TimelineLayout {
  const unit =
    spec.unit ??
    (spec.items.some((item) => typeof item.at === 'string' || typeof item.end === 'string')
      ? 'time'
      : 'ms');
  const zone = unit === 'time' ? spec.timezone : undefined;
  const series = seriesOf(spec);
  const events = spec.items.filter((item) => item.end === undefined);
  const spanItems = spec.items.filter((item) => item.end !== undefined);

  // Spans in rows: each one's children follow it, siblings by start.
  const order = new Map(spec.items.map((item, i) => [item.id, i]));
  const byStart = (a: TimelineItem, b: TimelineItem) =>
    timeValue(a.at) - timeValue(b.at) || order.get(a.id)! - order.get(b.id)!;
  const spanIds = new Set(spanItems.map((item) => item.id));
  const children = new Map<string | undefined, TimelineItem[]>();
  for (const item of spanItems) {
    const parent = item.parent !== undefined && spanIds.has(item.parent) ? item.parent : undefined;
    children.set(parent, [...(children.get(parent) ?? []), item]);
  }
  const rows: { item: TimelineItem; depth: number }[] = [];
  const visit = (parent: string | undefined, depth: number) => {
    for (const item of (children.get(parent) ?? []).sort(byStart)) {
      rows.push({ item, depth });
      visit(item.id, depth + 1);
    }
  };
  visit(undefined, 0);

  // Lanes that hold events, in declared order, then one for events without a lane.
  const declared = spec.lanes ?? [];
  const laneOf = (item: TimelineItem) =>
    item.lane !== undefined && declared.some((lane) => lane.id === item.lane) ? item.lane : '';
  const laneList = [
    ...declared.filter((lane) => events.some((item) => laneOf(item) === lane.id)),
    ...(events.some((item) => laneOf(item) === '') ? [{ id: '', label: '' }] : []),
  ];

  const labelColumn = Math.min(
    LABEL_MAX,
    Math.max(
      0,
      ...laneList.map((lane) => textWidth(lane.label)),
      ...rows.map(({ item, depth }) => textWidth(item.label) + depth * INDENT),
    ),
  );
  const gutter = PAD + (labelColumn > 0 ? labelColumn + 16 : 0);
  const plot = { left: gutter + 8, right: Math.max(gutter + 48, width - PAD - 24) };

  // The domain: every instant, start and end; durations from 0.
  const values = spec.items.flatMap((item) => [
    timeValue(item.at),
    ...(item.end !== undefined ? [timeValue(item.end)] : []),
  ]);
  let min = Math.min(...values);
  let max = Math.max(...values);
  const range = { min, max };
  if (unit === 'ms') min = Math.min(0, min);
  if (max === min) {
    if (unit === 'ms') max = min + 1;
    else {
      min -= MINUTE;
      max += MINUTE;
    }
  }
  const offset = unit === 'time' ? zoneOffset(range.min, zone) : 0;
  const seconds = unit === 'ms' && max - min >= 10 * SECOND;
  const ticked = pickTicks(
    unit,
    min + offset,
    max + offset,
    plot.right - plot.left,
    (walls, step) =>
      unit === 'time'
        ? clockLabels(walls, step)
        : walls.map((value) => numberText(seconds ? value / SECOND : value)),
  );
  const scale = (value: number) =>
    plot.left + ((value + offset - ticked.lo) / (ticked.hi - ticked.lo)) * (plot.right - plot.left);
  const instant = new Intl.DateTimeFormat(currentLocale(), {
    ...(zone !== undefined && { timeZone: zone }),
    dateStyle: 'medium',
    timeStyle: ticked.step < MINUTE ? 'medium' : 'short',
  });
  const pointText = (value: number) =>
    unit === 'time'
      ? instant.format(value)
      : new Intl.NumberFormat(currentLocale(), {
          style: 'unit',
          unit: 'millisecond',
          unitDisplay: 'short',
          maximumFractionDigits: 3,
          useGrouping: false,
        }).format(value);

  // Events: a title over the point, up to two detail lines under it; a later event that would
  // meet an earlier one on its lane takes the next free row of the lane.
  let cursor = 8;
  const laidLanes: LaidLane[] = [];
  const laidEvents: LaidEvent[] = [];
  for (const lane of laneList) {
    const own = events.filter((item) => laneOf(item) === lane.id).sort(byStart);
    const placed = own.map((item) => {
      const title = fit(item.label, TITLE_MAX);
      const lines = item.detail ? wrap(item.detail, DETAIL_MAX, 2) : [];
      const boxWidth = Math.ceil(Math.max(textWidth(title), ...lines.map((l) => textWidth(l))));
      const x = scale(timeValue(item.at));
      const left = Math.min(Math.max(x - boxWidth / 2, gutter), width - PAD - boxWidth);
      return { item, title, lines, x, left: Math.max(left, PAD), width: boxWidth };
    });
    const rowEnds: number[] = [];
    const rowLines: number[] = [];
    const rowOf = placed.map((event) => {
      let row = rowEnds.findIndex((end) => end + ROW_GAP <= event.left);
      if (row < 0) row = rowEnds.length;
      rowEnds[row] = event.left + event.width;
      rowLines[row] = Math.max(rowLines[row] ?? 0, event.lines.length);
      return row;
    });
    const rowTops: number[] = [];
    let top = cursor + LANE_PAD;
    for (const lines of rowLines) {
      rowTops.push(top);
      top += 2 * LINE + lines * LINE + ROW_GAP;
    }
    const height = top - ROW_GAP + LANE_PAD - cursor;
    placed.forEach((event, i) => {
      const rowTop = rowTops[rowOf[i]!]!;
      const middle = event.left + event.width / 2;
      laidEvents.push({
        item: event.item,
        series: series(event.item),
        x: event.x,
        y: rowTop + LINE + LINE / 2,
        title: { x: middle, y: rowTop + LINE / 2, text: event.title, anchor: 'middle' },
        lines: event.lines.map((text, j) => ({
          x: middle,
          y: rowTop + 2 * LINE + LINE / 2 + j * LINE,
          text,
          anchor: 'middle',
        })),
        box: {
          x: event.left,
          y: rowTop,
          width: event.width,
          height: 2 * LINE + event.lines.length * LINE,
        },
        at: pointText(timeValue(event.item.at)),
      });
    });
    laidLanes.push({
      id: lane.id,
      label: {
        x: PAD,
        y: cursor + LANE_PAD + LINE + LINE / 2,
        text: fit(lane.label, labelColumn),
        anchor: 'start',
      },
      y: cursor,
      height,
    });
    cursor += height;
  }

  // Spans: a bar from start to end, its duration beside its end.
  if (laidLanes.length > 0 && rows.length > 0) cursor += 8;
  const laidSpans = rows.map(({ item, depth }, i): LaidSpan => {
    const y = cursor + i * BAR_ROW;
    const start = scale(timeValue(item.at));
    const end = scale(timeValue(item.end!));
    const bar = {
      x: start,
      y: y + (BAR_ROW - BAR) / 2,
      width: Math.max(2, end - start),
      height: BAR,
    };
    const length = timeValue(item.end!) - timeValue(item.at);
    const text =
      unit === 'time' ? durationText(length) : numberText(seconds ? length / SECOND : length);
    const room = digitsWidth(text);
    const beside = bar.x + bar.width + 6;
    const duration =
      beside + room <= width - PAD / 2
        ? { x: beside, anchor: 'start' as const, inside: false }
        : room + 12 <= bar.width
          ? { x: bar.x + bar.width - 6, anchor: 'end' as const, inside: true }
          : { x: bar.x - 6, anchor: 'end' as const, inside: false };
    return {
      item,
      series: series(item),
      depth,
      y,
      bar,
      label: {
        x: PAD + depth * INDENT,
        y: y + BAR_ROW / 2,
        text: fit(item.label, Math.max(24, labelColumn - depth * INDENT)),
        anchor: 'start',
      },
      duration: { ...duration, y: y + BAR_ROW / 2, text },
      box: { x: PAD, y, width: width - 2 * PAD, height: BAR_ROW },
      from: pointText(timeValue(item.at)),
      to: pointText(timeValue(item.end!)),
      length: unit === 'time' ? durationText(length) : pointText(length),
    };
  });
  cursor += rows.length * BAR_ROW;

  const counts = new Map<string, number>();
  for (const item of spec.items)
    if (item.group !== undefined) counts.set(item.group, (counts.get(item.group) ?? 0) + 1);
  const legend = (spec.groups ?? [])
    .map((group, i) => ({
      id: group.id,
      label: group.label,
      series: (i % 6) + 1,
      count: counts.get(group.id) ?? 0,
    }))
    .filter((group) => group.count > 0);

  const bottom = cursor;
  return {
    width,
    height: bottom + 2 * LINE + 2 * PAD,
    plot: { ...plot, top: 8, bottom },
    axis: {
      unit: unit === 'time' ? 'time' : seconds ? 's' : 'ms',
      ...(zone !== undefined && { zone }),
      y: bottom + 2 * LINE + LINE / 2,
    },
    ticks: ticked.labels.map((label, i) => ({
      x: scale(ticked.lo + i * ticked.step - offset),
      label,
      width: digitsWidth(label),
    })),
    lanes: laidLanes,
    events: laidEvents,
    spans: laidSpans,
    legend: legend.length >= 2 ? legend : [],
    range: { from: pointText(range.min), to: pointText(range.max) },
  };
}
