import { useSyncExternalStore } from 'react';
import type { AgentProfile, AgentProposal, AgentToolGroup } from '@pantheon/protocol';
import { t } from '../i18n';
import { useBoard } from './board';
import { useProjectQuery } from './project-read';
import { useQuery } from './workbench-sessions';

export type { AgentProfile, AgentProposal, AgentToolGroup };
export type AgentRoutine = AgentProfile['routines'][number];
export type EventSource = NonNullable<AgentProfile['listens']>[number];
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
export const OFFERED_LISTENS: readonly EventSource[] = ['github'];

/** The project's agents from agent.list, archived ones included; null until read. */
export function useAgents(projectId: string | null): AgentProfile[] | null {
  return useProjectQuery<AgentProfile[]>('agent.list', projectId, Array.isArray).read;
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
const profileListeners = new Set<() => void>();

/** Shows the profile of the agent beside the conversation; null closes it. */
export function showAgentProfile(agentId: string | null): void {
  profileOf = agentId;
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
