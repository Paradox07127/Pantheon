import type { ComponentType } from 'react';
import { Eye, File, ShieldCheck, User, type LucideProps } from 'lucide-react';
import type { PlanItemView } from '@pantheon/protocol';
import { Clip } from '../../components/Clip';
import { t } from '../../i18n';

type Evidence = NonNullable<PlanItemView['evidence']>;

const ICON: Record<Evidence['level'], ComponentType<LucideProps>> = {
  report: File,
  gate: ShieldCheck,
  reviewed: Eye,
  accepted: User,
};

export function evidenceText({ level, reviewer }: Evidence): string {
  if (level === 'report')
    return t({ id: 'project.evidence.report', defaultMessage: 'Report only' });
  if (level === 'gate') return t({ id: 'project.evidence.gate', defaultMessage: 'Gate passed' });
  if (level === 'accepted')
    return t({ id: 'project.evidence.accepted', defaultMessage: 'Accepted by you' });
  if (reviewer === 'other_vendor')
    return t({
      id: 'project.evidence.reviewedOtherVendor',
      defaultMessage: 'Reviewed by another vendor',
    });
  if (reviewer === 'other_runtime')
    return t({
      id: 'project.evidence.reviewedOtherRuntime',
      defaultMessage: 'Reviewed on another runtime',
    });
  return t({ id: 'project.evidence.reviewed', defaultMessage: 'Reviewed' });
}

/** What backs a plan item, report only being the weakest; a dash while nothing does. */
export function EvidenceMark({ evidence }: { evidence: PlanItemView['evidence'] }) {
  if (!evidence) return <span className="pj-dash">—</span>;
  const Icon = ICON[evidence.level];
  const words = evidenceText(evidence);
  return (
    <span
      className="pj-ev"
      data-level={evidence.level}
      role="img"
      aria-label={t(
        { id: 'project.evidence.label', defaultMessage: 'Evidence: {evidence}' },
        { evidence: words },
      )}
    >
      <Icon aria-hidden="true" />
      <Clip text={words} />
    </span>
  );
}
