import type { SessionThread } from '@pantheon/protocol';
import {
  touchesSession,
  useNewestEvent,
  useQuery,
  useRefetchTick,
  type QueryState,
} from './workbench-sessions';

// The events session.thread folds, and those of the approvals it lists as questions.
const THREAD_KINDS: ReadonlySet<string> = new Set([
  'session.opened',
  'session.main_agent_decided',
  'session.conductor_messaged',
  'session.spawner_notified',
  'agent.turn.completed',
  'session.turn.delivery',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
  'session.gate_checked',
  'session.gate_run_failed',
  'session.gate_run_cancelled',
  'session.merged',
  'session.merge_blocked',
  'session.merge_cancelled',
  'approval.requested',
  'approval.approved',
  'approval.rejected',
  'approval.resolved',
  'approval.void',
]);

// A review's later events name the review, not its session, so any of them reads the thread again.
const REVIEW_KINDS: ReadonlySet<string> = new Set([
  'review.requested',
  'review.completed',
  'review.failed',
  'review.verdict_recorded',
  'review.finding_recorded',
  'review.finding_resolved',
  'review.finding_marked_stale',
]);

const threadParams = (session_id: string) => ({ session_id });
const acceptThread = (value: unknown): SessionThread | null =>
  Array.isArray((value as Partial<SessionThread> | null)?.entries)
    ? (value as SessionThread)
    : null;

/** What happened to the session, oldest first; read again after its turn, review, gate, landing and main agent events. */
export function useSessionThread(sessionId: string | null): QueryState<SessionThread> {
  const last = useNewestEvent(
    sessionId,
    (e, board) =>
      sessionId !== null &&
      (REVIEW_KINDS.has(e.kind) ||
        (THREAD_KINDS.has(e.kind) && touchesSession(e, sessionId, board))),
  );
  const tick = useRefetchTick(last?.sequence ?? 0, false, ['session.thread', sessionId]);
  return useQuery('session.thread', sessionId, threadParams, acceptThread, tick);
}
