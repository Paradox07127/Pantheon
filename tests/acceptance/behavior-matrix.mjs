import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { FixtureAdapter } from '@pantheon/adapters';
import { startNativeDaemon } from './lib/daemon.mjs';
import { waitFor } from './lib/event-client.mjs';
import { writeEvidence } from './lib/evidence.mjs';

// Scripted task behaviours × workflow structures on the fixture runtime; no model runs.
// It measures what each structure lets through and what it costs, not how often a model errs.
// Run from the repository root after `pnpm build`.
const repoRoot = process.cwd();
const evidenceDir = path.join(repoRoot, '.notes/evidence/behavior-matrix');
const root = mkdtempSync(path.join(repoRoot, 'node_modules/.cache/behavior-matrix-'));
const FILE = 'greeting.txt';
const EXPECTED = 'hello';
// The file a task session tries to write into the project's own checkout, outside its worktree.
const ESCAPED = 'outside.txt';
const GOAL = `Write ${EXPECTED} to ${FILE}`;
// A cell has settled when no event arrives for this long and no turn is queued or running.
const QUIET_MS = 2000;
const SETTLE_MS = 60000;
// Wall time is the only measured cost that varies between runs, so the correct behaviour runs this many times.
const COST_RUNS = 5;
// The goal the lead changes the task to; it carries no script, so the task session does no work for it.
const CHANGED_GOAL = `Write welcome to ${FILE}`;
// How long the task turn or the gate stays open for a goal change to land inside it; shorter than QUIET_MS, so a cell cannot settle while it is open.
const HOLD_MS = 1500;
/** When the lead changes the goal of a task whose session completes the first goal correctly. */
const goalChanges = ['before_report', 'after_report_before_merge', 'during_merge'];

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;
const write = (file, text) => ({ write: { path: file, text: `${text}\n` } });
const commit = { commit: GOAL };
const reportDone = { tool: { name: 'report', arguments: { kind: 'done', text: 'Done' } } };

/** What the task session does in its first turn; `correct` says whether the behaviour leaves the expected file, and nothing else, to merge. */
const behaviours = {
  completes_correctly: { correct: true, steps: () => [write(FILE, EXPECTED), commit, reportDone] },
  ends_without_artifact: { correct: false, steps: () => [{ say: 'Done' }, reportDone] },
  writes_wrong_content: {
    correct: false,
    steps: () => [write(FILE, 'goodbye'), commit, reportDone],
  },
  leaves_work_uncommitted: { correct: false, steps: () => [write(FILE, EXPECTED), reportDone] },
  writes_outside_scope: {
    correct: false,
    steps: () => [write(FILE, EXPECTED), write('notes.txt', 'scratch'), commit, reportDone],
  },
  writes_into_source_checkout: {
    correct: true,
    steps: (repo) => [
      { write_outside: { path: path.join(repo, ESCAPED), text: 'escaped\n' } },
      write(FILE, EXPECTED),
      commit,
      reportDone,
    ],
  },
  turn_fails: { correct: false, steps: () => [{ fail: 'Usage limit reached' }] },
};

/** Steps of the before_merge slot; the task's own acceptance command (`test -f`) is in every structure. */
const structures = {
  acceptance_only: [],
};

async function runCell(behaviour, structure, goalChange) {
  const workspace = mkdtempSync(path.join(root, `${behaviour}--${structure}-`));
  const repo = path.join(workspace, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Behaviour Matrix');
  git(repo, 'config', 'user.email', 'behaviour-matrix@example.invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repo, 'README.md'), 'Behaviour matrix\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-q', '-m', 'Initial commit');

  const adapter = new FixtureAdapter();
  // With protection paths the task session gets its sandbox; without them the fixture refuses no write.
  const home = path.join(workspace, 'home');
  mkdirSync(home);
  const fixture = await startNativeDaemon(workspace, [adapter], { intervalMs: 50, home });
  const { daemon } = fixture;
  const get = async (method, params) => {
    const response = await fetch(`${daemon.url}/v1/${method}?${new URLSearchParams(params)}`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`${method}: ${JSON.stringify(data)}`);
    return data;
  };
  try {
    const project = await fixture.call('project.open', { name: 'Behaviour matrix', roots: [repo] });
    const params = { project_id: project.id };
    const revision = async () =>
      (await get('board', params)).projects.find((row) => row.id === project.id).revision;
    await fixture.call(
      'project.gate.set',
      {
        project_id: project.id,
        root: project.roots[0],
        commands: [
          {
            name: 'Passes',
            argv: [
              process.execPath,
              '-e',
              `setTimeout(() => process.exit(0), ${goalChange === 'during_merge' ? HOLD_MS : 0})`,
            ],
          },
        ],
      },
      project.revision,
    );
    await fixture.call(
      'project.autoMerge.set',
      // Without auto-merge the reported work waits, so the goal can change before a merge starts.
      { project_id: project.id, enabled: goalChange !== 'after_report_before_merge' },
      await revision(),
    );
    await fixture.call(
      'project.sessionDefaults.set',
      { project_id: project.id, runtime: adapter.name, permission_mode: 'auto_edit' },
      await revision(),
    );
    const steps = behaviours[behaviour].steps(repo);
    const plan = {
      base_version: 0,
      headline: 'Behaviour matrix',
      lanes: [{ id: 'main', title: 'Main' }],
      tasks: [
        {
          id: 'A',
          title: 'Task A',
          goal: `${GOAL}\n${script(...(goalChange === 'before_report' ? [{ wait: HOLD_MS }, ...steps] : steps))}`,
          lane: 'main',
          milestone: 'M',
          depends_on: [],
          source: [GOAL],
          scope: [FILE],
          acceptance: [`test -f ${FILE}`],
          path: 'dispatch',
          flow_reason: 'The task runs in a session of its own',
        },
      ],
      milestones: [{ id: 'M', title: 'Milestone M', criteria: ['A is merged'], tasks: ['A'] }],
      risks: [],
      assumptions: [],
    };
    const lead = await fixture.call('session.create', {
      project_id: project.id,
      runtime: adapter.name,
      purpose: 'lead',
      input: script(
        { tool: { name: 'update_board', arguments: plan } },
        { tool: { name: 'start_task', arguments: { task_ids: ['A'] } } },
      ),
    });
    const events = async () => {
      const all = [];
      for (let after = 0; ;) {
        const page = await get('events', { after: String(after), ...params });
        if (!page.events.length) return all;
        all.push(...page.events);
        after = page.events.at(-1).sequence;
      }
    };
    const taskSession = await waitFor(
      async () =>
        (await events()).find((event) => event.kind === 'task.dispatched')?.payload.session_id ??
        false,
      `the task session of ${behaviour} under ${structure}`,
      SETTLE_MS,
    );
    let mergeRequest;
    if (goalChange) {
      const seen = (kind) =>
        waitFor(
          async () => (await events()).some((event) => event.kind === kind),
          `${kind} before the goal change ${goalChange}`,
          SETTLE_MS,
        );
      const version = async () => (await get('project.read', params)).plans[0].plan_version;
      const sessionRevision = async (id) =>
        (await get('board', params)).sessions.find((row) => row.id === id).revision;
      if (goalChange === 'after_report_before_merge') await seen('task.reported');
      if (goalChange === 'during_merge') await seen('session.gate_started');
      // The lead takes a new turn only once the turn that dispatched the task has ended.
      await waitFor(
        async () =>
          (await get('board', params)).session_turns.every(
            (turn) => turn.session_id !== lead.id || !['queued', 'running'].includes(turn.state),
          ),
        'the end of the lead turn before the goal change',
        SETTLE_MS,
      );
      const before = await version();
      await fixture.call(
        'session.send',
        {
          session_id: lead.id,
          input: script({
            tool: {
              name: 'update_board',
              arguments: {
                ...plan,
                base_version: before,
                tasks: [{ ...plan.tasks[0], goal: CHANGED_GOAL }],
              },
            },
          }),
        },
        await sessionRevision(lead.id),
      );
      if (goalChange === 'after_report_before_merge') {
        await waitFor(async () => (await version()) > before, 'the plan with the changed goal');
        // The task session is told of the changed goal in a turn of its own; a merge waits for that turn.
        await waitFor(
          async () =>
            (await events()).some((event) => event.kind === 'session.contract_notified') &&
            (await get('board', params)).session_turns.every(
              (turn) => !['queued', 'running'].includes(turn.state),
            ),
          'the end of the turn that tells the task session of the changed goal',
          SETTLE_MS,
        );
        mergeRequest = await fixture
          .call('session.merge', { session_id: taskSession }, await sessionRevision(taskSession))
          .then(
            () => 'accepted',
            (error) => JSON.parse(error.message).data.error,
          );
      }
    }
    const started = Date.now();
    let all = await events(),
      changed = Date.now(),
      settled = false;
    while (Date.now() - started < SETTLE_MS) {
      await delay(100);
      const next = await events();
      if (next.length !== all.length) {
        all = next;
        changed = Date.now();
        continue;
      }
      const turns = (await get('board', params)).session_turns;
      if (
        Date.now() - changed >= QUIET_MS &&
        turns.every((turn) => !['queued', 'running'].includes(turn.state))
      ) {
        settled = true;
        break;
      }
    }

    const board = await get('board', params);
    const needsYou = (await get('needs_you.list', params)).items.map((item) => item.kind);
    const mainFiles = git(repo, 'ls-tree', '--name-only', 'main').trim().split('\n');
    const of = (kind) => all.filter((event) => event.kind === kind);
    const blocked = of('session.merge_blocked').at(-1)?.payload;
    const merged = of('session.merged').some((event) => event.aggregate_id === taskSession);
    const turnsOf = (id) => board.session_turns.filter((turn) => turn.session_id === id);
    return {
      behaviour,
      structure,
      ...(goalChange
        ? {
            goal_change: goalChange,
            task_state: (await get('project.read', params)).plans[0].tasks[0].state,
            ...(mergeRequest ? { merge_request: mergeRequest } : {}),
          }
        : {}),
      settled,
      merged,
      main_correct:
        mainFiles.length === 2 &&
        mainFiles.includes(FILE) &&
        git(repo, 'show', `main:${FILE}`) === `${EXPECTED}\n`,
      escaped_write_landed: existsSync(path.join(repo, ESCAPED)),
      stopped_by: merged
        ? null
        : blocked
          ? [blocked.reason, blocked.gate?.name].filter(Boolean).join(': ')
          : of('session.merge_skipped').length
            ? of('session.merge_skipped').at(-1).payload.reason
            : of('turn.failed').length
              ? 'turn_failed'
              : 'unknown',
      task_turns: turnsOf(taskSession).length,
      lead_wakes: turnsOf(lead.id).filter((turn) => turn.origin === 'tracker').length,
      gate_runs: of('session.gate_checked').length,
      needs_you: needsYou,
      wall_ms: changed - started,
      events: all,
    };
  } finally {
    await fixture.close();
  }
}

const cells = [];
const costRuns = [];
const goalChangeCells = [];
try {
  for (const behaviour of Object.keys(behaviours))
    for (const structure of Object.keys(structures)) {
      const cell = await runCell(behaviour, structure);
      console.log(
        `${behaviour} / ${structure}: merged=${cell.merged} stopped_by=${cell.stopped_by} main_correct=${cell.main_correct}`,
      );
      cells.push(cell);
    }
  for (let run = 1; run < COST_RUNS; run++)
    for (const structure of Object.keys(structures))
      costRuns.push(await runCell('completes_correctly', structure));
  for (const moment of goalChanges) {
    const cell = await runCell('completes_correctly', 'acceptance_only', moment);
    console.log(
      `goal change ${moment}: merged=${cell.merged} stopped_by=${cell.stopped_by} task_state=${cell.task_state}`,
    );
    goalChangeCells.push(cell);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

const cell = (behaviour, structure) =>
  cells.find((row) => row.behaviour === behaviour && row.structure === structure);
/** A wrong result on main, or a write that reached the project's checkout. */
const harmful = (row) => (row.merged && !row.main_correct) || row.escaped_write_landed;
const summary = Object.keys(structures).map((structure) => {
  const rows = cells.filter((row) => row.structure === structure);
  const walls = [cell('completes_correctly', structure), ...costRuns]
    .filter((row) => row.structure === structure)
    .map((row) => row.wall_ms)
    .sort((a, b) => a - b);
  const correct = cell('completes_correctly', structure);
  return {
    structure,
    harmful_outcomes: rows.filter(harmful).map((row) => row.behaviour),
    correct_behaviours_not_merged: rows
      .filter((row) => behaviours[row.behaviour].correct && !row.merged)
      .map((row) => row.behaviour),
    correct_run: {
      task_turns: correct.task_turns,
      gate_runs: correct.gate_runs,
      lead_wakes: correct.lead_wakes,
      wall_ms: { min: walls[0], median: walls[Math.floor(walls.length / 2)], max: walls.at(-1) },
    },
  };
});

const table = [
  '| behaviour | structure | merged | stopped by | main correct | escaped write landed | task turns | gate runs | lead wakes | needs-you items |',
  '|---|---|---|---|---|---|---|---|---|---|',
  ...cells.map(
    (row) =>
      `| ${row.behaviour} | ${row.structure} | ${row.merged} | ${row.stopped_by ?? ''} | ${row.main_correct} | ${row.escaped_write_landed} | ${row.task_turns} | ${row.gate_runs} | ${row.lead_wakes} | ${row.needs_you.join(', ')} |`,
  ),
  '',
  '| structure | harmful outcomes | correct behaviours not merged | task turns | gate runs | lead wakes | wall ms (min / median / max) |',
  '|---|---|---|---|---|---|---|',
  ...summary.map(
    (row) =>
      `| ${row.structure} | ${row.harmful_outcomes.join(', ')} | ${row.correct_behaviours_not_merged.join(', ')} | ${row.correct_run.task_turns} | ${row.correct_run.gate_runs} | ${row.correct_run.lead_wakes} | ${Object.values(row.correct_run.wall_ms).join(' / ')} |`,
  ),
  '',
  // main_correct of these cells is the content of the goal the task no longer has.
  '| goal change | merged | stopped by | content of the first goal on main | task state | merge request | task turns | gate runs | lead wakes | needs-you items |',
  '|---|---|---|---|---|---|---|---|---|---|',
  ...goalChangeCells.map(
    (row) =>
      `| ${row.goal_change} | ${row.merged} | ${row.stopped_by ?? ''} | ${row.main_correct} | ${row.task_state} | ${row.merge_request ?? ''} | ${row.task_turns} | ${row.gate_runs} | ${row.lead_wakes} | ${row.needs_you.join(', ')} |`,
  ),
  '',
].join('\n');
mkdirSync(evidenceDir, { recursive: true });
await writeEvidence(evidenceDir, {
  'matrix.md': table,
  'matrix.json': {
    summary,
    cells: cells.map(({ events, ...row }) => row),
    goal_changes: goalChangeCells.map(({ events, ...row }) => row),
  },
  'events.json': [...cells, ...goalChangeCells].map(
    ({ behaviour, structure, goal_change, events }) => ({
      behaviour,
      structure,
      ...(goal_change ? { goal_change } : {}),
      events,
    }),
  ),
});
console.log(table);

// The matrix means nothing unless every cell settled, the correct behaviour merges everywhere,
// and the acceptance alone lets the wrong content through.
const broken = [
  ...cells
    .filter((row) => !row.settled)
    .map((row) => `${row.behaviour} / ${row.structure} did not settle`),
  ...goalChangeCells
    .filter((row) => !row.settled)
    .map((row) => `goal change ${row.goal_change} did not settle`),
  ...summary
    .filter((row) => row.correct_behaviours_not_merged.length)
    .map((row) => `${row.structure} stopped ${row.correct_behaviours_not_merged.join(', ')}`),
  ...(cell('writes_wrong_content', 'acceptance_only').merged
    ? []
    : ['acceptance_only stopped the wrong content, so the probe shows no gap']),
];
if (broken.length) {
  console.error(broken.join('\n'));
  process.exit(1);
}
