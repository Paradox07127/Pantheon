import type { ReactNode } from 'react';
import { RefreshCw, X } from 'lucide-react';
import type { MemoryGraph, MemoryRecord } from '@pantheon/domain';
import { Skeleton } from '../../components/Skeleton';
import { useMemoryQuery } from '../../data/memory';
import { t } from '../../i18n';
import type { EntryItem } from './EntryDetail';
import { kindIcon, kindText, nodeKind } from './GraphLegend';
import './memory-graph-side.css';

type GraphNode = MemoryGraph['nodes'][number];
type GraphEdge = MemoryGraph['edges'][number];

export interface GraphDetailProps {
  projectId: string;
  memoryId: string;
  /** The whole graph, to find what rests on the memory and what it replaced. */
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  onFocus: (id: string) => void;
  onOpenEntry: (id: string) => void;
  onClose: () => void;
}

export interface GraphDetailViewProps extends Omit<GraphDetailProps, 'projectId'> {
  /** null while the memory reads or after the read failed. */
  item: EntryItem | null;
  error: string | null;
  onRetry: () => void;
}

/** The memory's neighbours in the graph, by relation; edges point from the newer or dependent side. */
export function graphRelations(
  memoryId: string,
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const other = (kind: GraphEdge['kind'], side: 'from' | 'to') =>
    edges
      .filter((e) => e.kind === kind && e[side] === memoryId)
      .map((e) => byId.get(side === 'from' ? e.to : e.from))
      .filter((n): n is GraphNode => n !== undefined);
  return {
    dependencies: other('depends_on', 'from'),
    dependents: other('depends_on', 'to'),
    replaced: other('supersedes', 'from'),
    sources: other('source', 'from'),
  };
}

type Tone = 'ok' | 'wait' | 'idle' | 'bad';

const stateTone = (state: MemoryRecord['state']): Tone =>
  state === 'active' ? 'ok' : state === 'draft' ? 'wait' : 'idle';

const stateText = (state: MemoryRecord['state']) =>
  state === 'active'
    ? t({ id: 'memory.graphSide.state.active', defaultMessage: 'Current' })
    : state === 'draft'
      ? t({ id: 'memory.graphSide.state.draft', defaultMessage: 'Pending review' })
      : t({ id: 'memory.graphSide.state.archived', defaultMessage: 'Archived' });

const authorityText = (authority: MemoryRecord['authority']) =>
  authority === 'user'
    ? t({ id: 'memory.graphSide.byUser', defaultMessage: 'User confirmed' })
    : t({ id: 'memory.graphSide.byAgent', defaultMessage: 'Agent reported' });

const sourceText: Record<string, () => string> = {
  unchanged: () => t({ id: 'memory.graphSide.source.unchanged', defaultMessage: 'Unchanged' }),
  changed: () => t({ id: 'memory.graphSide.source.changed', defaultMessage: 'Changed' }),
  unversioned: () =>
    t({ id: 'memory.graphSide.source.unversioned', defaultMessage: 'Not tracked' }),
  unavailable: () => t({ id: 'memory.graphSide.source.unavailable', defaultMessage: 'Unreadable' }),
  unverified: () => t({ id: 'memory.graphSide.source.unverified', defaultMessage: 'Not checked' }),
};

const pad = (n: number) => String(n).padStart(2, '0');
/** Today and yesterday with the time, older days by date. */
function stamp(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === today.toDateString())
    return t({ id: 'memory.graphSide.today', defaultMessage: 'Today {time}' }, { time });
  if (d.toDateString() === yesterday.toDateString())
    return t({ id: 'memory.graphSide.yesterday', defaultMessage: 'Yesterday {time}' }, { time });
  const date = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return d.getFullYear() === today.getFullYear() ? date : `${d.getFullYear()}-${date}`;
}

/** What a source row shows: a file by its full path, a page without its scheme, a session by title. */
function sourceName(node: GraphNode) {
  if (node.source_kind === 'session') return node.label;
  const uri = node.uri ?? node.label;
  return node.source_kind === 'url' ? uri.replace(/^https?:\/\//, '') : uri;
}

export function GraphDetail({ projectId, memoryId, ...rest }: GraphDetailProps) {
  const query = useMemoryQuery<EntryItem>('memory.item', projectId, { memory_id: memoryId });
  return (
    <GraphDetailView
      {...rest}
      memoryId={memoryId}
      item={query.data}
      error={query.error}
      onRetry={query.reload}
    />
  );
}

export function GraphDetailView({
  memoryId,
  nodes,
  edges,
  item,
  error,
  onRetry,
  onFocus,
  onOpenEntry,
  onClose,
}: GraphDetailViewProps) {
  const node = nodes.find((n) => n.id === memoryId);
  const kind = item?.kind ?? (node ? nodeKind(node) : undefined);
  const relations = graphRelations(memoryId, nodes, edges);
  const statusOf = (n: GraphNode) => {
    const status = item?.reference_status?.find((r) => r.uri === n.uri)?.status;
    return status === undefined ? undefined : (sourceText[status] ?? sourceText.unverified!)();
  };
  const row = (n: GraphNode, name: string, end?: string, mono?: boolean) => {
    const k = nodeKind(n);
    return (
      <button
        key={n.id}
        type="button"
        className="mgs-row"
        data-id={n.id}
        onClick={() => onFocus(n.id)}
      >
        {kindIcon(k, kindText(k))}
        <span className="mgs-rt" data-mono={mono || undefined}>
          {name}
        </span>
        {end !== undefined && <span className="mgs-ct">{end}</span>}
      </button>
    );
  };
  const group = (title: string, rows: GraphNode[], render: (n: GraphNode) => ReactNode) =>
    rows.length > 0 && (
      <section className="mgs-sec">
        <h3 className="cap mgs-cap">
          <span>{title}</span>
          <span className="mgs-num">{rows.length}</span>
        </h3>
        {rows.map(render)}
      </section>
    );
  return (
    <aside
      className="mgs-side"
      aria-label={t({ id: 'memory.graphSide.label', defaultMessage: 'Entry details' })}
    >
      <div className="mgs-body">
        <div className="mgs-head">
          {kind && kindIcon(kind)}
          <h2 className="mgs-t">{item ? (item.title ?? item.key) : node?.label}</h2>
          <button
            type="button"
            className="ib mgs-x"
            aria-label={t({ id: 'memory.graphSide.close', defaultMessage: 'Close details' })}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </div>
        {item ? (
          <>
            <div className="mgs-chips">
              <span className="chip">{kindText(item.kind)}</span>
              <span className="chip mgs-st" data-st={stateTone(item.state)}>
                {stateText(item.state)}
              </span>
              <span className="chip">{authorityText(item.authority)}</span>
            </div>
            {(item.summary ?? node?.summary) && (
              <p className="mgs-sum">{item.summary ?? node?.summary}</p>
            )}
            <dl className="mgs-kv">
              <dt>{t({ id: 'memory.graphSide.key', defaultMessage: 'Key' })}</dt>
              <dd className="mgs-key">{item.key}</dd>
              {item.version !== undefined && (
                <>
                  <dt>{t({ id: 'memory.graphSide.version', defaultMessage: 'Version' })}</dt>
                  <dd className="mgs-num">{item.version}</dd>
                </>
              )}
              {item.committed_at !== undefined && (
                <>
                  <dt>{t({ id: 'memory.graphSide.committed', defaultMessage: 'Confirmed' })}</dt>
                  <dd className="mgs-num">{stamp(item.committed_at)}</dd>
                </>
              )}
            </dl>
          </>
        ) : error !== null ? (
          <div className="mgs-fail" role="alert">
            <span className="mgs-fail-t">
              <span className="mgs-dot" aria-hidden="true" />
              {t({ id: 'memory.graphSide.failed', defaultMessage: 'Cannot read this memory' })}
            </span>
            <span className="mgs-err">{error}</span>
            <button type="button" className="btn sm" onClick={onRetry}>
              <RefreshCw aria-hidden="true" />
              {t({ id: 'memory.graphSide.retry', defaultMessage: 'Retry' })}
            </button>
          </div>
        ) : (
          <div
            className="mgs-load"
            aria-busy="true"
            aria-label={t({ id: 'memory.graphSide.loading', defaultMessage: 'Reading memory' })}
          >
            <Skeleton style={{ width: 160 }} />
            <Skeleton />
            <Skeleton style={{ width: 200 }} />
          </div>
        )}
        <hr className="mgs-sep" />
        {group(
          t({ id: 'memory.graphSide.dependencies', defaultMessage: 'It rests on' }),
          relations.dependencies,
          (n) => row(n, n.label),
        )}
        {group(
          t({ id: 'memory.graphSide.dependents', defaultMessage: 'Rests on it' }),
          relations.dependents,
          (n) => row(n, n.label),
        )}
        {group(
          t({ id: 'memory.graphSide.replaced', defaultMessage: 'It replaced' }),
          relations.replaced,
          (n) => row(n, n.label, n.state === 'archived' ? stateText('archived') : undefined),
        )}
        {group(
          t({ id: 'memory.graphSide.sources', defaultMessage: 'Sources' }),
          relations.sources,
          (n) => row(n, sourceName(n), statusOf(n), n.source_kind === 'file'),
        )}
      </div>
      <div className="mgs-foot">
        <button type="button" className="btn pri" onClick={() => onOpenEntry(memoryId)}>
          {t({ id: 'memory.graphSide.open', defaultMessage: 'Open entry' })}
        </button>
      </div>
    </aside>
  );
}
