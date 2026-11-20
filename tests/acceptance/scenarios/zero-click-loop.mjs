import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FixtureAdapter } from '@pantheon/adapters';
import { command, USER_PRINCIPAL_ID } from '@pantheon/protocol';
import { startFixtureDaemon } from '../lib/daemon.mjs';
import { waitFor } from '../lib/event-client.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

export const title = '零点击闭环(fixture)';
export const mode = 'integration';

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const WAIT_MS = 60000;
const TASKS = ['A', 'B'];
const passingGate = [{ name: 'Passes', argv: [process.execPath, '-e', 'process.exit(0)'] }];

/** A turn input the fixture runtime runs as these steps. */
const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;
/** A task goal: one sentence, then the script its dispatched session runs. */
const scriptedGoal = (sentence, file) =>
  `${sentence}\n${script(
    { write: { path: file, text: `${sentence}\n` } },
    { commit: sentence },
    { tool: { name: 'report', arguments: { kind: 'done', text: `${sentence} is done` } } },
  )}`;
const planTask = (id, file, depends_on) => ({
  id,
  title: `Task ${id}`,
  goal: scriptedGoal(`Add ${file}`, file),
  lane: 'main',
  milestone: 'M',
  depends_on,
  source: [`Add ${file}`],
  scope: [file],
  acceptance: [`test -f ${file}`],
  // A one-file task would otherwise be the lead's own to do; this loop is about dispatched sessions.
  path: 'dispatch',
  flow_reason: 'Each task runs in a session of its own',
});
const plan = {
  base_version: 0,
  headline: 'Zero-click loop',
  lanes: [{ id: 'main', title: 'Main' }],
  tasks: [planTask('A', 'a.txt', []), planTask('B', 'b.txt', ['A'])],
  milestones: [
    { id: 'M', title: 'Milestone M', criteria: ['A and B are merged'], tasks: ['A', 'B'] },
  ],
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
    views = {},
    observations = {};
  let projectId, leadId, leadCommandId, failure, evidence;

  const call = async (step, type, input, revision = null) => {
    const body = command(USER_PRINCIPAL_ID, type, input, revision);
    const result = await fixture.submit(body);
    receipts.push({
      step,
      type,
      input,
      expected_revision: revision,
      command_id: body.command_id,
      ...result,
    });
    if (result.status !== 200) throw new Error(`${step} ${type}: ${JSON.stringify(result.data)}`);
    return { receipt: result.data.receipt, command_id: body.command_id };
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
  const view = async (moment) =>
    (views[moment] = await get('board.view', { project_id: projectId, days: '14' }));
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
  const local = (id) => id.slice(leadId.length + 1);
  const planTasks = (model) => model.tasks.filter((task) => task.owner_session_id === leadId);
  const leadMilestone = (model) => model.milestones.find((row) => row.owner_session_id === leadId);
  const dispatched = (all, taskId) =>
    all.find(
      (event) =>
        event.kind === 'task.dispatched' &&
        event.aggregate_id === leadId &&
        event.payload.task_id === taskId,
    );
  const merged = (all, sessionId) =>
    all.find((event) => event.kind === 'session.merged' && event.aggregate_id === sessionId);
  const dispatch = (taskId) =>
    waitFor(
      async () => dispatched(await events(), taskId)?.payload.session_id ?? false,
      `the daemon to open the session of task ${taskId}`,
      WAIT_MS,
    );
  const mergedSession = (sessionId, taskId) =>
    waitFor(
      async () => Boolean(merged(await events(), sessionId)),
      `the session of task ${taskId} to merge`,
      WAIT_MS,
    );
  /** User commands the daemon recorded after the one that opened the lead, in receipt order. */
  const userCommands = () =>
    daemon.store.db
      .prepare(
        "SELECT rowid, source_key FROM inbox WHERE source_key GLOB 'local-user:command:*' ORDER BY rowid",
      )
      .all()
      .map((row) => row.source_key.slice('local-user:command:'.length));

  try {
    // Open the project with a passing gate, auto_merge and fixture session defaults.
    const repo = path.join(workspace, 'repo');
    await mkdir(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Zero Click Loop');
    git(repo, 'config', 'user.email', 'zero-click-loop@example.invalid');
    git(repo, 'config', 'commit.gpgsign', 'false');
    await writeFile(path.join(repo, 'README.md'), 'Zero-click loop\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-q', '-m', 'Initial commit');
    const { receipt: project } = await call('open', 'project.open', {
      name: 'Zero-click loop',
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

    // The user's only request: the lead writes the plan and starts both tasks.
    const lead = await call('request', 'session.create', {
      project_id: projectId,
      runtime: adapter.name,
      purpose: 'lead',
      input: script(
        { tool: { name: 'update_board', arguments: plan } },
        { tool: { name: 'start_task', arguments: { task_ids: TASKS } } },
      ),
    });
    leadId = lead.receipt.id;
    leadCommandId = lead.command_id;

    // From here on the daemon and the sessions do everything.
    const sessionA = await dispatch('A');
    await mergedSession(sessionA, 'A');
    const sessionB = await dispatch('B');
    await mergedSession(sessionB, 'B');
    const final = await waitFor(
      async () => {
        const board = await snapshot();
        const leadRow = board.sessions.find((row) => row.id === leadId);
        const turns = board.session_turns.filter((turn) => turn.session_id === leadId);
        const model = await view('final');
        return leadRow?.state === 'open' &&
          turns.every(ended) &&
          turns.some((turn) => turn.origin === 'tracker') &&
          leadMilestone(model)?.status === 'ready_for_acceptance'
          ? { board, turns, model }
          : false;
      },
      'the lead tracker turn and milestone M ready for acceptance',
      WAIT_MS,
    );

    const all = await events();
    const sessions = { A: sessionA, B: sessionB };
    const lastGate = (sessionId) => {
      const mergedAt = merged(all, sessionId).sequence;
      return all.findLast(
        (event) =>
          event.kind === 'session.gate_checked' &&
          event.aggregate_id === sessionId &&
          event.sequence < mergedAt,
      );
    };
    const acceptanceOf = (taskId) => plan.tasks.find((task) => task.id === taskId).acceptance[0];
    const recorded = userCommands();
    observations.plan = { tasks: planTasks(final.model).map((row) => local(row.id)) };
    observations.dispatch = {
      order: all
        .filter((event) => event.kind === 'task.dispatched' && event.aggregate_id === leadId)
        .map((event) => event.payload.task_id),
      b_after_a_merged: dispatched(all, 'B').sequence > merged(all, sessionA).sequence,
    };
    observations.work = {
      auto_merged: TASKS.filter(
        (taskId) =>
          merged(all, sessions[taskId]) &&
          all.some(
            (event) =>
              event.kind === 'session.merge_started' &&
              event.aggregate_id === sessions[taskId] &&
              event.payload.auto === true,
          ),
      ),
      acceptance_ran: TASKS.filter((taskId) =>
        lastGate(sessions[taskId])?.payload.results.some(
          (result) => result.name === acceptanceOf(taskId),
        ),
      ),
    };
    observations.board = {
      done_tasks: planTasks(final.model)
        .filter((row) => row.status === 'done')
        .map((row) => local(row.id)),
    };
    observations.milestone = { status: leadMilestone(final.model)?.status ?? null };
    observations.user = {
      commands_after_lead: recorded.length - recorded.indexOf(leadCommandId) - 1,
    };
    observations.lead = {
      tracker_turns_at_least_one: final.turns.some((turn) => turn.origin === 'tracker'),
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
      'receipts.json': receipts,
      'events.json': await events(),
      'observations.json': observations,
      'board.json': { sessions: board.sessions, session_turns: board.session_turns },
      'board-views.json': views,
      'user-commands.json': { lead_command_id: leadCommandId ?? null, recorded: userCommands() },
    };
  }
}
