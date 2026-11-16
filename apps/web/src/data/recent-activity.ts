import type { WorkbenchSession } from '@pantheon/protocol';
import type { DaemonEvent } from './sync';
import type { SessionTurn } from './transcript';

export type ActivityKind = 'merged' | 'merge_blocked' | 'failed' | 'completed' | 'cancelled';

export interface ActivityRow {
  id: string;
  session_id: string;
  kind: ActivityKind;
  at: number;
}

function activityKind(event: Pick<DaemonEvent, 'kind'>): ActivityKind | null {
  switch (event.kind) {
    case 'session.merged':
      return 'merged';
    case 'session.merge_blocked':
      return 'merge_blocked';
    case 'session.merge_cancelled':
    case 'session.gate_run_cancelled':
      return 'cancelled';
    case 'turn.failed':
      return 'failed';
    case 'turn.completed':
      return 'completed';
    default:
      return null;
  }
}

export const isActivityEvent = (event: Pick<DaemonEvent, 'kind'>): boolean =>
  activityKind(event) !== null;

/**
 * The listed sessions' merges, blocked merges, failed and completed turns, newest first; a session's
 * completed turns in a row keep only the newest.
 */
export function recentActivity(
  events: readonly DaemonEvent[],
  sessions: readonly WorkbenchSession[],
  // Turn events name the turn; its session is found here.
  turns: readonly Pick<SessionTurn, 'id' | 'session_id'>[],
  limit = 50,
): ActivityRow[] {
  const listed = new Set(sessions.map((s) => s.id));
  const turnSession = new Map(turns.map((t) => [t.id, t.session_id]));
  const newest = new Map<string, ActivityKind>();
  const rows: ActivityRow[] = [];
  for (let i = events.length - 1; i >= 0 && rows.length < limit; i--) {
    const event = events[i]!;
    const kind = activityKind(event);
    if (!kind) continue;
    const session_id =
      kind === 'failed' || kind === 'completed'
        ? turnSession.get(event.aggregate_id)
        : event.aggregate_id;
    if (!session_id || !listed.has(session_id)) continue;
    if (kind === 'completed' && newest.get(session_id) === 'completed') continue;
    newest.set(session_id, kind);
    rows.push({ id: event.event_id, session_id, kind, at: event.created_at });
  }
  return rows;
}
