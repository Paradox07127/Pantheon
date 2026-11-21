import {
  DomainError,
  requireThat,
  type Principal,
  type Review,
  type Session,
  type SessionTurn,
  type Workspace,
} from '@pantheon/domain';
import { inputSchemas, USER_PRINCIPAL_ID, type Command } from '@pantheon/protocol';
import { projectChanges } from './changes.js';
import {
  projectAccess,
  revision,
  sessionWorkspaceKind,
  type ControlContext,
  type Handler,
  type Preparers,
} from './context.js';
import { sessionGoal } from './landing-diff.js';
import { latestEvent, needsYou } from './needs-you.js';
import {
  requireCrossReview,
  requireNoRunningReviewer,
  sessionChanges,
  startSessionReview,
} from './review.js';
import { notifySession } from './session-wake.js';
import {
  checkWorktreeSession,
  openWorktreeSession,
  prepareReadyMerge,
  readSessionOpening,
  sessionList,
} from './workbench-session.js';

/** The only instructions Pantheon adds to a conductor session. */
export const CONDUCTOR_INSTRUCTIONS =
  "Pantheon gives this session four tools. request_review: another vendor reviews your committed changes; the result comes back to you as a message. report_ready: your committed changes go through the project's gate and land. spawn_session: another vendor's session starts in a new worktree from your current commit; you hear when its turn ends. read_state: this project's changes, checks, landing queue and items waiting for the user. Plan, split work and run subagents with your own tools.";

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
  const review = ctx.store
    .list<Review>('reviews')
    .findLast((each) => each.session_id === target.id && each.state !== 'running');
  requireThat(
    !review?.findings.some(
      (finding) => finding.blocking && finding.status === 'open' && !finding.resolution,
    ),
    'review_blocking_open',
    'The latest review of this work has open blocking findings; fix them and request another review first',
  );
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
        next: 'The gate runs now; the result comes back to you as a message.',
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
    return {
      next: 'The gate and landing start when this turn ends; the result comes back to you as a message.',
    };
  };
}

/** An upper bound on what one conductor can spend through the sessions it starts. */
const SPAWNED_SESSION_LIMIT = 4;

/** The session.create input of a spawned session: a worktree cut from the caller's committed HEAD. */
function spawnInput(ctx: ControlContext, p: Principal, command: Command) {
  requireThat(p.role === 'conductor', 'permission_denied', 'A conductor session only');
  projectAccess(ctx, p, p.project_id!, command.type);
  const { runtime, input, model, effort } = inputSchemas['conductor.spawn'].parse(command.input);
  const caller = ctx.store.must<Session>('sessions', p.session_id!);
  const unfinished = ctx.store
    .list<Session>('sessions')
    .filter(
      (session) =>
        session.spawned_by?.session_id === caller.id &&
        session.state !== 'closed' &&
        !session.outcome,
    );
  requireThat(
    unfinished.length < SPAWNED_SESSION_LIMIT,
    'resource_busy',
    `At most ${SPAWNED_SESSION_LIMIT} unfinished spawned sessions at a time; these are unfinished: ${unfinished
      .map((session) => `${session.id} (${session.title ?? ''})`)
      .join(', ')}`,
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

/**
 * Once a spawned session has no turn left, tells the session that started it how its last turn
 * ended; a turn the user cancelled or stopped tells nothing, and each turn tells once.
 */
export function afterSpawnedTurn(ctx: ControlContext, sessionId: string): void {
  const session = ctx.store.get<Session>('sessions', sessionId);
  const callerId = session?.spawned_by?.session_id;
  if (!session || !callerId || session.stop_requested || ctx.closing) return;
  const caller = ctx.store.get<Session>('sessions', callerId);
  if (!caller || caller.state === 'closed') return;
  const turn = ctx.store
    .list<SessionTurn>('session_turns')
    .filter((each) => each.session_id === session.id)
    .at(-1);
  if (!turn || (turn.state !== 'completed' && turn.state !== 'failed')) return;
  const reported = latestEvent(ctx, session.id, 'session.spawner_notified');
  if (reported && JSON.parse(reported.payload).turn_id === turn.id) return;
  const listed = sessionList(
    ctx,
    { id: USER_PRINCIPAL_ID, role: 'user' },
    session.project_id,
    'cached',
  ).find((each) => each.id === session.id);
  const target = session.workspace_id
    ? ctx.store.get<Workspace>('workspaces', session.workspace_id)?.source_branch
    : undefined;
  const failure = latestEvent(ctx, turn.id, 'turn.failed');
  const { error, error_code } = failure
    ? (JSON.parse(failure.payload) as { error?: string; error_code?: string })
    : {};
  const reason = error_code ?? error?.split('\n')[0];
  const text = [
    `[Pantheon] Session "${session.title ?? ''}" (${session.id}, ${session.runtime}), which you spawned, ${
      turn.state === 'completed'
        ? 'completed its turn.'
        : `failed its turn${reason ? `: ${reason}` : ''}.`
    }`,
    ...(listed?.branch
      ? [
          `It is on branch ${listed.branch}${
            listed.ahead !== undefined && target
              ? `, ${listed.ahead} commits ahead of ${target}`
              : ''
          }.`,
        ]
      : []),
    ...(turn.state === 'completed'
      ? ['Review it with request_review, land it with report_ready, or read it in its worktree.']
      : []),
  ].join(' ');
  ctx.store.transaction(() => {
    notifySession(ctx, caller.id, text, turn.id);
    ctx.store.event('session.spawner_notified', session, session.project_id, {
      turn_id: turn.id,
      session_id: caller.id,
    });
  });
}

/** conductor.state */
function prepareConductorState(ctx: ControlContext, p: Principal, command: Command): Handler {
  requireThat(p.role === 'conductor', 'permission_denied', 'A conductor session only');
  const projectId = p.project_id ?? '';
  projectAccess(ctx, p, projectId, command.type);
  // The conductor's access is checked above; the shared reads then run as for the user.
  const reader: Principal = { id: p.id, role: 'user' };
  const items = needsYou(ctx, reader, projectId).items;
  const mergedSince = new Date(ctx.store.now() - 24 * 60 * 60_000).toISOString();
  const changes = projectChanges(ctx, reader, projectId, items)
    .filter((row) => row.status !== 'merged' || row.updated_at >= mergedSince)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, 30)
    .map((row) => (row.id === `session:${p.session_id}` ? { ...row, self: true } : row));
  const todo = items.slice(0, 20).map((item) => {
    const sessionId = item.source.table === 'sessions' ? item.source.id : item.session_id;
    return {
      reason: item.reason,
      ...(sessionId ? { session_id: sessionId } : {}),
      created_at: item.created_at,
    };
  });
  return () => ({ changes, todo });
}

export const conductorPreparers: Preparers = {
  'conductor.review': prepareConductorReview,
  'conductor.ready': prepareConductorReady,
  'conductor.spawn': prepareConductorSpawn,
  'conductor.state': prepareConductorState,
};
