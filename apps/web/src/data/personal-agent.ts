import { useSyncExternalStore } from 'react';
import type { PersonalKey } from '@pantheon/domain';
import type { BoardSnapshot, WorkbenchSession } from '@pantheon/protocol';
import { toast } from '../components/Toast';
import { useShell } from '../store';
import { useBoard } from './board';
import { runCommand } from './commands';
import { failureText, type NeedsYouItem } from './needs-you';
import type { DaemonEvent } from './sync';
import { useQuery } from './workbench-sessions';

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

/** What waits for the user in the visible projects; the home's own items are left out. */
export function crossProjectWaiting(
  items: readonly NeedsYouItem[],
  visibleIds: readonly string[],
): NeedsYouItem[] {
  return items.filter((item) => visibleIds.includes(item.project_id));
}

/**
 * The first line of the newest completed turn's reply in the home and when it came, from the
 * events already received; null when they hold none.
 */
export function latestReply(
  board: Pick<BoardSnapshot, 'session_turns'>,
  events: readonly DaemonEvent[],
  homeId: string,
): { text: string; at: number } | null {
  const done = new Set(
    board.session_turns
      .filter((turn) => turn.project_id === homeId && turn.state === 'completed')
      .map((turn) => turn.id),
  );
  const replies = new Map<string, { text: string; at: number }>();
  for (const event of events) {
    const { turn_id, text } = (event.payload ?? {}) as { turn_id?: unknown; text?: unknown };
    if (event.kind !== 'agent.message.delta' || typeof turn_id !== 'string' || !done.has(turn_id))
      continue;
    replies.set(turn_id, {
      text: (replies.get(turn_id)?.text ?? '') + (typeof text === 'string' ? text : ''),
      at: event.created_at,
    });
  }
  const newest = [...replies.values()]
    .map((reply) => ({ text: reply.text.trim().split('\n')[0]!, at: reply.at }))
    .filter((reply) => reply.text)
    .sort((a, b) => b.at - a.at)[0];
  return newest ?? null;
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

let profileShown = false;
const profileListeners = new Set<() => void>();

/** Shows or hides the personal agent's profile beside its conversation. */
export function showPersonalProfile(shown: boolean): void {
  profileShown = shown;
  profileListeners.forEach((listener) => listener());
}

/** Whether the personal agent's profile shows beside its conversation. */
export function usePersonalProfileShown(): boolean {
  return useSyncExternalStore(
    (listener) => {
      profileListeners.add(listener);
      return () => void profileListeners.delete(listener);
    },
    () => profileShown,
    () => profileShown,
  );
}

export type PersonalKeyListed = Pick<PersonalKey, 'id' | 'label' | 'created_at' | 'revoked_at'>;

/** Every personal agent key in creation order, read again when one is created or revoked. */
export function usePersonalKeys() {
  const changed = useBoard(
    (s) => s.events.findLast((e) => e.kind.startsWith('personal_key.'))?.sequence ?? 0,
  );
  return useQuery<PersonalKeyListed[]>(
    'personal.key.list',
    'all',
    () => ({}),
    (value) => (Array.isArray(value) ? (value as PersonalKeyListed[]) : null),
    changed,
  );
}

/** Revokes the key; a refusal shows its failure text. */
export async function revokePersonalKey(keyId: string): Promise<boolean> {
  const result = await runCommand('personal.key.revoke', { key_id: keyId }, null);
  if (!result.ok) toast({ title: failureText(result.error), kind: 'failure' });
  return result.ok;
}
