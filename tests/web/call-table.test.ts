import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionTrace, WorkbenchSession } from '@pantheon/protocol';
import { find, mount as host, nodes, text, unmountAll } from './web-hook-host.js';

vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
import { callRows, stepRow, type CallFilter, type CallRow } from '@/screens/runtime/call-rows';
import { CallTable } from '@/screens/runtime/CallTable';
import { runForest } from '@/screens/runtime/run-tree';
import { sessionFacts } from '@/screens/runtime/runtime-model';
import { zh } from './i18n-setup.js';

type Span = SessionTrace['spans'][number];

const T0 = Date.UTC(2026, 10, 13, 9);
const NOW = T0 + 40_000;

const span = (id: string, extra: Partial<Span> = {}): Span => ({
  id,
  parent: 'turn-2',
  turn: 'turn-2',
  kind: 'tool',
  name: 'Read',
  start: T0,
  end: T0 + 1_000,
  status: 'ok',
  timing: 'native',
  ...extra,
});

const turn = (id: string, start: number, end: number | null): Span =>
  span(id, { parent: null, turn: id, kind: 'turn', name: 'turn', start, end, status: 'ok' });

const listed = (id: string, extra: Partial<WorkbenchSession> = {}): WorkbenchSession => ({
  id,
  created_at: new Date(T0 - 60_000).toISOString(),
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

// worker-1 ran one turn before, then a second turn of 20s with five calls, a subagent with one call
// and an approval it still waits on.
const WORKER: Span[] = [
  turn('turn-1', T0 - 30_000, T0 - 20_000),
  span('old-read', { parent: 'turn-1', turn: 'turn-1', start: T0 - 29_000, end: T0 - 28_000 }),
  turn('turn-2', T0, null),
  span('think', { kind: 'llm', name: 'claude-opus', start: T0, end: T0 + 2_000 }),
  span('read', {
    start: T0 + 2_000,
    end: T0 + 2_200,
    files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    tokens: { input: 6_000, output: 400 },
  }),
  span('test', {
    name: 'Bash',
    start: T0 + 4_000,
    end: T0 + 14_000,
    status: 'error',
  }),
  span('grep', { name: 'mcp__x__Grep', start: T0 + 14_000, end: T0 + 14_500 }),
  span('agent', { name: 'Task', start: T0 + 15_000, end: null, status: 'running' }),
  span('agent-edit', {
    parent: 'agent',
    name: 'Edit',
    start: T0 + 16_000,
    end: T0 + 17_000,
    files: ['src/d.ts'],
  }),
];

const LEAD: Span[] = [
  turn('lead-turn', T0 + 10_000, null),
  span('lead-dispatch', {
    parent: 'lead-turn',
    turn: 'lead-turn',
    name: 'mcp__pantheon__spawn_session',
    start: T0 + 10_000,
    end: T0 + 10_400,
  }),
];

const waiting = {
  kind: 'approval' as const,
  summary: 'pnpm db:migrate',
  approval_id: 'approval-1',
  since: T0 + 30_000,
};

const SESSIONS = [
  listed('lead-1', { title: 'lead' }),
  listed('worker-1', {
    state: 'waiting',
    waiting: 1,
    waiting_kind: 'approval',
    waiting_request: { id: waiting.approval_id, tool: 'Bash', detail: waiting.summary },
    run: {
      phase: 'waiting_approval',
      since: waiting.since,
      wait: { reason: 'approval', since: waiting.since },
    },
    context: { used_tokens: 46_000, window_tokens: 100_000 },
    forked_from: { session_id: 'worker-0' },
  }),
];
const PARENTS = new Map([['worker-1', 'lead-1']]);

const SPANS = new Map([
  ['worker-1', WORKER],
  ['lead-1', LEAD],
]);

const rowsOf = (
  view: 'now' | 'history' = 'now',
  extra: {
    toggled?: ReadonlySet<string>;
    filter?: CallFilter;
    spans?: ReadonlyMap<string, readonly Span[]>;
  } = {},
) => {
  const spans = extra.spans ?? SPANS;
  return callRows({
    forest: runForest(SESSIONS, PARENTS, spans),
    facts: sessionFacts(SESSIONS),
    spans,
    view,
    now: NOW,
    toggled: extra.toggled ?? new Set(),
    filter: extra.filter,
  });
};

const named = (rows: readonly CallRow[], key: string) => rows.find((row) => row.key === key)!;

describe('call rows', () => {
  it('lists each session with the calls of its newest turn under it, verbs and targets mapped', () => {
    const { rows } = rowsOf();
    expect(rows.map((row) => [row.type, row.key, row.depth])).toEqual([
      ['session', 's:lead-1', 0],
      ['call', 'c:lead-1/lead-dispatch', 1],
      ['session', 's:worker-1', 0],
      ['call', 'c:worker-1/think', 1],
      ['call', 'c:worker-1/read', 1],
      ['call', 'c:worker-1/test', 1],
      ['call', 'c:worker-1/grep', 1],
      ['subagent', 'a:worker-1/agent', 1],
      ['call', 'c:worker-1/agent-edit', 2],
      ['approval', 'w:worker-1/approval-1', 1],
    ]);
    const verbs = rows.flatMap((row) =>
      row.type === 'call' ? [[row.verb, row.target, row.more]] : [],
    );
    expect(verbs).toEqual([
      ['tool', 'mcp__pantheon__spawn_session', 0],
      ['think', null, 0],
      ['read', 'src/a.ts', 2],
      ['run', 'Bash', 0],
      ['search', 'mcp__x__Grep', 0],
      ['edit', 'src/d.ts', 0],
    ]);
    const read = named(rows, 'c:worker-1/read');
    expect([read.tokens, read.duration, read.state]).toEqual([6_400, 200, 'ok']);
    expect(named(rows, 'c:worker-1/test').state).toBe('bad');
    expect(named(rows, 'c:worker-1/think').tokens).toBeNull();
  });

  it('places each bar in its own turn on one scale, the longest turn filling it', () => {
    const { rows, scale } = rowsOf();
    // worker-1's turn runs 40s to now, the lead's 30s.
    expect(scale).toBe(40_000);
    expect(named(rows, 'c:worker-1/test').bars).toEqual([
      { left: 10, width: 25, tone: 'bad', live: false },
    ]);
    // Short calls keep a visible sliver.
    expect(named(rows, 'c:worker-1/read').bars[0]!.width).toBe(1.5);
    expect(named(rows, 'c:lead-1/lead-dispatch').bars[0]!.left).toBe(0);
    expect(named(rows, 'a:worker-1/agent').bars).toEqual([
      { left: 37.5, width: 62.5, tone: 'series-1', live: true },
    ]);
  });

  it('heads a session with its turn number, context, fork and its wait in the bar', () => {
    const { rows } = rowsOf();
    const worker = named(rows, 's:worker-1');
    expect(worker.type === 'session' && [worker.turn, worker.context, worker.forked]).toEqual([
      2,
      46,
      true,
    ]);
    expect(worker.state).toBe('wait');
    expect(worker.bars).toEqual([
      { left: 0, width: 75, tone: 'idle', faded: true },
      { left: 75, width: 25, tone: 'wait', stripe: true },
    ]);
    const head = named(rows, 's:lead-1');
    expect(head.type === 'session' && [head.context, head.turn]).toEqual([null, 1]);
    expect(head.bars).toEqual([{ left: 0, width: 75, tone: 'run', live: true }]);
    // The session ran 70s from its first turn, its newest turn 40s.
    expect(worker.duration).toBe(70_000);
  });

  it('shows history rows with the turn time, no context and no live tails', () => {
    const { rows } = rowsOf('history', {
      toggled: new Set(['s:worker-1', 's:lead-1']),
    });
    const worker = named(rows, 's:worker-1');
    expect(worker.type === 'session' && worker.context).toBeNull();
    expect(worker.duration).toBe(40_000);
    expect(named(rows, 'a:worker-1/agent').bars[0]!.live).toBe(false);
    const wait = named(rows, 'w:worker-1/approval-1');
    expect(wait.bars).toEqual([{ left: 75, width: 25, tone: 'wait', stripe: true }]);
  });

  it('folds sessions by default in history and opens them in the now view, toggles flipping each', () => {
    expect(rowsOf('history').rows.map((row) => row.key)).toEqual(['s:lead-1', 's:worker-1']);
    const folded = rowsOf('now', { toggled: new Set(['s:worker-1', 'a:worker-1/agent']) }).rows;
    expect(folded.map((row) => row.key)).toEqual([
      's:lead-1',
      'c:lead-1/lead-dispatch',
      's:worker-1',
    ]);
    const sub = rowsOf('now', { toggled: new Set(['a:worker-1/agent']) }).rows;
    expect(sub.some((row) => row.key === 'c:worker-1/agent-edit')).toBe(false);
    expect(
      named(sub, 'a:worker-1/agent').type === 'subagent' && named(sub, 'a:worker-1/agent'),
    ).toMatchObject({ open: false });
  });

  it('keeps the calls a filter matches and the sessions and subagents holding them', () => {
    const failed = rowsOf('now', { filter: { only: 'failed', text: '', slowMs: 5_000 } }).rows;
    expect(failed.map((row) => row.key)).toEqual(['s:worker-1', 'c:worker-1/test']);
    const slow = rowsOf('now', { filter: { only: 'slow', text: '', slowMs: 5_000 } }).rows;
    expect(slow.map((row) => row.key)).toEqual([
      's:worker-1',
      'c:worker-1/test',
      'a:worker-1/agent',
    ]);
    const typed = rowsOf('now', { filter: { only: 'all', text: 'D.TS', slowMs: 5_000 } }).rows;
    expect(typed.map((row) => row.key)).toEqual([
      's:worker-1',
      'a:worker-1/agent',
      'c:worker-1/agent-edit',
    ]);
    const command = rowsOf('now', { filter: { only: 'all', text: 'migrate', slowMs: 5_000 } });
    expect(command.rows.map((row) => row.key)).toEqual(['s:worker-1', 'w:worker-1/approval-1']);
  });

  it('finds a call by the command or prompt it shows, and names each subagent by its prompt', () => {
    const spans = new Map([
      [
        'worker-1',
        WORKER.map((s) =>
          s.id === 'test'
            ? { ...s, input_summary: 'pnpm vitest run webhook' }
            : s.id === 'agent'
              ? { ...s, input_summary: 'review the signature check' }
              : s,
        ),
      ],
      ['lead-1', LEAD],
    ]);
    const filter = (text: string) => ({ only: 'all' as const, text, slowMs: 5_000 });
    const command = rowsOf('now', { spans, filter: filter('vitest') }).rows;
    expect(command.map((row) => row.key)).toEqual(['s:worker-1', 'c:worker-1/test']);
    const prompt = rowsOf('now', { spans, filter: filter('signature') }).rows;
    expect(prompt.map((row) => row.key)).toEqual(['s:worker-1', 'a:worker-1/agent']);
    const agent = named(rowsOf('now', { spans }).rows, 'a:worker-1/agent');
    expect(agent.type === 'subagent' && agent.target).toBe('review the signature check');
  });

  it('opens folded history sessions to the calls a filter matches', () => {
    const failed = rowsOf('history', { filter: { only: 'failed', text: '', slowMs: 5_000 } }).rows;
    expect(failed.map((row) => row.key)).toEqual(['s:worker-1', 'c:worker-1/test']);
  });

  it('steps the highlight one row at a time, stopping at either end', () => {
    const { rows } = rowsOf();
    expect(stepRow(rows, null, 1)).toBe('s:lead-1');
    expect(stepRow(rows, null, -1)).toBe('w:worker-1/approval-1');
    expect(stepRow(rows, 's:lead-1', 1)).toBe('c:lead-1/lead-dispatch');
    expect(stepRow(rows, 's:lead-1', -1)).toBe('s:lead-1');
    expect(stepRow(rows, 'w:worker-1/approval-1', 1)).toBe('w:worker-1/approval-1');
    expect(stepRow(rows, 'gone', 1)).toBe('s:lead-1');
  });
});

describe('call table', () => {
  afterEach(unmountAll);

  const mount = (props: Partial<Parameters<typeof CallTable>[0]> = {}) => {
    const all = {
      forest: runForest(SESSIONS, PARENTS, SPANS),
      facts: sessionFacts(SESSIONS),
      spans: SPANS,
      view: 'now' as const,
      now: NOW,
      selected: null,
      onSelect: vi.fn(),
      onRespond: vi.fn(),
      ...props,
    };
    return { h: host(() => CallTable(all)), props: all };
  };

  const rowEl = (tree: unknown, key: string) =>
    find(tree as any, (n) => n.props.role === 'row' && n.props['data-key'] === key);

  it('draws a tree grid with a header, the scale ticks and one row per entry', () => {
    const { h } = mount({ selected: 'c:worker-1/test' });
    const grid = find(h.value, (n) => n.props.role === 'treegrid');
    expect(grid.props['aria-activedescendant']).toBe(rowEl(h.value, 'c:worker-1/test').props.id);
    const head = find(h.value, (n) => n.props.role === 'row' && !n.props['data-key']);
    expect(text(head)).toContain(zh('runs.table.label'));
    expect(text(head)).toContain('20.0 秒');
    expect(text(head)).toContain('40.0 秒');
    expect(rowEl(h.value, 'c:worker-1/test').props['aria-selected']).toBe(true);
    expect(text(rowEl(h.value, 'c:worker-1/read'))).toContain('src/a.ts 等另外 2 个文件');
    expect(text(rowEl(h.value, 's:worker-1'))).toContain('第 2 轮');
    expect(text(rowEl(h.value, 's:worker-1'))).toContain('46%');
    expect(rowEl(h.value, 's:worker-1').props['aria-expanded']).toBe(true);
  });

  it('answers an approval inline in the now view and only names the wait in history', () => {
    const { h, props } = mount();
    const row = rowEl(h.value, 'w:worker-1/approval-1');
    expect(text(row)).toContain('pnpm db:migrate');
    expect(text(row)).toContain('等 10.0 秒');
    const allow = find(
      row,
      (n) => n.type === 'button' && text(n) === zh('runs.table.approval.allow'),
    );
    const reject = find(
      row,
      (n) => n.type === 'button' && text(n) === zh('runs.table.approval.reject'),
    );
    allow.props.onClick({ stopPropagation() {} });
    reject.props.onClick({ stopPropagation() {} });
    expect(props.onRespond).toHaveBeenNthCalledWith(1, 'approval-1', 'approve');
    expect(props.onRespond).toHaveBeenNthCalledWith(2, 'approval-1', 'reject');

    const past = mount({ view: 'history' });
    const fold = find(
      rowEl(past.h.value, 's:worker-1'),
      (n) => n.type === 'button' && n.props['aria-label'] === zh('runs.table.expand'),
    );
    fold.props.onClick({ stopPropagation() {} });
    past.h.render();
    const waited = rowEl(past.h.value, 'w:worker-1/approval-1');
    expect(text(waited)).toContain(zh('runs.table.approval.pending'));
    expect(nodes(waited).some((n) => n.type === 'button')).toBe(false);
  });

  it('disables both answers of an approval whose answer is out', () => {
    const { h } = mount({ responding: new Set(['approval-1']) });
    const row = rowEl(h.value, 'w:worker-1/approval-1');
    const answers = nodes(row).filter((n) => n.type === 'button');
    expect(answers.map((n) => n.props.disabled)).toEqual([true, true]);
  });

  it('selects rows by click and by the list keys, and folds with left and right', () => {
    const { h, props } = mount({ selected: 's:worker-1' });
    rowEl(h.value, 'c:worker-1/read').props.onClick();
    expect(props.onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: 'c:worker-1/read' }),
    );
    const grid = () => find(h.value, (n) => n.props.role === 'treegrid');
    const key = (k: string) => ({
      key: k,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault() {},
    });
    grid().props.onKeyDown(key('ArrowDown'));
    expect(props.onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: 'c:worker-1/think' }),
    );
    grid().props.onKeyDown(key('ArrowLeft'));
    h.render();
    expect(rowEl(h.value, 's:worker-1').props['aria-expanded']).toBe(false);
    expect(nodes(h.value).some((n) => n.props['data-key'] === 'c:worker-1/read')).toBe(false);
    grid().props.onKeyDown(key('Escape'));
    expect(props.onSelect).toHaveBeenLastCalledWith(null);
  });
});
