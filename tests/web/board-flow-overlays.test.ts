import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ReactElement } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { HookHost, find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true, useId: 'flow' }),
);
const view = vi.hoisted(() => ({ setViewport: vi.fn(), zoom: 1 }));
vi.mock('../../apps/web/node_modules/@xyflow/react/dist/esm/index.mjs', async (actual) => ({
  ...(await actual<object>()),
  useReactFlow: () => ({
    setViewport: view.setViewport,
    getViewport: () => ({ x: 0, y: 0, zoom: view.zoom }),
  }),
}));
const { runCommand } = vi.hoisted(() => ({ runCommand: vi.fn() }));
vi.mock('@/data/commands', () => ({ runCommand }));
import { FlowChart } from '@/screens/board/FlowPanel';
import { ConnectionLine, DraftCard, FlowLegend } from '@/screens/board/FlowOverlays';
import { NODE_HEIGHT } from '@/screens/board/flow-layout';
import { MergedStack, stackMerged } from '@/screens/board/MergedStack';
import { MilestoneNode } from '@/screens/board/MilestoneNode';
import { VerifyBadge } from '@/screens/board/MilestoneCard';
import { addDraftEdit, discardDraftEdits, draftEdits } from '@/data/plan-draft';
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

const merged = (id: string): Partial<Task> => ({
  state: 'merged',
  status: 'done',
  milestone_id: 'm1',
  started_at: NOW - 3_600_000,
  ended_at: NOW - 1_800_000,
});

const edge = (from: string, to: string) => ({
  from: `lead-1:${from}`,
  to: `lead-1:${to}`,
  state: 'pending' as const,
});

// a and b merged and feed c; c feeds d; c and d belong to the milestone, d waits for the user.
const board = (extra: Partial<BoardModel> = {}): BoardModel =>
  ({
    since: 0,
    now: NOW,
    lanes: [{ id: 'lead-1:main', title: 'main' }],
    merges: [],
    tasks: [
      task('a', merged('a')),
      task('b', merged('b')),
      task('c', { depends_on: ['a', 'b'], milestone_id: 'm1' }),
      task('d', { depends_on: ['c'], milestone_id: 'm1', state: 'waiting_approval' }),
      task('e'),
    ],
    edges: [edge('a', 'c'), edge('b', 'c'), edge('c', 'd')],
    milestones: [
      {
        id: 'm1',
        title: 'ship refunds',
        session_ids: [],
        merged: 0,
        status: 'active',
        criteria: [
          { text: 'one', accepted: true },
          { text: 'two', accepted: false },
        ],
        owner_session_id: 'lead-1',
        tasks: { done: 2, total: 4 },
        due_on: '2026-11-12',
      },
    ],
    needs: [
      {
        kind: 'approval',
        session_id: 's-d',
        task_id: 'lead-1:d',
        unblocks: 0,
      },
    ],
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
    ...extra,
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
const flowText = (key: string, values: Record<string, string | number> = {}) =>
  Object.entries(values).reduce(
    (said, [name, value]) => said.replace(`{${name}}`, String(value)),
    zh(`board.flow.${key}`),
  );

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
  view.setViewport.mockReset();
  view.zoom = 1;
});
afterEach(() => {
  unmountAll();
  hosts.splice(0).forEach((h) => h.unmount());
  discardDraftEdits('project-a');
  vi.unstubAllGlobals();
});

type ChartProps = Parameters<typeof FlowChart>[0];
const isBox = (n: ReactElement<any>) => String(n.props.className ?? '').startsWith('bd-fc');

/** The innermost element around the React Flow chart. */
const paneOf = (tree: ReactElement<any>) =>
  nodes(tree)
    .filter((n) => typeof n.type === 'string' && nodes(n).some((c) => 'nodeTypes' in c.props))
    .at(-1);

/**
 * The canvas laid out 1000px wide and 900px high, of which the chart pane takes 840px above the
 * legend row; `focused` collects the nodes the chart moves focus to.
 */
function canvas(props: Partial<ChartProps> = {}) {
  const focused: string[] = [];
  const all = {
    model: board(),
    selected: null,
    onSelect() {},
    title: 'flow',
    tell,
    ...props,
  } as ChartProps;
  const Canvas = named(FlowChart(all), 'FlowCanvas').type as (p: ChartProps) => ReactElement<any>;
  const h = new HookHost(
    () => Canvas(all),
    (tree) => {
      const pane = paneOf(tree)?.props.ref;
      if (pane) pane.current ??= { clientWidth: 1000, clientHeight: 840 };
      return (find(tree, isBox).props.ref.current ??= {
        clientWidth: 1000,
        clientHeight: 900,
        querySelectorAll: () =>
          ['lead-1:c', 'lead-1:d'].map((id) => ({
            getAttribute: () => id,
            focus: () => focused.push(id),
          })),
      });
    },
  );
  hosts.push(h);
  h.render();
  const flow = () => find(h.value, (n) => 'nodeTypes' in n.props).props;
  const node = (id: string) => flow().nodes.find((n: { id: string }) => n.id === id);
  return { h, flow, node, focused };
}

describe('the flow chart draft', () => {
  it('drafts a dependency dragged on the chart instead of sending it', async () => {
    const { flow, h } = canvas({ editing: true });
    flow().onConnect({ source: 'lead-1:e', target: 'lead-1:d' });
    await h.flush();
    expect(runCommand).not.toHaveBeenCalled();
    expect(draftEdits('project-a').map((d) => [d.target.taskId, d.ops])).toEqual([
      ['lead-1:d', [{ type: 'set_dependencies', task_id: 'd', depends_on: ['c', 'e'] }]],
    ]);
  });

  it('keeps one drafted list per task and drops it once it is back to the plan', () => {
    const { flow, h } = canvas({ editing: true });
    const edge = (id: string) => flow().edges.find((e: { id: string }) => e.id === id);
    flow().onConnect({ source: 'lead-1:e', target: 'lead-1:d' });
    h.render();
    expect(edge('lead-1:e->lead-1:d').className).toContain('draft');
    edge('lead-1:c->lead-1:d').data.onDelete();
    h.render();
    expect(draftEdits('project-a').map((d) => d.ops)).toEqual([
      [{ type: 'set_dependencies', task_id: 'd', depends_on: ['e'] }],
    ]);
    flow().onConnect({ source: 'lead-1:c', target: 'lead-1:d' });
    h.render();
    edge('lead-1:e->lead-1:d').data.onDelete();
    h.render();
    expect(draftEdits('project-a')).toEqual([]);
  });

  it('shows connection points only while the chart is edited', () => {
    expect(canvas().flow().nodesConnectable).toBe(false);
    expect(canvas().node('lead-1:c').data.editable).toBe(false);
    const edited = canvas({ editing: true });
    expect(edited.flow().nodesConnectable).toBe(true);
    expect(edited.node('lead-1:c').data.editable).toBe(true);
  });

  it('marks the nodes whose acceptance or upstream tasks the draft changed, and no other', () => {
    const model = board();
    model.tasks[2] = { ...model.tasks[2]!, acceptance_checks: [{ text: 'one', state: 'pending' }] };
    const target = (planId: string) => ({
      projectId: 'project-a',
      leadId: 'lead-1',
      planId,
      taskId: `lead-1:${planId}`,
    });
    addDraftEdit(target('c'), [
      { type: 'set_task', task_id: 'c', patch: { acceptance: ['one', 'two'] } },
    ]);
    addDraftEdit(target('d'), [{ type: 'set_dependencies', task_id: 'd', depends_on: ['c', 'e'] }]);
    const { node } = canvas({ model, editing: true });
    expect(node('lead-1:c').data.drafted).toEqual({ acceptance: 1 });
    expect(node('lead-1:d').data.drafted).toEqual({ upstream: true });
    expect(node('lead-1:e').data.drafted).toBeUndefined();
  });

  it('draws a drafted new task as a dashed node after its upstream task', () => {
    addDraftEdit({ projectId: 'project-a', leadId: 'lead-1', planId: 'f', taskId: 'lead-1:f' }, [
      {
        type: 'add_task',
        task: {
          id: 'f',
          title: 'retry refunds',
          goal: 'g',
          lane: 'main',
          depends_on: ['d'],
          source: ['s'],
          scope: ['src'],
          acceptance: ['pnpm test', 'pnpm lint'],
          runtime: 'codex',
        },
      },
    ]);
    const { flow, node } = canvas();
    const draft = node('lead-1:f');
    expect(draft.type).toBe('draft');
    expect(
      flow().edges.find((e: { id: string }) => e.id === 'lead-1:d->lead-1:f').className,
    ).toContain('draft');
    const card = DraftCard({ data: draft.data } as never);
    expect(find(card, (n) => n.props['data-look'] === 'queue')).toBeTruthy();
    expect(text(card)).toContain(flowText('draft.unsent'));
    expect(text(card)).toContain('验收 2 条');
  });
});

describe('the flow chart overlays', () => {
  it('stacks the merged tasks of a band into one node that opens to list them', () => {
    const selected: string[] = [];
    const { flow, node, h } = canvas({ onSelect: (id) => selected.push(id) });
    const ids = flow().nodes.map((n: { id: string }) => n.id);
    expect(ids).not.toContain('lead-1:a');
    const stack = node('stack:lead-1:main');
    expect(stack.type).toBe('stack');
    expect(flow().edges.map((e: { id: string }) => e.id)).toContain('stack:lead-1:main->lead-1:c');
    const closed = MergedStack({ data: stack.data } as never);
    const toggle = find(closed, (n) => n.props['aria-expanded'] !== undefined);
    expect(toggle.props['aria-expanded']).toBe(false);
    expect(toggle.props['aria-label']).toBe(flowText('stack.label', { count: 2 }));
    toggle.props.onClick();
    h.render();
    const opened = MergedStack({ data: node('stack:lead-1:main').data } as never);
    expect(find(opened, (n) => n.props['aria-expanded'] !== undefined).props['aria-expanded']).toBe(
      true,
    );
    find(opened, (n) => n.type === 'button' && text(n).includes('task b')).props.onClick();
    expect(selected).toEqual(['lead-1:b']);
  });

  it('leaves out of a stack the merged task that would make its edges run in a circle', () => {
    // a feeds b on another line, which feeds c; d stands alone on a's line.
    const side = { ...merged('b'), lane_id: 'lead-1:side' };
    const { model, stackOf } = stackMerged(
      board({
        tasks: [
          task('a', merged('a')),
          task('b', side),
          task('c', { ...merged('c'), depends_on: ['b'] }),
          task('d', merged('d')),
        ],
        edges: [
          { ...edge('a', 'b'), state: 'met' },
          { ...edge('b', 'c'), state: 'met' },
        ],
      }),
      'lane',
    );
    const after = (id: string) => {
      const seen = new Set<string>();
      for (let next = [id]; next.length;)
        next = model.edges
          .filter((e) => next.includes(e.from) && !seen.has(e.to))
          .map((e) => (seen.add(e.to), e.to));
      return seen;
    };
    for (const t of model.tasks) expect([...after(t.id)]).not.toContain(t.id);
    expect([...stackOf]).toEqual([
      ['lead-1:a', 'stack:lead-1:main'],
      ['lead-1:d', 'stack:lead-1:main'],
    ]);
  });

  it('gives an edge that several stacked tasks share the state of the one furthest from met', () => {
    const { model } = stackMerged(
      board({
        tasks: [task('a', merged('a')), task('b', merged('b')), task('c')],
        edges: [
          { ...edge('a', 'c'), state: 'met' },
          { ...edge('b', 'c'), state: 'active' },
        ],
      }),
      'lane',
    );
    expect(model.edges).toEqual([{ from: 'stack:lead-1:main', to: 'lead-1:c', state: 'active' }]);
  });

  it('ends the chart in the current milestone, which starts its next ready task', async () => {
    const model = board();
    model.tasks[3] = { ...model.tasks[3]!, state: 'todo' };
    model.tasks.push(task('g', { milestone_id: 'm1' }));
    const { flow, node } = canvas({ model });
    const milestone = node('milestone:m1');
    expect(milestone.type).toBe('milestone');
    const into = flow()
      .edges.filter((e: { target: string }) => e.target === 'milestone:m1')
      .map((e: { source: string }) => e.source);
    expect(into.sort()).toEqual(['lead-1:d', 'lead-1:g']);
    // c is the milestone's first task whose upstream tasks merged.
    expect(milestone.data.next.id).toBe('lead-1:c');
    const host = mount(() => MilestoneNode({ data: milestone.data } as never));
    expect(text(host.value)).toContain('2 / 4');
    expect(text(host.value)).toContain(flowText('milestone.criteria', { accepted: 1, count: 2 }));
    const start = flowText('milestone.startLabel', { task: 'task c' });
    find(host.value, (n) => n.props['aria-label'] === start).props.onClick();
    await host.flush();
    expect(runCommand.mock.calls).toEqual([
      ['task.start', { project_id: 'project-a', lead_session_id: 'lead-1', task_ids: ['c'] }, null],
    ]);
  });

  it.each([
    ['passed', 'board.verify.badge.passed'],
    ['failed', 'board.verify.badge.failed'],
    ['inconclusive', 'board.verify.badge.inconclusive'],
  ] as const)('names the milestone node with its %s verification', (state, id) => {
    const model = board();
    model.milestones[0] = {
      ...model.milestones[0]!,
      verification: {
        id: 'verify-1',
        state,
        started_at: NOW - 60_000,
        finished_at: NOW,
        failed: [],
        commands: [],
      },
    };
    const milestone = canvas({ model }).node('milestone:m1');
    expect(milestone.ariaLabel).toContain('ship refunds');
    expect(milestone.ariaLabel).toContain(zh(id));
    const host = mount(() => MilestoneNode({ data: milestone.data } as never));
    const badge = find(host.value, (n) => n.type === VerifyBadge);
    const drawn = VerifyBadge(badge.props)!;
    expect(find(drawn, (n) => n.props.role === 'img').props['aria-label']).toBe(zh(id));
  });

  it('draws the link from merged work into the milestone as met', () => {
    const model = board();
    model.tasks = model.tasks.map((t) =>
      ['lead-1:c', 'lead-1:d'].includes(t.id) ? { ...t, milestone_id: null } : t,
    );
    const { flow } = canvas({ model });
    const into = flow().edges.filter((e: { target: string }) => e.target === 'milestone:m1');
    expect(
      into.map((e: { source: string; data: { state: string } }) => [e.source, e.data.state]),
    ).toEqual([['stack:lead-1:main', 'met']]);
  });

  it('offers a jump to the next task waiting for the user, without a count of its own', () => {
    const { h, focused } = canvas();
    const count = named(h.value, 'NeedsCount');
    const drawn = mount(() => (count.type as (p: object) => ReactElement)(count.props)).value;
    expect(text(drawn)).toBe('');
    expect(
      nodes(drawn)
        .map((n) => n.props['aria-label'] ?? null)
        .filter(Boolean),
    ).toEqual([zh('board.flow.needs.next')]);
    view.setViewport.mockClear();
    count.props.onNext();
    expect(view.setViewport).toHaveBeenCalledTimes(1);
    expect(view.setViewport.mock.calls[0]![0]).toMatchObject({ zoom: 1 });
    expect(focused).toEqual(['lead-1:d']);
  });

  const leadQuestion = { kind: 'lead.question', session_id: 'lead-1', unblocks: 0 };
  it.each<[string, unknown[], number]>([
    [
      'leaves out a lead question, which has no task on the chart',
      [board().needs![0], leadQuestion],
      1,
    ],
    ['offers no jump while only lead questions wait', [leadQuestion], 0],
  ])('offers the jump only to what it reaches: %s', (_, needs, count) => {
    const { h } = canvas({ model: board({ needs } as Partial<BoardModel>) });
    const shown = nodes(h.value).filter((n) => (n.type as { name?: string }).name === 'NeedsCount');
    expect(shown).toHaveLength(count);
    expect(shown.every((n) => typeof n.props.onNext === 'function')).toBe(true);
  });

  it('centres the jumped-to task in the chart as tall as it is shown, not as the graph is drawn', () => {
    const { h, node } = canvas();
    view.setViewport.mockClear();
    named(h.value, 'NeedsCount').props.onNext();
    const { y } = view.setViewport.mock.calls[0]![0];
    expect(y + node('lead-1:d').position.y + NODE_HEIGHT / 2).toBe(420);
  });

  it('draws a past moment without the stacks, milestone, needs and part statuses of now', () => {
    const model = board();
    model.tasks[2] = {
      ...model.tasks[2]!,
      parallel: [{ title: 'part one', session_id: 's-p', status: 'done' }],
      subagents: 3,
    };
    const states = new Map<string, Task['status']>(model.tasks.map((t) => [t.id, 'todo']));
    states.set('lead-1:a', 'running');
    const { h, flow, node } = canvas({ model, states });
    const ids = flow().nodes.map((n: { id: string }) => n.id);
    expect(ids).toEqual(expect.arrayContaining(['lead-1:a', 'lead-1:b']));
    expect(ids.filter((id: string) => /^(stack|milestone):/.test(id))).toEqual([]);
    expect(node('lead-1:a').data.task.status).toBe('running');
    expect(node('lead-1:c').data.task.parallel).toBeUndefined();
    expect(node('lead-1:c').data.task.subagents).toBeUndefined();
    expect(nodes(h.value).some((n) => (n.type as { name?: string }).name === 'NeedsCount')).toBe(
      false,
    );
  });

  it('lays the legend and the zoom controls out in one wrapping row instead of guessing the toolbar width', () => {
    const { h } = canvas();
    const row = find(h.value, (n) => n.props.className === 'bd-fo-bar');
    expect(
      ([row.props.children].flat() as ReactElement<any>[]).map((n) =>
        n.type === FlowLegend ? 'legend' : n.props.className,
      ),
    ).toEqual(['legend', 'bd-zm']);
    const css = (file: string) =>
      readFileSync(new URL(`../../apps/web/src/screens/board/${file}`, import.meta.url), 'utf8');
    expect(css('flow-overlays.css')).toMatch(
      /\.bd-fo-bar \{[^}]*display: flex;[^}]*flex-wrap: wrap;/,
    );
    expect(css('flow-overlays.css')).not.toMatch(/\.bd-fo-lg \{[^}]*right:/);
    expect(css('flow-overlays.css')).not.toMatch(/\.bd-fo-lg \.legend \{[^}]*nowrap/);
    expect(css('flow.css')).not.toMatch(/\.bd-zm \{[^}]*position: absolute;/);
  });

  it('keeps the legend and the zoom controls out of the element that draws the nodes', () => {
    const { h } = canvas();
    const pane = paneOf(h.value)!;
    expect(nodes(h.value).some((n) => n.type === FlowLegend)).toBe(true);
    expect(nodes(pane).some((n) => n.type === FlowLegend)).toBe(false);
    expect(nodes(pane).some((n) => n.props['aria-label'] === zh('board.canvas.zoom.label'))).toBe(
      false,
    );
  });

  it('keeps every node inside the chart pane at the fitted view, the legend row taking none of its height', () => {
    const { h, flow } = canvas();
    const pane = paneOf(h.value)!;
    const { y, zoom } = view.setViewport.mock.calls.at(-1)![0];
    const bottom = Math.max(
      ...flow().nodes.map(
        (n: { position: { y: number }; initialHeight: number }) => n.position.y + n.initialHeight,
      ),
    );
    expect(Number.parseFloat(pane.props.style?.['--bd-fc-h'])).toBeGreaterThanOrEqual(
      y + bottom * zoom,
    );
    expect(nodes(pane).some((n) => n.type === FlowLegend)).toBe(false);
  });

  it('names five node colours in the legend', () => {
    const legend = FlowLegend();
    expect(
      nodes(legend)
        .filter((n) => n.props['data-c'])
        .map((n) => n.props['data-c']),
    ).toEqual(['ok', 'run', 'wait', 'review', 'bad']);
    expect(text(legend)).toBe(
      ['merged', 'running', 'waiting', 'review', 'failed']
        .map((key) => flowText(`legend.${key}`))
        .join(''),
    );
  });

  it('ends the dragged dependency in a dot under the pointer', () => {
    expect(canvas({ editing: true }).flow().connectionLineComponent).toBe(ConnectionLine);
    const line = ConnectionLine({
      fromX: 0,
      fromY: 0,
      toX: 40,
      toY: 30,
      fromPosition: 'right',
      toPosition: 'left',
    } as never);
    expect(find(line, (n) => n.type === 'circle').props).toMatchObject({ cx: 40, cy: 30, r: 4 });
  });
});
