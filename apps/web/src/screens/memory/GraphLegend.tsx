import {
  Diamond,
  File,
  FileText,
  Globe,
  Hash,
  MessageSquare,
  StickyNote,
  TriangleAlert,
} from 'lucide-react';
import type { MemoryGraph } from '@pantheon/domain';
import { t } from '../../i18n';
import './memory-graph-side.css';

type GraphNode = MemoryGraph['nodes'][number];

/** A node's kind as drawn: memories by kind, sources by what they point at. */
export type LegendKind = 'decision' | 'report' | 'note' | 'file' | 'url' | 'session' | 'tag';

const KINDS: LegendKind[] = ['decision', 'report', 'note', 'file', 'url', 'session', 'tag'];

export interface GraphLegendProps {
  kinds: readonly LegendKind[];
  /** Nodes in the focused neighbourhood; null when nothing is focused. */
  focused: number | null;
  shown: number;
  total: number;
  truncated: boolean;
}

export const nodeKind = (node: Pick<GraphNode, 'kind' | 'source_kind'>): LegendKind =>
  node.kind === 'source' ? (node.source_kind ?? 'file') : node.kind;

/** The kinds present among the nodes, in legend order. */
export function legendKinds(nodes: readonly GraphNode[]): LegendKind[] {
  const present = new Set(nodes.map(nodeKind));
  return KINDS.filter((kind) => present.has(kind));
}

const ICONS = {
  decision: Diamond,
  report: FileText,
  note: StickyNote,
  file: File,
  url: Globe,
  session: MessageSquare,
  tag: Hash,
};

export const kindText = (kind: LegendKind) =>
  ({
    decision: () => t({ id: 'memory.graphSide.kind.decision', defaultMessage: 'Decision' }),
    report: () => t({ id: 'memory.graphSide.kind.report', defaultMessage: 'Report' }),
    note: () => t({ id: 'memory.graphSide.kind.note', defaultMessage: 'Note' }),
    file: () => t({ id: 'memory.graphSide.kind.file', defaultMessage: 'File' }),
    url: () => t({ id: 'memory.graphSide.kind.url', defaultMessage: 'Web page' }),
    session: () => t({ id: 'memory.graphSide.kind.session', defaultMessage: 'Session' }),
    tag: () => t({ id: 'memory.graphSide.kind.tag', defaultMessage: 'Tag' }),
  })[kind]();

export function kindIcon(kind: LegendKind, label?: string) {
  const Icon = ICONS[kind];
  return label ? <Icon role="img" aria-label={label} /> : <Icon aria-hidden="true" />;
}

const LINKS = [
  {
    kind: 'depends_on',
    arrow: true,
    text: () => t({ id: 'memory.graphSide.link.dependsOn', defaultMessage: 'Rests on' }),
  },
  {
    kind: 'supersedes',
    arrow: true,
    text: () => t({ id: 'memory.graphSide.link.supersedes', defaultMessage: 'Replaces older' }),
  },
  {
    kind: 'restored_from',
    arrow: true,
    text: () => t({ id: 'memory.graphSide.link.restoredFrom', defaultMessage: 'Restored from' }),
  },
  {
    kind: 'source',
    arrow: false,
    text: () => t({ id: 'memory.graphSide.link.source', defaultMessage: 'Source' }),
  },
] as const;

function LinkSample({ kind, arrow, out }: { kind: string; arrow: boolean; out?: boolean }) {
  return (
    <svg className="mgs-ls" width="28" height="8" viewBox="0 0 28 8" aria-hidden="true">
      <path className="mgs-ed" data-kind={kind} data-out={out || undefined} d="M27 4 H1" />
      {arrow && <path className="mgs-ah" data-out={out || undefined} d="M8.5 .5 L1 4 L8.5 7.5z" />}
    </svg>
  );
}

export function GraphLegend({ kinds, focused, shown, total, truncated }: GraphLegendProps) {
  const present = new Set(kinds);
  return (
    <div
      className="pop mgs-legend"
      role="group"
      aria-label={t({ id: 'memory.graphSide.legend', defaultMessage: 'Legend' })}
    >
      {truncated && (
        <div className="mgs-cut" role="status">
          <TriangleAlert aria-hidden="true" />
          {t(
            {
              id: 'memory.graphSide.truncated',
              defaultMessage: 'Only {count} drawn; narrow the filters to see the rest',
            },
            { count: shown },
          )}
        </div>
      )}
      <div className="legend">
        <span className="cap">
          {t({ id: 'memory.graphSide.legend.kinds', defaultMessage: 'Kinds' })}
        </span>
        {KINDS.filter((kind) => present.has(kind)).map((kind) => (
          <span key={kind}>
            {kind === 'tag' ? <span className="mgs-tag">{kindIcon(kind)}</span> : kindIcon(kind)}
            {kindText(kind)}
          </span>
        ))}
      </div>
      <div className="legend">
        <span className="cap">
          {t({ id: 'memory.graphSide.legend.states', defaultMessage: 'States' })}
        </span>
        <span>
          <span className="mgs-n" aria-hidden="true" />
          {t({ id: 'memory.graphSide.state.active', defaultMessage: 'Current' })}
        </span>
        <span>
          <span className="mgs-n" data-state="draft" aria-hidden="true" />
          <span className="mgs-wait" aria-hidden="true" />
          {t({ id: 'memory.graphSide.state.draft', defaultMessage: 'Pending review' })}
        </span>
        <span>
          <span className="mgs-n" data-state="archived" aria-hidden="true" />
          {t({ id: 'memory.graphSide.state.archived', defaultMessage: 'Archived' })}
        </span>
      </div>
      <div className="legend">
        <span className="cap">
          {t({ id: 'memory.graphSide.legend.links', defaultMessage: 'Links' })}
        </span>
        {LINKS.map((link) => (
          <span key={link.kind}>
            <LinkSample kind={link.kind} arrow={link.arrow} />
            {link.text()}
          </span>
        ))}
        {focused !== null && (
          <span>
            <LinkSample kind="depends_on" arrow out />
            {t({
              id: 'memory.graphSide.link.outside',
              defaultMessage: 'Outside the neighbourhood',
            })}
          </span>
        )}
      </div>
      <div className="mgs-count">
        {focused !== null && (
          <span>
            {t(
              { id: 'memory.graphSide.count.focused', defaultMessage: 'Focused {count}' },
              { count: focused },
            )}
          </span>
        )}
        <span>
          {t(
            { id: 'memory.graphSide.count.shown', defaultMessage: 'Showing {shown} of {total}' },
            { shown, total },
          )}
        </span>
      </div>
    </div>
  );
}
