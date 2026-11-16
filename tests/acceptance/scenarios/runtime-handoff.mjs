import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { command, USER_PRINCIPAL_ID } from '@pantheon/protocol';
import { RecordingFixtureAdapter } from '../fixtures/recording-fixture-adapter.mjs';
import { startFixtureDaemon } from '../lib/daemon.mjs';
import { waitFor } from '../lib/event-client.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { createWorkspaceRoot } from '../lib/workspace-root.mjs';

export const title = '换模型或 harness 的交接';
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
const FIRST_RUNTIME = 'fixture';
const SECOND_RUNTIME = 'fixture-successor';
const HANDOFF_LINE = `[Pantheon] You continue work that a ${FIRST_RUNTIME} session did in this worktree.`;
// The old conversation's answer; the new one can only know it from the handoff.
const EARLIER_ANSWER = 'The export header goes into a.txt';
// Found on the daemon's PATH, so no machine path lands in the evidence.
const passingGate = [{ name: 'Passes', argv: ['node', '-e', 'process.exit(0)'] }];
const plan = (base_version, fields = {}) => ({
  base_version,
  headline: 'Runtime handoff',
  lanes: [{ id: 'main', title: 'Main' }],
  tasks: [
    {
      id: 'A',
      title: 'Task A',
      goal: 'Add a.txt with the export header',
      lane: 'main',
      depends_on: [],
      source: ['Add a.txt with the export header'],
      scope: ['a.txt'],
      acceptance: ['test -f a.txt'],
      ...fields,
    },
  ],
  milestones: [],
  risks: [],
  assumptions: [],
});

/** A turn input the fixture runtime runs as these steps. */
const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;
const ended = (turn) => !['queued', 'running'].includes(turn.state);
const passed = (run) =>
  Boolean(run?.results.length) &&
  run.results.every((result) => result.exit_code === 0 && !result.timed_out);

export async function run({ workspace, evidenceDir }) {
  const first = new RecordingFixtureAdapter(FIRST_RUNTIME);
  const second = new RecordingFixtureAdapter(SECOND_RUNTIME);
  const workspaceRoot = createWorkspaceRoot('pantheon-acceptance');
  const options = { intervalMs: 50, workspaceRoot: workspaceRoot.root };
  let fixture;
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
    const { daemon } = fixture;
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
  const sessionRow = (board, sessionId) => board.sessions.find((row) => row.id === sessionId);
  /** Waits until the session is open with every turn ended; each turn must have completed. */
  const idle = async (sessionId, description) => {
    const found = await waitFor(
      async () => {
        const board = await snapshot();
        const session = sessionRow(board, sessionId);
        const turns = board.session_turns.filter((turn) => turn.session_id === sessionId);
        return session?.state === 'open' &&
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
    return found;
  };
  /** Sends the session a turn once it is open; a tracker turn may take the lead first. */
  const tell = async (step, sessionId, input) => {
    for (;;) {
      const { session } = await idle(sessionId, `the ${step} session to be open`);
      const result = await send(
        step,
        'session.send',
        { session_id: sessionId, input },
        session.revision,
      );
      if (result.status === 200) return result.data.receipt;
      if (!['resource_busy', 'conflict', 'revision_conflict'].includes(result.data.error))
        throw new Error(`${step} session.send: ${JSON.stringify(result.data)}`);
    }
  };
  /** The task session's state, worktree head and gate evidence at this moment. */
  const evidenceOf = async (sessionId) => ({
    session: sessionRow(await snapshot(), sessionId),
    head: (await get('session.diff', { session_id: sessionId })).head_sha,
    preflight: await get('session.preflight', { session_id: sessionId }),
    history: await get('session.gates.history', { session_id: sessionId }),
  });

  try {
    fixture = await startFixtureDaemon(path.join(workspace, 'daemon'), [first, second], options);
    const repo = path.join(workspace, 'repo');
    await mkdir(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Runtime Handoff');
    git(repo, 'config', 'user.email', 'runtime-handoff@example.invalid');
    git(repo, 'config', 'commit.gpgsign', 'false');
    await writeFile(path.join(repo, 'README.md'), 'Runtime handoff\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-q', '-m', 'Initial commit');
    const project = await call('open', 'project.open', { name: 'Runtime handoff', roots: [repo] });
    projectId = project.id;
    await call(
      'open',
      'project.gate.set',
      { project_id: projectId, root: project.roots[0], commands: passingGate },
      project.revision,
    );

    // The lead plans task A; its session answers, commits and records a passing gate run.
    ids.lead = (
      await call('plan', 'session.create', {
        project_id: projectId,
        runtime: FIRST_RUNTIME,
        input: script({ tool: { name: 'update_board', arguments: plan(0) } }),
      })
    ).id;
    await idle(ids.lead, 'the lead to write the plan');
    // Only this first input holds a script step that is safe to run again from the handoff.
    ids.work = (
      await call('work', 'session.create', {
        project_id: projectId,
        runtime: FIRST_RUNTIME,
        task_id: `${ids.lead}:A`,
        input: script({ say: EARLIER_ANSWER }),
      })
    ).id;
    await idle(ids.work, 'the session of task A to answer');
    await tell(
      'work',
      ids.work,
      script(
        { write: { path: 'a.txt', text: 'Export header\n' } },
        { commit: 'Add a.txt with the export header' },
      ),
    );
    const committed = await idle(ids.work, 'the session of task A to commit');
    await call('gate', 'session.gates.run', { session_id: ids.work }, committed.session.revision);
    await waitFor(
      async () => (await get('session.gates.history', { session_id: ids.work })).runs.length > 0,
      'the gate of task A to record a run',
      WAIT_MS,
    );
    await idle(ids.work, 'the gate run of task A to end');
    reads.before = await evidenceOf(ids.work);

    // The lead moves task A to the other runtime.
    await tell(
      'change',
      ids.lead,
      script({ tool: { name: 'update_board', arguments: plan(1, { runtime: SECOND_RUNTIME }) } }),
    );
    reads.runtime_changed = await waitFor(
      async () =>
        (await events()).find(
          (event) => event.kind === 'session.runtime_changed' && event.aggregate_id === ids.work,
        ) ?? false,
      'the session of task A to change runtime',
      WAIT_MS,
    );
    await waitFor(
      () => second.sends.some((sent) => sent.session_id === ids.work),
      'the new runtime to receive its first input',
      WAIT_MS,
    );
    await idle(ids.work, 'the session of task A to end its first turn on the new runtime');
    reads.after = await evidenceOf(ids.work);

    // Another session's native start reports the task session's native id.
    second.forgeNextStart(reads.after.session.native_id);
    ids.probe = (
      await call('forge', 'session.create', {
        project_id: projectId,
        runtime: SECOND_RUNTIME,
        input: script({ say: 'Started' }),
      })
    ).id;
    reads.rejected = await waitFor(
      async () =>
        (await events()).find(
          (event) => event.kind === 'agent.native_id_rejected' && event.aggregate_id === ids.probe,
        ) ?? false,
      'the forged native id to be rejected',
      WAIT_MS,
    );
    await waitFor(
      async () => {
        const board = await snapshot();
        const turns = board.session_turns.filter((turn) => turn.session_id === ids.probe);
        return turns.length > 0 && turns.every(ended);
      },
      'the forging session turn to end',
      WAIT_MS,
    );

    const board = await snapshot();
    const { before, after } = reads;
    const taskSessions = board.sessions.filter(
      (row) => row.task?.lead_session_id === ids.lead && row.task.id === 'A',
    );
    const closedOld = first.closes.find(
      (closed) =>
        closed.session_id === ids.work &&
        closed.native_session_id === before.session.native_id &&
        closed.stopped,
    );
    const startedNew = second.starts.find(
      (started) => started.session_id === ids.work && !started.forged,
    );
    const firstInput = second.sends.find((sent) => sent.session_id === ids.work);
    const [beforeRun] = before.history.runs;
    const forged = reads.rejected.payload.native_session_id;
    observations.handoff = {
      same_task_id:
        before.session.task?.id === 'A' &&
        after.session.task?.id === before.session.task.id &&
        after.session.task.lead_session_id === ids.lead &&
        taskSessions.length === 1,
      same_session_id:
        reads.runtime_changed.payload.from === FIRST_RUNTIME &&
        reads.runtime_changed.payload.to === SECOND_RUNTIME &&
        before.session.runtime === FIRST_RUNTIME &&
        after.session.runtime === SECOND_RUNTIME &&
        taskSessions[0]?.id === ids.work,
      new_native_session:
        Boolean(before.session.native_id && after.session.native_id) &&
        after.session.native_id !== before.session.native_id &&
        Boolean(closedOld && startedNew) &&
        closedOld.sequence < startedNew.sequence &&
        startedNew.native_session_id === after.session.native_id,
      first_message_has_handoff:
        Boolean(firstInput?.input.startsWith(HANDOFF_LINE)) &&
        firstInput.input.includes(EARLIER_ANSWER),
      verified_evidence_preserved:
        passed(beforeRun) &&
        before.preflight.gate.last === 'passed' &&
        after.preflight.gate.last === 'passed' &&
        after.head === before.head &&
        after.history.runs.some(
          (run) => run.run_id === beforeRun.run_id && run.commit === before.head && passed(run),
        ),
      foreign_native_id_rejected:
        forged === after.session.native_id &&
        sessionRow(board, ids.probe)?.native_id !== forged &&
        sessionRow(board, ids.work)?.native_id === after.session.native_id,
    };
  } catch (error) {
    failure = error;
  } finally {
    try {
      evidence = await collectEvidence();
    } catch (error) {
      evidence = { 'collection-error.txt': String(error?.stack ?? error) };
    }
    await fixture?.close();
    workspaceRoot.remove();
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
    adapters: [first, second].map((adapter) => `${adapter.name}@${adapter.report.version}`),
  };

  async function collectEvidence() {
    const ledger = {
      ids,
      starts: { [FIRST_RUNTIME]: first.starts, [SECOND_RUNTIME]: second.starts },
      closes: { [FIRST_RUNTIME]: first.closes, [SECOND_RUNTIME]: second.closes },
    };
    if (!projectId)
      return {
        'handoff.json': { receipts },
        'session-ledger.json': ledger,
        'events.jsonl': receipts.map((r) => JSON.stringify(r)).join('\n') + '\n',
      };
    const all = await events(),
      board = await snapshot();
    const brief = (row) =>
      row && {
        id: row.id,
        runtime: row.runtime,
        native_id: row.native_id ?? null,
        task: row.task ?? null,
        state: row.state,
      };
    return {
      'handoff.json': {
        runtime_changed: reads.runtime_changed ?? null,
        first_input_on_new_runtime:
          second.sends.find((sent) => sent.session_id === ids.work)?.input ?? null,
        handoff_turns: board.session_turns
          .filter((turn) => turn.session_id === ids.work && turn.handoff !== undefined)
          .map((turn) => ({ id: turn.id, origin: turn.origin, handoff: turn.handoff })),
        native_id_rejected: all.filter((event) => event.kind === 'agent.native_id_rejected'),
        gate_before: reads.before
          ? {
              head: reads.before.head,
              preflight: reads.before.preflight,
              history: reads.before.history,
            }
          : null,
        gate_after: reads.after
          ? {
              head: reads.after.head,
              preflight: reads.after.preflight,
              history: reads.after.history,
            }
          : null,
        observations,
      },
      'session-ledger.json': {
        ...ledger,
        before: brief(reads.before?.session),
        after: brief(reads.after?.session),
        sessions: board.sessions.map(brief),
        turns: board.session_turns.map((turn) => ({
          id: turn.id,
          session_id: turn.session_id,
          origin: turn.origin ?? null,
          state: turn.state,
          delivery: turn.delivery,
        })),
        sends: {
          [FIRST_RUNTIME]: first.sends.map(({ input, ...sent }) => sent),
          [SECOND_RUNTIME]: second.sends.map(({ input, ...sent }) => sent),
        },
      },
      'events.jsonl': all.map((event) => JSON.stringify(event)).join('\n') + '\n',
      'receipts.json': receipts,
    };
  }
}
