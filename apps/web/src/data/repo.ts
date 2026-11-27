import type { LandingDiff, RepoCommit, RepoCommitAfter, RepoLog } from '@pantheon/protocol';
import { REPOSITORY_KINDS, useProjectQuery } from './project-read';

export type { LandingDiff, RepoCommit, RepoCommitAfter, RepoLog };

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
