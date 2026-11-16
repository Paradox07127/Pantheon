import type { BoardModel, BoardTaskStatus } from '@pantheon/protocol';
import { timeAxis } from '../../lib/time-axis';

type Task = BoardModel['tasks'][number];

/** Idle stretches longer than this and than a twentieth of the replay are cut from its axis. */
const IDLE_MS = 60_000;
const GAP_SHARE = 0.05;

/** A point on the replay track: a task done, an attempt failed, or a wait for the user begun. */
export interface FlowReplayMark {
  at: number;
  state: 'done' | 'failed' | 'waiting';
}

export interface FlowReplay {
  /** The first attempt's start. */
  from: number;
  /** The snapshot's time, or a later attempt end. */
  to: number;
  axis: ReturnType<typeof timeAxis>;
  /** By time. */
  marks: FlowReplayMark[];
  /** The distinct times a task's status changes, ascending. */
  changes: number[];
}

const started = (task: Task) => task.segments.filter((seg) => seg.started_at !== null);

/**
 * When an attempt stopped running: its end, or for a session still open but no longer running
 * the task's last progress; null while it runs.
 */
function stopped(task: Task, seg: Task['segments'][number]): number | null {
  if (seg.ended_at !== null) return seg.ended_at;
  if (seg.status === 'running' || seg.status === 'waiting') return null;
  return Math.max(seg.started_at!, task.last_progress_at ?? seg.started_at!);
}

/** The replay of the tasks' attempts up to now; null when no attempt started. */
export function flowReplay(tasks: readonly Task[], now: number): FlowReplay | null {
  if (!tasks.some((task) => started(task).length > 0)) return null;
  const marks: FlowReplayMark[] = [];
  const changes = new Set<number>();
  const spans: [number, number | null][] = [];
  for (const task of tasks) {
    for (const seg of started(task)) {
      const end = stopped(task, seg);
      changes.add(seg.started_at!);
      spans.push([seg.started_at!, end]);
      if (end === null) continue;
      changes.add(end);
      if (seg.status === 'done') marks.push({ at: end, state: 'done' });
      else if (seg.status === 'failed') marks.push({ at: end, state: 'failed' });
    }
    const since = task.activity?.waiting?.since;
    if (since !== undefined) {
      changes.add(since);
      marks.push({ at: since, state: 'waiting' });
    }
  }
  const times = [...changes].sort((a, b) => a - b);
  const from = times[0]!;
  const to = Math.max(now, times.at(-1)!);
  // The end counts as busy, so the idle stretch after the last attempt is cut as well.
  const busy = spans.map(([start, end]): [number, number] => [start, end ?? to]);
  busy.push([to, to]);
  return {
    from,
    to,
    axis: timeAxis(busy, from, to, Math.max(IDLE_MS, (to - from) * GAP_SHARE)),
    marks: marks.sort((a, b) => a.at - b.at),
    changes: times,
  };
}

/**
 * The newest status change at or before time, to the millisecond; -Infinity before the first. The
 * statuses hold from one change to the next.
 */
export function momentAt(replay: FlowReplay, time: number): number {
  const at = Math.round(time);
  return replay.changes.findLast((change) => change <= at) ?? Number.NEGATIVE_INFINITY;
}

/**
 * Each task's status at time: not started before its first attempt, running while an attempt or
 * the next parallel part is due, waiting once its current wait began, else the last attempt's.
 */
export function statusesAt(
  tasks: readonly Task[],
  time: number,
): ReadonlyMap<string, BoardTaskStatus> {
  return new Map(
    tasks.map((task) => {
      let status: BoardTaskStatus = 'todo';
      let ended = Number.NEGATIVE_INFINITY;
      let running = false;
      for (const seg of started(task)) {
        if (seg.started_at! > time) continue;
        const end = stopped(task, seg);
        if (end === null || end > time) running = true;
        else if (end >= ended) {
          ended = end;
          status = seg.status;
        }
      }
      const parts = new Set(task.parallel?.flatMap((part) => part.session_id ?? []));
      const starts = started(task)
        .filter((seg) => seg.session_id !== null && parts.has(seg.session_id))
        .map((seg) => seg.started_at!);
      if (starts.some((at) => at <= time) && starts.some((at) => at > time)) running = true;
      const since = task.activity?.waiting?.since;
      if (running) status = since !== undefined && since <= time ? 'waiting' : 'running';
      return [task.id, status];
    }),
  );
}
