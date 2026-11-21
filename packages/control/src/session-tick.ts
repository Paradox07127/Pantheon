import type { Approval, Session } from '@pantheon/domain';
import type { ControlContext } from './context.js';
import { relayingQuestion } from './approvals.js';
import { latestEvent, stuckMerge } from './needs-you.js';
import { advanceQueuedHandoffs } from './session.js';
import { finishStops } from './workbench-session.js';

/** A permission request unanswered this long, in milliseconds, is escalated once: the user and the lead are reminded. */
const ESCALATION_MS = 10 * 60_000;

export function tickSessions(ctx: ControlContext): void {
  // Every tick runs this, so the stops of all worktree sessions carry on here too.
  finishStops(ctx);
  advanceQueuedHandoffs(ctx);
  // A merge that gets stuck records nothing itself, so open views hear of it from this event, once per stop.
  for (const session of ctx.store.list<Session>('sessions')) {
    const progress = stuckMerge(ctx, session);
    if (
      progress &&
      (latestEvent(ctx, session.id, 'session.merge_stuck')?.sequence ?? 0) < progress.sequence
    )
      ctx.store.event('session.merge_stuck', session, session.project_id, {});
  }
  // The event marks the request escalated for needs-you, once; the lead of a task session hears of it from the tracker.
  for (const approval of ctx.store.list<Approval>('approvals')) {
    const waited = ctx.store.now() - approval.created_at;
    if (
      approval.kind !== 'permission' ||
      approval.state !== 'pending' ||
      waited <= ESCALATION_MS ||
      latestEvent(ctx, approval.id, 'approval.escalated') ||
      relayingQuestion(ctx, approval)
    )
      continue;
    ctx.store.event('approval.escalated', approval, approval.project_id, { waited_ms: waited });
  }
}
