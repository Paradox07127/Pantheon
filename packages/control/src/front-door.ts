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
import { openAgent, openResident } from './resident.js';
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

type PlanEvent = { sequence: number; kind: string; payload: string };

/**
 * What the resident did with the user's turn, from the events on its plan while the turn ran; an
 * event belongs to the turn that was running when it happened, so a steer folds into that turn.
 */
export function routingReceipt(
  ctx: ControlContext,
  turn: SessionTurn,
): SessionTurn['routing'] | undefined {
  const span = ctx.store.db
    .prepare(
      "SELECT max(CASE WHEN kind='turn.running' THEN sequence END) AS start, max(CASE WHEN kind='turn.completed' THEN sequence END) AS end FROM events WHERE aggregate_id=?",
    )
    .get(turn.id) as { start: number | null; end: number | null };
  if (span.start === null || span.end === null) return;
  const start = span.start;
  const events = ctx.store.db
    .prepare(
      "SELECT sequence, kind, payload FROM events WHERE aggregate_id=? AND kind IN ('board.plan_updated', 'lead.question_asked') AND sequence<? ORDER BY sequence",
    )
    .all(turn.session_id, span.end) as PlanEvent[];
  const plan = (event: PlanEvent | undefined) => event && (JSON.parse(event.payload) as BoardPlan);
  const plans = events.filter((event) => event.kind === 'board.plan_updated'),
    was = plan(plans.findLast((event) => event.sequence < start)),
    now = plan(plans.findLast((event) => event.sequence > start));
  const lanes = (now?.lanes ?? []).filter((lane) => !was?.lanes.some((old) => old.id === lane.id)),
    tasks = (now?.tasks ?? []).filter((task) => !was?.tasks.some((old) => old.id === task.id)),
    taskIds = tasks.map((task) => task.id);
  if (lanes.length)
    return {
      kind: 'new_plan',
      lane_id: lanes[0]!.id,
      ...(taskIds.length ? { task_ids: taskIds } : {}),
    };
  if (tasks.length) return { kind: 'added', lane_id: tasks[0]!.lane, task_ids: taskIds };
  if (events.some((event) => event.kind === 'lead.question_asked' && event.sequence > start))
    return { kind: 'asked' };
  return { kind: 'answered' };
}

/** Stores the routing receipt on a completed user turn of a resident session. */
export function recordRouting(ctx: ControlContext, turnId: string): void {
  ctx.store.transaction(() => {
    const turn = ctx.store.must<SessionTurn>('session_turns', turnId);
    if (
      turn.origin ||
      turn.routing ||
      turn.state !== 'completed' ||
      !ctx.store.must<Session>('sessions', turn.session_id).resident
    )
      return;
    const routing = routingReceipt(ctx, turn);
    if (!routing) return;
    const next = ctx.store.update('session_turns', { ...turn, routing }, turn.revision);
    ctx.store.event('turn.routed', next, next.project_id, routing);
  });
}

export const frontDoorHandlers: Handlers = {
  'request.send': (ctx, p, c) => {
    const input = inputSchemas['request.send'].parse(c.input);
    return deliver(
      ctx,
      p,
      c,
      requestTarget(ctx, p, input, c.command_id),
      input.input,
      input.attachments,
    );
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
      return deliver(ctx, p, c, openAgent(ctx, agent, c.command_id), turn.input);
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
      `[Pantheon] The user routes this request differently: ${route}.\n\n${turn.input}`,
    );
  },
};
