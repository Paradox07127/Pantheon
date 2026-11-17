import type { AgentProfile, Session } from '@pantheon/domain';
import type { Store } from '@pantheon/store';

export type AgentTemplate = Pick<AgentProfile, 'name' | 'role'> &
  Required<Pick<AgentProfile, 'tools' | 'listens'>> &
  Partial<Pick<AgentProfile, 'routines'>>;

const WEEK_MS = 7 * 24 * 60 * 60_000;

export const ASSISTANT_TEMPLATE: AgentTemplate = {
  name: 'Assistant',
  role: 'Main',
  tools: [
    'board',
    'dispatch',
    'memory',
    'browser',
    'always_on',
    'app',
    'sessions',
    'github',
    'agents',
  ],
  listens: [],
};

export const TRIAGE_TEMPLATE: AgentTemplate = {
  name: 'Triage',
  role: 'Bugs',
  tools: ['board', 'dispatch', 'memory', 'always_on', 'sessions', 'github'],
  listens: ['github'],
};

export const IDEAS_TEMPLATE: AgentTemplate = {
  name: 'Ideas',
  role: 'Ideas',
  tools: ['board', 'memory', 'always_on'],
  listens: [],
};

export const GOALS_TEMPLATE: AgentTemplate = {
  name: 'Goals',
  role: 'Goals',
  tools: ['board', 'memory', 'sessions', 'always_on'],
  listens: [],
  routines: [
    {
      id: 'weekly-review',
      prompt:
        'Compare each open milestone with the work done since the last review, and report what slipped or is stuck.',
      every_ms: WEEK_MS,
      enabled: true,
    },
  ],
};

export const CUSTOM_TEMPLATE: AgentTemplate = {
  name: 'Agent',
  role: 'Custom',
  tools: ['board', 'memory'],
  listens: [],
};

export const AGENT_TEMPLATES: Record<AgentProfile['template'], AgentTemplate> = {
  assistant: ASSISTANT_TEMPLATE,
  triage: TRIAGE_TEMPLATE,
  ideas: IDEAS_TEMPLATE,
  goals: GOALS_TEMPLATE,
  custom: CUSTOM_TEMPLATE,
};

/** The templates of which each project has exactly one agent, created with the project. */
export const BUILT_IN_TEMPLATES = ['assistant', 'triage'] as const;

/** The agent profile of a resident session, or its template's defaults while it has none. */
export function residentProfile(
  store: Store,
  resident: NonNullable<Session['resident']>,
): AgentTemplate & Pick<AgentProfile, 'instructions'> {
  const profile = resident.agent_id && store.get<AgentProfile>('agents', resident.agent_id);
  if (!profile) return AGENT_TEMPLATES[resident.kind];
  const defaults = AGENT_TEMPLATES[profile.template];
  return {
    ...profile,
    tools: profile.tools ?? defaults.tools,
    listens: profile.listens ?? defaults.listens,
  };
}
