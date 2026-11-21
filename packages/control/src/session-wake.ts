import { DomainError, type Session, type SessionTurn } from '@pantheon/domain';
import { insert, type ControlContext } from './context.js';
import { acceptInput, queuedTurn } from './session.js';
import { projectOverBudget } from './workflow-policy.js';

/** Sends the text to the session as a turn of its own; undefined when the session takes no turn. */
export function notifySession(
  ctx: ControlContext,
  sessionId: string,
  text: string,
  cause: string,
): SessionTurn | undefined {
  const session = ctx.store.get<Session>('sessions', sessionId);
  if (!session || projectOverBudget(ctx, session.project_id)) return;
  const running = session.state === 'running';
  try {
    acceptInput(ctx, session, running ? 'steer' : 'send');
  } catch (error) {
    if (error instanceof DomainError) return;
    throw error;
  }
  const waiting = running
    ? ctx.store
        .list<SessionTurn>('session_turns')
        .find(
          (turn) =>
            turn.session_id === session.id &&
            turn.state === 'queued' &&
            turn.delivery === 'pending' &&
            turn.origin === 'tracker',
        )
    : undefined;
  if (!waiting) return queueTurn(ctx, session, text, 'tracker', cause);
  return ctx.store.update(
    'session_turns',
    { ...waiting, input: `${waiting.input}\n\n${text}` },
    waiting.revision,
  );
}

/** Starts the turn on an idle session; on a running one it waits, outside the outbox, for that turn to end. */
export function queueTurn(
  ctx: ControlContext,
  session: Session,
  input: string,
  origin: NonNullable<SessionTurn['origin']>,
  cause: string,
  extras?: Pick<
    SessionTurn,
    | 'attachments'
    | 'skills'
    | 'refs'
    | 'reference_context'
    | 'handoff'
    | 'causal_depth'
    | 'lead_note_ids'
    | 'wake'
  >,
): SessionTurn {
  const turn: SessionTurn = { ...queuedTurn(session, input, 'send', extras), origin };
  if (session.state !== 'running') {
    const { archived_at, ...rest } = session;
    const next = ctx.store.update(
      'sessions',
      { ...rest, state: 'running' as const, turn_count: session.turn_count + 1, merge: undefined },
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
