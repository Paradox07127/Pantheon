import {
  requireThat,
  type AgentProfile,
  type Principal,
  type Session,
  type SessionTurn,
  type Timer,
} from '@pantheon/domain';
import { inputSchemas, type AgentRoutineRow, type AgentWake } from '@pantheon/protocol';
import { lastRoutineRun, ROUTINE, routineSubject, wakeAgent } from './agent-always-on.js';
import { finalOutput } from './agent-app-tools.js';
import { ensureAgents } from './agents.js';
import { projectAccess, userOnly, type ControlContext, type Handlers } from './context.js';
import { openOf } from './resident.js';
import { projectOverBudget } from './workflow-policy.js';

type Span = { turn: SessionTurn; at: number; start: number | null; end: number | null };

/** The agent's wake turns with when each was queued and the event span it ran in, newest first. */
export function wakeSpans(ctx: ControlContext, profile: AgentProfile): Span[] {
  const sessions = new Set(
    ctx.store
      .list<Session>('sessions')
      .filter((session) => session.resident?.agent_id === profile.id)
      .map((session) => session.id),
  );
  const span = ctx.store.statement(
    "SELECT min(CASE WHEN kind='turn.queued' THEN created_at END) AS at, max(CASE WHEN kind='turn.running' THEN sequence END) AS start, max(CASE WHEN kind IN ('turn.completed','turn.failed','turn.cancelled') THEN sequence END) AS end FROM events WHERE aggregate_id=?",
  );
  return ctx.store
    .list<SessionTurn>('session_turns')
    .filter((turn) => turn.origin === 'tracker' && turn.wake && sessions.has(turn.session_id))
    .map((turn) => ({
      turn,
      ...(span.get(turn.id) as { at: number; start: number | null; end: number | null }),
    }))
    .sort((a, b) => b.at - a.at);
}

/** The wake with what the agent did while its turn ran. */
export function wakeOf(ctx: ControlContext, { turn, at, start, end }: Span): AgentWake {
  const ids = <Row = { id: string; text: string }>(sql: string, sessionId: string) =>
    start === null
      ? []
      : (ctx.store.statement(sql).all(sessionId, start, end ?? Number.MAX_SAFE_INTEGER) as Row[]);
  const brief = ({ id, text }: { id: string; text: string }) => ({
    id,
    text: text.split('\n')[0]!.slice(0, 140),
  });
  const messages = ids(
      "SELECT payload ->> '$.id' AS id, payload ->> '$.text' AS text FROM events WHERE kind IN ('agent_message.created','agent_message.routed') AND payload ->> '$.session_id'=? AND sequence>? AND sequence<? ORDER BY sequence",
      turn.session_id,
    ).map(brief),
    questions = ids(
      "SELECT payload ->> '$.id' AS id, payload ->> '$.question' AS text FROM events WHERE aggregate_id=? AND kind='lead.question_asked' AND payload ->> '$.source' IS NULL AND sequence>? AND sequence<? ORDER BY sequence",
      turn.session_id,
    ).map(brief),
    // An event is the agent's own when the inbox holds its command under the session's principal.
    actions = ids<{ started: string | null }>(
      "SELECT CASE WHEN kind='task.start_requested' THEN payload ->> '$.task_ids' END AS started FROM events WHERE aggregate_id=? AND kind IN ('board.plan_updated','board.plan_proposed','task.start_requested','task.stop_requested') AND sequence>? AND sequence<? AND EXISTS(SELECT 1 FROM inbox WHERE source_key='session:'||events.aggregate_id||':command:'||events.causation_id)",
      turn.session_id,
    );
  return {
    turn_id: turn.id,
    session_id: turn.session_id,
    at,
    state: turn.state,
    causes: turn.wake!.causes,
    ...(turn.wake!.routine_ids && { routine_ids: turn.wake!.routine_ids }),
    ...(turn.usage && { usage: turn.usage }),
    outcome: questions.length
      ? 'asked'
      : messages.length
        ? 'told_user'
        : actions.length
          ? 'acted'
          : 'nothing',
    message_ids: messages.map((message) => message.id),
    question_ids: questions.map((question) => question.id),
    actions: actions.length,
    messages,
    questions,
    // A request may name a task twice, and a task waiting to dispatch may be started again.
    tasks_started: new Set(
      actions.flatMap((action) => (action.started ? (JSON.parse(action.started) as string[]) : [])),
    ).size,
  };
}

/** The agent's wakes, newest first. */
export function agentWakes(
  ctx: ControlContext,
  p: Principal,
  agentId: string,
  limit: number,
  routineId?: string,
): AgentWake[] {
  userOnly(p);
  const profile = ctx.store.must<AgentProfile>('agents', agentId);
  projectAccess(ctx, p, profile.project_id, 'agent.wakes');
  return wakeSpans(ctx, profile)
    .filter((span) => !routineId || span.turn.wake!.routine_ids?.includes(routineId))
    .slice(0, limit)
    .map((span) => wakeOf(ctx, span));
}

/** Each routine of the project's agents that are not archived, with its pending and last run. */
export function agentRoutines(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
): AgentRoutineRow[] {
  userOnly(p);
  projectAccess(ctx, p, projectId, 'agent.routines');
  const due = new Map(
    ctx.store
      .list<Timer>('timers')
      .filter((timer) => timer.kind === ROUTINE && timer.state === 'pending')
      .map((timer) => [timer.subject_id, timer.due_at]),
  );
  return ctx.store
    .list<AgentProfile>('agents')
    .filter((agent) => agent.project_id === projectId && !agent.archived_at)
    .flatMap((agent) => {
      const spans = agent.routines.length ? wakeSpans(ctx, agent) : [];
      return agent.routines.map((routine): AgentRoutineRow => {
        const next = due.get(routineSubject(agent, routine.id)),
          last = spans.find((span) => span.turn.wake!.routine_ids?.includes(routine.id));
        const wake = last && wakeOf(ctx, last);
        return {
          agent_id: agent.id,
          agent_name: agent.name,
          agent_revision: agent.revision,
          routine,
          ...(next !== undefined && { next_run_at: next }),
          ...(wake && {
            last_run: {
              turn_id: wake.turn_id,
              at: wake.at,
              state: wake.state,
              outcome: wake.outcome,
            },
          }),
        };
      });
    });
}

export const agentWakeHandlers: Handlers = {
  'agent.routine.run': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['agent.routine.run'].parse(c.input),
      profile = ctx.store.must<AgentProfile>('agents', input.agent_id);
    projectAccess(ctx, p, profile.project_id, c.type);
    const routine = profile.routines.find((each) => each.id === input.routine_id);
    requireThat(routine, 'not_found', `Not found: routine ${input.routine_id}`);
    requireThat(routine.enabled, 'invalid_state', 'Enable the routine before running it');
    const last = lastRoutineRun(ctx, profile, routine.id);
    // The user's own act, so the agent's contract does not hold it.
    wakeAgent(ctx, profile, 'routine', routine.prompt, c.command_id, {
      routine_id: routine.id,
      ...(last && { last_run_at: last.at }),
      bypass_hold: 'user',
    });
    return {
      session_id: openOf(ctx, profile)!.id,
      ...(projectOverBudget(ctx, profile.project_id) && { queued: 'budget' as const }),
    };
  },
  'agent.wake.to_task': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['agent.wake.to_task'].parse(c.input),
      turn = ctx.store.must<SessionTurn>('session_turns', input.turn_id);
    projectAccess(ctx, p, turn.project_id, c.type);
    const agentId = ctx.store.must<Session>('sessions', turn.session_id).resident?.agent_id,
      agent = agentId && ctx.store.get<AgentProfile>('agents', agentId);
    requireThat(
      agent && turn.origin === 'tracker' && turn.wake,
      'invalid_state',
      "Only an agent's wake can become a task",
    );
    const output = turn.state === 'completed' ? finalOutput(ctx, turn.session_id, turn.id) : '';
    requireThat(output, 'invalid_state', 'The wake ended without output');
    const routines = turn.wake.routine_ids?.length
      ? ` on routine ${turn.wake.routine_ids.join(', ')}`
      : '';
    const assistant = ensureAgents(ctx, turn.project_id).find(
      (each) => each.template === 'assistant',
    )!;
    // The user chose this text, so it counts as the user's words for a task's source.
    wakeAgent(
      ctx,
      assistant,
      'user_edit',
      `The user asks you to make a task of what ${agent.name} wrote in turn ${turn.id}${routines}. Plan it as the user's request; its text is the user's words, which you may quote in source:\n${output}`,
      c.command_id,
      { bypass_hold: 'user' },
    );
    return { session_id: openOf(ctx, assistant)!.id };
  },
};
