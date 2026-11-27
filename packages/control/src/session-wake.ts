import { DomainError, type Project, type Session, type SessionTurn } from '@pantheon/domain';
import { insert, type ControlContext } from './context.js';
import { acceptInput, queuedTurn } from './session.js';
import { projectOverBudget } from './workflow-policy.js';

function noticeRefusal(
  ctx: ControlContext,
  session: Session,
): 'budget' | 'not_accepting' | undefined {
  if (projectOverBudget(ctx, session.project_id)) return 'budget';
  try {
    acceptInput(ctx, session, session.state === 'running' ? 'steer' : 'send');
  } catch (error) {
    if (error instanceof DomainError) return 'not_accepting';
    throw error;
  }
}

/** Whether a notice to the session would go in now. */
export function takesNotice(ctx: ControlContext, session: Session | undefined): session is Session {
  return session !== undefined && noticeRefusal(ctx, session) === undefined;
}

/** Whether the turn is a notice that has not reached its session yet; stored rows may say tracker. */
export function waitingNotice(turn: SessionTurn): boolean {
  return (
    turn.state === 'queued' &&
    turn.delivery === 'pending' &&
    (turn.origin === 'notice' || turn.origin === 'tracker')
  );
}

/** Sends the text to the session as a turn of its own; undefined when the session takes no turn. */
export function notifySession(
  ctx: ControlContext,
  sessionId: string,
  text: string,
  cause: string,
): SessionTurn | undefined {
  const session = ctx.store.get<Session>('sessions', sessionId);
  if (!session) return;
  const project = ctx.store.must<Project>('projects', session.project_id);
  const resident = project.resident?.session_id === sessionId;
  const reason = noticeRefusal(ctx, session);
  if (reason) {
    if (resident)
      ctx.store.event(
        'resident.wake_skipped',
        session,
        project.id,
        { session_id: sessionId, reason, cause },
        cause,
      );
    return;
  }
  const running = session.state === 'running';
  const waiting = running
    ? ctx.store
        .list<SessionTurn>('session_turns')
        .find((turn) => turn.session_id === session.id && waitingNotice(turn))
    : undefined;
  const turn = waiting
    ? ctx.store.update(
        'session_turns',
        { ...waiting, input: `${waiting.input}\n\n${text}` },
        waiting.revision,
      )
    : queueTurn(ctx, session, text, 'notice', cause);
  if (resident)
    ctx.store.event(
      'resident.woken',
      ctx.store.must<Session>('sessions', sessionId),
      project.id,
      { session_id: sessionId, turn_id: turn.id, cause },
      cause,
    );
  return turn;
}

/** Starts the turn on an idle session; on a running one it waits, outside the outbox, for that turn to end. */
export function queueTurn(
  ctx: ControlContext,
  session: Session,
  input: string,
  origin: NonNullable<SessionTurn['origin']>,
  cause: string,
  extras?: Pick<SessionTurn, 'attachments' | 'skills' | 'refs' | 'reference_context' | 'handoff'>,
): SessionTurn {
  const turn: SessionTurn = { ...queuedTurn(session, input, 'send', extras), origin };
  if (session.state !== 'running') {
    const { archived_at, ...rest } = session;
    const next = ctx.store.update(
      'sessions',
      {
        ...rest,
        state: 'running' as const,
        turn_count: session.turn_count + 1,
        // A blocked merge waits for the user, and the notice of the block itself starts a turn here.
        merge: session.merge?.state === 'blocked' ? session.merge : undefined,
      },
      session.revision,
    );
    if (archived_at) ctx.store.event('session.unarchived', next, next.project_id, {}, cause);
    ctx.store.enqueue('session.turn', { turn_id: turn.id });
  } else
    ctx.store.update(
      'sessions',
      { ...session, turn_count: session.turn_count + 1 },
      session.revision,
    );
  insert(ctx, 'session_turns', turn, 'turn.queued', session.project_id, cause);
  ctx.store.event('session.turn.delivery', turn, turn.project_id, { delivery: 'pending' }, cause);
  return turn;
}
