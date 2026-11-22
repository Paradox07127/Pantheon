import {
  DomainError,
  type LandingItem,
  type NeedsYouItem,
  type Session,
  type SessionTurn,
  type Workspace,
} from '@pantheon/domain';
import { projectAccess, type ControlContext } from './context.js';
import { listedOutcomes, requireMergeReady } from './workbench-session.js';
import { sessionStall } from './session-stall.js';
import { BACKGROUND_LONG_MS, longBackground } from './progress.js';
import {
  NEXT_STEP,
  STOP_UNCONFIRMED_MS,
  action,
  latestEvent,
  latestExecuted,
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
      listedOutcomes(ctx, principal, id, 'needs_you.list').map(
        (session) => [session.id, session] as const,
      ),
    ),
  );
  const sessionTurns = new Map<string, SessionTurn[]>();
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
    const row = listed.get(session.id);
    const mergeStarted = stuckMerge(ctx, session)
      ? latestEvent(ctx, session.id, 'session.merge_started')
      : undefined;
    const workspace = session.workspace_id
      ? ctx.store.get<Workspace>('workspaces', session.workspace_id)
      : undefined;
    const stop = session.stop_requested,
      stopUnconfirmed =
        stop &&
        (ctx.store.now() - stop.at >= STOP_UNCONFIRMED_MS ||
          (latestEvent(ctx, session.id, 'session.discard_failed')?.created_at ?? -1) >= stop.at);
    const running = sessionTurns.get(session.id)?.findLast((turn) => turn.state === 'running');
    const executedLast =
        session.state === 'open'
          ? latestExecuted(ctx, sessionTurns.get(session.id) ?? [])
          : undefined,
      limitEnd =
        executedLast?.state === 'failed'
          ? (
              ctx.store
                .statement(
                  "SELECT payload FROM events WHERE aggregate_id=? AND kind='agent.turn.completed' AND json_extract(payload,'$.turn_id')=? ORDER BY sequence DESC LIMIT 1",
                )
                .get(session.id, executedLast.id) as { payload: string } | undefined
            )?.payload
          : undefined,
      limitHit = limitEnd
        ? (JSON.parse(limitEnd) as { error_code?: string; resets_at?: number })
        : undefined,
      stallAt = sessionStall(ctx, session, running);
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
                : row?.gate?.state === 'failed'
                  ? 'session.gate_failed'
                  : row?.merge?.state === 'blocked' && row.merge.reason !== 'cancelled'
                    ? 'session.merge_blocked'
                    : limitHit?.error_code === 'usage_limit'
                      ? 'usage_limit_reached'
                      : stallAt !== undefined
                        ? 'session_turn_stalled'
                        : undefined;
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
    if (kind === 'usage_limit_reached') {
      items.push({
        source: { table: 'sessions', id: session.id, revision: session.revision },
        kind: 'session.failed',
        project_id: session.project_id,
        status: session.state,
        created_at: latestEvent(ctx, executedLast!.id, 'turn.failed')?.created_at ?? 0,
        reason: kind,
        decision: 'other',
        primary: 'session.send',
        actions: [
          action('session.send', () =>
            projectAccess(ctx, principal, session.project_id, 'session.send'),
          ),
        ],
        ...(limitHit!.resets_at === undefined ? {} : { resets_at: limitHit!.resets_at }),
        next_step: NEXT_STEP[kind],
      });
      continue;
    }
    if (kind === 'session_turn_stalled') {
      items.push({
        source: { table: 'sessions', id: session.id, revision: session.revision },
        kind: 'session.failed',
        project_id: session.project_id,
        status: session.state,
        created_at: stallAt!,
        reason: kind,
        decision: 'other',
        actions: [],
        next_step: NEXT_STEP[kind],
      });
      continue;
    }
    if (kind === 'merge_stuck' || kind === 'workspace_reconciling' || kind === 'stop_unconfirmed') {
      items.push({
        source: { table: 'sessions', id: session.id, revision: session.revision },
        kind: 'session.failed',
        project_id: session.project_id,
        status: session.state,
        created_at:
          kind === 'merge_stuck'
            ? mergeStarted!.created_at
            : kind === 'workspace_reconciling'
              ? (latestEvent(ctx, workspace!.id, 'workspace.provisioning')?.created_at ?? 0)
              : stop!.at,
        reason: kind,
        decision: 'other',
        // session.resolve answers a reconciling session, not its worktree.
        actions: [],
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
          ? [
              action('session.resolve', () =>
                projectAccess(ctx, principal, session.project_id, 'session.resolve'),
              ),
            ]
          : [
              {
                command: 'session.resolve',
                allowed: false,
                disabled_reason: 'termination_unconfirmed',
              },
              ...(session.workspace_id &&
              !session.baseline &&
              (workspace?.kind !== 'in_place' || session.in_place)
                ? [
                    action('session.discard', () =>
                      projectAccess(ctx, principal, session.project_id, 'session.discard'),
                    ),
                  ]
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
      decision: 'other',
      ...(actions[0] ? { primary: actions[0].command } : {}),
      actions,
      ...(failureClass ? { failure_class: failureClass } : {}),
    });
  }
  return items;
}
