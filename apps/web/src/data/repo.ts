import type {
  LandingDiff,
  ProjectBranch,
  RepoBlame,
  RepoCommit,
  RepoCommitAfter,
  RepoCompare,
  RepoFileHistory,
  RepoLog,
} from '@pantheon/protocol';
import { REPOSITORY_KINDS, useProjectQuery } from './project-read';

export type {
  LandingDiff,
  ProjectBranch,
  RepoBlame,
  RepoCommit,
  RepoCommitAfter,
  RepoCompare,
  RepoFileHistory,
  RepoLog,
};

const isObject = (value: unknown) => typeof value === 'object' && value !== null;

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

/** GET /v1/repo.commit_after; the next commit on HEAD's first-parent line. */
export const useRepoCommitAfter = (projectId: string | null, sha: string) =>
  useProjectQuery<RepoCommitAfter>(
    'repo.commit_after',
    projectId,
    (value) => isObject(value) && 'next' in value,
    { sha },
    { kinds: REPOSITORY_KINDS },
  );

/** GET /v1/repo.blame; the file as `ref` has it, the first folder's HEAD without one. */
export const useRepoBlame = (projectId: string | null, path: string, ref?: string) =>
  useProjectQuery<RepoBlame>(
    'repo.blame',
    projectId,
    (value) =>
      isObject(value) &&
      Array.isArray((value as RepoBlame).chunks) &&
      Array.isArray((value as RepoBlame).pending),
    { path, ...(ref !== undefined ? { ref } : {}) },
    { kinds: REPOSITORY_KINDS },
  );

/** GET /v1/repo.file_history; the file's latest commits, weekly counts and the files changed with it. */
export const useRepoFileHistory = (projectId: string | null, path: string) =>
  useProjectQuery<RepoFileHistory>(
    'repo.file_history',
    projectId,
    (value) =>
      isObject(value) &&
      Array.isArray((value as RepoFileHistory).changes) &&
      Array.isArray((value as RepoFileHistory).weekly) &&
      Array.isArray((value as RepoFileHistory).cochange),
    { path },
    { kinds: REPOSITORY_KINDS },
  );

/** GET /v1/repo.compare; head against base from their merge base. */
export const useRepoCompare = (projectId: string | null, base: string, head: string) =>
  useProjectQuery<RepoCompare>(
    'repo.compare',
    projectId,
    (value) =>
      isObject(value) &&
      Array.isArray((value as RepoCompare).files) &&
      typeof (value as RepoCompare).ahead === 'number',
    { base, head },
    { kinds: REPOSITORY_KINDS },
  );

/** GET /v1/project.branches of the first folder; newest commit first. */
export const useRepoBranches = (projectId: string | null) =>
  useProjectQuery<ProjectBranch[]>('project.branches', projectId, Array.isArray, undefined, {
    kinds: REPOSITORY_KINDS,
  });
