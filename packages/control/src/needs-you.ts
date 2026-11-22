import {
  DomainError,
  requireThat,
  type Approval,
  type NeedsYouItem,
  type Principal,
  type Project,
  type Session,
  type SessionTurn,
} from '@pantheon/domain';
import type { ControlContext } from './context.js';
import { pendingApprovalItems, settledApprovalItems } from './needs-you-approvals.js';
import { sessionItems } from './needs-you-sessions.js';
import { settingProposalItems } from './needs-you-settings.js';
import { projectBudgetItems } from './needs-you-workflow.js';

/** A running merge with no progress event for this long is stuck; each gate command has a timeout. */
const MERGE_STUCK_MS = 30 * 60_000;
const MERGE_PROGRESS = ['session.merge_started', 'session.gate_started', 'session.gate_checked'];

/** A stop whose process has not confirmed it stopped for this long needs the user. */
export const STOP_UNCONFIRMED_MS = 2 * 60_000;

/** Session items listed under the session.failed kind, told apart by their reason. */
export type SessionAttention =
  | 'merge_stuck'
  | 'workspace_reconciling'
  | 'stop_unconfirmed'
  | 'usage_limit_reached'
  | 'session_turn_stalled'
  | 'background_task_long';

export const NEXT_STEP: Record<SessionAttention, string> = {
  merge_stuck: 'The user checks the stuck merge and cancels it if needed.',
  stop_unconfirmed:
    "The session's process has not confirmed it stopped; the user confirms the process stopped, or retries the stop.",
  workspace_reconciling:
    'A daemon restart interrupted the workspace setup, so whether its Git processes stopped is unknown; the user reconciles: once no Git process is still running in the workspace, discard this session.',
  usage_limit_reached:
    'Continue the session after the limit resets, or fork it to another runtime.',
  session_turn_stalled: 'Open the session to see where it stopped.',
  background_task_long:
    'A background command or agent of the session has run for 30 minutes; the user stops it, or waits for it to end.',
};

/** The aggregate's latest event of kind. */
export function latestEvent(
  ctx: ControlContext,
  aggregateId: string,
  kind: string,
): { sequence: number; created_at: number; payload: string } | undefined {
  return ctx.store
    .statement(
      'SELECT sequence, created_at, payload FROM events WHERE aggregate_id=? AND kind=? ORDER BY sequence DESC LIMIT 1',
    )
    .get(aggregateId, kind) as
    { sequence: number; created_at: number; payload: string } | undefined;
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

/** The command as an action, disabled with the code of the error its check throws. */
export function action(command: string, check: () => void): NeedsYouItem['actions'][number] {
  try {
    check();
    return { command, allowed: true };
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return { command, allowed: false, disabled_reason: error.code };
  }
}

/** A lost request stays open until its session starts a turn after the one that raised it. */
export function lostRequestOpen(ctx: ControlContext, approval: Approval): boolean {
  const session = ctx.store.get<Session>('sessions', approval.session_id ?? '');
  if (!approval.turn_id || !session || session.archived_at || session.outcome) return false;
  const turns = ctx.store
    .list<SessionTurn>('session_turns')
    .filter((turn) => turn.session_id === session.id);
  return !turns
    .slice(turns.findIndex((turn) => turn.id === approval.turn_id) + 1)
    .some((turn) => turn.state !== 'queued' && turn.state !== 'cancelled' && executed(ctx, turn));
}

/** What every builder reads: who asks, and which projects are listed. */
export interface NeedsYouScope {
  principal: Principal;
  projectId: string | undefined;
  removed: Set<string>;
  listedProject: (id: string) => boolean;
}

/** An item as a builder makes it. */
export type NeedsYouDraft = NeedsYouItem;

export function needsYou(
  ctx: ControlContext,
  principal: Principal,
  projectId?: string,
): { items: NeedsYouItem[] } {
  requireThat(
    (principal.role === 'user' || principal.role === 'planner' || principal.role === 'personal') &&
      (!principal.expires_at || principal.expires_at > ctx.store.now()),
    'permission_denied',
    'User, planner or personal principal required',
  );
  if (principal.role === 'planner') {
    projectId ??= principal.project_id;
    requireThat(
      projectId && projectId === principal.project_id,
      'permission_denied',
      'Project principal required',
    );
  }
  const items: NeedsYouDraft[] = [];
  const removed = new Set(
    ctx.store
      .list<Project>('projects')
      .filter((project) => project.removed_at !== undefined)
      .map((project) => project.id),
  );
  const listedProject = (id: string) => !removed.has(id) && (!projectId || id === projectId);
  const scope: NeedsYouScope = { principal, projectId, removed, listedProject };
  items.push(...pendingApprovalItems(ctx, scope));
  if (principal.role === 'user' || principal.role === 'personal') {
    items.push(...settledApprovalItems(ctx, scope));
    const sessions = ctx.store
      .list<Session>('sessions')
      .filter(
        (s) =>
          !s.archived_at &&
          !s.outcome &&
          !removed.has(s.project_id) &&
          (!projectId || s.project_id === projectId),
      );
    items.push(
      ...sessionItems(ctx, scope, sessions),
      ...projectBudgetItems(ctx, scope),
      ...settingProposalItems(ctx, scope),
    );
  }
  // Tool input can hold secrets, and a rule or a background command can be a whole command line.
  const shown =
    principal.role === 'personal'
      ? items.map(({ binding, background, ...item }) => {
          if (item.setting?.command === 'project.gate.set') {
            const { before: _before, after: _after, ...setting } = item.setting;
            return { ...item, setting };
          }
          if (!binding) return item;
          const { input_summary, rule, ...kept } = binding;
          return { ...item, binding: kept };
        })
      : items;
  // The longest waiting first.
  return {
    items: shown.sort(
      (a, b) => a.created_at - b.created_at || a.source.id.localeCompare(b.source.id),
    ),
  };
}
