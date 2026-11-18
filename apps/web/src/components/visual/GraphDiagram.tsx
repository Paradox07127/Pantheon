import { useRef, useState, type ComponentType } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Box,
  Database,
  Globe,
  Group,
  ListOrdered,
  Monitor,
  Shield,
  type LucideProps,
} from 'lucide-react';
import type {
  Edge,
  EdgeProps,
  MiniMap as FlowMap,
  Node,
  NodeProps,
  ReactFlow as Flow,
} from '@xyflow/react';
import { t } from '../../i18n';
import { Clip } from '../Clip';
import {
  PAD,
  fitZoom,
  layoutGraph,
  type EdgeStyle,
  type GraphLayout,
  type GraphSpec,
  type LaidGroup,
  type LaidNode,
  type NodeKind,
  type Point,
} from './graph-layout';
import { Drawing, useDraw } from './shared';
import './graph-diagram.css';

export type { GraphSpec } from './graph-layout';

// A tall graph grows its card to this, then pans.
const MAX_HEIGHT = 1200;
// A growing card picks the graph's direction for a box this high.
const CHOICE_HEIGHT = 640;
// Fitting shrinks a graph no further than this, where 12px labels still read at 8px.
const FLOOR = 2 / 3;
/** The legend row's height under the plot. */
const LEGEND = 28;
const CORNER = 6;
const HEAD = 6;

const KINDS: readonly NodeKind[] = ['client', 'service', 'store', 'queue', 'external', 'policy'];
const STYLES: readonly EdgeStyle[] = ['main', 'async', 'data', 'return'];

// The kind colours of graph-diagram.css, for the map's node shapes.
const KIND_TONE: Record<NodeKind, string> = {
  client: 'var(--series-1)',
  service: 'var(--series-2)',
  store: 'var(--series-4)',
  queue: 'var(--series-3)',
  external: 'var(--series-5)',
  policy: 'var(--series-6)',
};

const KIND_ICON: Record<NodeKind, ComponentType<LucideProps>> = {
  client: Monitor,
  service: Box,
  store: Database,
  queue: ListOrdered,
  external: Globe,
  policy: Shield,
};

// Getters, so each name is read in the language loaded by then.
const KIND_NAME: Record<NodeKind, string> = {
  get client() {
    return t({ id: 'visual.graph.kind.client', defaultMessage: 'Client' });
  },
  get service() {
    return t({ id: 'visual.graph.kind.service', defaultMessage: 'Service' });
  },
  get store() {
    return t({ id: 'visual.graph.kind.store', defaultMessage: 'Store' });
  },
  get queue() {
    return t({ id: 'visual.graph.kind.queue', defaultMessage: 'Queue' });
  },
  get external() {
    return t({ id: 'visual.graph.kind.external', defaultMessage: 'External' });
  },
  get policy() {
    return t({ id: 'visual.graph.kind.policy', defaultMessage: 'Policy' });
  },
};

const STYLE_NAME: Record<EdgeStyle, string> = {
  get main() {
    return t({ id: 'visual.graph.style.main', defaultMessage: 'Main path' });
  },
  get async() {
    return t({ id: 'visual.graph.style.async', defaultMessage: 'Async' });
  },
  get data() {
    return t({ id: 'visual.graph.style.data', defaultMessage: 'Data' });
  },
  get return() {
    return t({ id: 'visual.graph.style.return', defaultMessage: 'Return' });
  },
};

/** Counts of the node kinds and edge styles the spec uses, in legend order. */
export function legendItems(spec: GraphSpec) {
  const kinds = KINDS.map(
    (kind) => [kind, spec.nodes.filter((node) => node.kind === kind).length] as const,
  ).filter(([, count]) => count > 0);
  const styles = STYLES.map(
    (style) => [style, spec.edges.filter((edge) => edge.style === style).length] as const,
  ).filter(([, count]) => count > 0);
  return { kinds, styles, shown: kinds.length + styles.length >= 2 };
}

/** Hover focus: the hovered node's edges stand out, nodes off them dim. */
type Focus = 'on' | 'dim' | undefined;

type CardData = { node: LaidNode; focus: Focus };
type GroupData = { group: LaidGroup };
type RouteData = { edge: GraphLayout['edges'][number]; focus: Focus; tone?: NodeKind };

/** An orthogonal route with each bend rounded; the ends move back by `cut` for their heads. */
function routePath(points: Point[], cut: { start: number; end: number }): string {
  if (points.length < 2) return '';
  const at = points.map((p) => ({ ...p }));
  const pull = (end: Point, toward: Point, by: number) => {
    const length = Math.hypot(toward.x - end.x, toward.y - end.y);
    if (!length || !by) return;
    const k = Math.min(by, length) / length;
    end.x += (toward.x - end.x) * k;
    end.y += (toward.y - end.y) * k;
  };
  pull(at[0]!, points[1]!, cut.start);
  pull(at[at.length - 1]!, points[points.length - 2]!, cut.end);
  let d = `M${at[0]!.x} ${at[0]!.y}`;
  for (let i = 1; i < at.length - 1; i++) {
    const [before, corner, after] = [at[i - 1]!, at[i]!, at[i + 1]!];
    const into = Math.hypot(corner.x - before.x, corner.y - before.y);
    const out = Math.hypot(after.x - corner.x, after.y - corner.y);
    const r = Math.min(CORNER, into / 2, out / 2);
    if (!into || !out || !r) {
      d += `L${corner.x} ${corner.y}`;
      continue;
    }
    const a = {
      x: corner.x - ((corner.x - before.x) / into) * r,
      y: corner.y - ((corner.y - before.y) / into) * r,
    };
    const b = {
      x: corner.x + ((after.x - corner.x) / out) * r,
      y: corner.y + ((after.y - corner.y) / out) * r,
    };
    d += `L${a.x} ${a.y}Q${corner.x} ${corner.y} ${b.x} ${b.y}`;
  }
  const last = at[at.length - 1]!;
  return `${d}L${last.x} ${last.y}`;
}

/** A head with its tip on `tip`, pointing away from `from`. */
function headPath(tip: Point, from: Point): string {
  const length = Math.hypot(tip.x - from.x, tip.y - from.y) || 1;
  const [ux, uy] = [(tip.x - from.x) / length, (tip.y - from.y) / length];
  const [bx, by] = [tip.x - ux * HEAD, tip.y - uy * HEAD];
  const half = HEAD / 2;
  return `M${tip.x} ${tip.y}L${bx - uy * half} ${by + ux * half}L${bx + uy * half} ${by - ux * half}Z`;
}

function Route({ data }: EdgeProps<Edge<RouteData>>) {
  if (!data || data.edge.points.length < 2) return null;
  const { points, both, label, label_box: box } = data.edge;
  const n = points.length;
  return (
    <g
      className="vis-ge"
      data-style={data.edge.style ?? 'plain'}
      data-kind={data.tone}
      data-focus={data.focus}
    >
      <path className="vis-ge-p" d={routePath(points, { start: both ? HEAD : 0, end: HEAD })} />
      <path className="vis-ge-h" d={headPath(points[n - 1]!, points[n - 2]!)} />
      {both && <path className="vis-ge-h" d={headPath(points[0]!, points[1]!)} />}
      {box && label !== undefined && (
        <g className="vis-ge-l">
          <rect x={box.x} y={box.y} width={box.width} height={box.height} rx={5} />
          <text x={box.x + box.width / 2} y={box.y + box.height / 2}>
            {label}
          </text>
        </g>
      )}
    </g>
  );
}

function GroupBox({ data: { group } }: NodeProps<Node<GroupData>>) {
  return (
    <div className="vis-gg" data-depth={group.depth}>
      <span className="vis-gg-h">
        <Clip text={group.label} />
        <span className="vis-gg-n">{group.members}</span>
      </span>
    </div>
  );
}

/** Node and edge components, made once the flow library has loaded. */
function flowTypes(flow: typeof import('@xyflow/react')) {
  function Card({ data: { node, focus }, selected }: NodeProps<Node<CardData>>) {
    const Icon = node.kind && KIND_ICON[node.kind];
    return (
      <div
        className="vis-gn"
        data-kind={node.kind}
        data-focus={focus}
        data-selected={selected || undefined}
      >
        <flow.Handle type="target" position={flow.Position.Left} isConnectable={false} />
        {Icon && <Icon className="vis-gn-ic" aria-hidden="true" />}
        <Clip className="vis-gn-t" text={node.label} />
        {node.sublabel !== undefined && <Clip className="vis-gn-s" text={node.sublabel} />}
        <flow.Handle type="source" position={flow.Position.Right} isConnectable={false} />
      </div>
    );
  }
  return { nodeTypes: { card: Card, group: GroupBox }, edgeTypes: { route: Route } };
}

/** The node's kind, sublabel, group, edges in and out and sources, for the inspector. */
export function GraphNodeInfo({ spec, id }: { spec: GraphSpec; id: string }) {
  const node = spec.nodes.find((n) => n.id === id);
  if (!node) return null;
  const names = new Map(spec.nodes.map((n) => [n.id, n.label]));
  const group =
    node.group === undefined
      ? undefined
      : (spec.groups?.find((g) => g.id === node.group)?.label ?? node.group);
  const Icon = node.kind && KIND_ICON[node.kind];
  const ends = (end: 'from' | 'to', name: string, Arrow: ComponentType<LucideProps>) => {
    const edges = spec.edges.filter((edge) => edge[end === 'from' ? 'to' : 'from'] === id);
    return (
      edges.length > 0 && (
        <ul className="vis-gi-l" aria-label={name}>
          {edges.map((edge, i) => (
            <li key={i}>
              <Arrow className="vis-gi-ic" aria-hidden="true" />
              <span>{names.get(edge[end])}</span>
              {edge.label !== undefined && <span className="vis-gi-el">{edge.label}</span>}
            </li>
          ))}
        </ul>
      )
    );
  };
  return (
    <section className="vis-gi">
      <h2 className="vis-gi-t" data-kind={node.kind}>
        {Icon && <Icon className="vis-gi-ic" aria-hidden="true" />}
        {node.label}
      </h2>
      {(node.kind !== undefined || group !== undefined) && (
        <div className="vis-gi-m">
          {node.kind !== undefined && <span>{KIND_NAME[node.kind]}</span>}
          {group !== undefined && (
            <span>
              <Group className="vis-gi-ic" aria-hidden="true" />
              {group}
            </span>
          )}
        </div>
      )}
      {node.sublabel !== undefined && <code className="vis-gi-s">{node.sublabel}</code>}
      {ends(
        'from',
        t({ id: 'visual.graph.incoming', defaultMessage: 'Incoming edges' }),
        ArrowLeft,
      )}
      {ends('to', t({ id: 'visual.graph.outgoing', defaultMessage: 'Outgoing edges' }), ArrowRight)}
      {node.sources && node.sources.length > 0 && (
        <ul
          className="vis-gi-l"
          aria-label={t({ id: 'visual.graph.sources', defaultMessage: 'Sources' })}
        >
          {node.sources.map((source) => (
            <li key={source}>
              <code className="vis-gi-s">{source}</code>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface Laid {
  ReactFlow: typeof Flow;
  MiniMap: typeof FlowMap;
  Background: typeof import('@xyflow/react').Background;
  dots: import('@xyflow/react').BackgroundVariant;
  types: ReturnType<typeof flowTypes>;
  layout: GraphLayout;
  /** The plot's width in px when the graph was laid out. */
  room: number;
}

export function GraphDiagram({
  spec,
  height,
  selected,
  onSelect,
  grows = false,
  full = false,
}: {
  spec: GraphSpec;
  height: number;
  selected?: string;
  /** Grows past the height to the graph at the zoom that fits its width, up to `MAX_HEIGHT`. */
  grows?: boolean;
  /** Draws at full size and pans, as the Enlarge dialog does. */
  full?: boolean;
  /** A node was picked, or `undefined` once it is let go. */
  onSelect?: (id: string | undefined) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [laid, setLaid] = useState<Laid | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const legend = legendItems(spec);
  const below = legend.shown ? LEGEND : 0;
  const ready = useDraw(
    async (live) => {
      const [flow] = await Promise.all([
        import('@xyflow/react'),
        import('@xyflow/react/dist/base.css'),
      ]);
      const at = box.current;
      if (!live() || !at) return undefined;
      const room = at.clientWidth;
      const tall = (grows ? Math.max(height, CHOICE_HEIGHT) : height) - below;
      const layout = await layoutGraph(spec, { x: room, y: tall });
      if (!live()) return undefined;
      setLaid({
        ReactFlow: flow.ReactFlow,
        MiniMap: flow.MiniMap,
        Background: flow.Background,
        dots: flow.BackgroundVariant.Dots,
        types: flowTypes(flow),
        layout,
        room,
      });
      return undefined;
    },
    [spec, grows, height],
  );
  const clamp = (zoom: number) => Math.min(1, Math.max(FLOOR, zoom));
  const zoom =
    !laid || full
      ? 1
      : grows
        ? clamp((laid.room - PAD * 2) / laid.layout.width)
        : clamp(fitZoom(laid.layout, { x: laid.room, y: height - below }));
  const shown =
    grows && laid
      ? Math.min(
          Math.max(height, laid.layout.height * zoom + PAD * 2 + below),
          Math.max(height, MAX_HEIGHT),
        )
      : height;
  // A pixel of slack, so a card grown to the drawing does not count as cutting it.
  const over = (size: number, room: number) => size > room - PAD * 2 + 1;
  // Centred where it fits; where it does not, the view opens at its start and the graph pans.
  const start = (size: number, room: number) => (over(size, room) ? PAD : (room - size) / 2);
  const drawing = { x: (laid?.layout.width ?? 0) * zoom, y: (laid?.layout.height ?? 0) * zoom };
  const plot = { x: laid?.room ?? 0, y: shown - below };
  const viewport = { x: start(drawing.x, plot.x), y: start(drawing.y, plot.y), zoom };
  // A map shows the whole and the view while the graph pans.
  const overflows = !!laid && (over(drawing.x, plot.x) || over(drawing.y, plot.y));
  const chosen = selected ?? picked;
  const pick = (id: string | undefined) => {
    setPicked(id);
    onSelect?.(id);
  };
  const names = new Map(spec.nodes.map((node) => [node.id, node.label]));
  const kinds = new Map(spec.nodes.map((node) => [node.id, node.kind]));
  const near =
    laid && hover
      ? new Set(
          laid.layout.edges
            .filter((edge) => edge.from === hover || edge.to === hover)
            .flatMap((edge) => [edge.from, edge.to]),
        ).add(hover)
      : null;
  const nodes: Node[] = laid
    ? [
        ...laid.layout.groups.map((group): Node<GroupData> => ({
          id: `group:${group.id}`,
          type: 'group',
          data: { group },
          position: { x: group.x, y: group.y },
          width: group.width,
          height: group.height,
          // Behind the edges, an inner group over its outer one.
          zIndex: group.depth - 100,
          selectable: false,
          focusable: false,
          ariaRole: 'presentation',
        })),
        ...laid.layout.nodes.map((node): Node<CardData> => ({
          id: node.id,
          type: 'card',
          data: { node, focus: near && !near.has(node.id) ? 'dim' : undefined },
          position: { x: node.x, y: node.y },
          width: node.width,
          height: node.height,
          className: 'vis-gw',
          selected: node.id === chosen,
          ariaLabel: node.kind
            ? t(
                { id: 'visual.graph.node', defaultMessage: '{label}, {kind}' },
                { label: node.label, kind: KIND_NAME[node.kind] },
              )
            : node.label,
        })),
      ]
    : [];
  const edges: Edge[] = laid
    ? laid.layout.edges.map((edge): Edge<RouteData> => {
        const values = { from: names.get(edge.from), to: names.get(edge.to) };
        const tone = kinds.get(edge.to);
        return {
          id: edge.id,
          source: edge.from,
          target: edge.to,
          type: 'route',
          data: {
            edge,
            focus: hover ? (edge.from === hover || edge.to === hover ? 'on' : 'dim') : undefined,
            ...(tone && { tone }),
          },
          ariaLabel: edge.both
            ? t(
                { id: 'visual.graph.edgeBoth', defaultMessage: '{from} and {to}, both ways' },
                values,
              )
            : t({ id: 'visual.graph.edge', defaultMessage: '{from} to {to}' }, values),
        };
      })
    : [];
  return (
    <div
      ref={box}
      className="vis-graph vis-gd"
      style={{ height: shown }}
      data-direction={laid?.layout.direction}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && chosen !== undefined) {
          event.stopPropagation();
          pick(undefined);
          return;
        }
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const id = (event.target as HTMLElement).closest<HTMLElement>('.react-flow__node')?.dataset
          .id;
        if (id && names.has(id)) {
          event.preventDefault();
          pick(id);
        }
      }}
    >
      <div className="vis-gp">
        {laid && (
          <laid.ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={laid.types.nodeTypes}
            edgeTypes={laid.types.edgeTypes}
            defaultViewport={viewport}
            minZoom={FLOOR / 2}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            nodesFocusable
            onNodeClick={(_, node) => {
              if (node.type === 'card') pick(node.id);
            }}
            onPaneClick={() => {
              if (chosen !== undefined) pick(undefined);
            }}
            onNodeMouseEnter={(_, node) => setHover(node.type === 'card' ? node.id : null)}
            onNodeMouseLeave={() => setHover(null)}
            edgesFocusable={false}
            deleteKeyCode={null}
            // A plain wheel keeps scrolling the page; pinch or the modifier key with the wheel zooms.
            zoomOnScroll={false}
            preventScrolling={false}
            proOptions={{ hideAttribution: true }}
          >
            <laid.Background variant={laid.dots} gap={16} size={1} />
            {overflows && (
              <laid.MiniMap
                pannable
                zoomable={false}
                style={{ width: 144, height: 96 }}
                nodeColor={(node) => {
                  if (node.type === 'group') return 'transparent';
                  const kind = (node.data as CardData).node.kind;
                  return kind ? KIND_TONE[kind] : 'var(--mu)';
                }}
                nodeBorderRadius={2}
                maskStrokeWidth={1}
                ariaLabel={t({ id: 'visual.graph.overview', defaultMessage: 'Whole graph' })}
              />
            )}
          </laid.ReactFlow>
        )}
        {!ready && <Drawing />}
      </div>
      {legend.shown && (
        <ul
          className="vis-gl"
          aria-label={t({ id: 'visual.graph.legend', defaultMessage: 'Legend' })}
        >
          {legend.kinds.map(([kind, count]) => {
            const Icon = KIND_ICON[kind];
            return (
              <li key={kind} data-kind={kind}>
                <Icon className="vis-gl-ic" aria-hidden="true" />
                <span>{KIND_NAME[kind]}</span>
                <span className="vis-gl-n">{count}</span>
              </li>
            );
          })}
          {legend.styles.map(([style, count]) => (
            <li key={style} data-style={style}>
              <svg className="vis-gl-ln" viewBox="0 0 20 8" aria-hidden="true">
                <path d="M0 4H20" />
              </svg>
              <span>{STYLE_NAME[style]}</span>
              <span className="vis-gl-n">{count}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
