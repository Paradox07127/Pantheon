import type { Session, SessionTurn } from '@pantheon/domain';
import type { ControlContext } from './context.js';
import { daemonDriven } from './continuation.js';
import { latestEvent } from './needs-you.js';
import { HUNG_CALL_MS, STALL_MS, stalled, turnActivity } from './progress.js';

/** When the running turn of a session a person drives began to stall; undefined while it does not stall. */
export function sessionStall(
  ctx: ControlContext,
  session: Session,
  running: SessionTurn | undefined,
): number | undefined {
  if (!running || daemonDriven(ctx, session)) return;
  const now = ctx.store.now(),
    started = latestEvent(ctx, running.id, 'turn.running');
  if (!started || now - started.created_at <= STALL_MS) return;
  const activity = turnActivity(ctx, session.id, running.id);
  if (!activity || !stalled(activity, now)) return;
  return activity.open_call
    ? Math.max(activity.open_call.at, activity.answered_at ?? 0) + HUNG_CALL_MS
    : Math.max(activity.acted_at, activity.streamed_at ?? 0, activity.answered_at ?? 0) + STALL_MS;
}

export function tickSessionStalls(ctx: ControlContext): void {
  // Every tick runs this; the predicate is the one of the session_turns_active index.
  const active = ctx.store
    .statement(
      "SELECT id FROM session_turns WHERE json_extract(data,'$.state') IN ('queued','running')",
    )
    .all() as { id: string }[];
  // A stall records nothing itself, so open views hear of it from this event, once per stall.
  for (const { id } of active) {
    const turn = ctx.store.must<SessionTurn>('session_turns', id);
    if (turn.state !== 'running') continue;
    const session = ctx.store.must<Session>('sessions', turn.session_id),
      since = sessionStall(ctx, session, turn);
    if (
      since !== undefined &&
      (latestEvent(ctx, session.id, 'session.turn_stalled')?.created_at ?? -1) < since
    )
      ctx.store.event('session.turn_stalled', session, session.project_id, { turn_id: turn.id });
  }
}
