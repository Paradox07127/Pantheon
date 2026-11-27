import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanItemView, ProjectPlanView, WorkbenchSession } from '@pantheon/protocol';
import { HookHost, find, mount, nodes, unmountAll } from './web-hook-host.js';

const mock = vi.hoisted(() => ({
  plan: { read: null, error: null, loading: false, unavailable: false, stale: false } as any,
}));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/project-plan', () => ({
  useProjectPlan: () => ({ ...mock.plan, reload() {} }),
}));
vi.mock('@/data/project-resident', () => ({
  // Read, with no resident: the main agent is the one active last.
  useProjectResident: () => ({
    read: {
      session_id: null,
      since: null,
      turns: { pantheon: 0, user: 0 },
      budget: null,
      wakes: [],
    },
    error: null,
    loading: false,
    reload() {},
  }),
}));
vi.mock('@/data/projects-summary', () => ({
  useProjectsSummary: () => ({ data: [], loading: false, error: null }),
}));
vi.mock('@/data/project-overlap', () => ({
  useProjectOverlap: () => ({ read: null, error: null, reload() {} }),
}));
const xy = vi.hoisted(() => ({
  ReactFlow: function ReactFlow() {
    return null;
  },
  MiniMap: function MiniMap() {
    return null;
  },
  Background: function Background() {
    return null;
  },
  Handle: function Handle() {
    return null;
  },
  BackgroundVariant: { Dots: 'dots' },
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
}));
vi.mock('../../apps/web/node_modules/@xyflow/react/dist/esm/index.mjs', () => xy);
vi.mock('../../apps/web/node_modules/@xyflow/react/dist/esm/index.js', () => xy);
import { GraphDiagram } from '@/components/visual/GraphDiagram';
import { ItemInspector } from '@/screens/project/ItemInspector';
import { hasDependencies, planFlow } from '@/screens/project/plan-flow';
import { PlanList } from '@/screens/project/PlanList';
import { ProjectScreen } from '@/screens/project/ProjectScreen';
import { zh, zhf } from './i18n-setup.js';

type Plan = NonNullable<ProjectPlanView['plan']>;

const item = (id: string, extra: Partial<PlanItemView> = {}): PlanItemView => ({
  id,
  title: `Title of ${id}`,
  stage: 'plan',
  status: 'not_started',
  gate_runs: [],
  ...extra,
});

const plan = (items: PlanItemView[]): Plan => ({
  session_id: 'lead',
  conductor_open: true,
  revision: 4,
  updated_at: '2026-11-26T09:00:00.000Z',
  milestones: [
    { id: 'signatures', title: 'Signature checks' },
    { id: 'audit', title: 'Audit log' },
  ],
  items,
});

const landed = item('helper', { stage: 'landed', status: 'merged', milestone: 'signatures' });
const writing = item('schema', { stage: 'write', status: 'running', milestone: 'audit' });
const dropped = item('draft', { stage: 'dropped', dropped: true });

describe('the plan as a graph', () => {
  it.each([
    ['offers no graph when no item depends on another', [landed, writing], false],
    [
      'offers the graph when one item depends on another',
      [landed, item('x', { depends_on: ['helper'] })],
      true,
    ],
    [
      'offers no graph when the only dependency is on a dropped item',
      [dropped, item('x', { depends_on: ['draft'] })],
      false,
    ],
    [
      'offers no graph when the only dependency is on an unknown item',
      [item('x', { depends_on: ['gone'] })],
      false,
    ],
    [
      'offers no graph when only a dropped item has a dependency',
      [landed, item('y', { stage: 'dropped', dropped: true, depends_on: ['helper'] })],
      false,
    ],
  ] as const)('%s', (_name, items, offered) => {
    expect(hasDependencies(plan([...items]))).toBe(offered);
  });

  it.each([
    [
      'one dependency is one edge from the item waited for',
      [landed, item('x', { depends_on: ['helper'] })],
      [['helper', 'x']],
    ],
    [
      'a dependency on a dropped item is not drawn',
      [dropped, item('x', { depends_on: ['draft'] })],
      [],
    ],
    ['a dependency on an unknown item is not drawn', [item('x', { depends_on: ['gone'] })], []],
  ] as const)('%s', (_name, items, edges) => {
    const flow = planFlow(plan([...items]));
    expect(flow.edges.map((edge) => [edge.from, edge.to])).toEqual(
      edges.map((ends) => ends.map((id) => `item:${id}`)),
    );
    expect(flow.nodes.map((node) => node.id)).not.toContain('item:draft');
  });

  it.each([
    ['solid once the item waited for landed', landed, 'main'],
    ['dashed while the item waited for has not landed', writing, 'async'],
  ] as const)('draws an edge %s', (_name, upstream, style) => {
    const flow = planFlow(plan([upstream, item('x', { depends_on: [upstream.id] })]));
    expect(flow.edges).toEqual([{ from: `item:${upstream.id}`, to: 'item:x', style }]);
  });

  it.each([
    [
      'a failed item with its stage, evidence and the reason it failed',
      item('x', {
        stage: 'checks',
        status: 'failed',
        evidence: { level: 'report' },
        failure: { reason: 'webhook.rejects_stale failed twice', at: 't', handled_by: 'you' },
      }),
      { status: 'failed', detail: ['检查 3/5', '只是自报', 'webhook.rejects_stale failed twice'] },
    ],
    ['a landed item with every stage done', landed, { status: 'done', detail: ['已落地 5/5'] }],
    ['an item not started without a status', item('x'), { detail: ['未开始 0/5'] }],
  ] as const)('shows %s', (_name, shown, expected) => {
    const [node] = planFlow(plan([shown])).nodes;
    expect(node).toMatchObject({ label: shown.title, ...expected });
    if (!('status' in expected)) expect(node).not.toHaveProperty('status');
  });

  it('puts the items of a milestone in its group and the items outside milestones in none', () => {
    const flow = planFlow(plan([landed, writing, item('loose')]));
    expect(flow.groups).toEqual([
      { id: 'milestone:signatures', label: 'Signature checks' },
      { id: 'milestone:audit', label: 'Audit log' },
    ]);
    expect(flow.nodes.map((node) => node.group)).toEqual([
      'milestone:signatures',
      'milestone:audit',
      undefined,
    ]);
  });
});

describe('the list or flow switch', () => {
  const stored = new Map<string, string>();
  const hosts: HookHost<any>[] = [];
  beforeEach(() => {
    stored.clear();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    });
  });
  afterEach(() => {
    hosts.splice(0).forEach((h) => h.unmount());
    unmountAll();
    vi.unstubAllGlobals();
  });

  const read = (items: PlanItemView[]) => {
    mock.plan = { ...mock.plan, read: { plan: plan(items), unplanned: [] } };
  };
  const screen = () =>
    mount(
      () =>
        ProjectScreen({ projectId: 'alpha', sessions: [] as WorkbenchSession[] }) as ReactElement,
    );
  const switchOf = (tree: unknown) =>
    nodes(tree as ReactElement).find((n) => n.props['aria-label'] === zh('project.plan.view'));
  const listOf = (tree: unknown) => find(tree as ReactElement, (n) => n.type === PlanList);

  // The graph's box gets an element and a width before its draw reads them.
  async function drawn(props: () => Parameters<typeof GraphDiagram>[0]) {
    const h = new HookHost(
      () => GraphDiagram(props()),
      (tree) => {
        for (const node of nodes(tree as ReactNode))
          if (node.props.ref && typeof node.props.ref === 'object') node.props.ref.current ??= {};
      },
    );
    hosts.push(h);
    h.render();
    const box = find(h.value, (n) => n.props.ref?.current).props.ref.current;
    Object.defineProperties(box, { clientWidth: { value: 960 }, clientHeight: { value: 440 } });
    const deadline = Date.now() + 10_000;
    while (!nodes(h.value).some((n) => n.type === xy.ReactFlow)) {
      if (Date.now() > deadline)
        throw new Error(
          `the graph did not draw; last render: ${JSON.stringify(
            nodes(h.value).map((n) => [
              typeof n.type === 'string' ? n.type : n.type?.name,
              n.props.className,
            ]),
          )}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 0));
      await h.flush();
    }
    return h;
  }

  it('switches to the flow, where a node found by its name opens the same details as its row', async () => {
    read([landed, writing, item('viewer', { depends_on: ['schema'] })]);
    const h = screen();
    expect(listOf(h.value).props.view).toBe('list');
    expect(switchOf(h.value)).toBeDefined();
    switchOf(h.value)!.props.onValueChange('flow');
    h.render();
    expect(stored.get('pantheon.planView.alpha')).toBe('flow');
    const list = listOf(h.value);
    expect(list.props.view).toBe('flow');
    const shown = mount(() => PlanList(list.props) as ReactElement);
    const graph = find(shown.value, (n) => n.type === GraphDiagram);
    const g = await drawn(() => graph.props);
    const flow = find(g.value, (n) => n.type === xy.ReactFlow);
    expect(flow.props.nodesFocusable).toBe(true);
    const name = zhf('visual.graph.nodeStatus', {
      name: 'Title of schema',
      status: zh('visual.graph.status.running'),
    });
    const node = flow.props.nodes.find((n: { ariaLabel?: string }) => n.ariaLabel === name);
    expect(node.id).toBe('item:schema');
    flow.props.onNodeClick({}, node);
    h.render();
    expect(find(h.value, (n) => n.type === ItemInspector).props.item.id).toBe('schema');
    find(g.value, (n) => n.props['data-direction']).props.onKeyDown({
      key: 'Enter',
      target: { closest: () => ({ dataset: { id: 'item:viewer' } }) },
      preventDefault() {},
    });
    h.render();
    expect(find(h.value, (n) => n.type === ItemInspector).props.item.id).toBe('viewer');
  });

  it('draws an item whose id is a milestone group id beside that group, and opens that item', async () => {
    const clash = item('milestone:audit', { milestone: 'audit', depends_on: ['schema'] });
    read([landed, writing, clash]);
    stored.set('pantheon.planView.alpha', 'flow');
    const h = screen();
    const shown = mount(() => PlanList(listOf(h.value).props) as ReactElement);
    const spec = find(shown.value, (n) => n.type === GraphDiagram).props.spec;
    expect(spec.groups.map((g: { id: string }) => g.id)).toContain('milestone:audit');
    const ids = spec.nodes.map((n: { id: string }) => n.id);
    expect(ids).toHaveLength(3);
    for (const id of ids) expect(spec.groups.map((g: { id: string }) => g.id)).not.toContain(id);
    const g = await drawn(() => find(shown.value, (n) => n.type === GraphDiagram).props);
    const flow = find(g.value, (n) => n.type === xy.ReactFlow);
    const cards = flow.props.nodes.filter((n: { type: string }) => n.type === 'card');
    expect(cards).toHaveLength(3);
    expect(flow.props.nodes.filter((n: { type: string }) => n.type === 'group')).toHaveLength(2);
    const node = cards.find(
      (n: { data: { node: { label: string } } }) =>
        n.data.node.label === 'Title of milestone:audit',
    );
    flow.props.onNodeClick({}, node);
    h.render();
    expect(find(h.value, (n) => n.type === ItemInspector).props.item.id).toBe('milestone:audit');
  });

  it('keeps the graph and the inspector on one selection both ways', async () => {
    read([landed, writing, item('viewer', { depends_on: ['schema'] })]);
    stored.set('pantheon.planView.alpha', 'flow');
    const h = screen();
    const inspected = () => nodes(h.value).find((n) => n.type === ItemInspector);
    const shown = mount(() => PlanList(listOf(h.value).props) as ReactElement);
    const g = await drawn(() => find(shown.value, (n) => n.type === GraphDiagram).props);
    // The screen holds the selection, the list passes it down, the graph draws it.
    const sync = () => {
      h.render();
      shown.render();
      g.render();
    };
    const flow = () => find(g.value, (n) => n.type === xy.ReactFlow);
    const picked = () =>
      flow()
        .props.nodes.filter((n: { selected?: boolean }) => n.selected)
        .map((n: { id: string }) => n.id);
    const schema = flow().props.nodes.find((n: { id: string }) => n.id === 'item:schema');
    flow().props.onNodeClick({}, schema);
    sync();
    expect(inspected()?.props.item.id).toBe('schema');
    expect(picked()).toEqual(['item:schema']);
    flow().props.onPaneClick();
    sync();
    expect(inspected()).toBeUndefined();
    expect(picked()).toEqual([]);
    flow().props.onNodeClick({}, schema);
    sync();
    find(g.value, (n) => n.props['data-direction']).props.onKeyDown({
      key: 'Escape',
      stopPropagation() {},
    });
    sync();
    expect(inspected()).toBeUndefined();
    expect(picked()).toEqual([]);
    flow().props.onNodeClick({}, schema);
    sync();
    inspected()!.props.onClose();
    sync();
    expect(inspected()).toBeUndefined();
    expect(picked()).toEqual([]);
  });

  it('opens on the view stored for the project', () => {
    stored.set('pantheon.planView.alpha', 'flow');
    read([landed, item('x', { depends_on: ['helper'] })]);
    expect(listOf(screen().value).props.view).toBe('flow');
  });

  it('offers no flow and shows the list without dependencies, whatever view is stored', () => {
    stored.set('pantheon.planView.alpha', 'flow');
    read([landed, writing]);
    const h = screen();
    const choices = nodes(switchOf(h.value))
      .filter((n) => n.props.value !== undefined && n.props.onValueChange === undefined)
      .map((n) => n.props.value);
    expect(choices).toEqual(['list', 'history']);
    expect(listOf(h.value).props.view).toBe('list');
  });

  it('shows the list when the stored view cannot be read', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('storage is off');
      },
    });
    read([landed, item('x', { depends_on: ['helper'] })]);
    expect(listOf(screen().value).props.view).toBe('list');
  });
});
