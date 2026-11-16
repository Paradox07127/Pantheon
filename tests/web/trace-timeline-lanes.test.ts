import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type {
  ProjectTimeline,
  ProjectTrace,
  TraceStats,
  WorkbenchSession,
} from '@pantheon/protocol';
import { find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  trace: null as unknown,
  timeline: null as unknown,
  time: null as unknown,
  events: null as unknown[] | null,
  sessions: null as unknown[] | null,
}));
vi.mock('@/data/commands', () => ({ runCommand: vi.fn() }));
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
  useProjectTrace: (projectId: string | null) => ({
    data: projectId ? mock.trace : null,
    loading: false,
    error: null,
    reload() {},
  }),
  useProjectTimeline: (projectId: string | null) => ({
    data: projectId ? mock.timeline : null,
    loading: mock.timeline === null,
    error: null,
    reload() {},
  }),
  useProjectHeatmap: () => ({ data: null, loading: false, error: null, reload() {} }),
  useSessionTrace: () => ({ data: null, loading: false, error: null, reload() {} }),
  useTraceTime: (projectId: string | null) => ({
    data: projectId ? mock.time : null,
    loading: false,
    error: null,
    reload() {},
  }),
  useTurnSteps: () => ({ data: null, loading: false, error: null, reload() {} }),
}));
import { TraceScreen } from '@/screens/trace/TraceScreen';
import { durationText, whenText } from '@/screens/board/panels-model';
import { useShell } from '@/store';

const MIN = 60_000;
const NOW = new Date(2026, 2, 8, 14, 20).getTime();
const FROM = NOW - 60 * MIN;
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * MIN).toISOString();

const zero: TraceStats = {
  sessions: 2,
  turns: 2,
  llm: 0,
  tool: 0,
  error: 0,
  tokens: { input: 0, output: 0 },
  active_ms: 0,
  commits: 0,
};

const lane = (key: string, title: string, turnStart: number, turnEnd: number | null) => ({
  lane: {
    key,
    source: 'pantheon' as const,
    runtime: 'claude' as const,
    session_id: key,
    native_id: `native-${key}`,
    title,
    cwd: '/repo',
  },
  stats: { ...zero, sessions: 1, turns: 1 },
  turns: [
    {
      id: `turn-${key}`,
      start: turnStart,
      end: turnEnd,
      status: turnEnd === null ? ('running' as const) : ('ok' as const),
      segments: [],
    },
  ],
});

const projectTrace = (): ProjectTrace => ({
  epoch: null,
  from: new Date(FROM).toISOString(),
  to: new Date(NOW).toISOString(),
  indexing: null,
  stats: zero,
  lanes: [
    lane('session-a', 'refund api', NOW - 50 * MIN, null),
    lane('session-b', 'refund list', NOW - 40 * MIN, NOW - 35 * MIN),
  ],
  buckets: [],
});

const projectTimeline = (): ProjectTimeline => ({
  from: new Date(FROM).toISOString(),
  to: new Date(NOW).toISOString(),
  sessions: [
    {
      session_id: 'session-a',
      title: 'refund api',
      runtime: 'claude',
      intervals: [
        { state: 'queued', from: at(90), to: at(50) },
        { state: 'running', from: at(50), to: at(30) },
        { state: 'waiting', from: at(30), to: at(20) },
        { state: 'running', from: at(20), to: at(10) },
        { state: 'waiting', from: at(10), to: null },
      ],
    },
    {
      session_id: 'session-b',
      title: 'refund list',
      runtime: 'claude',
      intervals: [
        { state: 'running', from: at(40), to: at(35) },
        { state: 'ready', from: at(35), to: at(15) },
        { state: 'merging', from: at(15), to: at(14) },
        { state: 'merged', from: at(14), to: at(14) },
      ],
    },
    {
      session_id: 'session-old',
      title: 'old work',
      runtime: 'codex',
      intervals: [{ state: 'waiting', from: at(120), to: at(70) }],
    },
  ],
});

const session = (id: string, state: WorkbenchSession['state']) =>
  ({ id, title: id, state }) as WorkbenchSession;

let sequence = 0;
const gateFailed = (when: number) => ({
  event_id: `event-${++sequence}`,
  kind: 'session.gate_checked',
  aggregate_id: 'session-a',
  aggregate_revision: 1,
  project_id: 'project-a',
  sequence,
  created_at: when,
  causation_id: '',
  payload: { results: [{ name: 'test', exit_code: 1 }] },
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mock.trace = projectTrace();
  mock.timeline = projectTimeline();
  mock.time = { by_lane: { 'session-a': { wall_ms: 42 * MIN } } };
  mock.events = [];
  mock.sessions = [session('session-a', 'waiting'), session('session-b', 'merged')];
  useShell.setState({ traceTab: 'timeline' });
  vi.stubGlobal('document', { activeElement: null, body: {} });
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
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

const rowComponent = (n: ReactElement<any>) => {
  const type = (typeof n.type === 'function' ? n.type : (n.type as { type?: unknown })?.type) as
    ((props: unknown) => ReactElement) | undefined;
  return typeof type === 'function' && type.name === 'Row' ? type : undefined;
};
const sessionRow = (key: string) => {
  const lanes = child(screen().value, 'Lanes').value;
  const el = find(lanes, (n) => !!rowComponent(n) && n.props.row.key === key);
  return rowComponent(el)!(el.props);
};
const track = (row: ReactElement) => {
  const el = named(row, 'Track');
  return (el.type as (props: unknown) => ReactElement)(el.props);
};

const labelOf = (tree: unknown, head: string) =>
  nodes(tree as ReactElement)
    .map((n) => n.props['aria-label'])
    .find((label) => typeof label === 'string' && label.startsWith(`${head} `));

describe('trace timeline number row', () => {
  it('counts the time sessions waited on the user from their state intervals in the window', () => {
    expect(labelOf(screen().value, '等你的时间')).toBe(`等你的时间 ${durationText(20 * MIN)}`);
  });
});

describe('trace timeline lanes by session state', () => {
  it("draws a Pantheon session's lane as its state intervals, cut to the window", () => {
    const segs = nodes(track(sessionRow('session-a'))).filter(
      (n) => n.props.className === 'trc-seg',
    );
    expect(segs.map((n) => n.props['data-state'])).toEqual(['queue', 'run', 'wait', 'run', 'wait']);
    expect(parseFloat(segs[0]!.props.style.left)).toBeCloseTo(0);
    expect(parseFloat(segs[0]!.props.style.width)).toBeCloseTo(100 / 6);
    expect(parseFloat(segs[4]!.props.style.width)).toBeCloseTo(100 / 6);
  });

  it('draws review and merging apart and leaves out a state that takes no time', () => {
    const segs = nodes(track(sessionRow('session-b'))).filter(
      (n) => n.props.className === 'trc-seg',
    );
    expect(segs.map((n) => n.props['data-state'])).toEqual(['run', 'review', 'merge']);
  });

  it("names each state's time in the row's label, not by colour alone", () => {
    const head = find(sessionRow('session-a'), (n) => n.props.className === 'trc-head');
    expect(head.props['aria-label']).toContain(`在干活 ${durationText(30 * MIN)}`);
    expect(head.props['aria-label']).toContain(`等你 ${durationText(20 * MIN)}`);
    expect(head.props['aria-label']).toContain(`排队 ${durationText(10 * MIN)}`);
  });

  it("starts the row with the session's state glyph and greys an ended session's title", () => {
    const waiting = sessionRow('session-a');
    expect(named(waiting, 'SessionStateIcon').props.session.state).toBe('waiting');
    expect(find(waiting, (n) => n.props.className === 'trc-title').props['data-ended']).toBe(
      undefined,
    );
    const merged = sessionRow('session-b');
    expect(find(merged, (n) => n.props.className === 'trc-title').props['data-ended']).toBe(true);
  });

  it("puts the lane's time from the time breakdown beside its name", () => {
    const row = sessionRow('session-a');
    expect(text(find(row, (n) => n.props.className === 'trc-dur'))).toBe(durationText(42 * MIN));
    expect(nodes(sessionRow('session-b')).some((n) => n.props.className === 'trc-dur')).toBe(false);
  });

  it('heads the lanes with six moments from the start of the view to its end', () => {
    const lanes = child(screen().value, 'Lanes').value;
    const ticks = nodes(lanes).filter((n) => n.props.className === 'trc-tick');
    expect(ticks.map((n) => text(n))).toEqual(
      [60, 48, 36, 24, 12, 0].map((ago) => whenText(NOW - ago * MIN, NOW)),
    );
  });

  it('draws only the skeleton until the session states are read', () => {
    mock.timeline = null;
    const h = screen();
    expect(() => named(h.value, 'Lanes')).toThrow();
    expect(() => named(h.value, 'Skeleton')).not.toThrow();
    expect(labelOf(h.value, '调用')).toBeUndefined();
  });
});

describe('trace timeline bar', () => {
  it("names the lanes' window after the tabs", () => {
    const span = find(screen().value, (n) => n.props.className === 'trb-win');
    expect(text(span.props.children)).toBe('13:20 – 14:20');
  });

  it('draws the event type menu as a small ghost button', () => {
    mock.events = [gateFailed(NOW - 5 * MIN)];
    const h = screen();
    expect(() => find(h.value, (n) => n.props.className === 'btn ghost sm')).not.toThrow();
  });
});
