import type { RepoWorktree } from '../../../data/repo';
import type { StaleWorkspaces } from '../../../data/worktree-setup';

export const shortSha = (sha: string) => sha.slice(0, 7);

/** The worktree's branch, or its short sha when HEAD is detached. */
export const worktreeLabel = (w: RepoWorktree) => w.branch ?? shortSha(w.head_sha);

/** Paths of the two compared worktrees; null until the reader picks one. */
export interface PickedSides {
  base: string | null;
  head: string | null;
}

/** main: the picked worktree against the first folder's HEAD; pair: two picked worktrees. */
export type CompareMode = 'main' | 'pair';

/**
 * Head is the picked worktree, else the first session worktree. Base is the project's checkout
 * against main; in a pair the picked one, else another session worktree.
 */
export function compareSides(
  worktrees: readonly RepoWorktree[],
  picked: PickedSides,
  mode: CompareMode,
) {
  const at = (path: string | null) => worktrees.find((w) => w.path === path);
  const main = worktrees.find((w) => w.kind === 'checkout') ?? worktrees[0];
  const head =
    at(picked.head) ??
    worktrees.find((w) => w.kind === 'session' && w !== main) ??
    worktrees.find((w) => w !== main);
  if (mode === 'main') return { base: main, head };
  const base = at(picked.base) ?? worktrees.find((w) => w.kind === 'session' && w !== head) ?? main;
  return { base, head };
}

/** Paths both diffs change. */
export function bothChanged(
  a: readonly { path: string }[],
  b: readonly { path: string }[],
): string[] {
  const other = new Set(b.map((f) => f.path));
  return a.filter((f) => other.has(f.path)).map((f) => f.path);
}

/** Changed paths of head that no listed shared file names. */
export function singleOwnerPaths(
  files: readonly { path: string }[],
  shared: StaleWorkspaces['shared_files'],
): string[] {
  const many = new Set((shared?.files ?? []).map((f) => f.path));
  return files.filter((f) => !many.has(f.path)).map((f) => f.path);
}

/** Shared files a compared session changes, and those of the sessions that change one of them. */
export function overlapOf(
  shared: StaleWorkspaces['shared_files'],
  sessions: readonly string[],
): { rows: { path: string; session_ids: string[] }[]; columns: string[] } {
  const rows = (shared?.files ?? []).filter((f) =>
    f.session_ids.some((id) => sessions.includes(id)),
  );
  const columns = sessions.filter((id) => rows.some((f) => f.session_ids.includes(id)));
  return { rows, columns };
}
