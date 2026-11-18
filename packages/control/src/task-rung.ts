import type { Approval, BoardPlan, Review, Session, SessionTurn, StepRun } from '@pantheon/domain';
import type { BoardTaskRung } from '@pantheon/protocol';
import { ownEntry } from './board-plan.js';
import type { ControlContext } from './context.js';
import { relayingQuestion } from './approvals.js';
import { charterMode } from './charter.js';
import { usageResetAt } from './continuation.js';
import { blockedReport } from './lead-inbox.js';
import { continuationLimit, latestEvent, latestExecuted } from './needs-you.js';
import { awaitsDecision } from './needs-you-workflow.js';
import { handBackAllowed, mergeProblem, type HandBackCheck } from './task-tracking.js';
import { taskWorkflow } from './workflow-engine.js';
import { projectBudgetUse, projectOverBudget, workflowPolicy } from './workflow-policy.js';

/** What a task's rung is computed from; times are epoch milliseconds. */
export interface TaskRungFacts {
  /** The followed session's merge problem with the tracker's hand-back check; absent while a report holds the session. */
  problem?: HandBackCheck & { reason: string; at: number };
  /** Pantheon's hand-back or review findings turn the followed session is on, while it has no merge problem. */
  retry_turn?: { reason: string; at: number; used: number; limit: number };
  dispatch_error?: { attempts: number; at: number };
  /** The blocked or requirement report that holds the session for the lead. */
  report?: { kind: string; at: number };
  /** The state the tracker last told the lead of, while it lasts. */
  told?: { state: 'blocked' | 'failed' | 'turn_failed' | 'no_changes'; at: number };
  /** A stall or loop of the session the tracker told the lead of. */
  alert?: { kind: 'stalled' | 'looping'; at: number };
  /** What the task waits on the user for, the first one first. */
  user: { reason: string; at: number }[];
  switches: BoardTaskRung['switches'];
}

const TOLD = ['blocked', 'failed', 'turn_failed', 'no_changes'] as const;

/** When the tracker last left the lead a note of kind about the session. */
function noteAt(
  ctx: ControlContext,
  plan: BoardPlan,
  sessionId: string,
  kind: string,
): number | undefined {
  const row = ctx.store
    .statement(
      "SELECT created_at FROM events WHERE aggregate_id=? AND kind='lead.note_added' AND json_extract(payload,'$.session_id')=? AND json_extract(payload,'$.kind')=? ORDER BY sequence DESC LIMIT 1",
    )
    .get(plan.id, sessionId, kind) as { created_at: number } | undefined;
  return row?.created_at;
}

/**
 * Reads the facts of the task's rung: the task's queue entry, the runtime changes of its sessions,
 * and the tracker's view of the newest one without an outcome, else the newest. sessions are the
 * task's current sessions, oldest first, without the lead.
 */
export function taskRungFacts(
  ctx: ControlContext,
  plan: BoardPlan,
  taskId: string,
  sessions: Session[],
  now: number,
): TaskRungFacts {
  const ids = new Set(sessions.map((session) => session.id));
  const facts: TaskRungFacts = {
    user: [],
    switches: ctx.store
      .kindEvents(plan.project_id, ['session.runtime_changed'])
      .filter((event) => ids.has(event.aggregate_id))
      .map((event) => {
        const { from, to } = event.payload as { from: string; to: string };
        return { from, to, at: event.created_at, by: 'lead' as const };
      }),
  };
  const entry = ownEntry(plan.dispatch, taskId);
  if (entry && projectOverBudget(ctx, plan.project_id))
    facts.user.push({
      reason: 'project_over_budget',
      at: projectBudgetUse(ctx, plan.project_id)?.reached_at ?? entry.requested_at,
    });
  if (entry?.error) facts.dispatch_error = { attempts: entry.error.attempts, at: entry.error.at };
  const session = sessions.findLast((each) => !each.outcome);
  if (!session) return facts;
  const turns = ctx.store
      .list<SessionTurn>('session_turns')
      .filter((turn) => turn.session_id === session.id),
    latest = latestExecuted(ctx, turns),
    running = turns.findLast((turn) => turn.state === 'running');
  const alerts = [
    ...(running ? (ownEntry(plan.alerted, running.id) ?? []) : []),
    ...(ownEntry(plan.alerted, session.id) ?? []),
  ];
  const runningAt = () =>
    (running && latestEvent(ctx, running.id, 'turn.running')?.created_at) ?? now;
  // As needs-you lists the session for the user.
  if (alerts.includes('still_looping'))
    facts.user.push({ reason: 'task_turn_looping', at: runningAt() });
  if (alerts.includes('stall_unanswered'))
    facts.user.push({ reason: 'task_turn_stalled', at: runningAt() });
  const request = ctx.store.list<Approval>('approvals').find(
    (approval) =>
      approval.session_id === session.id &&
      approval.kind === 'permission' &&
      approval.state === 'pending' &&
      // The lead answers this question instead.
      !(
        relayingQuestion(ctx, approval) &&
        charterMode(ctx, approval.project_id, 'answer_worker_questions') === 'on'
      ),
  );
  if (request) facts.user.push({ reason: 'permission', at: request.created_at });
  if (usageResetAt(ctx, session.id) !== undefined) {
    const failed = turns.findLast((turn) => turn.state === 'failed');
    facts.user.push({
      reason: 'usage_limit_waiting',
      at: (failed && latestEvent(ctx, failed.id, 'turn.failed')?.created_at) ?? now,
    });
  }
  const limit = continuationLimit(ctx, session.id);
  if (limit) facts.user.push({ reason: 'continuation_limit_reached', at: limit.created_at });
  const step = ctx.store
    .list<StepRun>('workflow_step_runs')
    .find((run) => run.session_id === session.id && awaitsDecision(run, plan));
  if (step)
    facts.user.push({
      reason: 'workflow_approval',
      at: latestEvent(ctx, step.id, 'workflow.step_changed')?.created_at ?? step.created_at,
    });
  const lead = alerts.includes('looping')
    ? 'looping'
    : alerts.includes('stalled')
      ? 'stalled'
      : undefined;
  if (lead) facts.alert = { kind: lead, at: noteAt(ctx, plan, session.id, lead) ?? now };
  const told = TOLD.find((state) => state === ownEntry(plan.notified, session.id));
  if (told) facts.told = { state: told, at: noteAt(ctx, plan, session.id, told) ?? now };
  // The tracker leaves a session its report holds alone.
  const report = blockedReport(ctx, session);
  if (report) {
    facts.report = { kind: report.kind, at: report.at };
    return facts;
  }
  const { problem } = mergeProblem(ctx, plan, session, latest);
  if (problem) {
    const event = latestEvent(
      ctx,
      session.id,
      session.merge?.state === 'blocked' ? 'session.merge_blocked' : 'session.merge_skipped',
    );
    facts.problem = {
      reason: problem,
      at: event?.created_at ?? now,
      ...handBackAllowed(
        ctx,
        plan,
        session,
        problem,
        turns.findLast((turn) => turn.origin === 'tracker')?.input,
        latest,
      ),
    };
    return facts;
  }
  if (latest?.origin !== 'tracker') return facts;
  const at = latestEvent(ctx, latest.id, 'turn.queued')?.created_at ?? now,
    run = ctx.store.list<StepRun>('workflow_step_runs').find((each) => each.turn_id === latest.id);
  const handedBack = ownEntry(plan.handed_back, session.id) ?? [];
  if (run?.review_id)
    facts.retry_turn = {
      reason: 'review_findings',
      at,
      used: ctx.store.list<Review>('reviews').filter((review) => review.session_id === session.id)
        .length,
      limit: taskWorkflow(ctx, plan, taskId, sessions).definition.review.max_rounds,
    };
  // A tracker turn of no step run is a hand-back.
  else if (!run && handedBack.length) {
    const reason = handedBack.at(-1)!;
    facts.retry_turn = {
      reason,
      at,
      used: handedBack.filter((each) => each === reason).length,
      limit: workflowPolicy(ctx, plan.project_id).handback_limit,
    };
  }
  return facts;
}

/** Who acts next on the task, from its facts; undefined when nothing went wrong. */
export function taskRung(facts: TaskRungFacts): BoardTaskRung | undefined {
  const { problem, switches } = facts;
  if (problem?.allowed)
    return {
      rung: 'retry',
      by: 'pantheon',
      reason: problem.reason,
      used: problem.used,
      limit: problem.limit,
      ...(problem.held ? { held: problem.held } : {}),
      since: problem.at,
      switches,
    };
  const user = facts.user[0];
  if (user) return { rung: 'user', by: 'user', reason: user.reason, since: user.at, switches };
  const lead = facts.report
    ? { reason: facts.report.kind, at: facts.report.at }
    : facts.told
      ? { reason: problem?.reason ?? facts.told.state, at: facts.told.at }
      : facts.alert
        ? { reason: facts.alert.kind, at: facts.alert.at }
        : undefined;
  if (lead)
    return {
      rung: 'lead',
      by: 'lead',
      reason: lead.reason,
      // The lead has it because Pantheon's tries of the problem are used up.
      ...(facts.told && problem && problem.used >= problem.limit
        ? { used: problem.used, limit: problem.limit }
        : {}),
      since: lead.at,
      switches,
    };
  const retry = facts.retry_turn;
  if (retry)
    return {
      rung: 'retry',
      by: 'pantheon',
      reason: retry.reason,
      used: retry.used,
      limit: retry.limit,
      since: retry.at,
      switches,
    };
  if (facts.dispatch_error)
    return {
      rung: 'retry',
      by: 'pantheon',
      reason: 'dispatch_failed',
      used: facts.dispatch_error.attempts,
      since: facts.dispatch_error.at,
      switches,
    };
  const last = switches.at(-1);
  if (last)
    return { rung: 'switch', by: last.by, reason: 'runtime_changed', since: last.at, switches };
}
