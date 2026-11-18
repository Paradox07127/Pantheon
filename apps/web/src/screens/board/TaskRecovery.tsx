import type { ComponentType, CSSProperties } from 'react';
import { Crown, RefreshCw, Route, User, type LucideProps } from 'lucide-react';
import type { BoardModel, BoardTaskRung } from '@pantheon/protocol';
import { runtimeName } from '../../components/RuntimeGlyph';
import { t } from '../../i18n';
import './recovery.css';

type Budget = NonNullable<BoardModel['tasks'][number]['budget']>;

/** The share of its budget a task used; past 100% a short bar after the full track. */
export function BudgetShare({ budget }: { budget: Budget }) {
  const percent = Math.round(budget.ratio * 100);
  const over = percent > 100;
  return (
    <span
      className="bd-bu"
      role="img"
      data-over={over || undefined}
      aria-label={
        over
          ? t(
              {
                id: 'board.recovery.budget.overLabel',
                defaultMessage: '{percent}% of the budget used, over the budget',
              },
              { percent },
            )
          : t(
              {
                id: 'board.recovery.budget.label',
                defaultMessage: '{percent}% of the budget used',
              },
              { percent },
            )
      }
    >
      <span className="bd-bu-b">
        <span className="bd-bu-t">
          <i style={{ '--v': `${Math.min(100, percent)}%` } as CSSProperties} />
        </span>
        {/* The 40px track is 100%; the part over it gets 2px to 6px. */}
        {over && (
          <i
            className="bd-bu-x"
            style={{ width: Math.max(2, Math.min(6, Math.round((budget.ratio - 1) * 40))) }}
          />
        )}
      </span>
      <span className="bd-bu-n">{percent}%</span>
    </span>
  );
}

const RUNG_ICON: Record<BoardTaskRung['rung'], ComponentType<LucideProps>> = {
  retry: RefreshCw,
  switch: Route,
  lead: Crown,
  user: User,
};

function rungText(rung: BoardTaskRung): string {
  switch (rung.rung) {
    case 'retry':
      if (rung.held === 'usage_limit')
        return t({
          id: 'board.recovery.rung.heldUsage',
          defaultMessage: 'Waits for runtime quota',
        });
      if (rung.held === 'project_budget')
        return t({
          id: 'board.recovery.rung.heldBudget',
          defaultMessage: 'Waits for the project budget',
        });
      return rung.used !== undefined && rung.limit !== undefined
        ? t(
            {
              id: 'board.recovery.rung.retryCount',
              defaultMessage: 'Pantheon retries {used} / {limit}',
            },
            { used: rung.used, limit: rung.limit },
          )
        : t({ id: 'board.recovery.rung.retry', defaultMessage: 'Pantheon retries' });
    case 'switch':
      return t(
        { id: 'board.recovery.rung.switch', defaultMessage: 'Moved to {runtime}' },
        { runtime: runtimeName(rung.switches.at(-1)?.to ?? null) },
      );
    case 'lead':
      return t({ id: 'board.recovery.rung.lead', defaultMessage: 'Lead has it' });
    case 'user':
      return t({ id: 'board.recovery.rung.user', defaultMessage: 'Waits for you' });
  }
}

/** Who acts next on the task, by an icon of its own and its words. */
export function RungLabel({ rung }: { rung: BoardTaskRung }) {
  const Icon = RUNG_ICON[rung.rung];
  return (
    <span className="bd-rg" data-rung={rung.rung}>
      <Icon aria-hidden="true" />
      {rungText(rung)}
    </span>
  );
}

const REASON = new Map<string, () => string>([
  [
    'rebase_conflict',
    () => t({ id: 'board.recovery.reason.rebase_conflict', defaultMessage: 'Rebase conflict' }),
  ],
  [
    'gate_failed',
    () => t({ id: 'board.recovery.reason.gate_failed', defaultMessage: 'Checks failed' }),
  ],
  [
    'uncommitted_changes',
    () =>
      t({ id: 'board.recovery.reason.uncommitted_changes', defaultMessage: 'Uncommitted changes' }),
  ],
  [
    'no_changes',
    () => t({ id: 'board.recovery.reason.no_changes', defaultMessage: 'No changes to merge' }),
  ],
  [
    'out_of_scope',
    () =>
      t({ id: 'board.recovery.reason.out_of_scope', defaultMessage: 'Changes outside the scope' }),
  ],
  [
    'protected_paths',
    () =>
      t({ id: 'board.recovery.reason.protected_paths', defaultMessage: 'Touches protected paths' }),
  ],
  [
    'merge_commits',
    () => t({ id: 'board.recovery.reason.merge_commits', defaultMessage: 'Has merge commits' }),
  ],
  [
    'head_moved',
    () =>
      t({ id: 'board.recovery.reason.head_moved', defaultMessage: 'New commits after the report' }),
  ],
  [
    'verification_changed',
    () =>
      t({
        id: 'board.recovery.reason.verification_changed',
        defaultMessage: 'Verification changed',
      }),
  ],
  [
    'review_findings',
    () => t({ id: 'board.recovery.reason.review_findings', defaultMessage: 'Review findings' }),
  ],
  [
    'dispatch_failed',
    () =>
      t({ id: 'board.recovery.reason.dispatch_failed', defaultMessage: 'Session did not open' }),
  ],
  [
    'project_over_budget',
    () =>
      t({ id: 'board.recovery.reason.project_over_budget', defaultMessage: 'Project over budget' }),
  ],
  [
    'task_turn_looping',
    () =>
      t({ id: 'board.recovery.reason.task_turn_looping', defaultMessage: 'Turn keeps looping' }),
  ],
  [
    'task_turn_stalled',
    () => t({ id: 'board.recovery.reason.task_turn_stalled', defaultMessage: 'Turn stalled' }),
  ],
  [
    'permission',
    () => t({ id: 'board.recovery.reason.permission', defaultMessage: 'Asks for permission' }),
  ],
  [
    'usage_limit_waiting',
    () =>
      t({ id: 'board.recovery.reason.usage_limit_waiting', defaultMessage: 'Usage limit reached' }),
  ],
  [
    'continuation_limit_reached',
    () =>
      t({
        id: 'board.recovery.reason.continuation_limit_reached',
        defaultMessage: 'Continuation limit reached',
      }),
  ],
  [
    'workflow_approval',
    () =>
      t({
        id: 'board.recovery.reason.workflow_approval',
        defaultMessage: 'Step awaits your decision',
      }),
  ],
  ['blocked', () => t({ id: 'board.recovery.reason.blocked', defaultMessage: 'Blocked' })],
  [
    'requirement',
    () => t({ id: 'board.recovery.reason.requirement', defaultMessage: 'Reported a requirement' }),
  ],
  ['failed', () => t({ id: 'board.recovery.reason.failed', defaultMessage: 'Session failed' })],
  [
    'turn_failed',
    () => t({ id: 'board.recovery.reason.turn_failed', defaultMessage: 'Turn failed' }),
  ],
  ['stalled', () => t({ id: 'board.recovery.reason.stalled', defaultMessage: 'Stalled' })],
  ['looping', () => t({ id: 'board.recovery.reason.looping', defaultMessage: 'Looping' })],
  [
    'runtime_changed',
    () => t({ id: 'board.recovery.reason.runtime_changed', defaultMessage: 'Runtime changed' }),
  ],
]);

/** The words for a rung's reason; null for a reason not known here. */
export const rungReason = (reason: string): string | null => REASON.get(reason)?.() ?? null;
