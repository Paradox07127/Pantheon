import { z } from 'zod';
import type { AgentToolGroup, EffortLevel, SignalSource } from '@pantheon/domain';

const str = z.string().min(1).max(65536);
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
// index.ts imports this file before it defines EFFORT_LEVELS.
const EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const satisfies readonly EffortLevel[];

/** The lead tools of the agents profile group, by tool name. */
export const agentTools = {
  list_agents: 'agent.agents',
  propose_agent: 'agent.propose',
} as const satisfies Record<string, string>;

/** What each agents tool does; a costly one asks the user before every call. */
export const agentToolEffects = {
  list_agents: 'read',
  propose_agent: 'write',
} as const satisfies Record<keyof typeof agentTools, 'read' | 'write' | 'costly'>;

/** The agent profile tool group of each agents tool. */
export const agentToolGroups = {
  list_agents: 'agents',
  propose_agent: 'agents',
} as const satisfies Record<keyof typeof agentTools, AgentToolGroup>;

export const AGENT_TEMPLATE_NAMES = ['assistant', 'triage', 'ideas', 'goals', 'custom'] as const;
export const AGENT_TOOL_GROUPS = [
  'board',
  'dispatch',
  'memory',
  'browser',
  'app',
  'sessions',
  'github',
  'always_on',
  'agents',
  'signals',
] as const satisfies readonly AgentToolGroup[];
export const SIGNAL_SOURCES = [
  'gate_failures',
  'flaky_tests',
  'app_errors',
  'session_failures',
  'trace_findings',
] as const satisfies readonly SignalSource[];
export const AGENT_EVENT_SOURCES = ['github', ...SIGNAL_SOURCES] as const;

// The daemon checks that a routine has exactly one of every_minutes and at.
const routineInput = z.strictObject({
  id: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/)
    .optional(),
  prompt: z.string().min(1).max(2000),
  every_minutes: z.number().int().min(60).optional(),
  at: clockTime.optional(),
  active_hours: z.strictObject({ from: clockTime, to: clockTime }).optional(),
  enabled: z.boolean(),
});

/** The fields of an agent profile that agent.update changes and agent.propose may propose. */
const changeFields = {
  name: z.string().min(1).max(80).optional(),
  role: z.string().min(1).max(24).optional(),
  instructions: z.string().min(1).max(20000).optional(),
  brief: z.string().min(1).max(4000).optional(),
  tools: z.array(z.enum(AGENT_TOOL_GROUPS)).max(AGENT_TOOL_GROUPS.length).optional(),
  listens: z.array(z.enum(AGENT_EVENT_SOURCES)).max(AGENT_EVENT_SOURCES.length).optional(),
  runtime: str.optional(),
  model: str.optional(),
  effort: z.enum(EFFORTS).optional(),
  routines: z.array(routineInput).max(10).optional(),
};

const createFields = {
  ...changeFields,
  template: z.enum(AGENT_TEMPLATE_NAMES),
  name: z.string().min(1).max(80),
  role: z.string().min(1).max(24),
};

export const agentInputSchemas = {
  /** AgentProfile; the user only. Creates an ideas, goals or custom agent of the project with its routines; its session opens on its first message or trigger. */
  'agent.create': z.strictObject({ project_id: str, ...createFields }),
  /** The user only; changes an agent profile at its revision. A new model or effort applies to its open session, a new runtime ends it between turns and opens a successor; routines replace the list. Returns the AgentProfile. */
  'agent.update': z.strictObject({
    agent_id: str,
    revision: z.number().int().positive(),
    ...changeFields,
  }),
  /** AgentProfile; the user only. Ends the agent's idle session and its routines; the assistant cannot be archived. */
  'agent.archive': z.strictObject({ agent_id: str }),
  /** AgentProfile; the user only. Runs the agent's enabled routines again. */
  'agent.unarchive': z.strictObject({ agent_id: str }),
  /** AgentProposal; proposes a new agent with the agent.create fields, or with agent_id a change of the given fields, for the user to decide on. Resident leads with the agents group only. */
  'agent.propose': z.strictObject({
    project_id: str,
    agent_id: str.optional(),
    ...changeFields,
    template: z.enum(AGENT_TEMPLATE_NAMES).optional(),
  }),
  /** Guide, the text of the named guide, or GuideList, the name and use of each guide, for a name it does not know. Lead sessions only. */
  'agent.guide': z.strictObject({ name: z.string().min(1).max(80) }),
  /** AgentList; the project's agents with their role, tools and routines. Resident leads with the agents group only. */
  'agent.agents': z.strictObject({ project_id: str }),
  /** AgentProposal; the user only. create applies the proposal with fields over it, decline turns it down; the proposing agent is told either way. */
  'agent.proposal.resolve': z.strictObject({
    proposal_id: str,
    decision: z.enum(['create', 'decline']),
    fields: z.strictObject(changeFields).optional(),
  }),
} as const satisfies Record<string, z.ZodType>;
