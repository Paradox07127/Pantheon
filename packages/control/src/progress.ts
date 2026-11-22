import type { Approval, BackgroundTask, SessionTurn } from '@pantheon/domain';
import type { ControlContext } from './context.js';
import { sessionTasks } from './session-tasks.js';

/** A running turn without progress or a tool call under way this long shows as quiet on the board. */
export const QUIET_MS = 2 * 60_000;
/** A running turn without progress or a tool call under way this long is stalled. */
export const STALL_MS = 10 * 60_000;
/** A tool call open this long, in milliseconds, has hung; its turn is stalled. */
export const HUNG_CALL_MS = 3 * STALL_MS;
/**
 * A background task running this long is told once in needs-you. It is the line of a hung tool call; builds, test runs and servers sent to the
 * background are meant to outlast STALL_MS, and the runtimes catch a task blocked on a prompt sooner.
 */
export const BACKGROUND_LONG_MS = HUNG_CALL_MS;
/** Failed calls of one tool with one input in a row that make a loop. */
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
  /** The session waits for the user to answer a permission request. */
  asking?: true;
  /** When the user last answered a permission request of the session. */
  answered_at?: number;
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
  for (const approval of ctx.store.list<Approval>('approvals'))
    if (approval.kind === 'permission' && approval.session_id === sessionId)
      if (approval.state === 'pending') activity.asking = true;
      else if (approval.resolved_at)
        activity.answered_at = Math.max(activity.answered_at ?? 0, approval.resolved_at);
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
  // A permission request waits for the user, and its answer restarts the window.
  !activity.asking &&
  (activity.open_call
    ? now - Math.max(activity.open_call.at, activity.answered_at ?? 0) > HUNG_CALL_MS
    : !activity.background &&
      now - Math.max(activity.acted_at, activity.streamed_at ?? 0, activity.answered_at ?? 0) >
        STALL_MS);

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
