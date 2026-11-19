import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { HookHost, find, named } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true, useId: 'flow' }),
);
vi.mock('../../apps/web/node_modules/@xyflow/react/dist/esm/index.mjs', async (actual) => ({
  ...(await actual<object>()),
  useReactFlow: () => ({ setViewport: async () => true }),
}));
const { runCommand } = vi.hoisted(() => ({ runCommand: vi.fn() }));
vi.mock('@/data/commands', () => ({ runCommand }));
import { FlowChart } from '@/screens/board/FlowPanel';
import { connectRefusal, opChanges, withDependency, withoutDependency } from '@/data/plan-edit';
import { discardDraftEdits, draftEdits } from '@/data/plan-draft';
import type { SnapshotSession } from '@/screens/board/panels-model';

type Task = BoardModel['tasks'][number];
const NOW = Date.UTC(2026, 10, 10, 12);

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id: `lead-1:${id}`,
  owner_session_id: 'lead-1',
  title: `task ${id}`,
  goal: '',
  scope: [],
  lane_id: 'lead-1:main',
  milestone_id: null,
  status: 'todo',
  blockers: [],
  segments: [],
  additions: null,
  deletions: null,
  checks: 'none',
  started_at: null,
  ended_at: null,
  last_progress_at: null,
  blocked_since: null,
  turn_running: false,
  state: 'todo',
  depends_on: [],
  planned: {},
  pending_edit: false,
  ...extra,
});

const edge = (from: string, to: string) => ({
  from: `lead-1:${from}`,
  to: `lead-1:${to}`,
  state: 'pending' as const,
});

// a and b feed c, c feeds d.
const board = (): BoardModel =>
  ({
    since: 0,
    now: NOW,
    lanes: [{ id: 'lead-1:main', title: 'main' }],
    merges: [],
    tasks: [
      task('a'),
      task('b'),
      task('c', {
        depends_on: ['a', 'b'],
        planned: { runtime: 'codex', model: 'gpt-a', effort: 'high' },
      }),
      task('d', { depends_on: ['c'] }),
    ],
    edges: [edge('a', 'c'), edge('b', 'c'), edge('c', 'd')],
    leads: [
      {
        session_id: 'lead-1',
        title: 'lead',
        state: 'idle',
        inbox: 0,
        updated_at: 0,
        plan_version: 7,
        pending_edits: [],
        rejected_edits: [],
      },
    ],
  }) as unknown as BoardModel;

const lead = {
  id: 'lead-1',
  revision: 1,
  project_id: 'project-a',
  runtime: 'fixture',
  state: 'open',
  turn_count: 1,
} as SnapshotSession;
const tell = { sessions: [lead], run: async () => null };

const hosts: HookHost<any>[] = [];
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  runCommand.mockReset();
  runCommand.mockResolvedValue({ ok: true, value: { applied: true, edit_id: 'edit-1' } });
});
afterEach(() => {
  hosts.splice(0).forEach((h) => h.unmount());
  discardDraftEdits('project-a');
  vi.unstubAllGlobals();
});

type ChartProps = Parameters<typeof FlowChart>[0];
const box = (tree: unknown) =>
  find(tree as any, (n) => String(n.props.className ?? '').startsWith('bd-fc'));

/** The canvas under the chart, laid out 1000px wide, with the xyflow element it renders. */
function canvas(props: Partial<ChartProps> = {}) {
  const all: ChartProps = {
    model: board(),
    selected: null,
    onSelect() {},
    title: 'flow',
    tell,
    editing: true,
    ...props,
  };
  const Canvas = named(FlowChart(all), 'FlowCanvas').type as (p: ChartProps) => ReactElement<any>;
  const h = new HookHost(
    () => Canvas(all),
    (tree) => (box(tree).props.ref.current ??= { clientWidth: 1000 }),
  );
  hosts.push(h);
  h.render();
  const flow = () => find(h.value, (n) => 'nodeTypes' in n.props).props;
  return { h, flow, box: () => box(h.value).props, all };
}

const drafted = () => draftEdits('project-a').map((d) => d.ops);

describe('editing dependencies on the flow chart', () => {
  it('removes the dependency a focused edge draws when Delete is pressed', async () => {
    const { flow, box, h } = canvas();
    const id = 'lead-1:a->lead-1:c';
    expect(flow().edges.find((e: { id: string }) => e.id === id).focusable).toBe(true);
    box().onKeyDown({
      key: 'Delete',
      preventDefault() {},
      target: {
        closest: (selector: string) =>
          selector === '.react-flow__edge' ? { getAttribute: () => id } : null,
      },
    });
    await h.flush();
    expect(runCommand).not.toHaveBeenCalled();
    expect(drafted()).toEqual([[{ type: 'set_dependencies', task_id: 'c', depends_on: ['b'] }]]);
  });

  it('shows a delete button on the picked edge that removes its dependency', async () => {
    const { flow, h } = canvas();
    const picked = () => flow().edges.find((e: { id: string }) => e.id === 'lead-1:b->lead-1:c');
    expect(picked().className).not.toContain('pick');
    flow().onEdgeClick({}, picked());
    h.render();
    expect(picked().className).toContain('pick');
    const Edge = flow().edgeTypes.flow as (p: object) => ReactElement<any>;
    const drawn = Edge({
      id: picked().id,
      source: picked().source,
      target: picked().target,
      sourceX: 0,
      sourceY: 0,
      targetX: 100,
      targetY: 0,
      data: picked().data,
    });
    find(drawn, (n) => n.props['aria-label'] === '删除依赖：task b 到 task c').props.onClick();
    await h.flush();
    expect(drafted()).toEqual([[{ type: 'set_dependencies', task_id: 'c', depends_on: ['a'] }]]);
  });

  it('adds a dependency dragged from one task to another', async () => {
    const { flow, h } = canvas();
    const link = { source: 'lead-1:a', target: 'lead-1:d', sourceHandle: null, targetHandle: null };
    expect(flow().nodesConnectable).toBe(true);
    expect(flow().isValidConnection(link)).toBe(true);
    flow().onConnect(link);
    await h.flush();
    expect(drafted()).toEqual([
      [{ type: 'set_dependencies', task_id: 'd', depends_on: ['c', 'a'] }],
    ]);
  });

  it('refuses a dependency that loops back, repeats or points at its own task', async () => {
    const { flow, h } = canvas();
    for (const [source, target] of [
      ['lead-1:d', 'lead-1:a'],
      ['lead-1:a', 'lead-1:c'],
      ['lead-1:a', 'lead-1:a'],
    ]) {
      const link = { source, target, sourceHandle: null, targetHandle: null };
      expect(flow().isValidConnection(link)).toBe(false);
      flow().onConnect(link);
    }
    await h.flush();
    expect(drafted()).toEqual([]);
    const m = board();
    expect(connectRefusal(m, 'lead-1:d', 'lead-1:a')).toBe('cycle');
    expect(connectRefusal(m, 'lead-1:a', 'lead-1:c')).toBe('exists');
    expect(connectRefusal(m, 'lead-1:a', 'lead-1:a')).toBe('self');
    expect(connectRefusal(m, 'lead-1:a', 'lead-1:d')).toBeNull();
  });

  it('keeps the chart read-only without a command runner', () => {
    const { flow } = canvas({ tell: undefined });
    expect(flow().nodesConnectable).toBe(false);
    for (const e of flow().edges) expect(e.focusable).toBe(false);
    expect(flow().onConnect).toBeUndefined();
  });

  it('shows the plan version in the header', () => {
    const { h } = canvas();
    const label = zh('board.plan.flow.version').replace('{version}', '7');
    const chip = find(h.value, (n) => n.props['aria-label'] === label);
    expect(chip.props.children).toEqual(['v', 7]);
  });
});

describe('dependencies only a pending proposal adds', () => {
  // Task e has no dependency of its own; the lead proposes it wait for task a.
  const proposing = (): BoardModel => {
    const m = board();
    return {
      ...m,
      tasks: [...m.tasks, task('e')],
      proposed_edges: [edge('a', 'e')],
    };
  };
  const drawn = (flow: () => any) =>
    flow().edges.find(
      (e: { source: string; target: string }) => e.source === 'lead-1:a' && e.target === 'lead-1:e',
    );

  it('draws a proposed dependency dotted, named as a proposed dependency', () => {
    const { flow } = canvas({ model: proposing() });
    expect(drawn(flow).className.split(' ')).toContain('proposed');
    expect(drawn(flow).ariaLabel).toBe(
      zh('board.plan.flow.proposedEdge').replace('{from}', 'task a').replace('{to}', 'task e'),
    );
    expect(drawn(flow).data.state).toBe('pending');
  });

  it('places every task where it stands without the proposal', () => {
    const plain = board();
    plain.tasks.push(task('e'));
    const places = (model: BoardModel) =>
      canvas({ model })
        .flow()
        .nodes.map((n: { id: string; position: object }) => [n.id, n.position]);
    expect(places(proposing())).toEqual(places(plain));
  });

  it('keeps a task with only a proposed upstream ready to start', () => {
    const { flow } = canvas({ model: proposing() });
    const e = flow().nodes.find((n: { id: string }) => n.id === 'lead-1:e');
    expect(e.data.ready).toBe(true);
  });

  it('neither picks nor removes a proposed dependency while editing', async () => {
    const { flow, box, h } = canvas({ model: proposing() });
    expect(drawn(flow).focusable).toBe(false);
    expect(drawn(flow).data.onDelete).toBeUndefined();
    flow().onEdgeClick({}, drawn(flow));
    h.render();
    expect(drawn(flow).className).not.toContain('pick');
    const id = drawn(flow).id;
    box().onKeyDown({
      key: 'Delete',
      preventDefault() {},
      target: {
        closest: (selector: string) =>
          selector === '.react-flow__edge' ? { getAttribute: () => id } : null,
      },
    });
    await h.flush();
    expect(drafted()).toEqual([]);
  });

  it('draws no proposed dependency at a past moment', () => {
    const { flow } = canvas({ model: proposing(), states: new Map() });
    expect(drawn(flow)).toBeUndefined();
  });
});

describe('plan edit ops', () => {
  it('builds the dependency list without and with an upstream task', () => {
    const m = board();
    expect(withoutDependency(m, 'lead-1:a', 'lead-1:c')).toEqual({
      type: 'set_dependencies',
      task_id: 'c',
      depends_on: ['b'],
    });
    expect(withDependency(m, 'lead-1:b', 'lead-1:d')).toEqual({
      type: 'set_dependencies',
      task_id: 'd',
      depends_on: ['c', 'b'],
    });
  });

  it('keeps an upstream task the board leaves out of the range', () => {
    const m = board();
    // Task a ended before the range: the board has neither its row nor its edge.
    const ranged = {
      ...m,
      tasks: m.tasks.filter((t) => t.id !== 'lead-1:a'),
      edges: m.edges.filter((e) => e.from !== 'lead-1:a'),
    };
    expect(withDependency(ranged, 'lead-1:d', 'lead-1:c')).toMatchObject({
      depends_on: ['a', 'b', 'd'],
    });
    expect(withoutDependency(ranged, 'lead-1:b', 'lead-1:c')).toMatchObject({ depends_on: ['a'] });
  });

  it("sets each op's new values against the task's current ones", () => {
    const m = board();
    const field = (key: string) => zh(`data.planEdit.field.${key}`);
    expect(
      opChanges(m, 'lead-1', {
        type: 'set_task',
        task_id: 'c',
        patch: { model: 'claude-opus', effort: 'xhigh' },
      }),
    ).toEqual([
      { field: field('model'), before: 'gpt-a', after: 'claude-opus' },
      {
        field: field('effort'),
        before: zh('sessions.model.effort.high'),
        after: zh('sessions.model.effort.xhigh'),
      },
    ]);
    expect(
      opChanges(m, 'lead-1', { type: 'set_dependencies', task_id: 'c', depends_on: ['a', 'd'] }),
    ).toEqual([
      { field: field('dependencies'), before: 'task a, task b', after: 'task a, task d' },
    ]);
    expect(opChanges(m, 'lead-1', { type: 'remove_task', task_id: 'c' })).toEqual([
      { field: field('task'), before: 'task c', after: null },
    ]);
  });
});

describe('the flow chart across a selection change', () => {
  it('hands React Flow new node objects only for the tasks that gain or lose the selection', () => {
    const { h, flow, all } = canvas({ selected: 'lead-1:a' });
    type Node = { id: string; data: { selected?: boolean } };
    const before = new Map<string, Node>(flow().nodes.map((n: Node) => [n.id, n]));
    all.selected = 'lead-1:b';
    h.render();
    const after = new Map<string, Node>(flow().nodes.map((n: Node) => [n.id, n]));
    expect(after.get('lead-1:a')!.data.selected).toBe(false);
    expect(after.get('lead-1:b')!.data.selected).toBe(true);
    expect(after.get('lead-1:a')).not.toBe(before.get('lead-1:a'));
    expect(after.get('lead-1:b')).not.toBe(before.get('lead-1:b'));
    expect(after.get('lead-1:c')).toBe(before.get('lead-1:c'));
    expect(after.get('lead-1:d')).toBe(before.get('lead-1:d'));
  });
});
