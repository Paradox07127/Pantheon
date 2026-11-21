import { requireThat, type BoardPlan, type ExternalEvent, type Session } from '@pantheon/domain';
import { projectAccess, type ControlContext } from './context.js';
import { acceptInput } from './session.js';
import { personalAnswer } from './personal-scope.js';
import { blockedReport } from './lead-inbox.js';
import { stuckUpstream } from './task-dispatch.js';
import { NEXT_STEP, action, type NeedsYouDraft, type NeedsYouScope } from './needs-you.js';

/** The plans' proposals, external holds, lead questions, blocked and undispatched tasks and lead wake failures. */
export function planItems(
  ctx: ControlContext,
  scope: NeedsYouScope,
  plans: BoardPlan[],
  sessions: Session[],
): NeedsYouDraft[] {
  const { principal } = scope;
  const items: NeedsYouDraft[] = [];
  for (const plan of plans) {
    for (const proposal of plan.pending_proposals ?? []) {
      if (proposal.status !== 'pending') continue;
      items.push({
        source: { table: 'board_plans', id: plan.id, revision: plan.revision },
        kind: 'board.plan.proposal',
        project_id: plan.project_id,
        session_id: plan.id,
        request_id: proposal.proposal_id,
        status: 'pending',
        created_at: proposal.created_at,
        reason: 'plan_proposal_awaiting_decision',
        decision: 'plan_change',
        primary: 'board.plan.proposal.resolve',
        actions: [
          action('board.plan.proposal.resolve', () => {
            projectAccess(ctx, principal, plan.project_id, 'board.plan.proposal.resolve');
            personalAnswer(ctx, principal, 'board.plan.proposal.resolve', plan.project_id);
          }),
        ],
        next_step: NEXT_STEP.plan_proposal_awaiting_decision,
      });
    }
    for (const [subject, hold] of Object.entries(plan.external_holds ?? {})) {
      const title = ctx.store
        .list<ExternalEvent>('external_events')
        .findLast(
          (event) => event.project_id === plan.project_id && event.subject_key === subject,
        )?.title;
      items.push({
        source: { table: 'board_plans', id: plan.id, revision: plan.revision },
        kind: 'external.approval',
        project_id: plan.project_id,
        session_id: plan.id,
        request_id: subject,
        status: 'pending',
        created_at: hold.at,
        reason: 'external_approval',
        decision: 'external',
        primary: 'external.approve',
        actions: [
          action('external.approve', () =>
            requireThat(principal.role === 'user', 'permission_denied', 'Only user'),
          ),
        ],
        next_step: `Approve “${title ?? subject}” to let its tasks start.`,
      });
    }
    for (const question of plan.questions ?? []) {
      if (question.answer) continue;
      items.push({
        source: { table: 'board_plans', id: plan.id, revision: plan.revision },
        kind: 'lead.question',
        project_id: plan.project_id,
        session_id: plan.id,
        request_id: question.id,
        status: 'pending',
        created_at: question.at,
        reason: 'lead_question',
        decision: 'question',
        primary: 'lead.question.answer',
        question,
        plan_title: plan.headline,
        ...(question.default_after_ms && { default_at: question.at + question.default_after_ms }),
        actions: [
          action('lead.question.answer', () => {
            projectAccess(ctx, principal, plan.project_id, 'lead.question.answer');
            personalAnswer(ctx, principal, 'lead.question.answer', plan.project_id, question);
          }),
        ],
      });
    }
    const owner = ctx.store.get<Session>('sessions', plan.id);
    if (!owner || owner.state === 'closed')
      for (const session of sessions.filter(
        (session) => session.task?.lead_session_id === plan.id,
      )) {
        const blocked = blockedReport(ctx, session);
        if (!blocked) continue;
        items.push({
          source: { table: 'sessions', id: session.id, revision: session.revision },
          kind: 'session.failed',
          project_id: plan.project_id,
          session_id: plan.id,
          task_id: `${plan.id}:${session.task!.id}`,
          status: 'waiting',
          created_at: blocked.at,
          reason: 'task_blocked',
          decision: 'other',
          blocked,
          actions: [],
        });
      }
    for (const [taskId, entry] of Object.entries(plan.dispatch ?? {})) {
      if (!entry.error) continue;
      items.push({
        source: { table: 'board_plans', id: plan.id, revision: plan.revision },
        kind: 'session.failed',
        project_id: plan.project_id,
        session_id: plan.id,
        task_id: `${plan.id}:${taskId}`,
        status: 'queued',
        created_at: entry.error.at,
        reason: 'task_dispatch_failed',
        decision: 'other',
        actions: [],
        next_step: NEXT_STEP.task_dispatch_failed,
      });
    }
    for (const [taskId, entry] of Object.entries(plan.dispatch ?? {})) {
      const upstream = plan.tasks
        .find((task) => task.id === taskId)
        ?.depends_on.flatMap((upstreamId) => {
          const stuck = stuckUpstream(ctx, plan, upstreamId)?.stuck;
          return stuck ? [{ task_id: `${plan.id}:${upstreamId}`, stuck }] : [];
        })[0];
      if (!upstream) continue;
      items.push({
        source: { table: 'board_plans', id: plan.id, revision: plan.revision },
        kind: 'session.failed',
        project_id: plan.project_id,
        session_id: plan.id,
        task_id: `${plan.id}:${taskId}`,
        status: 'queued',
        created_at: entry.requested_at,
        reason: 'task_upstream_stuck',
        decision: 'other',
        actions: [],
        upstream,
        next_step: NEXT_STEP.task_upstream_stuck,
      });
    }
    const lead = ctx.store.get<Session>('sessions', plan.id);
    // A plan moved to another lead keeps the mark until its next wake.
    if (plan.wake_failed && (!lead || lead.state === 'closed'))
      items.push({
        source: { table: 'board_plans', id: plan.id, revision: plan.revision },
        kind: 'session.failed',
        project_id: plan.project_id,
        session_id: plan.id,
        status: 'closed',
        created_at: plan.wake_failed.at,
        reason: 'lead_closed',
        decision: 'other',
        primary: 'board.sync',
        actions: [
          action('board.sync', () => projectAccess(ctx, principal, plan.project_id, 'board.sync')),
        ],
        next_step: NEXT_STEP.lead_closed,
      });
    else if (plan.wake_failed?.reason === 'wake_limit')
      items.push({
        source: { table: 'board_plans', id: plan.id, revision: plan.revision },
        kind: 'session.failed',
        project_id: plan.project_id,
        session_id: plan.id,
        status: lead!.state,
        created_at: plan.wake_failed.at,
        reason: 'lead_wake_limited',
        decision: 'other',
        primary: 'session.send',
        actions: [
          action('session.send', () => {
            projectAccess(ctx, principal, plan.project_id, 'session.send');
            acceptInput(ctx, lead!, 'send');
          }),
        ],
        next_step: NEXT_STEP.lead_wake_limited,
      });
  }
  return items;
}
