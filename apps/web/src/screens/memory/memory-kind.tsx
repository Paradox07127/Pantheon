import { Diamond, FileText, StickyNote } from 'lucide-react';
import type { MemoryRecord } from '@pantheon/domain';
import { t } from '../../i18n';

type MemoryKind = MemoryRecord['kind'];

const ICONS = {
  decision: Diamond,
  report: FileText,
  note: StickyNote,
};

export const kindText = (kind: MemoryKind) =>
  ({
    decision: () => t({ id: 'memory.kind.decision', defaultMessage: 'Decision' }),
    report: () => t({ id: 'memory.kind.report', defaultMessage: 'Report' }),
    note: () => t({ id: 'memory.kind.note', defaultMessage: 'Note' }),
  })[kind]();

export function kindIcon(kind: MemoryKind, label?: string) {
  const Icon = ICONS[kind];
  return label ? <Icon role="img" aria-label={label} /> : <Icon aria-hidden="true" />;
}
