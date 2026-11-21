import type { Approval, Principal } from '@pantheon/domain';
import type { DecisionForUser, DecisionsForUser } from '@pantheon/protocol';
import { projectAccess, type ControlContext } from './context.js';

/** What a stored rule decided for the user in the project from since on, newest first. */
export function decisionsForUser(
  ctx: ControlContext,
  principal: Principal,
  projectId: string,
  since?: number,
): DecisionsForUser {
  projectAccess(ctx, principal, projectId, 'project.decisions');
  const events = ctx.store.kindEventsSince(projectId, ['approval.approved'], since ?? 0);
  const items = events.flatMap((event): DecisionForUser[] => {
    const answered = event.payload as Pick<Approval, 'answered_by_rule'>;
    if (!answered.answered_by_rule) return [];
    // The event payload leaves out the input summary; the row is gone once its session was deleted.
    const approval = ctx.store.get<Approval>('approvals', event.aggregate_id);
    return [
      {
        kind: 'prompt_by_rule',
        at: event.created_at,
        approval_id: event.aggregate_id,
        session_id: approval?.session_id,
        tool: approval?.tool,
        // Tool input can hold secrets, and a stored rule can be a whole command line.
        ...(principal.role === 'personal'
          ? {}
          : { input_summary: approval?.input_summary, rule: answered.answered_by_rule }),
      },
    ];
  });
  return { items: items.reverse() };
}
