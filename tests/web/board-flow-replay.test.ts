import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { HookHost, find, named, nodes, text } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('../../apps/web/node_modules/@xyflow/react/dist/esm/index.mjs', async (actual) => ({
  ...(await actual<object>()),
  useReactFlow: () => ({ setViewport: async () => true }),
}));
import { flowReplay, momentAt, statusesAt } from '@/screens/board/flow-replay';
import { FlowChart } from '@/screens/board/FlowPanel';
import { stackMerged } from '@/screens/board/MergedStack';
import { MainView } from '@/screens/board/MainView';

type Task = BoardModel['tasks'][number];
type Segment = Task['segments'][number];
const MIN = 60_000;
const T0 = new Date(2026, 10, 13, 9, 0).getTime();
const at = (minutes: number) => T0 + minutes * MIN;

const segment = (
  id: string,
  status: Segment['status'],
  start: number,
  end: number | null,
): Segment => ({
  id,
  session_id: id,
  title: id,
  runtime: 'claude',
  model: null,
  status,
  started_at: start,
  ended_at: end,
  tokens: 0,
});

const task = (id: string, status: Task['status'], segments: Segment[] = []): Task => ({
  id,
  owner_session_id: 'lead',
  title: `task ${id}`,
  goal: '',
  scope: [],
  lane_id: null,
  milestone_id: null,
  order: 0,
  status,
  blockers: [],
  segments,
  additions: null,
  deletions: null,
  checks: 'none',
  started_at: null,
  ended_at: null,
  last_progress_at: null,
  blocked_since: null,
  turn_running: false,
});

// build failed once and passed on its retry; ship runs and waits for an approval; docs never started.
const build = task('build', 'done', [
  segment('build-1', 'failed', at(0), at(10)),
  segment('build-2', 'done', at(20), at(40)),
]);
const ship: Task = {
  ...task('ship', 'waiting', [segment('ship-1', 'running', at(50), null)]),
  state: 'waiting_approval',
  turn_running: true,
  activity: {
    phase: 'waiting_approval',
    since: at(60),
    waiting: { kind: 'approval', summary: 'pnpm publish', approval_id: 'a1', since: at(60) },
    health: 'fresh',
    attempt: 1,
  },
};
const docs = task('docs', 'todo');
const tasks = [build, ship, docs];
const NOW = at(99);
const model = (list: Task[] = tasks) =>
  ({
    since: 0,
    now: NOW,
    lanes: [],
    merges: [],
    tasks: list,
    edges: [{ from: 'build', to: 'ship', state: 'met' }],
  }) as unknown as BoardModel;

/** The tasks as the lead's plan holds them, the way the main view keeps them. */
const planned = (list: Task[]) => list.map((t) => ({ ...t, id: `lead:${t.id}` }));

const names = (tree: ReactNode) =>
  nodes(tree)
    .filter((n) => typeof n.type === 'function')
    .map((n) => (n.type as { name: string }).name);

const hosts: HookHost<any>[] = [];
afterEach(() => {
  hosts.splice(0).forEach((h) => h.unmount());
  vi.unstubAllGlobals();
});
const mount = <T>(body: () => T, commit?: (value: T) => void) => {
  const h = new HookHost(body, commit);
  hosts.push(h);
  h.render();
  return h;
};

describe('the flow replay of the attempts', () => {
  it('runs from the first attempt to now, with a point per task done, attempt failed and wait begun', () => {
    const replay = flowReplay(tasks, NOW)!;
    expect([replay.from, replay.to]).toEqual([at(0), NOW]);
    expect(replay.marks).toEqual([
      { at: at(10), state: 'failed' },
      { at: at(40), state: 'done' },
      { at: at(60), state: 'waiting' },
    ]);
    expect(replay.changes).toEqual([at(0), at(10), at(20), at(40), at(50), at(60)]);
  });

  it('gives each task its status before, during, between and after its attempts', () => {
    const shown = (minutes: number) => Object.fromEntries(statusesAt(tasks, at(minutes)));
    expect(shown(-5)).toEqual({ build: 'todo', ship: 'todo', docs: 'todo' });
    expect(shown(5)).toEqual({ build: 'running', ship: 'todo', docs: 'todo' });
    expect(shown(15).build).toBe('failed');
    expect(shown(30).build).toBe('running');
    expect(shown(45)).toEqual({ build: 'done', ship: 'todo', docs: 'todo' });
    expect(shown(55).ship).toBe('running');
    expect(shown(70).ship).toBe('waiting');
  });

  it('holds the statuses from one change to the next', () => {
    const replay = flowReplay(tasks, NOW)!;
    expect(momentAt(replay, at(-1))).toBe(Number.NEGATIVE_INFINITY);
    expect(momentAt(replay, at(30))).toBe(at(20));
    // A playhead a hair before a change, as the axis gives it back, is on the change.
    expect(momentAt(replay, at(40) - 0.0001)).toBe(at(40));
  });

  it('has nothing to replay before any attempt started', () => {
    expect(flowReplay([docs, task('later', 'todo')], NOW)).toBeNull();
  });

  it('runs an open session that is no longer running only up to its last progress, then shows its status', () => {
    const open = (id: string, status: Segment['status']): Task => ({
      ...task(id, status, [segment(`${id}-1`, status, at(0), null)]),
      last_progress_at: at(30),
    });
    const list = [open('review', 'ready'), open('rest', 'idle'), open('broke', 'failed')];
    const shown = (minutes: number) => Object.fromEntries(statusesAt(list, at(minutes)));
    expect(shown(10)).toEqual({ review: 'running', rest: 'running', broke: 'running' });
    expect(shown(40)).toEqual({ review: 'ready', rest: 'idle', broke: 'failed' });
    const replay = flowReplay(list, NOW)!;
    expect(replay.changes).toEqual([at(0), at(30)]);
    expect(replay.marks).toEqual([{ at: at(30), state: 'failed' }]);
  });

  it('keeps a parallel task running between the end of one part and the start of the next', () => {
    const split: Task = {
      ...task('split', 'done', [
        segment('split-a', 'done', at(0), at(10)),
        segment('split-b', 'done', at(20), at(30)),
      ]),
      parallel: [
        { title: 'part a', session_id: 'split-a', status: 'done' },
        { title: 'part b', session_id: 'split-b', status: 'done' },
      ],
    };
    const shown = (minutes: number) => statusesAt([split], at(minutes)).get('split');
    expect([shown(5), shown(15), shown(25), shown(35)]).toEqual([
      'running',
      'running',
      'running',
      'done',
    ]);
  });

  it('cuts the idle stretch between the last attempt and now from the track', () => {
    const DAY = 24 * 60 * MIN;
    const list = [task('old', 'done', [segment('old-1', 'done', at(0), at(1))])];
    const replay = flowReplay(list, at(0) + 7 * DAY)!;
    expect(replay.axis.position(at(1))).toBeGreaterThan(0.9);
  });
});

describe('the main view under replay', () => {
  const props = (m: BoardModel) => ({
    model: m,
    selected: null,
    onSelect() {},
    onOpenSession() {},
  });

  it('leaves the replay bar out while no attempt started', () => {
    const h = mount(() => MainView(props(model(planned([docs])))));
    expect(nodes(h.value).some((n) => (n.type as { name?: string }).name === 'FlowReplayer')).toBe(
      false,
    );
    expect(named(h.value, 'FlowChart').props.states).toBeUndefined();
  });

  it('draws the chart at the moment the bar hands up, and live again on null', () => {
    const h = mount(() => MainView(props(model(planned(tasks)))));
    const bar = named(h.value, 'FlowReplayer');
    expect(named(h.value, 'FlowChart').props.states).toBeUndefined();
    bar.props.onMoment(at(20));
    h.render();
    expect(Object.fromEntries(named(h.value, 'FlowChart').props.states)).toEqual({
      'lead:build': 'running',
      'lead:ship': 'todo',
      'lead:docs': 'todo',
    });
    named(h.value, 'FlowReplayer').props.onMoment(null);
    h.render();
    expect(named(h.value, 'FlowChart').props.states).toBeUndefined();
  });

  it('leaves the focus out while a task drawer is open', () => {
    const h = mount(() => MainView({ ...props(model(planned(tasks))), selected: 'lead:build' }));
    expect(names(h.value)).not.toContain('TaskFocus');
  });

  it('leaves the focus out at a past moment', () => {
    const h = mount(() => MainView(props(model(planned(tasks)))));
    expect(names(h.value)).toContain('TaskFocus');
    named(h.value, 'FlowReplayer').props.onMoment(at(20));
    h.render();
    expect(names(h.value)).not.toContain('TaskFocus');
    named(h.value, 'FlowReplayer').props.onMoment(null);
    h.render();
    expect(names(h.value)).toContain('TaskFocus');
  });

  it('stacks the tasks merged now only at now, not at a moment before they started', () => {
    const merged = (id: string, start: number) => ({
      ...task(id, 'done', [segment(`${id}-1`, 'done', at(start), at(start + 10))]),
      state: 'merged' as const,
    });
    const h = mount(() =>
      MainView(props({ ...model(planned([merged('pay', 0), merged('refund', 20)])), edges: [] })),
    );
    const stacks = () => [
      ...stackMerged(named(h.value, 'FlowChart').props.model, 'lane').overlays.values(),
    ];
    expect(stacks()).toHaveLength(1);
    named(h.value, 'FlowReplayer').props.onMoment(at(-5));
    h.render();
    expect(stacks()).toEqual([]);
  });
});

describe('the replay bar under the chart', () => {
  type Listener = (e: Record<string, unknown>) => void;
  let keys: Listener[] = [];
  let frames: ((t: number) => void)[] = [];
  beforeEach(() => {
    keys = [];
    frames = [];
    vi.stubGlobal('window', {
      addEventListener: (type: string, fn: Listener) => type === 'keydown' && keys.push(fn),
      removeEventListener: (_type: string, fn: Listener) => {
        keys = keys.filter((l) => l !== fn);
      },
      matchMedia: () => ({ matches: false }),
    });
    vi.stubGlobal('requestAnimationFrame', (fn: (t: number) => void) => frames.push(fn));
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  /** The bar of the main view, its host keeping the custom properties the replay writes. */
  const replayer = () => {
    const onMoment = vi.fn();
    const main = mount(() => MainView(props()));
    const el = named(main.value, 'FlowReplayer');
    const style = new Map<string, string>();
    const element = {
      style: {
        setProperty: (name: string, value: string) => style.set(name, value),
        removeProperty: (name: string) => style.delete(name),
        getPropertyValue: (name: string) => style.get(name) ?? '',
      },
      setAttribute() {},
      removeAttribute() {},
    };
    let flow = el.props.flow;
    const h = mount(
      () => (el.type as (p: unknown) => ReactElement<any>)({ ...el.props, flow, onMoment }),
      (tree) => (tree.props.ref.current ??= element),
    );
    const bar = () => named(h.value, 'ReplayBar');
    const setFlow = (next: typeof flow) => (flow = next);
    return { h, bar, onMoment, setFlow };
  };
  const props = () => ({
    model: model(planned(tasks)),
    selected: null,
    onSelect() {},
    onOpenSession() {},
  });
  const tick = (h: HookHost<any>, t: number) => {
    for (const frame of frames.splice(0)) frame(t);
    h.render();
  };

  it('shows the replay range at now, the speeds and no way back to now but Esc', () => {
    const { bar } = replayer();
    expect(bar().props.live).toBe('09:00 – 10:39');
    expect(bar().props.marks.map((m: { state: string }) => m.state)).toEqual([
      'failed',
      'done',
      'waiting',
    ]);
    expect(named(bar().props.end, 'ReplaySpeedControl').props.speed).toBe(1);
  });

  it('hands up a moment only as the playhead passes a change, and now at the end', () => {
    const { h, bar, onMoment } = replayer();
    bar().props.replay.toggle();
    h.render();
    expect(onMoment).toHaveBeenLastCalledWith(at(0));
    tick(h, 0);
    tick(h, 1000);
    const moments = new Set(onMoment.mock.calls.map(([m]) => m));
    expect([...moments]).toEqual([null, at(0)]);
    for (let t = 2000; frames.length > 0 && t < 120_000; t += 100) tick(h, t);
    expect(bar().props.replay.time).toBeNull();
    expect(onMoment).toHaveBeenLastCalledWith(null);
    expect(new Set(onMoment.mock.calls.map(([m]) => m))).toEqual(
      new Set([null, at(0), at(10), at(20), at(40), at(50), at(60)]),
    );
  });

  it('keeps the moment the playing playhead reached when a board read brings a new replay', () => {
    const { h, bar, onMoment, setFlow } = replayer();
    bar().props.replay.toggle();
    h.render();
    for (let t = 0; onMoment.mock.lastCall?.[0] === at(0) && t < 120_000; t += 100) tick(h, t);
    const reached = onMoment.mock.lastCall?.[0];
    expect(reached).toBeGreaterThan(at(0));
    expect(bar().props.replay.playing).toBe(true);
    setFlow(flowReplay(planned(tasks), NOW)!);
    h.render();
    expect(onMoment).toHaveBeenLastCalledWith(reached);
  });

  it('lands on a mark pressed on the track and goes back to now on Esc', () => {
    const { h, bar, onMoment } = replayer();
    const replay = bar().props.replay;
    replay.scrub.current = { clientWidth: 500 };
    const done = flowReplay(tasks, NOW)!.axis.position(at(40)) * 1000;
    replay.seek(Math.round(done) - 2);
    h.render();
    expect(onMoment).toHaveBeenLastCalledWith(at(40));
    const e = { key: 'Escape', defaultPrevented: false, preventDefault: vi.fn() };
    for (const listener of [...keys]) listener(e);
    h.render();
    expect(e.preventDefault).toHaveBeenCalled();
    expect(bar().props.replay.time).toBeNull();
    expect(onMoment).toHaveBeenLastCalledWith(null);
  });
});

describe('the flow chart at a past moment', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  const canvas = (states?: ReadonlyMap<string, Task['status']>, m = model()) => {
    const chart = FlowChart({ model: m, selected: null, onSelect() {}, states });
    const Canvas = find(chart, (n) => typeof n.type === 'function' && n.type.name === 'FlowCanvas')
      .type as (props: Parameters<typeof FlowChart>[0]) => ReactElement<any>;
    const h = mount(
      () => Canvas({ model: m, selected: null, onSelect() {}, states }),
      (tree) =>
        (find(tree, (n) =>
          String(n.props.className ?? '').startsWith('bd-fc'),
        ).props.ref.current ??= { clientWidth: 1000 }),
    );
    return find(h.value, (n) => 'nodeTypes' in n.props).props;
  };
  const card = (flow: { nodes: { id: string; data: any }[] }, id: string) =>
    flow.nodes.find((n) => n.id === id)!.data;

  it('draws each card with the status it had and without what holds only now', () => {
    const flow = canvas(statusesAt(tasks, at(55)));
    const shipCard = card(flow, 'ship');
    expect([card(flow, 'build').task.status, shipCard.task.status]).toEqual(['done', 'running']);
    expect(shipCard.task.activity).toBeUndefined();
    expect(shipCard.task.state).toBeUndefined();
    expect(shipCard.line).toBeNull();
    expect(shipCard.actions).toBeUndefined();
    expect(flow.edges.map((e: { data: { state: string } }) => e.data.state)).toEqual(['met']);
  });

  it('colours an edge only once its upstream is done at that moment', () => {
    const flow = canvas(statusesAt(tasks, at(30)));
    expect(card(flow, 'build').task.status).toBe('running');
    expect(flow.edges.map((e: { data: { state: string } }) => e.data.state)).toEqual(['pending']);
  });

  it('draws the current milestone at now only', () => {
    const m = {
      ...model(tasks.map((t) => ({ ...t, milestone_id: 'ms' }))),
      milestones: [
        {
          id: 'ms',
          title: 'ship it',
          session_ids: [],
          merged: 0,
          status: 'active',
          criteria: [],
          owner_session_id: 'lead',
          tasks: { done: 1, total: 3 },
        },
      ],
    } as BoardModel;
    const kinds = (states?: ReadonlyMap<string, Task['status']>) =>
      canvas(states, m).nodes.map((n: { type: string }) => n.type);
    expect(kinds()).toContain('milestone');
    expect(kinds(statusesAt(tasks, at(55)))).not.toContain('milestone');
  });

  it('keeps the live cards without a moment', () => {
    const flow = canvas();
    expect(card(flow, 'ship').task.activity?.phase).toBe('waiting_approval');
    expect(text(card(flow, 'ship').line ?? '')).not.toBe('');
  });
});
