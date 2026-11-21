import { describe, expect, it } from 'vitest';
import type { ProjectGatesHistory } from '@pantheon/protocol';
import { nodes, text } from './web-hook-host.js';
import { gateTracker } from '@/lib/gate-model';
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
