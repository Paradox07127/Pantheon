import { DomainError, type Approval, type BoardPlan } from '@pantheon/domain';
import type { ControlContext } from './context.js';
import { approvalAccess, approvalBindingCurrent, relayingQuestion } from './approvals.js';
import {
  NEXT_STEP,
  latestEvent,
  lostRequestOpen,
  type NeedsYouDraft,
  type NeedsYouScope,
} from './needs-you.js';

/** Pending permission requests and questions. */
export function pendingApprovalItems(ctx: ControlContext, scope: NeedsYouScope): NeedsYouDraft[] {
  const { principal, listedProject } = scope;
  const items: NeedsYouDraft[] = [];
  for (const approval of ctx.store
    .list<Approval>('approvals')
    .filter((a) => a.state === 'pending' && listedProject(a.project_id))) {
    // The lead's board question for it is the one item.
    if (relayingQuestion(ctx, approval)) continue;
    let disabledReason: string | undefined;
    try {
      approvalAccess(ctx, principal, approval);
      if (!approvalBindingCurrent(ctx, approval)) disabledReason = 'revision_conflict';
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      disabledReason = error.code;
    }
    if (principal.role === 'planner' && disabledReason) continue;
    const escalated = latestEvent(ctx, approval.id, 'approval.escalated');
    items.push({
      source: { table: 'approvals', id: approval.id, revision: approval.revision },
      kind: approval.kind,
      project_id: approval.project_id,
      ...(approval.session_id ? { session_id: approval.session_id } : {}),
      status: approval.state,
      created_at: approval.created_at,
      reason: 'permission_requested',
      decision: approval.questions?.length ? 'question' : 'permission',
      primary: 'approval.respond',
      actions: [
        {
          command: 'approval.respond',
          allowed: !disabledReason,
          ...(disabledReason ? { disabled_reason: disabledReason } : {}),
        },
      ],
      binding: {
        action: approval.tool,
        input_hash: approval.input_hash,
        input_summary: approval.input_summary,
        ...(approval.rule ? { rule: approval.rule } : {}),
        project_rule_supported: approval.project_rule_supported === true,
      },
      ...(approval.questions ? { questions: approval.questions } : {}),
      ...(escalated
        ? { waited_ms: ctx.store.now() - approval.created_at, escalated: true as const }
        : {}),
      ...(approval.session_id && ctx.store.get<BoardPlan>('board_plans', approval.session_id)
        ? { next_step: NEXT_STEP.lead_permission }
        : {}),
    });
  }
  return items;
}

/** Answers that were not delivered, and requests voided by a lost session. */
export function settledApprovalItems(ctx: ControlContext, scope: NeedsYouScope): NeedsYouDraft[] {
  const { principal, listedProject } = scope;
  const items: NeedsYouDraft[] = [];
  for (const approval of ctx.store
    .list<Approval>('approvals')
    .filter((a) => a.state !== 'pending' && listedProject(a.project_id))) {
    const undelivered = approval.delivery_error !== undefined && approval.resolved_at === undefined;
    if (!undelivered && !(approval.reason === 'session_lost' && lostRequestOpen(ctx, approval)))
      continue;
    try {
      approvalAccess(ctx, principal, approval);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      continue;
    }
    items.push({
      source: { table: 'approvals', id: approval.id, revision: approval.revision },
      kind: approval.kind,
      project_id: approval.project_id,
      session_id: approval.session_id,
      turn_id: approval.turn_id,
      request_id: approval.request_id,
      status: approval.state,
      created_at: approval.created_at,
      reason: undelivered ? 'answer_undelivered' : 'permission_voided',
      decision: 'other',
      actions: [],
      binding: {
        action: approval.tool,
        input_hash: approval.input_hash,
        input_summary: approval.input_summary,
      },
    });
  }
  return items;
}
