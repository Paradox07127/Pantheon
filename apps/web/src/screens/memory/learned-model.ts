import { runtimeName } from '../../components/RuntimeGlyph';
import { ageText } from '../../data/needs-you';
import {
  changeText,
  DOMAIN_LABEL,
  scopeText,
  tierText,
  type Improvement,
  type ImprovementListItem,
} from '../../data/workflow-policy';
import { t } from '../../i18n';
import { dayText } from '../../lib/time-text';

/** A run of rule text; a code run was backticked in the procedure. */
export interface RulePart {
  text: string;
  code: boolean;
}

export type ScopePart =
  { kind: 'text' | 'tier'; text: string } | { kind: 'runtime'; runtime: string; text: string };

/** The rule an improvement states, with the backticked commands of an experience cut out. */
export function ruleParts(change: Improvement['change']): RulePart[] {
  if (change.type !== 'experience') return [{ text: changeText(change), code: false }];
  const pieces = change.procedure.split('`');
  // A last backtick without its pair opens nothing, so it and what follows stay text.
  if (pieces.length % 2 === 0) {
    const rest = pieces.pop()!;
    pieces[pieces.length - 1] += `\`${rest}`;
  }
  return pieces.flatMap((text, i) => (text ? [{ text, code: i % 2 === 1 }] : []));
}

/** Which tasks an improvement applies to, one part per narrowing. */
export function scopeParts(change: Improvement['change']): ScopePart[] {
  if (change.type === 'policy_change' && change.tier)
    return [{ kind: 'tier', text: tierText(change.tier) }];
  if (change.type !== 'experience' || (!change.domain && !change.tier && !change.runtime))
    return [{ kind: 'text', text: scopeText(change) }];
  const parts: ScopePart[] = [];
  if (change.domain) parts.push({ kind: 'text', text: DOMAIN_LABEL[change.domain] });
  if (change.tier) parts.push({ kind: 'tier', text: tierText(change.tier) });
  if (change.runtime)
    parts.push({ kind: 'runtime', runtime: change.runtime, text: runtimeName(change.runtime) });
  return parts;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const startOfDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);
// Rounded, so a day that a clock change shortens still counts as one.
const daysBetween = (from: number, to: number) =>
  Math.round((startOfDay(to) - startOfDay(from)) / (24 * HOUR));

function proposedText(at: number, now: number): string {
  const days = daysBetween(at, now);
  if (now - at < HOUR || days === 0) return ageText(at, now);
  return dayText(at, now);
}

// The reasons the daemon gives when it ends a trial; a user's revert gives none.
const REVERT_REASON = new Map<string, () => string>([
  ['not_better', () => t({ id: 'memory.learned.revert.notBetter', defaultMessage: 'no better' })],
  [
    'insufficient_sample',
    () => t({ id: 'memory.learned.revert.insufficientSample', defaultMessage: 'too few tasks' }),
  ],
]);

// The reasons the screening gives when it refuses an experience; a user's rejection gives none.
const REJECT_REASON = new Map<string, () => string>([
  [
    'network_access',
    () => t({ id: 'memory.learned.reject.networkAccess', defaultMessage: 'reaches the network' }),
  ],
  [
    'credentials',
    () => t({ id: 'memory.learned.reject.credentials', defaultMessage: 'touches credentials' }),
  ],
  [
    'destructive_command',
    () =>
      t({ id: 'memory.learned.reject.destructiveCommand', defaultMessage: 'destructive command' }),
  ],
  [
    'guardrail_relaxation',
    () =>
      t({ id: 'memory.learned.reject.guardrailRelaxation', defaultMessage: 'loosens a guardrail' }),
  ],
  [
    'duplicate_instruction',
    () => t({ id: 'memory.learned.reject.duplicateInstruction', defaultMessage: 'duplicate rule' }),
  ],
  [
    'invalid_reference',
    () =>
      t({ id: 'memory.learned.reject.invalidReference', defaultMessage: 'reference not found' }),
  ],
]);

// The reasons a user picks when rejecting a candidate.
const USER_REJECT_REASON = new Map<string, () => string>([
  ['duplicate', REJECT_REASON.get('duplicate_instruction')!],
  ['not_useful', () => t({ id: 'memory.learned.reject.notUseful', defaultMessage: 'not useful' })],
]);

const reasonOf = (table: Map<string, () => string>, reason: string | undefined) =>
  (reason && table.get(reason)?.()) || null;

const rejectedFor = (reason: string) =>
  t({ id: 'memory.learned.rejectedFor', defaultMessage: 'Rejected: {reason}' }, { reason });

/** "Rejected: why" when the user gave a reason for the rejection; null otherwise. */
export function userRejectText(item: Improvement): string | null {
  const reason = reasonOf(USER_REJECT_REASON, item.reject_reason);
  return reason && rejectedFor(reason);
}

/** The status column of a row: when it was proposed, how far its trial is, or why it ended. */
export function statusText(item: Omit<ImprovementListItem, 'grade'>, now: number): string {
  switch (item.status) {
    case 'candidate':
      return proposedText(item.proposed_at, now);
    case 'trial':
      if ((item.trial ? item.trial.status_reason : item.status_reason) === 'no_baseline')
        return t({ id: 'memory.learned.noBaseline', defaultMessage: 'No baseline' });
      return t(
        { id: 'memory.learned.trialDay', defaultMessage: 'Day {count}' },
        { count: daysBetween(item.trial_started_at ?? item.proposed_at, now) + 1 },
      );
    case 'active': {
      const date = dayText(item.decided_at ?? item.trial_started_at ?? item.proposed_at, now);
      return item.status_reason === 'trial_passed' && item.trial
        ? t(
            {
              id: 'memory.learned.sinceComparison',
              defaultMessage: 'Since {date} · before/after, n = {count}',
            },
            { date, count: item.trial.tasks_seen },
          )
        : t({ id: 'memory.learned.since', defaultMessage: 'Since {date}' }, { date });
    }
    case 'reverted': {
      const reason = reasonOf(REVERT_REASON, item.status_reason);
      return reason
        ? t({ id: 'memory.learned.revertedFor', defaultMessage: 'Reverted: {reason}' }, { reason })
        : t({ id: 'memory.learned.reverted', defaultMessage: 'Reverted' });
    }
    case 'rejected': {
      const reason = reasonOf(REJECT_REASON, item.status_reason);
      if (reason) return rejectedFor(reason);
      return (
        userRejectText(item) ?? t({ id: 'memory.learned.rejected', defaultMessage: 'Rejected' })
      );
    }
  }
}
