import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { command, USER_PRINCIPAL_ID } from '@pantheon/protocol';
import { RecordingFixtureAdapter } from '../fixtures/recording-fixture-adapter.mjs';
import { startFixtureDaemon } from '../lib/daemon.mjs';
import { waitFor } from '../lib/event-client.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

export const title =
  '带工具会话读状态、起会话、收通知、要审查，阻塞发现时拒绝落地，再审无阻塞后落地(fixture)';
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
const CONDUCTOR = 'fixture-conductor';
const WRITER = 'fixture-writer';
const REVIEWER = 'fixture-reviewer';
const FEATURE = 'feature.txt';
const DEFECT = 'answer = 41';
const passingGate = [{ name: 'Passes', argv: [process.execPath, '-e', 'process.exit(0)'] }];
/** A turn input the fixture runtime runs as these steps. */
const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;
const tool = (name, args = {}) => ({ tool: { name, arguments: args } });
const ended = (turn) => !['queued', 'running'].includes(turn.state);

/** The fixture runtime under its own name that also keeps every tool call and its result. */
class ToolRecordingAdapter extends RecordingFixtureAdapter {
  tools = [];
  #record(spec, emit) {
    return (event) => {
      if (event.kind === 'tool.started')
        this.tools.push({
          session_id: spec.platform_session_id,
          tool_call_id: event.tool_call_id,
          name: event.name,
          input: event.input,
        });
      if (event.kind === 'tool.completed') {
        const call = this.tools.find((each) => each.tool_call_id === event.tool_call_id);
        if (call) Object.assign(call, { ok: event.ok, output: event.output });
      }
      emit(event);
    };
  }
  // A new native session starts through resume too.
  async resume(spec, nativeSessionId, emit) {
    return super.resume(spec, nativeSessionId, this.#record(spec, emit));
  }
}

export async function run({ workspace, evidenceDir }) {
  const reviewerSessions = [];
  // What the conductor runtime does with each message Pantheon sends it.
  const conductorInput = async ({ input }) => {
    if (!input.startsWith('[Pantheon]')) return input;
    if (/\) landed on /.test(input)) return input;
    const reviewed = input.match(/^\[Pantheon\] Review \S+: completed\. Reviewed session (\S+)\./m);
    if (reviewed) return script(tool('report_ready', { session_id: reviewed[1] }));
    const spawned = input.match(
      new RegExp(`\\((\\S+), ${WRITER}\\), which you spawned, completed its turn`),
    );
    if (spawned)
      return script(tool('request_review', { session_id: spawned[1], runtimes: [REVIEWER] }));
    return input;
  };
  // The first review finds a blocking defect; the second, after the fix, passes.
  const reviewerInput = async ({ session_id }) => {
    if (!reviewerSessions.includes(session_id)) reviewerSessions.push(session_id);
    return reviewerSessions.indexOf(session_id) === 0
      ? script(
          tool('review_finding', {
            location: `${FEATURE}:1`,
            quote: DEFECT,
            evidence: 'The answer is 41, one less than the expected 42',
            impact: 'Every reader gets the wrong answer',
            blocking: true,
            reproduction: { command: `cat ${FEATURE}`, expected: 'answer = 42', actual: DEFECT },
          }),
        )
      : script(tool('review_verdict', { verdict: 'pass', summary: `Checked ${FEATURE}` }));
  };
  const conductor = new ToolRecordingAdapter(CONDUCTOR, { input: conductorInput });
  const writer = new ToolRecordingAdapter(WRITER);
  const reviewer = new ToolRecordingAdapter(REVIEWER, { input: reviewerInput });
  const home = path.join(workspace, 'home');
  const fixture = await startFixtureDaemon(
    path.join(workspace, 'daemon'),
    [conductor, writer, reviewer],
    {
      intervalMs: 50,
      workspaceRoot: path.join(workspace, 'workspaces'),
      protectionPaths: {
        dataDir: path.join(workspace, 'daemon/state'),
        backupDir: path.join(workspace, 'backups'),
        desktopUserDataDir: path.join(home, 'Library/Application Support/Pantheon Desktop'),
        home,
        codexHome: path.join(home, '.codex'),
      },
    },
  );
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
  const workspaceOf = (board, id) =>
    board.workspaces.find((row) => row.id === sessionRow(board, id).workspace_id);
  const turnsOf = (board, id) => board.session_turns.filter((turn) => turn.session_id === id);
  const settled = (id, what) =>
    waitFor(
      async () => {
        const board = await snapshot();
        const turns = turnsOf(board, id);
        return turns.length && turns.every(ended) && sessionRow(board, id).state !== 'running'
          ? board
          : false;
      },
      what,
      WAIT_MS,
    );
  const calls = (name) =>
    conductor.tools.filter((each) => each.session_id === ids.conductor && each.name === name);
  const finished = (name, count) =>
    waitFor(
      () => calls(name).length >= count && calls(name)[count - 1].ok !== undefined,
      `call ${count} of ${name}`,
      WAIT_MS,
    );
  const notices = () =>
    conductor.sends
      .filter((each) => each.session_id === ids.conductor && each.input.startsWith('[Pantheon]'))
      .map((each) => each.input);
  const reviewsOf = (sessionId) => get('session.reviews', { session_id: sessionId });
  const reviewDone = (count) =>
    waitFor(
      async () => {
        const reviews = await reviewsOf(ids.spawned);
        return reviews.length >= count && reviews.every((row) => row.state !== 'running')
          ? reviews
          : false;
      },
      `review ${count} of the spawned session`,
      WAIT_MS,
    );
  const blockingOpen = (review) =>
    review.findings.some((row) => row.blocking && row.status === 'open' && !row.resolution);

  try {
    repo = path.join(workspace, 'repo');
    await mkdir(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Conductor Loop');
    git(repo, 'config', 'user.email', 'conductor-loop@example.invalid');
    git(repo, 'config', 'commit.gpgsign', 'false');
    await writeFile(path.join(repo, 'README.md'), 'Conductor loop\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-q', '-m', 'Initial commit');
    const project = await call('open', 'project.open', { name: 'Conductor loop', roots: [repo] });
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
      { project_id: projectId, runtime: CONDUCTOR, permission_mode: 'auto_edit' },
      (await snapshot()).projects.find((row) => row.id === projectId).revision,
    );
    const mainBefore = git(repo, 'rev-parse', 'main').trim();

    // The conductor reads the project, commits a plan in its worktree and spawns a writer from there.
    ids.conductor = (
      await call('conductor', 'session.create', {
        project_id: projectId,
        runtime: CONDUCTOR,
        purpose: 'conductor',
        workspace: 'worktree',
        input: script(
          tool('read_state'),
          { write: { path: 'plan.txt', text: 'Write the feature\n' } },
          { commit: 'Add the plan' },
          tool('spawn_session', {
            runtime: WRITER,
            input: script(
              { write: { path: FEATURE, text: `${DEFECT}\n` } },
              { commit: 'Add the feature' },
            ),
          }),
        ),
      })
    ).id;
    await finished('spawn_session', 1);
    ids.spawned = (await snapshot()).sessions.find(
      (row) => row.spawned_by?.session_id === ids.conductor,
    )?.id;
    observations.spawn_returned_id = String(calls('spawn_session')[0].output).includes(
      `"${ids.spawned}"`,
    );
    let board = await settled(ids.spawned, 'the spawned session to write and commit');
    const conductorPath = workspaceOf(board, ids.conductor).path;
    const conductorHead = git(conductorPath, 'rev-parse', 'HEAD').trim();
    const spawnedWorkspace = workspaceOf(board, ids.spawned);
    const spawnedSpec = writer.specs.get(ids.spawned);
    let state;
    try {
      state = JSON.parse(calls('read_state')[0].output).receipt;
    } catch {
      state = null;
    }
    observations.read_state = {
      ok: calls('read_state')[0].ok,
      lists_self: Boolean(
        state?.changes?.some((row) => row.self === true && row.id === `session:${ids.conductor}`),
      ),
    };
    observations.spawn = {
      spawned_by_conductor: sessionRow(board, ids.spawned).spawned_by?.session_id === ids.conductor,
      runtime: sessionRow(board, ids.spawned).runtime,
      worktree: spawnedWorkspace.kind,
      base_is_conductor_commit:
        conductorHead !== mainBefore &&
        git(spawnedWorkspace.path, 'rev-parse', 'HEAD~1').trim() === conductorHead,
      committed_feature: git(spawnedWorkspace.path, 'show', `HEAD:${FEATURE}`) === `${DEFECT}\n`,
      pantheon_tools: Boolean(spawnedSpec?.pantheon_mcp),
    };

    // The spawned turn's end wakes the conductor, which asks for a review; the review blocks.
    const first = await reviewDone(1);
    await finished('report_ready', 1);
    board = await settled(ids.conductor, 'the conductor to try to land the blocked work');
    const woke = turnsOf(board, ids.conductor).find(
      (turn) => turn.origin === 'tracker' && turn.input.includes(`(${ids.spawned}, ${WRITER})`),
    );
    observations.notified = {
      tracker_turn: woke?.input.startsWith('[Pantheon]') ?? false,
      turn_state: woke?.state ?? null,
      requested_review: calls('request_review')[0]?.ok ?? false,
    };
    const refused = calls('report_ready')[0];
    observations.blocked = {
      review_state: first[0].state,
      blocking_open: blockingOpen(first[0]),
      ready_ok: refused.ok,
      ready_refusal: String(refused.output ?? '').includes('open blocking findings'),
      main_unmoved: git(repo, 'rev-parse', 'main').trim() === mainBefore,
      spawned_outcome: sessionRow(board, ids.spawned).outcome ?? null,
    };

    // The user has the writer fix it; its turn end wakes the conductor, which reviews and lands.
    await call(
      'fix',
      'session.send',
      {
        session_id: ids.spawned,
        input: script(
          { write: { path: FEATURE, text: 'answer = 42\n' } },
          { commit: 'Fix the answer' },
        ),
      },
      sessionRow(board, ids.spawned).revision,
    );
    const reviews = await reviewDone(2);
    await finished('report_ready', 2);
    await waitFor(
      () => notices().some((text) => text.includes(`(${ids.spawned}) landed on `)),
      'the conductor to hear the landing',
      WAIT_MS,
    );
    board = await settled(ids.conductor, 'the conductor to read the landing');
    const second = reviews.find((row) => row.id !== first[0].id);
    // The landed worktree is gone; the second review read the fixed head.
    const spawnedHead = second?.range?.to_sha;
    const gates = await get('session.gates', { session_id: ids.spawned });
    observations.landed = {
      second_review_state: second?.state ?? null,
      second_blocking_open: second ? blockingOpen(second) : null,
      ready_ok: calls('report_ready')[1].ok,
      gate_passed:
        gates.last?.commit === spawnedHead &&
        gates.last.results.length > 0 &&
        gates.last.results.every((result) => result.exit_code === 0),
      fast_forwarded: git(repo, 'rev-parse', 'main').trim() === spawnedHead,
      main_has_fix: git(repo, 'show', `main:${FEATURE}`) === 'answer = 42\n',
      spawned_outcome: sessionRow(board, ids.spawned).outcome ?? null,
      conductor_told: notices().some((text) =>
        text.includes(`(${ids.spawned}) landed on main at ${spawnedHead}`),
      ),
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
    adapters: [conductor, writer, reviewer].map(
      (adapter) => `${adapter.name}@${adapter.report.version}`,
    ),
  };

  async function collectEvidence() {
    if (!projectId) return { 'receipts.json': receipts };
    const board = await snapshot();
    return {
      'receipts.json': { ids, receipts },
      'board.json': {
        sessions: board.sessions,
        workspaces: board.workspaces,
        session_turns: board.session_turns,
      },
      'tool-calls.json': {
        conductor: conductor.tools,
        writer: writer.tools,
        reviewer: reviewer.tools,
      },
      'reviews.json': ids.spawned ? await reviewsOf(ids.spawned) : [],
      'git-log.txt': git(repo, 'log', '--oneline', 'main'),
      'observations.json': observations,
    };
  }
}
