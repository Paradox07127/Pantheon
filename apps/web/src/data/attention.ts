import { t } from '../i18n';
import type { NeedActionKey } from '../screens/board/frame-model';
import type { NeedsYouItem } from './needs-you';

/** The short name of what the user decides; none for the kinds the item's reason names better. */
export function decisionText(decision: NeedsYouItem['decision']): string | null {
  switch (decision) {
    case 'plan_change':
      return t({ id: 'data.attention.decision.planChange', defaultMessage: 'Plan change' });
    case 'question':
      return t({ id: 'data.attention.decision.question', defaultMessage: 'Question' });
    case 'milestone_accept':
      return t({
        id: 'data.attention.decision.milestoneAccept',
        defaultMessage: 'Milestone to accept',
      });
    case 'repeated_failure':
      return t({ id: 'data.attention.decision.repeatedFailure', defaultMessage: 'Failed twice' });
    case 'permission':
      return t({ id: 'data.attention.decision.permission', defaultMessage: 'Permission' });
    case 'budget':
      return t({ id: 'data.attention.decision.budget', defaultMessage: 'Budget' });
    case 'improvement':
      return t({ id: 'data.attention.decision.improvement', defaultMessage: 'Improvement' });
    case 'external':
      return t({ id: 'data.attention.decision.external', defaultMessage: 'External request' });
    default:
      return null;
  }
}

/** How many tasks wait on the item; none when no task does. */
export const blocksText = (count: number | undefined): string | null =>
  count
    ? t(
        {
          id: 'data.attention.blocks',
          defaultMessage: 'Blocks {count, plural, one {# task} other {# tasks}}',
        },
        { count },
      )
    : null;

// The buttons that send each command the daemon names as an item's primary.
const PRIMARY_KEYS: Readonly<Record<string, readonly NeedActionKey[]>> = {
  'approval.respond': ['approve', 'reply', 'answer'],
  'lead.question.answer': ['reply'],
  'milestone.accept': ['accept'],
  'session.merge': ['merge_out_of_scope', 'merge'],
  'session.gates.run': ['gates'],
  'session.send': ['continue'],
  'session.background.stop': ['stop_background'],
  'board.sync': ['sync'],
  'board.plan.proposal.resolve': ['approve'],
  'external.approve': ['approve'],
  'workflow.policy.set': ['budget'],
};

/** The item's one primary action: the one sending its primary command, else its first. */
export function primaryAction<A extends { key: NeedActionKey }>(
  actions: readonly A[],
  primary: string | undefined,
): A | undefined {
  const keys = primary === undefined ? undefined : PRIMARY_KEYS[primary];
  return actions.find((action) => keys?.includes(action.key)) ?? actions[0];
}

/** The item to go to once `acted` is settled: the one after it, else the one before, else none. */
export function nextKey(keys: readonly string[], acted: string): string | null {
  const at = keys.indexOf(acted);
  const rest = keys.filter((key) => key !== acted);
  if (at < 0) return rest[0] ?? null;
  return rest[at] ?? rest[at - 1] ?? null;
}
