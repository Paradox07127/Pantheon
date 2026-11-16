import {
  DomainError,
  requireThat,
  type Approval,
  type BoardPlan,
  type Improvement,
  type LandingItem,
  type Milestone,
  type NeedsYouItem,
  type Principal,
  type Project,
  type Session,
  type SessionTurn,
  type Workspace,
  type StepRun,
  type StoredWorkflowDefinition,
} from '@pantheon/domain';
import { projectAccess, type ControlContext } from './context.js';
import { approvalAccess, approvalBindingCurrent, relayingQuestion } from './approvals.js';
import { requireMergeReady, sessionList } from './workbench-session.js';
import { usageLimitWaiting, usageResetAt } from './continuation.js';
import { acceptInput } from './session.js';
import {
  currentAcceptance,
  currentDirectMerge,
  ownEntry,
  retiredBinding,
  taskGeneration,
} from './board-plan.js';
import { milestoneView } from './project-facts.js';
import { blockedReport } from './lead-inbox.js';
import { stuckUpstream } from './task-dispatch.js';
import { BACKGROUND_LONG_MS, longBackground } from './progress.js';
import { projectBudgetUse, workflowPolicy } from './workflow-policy.js';

/** A running merge with no progress event for this long is stuck; each gate command has a timeout. */
const MERGE_STUCK_MS = 30 * 60_000;
const MERGE_PROGRESS = ['session.merge_started', 'session.gate_started', 'session.gate_checked'];

/** A stop whose process has not confirmed it stopped for this long needs the user. */
const STOP_UNCONFIRMED_MS = 2 * 60_000;

/** Session items listed under the session.failed kind, told apart by their reason. */
type SessionAttention =
  | 'merge_stuck'
  | 'lead_turn_failed'
  | 'continuation_limit_reached'
  | 'workspace_reconciling'
  | 'stop_unconfirmed'
  | 'task_retired'
  | 'task_turn_looping'
  | 'task_turn_stalled'
  | 'lead_turn_looping'
  | 'lead_turn_stalled'
  | 'usage_limit_waiting'
  | 'background_task_long';

const NEXT_STEP: Record<
  | SessionAttention
  | 'lead_closed'
  | 'lead_wake_limited'
  | 'task_dispatch_failed'
  | 'task_upstream_stuck'
  | 'lead_permission'
  | 'milestone_ready_for_acceptance'
  | 'improvement_awaiting_decision'
  | 'plan_proposal_awaiting_decision',
  string
> = {
  merge_stuck: 'The user checks the stuck merge and cancels it if needed.',
  stop_unconfirmed:
    "The session's process has not confirmed it stopped; the user confirms the process stopped, or retries the stop.",
  workspace_reconciling:
    'A daemon restart interrupted the workspace setup, so whether its Git processes stopped is unknown; the user reconciles: once no Git process is still running in the workspace, discard this session.',
  continuation_limit_reached:
    'The automatic continuations are used up; the user sends the session a message to go on.',
  lead_turn_failed: 'The user retries, or sends the lead a message to go on.',
  lead_closed:
    'The lead is closed; the user reopens it, or hands the plan to a new lead with a board sync.',
  lead_wake_limited:
    'Board updates woke the lead too often in a short time, so Pantheon stopped waking it; the updates stay in its inbox and waking resumes in a few minutes. The user checks whether the lead is spinning and, if needed, sends it a message to correct course.',
  usage_limit_waiting:
    'The session used up its subscription limit; Pantheon has it go on once the limit resets and opens no new turn until then. The user waits for the reset, or moves it to another runtime.',
  task_dispatch_failed:
    "Pantheon retries with backoff; the lead can change the task's runtime, and the user can check why this runtime is unavailable.",
  task_upstream_stuck:
    'The queued task waits on a dependency nobody moves forward, and the lead was reminded; the user checks why the dependency stopped and has the lead restart or change it, or stops the queued task.',
  task_retired:
    "The lead removed the session's task from the plan (the same id may now be a new task), so its changes no longer merge; the user checks the changes, then discards this session.",
  task_turn_looping:
    "The task session's turn still repeats the same tool call after the lead was reminded; the user interrupts the turn, or sends the lead a message to correct course.",
  task_turn_stalled:
    "The task session's turn stalled and the lead has not handled it since it was reminded; the user interrupts the turn, or sends the lead a message to handle it.",
  lead_turn_looping:
    "The lead's turn repeats the same tool call; the user interrupts the turn, then sends the lead a message to correct course.",
  lead_turn_stalled:
    "The lead's turn has made no progress for a long time, or a tool call never ended; the user interrupts the turn, then sends the lead a message to go on.",
  lead_permission:
    "This is the lead's own permission request; its turn waits for the answer and gets no task session reports meanwhile. The lead goes on once the user allows or denies it.",
  milestone_ready_for_acceptance:
    "The milestone's tasks are all done; the user checks its acceptance criteria and accepts it, or tells the lead what is still missing.",
  improvement_awaiting_decision:
    'The improvement proposal awaits the user; the user confirms it to start a trial, or rejects it.',
  plan_proposal_awaiting_decision:
    'The plan proposal awaits the user; the user accepts it, changes its ops before accepting, or rejects it.',
  background_task_long:
    'A background command or agent of the session has run for 30 minutes; the user stops it, or waits for it to end.',
};

/** The aggregate's latest event of kind. */
function latestEvent(
  ctx: ControlContext,
  aggregateId: string,
  kind: string,
): { sequence: number; created_at: number } | undefined {
  return ctx.store.db
    .prepare(
      'SELECT sequence, created_at FROM events WHERE aggregate_id=? AND kind=? ORDER BY sequence DESC LIMIT 1',
    )
    .get(aggregateId, kind) as { sequence: number; created_at: number } | undefined;
}

/** The latest progress event of the session's running merge, when it is old enough to be stuck. */
export function stuckMerge(
  ctx: ControlContext,
  session: Session,
): { sequence: number; created_at: number } | undefined {
  if (session.merge?.state !== 'running') return;
  const progress = ctx.store.db
    .prepare(
      `SELECT sequence, created_at FROM events WHERE aggregate_id=? AND kind IN (${MERGE_PROGRESS.map(() => '?').join(',')}) ORDER BY sequence DESC LIMIT 1`,
    )
    .get(session.id, ...MERGE_PROGRESS) as { sequence: number; created_at: number } | undefined;
  return progress && ctx.store.now() - progress.created_at > MERGE_STUCK_MS ? progress : undefined;
}

/** The skip that hit the continuation limit, while the session has had no turn since. */
function continuationLimit(
  ctx: ControlContext,
  sessionId: string,
): { created_at: number } | undefined {
  const skip = ctx.store.db
    .prepare(
      "SELECT sequence, created_at FROM events WHERE aggregate_id=? AND kind='session.continuation_skipped' AND json_extract(payload,'$.reason')='limit_reached' ORDER BY sequence DESC LIMIT 1",
    )
    .get(sessionId) as { sequence: number; created_at: number } | undefined;
  if (!skip) return;
  const later = ctx.store.db
    .prepare(
      "SELECT 1 FROM events WHERE kind='turn.queued' AND json_extract(payload,'$.session_id')=? AND sequence>? LIMIT 1",
    )
    .get(sessionId, skip.sequence);
  return later ? undefined : skip;
}

/** True once the turn started running. */
export function ran(ctx: ControlContext, turn: SessionTurn): boolean {
  return latestEvent(ctx, turn.id, 'turn.running') !== undefined;
}

/** A steer delivered into a running turn, or refused by it, never runs as a turn of its own. */
export function executed(ctx: ControlContext, turn: SessionTurn): boolean {
  return turn.kind !== 'steer' || ran(ctx, turn);
}

/** The session's latest turn that runs or ran as a turn of its own. */
export function latestExecuted(ctx: ControlContext, turns: SessionTurn[]): SessionTurn | undefined {
  return turns.findLast((turn) => executed(ctx, turn));
}

/** A failed lead turn is not replayed; the lead waits for its next message. */
export function leadTurnFailed(
  ctx: ControlContext,
  lead: Session,
  latest: SessionTurn | undefined,
): boolean {
  return lead.state === 'open' && latest?.state === 'failed' && !usageLimitWaiting(ctx, lead.id);
}

/** The command as an action, disabled with the code of the error its check throws. */
function action(command: string, check: () => void): NeedsYouItem['actions'][number] {
  try {
    check();
    return { command, allowed: true };
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return { command, allowed: false, disabled_reason: error.code };
  }
}

/** A lost request stays open until its session starts a turn after the one that raised it. */
function lostRequestOpen(ctx: ControlContext, approval: Approval): boolean {
  const session = ctx.store.get<Session>('sessions', approval.session_id ?? '');
  if (!approval.turn_id || !session || session.archived_at || session.outcome) return false;
  const turns = ctx.store
    .list<SessionTurn>('session_turns')
    .filter((turn) => turn.session_id === session.id);
  return !turns
    .slice(turns.findIndex((turn) => turn.id === approval.turn_id) + 1)
    .some((turn) => turn.state !== 'queued' && turn.state !== 'cancelled' && executed(ctx, turn));
}

export function needsYou(
  ctx: ControlContext,
  principal: Principal,
  projectId?: string,
): { items: NeedsYouItem[] } {
  requireThat(
    (principal.role === 'user' || principal.role === 'planner') &&
      (!principal.expires_at || principal.expires_at > ctx.store.now()),
    'permission_denied',
    'User or planner principal required',
  );
  if (principal.role === 'planner') {
    projectId ??= principal.project_id;
    requireThat(
      projectId && projectId === principal.project_id,
      'permission_denied',
      'Project principal required',
    );
  }
  const items: NeedsYouItem[] = [];
  for (const approval of ctx.store
    .list<Approval>('approvals')
    .filter((a) => a.state === 'pending' && (!projectId || a.project_id === projectId))) {
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
  if (principal.role === 'user')
    for (const approval of ctx.store
      .list<Approval>('approvals')
      .filter((a) => a.state !== 'pending' && (!projectId || a.project_id === projectId))) {
      const undelivered =
        approval.delivery_error !== undefined && approval.resolved_at === undefined;
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
        actions: [],
        binding: {
          action: approval.tool,
          input_hash: approval.input_hash,
          input_summary: approval.input_summary,
        },
      });
    }
  if (principal.role === 'user') {
    const removed = new Set(
      ctx.store
        .list<Project>('projects')
        .filter((project) => project.removed_at !== undefined)
        .map((project) => project.id),
    );
    const sessions = ctx.store
      .list<Session>('sessions')
      .filter(
        (s) =>
          !s.archived_at &&
          !s.outcome &&
          !removed.has(s.project_id) &&
          (!projectId || s.project_id === projectId),
      );
    const listed = new Map(
      [
        ...new Set(
          sessions
            .filter((s) => s.workspace_id || s.baseline || s.runtime_review)
            .map((s) => s.project_id),
        ),
      ].flatMap((id) =>
        sessionList(ctx, principal, id, false).map((session) => [session.id, session] as const),
      ),
    );
    const plans = ctx.store
      .list<BoardPlan>('board_plans')
      .filter(
        (plan) => !removed.has(plan.project_id) && (!projectId || plan.project_id === projectId),
      );
    const leads = new Set(plans.map((plan) => plan.id)),
      planOf = new Map(plans.map((plan) => [plan.id, plan])),
      sessionTurns = new Map<string, SessionTurn[]>();
    for (const turn of ctx.store.list<SessionTurn>('session_turns')) {
      const turns = sessionTurns.get(turn.session_id);
      if (turns) turns.push(turn);
      else sessionTurns.set(turn.session_id, [turn]);
    }
    for (const session of sessions) {
      const audit = latestEvent(ctx, session.id, 'session.write_detected');
      if (audit)
        items.push({
          source: { table: 'sessions', id: session.id, revision: session.revision },
          kind: 'session.failed',
          project_id: session.project_id,
          status: session.state,
          created_at: audit.created_at,
          reason: 'non_writer_write_detected',
          actions: [],
          next_step:
            'This read-only session changed tracked files, or called a write tool. Review its changes and tool calls, then restore unintended changes.',
        });
      if (session.external_hold && session.state !== 'running')
        items.push({
          source: { table: 'sessions', id: session.id, revision: session.revision },
          kind: 'external.approval',
          project_id: session.project_id,
          status: session.state,
          created_at: latestEvent(ctx, session.id, 'session.external_held')!.created_at,
          reason: 'external_approval',
          actions: [
            action('external.approve', () =>
              requireThat(principal.role === 'user', 'permission_denied', 'Only user'),
            ),
          ],
          next_step: `Approve “${session.title}” to let its tasks start.`,
        });
      const row = listed.get(session.id),
        latest = leads.has(session.id)
          ? latestExecuted(ctx, sessionTurns.get(session.id) ?? [])
          : undefined;
      const mergeStarted = stuckMerge(ctx, session)
        ? latestEvent(ctx, session.id, 'session.merge_started')
        : undefined;
      const limit =
          leads.has(session.id) || session.task ? continuationLimit(ctx, session.id) : undefined,
        resetAt = leads.has(session.id) || session.task ? usageResetAt(ctx, session.id) : undefined;
      const workspace = session.workspace_id
        ? ctx.store.get<Workspace>('workspaces', session.workspace_id)
        : undefined;
      const stop = session.stop_requested,
        stopUnconfirmed =
          stop &&
          (ctx.store.now() - stop.at >= STOP_UNCONFIRMED_MS ||
            (latestEvent(ctx, session.id, 'session.discard_failed')?.created_at ?? -1) >= stop.at);
      // The tracker keeps the alerts of running turns on the plan of the lead or of the task's lead.
      const running = sessionTurns.get(session.id)?.findLast((turn) => turn.state === 'running'),
        alerts = running
          ? (ownEntry(
              planOf.get(session.task?.lead_session_id ?? session.id)?.alerted,
              running.id,
            ) ?? [])
          : [],
        turnAlert: SessionAttention | undefined = leads.has(session.id)
          ? alerts.includes('looping')
            ? 'lead_turn_looping'
            : alerts.includes('stalled')
              ? 'lead_turn_stalled'
              : undefined
          : alerts.includes('still_looping')
            ? 'task_turn_looping'
            : alerts.includes('stall_unanswered')
              ? 'task_turn_stalled'
              : undefined;
      // The tracker hands a failed gate or a blocked merge to the open lead of the task.
      const taskPlan = session.task && planOf.get(session.task.lead_session_id),
        taskLead = taskPlan && ctx.store.get<Session>('sessions', taskPlan.id),
        leadHandles =
          !!taskLead &&
          taskLead.state !== 'closed' &&
          !retiredBinding(taskPlan, session) &&
          !(
            (session.merge?.reason === 'gate_failed' || row?.gate?.state === 'failed') &&
            (workflowPolicy(ctx, session.project_id).gate_on_fail === 'stop' ||
              workflowPolicy(ctx, session.project_id).handback_limit === 0)
          );
      const kind: NeedsYouItem['kind'] | SessionAttention | undefined =
        session.state === 'reconciling'
          ? 'session.reconciling'
          : workspace?.provisioning?.state === 'reconciling'
            ? 'workspace_reconciling'
            : stopUnconfirmed
              ? 'stop_unconfirmed'
              : row?.state === 'failed'
                ? 'session.failed'
                : mergeStarted
                  ? 'merge_stuck'
                  : row?.gate?.state === 'failed' && !leadHandles
                    ? 'session.gate_failed'
                    : session.merge?.state === 'blocked' && session.merge.reason === 'task_retired'
                      ? 'task_retired'
                      : row?.merge?.state === 'blocked' &&
                          !['cancelled', 'workflow_approval'].includes(row.merge.reason ?? '') &&
                          (!leadHandles || row.merge.reason === 'protected_paths')
                        ? 'session.merge_blocked'
                        : leads.has(session.id) && leadTurnFailed(ctx, session, latest)
                          ? 'lead_turn_failed'
                          : (turnAlert ??
                            (resetAt !== undefined
                              ? 'usage_limit_waiting'
                              : limit
                                ? 'continuation_limit_reached'
                                : undefined));
      // The lead hears of a task session's long background task; the user of any other session's.
      if (!session.task)
        for (const background of longBackground(ctx, session.id))
          items.push({
            source: { table: 'sessions', id: session.id, revision: session.revision },
            kind: 'session.failed',
            project_id: session.project_id,
            status: session.state,
            created_at: background.started_at + BACKGROUND_LONG_MS,
            reason: 'background_task_long',
            actions: [
              action('session.background.stop', () =>
                projectAccess(ctx, principal, session.project_id, 'session.background.stop'),
              ),
            ],
            background,
            next_step: NEXT_STEP.background_task_long,
          });
      if (!kind) continue;
      if (
        kind === 'task_turn_looping' ||
        kind === 'task_turn_stalled' ||
        kind === 'lead_turn_looping' ||
        kind === 'lead_turn_stalled'
      ) {
        items.push({
          source: { table: 'sessions', id: session.id, revision: session.revision },
          kind: 'session.failed',
          project_id: session.project_id,
          status: session.state,
          created_at: latestEvent(ctx, running!.id, 'turn.running')?.created_at ?? 0,
          reason: kind,
          actions: [
            action('session.interrupt', () =>
              projectAccess(ctx, principal, session.project_id, 'session.interrupt'),
            ),
          ],
          next_step: NEXT_STEP[kind],
        });
        continue;
      }
      if (kind === 'usage_limit_waiting') {
        const failed = sessionTurns.get(session.id)?.findLast((turn) => turn.state === 'failed');
        items.push({
          source: { table: 'sessions', id: session.id, revision: session.revision },
          kind: 'session.failed',
          project_id: session.project_id,
          status: session.state,
          created_at: failed ? (latestEvent(ctx, failed.id, 'turn.failed')?.created_at ?? 0) : 0,
          reason: kind,
          actions: [],
          resets_at: resetAt,
          next_step: NEXT_STEP[kind],
        });
        continue;
      }
      if (
        kind === 'merge_stuck' ||
        kind === 'lead_turn_failed' ||
        kind === 'continuation_limit_reached' ||
        kind === 'workspace_reconciling' ||
        kind === 'stop_unconfirmed' ||
        kind === 'task_retired'
      ) {
        items.push({
          source: { table: 'sessions', id: session.id, revision: session.revision },
          kind: 'session.failed',
          project_id: session.project_id,
          status: session.state,
          created_at:
            kind === 'merge_stuck'
              ? mergeStarted!.created_at
              : kind === 'lead_turn_failed'
                ? (latestEvent(ctx, latest!.id, 'turn.failed')?.created_at ?? 0)
                : kind === 'workspace_reconciling'
                  ? (latestEvent(ctx, workspace!.id, 'workspace.provisioning')?.created_at ?? 0)
                  : kind === 'stop_unconfirmed'
                    ? stop!.at
                    : kind === 'task_retired'
                      ? (latestEvent(ctx, session.id, 'session.merge_blocked')?.created_at ?? 0)
                      : limit!.created_at,
          reason: kind,
          // session.resolve answers a reconciling session, not its worktree.
          actions:
            kind === 'merge_stuck' ||
            kind === 'workspace_reconciling' ||
            kind === 'stop_unconfirmed' ||
            kind === 'task_retired'
              ? []
              : [
                  action('session.send', () => {
                    projectAccess(ctx, principal, session.project_id, 'session.send');
                    acceptInput(ctx, session, 'send');
                  }),
                ],
          next_step: NEXT_STEP[kind],
        });
        continue;
      }
      const reason: NeedsYouItem['reason'] =
        kind === 'session.failed'
          ? 'session_failed'
          : kind === 'session.gate_failed'
            ? 'gate_failed'
            : kind === 'session.merge_blocked'
              ? 'merge_blocked'
              : 'reconciliation_required';
      const event = ctx.store.db
        .prepare(
          'SELECT created_at, payload FROM events WHERE aggregate_id=? AND kind=? ORDER BY sequence DESC LIMIT 1',
        )
        .get(
          kind === 'session.failed' && session.baseline ? session.baseline.baseline_id : session.id,
          kind === 'session.failed'
            ? session.baseline
              ? 'project.baseline_failed'
              : 'session.closed'
            : kind === 'session.gate_failed'
              ? 'session.gate_checked'
              : kind,
        ) as { created_at: number; payload: string } | undefined;
      const failureClass =
        kind === 'session.merge_blocked'
          ? session.merge?.failure_class
          : kind === 'session.gate_failed' && event
            ? (
                JSON.parse(event.payload) as { results?: NonNullable<LandingItem['gate_results']> }
              ).results?.find((result) => result.state !== 'skipped' && result.failure_class)
                ?.failure_class
            : undefined;
      const actions: NeedsYouItem['actions'] = [];
      if (kind === 'session.reconciling')
        // Without a stored process identity session.resolve can never confirm the old process ended.
        actions.push(
          ...(session.process_identity
            ? [{ command: 'session.resolve', allowed: true }]
            : [
                {
                  command: 'session.resolve',
                  allowed: false,
                  disabled_reason: 'termination_unconfirmed',
                },
                ...(session.workspace_id && !session.baseline && workspace?.kind !== 'in_place'
                  ? [{ command: 'session.discard', allowed: true }]
                  : []),
              ]),
        );
      else if (kind === 'session.merge_blocked' && workspace?.kind !== 'in_place') {
        let disabledReason: string | undefined;
        try {
          projectAccess(ctx, principal, session.project_id, 'session.merge');
          requireMergeReady(ctx, session);
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
          disabledReason = error.code;
        }
        actions.push({
          command: 'session.merge',
          allowed: !disabledReason,
          ...(disabledReason ? { disabled_reason: disabledReason } : {}),
        });
      }
      items.push({
        source: { table: 'sessions', id: session.id, revision: session.revision },
        kind,
        project_id: session.project_id,
        status: session.state,
        created_at: event?.created_at ?? 0,
        reason,
        actions,
        ...(failureClass ? { failure_class: failureClass } : {}),
      });
    }
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
          actions: [
            action('board.plan.proposal.resolve', () =>
              projectAccess(ctx, principal, plan.project_id, 'board.plan.proposal.resolve'),
            ),
          ],
          next_step: NEXT_STEP.plan_proposal_awaiting_decision,
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
          question,
          actions: [
            action('lead.question.answer', () =>
              projectAccess(ctx, principal, plan.project_id, 'lead.question.answer'),
            ),
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
          actions: [
            action('board.sync', () =>
              projectAccess(ctx, principal, plan.project_id, 'board.sync'),
            ),
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
          actions: [
            action('session.send', () => {
              projectAccess(ctx, principal, plan.project_id, 'session.send');
              acceptInput(ctx, lead!, 'send');
            }),
          ],
          next_step: NEXT_STEP.lead_wake_limited,
        });
    }
    for (const milestone of ctx.store.list<Milestone>('milestones')) {
      const leadId = milestone.owner_session_id;
      if (!leadId || milestone.removed_at || !planOf.has(leadId)) continue;
      const view = milestoneView(ctx, milestone);
      if (view.status !== 'ready_for_acceptance') continue;
      const plan = planOf.get(leadId);
      items.push({
        source: { table: 'milestones', id: milestone.id, revision: milestone.revision },
        kind: 'milestone.ready_for_acceptance',
        project_id: milestone.project_id,
        session_id: leadId,
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
        actions: [
          action('milestone.accept', () =>
            projectAccess(ctx, principal, milestone.project_id, 'milestone.accept'),
          ),
        ],
        next_step: NEXT_STEP.milestone_ready_for_acceptance,
      });
    }
    for (const run of ctx.store.list<StepRun>('workflow_step_runs')) {
      if (
        run.state !== 'waiting' ||
        run.step.kind.type !== 'approval' ||
        removed.has(run.project_id) ||
        (projectId && run.project_id !== projectId)
      )
        continue;
      const plan = planOf.get(run.lead_session_id),
        task = plan?.tasks.find((t) => t.id === run.task_id);
      if (!task || taskGeneration(plan, run.task_id) !== run.generation) continue;
      items.push({
        source: { table: 'workflow_step_runs', id: run.id, revision: run.revision },
        kind: 'workflow.approval',
        project_id: run.project_id,
        session_id: run.session_id ?? run.lead_session_id,
        task_id: `${run.lead_session_id}:${run.task_id}`,
        task_title: task.title,
        step_title: run.step.title,
        status: 'waiting',
        created_at: run.created_at,
        reason: 'workflow_approval',
        actions: (['approve', 'reject'] as const).map((decision) => ({
          ...action('workflow.step.decide', () =>
            projectAccess(ctx, principal, run.project_id, 'workflow.step.decide'),
          ),
          decision,
        })),
        next_step: `Approve or reject “${run.step.title}” for “${task.title}”.`,
      });
    }
    for (const row of ctx.store.list<StoredWorkflowDefinition>('workflow_definitions')) {
      if (
        !row.trial ||
        row.trial.done !== row.trial.tasks ||
        removed.has(row.project_id) ||
        (projectId && row.project_id !== projectId)
      )
        continue;
      items.push({
        source: { table: 'workflow_definitions', id: row.id, revision: row.revision },
        kind: 'workflow.definition.trial',
        project_id: row.project_id,
        status: 'waiting',
        created_at: row.trial.started_at,
        reason: 'workflow_definition_trial_completed',
        actions: (['keep', 'revert'] as const).map((decision) => ({
          ...action('workflow.definition.trial.decide', () =>
            projectAccess(ctx, principal, row.project_id, 'workflow.definition.trial.decide'),
          ),
          decision,
        })),
      });
    }
    // A candidate waits for the user: auto mode starts each trial as it proposes the improvement.
    for (const improvement of ctx.store.list<Improvement>('improvements')) {
      if (
        improvement.status !== 'candidate' ||
        removed.has(improvement.project_id) ||
        (projectId && improvement.project_id !== projectId)
      )
        continue;
      items.push({
        source: { table: 'improvements', id: improvement.id, revision: improvement.revision },
        kind: 'improvement.candidate',
        project_id: improvement.project_id,
        ...(improvement.lead_session_id ? { session_id: improvement.lead_session_id } : {}),
        status: improvement.status,
        created_at: improvement.proposed_at,
        reason: 'improvement_awaiting_decision',
        actions: [
          action('improvement.decide', () =>
            projectAccess(ctx, principal, improvement.project_id, 'improvement.decide'),
          ),
        ],
        next_step: NEXT_STEP.improvement_awaiting_decision,
      });
    }
    for (const project of ctx.store.list<Project>('projects')) {
      if (removed.has(project.id) || (projectId && project.id !== projectId)) continue;
      const use = projectBudgetUse(ctx, project.id);
      if (use?.reached_at === undefined) continue;
      items.push({
        source: {
          table: 'workflow_policies',
          id: project.id,
          revision: workflowPolicy(ctx, project.id).revision,
        },
        kind: 'project.over_budget',
        project_id: project.id,
        status: 'over_budget',
        created_at: use.reached_at,
        reason: 'project_over_budget',
        actions: [
          action('workflow.policy.set', () =>
            projectAccess(ctx, principal, project.id, 'workflow.policy.set'),
          ),
        ],
        project_budget: {
          used_input_tokens: use.used_input_tokens,
          input_tokens: use.input_tokens,
        },
        next_step: `The project used ${use.used_input_tokens} input tokens since its budget was set, against a budget of ${use.input_tokens}; Pantheon opens no new task session and wakes no lead, and running turns finish. Work resumes once the user raises or clears the project budget.`,
      });
    }
  }
  return {
    items: items.sort(
      (a, b) => a.created_at - b.created_at || a.source.id.localeCompare(b.source.id),
    ),
  };
}
