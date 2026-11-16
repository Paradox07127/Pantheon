import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { ChevronRight } from 'lucide-react';
import type { BoardModel } from '@pantheon/protocol';
import { t } from '../../i18n';
import type { FlowGroup } from './flow-layout';
import type { FlowOverlay } from './FlowOverlays';
import { durationText } from './panels-model';
import { StateIcon } from './status';

type Task = BoardModel['tasks'][number];

/** The band a task falls in, read from the same fields the layout bands it by. */
export function bandKey(task: Task, group: FlowGroup): string | null {
  switch (group) {
    case 'lane':
      return task.lane_id;
    case 'kind':
      return task.kind?.domain ?? null;
    case 'state':
      return task.state ?? null;
    case 'model':
      return task.claim?.model ?? task.planned?.model ?? null;
  }
}

/** A row the layout places like a task; only its id and band fields are read. */
export const placeholder = (
  id: string,
  band: Pick<Task, 'lane_id' | 'kind' | 'state' | 'claim' | 'planned'>,
): Task =>
  ({
    id,
    lane_id: band.lane_id,
    kind: band.kind,
    state: band.state,
    claim: band.claim,
    planned: band.planned,
  }) as Task;

const EDGE_RANK: Record<BoardModel['edges'][number]['state'], number> = {
  met: 0,
  pending: 1,
  active: 2,
};

/** Whether the edges, each task drawn as its stack, run in no circle. */
function acyclic(edges: BoardModel['edges'], stackOf: ReadonlyMap<string, string>): boolean {
  const at = (id: string) => stackOf.get(id) ?? id;
  const next = new Map<string, string[]>();
  const into = new Map<string, number>();
  for (const e of edges) {
    const from = at(e.from);
    const to = at(e.to);
    if (from === to) continue;
    next.set(from, [...(next.get(from) ?? []), to]);
    into.set(to, (into.get(to) ?? 0) + 1);
    if (!into.has(from)) into.set(from, 0);
  }
  const free = [...into].flatMap(([id, n]) => (n ? [] : [id]));
  let left = into.size;
  for (let id = free.pop(); id !== undefined; id = free.pop()) {
    left--;
    for (const to of next.get(id) ?? []) {
      const n = into.get(to)! - 1;
      into.set(to, n);
      if (!n) free.push(to);
    }
  }
  return !left;
}

/**
 * Two or more merged tasks of a band become one stack; a shared edge takes the state furthest from
 * met, and a task whose joining would close a circle of edges stays out.
 */
export function stackMerged(
  model: BoardModel,
  group: FlowGroup,
): {
  model: BoardModel;
  overlays: Map<string, FlowOverlay>;
  stackOf: Map<string, string>;
} {
  const bands = new Map<string, Task[]>();
  for (const task of model.tasks)
    if (task.state === 'merged') {
      const id = `stack:${bandKey(task, group) ?? ''}`;
      bands.set(id, [...(bands.get(id) ?? []), task]);
    }
  const overlays = new Map<string, FlowOverlay>();
  const stackOf = new Map<string, string>();
  for (const [id, members] of bands) {
    if (members.length < 2) continue;
    const kept: string[] = [];
    for (const m of members) {
      stackOf.set(m.id, id);
      if (acyclic(model.edges, stackOf)) kept.push(m.id);
      else stackOf.delete(m.id);
    }
    if (kept.length > 1) overlays.set(id, { kind: 'stack', members: kept });
    else for (const m of kept) stackOf.delete(m);
  }
  if (!stackOf.size) return { model, overlays, stackOf };
  const tasks: Task[] = [];
  for (const task of model.tasks) {
    const stack = stackOf.get(task.id);
    if (!stack) tasks.push(task);
    else if (!tasks.some((t) => t.id === stack)) tasks.push(placeholder(stack, task));
  }
  const at = (id: string) => stackOf.get(id) ?? id;
  const edges: BoardModel['edges'] = [];
  for (const e of model.edges) {
    const from = at(e.from);
    const to = at(e.to);
    if (from === to) continue;
    const same = edges.find((x) => x.from === from && x.to === to);
    if (!same) edges.push({ ...e, from, to });
    else if (EDGE_RANK[e.state] > EDGE_RANK[same.state]) same.state = e.state;
  }
  return { model: { ...model, tasks, edges }, overlays, stackOf };
}

export const stackTitle = (count: number) =>
  t({ id: 'board.flow.stack.title', defaultMessage: 'Merged {count}' }, { count });

export type StackNode = Node<
  {
    tasks: Task[];
    open: boolean;
    onToggle: () => void;
    /** Opens a stacked task's drawer. */
    onOpen: (taskId: string) => void;
  },
  'stack'
>;

/** The merged tasks of a band as one card on two cards behind it; opened, it lists them. */
export function MergedStack({ data }: NodeProps<StackNode>) {
  const { tasks, open, onToggle, onOpen } = data;
  const fixed = { isConnectable: false };
  const count = tasks.length;
  return (
    <>
      <Handle type="target" position={Position.Left} {...fixed} />
      <div className="bd-stk" data-open={open || undefined}>
        <span className="bd-stk-u" aria-hidden="true" />
        <span className="bd-stk-u" aria-hidden="true" />
        <div className="bd-stk-c">
          <button
            type="button"
            className="bd-stk-h nodrag nopan"
            aria-expanded={open}
            aria-label={t(
              { id: 'board.flow.stack.label', defaultMessage: 'Merged, {count} tasks' },
              { count },
            )}
            onClick={onToggle}
          >
            <span className="bd-nrow">
              <StateIcon state="merged" />
              <span className="bd-stk-t">{stackTitle(count)}</span>
              <ChevronRight className="bd-stk-ch" aria-hidden="true" />
            </span>
            <span className="bd-stk-seg" aria-hidden="true">
              {tasks.map((task) => (
                <i key={task.id} />
              ))}
            </span>
          </button>
          {open && (
            <ul className="bd-stk-l">
              {tasks.map((task) => (
                <li key={task.id}>
                  <button
                    type="button"
                    className="bd-stk-r nodrag nopan"
                    onClick={() => onOpen(task.id)}
                  >
                    <StateIcon state="merged" />
                    <span className="bd-stk-rt">{task.title}</span>
                    {task.started_at !== null && task.ended_at !== null && (
                      <span className="bd-stk-tm">
                        {durationText(task.ended_at - task.started_at)}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Right} {...fixed} />
    </>
  );
}

/** How wide a stack's card is; the cards behind it reach 8px further. */
export const STACK_WIDTH = 196;
