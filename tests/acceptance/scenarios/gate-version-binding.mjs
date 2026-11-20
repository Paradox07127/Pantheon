import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { FixtureAdapter } from '@pantheon/adapters';
import { command, USER_PRINCIPAL_ID } from '@pantheon/protocol';
import { createRepoBasic } from '../fixtures/repo-basic.mjs';
import { startFixtureDaemon } from '../lib/daemon.mjs';
import { waitFor } from '../lib/event-client.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

export const title = '代码验收与版本绑定';
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
const MODULE = 'src/text-stats.mjs';
const TEST = 'test/text-stats.test.mjs';
// The verifier sits in the repository outside the task's scope, so a session can try to change it.
const VERIFIER = 'verify/slugify.mjs';
// Gate commands find node on the daemon's PATH, so no machine path lands in the evidence.
const projectGate = [{ name: 'Repository tests', argv: ['node', '--test', 'test/*.test.mjs'] }];
const acceptance = `node ${VERIFIER} .`;
const plan = {
  base_version: 0,
  headline: 'Implement slugify',
  lanes: [{ id: 'main', title: 'Main' }],
  tasks: [
    {
      id: 'slugify',
      title: 'Implement slugify',
      goal: 'Implement slugify in the text stats module',
      lane: 'main',
      depends_on: [],
      source: ['Implement slugify'],
      scope: [MODULE, TEST],
      acceptance: [acceptance],
    },
  ],
  milestones: [],
  risks: [],
  assumptions: [],
};

/** A turn input the fixture runtime runs as these steps. */
const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;
const write = (file, text) => ({ write: { path: file, text } });
const ended = (turn) => !['queued', 'running'].includes(turn.state);
const passed = (check) =>
  Boolean(check?.payload.results.length) &&
  check.payload.results.every((result) => result.exit_code === 0 && !result.timed_out);

/** The file's text after the patch, applied to a copy of the file outside the repository. */
async function patched(repo, scratch, file, patch) {
  await mkdir(path.join(scratch, path.dirname(file)), { recursive: true });
  await copyFile(path.join(repo, file), path.join(scratch, file));
  // Its own repository, so git apply resolves the patch paths from the scratch directory.
  git(scratch, 'init', '-q');
  git(scratch, 'apply', patch);
  return readFile(path.join(scratch, file), 'utf8');
}

export async function run({ workspace, evidenceDir }) {
  const adapter = new FixtureAdapter();
  // The daemon refuses worktrees in temporary directories, where the case workspace may be.
  await mkdir(managedParent, { recursive: true });
  const workspaceRoot = await mkdtemp(path.join(managedParent, 'pantheon-acceptance-'));
  const options = { intervalMs: 50, workspaceRoot };
  const stateDir = path.join(workspace, 'daemon', 'state');
  const fixture = await startFixtureDaemon(path.join(workspace, 'daemon'), [adapter], options);
  const { daemon } = fixture;
  const receipts = [],
    reads = {},
    observations = {};
  const ids = {};
  let projectId, failure, evidence, tamperReceipt;

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
  const get = async (method, params, token = daemon.token) => {
    const response = await fetch(`${daemon.url}/v1/${method}?${new URLSearchParams(params)}`, {
      headers: { Authorization: `Bearer ${token}` },
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
  const sessionRow = (board, sessionId) => board.sessions.find((row) => row.id === sessionId);
  const projectRow = (board) => board.projects.find((row) => row.id === projectId);
  /** Waits until the session is open and idle; each of its turns must have completed. */
  const idle = async (sessionId, description) => {
    const found = await waitFor(
      async () => {
        const board = await snapshot();
        const session = sessionRow(board, sessionId);
        const turns = board.session_turns.filter((turn) => turn.session_id === sessionId);
        return session?.state === 'open' &&
          session.merge?.state !== 'running' &&
          session.gate_run?.state !== 'running' &&
          turns.length &&
          turns.every(ended)
          ? { board, session, turns }
          : false;
      },
      description,
      WAIT_MS,
    );
    const failed = found.turns.filter((turn) => turn.state !== 'completed');
    if (failed.length) throw new Error(`${description}: turn ended ${failed[0].state}`);
    return found.session;
  };
  const openTask = async (step, steps) => {
    const session = await call(step, 'session.create', {
      project_id: projectId,
      runtime: adapter.name,
      task_id: `${ids.lead}:slugify`,
      input: script(...steps),
    });
    await idle(session.id, `the ${step} session to commit`);
    return session.id;
  };
  const tell = async (step, sessionId, steps) => {
    const session = await idle(sessionId, `the ${step} session to be open`);
    // The send marks the session running before it returns.
    await call(
      step,
      'session.send',
      { session_id: sessionId, input: script(...steps) },
      session.revision,
    );
    return idle(sessionId, `the ${step} turn to end`);
  };
  /** Starts the user's merge and waits until it lands or is blocked. */
  const merge = async (step, sessionId) => {
    const session = await idle(sessionId, `the ${step} session to be idle`);
    await call(step, 'session.merge', { session_id: sessionId }, session.revision);
    return waitFor(
      async () => {
        const row = sessionRow(await snapshot(), sessionId);
        return row?.outcome === 'merged' || row?.merge?.state === 'blocked' ? row : false;
      },
      `the ${step} merge to land or be blocked`,
      WAIT_MS,
    );
  };
  const checksOf = (all, sessionId) =>
    all.filter(
      (event) => event.kind === 'session.gate_checked' && event.aggregate_id === sessionId,
    );
  const mergedEvent = (all, sessionId) =>
    all.find((event) => event.kind === 'session.merged' && event.aggregate_id === sessionId);

  try {
    // repo-basic with the verifier committed at verify/slugify.mjs.
    const fixtureRoot = path.join(workspace, 'fixture');
    const basic = await createRepoBasic(fixtureRoot);
    const repo = basic.repo;
    git(repo, 'config', 'user.name', 'Gate Version Binding');
    git(repo, 'config', 'user.email', 'gate-version-binding@example.invalid');
    git(repo, 'config', 'commit.gpgsign', 'false');
    await mkdir(path.join(repo, 'verify'));
    await copyFile(basic.verifier.script, path.join(repo, VERIFIER));
    git(repo, 'add', VERIFIER);
    git(repo, 'commit', '-q', '-m', 'Add the slugify verifier');
    const verifierText = await readFile(path.join(repo, VERIFIER), 'utf8');
    const scratch = (name) => path.join(fixtureRoot, 'scratch', name);
    const texts = {
      bad: await patched(repo, scratch('bad'), MODULE, basic.patches.bad),
      good: await patched(repo, scratch('good'), MODULE, basic.patches.good),
      test_edit: await patched(repo, scratch('test-edit'), TEST, basic.patches.test_edit),
    };

    const project = await call('open', 'project.open', { name: 'Text stats', roots: [repo] });
    projectId = project.id;
    await call(
      'open',
      'project.gate.set',
      { project_id: projectId, root: project.roots[0], commands: projectGate },
      project.revision,
    );
    ids.lead = (
      await call('plan', 'session.create', {
        project_id: projectId,
        runtime: adapter.name,
        purpose: 'lead',
        input: script({ tool: { name: 'update_board', arguments: plan } }),
      })
    ).id;
    await idle(ids.lead, 'the lead to write the plan');

    // The task session commits a wrong slugify; the user's merge is blocked by its gate.
    ids.work = await openTask('bad_patch', [
      write(MODULE, texts.bad),
      { commit: 'Implement slugify without trimming' },
    ]);
    reads.bad_commit = (await get('session.diff', { session_id: ids.work })).head_sha;
    reads.bad_merge = await merge('bad_merge', ids.work);

    // Fixed, the gate runs on demand; one more commit leaves that run behind.
    await tell('good_patch', ids.work, [
      write(MODULE, texts.good),
      { commit: 'Trim dashes from slugs' },
    ]);
    reads.good_commit = (await get('session.diff', { session_id: ids.work })).head_sha;
    const fixed = await idle(ids.work, 'the fixed session to be idle');
    await call('good_patch', 'session.gates.run', { session_id: ids.work }, fixed.revision);
    await waitFor(
      async () =>
        checksOf(await events(), ids.work).some(
          (event) => event.payload.commit === reads.good_commit,
        ),
      'the gate run on the fixed commit',
      WAIT_MS,
    );
    await idle(ids.work, 'the gate run to finish');
    reads.preflight_checked = await get('session.preflight', { session_id: ids.work });
    await tell('new_commit', ids.work, [
      write(MODULE, `${texts.good}\n// Slugs keep ASCII letters and digits only.\n`),
      { commit: 'Note what slugs keep' },
    ]);
    reads.new_commit = (await get('session.diff', { session_id: ids.work })).head_sha;
    reads.preflight_new_commit = await get('session.preflight', { session_id: ids.work });
    reads.history_new_commit = await get('session.gates.history', { session_id: ids.work });
    reads.good_merge = await merge('good_merge', ids.work);

    // A second task session tries to loosen its own verification.
    const gatesBefore = projectRow(await snapshot()).gates;
    ids.tamper = await openTask('tamper', [
      write(VERIFIER, 'process.exitCode = 0;\n'),
      write(MODULE, texts.bad),
      { commit: 'Loosen the verifier' },
    ]);
    const token = await waitFor(
      () => readFile(path.join(stateDir, 'session-tokens', ids.tamper), 'utf8').catch(() => false),
      'the credential of the tampering session',
      WAIT_MS,
    );
    const { principal } = await get('session-principal', {}, token);
    const current = projectRow(await snapshot());
    const tamperCommand = command(
      principal.id,
      'project.gate.set',
      {
        project_id: projectId,
        root: project.roots[0],
        commands: [{ name: 'Always passes', argv: ['node', '-e', ''] }],
      },
      current.revision,
    );
    const response = await fetch(`${daemon.url}/v1/commands`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(tamperCommand),
    });
    tamperReceipt = {
      step: 'tamper',
      principal: { id: principal.id, role: principal.role },
      type: tamperCommand.type,
      input: tamperCommand.input,
      status: response.status,
      data: await response.json(),
    };
    reads.tamper_merge = await merge('tamper_merge', ids.tamper);
    const gatesAfter = projectRow(await snapshot()).gates;

    // A task takes one unfinished session at a time, so the blocked one is discarded first.
    const blocked = await idle(ids.tamper, 'the tampering session to be idle');
    await call('tamper_discard', 'session.discard', { session_id: ids.tamper }, blocked.revision);
    await waitFor(
      async () => sessionRow(await snapshot(), ids.tamper)?.outcome === 'discarded',
      'the tampering session to be discarded',
      WAIT_MS,
    );

    // A third task session adds a test case inside the task's scope.
    ids.test_edit = await openTask('test_edit', [
      write(TEST, texts.test_edit),
      { commit: 'Test words separated by tabs and newlines' },
    ]);
    reads.test_edit_merge = await merge('test_edit_merge', ids.test_edit);

    const all = await events();
    const [badCheck] = checksOf(all, ids.work);
    const goodCheck = checksOf(all, ids.work).find(
      (event) => event.payload.commit === reads.good_commit,
    );
    const mergeCheck = (sessionId) =>
      checksOf(all, sessionId).findLast(
        (event) => event.sequence < (mergedEvent(all, sessionId)?.sequence ?? 0),
      );
    const show = (file) => git(repo, 'show', `HEAD:${file}`);
    const [latestRun] = reads.history_new_commit.runs;
    observations.gates = {
      bad_patch_passed: badCheck ? passed(badCheck) || reads.bad_merge.outcome === 'merged' : null,
      good_patch_passed:
        passed(goodCheck) &&
        Boolean(mergedEvent(all, ids.work)) &&
        passed(mergeCheck(ids.work)) &&
        show(MODULE).startsWith(texts.good),
      new_commit_invalidates:
        reads.preflight_checked.gate.last === 'passed' &&
        reads.preflight_new_commit.gate.last === 'stale' &&
        latestRun?.commit === reads.good_commit &&
        reads.new_commit !== reads.good_commit,
      verifier_tamper_blocked:
        tamperReceipt.status === 403 &&
        tamperReceipt.data.error === 'permission_denied' &&
        isDeepStrictEqual(gatesAfter, gatesBefore) &&
        reads.tamper_merge.merge?.state === 'blocked' &&
        !mergedEvent(all, ids.tamper) &&
        show(VERIFIER) === verifierText,
      legitimate_test_edit_allowed:
        Boolean(mergedEvent(all, ids.test_edit)) &&
        passed(mergeCheck(ids.test_edit)) &&
        show(TEST) === texts.test_edit,
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
    const merges = {
      commands: receipts.filter((r) => r.type === 'session.merge'),
      tamper: tamperReceipt ?? null,
    };
    if (!projectId) return { 'merge-receipts.json': merges, 'receipts.json': receipts };
    const all = await events(),
      board = await snapshot();
    const named = Object.fromEntries(Object.entries(ids).map(([name, id]) => [id, name]));
    const checks = all.filter((event) => event.kind === 'session.gate_checked');
    return {
      'gate-commands.json': {
        project: projectRow(board)?.gates ?? null,
        task_acceptance: plan.tasks[0].acceptance,
        started: all
          .filter((event) => event.kind === 'session.gate_started')
          .map((event) => ({ session: named[event.aggregate_id], ...event.payload })),
      },
      'gate-logs.txt':
        checks
          .map((event) =>
            [
              `# ${named[event.aggregate_id] ?? event.aggregate_id} at ${event.payload.commit}`,
              ...event.payload.results.map(
                (result) =>
                  `## ${result.name}: exit ${result.exit_code}${result.timed_out ? ' (timed out)' : ''}\n${result.output}`,
              ),
            ].join('\n'),
          )
          .join('\n\n') + '\n',
      'merge-receipts.json': {
        ...merges,
        outcomes: all
          .filter((event) =>
            ['session.merge_started', 'session.merge_blocked', 'session.merged'].includes(
              event.kind,
            ),
          )
          .map((event) => ({
            sequence: event.sequence,
            kind: event.kind,
            session: named[event.aggregate_id] ?? event.aggregate_id,
            payload: event.payload,
          })),
        sessions: Object.fromEntries(
          Object.entries(ids).map(([name, id]) => {
            const row = sessionRow(board, id);
            return [name, { outcome: row?.outcome ?? null, merge: row?.merge ?? null }];
          }),
        ),
      },
      'reads.json': reads,
      'receipts.json': receipts,
      'events.json': all,
      'observations.json': observations,
    };
  }
}
