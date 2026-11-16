import type { BoardModel } from '@pantheon/protocol';

type Task = BoardModel['tasks'][number];

/** Plan task ids are `<lead session id>:<task id>`; the other rows are sessions without a task. */
export const isPlanTask = (task: Pick<Task, 'id'>) => task.id.includes(':');

interface PlanGraph<T> {
  tasks: T[];
  upstream: Map<string, string[]>;
  /** Plan tasks in topological order; ties keep the board order. */
  order: T[];
}

/** The tasks and dependencies a plan graph is built from. */
type GraphInput<T> = { tasks: readonly T[]; edges: readonly { from: string; to: string }[] };

function planGraph<T extends Pick<Task, 'id' | 'status'>>(
  model: GraphInput<T>,
  keep: (task: T) => boolean = () => true,
): PlanGraph<T> {
  const tasks = model.tasks.filter((t) => isPlanTask(t) && keep(t));
  const ids = new Set(tasks.map((t) => t.id));
  const upstream = new Map(tasks.map((t) => [t.id, [] as string[]]));
  const downstream = new Map(tasks.map((t) => [t.id, [] as string[]]));
  for (const e of model.edges)
    if (ids.has(e.from) && ids.has(e.to)) {
      upstream.get(e.to)!.push(e.from);
      downstream.get(e.from)!.push(e.to);
    }
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const waiting = new Map(tasks.map((t) => [t.id, upstream.get(t.id)!.length]));
  const order = tasks.filter((t) => waiting.get(t.id) === 0);
  for (let i = 0; i < order.length; i++)
    for (const next of downstream.get(order[i]!.id)!) {
      waiting.set(next, waiting.get(next)! - 1);
      if (waiting.get(next) === 0) order.push(byId.get(next)!);
    }
  return { tasks, upstream, order };
}

/** The longest path through plan tasks not done, start first; of paths as long, the first. */
export function criticalPath(model: GraphInput<Pick<Task, 'id' | 'status'>>): string[] {
  const graph = planGraph(model, (t) => t.status !== 'done');
  const length = new Map<string, number>();
  const previous = new Map<string, string>();
  for (const t of graph.order) {
    let best: string | undefined;
    for (const up of graph.upstream.get(t.id)!)
      if (best === undefined || length.get(up)! > length.get(best)!) best = up;
    length.set(t.id, best === undefined ? 1 : length.get(best)! + 1);
    if (best !== undefined) previous.set(t.id, best);
  }
  let end: string | undefined;
  for (const t of graph.tasks)
    if (length.has(t.id) && (end === undefined || length.get(t.id)! > length.get(end)!)) end = t.id;
  const path: string[] = [];
  for (let at = end; at !== undefined; at = previous.get(at)) path.unshift(at);
  return path;
}

/** Plan tasks not started, without a session yet, whose upstream tasks are all done. */
export function readyTasks(model: Pick<BoardModel, 'tasks' | 'edges'>): string[] {
  const graph = planGraph(model);
  const done = new Set(graph.tasks.filter((t) => t.status === 'done').map((t) => t.id));
  return graph.tasks
    .filter(
      (t) =>
        (t.status === 'todo' || t.status === 'waiting') &&
        t.segments.length === 0 &&
        graph.upstream.get(t.id)!.every((up) => done.has(up)),
    )
    .map((t) => t.id);
}
