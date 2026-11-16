import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { command, USER_PRINCIPAL_ID } from '@pantheon/protocol';
import { startFixtureDaemon } from '../lib/daemon.mjs';
import { waitFor } from '../lib/event-client.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { createWorkspaceRoot } from '../lib/workspace-root.mjs';
import { RecordingFixtureAdapter } from '../fixtures/recording-fixture-adapter.mjs';

export const title = '首启导入与原地续接(fixture)';
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
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;
const ended = (turn) => !['queued', 'running'].includes(turn.state);

/** The recording fixture that also keeps each native resume with the cwd it was given. */
class ResumeRecordingAdapter extends RecordingFixtureAdapter {
  resumes = [];

  async resume(spec, nativeSessionId, emit) {
    const handle = await super.resume(spec, nativeSessionId, emit);
    this.specs.set(spec.platform_session_id, spec);
    this.resumes.push({
      session_id: spec.platform_session_id,
      native_session_id: nativeSessionId,
      cwd: spec.cwd,
      workspace: spec.workspace ?? null,
    });
    return handle;
  }

  /** Resumes of a native session that already existed, not the ones a fresh start makes. */
  get nativeResumes() {
    const started = new Set(this.starts.map((start) => start.native_session_id));
    return this.resumes.filter((resume) => !started.has(resume.native_session_id));
  }
}

const claudeLines = (id, cwd, at, prompt) => [
  {
    type: 'user',
    uuid: randomUUID(),
    parentUuid: null,
    isSidechain: false,
    timestamp: new Date(at).toISOString(),
    message: { role: 'user', content: prompt },
    turnPosition: { promptIndex: 1, turnIndex: 1 },
    cwd,
    sessionId: id,
    version: '2.1.309',
  },
  {
    type: 'assistant',
    uuid: randomUUID(),
    isSidechain: false,
    timestamp: new Date(at + 5000).toISOString(),
    message: { role: 'assistant', model: 'fixture', content: [{ type: 'text', text: 'Done.' }] },
    cwd,
    sessionId: id,
    version: '2.1.309',
  },
];
const codexLines = (id, cwd, at, prompt) => [
  {
    timestamp: new Date(at).toISOString(),
    type: 'session_meta',
    payload: { id, cwd, timestamp: new Date(at).toISOString(), cli_version: '0.166.0' },
  },
  {
    timestamp: new Date(at + 100).toISOString(),
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: randomUUID() },
  },
  {
    timestamp: new Date(at + 200).toISOString(),
    type: 'event_msg',
    payload: { type: 'user_message', message: prompt },
  },
];

export async function run({ workspace, evidenceDir }) {
  const claude = new ResumeRecordingAdapter('claude');
  const codex = new ResumeRecordingAdapter('codex');
  const adapters = [claude, codex];
  const workspaceRoot = createWorkspaceRoot('pantheon-acceptance');
  const home = path.join(workspace, 'home');
  const projects = path.join(workspace, 'projects');
  const roots = {
    alpha: path.join(projects, 'alpha'),
    beta: path.join(projects, 'beta'),
    nested: path.join(projects, 'alpha', 'nested'),
    gone: path.join(projects, 'gone'),
  };
  const records = [];
  const receipts = [],
    reads = {},
    observations = {};
  let fixture, daemon, projectId, failure, evidence;

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
  const get = async (method, params = {}) => {
    const response = await fetch(`${daemon.url}/v1/${method}?${new URLSearchParams(params)}`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`${method}: ${JSON.stringify(data)}`);
    return data;
  };
  const sessionRow = async (sessionId) =>
    (await get('board', { project_id: projectId })).sessions.find((row) => row.id === sessionId);
  /** Polls until the check holds or the wait runs out, and returns its last answer. */
  const eventually = async (check) => {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const result = await check();
      if (result || Date.now() >= deadline) return result;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  const writeRecord = async (runtime, cwd, ageMs, prompt) => {
    const id = randomUUID();
    const at = Date.now() - ageMs;
    const stamp = new Date(at).toISOString();
    const file =
      runtime === 'claude'
        ? path.join(home, '.claude/projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`)
        : path.join(
            home,
            '.codex/sessions',
            stamp.slice(0, 4),
            stamp.slice(5, 7),
            stamp.slice(8, 10),
            `rollout-${stamp.slice(0, 19).replaceAll(':', '-')}-${id}.jsonl`,
          );
    const lines = (runtime === 'claude' ? claudeLines : codexLines)(id, cwd, at, prompt);
    const text = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
    const mtime = new Date(at + 5000);
    await utimes(file, mtime, mtime);
    records.push({
      runtime,
      native_session_id: id,
      cwd,
      file,
      text,
      updated_at: mtime.toISOString(),
    });
  };
  const initRepo = (dir, name) => {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'First Run Import');
    git(dir, 'config', 'user.email', 'first-run-import@example.invalid');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'add', 'README.md');
    git(dir, 'commit', '-q', '-m', `Start ${name}`);
  };
  const worktreeCount = (dir) =>
    git(dir, 'worktree', 'list', '--porcelain')
      .split('\n')
      .filter((line) => line.startsWith('worktree ')).length - 1;
  const hiddenRefs = (dir) =>
    git(dir, 'for-each-ref', '--format=%(refname)', 'refs/pantheon/').split('\n').filter(Boolean);

  try {
    // Folders with native history: alpha and beta are repositories, nested sits inside alpha, gone is deleted.
    for (const name of ['alpha', 'beta', 'nested', 'gone']) {
      await mkdir(roots[name], { recursive: true });
      await writeFile(path.join(roots[name], 'README.md'), `${name}\n`);
    }
    initRepo(roots.alpha, 'alpha');
    git(roots.alpha, 'remote', 'add', 'origin', 'https://github.com/example/alpha.git');
    initRepo(roots.beta, 'beta');
    initRepo(roots.nested, 'nested');
    for (const name of Object.keys(roots)) roots[name] = realpathSync(roots[name]);
    for (const [index, age] of [HOUR, 2 * HOUR, 3 * HOUR, 5 * HOUR].entries())
      await writeRecord('claude', roots.alpha, age, `Alpha work ${index + 1}`);
    await writeRecord('codex', roots.beta, 40 * DAY, 'Beta work');
    for (const [index, age] of [HOUR, 2 * HOUR, 4 * HOUR].entries())
      await writeRecord('claude', roots.nested, age, `Nested work ${index + 1}`);
    await writeRecord('claude', roots.gone, 2 * DAY, 'Gone work');
    await rm(roots.gone, { recursive: true });

    // The daemon reads native history from the fake home only.
    fixture = await startFixtureDaemon(path.join(workspace, 'daemon'), adapters, {
      intervalMs: 50,
      workspaceRoot: workspaceRoot.root,
      protectionPaths: {
        dataDir: path.join(workspace, 'daemon', 'state'),
        backupDir: path.join(workspace, 'daemon', 'backups'),
        desktopUserDataDir: path.join(home, 'Library/Application Support/Pantheon Desktop'),
        home,
        codexHome: path.join(home, '.codex'),
      },
    });
    ({ daemon } = fixture);

    // The first-run list, once every native transcript is indexed.
    const found = await waitFor(
      async () => {
        const result = await get('import.candidates');
        return result.indexing === null ? result : false;
      },
      'the native transcripts to be indexed',
      WAIT_MS,
    );
    reads.candidates = found;
    const preselected = found.candidates.filter((candidate) => candidate.preselected);
    observations.import = {
      preselected: preselected.map((candidate) => candidate.name).sort(),
      excluded: found.candidates
        .filter((candidate) => candidate.excluded)
        .map((candidate) => `${candidate.name}:${candidate.excluded}`)
        .sort(),
    };

    // Opening the preselected folders; alpha lists its sessions to continue.
    const opened = {};
    for (const candidate of preselected) {
      const project = await call('open', 'project.open', {
        name: candidate.name,
        roots: [candidate.root],
      });
      opened[candidate.name] = project;
    }
    projectId = opened.alpha?.id;
    if (!projectId) throw new Error('alpha was not opened as a project');
    const importable = await eventually(async () => {
      const list = await get('session.importable', { project_id: projectId });
      return list.length ? list : false;
    });
    reads.importable = importable || [];
    observations.import.importable_count = reads.importable.length;

    // Adopting one alpha session in place and sending it one turn.
    const picked = records.find(
      (record) =>
        record.cwd === roots.alpha &&
        reads.importable.some((row) => row.native_session_id === record.native_session_id),
    );
    if (!picked) throw new Error('No alpha session is importable');
    const adopted = await call('adopt', 'session.adopt', {
      project_id: projectId,
      runtime: picked.runtime,
      native_session_id: picked.native_session_id,
    });
    const sessionId = adopted.id;
    const idle = await waitFor(
      async () => {
        const row = await sessionRow(sessionId);
        return row?.state === 'open' ? row : false;
      },
      'the adopted session to open',
      WAIT_MS,
    );
    await call(
      'adopt',
      'session.send',
      { session_id: sessionId, input: script({ say: 'Continuing alpha' }) },
      idle.revision,
    );
    const turned = await waitFor(
      async () => {
        const board = await get('board', { project_id: projectId });
        const row = board.sessions.find((session) => session.id === sessionId);
        const turns = board.session_turns.filter((turn) => turn.session_id === sessionId);
        return row?.state === 'open' && turns.length && turns.every(ended) ? row : false;
      },
      'the turn of the adopted session to end',
      WAIT_MS,
    );

    const adapter = adapters.find((one) => one.name === picked.runtime);
    const resumes = adapter.nativeResumes.filter((resume) => resume.session_id === sessionId);
    const merge = await send('refuse', 'session.merge', { session_id: sessionId }, turned.revision);
    const discard = await send(
      'refuse',
      'session.discard',
      { session_id: sessionId },
      (await sessionRow(sessionId)).revision,
    );
    observations.adopt = {
      resumed_same_native_id:
        !adapter.starts.some((start) => start.session_id === sessionId) &&
        resumes.length > 0 &&
        resumes.every((resume) => resume.native_session_id === picked.native_session_id) &&
        adapter.sends.some((one) => one.session_id === sessionId),
      cwd_is_original:
        resumes.length > 0 &&
        resumes.every((resume) => realpathSync(resume.cwd) === realpathSync(picked.cwd)),
      worktrees_created: readdirSync(workspaceRoot.root).length + worktreeCount(roots.alpha),
      hidden_refs: hiddenRefs(roots.alpha).length,
      merge_refused: merge.status !== 200,
      discard_refused: discard.status !== 200,
    };

    // Deleting the session leaves the folder and the native record; the trace shows it external again.
    await call(
      'delete',
      'session.delete',
      { session_id: sessionId },
      (await sessionRow(sessionId)).revision,
    );
    const lane = await eventually(async () => {
      const trace = await get('project.trace', { project_id: projectId });
      reads.trace = trace;
      const row = trace.lanes.find((one) => one.lane.native_id === picked.native_session_id);
      return row?.lane.source === 'external' ? row : false;
    });
    observations.delete = {
      directory_intact:
        existsSync(path.join(roots.alpha, '.git')) &&
        existsSync(path.join(roots.alpha, 'README.md')) &&
        existsSync(picked.file) &&
        readFileSync(picked.file, 'utf8') === picked.text,
      lane_returned_external: Boolean(lane),
    };
  } catch (error) {
    failure = error;
  } finally {
    evidence = {
      'import-candidates.json': {
        records: records.map(({ text, ...record }) => record),
        candidates: reads.candidates ?? null,
        importable: reads.importable ?? null,
      },
      'adopt-receipts.json': { receipts, trace: reads.trace ?? null },
      'session-specs.json': adapters.map((adapter) => ({
        runtime: adapter.name,
        specs: [...adapter.specs.values()],
        starts: adapter.starts,
        resumes: adapter.resumes,
        sends: adapter.sends,
        closes: adapter.closes,
      })),
    };
    try {
      await fixture?.close();
    } finally {
      workspaceRoot.remove();
    }
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
    adapters: adapters.map((adapter) => `${adapter.name}@${adapter.report.version}`),
  };
}
