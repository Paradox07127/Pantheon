import { z } from 'zod';
import type { AgentToolGroup } from '@pantheon/domain';

const str = z.string().min(1).max(65536);

/** The lead tools of the sessions and github profile groups, by tool name. */
export const appTools = {
  session_list: 'agent.sessions',
  session_read: 'agent.session_read',
  github_items: 'agent.github_items',
  github_pr: 'agent.github_pr',
} as const satisfies Record<string, string>;

/** What each app tool does; a costly one asks the user before every call. */
export const appToolEffects = {
  session_list: 'read',
  session_read: 'read',
  github_items: 'read',
  github_pr: 'read',
} as const satisfies Record<keyof typeof appTools, 'read' | 'write' | 'costly'>;

/** The agent profile tool group of each app tool. */
export const appToolGroups = {
  session_list: 'sessions',
  session_read: 'sessions',
  github_items: 'github',
  github_pr: 'github',
} as const satisfies Record<keyof typeof appTools, AgentToolGroup>;

export const appInputSchemas = {
  /** AgentSessionList; the project's listed sessions, optionally in one state. Resident leads only. */
  'agent.sessions': z.strictObject({
    state: z
      .string()
      .min(1)
      .max(40)
      .optional()
      .describe(
        'Keep only sessions in this state, written as the list shows it; leave it out for all.',
      ),
  }),
  /** AgentSessionRead; the state and last turns of one session of the project. Resident leads only. */
  'agent.session_read': z.strictObject({
    session_id: str.describe('The session id from session_list.'),
    turns: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe('How many of the last turns to read, 1-20; default 5.'),
  }),
  /** GithubItems for a resident lead, as github.items reads them. */
  'agent.github_items': z.strictObject({
    project_id: str,
    kind: z.enum(['pr', 'issue']).describe('pr for pull requests, issue for issues.'),
  }),
  /** GithubPullDetail for a resident lead, as github.pr.detail reads it. */
  'agent.github_pr': z.strictObject({
    project_id: str,
    number: z.coerce
      .number()
      .int()
      .min(1)
      .describe('The pull request number, as github_items lists it.'),
  }),
} as const satisfies Record<string, z.ZodType>;
