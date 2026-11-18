import type { ComponentType } from 'react';
import { Check, Eye, File, ShieldCheck, User, type LucideProps } from 'lucide-react';
import type { BoardMilestoneExtras, BoardTaskExtras } from '@pantheon/protocol';
import { t } from '../../i18n';
import './evidence.css';

type Level = NonNullable<BoardMilestoneExtras['evidence_level']>;
type Reviewer = NonNullable<BoardTaskExtras['evidence_reviewer']> | 'any';

const MARK: Record<
  Exclude<Level, 'reviewed'>,
  { Icon: ComponentType<LucideProps>; text: () => string; label: () => string }
> = {
  report: {
    Icon: File,
    text: () => t({ id: 'board.evidence.report', defaultMessage: 'Report only' }),
    label: () => t({ id: 'board.evidence.report.label', defaultMessage: 'Evidence: report only' }),
  },
  gate: {
    Icon: ShieldCheck,
    text: () => t({ id: 'board.evidence.gate', defaultMessage: 'Gate passed' }),
    label: () => t({ id: 'board.evidence.gate.label', defaultMessage: 'Evidence: gate passed' }),
  },
  verified: {
    Icon: Check,
    text: () => t({ id: 'board.evidence.verified', defaultMessage: 'Verified' }),
    label: () => t({ id: 'board.evidence.verified.label', defaultMessage: 'Evidence: verified' }),
  },
  accepted: {
    Icon: User,
    text: () => t({ id: 'board.evidence.accepted', defaultMessage: 'Accepted' }),
    label: () =>
      t({ id: 'board.evidence.accepted.label', defaultMessage: 'Evidence: accepted by you' }),
  },
};

const REVIEWED: Record<Reviewer, { text: () => string; label: () => string }> = {
  other_vendor: {
    text: () =>
      t({ id: 'board.evidence.reviewed.otherVendor', defaultMessage: 'Reviewed other vendor' }),
    label: () =>
      t({
        id: 'board.evidence.reviewed.otherVendor.label',
        defaultMessage: 'Evidence: reviewed by another vendor',
      }),
  },
  other_runtime: {
    text: () =>
      t({ id: 'board.evidence.reviewed.otherRuntime', defaultMessage: 'Reviewed other runtime' }),
    label: () =>
      t({
        id: 'board.evidence.reviewed.otherRuntime.label',
        defaultMessage: 'Evidence: reviewed on another runtime of the same vendor',
      }),
  },
  any: {
    text: () => t({ id: 'board.evidence.reviewed', defaultMessage: 'Reviewed' }),
    label: () => t({ id: 'board.evidence.reviewed.label', defaultMessage: 'Evidence: reviewed' }),
  },
};

/** What backs a merged task or a done milestone; nothing while it has no level. */
export function EvidenceMark({
  level,
  reviewer,
}: {
  level: Level | undefined;
  /** A milestone's review names no reviewer. */
  reviewer?: BoardTaskExtras['evidence_reviewer'];
}) {
  if (!level) return null;
  const { Icon, text, label } =
    level === 'reviewed' ? { Icon: Eye, ...REVIEWED[reviewer ?? 'any'] } : MARK[level];
  return (
    <span className="bd-evm" data-level={level} role="img" aria-label={label()}>
      <Icon aria-hidden="true" />
      {text()}
    </span>
  );
}
