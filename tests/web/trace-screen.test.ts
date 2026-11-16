import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { ProjectHeatmap, ProjectTrace, SessionTrace, TraceStats } from '@pantheon/protocol';
import { HookHost, find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  trace: null as unknown,
  heat: null as unknown,
  heatDays: [] as string[],
  spans: [] as unknown[],
  windows: [] as { from: number; to: number | null; bucketMs: number }[],
  loadingFrom: null as number | null,
  traceRead: {} as { stale?: boolean; refreshing?: boolean },
  heatRead: {} as { stale?: boolean; refreshing?: boolean },
  reloadTrace: null as unknown as () => void,
  reloadHeat: null as unknown as () => void,
  heatError: null as string | null,
  stepsError: null as string | null,
  reloadSteps: null as unknown as () => void,
  command: vi.fn(),
  events: null as unknown[] | null,
  sessions: null as unknown[] | null,
}));
vi.mock('@/data/commands', () => ({ runCommand: mock.command }));
vi.mock('@/data/logs', async (actual) => ({
  ...(await actual<object>()),
  useEventHistory: () => ({ events: mock.events, error: null, reload() {} }),
}));
vi.mock('@/data/workbench-sessions', async (actual) => ({
  ...(await actual<object>()),
  useSessionList: () => ({ data: mock.sessions, loading: false, error: null, reload() {} }),
}));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/trace', async (actual) => ({
  ...(await actual<object>()),
  useProjectTimeline: (() => {
    const read = {
      data: { from: '', to: '', sessions: [] },
      loading: false,
      error: null,
      reload() {},
    };
    return () => read;
  })(),
  useProjectTrace: (projectId: string | null, window: (typeof mock.windows)[number]) => {
    mock.windows.push(window);
    const loading = window.from === mock.loadingFrom;
    return {
      data: projectId && !loading ? mock.trace : null,
      loading,
      error: null,
      reload: mock.reloadTrace,
      ...mock.traceRead,
    };
  },
  useProjectHeatmap: (projectId: string | null, days: string) => {
    mock.heatDays.push(days);
    return {
      data: projectId ? mock.heat : null,
      loading: false,
      error: mock.heatError,
      reload: mock.reloadHeat,
      ...mock.heatRead,
    };
  },
  useSessionTrace: (projectId: string | null, laneKey: string | null) => ({
    data: projectId && laneKey ? { lane: { title: 'codex session' }, spans: mock.spans } : null,
    loading: false,
    error: null,
    reload() {},
  }),
  useTraceTime: () => ({ data: null, loading: true, error: null, reload() {} }),
  useTurnSteps: (_projectId: string | null, laneKey: string | null) => ({
    data: null,
    loading: false,
    error: laneKey ? mock.stepsError : null,
    reload: mock.reloadSteps,
  }),
}));
import { TraceScreen } from '@/screens/trace/TraceScreen';
import { listText } from '@/lib/list-text';
import { dayText } from '@/lib/time-text';
import { durationText } from '@/screens/board/panels-model';
import { eventClock } from '@/screens/trace/LaneOverlay';
import { presetWindow } from '@/screens/trace/model';
import { useShell } from '@/store';
import { zh, zhf } from './i18n-setup.js';

const MIN = 60_000;
const NOW = new Date(2026, 2, 8, 14, 20).getTime();
const LANE = 'native:codex:abc';
const lane = { key: LANE, title: 'codex session' };

const zero: TraceStats = {
  sessions: 1,
  turns: 1,
  llm: 0,
  tool: 0,
  error: 0,
  tokens: { input: 0, output: 0 },
  active_ms: 0,
  commits: 0,
};

const projectTrace = (): ProjectTrace => ({
  epoch: null,
  from: new Date(2026, 2, 2).toISOString(),
  to: new Date(NOW).toISOString(),
  indexing: null,
  stats: zero,
  lanes: [
    {
      lane: {
        key: LANE,
        source: 'external',
        runtime: 'codex',
        native_id: 'abc',
        title: 'codex session',
        cwd: '/repo',
      },
      stats: zero,
      turns: [{ id: 'turn-a', start: NOW - 5 * MIN, end: null, status: 'running', segments: [] }],
    },
  ],
  buckets: [],
});

const commit = (sha: string, at: number, laneKey: string | null) => ({
  sha,
  at,
  day: '2026-03-08',
  lane_key: laneKey,
  via: null,
  added: 1,
  removed: 0,
  subject: `subject of ${sha}`,
});

const heatmap = (): ProjectHeatmap => ({
  days: ['2026-03-08'],
  lanes: [
    {
      key: LANE,
      title: 'codex session',
      cells: [{ day: '2026-03-08', llm: 1, tool: 0, error: 0, tokens: 0, commits: 1 }],
    },
  ],
  hours: [{ day: '2026-03-08', calls: Array(24).fill(0), errors: Array(24).fill(0) }],
  commits: [
    commit('a1b2c3d', NOW - 10 * MIN, LANE),
    commit('e4f5a6b', NOW - 30 * MIN, null),
    commit('c7d8e9f', new Date(2026, 1, 1).getTime(), LANE),
  ],
  merges: [],
});

/** An element focus can move to. */
class FakeElement {
  isConnected = true;
  focus = vi.fn();
}

const keyListeners = new Set<(e: { key: string; defaultPrevented: boolean }) => void>();
const doc = { activeElement: null as unknown, body: new FakeElement() };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mock.trace = projectTrace();
  mock.heat = heatmap();
  mock.heatDays = [];
  mock.spans = [
    {
      id: 'turn-a',
      parent: null,
      turn: 'turn-a',
      kind: 'turn',
      name: 'turn',
      start: NOW - 5 * MIN,
      end: null,
      status: 'running',
      timing: 'native',
    },
  ] satisfies Partial<SessionTrace['spans'][number]>[];
  mock.windows = [];
  mock.loadingFrom = null;
  mock.traceRead = {};
  mock.heatRead = {};
  mock.reloadTrace = vi.fn();
  mock.reloadHeat = vi.fn();
  mock.heatError = null;
  mock.stepsError = null;
  mock.reloadSteps = vi.fn();
  mock.events = null;
  mock.sessions = null;
  useShell.setState({ traceTab: 'timeline' });
  keyListeners.clear();
  doc.activeElement = null;
  vi.stubGlobal('HTMLElement', FakeElement);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: never) => type === 'keydown' && keyListeners.add(fn),
    removeEventListener: (_type: string, fn: never) => keyListeners.delete(fn),
  });
});
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function screen() {
  const el = TraceScreen({ projectId: 'project-a', sessions: null }) as ReactElement<any>;
  return mount(() => (el.type as (props: unknown) => ReactElement)(el.props));
}

/** Renders a child component element of a rendered tree with its current props. */
function child(tree: unknown, name: string) {
  const el = named(tree as ReactElement, name);
  return mount(() => (el.type as (props: unknown) => ReactElement)(el.props));
}

/** The component a lane row element renders, unwrapped from memo. */
const rowComponent = (n: ReactElement<any>) => {
  const type = (typeof n.type === 'function' ? n.type : (n.type as { type?: unknown })?.type) as
    ((props: unknown) => ReactElement) | undefined;
  return typeof type === 'function' && type.name === 'Row' ? type : undefined;
};
const rowElement = (tree: unknown, key?: string) =>
  find(
    tree as ReactElement,
    (n) => !!rowComponent(n) && (key === undefined || n.props.row.key === key),
  );
const renderRow = (el: ReactElement<any>) => rowComponent(el)!(el.props);

const radio = (h: HookHost<any>, label: string, value: string) => {
  find(h.value, (n) => n.props['aria-label'] === label).props.onValueChange(value);
  h.render();
};

const labelOf = (tree: unknown, head: string) =>
  nodes(tree as ReactElement)
    .map((n) => n.props['aria-label'])
    .find((label) => typeof label === 'string' && label.startsWith(`${head} `));

const lastWindow = () => mock.windows.at(-1)!;

describe('trace screen clock', () => {
  it('moves a rolling window forward as time passes without new events', async () => {
    const h = screen();
    radio(h, zh('trace.window'), '1h');
    const from = lastWindow().from;
    vi.advanceTimersByTime(2 * MIN);
    await h.flush();
    expect(lastWindow().from).toBe(from + 2 * MIN);
  });

  it('rereads a window that runs up to now once a minute', async () => {
    const h = screen();
    radio(h, zh('trace.window'), '7d');
    vi.advanceTimersByTime(MIN);
    await h.flush();
    expect(mock.reloadTrace).toHaveBeenCalledTimes(1);
    expect(mock.reloadHeat).not.toHaveBeenCalled();
  });

  it('rereads the heatmap when the day turns', async () => {
    vi.setSystemTime(new Date(2026, 2, 8, 23, 59, 30));
    const h = screen();
    radio(h, zh('trace.view'), 'heatmap');
    vi.advanceTimersByTime(MIN);
    await h.flush();
    expect(mock.reloadHeat).toHaveBeenCalledTimes(1);
  });

  it('keeps the lanes on screen while a moved window loads', async () => {
    const h = screen();
    radio(h, zh('trace.window'), '1h');
    mock.loadingFrom = lastWindow().from + MIN;
    vi.advanceTimersByTime(MIN);
    await h.flush();
    expect(lastWindow().from).toBe(mock.loadingFrom);
    expect(() => named(h.value, 'Lanes')).not.toThrow();
  });

  it("grows a running turn's analysis duration with the clock", async () => {
    const h = screen();
    named(h.value, 'Lanes').props.onPick(lane);
    h.render();
    const el = () => named(h.value, 'Analysis');
    let props = el().props;
    const panel = mount(() => (el().type as (p: unknown) => ReactElement)(props));
    expect(labelOf(panel.value, '时长')).toBe('时长 5 分钟');
    vi.advanceTimersByTime(10 * MIN);
    await h.flush();
    props = el().props;
    expect(labelOf(panel.render(), '时长')).toBe('时长 15 分钟');
  });
});

describe('trace screen default window', () => {
  const DAY = 24 * 60 * MIN;
  it.each([
    ['a turn five minutes ago', [5 * MIN], '1h'],
    ['turns over three hours', [3 * 60 * MIN, MIN], '24h'],
    ['a turn three days ago', [3 * DAY], '7d'],
    ['a turn twenty days ago', [20 * DAY, MIN], '30d'],
    ['no turn', [], '30d'],
  ] as const)('opens on the smallest window that holds %s', (_name, agos, preset) => {
    const t = projectTrace();
    t.lanes[0]!.turns = agos.map((ago, i) => ({
      id: `turn-${i}`,
      start: NOW - ago,
      end: null,
      status: 'running',
      segments: [],
    }));
    mock.trace = t;
    const h = screen();
    expect(find(h.value, (n) => n.props['aria-label'] === zh('trace.window')).props.value).toBe(
      preset,
    );
    expect(lastWindow().from).toBe(presetWindow(preset, NOW).from);
    expect(named(h.value, 'Lanes').props.bucketMs).toBe(presetWindow(preset, NOW).bucketMs);
  });
});

describe("trace screen today's window", () => {
  const openHeat = (h: HookHost<any>) => radio(h, zh('trace.view'), 'heatmap');

  it('reads today up to now rather than to the coming midnight', () => {
    const h = screen();
    openHeat(h);
    named(h.value, 'Heatmap').props.onOpenDay(lane, '2026-03-08');
    h.render();
    expect(lastWindow().from).toBe(new Date(2026, 2, 8).getTime());
    expect(lastWindow().to ?? NOW).toBeLessThanOrEqual(NOW);
  });

  it('reads a past day to its end', () => {
    const h = screen();
    openHeat(h);
    named(h.value, 'Heatmap').props.onOpenDay(lane, '2026-03-07');
    h.render();
    expect(lastWindow().to).toBe(new Date(2026, 2, 8).getTime());
  });

  it('ends the current hour at now and opens the day so far for an hour to come', () => {
    const h = screen();
    openHeat(h);
    radio(h, zh('trace.heatBy.label'), 'hour');
    named(h.value, 'HourHeatmap').props.onOpenHour('2026-03-08', 14);
    h.render();
    expect(named(h.value, 'Lanes').props.range).toEqual({
      from: new Date(2026, 2, 8, 14).getTime(),
      to: NOW,
    });
    openHeat(h);
    named(h.value, 'HourHeatmap').props.onOpenHour('2026-03-08', 16);
    h.render();
    expect(named(h.value, 'Lanes').props.range).toBeNull();
  });
});

describe('trace screen commits', () => {
  it("counts the window's commits a session made, not spans with commit records", () => {
    const h = screen();
    expect(labelOf(h.value, '提交')).toBe('提交 1');
  });

  it("counts the lane's attributed commits in the analysis", () => {
    const h = screen();
    named(h.value, 'Lanes').props.onPick(lane);
    h.render();
    expect(labelOf(child(h.value, 'Analysis').value, '提交')).toBe('提交 2');
  });

  it("reads the analysis's commits over every day, not only the recent ones", () => {
    const h = screen();
    named(h.value, 'Lanes').props.onPick(lane);
    h.render();
    mock.heatDays = [];
    child(h.value, 'Analysis');
    expect(new Set(mock.heatDays)).toEqual(new Set(['all']));
  });
});

describe('trace screen read failures', () => {
  it("shows a failed read of a turn's steps with a retry", () => {
    mock.stepsError = 'steps read failed';
    const h = screen();
    named(h.value, 'Lanes').props.onSteps(LANE, 'turn-a');
    h.render();
    const failure = named(h.value, 'Failure');
    expect(failure.props.error).toBe('steps read failed');
    expect(failure.props.onRetry).toBe(mock.reloadSteps);
  });

  it("shows a failed read of the analysis's commits with a retry", () => {
    mock.heat = null;
    mock.heatError = 'commits read failed';
    const h = screen();
    named(h.value, 'Lanes').props.onPick(lane);
    h.render();
    const failure = named(child(h.value, 'Analysis').value, 'Failure');
    expect(failure.props.error).toBe('commits read failed');
    expect(failure.props.onRetry).toBe(mock.reloadHeat);
  });
});

describe('trace screen window selection from the keyboard', () => {
  const strip = () => {
    const el = named(child(screen().value, 'Lanes').value, 'Strip');
    const onRange = vi.fn();
    const h = mount(() => (el.type as (props: unknown) => ReactElement)({ ...el.props, onRange }));
    const edges = nodes(h.value).filter((n) => n.props.role === 'slider');
    return { edges, full: el.props.full, bucketMs: el.props.bucketMs, onRange };
  };
  const press = (edge: ReactElement<any>, key: string) => {
    const e = { key, preventDefault: vi.fn() };
    edge.props.onKeyDown(e);
    return e;
  };

  it('offers a focusable start and end of the window', () => {
    expect(strip().edges.map((n) => [n.props['aria-label'], n.props.tabIndex])).toEqual([
      [zh('trace.strip.from'), 0],
      [zh('trace.strip.to'), 0],
    ]);
  });

  it('moves either end by one bucket and returns to the whole window at both edges', () => {
    const { edges, full, bucketMs, onRange } = strip();
    const [start, end] = edges;
    expect(press(start!, 'ArrowRight').preventDefault).toHaveBeenCalled();
    expect(onRange).toHaveBeenLastCalledWith({ from: full.from + bucketMs, to: full.to });
    press(end!, 'ArrowLeft');
    expect(onRange).toHaveBeenLastCalledWith({ from: full.from, to: full.to - bucketMs });
    press(start!, 'Home');
    expect(onRange).toHaveBeenLastCalledWith(null);
  });
});

describe('trace screen analysis focus', () => {
  const setup = () => {
    const h = screen();
    const row = new FakeElement();
    const main = new FakeElement();
    const inside = new FakeElement();
    find(h.value, (n) => n.props.className === 'trc-main').props.ref.current = main;
    doc.activeElement = row;
    named(h.value, 'Lanes').props.onPick(lane);
    h.render();
    const panel = child(h.value, 'Analysis');
    const aside = find(panel.value, (n) => n.type === 'aside');
    if (aside.props.ref) aside.props.ref.current = { contains: (el: unknown) => el === inside };
    doc.activeElement = inside;
    return { h, row, main, panel };
  };
  const escape = () => {
    for (const fn of [...keyListeners]) fn({ key: 'Escape', defaultPrevented: false });
  };

  it('returns focus to the session that opened it when closed', () => {
    const { h, row, panel } = setup();
    const close = find(panel.value, (n) => n.props['aria-label'] === zh('trace.analysis.close'));
    close.props.onClick();
    h.render();
    expect(row.focus).toHaveBeenCalled();
    expect(() => named(h.value, 'Analysis')).toThrow();
  });

  it('returns focus on Escape, or to the lanes when the row is gone', () => {
    const { h, row, main } = setup();
    row.isConnected = false;
    escape();
    h.render();
    expect(row.focus).not.toHaveBeenCalled();
    expect(main.focus).toHaveBeenCalled();
  });

  it('leaves focus alone when it is outside the panel', () => {
    const { h, row, main } = setup();
    doc.activeElement = new FakeElement();
    escape();
    h.render();
    expect(row.focus).not.toHaveBeenCalled();
    expect(main.focus).not.toHaveBeenCalled();
  });
});

describe('trace screen turn rows', () => {
  const START = NOW - 5 * 60 * MIN;
  const withTurn = (extra: object) => {
    const t = projectTrace();
    t.lanes[0]!.turns = [
      { id: 'turn-a', start: START, end: null, segments: [], ...extra } as never,
    ];
    mock.trace = t;
  };
  /** The lanes with the session open and the given steps under its turn. */
  const lanes = (spans: unknown[] = []) => {
    const el = named(screen().value, 'Lanes');
    const turnKey = `${LANE}/turn-a`;
    return mount(() =>
      (el.type as (props: unknown) => ReactElement)({
        ...el.props,
        open: new Set([LANE]),
        expanded: turnKey,
        steps: { turnKey, spans },
      }),
    );
  };
  const row = (tree: unknown, key: string) => renderRow(rowElement(tree, key));
  const step = (id: string, status: string) => ({
    id,
    parent: 'turn-a',
    turn: 'turn-a',
    kind: 'tool',
    name: `tool ${id}`,
    start: START + MIN,
    end: null,
    status,
    timing: 'native',
  });

  it('leaves out the length of a turn without an end that is not running', () => {
    withTurn({ status: 'unknown' });
    const turn = row(lanes().value, `${LANE}/turn-a`);
    const head = find(turn, (n) => n.props.className === 'trc-head');
    expect(head.props['aria-label']).toBe(
      `codex session 回合 ${dayText(START, NOW, { time: true })}，未知`,
    );
  });

  it('draws only a running step without an end', () => {
    withTurn({ status: 'running' });
    const tree = lanes([step('call-open', 'running'), step('call-lost', 'unknown')]).value;
    const bars = (key: string) =>
      nodes(row(tree, `${LANE}/turn-a/${key}`)).filter((n) =>
        String(n.props.className).includes('trc-step'),
      );
    expect(bars('call-open')).toHaveLength(1);
    expect(bars('call-lost')).toHaveLength(0);
  });

  it("marks a turn's status other than done on its row", () => {
    withTurn({ status: 'error', end: START + MIN });
    const turn = row(lanes().value, `${LANE}/turn-a`);
    expect(find(turn, (n) => n.props.className === 'trc-st').props['data-status']).toBe('error');
    withTurn({ status: 'ok', end: START + MIN });
    const done = row(lanes().value, `${LANE}/turn-a`);
    expect(nodes(done).some((n) => n.props.className === 'trc-st')).toBe(false);
  });
});

describe('trace screen row updates', () => {
  it('gives each lane row the same props when the lanes render again, and skips equal props', () => {
    const lanes = child(screen().value, 'Lanes');
    const rows = () => nodes(lanes.value).filter((n) => !!rowComponent(n));
    const before = rows();
    expect(before).not.toHaveLength(0);
    lanes.render();
    const after = rows();
    expect(after.map((n) => n.key)).toEqual(before.map((n) => n.key));
    for (const [i, el] of after.entries())
      for (const [name, value] of Object.entries(el.props))
        expect(value, name).toBe(before[i]!.props[name]);
    expect((before[0]!.type as { $$typeof?: symbol }).$$typeof).toBe(Symbol.for('react.memo'));
  });
});

describe('trace screen error count', () => {
  it('takes the count to the session whose failure has no turn to show', () => {
    const t = projectTrace();
    t.stats = { ...zero, error: 1 };
    t.lanes[0]!.stats = { ...zero, error: 1 };
    mock.trace = t;
    const h = screen();
    const button = () => find(h.value, (n) => n.props['aria-label'] === '错误 1');
    expect(button().props.disabled).toBe(false);
    button().props.onClick();
    h.render();
    expect(named(h.value, 'Lanes').props.open.has(LANE)).toBe(true);
  });
});

describe('trace screen continue in Pantheon', () => {
  const sessionRow = (h: HookHost<any>) => renderRow(rowElement(child(h.value, 'Lanes').value));
  const continueButton = (tree: unknown) =>
    nodes(tree as ReactElement).find(
      (n) => n.type === 'button' && n.props.children === zh('trace.row.adopt'),
    );

  beforeEach(() => mock.command.mockReset());

  it('offers an external session to continue in Pantheon and opens the adopted session', async () => {
    const openSession = vi.fn();
    useShell.setState({ openSession });
    mock.command.mockResolvedValue({ ok: true, value: { id: 'session-adopted' } });
    const h = screen();
    continueButton(sessionRow(h))!.props.onClick();
    await h.flush();
    expect(mock.command).toHaveBeenCalledWith(
      'session.adopt',
      { project_id: 'project-a', runtime: 'codex', native_session_id: 'abc' },
      null,
    );
    expect(openSession).toHaveBeenCalledWith('session-adopted');
  });

  it('shows why a session could not be continued', async () => {
    mock.command.mockResolvedValue({
      ok: false,
      error: { code: 'not_implemented', message: 'session.adopt is not implemented' },
    });
    const h = screen();
    continueButton(sessionRow(h))!.props.onClick();
    await h.flush();
    expect(named(h.value, 'Failure').props.error).toBe(zh('data.reason.notImplemented'));
  });

  it("offers no continue on a Pantheon session's row", () => {
    const t = projectTrace();
    t.lanes[0]!.lane = { ...t.lanes[0]!.lane, source: 'pantheon', session_id: 'session-a' };
    mock.trace = t;
    expect(continueButton(sessionRow(screen()))).toBeUndefined();
  });
});

describe('trace screen heatmap', () => {
  it('shows the commit row when no session ran in the range', () => {
    mock.heat = { ...heatmap(), lanes: [] };
    const h = screen();
    radio(h, zh('trace.view'), 'heatmap');
    expect(labelOf(child(h.value, 'Heatmap').value, '3月8日')).toBe('3月8日 3 个提交');
  });

  it('shows an hour that failed without a call', () => {
    const heat = heatmap();
    heat.hours[0]!.errors[9] = 1;
    mock.heat = heat;
    const h = screen();
    radio(h, zh('trace.view'), 'heatmap');
    radio(h, zh('trace.heatBy.label'), 'hour');
    expect(labelOf(child(h.value, 'HourHeatmap').value, '3月8日 9 时')).toBe(
      '3月8日 9 时 0 次调用，1 个错误',
    );
  });
});

const tabTo = (h: HookHost<any>, tab: string) => {
  find(h.value, (n) => n.props.className === 'tb-pg').props.onValueChange(tab);
  h.render();
};
const has = (tree: unknown, name: string) =>
  nodes(tree as ReactElement).some((n) => typeof n.type === 'function' && n.type.name === name);

let sequence = 0;
const daemonEvent = (kind: string, at: number, payload: object = {}, aggregate = 'session-a') => ({
  event_id: `event-${++sequence}`,
  kind,
  aggregate_id: aggregate,
  aggregate_revision: 1,
  project_id: 'project-a',
  sequence,
  created_at: at,
  causation_id: '',
  payload,
});
const gateFailed = (at: number) =>
  daemonEvent('session.gate_checked', at, { results: [{ name: 'test', exit_code: 1 }] });
const asked = (at: number) =>
  daemonEvent('agent.permission.requested', at, { request_id: `r${at}`, tool: 'Bash' });

describe('trace screen tabs', () => {
  const tabs = (tree: unknown) =>
    nodes(tree as ReactElement)
      .filter((n) => n.props.className === 'tb-tab')
      .map((n) => [n.props.value, n.props.children]);
  const button = (tree: unknown, label: string) =>
    nodes(tree as ReactElement).find((n) => n.type === 'button' && n.props['aria-label'] === label);
  const backButton = (tree: unknown) =>
    nodes(tree as ReactElement).find(
      (n) => n.type === 'button' && text(n) === zh('trace.replay.back'),
    );

  it('names the timeline, runs, activity and diagnose tabs in that order', () => {
    expect(tabs(screen().value)).toEqual([
      ['timeline', zh('trace.tab.timeline')],
      ['runs', zh('trace.tab.runs')],
      ['activity', zh('trace.tab.activity')],
      ['diagnose', zh('trace.tab.diagnose')],
    ]);
  });

  it('shows the tab the shell asks for and writes a picked tab back to the shell', () => {
    mock.events = [];
    const h = screen();
    expect(has(h.value, 'EventTable')).toBe(true);
    useShell.getState().setTraceTab('activity');
    h.render();
    expect(has(h.value, 'Lanes')).toBe(false);
    expect(has(h.value, 'ActivityList')).toBe(true);
    tabTo(h, 'diagnose');
    expect(useShell.getState().traceTab).toBe('diagnose');
  });

  it('mounts the runs content with the listed sessions on the runs tab', () => {
    useShell.setState({ traceTab: 'runs' });
    const sessions = [{ id: 'session-a' }];
    const el = TraceScreen({ projectId: 'project-a', sessions } as never) as ReactElement<any>;
    const h = mount(() => (el.type as (props: unknown) => ReactElement)(el.props));
    expect(named(h.value, 'RunsView').props).toMatchObject({ projectId: 'project-a', sessions });
    expect(has(h.value, 'Lanes')).toBe(false);
  });

  it('replays a session from its row in the timeline and goes back to the timeline', () => {
    mock.events = [];
    const h = screen();
    expect(has(child(h.value, 'Lanes').value, 'Replayer')).toBe(true);
    expect(backButton(h.value)).toBeUndefined();
    const row = renderRow(rowElement(child(h.value, 'Lanes').value));
    button(row, zh('trace.row.replay'))!.props.onClick();
    h.render();
    expect(useShell.getState().traceTab).toBe('timeline');
    expect(named(h.value, 'StepReplay').props.sessionId).toBe(LANE);
    expect(has(h.value, 'Lanes')).toBe(false);
    expect(has(h.value, 'EventTable')).toBe(false);
    expect(nodes(h.value).some((n) => n.props['aria-label'] === zh('trace.view'))).toBe(false);

    backButton(h.value)!.props.onClick();
    h.render();
    expect(has(h.value, 'StepReplay')).toBe(false);
    expect(has(h.value, 'EventTable')).toBe(true);
    expect(backButton(h.value)).toBeUndefined();
  });

  it('keeps the heatmap switch inside the timeline tab', () => {
    const h = screen();
    radio(h, zh('trace.view'), 'heatmap');
    expect(has(h.value, 'Heatmap')).toBe(true);
    tabTo(h, 'activity');
    expect(has(h.value, 'Heatmap')).toBe(false);
    expect(nodes(h.value).some((n) => n.props['aria-label'] === zh('trace.view'))).toBe(false);
  });
});

describe('trace screen read status', () => {
  const shownStatus = (tree: unknown) =>
    nodes(tree as ReactElement)
      .filter((n) => typeof n.type === 'function' && n.type.name === 'ReadStatus')
      .map((n) => (n.type as (props: unknown) => ReactElement | null)(n.props))
      .filter(Boolean);

  it('draws no status bar over cached diagnostics whose reads land quickly, one after the other', async () => {
    useShell.setState({ traceTab: 'diagnose' });
    mock.traceRead = { stale: true, refreshing: true };
    mock.heatRead = { stale: true, refreshing: true };
    const h = screen();
    expect(shownStatus(h.value)).toHaveLength(0);
    vi.advanceTimersByTime(100);
    mock.traceRead = {};
    h.render();
    expect(shownStatus(h.value)).toHaveLength(0);
    vi.advanceTimersByTime(100);
    mock.heatRead = {};
    h.render();
    await h.flush();
    expect(shownStatus(h.value)).toHaveLength(0);
  });

  it('names a cached read once it runs long, and a lost stream at once', async () => {
    useShell.setState({ traceTab: 'diagnose' });
    mock.traceRead = { stale: true, refreshing: true };
    const h = screen();
    vi.advanceTimersByTime(300);
    await h.flush();
    expect(shownStatus(h.value)).toHaveLength(1);
    mock.traceRead = {};
    mock.heatRead = { stale: true };
    h.render();
    expect(shownStatus(h.value)).toHaveLength(1);
  });
});

describe('trace screen number row', () => {
  it('counts calls and the gate failures of the window, and leaves the failures out until the events are read', () => {
    const t = projectTrace();
    t.stats = { ...zero, llm: 3, tool: 4 };
    mock.trace = t;
    expect(labelOf(screen().value, '调用')).toBe('调用 7');
    expect(labelOf(screen().value, '门禁失败')).toBeUndefined();
    mock.events = [gateFailed(NOW - 10 * MIN), gateFailed(new Date(2026, 1, 1).getTime())];
    expect(labelOf(screen().value, '门禁失败')).toBe('门禁失败 1');
  });

  it('keeps every cell of the row in place while the events and the commits are read', () => {
    const cells = (tree: unknown) => {
      const row = find(tree as ReactElement, (n) =>
        [n.props.children]
          .flat()
          .some((c: any) => c?.props?.['aria-label']?.startsWith(`${zh('trace.stat.calls')} `)),
      );
      return [row.props.children]
        .flat()
        .filter(Boolean)
        .map((cell: any) => [text([cell.props.children].flat()[0]), !!cell.props['aria-busy']]);
    };
    mock.events = null;
    mock.heat = null;
    const reading = cells(screen().value);
    mock.events = [gateFailed(NOW - 10 * MIN)];
    mock.heat = heatmap();
    const read = cells(screen().value);
    expect(reading.map(([label]) => label)).toEqual(read.map(([label]) => label));
    expect(reading.filter(([, busy]) => busy).map(([label]) => label)).toEqual([
      zh('trace.stat.gateFailures'),
      zh('trace.stat.commits'),
    ]);
    expect(read.some(([, busy]) => busy)).toBe(false);
  });

  it.each<[string, TraceStats['tokens'], number | undefined, string, string]>([
    [
      'marks the tokens missing while no turn of the window reported usage',
      { input: 0, output: 0 },
      2,
      '—',
      'tokens 2 个回合没上报用量',
    ],
    [
      'writes the known tokens with a plus while some turns reported none',
      { input: 1500, output: 500 },
      1,
      '2k+',
      'tokens 2k，另有 1 个回合没上报用量',
    ],
    [
      'writes the tokens as they are while every turn reported usage',
      { input: 1500, output: 500 },
      undefined,
      '2k',
      'tokens 2k',
    ],
  ])('%s', (_name, tokens, unreported, shown, label) => {
    const t = projectTrace();
    t.stats = {
      ...zero,
      tokens,
      ...(unreported === undefined ? {} : { turns_without_usage: unreported }),
    };
    mock.trace = t;
    const h = screen();
    expect(labelOf(h.value, 'tokens')).toBe(label);
    expect(text(find(h.value, (n) => n.props['aria-label'] === label))).toBe(`tokens${shown}`);
  });
});

describe('trace screen event table', () => {
  it('lists the events of the window, newest first, and leaves out a kind turned off', () => {
    mock.events = [asked(NOW - 30 * MIN), gateFailed(NOW - 20 * MIN)];
    const h = screen();
    const rows = () => named(h.value, 'EventTable').props.rows.map((r: { what: string }) => r.what);
    expect(rows()).toEqual(['gate_failed', 'asked']);
    const items = nodes(h.value).filter((n) => typeof n.props.onCheckedChange === 'function');
    expect(items.map((n) => n.props.checked)).toEqual([true, true]);
    items[1]!.props.onCheckedChange(false);
    h.render();
    expect(rows()).toEqual(['asked']);
  });

  it('names a session without a title as untitled in the event rows and its lane', () => {
    const t = projectTrace();
    t.lanes[0]!.lane = { ...t.lanes[0]!.lane, title: '' };
    mock.trace = t;
    const h = screen();
    const untitled = zh('trace.session.untitled');
    expect(named(h.value, 'EventTable').props.titleOf(LANE)).toBe(untitled);
    expect(named(h.value, 'EventTable').props.titleOf('session-unknown')).toBe('session-unknown');
    const row = renderRow(rowElement(child(h.value, 'Lanes').value));
    const label = find(row, (n) => n.props['aria-expanded'] !== undefined).props['aria-label'];
    expect(label.startsWith(`${untitled}，`)).toBe(true);
    expect(nodes(row).some((n) => n.props.children === untitled)).toBe(true);
  });

  it("moves the lanes' view to a picked event and marks its session's lane", () => {
    const t = projectTrace();
    t.lanes[0]!.lane = {
      ...t.lanes[0]!.lane,
      key: 'session-a',
      source: 'pantheon',
      session_id: 'session-a',
    };
    mock.trace = t;
    mock.sessions = [{ id: 'session-a', title: 'fix the refund' }];
    const at = new Date(2026, 2, 5).getTime();
    mock.events = [gateFailed(at)];
    const h = screen();
    const table = named(h.value, 'EventTable');
    expect(table.props.titleOf('session-a')).toBe('fix the refund');
    table.props.onShow(table.props.rows[0]);
    h.render();
    const lanes = named(h.value, 'Lanes');
    const length = (Date.parse(t.to) - Date.parse(t.from)) / 10;
    expect(lanes.props.range).toEqual({ from: at - length / 2, to: at + length / 2 });
    expect(lanes.props.focus).toBe('session-a');
    expect(named(h.value, 'EventTable').props.shown).toBe(table.props.rows[0].id);
  });
});

describe('trace screen as of the replay playhead', () => {
  const replayed = (at: number | null) => {
    const t = projectTrace();
    t.lanes[0]!.turns = [
      {
        id: 'turn-a',
        start: NOW - 40 * MIN,
        end: NOW - 20 * MIN,
        status: 'ok',
        tokens: { input: 1000, output: 0 },
        segments: [],
      },
      { id: 'turn-b', start: NOW - 5 * MIN, end: null, status: 'running', segments: [] },
    ];
    t.buckets = [
      { at: NOW - 35 * MIN, llm: 2, tool: 1, error: 0 },
      { at: NOW - 25 * MIN, llm: 1, tool: 0, error: 1 },
      { at: NOW - 3 * MIN, llm: 5, tool: 5, error: 1 },
    ];
    t.stats = { ...zero, llm: 8, tool: 6, error: 2, tokens: { input: 1000, output: 0 } };
    mock.trace = t;
    mock.events = [asked(NOW - 50 * MIN), gateFailed(NOW - 20 * MIN), asked(NOW - 10 * MIN)];
    const h = screen();
    named(h.value, 'Lanes').props.onReplayAt(at);
    h.render();
    return h;
  };
  const kpiLabel = (h: HookHost<any>, id: string) => labelOf(h.value, zh(id));

  it('shows each number as of the playhead, running sessions in place of sessions', () => {
    const h = replayed(NOW - 30 * MIN);
    expect(kpiLabel(h, 'trace.stat.sessions')).toBeUndefined();
    expect(
      [
        'trace.stat.running',
        'trace.stat.duration',
        'trace.stat.calls',
        'trace.stat.gateFailures',
        'trace.stat.tokens',
        'trace.stat.commits',
      ].map((id) => kpiLabel(h, id)),
    ).toEqual([
      `${zh('trace.stat.running')} 1`,
      `${zh('trace.stat.duration')} ${durationText(10 * MIN)}`,
      `${zh('trace.stat.calls')} 3`,
      `${zh('trace.stat.gateFailures')} 0`,
      `${zh('trace.stat.tokens')} 500`,
      `${zh('trace.stat.commits')} 0`,
    ]);
    expect(
      nodes(h.value).some(
        (n) => n.props['aria-label'] === zhf('trace.stat.errorCount', { count: 0 }),
      ),
    ).toBe(true);

    named(h.value, 'Lanes').props.onReplayAt(null);
    h.render();
    expect(kpiLabel(h, 'trace.stat.running')).toBeUndefined();
    expect(kpiLabel(h, 'trace.stat.sessions')).toBe(`${zh('trace.stat.sessions')} 1`);
    expect(kpiLabel(h, 'trace.stat.calls')).toBe(`${zh('trace.stat.calls')} 14`);
  });

  it('lists only the events up to the playhead, the newest marked current', () => {
    const h = replayed(NOW - 15 * MIN);
    const table = named(h.value, 'EventTable');
    expect(table.props.rows.map((r: { what: string }) => r.what)).toEqual(['gate_failed', 'asked']);
    expect(table.props.current).toBe(table.props.rows[0].id);
    const rows = nodes(child(h.value, 'EventTable').value)
      .map((n) => n.props.render)
      .filter((r) => r?.props.className === 'tlo-er');
    expect(rows.map((r) => [r.props['aria-current'], r.props['data-sel']])).toEqual([
      ['true', true],
      [undefined, undefined],
    ]);

    named(h.value, 'Lanes').props.onReplayAt(null);
    h.render();
    expect(named(h.value, 'EventTable').props.rows).toHaveLength(3);
    expect(named(h.value, 'EventTable').props.current).toBeNull();
  });

  it('puts the events over the replay bar by time, session and text, and steps through them and the turn starts', () => {
    const h = replayed(null);
    const replayer = named(child(h.value, 'Lanes').value, 'Replayer');
    const bar = mount(() =>
      (replayer.type as (props: unknown) => ReactElement<any>)(replayer.props),
    ).value;
    const gate = zhf('trace.event.gateFailedCount', { check: 'test', failed: 1 });
    const ask = zhf('trace.event.asked', { tool: 'Bash' });
    expect(
      bar.props.ticks.map((tick: { label: string; tone?: string }) => [tick.label, tick.tone]),
    ).toEqual([
      [listText(eventClock(NOW - 50 * MIN, NOW), 'session-a', ask), 'wait'],
      [listText(eventClock(NOW - 20 * MIN, NOW), 'session-a', gate), 'bad'],
      [listText(eventClock(NOW - 10 * MIN, NOW), 'session-a', ask), 'wait'],
    ]);
    expect(bar.props.replay.steps).toEqual(
      [50, 40, 20, 10, 5].map((minutes) => NOW - minutes * MIN),
    );
    expect(bar.props.marks).toEqual([]);
  });
});

describe('trace screen idle gaps', () => {
  it('labels a cut idle stretch over the lanes with its length', () => {
    const t = projectTrace();
    const start = new Date(2026, 2, 3).getTime();
    t.lanes[0]!.turns = [
      { id: 'turn-a', start, end: start + 10 * MIN, status: 'ok', segments: [] },
      { id: 'turn-b', start: NOW - 5 * MIN, end: null, status: 'running', segments: [] },
    ];
    mock.trace = t;
    const lanes = child(screen().value, 'Lanes').value;
    const gaps = nodes(lanes).filter((n) => n.props.className === 'trc-gap');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.props['aria-label']).toMatch(/^空闲 \d+ 天/);
  });
});
