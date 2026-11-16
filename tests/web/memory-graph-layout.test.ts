import { describe, expect, it } from 'vitest';
import type { MemoryGraph } from '@pantheon/domain';
import { layoutGraph, type GraphLayout, type LaidNode } from '@/screens/memory/graph-layout';

type Node = MemoryGraph['nodes'][number];
type Edge = MemoryGraph['edges'][number];

const scope = (id: string, title: string, lead_session_id = 'lead', generation = 1) => ({
  id,
  title,
  lead_session_id,
  generation,
});
const refund = scope('refund-idempotency', 'Refund idempotency');
const webhook = scope('webhook-signature', 'Webhook signature');
const reconcile = scope('reconcile-report', 'Reconcile report');

const memory = (
  id: string,
  kind: 'decision' | 'report' | 'note',
  task?: ReturnType<typeof scope>,
  state: 'active' | 'draft' | 'archived' = 'active',
): Node => ({ id, label: `label ${id}`, kind, state, memory_id: id, ...(task && { task }) });
const source = (id: string, source_kind: 'file' | 'url' | 'session', label = id): Node => ({
  id,
  label,
  kind: 'source',
  source_kind,
  uri: id,
});
const edge = (from: string, to: string, kind: Edge['kind']): Edge => ({
  id: `${kind}:${from}:${to}`,
  from,
  to,
  kind,
});

// A whole project: three tasks and one memory outside any task, with every kind of link.
const project: Pick<MemoryGraph, 'nodes' | 'edges'> = {
  nodes: [
    memory('incident-review', 'report', refund),
    memory('dedupe-by-order', 'decision', refund, 'archived'),
    memory('dedupe-by-key', 'decision', refund),
    memory('key-load-test', 'report', refund),
    memory('replay-test', 'report', refund),
    memory('state-check', 'report', refund),
    memory('key-expiry-review', 'report', refund),
    memory('one-way-states', 'decision', refund),
    memory('retry-three-times', 'note', refund),
    memory('lock-comparison', 'report', refund),
    source('idempotency.ts', 'file'),
    source('signature-docs', 'url'),
    memory('current-key-only', 'decision', webhook, 'archived'),
    memory('rotation-drill', 'report', webhook),
    memory('old-and-new-keys', 'decision', webhook),
    memory('reject-after-five-minutes', 'decision', webhook),
    memory('replay-regression', 'report', webhook),
    source('webhook/verify.ts', 'file'),
    memory('switch-prefix', 'note'),
    memory('tolerance-one', 'decision', reconcile, 'archived'),
    memory('zero-tolerance', 'decision', reconcile, 'archived'),
    memory('tolerance-one-again', 'decision', reconcile),
    memory('merchant-day-cut', 'note', reconcile),
    memory('cross-day-failure', 'report', reconcile, 'draft'),
    source('session:reconcile', 'session', 'Reconcile session'),
  ],
  edges: [
    edge('dedupe-by-key', 'incident-review', 'depends_on'),
    edge('dedupe-by-key', 'dedupe-by-order', 'supersedes'),
    edge('key-load-test', 'dedupe-by-key', 'depends_on'),
    edge('replay-test', 'dedupe-by-key', 'depends_on'),
    edge('state-check', 'dedupe-by-key', 'depends_on'),
    edge('key-expiry-review', 'dedupe-by-key', 'depends_on'),
    edge('one-way-states', 'state-check', 'depends_on'),
    edge('retry-three-times', 'one-way-states', 'depends_on'),
    edge('lock-comparison', 'one-way-states', 'depends_on'),
    edge('dedupe-by-order', 'idempotency.ts', 'source'),
    edge('dedupe-by-key', 'idempotency.ts', 'source'),
    edge('key-expiry-review', 'idempotency.ts', 'source'),
    edge('old-and-new-keys', 'current-key-only', 'supersedes'),
    edge('old-and-new-keys', 'rotation-drill', 'depends_on'),
    edge('reject-after-five-minutes', 'old-and-new-keys', 'depends_on'),
    edge('replay-regression', 'reject-after-five-minutes', 'depends_on'),
    edge('old-and-new-keys', 'signature-docs', 'source'),
    edge('old-and-new-keys', 'webhook/verify.ts', 'source'),
    edge('reject-after-five-minutes', 'webhook/verify.ts', 'source'),
    edge('replay-regression', 'webhook/verify.ts', 'source'),
    edge('zero-tolerance', 'tolerance-one', 'supersedes'),
    edge('tolerance-one-again', 'zero-tolerance', 'supersedes'),
    edge('tolerance-one-again', 'tolerance-one', 'restored_from'),
    edge('cross-day-failure', 'tolerance-one-again', 'depends_on'),
    edge('cross-day-failure', 'merchant-day-cut', 'depends_on'),
    edge('cross-day-failure', 'session:reconcile', 'source'),
  ],
};

const all = () => layoutGraph(project, { kinds: null, tags: false });
const at = (layout: GraphLayout, id: string): LaidNode => {
  const node = layout.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`no node ${id}`);
  return node;
};
const centre = (n: LaidNode) => n.y + n.h / 2;
const path = (layout: GraphLayout, from: string, to: string) =>
  layout.edges.find((e) => e.from === from && e.to === to)?.d;

describe('memory graph layout', () => {
  it('boxes the memories by task, with the ones outside any task in a column on the right', () => {
    const layout = all();
    expect(layout.groups.map((g) => [g.task?.title ?? null, g.count])).toEqual([
      ['Refund idempotency', 10],
      ['Webhook signature', 5],
      ['Reconcile report', 5],
      [null, 1],
    ]);
    const [first, second, third, loose] = layout.groups;
    expect(second!.y).toBeGreaterThanOrEqual(first!.y + first!.h + 8);
    expect(third!.y).toBeGreaterThanOrEqual(second!.y + second!.h + 8);
    expect(loose!.x).toBeGreaterThanOrEqual(
      Math.max(...[first, second, third].map((g) => g!.x + g!.w)),
    );
    for (const group of layout.groups) {
      const inside = layout.nodes.filter(
        (n) => n.kind !== 'source' && (n.task?.id ?? null) === (group.task?.id ?? null),
      );
      expect(inside).toHaveLength(group.count);
      for (const n of inside) {
        expect(n.x).toBeGreaterThanOrEqual(group.x + 16);
        expect(n.x + n.w).toBeLessThanOrEqual(group.x + group.w - 16);
        expect(n.y).toBeGreaterThanOrEqual(group.y + 40);
        expect(n.y + n.h).toBeLessThanOrEqual(group.y + group.h - 16);
      }
    }
    expect(layout.width).toBe(Math.max(...layout.groups.map((g) => g.x + g.w)) + 16);
    expect(layout.height).toBe(Math.max(...layout.groups.map((g) => g.y + g.h)) + 16);
  });

  it('boxes one task id apart for each lead and generation', () => {
    const layout = layoutGraph(
      {
        nodes: [
          memory('first-lead', 'report', scope('shared-task', 'First lead task', 'lead-one')),
          memory('second-lead', 'report', scope('shared-task', 'Second lead task', 'lead-two')),
          memory('next-round', 'note', scope('shared-task', 'Next round', 'lead-one', 2)),
          memory('first-again', 'decision', scope('shared-task', 'First lead task', 'lead-one')),
        ],
        edges: [],
      },
      { kinds: null, tags: false },
    );
    expect(layout.groups.map((g) => [g.task?.title, g.count])).toEqual([
      ['First lead task', 2],
      ['Second lead task', 1],
      ['Next round', 1],
    ]);
  });

  it('puts what is relied on to the left, in columns 200 apart and rows 48 apart, at 160 by 32', () => {
    const layout = all();
    const memories = layout.nodes.filter((n) => n.kind !== 'source');
    expect(memories.every((n) => n.w === 160 && n.h === 32)).toBe(true);
    const x = (id: string) => at(layout, id).x;
    expect(x('incident-review')).toBe(x('dedupe-by-order'));
    expect(x('dedupe-by-key') - x('incident-review')).toBe(200);
    expect(x('state-check') - x('dedupe-by-key')).toBe(200);
    expect(x('one-way-states') - x('state-check')).toBe(200);
    expect(x('lock-comparison') - x('one-way-states')).toBe(200);
    expect(x('tolerance-one-again') - x('tolerance-one')).toBe(400);
    for (const e of project.edges.filter((e) => e.kind !== 'source'))
      expect(x(e.to), `${e.from} -> ${e.to}`).toBeLessThan(x(e.from));
    const reports = ['key-load-test', 'replay-test', 'state-check', 'key-expiry-review'];
    const ys = reports.map((id) => at(layout, id).y);
    expect(ys.slice(1).map((y, i) => y - ys[i]!)).toEqual([48, 48, 48]);
  });

  it('sets a memory at the middle of the memories that rely on it', () => {
    const layout = all();
    const reports = ['key-load-test', 'replay-test', 'state-check', 'key-expiry-review'];
    const middle = reports.reduce((sum, id) => sum + centre(at(layout, id)), 0) / reports.length;
    expect(centre(at(layout, 'dedupe-by-key'))).toBe(middle);
    expect(centre(at(layout, 'one-way-states'))).toBe(centre(at(layout, 'state-check')));
    expect(path(layout, 'one-way-states', 'state-check')).toMatch(/^M\S+ \S+ H\S+$/);
  });

  it('draws a source once, under a memory that cites it, joined to every memory citing it', () => {
    const layout = all();
    expect(layout.nodes.filter((n) => n.id === 'idempotency.ts')).toHaveLength(1);
    const file = at(layout, 'idempotency.ts');
    expect(file.h).toBe(24);
    expect(file.w).toBeLessThanOrEqual(160);
    const order = at(layout, 'dedupe-by-order');
    expect(file.x + file.w / 2).toBe(order.x + order.w / 2);
    expect(file.y - (order.y + order.h)).toBeGreaterThanOrEqual(24);
    expect(file.y - (order.y + order.h)).toBeLessThanOrEqual(40);
    expect(layout.edges.filter((e) => e.to === 'idempotency.ts').map((e) => e.from)).toEqual([
      'dedupe-by-order',
      'dedupe-by-key',
      'key-expiry-review',
    ]);
    expect(path(layout, 'dedupe-by-order', 'idempotency.ts')).toBe(
      `M${order.x + 80} ${order.y + 32} V${file.y}`,
    );
  });

  it('runs a link from the left edge of the relying memory to the right edge of the one relied on', () => {
    const layout = all();
    const from = at(layout, 'dedupe-by-key');
    const to = at(layout, 'incident-review');
    const d = path(layout, 'dedupe-by-key', 'incident-review')!;
    expect(d.startsWith(`M${from.x} ${centre(from)} C`)).toBe(true);
    expect(d.endsWith(` ${to.x + to.w} ${centre(to)}`)).toBe(true);
    const back = path(layout, 'tolerance-one-again', 'tolerance-one')!;
    const again = at(layout, 'tolerance-one-again');
    const old = at(layout, 'tolerance-one');
    const lift = Math.min(again.y, old.y) - 30;
    expect(back).toBe(
      `M${again.x + 80} ${again.y} C${again.x + 80} ${lift} ${old.x + 80} ${lift} ${old.x + 80} ${old.y}`,
    );
    expect(layout.edges).toHaveLength(project.edges.length);
  });

  it('leaves out the kinds that are not shown, and sources whose memories are all hidden', () => {
    const layout = layoutGraph(project, {
      kinds: new Set(['decision', 'report', 'note', 'url', 'session']),
      tags: false,
    });
    expect(layout.nodes.some((n) => n.source_kind === 'file')).toBe(false);
    expect(layout.edges.some((e) => e.to === 'idempotency.ts')).toBe(false);
    const notes = layoutGraph(project, {
      kinds: new Set(['decision', 'note', 'file', 'url', 'session']),
      tags: false,
    });
    expect(notes.nodes.some((n) => n.kind === 'report')).toBe(false);
    expect(notes.nodes.some((n) => n.id === 'session:reconcile')).toBe(false);
    expect(notes.groups.map((g) => g.count)).toEqual([4, 3, 4, 1]);
  });

  it('adds tag nodes only when asked', () => {
    const tagged = {
      nodes: [...project.nodes, { id: 'tag:refunds', label: 'refunds', kind: 'tag' as const }],
      edges: [
        ...project.edges,
        edge('dedupe-by-key', 'tag:refunds', 'tagged'),
        edge('replay-test', 'tag:refunds', 'tagged'),
      ],
    };
    expect(
      layoutGraph(tagged, { kinds: null, tags: false }).nodes.some((n) => n.kind === 'tag'),
    ).toBe(false);
    const layout = layoutGraph(tagged, { kinds: null, tags: true });
    const tag = at(layout, 'tag:refunds');
    expect(tag.h).toBe(24);
    expect(layout.edges.filter((e) => e.to === 'tag:refunds')).toHaveLength(2);
    const pills = layout.nodes.filter((n) => n.kind === 'source' || n.kind === 'tag');
    for (const a of pills)
      for (const b of pills)
        if (a !== b)
          expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(
            true,
          );
  });

  it('lays out an empty graph as nothing', () => {
    expect(layoutGraph({ nodes: [], edges: [] }, { kinds: null, tags: false })).toEqual({
      width: 0,
      height: 0,
      groups: [],
      nodes: [],
      edges: [],
    });
  });
});
