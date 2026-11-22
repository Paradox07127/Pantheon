import { t } from '../i18n';
import type { NeedActionKey } from './need-actions';
import type { NeedsYouItem } from './needs-you';

/** The short name of what the user decides; none for the kinds the item's reason names better. */
export function decisionText(decision: NeedsYouItem['decision']): string | null {
  switch (decision) {
    case 'question':
      return t({ id: 'data.attention.decision.question', defaultMessage: 'Question' });
    case 'permission':
      return t({ id: 'data.attention.decision.permission', defaultMessage: 'Permission' });
    case 'budget':
      return t({ id: 'data.attention.decision.budget', defaultMessage: 'Budget' });
    default:
      return null;
  }
}

// The buttons that send each command the daemon names as an item's primary.
const PRIMARY_KEYS: Readonly<Record<string, readonly NeedActionKey[]>> = {
  'approval.respond': ['approve', 'reply', 'answer'],
  'session.merge': ['merge'],
  'session.gates.run': ['gates'],
  'session.send': ['continue'],
  'session.background.stop': ['stop_background'],
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
