import type {
  Approval,
  BoardPlan,
  CharterMode,
  CharterPower,
  LeadQuestion,
  Principal,
  Session,
} from '@pantheon/domain';
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
  const events = ctx.store.kindEventsSince(
    projectId,
    ['charter.power_used', 'approval.approved', 'lead.question_answered'],
    since ?? 0,
  );
  // Only a task session's question carries answered_by, and the lead answers it with citations.
  const byLead = (event: (typeof events)[number]) =>
    event.kind === 'lead.question_answered' &&
    (event.payload as LeadQuestion).answered_by === 'lead';
  // The AskUserQuestion request a lead's answer settled is listed as the answered question.
  const answeredRequests = new Set(
    events.filter(byLead).map((event) => (event.payload as LeadQuestion).source!.approval_id),
  );
  const items = events.flatMap((event): DecisionForUser[] => {
    const at = event.created_at;
    if (event.kind === 'lead.question_answered') {
      const question = byLead(event)
        ? ctx.store
            .get<BoardPlan>('board_plans', event.aggregate_id)
            ?.questions?.find((entry) => entry.id === (event.payload as LeadQuestion).id)
        : undefined;
      if (!question) return [];
      const { answer, source, citations } = question as Required<LeadQuestion>;
      return [
        {
          kind: 'question_answered',
          at,
          lead_session_id: event.aggregate_id,
          question_id: question.id,
          session_id: ctx.store.get<Session>('sessions', source.session_id)
            ? source.session_id
            : undefined,
          question: question.question,
          answer: answer.overruled?.text ?? answer.text,
          citations,
          ...(answer.overruled ? { overruled: { answer: answer.text, at: answer.at } } : {}),
        },
      ];
    }
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
    const answered = event.payload as Pick<Approval, 'decider' | 'decided_by' | 'answered_by_rule'>;
    const prompt = {
      at,
      approval_id: event.aggregate_id,
      session_id: approval?.session_id,
      tool: approval?.tool,
      // Tool input can hold secrets.
      ...(principal.role === 'personal' ? {} : { input_summary: approval?.input_summary }),
    };
    if (answered.decider === 'lead' && !answeredRequests.has(event.aggregate_id))
      return [{ kind: 'prompt_approved', ...prompt, decided_by: answered.decided_by! }];
    if (answered.answered_by_rule)
      return [
        {
          kind: 'prompt_by_rule',
          ...prompt,
          // A stored rule can be a whole command line.
          ...(principal.role === 'personal' ? {} : { rule: answered.answered_by_rule }),
        },
      ];
    return [];
  });
  return { items: items.reverse() };
}
