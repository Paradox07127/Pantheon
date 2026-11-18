import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardModel, BoardTaskStatus } from '@pantheon/protocol';
import { BoardView } from '../../apps/web/src/screens/board/BoardScreen.js';
import {
  burnupPoints,
  cycleHistogram,
  dayTick,
  markerPlacement,
  stallRows,
} from '../../apps/web/src/screens/board/progress-model.js';
import { zh } from './i18n-setup.js';

const NOW = Date.UTC(2026, 10, 3, 12);
const MIN = 60_000;

type Task = BoardModel['tasks'][number];

const task = (id: string, status: BoardTaskStatus, patch: Partial<Task> = {}): Task => ({
  id,
  title: `task ${id}`,
  goal: '',
  scope: [],
  lane_id: null,
  milestone_id: null,
  status,
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
  ...patch,
});

describe('task burn-up', () => {
  it('draws done every day, skips scope where it is unknown and marks scope changes', () => {
    const points = burnupPoints([
      { day: '11-01', scope: null, done: 0, added: null, removed: null },
      { day: '11-02', scope: 4, done: 1, added: 0, removed: 0 },
      { day: '11-03', scope: 5, done: 2, added: 2, removed: 1 },
    ]);
    expect(points.done).toEqual([0, 1, 2]);
    expect(points.scope).toEqual([
      [
        { index: 1, value: 4 },
        { index: 2, value: 5 },
      ],
    ]);
    expect(points.ticks).toEqual([{ index: 2, added: 2, removed: 1, title: '+2 / −1' }]);
    expect(points.max).toBe(5);
  });

  it('breaks the scope line around a day without a scope', () => {
    const points = burnupPoints([
      { day: '11-01', scope: 2, done: 0, added: 0, removed: 0 },
      { day: '11-02', scope: null, done: 0, added: null, removed: null },
      { day: '11-03', scope: 3, done: 1, added: 1, removed: 0 },
    ]);
    expect(points.scope.map((run) => run.map((p) => p.index))).toEqual([[0], [2]]);
  });
});

describe('cycle time histogram', () => {
  it('labels each bucket by its bound and puts the markers into their buckets', () => {
    const { bars, median, p90 } = cycleHistogram({
      median_ms: 20 * MIN,
      p90_ms: 45 * MIN,
      sample_count: 7,
      buckets: [
        { upper_ms: 15 * MIN, count: 2 },
        { upper_ms: 30 * MIN, count: 4 },
        { upper_ms: null, count: 1 },
      ],
    });
    expect(bars.map((b) => b.label)).toEqual(['15 分钟', '30 分钟', '> 30 分钟']);
    expect(bars.map((b) => b.height)).toEqual([0.5, 1, 0.25]);
    expect(Math.floor(median!.at)).toBe(1);
    expect(median!.label).toBe('中位 20 分钟');
    expect(Math.floor(p90!.at)).toBe(2);
    expect(p90!.label).toBe('p90 45 分钟');
  });
});

describe('chart labels', () => {
  it('shows burn-up days as MM-DD', () => {
    expect(dayTick('2026-11-03')).toBe('11-03');
  });

  it('keeps marker labels inside the plot and moves a crowded one to the next row', () => {
    expect(
      markerPlacement(
        [
          { x: 16, label: '中位 0 分钟' },
          { x: 20, label: 'p90 0 分钟' },
        ],
        300,
      ),
    ).toEqual([
      { anchor: 'start', row: 0 },
      { anchor: 'start', row: 1 },
    ]);
    expect(
      markerPlacement(
        [
          { x: 40, label: '中位 20 分钟' },
          { x: 290, label: 'p90 45 分钟' },
        ],
        300,
      ),
    ).toEqual([
      { anchor: 'start', row: 0 },
      { anchor: 'end', row: 0 },
    ]);
  });
});

describe('blocked and stalled tasks', () => {
  it('lists blocked tasks and tasks running a turn without progress for 10 minutes, longest first', () => {
    const rows = stallRows({
      now: NOW,
      tasks: [
        task('stalled', 'running', { last_progress_at: NOW - 45 * MIN, turn_running: true }),
        task('idle', 'running', { last_progress_at: NOW - 45 * MIN, turn_running: false }),
        task('waiting', 'waiting', { last_progress_at: NOW - 45 * MIN }),
        task('fresh', 'running', { last_progress_at: NOW - 10 * MIN, turn_running: true }),
        task('blocked', 'todo', { blocked_since: NOW - 120 * MIN }),
      ],
    });
    expect(rows.map((r) => [r.task.id, r.kind, r.ms])).toEqual([
      ['blocked', 'blocked', 120 * MIN],
      ['stalled', 'stalled', 45 * MIN],
    ]);
    expect(rows.map((r) => r.share)).toEqual([1, 45 / 120]);
  });

  it('lists a turn the tracker marked stalled and leaves out one with a tool call under way', () => {
    const rows = stallRows({
      now: NOW,
      tasks: [
        task('marked', 'running', {
          last_progress_at: NOW - 15 * MIN,
          turn_running: true,
          activity: { phase: 'thinking', since: NOW - 15 * MIN, health: 'stalled', attempt: 1 },
        }),
        task('long-tool', 'running', {
          last_progress_at: NOW - 40 * MIN,
          turn_running: true,
          activity: {
            phase: 'tool',
            since: NOW - 40 * MIN,
            tool: { name: 'Bash', target: 'pnpm test' },
            health: 'fresh',
            attempt: 1,
          },
        }),
      ],
    });
    expect(rows.map((r) => [r.task.id, r.kind, r.ms])).toEqual([['marked', 'stalled', 15 * MIN]]);
  });
});

describe('progress section', () => {
  it('lays out table, trend beside cycle time, then blocked and stalled in the canvas view', () => {
    const model: BoardModel = {
      since: NOW - 7 * 86_400_000,
      now: NOW,
      headline: null,
      counts: {
        running: 1,
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
      tasks: [task('a', 'running', { last_progress_at: NOW - 45 * MIN })],
      edges: [],
      milestones: [],
      burnup: [],
      goals: [],
      task_progress: {
        totals: {
          done: 1,
          running: 1,
          waiting: 0,
          idle: 0,
          ready: 0,
          failed: 0,
          discarded: 0,
          not_started: 2,
        },
        daily: [{ day: '11-03', scope: 4, done: 1, added: 0, removed: 0 }],
        cycle: { median_ms: null, p90_ms: null, sample_count: 0, buckets: [] },
      },
      usage: [],
      models: [],
      merges: [],
      findings: [],
      risks: [],
    };
    const html = renderToStaticMarkup(
      createElement(BoardView, {
        model,
        page: 'canvas',
        loading: false,
        error: null,
        onRetry() {},
        range: 7,
        onRange() {},
        onPage() {},
        onOpenSession() {},
        onOpenStory() {},
        onOpenTrace() {},
      }),
    );
    const titles = [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1]);
    expect(titles.slice(0, 4)).toEqual([
      zh('board.progress.title'),
      zh('board.trend.title'),
      zh('board.cycle.title'),
      zh('board.stalls.title'),
    ]);
    expect(titles).not.toContain(zh('board.panels.main'));
    expect(html).not.toContain('任务完成');
  });
});
