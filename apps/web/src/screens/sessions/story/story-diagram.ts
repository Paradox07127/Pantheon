import type { DecisionDiagram, FlowDiagram, StorySide, TypeDiagram } from '@pantheon/domain';

export type StoryView = 'before' | 'after' | 'overlay';
export type ElementStatus = 'added' | 'removed' | 'same' | 'hidden';

const NODE_WIDTH = 144;
const NODE_HEIGHT = 44;
const LANE_LABEL_WIDTH = 16;
const COLUMN_GAP = 36;
const ROW_GAP = 16;
const LANE_PADDING = 24;

export interface FlowLayout {
  nodes: { id: string; x: number; y: number; width: number; height: number }[];
  lanes: { name: string; y: number; height: number }[];
  width: number;
  height: number;
}

export interface TypeRow {
  name: string;
  before?: string;
  after?: string;
  status: 'added' | 'removed' | 'changed' | 'same';
}

export function elementStatus(side: StorySide, view: StoryView): ElementStatus {
  if (view === 'overlay')
    return side === 'before' ? 'removed' : side === 'after' ? 'added' : 'same';
  if (side === 'both' || side === view) return 'same';
  return 'hidden';
}

// Longest chain of upstream nodes; an edge that closes a cycle counts as no upstream.
function columnsOf(spec: FlowDiagram): Map<string, number> {
  const incoming = new Map<string, string[]>(spec.nodes.map((n) => [n.id, []]));
  for (const e of spec.edges) incoming.get(e.to)?.push(e.from);
  const column = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    const known = column.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id) || !incoming.has(id)) return -1;
    visiting.add(id);
    const c = Math.max(-1, ...incoming.get(id)!.map(visit)) + 1;
    visiting.delete(id);
    column.set(id, c);
    return c;
  };
  for (const n of spec.nodes) visit(n.id);
  return column;
}

/** Laid out once over both sides, so a node keeps its place in every view. */
export function layoutFlow(spec: FlowDiagram): FlowLayout {
  const column = columnsOf(spec);
  const row = new Map<string, number>();
  const filled = new Map<string, number>();
  const rows = new Map<string, number>();
  for (const n of spec.nodes) {
    const cell = `${column.get(n.id)}:${n.lane}`;
    const index = filled.get(cell) ?? 0;
    filled.set(cell, index + 1);
    row.set(n.id, index);
    rows.set(n.lane, Math.max(rows.get(n.lane) ?? 0, index + 1));
  }
  const lanes: FlowLayout['lanes'] = [];
  const laneY = new Map<string, number>();
  let height = 0;
  for (const name of spec.lanes) {
    const laneHeight = (rows.get(name) ?? 0) * (NODE_HEIGHT + ROW_GAP) + 2 * LANE_PADDING;
    lanes.push({ name, y: height, height: laneHeight });
    laneY.set(name, height);
    height += laneHeight;
  }
  const nodes = spec.nodes.map((n) => ({
    id: n.id,
    x: LANE_LABEL_WIDTH + column.get(n.id)! * (NODE_WIDTH + COLUMN_GAP),
    y: (laneY.get(n.lane) ?? 0) + LANE_PADDING + row.get(n.id)! * (NODE_HEIGHT + ROW_GAP),
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
  }));
  const columns = spec.nodes.length ? Math.max(...column.values()) + 1 : 0;
  return {
    nodes,
    lanes,
    width: LANE_LABEL_WIDTH + columns * (NODE_WIDTH + COLUMN_GAP),
    height,
  };
}

export function typeRows(spec: TypeDiagram): TypeRow[] {
  const byName = new Map<string, { before?: string; after?: string }>();
  for (const f of spec.fields) {
    const entry = byName.get(f.name) ?? {};
    if (f.side !== 'after') entry.before = f.type;
    if (f.side !== 'before') entry.after = f.type;
    byName.set(f.name, entry);
  }
  return [...byName].map(([name, { before, after }]) => {
    if (before === undefined) return { name, after, status: 'added' };
    if (after === undefined) return { name, before, status: 'removed' };
    return { name, before, after, status: before === after ? 'same' : 'changed' };
  });
}

export function decisionStatus(row: DecisionDiagram['rows'][number]): 'changed' | 'same' {
  return row.before !== row.after ? 'changed' : 'same';
}
