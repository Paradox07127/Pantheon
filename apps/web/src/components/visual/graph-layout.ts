import type { ELK, ElkNode } from 'elkjs/lib/elk-api';
import type { VisualContent } from '@pantheon/domain';

type DrawnSpec = Extract<VisualContent, { kind: 'graph' }>['spec'];
/** A node drawn as other than a card; only diagrams read from mermaid give one. */
export type NodeShape = 'decision' | 'start' | 'end';
/** An edge may also end on a group, at its boundary. */
export type GraphSpec = Omit<DrawnSpec, 'nodes'> & {
  nodes: (DrawnSpec['nodes'][number] & { shape?: NodeShape })[];
};
export type NodeKind = NonNullable<GraphSpec['nodes'][number]['kind']>;
export type EdgeStyle = NonNullable<GraphSpec['edges'][number]['style']>;
export type Direction = NonNullable<GraphSpec['direction']>;

export interface Point {
  x: number;
  y: number;
}
export interface Box extends Point {
  width: number;
  height: number;
}
export interface LaidNode extends Box {
  id: string;
  label: string;
  kind?: NodeKind;
  shape?: NodeShape;
  sublabel?: string;
  /** The id of the innermost group the node is drawn in. */
  group?: string;
  sources?: string[];
}
export interface LaidGroup extends Box {
  id: string;
  label: string;
  /** Nodes inside it, nested groups' included. */
  members: number;
  /** 0 for a top-level group. */
  depth: number;
}
export interface LaidEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  style?: EdgeStyle;
  /** The graph also has the edge back; it is drawn with a head at each end. */
  both: boolean;
  /** The orthogonal route from the source's border to the target's. */
  points: Point[];
  label_box?: Box;
}
export interface GraphLayout {
  direction: Direction;
  width: number;
  height: number;
  nodes: LaidNode[];
  groups: LaidGroup[];
  edges: LaidEdge[];
}

/** Node card sizes in px: width bounds, one-line and two-line heights. */
const NODE = { min: 96, max: 240, one: 32, two: 44 } as const;
/** Room around the drawing inside its box. */
export const PAD = 16;
/** Text starts here in a card with a kind icon, else here. */
const TEXT_AT = { icon: 28, plain: 12 } as const;
const LABEL_HEIGHT = 18;
/** Room above a group's members for its label. */
const GROUP_HEAD = 32;
const GROUP_SIDE = 12;

/** Estimated advance of a run of text: wide (CJK) characters take a full em. */
const textWidth = (text: string, size: number, narrow: number): number =>
  [...text].reduce((width, c) => width + (c.charCodeAt(0) > 0x2e7f ? size : narrow), 0);

const nodeWidth = (node: GraphSpec['nodes'][number]): number => {
  const title = textWidth(node.label, 13, 7.6);
  const sub = node.sublabel ? textWidth(node.sublabel, 12, 7.2) : 0;
  const at = node.kind ? TEXT_AT.icon : TEXT_AT.plain;
  // The right padding, the hairline border on both sides and a pixel for rounding.
  const rest = 12 + 1 + 1;
  return Math.ceil(Math.min(NODE.max, Math.max(NODE.min, at + Math.max(title, sub) + rest)));
};

/** A start or end dot's diameter. */
const DOT = 10;
/** A decision diamond's height around one and two lines, and the height of those lines. */
const DIAMOND = { one: 48, two: 64, lines: { one: 20, two: 36 } } as const;

const nodeSize = (node: GraphSpec['nodes'][number]): { width: number; height: number } => {
  if (node.shape === 'start' || node.shape === 'end') return { width: DOT, height: DOT };
  if (node.shape !== 'decision')
    return { width: nodeWidth(node), height: node.sublabel ? NODE.two : NODE.one };
  const lines = node.sublabel ? 'two' : 'one';
  const text = Math.max(
    textWidth(node.label, 13, 7.6),
    node.sublabel ? textWidth(node.sublabel, 12, 7.2) : 0,
  );
  // The label's box, with 8px each side, keeps inside the diamond: its share of the diamond's
  // width and its share of the height add up to at most 1.
  const width = (text + 16) / (1 - DIAMOND.lines[lines] / DIAMOND[lines]);
  return {
    width: Math.ceil(Math.min(NODE.max, Math.max(NODE.min, width))),
    height: DIAMOND[lines],
  };
};

/**
 * Moves a route's end along its last run onto the outline of the diamond or dot it ends on; ELK
 * ends it on the node's box.
 */
function onOutline(end: Point, next: Point, node: LaidNode | undefined): Point {
  if (!node?.shape) return end;
  const [a, b] = [node.width / 2, node.height / 2];
  const [cx, cy] = [node.x + a, node.y + b];
  const level = Math.abs(end.y - next.y) < 0.5;
  // How far off the centre the run comes in, as a share of the half size across it, and how far
  // the outline reaches there.
  const off = Math.min(1, level ? Math.abs(end.y - cy) / b : Math.abs(end.x - cx) / a);
  const reach = node.shape === 'decision' ? 1 - off : Math.sqrt(1 - off * off);
  return level
    ? { x: cx + Math.sign(end.x - cx) * a * reach, y: end.y }
    : { x: end.x, y: cy + Math.sign(end.y - cy) * b * reach };
}

/** The largest zoom, at most 1, that shows the whole layout inside the box. */
export const fitZoom = (layout: { width: number; height: number }, room: Point): number =>
  Math.min(1, (room.x - PAD * 2) / layout.width, (room.y - PAD * 2) / layout.height);

const OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.spacing.nodeNodeBetweenLayers': '40',
  'elk.spacing.nodeNode': '16',
  'elk.spacing.edgeEdge': '12',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '12',
  'elk.spacing.edgeNode': '8',
  'elk.layered.spacing.edgeNodeBetweenLayers': '8',
  'elk.edgeLabels.placement': 'CENTER',
  // A label's own layer is the one where labels side by side take the least room.
  'org.eclipse.elk.layered.edgeLabels.centerLabelPlacementStrategy': 'SPACE_EFFICIENT_LAYER',
  // A cycle turns back at the edge that closes it on a walk from the sources, not at a path's start.
  'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'org.eclipse.elk.json.shapeCoords': 'ROOT',
  'org.eclipse.elk.json.edgeCoords': 'ROOT',
};

/** Each edge once; an edge back along an earlier one, with its label and style, is its second head. */
function mergeBack(edges: GraphSpec['edges']): Omit<LaidEdge, 'points'>[] {
  const merged: Omit<LaidEdge, 'points'>[] = [];
  edges.forEach((edge, index) => {
    const same = (other: Omit<LaidEdge, 'points'>) =>
      other.label === edge.label && other.style === edge.style;
    if (merged.some((m) => m.from === edge.from && m.to === edge.to && same(m))) return;
    const back = merged.find(
      (m) => m.from === edge.to && m.to === edge.from && m.from !== m.to && same(m),
    );
    if (back) back.both = true;
    else
      merged.push({
        id: String(index),
        from: edge.from,
        to: edge.to,
        both: false,
        ...(edge.label !== undefined && { label: edge.label }),
        ...(edge.style !== undefined && { style: edge.style }),
      });
  });
  return merged;
}

/** The groups as a forest: declared ones, then one top-level group per other name nodes give. */
function groupTree(spec: GraphSpec) {
  const declared = new Map((spec.groups ?? []).map((group) => [group.id, group]));
  const groups = new Map<string, { id: string; label: string; parent?: string }>(declared);
  for (const node of spec.nodes)
    if (node.group !== undefined && !groups.has(node.group))
      groups.set(node.group, { id: node.group, label: node.group });
  const members = new Map<string, number>();
  for (const node of spec.nodes) {
    // A parent that is missing or loops ends the walk; the spec check refuses both.
    const seen = new Set<string>();
    for (let at = node.group; at !== undefined && !seen.has(at); at = groups.get(at)?.parent) {
      seen.add(at);
      members.set(at, (members.get(at) ?? 0) + 1);
    }
  }
  return { groups, members };
}

/** Lays the graph out in one direction. */
async function layoutOnce(spec: GraphSpec, direction: Direction, elk: ELK): Promise<GraphLayout> {
  const { groups, members } = groupTree(spec);
  const edges = mergeBack(spec.edges);
  const shapes = new Map<string, ElkNode>();
  const root: ElkNode = {
    id: 'root',
    layoutOptions: {
      ...OPTIONS,
      'elk.direction': direction === 'LR' ? 'RIGHT' : 'DOWN',
      'elk.padding': '[top=0,left=0,bottom=0,right=0]',
    },
    children: [],
  };
  const groupShape = (id: string): ElkNode => {
    const key = `g:${id}`;
    const known = shapes.get(key);
    if (known) return known;
    const group = groups.get(id)!;
    const shape: ElkNode = {
      id: key,
      layoutOptions: {
        'elk.padding': `[top=${GROUP_HEAD},left=${GROUP_SIDE},bottom=${GROUP_SIDE},right=${GROUP_SIDE}]`,
      },
      children: [],
    };
    shapes.set(key, shape);
    const parent = group.parent !== undefined && members.has(group.parent) ? group.parent : null;
    (parent === null ? root : groupShape(parent)).children!.push(shape);
    return shape;
  };
  for (const node of spec.nodes) {
    const shape: ElkNode = { id: `n:${node.id}`, ...nodeSize(node) };
    (node.group === undefined ? root : groupShape(node.group)).children!.push(shape);
  }
  const ids = new Set(spec.nodes.map((node) => node.id));
  const end = (id: string) => (ids.has(id) ? `n:${id}` : `g:${id}`);
  root.edges = edges.map((edge) => ({
    id: `e:${edge.id}`,
    sources: [end(edge.from)],
    targets: [end(edge.to)],
    ...(edge.label !== undefined && {
      labels: [
        {
          id: `l:${edge.id}`,
          text: edge.label,
          width: Math.round(Math.min(NODE.max, textWidth(edge.label, 12, 6.8) + 14)),
          height: LABEL_HEIGHT,
          // On its edge, the route running under it.
          layoutOptions: { 'elk.edgeLabels.inline': 'true' },
        },
      ],
    }),
  }));
  const laid = await elk.layout(root);
  const at = new Map<string, ElkNode>();
  const depth = new Map<string, number>();
  const walk = (shape: ElkNode, level: number) => {
    for (const child of shape.children ?? []) {
      at.set(child.id, child);
      depth.set(child.id, level);
      walk(child, level + 1);
    }
  };
  walk(laid, 0);
  const box = (shape: Partial<Box>): Box => ({
    x: shape.x ?? 0,
    y: shape.y ?? 0,
    width: shape.width ?? 0,
    height: shape.height ?? 0,
  });
  const routes = new Map((laid.edges ?? []).map((edge) => [edge.id, edge]));
  const nodes: LaidNode[] = spec.nodes.map((node) => ({
    ...box(at.get(`n:${node.id}`)!),
    id: node.id,
    label: node.label,
    ...(node.kind !== undefined && { kind: node.kind }),
    ...(node.shape !== undefined && { shape: node.shape }),
    ...(node.sublabel !== undefined && { sublabel: node.sublabel }),
    ...(node.group !== undefined && { group: node.group }),
    ...(node.sources !== undefined && { sources: node.sources }),
  }));
  const shaped = new Map(nodes.filter((node) => node.shape).map((node) => [node.id, node]));
  return {
    direction,
    width: laid.width ?? 0,
    height: laid.height ?? 0,
    nodes,
    groups: [...groups.values()]
      .filter((group) => at.has(`g:${group.id}`))
      .map((group) => ({
        ...box(at.get(`g:${group.id}`)!),
        id: group.id,
        label: group.label,
        members: members.get(group.id) ?? 0,
        depth: depth.get(`g:${group.id}`)!,
      }))
      .sort((a, b) => a.depth - b.depth),
    edges: edges.map((edge) => {
      const route = routes.get(`e:${edge.id}`);
      const section = route?.sections?.[0];
      const label = route?.labels?.[0];
      const points = section
        ? [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]
        : [];
      if (points.length > 1) {
        const n = points.length;
        points[0] = onOutline(points[0]!, points[1]!, shaped.get(edge.from));
        points[n - 1] = onOutline(points[n - 1]!, points[n - 2]!, shaped.get(edge.to));
      }
      return {
        ...edge,
        points,
        ...(label && { label_box: box(label) }),
      };
    }),
  };
}

/** The other direction replaces the spec's when it fits the box at this many times the zoom. */
const OVERRIDE = 1.25;

/**
 * Lays the graph out with ELK's layered algorithm, both ways. Without a direction it keeps the one
 * that fits `room` (the box's width and height) at the larger zoom; with one, the other only when
 * that fits at `OVERRIDE` times the zoom or more.
 */
export async function layoutGraph(spec: GraphSpec, room: Point): Promise<GraphLayout> {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  const [across, down] = await Promise.all([
    layoutOnce(spec, 'LR', elk),
    layoutOnce(spec, 'TB', elk),
  ]);
  const [a, d] = [fitZoom(across, room), fitZoom(down, room)];
  if (spec.direction === 'LR') return d >= a * OVERRIDE ? down : across;
  if (spec.direction === 'TB') return a >= d * OVERRIDE ? across : down;
  if (Math.abs(a - d) > 1e-3) return a > d ? across : down;
  // Both fit as well: the one shaped more like the box.
  const misfit = (layout: GraphLayout) =>
    Math.abs(Math.log(layout.width / layout.height) - Math.log(room.x / room.y));
  return misfit(down) < misfit(across) ? down : across;
}
