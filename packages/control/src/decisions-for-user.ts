import type { Approval, CharterMode, CharterPower, Principal } from '@pantheon/domain';
import type { DecisionForUser, DecisionsForUser } from '@pantheon/protocol';
import { projectAccess, type ControlContext } from './context.js';

type ListedPower = Extract<DecisionForUser, { kind: 'power_used' }>['power'];
// The two worker-prompt powers are covered by the approval and question events; an external start records no power use.
const LISTED_POWERS: CharterPower[] = [
  'plan_change',
  'accept_milestone',
  'merge_out_of_scope',
  'create_agent',
];

/** What a lead or a stored rule decided for the user in the project from since on, newest first. */
export function decisionsForUser(
  ctx: ControlContext,
  principal: Principal,
  projectId: string,
  since?: number,
): DecisionsForUser {
  projectAccess(ctx, principal, projectId, 'project.decisions');
  const items = ctx.store
    .kindEventsSince(projectId, ['charter.power_used', 'approval.approved'], since ?? 0)
    .flatMap((event): DecisionForUser[] => {
      const at = event.created_at;
      if (event.kind === 'charter.power_used') {
        const used = event.payload as {
          power: CharterPower;
          mode: CharterMode;
          subject: string;
          session_id: string;
        };
        return used.mode === 'on' && LISTED_POWERS.includes(used.power)
          ? [
              {
                kind: 'power_used',
                at,
                power: used.power as ListedPower,
                subject: used.subject,
                session_id: used.session_id,
              },
            ]
          : [];
      }
      // The event payload leaves out the input summary; the row is gone once its session was deleted.
      const approval = ctx.store.get<Approval>('approvals', event.aggregate_id);
      const answered = event.payload as Pick<
        Approval,
        'decider' | 'decided_by' | 'answered_by_rule'
      >;
      const prompt = {
        at,
        approval_id: event.aggregate_id,
        session_id: approval?.session_id,
        tool: approval?.tool,
        input_summary: approval?.input_summary,
      };
      if (answered.decider === 'lead')
        return [{ kind: 'prompt_approved', ...prompt, decided_by: answered.decided_by! }];
      if (answered.answered_by_rule)
        return [{ kind: 'prompt_by_rule', ...prompt, rule: answered.answered_by_rule }];
      return [];
    });
  return { items: items.reverse() };
}
