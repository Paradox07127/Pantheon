import {
  DomainError,
  type Session,
  type SessionTurn,
  type Review,
  type Workspace,
  type AgentEvent,
} from '@pantheon/domain';
import { sessionRole } from '@pantheon/protocol';
import type { ControlContext } from './context.js';
import { loseSessionApprovals, recoverApprovals } from './approvals.js';
import { settleReview } from './review.js';
import { recoverReviewDirectories } from './review-removal.js';
import { turnDelivery } from './agent.js';
import { confirmTermination } from './process.js';
import { recoverChildProcesses } from './child-processes.js';
import { failWorkbenchTurns, workspaceReady } from './provisioning.js';
import { discardStopped, recoverGateRuns, rollbackTransaction } from './workbench-session.js';
import { finishRollback, restoreCheckpoint } from './checkpoint.js';
import { recoverQueuedHandoff, unsnooze } from './session.js';
import { waitingNotice } from './session-wake.js';
import { afterSpawnedTurn, tellSpawners } from './conductor.js';
import { recoverEnvironmentChecks } from './environment-check.js';
import { reconciledStates } from './non-writer-audit.js';

function recoverArtifacts(ctx: ControlContext): void {
  const referenced = new Set<string>();
  // Every table with a data column is read, so a file any row names is kept.
  const rowTables = ctx.store.db
    .prepare(
      "SELECT m.name AS name FROM sqlite_schema m JOIN pragma_table_info(m.name) c ON c.name='data' WHERE m.type='table'",
    )
    .all() as { name: string }[];
  for (const [table, column] of [
    ...rowTables.map(({ name }) => [name, 'data']),
    ['events', 'payload'],
  ])
    for (const row of ctx.store.db.prepare(`SELECT ${column} AS content FROM ${table}`).iterate())
      for (const name of String(row.content).match(/[a-f0-9]{64}|\.[a-f0-9-]+\.tmp/g) ?? [])
        referenced.add(name);
  const names: string[] = [];
  const count = ctx.files.collect(referenced, names);
  if (count)
    ctx.store.event('storage.collected', { id: 'storage', revision: 1 }, '', {
      count,
      names: names.slice(0, 100),
    });
}

/**
 * Restores the checkpoint of each rollback the daemon left unfinished again and writes its record.
 * A checkpoint that cannot be restored drops the intent and reconciles the session.
 */
async function recoverRollbacks(ctx: ControlContext): Promise<void> {
  for (const pending of ctx.store.list<Session>('sessions').filter((s) => s.rollback_pending)) {
    const workspace = ctx.store.must<Workspace>('workspaces', pending.workspace_id!);
    const restored = await restoreCheckpoint(workspace.path, pending.rollback_pending!.checkpoint)
      .then((head) => ({ head }))
      .catch((error: unknown) => ({ error }));
    rollbackTransaction(ctx, () => {
      const session = ctx.store.must<Session>('sessions', pending.id);
      if ('head' in restored) {
        finishRollback(ctx, session, restored.head);
        return;
      }
      const next = ctx.store.update(
        'sessions',
        { ...session, rollback_pending: undefined, state: 'reconciling' as const },
        session.revision,
      );
      ctx.store.event('session.reconciling', next, next.project_id, {
        reason: `rollback checkpoint could not be restored: ${String(restored.error)}`,
      });
    });
  }
}

/** An in-place session has the user's native id from the start; it is unstarted while none of its turns ran. */
function inPlaceUnstarted(ctx: ControlContext, session: Session): boolean {
  return (
    ctx.store.must<Workspace>('workspaces', session.workspace_id!).kind === 'in_place' &&
    ctx.store
      .list<SessionTurn>('session_turns')
      .every(
        (turn) =>
          turn.session_id !== session.id ||
          (['queued', 'running'].includes(turn.state) && turn.delivery === 'pending'),
      )
  );
}

/** Reviewer sessions settleReview may close as reconciled; one without a status baseline reads no git. */
function closableReviewers(ctx: ControlContext): string[] {
  return ctx.store
    .list<Review>('reviews')
    .flatMap((review) => review.session_ids)
    .filter((id) => {
      const session = ctx.store.get<Session>('sessions', id);
      return session !== undefined && session.state !== 'closed';
    });
}

/** Ends what an older version left in flight that nothing runs now: range story sessions and turns from a lead or a continuation. */
function retireLegacyRows(ctx: ControlContext): void {
  const error = 'Retired by an upgrade';
  for (const turn of ctx.store.list<SessionTurn>('session_turns')) {
    const story = ctx.store.get<Session>('sessions', turn.session_id)?.range_story;
    if (
      ['queued', 'running'].includes(turn.state) &&
      (story ||
        (turn.state === 'queued' && (turn.origin === 'lead' || turn.origin === 'continuation')))
    ) {
      const failed = turnDelivery(
        ctx,
        turn,
        turn.delivery === 'delivered' ? turn.delivery : 'failed',
        error,
        'failed',
      );
      ctx.store.event('turn.failed', failed, failed.project_id, { error });
    }
  }
  for (const session of ctx.store
    .list<Session>('sessions')
    .filter((s) => s.range_story && s.state !== 'closed')) {
    const next = ctx.store.update(
      'sessions',
      { ...session, state: 'closed' as const, stop_pending: false, process_identity: undefined },
      session.revision,
    );
    ctx.store.event('session.closed', next, next.project_id, { reason: 'retired' });
    unsnooze(ctx, next.id, 'session_ended');
  }
}

export async function recover(ctx: ControlContext): Promise<void> {
  const reconciled = await reconciledStates(ctx, closableReviewers(ctx));
  rollbackTransaction(ctx, () => {
    recoverChildProcesses(ctx);
    recoverGateRuns(ctx);
    recoverEnvironmentChecks(ctx);
    for (const workspace of ctx.store
      .list<Workspace>('workspaces')
      .filter((workspace) => workspace.owner.startsWith('landing:')))
      ctx.store.update(
        'workspaces',
        { ...workspace, owner: 'none', ownership_epoch: workspace.ownership_epoch + 1 },
        workspace.revision,
      );
    recoverArtifacts(ctx);
    recoverApprovals(ctx);
    retireLegacyRows(ctx);
    // A stop whose old process may still run finishes in reconcile, once its termination is confirmed.
    for (const session of ctx.store
      .list<Session>('sessions')
      .filter(
        (s) =>
          s.stop_requested &&
          !s.outcome &&
          s.state !== 'reconciling' &&
          !(s.state === 'running' && s.native_id) &&
          !s.process_identity,
      )) {
      failWorkbenchTurns(ctx, session, 'Session discarded');
      discardStopped(ctx, session.id, '');
    }
    const pendingTurns = new Set(
        ctx.store
          .pending()
          .filter((entry) => entry.kind === 'session.turn')
          .map((entry) => (JSON.parse(entry.payload) as { turn_id: string }).turn_id),
      ),
      reconcilingSessions = new Set(
        ctx.store
          .list<Session>('sessions')
          .filter((session) => session.state === 'reconciling')
          .map((session) => session.id),
      ),
      unstartedSessions = new Set<string>(),
      unstartedTurns = new Set<string>();
    for (const s of ctx.store
      .list<Session>('sessions')
      .filter((s) => s.state === 'running' || (s.state === 'open' && !!s.process_identity))) {
      if (s.workspace_id && !s.process_identity && (!s.native_id || inPlaceUnstarted(ctx, s))) {
        const ready = workspaceReady(ctx.store.must<Workspace>('workspaces', s.workspace_id));
        for (const turn of ctx.store
          .list<SessionTurn>('session_turns')
          .filter(
            (turn) => turn.session_id === s.id && ['queued', 'running'].includes(turn.state),
          )) {
          if (turn.state === 'running')
            ctx.store.update('session_turns', { ...turn, state: 'queued' as const }, turn.revision);
          unstartedTurns.add(turn.id);
          // A not-yet-ready worktree enqueues its turns when it becomes ready.
          if (ready && !pendingTurns.has(turn.id))
            ctx.store.enqueue('session.turn', { turn_id: turn.id });
        }
        continue;
      }
      // Input never handed to a start left the session as it was when open without an identity,
      // which recovery keeps: its last process had exited.
      if (!s.process_identity && s.native_id) {
        const active = ctx.store
          .list<SessionTurn>('session_turns')
          .filter((turn) => turn.session_id === s.id && ['queued', 'running'].includes(turn.state));
        if (
          active.length > 0 &&
          active.every(
            (turn, index) =>
              turn.state === 'queued' &&
              turn.delivery === 'pending' &&
              // Notices behind the first turn run after it, as the turn queue drains.
              (pendingTurns.has(turn.id) || (index > 0 && waitingNotice(turn))),
          )
        ) {
          for (const turn of active) unstartedTurns.add(turn.id);
          continue;
        }
      }
      // Review, baseline and change-story sessions open running with only a queued first turn.
      if (sessionRole(s) !== 'main' && !s.process_identity && !s.native_id) {
        const turns = ctx.store
          .list<SessionTurn>('session_turns')
          .filter((turn) => turn.session_id === s.id && ['queued', 'running'].includes(turn.state));
        if (
          turns.length > 0 &&
          turns.every(
            (turn) =>
              turn.state === 'queued' && turn.delivery === 'pending' && pendingTurns.has(turn.id),
          )
        ) {
          unstartedSessions.add(s.id);
          for (const turn of turns) unstartedTurns.add(turn.id);
          continue;
        }
      }
      const next = ctx.store.update(
        'sessions',
        { ...s, state: 'reconciling' as const },
        s.revision,
      );
      ctx.store.event('session.reconciling', next, s.project_id, {
        reason: 'daemon_restart; old execution termination unverified',
      });
    }
    for (const session of ctx.store
      .list<Session>('sessions')
      .filter((s) => s.state === 'reconciling')) {
      if (
        sessionRole(session) !== 'main' &&
        reconcilingSessions.has(session.id) &&
        !session.process_identity &&
        !session.native_id
      ) {
        const turns = ctx.store
          .list<SessionTurn>('session_turns')
          .filter((turn) => turn.session_id === session.id);
        if (turns.every((turn) => turn.delivery === 'pending')) {
          const next = ctx.store.update(
            'sessions',
            { ...session, state: 'closed' as const, stop_pending: false },
            session.revision,
          );
          const error = 'Session never started before the daemon stopped';
          for (const turn of turns) {
            const failed = turnDelivery(ctx, turn, 'failed', error, 'failed');
            ctx.store.event('turn.failed', failed, session.project_id, { error });
          }
          ctx.store.event('session.closed', next, session.project_id, { reason: 'never_started' });
          unsnooze(ctx, next.id, 'session_ended');
          continue;
        }
      }
      const row = ctx.store.db
        .prepare(
          "SELECT payload FROM events WHERE aggregate_id=? AND kind GLOB 'agent.*' AND json_extract(payload,'$.key') IS NOT NULL ORDER BY sequence DESC LIMIT 1",
        )
        .get(session.id) as { payload: string } | undefined;
      if (!row) continue;
      const event = JSON.parse(row.payload) as AgentEvent;
      const cursor = event.key.slice(event.key.indexOf(':') + 1);
      const namespace = event.key.includes(':') ? event.key.split(':')[0] : session.event_namespace;
      if (session.last_cursor !== cursor || session.event_namespace !== namespace)
        ctx.store.update(
          'sessions',
          {
            ...session,
            last_cursor: cursor,
            event_namespace: namespace,
            adapter_version:
              session.adapter_version ?? ctx.adapters.get(session.runtime)?.report.version,
          },
          session.revision,
        );
    }
    for (const o of ctx.store.pending().filter((o) => o.kind === 'session.turn'))
      if (!unstartedTurns.has((JSON.parse(o.payload) as { turn_id: string }).turn_id))
        ctx.store.mark(o.id, 'sent');
    // A lost resume handshake may already have spawned a session. Never replay it on restart.
    ctx.store.db
      .prepare(
        "UPDATE outbox SET state='done' WHERE kind='session.turn' AND json_extract(payload,'$.resume')=1 AND state IN ('pending','sent')",
      )
      .run();
    ctx.store.db
      .prepare("UPDATE outbox SET state='pending' WHERE kind='permission.answer' AND state='sent'")
      .run();
    for (const review of ctx.store.list<Review>('reviews'))
      settleReview(
        ctx,
        review.id,
        !review.session_ids.length || !review.session_ids.every((id) => unstartedSessions.has(id)),
        reconciled,
      );
    recoverReviewDirectories(ctx);
  });
  tellSpawners(ctx);
  ctx.changed();
}

export async function reconcile(ctx: ControlContext): Promise<void> {
  if (ctx.busy || ctx.closing) return;
  ctx.busy = true;
  try {
    // Restoring files runs git asynchronously, so unfinished rollbacks finish here, not in recover.
    await recoverRollbacks(ctx);
    for (const session of ctx.store
      .list<Session>('sessions')
      .filter((s) => s.state === 'reconciling' && s.workspace_id)) {
      try {
        confirmTermination(ctx, session);
      } catch (error) {
        // An unconfirmed stop keeps the session reconciling for session.resolve.
        if (error instanceof DomainError && error.code === 'termination_unconfirmed') continue;
        throw error;
      }
      rollbackTransaction(ctx, () => {
        const current = ctx.store.must<Session>('sessions', session.id);
        const error = 'Interrupted by a daemon restart';
        const interrupted = ctx.store
          .list<SessionTurn>('session_turns')
          .filter(
            (turn) => turn.session_id === session.id && ['queued', 'running'].includes(turn.state),
          );
        if (recoverQueuedHandoff(ctx, current, interrupted)) return;
        // A notice that never reached the session runs once the session takes input again.
        const kept = current.stop_requested ? [] : interrupted.filter(waitingNotice);
        for (const turn of interrupted) {
          if (kept.includes(turn)) continue;
          const failed = turnDelivery(
            ctx,
            turn,
            ['pending', 'queued'].includes(turn.delivery) ? 'failed' : turn.delivery,
            error,
            'failed',
          );
          ctx.store.event('turn.failed', failed, failed.project_id, { error });
        }
        loseSessionApprovals(ctx, session.id);
        const next = ctx.store.update(
          'sessions',
          {
            ...current,
            state: kept.length ? ('running' as const) : ('open' as const),
            stop_pending: false,
            process_identity: undefined,
          },
          current.revision,
        );
        // A stop the restart interrupted ends in the discard it asked for.
        if (next.stop_requested) {
          discardStopped(ctx, next.id, '');
          return;
        }
        ctx.store.event('session.recovered', next, next.project_id, {});
        if (kept.length) ctx.store.enqueue('session.turn', { turn_id: kept[0]!.id });
        if (interrupted.length === kept.length) return;
        unsnooze(ctx, next.id, 'turn_ended');
      });
      if (session.spawned_by) afterSpawnedTurn(ctx, session.id);
    }
  } finally {
    ctx.busy = false;
    ctx.changed();
  }
}
