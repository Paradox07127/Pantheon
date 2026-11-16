import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardModel, BoardSegment, SessionTrace } from '@pantheon/protocol';
import { find, named, nodes, text, mount, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';

const mock = vi.hoisted(() => ({
  view: null as unknown,
  viewLoading: false,
  spans: new Map() as ReadonlyMap<string, unknown[]>,
  openSession: (_id: string) => {},
}));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('@/data/board', () => ({
  useBoard: (selector: any) =>
    selector({ board: null, trace_revision: 0, resync: 0, status: { state: 'live' } }),
}));
vi.mock('@/data/board-view', () => ({
  useBoardView: () => ({ data: mock.view, loading: mock.viewLoading, error: null, reload() {} }),
}));
vi.mock('@/data/trace', () => ({
  useRunSpans: () => mock.spans,
  useProjectTrace: () => ({ data: null, loading: false, stale: false, error: null, reload() {} }),
  useTraceTick: () => 0,
}));
vi.mock('@/data/commands', () => ({ runCommand: async () => ({ ok: true, value: null }) }));
vi.mock('@/store', () => {
  const state = { openSession: (id: string) => mock.openSession(id) };
  return { useShell: Object.assign((selector: any) => selector(state), { getState: () => state }) };
});
import { callRows } from '@/screens/runtime/call-rows';
import { RunsView } from '@/screens/runtime/RuntimeScreen';

type Span = SessionTrace['spans'][number];
type Task = BoardModel['tasks'][number];

const NOW = Date.UTC(2026, 10, 7, 12);

const span = (id: string, extra: Partial<Span> = {}): Span => ({
  id,
  parent: 'turn-1',
  turn: 'turn-1',
  kind: 'tool',
  name: 'Write',
  start: NOW - 50_000,
  end: NOW - 40_000,
  status: 'ok',
  timing: 'daemon',
  ...extra,
});

const segment = (id: string): BoardSegment => ({
  id,
  session_id: id,
  title: `title of ${id}`,
  runtime: 'claude',
  model: null,
  status: 'running',
  started_at: NOW - 60_000,
  ended_at: null,
  tokens: 0,
});

const task = (id: string, session: string): Task => ({
  id,
  title: `task ${id}`,
  goal: '',
  scope: [],
  lane_id: null,
  milestone_id: null,
  status: 'running',
  blockers: [],
  segments: [segment(session)],
  additions: null,
  deletions: null,
  checks: 'none',
  started_at: NOW - 60_000,
  ended_at: null,
  last_progress_at: null,
  blocked_since: null,
  turn_running: true,
  owner_session_id: 'lead-1',
});

const board = (tasks: Task[]) =>
  ({
    now: NOW,
    since: NOW - 86_400_000,
    leads: [{ session_id: 'lead-1', title: 'lead', state: 'running', inbox: 0, updated_at: 0 }],
    tasks,
  }) as unknown as BoardModel;

const TRACED = new Map([
  ['lead-1', [span('lead-board', { name: 'update_board' })]],
  ['worker-1', [span('worker-write'), span('worker-commit', { name: 'commit' })]],
  ['worker-2', [span('other-write')]],
]);

const runs = () => mount(() => RunsView({ projectId: 'project-a', sessions: [] }));
beforeEach(() => {
  mock.view = board([task('lead-1:build', 'worker-1'), task('lead-1:check', 'worker-2')]);
  mock.viewLoading = false;
  mock.spans = TRACED;
  mock.openSession = vi.fn();
});
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const stats = (tree: unknown) =>
  find(tree as any, (n) => n.props['aria-label'] === zh('runs.page.figures'));
const traceStatus = (tree: unknown) =>
  find(
    tree as any,
    (n) =>
      typeof n.type === 'function' && n.type.name === 'ReadStatus' && n.props.label === 'Trace',
  );
const table = (tree: unknown) => named(tree as any, 'CallTable');
const named_ = (tree: unknown, name: string) =>
  nodes(tree as any).some((n) => typeof n.type === 'function' && n.type.name === name);

describe('runtime stats', () => {
  it('ages completed work out while the board snapshot stays unchanged', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const completed = {
      ...task('lead-1:done', 'worker-1'),
      status: 'done' as const,
      turn_running: false,
      last_progress_at: NOW - 60 * 60_000,
      segments: [{ ...segment('worker-1'), status: 'done' as const, ended_at: NOW }],
    };
    mock.view = {
      ...board([completed]),
      leads: [
        {
          session_id: 'lead-1',
          title: 'recent lead',
          state: 'idle',
          inbox: 0,
          updated_at: NOW - 60 * 60_000,
        },
      ],
    };
    const h = runs();
    expect(
      text(find(h.value, (n) => n.props['aria-label'] === zh('runs.page.justEnded'))),
    ).toContain('title of worker-1');
    expect(named(h.value, 'LeadStates').props.leads).toHaveLength(1);
    vi.advanceTimersByTime(15_000);
    h.render();
    expect(named(h.value, 'EmptyState').props.title).toBe(zh('runs.page.nowEmpty'));
    expect(named_(h.value, 'CallTable')).toBe(false);
    expect(named_(h.value, 'LeadStates')).toBe(false);
  });

  it('shows the stats as loading, not as zero, until every trace is read', () => {
    let spans: ReadonlyMap<string, unknown[]> = new Map();
    mock.spans = spans;
    const h = mount(() => {
      mock.spans = spans;
      return RunsView({ projectId: 'project-1', sessions: [] });
    });
    expect(stats(h.value).props['aria-busy']).toBe(true);
    expect(text(stats(h.value))).not.toMatch(/\d/);
    spans = new Map([...TRACED].slice(0, 1));
    h.render();
    expect(stats(h.value).props['aria-busy']).toBe(true);
    expect(text(stats(h.value))).not.toMatch(/\d/);
    spans = TRACED;
    h.render();
    expect(stats(h.value).props['aria-busy']).toBeUndefined();
    expect(text(stats(h.value))).toContain('调用4');
  });

  it('ends loading after trace failure, withholds incomplete totals and offers retry', () => {
    const reload = vi.fn();
    mock.spans = Object.assign(new Map(), {
      failed: new Set(['worker-1']),
      loading: false,
      stale: false,
      readAt: new Map(),
      reload,
    });
    const h = runs();
    expect(stats(h.value).props['aria-busy']).toBeUndefined();
    expect(text(stats(h.value))).toContain('调用—');
    const status = traceStatus(h.value);
    expect(status.props.error).toContain('合计不完整');
    status.props.reload();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('keeps cached totals visibly stale when the latest trace read fails', () => {
    mock.spans = Object.assign(new Map(TRACED), {
      failed: new Set(['worker-1']),
      stale: true,
      loading: false,
      readAt: new Map([['worker-1', NOW - 5000]]),
    });
    const h = runs();
    expect(text(stats(h.value))).toContain('调用4');
    const status = traceStatus(h.value);
    expect(status.props).toMatchObject({ stale: true, readAt: NOW - 5000 });
  });

  it('writes the tokens with a plus and counts the turns that reported none', () => {
    const turn = (id: string, extra: Partial<Span> = {}) =>
      span(id, { kind: 'turn', parent: null, turn: id, name: id, ...extra });
    const tokensOf = (spans: ReadonlyMap<string, unknown[]>) => {
      mock.spans = spans;
      const h = runs();
      const cell = find(
        stats(h.value),
        (n) => String(n.props.className).startsWith('cell') && text(n).startsWith('tokens'),
      );
      const { children, 'aria-label': label } = find(cell, (n) => n.props.className === 'kpi')
        .props as { children: string; 'aria-label'?: string };
      return label === undefined ? { children } : { children, 'aria-label': label };
    };
    const reported = new Map([
      ...TRACED,
      ['worker-1', [turn('worker-turn', { tokens: { input: 40, output: 5 } })]],
    ]);
    expect(tokensOf(reported)).toEqual({ children: '45' });
    const silent = new Map([
      ...reported,
      [
        'worker-2',
        [
          turn('silent-turn'),
          turn('silent-again'),
          turn('still-running', { end: null, status: 'running' }),
        ],
      ],
    ]);
    expect(tokensOf(silent)).toEqual({ children: '45+', 'aria-label': '2 个回合没上报用量' });
  });
});

describe('runtime selection', () => {
  const selected = (tree: unknown) => table(tree).props.selected;
  const pick = (tree: unknown, id: string) => {
    const { props } = table(tree);
    const row = callRows({ ...props, toggled: new Set() }).rows.find(
      (r) => r.type === 'call' && r.call.id === id,
    );
    props.onSelect(row);
  };

  it('drops a selection made in another project', () => {
    let projectId = 'project-a';
    const h = mount(() => RunsView({ projectId, sessions: [] }));
    pick(h.value, 'worker-write');
    h.render();
    expect(selected(h.value)).toBe('c:worker-1/worker-write');
    projectId = 'project-b';
    h.render();
    expect(selected(h.value)).toBeNull();
  });

  it('drops a selection whose row is gone', () => {
    const h = runs();
    pick(h.value, 'other-write');
    h.render();
    expect(selected(h.value)).toBe('c:worker-2/other-write');
    mock.view = board([task('lead-1:build', 'worker-1')]);
    h.render();
    expect(selected(h.value)).toBeNull();
  });
});

describe('runs controls', () => {
  it('shows the call table with no progress switch and no top bar of its own', () => {
    const h = runs();
    expect(nodes(h.value).some((n) => n.props['aria-label'] === '视图')).toBe(false);
    expect(text(h.value)).not.toContain('进度');
    expect(
      nodes(h.value).some(
        (n) => typeof n.type === 'function' && ['AgentLanes', 'TopBar'].includes(n.type.name),
      ),
    ).toBe(false);
    expect(table(h.value)).toBeTruthy();
    expect(named(h.value, 'LeadStates')).toBeTruthy();
    expect(
      find(h.value, (n) => n.props['aria-label'] === zh('runs.page.followLabel')).props.checked,
    ).toBe(true);
  });
});

describe('runtime screen entry', () => {
  it('keeps the last board view while it is read again and shows bars before the first', () => {
    mock.viewLoading = true;
    const skeleton = (tree: unknown) =>
      nodes(tree as any).some((n) => typeof n.type === 'function' && n.type.name === 'Skeleton');
    const kept = runs();
    expect(table(kept.value).props.forest.trees).toHaveLength(1);
    expect(skeleton(kept.value)).toBe(false);
    mock.view = null;
    const first = runs();
    expect(skeleton(first.value)).toBe(true);
    mock.viewLoading = false;
    first.render();
    expect(skeleton(first.value)).toBe(false);
  });
});
