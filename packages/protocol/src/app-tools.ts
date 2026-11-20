import { z } from 'zod';
import type { AgentToolGroup, SignalIssue } from '@pantheon/domain';
import { SIGNAL_SOURCES } from './agent-tools.js';

const str = z.string().min(1).max(65536);
const SIGNAL_STATES = [
  'new',
  'ongoing',
  'escalating',
  'regressed',
  'holding',
  'resolved',
  'muted',
] as const satisfies readonly SignalIssue['state'][];

/** The lead tools of the sessions, github and signals profile groups, by tool name. */
export const appTools = {
  session_list: 'agent.sessions',
  session_read: 'agent.session_read',
  github_items: 'agent.github_items',
  github_pr: 'agent.github_pr',
  signal_list: 'agent.signals',
  signal_read: 'agent.signal_read',
} as const satisfies Record<string, string>;

/** What each app tool does; a costly one asks the user before every call. */
export const appToolEffects = {
  session_list: 'read',
  session_read: 'read',
  github_items: 'read',
  github_pr: 'read',
  signal_list: 'read',
  signal_read: 'read',
} as const satisfies Record<keyof typeof appTools, 'read' | 'write' | 'costly'>;

/** The agent profile tool group of each app tool. */
export const appToolGroups = {
  session_list: 'sessions',
  session_read: 'sessions',
  github_items: 'github',
  github_pr: 'github',
  signal_list: 'signals',
  signal_read: 'signals',
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
  /** SignalIssue[] without samples; the project's signal issues, optionally of one state and source. Resident leads only. */
  'agent.signals': z.strictObject({
    state: z
      .enum(SIGNAL_STATES)
      .optional()
      .describe('Keep only issues in this state; leave it out for all.'),
    source: z
      .enum(SIGNAL_SOURCES)
      .optional()
      .describe('Keep only issues from this source; leave it out for all.'),
  }),
  /** SignalIssue; one signal issue of the project with its samples. Resident leads only. */
  'agent.signal_read': z.strictObject({
    id: str.describe('The issue id from signal_list.'),
  }),
} as const satisfies Record<string, z.ZodType>;
