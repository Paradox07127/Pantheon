import { useSyncExternalStore } from 'react';
import type { BoardSnapshot, WorkbenchSession } from '@pantheon/protocol';
import { toast } from '../components/Toast';
import { useShell } from '../store';
import { runCommand } from './commands';
import { failureText } from './needs-you';

type Project = BoardSnapshot['projects'][number];

/** The personal agent's home project; null until the personal agent is first opened. */
export function personalHomeOf<T extends Pick<Project, 'kind'>>(projects: readonly T[]): T | null {
  return projects.find((p) => p.kind === 'personal') ?? null;
}

/** The newest personal session of the home's list that is not archived; null before the first open. */
export function personalSessionOf(sessions: readonly WorkbenchSession[]): WorkbenchSession | null {
  return (
    sessions
      .filter((s) => s.resident?.kind === 'personal' && !s.archived_at)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null
  );
}

let opening = false;
const openingListeners = new Set<() => void>();
const setOpening = (now: boolean) => {
  opening = now;
  openingListeners.forEach((listener) => listener());
};

/** Whether the personal agent's resident.open is still out. */
export function usePersonalOpening(): boolean {
  return useSyncExternalStore(
    (listener) => {
      openingListeners.add(listener);
      return () => void openingListeners.delete(listener);
    },
    () => opening,
    () => opening,
  );
}

/** Opens the personal agent's conversation once the daemon returns it; the first open creates its home. */
export async function openPersonalAgent(): Promise<void> {
  if (opening) return;
  setOpening(true);
  const result = await runCommand('resident.open', { kind: 'personal' }, null);
  setOpening(false);
  if (!result.ok) {
    toast({ title: failureText(result.error), kind: 'failure' });
    return;
  }
  const id = (result.value as { id?: unknown } | null)?.id;
  if (typeof id === 'string') useShell.getState().openPersonal(id);
}
