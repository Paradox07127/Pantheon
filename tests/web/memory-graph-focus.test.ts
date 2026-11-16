import { describe, expect, it } from 'vitest';
import { fitZoom, graphNear, graphSummary, nextNode, stepZoom } from '@/screens/memory/graph-focus';
import { layoutGraph, type GraphLayout, type LaidNode } from '@/screens/memory/graph-layout';

const task = {
  id: 'refund-idempotency',
  lead_session_id: 'lead',
  generation: 1,
  title: 'Refund idempotency',
};
const other = {
  id: 'callback-signature',
  lead_session_id: 'lead',
  generation: 1,
  title: 'Callback signature',
};

const graph = {
  nodes: [
    { id: 'incident', label: 'Duplicate refund incident', kind: 'report', state: 'active', task },
    { id: 'by-order', label: 'Dedupe by order', kind: 'decision', state: 'archived', task },
    { id: 'by-key', label: 'Dedupe by key', kind: 'decision', state: 'active', task },
    { id: 'cross-day', label: 'Cross-day failure', kind: 'report', state: 'draft', task },
    { id: 'late', label: 'Late callback', kind: 'report', state: 'active', task },
    { id: 'secret', label: 'Rotate the secret', kind: 'decision', state: 'active', task: other },
    { id: 'prefix', label: 'Key prefix for switches', kind: 'note', state: 'active' },
    { id: 'file', label: 'idempotency.ts', kind: 'source', source_kind: 'file' },
    { id: 'web', label: 'Signature docs', kind: 'source', source_kind: 'url' },
  ],
  edges: [
    { id: 'e1', from: 'by-key', to: 'incident', kind: 'depends_on' },
    { id: 'e2', from: 'by-key', to: 'by-order', kind: 'supersedes' },
    { id: 'e3', from: 'cross-day', to: 'by-key', kind: 'depends_on' },
    { id: 'e4', from: 'by-key', to: 'file', kind: 'source' },
    { id: 'e5', from: 'prefix', to: 'web', kind: 'source' },
    { id: 'e6', from: 'cross-day', to: 'by-order', kind: 'restored_from' },
    { id: 'e7', from: 'late', to: 'cross-day', kind: 'depends_on' },
    { id: 'e8', from: 'secret', to: 'web', kind: 'source' },
  ],
} as const;
const layout = layoutGraph(
  { nodes: [...graph.nodes], edges: [...graph.edges] },
  { kinds: null, tags: false },
);

const box = (id: string, x: number, y: number): LaidNode => ({
  id,
  label: id,
  kind: 'note',
  state: 'active',
  x,
  y,
  w: 160,
  h: 32,
});
// Two columns, 200 apart, with rows 48 apart, and a source pill under the first column.
const grid: GraphLayout = {
  width: 600,
  height: 300,
  groups: [],
  edges: [],
  nodes: [
    box('a1', 16, 16),
    box('a2', 16, 64),
    box('b1', 216, 40),
    box('b2', 216, 136),
    { ...box('pill', 56, 128), w: 80, h: 24 },
  ],
};

describe('memory graph focus', () => {
  it('takes the neighbours one or two links away along either direction, the node itself included', () => {
    expect([...graphNear(graph.edges, 'by-key', 1)].sort()).toEqual(
      ['by-key', 'by-order', 'cross-day', 'file', 'incident'].sort(),
    );
    expect([...graphNear(graph.edges, 'by-key', 2)].sort()).toEqual(
      ['by-key', 'by-order', 'cross-day', 'file', 'incident', 'late'].sort(),
    );
    expect([...graphNear(graph.edges, 'web', 1)].sort()).toEqual(['prefix', 'secret', 'web']);
    expect([...graphNear(graph.edges, 'prefix', 2)].sort()).toEqual(['prefix', 'secret', 'web']);
  });

  it.each([
    [
      'sums up a focus by the node, its links and how many are faded',
      'by-key',
      9,
      '知识图谱，共 9 个节点。聚焦决定「Dedupe by key」，邻域内 5 个节点：它依据 1 条，替代 1 条，被 1 条依据，来源 1 个；其余 4 个节点淡化。',
    ],
    [
      'sums up the whole graph by tasks, memories, sources and each kind of link',
      null,
      9,
      '知识图谱，2 个任务，共 7 条记忆、2 个来源。依据 3 条、替代 1 条、恢复 1 条、来源 3 条。',
    ],
    [
      'says how many nodes there are and how many are drawn when the drawing is cut short',
      null,
      126,
      '知识图谱，共 126 个节点，只画了 9 个。',
    ],
  ])('%s', (_name, focus, total, summary) => {
    const near = focus ? graphNear(graph.edges, focus, 1) : null;
    expect(graphSummary(layout, focus, near, total)).toBe(summary);
  });

  it('moves to the nearest node on screen in the arrow direction, keeping to rows and columns', () => {
    expect(nextNode(grid, 'a1', 'ArrowDown')).toBe('a2');
    expect(nextNode(grid, 'a2', 'ArrowDown')).toBe('pill');
    expect(nextNode(grid, 'a2', 'ArrowRight')).toBe('b1');
    expect(nextNode(grid, 'b2', 'ArrowLeft')).toBe('pill');
    expect(nextNode(grid, 'b2', 'ArrowUp')).toBe('b1');
    expect(nextNode(grid, 'a1', 'ArrowUp')).toBeNull();
    expect(nextNode(grid, 'b1', 'ArrowRight')).toBeNull();
  });

  it('fits the drawing to the viewport, below the zoom buttons’ limit, never enlarging a small one', () => {
    expect(fitZoom(grid, { width: 450, height: 600 })).toBe(0.75);
    expect(fitZoom(grid, { width: 150, height: 600 })).toBe(0.25);
    expect(fitZoom(grid, { width: 3000, height: 3000 })).toBe(1);
  });

  it('steps the zoom by tenths within half and double size', () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(0.87, 1)).toBe(0.9);
    expect(stepZoom(0.87, -1)).toBe(0.8);
    expect(stepZoom(0.5, -1)).toBe(0.5);
    expect(stepZoom(2, 1)).toBe(2);
  });
});
