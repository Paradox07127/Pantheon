import { describe, expect, it } from 'vitest';

type Run = {
  task: string;
  condition: string;
  repetition: number;
  outcome: 'merged' | 'blocked' | 'failed';
  hidden_passed: boolean | null;
  hidden_unstable?: boolean | null;
  task_turns: number;
  gate_runs: number;
  wall_ms: number;
  input_tokens: number | null;
};
type Condition = {
  condition: string;
  runs: number;
  merged: number;
  leaked: number;
  leak_rate: number | null;
  completion_rate: number;
};
type Summary = {
  conditions: Condition[];
  comparison?: {
    leaked_only_under: Record<string, number>;
    p_value: number;
    verdict: string;
  };
};
// The tests project only typechecks the scripts it lists, so this module is imported by URL.
const {
  interval,
  signTest,
  summarize,
  render,
}: {
  interval(k: number, n: number, confidence: number): [number, number];
  signTest(b: number, c: number): number;
  summarize(runs: Run[], rule: { confidence: number; alpha: number }): Summary;
  render(summary: Summary): string;
} = await import(new URL('../eval/lib/report.mjs', import.meta.url).href);

const rule = { confidence: 0.95, alpha: 0.05 };
const run = (
  task: string,
  outcome: Run['outcome'],
  hidden_passed: boolean | null,
  condition = 'acceptance_only',
): Run => ({
  task,
  condition,
  repetition: 0,
  outcome,
  hidden_passed,
  task_turns: 1,
  gate_runs: outcome === 'merged' ? 1 : 0,
  wall_ms: 100,
  input_tokens: null,
});
// Three merges, one of which fails the hidden check, and four runs that never merge.
const mixed = [
  run('passes', 'merged', true),
  run('also_passes', 'merged', true),
  run('leaks', 'merged', false),
  run('blocked_one', 'blocked', null),
  run('blocked_two', 'blocked', null),
  run('failed_one', 'failed', null),
  run('failed_two', 'failed', null),
];

describe('the exact binomial interval', () => {
  it('starts at zero with no successes', () => {
    const [lower, upper] = interval(0, 16, 0.95);
    expect(lower).toBe(0);
    expect(upper).toBeGreaterThan(0.205);
    expect(upper).toBeLessThan(0.207);
  });

  it('puts the lower bound of four in sixteen near seven percent', () => {
    const [lower] = interval(4, 16, 0.95);
    expect(lower).toBeGreaterThan(0.072);
    expect(lower).toBeLessThan(0.074);
  });

  it('spans everything with no trials', () => {
    expect(interval(0, 0, 0.95)).toEqual([0, 1]);
  });
});

describe('the exact sign test', () => {
  it('gives the two-sided binomial tail of the smaller count', () => {
    expect(signTest(0, 5)).toBeCloseTo(0.0625, 10);
    expect(signTest(3, 3)).toBe(1);
    expect(signTest(0, 0)).toBe(1);
  });
});

describe('the summary of runs', () => {
  it('divides leaks by merges and completions by runs', () => {
    const [condition] = summarize(mixed, rule).conditions;
    expect(condition).toMatchObject({ runs: 7, merged: 3, leaked: 1 });
    expect(condition?.leak_rate).toBeCloseTo(1 / 3, 10);
    expect(condition?.completion_rate).toBeCloseTo(2 / 7, 10);
  });

  it('draws no conclusion from two conditions with the same results', () => {
    const runs = [...mixed, ...mixed.map((row) => ({ ...row, condition: 'independent_check' }))];
    const { comparison } = summarize(runs, rule);
    expect(comparison?.leaked_only_under).toEqual({ acceptance_only: 0, independent_check: 0 });
    expect(comparison?.verdict).toBe('no_conclusion');
    expect(render(summarize(runs, rule))).toContain('No conclusion');
  });

  it('names the condition that leaks less when six pairs all leak under the other', () => {
    const tasks = ['one', 'two', 'three', 'four', 'five', 'six'];
    const runs = [
      ...tasks.map((task) => run(task, 'merged', false)),
      ...tasks.map((task) => run(task, 'merged', true, 'independent_check')),
    ];
    const { comparison } = summarize(runs, rule);
    expect(comparison?.leaked_only_under).toEqual({ acceptance_only: 6, independent_check: 0 });
    expect(comparison?.p_value).toBeCloseTo(0.03125, 10);
    expect(comparison?.verdict).toBe('independent_check_leaks_less');
  });
});

describe('runs whose hidden check passed on its second try', () => {
  const unstable = { ...run('flaky', 'merged', true), repetition: 2, hidden_unstable: true };

  it('are not leaks and are listed by task, condition and repetition', () => {
    const summary = summarize([...mixed, unstable], rule);
    expect(summary.conditions[0]).toMatchObject({ merged: 4, leaked: 1 });
    expect(render(summary)).toMatch(/second try[\s\S]*`flaky`.*`acceptance_only`.*repetition 2/);
  });

  it('add no section to a report without them', () => {
    expect(render(summarize(mixed, rule))).not.toContain('second try');
  });
});
