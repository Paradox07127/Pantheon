import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FixtureAdapter } from '@pantheon/adapters';
import { command, USER_PRINCIPAL_ID } from '@pantheon/protocol';
import { FakeAgentAdapter } from '../fixtures/fake-agent-adapter.mjs';
import { startFixtureDaemon } from '../lib/daemon.mjs';
import { waitFor } from '../lib/event-client.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { createWorkspaceRoot } from '../lib/workspace-root.mjs';

export const title = 'daemon 崩溃与未知结果';
export const mode = 'integration';

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const WAIT_MS = 30000;
const CRASH_TIMEOUT_MS = 20000;
/** How long the writer that outlives its agent keeps writing at most, in ms, if nothing stops it. */
const WRITER_LIFETIME_MS = 30000;
const crashChild = fileURLToPath(
  new URL('../lib/crash-daemon-at-agent-event.mjs', import.meta.url),
);
/** A turn input the fixture runtime runs as these steps. */
const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;
const ended = (turn) => !['queued', 'running'].includes(turn.state);
/** Signal 0 only asks the process table; EPERM still means the pid exists. */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

/** One daemon kill per task session: where the kill lands and what the session's agent runs. */
const rounds = [
  {
    task: 'Q',
    moment: 'turn queued',
    runtime: 'queued-agent',
    failpoint: 'after_commit_before_send',
    turns: () => [{ steps: [] }],
  },
  {
    task: 'R',
    moment: 'turn running',
    runtime: 'running-agent',
    killOn: 'turn.started',
    turns: () => [{ steps: [{ gate: 'never-opened' }] }, { steps: [] }],
  },
  {
    task: 'C',
    moment: 'before the completion receipt',
    runtime: 'completing-agent',
    killOn: 'turn.completed',
    turns: () => [{ steps: [{ message: 'Work finished' }] }, { steps: [] }],
  },
  {
    task: 'W',
    moment: 'writer outlives its agent',
    runtime: 'writer-agent',
    killOn: 'message.delta',
    turns: (file) => [
      {
        steps: [
          { write_child: { file, lifetime_ms: WRITER_LIFETIME_MS } },
          { message: 'Writer started' },
          { gate: 'never-opened' },
        ],
      },
      { steps: [] },
    ],
  },
];
const plan = {
  base_version: 0,
  headline: 'Daemon crash recovery',
  lanes: [{ id: 'main', title: 'Main' }],
  tasks: rounds.map(({ task }) => ({
    id: task,
    title: `Task ${task}`,
    goal: `Add ${task.toLowerCase()}.txt`,
    lane: 'main',
    depends_on: [],
    source: [`Add ${task.toLowerCase()}.txt`],
    scope: [`${task.toLowerCase()}.txt`],
    acceptance: [`test -f ${task.toLowerCase()}.txt`],
  })),
  milestones: [],
  risks: [],
  assumptions: [],
};

export async function run({ workspace, evidenceDir }) {
  const dataDir = path.join(workspace, 'daemon');
  const managed = createWorkspaceRoot('daemon-crash-recovery');
  const workspaceRoot = managed.root;
  const writerFile = path.join(workspace, 'sentinels', 'writer.log');
  const fakeAgents = rounds.map((round) => ({
    name: round.runtime,
    dir: path.join(workspace, 'agents', round.runtime),
    capabilities: { resume: true },
    script: { turns: round.turns(writerFile) },
  }));
  const options = { intervalMs: 50, workspaceRoot };
  let fixture, daemon, agents;
  const receipts = [],
    crashes = [],
    probes = [],
    ids = {},
    observations = {};
  let projectId, leadId, failure, evidence, needsYouItem, ledgers;

  const start = async () => {
    agents = fakeAgents.map((config) => new FakeAgentAdapter(config));
    fixture = await startFixtureDaemon(dataDir, [new FixtureAdapter(), ...agents], options);
    daemon = fixture.daemon;
  };
  const stop = async () => {
    await fixture?.close();
    fixture = undefined;
  };
  const submit = async (step, type, input, revision = null) => {
    const body = command(USER_PRINCIPAL_ID, type, input, revision);
    const result = await fixture.submit(body);
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
  const sessionRow = (board, id) => board.sessions.find((row) => row.id === id);
  const turnsOf = (board, id) => board.session_turns.filter((turn) => turn.session_id === id);
  const waitSession = (id, check, description) =>
    waitFor(
      async () => {
        const board = await snapshot();
        const session = sessionRow(board, id);
        return session && check(session, turnsOf(board, id)) ? board : false;
      },
      description,
      WAIT_MS,
    );
  const agentOf = (runtime) => agents.find((agent) => agent.name === runtime);
  const ledgerOf = async (round) => {
    const nativeId = `fake-${ids[round.task]}`;
    return agentOf(round.runtime)
      .ledger(nativeId)
      .catch(() => []);
  };
  /** Process table reads of every pid an agent ledger names. */
  const probe = async (moment) => {
    const entries = [];
    for (const round of rounds) {
      if (!ids[round.task]) continue;
      for (const line of await ledgerOf(round))
        if (['start', 'resume', 'child', 'escaped'].includes(line.type))
          entries.push({
            task: round.task,
            kind: line.type === 'child' || line.type === 'escaped' ? 'writer' : 'agent',
            ledger: line.type,
            pid: line.pid,
            alive: alive(line.pid),
          });
    }
    probes.push({ moment, at: new Date().toISOString(), processes: entries });
    return entries;
  };
  /** Kills a daemon process on the same data directory at the round's moment; this process's daemon is stopped first. */
  const crash = async (round, body) => {
    await stop();
    const marker = randomUUID();
    const child = spawn(
      process.execPath,
      [
        crashChild,
        JSON.stringify({
          directory: dataDir,
          workspaceRoot,
          fakeAgents,
          failpoint: round.failpoint,
          killOn: round.killOn ? { runtime: round.runtime, kind: round.killOn } : undefined,
          commands: [body],
          timeoutMs: CRASH_TIMEOUT_MS,
        }),
        `--crash-marker=${marker}`,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    const [code, signal] = await once(child, 'exit');
    return { task: round.task, moment: round.moment, pid: child.pid, code, signal, stderr };
  };

  try {
    const repo = path.join(workspace, 'repo');
    await mkdir(repo, { recursive: true });
    await mkdir(path.dirname(writerFile), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Daemon Crash Recovery');
    git(repo, 'config', 'user.email', 'daemon-crash-recovery@example.invalid');
    git(repo, 'config', 'commit.gpgsign', 'false');
    await writeFile(path.join(repo, 'README.md'), 'Daemon crash recovery\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-q', '-m', 'Initial commit');
    await start();
    const project = await call('open', 'project.open', {
      name: 'Daemon crash recovery',
      roots: [repo],
    });
    projectId = project.id;
    leadId = (
      await call('plan', 'session.create', {
        project_id: projectId,
        runtime: 'fixture',
        purpose: 'lead',
        input: script({ tool: { name: 'update_board', arguments: plan } }),
      })
    ).id;
    await waitSession(
      leadId,
      (session, turns) => session.state === 'open' && turns.length > 0 && turns.every(ended),
      'the lead to write the plan',
    );

    // One task session per round, opened by a daemon that dies at the round's moment.
    for (const round of rounds) {
      const body = command(
        USER_PRINCIPAL_ID,
        'session.create',
        {
          project_id: projectId,
          runtime: round.runtime,
          task_id: `${leadId}:${round.task}`,
          input: `Start task ${round.task}`,
        },
        null,
      );
      const child = await crash(round, body);
      await start();
      // The resend answers with the receipt the dead daemon committed.
      const resend = await fixture.submit(body);
      ids[round.task] = resend.data.receipt?.id;
      const board = await snapshot();
      const entry = {
        ...child,
        killed: child.signal === 'SIGKILL',
        session_id: ids[round.task] ?? null,
        resend: { status: resend.status, error: resend.data.error ?? null },
        after_restart: {
          session: sessionRow(board, ids[round.task]) ?? null,
          turns: turnsOf(board, ids[round.task]),
        },
        processes_after_restart: await probe(`restart after the ${round.moment} kill`),
      };
      crashes.push(entry);
      if (!entry.killed || !ids[round.task])
        throw new Error(`The ${round.moment} kill did not happen: ${JSON.stringify(child)}`);
      if (round.task === 'W') break;
      // The restarted daemon runs the queued turn, or continues the session after its old agent stopped.
      entry.settled = await waitSession(
        ids[round.task],
        (session, turns) =>
          session.state === 'open' &&
          turns.every(ended) &&
          turns.some((turn) => turn.state === 'completed'),
        `task ${round.task} to finish a turn after the restart`,
      ).then((settled) => turnsOf(settled, ids[round.task]));
    }

    // The writer of task W still runs after its agent died: the session waits in "needs you".
    const writerRound = rounds.find((round) => round.task === 'W');
    await waitSession(
      ids.W,
      (session) => session.state === 'reconciling',
      'task W to be reconciling',
    );
    const needsYou = await get('needs_you.list', { project_id: projectId });
    needsYouItem =
      needsYou.items.find(
        (item) => item.source?.table === 'sessions' && item.source.id === ids.W,
      ) ?? null;
    const writersBefore = (await probe('writer branch before resolve')).filter(
      (entry) => entry.task === 'W' && entry.kind === 'writer',
    );
    const refused = await submit(
      'resolve while the writer runs',
      'session.resolve',
      { session_id: ids.W, choice: 'resume_session' },
      sessionRow(await snapshot(), ids.W).revision,
    );
    observations.recovery = {
      unconfirmed_stop_in_needs_you:
        needsYouItem !== null &&
        sessionRow(await snapshot(), ids.W).state === 'reconciling' &&
        writersBefore.length > 0 &&
        writersBefore.every((entry) => entry.alive),
    };

    // Once the writer has stopped, the user resumes the native session and continues it.
    await agentOf(writerRound.runtime).stopWriters();
    await probe('writer branch after the writer stopped');
    await call(
      'resolve',
      'session.resolve',
      { session_id: ids.W, choice: 'resume_session' },
      sessionRow(await snapshot(), ids.W).revision,
    );
    const resumed = await waitSession(
      ids.W,
      (session) => session.state === 'open',
      'task W to be resumed',
    );
    await call(
      'continue',
      'session.send',
      { session_id: ids.W, input: 'Continue task W' },
      sessionRow(resumed, ids.W).revision,
    );
    await waitSession(
      ids.W,
      (session, turns) =>
        session.state === 'open' &&
        turns.every(ended) &&
        turns.some((turn) => turn.state === 'completed'),
      'task W to finish a turn after the resume',
    );

    const board = await snapshot(),
      all = await events();
    ledgers = {};
    for (const round of rounds) ledgers[round.task] = await ledgerOf(round);
    const subjects = rounds.map((round) => ids[round.task]);
    const completedByRuntime = (turnId) =>
      all.some(
        (event) =>
          event.kind === 'agent.turn.completed' &&
          event.payload.turn_id === turnId &&
          event.payload.status === 'completed',
      );
    const startsOf = (sessionId) =>
      all.filter(
        (event) => event.kind === 'agent.session.started' && event.aggregate_id === sessionId,
      );
    /** Earlier agent or writer processes of the native session still running when a new agent process started. */
    const overlaps = (lines) => {
      const running = new Set();
      let count = 0;
      for (const line of lines) {
        if (line.type === 'start' || line.type === 'resume') {
          count += running.size;
          running.add(line.pid);
        } else if (line.type === 'child' || line.type === 'escaped') running.add(line.pid);
        else if (line.type === 'agent_exit' || line.type === 'writer_exit')
          running.delete(line.pid);
      }
      return count;
    };
    observations.recovery.false_successes = board.session_turns.filter(
      (turn) =>
        subjects.includes(turn.session_id) &&
        turn.state === 'completed' &&
        !completedByRuntime(turn.id),
    ).length;
    observations.recovery.concurrent_writers = rounds.reduce(
      (sum, round) => sum + overlaps(ledgers[round.task]),
      0,
    );
    observations.recovery.duplicate_native_start = rounds.reduce((sum, round) => {
      const fresh = ledgers[round.task].filter((line) => line.type === 'start').length;
      const nativeIds = new Set(
        startsOf(ids[round.task]).map((event) => event.payload.native_session_id),
      );
      return sum + Math.max(0, fresh - 1) + Math.max(0, nativeIds.size - 1);
    }, 0);
    observations.recovery.resolve_while_writer_ran = {
      status: refused.status,
      error: refused.data.error ?? null,
    };
  } catch (error) {
    failure = error;
  } finally {
    try {
      if (!fixture && projectId) await start();
      evidence = await collectEvidence();
    } catch (error) {
      evidence = { 'collection-error.txt': String(error?.stack ?? error) };
    }
    await stop();
    // Writers end at the stop file; a failed run may have left one before it.
    await new FakeAgentAdapter(fakeAgents.at(-1)).stopWriters().catch(() => {});
    // The evidence holds this list, so the reads after the close still reach it.
    if (agents) await probe('after the daemon closed').catch(() => {});
    managed.remove();
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
    adapters: ['fixture@1', ...fakeAgents.map((agent) => `${agent.name}@1`)],
  };

  async function collectEvidence() {
    if (!projectId) return { 'recovery-receipt.json': { crashes, commands: receipts } };
    const board = await snapshot(),
      all = await events();
    const subjects = new Set(Object.values(ids));
    await probe('evidence collection');
    return {
      'recovery-receipt.json': {
        ids: { lead: leadId, ...ids },
        crashes,
        commands: receipts,
        needs_you_item: needsYouItem ?? null,
        sessions: board.sessions
          .filter((row) => subjects.has(row.id))
          .map(({ id, state, runtime, native_id, process_identity }) => ({
            id,
            state,
            runtime,
            native_id,
            process_identity,
          })),
        session_turns: board.session_turns
          .filter((turn) => subjects.has(turn.session_id))
          .map(({ id, session_id, origin, state, delivery, delivery_reason }) => ({
            id,
            session_id,
            origin,
            state,
            delivery,
            delivery_reason,
          })),
        native_session_starts: all
          .filter(
            (event) => event.kind === 'agent.session.started' && subjects.has(event.aggregate_id),
          )
          .map((event) => ({
            sequence: event.sequence,
            session_id: event.aggregate_id,
            native_session_id: event.payload.native_session_id,
          })),
        agent_ledgers: ledgers ?? null,
        observations,
      },
      'process-probes.json': probes,
      'events.jsonl': all.map((event) => JSON.stringify(event)).join('\n') + '\n',
    };
  }
}
