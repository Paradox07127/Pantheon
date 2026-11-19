import { describe, expect, it } from 'vitest';
import type { BoardModel, BoardSegment } from '@pantheon/protocol';
import { nowSummary } from '@/data/now-summary';

// Local noon, so the day boundaries below are the user's calendar days.
const NOW = new Date(2026, 10, 13, 12).getTime();
const TODAY = new Date(2026, 10, 13).getTime();
const HOUR = 3_600_000;
const DAY = 86_400_000;

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
  goals: [],
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
