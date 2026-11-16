import { useEffect, useMemo, useRef, useState } from 'react';
import { LoadError } from '../../components/LoadError';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { BookOpen, Funnel, Search } from 'lucide-react';
import type { MemoryGraph } from '@pantheon/domain';
import { EmptyState } from '../../components/EmptyState';
import { Menu, MenuCheckboxItem } from '../../components/Menu';
import { Skeleton } from '../../components/Skeleton';
import { useMemoryQuery } from '../../data/memory';
import { useMemoryView } from '../../data/memory-view';
import { t } from '../../i18n';
import { useDelayed } from '../../lib/use-delayed';
import { useShell } from '../../store';
import { saveAndSelect } from './EntriesBar';
import { useHeld } from './EntriesPage';
import { GraphCanvas } from './GraphCanvas';
import { GraphDetail } from './GraphDetail';
import { GraphHoverCard } from './GraphHoverCard';
import { GraphLegend, kindIcon, kindText, legendKinds } from './GraphLegend';
import { GraphZoom } from './GraphZoom';
import { fitZoom, graphNear, graphSummary } from './graph-focus';
import { layoutGraph, type GraphKind } from './graph-layout';
import { NewMemoryDialog } from './NewMemoryDialog';
import './memory-graph-view.css';

const KINDS: GraphKind[] = ['decision', 'report', 'note', 'file', 'url', 'session'];
const MAX_NODES = 80;
const NO_KINDS: MemoryGraph = {
  nodes: [],
  edges: [],
  signature: '',
  total: 0,
  truncated: false,
  depth: 1,
};
// The first read shows its skeleton only once it has taken this long.
const SKELETON_AFTER = 1000;

const inTextField = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  return (
    !!el &&
    (el.tagName === 'INPUT' ||
      el.tagName === 'TEXTAREA' ||
      el.tagName === 'SELECT' ||
      !!el.isContentEditable)
  );
};

/** The project's whole graph, laid out with the kinds and tags the top bar asks for. */
function useGraph(projectId: string) {
  const showTags = useMemoryView((s) => s.showTags);
  const hiddenKinds = useMemoryView((s) => s.hiddenKinds);
  const focusId = useMemoryView((s) => s.graphNode ?? s.selectedId);
  const selectedId = useMemoryView((s) => s.selectedId);
  const depth = useMemoryView((s) => s.depth);
  const filtered = hiddenKinds.length > 0;
  // An empty kind list would reach the daemon as no filter at all, so it reads nothing.
  const cleared = KINDS.every((k) => hiddenKinds.includes(k));
  const read = useMemoryQuery<MemoryGraph>(
    'memory.graph',
    projectId,
    cleared
      ? null
      : {
          state: 'all',
          max_nodes: MAX_NODES,
          include_tags: showTags,
          kind: filtered ? KINDS.filter((k) => !hiddenKinds.includes(k)) : undefined,
          keep: selectedId ?? undefined,
        },
  );
  const held = useHeld(projectId, read.data);
  const graph = cleared ? NO_KINDS : held;
  const hidden = hiddenKinds.join();
  const layout = useMemo(
    () =>
      graph &&
      layoutGraph(graph, {
        kinds: filtered ? new Set(KINDS.filter((k) => !hiddenKinds.includes(k))) : null,
        tags: showTags,
      }),
    [graph, hidden, showTags],
  );
  const focused = !!layout && layout.nodes.some((n) => n.id === focusId);
  const near = useMemo(
    () => (layout && focused ? graphNear(layout.edges, focusId!, depth) : null),
    [layout, focused, focusId, depth],
  );
  const none = graph?.total === 0;
  // With a kind filter on, no nodes need not mean the project has no memory.
  return { read, graph, layout, near, none, empty: none && !filtered, focused, focusId };
}

/** The graph tab's top bar controls: search, kinds, tag nodes and how far the focus reaches. */
export function GraphTopControls({ projectId }: { projectId: string }) {
  const view = useMemoryView();
  const { layout, none, empty, focused } = useGraph(projectId);
  const q = view.query.trim().toLowerCase();
  const hits =
    q && layout ? layout.nodes.filter((n) => n.label.toLowerCase().includes(q)).length : 0;
  const kindsLabel = t({ id: 'memory.graphView.kinds', defaultMessage: 'Kinds' });
  return (
    <div className="tb-end">
      <label className="field mgv-find" data-off={none || undefined}>
        <Search aria-hidden="true" />
        <input
          type="search"
          maxLength={200}
          aria-label={t({ id: 'memory.graphView.search', defaultMessage: 'Search nodes' })}
          placeholder={t({ id: 'memory.graphView.search', defaultMessage: 'Search nodes' })}
          disabled={none}
          value={view.query}
          onChange={(e) => view.setQuery(e.target.value)}
        />
        {q && (
          <span
            className="mgv-hits"
            aria-label={t(
              {
                id: 'memory.graphView.hits',
                defaultMessage: '{count, plural, one {# node matches} other {# nodes match}}',
              },
              { count: hits },
            )}
          >
            {hits}
          </span>
        )}
      </label>
      <Menu
        label={kindsLabel}
        trigger={
          <button
            type="button"
            className="btn ghost sm mgv-kinds"
            disabled={empty}
            aria-pressed={view.hiddenKinds.length > 0}
          >
            <Funnel aria-hidden="true" />
            {kindsLabel}
          </button>
        }
      >
        {KINDS.map((kind) => (
          <MenuCheckboxItem
            key={kind}
            checked={!view.hiddenKinds.includes(kind)}
            onChange={(shown) => view.showKind(kind, shown)}
            icon={kindIcon(kind)}
          >
            {kindText(kind)}
          </MenuCheckboxItem>
        ))}
      </Menu>
      <label className="mgv-tags" data-off={none || undefined}>
        <input
          type="checkbox"
          role="switch"
          className="ps-sw"
          disabled={none}
          checked={view.showTags}
          onChange={(e) => view.setShowTags(e.target.checked)}
        />
        {t({ id: 'memory.graphView.tags', defaultMessage: 'Show tags' })}
      </label>
      <RadioGroup
        className="tb-seg mgv-depth"
        aria-label={t({ id: 'memory.graphView.depth', defaultMessage: 'Depth' })}
        value={String(view.depth)}
        disabled={none || !focused}
        onValueChange={(value) => view.setDepth(value === '2' ? 2 : 1)}
      >
        <Radio.Root value="1">
          {t({ id: 'memory.graphView.depth.one', defaultMessage: '1 level' })}
        </Radio.Root>
        <Radio.Root value="2">
          {t({ id: 'memory.graphView.depth.two', defaultMessage: '2 levels' })}
        </Radio.Root>
      </RadioGroup>
    </div>
  );
}

/** No memory in the project yet. */
function GraphEmpty({ onCreate }: { onCreate: () => void }) {
  return (
    <EmptyState
      graphic={<BookOpen aria-hidden="true" />}
      title={t({ id: 'memory.graphView.empty', defaultMessage: 'No project memory yet' })}
      action={{
        label: t({ id: 'memory.graphView.create', defaultMessage: 'New entry' }),
        keys: 'N',
        onClick: onCreate,
      }}
    />
  );
}

/** The graph tab: the whole project's memories and links, and the selected memory's details. */
export function MemoryGraphView({ projectId }: { projectId: string }) {
  const query = useMemoryView((s) => s.query);
  const select = useMemoryView((s) => s.select);
  const shown = useShell((s) => s.screen === 'memory' && s.memoryTab === 'graph');
  const { read, graph, layout, near, none, empty, focused, focusId } = useGraph(projectId);
  const late = useDelayed(!graph && !read.error, SKELETON_AFTER);
  const [zoom, setZoom] = useState(1);
  const [creating, setCreating] = useState(false);
  const viewport = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!shown || !empty || creating) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (inTextField(e.target) || e.key.toLowerCase() !== 'n') return;
      e.preventDefault();
      setCreating(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown, empty, creating]);

  const node = graph?.nodes.find((n) => n.id === focusId);
  // Only a memory entry becomes the selection the entries tab opens.
  const focus = (id: string) => {
    const kind = graph?.nodes.find((n) => n.id === id)?.kind;
    if (kind === 'source' || kind === 'tag') useMemoryView.getState().focusGraphNode(id);
    else select(id);
  };
  const detail = graph && node && node.kind !== 'source' && node.kind !== 'tag' && (
    <GraphDetail
      projectId={projectId}
      memoryId={node.id}
      nodes={graph.nodes}
      edges={graph.edges}
      onFocus={focus}
      onOpenEntry={(id) => {
        select(id);
        useShell.getState().setMemoryTab('entries');
      }}
      onClose={() => select(null)}
    />
  );

  let body;
  if (read.error)
    body = (
      <LoadError
        message={t(
          {
            id: 'memory.graphView.failed',
            defaultMessage: 'Cannot read the memory graph: {error}',
          },
          { error: read.error },
        )}
        onRetry={read.reload}
      />
    );
  else if (!graph || !layout)
    body = late && (
      <div
        className="mgv-load"
        aria-busy="true"
        aria-label={t({ id: 'memory.graphView.loading', defaultMessage: 'Reading the graph' })}
      >
        <Skeleton className="mgv-sk" style={{ width: 160 }} />
        <Skeleton className="mgv-sk" style={{ width: 160 }} />
        <Skeleton className="mgv-sk" style={{ width: 120 }} />
      </div>
    );
  else if (empty) body = <GraphEmpty onCreate={() => setCreating(true)} />;
  else if (none)
    body = (
      <EmptyState
        graphic={<Funnel aria-hidden="true" />}
        title={t({ id: 'memory.graphView.noMatch', defaultMessage: 'Nothing matches the filter' })}
      />
    );
  else
    body = (
      <>
        <GraphCanvas
          layout={layout}
          selected={focusId}
          near={near}
          query={query}
          zoom={zoom}
          onSelect={focus}
          summary={graphSummary(layout, focusId, near, graph.total)}
          onMove={(id) => {
            if (focused) focus(id);
          }}
          card={(n, id) => <GraphHoverCard node={n} id={id} />}
        />
        <GraphLegend
          kinds={legendKinds(layout.nodes)}
          focused={near ? layout.nodes.filter((n) => near.has(n.id)).length : null}
          shown={layout.nodes.length}
          total={graph.total}
          truncated={graph.truncated}
        />
        <GraphZoom
          zoom={zoom}
          onZoom={setZoom}
          onFit={() => {
            const el = viewport.current;
            if (el) setZoom(fitZoom(layout, { width: el.clientWidth, height: el.clientHeight }));
          }}
        />
      </>
    );

  return (
    <div className="mgv" data-detail={detail ? '' : undefined}>
      <div className="mgv-main" ref={viewport}>
        {body}
      </div>
      {detail}
      <NewMemoryDialog
        open={creating}
        onOpenChange={setCreating}
        projectId={projectId}
        onSubmit={saveAndSelect}
      />
    </div>
  );
}
