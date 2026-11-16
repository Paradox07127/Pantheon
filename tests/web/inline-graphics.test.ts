import { describe, expect, it } from 'vitest';
import type { BoardModel, ProjectGatesHistory } from '@pantheon/protocol';
import { nodes, text } from './web-hook-host.js';
import { bannerSegments } from '@/screens/board/progress-model';
import { TaskProgressStrip } from '@/screens/board/ProgressCharts';
import { gateTracker } from '@/screens/board/quality-model';
import { zh } from './i18n-setup.js';

type GateRun = ProjectGatesHistory['runs'][number];
const NOW = Date.UTC(2026, 10, 3, 12);
const run = (id: string, minutesAgo: number, results: GateRun['results']): GateRun => ({
  run_id: id,
  commit: `${id}0123456789abcdef`,
  started_at: new Date(NOW - minutesAgo * 60_000 - 10_000).toISOString(),
  finished_at: new Date(NOW - minutesAgo * 60_000).toISOString(),
  results,
  session_id: `session-${id}`,
  session_title: `title ${id}`,
});
const result = (name: string, patch: Partial<GateRun['results'][number]>) => ({
  name,
  command: ['pnpm', name],
  ...patch,
});

describe('gate tracker model', () => {
  const runs = [
    run('r3', 1, [
      result('lint', { exit_code: 0 }),
      result('test', { exit_code: 1 }),
      result('e2e', { timed_out: true, exit_code: null }),
    ]),
    run('r2', 10, [result('lint', { exit_code: 0 }), result('test', { skipped: true })]),
    run('r1', 20, [result('lint', { exit_code: 2 }), result('build', { exit_code: 0 })]),
  ];

  it('puts one row per command and one cell per run, the newest at the right', () => {
    const { columns, rows } = gateTracker(runs);
    expect(columns.map((c) => c.run_id)).toEqual(['r1', 'r2', 'r3']);
    expect(rows.map((r) => [r.name, r.cells.map((c) => c.state)])).toEqual([
      ['lint', ['failed', 'passed', 'passed']],
      ['test', ['absent', 'skipped', 'failed']],
      ['e2e', ['absent', 'absent', 'timed_out']],
      ['build', ['passed', 'absent', 'absent']],
    ]);
    expect(rows[0]!.cells.map((c) => c.exit_code)).toEqual([2, 0, 0]);
  });

  it('rates each command by the runs it ran in, without a rate when it never ran', () => {
    const { rows } = gateTracker([
      ...runs,
      run('r0', 30, [result('lint', { exit_code: 0 }), result('test', { skipped: true })]),
    ]);
    expect(rows.map((r) => [r.name, r.rate])).toEqual([
      ['lint', 0.75],
      ['test', 0],
      ['e2e', 0],
      ['build', 1],
    ]);
    const never = gateTracker([run('s', 1, [result('lint', { skipped: true })])]);
    expect(never.rows[0]!.rate).toBeNull();
  });

  it('keeps the latest thirty runs', () => {
    const many = Array.from({ length: 40 }, (_, i) => run(`n${i}`, i, [result('lint', {})]));
    const { columns } = gateTracker(many);
    expect(columns).toHaveLength(30);
    expect(columns.at(-1)!.run_id).toBe('n0');
  });
});

type Totals = BoardModel['task_progress']['totals'];
const totals = (patch: Partial<Totals>): Totals => ({
  done: 0,
  running: 0,
  waiting: 0,
  idle: 0,
  ready: 0,
  failed: 0,
  discarded: 0,
  not_started: 0,
  ...patch,
});

describe('task progress strip', () => {
  it('folds the states outside done, running, waiting and failed into other', () => {
    expect(
      bannerSegments(totals({ done: 3, running: 2, idle: 2, ready: 1, not_started: 4 })).map(
        (s) => [s.label, s.count],
      ),
    ).toEqual([
      [zh('board.taskTotals.done'), 3],
      [zh('board.taskTotals.running'), 2],
      [zh('board.taskTotals.other'), 7],
    ]);
  });

  it('keeps at most four parts, folding the smallest open state into other', () => {
    const parts = bannerSegments(
      totals({ done: 5, running: 3, waiting: 1, failed: 2, discarded: 1 }),
    );
    expect(parts.map((s) => [s.key, s.count])).toEqual([
      ['done', 5],
      ['running', 3],
      ['failed', 2],
      ['other', 2],
    ]);
    expect(bannerSegments(totals({ done: 1, running: 1, waiting: 1, failed: 1 }))).toHaveLength(4);
    expect(bannerSegments(totals({}))).toEqual([]);
  });

  it('labels each part with its count and draws no legend', () => {
    const strip = TaskProgressStrip({ totals: totals({ done: 3, waiting: 1 }) })!;
    expect(strip.props['aria-label']).toBe('任务进度：已完成 3，待处理 1');
    expect(
      nodes(strip)
        .filter((n) => n.type === 'i')
        .map((n) => n.props.className),
    ).toEqual(['bd-tpb bd-tp-done', 'bd-tpb bd-tp-waiting']);
    expect(text(strip)).toBe('31');
    expect(TaskProgressStrip({ totals: totals({}) })).toBeNull();
  });
});
