import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { ProjectTrace, TraceStats, WorkbenchSession } from '@pantheon/protocol';
import { find, mount, named, nodes, text, unmountAll, type HookHost } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  trace: null as unknown,
  windows: [] as { from: number; to: number | null; bucketMs: number }[],
}));
vi.mock('@/data/commands', () => ({ runCommand: vi.fn() }));
vi.mock('@/data/logs', async (actual) => ({
  ...(await actual<object>()),
  useEventHistory: () => ({ events: [], error: null, reload() {} }),
}));
vi.mock('@/data/workbench-sessions', async (actual) => ({
  ...(await actual<object>()),
  useSessionList: () => ({ data: null, loading: false, error: null, reload() {} }),
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
    return { data: projectId ? mock.trace : null, loading: false, error: null, reload() {} };
  },
  useProjectHeatmap: () => ({ data: null, loading: false, error: null, reload() {} }),
  useSessionTrace: () => ({ data: null, loading: false, error: null, reload() {} }),
  useTraceTime: () => ({ data: null, loading: true, error: null, reload() {} }),
  useTurnSteps: () => ({ data: null, loading: false, error: null, reload() {} }),
}));
import { SHORTCUTS } from '@/lib/shortcuts';
import { TraceScreen } from '@/screens/trace/TraceScreen';
import { useShell } from '@/store';
import { zh } from './i18n-setup.js';

const MIN = 60_000;
const NOW = new Date(2026, 2, 8, 14, 20).getTime();
const MIDNIGHT = new Date(2026, 2, 8).getTime();
const LANE = 'session-a';

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

const projectTrace = (from: number): ProjectTrace => ({
  epoch: null,
  from: new Date(from).toISOString(),
  to: new Date(NOW).toISOString(),
  indexing: null,
  stats: zero,
  lanes: [
    {
      lane: {
        key: LANE,
        source: 'pantheon',
        runtime: 'claude',
        session_id: LANE,
        native_id: 'native-a',
        title: 'fix the refund',
        cwd: '/repo',
      },
      stats: zero,
      turns: [{ id: 'turn-a', start: NOW - 80 * MIN, end: null, status: 'running', segments: [] }],
    },
  ],
  buckets: [],
});

type KeyListener = (e: Record<string, unknown>) => void;
const keyListeners = new Set<KeyListener>();
const press = (key: string) => {
  for (const listener of [...keyListeners])
    listener({
      key,
      code: `Key${key.toUpperCase()}`,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      target: null,
      defaultPrevented: false,
      preventDefault() {},
    });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mock.trace = projectTrace(MIDNIGHT);
  mock.windows = [];
  useShell.setState({ traceTab: 'timeline', runsView: 'now', runsSession: null });
  keyListeners.clear();
  vi.stubGlobal('document', { activeElement: null, body: {} });
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: KeyListener) => type === 'keydown' && keyListeners.add(fn),
    removeEventListener: (_type: string, fn: KeyListener) => keyListeners.delete(fn),
  });
});
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const session = (id: string, state: WorkbenchSession['state']) =>
  ({ id, title: id, state }) as WorkbenchSession;

function screen(sessions: WorkbenchSession[] = []) {
  const el = TraceScreen({ projectId: 'project-a', sessions }) as ReactElement<any>;
  return mount(() => (el.type as (props: unknown) => ReactElement)(el.props));
}

const group = (tree: unknown, label: string) =>
  nodes(tree as ReactElement).find((n) => n.props['aria-label'] === label);
const options = (tree: unknown, label: string) =>
  [group(tree, label)!.props.children].flat().map((n) => [n.props.value, text(n.props.children)]);
const pick = (h: HookHost<any>, label: string, value: string) => {
  group(h.value, label)!.props.onValueChange(value);
  h.render();
};
const lastWindow = () => mock.windows.at(-1)!;

describe('trace bar on the runs tab', () => {
  it('switches between the now and history views and counts the sessions running now', () => {
    useShell.setState({ traceTab: 'runs' });
    const h = screen([
      session('a', 'running'),
      session('b', 'waiting'),
      session('c', 'idle'),
      session('d', 'merged'),
    ]);
    const views = group(h.value, zh('trace.bar.view'))!;
    expect(views.props.value).toBe('now');
    const now = find(views.props.children, (n) => n.props.value === 'now');
    expect(now.props['aria-label']).toBe('现在，2 个会话在跑');
    expect(text(now.props.children)).toBe('现在2');
    expect(options(h.value, zh('trace.bar.view'))).toEqual([
      ['now', '现在2'],
      ['history', zh('trace.bar.history')],
    ]);
    pick(h, zh('trace.bar.view'), 'history');
    expect(useShell.getState().runsView).toBe('history');
    expect(named(h.value, 'RunsView').props.view).toBe('history');
  });

  it('says no session runs when none does', () => {
    useShell.setState({ traceTab: 'runs' });
    const now = find(
      group(screen().value, zh('trace.bar.view'))!.props.children,
      (n) => n.props.value === 'now',
    );
    expect(now.props['aria-label']).toBe('现在，没有会话在跑');
  });

  it('offers an hour, today and all time in the history view only', () => {
    useShell.setState({ traceTab: 'runs' });
    const h = screen();
    const periods = () => nodes(h.value).filter((n) => n.props.value === 'today');
    expect(periods()).toEqual([]);
    pick(h, zh('trace.bar.view'), 'history');
    expect(periods()).not.toHaveLength(0);
    expect(options(h.value, zh('trace.bar.range'))).toEqual([
      ['1h', zh('trace.preset.hour')],
      ['today', zh('trace.bar.today')],
      ['all', zh('trace.bar.all')],
    ]);
    const range = group(h.value, zh('trace.bar.range'))!;
    expect(range.props.disabled).toBeFalsy();
    expect(range.props.value).toBe('today');
    expect(named(h.value, 'RunsView').props.range).toEqual({ from: MIDNIGHT, to: null });
    pick(h, zh('trace.bar.range'), 'all');
    expect(named(h.value, 'RunsView').props.range).toEqual({ from: 0, to: null });
    expect(lastWindow().from).toBe(0);
    pick(h, zh('trace.bar.range'), '1h');
    expect(named(h.value, 'RunsView').props.range).toEqual({ from: NOW - 60 * MIN, to: null });
  });

  it("hands the runs the session the shell asks for and shows a call's moment in the timeline", () => {
    useShell.getState().showRuns(LANE);
    expect(useShell.getState()).toMatchObject({
      screen: 'trace',
      traceTab: 'runs',
      runsSession: LANE,
    });
    const h = screen();
    const runs = named(h.value, 'RunsView');
    expect(runs.props.sessionId).toBe(LANE);
    runs.props.onShowInTimeline({ lane_key: LANE, turn_id: 'turn-a', at: NOW - 70 * MIN });
    h.render();
    expect(useShell.getState().traceTab).toBe('timeline');
    const lanes = named(h.value, 'Lanes');
    expect(lanes.props.focus).toBe(`${LANE}/turn-a`);
    expect(lanes.props.open.has(LANE)).toBe(true);
    expect(lanes.props.expanded).toBe(`${LANE}/turn-a`);
    expect(lastWindow().from).toBe(MIDNIGHT);
  });

  it('shows all sessions again when the shell asks for the runs of none', () => {
    useShell.getState().showRuns(LANE);
    useShell.getState().showRuns(null);
    expect(useShell.getState().runsSession).toBeNull();
    expect(named(screen().value, 'RunsView').props.sessionId).toBeNull();
  });
});

describe('trace bar on the diagnose tab', () => {
  it('offers an hour, today and all time, today first, and writes the window it reads', () => {
    useShell.setState({ traceTab: 'diagnose' });
    const h = screen();
    expect(options(h.value, zh('trace.bar.range'))).toEqual([
      ['1h', zh('trace.preset.hour')],
      ['today', zh('trace.bar.today')],
      ['all', zh('trace.bar.all')],
    ]);
    expect(group(h.value, zh('trace.bar.range'))!.props.value).toBe('today');
    expect(lastWindow().from).toBe(MIDNIGHT);
    const span = find(h.value, (n) => n.props.className === 'trb-win');
    expect(text(span.props.children)).toBe('00:00 – 14:20');
  });

  it('starts the window of all time at its first turn', () => {
    useShell.setState({ traceTab: 'diagnose' });
    const h = screen();
    mock.trace = projectTrace(0);
    pick(h, zh('trace.bar.range'), 'all');
    expect(lastWindow().from).toBe(0);
    const span = find(h.value, (n) => n.props.className === 'trb-win');
    expect(text(span.props.children)).toBe('13:00 – 14:20');
  });

  it('has no view switch and keeps the timeline presets on the timeline', () => {
    useShell.setState({ traceTab: 'diagnose' });
    expect(group(screen().value, zh('trace.bar.view'))).toBeUndefined();
    useShell.setState({ traceTab: 'timeline' });
    expect(options(screen().value, zh('trace.window')).map(([value]) => value)).toEqual([
      '1h',
      '24h',
      '7d',
      '30d',
    ]);
  });

  it('ends the bar with the analysis menu of the window on the diagnose tab only', () => {
    useShell.setState({ traceTab: 'diagnose' });
    const diagnostics = {
      from: MIDNIGHT,
      to: NOW,
      events_read: 4,
      tools_timed: 1,
      tools_untimed: 0,
      partial: false,
      native: 'included' as const,
      findings: [],
    };
    mock.trace = {
      ...projectTrace(MIDNIGHT),
      diagnostics,
      reflection_runtimes: ['claude'],
    };
    const h = screen();
    const end = find(h.value, (n) => n.props.className === 'tb-end');
    const menu = nodes(end.props.children).at(-1)!;
    expect((menu.type as any).name).toBe('AnalyzeMenu');
    expect(menu.props).toMatchObject({
      projectId: 'project-a',
      diagnostics,
      runtimes: ['claude'],
      windowText: '00:00 – 14:20',
      stale: false,
    });
    useShell.setState({ traceTab: 'runs' });
    h.render();
    expect(nodes(h.value).some((n) => (n.type as any)?.name === 'AnalyzeMenu')).toBe(false);
  });

  it('widens the diagnose window to all time from its empty state', () => {
    useShell.setState({ traceTab: 'diagnose' });
    mock.trace = {
      ...projectTrace(MIDNIGHT),
      diagnostics: {
        from: MIDNIGHT,
        to: NOW,
        events_read: 0,
        tools_timed: 0,
        tools_untimed: 0,
        partial: false,
        native: 'included',
        findings: [],
      },
    };
    const h = screen();
    named(h.value, 'RuntimePanel').props.onAllTime();
    h.render();
    expect(group(h.value, zh('trace.bar.range'))!.props.value).toBe('all');
    expect(named(h.value, 'RuntimePanel').props.onAllTime).toBeUndefined();
  });
});

describe('trace bar keys', () => {
  it('lists the view, all time and row keys under the trace page', () => {
    const trace = SHORTCUTS.filter((s) => s.scope === 'trace').map((s) => [s.id, s.keys, s.label]);
    expect(trace).toEqual([
      ['trace-view', 'V', zh('lib.shortcuts.label.traceView')],
      ['trace-all', 'A', zh('lib.shortcuts.label.traceAll')],
      ['trace-next', 'J', zh('lib.shortcuts.label.traceNext')],
      ['trace-previous', 'K', zh('lib.shortcuts.label.tracePrevious')],
      ['replay-back', 'ArrowLeft', zh('lib.shortcuts.label.replayBack')],
      ['replay-forward', 'ArrowRight', zh('lib.shortcuts.label.replayForward')],
      ['replay-play', 'Space', zh('lib.shortcuts.label.replayPlay')],
    ]);
  });

  it('switches the view with V on the runs tab and reads all time with A in the history view', () => {
    useShell.setState({ traceTab: 'runs' });
    const h = screen();
    press('a');
    h.render();
    expect(group(h.value, zh('trace.bar.range'))).toBeUndefined();
    press('v');
    h.render();
    expect(useShell.getState().runsView).toBe('history');
    expect(group(h.value, zh('trace.bar.range'))!.props.value).toBe('today');
    press('a');
    h.render();
    expect(group(h.value, zh('trace.bar.range'))!.props.value).toBe('all');
    press('v');
    h.render();
    expect(useShell.getState().runsView).toBe('now');
  });

  it('reads all time with A on the diagnose tab and leaves V alone there', () => {
    useShell.setState({ traceTab: 'diagnose' });
    const h = screen();
    press('v');
    h.render();
    expect(useShell.getState().runsView).toBe('now');
    press('a');
    h.render();
    expect(group(h.value, zh('trace.bar.range'))!.props.value).toBe('all');
  });
});
