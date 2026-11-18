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
import { personalCalled } from './personal-scope.js';
import { openAgent, openResident } from './resident.js';
import { sessionHandlers, userWords } from './session.js';

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

/**
 * What the resident did with the user's turn, from its own events on its plan while the turn ran; an
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
  const plan = (after: number, before: number) => {
    const row = ctx.store.db
      .prepare(
        "SELECT payload FROM events WHERE aggregate_id=? AND kind='board.plan_updated' AND sequence>? AND sequence<? ORDER BY sequence DESC LIMIT 1",
      )
      .get(turn.session_id, after, before) as { payload: string } | undefined;
    return row && (JSON.parse(row.payload) as BoardPlan);
  };
  const was = plan(-1, span.start);
  // A plan update is the session's own when the inbox holds its command under the session's principal.
  const updates = ctx.store.db
    .prepare(
      "SELECT payload, EXISTS(SELECT 1 FROM inbox WHERE source_key='session:'||events.aggregate_id||':command:'||events.causation_id) AS own FROM events WHERE aggregate_id=? AND kind='board.plan_updated' AND sequence>? AND sequence<? ORDER BY sequence",
    )
    .all(turn.session_id, span.start, span.end) as { payload: string; own: number }[];
  // Only what an own update brought in counts, so a lane or task the user added stays out.
  const ownLanes = new Set<string>(),
    ownTasks = new Set<string>();
  let previous = was,
    now: BoardPlan | undefined;
  for (const update of updates) {
    const next = JSON.parse(update.payload) as BoardPlan;
    if (update.own) {
      now = next;
      for (const lane of next.lanes)
        if (!previous?.lanes.some((old) => old.id === lane.id)) ownLanes.add(lane.id);
      for (const task of next.tasks)
        if (!previous?.tasks.some((old) => old.id === task.id)) ownTasks.add(task.id);
    }
    previous = next;
  }
  const lanes = (now?.lanes ?? []).filter(
      (lane) => ownLanes.has(lane.id) && !was?.lanes.some((old) => old.id === lane.id),
    ),
    tasks = (now?.tasks ?? []).filter(
      (task) => ownTasks.has(task.id) && !was?.tasks.some((old) => old.id === task.id),
    ),
    taskIds = tasks.map((task) => task.id),
    taskTitles = tasks.map((task) => task.title);
  if (lanes.length)
    return {
      kind: 'new_plan',
      lane_id: lanes[0]!.id,
      lane_title: lanes[0]!.title,
      ...(taskIds.length ? { task_ids: taskIds, task_titles: taskTitles } : {}),
    };
  if (tasks.length) {
    const laneTitle = now!.lanes.find((lane) => lane.id === tasks[0]!.lane)?.title;
    return {
      kind: 'added',
      lane_id: tasks[0]!.lane,
      ...(laneTitle === undefined ? {} : { lane_title: laneTitle }),
      task_ids: taskIds,
      task_titles: taskTitles,
    };
  }
  if (
    ctx.store.db
      .prepare(
        "SELECT 1 FROM events WHERE aggregate_id=? AND kind='lead.question_asked' AND sequence>? AND sequence<? LIMIT 1",
      )
      .get(turn.session_id, span.start, span.end)
  )
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
    const routed = deliver(
      ctx,
      p,
      c,
      requestTarget(ctx, p, input, c.command_id),
      input.input,
      input.attachments,
    );
    personalCalled(ctx, p, c, input.project_id);
    return routed;
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
