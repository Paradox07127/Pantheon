import type { WorkbenchSession } from '@pantheon/protocol';
import type { SessionFacts } from './call-rows';
import type { RunForest, RunNode } from './run-tree';

/** How long a session without live work stays on the runtime page after its last activity, ms. */
export const RECENT_MS = 60 * 60_000;

const LIVE: ReadonlySet<WorkbenchSession['state']> = new Set([
  'starting',
  'running',
  'waiting',
  'merging',
]);
const ENDED: ReadonlySet<WorkbenchSession['state']> = new Set(['merged', 'discarded', 'done']);

type Listed = Pick<WorkbenchSession, 'id' | 'state' | 'last_activity_at'>;

/**
 * The sessions live now or active within RECENT_MS of now, and the sessions that started one of
 * those, in list order; parents maps a session to the session that started it.
 */
export function runtimeSessions<S extends Listed>(
  sessions: readonly S[],
  parents: ReadonlyMap<string, string>,
  now: number,
): S[] {
  const shown = new Set(
    sessions
      .filter((s) => LIVE.has(s.state) || Date.parse(s.last_activity_at) >= now - RECENT_MS)
      .map((s) => s.id),
  );
  for (const id of [...shown])
    for (let up = parents.get(id); up !== undefined && !shown.has(up); up = parents.get(up))
      shown.add(up);
  return sessions.filter((s) => shown.has(s.id));
}

/** Each session's context, fork and the oldest permission request it waits on, by session id. */
export function sessionFacts(
  sessions: readonly Pick<
    WorkbenchSession,
    | 'id'
    | 'context'
    | 'forked_from'
    | 'waiting_kind'
    | 'waiting_request'
    | 'run'
    | 'last_activity_at'
  >[],
): ReadonlyMap<string, SessionFacts> {
  const facts = new Map<string, SessionFacts>();
  for (const s of sessions) {
    const asked =
      s.waiting_kind === 'approval' || s.waiting_kind === 'question'
        ? s.waiting_request?.id
        : undefined;
    facts.set(s.id, {
      context: s.context,
      forked: !!s.forked_from,
      waiting:
        asked !== undefined
          ? {
              // As approval.respond, which takes answers for this tool's request only.
              kind: s.waiting_request?.tool === 'AskUserQuestion' ? 'input' : 'approval',
              summary: (s.waiting_request?.detail ?? s.waiting_request?.tool ?? '').slice(0, 140),
              approval_id: asked,
              revision: s.waiting_request!.revision,
              since: s.run?.wait?.since ?? Date.parse(s.last_activity_at),
            }
          : undefined,
    });
  }
  return facts;
}

export interface EndedSession {
  node: RunNode;
  /** Its last activity, epoch ms. */
  at: number;
}

/**
 * The forest without the sessions merged, discarded or done that no longer run or wait, the
 * sessions they started kept in their place, and those sessions, the newest end first.
 */
export function splitEnded(
  forest: RunForest,
  sessions: readonly Listed[],
): { live: RunForest; ended: EndedSession[] } {
  const endedAt = new Map(
    sessions.flatMap((s) => (ENDED.has(s.state) ? [[s.id, Date.parse(s.last_activity_at)]] : [])),
  );
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
        return keep(node.children.filter((child) => child.kind === 'session'));
      }
      return [{ ...node, children: keep(node.children) }];
    });
  const live = { trees: keep(forest.trees), adhoc: keep(forest.adhoc) };
  return { live, ended: ended.sort((a, b) => b.at - a.at) };
}

/** The one session id names, without the sessions it started; the whole forest for null. */
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
