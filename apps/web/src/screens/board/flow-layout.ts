import { Graph, layout, type EdgeLabel, type GraphLabel, type NodeLabel } from '@dagrejs/dagre';
import type { BoardModel, BoardTaskState } from '@pantheon/protocol';
import { DOMAIN_LABEL } from '../../data/workflow-policy';
import { t } from '../../i18n';
import { STATE } from './status';

export const NODE_WIDTH = 232;
/** A card's height until it is measured; a card is as tall as its content. */
export const NODE_HEIGHT = 108;
/** The lane title column, its 12px inset from the lane's frame and 16px gap to the first card included. */
export const LANE_LABEL_WIDTH = 92;
/** Space between the frames of two lanes. */
export const LANE_GAP = 16;
const MIN_GAP = 48;
const MAX_GAP = 160;
const ROW_GAP = 16;
const LANE_PADDING = 16;
/** The row over a plan lane's cards that holds its title and depth; a narrow lane's head takes two. */
const LANE_HEAD = 28;
/**
 * The narrowest lane frame whose head fits on one row: 12px insets on both sides, then in English text
 * the title cut to 80, the depth choice 220, who chose 76, the reason cut to 64 and the plan state 204,
 * 12px apart.
 */
const LANE_HEAD_ONE_ROW = 24 + 80 + 220 + 76 + 64 + 204 + 4 * 12;
/** The cards' smallest text is 12px at 1:1; fitting the graph never shrinks it under 11px. */
export const MIN_ZOOM = 11 / 12;
/** The user may zoom out this far; below COMPACT_ZOOM a card is a capsule, below DOT_ZOOM a dot. */
export const MIN_USER_ZOOM = 0.05;
export const MAX_USER_ZOOM = 1.5;
export const COMPACT_ZOOM = 0.6;
export const DOT_ZOOM = 0.15;

/** What splits the tasks into bands: their lane, task type, state or model. */
export type FlowGroup = 'lane' | 'kind' | 'state' | 'model';

type Task = BoardModel['tasks'][number];

function bandOf(task: Task, group: FlowGroup): string | null {
  switch (group) {
    case 'lane':
      return task.lane_id;
    case 'kind':
      return task.kind?.domain ?? null;
    case 'state':
      return task.state ?? null;
    case 'model':
      return task.claim?.model ?? task.planned?.model ?? null;
  }
}

/** The bands in drawing order, the band of tasks without a value last. */
function bands(
  model: BoardModel,
  group: FlowGroup,
): { id: string | null; title: string; fanout_reason?: string }[] {
  switch (group) {
    case 'lane':
      return [...model.lanes, { id: null, title: '' }];
    case 'kind':
      return [
        ...Object.keys(DOMAIN_LABEL).map((id) => ({
          id,
          title: DOMAIN_LABEL[id as keyof typeof DOMAIN_LABEL],
        })),
        { id: null, title: '' },
      ];
    case 'state':
      return [
        ...Object.keys(STATE).map((id) => ({ id, title: STATE[id as BoardTaskState].label })),
        { id: null, title: '' },
      ];
    case 'model':
      return [
        ...[...new Set(model.tasks.map((task) => bandOf(task, 'model')))]
          .filter((id) => id !== null)
          .map((id) => ({ id, title: id })),
        {
          id: null,
          title: t({ id: 'board.canvas.band.undecided', defaultMessage: 'Undecided' }),
        },
      ];
  }
}

export interface FlowLayout {
  /** Top-left corner of each task's card. */
  nodes: { id: string; x: number; y: number }[];
  /** id null is the band of tasks without a known value; it comes last. */
  lanes: {
    id: string | null;
    title: string;
    fanout_reason?: string;
    y: number;
    height: number;
    tasks: string[];
  }[];
  edges: BoardModel['edges'];
  /** Space between columns. */
  gap: number;
  /** Rows a plan lane's head takes, by the lanes' width. */
  headRows: 1 | 2;
  width: number;
  height: number;
}

/** 1:1 unless the graph is wider than the box, then fitted, but never below MIN_ZOOM. */
export function flowZoom(box: number, graph: number): number {
  return graph ? Math.max(MIN_ZOOM, Math.min(box / graph, 1)) : 1;
}

/** Changes only with what flowLayout places: tasks, their bands, lanes and edges, not edge states. */
export function layoutKey(model: BoardModel, group: FlowGroup = 'lane'): string {
  return JSON.stringify([
    group,
    model.tasks.map((t) => [t.id, bandOf(t, group)]),
    model.lanes.map((l) => [l.id, l.title, l.fanout_reason]),
    model.edges.map((e) => [e.from, e.to]),
  ]);
}

/**
 * Columns from dagre over all tasks, rows inside each band; column gaps stretch between MIN_GAP and
 * MAX_GAP so the graph fills `width` at 1:1. A card missing from `heights` is NODE_HEIGHT tall.
 */
export function flowLayout(
  model: BoardModel,
  width: number,
  group: FlowGroup = 'lane',
  heights: ReadonlyMap<string, number> = new Map(),
): FlowLayout {
  const ids = new Set(model.tasks.map((t) => t.id));
  const edges = model.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const heightOf = (id: string) => heights.get(id) ?? NODE_HEIGHT;
  const g: Graph<GraphLabel, NodeLabel, EdgeLabel> = new Graph();
  g.setGraph({ rankdir: 'LR', ranksep: MIN_GAP, nodesep: ROW_GAP, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const t of model.tasks) g.setNode(t.id, { width: NODE_WIDTH, height: heightOf(t.id) });
  for (const e of edges) g.setEdge(e.from, e.to);
  layout(g);
  const xs = [...new Set(model.tasks.map((t) => Math.round(g.node(t.id).x!)))].sort(
    (a, b) => a - b,
  );
  const column = new Map(model.tasks.map((t) => [t.id, xs.indexOf(Math.round(g.node(t.id).x!))]));
  const columns = xs.length;
  const gap =
    columns > 1
      ? Math.min(
          MAX_GAP,
          Math.max(
            MIN_GAP,
            (width - LANE_LABEL_WIDTH - LANE_PADDING - columns * NODE_WIDTH) / (columns - 1),
          ),
        )
      : MIN_GAP;

  const laneWidth =
    LANE_LABEL_WIDTH + columns * NODE_WIDTH + Math.max(0, columns - 1) * gap + LANE_PADDING;
  const headRows = laneWidth >= LANE_HEAD_ONE_ROW ? 1 : 2;

  const groups = bands(model, group);
  const known = new Set(groups.map((l) => l.id));
  const nodes: FlowLayout['nodes'] = [];
  const lanes: FlowLayout['lanes'] = [];
  let y = 0;
  for (const lane of groups) {
    const tasks = model.tasks
      .filter((t) => {
        const band = bandOf(t, group);
        return (known.has(band) ? band : null) === lane.id;
      })
      .sort((a, b) => column.get(a.id)! - column.get(b.id)! || g.node(a.id).y! - g.node(b.id).y!);
    if (!tasks.length) continue;
    // A task starts at the average row of its parents in the lane, then moves down to a free cell.
    // An edge skipping columns runs along its task's row, so that row stays free in those columns.
    const rows: Set<number>[] = [];
    const rowOf = new Map<string, number>();
    for (const t of tasks) {
      const parents = edges.filter((e) => e.to === t.id && rowOf.has(e.from));
      const col = column.get(t.id)!;
      const skipped = edges
        .filter((e) => e.to === t.id)
        .flatMap((e) =>
          Array.from({ length: col - column.get(e.from)! - 1 }, (_, i) => col - 1 - i),
        );
      let row = parents.length
        ? Math.round(parents.reduce((sum, e) => sum + rowOf.get(e.from)!, 0) / parents.length)
        : 0;
      while (rows[row]?.has(col) || skipped.some((c) => rows[row]?.has(c))) row++;
      (rows[row] ??= new Set()).add(col);
      rowOf.set(t.id, row);
    }
    const rowHeight = rows.map(() => 0);
    for (const t of tasks)
      rowHeight[rowOf.get(t.id)!] = Math.max(rowHeight[rowOf.get(t.id)!]!, heightOf(t.id));
    const head = group === 'lane' && lane.id !== null ? headRows * LANE_HEAD : 0;
    const rowTop = rowHeight.map((_, i) =>
      rowHeight.slice(0, i).reduce((sum, h) => sum + h + ROW_GAP, y + LANE_PADDING + head),
    );
    for (const t of tasks)
      nodes.push({
        id: t.id,
        x: LANE_LABEL_WIDTH + column.get(t.id)! * (NODE_WIDTH + gap),
        y: rowTop[rowOf.get(t.id)!]!,
      });
    const height =
      2 * LANE_PADDING +
      head +
      rowHeight.reduce((sum, h) => sum + h, 0) +
      (rows.length - 1) * ROW_GAP;
    lanes.push({
      id: lane.id,
      title: lane.title,
      ...(lane.fanout_reason ? { fanout_reason: lane.fanout_reason } : {}),
      y,
      height,
      tasks: tasks.map((t) => t.id),
    });
    y += height + LANE_GAP;
  }
  return {
    nodes,
    lanes,
    edges,
    gap,
    headRows,
    width: laneWidth,
    height: Math.max(0, y - LANE_GAP),
  };
}
