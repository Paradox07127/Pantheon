/** One task's cost under the first and the second condition. */
export interface CostPair {
  task: string;
  first: number;
  second: number;
}
export interface CostChange {
  pairs: number;
  tasks: number;
  /** The mean over tasks of second / first - 1; null without pairs. */
  change: number | null;
  interval: [number, number] | null;
}

/** Uniform numbers in [0, 1) from a 32-bit seed (mulberry32), so the same seed gives the same interval. */
function uniform(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * The mean over tasks of each task's cost change, second against first (-0.5 is half the cost),
 * and its percentile bootstrap interval from resampling tasks with replacement.
 * Costs are positive; a task's repetitions are summed. The eval report computes the same.
 */
export function costChange(
  pairs: CostPair[],
  { confidence, bootstrap }: { confidence: number; bootstrap: { resamples: number; seed: number } },
): CostChange {
  const tasks = new Map<string, { first: number; second: number }>();
  for (const { task, first, second } of pairs) {
    const sums = tasks.get(task) ?? { first: 0, second: 0 };
    tasks.set(task, { first: sums.first + first, second: sums.second + second });
  }
  const changes = [...tasks.values()].map(({ first, second }) => second / first - 1);
  if (!changes.length) return { pairs: 0, tasks: 0, change: null, interval: null };
  const next = uniform(bootstrap.seed);
  const means = Array.from({ length: bootstrap.resamples }, () =>
    mean(changes.map(() => changes[Math.floor(next() * changes.length)]!)),
  ).sort((a, b) => a - b);
  const tail = (1 - confidence) / 2;
  return {
    pairs: pairs.length,
    tasks: changes.length,
    change: mean(changes),
    interval: [
      means[Math.floor(tail * bootstrap.resamples)]!,
      means[Math.ceil((1 - tail) * bootstrap.resamples) - 1]!,
    ],
  };
}

/** P(X <= k) for X ~ Binomial(n, 0.5), summed in the eval report's order so both give the same bits. */
function atMostHalf(k: number, n: number) {
  let logChoose = 0,
    sum = 0;
  for (let i = 0; i <= k; i++) {
    if (i > 0) logChoose += Math.log((n - i + 1) / i);
    sum += Math.exp(logChoose + i * Math.log(0.5) + (n - i) * Math.log(1 - 0.5));
  }
  return sum;
}

/** The two-sided exact sign test of b against c discordant pairs. */
export function signTest(b: number, c: number) {
  if (b + c === 0) return 1;
  return Math.min(1, 2 * atMostHalf(Math.min(b, c), b + c));
}

/** One task's outcome under the first and the second condition: accepted, and its cost if reported. */
export interface OutcomePair {
  task: string;
  first: { accepted: boolean; cost: number | null };
  second: { accepted: boolean; cost: number | null };
}

/**
 * The verdicts over the pairs: pass by the exact sign test of discordant pairs at rule.alpha; cost
 * by the interval of costChange over the pairs accepted on both sides, with no conclusion while it
 * holds 0. A verdict names the better side, 'first' or 'second', or is 'no_conclusion'. The eval
 * report computes the same.
 */
export function comparePairs(
  pairs: OutcomePair[],
  rule: { alpha: number } & Parameters<typeof costChange>[1],
) {
  const onlyFirst = pairs.filter((pair) => pair.first.accepted && !pair.second.accepted).length;
  const onlySecond = pairs.filter((pair) => pair.second.accepted && !pair.first.accepted).length;
  const pValue = signTest(onlyFirst, onlySecond);
  // A runtime that reports no tokens records 0, which gives no cost to compare.
  const cost = costChange(
    pairs.flatMap(({ task, first, second }) =>
      first.accepted && second.accepted && (first.cost ?? 0) > 0 && (second.cost ?? 0) > 0
        ? [{ task, first: first.cost!, second: second.cost! }]
        : [],
    ),
    rule,
  );
  const [lower, upper] = cost.interval ?? [0, 0];
  type Side = 'first' | 'second' | 'no_conclusion';
  return {
    pass: {
      pairs: pairs.length,
      only_first: onlyFirst,
      only_second: onlySecond,
      p_value: pValue,
      verdict: (pValue >= rule.alpha
        ? 'no_conclusion'
        : onlyFirst > onlySecond
          ? 'first'
          : 'second') as Side,
    },
    cost: {
      ...cost,
      verdict: (upper < 0 ? 'second' : lower > 0 ? 'first' : 'no_conclusion') as Side,
    },
  };
}

export interface ArmsCostChange {
  /** The tasks of the first arm and of the second. */
  tasks: [number, number];
  /** The second arm's mean cost per task over the first's, minus 1; null while an arm has no task. */
  change: number | null;
  interval: [number, number] | null;
}

/**
 * The second arm's mean cost per task against the first's (-0.5 is half the cost), and its
 * percentile bootstrap interval from resampling each arm's tasks with replacement on its own.
 * The arms ran different tasks, so no task of one pairs with a task of the other.
 */
export function armsCostChange(
  first: number[],
  second: number[],
  { confidence, bootstrap }: { confidence: number; bootstrap: { resamples: number; seed: number } },
): ArmsCostChange {
  const tasks: [number, number] = [first.length, second.length];
  if (!first.length || !second.length) return { tasks, change: null, interval: null };
  const next = uniform(bootstrap.seed);
  const resampled = (costs: number[]) =>
    mean(costs.map(() => costs[Math.floor(next() * costs.length)]!));
  const changes = Array.from(
    { length: bootstrap.resamples },
    () => resampled(second) / resampled(first) - 1,
  ).sort((a, b) => a - b);
  const tail = (1 - confidence) / 2;
  return {
    tasks,
    change: mean(second) / mean(first) - 1,
    interval: [
      changes[Math.floor(tail * bootstrap.resamples)]!,
      changes[Math.ceil((1 - tail) * bootstrap.resamples) - 1]!,
    ],
  };
}
