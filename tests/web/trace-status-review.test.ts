import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectStatusRead } from '@pantheon/protocol';
import { find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';

const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector: any) => selector(mock.shell), {
    getState: () => mock.shell,
    setState: (patch: object) => Object.assign(mock.shell, patch),
  }),
  resolveTheme: () => 'light',
}));
import { reviewWindow, StatusReview } from '@/screens/trace/StatusReview';
import { ROLE_LABEL } from '@/screens/project/usage-model';
import { durationText } from '@/lib/time-text';
import { tokenText } from '@/lib/number-text';
import { zh, zhf } from './i18n-setup.js';

const MIN = 60_000;
const NOW = new Date(2026, 10, 26, 15, 40).getTime();

const status = (): ProjectStatusRead => ({
  landings: {
    records: [
      {
        id: 'landing-refunds',
        revision: 1,
        project_id: 'p',
        session_id: 'session-refunds',
        state: 'landed',
        reason: null,
        ended_at: NOW - 30 * MIN,
        landed_sha: 'abc1234',
        gate_runs: 2,
        first_gate_passed: false,
        review_rounds: 2,
        turns: 4,
        input_tokens: 1000,
        output_tokens: 200,
        wall_ms: 40 * MIN,
      },
      {
        id: 'landing-branch',
        revision: 1,
        project_id: 'p',
        branch: 'feature/export',
        state: 'blocked',
        reason: 'conflict',
        ended_at: NOW - 20 * MIN,
        landed_sha: null,
        gate_runs: 1,
        first_gate_passed: true,
        review_rounds: 1,
        turns: 0,
        input_tokens: 0,
        output_tokens: 0,
        wall_ms: null,
      },
    ],
    landed: 1,
    blocked: 1,
    no_changes: 0,
    first_gate_pass_rate: 0.5,
    mean_review_rounds: 1.5,
    median_wall_ms: 40 * MIN,
  },
  waiting: {
    count: 3,
    total_ms: 17 * MIN,
    longest: [
      { session_id: 'session-refunds', kind: 'permission', wait_ms: 12 * MIN, open: true },
      { session_id: 'session-docs', kind: 'permission', wait_ms: 4 * MIN, open: false },
      { session_id: null, kind: 'permission', wait_ms: MIN, open: false },
    ],
  },
  time: {
    roles: [
      { role: 'user', turn_ms: 30 * MIN },
      { role: 'reviewer', turn_ms: 9 * MIN },
      { role: 'conductor', turn_ms: 0 },
    ],
    gate_ms: 6 * MIN,
    review_ms: 9 * MIN,
  },
  usage: [
    {
      role: 'user',
      turns: 4,
      input_tokens: 12000,
      cached_input_tokens: 3000,
      output_tokens: 2000,
    },
    {
      role: 'reviewer',
      turns: 2,
      input_tokens: 5000,
      cached_input_tokens: null,
      output_tokens: 500,
    },
    { role: 'conductor', turns: 0, input_tokens: 0, cached_input_tokens: null, output_tokens: 0 },
  ],
});

const empty = (): ProjectStatusRead => ({
  landings: {
    records: [],
    landed: 0,
    blocked: 0,
    no_changes: 0,
    first_gate_pass_rate: null,
    mean_review_rounds: null,
    median_wall_ms: null,
  },
  waiting: { count: 0, total_ms: 0, longest: [] },
  time: {
    roles: [
      { role: 'user', turn_ms: 0 },
      { role: 'reviewer', turn_ms: 0 },
    ],
    gate_ms: 0,
    review_ms: 0,
  },
  usage: [{ role: 'user', turns: 0, input_tokens: 0, cached_input_tokens: null, output_tokens: 0 }],
});

let answer: () => unknown;
let query: ReturnType<typeof vi.fn>;
// Each test reads its own project, so no answer cached by another test shows first.
let projects = 0;
let projectId: string;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  projectId = `project-${++projects}`;
  answer = () => ({ ok: true, value: status() });
  query = vi.fn(async () => answer());
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {}, pantheon: { query } });
  mock.board = {
    board: { cursor: 1, projects: [], sessions: [] },
    events: [],
    status: { state: 'live' },
    resync: 0,
  };
  mock.shell = { openSession: vi.fn() };
});
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const TITLES: Record<string, string> = {
  'session-refunds': 'Refund idempotency',
  'session-docs': 'Export docs',
};
const panel = async (hasSession: (id: string) => boolean = (id) => id in TITLES) => {
  const h = mount(() =>
    StatusReview({
      projectId,
      titleOf: (id) => TITLES[id] ?? id,
      hasSession,
      range: 'today',
      onRange: vi.fn(),
      onClose: vi.fn(),
    }),
  );
  await h.flush();
  return h;
};
const section = (tree: unknown, id: string) =>
  find(tree as ReactElement, (n) => n.type === 'section' && n.props['aria-label'] === zh(id));
const labels = (tree: ReactElement) =>
  nodes(tree)
    .filter((n) => n.props.role === 'img')
    .map((n) => n.props['aria-label']);
const items = (tree: ReactElement) => nodes(tree).filter((n) => n.type === 'li');

describe('the recap window', () => {
  it.each([
    ['today', new Date(2026, 10, 26).getTime()],
    ['week', new Date(2026, 10, 20).getTime()],
    ['month', new Date(2026, 9, 28).getTime()],
  ] as const)(
    'reads %s from local midnight of its first day to the coming midnight',
    (range, from) => {
      expect(reviewWindow(range, NOW)).toEqual({ from, to: new Date(2026, 10, 27).getTime() });
    },
  );

  it('asks the daemon for today first and for the picked range after', async () => {
    const h = await panel();
    expect(query).toHaveBeenCalledWith('project.status.read', {
      project_id: projectId,
      from: String(new Date(2026, 10, 26).getTime()),
      to: String(new Date(2026, 10, 27).getTime()),
    });
    const range = find(
      h.value,
      (n) => n.props.role !== 'radio' && n.props['aria-label'] === zh('trace.recap.range'),
    );
    expect(range.props.value).toBe('today');
    const onRange = vi.fn();
    const week = mount(() =>
      StatusReview({
        projectId,
        titleOf: (id) => id,
        hasSession: () => true,
        range: 'week',
        onRange,
        onClose: vi.fn(),
      }),
    );
    await week.flush();
    expect(query).toHaveBeenLastCalledWith('project.status.read', {
      project_id: projectId,
      from: String(new Date(2026, 10, 20).getTime()),
      to: String(new Date(2026, 10, 27).getTime()),
    });
    find(
      week.value,
      (n) => n.props.role !== 'radio' && n.props['aria-label'] === zh('trace.recap.range'),
    ).props.onValueChange('month');
    expect(onRange).toHaveBeenCalledWith('month');
  });

  it.each([
    ['an open wait is listed', true, 2],
    ['no wait is open', false, 1],
  ])('reads again each minute while %s', async (_, open, reads) => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    const read = status();
    read.waiting.longest[0]!.open = open;
    answer = () => ({ ok: true, value: read });
    const h = await panel();
    expect(query).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(MIN);
    h.render();
    await h.flush();
    expect(query).toHaveBeenCalledTimes(reads);
  });

  it.each([
    ['session.merged', 2],
    ['approval.approved', 2],
    ['turn.completed', 2],
    ['workspace.removed', 2],
    ['session.renamed', 1],
  ])('reads again after %s while it is open', async (kind, reads) => {
    const h = await panel();
    expect(query).toHaveBeenCalledTimes(1);
    mock.board = { ...mock.board, events: [{ sequence: 9, kind, project_id: projectId }] };
    h.render();
    await h.flush();
    expect(query).toHaveBeenCalledTimes(reads);
  });
});

describe('the recap', () => {
  it('counts the landings with their rates and lists each record', async () => {
    const h = await panel();
    const block = section(h.value, 'trace.recap.landings');
    expect(labels(block)).toEqual([
      `${zh('trace.recap.state.landed')} 1`,
      `${zh('trace.recap.state.blocked')} 1`,
      `${zh('trace.recap.state.noChanges')} 0`,
      `${zh('trace.recap.firstPass')} ${zhf('trace.recap.rate', { percent: 50 })}`,
      `${zh('trace.recap.reviewRounds')} 1.5`,
      `${zh('trace.recap.medianTime')} ${durationText(40 * MIN)}`,
    ]);
    const rows = items(block);
    expect(rows.map((row) => text(row))).toEqual([
      expect.stringMatching(new RegExp(`^Refund idempotency${zh('trace.recap.state.landed')}`)),
      expect.stringMatching(new RegExp(`^feature/export${zh('trace.recap.state.blocked')}`)),
    ]);
  });

  it('says no gate ran when the first-pass rate is null', async () => {
    const read = status();
    read.landings.first_gate_pass_rate = null;
    answer = () => ({ ok: true, value: read });
    const h = await panel();
    expect(labels(section(h.value, 'trace.recap.landings'))).toContain(
      `${zh('trace.recap.firstPass')} ${zh('trace.recap.noGates')}`,
    );
  });

  it('counts the waits and lists the longest, marking the one still waiting', async () => {
    const h = await panel();
    const block = section(h.value, 'trace.recap.waiting');
    expect(labels(block).slice(0, 2)).toEqual([
      `${zh('trace.recap.waits')} 3`,
      `${zh('trace.recap.waited')} ${durationText(17 * MIN)}`,
    ]);
    const rows = items(block);
    expect(rows.map((row) => text(row))).toEqual([
      `Refund idempotency${zh('trace.recap.kind.permission')}${durationText(12 * MIN)}`,
      `Export docs${zh('trace.recap.kind.permission')}${durationText(4 * MIN)}`,
      `${zh('trace.recap.noSession')}${zh('trace.recap.kind.permission')}${durationText(MIN)}`,
    ]);
    expect(rows.map((row) => labels(row))).toEqual([[zh('trace.recap.open')], [], []]);
  });

  it("draws a bar for each role's turn time and the gates, review time on the reviewer's row", async () => {
    const h = await panel();
    expect(labels(section(h.value, 'trace.recap.time'))).toEqual([
      zhf('trace.recap.time.row', { role: ROLE_LABEL.user, time: durationText(30 * MIN) }),
      zhf('trace.recap.time.review', {
        role: ROLE_LABEL.reviewer,
        time: durationText(9 * MIN),
      }),
      zhf('trace.recap.time.row', {
        role: zh('trace.recap.time.gate'),
        time: durationText(6 * MIN),
      }),
    ]);
  });

  it("draws a bar for each role's tokens", async () => {
    const h = await panel();
    const block = section(h.value, 'trace.recap.usage');
    expect(labels(block)).toEqual([
      zhf('project.usage.roleLabel', {
        role: ROLE_LABEL.user,
        input: tokenText(12000),
        cached: tokenText(3000),
        output: tokenText(2000),
        turns: 4,
      }),
      zhf('project.usage.roleLabel', {
        role: ROLE_LABEL.reviewer,
        input: tokenText(5000),
        cached: zh('project.usage.notReported'),
        output: tokenText(500),
        turns: 2,
      }),
    ]);
  });

  it('says each block had nothing in an empty window', async () => {
    answer = () => ({ ok: true, value: empty() });
    const h = await panel();
    for (const [block, sentence] of [
      ['trace.recap.landings', 'trace.recap.landings.empty'],
      ['trace.recap.waiting', 'trace.recap.waiting.empty'],
      ['trace.recap.time', 'trace.recap.time.empty'],
      ['trace.recap.usage', 'trace.recap.usage.none'],
    ] as const)
      expect(text(section(h.value, block))).toBe(`${zh(block)}${zh(sentence)}`);
  });

  it('says no tokens were reported when turns ran without a usage report', async () => {
    const read = empty();
    read.usage = [
      { role: 'user', turns: 3, input_tokens: 0, cached_input_tokens: null, output_tokens: 0 },
    ];
    answer = () => ({ ok: true, value: read });
    const h = await panel();
    expect(text(section(h.value, 'trace.recap.usage'))).toBe(
      `${zh('trace.recap.usage')}${zh('trace.recap.usage.none')}`,
    );
  });

  it('takes an answer missing a block as a failed read', async () => {
    answer = () => ({ ok: true, value: { landings: { records: [] } } });
    const h = await panel();
    expect(nodes(h.value).some((n) => n.type === 'section')).toBe(false);
    expect(named(h.value, 'Failure')).toBeTruthy();
  });

  it('shows a failed read on one line with a retry that reads again', async () => {
    answer = () => ({ ok: false, error: { code: 'internal', message: 'disk full' } });
    const h = await panel();
    expect(nodes(h.value).some((n) => n.type === 'section')).toBe(false);
    const failure = named(h.value, 'Failure');
    expect(failure.props.error).toContain('disk full');
    answer = () => ({ ok: true, value: status() });
    failure.props.onRetry();
    h.render();
    await h.flush();
    expect(query).toHaveBeenCalledTimes(2);
    expect(() => named(h.value, 'Failure')).toThrow();
    expect(nodes(h.value).filter((n) => n.type === 'section')).toHaveLength(4);
  });

  it('opens the session of a landing record and of a wait', async () => {
    const h = await panel();
    const open = (block: string, row: number) =>
      find(items(section(h.value, block))[row]!, (n) => n.type === 'button').props.onClick();
    open('trace.recap.landings', 0);
    expect(mock.shell.openSession).toHaveBeenLastCalledWith('session-refunds');
    open('trace.recap.waiting', 1);
    expect(mock.shell.openSession).toHaveBeenLastCalledWith('session-docs');
    expect(
      nodes(items(section(h.value, 'trace.recap.landings'))[1]!).some((n) => n.type === 'button'),
    ).toBe(false);
  });

  it('names a deleted session without a link to it', async () => {
    const h = await panel((id) => id !== 'session-docs');
    const row = items(section(h.value, 'trace.recap.waiting'))[1]!;
    expect(nodes(row).some((n) => n.type === 'button')).toBe(false);
    expect(text(row)).toMatch(/^Export docs/);
  });
});
