import type { BoardHistory, BoardTaskState } from '@pantheon/protocol';
import { BREAK_SHARE, timeAxis } from '../../lib/time-axis';
import { TASK_TYPE } from './status';
import { criticalPath } from './view-rules';

export type HistoryRange = 'all' | 'month' | 'milestone';
/** What the rows split the tasks by. */
export type HistoryBands = 'lanes' | 'type' | 'model';
export type HistoryDecision = BoardHistory['decisions'][number];
export type HistoryTask = BoardHistory['tasks'][number];
export type OpenTask = HistoryTask & { state: Exclude<HistoryTask['state'], 'merged' | 'removed'> };

const DAY = 86_400_000;
/** The row titles' column left of the axis. */
export const LABEL_W = 100;
/** The open tasks' column right of the now line, at its narrowest. */
const OPEN_W = 180;
const MIN_PLOT = 240;
/** Milestone labels and month ticks above the first row. */
export const TOP = 64;
const ROW_H = 112;
export const PILL_GAP = 28;
/** An open task's pill starts this far right of the now line. */
const PILL_IN = 36;
/** A pill's padding, border, state icon and gap around its title. */
const PILL_PAD = 36;
/** A decision over a row sits this far above its line. */
const DECISION_RISE = 16;
/** The failure dots, the daily merge bars and the now label under the rows. */
const BOTTOM = 80;
const BAR_H = 20;
const TICK_GAP = 48;
/** A row with more merged tasks than this folds those in the axis's first third. */
export const FOLD_MIN = 12;

export interface HistoryDot {
  task: HistoryTask;
  x: number;
  reworked: boolean;
}

export interface HistoryRow {
  /** The lane id, task type or model; '' for the row of tasks without one. */
  key: string;
  laneId: string | null;
  /** A model row's runtime, for its glyph. */
  runtime: string | null;
  /** The row's centre line. */
  y: number;
  merged: number;
  total: number;
  dots: HistoryDot[];
  fold: { count: number; x1: number; x2: number; open: boolean } | null;
  line: { x1: number; x2: number } | null;
  pills: { task: OpenTask; y: number }[];
}

export interface HistoryLayout {
  width: number;
  height: number;
  left: number;
  /** The open tasks' column right of the now line. */
  openW: number;
  /** The now line, the axis's right end. */
  now: number;
  ticks: { x: number; at: number; first: boolean }[];
  breaks: { x: number; width: number; days: number }[];
  /** Reached milestones where they were reached; due ones, not reached yet, at their due day. */
  milestones: { id: string; title: string; x: number; due: boolean }[];
  rows: HistoryRow[];
  /** The bottom of the last row. */
  rowsEnd: number;
  bars: { x: number; width: number; height: number }[];
  /** Days with failed attempts or requests waiting on the user; at is the day's start. */
  marks: { x: number; at: number; kind: 'failed' | 'waited'; count: number }[];
  /** The user's decisions by day and row; at is the day's start, y the diamond's centre. */
  decisions: {
    key: string;
    x: number;
    y: number;
    at: number;
    count: number;
    items: HistoryDecision[];
  }[];
  /** Dependencies between drawn tasks of different rows. */
  edges: { key: string; x1: number; y1: number; x2: number; y2: number; critical: boolean }[];
  /** The critical path's tasks while it is asked for and runs through a dependency, else null. */
  critical: ReadonlySet<string> | null;
}

export const isMerged = (task: HistoryTask) => task.merged_at !== null || task.state === 'merged';
const isOpen = (task: HistoryTask): task is OpenTask =>
  task.state !== 'merged' && task.state !== 'removed';

const midnight = (at: number) => {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
const dayStart = (date: string) => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d).getTime();
};
/** The project's day number of `at`, its first day being 1. */
export const dayNumber = (startedAt: number, at: number) =>
  Math.round((midnight(at) - midnight(startedAt)) / DAY) + 1;

/** Tasks the history counts: removed ones only when they merged first. */
const counted = (history: BoardHistory) =>
  history.tasks.filter((task) => task.state !== 'removed' || task.merged_at !== null);

/** The first milestone not reached yet. */
export const currentMilestone = (history: BoardHistory) =>
  history.milestones.find((m) => m.state !== 'removed' && m.reached_at === null) ?? null;

export interface HistoryInput {
  history: BoardHistory;
  lanes: readonly { id: string; title: string }[];
  width: number;
  now: number;
  range: HistoryRange;
  /** Keys of the rows whose fold is open. */
  expanded: ReadonlySet<string>;
  /** Due calendar days by milestone id. */
  due: ReadonlyMap<string, string>;
  bands: HistoryBands;
  /** Whether to mark the critical path. */
  critical: boolean;
  /** The widest open task title's full width, 0 until measured. */
  titleWidth: number;
}

export function historyLayout({
  history,
  lanes,
  width,
  now,
  range,
  expanded,
  due,
  bands,
  critical,
  titleWidth,
}: HistoryInput): HistoryLayout {
  const current = currentMilestone(history);
  const tasks =
    range === 'milestone'
      ? counted(history).filter((task) => task.milestone_id === current?.id)
      : counted(history);
  const from =
    range === 'month'
      ? Math.max(history.started_at, now - 30 * DAY)
      : range === 'milestone'
        ? Math.max(history.started_at, Math.min(now, ...tasks.map((task) => task.created_at)))
        : history.started_at;
  const to = Math.max(now, from);
  const idle = history.idle
    .map(({ from: a, to: b }): [number, number] => [Math.max(a, from), Math.min(b, to)])
    .filter(([a, b]) => b > a);
  const busy: [number, number][] = [];
  let cursor = from;
  for (const [a, b] of idle) {
    busy.push([cursor, a]);
    cursor = b;
  }
  busy.push([cursor, to]);
  const axis = timeAxis(busy, from, to, 0);
  const left = LABEL_W;
  // The open column fits the longest title, taking at most a third of the width past the labels.
  const openW = Math.max(
    OPEN_W,
    Math.min(PILL_IN + PILL_PAD + Math.ceil(titleWidth), (width - LABEL_W) / 3),
  );
  const plot = Math.max(MIN_PLOT, width - LABEL_W - openW);
  const right = left + plot;
  const x = (at: number) => left + axis.position(Math.min(to, Math.max(from, at))) * plot;

  const ticks: HistoryLayout['ticks'] = [{ x: left, at: from, first: true }];
  const first = new Date(from);
  for (let m = first.getMonth() + 1; ; m++) {
    const at = new Date(first.getFullYear(), m, 1).getTime();
    if (at > to) break;
    if (x(at) - ticks.at(-1)!.x >= TICK_GAP) ticks.push({ x: x(at), at, first: false });
  }

  const known = new Set(lanes.map((lane) => lane.id));
  const bandKey = (task: HistoryTask) =>
    bands === 'type'
      ? task.task_type && task.task_type in TASK_TYPE
        ? task.task_type
        : ''
      : bands === 'model'
        ? (task.model ?? task.runtime ?? '')
        : known.has(task.lane_id)
          ? task.lane_id
          : '';
  const order =
    bands === 'lanes'
      ? lanes.map((lane) => lane.id)
      : bands === 'type'
        ? Object.keys(TASK_TYPE)
        : [];
  const groups = new Map<string, HistoryTask[]>(order.map((key) => [key, []]));
  const rest: HistoryTask[] = [];
  for (const task of tasks) {
    const key = bandKey(task);
    if (!key) rest.push(task);
    else if (groups.has(key)) groups.get(key)!.push(task);
    else groups.set(key, [task]);
  }
  groups.set('', rest);
  const foldEnd = axis.time(1 / 3);
  const rows: HistoryRow[] = [];
  /** Where each drawn task sits, and in which row. */
  const placed = new Map<string, { x: number; y: number; row: string }>();
  let top = TOP;
  for (const [key, list] of groups) {
    if (!list.length) continue;
    const drawn = list
      .filter((task) => task.merged_at !== null && task.merged_at >= from && task.merged_at <= to)
      .sort((a, b) => a.merged_at! - b.merged_at!);
    const early =
      range === 'all' && drawn.length > FOLD_MIN
        ? drawn.filter((task) => task.merged_at! <= foldEnd)
        : [];
    const open = expanded.has(key);
    const fold = early.length ? { count: early.length, x1: left, x2: x(foldEnd), open } : null;
    const dots = (fold && !open ? drawn.slice(early.length) : drawn).map((task) => ({
      task,
      x: x(task.merged_at!),
      reworked: task.handbacks > 0,
    }));
    const pending = list.filter(isOpen);
    const height = Math.max(ROW_H, pending.length * PILL_GAP + 16);
    const y = top + height / 2;
    const start = fold && !open ? fold.x2 : dots[0]?.x;
    const pills = pending.map((task, i) => ({
      task,
      y: y + (i - (pending.length - 1) / 2) * PILL_GAP,
    }));
    for (const dot of dots) placed.set(dot.task.id, { x: dot.x, y, row: key });
    for (const pill of pills) placed.set(pill.task.id, { x: right + PILL_IN, y: pill.y, row: key });
    rows.push({
      key,
      laneId: bands === 'lanes' ? key || null : null,
      runtime: bands === 'model' ? (list.find((task) => task.runtime)?.runtime ?? null) : null,
      y,
      merged: list.filter(isMerged).length,
      total: list.length,
      dots,
      fold,
      line: start === undefined ? null : { x1: start, x2: dots.at(-1)?.x ?? start },
      pills,
    });
    top += height;
  }

  const dependencies = tasks.flatMap((task) =>
    task.depends_on.map((id) => ({ from: `${task.owner_session_id}:${id}`, to: task.id })),
  );
  // Over the whole history no task counts as done, so the path runs through merged ones too.
  const path = critical
    ? criticalPath({
        tasks: tasks.map((task) => ({ id: task.id, status: 'todo' as const })),
        edges: dependencies,
      })
    : [];
  const onPath = new Set(path.slice(1).map((to, i) => `${path[i]}->${to}`));
  const edges = dependencies.flatMap(({ from: a, to: b }): HistoryLayout['edges'] => {
    const up = placed.get(a);
    const down = placed.get(b);
    if (!up || !down || up.row === down.row) return [];
    const key = `${a}->${b}`;
    return [{ key, x1: up.x, y1: up.y, x2: down.x, y2: down.y, critical: onPath.has(key) }];
  });

  const rowY = new Map(rows.map((row) => [row.key, row.y]));
  const decisions = new Map<string, HistoryLayout['decisions'][number]>();
  for (const decision of history.decisions) {
    const at = midnight(decision.at);
    if (at + DAY <= from || decision.at > to) continue;
    const lane =
      bands === 'lanes' && decision.lane_id !== null && rowY.has(decision.lane_id)
        ? decision.lane_id
        : null;
    const key = `${at}:${lane ?? ''}`;
    const held = decisions.get(key);
    if (held) {
      held.count++;
      held.items.push(decision);
    } else
      decisions.set(key, {
        key,
        x: x(at + DAY / 2),
        y: lane === null ? TOP + 8 : rowY.get(lane)! - DECISION_RISE,
        at,
        count: 1,
        items: [decision],
      });
  }

  const shown = history.days.filter((day) => dayStart(day.date) + DAY > from);
  const most = Math.max(1, ...shown.map((day) => day.merged));
  const dayWidth = axis.unit * DAY * plot;
  const barWidth = Math.max(2, Math.min(8, dayWidth - 2));
  return {
    width: right + openW,
    height: top + BOTTOM,
    left,
    openW,
    now: right,
    ticks,
    breaks: axis.breaks.map((b) => ({
      x: left + b.at * plot,
      width: BREAK_SHARE * plot,
      days: Math.round(b.ms / DAY),
    })),
    milestones: history.milestones.flatMap((m): HistoryLayout['milestones'] => {
      if (m.state === 'removed') return [];
      if (m.reached_at !== null)
        return m.reached_at >= from && m.reached_at <= to
          ? [{ id: m.id, title: m.title, x: x(m.reached_at), due: false }]
          : [];
      const day = due.get(m.id);
      const at = day === undefined ? null : dayStart(day);
      if (at === null || at < from) return [];
      // A day still ahead goes right of the now line at the axis's scale, inside the open column.
      const mx = at <= to ? x(at) : Math.min(right + openW, right + (at - to) * axis.unit * plot);
      return [{ id: m.id, title: m.title, x: mx, due: true }];
    }),
    rows,
    rowsEnd: top,
    bars: shown
      .filter((day) => day.merged > 0)
      .map((day) => ({
        x: x(dayStart(day.date) + DAY / 2) - barWidth / 2,
        width: barWidth,
        height: Math.max(4, (day.merged / most) * BAR_H),
      })),
    marks: shown.flatMap((day): HistoryLayout['marks'] => {
      const at = dayStart(day.date);
      const mid = x(at + DAY / 2);
      // A day with both draws them side by side.
      const both = day.failed > 0 && day.waited > 0;
      return [
        ...(day.failed > 0
          ? [{ x: both ? mid - 4 : mid, at, kind: 'failed' as const, count: day.failed }]
          : []),
        ...(day.waited > 0
          ? [{ x: both ? mid + 4 : mid, at, kind: 'waited' as const, count: day.waited }]
          : []),
      ];
    }),
    decisions: [...decisions.values()],
    edges,
    critical: path.length > 1 ? new Set(path) : null,
  };
}

/**
 * A line through values from 0 to 1, left to right over width, top to bottom over height; it
 * breaks at null and draws a lone value as a dot.
 */
export function sparkPath(values: readonly (number | null)[], width: number, height: number) {
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const round = (n: number) => Math.round(n * 10) / 10;
  let d = '';
  values.forEach((v, i) => {
    if (v === null) return;
    const lead = i > 0 && values[i - 1] !== null;
    d += `${d ? ' ' : ''}${lead ? 'L' : 'M'}${round(i * step)} ${round(2 + (1 - v) * (height - 4))}`;
    if (!lead && (values[i + 1] ?? null) === null) d += ' h0';
  });
  return d;
}

const WEEKS = 10;
const REWORKED = 3;
/** The progress bar's segment order, from done to not started. */
const STATE_ORDER: readonly BoardTaskState[] = [
  'merged',
  'awaiting_merge',
  'awaiting_acceptance',
  'gating',
  'running',
  'claimed',
  'waiting_approval',
  'needs_attention',
  'blocked',
  'failed',
  'waiting_upstream',
  'todo',
];

export interface HistorySummary {
  merged: number;
  total: number;
  /** Counted tasks by state, in STATE_ORDER, states without a task left out. */
  states: { state: BoardTaskState; count: number }[];
  reached: number;
  milestoneCount: number;
  handbacks: number;
  /**
   * Non-removed milestones; day is the project day it was reached on, null while open; left is
   * the days from today to the due day of an open one, negative once past, null without one.
   */
  milestones: { id: string; title: string; day: number | null; left: number | null }[];
  /** Merges per week, oldest first, the last week ending today. */
  weeks: number[];
  reworked: { task: HistoryTask; share: number }[];
  /**
   * First-run pass share of tasks with a passed gate run, overall and per merge week (oldest first,
   * the last ending today, null for a week without one); null when no task has a passed gate run.
   */
  gate: { share: number; weeks: (number | null)[] } | null;
}

/** The totals over the whole history, whatever range the chart shows. */
export function historySummary(
  history: BoardHistory,
  due: ReadonlyMap<string, string>,
  now: number,
): HistorySummary {
  const tasks = counted(history);
  const milestones = history.milestones.filter((m) => m.state !== 'removed');
  const weeks: number[] = [];
  for (let end = history.days.length; end > 0 && weeks.length < WEEKS; end -= 7)
    weeks.unshift(
      history.days.slice(Math.max(0, end - 7), end).reduce((sum, day) => sum + day.merged, 0),
    );
  const reworked = tasks
    .filter((task) => task.handbacks > 0)
    .sort((a, b) => b.handbacks - a.handbacks)
    .slice(0, REWORKED);
  const gated = tasks.filter((task) => task.gate_passed_on_attempt !== undefined);
  const firstRun = (list: HistoryTask[]) =>
    list.filter((task) => task.gate_passed_on_attempt === 1).length / list.length;
  const end = midnight(now) + DAY;
  const gateWeeks = Array.from({ length: weeks.length }, (_, i) => {
    const since = end - (weeks.length - i) * 7 * DAY;
    const list = gated.filter(
      (task) =>
        task.merged_at !== null && task.merged_at >= since && task.merged_at < since + 7 * DAY,
    );
    return list.length ? firstRun(list) : null;
  });
  return {
    merged: tasks.filter(isMerged).length,
    total: tasks.length,
    states: STATE_ORDER.flatMap((state) => {
      const count = tasks.filter(
        (task) => (task.state === 'removed' ? 'merged' : task.state) === state,
      ).length;
      return count ? [{ state, count }] : [];
    }),
    reached: milestones.filter((m) => m.reached_at !== null).length,
    milestoneCount: milestones.length,
    handbacks: history.days.reduce((sum, day) => sum + day.handbacks, 0),
    milestones: milestones.map((m) => {
      const day = m.reached_at === null ? due.get(m.id) : undefined;
      return {
        id: m.id,
        title: m.title,
        day: m.reached_at === null ? null : dayNumber(history.started_at, m.reached_at),
        left: day === undefined ? null : dayNumber(now, dayStart(day)) - 1,
      };
    }),
    weeks,
    reworked: reworked.map((task) => ({
      task,
      share: task.handbacks / reworked[0]!.handbacks,
    })),
    gate: gated.length ? { share: firstRun(gated), weeks: gateWeeks } : null,
  };
}
