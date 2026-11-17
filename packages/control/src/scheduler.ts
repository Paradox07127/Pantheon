import { tickMemory } from './memory.js';
import type { Session, SessionTurn } from '@pantheon/domain';
import type { ControlContext } from './context.js';
import { startTurn, stopConversations } from './session.js';
import { isRuntimeHeld } from './runtime-status.js';
import { fireDueTimers } from './timers.js';
import { tickExternalSources } from './external-sources.js';
import { tickExternalIntake } from './external-events.js';
import { conditionsDecided, conditionsRead } from './workflow-engine.js';
import {
  deliverPermissionAnswer,
  recordAnswerDelivery,
  type PermissionAnswer,
} from './approvals.js';
import { removeWorkspace } from './workspace-removal.js';
import { autoMergesRead, mergeSession, rollbackTransaction } from './workbench-session.js';
import { removeReviewDirectories } from './review-removal.js';
import { startWorkspaceProvisioning } from './provisioning.js';
import { tickChangeStories } from './change-story.js';
import { tickRangeStories } from './range-story.js';
import { tickProjectBaselines } from './baseline.js';
import { tickTaskTracking } from './task-tracking.js';
import { readDispatchOpenings } from './task-dispatch.js';
import { forgetRetrospectiveScan, recordRetrospectives } from './retrospective.js';
import { evaluateTrials, proposeFromSignals } from './improvements.js';

export async function tick(ctx: ControlContext): Promise<void> {
  if (ctx.busy || ctx.closing) return;
  ctx.busy = true;
  try {
    await stopConversations(ctx);
    // The tracker and the merge jobs see the merges turns that ended have admitted.
    await autoMergesRead(ctx);
    // The step decisions below use the condition answers that earlier decisions requested.
    const reading = conditionsRead(ctx);
    if (reading) await reading;
    ctx.store.transaction(() => tickProjectBaselines(ctx));
    ctx.store.transaction(() => tickChangeStories(ctx));
    ctx.store.transaction(() => tickRangeStories(ctx));
    tickExternalIntake(ctx);
    // The dispatch in the tracker's transaction opens sessions from these start points; awaited
    // only when there is git to read, so a tick with nothing to read does not yield here.
    const openings = readDispatchOpenings(ctx);
    if (openings) await openings;
    try {
      rollbackTransaction(ctx, () => {
        tickTaskTracking(ctx);
        recordRetrospectives(ctx);
        proposeFromSignals(ctx);
        evaluateTrials(ctx);
      });
    } catch (error) {
      forgetRetrospectiveScan(ctx);
      throw error;
    } finally {
      conditionsDecided(ctx);
    }
    for (const out of ctx.store.pending()) {
      // Shutdown began while an earlier job awaited; the rest stay pending for the next daemon.
      if (ctx.closing) break;
      // A command may have settled the job while an earlier one awaited.
      if (
        ctx.store.db.prepare('SELECT state FROM outbox WHERE id=?').get(out.id)?.state !== 'pending'
      )
        continue;
      const payload = JSON.parse(out.payload) as Record<string, string>;
      if (out.kind === 'workspace.provision') {
        startWorkspaceProvisioning(ctx, payload.workspace_id!);
        ctx.store.mark(out.id, 'done');
      } else if (out.kind === 'session.turn') {
        const turn = ctx.store.must<SessionTurn>('session_turns', payload.turn_id!);
        const session = ctx.store.must<Session>('sessions', turn.session_id);
        if (isRuntimeHeld(ctx, session.runtime)) continue;
        ctx.store.mark(out.id, 'sent');
        await startTurn(ctx, payload.turn_id!);
        ctx.store.mark(out.id, 'done');
      } else if (out.kind === 'session.merge') mergeSession(ctx, payload.session_id!, out.id);
      else if (out.kind === 'workspace.remove')
        await removeWorkspace(ctx, payload.workspace_id!, out.id);
      else if (out.kind === 'review.remove')
        removeReviewDirectories(ctx, payload.review_id!, out.id);
    }
    fireDueTimers(ctx);
    tickMemory(ctx);
    tickExternalSources(ctx);
    for (const out of ctx.store.pending().filter((out) => out.kind === 'permission.answer')) {
      const payload = JSON.parse(out.payload) as PermissionAnswer;
      ctx.store.mark(out.id, 'sent');
      try {
        const receipt = await deliverPermissionAnswer(ctx, payload);
        // Adapters register a request before raising it, so a running process without it lost it.
        // A refused answer reopened its approval, which carries the reason.
        ctx.store.mark(
          out.id,
          receipt.ok || receipt.unknown_request || receipt.refused ? 'done' : 'pending',
        );
        recordAnswerDelivery(
          ctx,
          payload,
          receipt.ok || receipt.refused
            ? undefined
            : (receipt.reason ?? 'The runtime did not accept the answer'),
        );
      } catch (error) {
        ctx.store.mark(out.id, 'pending');
        recordAnswerDelivery(ctx, payload, error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    ctx.busy = false;
    ctx.changed();
  }
}
