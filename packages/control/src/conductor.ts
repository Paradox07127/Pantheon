import {
  DomainError,
  requireThat,
  type Principal,
  type Project,
  type Session,
  type SessionTurn,
  type Workspace,
} from '@pantheon/domain';
import { inputSchemas, type Command } from '@pantheon/protocol';
import { projectChanges } from './changes.js';
import {
  projectAccess,
  revision,
  sessionWorkspaceKind,
  type ControlContext,
  type Handler,
  type Preparers,
} from './context.js';
import { runGit } from './git.js';
import { gateCommands } from './landing.js';
import { sessionGoal } from './landing-diff.js';
import { executed, latestEvent, needsYou } from './needs-you.js';
import {
  requireCrossReview,
  requireNoBlockingReview,
  requireNoRunningReviewer,
  sessionChanges,
  startSessionReview,
} from './review.js';
import { notifySession, takesNotice } from './session-wake.js';
import {
  checkWorktreeSession,
  openWorktreeSession,
  prepareReadyMerge,
  readSessionOpening,
  worktreeStatusArgs,
} from './workbench-session.js';

/** The instructions Pantheon adds to a conductor session after the line on where it works. */
export const CONDUCTOR_INSTRUCTIONS =
  "Pantheon gives this session five tools. request_review: another vendor reviews your committed changes; the result comes back to you as a message. report_ready: your committed changes go through the project's gate and land. spawn_session: another vendor's session starts in a new worktree from your current commit; you hear when its turn ends. read_state: this project's changes, checks, landing queue and items waiting for the user. draw: a chart or diagram the user sees in this session. Plan, split work and run subagents with your own tools.";

/** conductor.review; the session's committed range and its diff are read before the transaction. */
function prepareConductorReview(
  ctx: ControlContext,
  p: Principal,
  command: Command,
): Promise<Handler> {
  requireThat(p.role === 'conductor', 'permission_denied', 'A conductor session only');
  const target = (ctx: ControlContext, p: Principal, command: Command) => {
    const input = inputSchemas['conductor.review'].parse(command.input);
    const session = ctx.store.get<Session>('sessions', input.session_id ?? p.session_id!);
    requireThat(
      session && (session.id === p.session_id || session.spawned_by?.session_id === p.session_id),
      'permission_denied',
      'Review your own session or a session you spawned',
    );
    projectAccess(ctx, p, session.project_id, command.type);
    revision(ctx, command);
    requireCrossReview(ctx, session, input.runtimes);
    return { input, session };
  };
  const { session } = target(ctx, p, command);
  return (async () => {
    const changes = await sessionChanges(ctx, session);
    return (ctx: ControlContext, p: Principal, command: Command) => {
      const { input, session } = target(ctx, p, command);
      requireNoRunningReviewer(ctx, session, input.runtimes);
      const review = startSessionReview(ctx, session, input.runtimes, {
        cause: command.command_id,
        goal: sessionGoal(ctx, session),
        changes,
        notify_session_id: p.session_id!,
      });
      return { review_id: review.id, runtimes: review.runtimes };
    };
  })();
}

/** conductor.ready */
function prepareConductorReady(
  ctx: ControlContext,
  p: Principal,
  command: Command,
): Handler | Promise<Handler> {
  requireThat(p.role === 'conductor', 'permission_denied', 'A conductor session only');
  const input = inputSchemas['conductor.ready'].parse(command.input),
    target = ctx.store.must<Session>('sessions', input.session_id ?? p.session_id!);
  projectAccess(ctx, p, target.project_id, command.type);
  requireThat(
    target.id === p.session_id || target.spawned_by?.session_id === p.session_id,
    'permission_denied',
    'Name a session you spawned',
  );
  requireThat(
    !target.in_place,
    'invalid_state',
    'This session works in the project folder; report_ready does not land it, the user lands it in the app',
  );
  requireNoBlockingReview(ctx, target.id);
  if (input.session_id) {
    requireThat(
      target.state !== 'running',
      'resource_busy',
      'That session is taking a turn; call report_ready again once its turn ends',
    );
    return prepareReadyMerge(
      ctx,
      { ...command, expected_revision: target.revision },
      target.id,
    ).then((admit) => (ctx) => {
      admit(ctx);
      return {
        session_id: target.id,
        next: gated(ctx, target)
          ? 'The gate runs now; the result comes back to you as a message.'
          : 'This project has no gate commands, so the work lands without a gate; the result comes back to you as a message.',
      };
    });
  }
  const turn = ctx.store
    .list<SessionTurn>('session_turns')
    .find((each) => each.session_id === target.id && each.state === 'running');
  requireThat(turn, 'invalid_state', 'Call report_ready during your turn');
  return (ctx) => {
    const session = ctx.store.must<Session>('sessions', target.id);
    ctx.store.update(
      'sessions',
      { ...session, ready: { turn_id: turn.id, command_id: command.command_id } },
      session.revision,
    );
    const when = ctx.store
      .list<SessionTurn>('session_turns')
      .some((each) => each.session_id === session.id && each.state === 'queued')
      ? 'once this turn and the turns queued after it end'
      : 'when this turn ends';
    return {
      next: gated(ctx, session)
        ? `The gate and landing start ${when}; the result comes back to you as a message.`
        : `This project has no gate commands, so the work lands without a gate ${when}; the result comes back to you as a message.`,
    };
  };
}

/**
 * Drops the session's ready declaration once a turn after the one that declared it failed or was
 * cancelled, and tells the session; that turn's work was not what was declared ready.
 */
export function dropReadyAfterEndedTurn(ctx: ControlContext, sessionId: string): void {
  const ready = ctx.store.get<Session>('sessions', sessionId)?.ready;
  // A turn the daemon's shutdown ends says nothing of the work.
  if (!ready || ctx.closing) return;
  const turns = ctx.store
    .list<SessionTurn>('session_turns')
    .filter((each) => each.session_id === sessionId);
  const declaring = turns.findIndex((each) => each.id === ready.turn_id);
  const ended = turns
    .slice(declaring + 1)
    .find((each) => each.state === 'failed' || each.state === 'cancelled');
  if (declaring < 0 || turns[declaring]!.state !== 'completed' || !ended) return;
  ctx.store.transaction(() => {
    const session = ctx.store.must<Session>('sessions', sessionId);
    ctx.store.update('sessions', { ...session, ready: undefined }, session.revision);
    notifySession(
      ctx,
      sessionId,
      `[Pantheon] Your work did not land: a turn after the one that called report_ready ${ended.state === 'failed' ? 'failed' : 'was cancelled'}. Call report_ready again once the work is ready.`,
      ready.command_id,
    );
  });
}

/** Whether the project's gate has commands for the session's worktree; without any, a landing runs no gate. */
function gated(ctx: ControlContext, session: Session): boolean {
  const project = ctx.store.must<Project>('projects', session.project_id),
    workspace = ctx.store.must<Workspace>('workspaces', session.workspace_id!);
  return !!gateCommands(ctx, project, workspace, session)?.length;
}

/** An upper bound on what one conductor can spend through the sessions it starts. */
const SPAWNED_SESSION_LIMIT = 4;

/** The session.create input of a spawned session: a worktree cut from the caller's committed HEAD. */
function spawnInput(ctx: ControlContext, p: Principal, command: Command) {
  requireThat(p.role === 'conductor', 'permission_denied', 'A conductor session only');
  projectAccess(ctx, p, p.project_id!, command.type);
  const { runtime, input, model, effort } = inputSchemas['conductor.spawn'].parse(command.input);
  const caller = ctx.store.must<Session>('sessions', p.session_id!);
  const busy = new Set(
    ctx.store
      .list<SessionTurn>('session_turns')
      .filter((turn) => turn.state === 'queued' || turn.state === 'running')
      .map((turn) => turn.session_id),
  );
  const taking = ctx.store
    .list<Session>('sessions')
    .filter((session) => session.spawned_by?.session_id === caller.id && busy.has(session.id));
  requireThat(
    taking.length < SPAWNED_SESSION_LIMIT,
    'resource_busy',
    `At most ${SPAWNED_SESSION_LIMIT} spawned sessions take a turn at a time; these are taking one: ${taking
      .map((session) => `${session.id} (${session.title ?? ''})`)
      .join(', ')}. You get a message as each turn ends.`,
  );
  return inputSchemas['session.create'].parse({
    project_id: caller.project_id,
    workspace: 'worktree',
    runtime,
    model,
    effort,
    input,
    // An in-place caller's HEAD is the project folder's, which a start without `from` reads.
    ...(sessionWorkspaceKind(ctx, caller) === 'linked_worktree'
      ? { from: { session_id: caller.id } }
      : {}),
  });
}

/** conductor.spawn */
function prepareConductorSpawn(
  ctx: ControlContext,
  p: Principal,
  command: Command,
): Promise<Handler> {
  const input = spawnInput(ctx, p, command);
  checkWorktreeSession(ctx, input, undefined, p);
  return readSessionOpening(ctx, input).then(
    (opening) => (ctx: ControlContext, p: Principal, command: Command) => {
      const opened = openWorktreeSession(
        ctx,
        spawnInput(ctx, p, command),
        command.command_id,
        opening,
        undefined,
        p,
      );
      ctx.store.update<Session>(
        'sessions',
        { ...opened, spawned_by: { session_id: p.session_id! } },
        opened.revision,
      );
      return { session_id: opened.id };
    },
  );
}

/** Per control, the callers a notice did not reach because they took no input then. */
const unreached = new WeakMap<ControlContext, Set<string>>();

function unreachedCaller(ctx: ControlContext, callerId: string): void {
  let callers = unreached.get(ctx);
  if (!callers) unreached.set(ctx, (callers = new Set()));
  callers.add(callerId);
}

/**
 * The spawned session's completed and failed turns its caller has not heard of, in the order they
 * ended; a steer delivered into a running turn and a turn that ended once the session was stopped
 * are left out.
 */
function untoldTurns(ctx: ControlContext, sessionId: string): SessionTurn[] {
  const told = new Set(
    (
      ctx.store
        .statement(
          "SELECT json_extract(payload,'$.turn_id') AS turn_id FROM events WHERE aggregate_id=? AND kind='session.spawner_notified'",
        )
        .all(sessionId) as { turn_id: string }[]
    ).map((row) => row.turn_id),
  );
  const turns = ctx.store
    .list<SessionTurn>('session_turns')
    .filter((each) => each.session_id === sessionId && executed(ctx, each));
  const stop = ctx.store.must<Session>('sessions', sessionId).stop_requested;
  // Notices go out in order, so a turn before the last one told was passed over before that held.
  return turns
    .slice(turns.findLastIndex((each) => told.has(each.id)) + 1)
    .filter(
      (each) =>
        (each.state === 'completed' || each.state === 'failed') &&
        (!stop ||
          (latestEvent(ctx, each.id, `turn.${each.state}`)?.created_at ?? Infinity) < stop.at),
    );
}

/**
 * Tells the session that started this one how each of its turns ended, once per turn and in
 * order; a turn the user cancelled or stopped tells nothing. A notice the caller cannot take yet
 * waits for it, and one the daemon's shutdown holds back goes out on the next start.
 */
function tellSpawner(ctx: ControlContext, session: Session): void {
  const callerId = session.spawned_by?.session_id;
  if (!callerId || ctx.closing) return;
  const caller = ctx.store.get<Session>('sessions', callerId);
  if (!caller || caller.state === 'closed' || !untoldTurns(ctx, session.id).length) return;
  if (!takesNotice(ctx, caller)) return unreachedCaller(ctx, callerId);
  const ended =
    session.outcome === 'discarded'
      ? 'discarded'
      : session.state === 'closed'
        ? 'closed'
        : undefined;
  const notice = (turn: SessionTurn) => {
    const failure = latestEvent(ctx, turn.id, 'turn.failed');
    const { error, error_code } = failure
      ? (JSON.parse(failure.payload) as { error?: string; error_code?: string })
      : {};
    const reason = error_code ?? error?.split('\n')[0];
    return [
      `[Pantheon] Session "${session.title ?? ''}" (${session.id}, ${session.runtime}), which you spawned, ${
        turn.state === 'completed'
          ? 'completed its turn.'
          : `failed its turn${reason ? `: ${reason}` : ''}.`
      }`,
      ...(ended
        ? [`It was ${ended}.`]
        : [
            'Find its branch with read_state.',
            ...(turn.state === 'completed'
              ? [
                  'Review it with request_review, land it with report_ready, or read it in its worktree.',
                ]
              : []),
          ]),
    ].join(' ');
  };
  ctx.store.transaction(() => {
    for (const turn of untoldTurns(ctx, session.id)) {
      if (!notifySession(ctx, caller.id, notice(turn), turn.id))
        return unreachedCaller(ctx, caller.id);
      ctx.store.event(
        'session.spawner_notified',
        ctx.store.must<Session>('sessions', session.id),
        session.project_id,
        { turn_id: turn.id, session_id: caller.id },
      );
    }
  });
}

/** Sends the notices of the sessions this one spawned that have not reached it. */
function tellCaller(ctx: ControlContext, callerId: string): void {
  for (const session of ctx.store.list<Session>('sessions'))
    if (session.spawned_by?.session_id === callerId) tellSpawner(ctx, session);
}

/**
 * Once a turn of the session ended: tells its spawner, when it has one, and sends the notices
 * that waited for this session to end its own turn.
 */
export function afterSpawnedTurn(ctx: ControlContext, sessionId: string): void {
  const session = ctx.store.get<Session>('sessions', sessionId);
  if (!session || ctx.closing) return;
  tellSpawner(ctx, session);
  tellCaller(ctx, sessionId);
}

/** Sends the waiting notices of the callers that take input again. */
export function retrySpawnerNotices(ctx: ControlContext): void {
  const callers = unreached.get(ctx);
  for (const callerId of callers ?? []) {
    const caller = ctx.store.get<Session>('sessions', callerId);
    if (caller && caller.state !== 'closed' && !takesNotice(ctx, caller)) continue;
    callers!.delete(callerId);
    if (caller && caller.state !== 'closed') tellCaller(ctx, callerId);
  }
}

/** On start, sends every notice that did not go out before the daemon stopped. */
export function tellSpawners(ctx: ControlContext): void {
  for (const session of ctx.store.list<Session>('sessions')) tellSpawner(ctx, session);
}

/** Whether the session's HEAD is the commit it last landed and its index and files are clean. */
async function atLandedCommit(ctx: ControlContext, sessionId: string): Promise<boolean> {
  const session = ctx.store.get<Session>('sessions', sessionId);
  const workspace = session?.workspace_id
    ? ctx.store.get<Workspace>('workspaces', session.workspace_id)
    : undefined;
  const merged = latestEvent(ctx, sessionId, 'session.merged');
  if (!workspace || !merged) return false;
  const status = await runGit(workspace.path, await worktreeStatusArgs(), undefined, true);
  if (status.exit_code !== 0) return false;
  // Porcelain v2 with --branch: header records start with "# ", every other record is a change.
  const records = status.stdout.toString().split('\0').filter(Boolean);
  return (
    records.every((record) => record.startsWith('# ')) &&
    records.includes(`# branch.oid ${(JSON.parse(merged.payload) as { to_sha?: string }).to_sha}`)
  );
}

/** conductor.state; the caller's worktree is read before the transaction. */
function prepareConductorState(
  ctx: ControlContext,
  p: Principal,
  command: Command,
): Promise<Handler> {
  requireThat(p.role === 'conductor', 'permission_denied', 'A conductor session only');
  const projectId = p.project_id ?? '';
  projectAccess(ctx, p, projectId, command.type);
  return atLandedCommit(ctx, p.session_id!).then((landed) => (ctx: ControlContext) => {
    // The conductor's access is checked above; the shared reads then run as for the user.
    const reader: Principal = { id: p.id, role: 'user' };
    const items = needsYou(ctx, reader, projectId).items;
    const mergedSince = new Date(ctx.store.now() - 24 * 60 * 60_000).toISOString();
    const changes = projectChanges(ctx, reader, projectId, items)
      .filter((row) => row.status !== 'merged' || row.updated_at >= mergedSince)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, 30)
      .map((row) =>
        row.id === `session:${p.session_id}`
          ? {
              ...row,
              self: true,
              ...(row.status === 'running' && landed ? { landed: true as const } : {}),
            }
          : row,
      );
    const todo = items.slice(0, 20).map((item) => {
      const sessionId = item.source.table === 'sessions' ? item.source.id : item.session_id;
      return {
        reason: item.reason,
        ...(sessionId ? { session_id: sessionId } : {}),
        created_at: item.created_at,
      };
    });
    return { changes, todo };
  });
}

export const conductorPreparers: Preparers = {
  'conductor.review': prepareConductorReview,
  'conductor.ready': prepareConductorReady,
  'conductor.spawn': prepareConductorSpawn,
  'conductor.state': prepareConductorState,
};
