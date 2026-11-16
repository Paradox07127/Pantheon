import type { MemoryGraph } from '@pantheon/domain';

export type GraphNode = MemoryGraph['nodes'][number];
export type GraphEdge = MemoryGraph['edges'][number];
/** What the kind filter can hide: the three memory kinds and the three source kinds. */
export type GraphKind = 'decision' | 'report' | 'note' | 'file' | 'url' | 'session';

export interface GraphLayoutOptions {
  /** The kinds to draw; null draws every kind. */
  kinds: ReadonlySet<GraphKind> | null;
  tags: boolean;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type LaidNode = GraphNode & Box;
export type LaidEdge = GraphEdge & { d: string };
export type LaidGroup = Box & {
  key: string;
  /** null for the memories outside any task. */
  task: NonNullable<GraphNode['task']> | null;
  /** How many memories the group holds; sources and tags are not counted. */
  count: number;
};
export interface GraphLayout {
  width: number;
  height: number;
  groups: LaidGroup[];
  nodes: LaidNode[];
  edges: LaidEdge[];
}

const NODE_W = 160;
const NODE_H = 32;
const COL = 200;
const ROW = 48;
const PILL_H = 24;
const PILL_GAP = 8;
// From the bottom of a column to the first source or tag below it.
const BELOW = 32;
const PAD = 16;
// Room for the group's title above its first row.
const HEAD = 40;
const GAP = 16;
const MARGIN = 16;
// How far a restored-from arc rises above the higher of its two ends.
const ARC = 30;

const MEMORY = new Set<GraphNode['kind']>(['decision', 'report', 'note']);
const LINKS = new Set<GraphEdge['kind']>(['depends_on', 'supersedes', 'restored_from']);
const NO_TASK = '';

const kindOf = (n: GraphNode): GraphKind | 'tag' =>
  n.kind === 'source' ? (n.source_kind ?? 'file') : n.kind;
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

/** The tops nearest to `want` that keep the order and leave a row between neighbours. */
function spread(want: number[]): number[] {
  // With z = y - i * ROW the rows only need z to not decrease: pool adjacent violators.
  const blocks: { sum: number; n: number }[] = [];
  want.forEach((w, i) => {
    blocks.push({ sum: w - i * ROW, n: 1 });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1]!;
      const prev = blocks[blocks.length - 2]!;
      if (prev.sum / prev.n <= last.sum / last.n) break;
      prev.sum += last.sum;
      prev.n += last.n;
      blocks.pop();
    }
  });
  return blocks
    .flatMap((b) => Array<number>(b.n).fill(Math.round(b.sum / b.n)))
    .map((z, i) => z + i * ROW);
}

// Wide characters take a full em at the 12px label size; the rest about 7px.
const labelWidth = (label: string) =>
  [...label].reduce((w, c) => {
    const code = c.codePointAt(0)!;
    return w + (code >= 0x2e80 && code <= 0xffef ? 12 : 7);
  }, 0);

// Even, so a pill centres on its column without a half pixel.
const pillWidth = (n: GraphNode) =>
  2 *
  Math.round(
    Math.min(NODE_W, Math.max(48, (n.kind === 'tag' ? 36 : 32) + labelWidth(n.label))) / 2,
  );

const cx = (b: Box) => b.x + b.w / 2;
const cy = (b: Box) => b.y + b.h / 2;

/** A curve leaving and arriving horizontally; a straight line on one row. */
function across(x1: number, y1: number, x2: number, y2: number): string {
  if (y1 === y2) return `M${x1} ${y1} H${x2}`;
  const mx = (x1 + x2) / 2;
  return `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
}

/** A curve leaving and arriving vertically; a straight line in one column. */
function down(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 === x2) return `M${x1} ${y1} V${y2}`;
  const my = (y1 + y2) / 2;
  return `M${x1} ${y1} C${x1} ${my} ${x2} ${my} ${x2} ${y2}`;
}

function link(a: Box, b: Box): string {
  if (b.x + b.w <= a.x) return across(a.x, cy(a), b.x + b.w, cy(b));
  if (a.x + a.w <= b.x) return across(a.x + a.w, cy(a), b.x, cy(b));
  return `M${a.x} ${cy(a)} C${a.x - 24} ${cy(a)} ${b.x - 24} ${cy(b)} ${b.x} ${cy(b)}`;
}

function edgePath(kind: GraphEdge['kind'], a: Box, b: Box): string {
  if (kind === 'source' || kind === 'tagged') {
    if (b.y >= a.y + a.h) return down(cx(a), a.y + a.h, cx(b), b.y);
    if (b.y + b.h <= a.y) return down(cx(a), a.y, cx(b), b.y + b.h);
    return link(a, b);
  }
  if (kind === 'restored_from' && cx(a) !== cx(b)) {
    const top = Math.min(a.y, b.y) - ARC;
    return `M${cx(a)} ${a.y} C${cx(a)} ${top} ${cx(b)} ${top} ${cx(b)} ${b.y}`;
  }
  return link(a, b);
}

/**
 * Places a project's memory graph: one box per task, the memories in a box in columns with what
 * is relied on to the left, sources and tags under the memories that cite them.
 */
export function layoutGraph(
  graph: Pick<MemoryGraph, 'nodes' | 'edges'>,
  options: GraphLayoutOptions,
): GraphLayout {
  const shown = (n: GraphNode) => {
    const kind = kindOf(n);
    return kind === 'tag' ? options.tags : !options.kinds || options.kinds.has(kind);
  };
  const memories = graph.nodes.filter((n) => MEMORY.has(n.kind) && shown(n));
  const byGroup = new Map<string, GraphNode[]>();
  const groupOf = new Map<string, string>();
  for (const n of memories) {
    const key = n.task
      ? JSON.stringify([n.task.lead_session_id, n.task.id, n.task.generation])
      : NO_TASK;
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key)!.push(n);
    groupOf.set(n.id, key);
  }
  const keys = [...byGroup.keys()].filter((k) => k !== NO_TASK);
  if (byGroup.has(NO_TASK)) keys.push(NO_TASK);

  const out = new Map<string, string[]>();
  const into = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!LINKS.has(e.kind) || e.from === e.to) continue;
    const group = groupOf.get(e.from);
    if (group === undefined || groupOf.get(e.to) !== group) continue;
    out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
    into.set(e.to, [...(into.get(e.to) ?? []), e.from]);
  }
  // Column = the longest chain of links leading left; a link closing a cycle is not followed.
  const rank = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    const known = rank.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return -1;
    visiting.add(id);
    let r = 0;
    for (const to of out.get(id) ?? []) {
      const v = visit(to);
      if (v >= 0) r = Math.max(r, v + 1);
    }
    visiting.delete(id);
    rank.set(id, r);
    return r;
  };
  memories.forEach((n) => visit(n.id));

  const attachments = graph.nodes.filter((n) => !MEMORY.has(n.kind) && shown(n));
  const citers = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (LINKS.has(e.kind)) continue;
    const [memory, other] = groupOf.has(e.from) ? [e.from, e.to] : [e.to, e.from];
    if (groupOf.has(memory)) citers.set(other, [...(citers.get(other) ?? []), memory]);
  }

  const placed = new Map<string, Box>();
  const order: string[] = [];
  const groups: LaidGroup[] = [];
  let stackY = MARGIN;
  let taskRight = MARGIN;
  for (const key of keys) {
    const members = byGroup.get(key)!;
    const cols: string[][] = [];
    for (const n of members) (cols[rank.get(n.id)!] ??= []).push(n.id);
    const top = new Map<string, number>();
    const arrange = (c: number, want: (id: string, i: number) => number) => {
      const wanted = cols[c]!.map((id, i) => [id, want(id, i)] as const).sort(
        (a, b) => a[1] - b[1],
      );
      const ys = spread(wanted.map(([, w]) => w));
      wanted.forEach(([id], i) => top.set(id, ys[i]!));
      cols[c] = wanted.map(([id]) => id);
    };
    for (let c = 0; c < cols.length; c++)
      arrange(c, (id, i) => {
        const ys = (out.get(id) ?? []).filter((to) => top.has(to)).map((to) => top.get(to)!);
        return ys.length ? mean(ys) : i * ROW;
      });
    // Then each memory moves to the middle of the memories that rely on it.
    for (let c = cols.length - 2; c >= 0; c--)
      arrange(c, (id) => {
        const ys = (into.get(id) ?? [])
          .filter((from) => rank.get(from)! > c)
          .map((from) => top.get(from)!);
        return ys.length ? mean(ys) : top.get(id)!;
      });

    const isTask = key !== NO_TASK;
    const x = isTask ? MARGIN : taskRight + (keys.length > 1 ? GAP : 0);
    const y = isTask ? stackY : MARGIN;
    const first = Math.min(...top.values());
    const colX = (c: number) => x + PAD + c * COL;
    const bottoms = cols.map(() => 0);
    cols.forEach((col, c) =>
      col.forEach((id) => {
        const box = { x: colX(c), y: y + HEAD + top.get(id)! - first, w: NODE_W, h: NODE_H };
        placed.set(id, box);
        order.push(id);
        bottoms[c] = Math.max(bottoms[c]!, box.y + box.h);
      }),
    );
    const stacked = cols.map(() => 0);
    for (const n of attachments) {
      if (placed.has(n.id)) continue;
      // A source or tag cited from several groups sits in the group of its first citing memory.
      const cited = citers.get(n.id) ?? [];
      if (!cited.length || groupOf.get(cited[0]!) !== key) continue;
      // Under the leftmost memory citing it, below everything else in that column.
      const anchor = cited
        .filter((id) => groupOf.get(id) === key)
        .reduce((a, b) => (rank.get(b)! < rank.get(a)! ? b : a));
      const c = rank.get(anchor)!;
      const w = pillWidth(n);
      const py = stacked[c] ? stacked[c]! + PILL_GAP : bottoms[c]! + BELOW;
      placed.set(n.id, { x: colX(c) + (NODE_W - w) / 2, y: py, w, h: PILL_H });
      order.push(n.id);
      stacked[c] = py + PILL_H;
    }
    const bottom = Math.max(...bottoms, ...stacked);
    const group = {
      key,
      task: members[0]!.task ?? null,
      count: members.length,
      x,
      y,
      w: PAD * 2 + (cols.length - 1) * COL + NODE_W,
      h: bottom - y + PAD,
    };
    groups.push(group);
    if (isTask) {
      stackY = group.y + group.h + GAP;
      taskRight = Math.max(taskRight, group.x + group.w);
    }
  }
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const nodes = order.map((id) => ({ ...nodeById.get(id)!, ...placed.get(id)! }));
  const edges = graph.edges
    .filter((e) => placed.has(e.from) && placed.has(e.to))
    .map((e) => ({ ...e, d: edgePath(e.kind, placed.get(e.from)!, placed.get(e.to)!) }));
  if (!groups.length) return { width: 0, height: 0, groups, nodes, edges };
  return {
    width: Math.max(...groups.map((g) => g.x + g.w)) + MARGIN,
    height: Math.max(...groups.map((g) => g.y + g.h)) + MARGIN,
    groups,
    nodes,
    edges,
  };
}
