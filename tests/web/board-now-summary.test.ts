import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { BoardModel, BoardSegment } from '@pantheon/protocol';
import { find, nodes, text, mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'summary-id' }),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign(
    (selector: any) => selector({ openSession() {}, openSessionGroup() {}, openTaskSession() {} }),
    { setState() {} },
  ),
}));
import { nowSummary } from '@/data/now-summary';
import { NowSummary } from '@/screens/board/NowSummary';
import { BoardView } from '@/screens/board/BoardScreen';
import { zh, zhf } from './i18n-setup.js';

// Local noon, so the day boundaries below are the user's calendar days.
const NOW = new Date(2026, 10, 13, 12).getTime();
const TODAY = new Date(2026, 10, 13).getTime();
const HOUR = 3_600_000;
const DAY = 86_400_000;
const noop = () => {};

type Task = BoardModel['tasks'][number];
const segment = (session_id: string, extra: Partial<BoardSegment> = {}): BoardSegment => ({
  id: session_id,
  session_id,
  title: session_id,
  runtime: 'claude',
  model: null,
  status: 'done',
  started_at: null,
  ended_at: null,
  tokens: 0,
  ...extra,
});
const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: id,
  goal: '',
  scope: [],
  lane_id: null,
  milestone_id: null,
  status: 'done',
  blockers: [],
  segments: [],
  additions: null,
  deletions: null,
  checks: 'none',
  started_at: null,
  ended_at: null,
  last_progress_at: null,
  blocked_since: null,
  turn_running: false,
  ...extra,
});
const gated = (id: string, ended_at: number, attempt?: number) =>
  task(id, {
    ended_at,
    retrospective: {
      outcome: 'merged',
      handbacks: 0,
      ...(attempt === undefined ? {} : { gate_passed_on_attempt: attempt }),
    },
  });
const merge = (merged_at: number) =>
  ({ session_id: `m-${merged_at}`, merged_at }) as BoardModel['merges'][number];

const board = (extra: Partial<BoardModel> = {}): BoardModel => ({
  since: TODAY - 6 * DAY,
  now: NOW,
  headline: null,
  counts: {
    running: 0,
    waiting: 0,
    ready: 0,
    failed: 0,
    merged: 0,
    reverted: 0,
    median_ms: null,
    tokens: 0,
    tokens_by_runtime: {},
    previous: { tokens: 0, cost_usd: null, merged: 0, median_ms: null },
    cost_usd: null,
  },
  lanes: [],
  tasks: [],
  edges: [],
  milestones: [],
  burnup: [],
  task_progress: {
    totals: {
      done: 0,
      running: 0,
      waiting: 0,
      idle: 0,
      ready: 0,
      failed: 0,
      discarded: 0,
      not_started: 0,
    },
    daily: [],
    cycle: { median_ms: null, p90_ms: null, sample_count: 0, buckets: [] },
  },
  usage: [],
  models: [],
  merges: [],
  findings: [],
  risks: [],
  ...extra,
});

const full = () =>
  board({
    tasks: [
      task('lead-1:a', {
        segments: [
          segment('s-first', { started_at: TODAY + HOUR, ended_at: TODAY + 3 * HOUR }),
          segment('s-failed', {
            status: 'failed',
            started_at: TODAY + 2 * HOUR,
            ended_at: TODAY + 4 * HOUR,
          }),
        ],
      }),
      // Ended yesterday, still open, and the same session listed twice.
      task('s-old', {
        segments: [segment('s-old', { started_at: TODAY - 5 * HOUR, ended_at: TODAY - HOUR })],
      }),
      task('s-open', { segments: [segment('s-open', { started_at: TODAY + HOUR })] }),
      task('s-first', {
        segments: [segment('s-first', { started_at: TODAY + HOUR, ended_at: TODAY + 3 * HOUR })],
      }),
      gated('lead-1:g1', TODAY + HOUR, 1),
      gated('lead-1:g2', TODAY + 2 * HOUR, 1),
      gated('lead-1:g3', TODAY + 3 * HOUR, 2),
      gated('lead-1:never', TODAY + 3 * HOUR),
      gated('lead-1:yesterday', TODAY - HOUR, 1),
    ],
    usage: [
      { day: '2026-11-13', runtime: 'codex', model: null, tokens: 100, cost_usd: null },
      { day: '2026-11-13', runtime: 'claude', model: 'a', tokens: 200, cost_usd: null },
      { day: '2026-11-13', runtime: 'claude', model: 'b', tokens: 100, cost_usd: null },
      { day: '2026-11-12', runtime: 'claude', model: null, tokens: 9_999, cost_usd: null },
    ],
    merges: [merge(TODAY + HOUR), merge(TODAY + 2 * HOUR), merge(TODAY - 2 * DAY + HOUR)],
  });

const labelled = (tree: ReactNode, label: string) =>
  find(tree, (n) => n.props['aria-label'] === label);

beforeEach(() => {
  mock.board = {
    board: { cursor: 1, projects: [], sessions: [], session_turns: [], workspaces: [] },
    events: [],
    status: { state: 'live' },
    resync: 0,
    refresh() {},
  };
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  vi.stubGlobal('window', {
    pantheon: {
      query: vi.fn(() => new Promise(() => {})),
      command: vi.fn(async () => ({ ok: true, value: null })),
    },
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('now summary figures', () => {
  it("counts today's ended sessions, first-pass gates, usage per runtime and merges per day", () => {
    const summary = nowSummary(full())!;
    expect(summary.ended!.map((s) => [s.session_id, s.ms])).toEqual([
      ['s-first', 2 * HOUR],
      ['s-failed', 2 * HOUR],
    ]);
    expect(summary.gate).toEqual({ first: 2, total: 3 });
    expect(summary.usage).toEqual([
      { runtime: 'codex', tokens: 100, share: 0.25 },
      { runtime: 'claude', tokens: 300, share: 0.75 },
    ]);
    expect(summary.merged!.today).toBe(2);
    expect(summary.merged!.days.map((d) => d.count)).toEqual([0, 0, 0, 0, 1, 0, 2]);
  });

  it('leaves out a part without data and the whole strip when no part has any', () => {
    expect(nowSummary(board())).toBeNull();
    const merges = nowSummary(board({ since: TODAY, merges: [merge(TODAY + HOUR)] }))!;
    expect(merges).toEqual({
      ended: null,
      gate: null,
      usage: null,
      merged: { today: 1, days: [{ day: '2026-11-13', count: 1 }] },
    });
  });
});

describe('now summary strip', () => {
  it('draws nothing when the board has nothing to sum up', () => {
    expect(mount(() => NowSummary({ model: board(), onOpenSession: noop })).value).toBeNull();
  });

  it('puts each part in a cell of one panel, every small graphic beside its number', () => {
    const h = mount(() => NowSummary({ model: full(), onOpenSession: noop }));
    const panel = labelled(h.value, zh('board.summary.label'));
    expect(panel.props.className).toContain('panel');
    const cells = nodes(panel.props.children).filter((n) =>
      String(n.props.className).split(' ').includes('cell'),
    );
    expect(cells).toHaveLength(4);
    expect(text(cells[0])).toContain(`${zh('board.summary.ended')}2`);
    expect(text(cells[1])).toContain(zh('board.summary.gate'));
    expect(labelled(cells[1], zhf('board.summary.gate.ring', { percent: 67 })).props.role).toBe(
      'img',
    );
    expect(text(cells[1])).toContain(
      `67%${zhf('board.summary.gate.count', { first: 2, total: 3 })}`,
    );
    expect(text(cells[2])).toContain(zh('board.summary.usage'));
    expect(text(cells[2])).toContain('300');
    expect(
      labelled(cells[2], zhf('board.summary.usage.share', { runtime: 'Claude', percent: 75 })).props
        .role,
    ).toBe('meter');
    expect(text(cells[3])).toContain(`${zh('board.summary.merged')}2`);
    expect(
      find(cells[3], (n) => n.props.label === zhf('board.summary.merged.bars', { count: 7 })).props
        .values,
    ).toHaveLength(7);
  });

  it('opens the ended sessions as a list, each row opening its session', () => {
    const onOpenSession = vi.fn();
    const h = mount(() => NowSummary({ model: full(), onOpenSession }));
    const toggle = () => find(h.value, (n) => n.props['aria-expanded'] !== undefined);
    expect(toggle().props['aria-expanded']).toBe(false);
    expect(nodes(h.value).some((n) => n.type === 'ul')).toBe(false);
    toggle().props.onClick();
    h.render();
    expect(toggle().props['aria-expanded']).toBe(true);
    const list = find(h.value, (n) => n.type === 'ul');
    expect(toggle().props['aria-controls']).toBe(list.props.id);
    const rows = nodes(list.props.children).filter((n) => n.type === 'button');
    expect(rows.map((row) => text(row))).toEqual(['s-first2 时', 's-failed2 时']);
    rows[1]!.props.onClick();
    expect(onOpenSession).toHaveBeenCalledWith('s-failed');
  });

  it('drops the cell of a part without data', () => {
    const h = mount(() => NowSummary({ model: { ...full(), usage: [] }, onOpenSession: noop }));
    expect(text(h.value)).not.toContain(zh('board.summary.usage'));
    expect(labelled(h.value, zh('board.summary.label')).props.style.gridTemplateColumns).toBe(
      'minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1fr)',
    );
  });

  it('sits under the now view only', () => {
    const shown = (page: 'now' | 'canvas') =>
      nodes(
        mount(() =>
          BoardView({
            model: full(),
            loading: false,
            error: null,
            onRetry: noop,
            range: 7,
            onRange: noop,
            page,
            onPage: noop,
            projectId: 'project-a',
            onOpenSession: noop,
            onOpenStory: noop,
            onOpenTrace: noop,
          }),
        ).value,
      ).some((n) => n.type === NowSummary);
    expect(shown('now')).toBe(true);
    expect(shown('canvas')).toBe(false);
  });
});
