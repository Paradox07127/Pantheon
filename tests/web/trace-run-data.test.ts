import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { RuntimeDiagnostics, RuntimeFinding } from '@pantheon/domain';
import type { BoardModel, ProjectTrace, SessionTrace } from '@pantheon/protocol';
import { find, named, nodes, text, mount, unmountAll } from './web-hook-host.js';

const mock = vi.hoisted(() => ({
  view: null as unknown,
  spans: new Map() as ReadonlyMap<string, unknown[]>,
  trace: null as unknown,
}));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign(
    (selector: any) =>
      selector({ board: null, trace_revision: 0, resync: 0, status: { state: 'live' } }),
    { getState: () => ({ refresh() {} }) },
  ),
}));
vi.mock('@/data/board-view', () => ({
  useBoardView: () => ({ data: mock.view, loading: false, error: null, reload() {} }),
}));
vi.mock('@/data/trace', () => ({
  useRunSpans: (_projectId: string | null, ids: readonly string[]) =>
    Object.assign(new Map([...mock.spans].filter(([id]) => ids.includes(id))), {
      failed: new Set(),
      loading: false,
      stale: false,
      readAt: new Map(),
      errors: new Map(),
      reload() {},
    }),
  useProjectTrace: (projectId: string | null) => ({
    data: projectId ? mock.trace : null,
    loading: false,
    stale: false,
    error: null,
    reload() {},
  }),
  useTraceTick: () => 0,
}));
vi.mock('@/data/workbench-sessions', async (actual) => {
  const real = await actual<typeof import('@/data/workbench-sessions')>();
  return {
    ...real,
    useQuery: (...args: Parameters<typeof real.useQuery>) =>
      args[0] === 'project.trace.stats'
        ? { data: null, loading: false, error: null, reload() {} }
        : real.useQuery(...args),
  };
});
vi.mock('@/data/commands', () => ({ runCommand: async () => ({ ok: true, value: null }) }));
vi.mock('@/data/logs', async (actual) => ({
  ...(await actual<object>()),
  useEventHistory: () => ({ events: null, error: null, reload: () => undefined }),
}));
vi.mock('@/store', () => {
  const state = { openSession: () => undefined };
  return {
    useShell: Object.assign((selector: any) => selector(state), {
      getState: () => state,
      setState: () => undefined,
    }),
  };
});
import { CallDetail } from '@/screens/runtime/CallDetail';
import { boardFacts, callRows, type CallRow } from '@/screens/runtime/call-rows';
import { runForest, type RunCall } from '@/screens/runtime/run-tree';
import { liveFigures, rangeFigures } from '@/screens/runtime/run-stats';
import { RunsView, SLOW_MS } from '@/screens/runtime/RuntimeScreen';
import { FindingDetail } from '@/screens/trace/FindingDetail';
import { RuntimePanel } from '@/screens/trace/RuntimeDiagnostics';
import { zh } from './i18n-setup.js';

type Span = SessionTrace['spans'][number];
type Lead = NonNullable<BoardModel['leads']>[number];

const NOW = Date.UTC(2026, 10, 13, 12);

const span = (id: string, extra: Partial<Span> = {}): Span => ({
  id,
  parent: 'turn-a',
  turn: 'turn-a',
  kind: 'tool',
  name: 'Read',
  start: NOW - 30_000,
  end: NOW - 29_000,
  status: 'ok',
  timing: 'daemon',
  ...extra,
});

const turn = (id: string, extra: Partial<Span> = {}) =>
  span(id, { parent: null, turn: id, kind: 'turn', name: id, start: NOW - 60_000, ...extra });

const lead = (extra: Partial<Lead> = {}): Lead => ({
  session_id: 'lead-1',
  title: 'lead',
  state: 'running',
  inbox: 0,
  updated_at: NOW,
  ...extra,
});

const board = (leadExtra: Partial<Lead> = {}) =>
  ({
    now: NOW,
    since: NOW - 86_400_000,
    leads: [lead(leadExtra)],
    tasks: [],
  }) as unknown as BoardModel;

// The first turn reports its own usage, which its model call repeats; the second only its model call's.
const CACHED: Span[] = [
  turn('turn-a', { end: NOW - 40_000, tokens: { input: 100, output: 10, cache_read: 300 } }),
  span('think-a', {
    kind: 'llm',
    name: 'claude-opus',
    tokens: { input: 100, output: 10, cache_read: 300 },
  }),
  turn('turn-b', { start: NOW - 20_000, status: 'running' }),
  span('think-b', {
    kind: 'llm',
    name: 'claude-opus',
    turn: 'turn-b',
    parent: 'turn-b',
    start: NOW - 19_000,
    end: NOW - 18_000,
    tokens: { input: 200, output: 0, cache_read: 400 },
  }),
];

const UNCACHED: Span[] = [
  turn('turn-a', { status: 'running', tokens: { input: 100, output: 10 } }),
  span('think-a', { kind: 'llm', name: 'claude-opus', tokens: { input: 100, output: 10 } }),
];

const stats = (extra: Partial<ProjectTrace['stats']> = {}): ProjectTrace['stats'] => ({
  sessions: 1,
  turns: 1,
  llm: 1,
  tool: 2,
  error: 0,
  tokens: { input: 1000, output: 200 },
  active_ms: 0,
  commits: 0,
  ...extra,
});

const trace = (extra: Partial<ProjectTrace['stats']> = {}): ProjectTrace => ({
  epoch: null,
  from: new Date(NOW - 3_600_000).toISOString(),
  to: new Date(NOW).toISOString(),
  indexing: null,
  stats: stats(extra),
  lanes: [],
  buckets: [],
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mock.view = board();
  mock.spans = new Map([['lead-1', CACHED]]);
  mock.trace = trace();
});
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
});

const figures = (tree: unknown) =>
  find(tree as any, (n) => n.props['aria-label'] === zh('runs.page.figures'));
const table = (tree: unknown) => named(tree as any, 'CallTable');
const detail = (tree: unknown) =>
  nodes(tree as any).find((n) => typeof n.type === 'function' && n.type.name === 'CallDetail');

describe('cache hit figure', () => {
  const forestOf = (spans: Span[]) => runForest(board(), [], new Map([['lead-1', spans]]));

  it('shares the cache reads of the shown sessions by their turns, counting a turn once', () => {
    const forest = forestOf(CACHED);
    expect(liveFigures(forest, new Map([['lead-1', CACHED]]), NOW).cacheHit).toBe(0.7);
    const strip = text(figures(mount(() => RunsView({ projectId: 'p', sessions: [] })).value));
    expect(strip).toContain('缓存命中70%');
  });

  it('stays unknown when no call reports cache reads or nothing was read', () => {
    const forest = forestOf(UNCACHED);
    expect(liveFigures(forest, new Map([['lead-1', UNCACHED]]), NOW).cacheHit).toBeNull();
    const empty = [turn('turn-a', { tokens: { input: 0, output: 0, cache_read: 0 } })];
    expect(liveFigures(forestOf(empty), new Map([['lead-1', empty]]), NOW).cacheHit).toBeNull();
    mock.spans = new Map([['lead-1', UNCACHED]]);
    const strip = text(figures(mount(() => RunsView({ projectId: 'p', sessions: [] })).value));
    expect(strip).toContain('缓存命中—');
  });

  it('takes the range share from the project trace totals', () => {
    expect(
      rangeFigures(trace({ tokens: { input: 250, output: 10, cache_read: 750 } })).cacheHit,
    ).toBe(0.75);
    expect(rangeFigures(trace()).cacheHit).toBeNull();
    expect(
      rangeFigures(trace({ tokens: { input: 0, output: 0, cache_read: 0 } })).cacheHit,
    ).toBeNull();
  });
});

describe('history median and p95', () => {
  const history = () =>
    mount(() =>
      RunsView({ projectId: 'p', sessions: [], view: 'history', range: { from: 0, to: null } }),
    );

  it('shows the tool call median and p95 of the range', () => {
    mock.trace = trace({
      tokens: { input: 250, output: 10, cache_read: 750 },
      tool_duration_p50_ms: 800,
      tool_duration_p95_ms: 21_400,
    });
    expect(rangeFigures(mock.trace as ProjectTrace)).toMatchObject({ median: 800, p95: 21_400 });
    const strip = text(figures(history().value));
    expect(strip).toContain('中位时长0.8 秒');
    expect(strip).toContain('p95 21.4 秒');
    expect(strip).toContain('缓存命中75%');
  });

  it('keeps the dashes when the range has no timed calls', () => {
    const strip = text(figures(history().value));
    expect(strip).toContain('中位时长—');
    expect(strip).toContain('缓存命中—');
  });
});

describe('slow threshold', () => {
  it.each([
    ['counts a call as slow from the threshold of the diagnostics', 8_000, 8_000],
    ['keeps the page threshold without diagnostics', undefined, SLOW_MS],
  ])('%s', (_, slowMs, threshold) => {
    const h = mount(() => RunsView({ projectId: 'p', sessions: [], slowMs }));
    expect(table(h.value).props.filter.slowMs).toBe(threshold);
  });
});

describe('call row target and tokens', () => {
  const rowOf = (extra: Partial<Span>) => {
    const spans = new Map([['lead-1', [turn('turn-a', { status: 'running' }), span('c', extra)]]]);
    const b = board();
    const { rows } = callRows({
      forest: runForest(b, [], spans),
      facts: boardFacts(b),
      spans,
      view: 'now',
      now: NOW,
      toggled: new Set(),
    });
    return rows.find((row): row is Extract<CallRow, { type: 'call' }> => row.type === 'call')!;
  };

  it('names the call by its input summary and shows the tokens it reported', () => {
    const row = rowOf({
      name: 'Bash',
      input_summary: 'pnpm test webhook',
      files: ['src/a.ts', 'src/b.ts'],
      tokens: { input: 0, output: 0 },
    });
    expect([row.target, row.more, row.tokens]).toEqual(['pnpm test webhook', 0, 0]);
  });

  it('keeps the file or tool name and no tokens without them', () => {
    expect([rowOf({ name: 'Bash' }).target, rowOf({ name: 'Bash' }).tokens]).toEqual([
      'Bash',
      null,
    ]);
    const files = rowOf({ files: ['src/a.ts', 'src/b.ts'] });
    expect([files.target, files.more]).toEqual(['src/a.ts', 1]);
  });
});

describe('call detail facts', () => {
  const call: RunCall = {
    id: 'c',
    kind: 'tool',
    name: 'Bash',
    status: 'error',
    start: NOW - 21_400,
    end: NOW,
    tokens: 3300,
  };
  const shown = (extra: Partial<Parameters<typeof CallDetail>[0]> = {}) =>
    CallDetail({
      call,
      session: 'lead-1',
      title: 'lead',
      turn: 1,
      projectId: 'p',
      events: false,
      now: NOW,
      onClose: () => undefined,
      ...extra,
    });
  const cells = (tree: unknown) =>
    nodes(tree as any)
      .filter((n) => n.props.className === 'cell')
      .map((cell) => text(cell));

  it('shows the retries, the exit code in the failure colour and the cost of the turn', () => {
    const tree = shown({ span: span('c', { retry_count: 2, exit_code: 1 }), turnCost: 0.42 });
    expect(cells(tree)).toEqual(expect.arrayContaining(['重试2 次', '退出码1', '本轮成本$0.42']));
    const code = (detail: unknown) =>
      [
        find(
          detail as any,
          (n) => n.props.className === 'cell' && text(n).startsWith(zh('runs.detail.exitCode')),
        ).props.children,
      ]
        .flat()
        .at(-1).props.className;
    expect(code(tree)).toBe('cd-v cd-bad');
    expect(code(shown({ span: span('c', { exit_code: 0 }) }))).toBe('cd-v');
  });

  it('holds the retry place and adds nothing without them', () => {
    const tree = shown({ span: span('c') });
    expect(cells(tree)).toHaveLength(6);
    expect(nodes(tree).some((n) => n.props.className === 'cell' && n.props['aria-hidden'])).toBe(
      true,
    );
    expect(text(tree)).not.toContain(zh('runs.detail.exitCode'));
    expect(text(tree)).not.toContain(zh('runs.detail.turnCost'));
  });

  it('gets the span and its turn cost from the runs page', () => {
    mock.spans = new Map([
      [
        'lead-1',
        [
          turn('turn-a', { status: 'running', cost_usd: 0.42 }),
          span('c', {
            name: 'Bash',
            retry_count: 1,
            start: NOW - 1_000,
            end: null,
            status: 'running',
          }),
        ],
      ],
    ]);
    const shownDetail = detail(mount(() => RunsView({ projectId: 'p', sessions: [] })).value)!;
    expect(shownDetail.props.span).toMatchObject({ id: 'c', retry_count: 1 });
    expect(shownDetail.props.turnCost).toBe(0.42);
  });
});

describe('lead context', () => {
  const leadRow = (extra: Partial<Lead>) => {
    const b = board(extra);
    const spans = new Map([['lead-1', CACHED]]);
    const { rows } = callRows({
      forest: runForest(b, [], spans),
      facts: boardFacts(b),
      spans,
      view: 'now',
      now: NOW,
      toggled: new Set(),
    });
    return rows.find((row) => row.type === 'session')!;
  };

  it('draws the context ring of a lead that reports it', () => {
    expect(leadRow({ context: { used_tokens: 34_000, window_tokens: 100_000 } })).toMatchObject({
      lead: true,
      context: 34,
    });
  });

  it('leaves the ring out without it', () => {
    expect(leadRow({}).context).toBeNull();
  });
});

describe('finding threshold and evidence', () => {
  const at = (hours: number, minutes: number, seconds = 0) =>
    new Date(2026, 10, 13, hours, minutes, seconds).getTime();
  const slow: RuntimeFinding = {
    id: 'f-slow',
    kind: 'slow_tool',
    layer: 'tool',
    source: 'native',
    at: at(10, 30, 15),
    lane_key: 'lane-a',
    duration_ms: 48_200,
    evidence_ids: ['call-1', 'event-1'],
  };
  const withEvidence: RuntimeFinding = {
    ...slow,
    evidence: [
      { source: 'native', at: at(10, 29, 27), id: 'call-1', duration_ms: 48_200 },
      { source: 'runtime_reported', at: at(10, 30, 15), id: 'call-1', duration_ms: 47_900 },
      { source: 'daemon', at: at(10, 30, 15), id: 'event-1' },
    ],
  };
  const shown = (finding: RuntimeFinding, slowToolMs?: number) => {
    const onShowInTimeline = vi.fn();
    const tree = FindingDetail({
      finding,
      title: 'lead',
      onClose: () => undefined,
      onShowInTimeline,
      slowToolMs,
    });
    return { tree, onShowInTimeline };
  };
  const said = (tree: unknown) => text(find(tree as any, (n) => n.type === 'p'));

  it('says from how long on a tool counts as slow', () => {
    expect(said(shown(slow, 5_000).tree)).toBe('一次工具调用跑了 48 秒。超过 5 秒就算慢。');
  });

  it('keeps the sentence without the threshold', () => {
    expect(said(shown(slow).tree)).toBe('一次工具调用跑了 48 秒。');
  });

  it('lists the evidence with source, time and duration, each opening the timeline', () => {
    const { tree, onShowInTimeline } = shown(withEvidence, 5_000);
    const list = find(tree, (n) => n.props['aria-label'] === zh('trace.diagnose.evidence.label'));
    expect(text(find(tree, (n) => n.props.className === 'fd-evh'))).toBe('证据3');
    const rows = nodes(list).filter((n) => n.type === 'button');
    expect(rows.map((row) => text(row))).toEqual([
      '原生 span10:29:27call-148 秒',
      '上报时长10:30:15call-147 秒',
      '事件差10:30:15event-1',
    ]);
    rows[1]!.props.onClick();
    expect(onShowInTimeline).toHaveBeenCalledOnce();
  });

  it('shows no evidence list without evidence', () => {
    expect(
      nodes(shown(slow, 5_000).tree).some(
        (n) => n.props['aria-label'] === zh('trace.diagnose.evidence.label'),
      ),
    ).toBe(false);
  });

  it('gets the threshold from the diagnostics', () => {
    const diagnostics: RuntimeDiagnostics = {
      from: at(9, 0),
      to: at(10, 39),
      slow_tool_ms: 5_000,
      events_read: 1,
      tools_timed: 1,
      tools_untimed: 0,
      partial: false,
      native: 'included',
      findings: [slow],
    };
    const h = mount(
      () =>
        RuntimePanel({
          overview: null,
          diagnostics,
          leads: [],
          lead: undefined,
          reviews: [],
          stale: false,
          titleOf: () => 'lead',
          onEvidence: () => undefined,
        }) as ReactElement<any>,
    );
    const table = named(h.value, 'FindingTable');
    table.props.onPick(slow);
    h.render();
    expect(named(h.value, 'FindingDetail').props.slowToolMs).toBe(5_000);
  });
});
