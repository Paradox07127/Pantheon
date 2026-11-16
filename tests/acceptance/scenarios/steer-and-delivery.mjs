import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FixtureAdapter } from '@pantheon/adapters';
import { command, USER_PRINCIPAL_ID } from '@pantheon/protocol';
import { FakeAgentAdapter } from '../fixtures/fake-agent-adapter.mjs';
import { startFixtureDaemon } from '../lib/daemon.mjs';
import { waitFor } from '../lib/event-client.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

export const title = '插话与交付语义';
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
/** How long the lead's messaging turn keeps running, in ms, so the user's steer finds it running. */
const LEAD_HOLD_MS = 4000;
/** Ticks the event cursor must stay still for before the daemon counts as settled. */
const QUIET_TICKS = 20;
const plan = {
  base_version: 0,
  headline: 'Delivery semantics',
  lanes: [{ id: 'main', title: 'Main' }],
  tasks: [
    {
      id: 'W',
      title: 'Task W',
      goal: 'Add w.txt',
      lane: 'main',
      depends_on: [],
      source: ['Add w.txt'],
      scope: ['w.txt'],
      acceptance: ['test -f w.txt'],
    },
  ],
  milestones: [],
  risks: [],
  assumptions: [],
};

/** A turn input the fixture runtime runs as these steps. */
const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;
const ended = (turn) => !['queued', 'running'].includes(turn.state);

/** The fixture runtime without steer; it keeps every input it was handed as its own record. */
class RecordingFixture extends FixtureAdapter {
  inputs = [];
  async send(handle, turn) {
    const receipt = await super.send(handle, turn);
    this.inputs.push({
      session_id: handle.platform_session_id,
      turn_id: turn.turn_id,
      input: turn.input,
      status: receipt.status,
    });
    return receipt;
  }
}

export async function run({ workspace, evidenceDir }) {
  const lead = new RecordingFixture();
  // The worker's runtime takes a steer; its first turn runs until the gate opens.
  const steering = new FakeAgentAdapter({
    dir: path.join(workspace, 'agents', 'steering'),
    name: 'steering-agent',
    capabilities: { steer: true },
    script: { turns: [{ steps: [{ gate: 'release-worker' }] }, { steps: [] }] },
  });
  // No steer: input waits for the running turn, and the runtime refuses the next one it is handed.
  const queueing = new FakeAgentAdapter({
    dir: path.join(workspace, 'agents', 'queueing'),
    name: 'queueing-agent',
    script: { turns: [{ steps: [{ gate: 'release-queue' }] }, { deliver: 'unsupported' }] },
  });
  const adapters = [lead, steering, queueing];
  // The daemon refuses worktrees in temporary directories, where the case workspace may be.
  await mkdir(managedParent, { recursive: true });
  const workspaceRoot = await mkdtemp(path.join(managedParent, 'pantheon-acceptance-'));
  const options = { intervalMs: 50, workspaceRoot };
  const fixture = await startFixtureDaemon(path.join(workspace, 'daemon'), adapters, options);
  const { daemon } = fixture;
  const receipts = [],
    views = {},
    observations = {};
  const markers = {
    worker_steer: `worker-steer-${randomUUID()}`,
    lead_message: `lead-message-${randomUUID()}`,
    lead_steer: `lead-steer-${randomUUID()}`,
    queued_steer: `queued-steer-${randomUUID()}`,
  };
  let projectId, failure, evidence, native;
  const ids = {};

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
  const sessionRow = (board, sessionId) => board.sessions.find((row) => row.id === sessionId);
  const turnRow = (board, turnId) => board.session_turns.find((turn) => turn.id === turnId);
  /** Waits until the session is open with at least `count` turns, every one ended. */
  const settled = (sessionId, count, description) =>
    waitFor(
      async () => {
        const board = await snapshot();
        const session = sessionRow(board, sessionId);
        const turns = turnsOf(board, sessionId);
        return session?.state === 'open' && turns.length >= count && turns.every(ended)
          ? { board, session, turns }
          : false;
      },
      description,
      WAIT_MS,
    );
  /** Waits until the session's first turn runs with its input delivered. */
  const running = (sessionId, description) =>
    waitFor(
      async () => {
        const board = await snapshot();
        const session = sessionRow(board, sessionId);
        const [first] = turnsOf(board, sessionId);
        return session?.state === 'running' &&
          first?.state === 'running' &&
          first.delivery === 'delivered'
          ? session
          : false;
      },
      description,
      WAIT_MS,
    );
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
  /** Each input the runtimes recorded, with whether the runtime accepted it. */
  const nativeInputs = async (board) => {
    const records = lead.inputs.map((entry) => ({
      runtime: lead.name,
      ...entry,
      accepted: entry.status === 'delivered',
    }));
    for (const [adapter, sessionId] of [
      [steering, ids.worker],
      [queueing, ids.queued],
    ]) {
      const nativeId = sessionRow(board, sessionId)?.native_id;
      if (!nativeId) continue;
      for (const entry of await adapter.ledger(nativeId))
        if (['input', 'steer', 'input_rejected'].includes(entry.type))
          records.push({
            runtime: adapter.name,
            session_id: sessionId,
            turn_id: entry.turn_id,
            input: entry.input,
            kind: entry.type,
            accepted: entry.type !== 'input_rejected',
          });
    }
    return records;
  };

  try {
    const repo = path.join(workspace, 'repo');
    await mkdir(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Delivery Semantics');
    git(repo, 'config', 'user.email', 'delivery-semantics@example.invalid');
    git(repo, 'config', 'commit.gpgsign', 'false');
    await writeFile(path.join(repo, 'README.md'), 'Delivery semantics\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-q', '-m', 'Initial commit');
    const project = await call('open', 'project.open', {
      name: 'Delivery semantics',
      roots: [repo],
    });
    projectId = project.id;

    // The lead writes a plan with task W.
    ids.lead = (
      await call('plan', 'session.create', {
        project_id: projectId,
        runtime: lead.name,
        input: script({ tool: { name: 'update_board', arguments: plan } }),
      })
    ).id;
    await settled(ids.lead, 1, 'the lead to write the plan');

    // A session of task W on the steering runtime, held in its first turn.
    ids.worker = (
      await call('worker', 'session.create', {
        project_id: projectId,
        runtime: steering.name,
        task_id: `${ids.lead}:W`,
        input: 'Start task W',
      })
    ).id;
    const worker = await running(ids.worker, 'the first turn of task W to run');
    ids.worker_steer = (
      await call(
        'steer_worker',
        'session.steer',
        { session_id: ids.worker, input: markers.worker_steer },
        worker.revision,
      )
    ).id;

    // A direct session on the queueing runtime, held in its first turn.
    ids.queued = (
      await call('queued', 'session.create', {
        project_id: projectId,
        runtime: queueing.name,
        input: 'Hold the first turn',
      })
    ).id;
    const queued = await running(ids.queued, 'the first turn of the queueing session to run');
    ids.queued_steer = (
      await call(
        'steer_queued',
        'session.steer',
        { session_id: ids.queued, input: markers.queued_steer },
        queued.revision,
      )
    ).id;

    // The lead messages task W, then runs on while the user steers it.
    const idleLead = await settled(ids.lead, 1, 'the lead to be open');
    ids.lead_instruction = (
      await call(
        'message',
        'session.send',
        {
          session_id: ids.lead,
          input: script(
            {
              tool: {
                name: 'message_task',
                arguments: { project_id: projectId, task_id: 'W', text: markers.lead_message },
              },
            },
            { wait: LEAD_HOLD_MS },
          ),
        },
        idleLead.session.revision,
      )
    ).id;
    const messaged = await waitFor(
      async () => {
        const board = await snapshot();
        const message = turnsOf(board, ids.worker).find(
          (turn) => turn.origin === 'lead' && turn.input.includes(markers.lead_message),
        );
        const session = sessionRow(board, ids.lead);
        return message && session?.state === 'running' ? { message, session } : false;
      },
      'the lead message to reach task W',
      WAIT_MS,
    );
    ids.lead_message = messaged.message.id;
    ids.lead_steer = (
      await call(
        'steer_lead',
        'session.steer',
        { session_id: ids.lead, input: markers.lead_steer },
        messaged.session.revision,
      )
    ).id;

    // What the board shows while both runtimes without steer hold their input.
    views.held = await waitFor(
      async () => {
        const board = await snapshot();
        return [ids.lead_steer, ids.queued_steer].every(
          (turnId) => turnRow(board, turnId)?.delivery === 'queued',
        )
          ? board
          : false;
      },
      'the steers without runtime support to show as queued',
      WAIT_MS,
    );

    steering.open('release-worker');
    queueing.open('release-queue');
    await waitFor(
      async () => {
        const board = await snapshot();
        const done = (turnId) => {
          const turn = turnRow(board, turnId);
          return turn && ended(turn) && turn.delivery !== 'pending' && turn.delivery !== 'queued';
        };
        return [ids.worker_steer, ids.lead_message, ids.lead_steer, ids.queued_steer].every(done);
      },
      'every marked input to be delivered or to fail',
      WAIT_MS,
    );
    await quiet('the daemon to settle');
    for (const sessionId of [ids.lead, ids.worker, ids.queued])
      await settled(sessionId, 1, `session ${sessionId} to end its turns`);
    views.final = await snapshot();
    // Read after the board: a delivery the board shows was recorded by the runtime before it.
    native = await nativeInputs(views.final);

    const all = await events();
    const deliveryEvent = (turnId, delivery) =>
      all.some(
        (event) =>
          event.kind === 'session.turn.delivery' &&
          event.aggregate_id === turnId &&
          event.payload.delivery === delivery,
      );
    const observed = [ids.lead, ids.worker, ids.queued];
    const acceptedBy = (sessionId, turnId) =>
      native.some(
        (entry) => entry.accepted && entry.session_id === sessionId && entry.turn_id === turnId,
      );
    const failedTurn = turnRow(views.final, ids.queued_steer);
    const targets = {
      worker_steer: ids.worker,
      lead_message: ids.worker,
      lead_steer: ids.lead,
    };
    observations.delivery = {
      false_delivered: views.final.session_turns.filter(
        (turn) =>
          observed.includes(turn.session_id) &&
          turn.delivery === 'delivered' &&
          !acceptedBy(turn.session_id, turn.id),
      ).length,
      queued_visible: [ids.lead_steer, ids.queued_steer].every(
        (turnId) =>
          turnRow(views.held, turnId)?.delivery === 'queued' && deliveryEvent(turnId, 'queued'),
      ),
      failed_visible:
        failedTurn?.delivery === 'failed' &&
        Boolean(failedTurn.delivery_reason) &&
        deliveryEvent(ids.queued_steer, 'failed') &&
        native.some((entry) => !entry.accepted && entry.turn_id === ids.queued_steer),
      correct_target:
        Object.entries(targets).every(([name, target]) => {
          // The lead's own turn that told it to send the message is not a delivery of it.
          const holders = native.filter(
            (entry) =>
              entry.accepted &&
              entry.turn_id !== ids.lead_instruction &&
              entry.input.includes(markers[name]),
          );
          return holders.length === 1 && holders[0].session_id === target;
        }) && !native.some((entry) => entry.accepted && entry.input.includes(markers.queued_steer)),
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
    adapters: adapters.map((adapter) => `${adapter.name}@${adapter.report.version}`),
  };

  async function collectEvidence() {
    if (!projectId) return { 'delivery-receipts.json': { commands: receipts } };
    const board = await snapshot(),
      all = await events();
    const marked = new Set(Object.values(ids));
    return {
      'delivery-receipts.json': {
        markers,
        ids,
        commands: receipts,
        turns: board.session_turns.map(
          ({ id, session_id, kind, origin, delivery, delivery_reason, state, input }) => ({
            id,
            session_id,
            kind,
            origin,
            delivery,
            delivery_reason,
            state,
            input: input.slice(0, 200),
          }),
        ),
        delivery_events: all
          .filter(
            (event) => event.kind === 'session.turn.delivery' && marked.has(event.aggregate_id),
          )
          .map((event) => ({
            sequence: event.sequence,
            turn_id: event.aggregate_id,
            ...event.payload,
          })),
      },
      'native-inputs.json': native ?? (await nativeInputs(board).catch((error) => String(error))),
      'board-views.json': views,
      'events.json': all,
      'observations.json': observations,
    };
  }
}
