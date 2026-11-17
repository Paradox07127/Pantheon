import {
  DomainError,
  type BoardPlan,
  type LandingItem,
  type NeedsYouItem,
  type Session,
  type SessionTurn,
  type Workspace,
} from '@pantheon/domain';
import { projectAccess, type ControlContext } from './context.js';
import { requireMergeReady, sessionList } from './workbench-session.js';
import { usageResetAt } from './continuation.js';
import { acceptInput } from './session.js';
import { ownEntry, retiredBinding } from './board-plan.js';
import { BACKGROUND_LONG_MS, longBackground } from './progress.js';
import { workflowPolicy } from './workflow-policy.js';
import {
  NEXT_STEP,
  STOP_UNCONFIRMED_MS,
  action,
  continuationLimit,
  latestEvent,
  latestExecuted,
  leadTurnFailed,
  stuckMerge,
  type NeedsYouDraft,
  type NeedsYouScope,
  type SessionAttention,
} from './needs-you.js';

/** The listed sessions' failures, stuck merges, alerts of running turns and long background tasks. */
export function sessionItems(
  ctx: ControlContext,
  scope: NeedsYouScope,
  sessions: Session[],
  plans: BoardPlan[],
  planOf: Map<string, BoardPlan>,
): NeedsYouDraft[] {
  const { principal } = scope;
  const items: NeedsYouDraft[] = [];
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
  const leads = new Set(plans.map((plan) => plan.id)),
    sessionTurns = new Map<string, SessionTurn[]>();
  for (const turn of ctx.store.list<SessionTurn>('session_turns')) {
    const turns = sessionTurns.get(turn.session_id);
    if (turns) turns.push(turn);
    else sessionTurns.set(turn.session_id, [turn]);
  }
  for (const session of sessions) {
    const audit = latestEvent(ctx, session.id, 'session.write_detected');
    const outsideWorktree =
      audit &&
      (JSON.parse(audit.payload) as { reason?: string }).reason ===
        'outside_worktree_write_detected';
    if (audit)
      items.push({
        source: { table: 'sessions', id: session.id, revision: session.revision },
        kind: 'session.failed',
        project_id: session.project_id,
        status: session.state,
        created_at: audit.created_at,
        reason: outsideWorktree ? 'outside_worktree_write_detected' : 'non_writer_write_detected',
        decision: 'other',
        actions: [],
        next_step: outsideWorktree
          ? 'This session wrote outside its worktree. Review the listed paths, then restore unintended changes.'
          : 'This read-only session changed tracked files, or called a write tool. Review its changes and tool calls, then restore unintended changes.',
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
        ? (ownEntry(planOf.get(session.task?.lead_session_id ?? session.id)?.alerted, running.id) ??
          [])
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
          decision: 'other',
          primary: 'session.background.stop',
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
        decision: 'other',
        primary: 'session.interrupt',
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
        decision: 'other',
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
        decision: 'other',
        ...(kind === 'lead_turn_failed' || kind === 'continuation_limit_reached'
          ? { primary: 'session.send' }
          : {}),
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
              ...(session.workspace_id &&
              !session.baseline &&
              (workspace?.kind !== 'in_place' || session.in_place)
                ? [{ command: 'session.discard', allowed: true }]
                : []),
            ]),
      );
    else if (
      kind === 'session.merge_blocked' &&
      (workspace?.kind !== 'in_place' || session.in_place)
    ) {
      let disabledReason: string | undefined;
      try {
        projectAccess(ctx, principal, session.project_id, 'session.merge');
        requireMergeReady(ctx, session, true);
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
      decision:
        kind === 'session.gate_failed' &&
        (ownEntry(taskPlan?.handed_back, session.id)?.length ?? 0) >= 2
          ? 'repeated_failure'
          : 'other',
      ...(actions[0] ? { primary: actions[0].command } : {}),
      actions,
      ...(failureClass ? { failure_class: failureClass } : {}),
    });
  }
  return items;
}
