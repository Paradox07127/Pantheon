import {
  requireThat,
  type AgentProfile,
  type BoardPlan,
  type Principal,
  type Session,
  type SessionTurn,
} from '@pantheon/domain';
import { inputSchemas, type Command } from '@pantheon/protocol';
import { projectAccess, userOnly, type ControlContext, type Handlers } from './context.js';
import { openAgent } from './resident.js';
import { sessionHandlers, userWords } from './session.js';

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
  'request.reroute': (ctx, p, c) => {
    userOnly(p);
    const { turn_id, to } = inputSchemas['request.reroute'].parse(c.input),
      turn = ctx.store.must<SessionTurn>('session_turns', turn_id);
    projectAccess(ctx, p, turn.project_id, c.type);
    const agentId = ctx.store.must<Session>('sessions', turn.session_id).resident?.agent_id;
    requireThat(
      agentId && !turn.origin,
      'invalid_state',
      "Only the user's request to a resident can be routed",
    );
    if (typeof to === 'object' && 'agent_id' in to) {
      const agent = ctx.store.must<AgentProfile>('agents', to.agent_id);
      requireThat(
        agent.project_id === turn.project_id,
        'permission_denied',
        'Agent of another project',
      );
      return deliver(ctx, p, c, openAgent(ctx, agent, c.command_id), userWords(turn.input));
    }
    const session = openAgent(ctx, ctx.store.must<AgentProfile>('agents', agentId), c.command_id);
    let route: string;
    if (to === 'answer_here') route = 'answer it here, without changing your plan';
    else if (to === 'new_plan') route = 'plan it as a new lane';
    else {
      const lane = ctx.store
        .get<BoardPlan>('board_plans', session.id)
        ?.lanes.find((each) => each.id === to.lane_id);
      requireThat(lane, 'not_found', `Not found: lane ${to.lane_id} in the plan`);
      route = `add it to lane ${lane.id} (${lane.title})`;
    }
    return deliver(
      ctx,
      p,
      c,
      session,
      `[Pantheon] The user routes this request differently: ${route}.\n\n${userWords(turn.input)}`,
    );
  },
};
