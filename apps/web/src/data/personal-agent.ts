import { useEffect, useSyncExternalStore } from 'react';
import type { AgentProfile, PersonalKey } from '@pantheon/domain';
import type { BoardSnapshot, WorkbenchSession } from '@pantheon/protocol';
import { toast } from '../components/Toast';
import { useShell } from '../store';
import { useBoard } from './board';
import { runCommand } from './commands';
import { failureText, type NeedsYouItem } from './needs-you';
import type { DaemonEvent } from './sync';
import type { ToolItem } from './transcript';
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

/** What a personal tool call showed once it ended well: the needs-you list it read, or where it sent a request. */
export type PersonalCall =
  | { kind: 'needs'; items: NeedsYouItem[]; at: number }
  | { kind: 'sent'; project_id: string; session_id: string | null; assistant: boolean };

// By tool call id: a call is read once when it ends, so a streaming reply does not parse it again.
const personalCallsRead = new Map<string, PersonalCall | null>();

/** The text of a tool result: the fixture's string, or the text of the runtime's content blocks. */
const resultText = (value: unknown): string | null => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(resultText).join('');
  if (!value || typeof value !== 'object') return null;
  const result = value as { content?: unknown; text?: unknown; result?: unknown };
  return resultText(result.content ?? result.text ?? result.result);
};

/**
 * The needs_you or send_request call as the personal agent made it, once it ended well; null for any
 * other call, one still running, or a result cut short and no longer JSON.
 */
export function personalCall(item: ToolItem): PersonalCall | null {
  if (!item.ok || item.completed_at === undefined) return null;
  const tool = item.name.replace(/^(mcp__pantheon__|pantheon\.)/, '');
  if (tool !== 'needs_you' && tool !== 'send_request') return null;
  if (personalCallsRead.has(item.id)) return personalCallsRead.get(item.id)!;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(resultText(item.output) ?? '');
  } catch {
    // Left null: the call shows as a plain tool row.
  }
  const items = (parsed as { items?: unknown } | null)?.items;
  const input = item.input as { project_id?: unknown; target?: { kind?: unknown } } | null;
  const receipt = (parsed as { receipt?: { session_id?: unknown } } | null)?.receipt;
  const call: PersonalCall | null =
    tool === 'needs_you'
      ? Array.isArray(items)
        ? { kind: 'needs', items: items as NeedsYouItem[], at: item.completed_at }
        : null
      : typeof input?.project_id === 'string'
        ? {
            kind: 'sent',
            project_id: input.project_id,
            session_id: typeof receipt?.session_id === 'string' ? receipt.session_id : null,
            assistant: input.target?.kind !== 'session',
          }
        : null;
  personalCallsRead.set(item.id, call);
  return call;
}

let builtInKey: string | null = null;
let builtInKeyAsked = false;
const builtInKeyListeners = new Set<() => void>();

/** The built-in personal agent's key id, read from the home's agents once, when a thread first asks with the home. */
export function useBuiltInPersonalKey(homeId: string | null): string | null {
  useEffect(() => {
    const bridge = window.pantheon;
    if (!homeId || builtInKeyAsked || !bridge) return;
    builtInKeyAsked = true;
    void bridge.query('agent.list', { project_id: homeId }).then((result) => {
      if (!result.ok || !Array.isArray(result.value)) {
        builtInKeyAsked = false;
        return;
      }
      builtInKey =
        (result.value as AgentProfile[]).find((agent) => agent.template === 'personal')
          ?.personal_key_id ?? null;
      builtInKeyListeners.forEach((listener) => listener());
    });
  }, [homeId]);
  return useSyncExternalStore(
    (listener) => {
      builtInKeyListeners.add(listener);
      return () => void builtInKeyListeners.delete(listener);
    },
    () => builtInKey,
    () => builtInKey,
  );
}

/** Revokes the key; a refusal shows its failure text. */
export async function revokePersonalKey(keyId: string): Promise<boolean> {
  const result = await runCommand('personal.key.revoke', { key_id: keyId }, null);
  if (!result.ok) toast({ title: failureText(result.error), kind: 'failure' });
  return result.ok;
}
