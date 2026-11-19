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
  input_tokens_per_accepted?: number | null;
};
type Summary = {
  conditions: Condition[];
  comparison?: {
    leaked_only_under: Record<string, number>;
    p_value: number;
    verdict: string;
    accepted_only_under?: Record<string, number>;
    pass_p_value?: number;
    pass_verdict?: string;
    cost?: {
      pairs: number;
      tasks: number;
      change: number | null;
      interval: [number, number] | null;
      verdict: string;
    };
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
  summarize(
    runs: Run[],
    rule: {
      confidence: number;
      alpha: number;
      bootstrap?: { resamples: number; seed: number };
    },
  ): Summary;
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

describe('the paired comparison of accepted runs and their cost', () => {
  const pairedRule = { ...rule, bootstrap: { resamples: 10000, seed: 1 } };
  const tasks = Array.from({ length: 12 }, (_, index) => `task_${index}`);
  // Twelve tasks accepted under both conditions; the second costs the first's cost times factor(i).
  const paired = (factor: (index: number) => number) => [
    ...tasks.map((task, index) => ({
      ...run(task, 'merged', true),
      input_tokens: 1000 + 100 * index,
    })),
    ...tasks.map((task, index) => ({
      ...run(task, 'merged', true, 'independent_check'),
      input_tokens: (1000 + 100 * index) * factor(index),
    })),
  ];

  it('draws no conclusion on cost from twelve pairs with no effect', () => {
    const summary = summarize(
      paired((index) => (index % 2 ? 1.1 : 0.9)),
      pairedRule,
    );
    const cost = summary.comparison?.cost;
    expect(cost).toMatchObject({ pairs: 12, tasks: 12, verdict: 'no_conclusion' });
    expect(cost?.change).toBeCloseTo(0, 10);
    expect(cost?.interval?.[0]).toBeLessThan(0);
    expect(cost?.interval?.[1]).toBeGreaterThan(0);
    expect(render(summary)).toMatch(/12 pairs over 12 tasks: [^\n]*\n\nNo conclusion\./);
  });

  it('finds the second condition cheaper from a 50% cut over twelve pairs', () => {
    const summary = summarize(
      paired((index) => (index % 2 ? 0.55 : 0.45)),
      pairedRule,
    );
    const cost = summary.comparison?.cost;
    expect(cost?.verdict).toBe('independent_check_cheaper');
    expect(cost?.change).toBeCloseTo(-0.5, 10);
    expect(cost?.interval?.[1]).toBeLessThan(0);
    expect(render(summary)).toContain('Verdict: independent_check cheaper by 50.0% [');
  });

  it('gives the same interval from the same seed', () => {
    const runs = paired((index) => (index % 3 ? 0.8 : 1.3));
    const interval = summarize(runs, pairedRule).comparison?.cost?.interval;
    expect(interval).toHaveLength(2);
    expect(summarize(runs, pairedRule).comparison?.cost?.interval).toEqual(interval);
  });

  it('names the condition accepted more when six pairs pass only under it', () => {
    const six = tasks.slice(0, 6);
    const summary = summarize(
      [
        ...six.map((task) => run(task, 'failed', null)),
        ...six.map((task) => run(task, 'merged', true, 'independent_check')),
      ],
      pairedRule,
    );
    expect(summary.comparison?.accepted_only_under).toEqual({
      acceptance_only: 0,
      independent_check: 6,
    });
    expect(summary.comparison?.pass_verdict).toBe('independent_check_passes_more');
    expect(summary.comparison?.cost?.verdict).toBe('no_conclusion');
    expect(render(summary)).toContain('Verdict: independent_check passes more.');
  });

  it('divides the input tokens of all runs by the accepted runs', () => {
    const [condition] = summarize(
      [
        { ...run('passes', 'merged', true), input_tokens: 300 },
        { ...run('leaks', 'merged', false), input_tokens: 200 },
        { ...run('fails', 'failed', null), input_tokens: 100 },
      ],
      pairedRule,
    ).conditions;
    expect(condition?.input_tokens_per_accepted).toBe(600);
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
