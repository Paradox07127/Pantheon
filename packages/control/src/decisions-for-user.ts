import type { Approval, Principal } from '@pantheon/domain';
import type { DecisionForUser, DecisionsForUser } from '@pantheon/protocol';
import { projectAccess, type ControlContext } from './context.js';

/**
 * What a stored rule, or the main agent that spawned a session, decided for the user in the
 * project from since on, newest first.
 */
export function decisionsForUser(
  ctx: ControlContext,
  principal: Principal,
  projectId: string,
  since?: number,
): DecisionsForUser {
  projectAccess(ctx, principal, projectId, 'project.decisions');
  const events = ctx.store.kindEventsSince(
    projectId,
    ['approval.approved', 'approval.rejected', 'approval.refused', 'approval.resolved'],
    since ?? 0,
  );
  // Tool input can hold secrets, and a stored rule can be a whole command line.
  const personal = principal.role === 'personal';
  const seen = new Set<string>();
  // Events run newest first, so the first event of a request is the one that stands.
  const items = [...events].reverse().flatMap((event): DecisionForUser[] => {
    const answered = event.payload as Omit<Approval, 'input_summary'>;
    // A delivered answer changes nothing; a refusal or a withdrawal leaves no decision standing.
    if (event.kind === 'approval.resolved' && answered.state !== 'void') return [];
    if (seen.has(event.aggregate_id)) return [];
    seen.add(event.aggregate_id);
    if (event.kind === 'approval.refused' || event.kind === 'approval.resolved') return [];
    const byRule = event.kind === 'approval.approved' && !!answered.answered_by_rule;
    // A decline with a reason is the daemon's, for a session that went away before delivery.
    const byMainAgent =
      !!answered.conductor_reason &&
      !!answered.decided_by?.startsWith('session:') &&
      !answered.reason;
    if (!byRule && !byMainAgent) return [];
    // The event payload leaves out the input summary; the row is gone once its session was deleted.
    const approval = ctx.store.get<Approval>('approvals', event.aggregate_id);
    if (byRule)
      return [
        {
          kind: 'prompt_by_rule',
          at: event.created_at,
          approval_id: event.aggregate_id,
          session_id: approval?.session_id,
          tool: approval?.tool,
          ...(personal
            ? {}
            : { input_summary: approval?.input_summary, rule: answered.answered_by_rule }),
        },
      ];
    // The main agent's answer leaves with its session.
    if (!approval) return [];
    const questions = approval.questions?.map((each) => each.question).join('; ');
    return [
      {
        kind: 'answered_by_main_agent',
        at: event.created_at,
        approval_id: approval.id,
        session_id: approval.session_id,
        tool: approval.tool,
        decision: event.kind === 'approval.approved' ? 'approve' : 'reject',
        main_agent_session_id: answered.decided_by!.slice('session:'.length),
        ...(personal
          ? {}
          : {
              reason: answered.conductor_reason,
              ...(approval.input_summary ? { input_summary: approval.input_summary } : {}),
              ...(questions ? { question: questions } : {}),
              ...(answered.answers ? { answers: answered.answers } : {}),
            }),
      },
    ];
  });
  return { items };
}
