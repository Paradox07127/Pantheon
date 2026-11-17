import type { AgentProfile, Session } from '@pantheon/domain';
import type { Store } from '@pantheon/store';

export type AgentTemplate = Pick<AgentProfile, 'name' | 'role' | 'instructions'> &
  Required<Pick<AgentProfile, 'tools' | 'listens'>>;

export const ASSISTANT_TEMPLATE: AgentTemplate = {
  name: 'Assistant',
  role: 'Main',
  instructions: [
    "You are the main agent of this project and the user's first point of contact.",
    'Answer questions from the code, the board and project memory; read before you ask.',
    'When you see a problem the user has not raised, such as a failing gate, a stalled task or a risky change, tell the user and propose what to do.',
    'Turn each request that changes the repository into a plan and dispatch it; you do not change code yourself.',
    'After you dispatch work, follow it through the board updates Pantheon sends you, and handle each one before the next request.',
    'Speak up when something needs the user or a request finished; when a board update needs nothing from the user, end the turn with one short line.',
  ].join('\n'),
  tools: [
    'board',
    'dispatch',
    'memory',
    'browser',
    'app_debug',
    'always_on',
    'app',
    'sessions',
    'github',
  ],
  listens: [],
};

export const TRIAGE_TEMPLATE: AgentTemplate = {
  name: 'Triage',
  role: 'Bugs',
  instructions: [
    'You own the GitHub issues, gate failures and error reports that reach this project.',
    'For each one, first check whether your plan already has a task for the same problem, and only then start tasks. Give each task for an external request the subject its note names as external_subject.',
    'Tell the user when a report needs their decision or its fix has merged; otherwise end the turn with one short line.',
  ].join('\n'),
  tools: ['board', 'dispatch', 'memory', 'always_on', 'sessions', 'github'],
  listens: ['github'],
};

export const AGENT_TEMPLATES: Record<AgentProfile['template'], AgentTemplate> = {
  assistant: ASSISTANT_TEMPLATE,
  triage: TRIAGE_TEMPLATE,
};

/** The agent profile of a resident session, or its template's defaults while it has none. */
export function residentProfile(
  store: Store,
  resident: NonNullable<Session['resident']>,
): AgentTemplate {
  const profile = resident.agent_id && store.get<AgentProfile>('agents', resident.agent_id);
  if (!profile) return AGENT_TEMPLATES[resident.kind];
  const defaults = AGENT_TEMPLATES[profile.template];
  return {
    ...profile,
    tools: profile.tools ?? defaults.tools,
    listens: profile.listens ?? defaults.listens,
  };
}
