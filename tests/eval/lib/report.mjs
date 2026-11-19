import { atLeast, atMost, comparePairs, signTest } from './paired-stats.mjs';

export { signTest };

/** The p in [0, 1] where the monotone f crosses target; rising says whether f increases with p. */
function bisect(f, target, rising) {
  let low = 0;
  let high = 1;
  for (let step = 0; step < 100; step++) {
    const middle = (low + high) / 2;
    if (f(middle) < target === rising) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

/** The exact (Clopper–Pearson) two-sided interval of k successes in n trials at the confidence. */
export function interval(k, n, confidence) {
  if (n === 0) return [0, 1];
  const tail = (1 - confidence) / 2;
  const lower = k === 0 ? 0 : bisect((p) => atLeast(k, n, p), tail, true);
  const upper = k === n ? 1 : bisect((p) => atMost(k, n, p), tail, false);
  return [lower, upper];
}

function median(values) {
  const known = values.filter((value) => value !== null).sort((a, b) => a - b);
  if (!known.length) return null;
  const middle = Math.floor(known.length / 2);
  return known.length % 2 ? known[middle] : (known[middle - 1] + known[middle]) / 2;
}

const leakedRun = (run) => run.outcome === 'merged' && run.hidden_passed === false;
const acceptedRun = (run) => run.outcome === 'merged' && run.hidden_passed === true;

/** Rates per condition and, with two conditions, the paired comparison and its verdict. */
export function summarize(runs, rule) {
  const names = [...new Set(runs.map((run) => run.condition))];
  const conditions = names.map((condition) => {
    const own = runs.filter((run) => run.condition === condition);
    const merged = own.filter((run) => run.outcome === 'merged').length;
    const leaked = own.filter(leakedRun).length;
    const completed = own.filter((run) => run.outcome === 'merged' && run.hidden_passed).length;
    const tokens = own.filter((run) => run.input_tokens !== null);
    return {
      condition,
      runs: own.length,
      merged,
      leaked,
      leak_rate: merged ? leaked / merged : null,
      leak_interval: interval(leaked, merged, rule.confidence),
      completed,
      completion_rate: completed / own.length,
      completion_interval: interval(completed, own.length, rule.confidence),
      median_task_turns: median(own.map((run) => run.task_turns)),
      median_gate_runs: median(own.map((run) => run.gate_runs)),
      median_wall_ms: median(own.map((run) => run.wall_ms)),
      median_input_tokens: median(own.map((run) => run.input_tokens)),
      // What one accepted run cost, the tokens of the runs that were not accepted included.
      input_tokens_per_accepted:
        completed && tokens.length
          ? tokens.reduce((sum, run) => sum + run.input_tokens, 0) / completed
          : null,
    };
  });
  // Their hidden_passed is true already, so they count as completed and not as leaked.
  const unstable = runs
    .filter((run) => run.hidden_unstable)
    .map(({ task, condition, repetition }) => ({ task, condition, repetition }));
  if (names.length !== 2) return { rule, conditions, unstable };

  const [first, second] = names;
  const key = (run) => JSON.stringify([run.task, run.repetition]);
  const partners = new Map(
    runs.filter((run) => run.condition === second).map((run) => [key(run), run]),
  );
  const leakedOnlyUnder = { [first]: 0, [second]: 0 };
  const paired = [];
  for (const run of runs.filter((row) => row.condition === first)) {
    const partner = partners.get(key(run));
    if (!partner) continue;
    paired.push({
      task: run.task,
      first: { accepted: acceptedRun(run), cost: run.input_tokens },
      second: { accepted: acceptedRun(partner), cost: partner.input_tokens },
    });
    if (leakedRun(run) && !leakedRun(partner)) leakedOnlyUnder[first]++;
    if (leakedRun(partner) && !leakedRun(run)) leakedOnlyUnder[second]++;
  }
  const pValue = signTest(leakedOnlyUnder[first], leakedOnlyUnder[second]);
  const fewer = leakedOnlyUnder[first] < leakedOnlyUnder[second] ? first : second;
  const { pass, cost } = comparePairs(paired, rule);
  const named = { first, second };
  return {
    rule,
    conditions,
    unstable,
    comparison: {
      pairs: paired.length,
      leaked_only_under: leakedOnlyUnder,
      p_value: pValue,
      verdict: pValue < rule.alpha ? `${fewer}_leaks_less` : 'no_conclusion',
      accepted_only_under: { [first]: pass.only_first, [second]: pass.only_second },
      pass_p_value: pass.p_value,
      pass_verdict:
        pass.verdict === 'no_conclusion' ? pass.verdict : `${named[pass.verdict]}_passes_more`,
      // Input tokens of the pairs accepted under both conditions: the second's change against the first's.
      cost: {
        ...cost,
        verdict: cost.verdict === 'no_conclusion' ? cost.verdict : `${named[cost.verdict]}_cheaper`,
      },
    },
  };
}

const percent = (value) => `${(value * 100).toFixed(1)}%`;
const rate = (k, n, value, [lower, upper]) =>
  value === null
    ? `${k}/${n}`
    : `${k}/${n} = ${percent(value)} [${percent(lower)}, ${percent(upper)}]`;
const cell = (value) => (value === null ? '—' : String(value));
const signed = (value) => `${value > 0 ? '+' : ''}${percent(value)}`;

/** The summary as Markdown. */
export function render(summary) {
  const confidence = percent(summary.rule.confidence);
  const lines = [
    `| Condition | Runs | Leak rate (${confidence} interval) | Completion rate (${confidence} interval) | Median task turns | Median gate runs | Median wall ms | Median input tokens | Input tokens per accepted run |`,
    '|---|---|---|---|---|---|---|---|---|',
    ...summary.conditions.map((row) =>
      [
        '',
        row.condition,
        row.runs,
        rate(row.leaked, row.merged, row.leak_rate, row.leak_interval),
        rate(row.completed, row.runs, row.completion_rate, row.completion_interval),
        cell(row.median_task_turns),
        cell(row.median_gate_runs),
        cell(row.median_wall_ms),
        cell(row.median_input_tokens),
        cell(
          row.input_tokens_per_accepted === null ? null : Math.round(row.input_tokens_per_accepted),
        ),
        '',
      ]
        .join(' | ')
        .trim(),
    ),
  ];
  const { comparison } = summary;
  if (comparison) {
    const [first, second] = Object.keys(comparison.leaked_only_under);
    lines.push(
      '',
      `Paired by task and repetition: ${comparison.pairs} pairs. ` +
        `Leaked only under ${first}: ${comparison.leaked_only_under[first]}; ` +
        `only under ${second}: ${comparison.leaked_only_under[second]}. ` +
        `Exact sign test, two-sided: p = ${comparison.p_value.toFixed(4)}.`,
      '',
      comparison.verdict === 'no_conclusion'
        ? 'No conclusion.'
        : `Verdict: ${comparison.verdict.slice(0, -'_leaks_less'.length)} leaks less.`,
    );
    const { cost } = comparison;
    const [lower, upper] = cost.interval ?? [];
    lines.push(
      '',
      `Accepted (merged, hidden check passed) only under ${first}: ${comparison.accepted_only_under[first]}; ` +
        `only under ${second}: ${comparison.accepted_only_under[second]}. ` +
        `Exact sign test, two-sided: p = ${comparison.pass_p_value.toFixed(4)}.`,
      '',
      comparison.pass_verdict === 'no_conclusion'
        ? 'No conclusion.'
        : `Verdict: ${comparison.pass_verdict.slice(0, -'_passes_more'.length)} passes more.`,
      '',
      cost.change === null
        ? 'Input tokens per accepted run: no pair was accepted under both conditions with its tokens reported.'
        : `Input tokens per accepted run, ${second} against ${first}, ${cost.pairs} pairs over ${cost.tasks} tasks: ` +
            `${signed(cost.change)} [${signed(lower)}, ${signed(upper)}] (${confidence} bootstrap interval over tasks).`,
      '',
      cost.verdict === 'no_conclusion'
        ? 'No conclusion.'
        : cost.verdict === `${second}_cheaper`
          ? `Verdict: ${second} cheaper by ${percent(-cost.change)} [${percent(-upper)}, ${percent(-lower)}].`
          : `Verdict: ${first} cheaper; ${second} costs ${percent(cost.change)} more [${percent(lower)}, ${percent(upper)}].`,
    );
  }
  if (summary.unstable.length) {
    lines.push(
      '',
      'Hidden check failed once and passed on its second try:',
      '',
      ...summary.unstable.map(
        (run) => `- \`${run.task}\`, \`${run.condition}\`, repetition ${run.repetition}`,
      ),
    );
  }
  return `${lines.join('\n')}\n`;
}
