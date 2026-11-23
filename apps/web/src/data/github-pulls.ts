import type { GithubItems, GithubPullDetail } from '@pantheon/protocol';
import { useProjectQuery } from './project-read';

export type { GithubItem } from './code-refs';
export type { GithubItems, GithubPullDetail };

const isObject = (value: unknown) => typeof value === 'object' && value !== null;

/**
 * Event kinds after which the project's pull requests may differ; checks and reviews change on
 * GitHub with no event, so the reads also follow window focus.
 */
const PULL_KINDS: ReadonlySet<string> = new Set(['session.pr_created']);

/** GET /v1/github.items for open pull requests. */
export const useGithubPulls = (projectId: string | null) =>
  useProjectQuery<GithubItems>(
    'github.items',
    projectId,
    (value) => isObject(value) && Array.isArray((value as GithubItems).items),
    { kind: 'pr' },
    { kinds: PULL_KINDS },
  );

/** GET /v1/github.pr.detail; one pull request's checks and review threads. */
export const useGithubPullDetail = (projectId: string | null, number: number) =>
  useProjectQuery<GithubPullDetail>(
    'github.pr.detail',
    projectId,
    (value) => isObject(value) && Array.isArray((value as GithubPullDetail).checks),
    { number: String(number) },
    { kinds: PULL_KINDS },
  );
