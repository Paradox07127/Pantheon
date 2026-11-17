import { z } from 'zod';
import type { AgentToolGroup } from '@pantheon/domain';

const str = z.string().min(1).max(65536);

/** The lead tools of the app, sessions and github profile groups, by tool name. */
export const appTools = {
  app_help: 'agent.app_help',
  session_list: 'agent.sessions',
  session_read: 'agent.session_read',
  github_items: 'agent.github_items',
  github_pr: 'agent.github_pr',
} as const satisfies Record<string, string>;

/** What each app tool does; a costly one asks the user before every call. */
export const appToolEffects = {
  app_help: 'read',
  session_list: 'read',
  session_read: 'read',
  github_items: 'read',
  github_pr: 'read',
} as const satisfies Record<keyof typeof appTools, 'read' | 'write' | 'costly'>;

/** The agent profile tool group of each app tool. */
export const appToolGroups = {
  app_help: 'app',
  session_list: 'sessions',
  session_read: 'sessions',
  github_items: 'github',
  github_pr: 'github',
} as const satisfies Record<keyof typeof appTools, AgentToolGroup>;

export const appInputSchemas = {
  /** AppHelp; the command groups and screens, or one group's commands and the tools that call them. Resident leads only. */
  'agent.app_help': z.strictObject({ topic: z.string().min(1).max(200).optional() }),
  /** AgentSessionList; the project's listed sessions, optionally in one state. Resident leads only. */
  'agent.sessions': z.strictObject({ state: z.string().min(1).max(40).optional() }),
  /** AgentSessionRead; the state and last turns of one session of the project. Resident leads only. */
  'agent.session_read': z.strictObject({
    session_id: str,
    turns: z.number().int().min(1).max(20).default(5),
  }),
  /** GithubItems for a resident lead, as github.items reads them. */
  'agent.github_items': z.strictObject({ project_id: str, kind: z.enum(['pr', 'issue']) }),
  /** GithubPullDetail for a resident lead, as github.pr.detail reads it. */
  'agent.github_pr': z.strictObject({
    project_id: str,
    number: z.coerce.number().int().min(1),
  }),
} as const satisfies Record<string, z.ZodType>;
