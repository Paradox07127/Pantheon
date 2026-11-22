import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectTrace, SessionTrace, WorkbenchSession } from '@pantheon/protocol';
import { find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';

const mock = vi.hoisted(() => ({
  sessions: null as WorkbenchSession[] | null,
  snapshot: [] as { id: string; spawned_by?: { session_id: string } }[],
  spans: new Map() as ReadonlyMap<string, unknown[]>,
  spanReads: [] as string[][],
  trace: null as unknown,
  traceReads: [] as { projectId: string | null; window: unknown }[],
  stats: null as unknown,
  statsReads: [] as unknown[],
  commands: [] as { type: string; input: unknown }[],
  // The approval answers wait on this while it is set.
  answered: null as Promise<void> | null,
  needs: [] as unknown[],
  needsError: null as string | null,
  needsReloads: 0,
  // The command result is a success while this is set.
  accepted: false,
  setState: vi.fn(),
}));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('@/data/board', () => ({
  useBoard: (selector: any) =>
    selector({
      board: { sessions: mock.snapshot },
      events: [],
      trace_revision: 0,
      resync: 0,
      status: { state: 'live' },
    }),
}));
vi.mock('@/data/trace', () => ({
  useRunSpans: (_projectId: string | null, ids: readonly string[]) => {
    mock.spanReads.push([...ids]);
    return Object.assign(new Map([...mock.spans].filter(([id]) => ids.includes(id))), {
      failed: new Set(),
      loading: false,
      stale: false,
      readAt: new Map(),
      errors: new Map(),
      reload() {},
    });
  },
  useProjectTrace: (projectId: string | null, window: unknown) => {
    mock.traceReads.push({ projectId, window });
    return {
      data: projectId ? mock.trace : null,
      loading: false,
      stale: false,
      error: null,
      reload() {},
    };
  },
  useTraceTick: () => 0,
}));
vi.mock('@/data/workbench-sessions', async (actual) => {
  const real = await actual<typeof import('@/data/workbench-sessions')>();
  return {
    ...real,
    useQuery: (...args: Parameters<typeof real.useQuery>) => {
      const [method, key, params] = args;
      if (method !== 'project.trace.stats') return real.useQuery(...args);
      mock.statsReads.push(key && params(key));
      return { data: key ? mock.stats : null, loading: false, error: null, reload() {} };
    },
  };
});
vi.mock('@/data/commands', () => ({
  runCommand: async (type: string, input: unknown) => {
    mock.commands.push({ type, input });
    await mock.answered;
    if (mock.accepted) return { ok: true, value: null };
    return {
      ok: false,
      error: { code: 'not_waiting', message: 'The approval is no longer waiting' },
    };
  },
}));
vi.mock('@/data/needs-you', async (actual) => ({
  ...(await actual<object>()),
  useNeedsYou: () => ({
    items: mock.needs,
    loading: false,
    error: mock.needsError,
    reload: () => mock.needsReloads++,
  }),
}));
vi.mock('@/data/logs', async (actual) => ({
  ...(await actual<object>()),
  useEventHistory: () => ({ events: null, error: null, reload: () => undefined }),
}));
vi.mock('@/store', () => {
  const state = { openSession: () => undefined };
  return {
    useShell: Object.assign((selector: any) => selector(state), {
      getState: () => state,
      setState: (patch: unknown) => mock.setState(patch),
    }),
  };
});
import { CallDetail } from '@/screens/runtime/CallDetail';
import { callRows, type CallRow } from '@/screens/runtime/call-rows';
import { HISTORY_BUCKET_MS, historyForest } from '@/data/run-history';
import { runForest, type RunCall } from '@/screens/runtime/run-tree';
import { liveFigures, rangeFigures } from '@/screens/runtime/run-stats';
import { onlySession, splitEnded } from '@/screens/runtime/runtime-model';
import { RunsView } from '@/screens/runtime/RuntimeScreen';

type Span = SessionTrace['spans'][number];
type Lane = ProjectTrace['lanes'][number];

const NOW = Date.UTC(2026, 10, 13, 12);

const span = (id: string, extra: Partial<Span> = {}): Span => ({
  id,
  parent: null,
  turn: 'turn',
  kind: 'tool',
  name: 'Read',
  start: null,
  end: null,
  status: 'ok',
  timing: 'daemon',
  ...extra,
});

const turn = (id: string, extra: Partial<Span> = {}) =>
  span(id, { kind: 'turn', name: id, turn: id, ...extra });

const call = (id: string, turnId: string, extra: Partial<Span> = {}) =>
  span(id, { parent: turnId, turn: turnId, ...extra });

const listed = (id: string, extra: Partial<WorkbenchSession> = {}): WorkbenchSession => ({
  id,
  created_at: new Date(NOW - 120_000).toISOString(),
  title: `title of ${id}`,
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: `workspace-${id}`,
  workspace_kind: 'linked_worktree',
  state: 'running',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: new Date(NOW).toISOString(),
  changes: null,
  merge: null,
  ...extra,
});

const SESSIONS = [
  listed('lead-1', { title: 'lead' }),
  listed('worker-1'),
  listed('worker-done', {
    state: 'merged',
    last_activity_at: new Date(NOW - 60_000).toISOString(),
  }),
];
const SNAPSHOT = [
  { id: 'lead-1' },
  { id: 'worker-1', spawned_by: { session_id: 'lead-1' } },
  { id: 'worker-done', spawned_by: { session_id: 'lead-1' } },
];
const PARENTS = new Map([
  ['worker-1', 'lead-1'],
  ['worker-done', 'lead-1'],
]);

const SPANS = new Map<string, Span[]>([
  [
    'lead-1',
    [
      turn('lead-turn', { start: NOW - 100_000, status: 'running' }),
      call('lead-think', 'lead-turn', {
        kind: 'llm',
        name: 'claude-opus',
        start: NOW - 90_000,
        end: NOW - 89_000,
        tokens: { input: 100, output: 20 },
      }),
    ],
  ],
  [
    'worker-1',
    [
      turn('w-turn', { start: NOW - 60_000, status: 'running' }),
      call('w-read', 'w-turn', { start: NOW - 50_000, end: NOW - 49_000 }),
      call('w-bash', 'w-turn', {
        name: 'Bash',
        start: NOW - 30_000,
        end: NOW - 9_000,
        status: 'error',
      }),
      call('w-edit', 'w-turn', { name: 'Edit', start: NOW - 5_000, status: 'running' }),
    ],
  ],
  [
    'worker-done',
    [
      turn('d-turn', {
        start: NOW - 120_000,
        end: NOW - 60_000,
        tokens: { input: 30, output: 0 },
      }),
      call('d-read', 'd-turn', { start: NOW - 110_000, end: NOW - 109_800 }),
    ],
  ],
]);

const lane = (key: string, turns: Lane['turns'], tokens = 0): Lane => ({
  lane: {
    key,
    source: key.startsWith('native:') ? 'external' : 'pantheon',
    runtime: 'claude',
    ...(!key.startsWith('native:') && { session_id: key }),
    native_id: key,
    title: `title of ${key}`,
    cwd: '/repo',
  },
  stats: {
    sessions: 1,
    turns: turns.length,
    llm: 0,
    tool: 0,
    error: 0,
    tokens: { input: tokens, output: 0 },
    active_ms: 0,
    commits: 0,
  },
  turns,
});

const TRACE: ProjectTrace = {
  epoch: null,
  from: new Date(NOW - 3_600_000).toISOString(),
  to: new Date(NOW).toISOString(),
  indexing: null,
  stats: {
    sessions: 2,
    turns: 3,
    llm: 3,
    tool: 9,
    error: 1,
    tokens: { input: 1000, output: 200 },
    active_ms: 0,
    commits: 0,
  },
  lanes: [
    lane(
      'native:claude:older',
      [
        {
          id: 'o-turn',
          start: NOW - 50 * 60_000,
          end: NOW - 40 * 60_000,
          status: 'ok',
          segments: [],
        },
      ],
      300,
    ),
    lane(
      'worker-done',
      [{ id: 'd-turn', start: NOW - 120_000, end: NOW - 60_000, status: 'ok', segments: [] }],
      30,
    ),
    lane(
      'worker-1',
      [{ id: 'w-turn', start: NOW - 60_000, end: null, status: 'running', segments: [] }],
      500,
    ),
  ],
  buckets: [
    { at: NOW - 1_200_000, llm: 1, tool: 2, error: 0 },
    { at: NOW - 600_000, llm: 2, tool: 7, error: 1 },
  ],
};

const forestOf = () => runForest(SESSIONS, PARENTS, SPANS);

describe('run figures', () => {
  it('counts the calls, failures, finished durations, tokens and the calls of each recent minute', () => {
    expect(liveFigures(forestOf(), SPANS, NOW)).toEqual({
      calls: 5,
      failed: 1,
      median: 1000,
      p95: 21_000,
      tokens: 150,
      unreported: 0,
      cacheHit: null,
      spark: [0, 0, 0, 0, 0, 0, 0, 0, 2, 3],
    });
  });

  it('counts only the sessions of the forest', () => {
    const only = onlySession(forestOf(), 'worker-1');
    expect(liveFigures(only, SPANS, NOW)).toMatchObject({ calls: 3, failed: 1 });
  });

  it('takes the range figures from the project trace and leaves the durations unknown', () => {
    expect(rangeFigures(TRACE, { failed_tool_calls: 2 })).toEqual({
      calls: 12,
      failed: 2,
      median: null,
      p95: null,
      tokens: 1200,
      unreported: 0,
      cacheHit: null,
      spark: [3, 9],
    });
  });

  it('counts the failed tool calls of the trace stats, not failed turns, and none before they are read', () => {
    expect(rangeFigures(TRACE, { failed_tool_calls: 0 }).failed).toBe(0);
    expect(rangeFigures(TRACE, null).failed).toBeNull();
  });
});

describe('run forest parts', () => {
  it('takes the sessions that ended out of the trees, with their last activity', () => {
    const { live, ended } = splitEnded(forestOf(), SESSIONS);
    expect(live.trees.map((n) => n.id)).toEqual(['lead-1']);
    expect(live.trees[0]!.children.map((n) => n.id)).toEqual(['worker-1']);
    expect(ended.map(({ node, at }) => [node.id, at])).toEqual([['worker-done', NOW - 60_000]]);
  });

  it('keeps one session, without the sessions it started, and nothing for an unknown id', () => {
    const forest = forestOf();
    const lead = onlySession(forest, 'lead-1');
    expect([...lead.trees, ...lead.adhoc].map((n) => n.id)).toEqual(['lead-1']);
    expect(lead.adhoc[0]?.children ?? lead.trees[0]!.children).toEqual([]);
    expect(onlySession(forest, null)).toBe(forest);
    expect(onlySession(forest, 'gone')).toEqual({ trees: [], adhoc: [] });
  });

  it('lists the lanes of the range newest first, with the calls of the lanes read', () => {
    const forest = historyForest(TRACE.lanes, SPANS, null);
    expect(forest.adhoc.map((n) => [n.id, n.status, n.tokens])).toEqual([
      ['worker-1', 'running', 500],
      ['worker-done', 'ok', 30],
      ['native:claude:older', 'ok', 300],
    ]);
    expect(forest.adhoc[0]!.calls.map((c) => c.id)).toEqual(['w-read', 'w-bash', 'w-edit']);
    expect(forest.adhoc[2]!.calls).toEqual([]);
    expect(historyForest(TRACE.lanes, SPANS, 'worker-done').adhoc.map((n) => n.id)).toEqual([
      'worker-done',
    ]);
  });

  it('keeps under a lane only the calls of its turns in the range', () => {
    const ranged = lane('worker-2', [
      { id: 'y-turn', start: 1000, end: 2000, status: 'ok', segments: [] },
    ]);
    const spans = new Map<string, Span[]>([
      [
        'worker-2',
        [
          turn('y-turn', { start: 1000, end: 2000 }),
          call('y-read', 'y-turn', { start: 1100, end: 1200 }),
          turn('t-turn', { start: NOW - 60_000, end: NOW - 30_000 }),
          call('t-bash', 't-turn', { name: 'Bash', start: NOW - 50_000, end: NOW - 40_000 }),
        ],
      ],
    ]);
    const [node] = historyForest([ranged], spans, null).adhoc;
    expect(node!.calls.map((c) => c.id)).toEqual(['y-read']);
  });
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mock.sessions = SESSIONS;
  mock.snapshot = SNAPSHOT;
  mock.spans = SPANS;
  mock.spanReads = [];
  mock.trace = TRACE;
  mock.traceReads = [];
  mock.stats = { failed_tool_calls: 2 };
  mock.statsReads = [];
  mock.commands = [];
  mock.answered = null;
  mock.needs = [];
  mock.needsError = null;
  mock.needsReloads = 0;
  mock.accepted = false;
  mock.setState = vi.fn();
});
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
});

const table = (tree: unknown) => named(tree as any, 'CallTable');
const rowsOf = (tree: unknown): CallRow[] => {
  const { props } = table(tree);
  return callRows({ ...props, toggled: new Set(), filter: undefined }).rows;
};
const callRow = (tree: unknown, id: string) =>
  rowsOf(tree).find((r) => r.type === 'call' && r.call.id === id)!;
const detail = (tree: unknown) =>
  nodes(tree as any).find((n) => typeof n.type === 'function' && n.type.name === 'CallDetail');
const figures = (tree: unknown) =>
  find(tree as any, (n) => n.props['aria-label'] === zh('runs.page.figures'));
const labelled = (tree: unknown, label: string) =>
  find(tree as any, (n) => n.type === 'button' && text(n.props.children).includes(label));

describe('runs now', () => {
  const now = () =>
    mount(() => RunsView({ projectId: 'project-a', sessions: mock.sessions, view: 'now' }));

  it('shows the running sessions in the call table with the page filter and the row keys', () => {
    const h = now();
    const { props } = table(h.value);
    expect(props.view).toBe('now');
    expect(props.forest.trees.map((n: any) => n.id)).toEqual(['lead-1']);
    expect(props.forest.trees[0].children.map((n: any) => n.id)).toEqual(['worker-1']);
    expect(props.filter).toEqual({ only: 'all', text: '', slowMs: 5_000 });
    expect(props.keys).toEqual({ next: 'trace-next', previous: 'trace-previous' });
    expect(mock.traceReads.every((read) => read.projectId === null)).toBe(true);
  });

  const sessionTitles = (tree: unknown) =>
    rowsOf(find(tree as any, (n) => n.props['aria-label'] === zh('runs.page.nowLabel'))).flatMap(
      (row) => (row.type === 'session' ? [row.node.title] : []),
    );

  it('lists the sessions live or active within the hour with no plan data at all', () => {
    mock.snapshot = [];
    mock.sessions = [
      listed('solo'),
      listed('quiet', {
        state: 'idle',
        last_activity_at: new Date(NOW - 30 * 60_000).toISOString(),
      }),
      listed('stale', {
        state: 'idle',
        last_activity_at: new Date(NOW - 2 * 3_600_000).toISOString(),
      }),
    ];
    expect(sessionTitles(now().value)).toEqual(['title of solo', 'title of quiet']);
    expect(mock.spanReads).toContainEqual(['solo', 'quiet']);
  });

  it('puts a started session under the session that started it, one whose starter is not listed on top', () => {
    mock.snapshot = [
      { id: 'child', spawned_by: { session_id: 'parent' } },
      { id: 'orphan', spawned_by: { session_id: 'gone' } },
    ];
    mock.sessions = [listed('child'), listed('parent'), listed('orphan')];
    const h = now();
    expect(table(h.value).props.forest.trees.map((n: any) => n.id)).toEqual(['parent', 'orphan']);
    expect(sessionTitles(h.value)).toEqual([
      'title of parent',
      'title of child',
      'title of orphan',
    ]);
  });

  it('fills the figures strip from the spans of the sessions shown', () => {
    const strip = text(figures(now().value));
    expect(strip).toContain('调用5');
    expect(strip).toContain('失败1');
    expect(strip).toContain('20%');
    expect(strip).toContain('中位时长1.0 秒');
    expect(strip).toContain('p95 21.0 秒');
    expect(strip).toContain('tokens150');
    expect(strip).toContain('缓存命中—');
  });

  it('shows the missing dash for tokens when only unreported turns ended', () => {
    mock.spans = new Map(
      [...SPANS].map(([id, spans]) => [
        id,
        spans
          .filter((s) => s.kind !== 'llm')
          .map(({ tokens: _, ...s }) =>
            s.kind === 'turn' ? { ...s, end: NOW - 1_000, status: 'ok' as const } : s,
          ),
      ]),
    );
    const strip = text(figures(now().value));
    expect(strip).toContain('tokens—');
    expect(strip).not.toContain('0+');
  });

  it('follows the newest call into the detail until a row is picked', () => {
    const shown = vi.fn();
    const h = mount(() =>
      RunsView({
        projectId: 'project-a',
        sessions: mock.sessions,
        view: 'now',
        onShowInTimeline: shown,
      }),
    );
    const followed = detail(h.value)!;
    expect(followed.props).toMatchObject({
      session: 'worker-1',
      title: 'title of worker-1',
      turn: 1,
      events: true,
    });
    expect(followed.props.call.id).toBe('w-edit');
    expect(table(h.value).props.selected).toBe(callRow(h.value, 'w-edit').key);
    followed.props.onShowInTimeline();
    expect(shown).toHaveBeenCalledWith({
      lane_key: 'worker-1',
      turn_id: 'w-turn',
      span_id: 'w-edit',
      at: NOW - 5_000,
    });
    const follow = () => find(h.value, (n) => n.type === 'input' && n.props.type === 'checkbox');
    expect(follow().props.checked).toBe(true);
    table(h.value).props.onSelect(callRow(h.value, 'w-bash'));
    h.render();
    expect(detail(h.value)!.props.call.id).toBe('w-bash');
    expect(follow().props.checked).toBe(false);
    detail(h.value)!.props.onClose();
    h.render();
    expect(detail(h.value)).toBeUndefined();
  });

  it('passes the scope and the text of the filter row to the table', () => {
    const h = now();
    find(h.value, (n) => n.props['aria-label'] === zh('runs.page.scope')).props.onValueChange(
      'slow',
    );
    h.render();
    find(
      h.value,
      (n) => n.type === 'input' && n.props['aria-label'] === zh('runs.page.filter'),
    ).props.onChange({
      target: { value: 'pnpm' },
    });
    h.render();
    expect(table(h.value).props.filter).toEqual({ only: 'slow', text: 'pnpm', slowMs: 5_000 });
  });

  it('groups the sessions that just ended and opens one in the history view', () => {
    const h = now();
    const group = find(h.value, (n) => n.props['aria-label'] === zh('runs.page.justEnded'));
    expect(text(group)).toContain('title of worker-done');
    labelled(group, zh('runs.page.inHistory')).props.onClick();
    expect(mock.setState).toHaveBeenCalledWith({ runsView: 'history' });
  });

  it('says nothing runs and offers the history view when no session is shown', () => {
    mock.sessions = [];
    const h = now();
    const element = named(h.value, 'EmptyState');
    const empty = (element.type as (props: object) => any)(element.props);
    expect(text(empty)).toContain(zh('runs.page.nowEmpty'));
    expect(
      nodes(h.value).some((n) => typeof n.type === 'function' && n.type.name === 'CallTable'),
    ).toBe(false);
    const button = labelled(empty, zh('runs.page.seeHistory'));
    expect(button.props['aria-keyshortcuts']).toBe('V');
    button.props.onClick();
    expect(mock.setState).toHaveBeenCalledWith({ runsView: 'history' });
  });

  it('shows where answering an approval failed', async () => {
    const h = now();
    table(h.value).props.onRespond('approval-1', 'approve');
    await h.flush();
    expect(mock.commands).toEqual([
      { type: 'approval.respond', input: { approval_id: 'approval-1', decision: 'approve' } },
    ]);
    expect(find(h.value, (n) => n.props.role === 'alert').props.children).toBeTruthy();
  });

  it('hands the table the questions waiting on an answer and sends the answers given', async () => {
    const questions = [
      { question: 'Which db?', header: 'Database', options: [], multiSelect: false },
    ];
    mock.sessions = [
      listed('asker', {
        state: 'waiting',
        waiting: 1,
        waiting_kind: 'question',
        waiting_request: { id: 'question-1', revision: 3, tool: 'AskUserQuestion' },
      }),
    ];
    mock.snapshot = [];
    mock.needs = [
      {
        source: { table: 'approvals', id: 'question-1', revision: 3 },
        kind: 'permission',
        reason: 'permission_requested',
        project_id: 'project-a',
        session_id: 'asker',
        status: 'pending',
        created_at: NOW,
        questions,
        actions: [{ command: 'approval.respond', allowed: true }],
      },
    ];
    const h = now();
    expect([...table(h.value).props.asked]).toEqual([['question-1', { questions, reason: null }]]);
    table(h.value).props.onAnswer('question-1', { 'Which db?': 'sqlite' });
    await h.flush();
    expect(mock.commands).toEqual([
      {
        type: 'approval.respond',
        input: {
          approval_id: 'question-1',
          decision: 'approve',
          answers: { 'Which db?': 'sqlite' },
        },
      },
    ]);
    expect(find(h.value, (n) => n.props.role === 'alert').props.children).toBeTruthy();
    expect([...table(h.value).props.responding]).toEqual([]);
  });

  it('keeps an accepted answer held until the session stops waiting', async () => {
    mock.accepted = true;
    const h = now();
    table(h.value).props.onAnswer('question-1', { 'Which db?': 'sqlite' });
    await h.flush();
    expect([...table(h.value).props.responding]).toEqual(['question-1']);
    expect(nodes(h.value).some((n) => n.props.role === 'alert')).toBe(false);
    table(h.value).props.onAnswer('question-1', { 'Which db?': 'sqlite' });
    expect(mock.commands).toHaveLength(1);
  });

  it('lets a request reopened at a newer revision be answered again', async () => {
    mock.accepted = true;
    const asking = (revision: number) => [
      listed('asker', {
        state: 'waiting',
        waiting: 1,
        waiting_kind: 'question',
        waiting_request: { id: 'question-1', revision, tool: 'AskUserQuestion' },
      }),
    ];
    mock.snapshot = [];
    mock.sessions = asking(3);
    const h = now();
    table(h.value).props.onAnswer('question-1', { 'Which db?': 'sqlite' });
    await h.flush();
    expect([...table(h.value).props.responding]).toEqual(['question-1']);
    mock.sessions = asking(4);
    h.render();
    expect([...table(h.value).props.responding]).toEqual([]);
    table(h.value).props.onRespond('question-1', 'reject');
    await h.flush();
    expect(mock.commands.map((sent) => (sent.input as { decision: string }).decision)).toEqual([
      'approve',
      'reject',
    ]);
  });

  it('offers no answer and shows the read error with a retry when the questions cannot be read', () => {
    mock.needsError = 'Needs you could not be read';
    mock.needs = [
      {
        source: { table: 'approvals', id: 'question-1', revision: 3 },
        questions: [{ question: 'Which db?', header: 'Database', options: [], multiSelect: false }],
        actions: [{ command: 'approval.respond', allowed: true }],
      },
    ];
    const h = now();
    expect([...table(h.value).props.asked]).toEqual([]);
    const status = find(h.value, (n) => n.props.error === 'Needs you could not be read');
    expect(status.props.label).toBe(zh('runs.page.questionsRead'));
    status.props.reload();
    expect(mock.needsReloads).toBe(1);
  });

  it('holds an approval while its answer is out, so a second click sends nothing', async () => {
    let answer!: () => void;
    mock.answered = new Promise((resolve) => (answer = resolve));
    const h = now();
    table(h.value).props.onRespond('approval-1', 'approve');
    h.render();
    expect([...table(h.value).props.responding]).toEqual(['approval-1']);
    table(h.value).props.onRespond('approval-1', 'reject');
    expect(mock.commands).toHaveLength(1);
    answer();
    await h.flush();
    expect([...table(h.value).props.responding]).toEqual([]);
  });
});

describe('runs history', () => {
  const RANGE = { from: NOW - 3_600_000, to: null };
  const history = () =>
    mount(() =>
      RunsView({ projectId: 'project-a', sessions: mock.sessions, view: 'history', range: RANGE }),
    );

  it('reads the range from the project trace and lists its sessions', () => {
    const h = history();
    expect(mock.traceReads.at(-1)).toEqual({
      projectId: 'project-a',
      window: { ...RANGE, bucketMs: HISTORY_BUCKET_MS },
    });
    const { props } = table(h.value);
    expect(props.view).toBe('history');
    expect(props.forest.adhoc.map((n: any) => n.id)).toEqual([
      'worker-1',
      'worker-done',
      'native:claude:older',
    ]);
    expect(props.onRespond).toBeUndefined();
    const strip = text(figures(h.value));
    expect(strip).toContain('调用12');
    expect(strip).toContain('失败216.7%');
    expect(strip).toContain('中位时长—');
    expect(strip).toContain('tokens1k');
    expect(nodes(h.value).some((n) => n.props.type === 'checkbox')).toBe(false);
  });

  it('reads the failed tool calls of the range up to now from the trace stats', () => {
    history();
    expect(mock.statsReads.at(-1)).toEqual({
      project_id: 'project-a',
      since: String(RANGE.from),
      until: String(NOW),
    });
  });

  it("counts one session's figures from its lane, its failed calls without its failed turns, and draws no spark", () => {
    mock.trace = {
      ...TRACE,
      lanes: TRACE.lanes.map((l) =>
        l.lane.key === 'worker-1'
          ? {
              ...l,
              stats: { ...l.stats, llm: 2, tool: 4, error: 5 },
              turns: l.turns.map((turn) => ({ ...turn, status: 'error' as const })),
            }
          : l,
      ),
    };
    const h = mount(() =>
      RunsView({
        projectId: 'project-a',
        sessions: mock.sessions,
        view: 'history',
        range: RANGE,
        sessionId: 'worker-1',
      }),
    );
    const strip = text(figures(h.value));
    expect(strip).toContain('调用6');
    expect(strip).toContain('失败4');
    expect(strip).toContain('tokens500');
    expect(
      nodes(figures(h.value)).some((n) => typeof n.type === 'function' && n.type.name === 'Spark'),
    ).toBe(false);
  });

  it('counts nothing for a session that ran nothing in the range', () => {
    const h = mount(() =>
      RunsView({
        projectId: 'project-a',
        sessions: mock.sessions,
        view: 'history',
        range: RANGE,
        sessionId: 'worker-none',
      }),
    );
    const strip = text(figures(h.value));
    expect(strip).toContain('调用0');
    expect(strip).toContain('失败0');
  });

  it('shows no failure count while the trace stats are not read', () => {
    mock.stats = null;
    const h = history();
    expect(text(figures(h.value))).toContain('失败—');
  });

  it('reads the calls of a session once its row is picked', () => {
    const h = history();
    expect(mock.spanReads.at(-1)).toEqual([]);
    const session = rowsOf(h.value).find((r) => r.type === 'session' && r.session === 'worker-1')!;
    table(h.value).props.onSelect(session);
    h.render();
    expect(mock.spanReads.at(-1)).toEqual(['worker-1']);
    expect(table(h.value).props.forest.adhoc[0].calls.map((c: RunCall) => c.id)).toEqual([
      'w-read',
      'w-bash',
      'w-edit',
    ]);
  });

  it('picks the session a just ended row opened', () => {
    let view: 'now' | 'history' = 'now';
    const h = mount(() =>
      RunsView({ projectId: 'project-a', sessions: mock.sessions, view, range: RANGE }),
    );
    const group = find(h.value, (n) => n.props['aria-label'] === zh('runs.page.justEnded'));
    labelled(group, zh('runs.page.inHistory')).props.onClick();
    view = 'history';
    h.render();
    const picked = rowsOf(h.value).find((r) => r.key === table(h.value).props.selected);
    expect(picked).toMatchObject({ type: 'session', session: 'worker-done' });
    expect(mock.spanReads.at(-1)).toEqual(['worker-done']);
  });
});

describe('call detail kind', () => {
  const kind = (name: string) =>
    find(
      CallDetail({
        call: { id: 'a', kind: 'tool', name, status: 'ok', start: null, end: null, tokens: 0 },
        session: 'session-1',
        title: 'session',
        turn: null,
        projectId: 'project-1',
        events: false,
        now: NOW,
        onClose: () => undefined,
      }),
      (n) => n.props.className === 'cd-kind',
    ).props.children;

  it('names a call with the verb of the call table', () => {
    expect(kind('apply_patch')).toBe(zh('runs.detail.kind.edit'));
    expect(kind('exec_command')).toBe(zh('runs.detail.kind.run'));
    expect(kind('commandExecution')).toBe(zh('runs.detail.kind.run'));
    expect(kind('mcp__fs__read')).toBe(zh('runs.detail.kind.read'));
  });
});
