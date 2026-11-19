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
