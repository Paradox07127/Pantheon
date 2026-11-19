// Statistics of two conditions run in pairs on the same tasks. No imports, so the module can be
// ported as it is.

/** P(X = i) for every i of X ~ Binomial(n, p), in log space so large n does not underflow. */
function binomial(n, p) {
  const terms = [];
  let logChoose = 0;
  for (let i = 0; i <= n; i++) {
    if (i > 0) logChoose += Math.log((n - i + 1) / i);
    terms.push(
      p === 0
        ? i === 0
          ? 1
          : 0
        : p === 1
          ? i === n
            ? 1
            : 0
          : Math.exp(logChoose + i * Math.log(p) + (n - i) * Math.log(1 - p)),
    );
  }
  return terms;
}

export const atMost = (k, n, p) =>
  binomial(n, p)
    .slice(0, k + 1)
    .reduce((sum, term) => sum + term, 0);
export const atLeast = (k, n, p) =>
  binomial(n, p)
    .slice(k)
    .reduce((sum, term) => sum + term, 0);

/** The two-sided exact sign test of b against c discordant pairs. */
export function signTest(b, c) {
  if (b + c === 0) return 1;
  return Math.min(1, 2 * atMost(Math.min(b, c), b + c, 0.5));
}

/** Uniform numbers in [0, 1) from a 32-bit seed (mulberry32), so the same seed gives the same interval. */
function uniform(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * The mean over tasks of each task's cost change, second against first (-0.5 is half the cost),
 * and its percentile bootstrap interval from resampling tasks with replacement.
 * pairs: { task, first, second } with positive costs; a task's repetitions are summed.
 */
export function costChange(pairs, { confidence, bootstrap }) {
  const tasks = new Map();
  for (const { task, first, second } of pairs) {
    const sums = tasks.get(task) ?? { first: 0, second: 0 };
    tasks.set(task, { first: sums.first + first, second: sums.second + second });
  }
  const changes = [...tasks.values()].map(({ first, second }) => second / first - 1);
  if (!changes.length) return { pairs: 0, tasks: 0, change: null, interval: null };
  const next = uniform(bootstrap.seed);
  const means = Array.from({ length: bootstrap.resamples }, () =>
    mean(changes.map(() => changes[Math.floor(next() * changes.length)])),
  ).sort((a, b) => a - b);
  const tail = (1 - confidence) / 2;
  return {
    pairs: pairs.length,
    tasks: changes.length,
    change: mean(changes),
    interval: [
      means[Math.floor(tail * bootstrap.resamples)],
      means[Math.ceil((1 - tail) * bootstrap.resamples) - 1],
    ],
  };
}

/**
 * The verdicts over pairs { task, first, second }, each side { accepted, cost }: pass by the
 * exact sign test of discordant pairs at rule.alpha; cost by the interval of costChange over the
 * pairs accepted on both sides, with no conclusion while it holds 0. A verdict names the better
 * side, 'first' or 'second', or is 'no_conclusion'.
 */
export function comparePairs(pairs, rule) {
  const onlyFirst = pairs.filter((pair) => pair.first.accepted && !pair.second.accepted).length;
  const onlySecond = pairs.filter((pair) => pair.second.accepted && !pair.first.accepted).length;
  const pValue = signTest(onlyFirst, onlySecond);
  // A runtime that reports no tokens records 0, which gives no cost to compare.
  const cost = costChange(
    pairs
      .filter(
        ({ first, second }) =>
          first.accepted && second.accepted && first.cost > 0 && second.cost > 0,
      )
      .map(({ task, first, second }) => ({ task, first: first.cost, second: second.cost })),
    rule,
  );
  const [lower, upper] = cost.interval ?? [0, 0];
  return {
    pass: {
      pairs: pairs.length,
      only_first: onlyFirst,
      only_second: onlySecond,
      p_value: pValue,
      verdict: pValue >= rule.alpha ? 'no_conclusion' : onlyFirst > onlySecond ? 'first' : 'second',
    },
    cost: {
      ...cost,
      verdict: upper < 0 ? 'second' : lower > 0 ? 'first' : 'no_conclusion',
    },
  };
}
