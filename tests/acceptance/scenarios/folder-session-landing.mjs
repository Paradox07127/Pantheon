import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FixtureAdapter } from '@pantheon/adapters';
import { command, USER_PRINCIPAL_ID } from '@pantheon/protocol';
import { startFixtureDaemon } from '../lib/daemon.mjs';
import { waitFor } from '../lib/event-client.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

export const title = '新会话默认在项目目录改，门禁通过后落地，目录被占时开工作树(fixture)';
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
const passingGate = [{ name: 'Passes', argv: [process.execPath, '-e', 'process.exit(0)'] }];
/** A turn input the fixture runtime runs as these steps. */
const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;
const ended = (turn) => !['queued', 'running'].includes(turn.state);

export async function run({ workspace, evidenceDir }) {
  const adapter = new FixtureAdapter();
  const home = path.join(workspace, 'home');
  const fixture = await startFixtureDaemon(path.join(workspace, 'daemon'), [adapter], {
    intervalMs: 50,
    workspaceRoot: path.join(workspace, 'workspaces'),
    protectionPaths: {
      dataDir: path.join(workspace, 'daemon/state'),
      backupDir: path.join(workspace, 'backups'),
      desktopUserDataDir: path.join(home, 'Library/Application Support/Pantheon Desktop'),
      home,
      codexHome: path.join(home, '.codex'),
    },
  });
  const { daemon } = fixture;
  const receipts = [],
    ids = {},
    observations = {};
  let projectId, repo, failure, evidence;

  const call = async (step, type, input, revision = null) => {
    const result = await fixture.submit(command(USER_PRINCIPAL_ID, type, input, revision));
    receipts.push({ step, type, input, expected_revision: revision, ...result });
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
  const sessionRow = (board, id) => board.sessions.find((row) => row.id === id);
  const listed = async (id) =>
    (await get('session.list', { project_id: projectId })).find((row) => row.id === id);
  const workspaceKind = (board, id) =>
    board.workspaces.find((row) => row.id === sessionRow(board, id).workspace_id)?.kind ?? null;
  const commits = () => Number(git(repo, 'rev-list', '--count', 'main').trim());
  // What the new-session page sends when the user chooses nothing.
  const newSession = (step, input) =>
    call(step, 'session.create', { project_id: projectId, input, workspace: 'auto' });
  const settled = (id, what) =>
    waitFor(
      async () => {
        const board = await snapshot();
        const turns = board.session_turns.filter((turn) => turn.session_id === id);
        return turns.length && turns.every(ended) ? board : false;
      },
      what,
      WAIT_MS,
    );

  try {
    repo = path.join(workspace, 'repo');
    await mkdir(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Folder Session');
    git(repo, 'config', 'user.email', 'folder-session@example.invalid');
    git(repo, 'config', 'commit.gpgsign', 'false');
    await writeFile(path.join(repo, 'README.md'), 'Folder session\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-q', '-m', 'Initial commit');
    const project = await call('open', 'project.open', { name: 'Folder session', roots: [repo] });
    projectId = project.id;
    await call(
      'open',
      'project.gate.set',
      { project_id: projectId, root: project.roots[0], commands: passingGate },
      project.revision,
    );
    await call(
      'open',
      'project.sessionDefaults.set',
      { project_id: projectId, runtime: adapter.name, permission_mode: 'auto_edit' },
      (await snapshot()).projects.find((row) => row.id === projectId).revision,
    );

    // The first session works in the project folder; its runtime writes a file and commits.
    const before = commits();
    ids.first = (
      await newSession(
        'first',
        script({ write: { path: 'notes.txt', text: 'notes\n' } }, { commit: 'Add notes' }),
      )
    ).id;
    let board = await settled(ids.first, 'the first session to write and commit');
    observations.first = {
      workspace_kind: workspaceKind(board, ids.first),
      branch: git(repo, 'branch', '--show-current').trim(),
    };

    await call(
      'gates',
      'session.gates.run',
      { session_id: ids.first },
      sessionRow(board, ids.first).revision,
    );
    await waitFor(
      async () => {
        const gates = await get('session.gates', { session_id: ids.first });
        return !gates.running && gates.last ? gates : false;
      },
      'the gates of the first session',
      WAIT_MS,
    );
    board = await snapshot();
    await call(
      'land',
      'session.merge',
      { session_id: ids.first },
      sessionRow(board, ids.first).revision,
    );
    board = await snapshot();
    observations.land = {
      outcome: sessionRow(board, ids.first).outcome ?? null,
      new_commits: commits() - before,
      branch: git(repo, 'branch', '--show-current').trim(),
    };

    // A second session takes the folder; the next one gets a worktree that names it.
    ids.second = (await newSession('second', 'Look at the parser')).id;
    await settled(ids.second, 'the second session to answer');
    ids.third = (await newSession('third', 'Look at the tests')).id;
    board = await snapshot();
    const third = await listed(ids.third);
    observations.busy = {
      second_kind: workspaceKind(board, ids.second),
      third_kind: workspaceKind(board, ids.third),
      reason_names_second: third?.worktree_reason?.holder_session_id === ids.second,
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
      'board.json': { sessions: board.sessions, workspaces: board.workspaces },
      'git-log.txt': git(repo, 'log', '--oneline', 'main'),
      'observations.json': observations,
    };
  }
}
