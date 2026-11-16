import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTask } from '../tests/eval/lib/check.mjs';
import { render, summarize } from '../tests/eval/lib/report.mjs';
import { loadTasks } from '../tests/eval/lib/tasks.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [command, ...names] = process.argv.slice(2);

const rule = {
  confidence: 0.95,
  interval: 'clopper-pearson',
  paired_test: 'exact sign test, two-sided',
  alpha: 0.05,
};
// A run has settled when no event arrives for QUIET_MS and no turn is queued or running.
const QUIET_MS = 2000;
const SETTLE_MS = 60000;
// A frozen task's merge builds and tests a whole Pantheon tree.
const FROZEN_QUIET_MS = 30000;
const FROZEN_SETTLE_MS = 3600000;
const usage =
  'usage: node scripts/eval.mjs check [task-name...] | run --runtime fixture|reference|codex|claude [--task <name>]... [--repetitions <n>] [--workspace <dir>] [--out <dir>] | report <run-dir>';

const writeReport = (out, runs, rule) => {
  const report = render(summarize(runs, rule));
  fs.writeFileSync(path.join(out, 'report.md'), report);
  console.log(report);
};

if (command === 'run') {
  const option = (name) => {
    const index = names.indexOf(name);
    return index === -1 ? undefined : names[index + 1];
  };
  const refuse = (message) => {
    console.error(message);
    process.exit(2);
  };
  // An option without its value would otherwise select the default: every task, or the default directory.
  if (names.some((name, index) => name.startsWith('--') && !/^[^-]/.test(names[index + 1] ?? '')))
    refuse(usage);
  const runtime = option('--runtime');
  if (!['fixture', 'reference', 'codex', 'claude'].includes(runtime)) refuse(usage);
  const real = runtime === 'codex' || runtime === 'claude';
  const repetitions = Number(option('--repetitions') ?? 1);
  if (!Number.isInteger(repetitions) || repetitions < 1) refuse(usage);
  // A real runtime reads the whole disk, and the checkout holds each task's source commit and hidden test.
  const workspaceRoot = path.resolve(
    option('--workspace') ??
      (real ? path.join(os.homedir(), '.pantheon-eval') : path.join(repoRoot, '.eval-work')),
  );
  if (real && !path.relative(repoRoot, workspaceRoot).startsWith('..'))
    refuse(`a ${runtime} run needs --workspace <dir> outside this checkout`);
  // Loaded here so `check` does not need the built packages the daemon runs on.
  const fixtureTasks = await import('../tests/eval/lib/fixture-tasks.mjs');
  const frozenTasks = await import('../tests/eval/lib/frozen-tasks.mjs');
  const { runOne } = await import('../tests/eval/lib/run.mjs');
  const { ClaudeAdapter, CodexAdapter, FixtureAdapter } = await import('@pantheon/adapters');
  // Each job is a task, a condition, a repetition and the runOne spec for a workspace.
  const jobs =
    runtime === 'fixture'
      ? Object.keys(fixtureTasks.behaviours).flatMap((name) =>
          Object.entries(fixtureTasks.conditions).map(([condition, beforeMerge]) => ({
            task: name,
            condition,
            repetition: 0,
            spec: (workspace) => ({
              createRepo: fixtureTasks.createRepo,
              adapters: fixtureTasks.adapters(),
              leadRuntime: fixtureTasks.leadRuntime,
              task: fixtureTasks.task(name, path.join(workspace, 'repo')),
              gate: fixtureTasks.gate,
              beforeMerge,
              hiddenCheck: fixtureTasks.hiddenCheck,
              settleMs: SETTLE_MS,
              quietMs: QUIET_MS,
            }),
          })),
        )
      : Array.from({ length: repetitions }, (_, repetition) =>
          loadTasks(
            path.join(repoRoot, 'tests/eval/tasks'),
            names.filter((_, index) => names[index - 1] === '--task'),
          ).map((task) => ({
            task: task.name,
            condition: 'default',
            repetition,
            spec: () => ({
              createRepo: frozenTasks.createRepo(repoRoot, task),
              adapters: [
                new FixtureAdapter(),
                runtime === 'reference'
                  ? frozenTasks.referenceAdapter(repoRoot, task)
                  : runtime === 'codex'
                    ? new CodexAdapter()
                    : new ClaudeAdapter(),
              ],
              realHome: real,
              checkout: repoRoot,
              leadRuntime: fixtureTasks.leadRuntime,
              task: frozenTasks.planTask(task, runtime),
              gate: frozenTasks.gate,
              beforeMerge: [],
              hiddenCheck: frozenTasks.hiddenCheck(repoRoot, task),
              settleMs: FROZEN_SETTLE_MS,
              quietMs: FROZEN_QUIET_MS,
            }),
          })),
        ).flat();
  const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '') + 'Z';
  const out = path.resolve(
    repoRoot,
    option('--out') ?? path.join('.notes/evidence/eval', `${stamp}-${runtime}`),
  );
  if (fs.existsSync(path.join(out, 'runs.jsonl')))
    refuse(`${out} already holds the runs of an earlier run`);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'rule.json'), `${JSON.stringify(rule, null, 2)}\n`);
  // The product refuses managed workspaces below the system temporary directory, and `tsc -b`
  // refuses a Pantheon tree below node_modules/.cache (TS6305).
  const parent = runtime === 'fixture' ? path.join(repoRoot, 'node_modules/.cache') : workspaceRoot;
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'eval-run-'));
  const runs = [];
  try {
    for (const { task, condition, repetition, spec } of jobs) {
      // A short name: a task goal that holds a path below it must stay within the goal's 400 characters.
      const workspace = fs.mkdtempSync(path.join(root, 'run-'));
      const result = await runOne({ workspace, ...spec(workspace) });
      const row = { task, condition, repetition, runtime, ...result };
      runs.push(row);
      fs.appendFileSync(path.join(out, 'runs.jsonl'), `${JSON.stringify(row)}\n`);
      const hidden =
        row.outcome === 'merged' ? `, hidden ${row.hidden_passed ? 'passed' : 'failed'}` : '';
      console.log(`${task} ${condition}: ${row.outcome}${hidden}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  writeReport(out, runs, rule);
  if (runtime !== 'fixture') {
    const missed =
      runtime === 'reference'
        ? runs.filter((run) => run.outcome !== 'merged' || !run.hidden_passed)
        : [];
    for (const run of missed)
      console.error(
        `${run.task} repetition ${run.repetition}: expected merged with the hidden check passed, got ${run.outcome}, hidden_passed ${run.hidden_passed}, stopped_by ${run.stopped_by}`,
      );
    console.log(`runs written to ${out}`);
    process.exit(missed.length ? 1 : 0);
  }
  const { conditions } = summarize(runs, rule);
  const differences = Object.entries(fixtureTasks.knownAnswers).flatMap(([condition, known]) => {
    const row = conditions.find((summary) => summary.condition === condition);
    const leaking = runs
      .filter(
        (run) => run.condition === condition && run.outcome === 'merged' && !run.hidden_passed,
      )
      .map((run) => run.task);
    return [
      ...['runs', 'merged', 'leaked']
        .filter((field) => row?.[field] !== known[field])
        .map(
          (field) => `${condition} ${field}: expected ${known[field]}, got ${row?.[field] ?? 0}`,
        ),
      ...(leaking.join() === known.leaking.join()
        ? []
        : [`${condition} leaking: expected [${known.leaking}], got [${leaking}]`]),
    ];
  });
  for (const difference of differences) console.error(difference);
  console.log(`runs written to ${out}`);
  process.exit(differences.length ? 1 : 0);
}

if (command === 'report' && names[0]) {
  const out = path.resolve(names[0]);
  const runs = fs
    .readFileSync(path.join(out, 'runs.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  writeReport(out, runs, JSON.parse(fs.readFileSync(path.join(out, 'rule.json'), 'utf8')));
  process.exit(0);
}

if (command !== 'check') {
  console.error(usage);
  process.exit(2);
}

let rejected = false;
for (const task of loadTasks(path.join(repoRoot, 'tests/eval/tasks'), names)) {
  const result = checkTask(repoRoot, task);
  console.log(
    `${result.name}: base ${result.base}, source ${result.source}${result.ok ? '' : ' — rejected'}`,
  );
  if (!result.ok) {
    rejected = true;
    console.error(result.output.split('\n').slice(-40).join('\n'));
  }
}
process.exit(rejected ? 1 : 0);
