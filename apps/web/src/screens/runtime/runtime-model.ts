import type { BoardModel } from '@pantheon/protocol';
import type { RunForest, RunNode } from './run-tree';

/** How long a task or lead without live work stays on the runtime page after its last progress, ms. */
export const RECENT_MS = 60 * 60_000;

/**
 * The tasks live now or with progress within RECENT_MS of now, and the leads running,
 * waiting, with a plan changed within it or owning one of those tasks; each in board order.
 */
export function runtimeBoard(
  model: Pick<BoardModel, 'now' | 'since' | 'tasks' | 'leads'>,
  now = model.now,
): Pick<BoardModel, 'since' | 'tasks' | 'leads'> {
  const recent = (at: number | null) => at !== null && at >= now - RECENT_MS;
  const tasks = model.tasks.filter(
    (task) =>
      task.status === 'running' ||
      task.status === 'waiting' ||
      task.turn_running ||
      task.activity?.phase === 'queued' ||
      recent(task.last_progress_at),
  );
  const owners = new Set(tasks.map((task) => task.owner_session_id));
  const leads = model.leads?.filter(
    (lead) =>
      lead.state === 'running' ||
      lead.state === 'waiting' ||
      recent(lead.updated_at) ||
      owners.has(lead.session_id),
  );
  return { since: model.since, tasks, leads };
}

/** The leads' sessions and the sessions of segments still open or ended within the range, each once. */
export function runSessionIds(model: Pick<BoardModel, 'since' | 'tasks' | 'leads'>): string[] {
  const ids = new Set(model.leads?.map((lead) => lead.session_id));
  for (const task of model.tasks)
    for (const segment of task.segments)
      if (
        segment.session_id !== null &&
        (segment.ended_at === null || segment.ended_at >= model.since)
      )
        ids.add(segment.session_id);
  return [...ids];
}

export interface EndedSession {
  node: RunNode;
  /** When its segment ended, epoch ms. */
  at: number;
}

/**
 * The forest without the task sessions whose segment ended and that no longer run or wait, and
 * those sessions, the newest end first.
 */
export function splitEnded(
  forest: RunForest,
  tasks: BoardModel['tasks'],
): { live: RunForest; ended: EndedSession[] } {
  const endedAt = new Map<string, number>();
  for (const task of tasks)
    for (const segment of task.segments)
      if (segment.session_id !== null && segment.ended_at !== null)
        endedAt.set(segment.session_id, segment.ended_at);
  const ended: EndedSession[] = [];
  const keep = (nodes: readonly RunNode[]): RunNode[] =>
    nodes.flatMap((node) => {
      const at = endedAt.get(node.id);
      if (
        node.kind === 'session' &&
        at !== undefined &&
        node.status !== 'running' &&
        node.status !== 'waiting'
      ) {
        ended.push({ node, at });
        return [];
      }
      return [{ ...node, children: keep(node.children) }];
    });
  const live = { trees: keep(forest.trees), adhoc: keep(forest.adhoc) };
  return { live, ended: ended.sort((a, b) => b.at - a.at) };
}

/** The one session id names, without the task sessions under it; the whole forest for null. */
export function onlySession(forest: RunForest, id: string | null): RunForest {
  if (id === null) return forest;
  const find = (nodes: readonly RunNode[]): RunNode | null => {
    for (const node of nodes) {
      if (node.kind === 'subagent') continue;
      if (node.id === id) return node;
      const inner = find(node.children);
      if (inner) return inner;
    }
    return null;
  };
  const node = find([...forest.trees, ...forest.adhoc]);
  if (!node) return { trees: [], adhoc: [] };
  return {
    trees: [],
    adhoc: [{ ...node, children: node.children.filter((child) => child.kind === 'subagent') }],
  };
}
