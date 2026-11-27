import type { SignalIssue } from '../../data/signals';
import { t } from '../../i18n';

/** Resolved issues listed under the unresolved ones. */
export const SHOWN_RESOLVED = 5;

const RANK: Record<SignalIssue['state'], number> = { escalated: 0, open: 1, resolved: 2 };

/** Escalated, then open, then the latest resolved; each newest first. */
export function orderSignals(
  issues: readonly SignalIssue[],
  shownResolved = SHOWN_RESOLVED,
): SignalIssue[] {
  const ordered = [...issues].sort(
    (a, b) => RANK[a.state] - RANK[b.state] || b.last_seen - a.last_seen,
  );
  const resolved = ordered.findIndex((issue) => issue.state === 'resolved');
  return resolved < 0 ? ordered : ordered.slice(0, resolved + shownResolved);
}

export function signalStateText(state: SignalIssue['state']): string {
  if (state === 'escalated')
    return t({ id: 'project.signals.escalated', defaultMessage: 'Escalated' });
  if (state === 'open') return t({ id: 'project.signals.open', defaultMessage: 'Open' });
  return t({ id: 'project.signals.resolved', defaultMessage: 'Resolved' });
}

export function signalSourceText(source: SignalIssue['source']): string {
  if (source === 'gate_repeat')
    return t({ id: 'project.signals.gateRepeat', defaultMessage: 'Repeated failure' });
  if (source === 'gate_flaky')
    return t({ id: 'project.signals.gateFlaky', defaultMessage: 'Flaky' });
  return t({ id: 'project.signals.daemonError', defaultMessage: 'Pantheon error' });
}

export function signalCountText(count: number): string {
  return t(
    {
      id: 'project.signals.count',
      defaultMessage: '{count, plural, one {# time} other {# times}}',
    },
    { count },
  );
}
