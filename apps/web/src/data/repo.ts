import type {
  GithubItems,
  GithubPullDetail,
  LandingDiff,
  RepoBlame,
  RepoCommitAfter,
  RepoConflict,
  RepoFileHistory,
  RepoCompare,
  RepoLog,
  RepoStatus,
  RepoTimeline,
  RepoWorktree,
} from '@pantheon/protocol';
import { REPOSITORY_KINDS, WORKTREE_KINDS, useProjectQuery } from './project-read';

export type {
  GithubItems,
  GithubPullDetail,
  LandingDiff,
  RepoBlame,
  RepoCommitAfter,
  RepoConflict,
  RepoFileHistory,
  RepoCompare,
  RepoLog,
  RepoStatus,
  RepoTimeline,
  RepoWorktree,
};

const isObject = (value: unknown) => typeof value === 'object' && value !== null;

/** GET /v1/repo.worktrees; the project repository's worktrees, the project folder first. */
export const useRepoWorktrees = (projectId: string | null) =>
  useProjectQuery<RepoWorktree[]>('repo.worktrees', projectId, Array.isArray, undefined, {
    kinds: REPOSITORY_KINDS,
  });

/** GET /v1/repo.status for one worktree path from useRepoWorktrees. */
export const useRepoStatus = (projectId: string | null, path: string) =>
  useProjectQuery<RepoStatus>(
    'repo.status',
    projectId,
    (value) => isObject(value) && Array.isArray((value as RepoStatus).files),
    { path },
    { kinds: WORKTREE_KINDS },
  );

/** GET /v1/repo.log; newest first, `limit` commits after skipping `skip`. */
export const useRepoLog = (projectId: string | null, limit: number, skip = 0, ref?: string) =>
  useProjectQuery<RepoLog>(
    'repo.log',
    projectId,
    (value) => isObject(value) && Array.isArray((value as RepoLog).commits),
    { limit: String(limit), skip: String(skip), ...(ref !== undefined ? { ref } : {}) },
    { kinds: REPOSITORY_KINDS },
  );

/** GET /v1/repo.commit_diff; one commit against its first parent. */
export const useRepoCommitDiff = (projectId: string | null, sha: string) =>
  useProjectQuery<LandingDiff>(
    'repo.commit_diff',
    projectId,
    (value) => isObject(value) && Array.isArray((value as LandingDiff).files),
    { sha },
    { kinds: REPOSITORY_KINDS },
  );

/** GET /v1/repo.commit_after; the gate, later changes and upstream state after one commit. */
export const useRepoCommitAfter = (projectId: string | null, sha: string) =>
  useProjectQuery<RepoCommitAfter>(
    'repo.commit_after',
    projectId,
    (value) => isObject(value) && Array.isArray((value as RepoCommitAfter).later),
    { sha },
    { kinds: REPOSITORY_KINDS },
  );

/** GET /v1/repo.compare; head from its merge base with base. */
export const useRepoCompare = (projectId: string | null, base: string, head: string) =>
  useProjectQuery<RepoCompare>(
    'repo.compare',
    projectId,
    (value) => isObject(value) && Array.isArray((value as RepoCompare).files),
    { base, head },
    { kinds: REPOSITORY_KINDS },
  );

/** GET /v1/repo.timeline; lanes over [from, to) in ms, plus the whole history by week. */
export const useRepoTimeline = (
  projectId: string | null,
  from: number,
  to: number,
  group: 'workstream' | 'branch' | 'author',
) =>
  useProjectQuery<RepoTimeline>(
    'repo.timeline',
    projectId,
    (value) => isObject(value) && Array.isArray((value as RepoTimeline).lanes),
    { from: String(from), to: String(to), group },
  );

/** GET /v1/repo.blame; which commit, and session, last wrote each line of one file. */
export const useRepoBlame = (projectId: string | null, path: string) =>
  useProjectQuery<RepoBlame>(
    'repo.blame',
    projectId,
    (value) => isObject(value) && Array.isArray((value as RepoBlame).chunks),
    { path },
    { kinds: REPOSITORY_KINDS },
  );

/** GET /v1/repo.file_history; one file's recent commits, weekly changes and co-changed files. */
export const useRepoFileHistory = (projectId: string | null, path: string) =>
  useProjectQuery<RepoFileHistory>(
    'repo.file_history',
    projectId,
    (value) => isObject(value) && Array.isArray((value as RepoFileHistory).changes),
    { path },
    { kinds: REPOSITORY_KINDS },
  );

/** GET /v1/github.items for open pull requests. */
export const useGithubPulls = (projectId: string | null) =>
  useProjectQuery<GithubItems>(
    'github.items',
    projectId,
    (value) => isObject(value) && Array.isArray((value as GithubItems).items),
    { kind: 'pr' },
  );

/** GET /v1/github.pr.detail; one pull request's checks and review threads. */
export const useGithubPullDetail = (projectId: string | null, number: number) =>
  useProjectQuery<GithubPullDetail>(
    'github.pr.detail',
    projectId,
    (value) => isObject(value) && Array.isArray((value as GithubPullDetail).checks),
    { number: String(number) },
  );

// Git's C-style escapes; other control characters become three octal digits.
const ESCAPES: Partial<Record<string, string>> = {
  '\u0007': 'a',
  '\b': 'b',
  '\t': 't',
  '\n': 'n',
  '\v': 'v',
  '\f': 'f',
  '\r': 'r',
  '"': '"',
  '\\': '\\',
};

const quoted = (char: string): boolean => char in ESCAPES || char < ' ' || char === '\u007f';

/** A path as git writes it in patch headers, quoted once it holds a quote, backslash or control character. */
function gitPath(path: string): string {
  const chars = [...path];
  if (!chars.some(quoted)) return path;
  const body = chars.map((c) =>
    quoted(c) ? `\\${ESCAPES[c] ?? c.charCodeAt(0).toString(8).padStart(3, '0')}` : c,
  );
  return `"${body.join('')}"`;
}

/** The diff's hunks written back as git patch text, file by file; null when it was truncated. */
export function landingPatch(diff: LandingDiff): string | null {
  if (diff.truncated) return null;
  return diff.files
    .map((f) => {
      const old = f.old_path ?? f.path;
      const head = [`diff --git ${gitPath(`a/${old}`)} ${gitPath(`b/${f.path}`)}`];
      if (f.status === 'added') head.push('new file mode 100644');
      if (f.status === 'deleted') head.push('deleted file mode 100644');
      if (f.status === 'renamed')
        head.push(`rename from ${gitPath(old)}`, `rename to ${gitPath(f.path)}`);
      head.push(
        f.status === 'added' ? '--- /dev/null' : `--- ${gitPath(`a/${old}`)}`,
        f.status === 'deleted' ? '+++ /dev/null' : `+++ ${gitPath(`b/${f.path}`)}`,
      );
      const hunks = diff.hunks.filter((h) => h.file === f.path).flatMap((h) => [h.header, h.text]);
      return [...head, ...hunks].join('\n') + '\n';
    })
    .join('');
}
