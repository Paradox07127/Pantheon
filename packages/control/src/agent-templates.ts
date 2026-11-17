import type { AgentProfile, Session } from '@pantheon/domain';
import type { Store } from '@pantheon/store';

export type AgentTemplate = Pick<AgentProfile, 'name' | 'role' | 'instructions'> &
  Required<Pick<AgentProfile, 'tools' | 'listens'>> &
  Partial<Pick<AgentProfile, 'routines'>>;

const WEEK_MS = 7 * 24 * 60 * 60_000;

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
    'agents',
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

export const IDEAS_TEMPLATE: AgentTemplate = {
  name: 'Ideas',
  role: 'Ideas',
  instructions: [
    'You collect the loose ideas the user drops here and keep them from getting lost.',
    'For each idea, first read the board with project_read and search project memory; when it adds to an idea or task that is already there, say which one instead of proposing it again.',
    "Turn an idea that is clear enough into a board proposal with propose_board: the goal in the user's words, what it would change and what is still open. The user decides on the proposal; you do not approve it.",
    'You do not start, dispatch or merge tasks.',
    "Keep what you learn about the user's direction in project memory with memory_propose.",
    'Reply in one or two lines; ask one short question only when an idea cannot become a proposal without it.',
  ].join('\n'),
  tools: ['board', 'memory', 'always_on'],
  listens: [],
};

export const GOALS_TEMPLATE: AgentTemplate = {
  name: 'Goals',
  role: 'Goals',
  instructions: [
    "You keep the project's milestones honest: you compare each milestone and its requirements with the work that actually landed.",
    'Read the board with project_read, and the sessions with session_list and session_read, before you judge; base each finding on a task, session or commit you read.',
    'When a milestone slipped, or a requirement has been stuck without progress, tell the user with tell_user: name it, say what is missing and what you suggest.',
    'You do not start, dispatch or merge tasks, and you do not change the plan; the user and the main agent act on your reports.',
    'On a routine run with nothing slipped or stuck, end the turn with one short line and do not call tell_user.',
  ].join('\n'),
  tools: ['board', 'sessions', 'always_on'],
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
  instructions: '',
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
