import { useEffect, useState } from 'react';
import type { SessionActivity } from '@pantheon/protocol';
import { useBoard } from './board';
import { STREAM_KINDS, type DaemonEvent } from './sync';
import { touchesSession, useQuery, useRefetchTick } from './workbench-sessions';

function newest(
  events: readonly DaemonEvent[],
  keep: (event: DaemonEvent) => boolean,
): DaemonEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) if (keep(events[i]!)) return events[i];
  return undefined;
}

interface SessionRead<T> {
  /** null until a read succeeds and after a read fails. */
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

const sessionParams = (session_id: string) => ({ session_id });
const acceptActivity = (value: unknown): SessionActivity | null => {
  const activity = value as Partial<SessionActivity> | null;
  return typeof activity?.from === 'string' && Array.isArray(activity.tools_completed)
    ? (activity as SessionActivity)
    : null;
};

const REREAD_MS = 5 * 60_000;

/**
 * The session's completed tool calls of the last hour; read again after the session's events,
 * and every five minutes, as the hour moves on.
 */
export function useSessionActivity(sessionId: string | null): SessionRead<SessionActivity> {
  const keep = (e: DaemonEvent) => sessionId !== null && touchesSession(e, sessionId);
  const sequence = useBoard((s) => newest(s.events, keep)?.sequence ?? 0);
  const stream = useBoard((s) => STREAM_KINDS.has(newest(s.events, keep)?.kind ?? ''));
  const tick = useRefetchTick(sequence, stream);
  const [rereads, setRereads] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setRereads((n) => n + 1), REREAD_MS);
    return () => clearInterval(id);
  }, []);
  return useQuery('session.activity', sessionId, sessionParams, acceptActivity, tick + rereads);
}
