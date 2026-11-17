import { prepareMemoryDelivery, finishMemoryDelivery, MEMORY_INSTRUCTIONS } from './memory.js';
import { lstatSync, mkdirSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  credentialRole,
  DomainError,
  id,
  SessionStartError,
  type CancelReceipt,
  type BoardPlan,
  requireThat,
  type Project,
  type Session,
  type SessionTurn,
  type Timer,
  type UserTurn,
  type Workspace,
  NATIVE_ENV_ALLOWLIST,
  type SessionHandle,
  type SessionSpec,
  type AgentEvent,
  type HarnessAdapter,
  type ProcessIdentity,
  type Principal,
} from '@pantheon/domain';
import { inputSchemas, type Command } from '@pantheon/protocol';
import { checkRuntimeConnection, isRuntimeHeld, updateRuntimeQuota } from './runtime-status.js';
import {
  revision,
  projectAccess,
  userOnly,
  gitFolderAsync,
  inside,
  insert,
  projectFolder,
  projectFolders,
  resolvedPath,
  sessionMcp,
  purposeSessionInstructions,
  sessionAdapter,
  bindSessionAdapter,
  type ControlContext,
  type Handler,
  type Handlers,
} from './context.js';
import { runtime } from './admission.js';
import {
  finishReconciledWriteAudit,
  finishWriteAudit,
  startWriteAudit,
  withReconciledState,
  type WrittenState,
} from './non-writer-audit.js';
import { agentEvent, saveSessionHandle, stopSession, turnDelivery } from './agent.js';
import { loseSessionApprovals } from './approvals.js';
import { REVIEW_WALL_TIME_MS, reviewerDirectory, settleReview } from './review.js';
import { BASELINE_WALL_TIME_MS } from './baseline.js';
import { readAppSettings } from './app-settings.js';
import { STORY_WALL_TIME_MS } from './change-story.js';
import { confirmTermination } from './process.js';
import { captureCheckpoint } from './checkpoint.js';
import {
  deviceTurn,
  onDevice,
  prepareRemoteWorkspace,
  pullingSink,
  pullRemoteWorkspace,
  pushRemoteWorkspace,
  remoteSessionSpec,
} from './remote-workspace.js';
import { serveSessionTools } from './remote-tools.js';
import { buildHandoff } from './handoff.js';
import { awaitingChange, planUnfinished, taskGeneration } from './board-plan.js';
import {
  appendNote,
  compactionInstructions,
  contractMoveWaits,
  followContractModel,
  followContractRuntime,
  noteUserMessage,
  returnNotes,
  takeContractChange,
  takeInbox,
} from './lead-inbox.js';
import {
  assertManagedLocation,
  plannerProtectionList,
  reviewerProtectionList,
} from './protection.js';
import { assertInPlaceSessionFree, inPlaceSessionSpec } from './in-place-session.js';
import { managedSessionSpec } from './native-session.js';
import { workspaceReady } from './provisioning.js';
import { daemonDriven, usageLimitWaiting } from './continuation.js';
import { cancelTimer, scheduleTimer } from './timers.js';
import { activeRuntimeReview, RUNTIME_REVIEW_CONTRACT } from './runtime-review.js';
import { projectOverBudget } from './workflow-policy.js';
import { queueTurn } from './task-tracking.js';
import { backgroundTasks } from './progress.js';
import {
  applyModel,
  applyPermissionMode,
  applyFastMode,
  applyUltracode,
  autoMergeAfterTurn,
  RESIDENT_INSTRUCTIONS,
  turnExtras,
  WORKBENCH_TURN_MS,
  workbenchSessionSpec,
} from './workbench-session.js';

const queues = new WeakMap<SessionHandle, ReturnType<typeof createTurnQueue>>();
const stopRetryAfter = new WeakMap<SessionHandle, number>();
/**
 * Running turns the user or a lead interrupted, with the user's turns queued behind them at that
 * moment. An interrupted end of such a turn is a cancel, not a failure, and cancels those queued turns.
 */
const interrupts = new Map<string, { queued: string[]; cause: string; by: 'user' | 'lead' }>();
/** Sessions whose native process is starting and has no handle yet. */
const launching = new Set<string>();
const conversationIdleLimitMs = 10 * 60 * 1000;
const deliveringContracts = new WeakMap<
  ControlContext,
  Map<string, { turn_id: string; generation: number }>
>();

/** The latest context an MCP interface gave each session, until a user turn carries it. */
const appContexts = new WeakMap<ControlContext, Map<string, { server: string; content: string }>>();

function takeAppContext(ctx: ControlContext, sessionId: string): string | undefined {
  const found = appContexts.get(ctx)?.get(sessionId);
  if (!found) return undefined;
  appContexts.get(ctx)!.delete(sessionId);
  return appContextText(found);
}

function appContextText(found: { server: string; content: string }): string {
  const server = found.server.replace(/["<>]/g, '');
  const content = found.content.replaceAll('</app-context>', '</app-context_>');
  return `<app-context server="${server}">\n${content}\n</app-context>`;
}

/** A report may arrive after native acceptance but before send returns its receipt. */
export const taskReportGeneration = (ctx: ControlContext, session: Session): number =>
  deliveringContracts.get(ctx)?.get(session.id)?.generation ?? session.task?.generation ?? 1;

const HANDOFF_RETRIES = 3;

const queuedInputs = (ctx: ControlContext, sessionId: string) =>
  ctx.store
    .list<SessionTurn>('session_turns')
    .filter(
      (turn) =>
        turn.session_id === sessionId &&
        turn.state === 'queued' &&
        (turn.delivery === 'pending' || turn.delivery === 'queued'),
    );

/** The caller owns the transaction. The original queue remains the source of message order. */
function holdQueuedHandoff(ctx: ControlContext, session: Session, first: SessionTurn): Session {
  if (session.queued_handoff) return session;
  const next = ctx.store.update(
    'sessions',
    { ...session, queued_handoff: { first_turn_id: first.id } },
    session.revision,
  );
  ctx.store.event('session.handoff_queued', next, next.project_id, { turn_id: first.id });
  return next;
}

/** Queues the oldest held input after the old process has confirmed its stop. */
export function advanceQueuedHandoffs(ctx: ControlContext): void {
  for (const session of ctx.store.list<Session>('sessions')) {
    const held = session.queued_handoff;
    if (
      !held ||
      held.blocked ||
      session.state === 'closed' ||
      session.state === 'reconciling' ||
      session.stop_pending ||
      session.stop_requested ||
      session.outcome ||
      sessionHandle(ctx, session) ||
      launching.has(session.id) ||
      (held.retry_at !== undefined && held.retry_at > ctx.store.now())
    )
      continue;
    const first = queuedInputs(ctx, session.id)[0];
    if (!first) continue;
    const moved = followContractRuntime(ctx, { ...session, state: 'open' }, '', first.id);
    let next = moved.session;
    if (moved.handoff !== undefined && first.handoff === undefined)
      ctx.store.update('session_turns', { ...first, handoff: moved.handoff }, first.revision);
    if (next.state !== 'running')
      next = ctx.store.update('sessions', { ...next, state: 'running' }, next.revision);
    if (
      !ctx.store
        .pending()
        .some(
          (job) =>
            job.kind === 'session.turn' &&
            (JSON.parse(job.payload) as { turn_id: string }).turn_id === first.id,
        )
    )
      ctx.store.enqueue('session.turn', { turn_id: first.id });
  }
}

/** Recovery calls this after confirming the previous process ended, inside its transaction. */
export function recoverQueuedHandoff(
  ctx: ControlContext,
  session: Session,
  interrupted: SessionTurn[],
): boolean {
  // An explicit discard owns recovery even when input delivery was unknown.
  if (session.stop_requested) return false;
  const first = session.queued_handoff
    ? ctx.store.get<SessionTurn>('session_turns', session.queued_handoff.first_turn_id)
    : undefined;
  if (first?.state === 'running' && first.delivery === 'pending') {
    const reason = 'Daemon restarted before the input delivery receipt was recorded';
    const failed = turnDelivery(ctx, first, 'failed', reason, 'failed');
    ctx.store.event('turn.failed', failed, failed.project_id, { error: reason });
    const next = ctx.store.update(
      'sessions',
      {
        ...session,
        state: 'reconciling',
        queued_handoff: { ...session.queued_handoff!, blocked: 'delivery_unknown' },
      },
      session.revision,
    );
    ctx.store.event('session.handoff_delivery_unknown', next, next.project_id, {
      turn_id: first.id,
      error: reason,
    });
    unsnooze(ctx, session.id, 'turn_ended');
    return true;
  }
  const pending = interrupted.filter(
    (turn) =>
      turn.state === 'queued' && (turn.delivery === 'pending' || turn.delivery === 'queued'),
  );
  if (session.queued_handoff?.blocked) return true;
  if (
    !pending.length ||
    (!session.queued_handoff && !contractMoveWaits(ctx, { ...session, state: 'open' }))
  )
    return false;
  for (const turn of interrupted) {
    if (pending.some((queued) => queued.id === turn.id)) {
      if (turn.delivery !== 'pending') turnDelivery(ctx, turn, 'pending', undefined, 'queued');
      continue;
    }
    const failed = turnDelivery(
      ctx,
      turn,
      turn.delivery,
      'Interrupted by a daemon restart',
      'failed',
    );
    ctx.store.event('turn.failed', failed, failed.project_id, {
      error: 'Interrupted by a daemon restart',
    });
  }
  const held = holdQueuedHandoff(ctx, session, pending[0]!);
  const next = ctx.store.update(
    'sessions',
    { ...held, state: 'running', stop_pending: false, process_identity: undefined },
    held.revision,
  );
  ctx.store.event('session.recovered', next, next.project_id, { queued_handoff: true });
  // Every interrupted turn outside the held queue failed above.
  if (interrupted.length > pending.length) unsnooze(ctx, session.id, 'turn_ended');
  advanceQueuedHandoffs(ctx);
  return true;
}

/** A known rejection is safe to retry; an exception from send leaves delivery unknown. */
function retryQueuedHandoff(ctx: ControlContext, sessionId: string, reason: string): boolean {
  const session = ctx.store.must<Session>('sessions', sessionId);
  const held = session.queued_handoff;
  if (!held || held.blocked) return false;
  const attempts = (held.attempts ?? 0) + 1;
  if (attempts >= HANDOFF_RETRIES) {
    const { queued_handoff, ...rest } = session;
    const next = ctx.store.update('sessions', rest, session.revision);
    ctx.store.event('session.handoff_retry_limit', next, next.project_id, { reason, attempts });
    return false;
  }
  const next = ctx.store.update(
    'sessions',
    {
      ...session,
      queued_handoff: {
        ...held,
        attempts,
        retry_at: ctx.store.now() + 1000 * 2 ** (attempts - 1),
      },
    },
    session.revision,
  );
  ctx.store.event('session.handoff_retry', next, next.project_id, { reason, attempts });
  return true;
}

/** A conversation the user talks to directly, outside any review or managed flow. */
function directConversation(session: Session): boolean {
  return !(
    session.review_id ||
    session.baseline ||
    session.change_story ||
    session.range_story ||
    session.intro
  );
}

/**
 * The reviews folder of every project folder: each project's folders, the one its next review goes
 * to, and every other folder in the managed roots, which may hold reviews of project rows now gone.
 */
export function reviewsRoots(ctx: ControlContext): string[] {
  if (!ctx.workspaceRoot) return [];
  const folders = new Set(
    ctx.store
      .list<Project>('projects')
      .flatMap((project) => [...projectFolders(ctx, project.id), projectFolder(ctx, project.id)]),
  );
  for (const root of ctx.managedWorkspaceRoots)
    if (lstatSync(root, { throwIfNoEntry: false })?.isDirectory())
      for (const entry of readdirSync(root, { withFileTypes: true }))
        if (entry.isDirectory()) folders.add(path.join(root, entry.name));
  return [...folders].map((folder) => path.join(folder, 'reviews'));
}

function sessionHandle(ctx: ControlContext, session: Session): SessionHandle | undefined {
  return [...ctx.handles.values()].find((h) => h.platform_session_id === session.id);
}

function pendingResume(ctx: ControlContext, sessionId: string) {
  const row = ctx.store.db
    .prepare(
      "SELECT payload FROM outbox WHERE kind='session.turn' AND state IN ('pending','sent') AND json_extract(payload,'$.resume')=1 AND json_extract(payload,'$.session_id')=?",
    )
    .get(sessionId) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as { turn_id: string; cause: string }) : undefined;
}

function endReconciledTurns(ctx: ControlContext, sessionId: string): void {
  loseSessionApprovals(ctx, sessionId);
  for (const turn of ctx.store
    .list<SessionTurn>('session_turns')
    .filter((t) => t.session_id === sessionId && ['queued', 'running'].includes(t.state))) {
    const reason = 'Previous execution ended during reconciliation';
    const ended = turnDelivery(
      ctx,
      turn,
      ['pending', 'queued'].includes(turn.delivery) ? 'failed' : turn.delivery,
      reason,
      'failed',
    );
    ctx.store.event('turn.failed', ended, ended.project_id, { error: reason });
  }
}

function closeToolRelay(ctx: ControlContext, sessionId: string): void {
  ctx.toolRelays.get(sessionId)?.();
  ctx.toolRelays.delete(sessionId);
}

function discardSessionHandle(ctx: ControlContext, sessionId: string): void {
  for (const [key, handle] of ctx.handles) {
    if (handle.platform_session_id !== sessionId) continue;
    const end = ctx.endTurns.get(key);
    ctx.handles.delete(key);
    ctx.endTurns.delete(key);
    end?.('Previous execution resolved');
  }
}

/** Brings a snoozed session back to the inbox; the caller owns the transaction. */
export function unsnooze(ctx: ControlContext, sessionId: string, reason: string, cause = ''): void {
  const session = ctx.store.get<Session>('sessions', sessionId);
  if (!session?.snoozed_at) return;
  const { snoozed_at: _, ...rest } = session;
  const next = ctx.store.update<Session>('sessions', rest, session.revision);
  ctx.store.event('session.unsnoozed', next, next.project_id, { reason }, cause);
}

/** The caller owns the transaction, has confirmed termination and read the audited state before it. */
export function closeReconciledSession(
  ctx: ControlContext,
  session: Session,
  audited: WrittenState | undefined,
  cause = '',
): Session {
  finishReconciledWriteAudit(ctx, session.id, audited);
  session = ctx.store.must<Session>('sessions', session.id);
  const { queued_handoff, ...rest } = session;
  const next = ctx.store.update(
    'sessions',
    { ...rest, state: 'closed' as const, stop_pending: false, process_identity: undefined },
    session.revision,
  );
  discardSessionHandle(ctx, session.id);
  ctx.revokeSessionCredential?.(session.id);
  endReconciledTurns(ctx, session.id);
  ctx.store.event('session.closed', next, next.project_id, { reason: 'reconciliation' }, cause);
  unsnooze(ctx, session.id, 'session_ended', cause);
  return ctx.store.must<Session>('sessions', session.id);
}

export function queuedTurn(
  session: Session,
  input: string,
  kind: SessionTurn['kind'],
  extras: Pick<
    SessionTurn,
    | 'attachments'
    | 'skills'
    | 'refs'
    | 'reference_context'
    | 'handoff'
    | 'causal_depth'
    | 'lead_note_ids'
    | 'app'
  > = {},
): SessionTurn {
  return {
    id: id(),
    revision: 1,
    project_id: session.project_id,
    session_id: session.id,
    model: session.reported_model ?? session.requested_model ?? null,
    input,
    ...extras,
    kind,
    delivery: 'pending',
    state: 'queued',
  };
}

function userTurn(turn: SessionTurn): UserTurn {
  return {
    turn_id: turn.id,
    input: [turn.handoff, turn.reference_context, turn.input]
      .filter((part) => part !== undefined)
      .join('\n\n'),
    ...(turn.attachments ? { attachments: turn.attachments } : {}),
    ...(turn.skills ? { skills: turn.skills } : {}),
  };
}

/** Throws unless the session can take input of this kind now. */
export function acceptInput(
  ctx: ControlContext,
  session: Session,
  kind: SessionTurn['kind'],
): void {
  requireThat(
    !session.stop_pending &&
      (session.state === 'open' || (kind === 'steer' && session.state === 'running')),
    'resource_busy',
    'Wait for the current turn or session reconciliation',
  );
  requireThat(session.merge?.state !== 'running', 'invalid_state', 'Session is being merged');
  requireThat(!session.stop_requested, 'invalid_state', 'Session is being discarded');
  requireThat(
    !session.rollback_pending,
    'rollback_in_progress',
    'Session is finishing a rollback; the daemon completes it on restart',
  );
  const handle = sessionHandle(ctx, session);
  requireThat(!handle || !queues.get(handle)?.settled, 'resource_busy', 'Session is closing');
}

const queueInput: Handler = (ctx, p, c) => {
  const cause = c.command_id,
    kind = c.type === 'session.steer' ? 'steer' : 'send',
    input = inputSchemas['session.send'].parse(c.input),
    sent = ctx.store.must<Session>('sessions', input.session_id);
  projectAccess(ctx, p, sent.project_id, c.type);
  requireThat(!sent.review_id, 'permission_denied', 'Reviewer input is fixed by its artifact');
  if (sent.runtime_review) {
    userOnly(p);
    requireThat(
      kind === 'send' && sent.turn_count < 4,
      'invalid_state',
      'Analysis accepts at most four read-only turns',
    );
    requireThat(
      !projectOverBudget(ctx, sent.project_id),
      'budget_exceeded',
      'Project runtime budget is exhausted',
    );
    revision(ctx, c, sent);
    acceptInput(ctx, sent, 'send');
    requireThat(
      input.input.length <= 1600 && !input.attachments?.length && !input.skills?.length,
      'invalid_input',
      'Analysis follow-ups take a short text question',
    );
    requireThat(
      !activeRuntimeReview(ctx, sent.project_id, sent.id),
      'resource_busy',
      'A runtime analysis is already active',
    );
    return queueTurn(ctx, sent, input.input, 'reflection', cause, turnExtras(ctx, sent, input));
  }
  revision(ctx, c, sent);
  acceptInput(ctx, sent, kind);
  const extras = turnExtras(ctx, sent, input);
  const digest = takeInbox(ctx, sent.id);
  const { session, handoff } = followContractRuntime(ctx, sent, cause);
  requireThat(
    !contractMoveWaits(ctx, session),
    'resource_busy',
    'The task session is moving to its changed runtime or model; send the message again in a moment',
  );
  const turn = queuedTurn(
    session,
    [input.input, digest?.text].filter((part) => part !== undefined).join('\n\n'),
    kind,
    {
      ...extras,
      handoff,
      ...(digest ? { lead_note_ids: digest.note_ids } : {}),
      ...(input.app ? { app: input.app } : {}),
    },
  );
  const { archived_at, ...rest } = session;
  const next = ctx.store.update(
    'sessions',
    {
      ...rest,
      state: 'running' as const,
      turn_count: session.turn_count + 1,
      merge: undefined,
    },
    session.revision,
  );
  if (archived_at) ctx.store.event('session.unarchived', next, next.project_id, {}, cause);
  ctx.store.enqueue('session.turn', { turn_id: turn.id });
  insert(ctx, 'session_turns', turn, 'turn.queued', session.project_id, cause);
  ctx.store.event('session.turn.delivery', turn, turn.project_id, { delivery: 'pending' }, cause);
  if (p.role === 'user' && session.task) noteUserMessage(ctx, session, turn.id, input.input, cause);
  if (p.role === 'user') unsnooze(ctx, session.id, 'user_message', cause);
  return turn;
};

const interruptTurn: Handler = (ctx, p, c) => {
  const cause = c.command_id,
    input = inputSchemas['session.interrupt'].parse(c.input),
    session = ctx.store.must<Session>('sessions', input.session_id);
  projectAccess(ctx, p, session.project_id, c.type);
  requireThat(
    !session.review_id,
    'permission_denied',
    'Only a direct conversation can be interrupted',
  );
  revision(ctx, c, session);
  return interruptSession(ctx, session, 'user', cause);
};

/**
 * Asks the runtime to end the session's running turn and keep the session. A user's interrupt
 * also cancels the user's own turns queued behind it; other queued turns run after it.
 */
export function interruptSession(
  ctx: ControlContext,
  session: Session,
  by: 'user' | 'lead',
  cause: string,
): Session {
  const handle = sessionHandle(ctx, session);
  requireThat(
    session.state === 'running' && !session.stop_pending && handle,
    'resource_busy',
    'No running turn to interrupt',
  );
  const adapter = sessionAdapter(ctx, session);
  requireThat(
    adapter?.interrupt,
    'unsupported_capability',
    'Runtime cannot interrupt a turn and keep its session',
  );
  const turns = ctx.store
    .list<SessionTurn>('session_turns')
    .filter((t) => t.session_id === session.id);
  const running = turns.find((t) => t.state === 'running');
  if (running)
    interrupts.set(running.id, {
      queued:
        by === 'user'
          ? turns.filter((t) => t.state === 'queued' && !t.origin).map((t) => t.id)
          : [],
      cause,
      by,
    });
  ctx.store.event('session.interrupt_requested', session, session.project_id, {}, cause);
  const failed = (error: string): void => {
    if (running) interrupts.delete(running.id);
    const current = ctx.store.must<Session>('sessions', session.id);
    ctx.store.event('session.interrupt_failed', current, current.project_id, { error }, cause);
    ctx.changed();
  };
  const completion = Promise.resolve()
    .then(() => adapter.interrupt!(handle))
    .then(
      (receipt) => {
        if (!receipt.ok) failed(receipt.reason ?? 'Runtime refused the interrupt');
      },
      (error: unknown) => failed(String(error)),
    )
    .finally(() => ctx.completions.delete(completion));
  ctx.completions.add(completion);
  return session;
}

/** Asks the runtime to stop one background task of the session; its next background list shows the stop. */
export function stopBackground(
  ctx: ControlContext,
  session: Session,
  backgroundId: string,
  cause: string,
): { session_id: string; background_id: string } {
  requireThat(
    backgroundTasks(ctx, session.id).some((task) => task.id === backgroundId),
    'not_found',
    `No background task ${backgroundId} runs in the session`,
  );
  const handle = sessionHandle(ctx, session),
    adapter = sessionAdapter(ctx, session);
  requireThat(handle, 'resource_busy', 'The session has no live process');
  requireThat(
    adapter?.stopBackground,
    'unsupported_capability',
    'Runtime cannot stop a background task',
  );
  ctx.store.event(
    'session.background_stop_requested',
    session,
    session.project_id,
    { background_id: backgroundId },
    cause,
  );
  const completion = Promise.resolve()
    .then(() => adapter.stopBackground!(handle, backgroundId))
    .then(
      () => {},
      (error: unknown) => {
        const current = ctx.store.must<Session>('sessions', session.id);
        ctx.store.event(
          'session.background_stop_failed',
          current,
          current.project_id,
          { background_id: backgroundId, error: String(error) },
          cause,
        );
        ctx.changed();
      },
    )
    .finally(() => ctx.completions.delete(completion));
  ctx.completions.add(completion);
  return { session_id: session.id, background_id: backgroundId };
}

/** session.resolve; a close reads the tracked files its write audit compares before the transaction. */
export function prepareResolve(
  ctx: ControlContext,
  p: Principal,
  c: Command,
): Handler | Promise<Handler> {
  const { session_id, choice } = inputSchemas['session.resolve'].parse(c.input);
  const resolve = sessionHandlers['session.resolve']!;
  return choice === 'close' ? withReconciledState(ctx, session_id, resolve) : resolve;
}

export const sessionHandlers: Handlers = {
  'session.resolve': (ctx, principal, command, audited?: WrittenState) => {
    const { session_id, choice } = inputSchemas['session.resolve'].parse(command.input);
    const session = ctx.store.must<Session>('sessions', session_id);
    requireThat(
      principal.role === 'user' || principal.role === 'planner',
      'permission_denied',
      'User or planner principal required',
    );
    projectAccess(ctx, principal, session.project_id, command.type);
    revision(ctx, command, session);
    requireThat(session.state === 'reconciling', 'invalid_state', 'Session must be reconciling');
    requireThat(
      !pendingResume(ctx, session.id),
      'resource_busy',
      'Session resolution is already pending',
    );
    confirmTermination(ctx, session);
    if (choice === 'close') {
      const next = closeReconciledSession(ctx, session, audited, command.command_id);
      if (session.review_id) settleReview(ctx, session.review_id);
      return next;
    }
    const adapter = sessionAdapter(ctx, session);
    requireThat(
      session.native_id &&
        adapter?.resume &&
        adapter.report.capabilities.resume?.status === 'supported',
      'unsupported_capability',
      'Runtime cannot resume this native session',
    );
    runtime(
      ctx,
      session.runtime,
      session.review_id || session.runtime_review ? 'reviewer' : 'text',
    );
    const turn = ctx.store
      .list<SessionTurn>('session_turns')
      .find((t) => t.session_id === session.id);
    requireThat(turn, 'invalid_state', 'Session has no previous turn');
    const { queued_handoff, ...rest } = session;
    const resolved = queued_handoff?.blocked ? rest : session;
    const next = ctx.store.update('sessions', resolved, session.revision);
    // The direct-session dispatcher owns both the resume handshake and its idle turn queue.
    ctx.store.enqueue('session.turn', {
      turn_id: turn.id,
      session_id,
      resume: true,
      cause: command.command_id,
    });
    discardSessionHandle(ctx, session.id);
    return next;
  },
  'session.compact': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['session.compact'].parse(c.input),
      session = ctx.store.must<Session>('sessions', input.session_id);
    projectAccess(ctx, p, session.project_id, c.type);
    revision(ctx, c, session);
    acceptInput(ctx, session, 'send');
    requireThat(!session.outcome, 'invalid_state', 'Session has ended');
    requireThat(
      !ctx.store
        .list<SessionTurn>('session_turns')
        .some(
          (turn) => turn.session_id === session.id && ['queued', 'running'].includes(turn.state),
        ),
      'resource_busy',
      'Wait for the current turn',
    );
    requireThat(
      !contractMoveWaits(ctx, session),
      'resource_busy',
      'The task session is moving to its changed runtime or model; try again in a moment',
    );
    const adapter = sessionAdapter(ctx, session);
    requireThat(
      adapter?.report.capabilities.manual_compaction?.status === 'supported',
      'unsupported_capability',
      `${session.runtime} does not support manual context compaction`,
    );
    requireThat(
      input.instructions === undefined ||
        adapter.report.capabilities.compaction_instructions?.status === 'supported',
      'unsupported_capability',
      `${session.runtime} takes no instructions for a compaction`,
    );
    const turn: SessionTurn = {
      ...queuedTurn(session, input.instructions ?? '', 'send'),
      origin: 'compaction',
    };
    const { archived_at, ...rest } = session;
    const next = ctx.store.update(
      'sessions',
      { ...rest, state: 'running' as const, turn_count: session.turn_count + 1 },
      session.revision,
    );
    if (archived_at) ctx.store.event('session.unarchived', next, next.project_id, {}, c.command_id);
    ctx.store.enqueue('session.turn', { turn_id: turn.id });
    insert(ctx, 'session_turns', turn, 'turn.queued', session.project_id, c.command_id);
    ctx.store.event(
      'session.turn.delivery',
      turn,
      turn.project_id,
      { delivery: 'pending' },
      c.command_id,
    );
    unsnooze(ctx, session.id, 'user_message', c.command_id);
    return turn;
  },
  'session.send': queueInput,
  'session.steer': queueInput,
  'session.app_context': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['session.app_context'].parse(c.input),
      session = ctx.store.must<Session>('sessions', input.session_id);
    projectAccess(ctx, p, session.project_id, c.type);
    let contexts = appContexts.get(ctx);
    if (!contexts) appContexts.set(ctx, (contexts = new Map()));
    contexts.set(session.id, { server: input.server, content: input.content });
    return { session_id: session.id, server: input.server };
  },
  'session.interrupt': interruptTurn,
  'session.background.stop': (ctx, p, c) => {
    const input = inputSchemas['session.background.stop'].parse(c.input),
      session = ctx.store.must<Session>('sessions', input.session_id);
    projectAccess(ctx, p, session.project_id, c.type);
    return stopBackground(ctx, session, input.background_id, c.command_id);
  },
};

/** One live handle drains the persisted inputs before its owner may close it. */
export function createTurnQueue(ctx: ControlContext, initial: SessionTurn, resumed = false) {
  const eventKey = resumed ? id() : initial.id;
  const connectors = JSON.stringify(
    ctx.store.must<Session>('sessions', initial.session_id).enabled_user_connectors,
  );
  const connectorsChanged = () =>
    JSON.stringify(
      ctx.store.must<Session>('sessions', initial.session_id).enabled_user_connectors,
    ) !== connectors;
  let current = initial,
    waitingForInput = resumed === true,
    inProgress = false,
    stopped = false,
    settled = false,
    failure: string | undefined,
    adapter: HarnessAdapter,
    handle: SessionHandle,
    spec: SessionSpec | undefined;
  let lastState: 'completed' | 'failed' | 'cancelled' = 'failed';
  let resolveTurn: ((state: 'completed' | 'failed' | 'cancelled') => void) | undefined;
  let resolveDone!: (state: 'completed' | 'failed' | 'cancelled') => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<'completed' | 'failed' | 'cancelled'>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const injections = new Set<Promise<void>>();
  const interrupted = (): boolean => {
    const session = ctx.store.must<Session>('sessions', initial.session_id);
    return (
      stopped ||
      ctx.closing ||
      ctx.cancelling.has(initial.id) ||
      session.state === 'reconciling' ||
      session.state === 'closed' ||
      session.stop_pending === true ||
      !!session.stop_requested
    );
  };
  const record = (
    turn: SessionTurn,
    delivery: SessionTurn['delivery'],
    reason?: string,
    state?: SessionTurn['state'],
  ): void => {
    ctx.store.transaction(() => {
      const before = ctx.store.must<SessionTurn>('session_turns', turn.id);
      const next = turnDelivery(ctx, before, delivery, reason, state);
      if (delivery === 'failed' && before.delivery !== 'failed')
        returnNotes(ctx, next.session_id, [next]);
      const session = ctx.store.must<Session>('sessions', turn.session_id);
      if (
        (delivery === 'delivered' || delivery === 'queued') &&
        session.queued_handoff?.first_turn_id === turn.id
      ) {
        const { queued_handoff, ...rest } = session;
        ctx.store.update('sessions', rest, session.revision);
      }
    });
    ctx.changed();
  };
  const stillQueued = (turn: SessionTurn): boolean =>
    ctx.store.must<SessionTurn>('session_turns', turn.id).state === 'queued';
  const sink = (event: AgentEvent): void => {
    if (event.kind === 'runtime.disconnected') {
      const session = ctx.store.must<Session>('sessions', initial.session_id);
      checkRuntimeConnection(ctx, session.runtime);
      if (waitingForInput) queue.end(event.reason);
    }
    if (
      event.kind !== 'usage.updated' &&
      event.kind !== 'quota.updated' &&
      event.kind !== 'session.exited' &&
      event.kind !== 'permission.requested' &&
      (stopped ||
        settled ||
        (!inProgress && event.turn_id !== undefined) ||
        (event.turn_id && event.turn_id !== current.id))
    )
      return;
    // A closing process's handle is stale: a rollback may have cleared its conversation.
    if (handle && !stopped && !settled) saveSessionHandle(ctx, handle);
    if (
      !agentEvent(ctx, initial.session_id, {
        ...event,
        key: `${eventKey}:${event.key}`,
        turn_id:
          event.turn_id ??
          ((inProgress &&
            (event.kind === 'tool.started' ||
              event.kind === 'tool.completed' ||
              event.kind === 'context.compacted' ||
              event.kind === 'context.compacting' ||
              event.kind === 'turn.retrying' ||
              event.kind === 'permission.requested')) ||
          event.kind === 'usage.updated'
            ? current.id
            : undefined),
      })
    )
      return;
    if (event.kind === 'quota.updated')
      updateRuntimeQuota(
        ctx,
        ctx.store.must<Session>('sessions', initial.session_id).runtime,
        event.windows,
      );
    if (event.kind === 'turn.completed' && event.turn_id === current.id) {
      inProgress = false;
      if (event.error) failure = event.error;
      if (event.error_code === 'usage_limit')
        ctx.store.transaction(() => {
          const session = ctx.store.must<Session>('sessions', current.session_id);
          if (!daemonDriven(ctx, session) || usageLimitWaiting(ctx, session.id)) return;
          // A minute past the reset; half an hour when the runtime gives no reset time.
          const dueAt =
            event.resets_at === undefined
              ? ctx.store.now() + 30 * 60_000
              : event.resets_at + 60_000;
          scheduleTimer(ctx, {
            // Keyed by the failed turn: a retry that fails with the same reset time needs a new timer.
            id: `usage-limit-resume:${current.id}`,
            project_id: session.project_id,
            kind: 'usage-limit-resume',
            subject_id: session.id,
            due_at: dueAt,
          });
        });
      const requested = interrupts.get(current.id);
      interrupts.delete(current.id);
      const cancelled = event.status === 'interrupted' && requested !== undefined;
      if (cancelled)
        ctx.store.transaction(() => {
          for (const id of requested.queued) {
            const turn = ctx.store.must<SessionTurn>('session_turns', id);
            if (turn.state !== 'queued') continue;
            const next = turnDelivery(ctx, turn, 'failed', 'interrupted', 'cancelled');
            returnNotes(ctx, next.session_id, [next]);
            ctx.store.event(
              'turn.cancelled',
              next,
              next.project_id,
              { reason: 'interrupted' },
              requested.cause,
            );
          }
          const session = ctx.store.must<Session>('sessions', current.session_id);
          const plan =
            requested.by === 'user' && session.task
              ? ctx.store.get<BoardPlan>('board_plans', session.task.lead_session_id)
              : undefined;
          if (plan)
            appendNote(
              ctx,
              plan,
              {
                at: ctx.store.now(),
                session_id: session.id,
                task_id: session.task!.id,
                kind: 'user_edit',
                text: `The user interrupted the current turn of task ${session.task!.id}.`,
              },
              requested.cause,
            );
        });
      resolveTurn?.(
        event.status === 'completed' ? 'completed' : cancelled ? 'cancelled' : 'failed',
      );
    }
  };
  const send = (turn: SessionTurn) => {
    current = turn;
    failure = undefined;
    inProgress = true;
    const completed = new Promise<'completed' | 'failed' | 'cancelled'>((resolve) => {
      resolveTurn = resolve;
    });
    const ready = (async () => {
      let contract: ContractDelivery | undefined;
      let dispatched = false;
      try {
        if (turn.origin === 'compaction') {
          requireThat(!interrupted(), 'invalid_state', 'Session interrupted before input delivery');
          ctx.store.transaction(() => {
            const running = turnDelivery(ctx, turn, 'pending', undefined, 'running');
            ctx.store.event('turn.running', running, turn.project_id, {});
          });
          const receipt = await adapter.send(handle, {
            turn_id: turn.id,
            input: turn.input,
            compact: true,
          });
          saveSessionHandle(ctx, handle);
          record(
            turn,
            receipt.status === 'unsupported' ? 'failed' : receipt.status,
            receipt.reason,
          );
          if (receipt.status === 'unsupported') {
            failure = receipt.reason;
            inProgress = false;
            resolveTurn?.('failed');
          }
          return;
        }
        const device = onDevice(ctx.store.must<Session>('sessions', turn.session_id));
        if (turn.origin !== 'reflection') {
          ctx.store.event('turn.prepare_started', turn, turn.project_id, {
            session_id: turn.session_id,
          });
          // The checkpoint holds what the device changed since the last pull, and the device gets that checkpoint.
          if (device) await pullRemoteWorkspace(ctx, turn.session_id);
          await captureCheckpoint(ctx, turn.session_id, turn.id);
          if (device) await pushRemoteWorkspace(ctx, turn.session_id, turn.id);
        }
        // Before the turn is marked as running: a copy that fails leaves nothing delivered.
        const copied = await deviceTurn(ctx, turn.session_id, userTurn(turn));
        requireThat(!interrupted(), 'invalid_state', 'Session interrupted before input delivery');
        const beforeDelivery = ctx.store.must<Session>('sessions', turn.session_id);
        if (contractMoveWaits(ctx, { ...beforeDelivery, state: 'open' })) {
          ctx.store.transaction(() => holdQueuedHandoff(ctx, beforeDelivery, turn));
          inProgress = false;
          resolveTurn?.('completed');
          return;
        }
        let readOnly = false;
        const delivered = ctx.store.transaction(() => {
          const s = ctx.store.must<Session>('sessions', turn.session_id);
          contract = prepareContractDelivery(ctx, s, turn.id);
          const t = ctx.store.must<SessionTurn>('session_turns', turn.id);
          readOnly = t.origin === 'reflection' || (!s.direct_task && planUnfinished(ctx, s.id));
          const next = ctx.store.update(
            'session_turns',
            {
              ...t,
              ...(s.handoff_before_turn_id && {
                handoff: buildHandoff(ctx, s, s.handoff_before_turn_id),
              }),
              state: 'running' as const,
              ...(readOnly && { read_only: true }),
              model: s.reported_model ?? s.requested_model ?? null,
              // Codex reports the model once per process, not on each turn.
              ...(s.reported_model && !t.reported_model && { reported_model: s.reported_model }),
            },
            t.revision,
          );
          if (s.handoff_before_turn_id)
            ctx.store.update('sessions', { ...s, handoff_before_turn_id: undefined }, s.revision);
          for (const timer of ctx.store.list<Timer>('timers'))
            if (timer.kind === 'usage-limit-resume' && timer.subject_id === s.id)
              cancelTimer(ctx, timer.id);
          ctx.store.event('turn.running', next, t.project_id, {});
          return next;
        });
        if (spec)
          await startWriteAudit(
            ctx,
            spec,
            turn.id,
            spec.role !== 'writer' || beforeDelivery.permission_mode === 'plan' || readOnly,
          );
        dispatched = true;
        if (contract) {
          let deliveries = deliveringContracts.get(ctx);
          if (!deliveries) deliveringContracts.set(ctx, (deliveries = new Map()));
          deliveries.set(turn.session_id, { turn_id: turn.id, generation: contract.generation });
        }
        const compaction =
          turn.origin === 'reflection' ? undefined : compactionInstructions(ctx, turn.session_id);
        const input = { ...copied, input: userTurn(delivered).input };
        const memory = beforeDelivery.runtime_review
          ? undefined
          : ctx.store.transaction(() =>
              prepareMemoryDelivery(
                ctx,
                ctx.store.must<Session>('sessions', turn.session_id),
                turn.id,
              ),
            );
        const appContext = turn.origin ? undefined : takeAppContext(ctx, turn.session_id);
        const parts = appContext ? [appContext, input.input] : [input.input];
        if (memory) parts.push('[Pantheon current project memory]\n' + JSON.stringify(memory));
        if (compaction) parts.push(compaction.text);
        const receipt = await adapter.send(handle, {
          ...input,
          input: parts.join('\n\n'),
          ...(readOnly ? { read_only: true } : {}),
        });
        if (compaction && receipt.status !== 'unsupported')
          ctx.store.event('session.context_restored', beforeDelivery, beforeDelivery.project_id, {
            turn_id: turn.id,
            compaction_sequence: compaction.sequence,
          });
        if (memory)
          finishMemoryDelivery(
            ctx,
            turn.session_id,
            turn.id,
            memory,
            receipt.status === 'delivered',
          );
        finishContractDelivery(ctx, turn.session_id, contract, receipt.status !== 'unsupported');
        saveSessionHandle(ctx, handle);
        const wasHeld = !!ctx.store.must<Session>('sessions', turn.session_id).queued_handoff;
        const retry =
          receipt.status === 'unsupported' &&
          ctx.store.transaction(() =>
            retryQueuedHandoff(ctx, turn.session_id, receipt.reason ?? 'Input was refused'),
          );
        record(
          turn,
          retry ? 'pending' : receipt.status === 'unsupported' ? 'failed' : receipt.status,
          receipt.reason,
          retry ? 'queued' : undefined,
        );
        if (receipt.status === 'unsupported') {
          if (wasHeld && !retry) stopped = true;
          failure = receipt.reason;
          inProgress = false;
          resolveTurn?.('failed');
        }
      } catch (error) {
        finishContractDelivery(ctx, turn.session_id, contract, false);
        saveSessionHandle(ctx, handle);
        failure = String(error);
        const retry = ctx.store.transaction(() => {
          const session = ctx.store.must<Session>('sessions', turn.session_id);
          if (!session.queued_handoff) return false;
          if (!dispatched) return retryQueuedHandoff(ctx, turn.session_id, failure!);
          const next = ctx.store.update(
            'sessions',
            {
              ...session,
              queued_handoff: { ...session.queued_handoff, blocked: 'delivery_unknown' as const },
            },
            session.revision,
          );
          ctx.store.event('session.handoff_delivery_unknown', next, next.project_id, {
            turn_id: turn.id,
            error: failure,
          });
          return false;
        });
        record(turn, retry ? 'pending' : 'failed', failure, retry ? 'queued' : 'failed');
        inProgress = false;
        resolveTurn?.('failed');
      } finally {
        const deliveries = deliveringContracts.get(ctx);
        if (deliveries?.get(turn.session_id)?.turn_id === turn.id)
          deliveries.delete(turn.session_id);
      }
    })();
    return { ready, completed };
  };
  /** Settles `done` when the handle should close; an idle direct conversation leaves it open. */
  const drain = async (sent: ReturnType<typeof send>): Promise<void> => {
    let result: 'completed' | 'failed' | 'cancelled' = 'completed';
    for (;;) {
      await sent.ready;
      const state = await sent.completed;
      await finishWriteAudit(ctx, initial.session_id);
      lastState = state;
      if (state === 'failed') result = 'failed';
      while (injections.size) await Promise.all([...injections]);
      const next = ctx.store
        .list<SessionTurn>('session_turns')
        .find(
          (t) => t.session_id === initial.session_id && t.id !== current.id && t.state === 'queued',
        );
      const session = ctx.store.must<Session>('sessions', initial.session_id);
      if (
        !interrupted() &&
        (session.queued_handoff ||
          (next && (connectorsChanged() || contractMoveWaits(ctx, { ...session, state: 'open' }))))
      ) {
        ctx.store.transaction(() => {
          const latest = ctx.store.must<SessionTurn>('session_turns', current.id);
          if (latest.state === 'running') {
            const finished = ctx.store.update(
              'session_turns',
              { ...latest, state },
              latest.revision,
            );
            ctx.store.event(`turn.${state}`, finished, latest.project_id, { error: failure });
          }
          if (!session.queued_handoff && next) holdQueuedHandoff(ctx, session, next);
        });
        settled = true;
        ctx.idleConversations.delete(initial.session_id);
        resolveDone(result);
        return;
      }
      if (
        !next &&
        !interrupted() &&
        state !== 'failed' &&
        directConversation(ctx.store.must<Session>('sessions', initial.session_id))
      ) {
        ctx.store.transaction(() => {
          const t = ctx.store.must<SessionTurn>('session_turns', current.id);
          const finished = ctx.store.update('session_turns', { ...t, state }, t.revision);
          ctx.store.event(`turn.${state}`, finished, t.project_id, { error: failure });
          const session = ctx.store.must<Session>('sessions', initial.session_id);
          if (session.state === 'running')
            ctx.store.update('sessions', { ...session, state: 'open' as const }, session.revision);
          loseSessionApprovals(ctx, session.id);
        });
        if (state === 'completed' && current.origin !== 'compaction')
          autoMergeAfterTurn(ctx, initial.session_id, current.id);
        ctx.changed();
        resolveTurn = undefined;
        waitingForInput = true;
        ctx.idleConversations.set(initial.session_id, ctx.store.now());
        return;
      }
      if (interrupted() || !next || isRuntimeHeld(ctx, session.runtime)) {
        settled = true;
        resolveDone(interrupted() ? 'failed' : result);
        return;
      }
      ctx.store.transaction(() => {
        const t = ctx.store.must<SessionTurn>('session_turns', current.id);
        const finished = ctx.store.update('session_turns', { ...t, state }, t.revision);
        ctx.store.event(`turn.${state}`, finished, t.project_id, { error: failure });
      });
      sent = send(next);
    }
  };
  const queue = {
    done,
    sink,
    get settled() {
      return settled;
    },
    get failure() {
      return failure;
    },
    get lastState() {
      return lastState;
    },
    /** Stops an idle handle before its held queued input can be sent to the old runtime. */
    handoff(turn: SessionTurn): boolean {
      if (settled || inProgress || !waitingForInput) return false;
      ctx.store.transaction(() => {
        holdQueuedHandoff(ctx, ctx.store.must<Session>('sessions', initial.session_id), turn);
      });
      settled = true;
      ctx.idleConversations.delete(initial.session_id);
      resolveDone(lastState);
      return true;
    },
    end(error?: string) {
      stopped = true;
      inProgress = false;
      if (error) failure = error;
      ctx.idleConversations.delete(initial.session_id);
      if (resolveTurn) resolveTurn('failed');
      else resolveDone('failed');
      return failure;
    },
    /** Lets the owner close an idle conversation's process. */
    release() {
      if (settled || !ctx.idleConversations.has(initial.session_id)) return;
      settled = true;
      ctx.idleConversations.delete(initial.session_id);
      resolveDone(lastState);
    },
    start(a: HarnessAdapter, h: SessionHandle, sessionSpec?: SessionSpec): Promise<void> {
      adapter = a;
      handle = h;
      spec = sessionSpec;
      queues.set(handle, queue);
      if (waitingForInput) {
        ctx.idleConversations.set(initial.session_id, ctx.store.now());
        return Promise.resolve();
      }
      const sent = send(initial);
      void drain(sent).catch(rejectDone);
      return sent.ready;
    },
    async submit(turn: SessionTurn): Promise<void> {
      if (settled || interrupted() || turn.delivery !== 'pending' || turn.state !== 'queued')
        return;
      if (connectorsChanged()) {
        if (waitingForInput) queue.handoff(turn);
        else record(turn, 'queued');
        return;
      }
      if (waitingForInput) {
        waitingForInput = false;
        ctx.idleConversations.delete(initial.session_id);
        const sent = send(turn);
        void drain(sent).catch(rejectDone);
        await sent.ready;
        return;
      }
      // A compaction turn runs without the read-only and checkpoint preparation of a user turn.
      if (!inProgress || !adapter.steer || current.origin === 'compaction') {
        if (inProgress) record(turn, 'queued');
        return;
      }
      const injection = Promise.resolve().then(async () => {
        try {
          const memory = ctx.store.transaction(() =>
            prepareMemoryDelivery(
              ctx,
              ctx.store.must<Session>('sessions', turn.session_id),
              turn.id,
            ),
          );
          const input = await deviceTurn(ctx, turn.session_id, userTurn(turn));
          // Only a delivered steer carries the context; a queued one is sent later as its own turn.
          const found = turn.origin ? undefined : appContexts.get(ctx)?.get(turn.session_id);
          const appContext = found && appContextText(found);
          const text = appContext ? appContext + '\n\n' + input.input : input.input;
          const receipt = await adapter.steer!(handle, {
            ...input,
            input: memory
              ? text + '\n\n[Pantheon current project memory]\n' + JSON.stringify(memory)
              : text,
          });
          // A context the interface replaced while the steer awaited stays for the next turn.
          if (
            found &&
            receipt.status === 'delivered' &&
            appContexts.get(ctx)?.get(turn.session_id) === found
          )
            appContexts.get(ctx)!.delete(turn.session_id);
          if (memory)
            finishMemoryDelivery(
              ctx,
              turn.session_id,
              turn.id,
              memory,
              receipt.status === 'delivered',
            );
          // An interrupt may have cancelled the turn while the steer awaited.
          if (stillQueued(turn))
            record(
              turn,
              receipt.status === 'unsupported' ? 'failed' : receipt.status,
              receipt.reason,
              receipt.status === 'delivered'
                ? 'completed'
                : receipt.status === 'queued'
                  ? 'queued'
                  : 'failed',
            );
        } catch (error) {
          if (stillQueued(turn)) record(turn, 'failed', String(error), 'failed');
        }
      });
      injections.add(injection);
      try {
        await injection;
      } finally {
        injections.delete(injection);
      }
    },
  };
  return queue;
}

/** Applies the model before starting or resuming the native process, without confirming delivery. */
function followModelAtStart(ctx: ControlContext, session: Session): Session {
  return ctx.store.transaction(() => {
    const between = { ...session, state: 'open' as const };
    const followed = followContractModel(ctx, between, '');
    return followed === between
      ? session
      : ctx.store.update('sessions', { ...followed, state: session.state }, followed.revision);
  });
}

type ContractDelivery = {
  notice: string;
  task: NonNullable<Session['task']>;
  generation: number;
  plan_sequence: number;
};

/** The caller owns the delivery transaction; the marker stays until a delivery receipt. */
function prepareContractDelivery(
  ctx: ControlContext,
  session: Session,
  turnId: string,
): ContractDelivery | undefined {
  // A running row includes this turn; the previous turn is no longer running at this boundary.
  const between = { ...session, state: 'open' as const };
  const plan = session.task
    ? ctx.store.get<BoardPlan>('board_plans', session.task.lead_session_id)
    : undefined;
  const notice = takeContractChange(ctx, between, false);
  if (notice !== undefined) {
    const turn = ctx.store.must<SessionTurn>('session_turns', turnId);
    // A lead message may already show this contract while queued; a newer one is appended.
    if (!turn.input.includes(notice))
      ctx.store.update(
        'session_turns',
        { ...turn, input: `${turn.input}\n\n${notice}` },
        turn.revision,
      );
  }
  return notice !== undefined && session.task
    ? {
        notice,
        task: session.task,
        generation: taskGeneration(plan, session.task.id),
        plan_sequence: (
          ctx.store.db
            .prepare('SELECT max(sequence) AS sequence FROM events WHERE aggregate_id=?')
            .get(plan!.id) as { sequence: number }
        ).sequence,
      }
    : undefined;
}

/** Confirms only the contract and generation accepted by this delivery receipt. */
function finishContractDelivery(
  ctx: ControlContext,
  sessionId: string,
  contract: ContractDelivery | undefined,
  accepted: boolean,
): void {
  if (!contract) return;
  ctx.store.transaction(() => {
    const session = ctx.store.must<Session>('sessions', sessionId);
    if (
      session.task?.lead_session_id !== contract.task.lead_session_id ||
      session.task.id !== contract.task.id
    )
      return;
    if (accepted) {
      ctx.store.event('session.contract_notified', session, session.project_id, {
        plan_sequence: contract.plan_sequence,
      });
      let between = { ...session, state: 'open' as const };
      const plan = ctx.store.get<BoardPlan>('board_plans', session.task.lead_session_id);
      // A later lead update while send awaited its receipt must keep its notification.
      if (
        taskGeneration(plan, session.task.id) === contract.generation &&
        takeContractChange(ctx, between, false) === contract.notice
      ) {
        if (awaitingChange(plan, between)) {
          const next = ctx.store.update(
            'sessions',
            { ...session, task: { ...session.task, generation: contract.generation } },
            session.revision,
          );
          between = { ...next, state: 'open' };
        }
        takeContractChange(ctx, between);
      }
    }
  });
}

/**
 * Fails the turn when a process outside Pantheon holds the native session of an in-place session
 * whose live process would take the turn.
 */
function heldElsewhere(ctx: ControlContext, session: Session, turn: SessionTurn): boolean {
  if (
    !session.workspace_id ||
    ctx.store.must<Workspace>('workspaces', session.workspace_id).kind !== 'in_place'
  )
    return false;
  try {
    assertInPlaceSessionFree(ctx, session);
    return false;
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    ctx.store.transaction(() => {
      const failed = turnDelivery(
        ctx,
        ctx.store.must<SessionTurn>('session_turns', turn.id),
        'failed',
        error.message,
        'failed',
      );
      returnNotes(ctx, failed.session_id, [failed]);
      ctx.store.event('turn.failed', failed, failed.project_id, {
        error: error.message,
        error_code: error.code,
      });
      const current = ctx.store.must<Session>('sessions', session.id);
      if (
        current.state === 'running' &&
        !ctx.store
          .list<SessionTurn>('session_turns')
          .some((t) => t.session_id === session.id && ['queued', 'running'].includes(t.state))
      )
        ctx.store.update('sessions', { ...current, state: 'open' as const }, current.revision);
    });
    ctx.changed();
    return true;
  }
}

export async function startTurn(ctx: ControlContext, key: string): Promise<void> {
  const turn = ctx.store.must<SessionTurn>('session_turns', key),
    project = ctx.store.must<Project>('projects', turn.project_id);
  let session = ctx.store.must<Session>('sessions', turn.session_id);
  const resume = pendingResume(ctx, session.id),
    resumed = resume?.turn_id === key;
  if (
    ctx.closing ||
    (resumed
      ? session.state !== 'reconciling'
      : turn.state !== 'queued' ||
        session.state === 'reconciling' ||
        session.state === 'closed' ||
        session.stop_pending)
  )
    return;
  if (
    session.workspace_id &&
    !workspaceReady(ctx.store.must<Workspace>('workspaces', session.workspace_id))
  )
    return;
  if (!resumed && session.queued_handoff?.blocked) return;
  if (
    !resumed &&
    turn.origin !== 'compaction' &&
    contractMoveWaits(ctx, { ...session, state: 'open' })
  ) {
    const live = sessionHandle(ctx, session);
    if (live) {
      queues.get(live)?.handoff(turn);
      return;
    }
    ctx.store.transaction(() => {
      session = holdQueuedHandoff(ctx, session, queuedInputs(ctx, session.id)[0] ?? turn);
      advanceQueuedHandoffs(ctx);
    });
    session = ctx.store.must<Session>('sessions', session.id);
  }
  if (!resumed && session.queued_handoff) {
    const held = session.queued_handoff;
    if (
      held.first_turn_id !== key ||
      (held.retry_at !== undefined && held.retry_at > ctx.store.now()) ||
      sessionHandle(ctx, session)
    )
      return;
  }
  if (!resumed && turn.origin !== 'compaction' && !nativeTurnActive(ctx, session))
    session = followModelAtStart(ctx, session);
  const live = sessionHandle(ctx, session);
  if (live) {
    if (!heldElsewhere(ctx, session, turn)) await queues.get(live)?.submit(turn);
    return;
  }
  const queue = createTurnQueue(ctx, turn, resumed);
  let handle: SessionHandle | undefined;
  try {
    const adapter = runtime(
      ctx,
      session.runtime,
      session.review_id ||
        session.runtime_review ||
        session.baseline ||
        session.change_story ||
        session.range_story ||
        session.intro ||
        session.resident
        ? 'reviewer'
        : session.workspace_id
          ? 'writer'
          : 'text',
    );
    const otherReviewers: string[] = [];
    if ((session.review_id || session.runtime_review) && ctx.protectionPaths) {
      otherReviewers.push(
        ...ctx.store
          .list<Session>('sessions')
          .filter((other) => other.review_id && other.id !== session.id)
          .map((other) => reviewerDirectory(ctx, other.project_id, other.review_id!, other.id)),
      );
      for (const reviewsRoot of reviewsRoots(ctx)) {
        if (
          ![path.dirname(path.dirname(reviewsRoot)), path.dirname(reviewsRoot), reviewsRoot].every(
            (directory) => lstatSync(directory, { throwIfNoEntry: false })?.isDirectory(),
          )
        )
          continue;
        for (const review of readdirSync(reviewsRoot, { withFileTypes: true })) {
          if (!review.isDirectory()) continue;
          const reviewPath = path.join(reviewsRoot, review.name);
          if (review.name !== session.review_id) otherReviewers.push(reviewPath);
          else
            for (const sibling of readdirSync(reviewPath, { withFileTypes: true }))
              if (sibling.isDirectory() && sibling.name !== session.id)
                otherReviewers.push(path.join(reviewPath, sibling.name));
        }
      }
    }
    const reviewerPath = session.review_id
      ? reviewerDirectory(ctx, session.project_id, session.review_id, session.id)
      : undefined;
    const analysisRoot = path.join(ctx.workspaceRoot ?? os.tmpdir(), 'runtime-analysis');
    const analysisPath = session.runtime_review
      ? resolvedPath(path.join(analysisRoot, session.id))
      : undefined;
    if (analysisPath) {
      if (ctx.workspaceRoot) {
        assertManagedLocation(analysisPath);
        requireThat(
          inside(ctx.workspaceRoot, analysisPath),
          'scope_violation',
          'Analysis directory outside workspace root',
        );
      }
      mkdirSync(analysisPath, { recursive: true, mode: 0o700 });
    }
    const spec: SessionSpec = session.workspace_id
      ? ctx.store.must<Workspace>('workspaces', session.workspace_id).kind === 'in_place'
        ? await inPlaceSessionSpec(ctx, session)
        : workbenchSessionSpec(ctx, session)
      : managedSessionSpec(ctx, {
          platform_session_id: session.id,
          project_id: project.id,
          runtime: session.runtime,
          model: session.requested_model,
          effort: session.requested_effort,
          profile_version: session.profile_version,
          ...(session.runtime_review ? { runtime_analysis: true as const } : {}),
          ...(session.baseline || session.resident ? { read_only_shell: true as const } : {}),
          control_instructions: session.runtime_review
            ? RUNTIME_REVIEW_CONTRACT
            : session.resident
              ? RESIDENT_INSTRUCTIONS[session.resident.kind]
              : purposeSessionInstructions(session, {
                  rounds: readAppSettings(ctx).baseline_rounds,
                  visuals: readAppSettings(ctx).baseline_visuals,
                }),
          account_ref: session.account_ref,
          role: session.review_id || session.runtime_review ? 'reviewer' : 'planner',
          cwd: analysisPath ?? reviewerPath ?? project.roots[0]!,
          ...(analysisPath
            ? { workspace: { id: session.id, path: analysisPath } }
            : reviewerPath
              ? { workspace: { id: session.id, path: reviewerPath } }
              : {
                  // git is filled in once this start holds the session.
                  project_roots: project.roots.map((root) => ({ path: root, git: false })),
                }),
          ...((session.review_id || analysisPath) && ctx.protectionPaths
            ? {
                sandbox: {
                  writable_roots: [],
                  protected_entries: reviewerProtectionList({
                    ...ctx.protectionPaths,
                    reviewerPath: analysisPath ?? reviewerPath!,
                    otherWorkspaces: ctx.store
                      .list<Workspace>('workspaces')
                      .filter((other) => other.kind !== 'in_place')
                      .map((other) => other.path),
                    otherReviewers: analysisPath
                      ? [
                          ...otherReviewers,
                          ...project.roots,
                          ...reviewsRoots(ctx),
                          ...readdirSync(analysisRoot, { withFileTypes: true })
                            .filter((entry) => entry.name !== session.id)
                            .map((entry) => path.join(analysisRoot, entry.name)),
                          ...ctx.managedWorkspaceRoots
                            .slice(1)
                            .map((root) => path.join(root, 'runtime-analysis')),
                        ]
                      : otherReviewers,
                  }).map(({ path, deny }) => ({ path, deny })),
                },
              }
            : ctx.protectionPaths
              ? {
                  sandbox: {
                    writable_roots: [],
                    protected_entries: plannerProtectionList({
                      ...ctx.protectionPaths,
                      workspaceRoot: ctx.workspaceRoot ? projectFolder(ctx, project.id) : undefined,
                      // A workspace that is or holds the project root would hide the project itself.
                      otherWorkspaces: [
                        ...ctx.store
                          .list<Workspace>('workspaces')
                          .filter((other) => other.kind !== 'in_place')
                          .map((other) => other.path),
                        ...reviewsRoots(ctx),
                      ]
                        .map((other) => resolvedPath(other))
                        .filter((other) =>
                          project.roots.every(
                            (root) =>
                              !inside(other, resolvedPath(root)) &&
                              !inside(resolvedPath(root), other),
                          ),
                        ),
                    }).map(({ path, deny }) => ({ path, deny })),
                  },
                }
              : {}),
          env_allowlist: NATIVE_ENV_ALLOWLIST,
          skills: [],
          mcp_servers: [],
          pantheon_mcp: sessionMcp(ctx, session, credentialRole(session)),
          extensions: { mode: 'none' },
          device_id: session.device_id ?? 'local',
          budget: {
            max_turns: 1,
            wall_time_ms: session.resident
              ? (ctx.turnWallTimeMs ?? WORKBENCH_TURN_MS)
              : session.review_id || session.runtime_review
                ? REVIEW_WALL_TIME_MS
                : session.baseline
                  ? BASELINE_WALL_TIME_MS
                  : STORY_WALL_TIME_MS,
          },
        });
    if (!session.runtime_review)
      spec.control_instructions = [MEMORY_INSTRUCTIONS, spec.control_instructions]
        .filter(Boolean)
        .join('\n\n');
    session = ctx.store.must<Session>('sessions', session.id);
    if (resumed) {
      confirmTermination(ctx, session);
      requireThat(
        session.native_id &&
          adapter.resume &&
          adapter.report.capabilities.resume?.status === 'supported',
        'unsupported_capability',
        'Runtime cannot resume this native session',
      );
      // A lost handshake must not leave the old identity as evidence for a new process.
      ctx.store.update(
        'sessions',
        { ...session, process_identity: undefined, reported_model: undefined },
        session.revision,
      );
    }
    const remote = onDevice(session);
    // Set before the device is prepared, so a discard meanwhile waits for this start.
    launching.add(session.id);
    let chosen: Session;
    try {
      if (remote) await prepareRemoteWorkspace(ctx, session);
      for (const root of spec.project_roots ?? []) root.git = await gitFolderAsync(root.path);
      requireThat(
        !ctx.store.must<Session>('sessions', session.id).stop_requested,
        'invalid_state',
        'Session is being discarded',
      );
      await startWriteAudit(
        ctx,
        spec,
        turn.id,
        spec.role !== 'writer' ||
          session.permission_mode === 'plan' ||
          (!session.direct_task && planUnfinished(ctx, session.id)),
      );
      bindSessionAdapter(ctx, session, adapter);
      closeToolRelay(ctx, session.id);
      // Session tools run here; the device runtime reaches them through a socket SSH forwards.
      const toolsSocket =
        remote && spec.pantheon_mcp
          ? path.join(os.tmpdir(), `pantheon-${session.id.slice(0, 12)}.sock`)
          : undefined;
      if (toolsSocket)
        ctx.toolRelays.set(
          session.id,
          (await serveSessionTools(spec.pantheon_mcp!, toolsSocket)).close,
        );
      // The device runs in its own worktree; the write audit and the queue keep the local spec.
      const launchSpec = remote ? remoteSessionSpec(ctx, session, spec, toolsSocket) : spec,
        sink = remote ? pullingSink(ctx, session.id, queue.sink) : queue.sink;
      try {
        if (session.native_id) {
          requireThat(adapter.resume, 'unsupported_capability', 'Runtime cannot resume sessions');
          handle = await adapter.resume(launchSpec, session.native_id, sink);
        } else handle = await adapter.start(launchSpec, sink);
      } catch (error) {
        closeToolRelay(ctx, session.id);
        checkRuntimeConnection(ctx, session.runtime);
        throw error;
      }
      ctx.failpoint('native_started_before_handle_saved');
      chosen = ctx.store.must<Session>('sessions', session.id);
      saveSessionHandle(ctx, handle);
      ctx.handles.set(turn.id, handle);
      ctx.endTurns.set(turn.id, queue.end);
    } finally {
      launching.delete(session.id);
    }
    // The model changed while the process started, and saving the handle wrote back the spec's model.
    if (
      session.workspace_id &&
      adapter.setModel &&
      chosen.requested_model !== undefined &&
      (chosen.requested_model !== spec.model || chosen.requested_effort !== spec.effort)
    ) {
      const current = ctx.store.must<Session>('sessions', session.id);
      ctx.store.update(
        'sessions',
        {
          ...current,
          requested_model: chosen.requested_model,
          requested_effort: chosen.requested_effort,
        },
        current.revision,
      );
      await applyModel(
        ctx,
        adapter,
        handle,
        { model: spec.model, effort: spec.effort, fast: spec.fast },
        chosen.requested_model,
        chosen.requested_effort,
        undefined,
        chosen.fast !== spec.fast ? chosen.fast === true : undefined,
      );
    }
    const fast = ctx.store.must<Session>('sessions', session.id).fast === true;
    if (session.workspace_id && adapter.setFastMode && fast !== (spec.fast === true))
      await applyFastMode(ctx, adapter, handle, spec.fast === true, fast);
    const ultracode = ctx.store.must<Session>('sessions', session.id).ultracode === true;
    if (session.workspace_id && adapter.setUltracode && ultracode !== (spec.ultracode === true))
      await applyUltracode(ctx, adapter, handle, spec.ultracode === true, ultracode);
    const mode = ctx.store.must<Session>('sessions', session.id).permission_mode ?? 'ask';
    // The mode changed while the process started; without a setter the change was refused.
    if (session.workspace_id && adapter.setPermissionMode && mode !== spec.permission_mode)
      await applyPermissionMode(ctx, adapter, handle, spec.permission_mode ?? 'ask', mode);
    if (resumed)
      ctx.store.transaction(() => {
        const current = ctx.store.must<Session>('sessions', session.id);
        const next = ctx.store.update(
          'sessions',
          { ...current, state: 'open' as const, stop_pending: false },
          current.revision,
        );
        endReconciledTurns(ctx, session.id);
        ctx.store.event('session.resumed', next, next.project_id, {}, resume.cause);
      });
    const completion = queue.done
      .then(async (state) => {
        if (ctx.cancelling.has(key) || !ctx.handles.has(key)) return;
        ctx.cancelling.set(key, completion);
        const stop = await stopSession(ctx, adapter, handle!, 'close');
        if (ctx.handles.get(key) === handle)
          await finishTurn(
            ctx,
            key,
            ctx.closing ? 'failed' : state,
            ctx.closing ? 'daemon_shutdown' : queue.failure,
            stop,
            ctx.closing ? 'failed' : queue.lastState,
          );
      })
      .finally(() => {
        queue.end();
        if (ctx.cancelling.get(key) === completion) ctx.cancelling.delete(key);
        if (
          !ctx.cancelling.has(key) &&
          ctx.handles.get(key) === handle &&
          !ctx.store.must<Session>('sessions', session.id).stop_pending
        ) {
          ctx.handles.delete(turn.id);
          ctx.endTurns.delete(turn.id);
        }
        ctx.completions.delete(completion);
      });
    ctx.completions.add(completion);
    ctx.failpoint('during_turn_start');
    await queue.start(adapter, handle, spec);
  } catch (error) {
    ctx.revokeSessionCredential?.(session.id);
    const failure = ctx.closing ? 'daemon_shutdown' : String(error);
    queue.end(failure);
    if (resumed && !handle)
      ctx.store.transaction(() => {
        const current = ctx.store.must<Session>('sessions', session.id);
        const next = ctx.store.update(
          'sessions',
          {
            ...current,
            state: 'reconciling' as const,
            process_identity:
              error instanceof SessionStartError && !error.stop.stopped
                ? undefined
                : session.process_identity,
          },
          current.revision,
        );
        ctx.store.event(
          'session.resume_failed',
          next,
          next.project_id,
          { error: failure },
          resume.cause,
        );
      });
    else if (!handle) {
      if (session.queued_handoff && (!(error instanceof SessionStartError) || error.stop.stopped))
        ctx.store.transaction(() => retryQueuedHandoff(ctx, session.id, failure));
      await finishTurn(
        ctx,
        key,
        'failed',
        failure,
        error instanceof SessionStartError ? { receipt: error.stop } : undefined,
        'failed',
        error instanceof DomainError ? error.code : undefined,
      );
    }
  }
}

/** The process a stop could not confirm ended, with its start time read while it may still run. */
function unconfirmedProcess(
  ctx: ControlContext,
  receipt: CancelReceipt | undefined,
): ProcessIdentity | undefined {
  const leader = receipt?.stopped === false ? receipt.evidence.members[0] : undefined;
  if (!leader || leader.start_time_us !== undefined) return leader;
  try {
    return ctx.readProcess(leader.pid) ?? leader;
  } catch {
    return leader;
  }
}

export async function finishTurn(
  ctx: ControlContext,
  key: string,
  state: 'completed' | 'failed' | 'cancelled',
  error?: string,
  stop?: { receipt?: CancelReceipt; error?: string; reason?: string },
  turnState = state,
  errorCode?: string,
): Promise<void> {
  await finishWriteAudit(ctx, ctx.store.must<SessionTurn>('session_turns', key).session_id);
  ctx.store.transaction(() => {
    const t = ctx.store.must<SessionTurn>('session_turns', key),
      s = ctx.store.must<Session>('sessions', t.session_id);
    if (
      s.state === 'reconciling' ||
      (!['queued', 'running'].includes(t.state) && !ctx.handles.has(key))
    )
      return;
    const turns = ctx.store
      .list<SessionTurn>('session_turns')
      .filter((turn) => turn.session_id === s.id && ['queued', 'running'].includes(turn.state));
    const stopPending = stop ? stop.receipt?.stopped !== true : s.stop_pending;
    const held = !s.stop_requested ? s.queued_handoff : undefined;
    // A confirmed close ends the process even when the adapter no longer reports its identity.
    if (
      turns.length === 0 &&
      (!s.stop_pending || stopPending === s.stop_pending) &&
      !s.process_identity &&
      stop?.receipt?.stopped !== true
    )
      return;
    for (const turn of turns) {
      const undelivered = turn.delivery === 'pending' || turn.delivery === 'queued';
      if (
        (held || (turn.id !== key && isRuntimeHeld(ctx, s.runtime))) &&
        turn.state === 'queued' &&
        undelivered
      )
        continue;
      const next = turnDelivery(
        ctx,
        turn,
        undelivered ? 'failed' : turn.delivery,
        undelivered ? (error ?? 'Session ended before delivery') : turn.delivery_reason,
        turn.state === 'queued' && state !== 'cancelled' ? 'failed' : turnState,
      );
      if (undelivered) returnNotes(ctx, s.id, [next]);
      ctx.store.event(`turn.${next.state}`, next, t.project_id, {
        ...stop,
        error: error ?? stop?.error,
        ...(errorCode ? { error_code: errorCode } : {}),
      });
    }
    const next = ctx.store.update(
      'sessions',
      {
        ...s,
        state: s.review_id
          ? ('closed' as const)
          : held?.blocked || (stopPending && !ctx.handles.has(key))
            ? ('reconciling' as const)
            : held
              ? ('running' as const)
              : ('open' as const),
        stop_pending: stopPending,
        // A start that failed without a handle leaves only the stop's evidence to reconcile with.
        process_identity:
          stop?.receipt?.stopped === true && !held
            ? undefined
            : (s.process_identity ??
              (ctx.handles.has(key) ? undefined : unconfirmedProcess(ctx, stop?.receipt))),
      },
      s.revision,
    );
    if (stop && !!s.stop_pending !== !!next.stop_pending)
      ctx.store.event(
        next.stop_pending ? 'session.stop_unconfirmed' : 'session.stop_confirmed',
        next,
        s.project_id,
        stop,
      );
    // An idle conversation closes with no turn event, and clients refresh only on events.
    else if (turns.length === 0) ctx.store.event('session.process_closed', next, s.project_id, {});
    loseSessionApprovals(ctx, s.id);
    ctx.revokeSessionCredential?.(s.id);
    if (s.review_id) settleReview(ctx, s.review_id);
    if (turns.length) unsnooze(ctx, s.id, 'turn_ended');
  });
  if (stop?.receipt?.stopped === true)
    closeToolRelay(ctx, ctx.store.must<SessionTurn>('session_turns', key).session_id);
  ctx.changed();
}

export async function stopTurn(
  ctx: ControlContext,
  key: string,
  reason?: 'daemon_shutdown',
  method: 'cancel' | 'close' = 'cancel',
): Promise<void> {
  const running = ctx.cancelling.get(key);
  if (running) return running;
  const handle = ctx.handles.get(key);
  if (!handle) return;
  const session = ctx.store.must<Session>('sessions', handle.platform_session_id);
  const stopping = (async () => {
    ctx.endTurns.get(key)?.(reason);
    const stop = await stopSession(ctx, sessionAdapter(ctx, session)!, handle, method);
    await finishTurn(ctx, key, 'failed', reason, { ...stop, reason });
    if (stop.receipt?.stopped === true) {
      ctx.handles.delete(key);
      ctx.endTurns.delete(key);
    }
    // Completion awakened by cancellation must not race a close against its receipt.
    await Promise.resolve();
  })().finally(() => ctx.cancelling.delete(key));
  ctx.cancelling.set(key, stopping);
  return stopping;
}

/** Closes the idle conversation processes of a project; their next input resumes them. */
export function releaseIdleConversations(ctx: ControlContext, projectId: string): void {
  for (const handle of ctx.handles.values())
    if (
      ctx.idleConversations.has(handle.platform_session_id) &&
      ctx.store.must<Session>('sessions', handle.platform_session_id).project_id === projectId
    )
      queues.get(handle)?.release();
}

/** Whether the session's native process is starting or running a turn. */
export function nativeTurnActive(ctx: ControlContext, session: Session): boolean {
  return (
    launching.has(session.id) ||
    (!!sessionHandle(ctx, session) && !ctx.idleConversations.has(session.id))
  );
}

/** The session without its native conversation; a fresh native start sets these fields again. */
export function withoutNativeConversation(ctx: ControlContext, session: Session): Session {
  requireThat(
    !session.workspace_id ||
      ctx.store.must<Workspace>('workspaces', session.workspace_id).kind !== 'in_place',
    'invalid_state',
    "A session in the user folder keeps the user's native session",
  );
  return {
    ...session,
    native_id: undefined,
    last_cursor: undefined,
    event_namespace: undefined,
    reported_model: undefined,
    adapter_version: undefined,
    native_state_dir: undefined,
    native_fork: undefined,
  };
}

/** Closes the session's idle conversation process; its next input resumes it. */
export function releaseIdleConversation(ctx: ControlContext, session: Session): void {
  const handle = sessionHandle(ctx, session);
  if (handle && ctx.store.must<Session>('sessions', session.id).state === 'open')
    queues.get(handle)?.release();
}

export async function stopConversations(ctx: ControlContext): Promise<void> {
  let retried = false;
  for (const [key, handle] of [...ctx.handles]) {
    if (ctx.closing) return;
    const session = ctx.store.must<Session>('sessions', handle.platform_session_id);
    if (session.stop_pending) {
      if (ctx.cancelling.has(key) || ctx.store.now() < (stopRetryAfter.get(handle) ?? 0)) continue;
      // Retry off the tick path, but keep shutdown waiting for the whole stop lifecycle.
      const completion = stopTurn(ctx, key, undefined, 'close').finally(() => {
        stopRetryAfter.set(handle, ctx.store.now() + 1000);
        ctx.completions.delete(completion);
      });
      ctx.completions.add(completion);
      retried = true;
    }
  }
  for (const [sessionId, since] of [...ctx.idleConversations]) {
    const entry = [...ctx.handles].find(([, handle]) => handle.platform_session_id === sessionId);
    if (!entry) continue;
    const [key, handle] = entry,
      session = ctx.store.must<Session>('sessions', sessionId);
    // A running session has an input on its way to this process.
    if (ctx.cancelling.has(key) || session.stop_pending || session.state !== 'open') continue;
    if (ctx.store.now() - since >= conversationIdleLimitMs) queues.get(handle)?.release();
  }
  // Let ready receipts free their slots before dispatch, without waiting for a pending stop.
  if (retried) await new Promise<void>((resolve) => setImmediate(resolve));
}
