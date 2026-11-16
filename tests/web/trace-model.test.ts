import { describe, expect, it } from 'vitest';
import type { ProjectHeatmap, ProjectTrace, TraceStats } from '@pantheon/protocol';
import type { DaemonEvent } from '@/data/sync';
import {
  dayLabel,
  dayWindow,
  eventDays,
  eventReplayStep,
  eventWindow,
  EVENT_MS,
  firstError,
  heatCells,
  hourCells,
  hourWindow,
  laneAnalysis,
  laneStats,
  levels,
  panWindow,
  presetWindow,
  replayStep,
  replayTotals,
  ROW_HEIGHT,
  stepRows,
  stripBars,
  traceAxis,
  traceEvents,
  traceRows,
  turnSpan,
  turnWindow,
  visibleWindow,
  windowLanes,
  zoomWindow,
  type HeatCommit,
  type TraceLaneView,
  type TraceSpan,
  type TraceTurn,
  type TraceWindow,
} from '@/screens/trace/model';

const MIN = 60_000;

const stats: TraceStats = {
  sessions: 1,
  turns: 0,
  llm: 0,
  tool: 0,
  error: 0,
  tokens: { input: 0, output: 0 },
  active_ms: 0,
  commits: 0,
};

const turn = (id: string, start: number, end: number | null, extra: Partial<TraceTurn> = {}) =>
  ({ id, start, end, status: 'ok', segments: [], ...extra }) as TraceTurn;

const lane = (key: string, turns: TraceTurn[]): TraceLaneView => ({
  lane: {
    key,
    source: key.startsWith('native:') ? 'external' : 'pantheon',
    runtime: 'claude',
    native_id: key,
    title: `title of ${key}`,
    cwd: '/repo',
  },
  stats: { ...stats, turns: turns.length },
  turns,
});

const trace = (lanes: TraceLaneView[]): ProjectTrace => ({
  epoch: null,
  from: new Date(0).toISOString(),
  to: new Date(60 * MIN).toISOString(),
  indexing: null,
  stats,
  lanes,
  buckets: [],
});

describe('traceRows', () => {
  it('lists the lanes in order with the open lane followed by its turns', () => {
    const t = trace([
      lane('session-main', [turn('turn-a', 0, MIN), turn('turn-b', 2 * MIN, 3 * MIN)]),
      lane('native:claude:abc', [turn('turn-c', 0, MIN)]),
    ]);
    const rows = traceRows(t, new Set(['session-main']));
    expect(rows.map((r) => [r.kind, r.key])).toEqual([
      ['session', 'session-main'],
      ['turn', 'session-main/turn-a'],
      ['turn', 'session-main/turn-b'],
      ['session', 'native:claude:abc'],
    ]);
    expect(rows[0]).toMatchObject({ kind: 'session', stats: { turns: 2 } });
  });
});

describe('visibleWindow', () => {
  it('mounts the viewport plus eight rows each way, clamped to the rows', () => {
    expect(visibleWindow(100, 0, 300)).toEqual({ first: 0, last: 17 });
    expect(visibleWindow(100, 1500, 300)).toEqual({ first: 42, last: 67 });
    expect(visibleWindow(100, 2700, 300)).toEqual({ first: 82, last: 99 });
    expect(visibleWindow(5, 0, 300)).toEqual({ first: 0, last: 4 });
  });
});

describe('firstError', () => {
  it('takes the error turn that starts first across lanes', () => {
    const t = trace([
      lane('session-main', [
        turn('turn-a', 0, MIN),
        turn('turn-b', 9 * MIN, null, { status: 'error' }),
      ]),
      lane('native:claude:abc', [turn('turn-c', 4 * MIN, 5 * MIN, { status: 'error' })]),
    ]);
    expect(firstError(t)).toEqual({ laneKey: 'native:claude:abc', turnId: 'turn-c' });
  });

  it('counts a turn that finished ok with a failed tool call', () => {
    const t = trace([
      lane('session-main', [
        turn('turn-a', 0, MIN),
        turn('turn-b', 2 * MIN, 3 * MIN, {
          segments: [{ from: 2 * MIN, to: 2 * MIN + 1000, kind: 'error' }],
        }),
      ]),
    ]);
    expect(firstError(t)).toEqual({ laneKey: 'session-main', turnId: 'turn-b' });
  });

  it('is null without an error turn', () => {
    expect(firstError(trace([lane('session-main', [turn('turn-a', 0, MIN)])]))).toBeNull();
  });

  it('finds a failed turn without a start among the rows of the window', () => {
    const t = trace([
      lane('session-main', [turn('turn-a', 0, MIN)]),
      lane('native:claude:abc', [turn('turn-failed', 0, null, { start: null, status: 'error' })]),
    ]);
    const shown = windowLanes(t, { from: 0, to: 60 * MIN });
    const error = firstError(shown)!;
    expect(error).toEqual({ laneKey: 'native:claude:abc', turnId: 'turn-failed' });
    const rows = traceRows(shown, new Set([error.laneKey]));
    expect(rows.map((r) => r.key)).toContain('native:claude:abc/turn-failed');
  });

  it('falls back to the session whose failed step drew no segment', () => {
    const t = trace([
      lane('session-main', [turn('turn-a', 0, MIN)]),
      { ...lane('native:claude:abc', [turn('turn-b', 0, MIN)]), stats: { ...stats, error: 1 } },
    ]);
    expect(firstError(t)).toEqual({ laneKey: 'native:claude:abc', turnId: null });
  });
});

describe('turnSpan', () => {
  const window = { from: 0, to: 60 * MIN };

  it('runs only a running turn without an end up to the window end', () => {
    expect(turnSpan(turn('turn-run', 10 * MIN, null, { status: 'running' }), window)).toEqual([
      10 * MIN,
      60 * MIN,
    ]);
    const cut = turn('turn-cut', 10 * MIN, null, {
      status: 'unknown',
      segments: [{ from: 10 * MIN, to: 12 * MIN, kind: 'tool' }],
    });
    expect(turnSpan(cut, window)).toEqual([10 * MIN, 12 * MIN]);
    expect(turnSpan(turn('turn-bare', 10 * MIN, null, { status: 'ok' }), window)).toEqual([
      10 * MIN,
      10 * MIN,
    ]);
  });
});

describe('windowLanes', () => {
  const window = { from: 10 * MIN, to: 20 * MIN };

  it('keeps a turn without a start by its end, or always when that is unknown too', () => {
    const t = trace([
      lane('session-main', [
        turn('turn-inside', 0, 15 * MIN, { start: null }),
        turn('turn-earlier', 0, 5 * MIN, { start: null }),
        turn('turn-untimed', 0, null, { start: null }),
      ]),
    ]);
    expect(windowLanes(t, window).lanes[0]!.turns.map((x) => x.id)).toEqual([
      'turn-inside',
      'turn-untimed',
    ]);
  });

  it('counts only the turns left in the window and their failures', () => {
    const turns = [
      turn('turn-a', 0, 5 * MIN, { status: 'error' }),
      turn('turn-b', 12 * MIN, 14 * MIN),
      turn('turn-c', 16 * MIN, 18 * MIN, {
        segments: [{ from: 16 * MIN, to: 17 * MIN, kind: 'error' }],
      }),
    ];
    const t = trace([{ ...lane('session-main', turns), stats: { ...stats, turns: 3, error: 2 } }]);
    expect(windowLanes(t, window).lanes[0]!.stats).toMatchObject({ turns: 2, error: 1 });
    expect(windowLanes(t, { from: 0, to: 60 * MIN }).lanes[0]!.stats).toMatchObject({
      turns: 3,
      error: 2,
    });
  });
});

describe('stripBars', () => {
  it('scales the busiest bucket to the full height and marks the error buckets', () => {
    const bars = stripBars(
      [
        { at: 0, llm: 2, tool: 2, error: 0 },
        { at: 1, llm: 4, tool: 4, error: 1 },
        { at: 2, llm: 0, tool: 0, error: 0 },
      ],
      40,
    );
    expect(bars.map((b) => b.llm + b.tool)).toEqual([20, 40, 0]);
    expect(bars[1]).toMatchObject({ llm: 20, tool: 20 });
    expect(bars.map((b) => b.error)).toEqual([false, true, false]);
  });
});

describe('traceAxis', () => {
  const window = { from: 0, to: 30 * MIN };

  it('cuts a ten-minute idle stretch between turns', () => {
    const t = trace([
      lane('session-main', [turn('turn-a', 0, 5 * MIN), turn('turn-b', 15 * MIN, null)]),
    ]);
    const axis = traceAxis(t, window);
    expect(axis.breaks).toHaveLength(1);
    expect(axis.breaks[0]!.ms).toBe(10 * MIN);
  });

  it('keeps a thirty-second pause on the axis', () => {
    const t = trace([
      lane('session-main', [turn('turn-a', 0, 5 * MIN)]),
      lane('native:claude:abc', [turn('turn-b', 5 * MIN + 30_000, 30 * MIN)]),
    ]);
    expect(traceAxis(t, window).breaks).toEqual([]);
  });

  it('cuts an idle stretch only once it passes a twentieth of the window, keeping its length', () => {
    const hundred = { from: 0, to: 100 * MIN };
    const gap = (minutes: number) =>
      traceAxis(
        trace([
          lane('session-main', [
            turn('turn-a', 0, 40 * MIN),
            turn('turn-b', (40 + minutes) * MIN, 100 * MIN),
          ]),
        ]),
        hundred,
      ).breaks;
    expect(gap(4.5)).toEqual([]);
    expect(gap(6)).toHaveLength(1);
    expect(gap(6)[0]!.ms).toBe(6 * MIN);
  });
});

describe('eventWindow', () => {
  const full = { from: 0, to: 100 * MIN };

  it('centres a tenth of the whole window on the event', () => {
    expect(eventWindow(50 * MIN, null, full)).toEqual({ from: 45 * MIN, to: 55 * MIN });
  });

  it('keeps the length of a zoomed view and stays inside the window', () => {
    expect(eventWindow(30 * MIN, { from: 0, to: 20 * MIN }, full)).toEqual({
      from: 20 * MIN,
      to: 40 * MIN,
    });
    expect(eventWindow(99 * MIN, null, full)).toEqual({ from: 90 * MIN, to: 100 * MIN });
  });

  it('is null when the view would cover the whole window', () => {
    expect(eventWindow(MIN, null, { from: 0, to: 30_000 })).toBeNull();
  });
});

describe('traceEvents', () => {
  let sequence = 0;
  const event = (kind: string, at: number, payload: object = {}, aggregate = 'session-a') =>
    ({
      event_id: `event-${++sequence}`,
      kind,
      aggregate_id: aggregate,
      aggregate_revision: 1,
      project_id: 'project-a',
      sequence,
      created_at: at,
      causation_id: '',
      payload,
    }) as unknown as DaemonEvent;

  it('lists approvals, checks, merges and session starts and ends newest first', () => {
    const rows = traceEvents([
      event('session.opened', MIN),
      event('agent.message.delta', 2 * MIN, { text: 'hello' }),
      event('agent.permission.requested', 3 * MIN, { request_id: 'r1', tool: 'Bash' }),
      event('session.gate_checked', 4 * MIN, { results: [{ name: 'test', exit_code: 0 }] }),
      event('session.merged', 5 * MIN, { to_sha: 'abcdef123456', additions: 9, deletions: 2 }),
      event('session.closed', 6 * MIN, { reason: 'merged' }),
    ]);
    expect(rows.map((r) => [r.kind, r.what])).toEqual([
      ['session', 'closed'],
      ['merge', 'merged'],
      ['gate', 'gate_passed'],
      ['approval', 'asked'],
      ['session', 'opened'],
    ]);
    expect(rows[1]).toMatchObject({ detail: 'abcdef1', added: 9, removed: 2 });
  });

  it('gives an approval the time it waited for its answer, and the answer the tool asked for', () => {
    const rows = traceEvents([
      event('agent.permission.requested', MIN, { request_id: 'r1', tool: 'Bash' }),
      event('agent.permission.requested', 2 * MIN, { request_id: 'r2', tool: 'Edit' }),
      event('agent.permission.resolved', 4 * MIN, { request_id: 'r1', decision: 'allow' }),
    ]);
    expect(rows.map((r) => [r.what, r.detail, r.waitedMs])).toEqual([
      ['allowed', 'Bash', undefined],
      ['asked', 'Edit', null],
      ['asked', 'Bash', 3 * MIN],
    ]);
  });

  it("numbers each session's gate runs and names the first failed check, skipped ones aside", () => {
    const rows = traceEvents([
      event('session.gate_checked', MIN, {
        results: [
          { name: 'lint', skipped: true },
          { name: 'test', exit_code: 1 },
        ],
      }),
      event('session.gate_checked', 2 * MIN, { results: [{ name: 'test', exit_code: 0 }] }),
      event('session.gate_checked', 3 * MIN, { results: [] }, 'session-b'),
    ]);
    expect(rows.map((r) => [r.sessionId, r.what, r.detail, r.run])).toEqual([
      ['session-b', 'gate_passed', null, 1],
      ['session-a', 'gate_passed', null, 2],
      ['session-a', 'gate_failed', 'test', 1],
    ]);
  });

  it('gives an approval and its answer the command the tool was asked to run', () => {
    const rows = traceEvents([
      event('agent.permission.requested', MIN, {
        request_id: 'r1',
        tool: 'Bash',
        detail: { input: { command: 'pnpm db:migrate --env staging' } },
      }),
      event('agent.permission.resolved', 2 * MIN, { request_id: 'r1', decision: 'allow' }),
    ]);
    expect(rows.map((r) => [r.what, r.detail, r.input])).toEqual([
      ['allowed', 'Bash', 'pnpm db:migrate --env staging'],
      ['asked', 'Bash', 'pnpm db:migrate --env staging'],
    ]);
  });

  it('counts the checks of a gate run that passed and were skipped', () => {
    const rows = traceEvents([
      event('session.gate_checked', MIN, {
        results: [
          { name: 'lint', exit_code: 0 },
          { name: 'types', skipped: true },
          { name: 'test', exit_code: 0 },
        ],
      }),
    ]);
    expect(rows[0]!.checks).toEqual({ passed: 2, failed: 0, skipped: 1 });
  });

  it('lists model changes, lead questions with their wait, dispatches and new task counts', () => {
    const plan = (tasks: number) => ({
      headline: 'Refunds v2',
      tasks: Array.from({ length: tasks }, (_, i) => ({ id: `task-${i}` })),
    });
    const rows = traceEvents([
      event('board.plan_updated', MIN, plan(3), 'lead-a'),
      event('board.plan_updated', 2 * MIN, plan(3), 'lead-a'),
      event('lead.question_asked', 3 * MIN, { id: 'q1', question: 'One endpoint?' }, 'lead-a'),
      event('task.dispatched', 4 * MIN, { task_id: 'task-0', session_id: 'session-b' }, 'lead-a'),
      event('lead.question_answered', 9 * MIN, { id: 'q1', question: 'One endpoint?' }, 'lead-a'),
      event('session.model_changed', 10 * MIN, { model: 'claude-opus-5-5', effort: null }),
      event('board.plan_updated', 11 * MIN, plan(4), 'lead-a'),
    ]);
    expect(rows.map((r) => [r.sessionId, r.kind, r.what, r.detail])).toEqual([
      ['lead-a', 'plan', 'planned', 'Refunds v2'],
      ['session-a', 'model', 'model_changed', 'claude-opus-5-5'],
      ['session-b', 'plan', 'dispatched', null],
      ['lead-a', 'plan', 'question', 'One endpoint?'],
      ['lead-a', 'plan', 'planned', 'Refunds v2'],
    ]);
    expect(rows.map((r) => r.tasks)).toEqual([4, undefined, undefined, undefined, 3]);
    expect(rows[3]!.waitedMs).toBe(6 * MIN);
  });
});

describe('eventDays', () => {
  it('groups newest-first rows by local day, the newest day first', () => {
    const at = (day: number, hour: number) => new Date(2026, 2, day, hour).getTime();
    const row = (id: string, time: number) =>
      ({ id, at: time, sessionId: 's', kind: 'session', what: 'opened', detail: null }) as const;
    const days = eventDays([row('c', at(8, 9)), row('b', at(8, 1)), row('a', at(7, 23))]);
    expect(days.map((d) => [d.day, d.rows.map((r) => r.id)])).toEqual([
      ['2026-03-08', ['c', 'b']],
      ['2026-03-07', ['a']],
    ]);
  });
});

const cell = (
  day: string,
  llm: number,
  extra: Partial<ProjectHeatmap['lanes'][number]['cells'][number]> = {},
) => ({ day, llm, tool: 0, error: 0, tokens: 0, commits: 0, ...extra });

const commit = (sha: string, at: number, day: string, laneKey: string | null): HeatCommit => ({
  sha,
  at,
  day,
  lane_key: laneKey,
  via: null,
  added: 1,
  removed: 0,
  subject: `subject of ${sha}`,
});

describe('heatCells', () => {
  const days = ['2026-03-01', '2026-03-02', '2026-03-03'];
  const heatmap: ProjectHeatmap = {
    days,
    lanes: [
      {
        key: 'session-main',
        title: 'main session',
        cells: [cell('2026-03-01', 1), cell('2026-03-02', 0), cell('2026-03-03', 2, { error: 2 })],
      },
      {
        key: 'native:codex:abc',
        title: 'codex session',
        cells: [
          cell('2026-03-01', 0, { tool: 3, commits: 1 }),
          cell('2026-03-02', 4),
          cell('2026-03-03', 0),
        ],
      },
    ],
    hours: days.map((day) => ({ day, calls: Array(24).fill(0), errors: Array(24).fill(0) })),
    commits: [
      commit('aaa', 1, '2026-03-01', 'native:codex:abc'),
      commit('bbb', 2, '2026-03-03', null),
      commit('ccc', 3, '2026-03-03', 'session-main'),
    ],
    merges: [],
  };

  it('spreads four busy cells over the four levels and leaves idle cells at zero', () => {
    const grid = heatCells(heatmap);
    expect(grid.lanes.map((lane) => lane.cells.map((c) => c.level))).toEqual([
      [1, 0, 2],
      [3, 4, 0],
    ]);
    expect(grid.lanes[1]!.cells[0]).toMatchObject({ calls: 3 });
  });

  it('marks errors and commits on their cells', () => {
    const [main, codex] = heatCells(heatmap).lanes;
    expect(main!.cells.map((c) => c.error)).toEqual([false, false, true]);
    expect(main!.cells[2]!.errors).toBe(2);
    expect(codex!.cells.map((c) => c.commits)).toEqual([1, 0, 0]);
  });

  it("counts the project's commits per day", () => {
    expect(heatCells(heatmap).commits).toEqual([
      { day: '2026-03-01', count: 1 },
      { day: '2026-03-02', count: 0 },
      { day: '2026-03-03', count: 2 },
    ]);
  });
});

describe('levels', () => {
  it('spreads four different counts over the four levels and keeps zero at zero', () => {
    const level = levels([0, 8, 1, 4, 2, 0]);
    expect([0, 1, 2, 4, 8].map(level)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('hourCells', () => {
  const hours = (calls: Record<number, number>, errors: Record<number, number> = {}) => ({
    calls: Array.from({ length: 24 }, (_, h) => calls[h] ?? 0),
    errors: Array.from({ length: 24 }, (_, h) => errors[h] ?? 0),
  });
  const heatmap: ProjectHeatmap = {
    days: ['2026-03-01', '2026-03-02'],
    lanes: [],
    hours: [
      { day: '2026-03-01', ...hours({ 9: 1, 10: 2 }, { 10: 1 }) },
      { day: '2026-03-02', ...hours({ 0: 4, 23: 8 }) },
    ],
    commits: [],
    merges: [],
  };

  it('gives each day 24 hours with their calls and errors', () => {
    const grid = hourCells(heatmap);
    expect(grid.days).toEqual(heatmap.days);
    expect(grid.hours.map((d) => [d.day, d.cells.length])).toEqual([
      ['2026-03-01', 24],
      ['2026-03-02', 24],
    ]);
    expect(grid.hours[0]!.cells.map((c) => c.hour)).toEqual(
      Array.from({ length: 24 }, (_, h) => h),
    );
    expect(grid.hours[0]!.cells.map((c) => c.calls)).toEqual(heatmap.hours[0]!.calls);
    expect(grid.hours[0]!.cells.map((c) => c.errors)).toEqual(heatmap.hours[0]!.errors);
  });

  it('levels the hours across all days at once', () => {
    const [first, second] = hourCells(heatmap).hours;
    expect([9, 10, 11].map((h) => first!.cells[h]!.level)).toEqual([1, 2, 0]);
    expect([0, 23].map((h) => second!.cells[h]!.level)).toEqual([3, 4]);
  });
});

describe('replayStep', () => {
  it('crosses half the view in thirty seconds at 1x', () => {
    expect(replayStep(0, 30_000, 1)).toBe(0.5);
  });

  it('moves sixteen times as fast at 16x', () => {
    expect(replayStep(0.1, 1000, 16)! - 0.1).toBeCloseTo(16 * (replayStep(0.1, 1000, 1)! - 0.1));
  });

  it('is null on reaching or passing the end', () => {
    expect(replayStep(0.5, 30_000, 1)).toBeNull();
    expect(replayStep(0.9, 30_000, 4)).toBeNull();
  });
});

describe('eventReplayStep', () => {
  const steps = [0.1, 0.5, 0.6];

  it('takes as long to reach each step however far apart the steps lie', () => {
    expect(eventReplayStep(0, EVENT_MS / 2, 1, steps)).toBeCloseTo(0.05);
    expect(eventReplayStep(0.1, EVENT_MS / 2, 1, steps)).toBeCloseTo(0.3);
    expect(eventReplayStep(0.5, EVENT_MS / 2, 1, steps)).toBeCloseTo(0.55);
    expect(eventReplayStep(0.1, EVENT_MS / 2, 4, steps)).toBeCloseTo(0.6);
  });

  it('carries the rest of a long frame into the next leg', () => {
    expect(eventReplayStep(0, 1.5 * EVENT_MS, 1, steps)).toBeCloseTo(0.3);
  });

  it('stops on the last step and is null once there', () => {
    expect(eventReplayStep(0.55, 10 * EVENT_MS, 1, steps)).toBe(0.6);
    expect(eventReplayStep(0.6, 1, 1, steps)).toBeNull();
    expect(eventReplayStep(0.7, 1, 1, steps)).toBeNull();
  });
});

describe('replayTotals', () => {
  const t = trace([
    lane('session-a', [
      turn('turn-a', 10 * MIN, 20 * MIN, { tokens: { input: 600, output: 400 } }),
      turn('turn-b', 30 * MIN, 40 * MIN),
    ]),
    lane('session-b', [turn('turn-c', 15 * MIN, 25 * MIN, { tokens: { input: 2000, output: 0 } })]),
  ]);
  t.buckets = [
    { at: 0, llm: 1, tool: 2, error: 0 },
    { at: 15 * MIN, llm: 3, tool: 1, error: 1 },
    { at: 30 * MIN, llm: 2, tool: 0, error: 1 },
  ];
  const at = replayTotals(t, { from: 0, to: 60 * MIN });

  it.each([
    [
      'counts no turn before the first starts',
      5 * MIN,
      { activeMs: 0, running: 0, calls: 3, errors: 0, tokens: 0, unreported: 0 },
    ],
    [
      'counts a turn under way by the share of it passed',
      15 * MIN,
      { activeMs: 5 * MIN, running: 2, calls: 7, errors: 1, tokens: 500, unreported: 0 },
    ],
    [
      'counts every turn whole after the last one ends',
      50 * MIN,
      { activeMs: 25 * MIN, running: 0, calls: 9, errors: 2, tokens: 3000, unreported: 1 },
    ],
  ])('%s', (_name, time, totals) => {
    expect(at(time)).toEqual(totals);
  });

  it('counts a lane running from the start of its turn up to its end', () => {
    expect([10 * MIN, 20 * MIN, 25 * MIN, 30 * MIN].map((time) => at(time).running)).toEqual([
      1, 1, 0, 1,
    ]);
  });
});

describe('hourWindow', () => {
  it('runs from the local hour to the next', () => {
    expect(hourWindow('2026-03-08', 14)).toEqual({
      from: new Date(2026, 2, 8, 14).getTime(),
      to: new Date(2026, 2, 8, 15).getTime(),
    });
  });

  it('ends the last hour at the next midnight', () => {
    expect(hourWindow('2026-12-31', 23).to).toBe(new Date(2027, 0, 1).getTime());
  });
});

const span = (id: string, extra: Partial<TraceSpan> = {}): TraceSpan => ({
  id,
  parent: null,
  turn: 'turn-a',
  kind: 'tool',
  name: 'Read',
  start: 0,
  end: MIN,
  status: 'ok',
  timing: 'native',
  ...extra,
});

describe('laneAnalysis', () => {
  it('counts tool calls under a turn but not the steps a Codex call runs', () => {
    const spans = [
      span('turn-a', { kind: 'turn', name: 'turn' }),
      span('call-1', { parent: 'turn-a', name: 'exec_command' }),
      span('step-1', { parent: 'call-1', name: 'exec_command' }),
      span('step-2', { parent: 'call-1', name: 'shell' }),
      span('call-2', { name: 'Task', kind: 'subagent' }),
      span('llm-1', { kind: 'llm', name: 'model' }),
    ];
    expect(laneAnalysis(spans, [], 'session-main').tools).toEqual([
      { name: 'Task', count: 1 },
      { name: 'exec_command', count: 1 },
    ]);
  });

  it('keeps the five busiest tools, ties by name', () => {
    const names = ['Read', 'Read', 'Edit', 'Edit', 'Bash', 'Grep', 'Glob', 'Write', 'Bash'];
    const spans = names.map((name, i) => span(`call-${i}`, { name }));
    expect(laneAnalysis(spans, [], 'session-main').tools).toEqual([
      { name: 'Bash', count: 2 },
      { name: 'Edit', count: 2 },
      { name: 'Read', count: 2 },
      { name: 'Glob', count: 1 },
      { name: 'Grep', count: 1 },
    ]);
  });

  it('counts the paths across all spans', () => {
    const spans = [
      span('call-1', { files: ['src/a.ts', 'src/b.ts'] }),
      span('step-1', { parent: 'call-1', files: ['src/b.ts'] }),
      span('llm-1', { kind: 'llm', files: ['src/c.ts'] }),
    ];
    expect(laneAnalysis(spans, [], 'session-main').files).toEqual([
      { path: 'src/b.ts', count: 2 },
      { path: 'src/a.ts', count: 1 },
      { path: 'src/c.ts', count: 1 },
    ]);
  });

  it("lists only the lane's commits, newest first", () => {
    const commits = [
      commit('aaa', 1, '2026-03-01', 'session-main'),
      commit('bbb', 3, '2026-03-02', 'session-main'),
      commit('ccc', 2, '2026-03-02', 'native:codex:abc'),
      commit('ddd', 4, '2026-03-03', null),
    ];
    expect(laneAnalysis([], commits, 'session-main').commits.map((c) => c.sha)).toEqual([
      'bbb',
      'aaa',
    ]);
  });
});

describe('laneStats', () => {
  it('totals the turns, calls and tokens, an open turn running to now', () => {
    const spans = [
      span('turn-a', { kind: 'turn', start: 0, end: 2 * MIN }),
      span('turn-b', {
        kind: 'turn',
        turn: 'turn-b',
        start: 3 * MIN,
        end: null,
        status: 'running',
      }),
      span('llm-1', { kind: 'llm', tokens: { input: 10, output: 5 } }),
      span('call-1', { status: 'error', commit: { sha: 'aaa', via: 'bash_output' } }),
    ];
    expect(laneStats(spans, 5 * MIN)).toMatchObject({
      turns: 2,
      llm: 1,
      tool: 1,
      error: 1,
      tokens: { input: 10, output: 5 },
      active_ms: 4 * MIN,
      commits: 1,
    });
  });

  it('adds no time for a turn without an end that is not running', () => {
    const spans = [
      span('turn-a', { kind: 'turn', start: 0, end: 2 * MIN }),
      span('turn-b', {
        kind: 'turn',
        turn: 'turn-b',
        start: 3 * MIN,
        end: null,
        status: 'unknown',
      }),
    ];
    expect(laneStats(spans, 60 * MIN).active_ms).toBe(2 * MIN);
  });
});

describe('dayWindow', () => {
  it('runs from local midnight to the next', () => {
    expect(dayWindow('2026-03-08')).toEqual({
      from: new Date(2026, 2, 8).getTime(),
      to: new Date(2026, 2, 9).getTime(),
    });
    expect(dayWindow('2026-12-31').to).toBe(new Date(2027, 0, 1).getTime());
  });
});

describe('stepRows', () => {
  it('drops the turn span and indents each nesting level up to two', () => {
    const spans = [
      span('turn-a', { kind: 'turn', name: 'turn', start: 0 }),
      span('call-1', { parent: 'turn-a', start: 1000 }),
      span('step-1', { parent: 'call-1', start: 2000 }),
      span('step-2', { parent: 'step-1', start: 3000 }),
      span('step-3', { parent: 'step-2', start: 4000 }),
      span('llm-1', { kind: 'llm', start: 5000 }),
    ];
    expect(stepRows(spans, 'turn-a').map((r) => [r.span.id, r.depth])).toEqual([
      ['call-1', 0],
      ['step-1', 1],
      ['step-2', 2],
      ['step-3', 2],
      ['llm-1', 0],
    ]);
  });

  it('puts a step whose parent is missing at the top level', () => {
    const rows = stepRows([span('step-1', { parent: 'call-gone' })], 'turn-a');
    expect(rows.map((r) => r.depth)).toEqual([0]);
  });

  it('orders by start with unstarted steps last and ties by id', () => {
    const spans = [
      span('step-c', { start: null }),
      span('step-b', { start: 2000 }),
      span('step-z', { start: 1000 }),
      span('step-a', { start: 2000 }),
      span('step-y', { start: null }),
    ];
    expect(stepRows(spans, 'turn-a').map((r) => r.span.id)).toEqual([
      'step-z',
      'step-a',
      'step-b',
      'step-c',
      'step-y',
    ]);
  });
});

describe('traceRows with steps', () => {
  const t = trace([
    lane('session-main', [turn('turn-a', 0, MIN), turn('turn-b', 2 * MIN, 3 * MIN)]),
    lane('native:claude:abc', [turn('turn-c', 0, MIN)]),
  ]);
  const steps = (turnKey: string) => ({
    turnKey,
    spans: [
      span('turn-a', { kind: 'turn', name: 'turn' }),
      span('call-2', { start: 2000 }),
      span('call-1', { start: 1000 }),
    ],
  });

  it('puts the step rows right under their turn row', () => {
    const rows = traceRows(t, new Set(['session-main']), steps('session-main/turn-a'));
    expect(rows.map((r) => [r.kind, r.key])).toEqual([
      ['session', 'session-main'],
      ['turn', 'session-main/turn-a'],
      ['step', 'session-main/turn-a/call-1'],
      ['step', 'session-main/turn-a/call-2'],
      ['turn', 'session-main/turn-b'],
      ['session', 'native:claude:abc'],
    ]);
    expect(rows[2]).toMatchObject({ kind: 'step', depth: 0, turn: { id: 'turn-a' } });
  });

  it('adds no step rows under a closed lane', () => {
    const rows = traceRows(t, new Set(['session-main']), steps('native:claude:abc/turn-c'));
    expect(rows.map((r) => r.kind)).toEqual(['session', 'turn', 'turn', 'session']);
  });
});

describe('traceRows with subagents', () => {
  const t = trace([
    lane('session-main', [turn('turn-a', 0, MIN)]),
    lane('native:claude:abc', [turn('turn-c', 0, MIN)]),
  ]);
  const agent = (n: number, sessionId = 'session-main') => ({
    session_id: sessionId,
    span_id: `agent-${n}`,
    name: `explore ${n}`,
    start: n * 1000,
    status: 'ok' as const,
  });
  const agents = (count: number) => Array.from({ length: count }, (_, i) => agent(count - i));

  it('puts the subagents under their session row by start, before its turns', () => {
    const rows = traceRows(t, new Set(['session-main']), null, [
      agent(2),
      agent(1),
      agent(1, 'native:claude:abc'),
    ]);
    expect(rows.map((r) => [r.kind, r.key])).toEqual([
      ['session', 'session-main'],
      ['subagent', 'session-main/subagent:agent-1'],
      ['subagent', 'session-main/subagent:agent-2'],
      ['turn', 'session-main/turn-a'],
      ['session', 'native:claude:abc'],
    ]);
    expect(rows[2]).toMatchObject({ kind: 'subagent', below: 2, agent: { name: 'explore 2' } });
  });

  it.each([
    ['all six under a closed lane', new Set<string>(), 6, [6, 0]],
    ['five and a row for the rest under a closed lane', new Set<string>(), 8, [5, 3]],
    ['all of them under an open lane', new Set(['session-main']), 8, [8, 0]],
  ] as const)('lists %s', (_, open, count, [listed, more]) => {
    const rows = traceRows(t, open, null, agents(count));
    const own = rows.filter((r) => r.lane.lane.key === 'session-main');
    expect(own.filter((r) => r.kind === 'subagent')).toHaveLength(listed);
    const rest = own.find((r) => r.kind === 'more');
    expect(rest && rest.kind === 'more' ? rest.agents.length : 0).toBe(more);
    if (rest) expect(own.indexOf(rest)).toBe(6);
  });
});

describe('zoomWindow', () => {
  const full = { from: 0, to: 60 * MIN };
  const idle = trace([]);
  /** To the millisecond. */
  const near = (got: TraceWindow | null, from: number, to: number) => {
    expect(got!.from).toBeCloseTo(from, 0);
    expect(got!.to).toBeCloseTo(to, 0);
  };

  it('keeps the time under the pointer in place', () => {
    const view = { from: 10 * MIN, to: 40 * MIN };
    const at = 20 * MIN;
    near(zoomWindow(view, full, at, 0.5, idle), 15 * MIN, 30 * MIN);
  });

  it('keeps the time under the pointer in place on the axis the zoomed view cuts anew', () => {
    const t = trace([
      lane('session-main', [turn('turn-a', 0, 5 * MIN), turn('turn-b', 15 * MIN, 30 * MIN)]),
    ]);
    const view = { from: 0, to: 30 * MIN };
    const at = traceAxis(t, view).time(0.5);
    const next = zoomWindow(view, full, at, 0.5, t)!;
    expect(next.to - next.from).toBeCloseTo(15 * MIN);
    expect(traceAxis(t, next).position(at)).toBeCloseTo(0.5, 4);
  });

  it('stops at one minute', () => {
    const next = zoomWindow({ from: 10 * MIN, to: 12 * MIN }, full, 11 * MIN, 0.1, idle)!;
    expect(next.to - next.from).toBe(MIN);
    near(next, 10.5 * MIN, 11.5 * MIN);
  });

  it('zooms out of an empty view around its time', () => {
    near(zoomWindow({ from: 20 * MIN, to: 20 * MIN }, full, 20 * MIN, 2, idle), 20 * MIN, 21 * MIN);
  });

  it('is null once the view would cover the whole window', () => {
    expect(zoomWindow({ from: 10 * MIN, to: 40 * MIN }, full, 20 * MIN, 3, idle)).toBeNull();
  });

  it('pushes a view past an edge back inside', () => {
    expect(zoomWindow({ from: 0, to: 20 * MIN }, full, 5 * MIN, 2, idle)).toEqual({
      from: 0,
      to: 40 * MIN,
    });
    expect(zoomWindow({ from: 50 * MIN, to: 60 * MIN }, full, 58 * MIN, 2, idle)).toEqual({
      from: 40 * MIN,
      to: 60 * MIN,
    });
  });
});

describe('turnWindow', () => {
  const full = { from: 0, to: 60 * MIN };

  // The turn and the frame in minutes.
  it.each([
    ['frames the turn with a twentieth of its length on each side', [10, 20], [9.5, 20.5]],
    ['widens a short turn to a minute around its middle', [30, 30.5], [29.75, 30.75]],
    ['keeps the frame inside full', [0, 10], [0, 11]],
    ['keeps the frame inside full', [50, 60], [49, 60]],
    ['is null when the frame would cover full', [1, 58], null],
  ] as const)('%s', (_, [from, to], frame) => {
    const framed = frame && { from: frame[0] * MIN, to: frame[1] * MIN };
    expect(turnWindow(from * MIN, to * MIN, full)).toEqual(framed);
  });
});

describe('panWindow', () => {
  const full = { from: 0, to: 60 * MIN };
  const view = { from: 10 * MIN, to: 20 * MIN };

  it('moves the view and keeps its length', () => {
    expect(panWindow(view, full, 5 * MIN)).toEqual({ from: 15 * MIN, to: 25 * MIN });
  });

  it('stops at either edge', () => {
    expect(panWindow(view, full, -30 * MIN)).toEqual({ from: 0, to: 10 * MIN });
    expect(panWindow(view, full, 90 * MIN)).toEqual({ from: 50 * MIN, to: 60 * MIN });
  });
});

describe('presetWindow', () => {
  const now = new Date(2026, 2, 8, 14, 37, 21, 500).getTime();
  const midnight = (back: number) => new Date(2026, 2, 8 - back).getTime();

  it('starts each preset where it should with its bucket', () => {
    expect(presetWindow('1h', now)).toEqual({
      from: Math.floor((now - 3_600_000) / 60_000) * 60_000,
      bucketMs: 60_000,
    });
    expect(presetWindow('24h', now)).toEqual({
      from: Math.floor((now - 86_400_000) / 900_000) * 900_000,
      bucketMs: 900_000,
    });
    expect(presetWindow('7d', now)).toEqual({ from: midnight(6), bucketMs: 3_600_000 });
    expect(presetWindow('30d', now)).toEqual({ from: midnight(29), bucketMs: 14_400_000 });
  });

  it('starts the short presets on a bucket edge that holds still within the bucket', () => {
    for (const preset of ['1h', '24h'] as const) {
      const { from, bucketMs } = presetWindow(preset, now);
      expect(from % bucketMs).toBe(0);
      const edge = Math.floor(now / bucketMs) * bucketMs;
      expect(presetWindow(preset, edge)).toEqual(presetWindow(preset, edge + bucketMs - 1));
    }
  });
});

describe('row mounting', () => {
  it('mounts fewer than sixty rows of a 500-turn session with 300 open steps', () => {
    const turns = Array.from({ length: 500 }, (_, i) =>
      turn(`turn-${i}`, i * MIN, i * MIN + 50_000, {
        segments: [0, 1, 2, 3].map((k) => ({
          from: i * MIN + k * 10_000,
          to: i * MIN + (k + 1) * 10_000,
          kind: (['llm', 'tool', 'llm', 'subagent'] as const)[k]!,
        })),
      }),
    );
    const spans = Array.from({ length: 300 }, (_, i) =>
      span(`step-${String(i).padStart(3, '0')}`, {
        turn: 'turn-250',
        parent: 'turn-250',
        start: 250 * MIN + i * 100,
      }),
    );
    const rows = traceRows(trace([lane('session-main', turns)]), new Set(['session-main']), {
      turnKey: 'session-main/turn-250',
      spans,
    });
    expect(rows).toHaveLength(1 + 500 + 300);
    const height = rows.length * ROW_HEIGHT;
    for (const top of [0, height / 2, height - 900]) {
      const { first, last } = visibleWindow(rows.length, top, 900);
      expect(last - first + 1).toBeLessThan(60);
    }
  });
});

describe('dayLabel', () => {
  it('writes the day, with the month on the first', () => {
    expect(dayLabel('2026-03-08')).toBe('8');
    expect(dayLabel('2026-04-01')).toBe('4月1日');
  });
});
