import { requireThat, type Principal, type Session, type SessionTurn } from '@pantheon/domain';
import { inputSchemas, type Command } from '@pantheon/protocol';
import { projectAccess, userOnly, type ControlContext, type Handlers } from './context.js';
import { sessionHandlers } from './session.js';

type Request = ReturnType<(typeof inputSchemas)['request.send']['parse']>;

/** The session a user's request goes to: the session it names. */
function requestTarget(ctx: ControlContext, p: Principal, input: Request): Session {
  userOnly(p);
  requireThat(input.target?.kind === 'session', 'invalid_request', 'Name the session to send to');
  projectAccess(ctx, p, input.project_id, 'request.send');
  const session = ctx.store.must<Session>('sessions', input.target.session_id);
  requireThat(
    session.project_id === input.project_id,
    'permission_denied',
    'The session belongs to another project',
  );
  requireThat(!session.archived_at, 'invalid_state', 'Unarchive the session first');
  return session;
}

/** Sends the input to the session, steering it while it runs. */
function deliver(
  ctx: ControlContext,
  p: Principal,
  c: Command,
  session: Session,
  input: string,
  attachments?: string[],
) {
  const type = session.state === 'running' ? 'session.steer' : 'session.send';
  const turn = sessionHandlers[type]!(ctx, p, {
    ...c,
    type,
    expected_revision: session.revision,
    input: { session_id: session.id, input, ...(attachments ? { attachments } : {}) },
  }) as SessionTurn;
  return { session_id: turn.session_id, turn_id: turn.id };
}

export const frontDoorHandlers: Handlers = {
  'request.send': (ctx, p, c) => {
    const input = inputSchemas['request.send'].parse(c.input);
    return deliver(ctx, p, c, requestTarget(ctx, p, input), input.input, input.attachments);
  },
};
