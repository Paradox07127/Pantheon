import {
  requireThat,
  type BoardPlan,
  type ExternalEvent,
  type Milestone,
  type Session,
} from '@pantheon/domain';
import { projectAccess, type ControlContext } from './context.js';
import { acceptInput } from './session.js';
import { currentAcceptance, currentDirectMerge } from './board-plan.js';
import { milestoneView } from './project-facts.js';
import { personalAnswer } from './personal-scope.js';
import { blockedReport } from './lead-inbox.js';
import { stuckUpstream } from './task-dispatch.js';
import { laneHeld } from './lane-stops.js';
import { runningPlanReview } from './review.js';
import { taskWorkflow } from './workflow-engine.js';
import {
  NEXT_STEP,
  action,
  latestEvent,
  type NeedsYouDraft,
  type NeedsYouScope,
} from './needs-you.js';

/** The plans' proposals, lanes waiting for plan approval, external holds, lead questions, blocked and undispatched tasks and lead wake failures. */
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
    for (const [laneId, stop] of Object.entries(plan.lane_stops ?? {})) {
      if (!laneHeld(plan, laneId)) continue;
      items.push({
        source: { table: 'board_plans', id: plan.id, revision: plan.revision },
        kind: 'board.lane.approval',
        project_id: plan.project_id,
        session_id: plan.id,
        request_id: laneId,
        lane_title: plan.lanes.find((lane) => lane.id === laneId)?.title,
        status: 'pending',
        created_at: stop.held_at,
        reason: 'lane_plan_awaiting_approval',
        decision: 'plan_change',
        primary: 'board.lane.approve',
        actions: [
          action('board.lane.approve', () => {
            projectAccess(ctx, principal, plan.project_id, 'board.lane.approve');
            personalAnswer(ctx, principal, 'board.lane.approve', plan.project_id);
          }),
        ],
        plan_review_running: plan.tasks.some(
          (task) =>
            task.lane === laneId &&
            !!task.kind &&
            taskWorkflow(ctx, plan, task.id).definition.plan_review.tiers.includes(
              task.kind.tier,
            ) &&
            !!runningPlanReview(ctx, plan, task.id),
        ),
        next_step: NEXT_STEP.lane_plan_awaiting_approval,
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

/** Milestones ready for acceptance. */
export function milestoneItems(
  ctx: ControlContext,
  scope: NeedsYouScope,
  planOf: Map<string, BoardPlan>,
): NeedsYouDraft[] {
  const { principal, listedProject } = scope;
  const items: NeedsYouDraft[] = [];
  for (const milestone of ctx.store.list<Milestone>('milestones')) {
    // A milestone the user created has no lead.
    const leadId = milestone.owner_session_id;
    if (
      milestone.removed_at ||
      (leadId ? !planOf.has(leadId) : !listedProject(milestone.project_id))
    )
      continue;
    const view = milestoneView(ctx, milestone);
    if (view.status !== 'ready_for_acceptance') continue;
    const plan = leadId ? planOf.get(leadId) : undefined;
    items.push({
      source: { table: 'milestones', id: milestone.id, revision: milestone.revision },
      kind: 'milestone.ready_for_acceptance',
      project_id: milestone.project_id,
      ...(leadId ? { session_id: leadId } : {}),
      status: view.status,
      // Ready since its last task was done, or since it last changed.
      created_at: Math.max(
        milestone.created_at,
        latestEvent(ctx, milestone.id, 'milestone.revised')?.created_at ?? 0,
        ...view.required_sessions.map(
          (sessionId) => latestEvent(ctx, sessionId, 'session.merged')?.created_at ?? 0,
        ),
        ...(milestone.task_ids ?? []).map((taskId) =>
          Math.max(
            currentAcceptance(plan, taskId)?.at ?? 0,
            currentDirectMerge(plan, taskId)?.at ?? 0,
          ),
        ),
      ),
      reason: 'milestone_ready_for_acceptance',
      decision: 'milestone_accept',
      primary: 'milestone.accept',
      actions: [
        action('milestone.accept', () => {
          projectAccess(ctx, principal, milestone.project_id, 'milestone.accept');
          personalAnswer(ctx, principal, 'milestone.accept', milestone.project_id);
        }),
      ],
      next_step: NEXT_STEP.milestone_ready_for_acceptance,
    });
  }
  return items;
}
