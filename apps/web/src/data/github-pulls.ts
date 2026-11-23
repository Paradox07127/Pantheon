import type { GithubItems, GithubPullDetail } from '@pantheon/protocol';
import { useProjectQuery } from './project-read';

export type { GithubItem } from './code-refs';
export type { GithubItems, GithubPullDetail };

const isObject = (value: unknown) => typeof value === 'object' && value !== null;

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
