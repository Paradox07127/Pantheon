import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FixtureAdapter } from '@pantheon/adapters';
import { command, USER_PRINCIPAL_ID } from '@pantheon/protocol';
import { startFixtureDaemon } from '../lib/daemon.mjs';
import { waitFor } from '../lib/event-client.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

export const title = '改目标只影响相关任务';
export const mode = 'integration';

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const managedParent = fileURLToPath(new URL('../../../node_modules/.cache/', import.meta.url));
const WAIT_MS = 30000;
/** How long task A's reporting turn runs before it reports, in ms; the lead changes A meanwhile. */
const REPORT_DELAY_MS = 5000;
/** Ticks the event cursor must stay still for before the daemon counts as settled. */
const QUIET_TICKS = 20;
const REPORT_A = 'Task A is finished';
// Found on the daemon's PATH, so no machine path lands in the evidence.
const passingGate = [{ name: 'Passes', argv: ['node', '-e', 'process.exit(0)'] }];
const task = (id, file, fields = {}) => ({
  id,
  title: `Task ${id}`,
  goal: `Add ${file}`,
  lane: 'main',
  depends_on: [],
  source: [`Add ${file}`],
  scope: [file],
  acceptance: [`test -f ${file}`],
  ...fields,
});
const plan = {
  base_version: 0,
  headline: 'Changed goal',
  lanes: [{ id: 'main', title: 'Main' }],
  tasks: [
    task('A', 'a.txt', { done_when: 'report' }),
    task('B', 'b.txt', { depends_on: ['A'] }),
    task('C', 'c.txt'),
  ],
  milestones: [],
  risks: [],
  assumptions: [],
};
// The lead's first plan is at version 1; only A's goal and acceptance change.
const changedPlan = {
  ...plan,
  base_version: 1,
  tasks: plan.tasks.map((row) =>
    row.id === 'A'
      ? { ...row, goal: 'Add a.txt that names task A', acceptance: ['grep -q "Task A" a.txt'] }
      : row,
  ),
};

/** A turn input the fixture runtime runs as these steps. */
const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;
const ended = (turn) => !['queued', 'running'].includes(turn.state);

export async function run({ workspace, evidenceDir }) {
  const adapter = new FixtureAdapter();
  // The daemon refuses worktrees in temporary directories, where the case workspace may be.
  await mkdir(managedParent, { recursive: true });
  const workspaceRoot = await mkdtemp(path.join(managedParent, 'pantheon-acceptance-'));
  const options = { intervalMs: 50, workspaceRoot };
  const fixture = await startFixtureDaemon(path.join(workspace, 'daemon'), [adapter], options);
  const { daemon } = fixture;
  const receipts = [],
    reads = {},
    observations = {};
  const ids = {};
  let projectId, failure, evidence;

  const send = async (step, type, input, revision = null) => {
    const result = await fixture.submit(command(USER_PRINCIPAL_ID, type, input, revision));
    receipts.push({ step, type, input, expected_revision: revision, ...result });
    return result;
  };
  const call = async (step, type, input, revision = null) => {
    const result = await send(step, type, input, revision);
    if (result.status !== 200) throw new Error(`${step} ${type}: ${JSON.stringify(result.data)}`);
    return result.data.receipt;
  };
  const get = async (method, params) => {
    const response = await fetch(`${daemon.url}/v1/${method}?${new URLSearchParams(params)}`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`${method}: ${JSON.stringify(data)}`);
    return data;
  };
  const snapshot = () => get('board', { project_id: projectId });
  const events = async () => {
    const all = [];
    for (let after = 0; ;) {
      const page = await get('events', { after: String(after), project_id: projectId });
      if (page.snapshot_required) throw new Error('Event log no longer reaches the first event');
      if (!page.events.length) return all;
      all.push(...page.events);
      after = page.events.at(-1).sequence;
    }
  };
  const turnsOf = (board, sessionId) =>
    board.session_turns.filter((turn) => turn.session_id === sessionId);
  /** Waits until the session is open with at least `count` turns, every one ended. */
  const settled = (sessionId, count, description) =>
    waitFor(
      async () => {
        const board = await snapshot();
        const session = board.sessions.find((row) => row.id === sessionId);
        const turns = turnsOf(board, sessionId);
        return session?.state === 'open' && turns.length >= count && turns.every(ended)
          ? { board, session, turns }
          : false;
      },
      description,
      WAIT_MS,
    );
  /** Waits until the session is open with every turn ended; each turn must have completed. */
  const idle = async (sessionId, description) => {
    const found = await settled(sessionId, 1, description);
    const failed = found.turns.filter((turn) => turn.state !== 'completed');
    if (failed.length) throw new Error(`${description}: turn ended ${failed[0].state}`);
    return found;
  };
  /** Waits until the event cursor has not moved for QUIET_TICKS daemon ticks. */
  const quiet = (description) => {
    let cursor = -1,
      movedAt = 0;
    return waitFor(
      async () => {
        const latest = (await events()).at(-1)?.sequence ?? 0;
        if (latest !== cursor) {
          cursor = latest;
          movedAt = Date.now();
          return false;
        }
        return Date.now() - movedAt >= QUIET_TICKS * options.intervalMs;
      },
      description,
      WAIT_MS,
    );
  };
  /** Sends the lead a turn once it is open; a tracker turn may take it first. */
  const tellLead = async (step, input) => {
    for (;;) {
      const { session } = await settled(ids.lead, 1, `the lead to be open for ${step}`);
      const result = await send(
        step,
        'session.send',
        { session_id: ids.lead, input },
        session.revision,
      );
      if (result.status === 200) return result.data.receipt;
      if (!['resource_busy', 'conflict', 'revision_conflict'].includes(result.data.error))
        throw new Error(`${step} session.send: ${JSON.stringify(result.data)}`);
    }
  };
  const lastPlan = (all) =>
    all.findLast((event) => event.kind === 'board.plan_updated' && event.aggregate_id === ids.lead)
      ?.payload;
  const generationOf = (planRow, taskId) => planRow?.generations?.[taskId]?.generation ?? null;
  const viewTask = (model, taskId) =>
    model.tasks.find(
      (row) => row.owner_session_id === ids.lead && row.id === `${ids.lead}:${taskId}`,
    );

  try {
    const repo = path.join(workspace, 'repo');
    await mkdir(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Changed Goal');
    git(repo, 'config', 'user.email', 'changed-goal@example.invalid');
    git(repo, 'config', 'commit.gpgsign', 'false');
    await writeFile(path.join(repo, 'README.md'), 'Changed goal\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-q', '-m', 'Initial commit');
    const project = await call('open', 'project.open', { name: 'Changed goal', roots: [repo] });
    projectId = project.id;
    await call(
      'open',
      'project.gate.set',
      { project_id: projectId, root: project.roots[0], commands: passingGate },
      project.revision,
    );

    // The lead writes the plan: A done on report, B after A, C on its own.
    ids.lead = (
      await call('plan', 'session.create', {
        project_id: projectId,
        runtime: adapter.name,
        input: script({ tool: { name: 'update_board', arguments: plan } }),
      })
    ).id;
    await idle(ids.lead, 'the lead to write the plan');

    // C is done and merged.
    ids.c = (
      await call('merge_c', 'session.create', {
        project_id: projectId,
        runtime: adapter.name,
        task_id: `${ids.lead}:C`,
        input: script(
          { write: { path: 'c.txt', text: 'Task C\n' } },
          { commit: 'Add c.txt for task C' },
        ),
      })
    ).id;
    const committedC = await idle(ids.c, 'the session of task C to commit');
    await call('merge_c', 'session.merge', { session_id: ids.c }, committedC.session.revision);
    await waitFor(
      async () => (await snapshot()).sessions.find((row) => row.id === ids.c)?.outcome === 'merged',
      'the session of task C to merge',
      WAIT_MS,
    );
    reads.view_before_change = await get('board.view', { project_id: projectId, days: '14' });

    // A commits, and its gate runs once on that commit.
    ids.a = (
      await call('gate_a', 'session.create', {
        project_id: projectId,
        runtime: adapter.name,
        task_id: `${ids.lead}:A`,
        input: script(
          { write: { path: 'a.txt', text: 'Work for A\n' } },
          { commit: 'Add a.txt for task A' },
        ),
      })
    ).id;
    const committedA = await idle(ids.a, 'the session of task A to commit');
    await call('gate_a', 'session.gates.run', { session_id: ids.a }, committedA.session.revision);
    reads.gates_before_change = await waitFor(
      async () => {
        const history = await get('session.gates.history', { session_id: ids.a });
        return history.runs.length ? history : false;
      },
      'the gate of task A to record a run',
      WAIT_MS,
    );
    reads.preflight_before_change = await get('session.preflight', { session_id: ids.a });

    // A runs a turn that reports done only after the lead has changed its contract.
    const gatedA = await idle(ids.a, 'the gate run of task A to end');
    await call(
      'report_a',
      'session.send',
      {
        session_id: ids.a,
        input: script(
          { wait: REPORT_DELAY_MS },
          { tool: { name: 'report', arguments: { kind: 'done', text: REPORT_A } } },
        ),
      },
      gatedA.session.revision,
    );
    await waitFor(
      async () =>
        turnsOf(await snapshot(), ids.a).some((turn) => turn.state === 'running') || false,
      'the reporting turn of task A to run',
      WAIT_MS,
    );
    await tellLead('change', script({ tool: { name: 'update_board', arguments: changedPlan } }));
    const changed = await waitFor(
      async () => {
        const all = await events();
        return generationOf(lastPlan(all), 'A') !== 1 ? all : false;
      },
      'the lead to change task A',
      WAIT_MS,
    );
    const reportedEarly = changed.some((event) => event.kind === 'task.reported');
    if (reportedEarly) throw new Error('Task A reported before the lead changed its contract');
    const report = await waitFor(
      async () => (await events()).find((event) => event.kind === 'task.reported') ?? false,
      'the done report of task A',
      WAIT_MS,
    );

    // The lead accepts A on that report.
    await quiet('the daemon to settle after the report');
    const acceptTurn = await tellLead(
      'accept',
      script({
        tool: {
          name: 'accept_task',
          arguments: { project_id: projectId, task_id: 'A', evidence: REPORT_A },
        },
      }),
    );
    await waitFor(
      async () => {
        const turn = (await snapshot()).session_turns.find((row) => row.id === acceptTurn.id);
        return turn && ended(turn);
      },
      'the lead accept turn to end',
      WAIT_MS,
    );
    await quiet('the daemon to settle after the acceptance');

    const all = await events(),
      board = await snapshot();
    reads.view = await get('board.view', { project_id: projectId, days: '14' });
    reads.session_list = await get('session.list', { project_id: projectId });
    reads.preflight = await get('session.preflight', { session_id: ids.a });
    reads.gates_history = await get('session.gates.history', { session_id: ids.a });
    reads.diff_a = await get('session.diff', { session_id: ids.a });
    const finalPlan = lastPlan(all);
    const acceptCall = all.find(
      (event) =>
        event.kind === 'agent.tool.started' &&
        event.aggregate_id === ids.lead &&
        event.payload.name === 'accept_task',
    );
    reads.accept_result =
      all.find(
        (event) =>
          event.kind === 'agent.tool.completed' &&
          event.payload.tool_call_id === acceptCall?.payload.tool_call_id,
      )?.payload ?? null;
    reads.report = report.payload;
    const sessionsOf = (taskId) =>
      board.sessions.filter(
        (row) => row.task?.lead_session_id === ids.lead && row.task.id === taskId,
      );
    const [latestRun] = reads.gates_history.runs;
    observations.plans = {
      changed_task_generation: generationOf(finalPlan, 'A'),
      stale_result_accepted:
        viewTask(reads.view, 'A')?.status === 'done' ||
        Boolean(finalPlan?.accepted?.A) ||
        all.some((event) => event.kind === 'task.accepted'),
      unaffected_C_reused:
        generationOf(finalPlan, 'C') === 1 &&
        sessionsOf('C').length === 1 &&
        sessionsOf('C')[0].id === ids.c &&
        sessionsOf('C')[0].outcome === 'merged' &&
        viewTask(reads.view, 'C')?.status === 'done' &&
        viewTask(reads.view_before_change, 'C')?.status === 'done',
    };
    // Stale on the very commit the record checked, so only the task's changed acceptance makes it so.
    observations.gates = {
      changed_spec_stale:
        reads.preflight_before_change.gate.last === 'passed' &&
        reads.preflight.gate.last === 'stale' &&
        latestRun?.commit === reads.diff_a.head_sha,
    };
  } catch (error) {
    failure = error;
  } finally {
    try {
      evidence = await collectEvidence();
    } catch (error) {
      evidence = { 'collection-error.txt': String(error?.stack ?? error) };
    }
    await fixture.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
  if (failure) {
    await writeEvidence(evidenceDir, {
      ...evidence,
      'failure.txt': String(failure?.stack ?? failure),
    });
    throw failure;
  }
  return {
    observations,
    evidence,
    adapters: [`${adapter.name}@${adapter.report.version}`],
  };

  async function collectEvidence() {
    if (!projectId) return { 'events.jsonl': receipts.map((r) => JSON.stringify(r)).join('\n') };
    const all = await events();
    return {
      'board.json': {
        ids,
        plans: all.filter((event) => event.kind === 'board.plan_updated').map((e) => e.payload),
        view_before_change: reads.view_before_change ?? null,
        view: reads.view ?? null,
        session_list: reads.session_list ?? null,
        accept_result: reads.accept_result ?? null,
        report: reads.report ?? null,
      },
      'gate-history.json': {
        before_change: reads.gates_before_change ?? null,
        preflight_before_change: reads.preflight_before_change ?? null,
        after: reads.gates_history ?? null,
        preflight: reads.preflight ?? null,
        head_a: reads.diff_a?.head_sha ?? null,
      },
      'events.jsonl': all.map((event) => JSON.stringify(event)).join('\n') + '\n',
      'receipts.json': receipts,
      'observations.json': observations,
    };
  }
}
