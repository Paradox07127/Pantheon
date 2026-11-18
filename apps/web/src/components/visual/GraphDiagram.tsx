import { useRef, useState, type ComponentType } from 'react';
import {
  AppWindow,
  ArrowLeft,
  ArrowRight,
  Bell,
  Bot,
  Box,
  Calendar,
  ChartColumn,
  Clock,
  Cloud,
  Code,
  Cpu,
  CreditCard,
  Database,
  FileIcon,
  Folder,
  GitBranch,
  Globe,
  Group,
  HardDrive,
  Key,
  Layers,
  ListOrdered,
  Lock,
  Mail,
  MapIcon,
  MessageSquare,
  Monitor,
  Package,
  Plug,
  Rocket,
  Search,
  Server,
  Settings,
  Shield,
  ShoppingCart,
  Smartphone,
  Terminal,
  TestTube,
  User,
  Users,
  Webhook,
  Zap,
  type LucideProps,
} from 'lucide-react';
import type { GraphColor, GraphIcon, GraphStatus } from '@pantheon/domain';
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
  FLOOR,
  LABEL_LINE,
  PAD,
  fitZoom,
  labelLines,
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

const ICON: Record<GraphIcon, ComponentType<LucideProps>> = {
  monitor: Monitor,
  smartphone: Smartphone,
  globe: Globe,
  server: Server,
  box: Box,
  database: Database,
  'hard-drive': HardDrive,
  'list-ordered': ListOrdered,
  shield: Shield,
  key: Key,
  lock: Lock,
  user: User,
  users: Users,
  bot: Bot,
  cpu: Cpu,
  cloud: Cloud,
  'git-branch': GitBranch,
  file: FileIcon,
  folder: Folder,
  terminal: Terminal,
  mail: Mail,
  bell: Bell,
  search: Search,
  settings: Settings,
  'chart-column': ChartColumn,
  clock: Clock,
  zap: Zap,
  package: Package,
  layers: Layers,
  'message-square': MessageSquare,
  'credit-card': CreditCard,
  'shopping-cart': ShoppingCart,
  plug: Plug,
  webhook: Webhook,
  calendar: Calendar,
  map: MapIcon,
  'app-window': AppWindow,
  code: Code,
  'test-tube': TestTube,
  rocket: Rocket,
};

const COLORS: readonly GraphColor[] = ['blue', 'teal', 'orange', 'violet', 'gray', 'green'];
const STATUSES: readonly GraphStatus[] = ['waiting', 'running', 'done', 'failed', 'blocked'];

// The colour and status tones of graph-diagram.css, for the map's node shapes.
const COLOR_TONE = Object.fromEntries(
  COLORS.map((color, i) => [color, `var(--series-${i + 1})`]),
) as Record<GraphColor, string>;
const STATUS_TONE: Record<GraphStatus, string> = {
  waiting: 'var(--wait)',
  running: 'var(--run)',
  done: 'var(--ok)',
  failed: 'var(--bad)',
  blocked: 'var(--bad)',
};

/** A node's tone: its status's, else its colour's, else its kind's. */
const toneOf = (node: LaidNode): string | undefined =>
  node.status
    ? STATUS_TONE[node.status]
    : node.color
      ? COLOR_TONE[node.color]
      : node.kind && KIND_TONE[node.kind];

/** The icon drawn for a node: the one it names, else its kind's. */
const iconOf = (node: { icon?: GraphIcon; kind?: NodeKind }) =>
  node.icon ? ICON[node.icon] : node.kind && KIND_ICON[node.kind];

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

const STATUS_NAME: Record<GraphStatus, string> = {
  get waiting() {
    return t({ id: 'visual.graph.status.waiting', defaultMessage: 'Waiting' });
  },
  get running() {
    return t({ id: 'visual.graph.status.running', defaultMessage: 'Running' });
  },
  get done() {
    return t({ id: 'visual.graph.status.done', defaultMessage: 'Done' });
  },
  get failed() {
    return t({ id: 'visual.graph.status.failed', defaultMessage: 'Failed' });
  },
  get blocked() {
    return t({ id: 'visual.graph.status.blocked', defaultMessage: 'Blocked' });
  },
};

/** A status's dot; each status has a shape of its own besides its colour. */
function StatusDot({ status, className }: { status: GraphStatus; className: string }) {
  return (
    <svg className={className} data-status={status} viewBox="0 0 8 8" aria-hidden="true">
      {status === 'waiting' && <circle cx={4} cy={4} r={3.25} />}
      {status === 'running' && <path d="M4 0.5A3.5 3.5 0 0 1 4 7.5Z" />}
      {status === 'done' && <circle cx={4} cy={4} r={4} />}
      {status === 'failed' && <path d="M1 1L7 7M7 1L1 7" />}
      {status === 'blocked' && <rect x={0.5} y={0.5} width={7} height={7} rx={1} />}
    </svg>
  );
}

/**
 * Counts of the node kinds, the colours given a meaning, the statuses and the edge styles the spec
 * uses, in legend order.
 */
export function legendItems(spec: GraphSpec) {
  const count = <T,>(
    values: readonly T[],
    of: (node: GraphSpec['nodes'][number]) => T | undefined,
  ) =>
    values
      .map((value) => [value, spec.nodes.filter((node) => of(node) === value).length] as const)
      .filter(([, n]) => n > 0);
  const kinds = count(KINDS, (node) => node.kind);
  const colors = count(
    COLORS.filter((color) => spec.colors?.[color] !== undefined),
    (node) => node.color,
  );
  const statuses = count(STATUSES, (node) => node.status);
  const styles = STYLES.map(
    (style) => [style, spec.edges.filter((edge) => edge.style === style).length] as const,
  ).filter(([, n]) => n > 0);
  const shown = kinds.length + colors.length + statuses.length + styles.length >= 2;
  return { kinds, colors, statuses, styles, shown };
}

/** A node's accessible name: its label, then its kind and its status in words. */
function nodeName(node: LaidNode): string {
  const named = node.kind
    ? t(
        { id: 'visual.graph.node', defaultMessage: '{label}, {kind}' },
        { label: node.label, kind: KIND_NAME[node.kind] },
      )
    : node.label;
  return node.status
    ? t(
        { id: 'visual.graph.nodeStatus', defaultMessage: '{name}, {status}' },
        { name: named, status: STATUS_NAME[node.status] },
      )
    : named;
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
  const lines = label === undefined ? [] : labelLines(label);
  const middle = box && { x: box.x + box.width / 2, y: box.y + box.height / 2 };
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
      {box && middle && label !== undefined && (
        <g className="vis-ge-l">
          {lines.length > 1 && <title>{label}</title>}
          <rect x={box.x} y={box.y} width={box.width} height={box.height} rx={5} />
          <text x={middle.x} y={middle.y}>
            {lines.length > 1
              ? lines.map((line, i) => (
                  <tspan
                    key={i}
                    x={middle.x}
                    y={middle.y + (i - (lines.length - 1) / 2) * LABEL_LINE}
                  >
                    {line}
                  </tspan>
                ))
              : label}
          </text>
        </g>
      )}
    </g>
  );
}

/** Node and edge components, made once the flow library has loaded. */
function flowTypes(flow: typeof import('@xyflow/react')) {
  // The flow attaches an edge only to a node with handles; edges are drawn along their routes.
  const ends = (
    <>
      <flow.Handle type="target" position={flow.Position.Left} isConnectable={false} />
      <flow.Handle type="source" position={flow.Position.Right} isConnectable={false} />
    </>
  );
  function Card({ data: { node, focus }, selected }: NodeProps<Node<CardData>>) {
    const Icon = !node.shape && iconOf(node);
    // A start or end dot has no text; its label names it.
    const dot = node.shape === 'start' || node.shape === 'end';
    const { width: w, height: h } = node;
    return (
      <div
        className="vis-gn"
        data-kind={node.kind}
        data-color={node.color}
        data-status={node.status}
        data-shape={node.shape}
        data-focus={focus}
        data-selected={selected || undefined}
      >
        {ends}
        {node.shape === 'decision' && (
          <svg className="vis-gn-dm" viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
            <path d={`M${w / 2} 0L${w} ${h / 2}L${w / 2} ${h}L0 ${h / 2}Z`} />
          </svg>
        )}
        {Icon && <Icon className="vis-gn-ic" aria-hidden="true" />}
        {!dot && node.status ? (
          <span className="vis-gn-r">
            <StatusDot status={node.status} className="vis-gn-st" />
            <Clip className="vis-gn-t" text={node.label} />
          </span>
        ) : (
          !dot && <Clip className="vis-gn-t" text={node.label} />
        )}
        {!dot && node.sublabel !== undefined && <Clip className="vis-gn-s" text={node.sublabel} />}
        {!dot && node.detail?.map((line, i) => <Clip key={i} className="vis-gn-d" text={line} />)}
      </div>
    );
  }
  function GroupBox({ data: { group } }: NodeProps<Node<GroupData>>) {
    return (
      <div className="vis-gg" data-depth={group.depth}>
        {ends}
        <span className="vis-gg-h">
          <Clip text={group.label} />
          <span className="vis-gg-n">{group.members}</span>
        </span>
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
  const Icon = iconOf(node);
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
      <h2
        className="vis-gi-t"
        data-kind={node.kind}
        data-color={node.color}
        data-status={node.status}
      >
        {Icon && <Icon className="vis-gi-ic" aria-hidden="true" />}
        {node.label}
      </h2>
      {(node.kind !== undefined || node.status !== undefined || group !== undefined) && (
        <div className="vis-gi-m">
          {node.kind !== undefined && <span>{KIND_NAME[node.kind]}</span>}
          {node.status !== undefined && (
            <span>
              <StatusDot status={node.status} className="vis-gi-st" />
              {STATUS_NAME[node.status]}
            </span>
          )}
          {group !== undefined && (
            <span>
              <Group className="vis-gi-ic" aria-hidden="true" />
              {group}
            </span>
          )}
        </div>
      )}
      {node.sublabel !== undefined && <code className="vis-gi-s">{node.sublabel}</code>}
      {node.detail && node.detail.length > 0 && (
        <ul
          className="vis-gi-l"
          aria-label={t({ id: 'visual.graph.detail', defaultMessage: 'Detail' })}
        >
          {node.detail.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
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
          ariaLabel: nodeName(node),
        })),
      ]
    : [];
  const groupNames = new Map(laid?.layout.groups.map((group) => [group.id, group.label]));
  // An end that is no node is a group.
  const end = (id: string) => (names.has(id) ? id : `group:${id}`);
  const edges: Edge[] = laid
    ? laid.layout.edges.map((edge): Edge<RouteData> => {
        const name = (id: string) => names.get(id) ?? groupNames.get(id);
        const values = { from: name(edge.from), to: name(edge.to) };
        const tone = kinds.get(edge.to);
        return {
          id: edge.id,
          source: end(edge.from),
          target: end(edge.to),
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
                  return toneOf((node.data as CardData).node) ?? 'var(--mu)';
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
          {legend.colors.map(([color, count]) => (
            <li key={color} data-color={color}>
              <svg className="vis-gl-sw" viewBox="0 0 10 10" aria-hidden="true">
                <rect width={10} height={10} rx={2} />
              </svg>
              <span>{spec.colors?.[color]}</span>
              <span className="vis-gl-n">{count}</span>
            </li>
          ))}
          {legend.statuses.map(([status, count]) => (
            <li key={status}>
              <StatusDot status={status} className="vis-gl-st" />
              <span>{STATUS_NAME[status]}</span>
              <span className="vis-gl-n">{count}</span>
            </li>
          ))}
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
