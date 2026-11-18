import type { ELK, ElkNode } from 'elkjs/lib/elk-api';
import type { VisualContent } from '@pantheon/domain';

type DrawnSpec = Extract<VisualContent, { kind: 'graph' }>['spec'];
/** A node drawn as other than a card; only diagrams read from mermaid give one. */
export type NodeShape = 'decision' | 'start' | 'end';
/** An edge may also end on a group, at its boundary. */
export type GraphSpec = Omit<DrawnSpec, 'nodes'> & {
  nodes: (DrawnSpec['nodes'][number] & { shape?: NodeShape })[];
};
type GraphNode = GraphSpec['nodes'][number];
export type NodeKind = NonNullable<GraphNode['kind']>;
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
  icon?: GraphNode['icon'];
  color?: GraphNode['color'];
  status?: GraphNode['status'];
  detail?: string[];
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
/** Space between nodes side by side, and between layers. */
const GAP = 16;
const LAYER_GAP = 40;
/** Clear space around a label, and between a label and the ends of its route. */
const LABEL_CLEAR = 4;
const LABEL_END = 10;

/** Estimated advance of a run of text: wide (CJK) characters take a full em. */
const textWidth = (text: string, size: number, narrow: number): number =>
  [...text].reduce((width, c) => width + (c.charCodeAt(0) > 0x2e7f ? size : narrow), 0);

/** A detail line's height, and the room a status dot and its gap take before the title. */
export const DETAIL_LINE = 16;
const STATUS_DOT = 8 + 4;

/** The title's width, with the status dot before it. */
const titleWidth = (node: GraphSpec['nodes'][number]): number =>
  textWidth(node.label, 13, 7.6) + (node.status ? STATUS_DOT : 0);

const nodeWidth = (node: GraphSpec['nodes'][number]): number => {
  const title = titleWidth(node);
  const sub = node.sublabel ? textWidth(node.sublabel, 12, 7.2) : 0;
  const detail = (node.detail ?? []).map((line) => textWidth(line, 12, 6.8));
  const at = node.kind || node.icon ? TEXT_AT.icon : TEXT_AT.plain;
  // The right padding, the hairline border on both sides and a pixel for rounding.
  const rest = 12 + 1 + 1;
  return Math.ceil(
    Math.min(NODE.max, Math.max(NODE.min, at + Math.max(title, sub, ...detail) + rest)),
  );
};

/** The widest an edge label's pill grows, and how far apart its lines are. */
const LABEL_MAX = 160;
export const LABEL_LINE = 16;
/** A label's pill around its 12px text: 6px each side and a pixel for its border. */
const LABEL_SIDE = 14;
const labelText = (text: string): number => textWidth(text, 12, 6.8);

/**
 * An edge label's lines: its words filled into the widest pill, a word wider than that cut where it
 * runs out; past two lines the second ends in an ellipsis.
 */
export function labelLines(text: string): string[] {
  const fits = (line: string) => labelText(line) + LABEL_SIDE <= LABEL_MAX;
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (fits(next)) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    let rest = [...word];
    while (!fits(rest.join(''))) {
      let k = rest.length - 1;
      while (k > 1 && !fits(rest.slice(0, k).join(''))) k--;
      lines.push(rest.slice(0, k).join(''));
      rest = rest.slice(k);
    }
    line = rest.join('');
  }
  lines.push(line);
  if (lines.length <= 2) return lines;
  const tail = [...lines.slice(1).join(' ')];
  while (tail.length && !fits(`${tail.join('').trimEnd()}…`)) tail.pop();
  return [lines[0]!, `${tail.join('').trimEnd()}…`];
}

const labelSize = (text: string): { width: number; height: number } => {
  const lines = labelLines(text);
  return {
    width: Math.round(Math.max(...lines.map(labelText)) + LABEL_SIDE),
    height: LABEL_HEIGHT + (lines.length - 1) * LABEL_LINE,
  };
};

/** A start or end dot's diameter. */
const DOT = 10;
/** A decision diamond's height around one and two lines, and the height of those lines. */
const DIAMOND = { one: 48, two: 64, lines: { one: 20, two: 36 } } as const;

const nodeSize = (node: GraphSpec['nodes'][number]): { width: number; height: number } => {
  if (node.shape === 'start' || node.shape === 'end') return { width: DOT, height: DOT };
  if (node.shape !== 'decision')
    return {
      width: nodeWidth(node),
      height: (node.sublabel ? NODE.two : NODE.one) + (node.detail?.length ?? 0) * DETAIL_LINE,
    };
  const lines = node.sublabel ? 'two' : 'one';
  const text = Math.max(titleWidth(node), node.sublabel ? textWidth(node.sublabel, 12, 7.2) : 0);
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

/** Fitting shrinks a graph no further than this, where 12px labels still read at 8px. */
export const FLOOR = 2 / 3;

/** The largest zoom, at most 1, that shows the whole layout inside the box. */
export const fitZoom = (layout: { width: number; height: number }, room: Point): number =>
  Math.min(1, (room.x - PAD * 2) / layout.width, (room.y - PAD * 2) / layout.height);

const OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.spacing.nodeNodeBetweenLayers': String(LAYER_GAP),
  'elk.spacing.nodeNode': String(GAP),
  'elk.spacing.edgeEdge': '12',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '12',
  'elk.spacing.edgeNode': '8',
  'elk.layered.spacing.edgeNodeBetweenLayers': '8',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.padding': '[top=0,left=0,bottom=0,right=0]',
  'org.eclipse.elk.json.shapeCoords': 'ROOT',
  'org.eclipse.elk.json.edgeCoords': 'ROOT',
};
/** The first run picks the layers, their order and straight runs. */
const FREE: Record<string, string> = {
  // A cycle turns back at the edge that ties its strongly connected part to the rest least.
  'elk.layered.cycleBreaking.strategy': 'SCC_CONNECTIVITY',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.nodePlacement.bk.edgeStraightening': 'IMPROVE_STRAIGHTNESS',
};
/** A second run keeps the nodes where they were put and routes the edges between them. */
const FIXED: Record<string, string> = {
  'elk.layered.cycleBreaking.strategy': 'INTERACTIVE',
  'elk.layered.layering.strategy': 'INTERACTIVE',
  'elk.layered.crossingMinimization.strategy': 'INTERACTIVE',
  'elk.layered.nodePlacement.strategy': 'INTERACTIVE',
};
/** With an edge on a group, ELK lays the groups out as nested graphs and routes to their edges. */
const NESTED: Record<string, string> = {
  ...FREE,
  // A cycle turns back at the edge that closes it on a walk from the sources, not at a path's start.
  'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
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

type Groups = ReturnType<typeof groupTree>;

/** The groups as a forest: declared ones, then one top-level group per other name nodes give. */
function groupTree(spec: GraphSpec) {
  const declared = new Map((spec.groups ?? []).map((group) => [group.id, group]));
  const groups = new Map<string, { id: string; label: string; parent?: string }>(declared);
  for (const node of spec.nodes)
    if (node.group !== undefined && !groups.has(node.group))
      groups.set(node.group, { id: node.group, label: node.group });
  const members = new Map<string, number>();
  const chains = new Map<string, string[]>();
  for (const node of spec.nodes) {
    // A parent that is missing or loops ends the walk; the spec check refuses both.
    const seen: string[] = [];
    for (let at = node.group; at !== undefined && !seen.includes(at); at = groups.get(at)?.parent) {
      seen.push(at);
      members.set(at, (members.get(at) ?? 0) + 1);
    }
    chains.set(node.id, seen);
  }
  /** The group a group is drawn in, or null for a top-level one. */
  const parent = (id: string): string | null => {
    const up = groups.get(id)?.parent;
    return up !== undefined && members.has(up) ? up : null;
  };
  return { groups, members, chains, parent };
}

/**
 * When the top-level groups are stages of one flow, each one's place along it: every node is in a
 * group, the groups line up in one order, and two edges in three between groups go to the next.
 */
function stageOrder(spec: GraphSpec, tree: Groups): Map<string, number> | undefined {
  const top = (id: string | undefined) =>
    id === undefined ? undefined : tree.chains.get(id)?.at(-1);
  const tops = [...new Set(spec.nodes.map((node) => top(node.id)))];
  if (tops.length < 2 || tops.includes(undefined)) return undefined;
  const index = new Map(tops.map((id, i) => [id!, i]));
  const between = spec.edges.flatMap((edge) => {
    const [from, to] = [top(edge.from), top(edge.to)];
    return edge.style === 'return' || !from || !to || from === to ? [] : [[from, to] as const];
  });
  const rank = new Map(tops.map((id) => [id!, 0]));
  for (const id of tops)
    for (const [from, to] of between)
      if (from === id && index.get(to)! > index.get(from)!)
        rank.set(to, Math.max(rank.get(to)!, rank.get(from)! + 1));
  if (new Set(rank.values()).size !== tops.length) return undefined;
  const next = between.filter(([from, to]) => rank.get(to) === rank.get(from)! + 1).length;
  return next * 3 >= between.length * 2 ? rank : undefined;
}

/** The drawing with its flow running down; a layout across is turned into this frame and back. */
interface Drawing {
  /** Turned from a layout across. */
  across: boolean;
  nodes: LaidNode[];
  groups: LaidGroup[];
  edges: LaidEdge[];
}

/** A group's room around its members in that frame: its label stays on top as drawn. */
type Padding = { before: number; after: number; left: number; right: number };
const padding = (across: boolean): Padding =>
  across
    ? { before: GROUP_SIDE, after: GROUP_SIDE, left: GROUP_HEAD, right: GROUP_SIDE }
    : { before: GROUP_HEAD, after: GROUP_SIDE, left: GROUP_SIDE, right: GROUP_SIDE };

const turn = (p: Point): Point => ({ x: p.y, y: p.x });
const turnBox = <T extends Box>(b: T): T => ({
  ...b,
  x: b.y,
  y: b.x,
  width: b.height,
  height: b.width,
});

/** Drops repeated points and points in the middle of a straight run. */
function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out.at(-1);
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    const before = out.at(-2);
    if (
      before &&
      last &&
      ((Math.abs(before.x - last.x) < 0.01 && Math.abs(last.x - p.x) < 0.01) ||
        (Math.abs(before.y - last.y) < 0.01 && Math.abs(last.y - p.y) < 0.01))
    )
      out.pop();
    out.push(p);
  }
  return out;
}

/** Nodes and routes of a laid-out ELK graph, in the frame where the flow runs down. */
function read(
  laid: ElkNode,
  spec: GraphSpec,
  edges: Omit<LaidEdge, 'points'>[],
  across: boolean,
): { nodes: LaidNode[]; edges: LaidEdge[]; at: Map<string, ElkNode>; depth: Map<string, number> } {
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
  const point = (p: Point): Point => (across ? turn(p) : { x: p.x, y: p.y });
  const routes = new Map((laid.edges ?? []).map((edge) => [edge.id, edge]));
  const nodes: LaidNode[] = spec.nodes.map((node) => {
    const shape = at.get(`n:${node.id}`)!;
    const box = {
      x: shape.x ?? 0,
      y: shape.y ?? 0,
      width: shape.width ?? 0,
      height: shape.height ?? 0,
    };
    return {
      ...(across ? turnBox(box) : box),
      id: node.id,
      label: node.label,
      ...(node.kind !== undefined && { kind: node.kind }),
      ...(node.shape !== undefined && { shape: node.shape }),
      ...(node.sublabel !== undefined && { sublabel: node.sublabel }),
      ...(node.icon !== undefined && { icon: node.icon }),
      ...(node.color !== undefined && { color: node.color }),
      ...(node.status !== undefined && { status: node.status }),
      ...(node.detail !== undefined && { detail: node.detail }),
      ...(node.group !== undefined && { group: node.group }),
      ...(node.sources !== undefined && { sources: node.sources }),
    };
  });
  return {
    nodes,
    at,
    depth,
    edges: edges.map((edge) => {
      const section = routes.get(`e:${edge.id}`)?.sections?.[0];
      const points = section
        ? simplify([section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map(point))
        : [];
      return { ...edge, points };
    }),
  };
}

/** Each node's layer: nodes whose extents along the flow overlap share one. */
function layersOf(nodes: Box[]): number[] {
  const order = nodes.map((_, i) => i).sort((a, b) => nodes[a]!.y - nodes[b]!.y);
  const layer = nodes.map(() => 0);
  let index = -1;
  let bottom = -Infinity;
  for (const i of order) {
    const node = nodes[i]!;
    if (node.y >= bottom) {
      index++;
      bottom = node.y + node.height;
    } else bottom = Math.max(bottom, node.y + node.height);
    layer[i] = index;
  }
  return layer;
}

/** Nodes, or a group's members, side by side: the layers they span and where each sits in them. */
interface Block {
  lo: number;
  hi: number;
  width: number;
  /** Each node's offset from the block's left. */
  at: Map<string, number>;
  want: number;
}

/**
 * Lefts for blocks, in the order of their wanted centres, as near their wanted lefts as blocks that
 * share a layer allow: pushed right, pushed left, then the mean of the two pushed right again.
 */
function place(blocks: Block[]): number[] {
  const order = blocks
    .map((_, i) => i)
    .sort(
      (a, b) => blocks[a]!.want + blocks[a]!.width / 2 - blocks[b]!.want - blocks[b]!.width / 2,
    );
  const span = (block: Block) =>
    Array.from({ length: block.hi - block.lo + 1 }, (_, k) => block.lo + k);
  const right = (want: (i: number) => number) => {
    const lefts: number[] = [];
    const edge = new Map<number, number>();
    for (const i of order) {
      const block = blocks[i]!;
      const left = Math.max(want(i), ...span(block).map((k) => (edge.get(k) ?? -Infinity) + GAP));
      lefts[i] = left;
      for (const k of span(block)) edge.set(k, left + block.width);
    }
    return lefts;
  };
  const pushed = right((i) => blocks[i]!.want);
  const pulled: number[] = [];
  const edge = new Map<number, number>();
  for (const i of [...order].reverse()) {
    const block = blocks[i]!;
    const end = Math.min(
      block.want + block.width,
      ...span(block).map((k) => (edge.get(k) ?? Infinity) - GAP),
    );
    pulled[i] = end - block.width;
    for (const k of span(block)) edge.set(k, pulled[i]!);
  }
  return right((i) => (pushed[i]! + pulled[i]!) / 2);
}

/** The groups drawn directly in each group, and in the graph under `null`. */
function innerGroups(tree: Groups): Map<string | null, string[]> {
  const inner = new Map<string | null, string[]>();
  for (const id of tree.groups.keys())
    if (tree.members.has(id))
      inner.set(tree.parent(id), [...(inner.get(tree.parent(id)) ?? []), id]);
  return inner;
}

/**
 * The nodes in an order that keeps each group's members together: a group's nodes and inner groups
 * by their mean place across the flow, each inner group's members in their own such order.
 */
function groupOrder(
  spec: GraphSpec,
  tree: Groups,
  nodes: LaidNode[],
  layer: number[],
  edges: Omit<LaidEdge, 'points'>[],
  pad: Padding,
): number[] {
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const inner = innerGroups(tree);
  type Part = { id: string; group: boolean; ids: string[] };
  const parts = new Map<string | null, Part[]>();
  const centre = (ids: string[]) =>
    ids.reduce((sum, id) => sum + nodes[index.get(id)!]!.x + nodes[index.get(id)!]!.width / 2, 0) /
    ids.length;
  const build = (id: string | null): string[] => {
    const list: Part[] = [
      ...spec.nodes
        .filter((node) => (node.group ?? null) === id)
        .map((node) => ({ id: node.id, group: false, ids: [node.id] })),
      ...(inner.get(id) ?? []).map((group) => ({ id: group, group: true, ids: build(group) })),
    ]
      .map((part) => ({ part, at: centre(part.ids) }))
      .sort((a, b) => a.at - b.at)
      .map(({ part }) => part);
    parts.set(id, list);
    return list.flatMap((part) => part.ids);
  };
  build(null);
  const sequence = (id: string | null): string[] =>
    parts.get(id)!.flatMap((part) => (part.group ? sequence(part.id) : [part.id]));
  // Each part packed from the left in its order: a group as one box over the layers it spans.
  const packed = (id: string | null): Block => {
    const blocks = parts.get(id)!.map((part): Block => {
      if (part.group) return packed(part.id);
      const i = index.get(part.id)!;
      return {
        lo: layer[i]!,
        hi: layer[i]!,
        width: nodes[i]!.width,
        at: new Map([[part.id, 0]]),
        want: 0,
      };
    });
    const [start, end] = id === null ? [0, 0] : [pad.left, pad.right];
    const edge = new Map<number, number>();
    const at = new Map<string, number>();
    let width = 0;
    for (const block of blocks) {
      let left = start;
      for (let k = block.lo; k <= block.hi; k++)
        left = Math.max(left, (edge.get(k) ?? -Infinity) + GAP);
      for (let k = block.lo; k <= block.hi; k++) edge.set(k, left + block.width);
      for (const [node, offset] of block.at) at.set(node, left + offset);
      width = Math.max(width, left + block.width + end);
    }
    return {
      lo: Math.min(...blocks.map((b) => b.lo)),
      hi: Math.max(...blocks.map((b) => b.hi)),
      width,
      at,
      want: 0,
    };
  };
  const centres = () =>
    new Map(
      [...packed(null).at].map(([id, at]) => [id, at + nodes[index.get(id)!]!.width / 2] as const),
    );
  // Crossings of the edges drawn straight between the nodes so packed, then their length across.
  const crossings = (): number => {
    const x = centres();
    const lines = edges
      .map((edge) => {
        const [a, b] = [index.get(edge.from)!, index.get(edge.to)!];
        return { a, b, x1: x.get(edge.from)!, y1: layer[a]!, x2: x.get(edge.to)!, y2: layer[b]! };
      })
      .filter((line) => line.y1 !== line.y2);
    const side = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) =>
      Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
    let count = 0;
    lines.forEach((p, i) => {
      for (const q of lines.slice(i + 1)) {
        if (p.a === q.a || p.a === q.b || p.b === q.a || p.b === q.b) continue;
        const d1 = side(p.x1, p.y1, p.x2, p.y2, q.x1, q.y1);
        const d2 = side(p.x1, p.y1, p.x2, p.y2, q.x2, q.y2);
        const d3 = side(q.x1, q.y1, q.x2, q.y2, p.x1, p.y1);
        const d4 = side(q.x1, q.y1, q.x2, q.y2, p.x2, p.y2);
        if (d1 * d2 < 0 && d3 * d4 < 0) count++;
      }
    });
    return count * 1e6 + lines.reduce((sum, line) => sum + Math.abs(line.x1 - line.x2), 0);
  };
  // Sweeps that sort each group's parts by the mean place of what they link to outside them.
  const neighbours = new Map<string, string[]>();
  for (const edge of edges) {
    neighbours.set(edge.from, [...(neighbours.get(edge.from) ?? []), edge.to]);
    neighbours.set(edge.to, [...(neighbours.get(edge.to) ?? []), edge.from]);
  }
  let best = crossings();
  let kept = new Map([...parts].map(([id, list]) => [id, [...list]]));
  for (let sweep = 0; sweep < 6; sweep++) {
    const x = centres();
    for (const list of parts.values()) {
      const pull = new Map(
        list.map((part) => {
          const inside = new Set(part.ids);
          const out = part.ids
            .flatMap((id) => neighbours.get(id) ?? [])
            .filter((id) => !inside.has(id));
          const at = (ids: string[]) => ids.reduce((sum, id) => sum + x.get(id)!, 0) / ids.length;
          return [part, out.length ? at(out) : at(part.ids)] as const;
        }),
      );
      list.sort((a, b) => pull.get(a)! - pull.get(b)!);
    }
    const cost = crossings();
    if (cost < best) {
      best = cost;
      kept = new Map([...parts].map(([id, list]) => [id, [...list]]));
    }
  }
  for (const [id, list] of kept) parts.set(id, list);
  // Each group moves to the place among its siblings where fewest edges cross, while that helps.
  for (const list of parts.values()) {
    if (!list.some((part) => part.group)) continue;
    for (let round = 0, better = true; better && round < 4; round++) {
      better = false;
      for (const part of list.filter((p) => p.group)) {
        const from = list.indexOf(part);
        for (let to = 0; to < list.length; to++) {
          if (to === from) continue;
          list.splice(list.indexOf(part), 1);
          list.splice(to, 0, part);
          const count = crossings();
          if (count < best) {
            best = count;
            better = true;
            break;
          }
          list.splice(list.indexOf(part), 1);
          list.splice(from, 0, part);
        }
      }
    }
  }
  const rank = new Map(sequence(null).map((id, i) => [id, i]));
  return nodes.map((node) => rank.get(node.id)!);
}

/**
 * New places across the flow that keep each group's members together, its box clear of nodes and
 * boxes it does not hold, and every node as near where ELK put it as that allows.
 */
function packAcross(
  spec: GraphSpec,
  tree: Groups,
  nodes: LaidNode[],
  layer: number[],
  pad: Padding,
): number[] {
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const inner = innerGroups(tree);
  const pack = (id: string | null): Block => {
    const blocks: Block[] = [
      ...spec.nodes
        .filter((node) => (node.group ?? null) === id)
        .map((node) => {
          const i = index.get(node.id)!;
          return {
            lo: layer[i]!,
            hi: layer[i]!,
            width: nodes[i]!.width,
            at: new Map([[node.id, 0]]),
            want: nodes[i]!.x,
          };
        }),
      ...(inner.get(id) ?? []).map(pack),
    ];
    const lefts = place(blocks);
    const [start, end] = id === null ? [0, 0] : [pad.left, pad.right];
    const min = Math.min(...lefts) - start;
    const at = new Map<string, number>();
    blocks.forEach((block, i) => {
      for (const [node, offset] of block.at) at.set(node, lefts[i]! + offset - min);
    });
    const shift = [...at].map(([node, offset]) => nodes[index.get(node)!]!.x - offset);
    return {
      lo: Math.min(...blocks.map((block) => block.lo)),
      hi: Math.max(...blocks.map((block) => block.hi)),
      width: Math.max(...blocks.map((block, i) => lefts[i]! + block.width)) + end - min,
      at,
      want: shift.reduce((sum, x) => sum + x, 0) / shift.length,
    };
  };
  const all = pack(null);
  return nodes.map((node) => all.want + all.at.get(node.id)!);
}

type Run = readonly [Point, Point];
const runBox = ([p, q]: Run): Box => ({
  x: Math.min(p.x, q.x),
  y: Math.min(p.y, q.y),
  width: Math.abs(p.x - q.x),
  height: Math.abs(p.y - q.y),
});
/** Edges keep this far apart where they run side by side. */
const EDGE_GAP = 12;
/** And this far from nodes they pass. */
const EDGE_CLEAR = 8;

/**
 * What a route for `edge` costs among the others as they are: bends first, then crossings, then
 * length; Infinity when it runs into a node or alongside another route, or once over `limit`.
 */
function routeCost(drawing: Drawing, edge: LaidEdge) {
  const ends = new Set([edge.from, edge.to]);
  const blocks = [
    ...drawing.nodes.map((node) => {
      const by = ends.has(node.id) ? -1 : EDGE_CLEAR - 0.5;
      return [
        node.x - by,
        node.y - by,
        node.x + node.width + by,
        node.y + node.height + by,
      ] as const;
    }),
    ...drawing.groups.map((group) => {
      const line = title(group, drawing.across);
      const by = EDGE_CLEAR / 2;
      return [
        line.x - by,
        line.y - by,
        line.x + line.width + by,
        line.y + line.height + by,
      ] as const;
    }),
  ];
  const others = drawing.edges
    .filter((other) => other !== edge)
    .flatMap((other) => runs(other.points))
    .map(
      ([p, q]) =>
        [Math.min(p.x, q.x), Math.min(p.y, q.y), Math.max(p.x, q.x), Math.max(p.y, q.y)] as const,
    );
  return (points: Point[], limit = Infinity): number => {
    let total = (points.length - 2) * 1e7;
    for (let k = 1; k < points.length; k++) {
      const [p, q] = [points[k - 1]!, points[k]!];
      const [x0, y0] = [Math.min(p.x, q.x), Math.min(p.y, q.y)];
      const [x1, y1] = [Math.max(p.x, q.x), Math.max(p.y, q.y)];
      total += x1 - x0 + y1 - y0;
      for (const [a, b, c, d] of blocks) if (x0 < c && a < x1 && y0 < d && b < y1) return Infinity;
      const flat = y1 - y0 < 0.5;
      for (const [a, b, c, d] of others) {
        if (flat === d - b < 0.5) {
          // Side by side closer than the space between edges, over a shared stretch.
          const gap = flat ? Math.abs(b - y0) : Math.abs(a - x0);
          const shared = flat
            ? Math.min(x1, c) - Math.max(x0, a)
            : Math.min(y1, d) - Math.max(y0, b);
          if (gap < EDGE_GAP / 2 && shared > 0.5) return Infinity;
        } else if (
          flat
            ? a > x0 + 0.5 && a < x1 - 0.5 && y0 > b + 0.5 && y0 < d - 0.5
            : x0 > a + 0.5 && x0 < c - 0.5 && b > y0 + 0.5 && b < y1 - 0.5
        )
          total += 1e5;
      }
      if (total >= limit) return Infinity;
    }
    return total;
  };
}

/**
 * Other routes `edge` could take: a straight line where its ends face each other, one jog in a gap
 * between layers, from another place on either end's side when `ports`, two jogs around the
 * layers in between when `lanes`, and into the target's left or right side when `sides`. None for an edge on itself or one that does not leave and enter
 * its nodes upright.
 */
function routeOptions(
  drawing: Drawing,
  edge: LaidEdge,
  { ports, lanes, sides = false }: { ports: boolean; lanes: boolean; sides?: boolean },
): Point[][] {
  const source = drawing.nodes.find((node) => node.id === edge.from);
  const target = drawing.nodes.find((node) => node.id === edge.to);
  const { points } = edge;
  if (!source || !target || source === target || points.length < 2) return [];
  const [p, q] = [points[0]!, points.at(-1)!];
  if (Math.abs(points[1]!.x - p.x) > 0.5 || Math.abs(points.at(-2)!.x - q.x) > 0.5) return [];
  const [top, bottom] = [Math.min(p.y, q.y), Math.max(p.y, q.y)];
  const options: Point[][] = [];
  const lo = Math.max(source.x, target.x) + EDGE_CLEAR;
  const hi = Math.min(source.x + source.width, target.x + target.width) - EDGE_CLEAR;
  for (let x = lo; x <= hi; x += EDGE_GAP / 2)
    options.push([
      { x, y: p.y },
      { x, y: q.y },
    ]);
  // Places along the flow no node spans, where a run across can go.
  const ys: number[] = [];
  for (let y = top + EDGE_CLEAR; y <= bottom - EDGE_CLEAR; y += 4)
    if (!drawing.nodes.some((n) => n.y - EDGE_CLEAR < y && y < n.y + n.height + EDGE_CLEAR))
      ys.push(y);
  const side = (node: LaidNode, at: number) => {
    const xs = [at];
    if (ports)
      for (let x = node.x + EDGE_CLEAR; x <= node.x + node.width - EDGE_CLEAR; x += EDGE_GAP / 2)
        xs.push(x);
    return xs;
  };
  const jog = (from: number, to: number, y: number) => [
    { x: from, y: p.y },
    { x: from, y },
    { x: to, y },
    { x: to, y: q.y },
  ];
  for (const y of ys) {
    for (const x of side(source, p.x)) options.push(jog(x, q.x, y));
    for (const x of side(target, q.x)) if (x !== q.x) options.push(jog(p.x, x, y));
  }
  const near = (y: number, end: number) => Math.abs(y - end) < LAYER_GAP + EDGE_CLEAR * 2;
  if (lanes) {
    const xs = drawing.nodes
      .filter((node) => node.y > top && node.y + node.height < bottom)
      .flatMap((node) => [node.x - EDGE_GAP, node.x + node.width + EDGE_GAP]);
    for (const x of xs)
      for (const a of ys.filter((y) => near(y, p.y)))
        for (const b of ys.filter((y) => near(y, q.y)))
          options.push([p, { x: p.x, y: a }, { x, y: a }, { x, y: b }, { x: q.x, y: b }, q]);
  }
  // Into the target's side: from a lane beside it, or from a corner of the route beside it.
  const tails: Point[][] = [];
  if (sides && !target.shape) {
    const middle = target.y + target.height / 2;
    const right = target.x + target.width;
    for (const y of [middle, middle - EDGE_CLEAR, middle + EDGE_CLEAR]) {
      for (const [x, end] of [
        [target.x - EDGE_GAP, target.x],
        [right + EDGE_GAP, right],
      ] as const)
        for (const a of ys.filter((at) => near(at, p.y)))
          options.push([p, { x: p.x, y: a }, { x, y: a }, { x, y }, { x: end, y }]);
      for (const [k, { x }] of points.slice(0, -1).entries())
        if (k > 0 && (x < target.x || x > right))
          tails.push([
            ...points.slice(0, k + 1),
            { x, y },
            { x: x < target.x ? target.x : right, y },
          ]);
    }
  }
  const down = q.y > p.y;
  return [
    ...options.map(simplify).filter((o) => o.length >= 2 && o[1]!.y > o[0]!.y === down),
    ...tails.map(simplify),
  ];
}

/**
 * Replaces each route by the cheapest clear one of its options, edges with the most bends first;
 * then lets two single-jog routes from or to the same side of a node trade their places on it,
 * their jogs or both where that is cheaper; until no route changes.
 */
function straighten(drawing: Drawing) {
  const total = (edges: LaidEdge[]) =>
    edges.reduce((sum, edge) => sum + routeCost(drawing, edge)(edge.points), 0);
  for (let round = 0, changed = true; changed && round < 4; round++) {
    changed = false;
    for (const edge of [...drawing.edges].sort((a, b) => b.points.length - a.points.length)) {
      const bends = edge.points.length - 2;
      if (bends <= 0) continue;
      const cost = routeCost(drawing, edge);
      const now = cost(edge.points);
      const crossed = Math.floor((now % 1e7) / 1e5) > 0;
      let best = { points: edge.points, cost: now };
      for (const option of routeOptions(drawing, edge, { ports: crossed, lanes: bends > 3 })) {
        const c = cost(option, best.cost);
        if (c < best.cost - 0.5) best = { points: option, cost: c };
      }
      if (best.points !== edge.points) {
        edge.points = best.points;
        changed = true;
      }
    }
    const jogs = drawing.edges.filter((edge) => edge.points.length === 4);
    for (const [i, a] of jogs.entries())
      for (const b of jogs.slice(i + 1)) {
        const [pa, pb] = [a.points, b.points];
        const down = (points: Point[]) => points[1]!.y > points[0]!.y;
        if (down(pa) !== down(pb)) continue;
        // The end the two share: 0 for the source, 3 for the target.
        const end = a.from === b.from ? 0 : a.to === b.to ? 3 : -1;
        if (end < 0) continue;
        const next = end === 0 ? 1 : 2;
        const before = total([a, b]);
        const trade = (port: boolean, jog: boolean) => {
          const make = (own: Point[], other: Point[]) => {
            const points = own.map((p) => ({ ...p }));
            if (port) points[end]!.x = points[next]!.x = other[end]!.x;
            if (jog) points[1]!.y = points[2]!.y = other[1]!.y;
            return points;
          };
          return [make(pa, pb), make(pb, pa)] as const;
        };
        let best = { cost: before, points: [pa, pb] as readonly [Point[], Point[]] };
        for (const [port, jog] of [
          [true, false],
          [false, true],
          [true, true],
        ] as const) {
          const points = trade(port, jog);
          [a.points, b.points] = points;
          const after = total([a, b]);
          if (after < best.cost - 0.5) best = { cost: after, points };
        }
        [a.points, b.points] = best.points;
        if (best.points[0] !== pa) changed = true;
      }
  }
}

/**
 * Moves each route that runs through a node other than its ends or through a group's label line to
 * its cheapest clear option, where it has one; a second round lets the moved ones settle among each
 * other. Returns the edges moved.
 */
function unblock(drawing: Drawing): LaidEdge[] {
  // A moved edge's options are still its first route's.
  const moved = new Map<LaidEdge, Point[]>();
  for (let round = 0; round < 2; round++)
    for (const edge of drawing.edges) {
      const through = routeCost({ ...drawing, edges: [edge] }, edge)(edge.points) === Infinity;
      if (!through && !(round > 0 && moved.has(edge))) continue;
      const cost = routeCost(drawing, edge);
      let best = { points: edge.points, cost: through ? Infinity : cost(edge.points) };
      const first = { ...edge, points: moved.get(edge) ?? edge.points };
      for (const option of routeOptions(drawing, first, {
        ports: true,
        lanes: true,
        sides: true,
      })) {
        const c = cost(option, best.cost);
        if (c < best.cost - 0.5) best = { points: option, cost: c };
      }
      if (best.points === edge.points) continue;
      if (!moved.has(edge)) moved.set(edge, edge.points);
      edge.points = best.points;
    }
  return [...moved.keys()];
}

/** Opens `by` px along the flow at `at`: what lies past it moves on, what spans it grows. */
function stretch(drawing: Drawing, at: number, by: number) {
  const move = (y: number) => (y > at ? y + by : y);
  for (const node of drawing.nodes) node.y = move(node.y);
  for (const group of drawing.groups) {
    const bottom = move(group.y + group.height);
    group.y = move(group.y);
    group.height = bottom - group.y;
  }
  for (const edge of drawing.edges) {
    for (const p of edge.points) p.y = move(p.y);
    const box = edge.label_box;
    if (box && box.y + box.height / 2 > at) box.y += by;
  }
}

/** Each group's box around its members and inner groups' boxes, with room for its label on top. */
function groupBoxes(tree: Groups, nodes: LaidNode[], pad: Padding): LaidGroup[] {
  const boxes = new Map<string, Box>();
  const depthOf = (id: string): number => {
    const up = tree.parent(id);
    return up === null ? 0 : depthOf(up) + 1;
  };
  const ids = [...tree.groups.keys()].filter((id) => tree.members.has(id));
  // Inner groups first: the deeper, the sooner.
  for (const id of ids.sort((a, b) => depthOf(b) - depthOf(a))) {
    const parts: Box[] = [
      ...nodes.filter((node) => node.group === id),
      ...ids.filter((other) => tree.parent(other) === id).map((other) => boxes.get(other)!),
    ];
    const x = Math.min(...parts.map((b) => b.x)) - pad.left;
    const y = Math.min(...parts.map((b) => b.y)) - pad.before;
    boxes.set(id, {
      x,
      y,
      width: Math.max(...parts.map((b) => b.x + b.width)) + pad.right - x,
      height: Math.max(...parts.map((b) => b.y + b.height)) + pad.after - y,
    });
  }
  return [...tree.groups.values()]
    .filter((group) => boxes.has(group.id))
    .map((group) => ({
      ...boxes.get(group.id)!,
      id: group.id,
      label: group.label,
      members: tree.members.get(group.id)!,
      depth: depthOf(group.id),
    }))
    .sort((a, b) => a.depth - b.depth);
}

/**
 * Lays the nodes out without their groups, so a group spans the layers its members are in, then
 * moves nodes across the flow so that each group's box holds only its own, and opens room along the
 * flow for the boxes' labels and edges.
 */
async function flatLayout(
  spec: GraphSpec,
  edges: Omit<LaidEdge, 'points'>[],
  tree: Groups,
  across: boolean,
  elk: ELK,
): Promise<Drawing> {
  const stages = stageOrder(spec, tree);
  // Each run: where nodes sit across the flow (kept by the last), the rank each keeps in its
  // layer and the layer it keeps (the second), or the stage it keeps to (the first).
  const graph = (
    options: Record<string, string>,
    keep: { at?: Point[]; rank?: number[]; layer?: number[] } = {},
  ): ElkNode => {
    const part = (i: number) =>
      keep.layer?.[i] ??
      (keep.at ? undefined : stages?.get(tree.chains.get(spec.nodes[i]!.id)?.at(-1) ?? ''));
    const parted = spec.nodes.some((_, i) => part(i) !== undefined);
    return {
      id: 'root',
      layoutOptions: {
        ...OPTIONS,
        ...options,
        'elk.direction': across ? 'RIGHT' : 'DOWN',
        // A node with no edges keeps to its part only when it is laid out with the rest.
        ...(parted && {
          'elk.partitioning.activate': 'true',
          'elk.separateConnectedComponents': 'false',
        }),
        ...(keep.rank && { 'elk.layered.crossingMinimization.semiInteractive': 'true' }),
      },
      children: spec.nodes.map((node, i) => {
        const p = keep.at?.[i];
        const r = keep.rank?.[i];
        return {
          id: `n:${node.id}`,
          ...nodeSize(node),
          ...(p && (across ? turn(p) : p)),
          layoutOptions: {
            ...(part(i) !== undefined && { 'elk.partitioning.partition': String(part(i)) }),
            ...(r !== undefined && { 'elk.position': across ? `(0,${r})` : `(${r},0)` }),
          },
        };
      }),
      // With its layers kept, a node lines up with its edges other than returns.
      edges: edges
        .filter((edge) => !keep.layer || edge.style !== 'return')
        .map((edge) => ({
          id: `e:${edge.id}`,
          sources: [`n:${edge.from}`],
          targets: [`n:${edge.to}`],
        })),
    };
  };
  const pad = padding(across);
  let laid = read(await elk.layout(graph(FREE)), spec, edges, across);
  const layer = layersOf(laid.nodes);
  const returns = edges.some((edge) => edge.style === 'return');
  if (tree.members.size > 0 || returns) {
    const rank = groupOrder(spec, tree, laid.nodes, layer, edges, pad);
    laid = read(await elk.layout(graph(FREE, { rank, layer })), spec, edges, across);
  }
  const xs = packAcross(spec, tree, laid.nodes, layer, pad);
  if (returns || laid.nodes.some((node, i) => Math.abs(node.x - xs[i]!) > 0.5))
    laid = read(
      await elk.layout(
        graph(FIXED, { at: laid.nodes.map((node, i) => ({ x: xs[i]!, y: node.y })) }),
      ),
      spec,
      edges,
      across,
    );
  const drawing: Drawing = { nodes: laid.nodes, groups: [], edges: laid.edges, across };
  straighten(drawing);
  // How many group labels start at each layer and how many group bottoms end there.
  const range = new Map<string, [number, number]>();
  laid.nodes.forEach((node, i) => {
    for (const id of tree.chains.get(node.id) ?? []) {
      const [lo, hi] = range.get(id) ?? [Infinity, -Infinity];
      range.set(id, [Math.min(lo, layer[i]!), Math.max(hi, layer[i]!)]);
    }
  });
  const cuts: { at: number; by: number }[] = [];
  const count = layer.reduce((most, l) => Math.max(most, l + 1), 0);
  for (let l = 0; l < count; l++) {
    const inLayer = laid.nodes.filter((_, i) => layer[i] === l);
    const chains = inLayer.map((node) => tree.chains.get(node.id) ?? []);
    const heads = Math.max(...chains.map((c) => c.filter((id) => range.get(id)![0] === l).length));
    const feet = Math.max(...chains.map((c) => c.filter((id) => range.get(id)![1] === l).length));
    const top = Math.min(...inLayer.map((node) => node.y));
    const bottom = Math.max(...inLayer.map((node) => node.y + node.height));
    if (heads) cuts.push({ at: top - 0.5, by: heads * pad.before });
    if (feet) cuts.push({ at: bottom + 0.5, by: feet * pad.after });
  }
  for (const cut of cuts.sort((a, b) => b.at - a.at)) stretch(drawing, cut.at, cut.by);
  drawing.groups = groupBoxes(tree, drawing.nodes, pad);
  return drawing;
}

/** Lays the groups out as nested graphs, so that ELK routes edges to a group's boundary. */
async function nestedLayout(
  spec: GraphSpec,
  edges: Omit<LaidEdge, 'points'>[],
  tree: Groups,
  across: boolean,
  elk: ELK,
): Promise<Drawing> {
  const shapes = new Map<string, ElkNode>();
  const root: ElkNode = {
    id: 'root',
    layoutOptions: { ...OPTIONS, ...NESTED, 'elk.direction': across ? 'RIGHT' : 'DOWN' },
    children: [],
  };
  const groupShape = (id: string): ElkNode => {
    const key = `g:${id}`;
    const known = shapes.get(key);
    if (known) return known;
    const shape: ElkNode = {
      id: key,
      layoutOptions: {
        'elk.padding': `[top=${GROUP_HEAD},left=${GROUP_SIDE},bottom=${GROUP_SIDE},right=${GROUP_SIDE}]`,
      },
      children: [],
    };
    shapes.set(key, shape);
    const parent = tree.parent(id);
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
  }));
  const laid = read(await elk.layout(root), spec, edges, across);
  return {
    across,
    nodes: laid.nodes,
    edges: laid.edges,
    groups: [...tree.groups.values()]
      .filter((group) => laid.at.has(`g:${group.id}`))
      .map((group) => {
        const shape = laid.at.get(`g:${group.id}`)!;
        const box = {
          x: shape.x ?? 0,
          y: shape.y ?? 0,
          width: shape.width ?? 0,
          height: shape.height ?? 0,
        };
        return {
          ...(across ? turnBox(box) : box),
          id: group.id,
          label: group.label,
          members: tree.members.get(group.id) ?? 0,
          depth: laid.depth.get(`g:${group.id}`)!,
        };
      })
      .sort((a, b) => a.depth - b.depth),
  };
}

const overlaps = (a: Box, b: Box, clear = 0) =>
  a.x < b.x + b.width + clear &&
  b.x < a.x + a.width + clear &&
  a.y < b.y + b.height + clear &&
  b.y < a.y + a.height + clear;

const runs = (points: Point[]) => points.slice(1).map((q, i) => [points[i]!, q] as const);

/** A group's label line, as the group box draws it at its top left: 12px text after 8px and 12px. */
function title(group: LaidGroup, across: boolean): Box {
  const width = textWidth(group.label, 12, 6.8) + 4 + 8 * String(group.members).length;
  return across
    ? { x: group.x + 8, y: group.y + 12, width: 16, height: width }
    : { x: group.x + 12, y: group.y + 8, width, height: 16 };
}

/** Something a label keeps clear of; a cut through a route's run along the flow lengthens it. */
interface Obstacle {
  box: Box;
  clear: number;
}

/** What a label on `edge` keeps clear of: nodes, group labels, other labels and routes, its route's ends. */
function obstacles(drawing: Drawing, edge: LaidEdge): Obstacle[] {
  return [
    ...drawing.nodes.map((node) => ({ box: node, clear: LABEL_CLEAR / 2 })),
    ...drawing.groups.map((group) => ({
      box: title(group, drawing.across),
      clear: LABEL_CLEAR / 2,
    })),
    ...drawing.edges
      .filter((other) => other !== edge)
      .flatMap((other) => [
        ...(other.label_box ? [{ box: other.label_box, clear: LABEL_CLEAR }] : []),
        ...runs(other.points).map((run) => ({ box: runBox(run), clear: 1 })),
      ]),
    ...[edge.points[0]!, edge.points.at(-1)!].map((p) => ({
      box: { ...p, width: 0, height: 0 },
      clear: LABEL_END,
    })),
  ];
}

const blocked = (box: Box, all: Obstacle[]) => all.some((o) => overlaps(box, o.box, o.clear));

/** Centres a label of `size` can take on a run, every 2px along it. */
function along([p, q]: Run, size: { width: number; height: number }): Box[] {
  const length = Math.hypot(q.x - p.x, q.y - p.y);
  const steps = Math.max(1, Math.floor(length / 2));
  return Array.from({ length: steps + 1 }, (_, k) => ({
    x: p.x + ((q.x - p.x) * k) / steps - size.width / 2,
    y: p.y + ((q.y - p.y) * k) / steps - size.height / 2,
    ...size,
  }));
}

/** The middle of the longest stretch of free places on one run of the route, if there is one. */
function freeSpot(drawing: Drawing, edge: LaidEdge, size: { width: number; height: number }) {
  const all = obstacles(drawing, edge);
  let best: { box: Box; length: number } | undefined;
  for (const run of runs(edge.points)) {
    let start = -1;
    const spots = along(run, size);
    spots.forEach((box, k) => {
      const ok = !blocked(box, all);
      if (ok && start < 0) start = k;
      if (start >= 0 && (!ok || k === spots.length - 1)) {
        const last = ok ? k : k - 1;
        if (!best || last - start > best.length)
          best = { box: spots[Math.floor((start + last) / 2)]!, length: last - start };
        start = -1;
      }
    });
  }
  return best?.box;
}

const copy = (drawing: Drawing): Drawing => ({
  across: drawing.across,
  nodes: drawing.nodes.map((node) => ({ ...node })),
  groups: drawing.groups.map((group) => ({ ...group })),
  edges: drawing.edges.map((edge) => ({
    ...edge,
    points: edge.points.map((p) => ({ ...p })),
    ...(edge.label_box && { label_box: { ...edge.label_box } }),
  })),
});

/**
 * Room for a label no free place takes, opened along the flow by exactly what is missing. On a run
 * along the flow, a cut through the run moves what lies past it on; on a run across, cuts just
 * before and after it open room on both sides. A cut goes through no node and no other route running
 * by the label, which would only grow with it.
 */
function makeRoom(drawing: Drawing, index: number, size: { width: number; height: number }) {
  const edge = drawing.edges[index]!;
  const all = obstacles(drawing, edge);
  const { width: w, height: h } = size;
  const open = (y: number) => !drawing.nodes.some((node) => node.y < y && y < node.y + node.height);
  const by = (x: number) =>
    all.filter((o) => o.box.x - o.clear < x + w / 2 && o.box.x + o.box.width + o.clear > x - w / 2);
  const top = (o: Obstacle) => o.box.y - o.clear;
  const bottom = (o: Obstacle) => o.box.y + o.box.height + o.clear;
  // A route's run along the flow, which a cut lengthens rather than parts.
  const grows = (o: Obstacle) => o.box.width < 0.5 && o.box.height > 0.5;
  const options: { missing: number; cuts: { at: number; by: number }[]; box: Box }[] = [];
  for (const [p, q] of runs(edge.points)) {
    if (Math.abs(p.x - q.x) < 0.5) {
      const [from, to] = [Math.min(p.y, q.y), Math.max(p.y, q.y)];
      const near = by(p.x);
      for (let at = from + 1; at < to; at += 2) {
        if (!open(at) || near.some((o) => grows(o) && top(o) < at && at < bottom(o))) continue;
        const stays = near.filter((o) => o.box.y + o.box.height / 2 <= at);
        const moves = near.filter((o) => o.box.y + o.box.height / 2 > at);
        // The label's centre keeps to the run: it starts no higher than half above the run's top.
        const start = Math.max(from - h / 2, ...stays.map(bottom));
        const end = Math.min(to + h / 2, ...moves.map(top));
        if (start > at || end < at) continue;
        const missing = Math.max(0, h - (end - start));
        options.push({
          missing,
          cuts: [{ at, by: missing }],
          box: { x: p.x - w / 2, y: start, width: w, height: h },
        });
      }
    } else if (open(p.y)) {
      const y = p.y;
      const [from, to] = [Math.min(p.x, q.x), Math.max(p.x, q.x)];
      for (let x = from; x <= to; x += 4) {
        const near = by(x);
        if (near.some((o) => grows(o) && top(o) < y && y < bottom(o))) continue;
        const above = Math.max(
          -Infinity,
          ...near.filter((o) => o.box.y + o.box.height / 2 < y).map(bottom),
        );
        const below = Math.min(
          Infinity,
          ...near.filter((o) => o.box.y + o.box.height / 2 > y).map(top),
        );
        if (near.some((o) => Math.abs(o.box.y + o.box.height / 2 - y) < 0.01)) continue;
        const up = Math.max(0, h / 2 - (y - above));
        const down = Math.max(0, h / 2 - (below - y));
        options.push({
          missing: up + down,
          cuts: [
            { at: y + 0.01, by: down },
            { at: y - 0.01, by: up },
          ],
          box: { x: x - w / 2, y: y + up - h / 2, width: w, height: h },
        });
      }
    }
  }
  options.sort((a, b) => a.missing - b.missing);
  for (const option of options) {
    const trial = copy(drawing);
    for (const cut of option.cuts) stretch(trial, cut.at, cut.by);
    if (blocked(option.box, obstacles(trial, trial.edges[index]!))) continue;
    for (const cut of option.cuts) stretch(drawing, cut.at, cut.by);
    return option.box;
  }
  return undefined;
}

/**
 * Puts each label on its route where it covers nothing, opening room along the flow where none is
 * free. Where its route has no such place, the edge takes the cheapest other clear route that has.
 */
function placeLabels(drawing: Drawing, across: boolean) {
  drawing.edges.forEach((edge, index) => {
    if (edge.label === undefined || edge.label_box || edge.points.length < 2) return;
    const { width, height } = labelSize(edge.label);
    const size = across ? { width: height, height: width } : { width, height };
    const place = () => freeSpot(drawing, edge, size) ?? makeRoom(drawing, index, size);
    let box = place();
    if (!box) {
      const cost = routeCost(drawing, edge);
      const kept = edge.points;
      const options = routeOptions(drawing, edge, { ports: true, lanes: true })
        .map((points) => ({ points, cost: cost(points) }))
        .filter((option) => option.cost < Infinity)
        .sort((a, b) => a.cost - b.cost);
      for (const option of options) {
        edge.points = option.points;
        box = place();
        if (box) break;
      }
      if (!box) edge.points = kept;
    }
    if (box) edge.label_box = box;
  });
}

/** ELK's own layout with the groups as nested graphs and the labels on their routes. */
const LAYERED: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.spacing.nodeNodeBetweenLayers': String(LAYER_GAP),
  'elk.spacing.nodeNode': String(GAP),
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
  'elk.padding': '[top=0,left=0,bottom=0,right=0]',
  'org.eclipse.elk.json.shapeCoords': 'ROOT',
  'org.eclipse.elk.json.edgeCoords': 'ROOT',
};

async function layeredLayout(
  spec: GraphSpec,
  direction: Direction,
  elk: ELK,
): Promise<GraphLayout> {
  const tree = groupTree(spec);
  const edges = mergeBack(spec.edges);
  const shapes = new Map<string, ElkNode>();
  const root: ElkNode = {
    id: 'root',
    layoutOptions: { ...LAYERED, 'elk.direction': direction === 'LR' ? 'RIGHT' : 'DOWN' },
    children: [],
  };
  const groupShape = (id: string): ElkNode => {
    const key = `g:${id}`;
    const known = shapes.get(key);
    if (known) return known;
    const shape: ElkNode = {
      id: key,
      layoutOptions: {
        'elk.padding': `[top=${GROUP_HEAD},left=${GROUP_SIDE},bottom=${GROUP_SIDE},right=${GROUP_SIDE}]`,
      },
      children: [],
    };
    shapes.set(key, shape);
    const parent = tree.parent(id);
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
          ...labelSize(edge.label),
          // On its edge, the route running under it.
          layoutOptions: { 'elk.edgeLabels.inline': 'true' },
        },
      ],
    }),
  }));
  const laid = await elk.layout(root);
  const read = new Map<string, ElkNode>();
  const depth = new Map<string, number>();
  const walk = (shape: ElkNode, level: number) => {
    for (const child of shape.children ?? []) {
      read.set(child.id, child);
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
    ...box(read.get(`n:${node.id}`)!),
    id: node.id,
    label: node.label,
    ...(node.kind !== undefined && { kind: node.kind }),
    ...(node.shape !== undefined && { shape: node.shape }),
    ...(node.sublabel !== undefined && { sublabel: node.sublabel }),
    ...(node.icon !== undefined && { icon: node.icon }),
    ...(node.color !== undefined && { color: node.color }),
    ...(node.status !== undefined && { status: node.status }),
    ...(node.detail !== undefined && { detail: node.detail }),
    ...(node.group !== undefined && { group: node.group }),
    ...(node.sources !== undefined && { sources: node.sources }),
  }));
  const shaped = new Map(nodes.filter((node) => node.shape).map((node) => [node.id, node]));
  const layout: GraphLayout = {
    direction,
    width: laid.width ?? 0,
    height: laid.height ?? 0,
    nodes,
    groups: [...tree.groups.values()]
      .filter((group) => read.has(`g:${group.id}`))
      .map((group) => ({
        ...box(read.get(`g:${group.id}`)!),
        id: group.id,
        label: group.label,
        members: tree.members.get(group.id) ?? 0,
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
      return { ...edge, points, ...(label && { label_box: box(label) }) };
    }),
  };
  // Routes through a node or a group's label line move, in the frame where the flow runs down, and
  // their labels move onto them.
  const across = direction === 'LR';
  const into = <T extends Box>(b: T): T => (across ? turnBox(b) : b);
  const drawing: Drawing = {
    across,
    nodes: layout.nodes.map(into),
    groups: layout.groups.map(into),
    edges: layout.edges.map((edge) => ({
      ...edge,
      points: edge.points.map((p) => (across ? turn(p) : p)),
      ...(edge.label_box && { label_box: into(edge.label_box) }),
    })),
  };
  for (const edge of unblock(drawing)) delete edge.label_box;
  placeLabels(drawing, across);
  const edgesOut = drawing.edges.map((edge) => ({
    ...edge,
    points: edge.points.map((p) => (across ? turn(p) : p)),
    ...(edge.label_box && { label_box: into(edge.label_box) }),
  }));
  const nodesOut = drawing.nodes.map(into);
  const groupsOut = drawing.groups.map(into);
  const boxes: Box[] = [
    ...nodesOut,
    ...groupsOut,
    ...edgesOut.flatMap((edge) => edge.label_box ?? []),
    ...edgesOut.flatMap((edge) => edge.points.map((p) => ({ ...p, width: 0, height: 0 }))),
  ];
  return {
    direction,
    width: Math.max(layout.width, ...boxes.map((b) => b.x + b.width)),
    height: Math.max(layout.height, ...boxes.map((b) => b.y + b.height)),
    nodes: nodesOut,
    groups: groupsOut,
    edges: edgesOut,
  };
}

/** A crossing reads as badly as this many bends. */
const CROSSING = 16;

/** A level run and an upright one that cross inside both. */
function crosses([a, b]: Run, [c, d]: Run): boolean {
  const level = (p: Point, q: Point) => Math.abs(p.y - q.y) < 0.5;
  if (level(a, b) === level(c, d)) return false;
  const [h, v] = level(a, b)
    ? [
        [a, b],
        [c, d],
      ]
    : [
        [c, d],
        [a, b],
      ];
  const [x, y] = [v[0]!.x, h[0]!.y];
  return (
    x > Math.min(h[0]!.x, h[1]!.x) + 0.5 &&
    x < Math.max(h[0]!.x, h[1]!.x) - 0.5 &&
    y > Math.min(v[0]!.y, v[1]!.y) + 0.5 &&
    y < Math.max(v[0]!.y, v[1]!.y) - 0.5
  );
}

/** How many times routes cross. */
function crossings(layout: GraphLayout): number {
  const all = layout.edges.map((edge) => runs(edge.points));
  return all.reduce(
    (sum, mine, i) =>
      sum +
      all
        .slice(i + 1)
        .reduce(
          (count, theirs) =>
            count + mine.reduce((n, r) => n + theirs.filter((s) => crosses(r, s)).length, 0),
          0,
        ),
    0,
  );
}

/** How hard the routes are to follow: routes through a node or a group's label, crossings, bends. */
function tangle(layout: GraphLayout): number {
  const drawing: Drawing = { across: false, ...layout };
  const through = layout.edges.filter(
    (edge) => routeCost({ ...drawing, edges: [edge] }, edge)(edge.points) === Infinity,
  ).length;
  const bends = layout.edges.reduce((sum, edge) => sum + Math.max(0, edge.points.length - 2), 0);
  return through * 1e6 + crossings(layout) * CROSSING + bends;
}

/**
 * The gap between two parts of a wrapped layout: a lane for each edge routed through it, and room
 * across for the widest of their labels.
 */
function wrapGap(edges: { label?: string }[], across: boolean): number {
  const sizes = edges.flatMap((edge) => (edge.label === undefined ? [] : [labelSize(edge.label)]));
  const widest = Math.max(0, ...sizes.map((size) => (across ? size.height : size.width)));
  return Math.max(
    LAYER_GAP,
    EDGE_CLEAR * 2 + edges.length * EDGE_GAP + Math.max(EDGE_GAP, widest + LABEL_CLEAR * 2),
  );
}

/**
 * The layout broken along its flow where no node or group spans the break, its parts side by side
 * across the flow in their order, so that its shape comes nearer the room's: rows when it runs
 * across, columns when it runs down. Each edge between two parts is routed anew through the gap
 * after the first of them. None when no break fits it larger, or the best few leave an edge with no
 * clear route, a label with no place, or more crossings than the wrap is worth.
 */
function wrapped(layout: GraphLayout, room: Point): GraphLayout | undefined {
  const ids = new Set(layout.nodes.map((node) => node.id));
  if (layout.edges.some((edge) => !ids.has(edge.from) || !ids.has(edge.to))) return undefined;
  const across = layout.direction === 'LR';
  const into = <T extends Box>(b: T): T => (across ? turnBox(b) : b);
  const boxes = [...layout.nodes, ...layout.groups].map(into);
  // The stretches along the flow that nodes and groups take, merged where they meet.
  const spans: [number, number][] = [];
  for (const b of [...boxes].sort((a, b) => a.y - b.y)) {
    const last = spans.at(-1);
    if (last && b.y <= last[1]) last[1] = Math.max(last[1], b.y + b.height);
    else spans.push([b.y, b.y + b.height]);
  }
  const m = spans.length;
  if (m < 2) return undefined;
  const at = boxes.map((b) => spans.findIndex(([, end]) => b.y + b.height / 2 <= end));
  const span = new Map(layout.nodes.map((node, i) => [node.id, at[i]!]));
  const ends = layout.edges.map((edge) => [span.get(edge.from)!, span.get(edge.to)!] as const);
  // A part of spans j..i-1: its length, the room it takes across with the gap after it, and the
  // edges it sends past its end.
  const part = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: i }, (_, j) => {
      const held = boxes.filter((_, k) => at[k]! >= j && at[k]! < i);
      const sent =
        i < m
          ? layout.edges.filter((_, e) => {
              const [a, b] = ends[e]!;
              return Math.min(a, b) >= j && Math.min(a, b) < i && Math.max(a, b) >= i;
            })
          : [];
      const wide = Math.max(...held.map((b) => b.x + b.width)) - Math.min(...held.map((b) => b.x));
      return {
        length: spans[i - 1]![1] - spans[j]![0],
        room: wide + (i < m ? wrapGap(sent, across) : 0),
        lanes: sent.length,
      };
    }),
  );
  // The furthest span an edge from a part of spans j..i-1 reaches past it.
  const reach = (j: number, i: number) =>
    Math.max(
      -1,
      ...ends
        .filter(([a, b]) => Math.min(a, b) >= j && Math.min(a, b) < i)
        .map(([a, b]) => Math.max(a, b)),
    );
  // For each longest part allowed, the breaks that take the least room across with every edge
  // between parts joining neighbours, which keeps it out of the parts between: best[i][j] ends
  // with the part of spans j..i-1.
  type Plan = { room: number; lanes: number; from: number };
  const plans: { cuts: number[]; fit: number; lanes: number }[] = [];
  for (const longest of new Set(part.flatMap((row) => row.map((p) => p.length)))) {
    const best: (Plan | undefined)[][] = Array.from({ length: m + 1 }, () => []);
    for (let i = 1; i <= m; i++)
      for (let j = 0; j < i; j++) {
        const p = part[i]![j]!;
        if (p.length > longest) continue;
        if (j === 0) best[i]![0] = { room: p.room, lanes: p.lanes, from: -1 };
        for (let k = 0; k < j; k++) {
          const before = best[j]![k];
          if (!before || reach(k, j) >= i) continue;
          if (!best[i]![j] || before.room + p.room < best[i]![j]!.room)
            best[i]![j] = { room: before.room + p.room, lanes: before.lanes + p.lanes, from: k };
        }
      }
    const last = best[m]!.reduce<number | undefined>(
      (most, plan, j) =>
        plan && (most === undefined || plan.room < best[m]![most]!.room) ? j : most,
      undefined,
    );
    // A last part from span 0 is the layout unbroken.
    if (!last) continue;
    const cuts: number[] = [];
    for (let [i, j] = [m, last]; j > 0; [i, j] = [j, best[i]![j]!.from]) cuts.unshift(j);
    if (plans.some((plan) => plan.cuts.join() === cuts.join())) continue;
    const plan = best[m]![last]!;
    const bounds = [0, ...cuts, m];
    const size = {
      x: 0,
      y: 0,
      width: plan.room,
      height: Math.max(
        ...cuts.map((_, k) => part[bounds[k + 1]!]![bounds[k]!]!.length),
        part[m]![last]!.length,
      ),
    };
    plans.push({ cuts, fit: fitZoom(across ? turnBox(size) : size, room), lanes: plan.lanes });
  }
  const now = fitZoom(layout, room);
  for (const { cuts } of plans
    .filter((plan) => plan.fit > now + 1e-3)
    .sort((a, b) => b.fit - a.fit || a.lanes - b.lanes)
    .slice(0, 3)) {
    const breaks = cuts.map((i) => (spans[i - 1]![1] + spans[i]![0]) / 2);
    const done = wrapAt(layout, breaks);
    if (done) return done;
  }
  return undefined;
}

/** The layout broken at `cuts` along the flow, in the frame where it runs down, parts side by side. */
function wrapAt(layout: GraphLayout, cuts: number[]): GraphLayout | undefined {
  const across = layout.direction === 'LR';
  const into = <T extends Box>(b: T): T => (across ? turnBox(b) : { ...b });
  const point = (p: Point): Point => (across ? turn(p) : { ...p });
  const nodes = layout.nodes.map(into);
  const groups = layout.groups.map(into);
  const partOf = (b: Box) => cuts.filter((at) => at <= b.y + b.height / 2).length;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const placed = new Map<Box, number>([...nodes, ...groups].map((b) => [b, partOf(b)]));
  const parts = cuts.length + 1;
  const edges: LaidEdge[] = layout.edges.map((edge) => ({
    ...edge,
    points: edge.points.map(point),
    ...(edge.label_box && { label_box: into(edge.label_box) }),
  }));
  const ends = (edge: LaidEdge) => [
    placed.get(byId.get(edge.from)!)!,
    placed.get(byId.get(edge.to)!)!,
  ];
  const between = edges.filter((edge) => {
    const [a, b] = ends(edge);
    return a !== b;
  });
  for (const edge of between) {
    edge.points = [];
    delete edge.label_box;
  }
  // Each part's box with what it holds, and the edges routed through the gap after it.
  const holds = Array.from({ length: parts }, (_, p) => ({
    nodes: nodes.filter((node) => placed.get(node) === p),
    groups: groups.filter((group) => placed.get(group) === p),
    edges: edges.filter((edge) => !between.includes(edge) && ends(edge)[0] === p),
  }));
  const gap = (p: number) =>
    wrapGap(
      between.filter((edge) => Math.min(...ends(edge)) === p),
      across,
    );
  let left = 0;
  const gaps: [number, number][] = [];
  holds.forEach((part, p) => {
    const boxes: Box[] = [
      ...part.nodes,
      ...part.groups,
      ...part.edges.flatMap((edge) => [
        ...edge.points.map((q) => ({ ...q, width: 0, height: 0 })),
        ...(edge.label_box ? [edge.label_box] : []),
      ]),
    ];
    const [x0, y0] = [Math.min(...boxes.map((b) => b.x)), Math.min(...boxes.map((b) => b.y))];
    const [dx, dy] = [left - x0, -y0];
    const wide = Math.max(...boxes.map((b) => b.x + b.width)) - x0;
    for (const b of [
      ...part.nodes,
      ...part.groups,
      ...part.edges.flatMap((e) => e.label_box ?? []),
    ]) {
      b.x += dx;
      b.y += dy;
    }
    for (const edge of part.edges) for (const q of edge.points) [q.x, q.y] = [q.x + dx, q.y + dy];
    left += wide;
    gaps.push([left, left + gap(p)]);
    left += gap(p);
  });
  const drawing: Drawing = { across, nodes, groups, edges };
  const legs = (node: LaidNode, down: boolean): Point[][] => {
    const from = down ? node.y + node.height : node.y;
    const xs = [node.x + node.width / 2];
    for (let x = node.x + EDGE_CLEAR; x <= node.x + node.width - EDGE_CLEAR; x += EDGE_GAP / 2)
      xs.push(x);
    // The run on to the gap goes anywhere up to past the drawing's end, and keeps off group
    // borders, which it would be read as.
    const end = down
      ? Math.max(...nodes.map((n) => n.y + n.height))
      : Math.min(...nodes.map((n) => n.y));
    const ys = Array.from(
      { length: Math.floor(Math.abs(end - from) / 4) + LAYER_GAP / 2 },
      (_, k) => from + (down ? 1 : -1) * (EDGE_CLEAR + k * 4),
    ).filter((y) =>
      groups.every(
        (g) => Math.abs(y - g.y) > EDGE_GAP / 2 && Math.abs(y - g.y - g.height) > EDGE_GAP / 2,
      ),
    );
    return xs.flatMap((x) =>
      ys.map((y) => [
        { x, y: from },
        { x, y },
      ]),
    );
  };
  for (const edge of between) {
    const [a, b] = ends(edge);
    const [source, target] = [byId.get(edge.from)!, byId.get(edge.to)!];
    const [lo, hi] = gaps[Math.min(a!, b!)]!;
    const mid = (lo + hi) / 2;
    // Labels kept from the strip stay where they are, so a new route goes around them.
    const labels = drawing.edges.flatMap((other) => other.label_box ?? []);
    const clear = routeCost(drawing, edge);
    const cost = (points: Point[], limit?: number) =>
      runs(points).some((run) => labels.some((box) => overlaps(runBox(run), box, LABEL_CLEAR)))
        ? Infinity
        : clear(points, limit);
    const best = (options: Point[][]) =>
      options
        .map((leg) => ({ leg, cost: cost([...leg, { x: mid, y: leg[1]!.y }]) }))
        .filter((option) => option.cost < Infinity)
        .sort((p, q) => p.cost - q.cost)
        .slice(0, 6)
        .map((option) => option.leg);
    const out = best(legs(source, a! < b!));
    const back = best(legs(target, a! > b!));
    let route: { points: Point[]; cost: number } | undefined;
    for (let x = lo + EDGE_CLEAR; x <= hi - EDGE_CLEAR; x += EDGE_GAP / 2)
      for (const p of out)
        for (const q of back) {
          const points = simplify([
            p[0]!,
            p[1]!,
            { x, y: p[1]!.y },
            { x, y: q[1]!.y },
            q[1]!,
            q[0]!,
          ]);
          const c = cost(points, route?.cost);
          if (c < (route?.cost ?? Infinity)) route = { points, cost: c };
        }
    if (!route) return undefined;
    const n = route.points.length;
    route.points[0] = onOutline(route.points[0]!, route.points[1]!, source);
    route.points[n - 1] = onOutline(route.points[n - 1]!, route.points[n - 2]!, target);
    edge.points = route.points;
  }
  placeLabels(drawing, across);
  const labelled = (edges: LaidEdge[]) => edges.filter((edge) => edge.label_box).length;
  if (labelled(drawing.edges) < labelled(layout.edges)) return undefined;
  const boxes: Box[] = [
    ...drawing.nodes,
    ...drawing.groups,
    ...drawing.edges.flatMap((edge) => [
      ...edge.points.map((p) => ({ ...p, width: 0, height: 0 })),
      ...(edge.label_box ? [edge.label_box] : []),
    ]),
  ];
  const [x0, y0] = [Math.min(...boxes.map((b) => b.x)), Math.min(...boxes.map((b) => b.y))];
  const width = Math.max(...boxes.map((b) => b.x + b.width)) - x0;
  const height = Math.max(...boxes.map((b) => b.y + b.height)) - y0;
  const out = <T extends Box>(b: T): T => into({ ...b, x: b.x - x0, y: b.y - y0 });
  const result: GraphLayout = {
    direction: layout.direction,
    width: across ? height : width,
    height: across ? width : height,
    nodes: drawing.nodes.map(out),
    groups: drawing.groups.map(out),
    edges: drawing.edges.map((edge) => ({
      ...edge,
      points: edge.points.map((p) => point({ x: p.x - x0, y: p.y - y0 })),
      ...(edge.label_box && { label_box: out(edge.label_box) }),
    })),
  };
  // Room opened for labels may have moved a node or a group's label onto a route; and past two
  // crossings for each edge between parts, the wrap reads worse than the strip.
  const through = (l: GraphLayout) => Math.floor(tangle(l) / 1e6);
  return through(result) > through(layout) ||
    crossings(result) > crossings(layout) + 2 * between.length
    ? undefined
    : result;
}

/** Lays the graph out in one direction: the compact layout, or ELK's own where that is less tangled. */
async function layoutOnce(spec: GraphSpec, direction: Direction, elk: ELK): Promise<GraphLayout> {
  const [compact, layered] = await Promise.all([
    compactLayout(spec, direction, elk),
    layeredLayout(spec, direction, elk),
  ]);
  return tangle(layered) < tangle(compact) ? layered : compact;
}

/** Lays the graph out in one direction, without groups first, then moved to keep them apart. */
async function compactLayout(
  spec: GraphSpec,
  direction: Direction,
  elk: ELK,
): Promise<GraphLayout> {
  const tree = groupTree(spec);
  const edges = mergeBack(spec.edges);
  const ids = new Set(spec.nodes.map((node) => node.id));
  const across = direction === 'LR';
  const drawing = edges.every((edge) => ids.has(edge.from) && ids.has(edge.to))
    ? await flatLayout(spec, edges, tree, across, elk)
    : await nestedLayout(spec, edges, tree, across, elk);
  const shaped = new Map(drawing.nodes.filter((node) => node.shape).map((node) => [node.id, node]));
  for (const edge of drawing.edges) {
    const { points } = edge;
    const n = points.length;
    if (n < 2) continue;
    points[0] = onOutline(points[0]!, points[1]!, shaped.get(edge.from));
    points[n - 1] = onOutline(points[n - 1]!, points[n - 2]!, shaped.get(edge.to));
  }
  unblock(drawing);
  placeLabels(drawing, across);
  // The drawing from its top-left corner, turned back when it runs across.
  const boxes: Box[] = [
    ...drawing.nodes,
    ...drawing.groups,
    ...drawing.edges.flatMap((edge) => [
      ...edge.points.map((p) => ({ ...p, width: 0, height: 0 })),
      ...(edge.label_box ? [edge.label_box] : []),
    ]),
  ];
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const width = Math.max(...boxes.map((b) => b.x + b.width)) - left;
  const height = Math.max(...boxes.map((b) => b.y + b.height)) - top;
  const out = <T extends Box>(b: T): T => {
    const moved = { ...b, x: b.x - left, y: b.y - top };
    return across ? turnBox(moved) : moved;
  };
  const point = (p: Point): Point => {
    const moved = { x: p.x - left, y: p.y - top };
    return across ? turn(moved) : moved;
  };
  return {
    direction,
    width: across ? height : width,
    height: across ? width : height,
    nodes: drawing.nodes.map(out),
    groups: drawing.groups.map(out),
    edges: drawing.edges.map((edge) => ({
      ...edge,
      points: edge.points.map(point),
      ...(edge.label_box && { label_box: out(edge.label_box) }),
    })),
  };
}

/**
 * Lays the graph out with ELK's layered algorithm. A spec's direction is kept where it fits `room`
 * (the box's width and height) at `FLOOR` or more, else the other direction where that does;
 * without one it is laid out both ways and keeps the one that fits at the larger zoom. Only when
 * neither direction fits at `FLOOR` do the layouts both ways and those wrapped into rows or columns
 * compete: the one that fits at the largest zoom, then the least tangled.
 */
export async function layoutGraph(spec: GraphSpec, room: Point): Promise<GraphLayout> {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  const fittest = (layouts: GraphLayout[]) => {
    const all = [...layouts, ...layouts.flatMap((layout) => wrapped(layout, room) ?? [])];
    const top = Math.max(...all.map((layout) => fitZoom(layout, room)));
    // Zooms a hundredth apart draw text the same size.
    const near = all.filter((layout) => fitZoom(layout, room) > top - 0.01);
    return near.reduce((best, layout) => (tangle(layout) < tangle(best) ? layout : best));
  };
  if (spec.direction) {
    const given = await layoutOnce(spec, spec.direction, elk);
    if (fitZoom(given, room) >= FLOOR) return given;
    const other = await layoutOnce(spec, spec.direction === 'LR' ? 'TB' : 'LR', elk);
    if (fitZoom(other, room) >= FLOOR) return other;
    return fittest([given, other]);
  }
  const [across, down] = await Promise.all([
    layoutOnce(spec, 'LR', elk),
    layoutOnce(spec, 'TB', elk),
  ]);
  const [a, d] = [fitZoom(across, room), fitZoom(down, room)];
  if (Math.max(a, d) < FLOOR) return fittest([across, down]);
  if (Math.abs(a - d) > 1e-3) return a > d ? across : down;
  // Both fit as well: the one shaped more like the box.
  const misfit = (layout: GraphLayout) =>
    Math.abs(Math.log(layout.width / layout.height) - Math.log(room.x / room.y));
  return misfit(down) < misfit(across) ? down : across;
}
