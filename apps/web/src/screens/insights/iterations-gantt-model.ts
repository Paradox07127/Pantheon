import type { BoardModel } from '@pantheon/protocol';
import { planTaskIds } from '../../data/task-trace';
import { isPlanTask } from '../board/view-rules';

type Task = BoardModel['tasks'][number];
type Iteration = NonNullable<BoardModel['iterations']>[number];

/** Rows drawn when the board does not say how many tasks may run at once. */
const DEFAULT_SLOTS = 3;
/** Days shown before and after today without an iteration; few before, so today stays in view. */
const BEFORE = 2;
const AFTER = 7;
/** The narrowest a day is drawn, in px; a bar's title is given room on this scale. */
export const DAY_PX = 96;
/** A bar's state icon, runtime glyph, one point's square, gaps and padding, in px. */
const BAR_CHROME_PX = 72;
/** The most squares an estimate draws; the points past them follow as a number. */
export const ESTIMATE_SQUARES = 3;
const DAY = 86_400_000;

export interface GanttBar {
  task: Task;
  /** The row, from 0; rows past the slot limit hold bars that would overlap otherwise. */
  slot: number;
  /** Left and right edges as shares of the axis, 0 to 1. */
  x1: number;
  x2: number;
  /** Not started: a place in its iteration by plan order and points, not a forecast. */
  planned: boolean;
}

export interface GanttLayout {
  /** Each day on the axis with where it starts. */
  days: { date: string; x: number }[];
  /** The dispatch limit. */
  slots: number;
  /** Rows drawn: the slots, and more when bars or their titles would overlap past the limit. */
  rows: number;
  bars: GanttBar[];
  /** A bar after the bar of a task it depends on. */
  links: { from: GanttBar; to: GanttBar }[];
  /** Null when now is off the axis. */
  today: number | null;
  /** Plan tasks neither started nor in an iteration. */
  unscheduled: Task[];
}

const pad = (n: number) => String(n).padStart(2, '0');
const dayOf = (at: number) => {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const startOf = (day: string, plus = 0) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d! + plus).getTime();
};
const pointsOf = (task: Task) => task.estimate ?? 1;
// Estimated rendered width at --fs-xs: CJK glyphs about 12px, others about 7px.
const titlePx = (title: string) =>
  [...title].reduce((w, c) => {
    const code = c.codePointAt(0)!;
    return w + (code >= 0x3000 && code <= 0x9fff ? 12 : 7);
  }, 0);
/** The estimate's width past the one square in BAR_CHROME_PX: 8px squares 4px apart, then `+n`. */
const estimatePx = (task: Task) => {
  const points = pointsOf(task);
  const more = points - ESTIMATE_SQUARES;
  return (Math.min(points, ESTIMATE_SQUARES) - 1) * 12 + (more > 0 ? 4 + titlePx(`+${more}`) : 0);
};
/** Until when a bar drawn from `at` keeps its row, so its title is not covered by the next bar. */
const heldUntil = (task: Task, at: number, end: number) =>
  Math.max(end, at + ((BAR_CHROME_PX + estimatePx(task) + titlePx(task.title)) / DAY_PX) * DAY);

/** The tasks so each comes after the ones it depends on among them; ties keep the plan order. */
function dependencyOrder(tasks: Task[]): Task[] {
  const ids = new Set(tasks.map((task) => task.id));
  const upstream = (task: Task) =>
    (task.depends_on ?? [])
      .map((id) => `${planTaskIds(task.id).lead}:${id}`)
      .filter((id) => ids.has(id));
  const left = [...tasks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const done = new Set<string>();
  const order: Task[] = [];
  while (left.length) {
    const at = Math.max(
      0,
      left.findIndex((task) => upstream(task).every((id) => done.has(id))),
    );
    const [next] = left.splice(at, 1);
    done.add(next!.id);
    order.push(next!);
  }
  return order;
}

/**
 * The started plan tasks over the iteration's days and its tasks not started, each as a bar in a
 * slot row, and the unscheduled rest; without an iteration, two days before today and a week after.
 */
export function ganttLayout(
  model: Pick<BoardModel, 'tasks' | 'iterations' | 'slots' | 'now'>,
  iteration: Iteration | null,
): GanttLayout {
  const iterations = model.iterations ?? [];
  const today = dayOf(model.now);
  const first = iteration?.starts_on ?? dayOf(startOf(today, -BEFORE));
  const last = iteration?.ends_on ?? dayOf(startOf(today, AFTER));
  const days: string[] = [];
  for (let k = 0; !days.length || days.at(-1)! < last; k++) days.push(dayOf(startOf(first, k)));
  const from = startOf(first);
  const to = startOf(last, 1);
  const x = (at: number) => (Math.min(to, Math.max(from, at)) - from) / (to - from);

  const slots = Math.max(1, model.slots?.limit ?? DEFAULT_SLOTS);
  const taken: [number, number][][] = Array.from({ length: slots }, () => []);
  const place = (a: number, b: number, preferred = 0) => {
    const free = (s: number) => taken[s]!.every(([c, d]) => b <= c || d <= a);
    let slot = free(preferred) ? preferred : taken.findIndex((_, s) => free(s));
    if (slot < 0) slot = taken.push([]) - 1;
    taken[slot]!.push([a, b]);
    return slot;
  };

  const plan = model.tasks.filter((task) => isPlanTask(task) && task.owner_session_id);
  const iterationOf = (task: Task) => iterations.find((i) => i.id === task.iteration_id);
  const bars: GanttBar[] = [];
  let startedEnd = -Infinity;
  for (const task of plan
    .filter((t) => t.started_at !== null)
    .sort((a, b) => a.started_at! - b.started_at!)) {
    const start = task.started_at!;
    const end =
      task.ended_at ??
      (task.state === 'merged' || task.state === 'failed'
        ? (task.last_progress_at ?? start)
        : model.now);
    startedEnd = Math.max(startedEnd, end);
    if (start >= to || end < from) continue;
    const slot = place(start, heldUntil(task, Math.max(start, from), end));
    bars.push({ task, slot, x1: x(start), x2: x(end), planned: false });
  }

  const waiting = iteration
    ? plan.filter((t) => t.started_at === null && t.iteration_id === iteration.id)
    : [];
  if (iteration && waiting.length) {
    const begins = startOf(iteration.starts_on);
    const ends = startOf(iteration.ends_on, 1);
    // What is still to do goes after now and after the started bars, while the iteration has room.
    const after = Math.max(begins, model.now < ends ? model.now : begins, startedEnd);
    const a = after < ends ? after : begins;
    const free = Array<number>(slots).fill(0);
    const finish = new Map<string, number>();
    const placed = dependencyOrder(waiting).map((task) => {
      const ready = Math.max(
        0,
        ...(task.depends_on ?? []).map(
          (id) => finish.get(`${planTaskIds(task.id).lead}:${id}`) ?? 0,
        ),
      );
      const slot = free.reduce(
        (best, at, s) => (Math.max(at, ready) < Math.max(free[best]!, ready) ? s : best),
        0,
      );
      const start = Math.max(free[slot]!, ready);
      free[slot] = start + pointsOf(task);
      finish.set(task.id, free[slot]!);
      return { task, slot, start, end: free[slot]! };
    });
    const unit = (ends - a) / Math.max(...placed.map((p) => p.end));
    for (const p of placed) {
      const start = a + p.start * unit;
      const end = a + p.end * unit;
      bars.push({
        task: p.task,
        slot: place(start, heldUntil(p.task, start, end), p.slot),
        x1: x(start),
        x2: x(end),
        planned: true,
      });
    }
  }

  const barOf = new Map(bars.map((bar) => [bar.task.id, bar]));
  return {
    days: days.map((date) => ({ date, x: x(startOf(date)) })),
    slots,
    rows: taken.length,
    bars,
    links: bars.flatMap((to) =>
      (to.task.depends_on ?? []).flatMap((id) => {
        const from = barOf.get(`${planTaskIds(to.task.id).lead}:${id}`);
        return from ? [{ from, to }] : [];
      }),
    ),
    today: model.now >= from && model.now < to ? x(model.now) : null,
    unscheduled: plan.filter((t) => t.started_at === null && !iterationOf(t)),
  };
}
