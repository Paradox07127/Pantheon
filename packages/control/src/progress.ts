import {
  hash,
  type BackgroundTask,
  type BoardPlan,
  type Event,
  type Project,
  type Session,
  type SessionTurn,
  type Workspace,
} from '@pantheon/domain';
import type { ControlContext } from './context.js';
import { taskGeneration, taskSessions } from './board-plan.js';
import { gateCommands } from './landing.js';
import { sessionTasks } from './session-tasks.js';

/** A running turn without progress or a tool call under way this long shows as quiet on the board. */
export const QUIET_MS = 2 * 60_000;
/** A running turn without progress or a tool call under way this long is stalled; the tracker tells the lead. */
export const STALL_MS = 10 * 60_000;
/** A tool call open this long, in milliseconds, has hung; its turn is stalled. */
export const HUNG_CALL_MS = 3 * STALL_MS;
/**
 * A background task running this long is told once: to the lead of a task session, else in
 * needs-you. It is the line of a hung tool call; builds, test runs and servers sent to the
 * background are meant to outlast STALL_MS, and the runtimes catch a task blocked on a prompt sooner.
 */
export const BACKGROUND_LONG_MS = HUNG_CALL_MS;
/** Failed calls of one tool with one input in a row that make a loop; the tracker tells the lead. */
export const LOOP_CALLS = 3;
/** Successful calls of one tool with one input in a row, with no other call between, that make a loop. */
export const REPEAT_CALLS = 5;
/** Failed calls taking turns between two tools or inputs that make a loop: LOOP_CALLS of each. */
export const ALTERNATING_CALLS = 2 * LOOP_CALLS;
/** Input fields of free text or limits, left out when calls are compared. */
const FREE_TEXT_FIELDS = ['description', 'timeout'];

// A turn start counts so that a new turn is measured from its start, not from an earlier turn.
export const PROGRESS_KINDS = [
  'turn.running',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
  'agent.tool.completed',
  'session.gate_checked',
  'session.merged',
];

type Call = Record<string, unknown>;

/** What a running turn has done since it started. */
export interface TurnActivity {
  started_at: number;
  /** The turn's newest progress event, or its start. */
  acted_at: number;
  /** The newest tool call not yet completed. */
  open_call?: { at: number; name: string; input?: unknown };
  /** When the turn's newest tool call completed. */
  tool_ended_at?: number;
  /** When the turn last streamed text. */
  streamed_at?: number;
  /** The session has background tasks running, which keep a Claude turn open with no events. */
  background?: true;
  /** The completed calls in order, each with the call's start payload when it is recorded. */
  completed: { ok: unknown; call?: Call; sequence?: number }[];
}

/** The activity of the session's turn since its latest start; undefined before it started. */
export function turnActivity(
  ctx: ControlContext,
  sessionId: string,
  turnId: string,
): TurnActivity | undefined {
  const started = ctx.store.db
    .prepare(
      "SELECT sequence, created_at FROM events WHERE aggregate_id=? AND kind='turn.running' ORDER BY sequence DESC LIMIT 1",
    )
    .get(turnId) as { sequence: number; created_at: number } | undefined;
  if (!started) return;
  const rows = ctx.store.db
    .prepare(
      `SELECT sequence, kind, created_at, payload FROM events WHERE aggregate_id=? AND sequence>? AND kind IN (${PROGRESS_KINDS.map(() => '?').join(',')}, 'agent.tool.started') ORDER BY sequence`,
    )
    .all(sessionId, started.sequence, ...PROGRESS_KINDS) as {
    sequence: number;
    kind: string;
    created_at: number;
    payload: string;
  }[];
  const streamed = ctx.store.db
    .prepare(
      "SELECT created_at FROM events WHERE aggregate_id=? AND sequence>? AND kind='agent.message.delta' AND json_extract(payload,'$.turn_id')=? ORDER BY sequence DESC LIMIT 1",
    )
    .get(sessionId, started.sequence, turnId) as { created_at: number } | undefined;
  const calls = new Map<unknown, { at: number; payload: Call; done: boolean }>();
  const activity: TurnActivity = {
    started_at: started.created_at,
    acted_at: started.created_at,
    ...(streamed ? { streamed_at: streamed.created_at } : {}),
    ...(backgroundTasks(ctx, sessionId).length ? { background: true as const } : {}),
    completed: [],
  };
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as Call;
    // Agent events name their turn; a later queued turn's events are not this turn's.
    if (row.kind.startsWith('agent.') && payload.turn_id !== turnId) continue;
    if (PROGRESS_KINDS.includes(row.kind))
      activity.acted_at = Math.max(activity.acted_at, row.created_at);
    if (row.kind === 'agent.tool.started')
      calls.set(payload.tool_call_id, { at: row.created_at, payload, done: false });
    else if (row.kind === 'agent.tool.completed') {
      const call = calls.get(payload.tool_call_id);
      if (call) call.done = true;
      activity.completed.push({ ok: payload.ok, call: call?.payload, sequence: row.sequence });
      activity.tool_ended_at = row.created_at;
    }
  }
  const open = [...calls.values()].filter((call) => !call.done).at(-1);
  if (open)
    activity.open_call = {
      at: open.at,
      name: (open.payload.name as string | undefined) ?? '',
      input: open.payload.input,
    };
  return activity;
}

/** True when the running turn made no progress for QUIET_MS and has no tool call under way. */
export const quiet = (activity: TurnActivity, now: number): boolean =>
  !activity.open_call && now - activity.acted_at > QUIET_MS;

/**
 * True when the running turn's tool call has been open for HUNG_CALL_MS, or, with no tool call
 * or background task under way, it made no progress and streamed no text for STALL_MS.
 */
export const stalled = (activity: TurnActivity, now: number): boolean =>
  activity.open_call
    ? now - activity.open_call.at > HUNG_CALL_MS
    : !activity.background &&
      now - Math.max(activity.acted_at, activity.streamed_at ?? 0) > STALL_MS;

/** The session's running background tasks; none once its process started anew or exited. */
export const backgroundTasks = (ctx: ControlContext, sessionId: string): BackgroundTask[] =>
  sessionTasks(ctx, sessionId)
    .tasks.filter((task) => task.background && task.state === 'running')
    .map(({ id, kind, description, started_at }) => ({
      id,
      kind: kind === 'workflow' ? 'other' : kind,
      description,
      started_at,
    }));

/** The session's background tasks that have run for BACKGROUND_LONG_MS. */
export const longBackground = (ctx: ControlContext, sessionId: string): BackgroundTask[] =>
  backgroundTasks(ctx, sessionId).filter(
    (task) => ctx.store.now() - task.started_at >= BACKGROUND_LONG_MS,
  );

/** A loop the turn's latest completed calls make. */
export interface TurnLoop {
  form: 'failing' | 'repeating' | 'alternating';
  /** The loop's latest call. */
  call: Call;
  /** The call an alternating loop takes turns with. */
  other?: Call;
  /** The completed calls the loop spans, oldest first. */
  calls: TurnActivity['completed'];
}

/** The call's tool and input without free-text fields; undefined when the call is not recorded. */
function callKey(call: Call | undefined): string | undefined {
  if (call?.name === undefined) return;
  const input = call.input;
  return JSON.stringify([
    call.name,
    input && typeof input === 'object' && !Array.isArray(input)
      ? Object.fromEntries(
          Object.entries(input).filter(([field]) => !FREE_TEXT_FIELDS.includes(field)),
        )
      : (input ?? null),
  ]);
}

/**
 * The loop of the turn's latest completed calls: one call failing LOOP_CALLS times in a row, two
 * failing calls taking turns ALTERNATING_CALLS times, or one call succeeding REPEAT_CALLS times in a row.
 */
export function turnLoop(activity: TurnActivity): TurnLoop | undefined {
  const done = activity.completed,
    keys = done.map((entry) => callKey(entry.call));
  // The latest calls, back to the first that breaks a pattern repeating every period calls.
  const run = (period: number, ok: boolean) => {
    let start = done.length;
    while (
      start > 0 &&
      keys[start - 1] !== undefined &&
      done[start - 1]!.ok === ok &&
      (start - 1 + period >= done.length || keys[start - 1] === keys[start - 1 + period])
    )
      start--;
    return done.slice(start);
  };
  const failing = run(1, false);
  if (failing.length >= LOOP_CALLS)
    return { form: 'failing', call: failing.at(-1)!.call!, calls: failing };
  const alternating = run(2, false);
  if (alternating.length >= ALTERNATING_CALLS)
    return {
      form: 'alternating',
      call: alternating.at(-1)!.call!,
      other: alternating.at(-2)!.call!,
      calls: alternating,
    };
  const repeating = run(1, true);
  if (repeating.length >= REPEAT_CALLS)
    return { form: 'repeating', call: repeating.at(-1)!.call!, calls: repeating };
}

/** A failing call the session's ended turns repeat. */
export interface SessionLoop {
  /** The repeated call as the newest turn last called it. */
  call: Call;
  /** The ended turns the loop spans. */
  turns: number;
}

/**
 * The call that failed as its last completion in each of the session's last LOOP_CALLS ended turns
 * that ran, the same count of failures that makes a loop within one turn; undefined otherwise.
 */
export function sessionLoop(
  ctx: ControlContext,
  sessionId: string,
  endedTurns: SessionTurn[],
): SessionLoop | undefined {
  const failed: Map<string, Call>[] = [];
  for (const turn of endedTurns.toReversed()) {
    if (failed.length === LOOP_CALLS) break;
    const activity = turnActivity(ctx, sessionId, turn.id);
    if (!activity) continue;
    const last = new Map<string, TurnActivity['completed'][number]>();
    for (const entry of activity.completed) {
      const key = callKey(entry.call);
      if (key === undefined) continue;
      last.delete(key);
      last.set(key, entry);
    }
    failed.push(
      new Map(
        [...last]
          .filter(([, entry]) => entry.ok === false)
          .map(([key, entry]) => [key, entry.call!]),
      ),
    );
  }
  if (failed.length < LOOP_CALLS) return;
  const [newest, ...older] = failed;
  const key = [...newest!.keys()].findLast((key) => older.every((turn) => turn.has(key)));
  if (key !== undefined) return { call: newest!.get(key)!, turns: failed.length };
}

type TaskRef = Pick<NonNullable<Session['task']>, 'lead_session_id' | 'id'>;

const VERIFIED_KINDS = ['session.merged', 'session.gate_checked', 'task.accepted'];

/**
 * The newest evidence that the task meets its current contract: a merge of one of its sessions, a
 * commit passing the session's current gate commands for the first time, or the lead accepting a
 * done report of its current generation.
 */
export const verifiedProgress = (ctx: ControlContext, task: TaskRef): Event | undefined =>
  verifiedProgressReader(ctx)(task);

/**
 * verifiedProgress for many tasks, reading the sessions and each project's evidence events once;
 * use it only while the store does not change.
 */
export function verifiedProgressReader(ctx: ControlContext): (task: TaskRef) => Event | undefined {
  let listed: Session[] | undefined;
  const evidence = new Map<string, Event[]>(),
    specs = new Map<string, string>();
  return (task) => {
    const plan = ctx.store.get<BoardPlan>('board_plans', task.lead_session_id);
    if (!plan) return;
    listed ??= ctx.store.list<Session>('sessions');
    const sessions = new Map(
        taskSessions(ctx, plan.id, task.id, listed).map((session) => [session.id, session]),
      ),
      passed = new Set<string>();
    const currentSpec = (session: Session) => {
      if (!specs.has(session.id))
        specs.set(
          session.id,
          hash(
            gateCommands(
              ctx,
              ctx.store.must<Project>('projects', plan.project_id),
              ctx.store.must<Workspace>('workspaces', session.workspace_id!),
              session,
            ),
          ),
        );
      return specs.get(session.id)!;
    };
    if (!evidence.has(plan.project_id))
      evidence.set(plan.project_id, ctx.store.kindEvents(plan.project_id, VERIFIED_KINDS));
    let newest: Event | undefined;
    for (const event of evidence.get(plan.project_id)!) {
      if (event.kind === 'task.accepted') {
        const accepted = event.payload as { task_id: string; generation?: number };
        if (
          event.aggregate_id === plan.id &&
          accepted.task_id === task.id &&
          (accepted.generation ?? 1) === taskGeneration(plan, task.id)
        )
          newest = event;
      } else if (!sessions.has(event.aggregate_id)) continue;
      else if (event.kind === 'session.merged') newest = event;
      else {
        const { commit, check_spec_hash, results } = event.payload as {
          commit: string;
          check_spec_hash?: string;
          results: { exit_code: number | null; timed_out?: boolean; state?: string }[];
        };
        const key = JSON.stringify([event.aggregate_id, commit, check_spec_hash]);
        if (
          check_spec_hash === currentSpec(sessions.get(event.aggregate_id)!) &&
          results.length &&
          results.every(
            (result) => result.state === 'skipped' || (result.exit_code === 0 && !result.timed_out),
          ) &&
          !passed.has(key)
        ) {
          passed.add(key);
          newest = event;
        }
      }
    }
    return newest;
  };
}

/** The depth of the turn's causal chain: 0 once its session merged or its task made verified progress after it was queued. */
export function chainDepth(
  ctx: ControlContext,
  turn: SessionTurn | undefined,
  task: TaskRef | undefined,
  verify = (task: TaskRef) => verifiedProgress(ctx, task),
): number {
  if (!turn) return 0;
  if (ctx.store.get<Session>('sessions', turn.session_id)?.outcome === 'merged') return 0;
  const verified = task ? verify(task) : undefined;
  if (verified) {
    const { queued } = ctx.store.db
      .prepare('SELECT min(sequence) AS queued FROM events WHERE aggregate_id=?')
      .get(turn.id) as { queued: number | null };
    if (verified.sequence > (queued ?? 0)) return 0;
  }
  return turn.causal_depth ?? 0;
}

/** The session's running turn, else its newest: the turn a daemon turn follows from. */
export function causeTurn(ctx: ControlContext, sessionId: string): SessionTurn | undefined {
  const turns = ctx.store
    .list<SessionTurn>('session_turns')
    .filter((turn) => turn.session_id === sessionId);
  return turns.findLast((turn) => turn.state === 'running') ?? turns.at(-1);
}

/** The causal depth of a daemon turn that follows from the session's running or newest turn. */
export const nextDepth = (ctx: ControlContext, sessionId: string, task: TaskRef | undefined) =>
  chainDepth(ctx, causeTurn(ctx, sessionId), task) + 1;
