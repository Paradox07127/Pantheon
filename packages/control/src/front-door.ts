import { requireThat, type Principal, type Session, type SessionTurn } from '@pantheon/domain';
import { inputSchemas } from '@pantheon/protocol';
import { projectAccess, userOnly, type ControlContext, type Handlers } from './context.js';
import { openResident } from './resident.js';
import { sessionHandlers } from './session.js';

type Request = ReturnType<(typeof inputSchemas)['request.send']['parse']>;

/** The session a user's request goes to: the session it names, or else the project's Assistant. */
function requestTarget(ctx: ControlContext, p: Principal, input: Request, cause: string): Session {
  if (input.target?.kind !== 'session')
    return openResident(ctx, p, input.project_id, 'assistant', cause);
  userOnly(p);
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

export const frontDoorHandlers: Handlers = {
  'request.send': (ctx, p, c) => {
    const input = inputSchemas['request.send'].parse(c.input),
      session = requestTarget(ctx, p, input, c.command_id),
      type = session.state === 'running' ? 'session.steer' : 'session.send';
    const turn = sessionHandlers[type]!(ctx, p, {
      ...c,
      type,
      expected_revision: session.revision,
      input: {
        session_id: session.id,
        input: input.input,
        ...(input.attachments ? { attachments: input.attachments } : {}),
      },
    }) as SessionTurn;
    return { session_id: turn.session_id, turn_id: turn.id };
  },
};
