import { describe, expect, it, vi } from 'vitest';
import type {
  ChangeStory,
  FlowDiagram,
  StoryCard,
  StoryResult,
  TypeDiagram,
} from '@pantheon/domain';
import { nodes } from './web-hook-host.js';

vi.mock('react', async (actual) => ({ ...(await actual<object>()), useId: () => 'story' }));

import type { LandedPoint } from '@/screens/sessions/story/model';
import {
  decisionStatus,
  elementStatus,
  layoutFlow,
  typeRows,
} from '@/screens/sessions/story/story-diagram';
import { StoryView } from '@/screens/sessions/story/StoryView';

const dispatchFlow: FlowDiagram = {
  type: 'flow',
  title: 'who picks the next writer',
  lanes: ['planner', 'controller', 'lead', 'writer'],
  nodes: [
    { id: 'plan', label: 'split backlog', lane: 'planner', side: 'both' },
    { id: 'signal', label: 'progress signal', lane: 'controller', side: 'both' },
    { id: 'rule', label: 'dispatch by rule', lane: 'controller', side: 'after' },
    { id: 'session', label: 'start lead session', lane: 'lead', side: 'before' },
    { id: 'pick', label: 'lead picks writer', lane: 'lead', side: 'before' },
    { id: 'write', label: 'writer starts', lane: 'writer', side: 'both' },
  ],
  edges: [
    { from: 'plan', to: 'signal', side: 'both' },
    { from: 'signal', to: 'session', side: 'before' },
    { from: 'session', to: 'pick', side: 'before' },
    { from: 'pick', to: 'write', side: 'before' },
    { from: 'signal', to: 'rule', side: 'after' },
    { from: 'rule', to: 'write', side: 'after' },
  ],
};

const overlaps = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe('elementStatus', () => {
  it.each([
    ['before', 'overlay', 'removed'],
    ['after', 'overlay', 'added'],
    ['both', 'overlay', 'same'],
    ['before', 'before', 'same'],
    ['after', 'before', 'hidden'],
    ['both', 'before', 'same'],
    ['before', 'after', 'hidden'],
    ['after', 'after', 'same'],
    ['both', 'after', 'same'],
  ] as const)('%s element in the %s view is %s', (side, view, status) => {
    expect(elementStatus(side, view)).toBe(status);
  });
});

describe('layoutFlow', () => {
  it('gives the same positions on every call', () => {
    expect(layoutFlow(dispatchFlow)).toEqual(layoutFlow(dispatchFlow));
  });

  it('keeps before-only and after-only nodes apart', () => {
    const layout = layoutFlow(dispatchFlow);
    const side = new Map(dispatchFlow.nodes.map((n) => [n.id, n.side]));
    const before = layout.nodes.filter((n) => side.get(n.id) === 'before');
    const after = layout.nodes.filter((n) => side.get(n.id) === 'after');
    expect(before.length).toBeGreaterThan(0);
    expect(after.length).toBeGreaterThan(0);
    for (const a of before) for (const b of after) expect(overlaps(a, b)).toBe(false);
    for (const a of layout.nodes)
      for (const b of layout.nodes) if (a !== b) expect(overlaps(a, b)).toBe(false);
  });

  it('stacks lanes downward in spec order and puts each node in its lane', () => {
    const layout = layoutFlow(dispatchFlow);
    expect(layout.lanes.map((l) => l.name)).toEqual(dispatchFlow.lanes);
    for (let i = 1; i < layout.lanes.length; i++)
      expect(layout.lanes[i]!.y).toBeGreaterThan(layout.lanes[i - 1]!.y);
    for (const n of dispatchFlow.nodes) {
      const lane = layout.lanes.find((l) => l.name === n.lane)!;
      const box = layout.nodes.find((b) => b.id === n.id)!;
      expect(box.y).toBeGreaterThanOrEqual(lane.y);
      expect(box.y + box.height).toBeLessThanOrEqual(lane.y + lane.height);
    }
  });

  it('places a node right of its upstream node', () => {
    const layout = layoutFlow(dispatchFlow);
    const x = new Map(layout.nodes.map((n) => [n.id, n.x]));
    expect(x.get('signal')!).toBeGreaterThan(x.get('plan')!);
    expect(x.get('write')!).toBeGreaterThan(x.get('pick')!);
  });

  it('finishes on a cycle and a self loop', () => {
    const looped: FlowDiagram = {
      ...dispatchFlow,
      edges: [
        ...dispatchFlow.edges,
        { from: 'write', to: 'signal', side: 'both' },
        { from: 'rule', to: 'rule', side: 'after' },
      ],
    };
    const layout = layoutFlow(looped);
    expect(layout.nodes).toHaveLength(dispatchFlow.nodes.length);
    expect(layout.width).toBeGreaterThan(0);
  });
});

describe('typeRows', () => {
  it('marks added, removed, changed and unchanged fields in first-seen order', () => {
    const spec: TypeDiagram = {
      type: 'type',
      name: 'BacklogEntry',
      file: 'packages/domain/src/planning.ts',
      fields: [
        { name: 'key', type: 'string', side: 'both', quote: 'key: string' },
        { name: 'owner', type: 'string', side: 'before', quote: 'owner: string' },
        { name: 'depends_on', type: 'string[]', side: 'before', quote: 'depends_on' },
        { name: 'writer', type: 'ModelProfile', side: 'after', quote: 'writer?' },
        { name: 'depends_on', type: 'TaskReference[]', side: 'after', quote: 'depends_on' },
        { name: 'lane', type: 'string', side: 'before', quote: 'lane: string' },
        { name: 'lane', type: 'string', side: 'after', quote: 'lane: string' },
      ],
    };
    expect(typeRows(spec)).toEqual([
      { name: 'key', before: 'string', after: 'string', status: 'same' },
      { name: 'owner', before: 'string', status: 'removed' },
      { name: 'depends_on', before: 'string[]', after: 'TaskReference[]', status: 'changed' },
      { name: 'writer', after: 'ModelProfile', status: 'added' },
      { name: 'lane', before: 'string', after: 'string', status: 'same' },
    ]);
  });
});

describe('decisionStatus', () => {
  it('is changed only when the outcome differs', () => {
    expect(decisionStatus({ case: 'routine progress', before: 'lead', after: 'controller' })).toBe(
      'changed',
    );
    expect(decisionStatus({ case: 'check failed', before: 'lead', after: 'lead' })).toBe('same');
  });
});

describe('story cards', () => {
  const card: StoryCard = {
    title: 'Login form',
    kind: 'added',
    surface: 'ui',
    acceptance: [],
    before: 'no form',
    after: 'a form',
    how: [],
    hunks: ['H1'],
    tests: [],
    out_of_scope: true,
    evidence: [],
    shared_with: [],
  };
  const result: StoryResult = {
    overall: { before: [], after: [] },
    cards: [card],
    noise: [],
    uninterpreted: [],
    hunk_total: 1,
    unmatched_acceptance: [],
  };
  const story = (id: string): ChangeStory => ({
    id,
    revision: 1,
    project_id: 'project',
    source: '/repo',
    from_sha: 'a0',
    to_sha: 'a1',
    state: 'ready',
    created_at: 1,
    result,
  });
  const point: LandedPoint = {
    kind: 'landed',
    workspace_id: 'session',
    task_goal: 'Add a login form',
    source: '/repo',
    branch: 'main',
    from_sha: 'a0',
    to_sha: 'a1',
    at: 1,
  };
  const cardKeys = (id: string) =>
    nodes(StoryView({ point, story: story(id), result, diff: null, findings: [] }))
      .filter((n) => typeof n.type === 'function' && n.type.name === 'Card')
      .map((n) => n.key);

  it('gives the cards of a replacement story new identities, dropping their revert state', () => {
    const first = cardKeys('story-first');
    const second = cardKeys('story-second');
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]).not.toBe(first[0]);
    expect(cardKeys('story-first')).toEqual(first);
  });
});
