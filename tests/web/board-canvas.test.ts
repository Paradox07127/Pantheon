import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { HookHost, find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
import { zh, zhf } from './i18n-setup.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true, useId: 'canvas' }),
);
const viewport = vi.hoisted(() => ({ x: 0, y: 0, zoom: 1 }));
const zoomTo = vi.hoisted(() => vi.fn());
const setViewport = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../apps/web/node_modules/@xyflow/react/dist/esm/index.mjs', async (actual) => ({
  ...(await actual<object>()),
  useReactFlow: () => ({ setViewport, zoomTo }),
  useViewport: () => viewport,
}));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { FlowChart } from '@/screens/board/FlowPanel';
import { flowLayout } from '@/screens/board/flow-layout';
import { FlowGroupControl, MainView } from '@/screens/board/MainView';
import { TaskList } from '@/screens/board/TaskList';

type Task = BoardModel['tasks'][number];
const NOW = Date.UTC(2026, 10, 12, 12);

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id: `lead-1:${id}`,
  owner_session_id: 'lead-1',
  title: `task ${id}`,
  goal: '',
  scope: [],
  lane_id: null,
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
  ...extra,
});

const claim = (model: string | null) => ({ session_id: 's', runtime: 'claude', model });

const board = (tasks: Task[], edges: BoardModel['edges'] = []): BoardModel =>
  ({
    since: NOW - 86_400_000,
    now: NOW,
    lanes: [
      { id: 'api', title: 'API' },
      { id: 'ui', title: 'UI' },
    ],
    tasks,
    edges,
    merges: [],
    leads: [],
  }) as unknown as BoardModel;

const mixed = () =>
  board([
    task('a', {
      lane_id: 'api',
      kind: { domain: 'backend-logic', tier: 't2' },
      state: 'merged',
      status: 'done',
      claim: claim('claude-opus'),
    }),
    task('b', {
      lane_id: 'api',
      kind: { domain: 'frontend-ui', tier: 't1' },
      state: 'running',
      status: 'running',
      planned: { model: 'gpt-5' },
    }),
    task('c', { lane_id: 'ui', state: 'todo' }),
    task('d', {
      lane_id: 'ui',
      kind: { domain: 'backend-logic', tier: 't1' },
      state: 'waiting_approval',
      status: 'waiting',
      claim: claim(null),
      planned: { model: 'gpt-5' },
    }),
  ]);

const hosts: HookHost<any>[] = [];
let stored: Map<string, string>;
beforeEach(() => {
  stored = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  zoomTo.mockReset();
  zoomTo.mockImplementation((zoom: number) => void (viewport.zoom = zoom));
  viewport.zoom = 1;
});
afterEach(() => {
  unmountAll();
  hosts.splice(0).forEach((h) => h.unmount());
  vi.unstubAllGlobals();
});

const labelled = (tree: ReactNode, label: string) =>
  find(tree, (n) => n.props['aria-label'] === label);
const call = (el: ReactElement<any>) => (el.type as (p: unknown) => ReactNode)(el.props);

const main = (projectId = 'canvas-project', model = mixed()) =>
  mount(() =>
    MainView({
      model,
      projectId,
      onSelect() {},
      onOpenSession() {},
    }),
  );

/** The board bar's grouping of the project's chart. */
const grouping = (projectId: string) => mount(() => FlowGroupControl({ projectId })).value;
const groupLabel = zh('board.canvas.group.label');

type ChartProps = Parameters<typeof FlowChart>[0];
/** The canvas under the chart, laid out 1000px wide. */
function canvas(props: Partial<ChartProps> = {}) {
  const all: ChartProps = { model: mixed(), selected: null, onSelect() {}, ...props };
  const Canvas = named(FlowChart(all), 'FlowCanvas').type as (p: ChartProps) => ReactNode;
  const h = new HookHost(
    () => Canvas(all),
    (tree) =>
      (find(tree, (n) => String(n.props.className ?? '').startsWith('bd-fc')).props.ref.current ??=
        { clientWidth: 1000 }),
  );
  hosts.push(h);
  h.render();
  return h;
}

describe('board now view canvas', () => {
  it('draws only the flow chart, with no view switch', () => {
    const tree = main().value;
    expect(() => labelled(tree, '视图')).toThrow();
    expect(() => labelled(tree, '按形状自动')).toThrow();
    for (const name of ['PhaseList', 'MetroLine', 'AgentLanes'])
      expect(() => named(tree, name)).toThrow();
    expect(named(tree, 'FlowChart').props.model.tasks).toHaveLength(4);
    expect(() => labelled(tree, groupLabel)).toThrow();
    const groups = labelled(grouping('canvas-project'), groupLabel);
    expect(nodes(groups.props.children).map((n) => text(n))).toEqual(
      ['lane', 'kind', 'state', 'model'].map((key) => zh(`board.canvas.group.${key}`)),
    );
    expect(groups.props.value).toBe('lane');
  });

  it('remembers the grouping picked on each project', () => {
    labelled(grouping('alpha'), groupLabel).props.onValueChange('model');
    expect(JSON.parse(stored.get('pantheon.board-group.v1')!)).toEqual({ alpha: 'model' });
    expect(labelled(grouping('alpha'), groupLabel).props.value).toBe('model');
    expect(named(main('alpha').value, 'FlowChart').props.group).toBe('model');
    expect(labelled(grouping('beta'), groupLabel).props.value).toBe('lane');
    labelled(grouping('beta'), groupLabel).props.onValueChange('kind');
    expect(JSON.parse(stored.get('pantheon.board-group.v1')!)).toEqual({
      alpha: 'model',
      beta: 'kind',
    });

    stored.set('pantheon.board-group.v1', JSON.stringify({ gamma: 'state' }));
    expect(labelled(grouping('gamma'), groupLabel).props.value).toBe('state');
  });

  it('draws the canvas without a panel header', () => {
    const tree = canvas().value;
    expect(nodes(tree).some((n) => n.type === 'h2')).toBe(false);
    expect(nodes(tree).some((n) => n.props.className === 'bd-ph')).toBe(false);
  });
});

describe('board canvas long lists', () => {
  const todo = (n: number) =>
    Array.from({ length: n }, (_, i) => task(`row-${i}`, { state: 'todo' }));
  const toggles = (tree: ReactNode) =>
    nodes(tree).filter((n) => n.type === 'button' && n.props.className === 'bd-lnk bf-more');

  it.each([
    {
      list: 'task list group',
      limit: 8,
      draw: (n: number) =>
        mount(() =>
          TaskList({ model: { tasks: todo(n), needs: [], now: NOW }, onOpenTask() {}, bar: null }),
        ),
      rows: (tree: ReactNode) =>
        nodes(tree).filter((n) => n.props.role === 'row' && n.props['aria-label']).length,
    },
  ])(
    'shows the first $limit rows of a $list and a switch to all of them',
    ({ limit, draw, rows }) => {
      const h = draw(limit + 1);
      const [more] = toggles(h.value);
      expect(rows(h.value)).toBe(limit);
      expect(text(more)).toBe(zhf('board.rows.all', { count: limit + 1 }));
      expect(more!.props['aria-expanded']).toBe(false);
      more!.props.onClick();
      const open = h.render();
      const [less] = toggles(open);
      expect(rows(open)).toBe(limit + 1);
      expect(less!.props['aria-expanded']).toBe(true);
      expect(text(less)).toBe(zh('board.rows.less'));
      const fits = draw(limit).value;
      expect(rows(fits)).toBe(limit);
      expect(toggles(fits)).toEqual([]);
    },
  );
});

describe('board canvas bands', () => {
  const bands = (group: Parameters<typeof flowLayout>[2]) =>
    flowLayout(mixed(), 1200, group).lanes.map((l) => [
      l.id,
      l.title,
      l.tasks.map((id) => id.slice('lead-1:'.length)).sort(),
    ]);

  it.each([
    [
      'bands the tasks by work line',
      'lane',
      [
        ['api', 'API', ['a', 'b']],
        ['ui', 'UI', ['c', 'd']],
      ],
    ],
    [
      'bands the tasks by type in the order of the task types, untyped ones last',
      'kind',
      [
        ['frontend-ui', zh('data.workflowPolicy.domain.frontendUi'), ['b']],
        ['backend-logic', zh('data.workflowPolicy.domain.backendLogic'), ['a', 'd']],
        [null, '', ['c']],
      ],
    ],
    [
      'bands the tasks by state in the order of the states',
      'state',
      [
        ['todo', zh('board.task.state.todo'), ['c']],
        ['running', zh('board.task.state.running'), ['b']],
        ['waiting_approval', zh('board.task.state.waitingApproval'), ['d']],
        ['merged', zh('board.task.state.merged'), ['a']],
      ],
    ],
    [
      'bands the tasks by the claimed model, else the planned one, else as undecided',
      'model',
      [
        ['claude-opus', 'claude-opus', ['a']],
        ['gpt-5', 'gpt-5', ['b', 'd']],
        [null, zh('board.canvas.band.undecided'), ['c']],
      ],
    ],
  ] as const)('%s', (_name, group, expected) => {
    expect(bands(group)).toEqual(expected);
  });

  it('draws a dependency between two bands of the picked grouping as crossing them', () => {
    const edges: BoardModel['edges'] = [{ from: 'lead-1:a', to: 'lead-1:b', state: 'met' }];
    const model = { ...mixed(), edges };
    const crossing = (group: ChartProps['group']) => {
      const flow = find(canvas({ model, group }).value, (n) => 'nodeTypes' in n.props);
      return flow.props.edges[0].className.split(' ').includes('cross');
    };
    expect(crossing('lane')).toBe(false);
    expect(crossing('state')).toBe(true);
  });

  it('sums each band up in a segment bar that names every count above zero', () => {
    const model = board([
      task('m1', { lane_id: 'api', state: 'merged', status: 'done' }),
      task('m2', { lane_id: 'api', state: 'merged', status: 'done' }),
      task('r', { lane_id: 'api', state: 'running', status: 'running' }),
      task('w', { lane_id: 'api', state: 'waiting_approval', status: 'waiting' }),
      task('t', { lane_id: 'api', state: 'todo' }),
      task('f', { lane_id: 'ui', state: 'failed', status: 'failed' }),
      // Acceptance is the user's move; an idle session row has not started.
      task('a', { lane_id: 'ui', state: 'awaiting_acceptance', status: 'running' }),
      task('i', { lane_id: 'ui', status: 'idle' }),
    ]);
    const lanes = call(named(canvas({ model }).value, 'Lanes'));
    const bars = nodes(lanes).filter((n) => n.props.role === 'img');
    expect(bars.map((n) => n.props['aria-label'])).toEqual([
      '已合并 2 / 5，运行 1，等你 1，未开始 1',
      '已合并 0 / 3，等你 1，卡住 1，未开始 1',
    ]);
    expect(
      nodes(lanes)
        .filter((n) => n.props.className === 'bd-lane-n')
        .map((n) => text(n)),
    ).toEqual(['2 / 5', '0 / 3']);
  });

  it('shows the whole lane name on hover', () => {
    const lanes = call(named(canvas({ model: mixed() }).value, 'Lanes'));
    const names = nodes(lanes).filter(
      (n) => n.props.children === 'API' || n.props.children === 'UI',
    );
    expect(names.map((n) => n.props.title)).toEqual(['API', 'UI']);
  });

  it("names a lane after its title and the lead's reason for running it in parallel", () => {
    const model = mixed();
    model.lanes[0]!.fanout_reason = 'Endpoints share no files';
    const lanes = call(named(canvas({ model }).value, 'Lanes'));
    const boxes = nodes(lanes).filter((n) => n.key === 'api' || n.key === 'ui');
    expect(boxes.map((n) => [n.props.role, n.props['aria-label']])).toEqual([
      ['group', 'API, Endpoints share no files'],
      [undefined, undefined],
    ]);
    expect(nodes(lanes).some((n) => n.props.text === 'Endpoints share no files')).toBe(true);
  });

  type Lane = BoardModel['lanes'][number];
  const deep = (lane: Partial<Lane>) => {
    const model = board([
      task('a', { lane_id: 'lead-1:api' }),
      task('b', { lane_id: 'lead-1:ui' }),
    ]);
    model.lanes = [
      { id: 'lead-1:api', title: 'API', ...lane },
      { id: 'lead-1:ui', title: 'UI' },
    ];
    return model;
  };
  const sessions = [{ id: 'lead-1', project_id: 'canvas-project' }] as never[];
  const depthOf = (lane: string) => zhf('board.canvas.lane.depth.label', { lane });
  const headed = (lane: Partial<Lane>, run = vi.fn(async () => null as string | null)) =>
    call(named(canvas({ model: deep(lane), tell: { sessions, run } }).value, 'Lanes'));
  const laneText = (tree: ReactNode, id: string) => text(nodes(tree).find((n) => n.key === id));

  it("marks the lane's depth in a three-way choice named after the lane, none while it has none", () => {
    const lanes = headed({ depth: 'plan_first', depth_by: 'lead' });
    const choice = labelled(lanes, depthOf('API'));
    expect(choice.props.value).toBe('plan_first');
    expect(nodes(choice.props.children).map((n) => [n.props.value, text(n)])).toEqual([
      ['just_do', zh('board.canvas.lane.depth.justDo')],
      ['plan_first', zh('board.canvas.lane.depth.planFirst')],
      ['spec_first', zh('board.canvas.lane.depth.specFirst')],
    ]);
    expect(labelled(lanes, depthOf('UI')).props.value).toBeNull();
  });

  it('sets the depth the user picks on the lead of the lane', async () => {
    const run = vi.fn(async () => null as string | null);
    labelled(
      headed({ depth: 'just_do', depth_by: 'lead' }, run),
      depthOf('API'),
    ).props.onValueChange('spec_first');
    await Promise.resolve();
    expect(run).toHaveBeenCalledWith(
      'board.lane.depth.set',
      {
        project_id: 'canvas-project',
        lead_session_id: 'lead-1',
        lane_id: 'api',
        depth: 'spec_first',
      },
      null,
    );
  });

  it.each<[string, NonNullable<Lane['depth_by']>, () => string, () => string | null]>([
    [
      'the lead',
      'lead',
      () => zh('board.canvas.lane.by.lead'),
      () => 'One change the gates can check',
    ],
    ['you', 'user', () => zh('board.canvas.lane.by.user'), () => null],
    [
      'Pantheon',
      'pantheon',
      () => zh('board.canvas.lane.by.pantheon'),
      () => zh('board.canvas.lane.reason.pantheon'),
    ],
  ])(
    'says %s chose the depth, with the reason only the lead gives or Pantheon holds',
    (_who, by, name, why) => {
      const shown = laneText(
        headed({
          depth: 'plan_first',
          depth_by: by,
          depth_reason: 'One change the gates can check',
        }),
        'lead-1:api',
      );
      expect(shown).toContain(name());
      const reason = why();
      if (reason) expect(shown).toContain(reason);
      if (by !== 'lead') expect(shown).not.toContain('One change the gates can check');
    },
  );

  it("shows whether the lane's plan waits for the user's approval or was approved", () => {
    const waiting = laneText(
      headed({ depth: 'plan_first', depth_by: 'pantheon', stop: { state: 'waiting', at: NOW } }),
      'lead-1:api',
    );
    expect(waiting).toContain(zh('board.canvas.lane.stop.waiting'));
    const approved = laneText(
      headed({ depth: 'plan_first', depth_by: 'user', stop: { state: 'approved', at: NOW } }),
      'lead-1:api',
    );
    expect(approved).toContain(zh('board.canvas.lane.stop.approved'));
    expect(approved).not.toContain(zh('board.canvas.lane.stop.waiting'));
    const none = laneText(headed({ depth: 'just_do', depth_by: 'lead' }), 'lead-1:api');
    expect(none).not.toContain(zh('board.canvas.lane.stop.approved'));
    expect(none).not.toContain(zh('board.canvas.lane.stop.waiting'));
  });

  it('gives a discarded row its own segment, so the bar holds every task the total counts', () => {
    const model = board([
      task('m', { lane_id: 'api', state: 'merged', status: 'done' }),
      task('x', { lane_id: 'api', status: 'discarded' }),
    ]);
    const lanes = call(named(canvas({ model }).value, 'Lanes'));
    const bar = nodes(lanes).find((n) => n.props.role === 'img')!;
    expect(bar.props['aria-label']).toBe('已合并 1 / 2，已丢弃 1');
    expect(
      nodes(bar)
        .filter((n) => n.type === 'i')
        .map((n) => [n.props['data-count'], n.props.style.flexGrow]),
    ).toEqual([
      ['merged', 1],
      ['discarded', 1],
    ]);
  });
});

describe('board canvas zoom', () => {
  const zoomText = (key: string) => zh(`board.canvas.zoom.${key}`);
  const controls = () => labelled(canvas().value, zoomText('label'));

  it('floats zoom out, the zoom level, zoom in and fit over the canvas', () => {
    const group = controls();
    const zoom = call(named(group, 'ZoomControls'));
    expect(labelled(zoom, zoomText('out')).type).toBe('button');
    expect(text(labelled(zoom, zoomText('level')))).toBe('100%');
    expect(labelled(zoom, zoomText('in')).type).toBe('button');
  });

  it('fits the chart to the view from a text button', () => {
    const fit = find(
      controls(),
      (n) => n.type === 'button' && text(n) === zh('board.plan.flow.fit'),
    );
    expect(fit.props.className).toBe('btn ghost sm');
    setViewport.mockClear();
    fit.props.onClick();
    expect(setViewport).toHaveBeenCalledTimes(1);
  });

  it('zooms in by ten percent up to 150%, where zoom in turns off', () => {
    const el = named(controls(), 'ZoomControls');
    labelled(call(el), zoomText('in')).props.onClick();
    expect(zoomTo).toHaveBeenLastCalledWith(1.1);
    expect(text(labelled(call(el), zoomText('level')))).toBe('110%');
    viewport.zoom = 1.4;
    labelled(call(el), zoomText('in')).props.onClick();
    expect(text(labelled(call(el), zoomText('level')))).toBe('150%');
    expect(labelled(call(el), zoomText('in')).props.disabled).toBe(true);
    expect(labelled(call(el), zoomText('out')).props.disabled).toBe(false);
  });
});

describe('board canvas layout styles', () => {
  const sheet = (name: string) =>
    readFileSync(new URL(`../../apps/web/src/screens/board/${name}.css`, import.meta.url), 'utf8');
  const css = sheet('flow');
  const board = sheet('board');

  it('docks a 400px drawer as the page column beside the one with the canvas', () => {
    expect(board).toMatch(
      /\.bd-split\[data-drawer\] \{[^}]*grid-template-columns: minmax\(0, 1fr\) 400px;/,
    );
    expect(board).toMatch(/\.bd-split > \.bd-drw \{[^}]*max-width: 100%;/);
    expect(css).not.toContain('@container bd-main');
  });

  it('opens a drawer placed outside the board split over the page instead of in the panel flow', () => {
    expect(css).toMatch(
      /:not\(\.bd-split\) > \.bd-drw \{[^}]*position: fixed;[^}]*top: [^}]*right: 0;[^}]*bottom: 0;/,
    );
  });

  it('lays the lane names over the chart layer, which would otherwise take their hover', () => {
    const rule = (selector: string) =>
      new RegExp(`\\n${selector.replace(/\./g, '\\.')} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';
    const layer = (body: string) => Number(/z-index: (\d+);/.exec(body)?.[1] ?? 0);
    // React Flow also gives its wrapper z-index 0 inline.
    expect(layer(rule('.bd-lanes'))).toBeGreaterThan(
      Math.max(0, layer(rule('.bd-fc .react-flow'))),
    );
    // Only the names take the pointer; pan, zoom and node clicks pass through the rest.
    expect(rule('.bd-lanes')).toContain('pointer-events: none');
    expect(rule('.bd-lane-t')).toContain('pointer-events: auto');
  });

  it('keeps the board body from containing the drawer of a canvas panel, so it lies over the page', () => {
    const body = /\n\.bd-body \{([^}]*)\}/.exec(board)![1]!;
    expect(body).not.toMatch(/container|contain:|transform|filter/);
  });

  it('stacks the chart, the replay bar and the task focus in that order, the chart keeping its height', () => {
    const row = (part: string) =>
      Number(
        new RegExp(`\\.bd-main > [^{]*\\.${part}\\b[^{]*\\{[^}]*grid-row: (\\d+);`).exec(css)?.[1],
      );
    expect(['bd-fc', 'es-in', 'bd-rp', 'bd-focus'].map(row)).toEqual([1, 1, 2, 3]);
    expect(/\.bd-cv > \.bd-main \{[^}]*grid-template-rows: ([^;]+);/.exec(css)![1]).toMatch(
      /^minmax\([1-9]\d*px, 1fr\) auto auto$/,
    );
  });

  it('paints a running segment of a card progress bar in the running colour', () => {
    expect(css).toMatch(/\.bd-pbar \.b-running \{\s*background: var\(--run\);/);
  });

  it('fills the rest of the now view with a dotted canvas', () => {
    // It grows into the rest and, past its content, lets the view scroll instead of shrinking.
    expect(css).toMatch(/\.bd-main \{[^}]*flex: 1 0 auto;/);
    expect(css).toMatch(/\.bd-main > \.bd-fc \{[^}]*radial-gradient\(var\(--[\w-]+\)/);
  });
});
