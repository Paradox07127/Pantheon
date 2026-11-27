import type { RepoCommit } from '@pantheon/protocol';

/** Columns past this many share the last one. */
export const MAX_COLUMNS = 8;

/** A line from a commit's row down to one of its parents. */
export interface GraphEdge {
  /** Row of the commit. */
  child: number;
  /** Row of the parent; null while the parent is not in the list. */
  parent: number | null;
  /** The commit's column. */
  from: number;
  /** The column the line runs down between the two rows. */
  lane: number;
  /** The parent's column; the lane while the parent is not in the list. */
  to: number;
}

export interface CommitGraphLayout {
  /** Each commit's column, in list order. */
  columns: number[];
  edges: GraphEdge[];
  /** Columns in use. */
  width: number;
}

/**
 * Lays out commits listed newest first: a first parent stays in its child's column, every other
 * parent opens a column, and a column frees up once its line ends.
 */
export function layoutCommitGraph(
  commits: readonly Pick<RepoCommit, 'sha' | 'parents'>[],
): CommitGraphLayout {
  // The commits each column waits for; more than one only in the last column once all are taken.
  const lanes: Set<string>[] = [];
  // A column whose line ends on this row is free from the next row on.
  const open = (ending: ReadonlySet<number> = new Set()) => {
    const free = lanes.findIndex((lane, i) => lane.size === 0 && !ending.has(i));
    if (free >= 0) return free;
    if (lanes.length < MAX_COLUMNS) return lanes.push(new Set()) - 1;
    return MAX_COLUMNS - 1;
  };
  const waiting = (sha: string) => lanes.findIndex((lane) => lane.has(sha));
  const columns: number[] = [];
  const edges: GraphEdge[] = [];
  const rowOf = new Map(commits.map((c, i) => [c.sha, i]));
  commits.forEach((commit, row) => {
    const expected = waiting(commit.sha);
    const column = expected >= 0 ? expected : open();
    const ending = new Set<number>();
    lanes.forEach((lane, i) => {
      if (lane.delete(commit.sha) && lane.size === 0 && i !== column) ending.add(i);
    });
    columns.push(column);
    commit.parents.forEach((sha, i) => {
      const already = waiting(sha);
      const lane = i === 0 ? column : already >= 0 ? already : open(ending);
      lanes[lane]!.add(sha);
      const parent = rowOf.get(sha);
      edges.push({
        child: row,
        parent: parent !== undefined && parent > row ? parent : null,
        from: column,
        lane,
        to: lane,
      });
    });
  });
  for (const edge of edges) if (edge.parent !== null) edge.to = columns[edge.parent]!;
  return { columns, edges, width: lanes.length };
}
