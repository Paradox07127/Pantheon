import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { ProjectTimeline, ProjectTrace, TraceStats } from '@pantheon/protocol';
import { find, mount as mountBody, named, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  trace: null as unknown,
  timeline: null as unknown,
  events: null as unknown[] | null,
}));
vi.mock('@/data/commands', () => ({ runCommand: vi.fn() }));
vi.mock('@/data/logs', async (actual) => ({
  ...(await actual<object>()),
  useEventHistory: () => ({ events: mock.events, error: null, reload() {} }),
}));
vi.mock('@/data/workbench-sessions', async (actual) => ({
  ...(await actual<object>()),
  useSessionList: () => ({ data: [], loading: false, error: null, reload() {} }),
}));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/trace', async (actual) => ({
  ...(await actual<object>()),
  useProjectTrace: (projectId: string | null) => ({
    data: projectId ? mock.trace : null,
    loading: false,
    error: null,
    reload() {},
  }),
  useProjectTimeline: (projectId: string | null) => ({
    data: projectId ? mock.timeline : null,
    loading: false,
    error: null,
    reload() {},
  }),
  useProjectHeatmap: () => ({ data: null, loading: false, error: null, reload() {} }),
  useSessionTrace: () => ({ data: null, loading: false, error: null, reload() {} }),
  useTraceTime: () => ({ data: null, loading: false, error: null, reload() {} }),
  useTurnSteps: () => ({ data: null, loading: false, error: null, reload() {} }),
}));
import { LaneLegend, LaneOverlay } from '@/screens/trace/LaneOverlay';
import { EventTable } from '@/screens/trace/EventTable';
import { TraceScreen } from '@/screens/trace/TraceScreen';
import { traceEvents, type TraceEvent, type TraceRow } from '@/screens/trace/model';
import { durationText } from '@/lib/time-text';
import { useShell } from '@/store';
import { zh } from './i18n-setup.js';

const MIN = 60_000;
const NOW = new Date(2026, 2, 8, 14, 20, 0).getTime();
const FROM = NOW - 60 * MIN;
const VIEW = { from: FROM, to: NOW };
const axis = { position: (at: number) => (at - FROM) / (NOW - FROM) };

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

const laneView = (key: string, title: string): ProjectTrace['lanes'][number] => ({
  lane: {
    key,
    source: 'pantheon',
    runtime: 'claude',
    session_id: key,
    native_id: `native-${key}`,
    title,
    cwd: '/repo',
  },
  stats: zero,
  turns: [
    {
      id: `turn-${key}`,
      start: NOW - 40 * MIN,
      end: NOW - 20 * MIN,
      status: 'ok',
      tokens: { input: 1200, output: 300 },
      cost_usd: 0.42,
      segments: [],
    },
  ],
});
const sessionRow = (key: string, title: string): TraceRow => ({
  kind: 'session',
  key,
  lane: laneView(key, title),
  stats: zero,
});

let sequence = 0;
const daemonEvent = (kind: string, at: number, sessionId: string, payload: object) => ({
  event_id: `event-${++sequence}`,
  kind,
  aggregate_id: sessionId,
  aggregate_revision: 1,
  project_id: 'project-a',
  sequence,
  created_at: at,
  causation_id: '',
  payload,
});
const gate = (at: number, sessionId: string, exit: number, durations: number[] = []) =>
  daemonEvent('session.gate_checked', at, sessionId, {
    results: durations.length
      ? durations.map((ms, i) => ({ name: `check-${i}`, exit_code: exit, duration_ms: ms }))
      : [{ name: 'test', exit_code: exit }],
  });
const asked = (at: number, sessionId: string, request: string) =>
  daemonEvent('agent.permission.requested', at, sessionId, { request_id: request, tool: 'Bash' });
const resolved = (at: number, sessionId: string, request: string) =>
  daemonEvent('agent.permission.resolved', at, sessionId, {
    request_id: request,
    decision: 'allow',
  });
const merged = (at: number, sessionId: string) =>
  daemonEvent('session.merged', at, sessionId, { to_sha: 'abcdef1234' });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal('document', { activeElement: null, body: {} });
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
});
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const mount = <P>(component: (props: P) => ReactElement | null, props: P) =>
  mountBody(() => component(props));

/** The text of a function component element rendered with its props. */
const shownText = (el: ReactElement<any>) =>
  text((el.type as (props: unknown) => ReactElement)(el.props));

const marks = (tree: unknown) =>
  nodes(tree as ReactElement)
    .map((n) => n.props.render as ReactElement<any> | undefined)
    .filter((r): r is ReactElement<any> => r?.props?.className === 'tlo-mark');

describe('trace lane overlay', () => {
  const rows = [sessionRow('session-a', 'refund api'), sessionRow('session-b', 'refund list')];

  it("marks each gate failure on its session's lane at its moment, in its row", () => {
    const events = traceEvents([
      gate(NOW - 30 * MIN, 'session-b', 1) as never,
      gate(NOW - 15 * MIN, 'session-a', 0) as never,
    ]);
    const h = mount(LaneOverlay, { rows, first: 4, count: 10, axis, view: VIEW, events, now: NOW });
    const found = marks(h.value);
    expect(found).toHaveLength(1);
    expect(parseFloat(found[0]!.props.style.left)).toBeCloseTo(50);
    expect(found[0]!.props.style.top).toBe(5 * 30 + 11);
    expect(found[0]!.props['aria-label']).toContain('门禁失败：test');
  });

  it("opens a hover card with the event, its session, its moment and its turn's tokens and cost", () => {
    const events = traceEvents([gate(NOW - 15 * MIN - 7_000, 'session-a', 1) as never]);
    const h = mount(LaneOverlay, { rows, first: 0, count: 2, axis, view: VIEW, events, now: NOW });
    const card = named(h.value, 'EventCard');
    const shown = shownText(card);
    expect(shown).toContain('门禁失败：test');
    expect(shown).toContain('refund api');
    expect(shown).toContain('14:04:53');
    expect(shown).toContain('2k');
    expect(shown).toContain('$0.42');
  });

  it('draws the now line at the end of a window that runs up to now, and none for a past one', () => {
    const now = (view: { from: number; to: number }) =>
      nodes(
        mount(LaneOverlay, { rows, first: 0, count: 2, axis, view, events: [], now: NOW }).value,
      ).filter((n) => n.props.className === 'tlo-now');
    const live = now(VIEW);
    expect(live).toHaveLength(1);
    expect(parseFloat(live[0]!.props.style.left)).toBeCloseTo(100);
    expect(now({ from: FROM - 120 * MIN, to: FROM - 60 * MIN })).toHaveLength(0);
  });

  it('names the seven lane colours in the legend', () => {
    const legend = mount(LaneLegend, {}).value;
    expect(
      nodes(legend)
        .filter((n) => n.props.className === 'tlo-li')
        .map((n) => text(n)),
    ).toEqual([
      zh('trace.laneState.run'),
      zh('trace.laneState.wait'),
      zh('trace.laneState.review'),
      zh('trace.laneState.merge'),
      zh('trace.event.gateFailed'),
      zh('trace.laneState.idle'),
      zh('trace.laneState.queue'),
    ]);
  });
});

describe('trace event table', () => {
  const lanes = [laneView('session-a', 'refund api')];
  const table = (history: unknown[], extra: Partial<Parameters<typeof EventTable>[0]> = {}) =>
    mount(EventTable, {
      rows: traceEvents(history as never),
      error: null,
      onRetry() {},
      titleOf: (id: string) => (id === 'session-a' ? 'refund api' : id),
      to: NOW,
      shown: null,
      onShow() {},
      history: history as never,
      lanes,
      now: NOW,
      ...extra,
    });
  const rowsOf = (tree: unknown) =>
    nodes(tree as ReactElement)
      .map((n) => n.props.render as ReactElement<any> | undefined)
      .filter((r): r is ReactElement<any> => r?.props?.className === 'tlo-er');
  const durations = (tree: unknown) =>
    nodes(nodes(tree as ReactElement).filter((n) => n.type === 'li'))
      .filter((n) => n.props.className === 'tlo-et-d')
      .map((n) => text(n));

  it('heads its columns with time, session, event and duration', () => {
    const h = table([]);
    const head = find(h.value, (n) => n.props.className === 'tlo-er tlo-eh');
    expect(nodes(head.props.children).map((n) => text(n))).toEqual([
      zh('trace.events.time'),
      '',
      zh('trace.events.session'),
      zh('trace.events.event'),
      zh('trace.overlay.duration'),
    ]);
  });

  it("puts each row's duration last: an approval's wait, a gate run's commands, none for a merge", () => {
    const h = table([
      asked(NOW - 50 * MIN, 'session-a', 'r1'),
      resolved(NOW - 44 * MIN, 'session-a', 'r1'),
      gate(NOW - 30 * MIN, 'session-a', 1, [20_000, 1_400]),
      merged(NOW - 20 * MIN, 'session-a'),
      asked(NOW - 6 * MIN, 'session-a', 'r2'),
    ]);
    expect(durations(h.value)).toEqual([
      `等 ${durationText(6 * MIN)}`,
      '',
      '21 秒',
      '',
      durationText(6 * MIN),
    ]);
    expect(nodes(h.value).some((n) => text(n) === '$0.42')).toBe(false);
  });

  it('sets a merged commit apart as code', () => {
    const h = table([merged(NOW - 20 * MIN, 'session-a')]);
    const codes = nodes(h.value).filter((n) => n.type === 'code');
    expect(codes.map((n) => text(n))).toEqual([traceEvents([merged(0, 'x')] as never)[0]!.detail]);
  });

  it("keeps a row's tokens and cost for its hover card", () => {
    const h = table([gate(NOW - 15 * MIN, 'session-a', 1)]);
    const card = named(h.value, 'EventCard');
    const shown = shownText(card);
    expect(shown).toContain('$0.42');
    expect(shown).toContain('2k');
  });

  it('mounts only the rows near its viewport and moves them with the scroll', () => {
    const history = Array.from({ length: 200 }, (_, i) => gate(NOW - i * 1_000, 'session-a', 0));
    const shown: TraceEvent[] = [];
    const h = table(history, { onShow: (event) => shown.push(event) });
    const first = rowsOf(h.value);
    expect(first.length).toBeLessThan(40);
    const scroller = find(h.value, (n) => n.props.className === 'tlo-es');
    scroller.props.onScroll({ currentTarget: { scrollTop: 100 * 32 } });
    h.render();
    const items = nodes(h.value).filter((n) => n.type === 'li');
    expect(items[0]!.props.style.top).toBeGreaterThan(80 * 32);
    expect(items[0]!.props['aria-setsize']).toBe(200);
    rowsOf(h.value)[0]!.props.onClick();
    expect(shown).toHaveLength(1);
  });
});

describe('trace screen overlay mount', () => {
  const projectTrace = (): ProjectTrace => ({
    epoch: null,
    from: new Date(FROM).toISOString(),
    to: new Date(NOW).toISOString(),
    indexing: null,
    stats: zero,
    lanes: [laneView('session-a', 'refund api')],
    buckets: [],
  });
  const timeline = (): ProjectTimeline => ({
    from: new Date(FROM).toISOString(),
    to: new Date(NOW).toISOString(),
    sessions: [
      {
        session_id: 'session-a',
        title: 'refund api',
        runtime: 'claude',
        intervals: [{ state: 'running', from: new Date(FROM).toISOString(), to: null }],
      },
    ],
  });

  it("lays the window's events over the lanes, with the legend under them and the table below", () => {
    mock.trace = projectTrace();
    mock.timeline = timeline();
    mock.events = [gate(NOW - 10 * MIN, 'session-a', 1)];
    useShell.setState({ traceTab: 'timeline' });
    const el = TraceScreen({ projectId: 'project-a', sessions: null }) as ReactElement<any>;
    const h = mount(el.type as (props: unknown) => ReactElement, el.props);
    const lanesEl = named(h.value, 'Lanes');
    const lanes = mount(lanesEl.type as (props: unknown) => ReactElement, lanesEl.props).value;
    const overlay = named(lanes, 'LaneOverlay');
    expect(overlay.props.events.map((e: TraceEvent) => e.what)).toEqual(['gate_failed']);
    expect(() => named(lanes, 'LaneLegend')).not.toThrow();
    expect(named(h.value, 'EventTable').props.history).toBe(mock.events);
  });
});
