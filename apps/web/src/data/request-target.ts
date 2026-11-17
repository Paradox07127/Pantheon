import { useSyncExternalStore } from 'react';

/** Where the requirement bar sends: the project's Assistant, another resident, a session or a new lead. */
export type RequestChoice =
  | { kind: 'assistant' }
  | { kind: 'agent'; agent_id: string }
  | { kind: 'session'; session_id: string }
  | { kind: 'create' };

export const ASSISTANT: RequestChoice = { kind: 'assistant' };

const KEY = 'pantheon.requestTargets';

/** One string per choice, the same for equal choices. */
export const choiceKey = (choice: RequestChoice): string =>
  choice.kind === 'agent'
    ? `agent:${choice.agent_id}`
    : choice.kind === 'session'
      ? `session:${choice.session_id}`
      : choice.kind;

function storedChoices(): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function asChoice(value: unknown): RequestChoice {
  const choice = value as Partial<{ kind: string; agent_id: unknown; session_id: unknown }> | null;
  if (choice?.kind === 'agent' && typeof choice.agent_id === 'string')
    return { kind: 'agent', agent_id: choice.agent_id };
  if (choice?.kind === 'session' && typeof choice.session_id === 'string')
    return { kind: 'session', session_id: choice.session_id };
  return ASSISTANT;
}

// A new lead is chosen only until the request is sent, and is not stored.
const creating = new Set<string>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** Makes the choice the target of the project's requirement bar. */
export function chooseRequestTarget(projectId: string, choice: RequestChoice): void {
  if (choice.kind === 'create') creating.add(projectId);
  else {
    creating.delete(projectId);
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...storedChoices(), [projectId]: choice }));
    } catch {
      // The bar then targets the Assistant.
    }
  }
  listeners.forEach((listener) => listener());
}

/** The target chosen on the project's requirement bar; the Assistant when none is stored. */
export function useRequestTarget(projectId: string): RequestChoice {
  const read = () =>
    creating.has(projectId) ? 'create' : JSON.stringify(storedChoices()[projectId] ?? null);
  const raw = useSyncExternalStore(subscribe, read, read);
  return raw === 'create' ? { kind: 'create' } : asChoice(JSON.parse(raw));
}
