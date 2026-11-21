import type { Review } from '@pantheon/domain';
import type {
  BoardSnapshot,
  SessionGates,
  SessionGatesHistory,
  SessionPreflight,
} from '@pantheon/protocol';
import { useBoard } from './board';
import { STREAM_KINDS, type DaemonEvent } from './sync';
import {
  touchesSession,
  useFocusTick,
  useNewestEvent,
  useQuery,
  useRefetchTick,
} from './workbench-sessions';

export interface SessionRead<T> {
  /** null until a read succeeds and after a read fails. */
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  stale?: boolean;
  readAt?: number | null;
}

const sessionParams = (session_id: string) => ({ session_id });
const acceptGates = (value: unknown): SessionGates | null => {
  const gates = value as Partial<SessionGates> | null;
  return typeof gates?.configured === 'boolean' && typeof gates.running === 'boolean'
    ? (gates as SessionGates)
    : null;
};
const historyParams = (session_id: string) => ({ session_id, limit: '30' });
const acceptHistory = (value: unknown): SessionGatesHistory | null =>
  Array.isArray((value as Partial<SessionGatesHistory> | null)?.runs)
    ? (value as SessionGatesHistory)
    : null;
const acceptReviews = (value: unknown): Review[] | null =>
  Array.isArray(value) ? (value as Review[]) : null;
const acceptPreflight = (value: unknown): SessionPreflight | null => {
  const preflight = value as Partial<SessionPreflight> | null;
  return typeof preflight?.can_merge === 'boolean' && typeof preflight.gate === 'object'
    ? (preflight as SessionPreflight)
    : null;
};

// Another session's merge moves the source this session's gates and preflight are read against.
const sourceMerged = (e: DaemonEvent, sessionId: string, board: BoardSnapshot | null) => {
  if (e.kind !== 'session.merged') return false;
  const workspaceId = board?.sessions.find((session) => session.id === sessionId)?.workspace_id;
  const source = board?.workspaces.find((workspace) => workspace.id === workspaceId)?.source;
  return source !== undefined && (e.payload as { source?: unknown } | null)?.source === source;
};

/** Counts up after the session's events, its lead's plan changes, merges into its source and gate changes. */
function useGateTick(sessionId: string | null): number {
  const last = useNewestEvent(
    sessionId,
    (e, board) =>
      sessionId !== null &&
      (touchesSession(e, sessionId, board) ||
        sourceMerged(e, sessionId, board) ||
        e.kind === 'project.gate_set'),
  );
  return useRefetchTick(last?.sequence ?? 0, STREAM_KINDS.has(last?.kind ?? ''));
}

/** The session's newest gate result; read again after the session's events and gate changes. */
export function useSessionGates(sessionId: string | null): SessionRead<SessionGates> {
  const tick = useGateTick(sessionId);
  return useQuery('session.gates', sessionId, sessionParams, acceptGates, tick);
}

/** The session's latest thirty gate runs, newest first; read again when its gate result is. */
export function useSessionGatesHistory(sessionId: string | null): SessionRead<SessionGatesHistory> {
  const tick = useGateTick(sessionId);
  return useQuery('session.gates.history', sessionId, historyParams, acceptHistory, tick);
}

/**
 * The session's merge preflight; read again after its own, turn, worktree, lead plan, source merge
 * and gate setting events, and on window focus, as edits made outside the app send no event.
 */
export function useSessionPreflight(sessionId: string | null): SessionRead<SessionPreflight> {
  const workspaceId = useBoard(
    (s) => s.board?.sessions.find((session) => session.id === sessionId)?.workspace_id ?? null,
  );
  // workspaceId follows the board, so the newest event is still scanned again only on a new board.
  const last = useNewestEvent(
    sessionId,
    (e, board) =>
      sessionId !== null &&
      (touchesSession(e, sessionId, board) ||
        (workspaceId !== null && e.aggregate_id === workspaceId) ||
        sourceMerged(e, sessionId, board) ||
        e.kind === 'project.gate_set'),
  );
  const tick =
    useRefetchTick(last?.sequence ?? 0, STREAM_KINDS.has(last?.kind ?? '')) + useFocusTick();
  return useQuery('session.preflight', sessionId, sessionParams, acceptPreflight, tick);
}

/** The reviews of the session's changes; review events name the review, so read again after any event that can change the board. */
export function useSessionReviews(sessionId: string | null): SessionRead<Review[]> {
  const changed = useBoard((s) => s.changed);
  return useQuery('session.reviews', sessionId, sessionParams, acceptReviews, changed, {}, true);
}
