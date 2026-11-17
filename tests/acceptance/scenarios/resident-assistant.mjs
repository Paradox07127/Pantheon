import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FixtureAdapter } from '@pantheon/adapters';
import { command, USER_PRINCIPAL_ID } from '@pantheon/protocol';
import { startFixtureDaemon } from '../lib/daemon.mjs';
import { waitFor } from '../lib/event-client.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

export const title = '常驻助理派两条需求的 worker 并接手旧计划(fixture)';
export const mode = 'integration';

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const WAIT_MS = 120000;
const TASKS = ['notes', 'greeting'];
const passingGate = [{ name: 'Passes', argv: [process.execPath, '-e', 'process.exit(0)'] }];

/** A turn input the fixture runtime runs as these steps. */
const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;
/** A task goal: one sentence, then the script its dispatched session runs. */
const scriptedGoal = (sentence, file) =>
  `${sentence}\n${script({ write: { path: file, text: `${sentence}\n` } }, { commit: sentence })}`;
// No path: the tier's default path is direct, which a resident hands to a worker instead.
const planTask = (id, lane, file) => ({
  id,
  title: `Add ${file}`,
  goal: scriptedGoal(`Add ${file}`, file),
  lane,
  depends_on: [],
  source: [`Add ${file}`],
  scope: [file],
  acceptance: [`test -f ${file}`],
  kind: { domain: 'backend-logic', tier: 't1' },
});
const plan = {
  base_version: 0,
  headline: 'Two requests at once',
  lanes: [
    { id: 'docs', title: 'Docs' },
    { id: 'code', title: 'Code' },
  ],
  tasks: [planTask('notes', 'docs', 'notes.txt'), planTask('greeting', 'code', 'greeting.txt')],
  milestones: [],
  risks: [],
  assumptions: [],
};
const ended = (turn) => !['queued', 'running'].includes(turn.state);

export async function run({ workspace, evidenceDir }) {
  const adapter = new FixtureAdapter();
  const options = { intervalMs: 50, workspaceRoot: path.join(workspace, 'workspaces') };
  const fixture = await startFixtureDaemon(path.join(workspace, 'daemon'), [adapter], options);
  const { daemon } = fixture;
  const receipts = [],
    ids = {},
    observations = {};
  let projectId, failure, evidence;

  const submit = async (step, type, input, revision = null) => {
    const result = await fixture.submit(command(USER_PRINCIPAL_ID, type, input, revision));
    receipts.push({ step, type, input, expected_revision: revision, ...result });
    return result;
  };
  const call = async (step, type, input, revision = null) => {
    const result = await submit(step, type, input, revision);
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
  const projectRow = (board) => board.projects.find((row) => row.id === projectId);
  const sessionRow = (board, id) => board.sessions.find((row) => row.id === id);
  const turnsOf = (board, id) => board.session_turns.filter((turn) => turn.session_id === id);
  const planRow = (id) => daemon.store.get('board_plans', id);
  const taskSessions = (board, leadId) =>
    board.sessions.filter((row) => row.task?.lead_session_id === leadId);
  const openAssistant = (step) =>
    call(step, 'resident.open', { project_id: projectId, kind: 'assistant' });

  try {
    const repo = path.join(workspace, 'repo');
    await mkdir(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Resident Assistant');
    git(repo, 'config', 'user.email', 'resident-assistant@example.invalid');
    git(repo, 'config', 'commit.gpgsign', 'false');
    await writeFile(path.join(repo, 'README.md'), 'Resident assistant\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-q', '-m', 'Initial commit');
    const project = await call('open', 'project.open', {
      name: 'Resident assistant',
      roots: [repo],
    });
    projectId = project.id;
    await call(
      'open',
      'project.gate.set',
      { project_id: projectId, root: project.roots[0], commands: passingGate },
      project.revision,
    );
    await call(
      'open',
      'project.autoMerge.set',
      { project_id: projectId, enabled: true },
      projectRow(await snapshot()).revision,
    );
    await call(
      'open',
      'project.sessionDefaults.set',
      { project_id: projectId, runtime: adapter.name, permission_mode: 'auto_edit' },
      projectRow(await snapshot()).revision,
    );

    // The user only talks to the assistant, which plans two lanes and starts both tasks.
    ids.assistant = (await openAssistant('assistant')).id;
    ids.again = (await openAssistant('assistant again')).id;
    let board = await snapshot();
    await call(
      'request',
      'session.send',
      {
        session_id: ids.assistant,
        input: script(
          { tool: { name: 'update_board', arguments: plan } },
          { tool: { name: 'start_task', arguments: { task_ids: TASKS } } },
        ),
      },
      sessionRow(board, ids.assistant).revision,
    );

    const settled = await waitFor(
      async () => {
        const current = await snapshot();
        const workers = taskSessions(current, ids.assistant);
        const turns = turnsOf(current, ids.assistant);
        return workers.length === TASKS.length &&
          workers.every((row) => row.outcome === 'merged') &&
          planRow(ids.assistant)?.inbox.length === 0 &&
          turns.some((turn) => turn.origin === 'tracker') &&
          turns.every(ended)
          ? current
          : false;
      },
      'both workers to merge and the assistant to hear of it',
      WAIT_MS,
    );
    const wakes = turnsOf(settled, ids.assistant).filter((turn) => turn.origin === 'tracker');
    const needsYou = await get('needs_you.list', { project_id: projectId });
    observations.open = { same_session: ids.again === ids.assistant };
    observations.assistant = {
      direct_task: sessionRow(settled, ids.assistant).direct_task ?? null,
      wakes_at_most_two: wakes.length >= 1 && wakes.length <= 2,
      wake_failed: planRow(ids.assistant)?.wake_failed ?? null,
    };
    observations.workers = {
      merged: taskSessions(settled, ids.assistant)
        .map((row) => row.task.id)
        .sort(),
    };
    observations.needs_you = {
      wake_limited: needsYou.items.filter((item) => item.reason === 'lead_wake_limited').length,
    };

    // The assistant's native process ends; the next request opens a new one that takes the plan.
    const old = daemon.store.get('sessions', ids.assistant);
    daemon.store.update('sessions', { ...old, state: 'closed' }, old.revision);
    ids.replacement = (await openAssistant('assistant after close')).id;
    board = await waitFor(
      async () => {
        const current = await snapshot();
        const turns = turnsOf(current, ids.replacement);
        return turns.length && turns.every(ended) ? current : false;
      },
      'the new assistant to take over the plan',
      WAIT_MS,
    );
    observations.reopen = {
      new_session: ids.replacement !== ids.assistant,
      plan_moved: planRow(ids.replacement)?.headline === plan.headline && !planRow(ids.assistant),
      task_sessions_moved:
        taskSessions(board, ids.replacement)
          .map((row) => row.task.id)
          .sort()
          .join(',') === [...TASKS].sort().join(','),
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
    if (!projectId) return { 'receipts.json': receipts };
    const board = await snapshot();
    return {
      'receipts.json': { ids, receipts },
      'events.json': await events(),
      'board.json': { sessions: board.sessions, session_turns: board.session_turns },
      'observations.json': observations,
    };
  }
}
