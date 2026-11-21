import {
  DomainError,
  type BoardPlan,
  type Session,
  type SessionTurn,
  type Timer,
} from '@pantheon/domain';
import type { ControlContext } from './context.js';
import { queueTurn } from './session-wake.js';
import { nextDepth } from './progress.js';
import { acceptInput } from './session.js';

/** Continuation turns one session may get within CONTINUATION_WINDOW_MS. */
const CONTINUATION_LIMIT = 3;
const CONTINUATION_WINDOW_MS = 5 * 60_000;

/** A task session or a lead with a board plan: the daemon, not a person, sends its turns. */
export function daemonDriven(ctx: ControlContext, session: Session): boolean {
  return !!session.task || !!ctx.store.get<BoardPlan>('board_plans', session.id);
}

/** True while the session waits for a used-up usage limit to reset. */
export function usageLimitWaiting(ctx: ControlContext, sessionId: string): boolean {
  return usageResetAt(ctx, sessionId) !== undefined;
}

/** When the session's pending resume after a used-up usage limit is due, in Unix milliseconds. */
export function usageResetAt(ctx: ControlContext, sessionId: string): number | undefined {
  return ctx.store
    .list<Timer>('timers')
    .find(
      (timer) =>
        timer.kind === 'usage-limit-resume' &&
        timer.subject_id === sessionId &&
        timer.state === 'pending',
    )?.due_at;
}

type ContinuationSkip =
  | { reason: 'not_daemon_driven' }
  | { reason: 'limit_reached' }
  | { reason: 'input_refused'; code: string };

/** Starts a turn on a session the daemon drives; undefined, with a skip event, for a person's session, past the limit, or while it takes no input. */
export function continueSession(
  ctx: ControlContext,
  session: Session,
  text: string,
  cause: string,
  extras?: Pick<SessionTurn, 'attachments' | 'skills' | 'handoff'>,
): SessionTurn | undefined {
  const skip = (payload: ContinuationSkip) => {
    ctx.store.event('session.continuation_skipped', session, session.project_id, payload, cause);
    return undefined;
  };
  if (!daemonDriven(ctx, session)) return skip({ reason: 'not_daemon_driven' });
  const { count } = ctx.store.db
    .prepare(
      "SELECT count(*) AS count FROM events WHERE kind='turn.queued' AND json_extract(payload,'$.session_id')=? AND json_extract(payload,'$.origin')='continuation' AND created_at>?",
    )
    .get(session.id, ctx.store.now() - CONTINUATION_WINDOW_MS) as { count: number };
  if (count >= CONTINUATION_LIMIT) return skip({ reason: 'limit_reached' });
  try {
    acceptInput(ctx, session, 'send');
  } catch (error) {
    if (error instanceof DomainError) return skip({ reason: 'input_refused', code: error.code });
    throw error;
  }
  return queueTurn(ctx, session, text, 'continuation', cause, {
    ...extras,
    causal_depth: nextDepth(ctx, session.id, session.task),
  });
}
