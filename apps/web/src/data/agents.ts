import { useSyncExternalStore } from 'react';
import {
  ChartGantt,
  CircleAlert,
  CircleDot,
  Flag,
  ShieldCheck,
  Terminal,
  type LucideIcon,
} from 'lucide-react';
import type {
  AgentLedgerWeek,
  AgentProfile,
  AgentProposal,
  AgentRoutineRow,
  AgentToolGroup,
  AgentWake,
} from '@pantheon/protocol';
import { t } from '../i18n';
import { useBoard } from './board';
import { useProjectQuery } from './project-read';
import { useQuery } from './workbench-sessions';

export type {
  AgentLedgerWeek,
  AgentProfile,
  AgentProposal,
  AgentRoutineRow,
  AgentToolGroup,
  AgentWake,
};
export type AgentRoutine = AgentProfile['routines'][number];
export type EventSource = NonNullable<AgentProfile['listens']>[number];
/** A profile as agent.list returns it, with the built-in role prompt of its template and what it works with. */
export type AgentListed = AgentProfile & {
  role_prompt: string;
  effective_tools: AgentToolGroup[];
  effective_listens: EventSource[];
};
/** The templates a new agent is created from; assistant and triage come with the project. */
export type CreatedTemplate = 'ideas' | 'goals' | 'custom';

/** A template's defaults, as agent.templates lists them. */
export interface AgentTemplateDefaults {
  template: CreatedTemplate;
  name: string;
  role: string;
  tools: AgentToolGroup[];
  listens: EventSource[];
  routines: AgentRoutine[];
  role_prompt: string;
}

/** A template's name in the interface's language. */
export function templateName(template: AgentProfile['template']): string {
  switch (template) {
    case 'assistant':
      return t({ id: 'sessions.agents.template.assistant', defaultMessage: 'Assistant' });
    case 'triage':
      return t({ id: 'sessions.agents.template.triage', defaultMessage: 'Triage' });
    case 'ideas':
      return t({ id: 'sessions.agents.template.ideas', defaultMessage: 'Ideas' });
    case 'goals':
      return t({ id: 'sessions.agents.template.goals', defaultMessage: 'Goals' });
    default:
      return t({ id: 'sessions.agents.template.custom', defaultMessage: 'Custom' });
  }
}

/** The names the built-in agents are created with. */
export const BUILT_IN_NAMES: Readonly<Record<string, string>> = {
  assistant: 'Assistant',
  triage: 'Triage',
};

/** An agent's name; a built-in agent with the name it was created with shows it in the interface's language. */
export function agentName(agent: Pick<AgentProfile, 'template' | 'name'>): string {
  return agent.name === BUILT_IN_NAMES[agent.template] ? templateName(agent.template) : agent.name;
}

/** The tool groups an agent of the user may get; the agents group stays the assistant's. */
export const OFFERED_TOOLS: readonly AgentToolGroup[] = [
  'board',
  'dispatch',
  'memory',
  'browser',
  'app',
  'sessions',
  'github',
  'always_on',
];

/** The event sources an agent may listen to. */
export const OFFERED_LISTENS: readonly EventSource[] = [
  'github',
  'gate_failures',
  'flaky_tests',
  'app_errors',
  'session_failures',
  'trace_findings',
];

/** The icon of each event source, in the profile's listens and on the signals list. */
export const SOURCE_ICONS: Readonly<Record<EventSource, LucideIcon>> = {
  github: CircleDot,
  gate_failures: ShieldCheck,
  flaky_tests: Flag,
  app_errors: CircleAlert,
  session_failures: Terminal,
  trace_findings: ChartGantt,
};

/** What listening to the source brings, in the interface's language. */
export function listenName(source: EventSource): string {
  switch (source) {
    case 'github':
      return t({ id: 'sessions.agents.listen.github', defaultMessage: 'GitHub' });
    case 'gate_failures':
      return t({ id: 'sessions.agents.listen.gateFailures', defaultMessage: 'Gate failures' });
    case 'flaky_tests':
      return t({ id: 'sessions.agents.listen.flakyTests', defaultMessage: 'Flaky tests' });
    case 'app_errors':
      return t({ id: 'sessions.agents.listen.appErrors', defaultMessage: 'App errors' });
    case 'session_failures':
      return t({
        id: 'sessions.agents.listen.sessionFailures',
        defaultMessage: 'Session failures',
      });
    default:
      return t({ id: 'sessions.agents.listen.traceFindings', defaultMessage: 'Trace findings' });
  }
}

/** Every write of a profile records one of these. */
const AGENT_KINDS: ReadonlySet<string> = new Set([
  'agent_profile.created',
  'agent_profile.updated',
]);

/** The project's agents from agent.list, archived ones included; null until read. */
export function useAgents(projectId: string | null): AgentListed[] | null {
  return useProjectQuery<AgentListed[]>('agent.list', projectId, Array.isArray, undefined, {
    kinds: AGENT_KINDS,
  }).read;
}

/** A read of an agent's activity; data is null until read. */
export interface AgentRead<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** A wake is a turn: these change what the wakes, routine runs and the week's ledger show. */
const TURN_KINDS: ReadonlySet<string> = new Set([
  'turn.queued',
  'turn.running',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
]);
const LEDGER_KINDS: ReadonlySet<string> = new Set([...TURN_KINDS, 'session.merged']);
const ROUTINE_KINDS: ReadonlySet<string> = new Set([...TURN_KINDS, ...AGENT_KINDS]);

/** Sequence of the project's newest event of one of `kinds`; 0 when none. */
const useNewest = (projectId: string, kinds: ReadonlySet<string>) =>
  useBoard(
    (s) => s.events.findLast((e) => e.project_id === projectId && kinds.has(e.kind))?.sequence ?? 0,
  );

/** The agent's newest wakes, newest first; read again when one of the project's turns moves. */
export function useAgentWakes(
  projectId: string,
  agentId: string,
  limit: number,
): AgentRead<AgentWake[]> {
  return useQuery<AgentWake[]>(
    'agent.wakes',
    agentId,
    (agent_id) => ({ agent_id, limit: String(limit) }),
    (value) => (Array.isArray(value) ? (value as AgentWake[]) : null),
    useNewest(projectId, TURN_KINDS),
  );
}

/** What the agent did in the last seven days, read again when a turn moves or a session merges. */
export function useAgentLedger(projectId: string, agentId: string): AgentRead<AgentLedgerWeek> {
  const read = useQuery<AgentLedgerWeek[]>(
    'agent.ledger',
    agentId,
    (agent_id) => ({ agent_id, weeks: '1' }),
    (value) => (Array.isArray(value) && value.length > 0 ? (value as AgentLedgerWeek[]) : null),
    useNewest(projectId, LEDGER_KINDS),
  );
  return { ...read, data: read.data?.[0] ?? null };
}

/** The routines of one agent with their next and last runs. */
export function useAgentRoutines(projectId: string, agentId: string): AgentRead<AgentRoutineRow[]> {
  const read = useProjectQuery<AgentRoutineRow[]>(
    'agent.routines',
    projectId,
    Array.isArray,
    undefined,
    {
      kinds: ROUTINE_KINDS,
    },
  );
  return {
    data: read.read?.filter((row) => row.agent_id === agentId) ?? null,
    loading: read.loading,
    error: read.error,
    reload: read.reload,
  };
}

/** The proposal as the daemon stores it, read again once it is decided; null until read. */
export function useAgentProposal(id: string | null): AgentProposal | null {
  const resolved = useBoard((s) =>
    id
      ? (s.events.findLast((e) => e.kind === 'agent_proposal.resolved' && e.aggregate_id === id)
          ?.sequence ?? 0)
      : 0,
  );
  return useQuery<AgentProposal>(
    'agent.proposal',
    id,
    (proposal_id) => ({ proposal_id }),
    (value) =>
      value && typeof value === 'object' && 'state' in value ? (value as AgentProposal) : null,
    resolved,
  ).data;
}

/** The defaults of the ideas, goals and custom templates; null until read. */
export function useAgentTemplates(): AgentTemplateDefaults[] | null {
  return useQuery<AgentTemplateDefaults[]>(
    'agent.templates',
    'all',
    () => ({}),
    (value) => (Array.isArray(value) ? (value as AgentTemplateDefaults[]) : null),
    0,
  ).data;
}

/** Built-in agents first, assistant then triage, then the others oldest first; archived ones left out. */
export function shownAgents(agents: readonly AgentProfile[]): AgentProfile[] {
  const rank = (agent: AgentProfile) =>
    agent.template === 'assistant' ? 0 : agent.template === 'triage' ? 1 : 2;
  return agents
    .filter((agent) => !agent.archived_at)
    .sort((a, b) => rank(a) - rank(b) || a.created_at - b.created_at);
}

let profileOf: string | null = null;
let profileIntent: ProfileIntent | null = null;
const profileListeners = new Set<() => void>();

/** What the profile does once when it opens: `addRoutine` puts a blank routine in its form. */
export type ProfileIntent = { addRoutine: true };

/** Shows the profile of the agent beside the conversation; null closes it. */
export function showAgentProfile(agentId: string | null, intent?: ProfileIntent): void {
  profileOf = agentId;
  profileIntent = (agentId && intent) || null;
  profileListeners.forEach((listener) => listener());
}

/** What the shown profile was opened to do, until the panel takes it with `takeAgentProfileIntent`. */
export function useAgentProfileIntent(): ProfileIntent | null {
  return useSyncExternalStore(
    (listener) => {
      profileListeners.add(listener);
      return () => void profileListeners.delete(listener);
    },
    () => profileIntent,
    () => profileIntent,
  );
}

export function takeAgentProfileIntent(): void {
  profileIntent = null;
  profileListeners.forEach((listener) => listener());
}

/** The agent whose profile shows beside the conversation; null while none does. */
export function useAgentProfileShown(): string | null {
  return useSyncExternalStore(
    (listener) => {
      profileListeners.add(listener);
      return () => void profileListeners.delete(listener);
    },
    () => profileOf,
    () => profileOf,
  );
}

const decided = new Map<string, AgentProposal>();
const decidedListeners = new Set<() => void>();

/** Keeps the proposal as the user's decision answered it, so its card shows the outcome. */
export function noteProposalDecided(proposal: AgentProposal): void {
  decided.set(proposal.id, proposal);
  decidedListeners.forEach((listener) => listener());
}

/** The proposal as a decision made in this window left it; undefined while none was made here. */
export function useDecidedProposal(id: string | null): AgentProposal | undefined {
  return useSyncExternalStore(
    (listener) => {
      decidedListeners.add(listener);
      return () => void decidedListeners.delete(listener);
    },
    () => (id ? decided.get(id) : undefined),
    () => (id ? decided.get(id) : undefined),
  );
}
