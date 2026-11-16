import type { MemoryRecord } from '@pantheon/domain';
import { useBoard } from './board';
import { STREAM_KINDS } from './sync';
import { useFocusTick, useQuery, useRefetchTick } from './workbench-sessions';

/**
 * Summary queries never fetch bodies. Hidden detail/document panes issue no query. While a read is
 * out the last data stays with `refreshing` set; it is no authority for a write until the read lands.
 */
export function useMemoryQuery<T>(
  method: string,
  projectId: string,
  params: Record<string, unknown> | null,
) {
  const sequence = useBoard(
    (s) =>
      s.events.findLast((e) => e.project_id === projectId && !STREAM_KINDS.has(e.kind))?.sequence ??
      0,
  );
  const tick = useRefetchTick(sequence, false) + useFocusTick();
  const key = params === null ? null : JSON.stringify({ project_id: projectId, ...params });
  return useQuery<T>(
    method,
    key,
    (value) =>
      Object.fromEntries(
        Object.entries(JSON.parse(value) as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : String(v)]),
      ),
    (value) => (value && typeof value === 'object' ? (value as T) : null),
    tick,
  );
}

/** One memory entry a turn was given; `version` counts committed versions of its key, none for a draft. */
export interface MemoryTurnItem {
  id: string;
  key: string;
  title: string;
  kind: MemoryRecord['kind'];
  state: MemoryRecord['state'];
  version?: number;
}

/** The memory delivered with one turn, read once per mount; null `turnId` reads nothing. */
export function useMemoryTurn(sessionId: string, turnId: string | null) {
  return useQuery<{ items: MemoryTurnItem[] }>(
    'memory.turn',
    turnId === null ? null : JSON.stringify({ session_id: sessionId, turn_id: turnId }),
    (value) => JSON.parse(value) as Record<string, string>,
    (value) =>
      value && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items)
        ? (value as { items: MemoryTurnItem[] })
        : null,
    0,
  );
}

/** How many memory entries each turn of the session was given; read again when a turn ends. */
export function useMemorySessionTurns(sessionId: string) {
  const ended = useBoard(
    (s) =>
      s.board?.session_turns.filter(
        (t) => t.session_id === sessionId && t.state !== 'running' && t.state !== 'queued',
      ).length ?? 0,
  );
  return useQuery<{ turns: { turn_id: string; count: number }[] }>(
    'memory.session_turns',
    JSON.stringify({ session_id: sessionId }),
    (value) => JSON.parse(value) as Record<string, string>,
    (value) =>
      value && typeof value === 'object' && Array.isArray((value as { turns?: unknown }).turns)
        ? (value as { turns: { turn_id: string; count: number }[] })
        : null,
    ended,
  );
}
