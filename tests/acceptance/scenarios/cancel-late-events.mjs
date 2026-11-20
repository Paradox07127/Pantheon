import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FixtureAdapter } from '@pantheon/adapters';
import { command, USER_PRINCIPAL_ID } from '@pantheon/protocol';
import { FakeAgentAdapter } from '../fixtures/fake-agent-adapter.mjs';
import { startFixtureDaemon } from '../lib/daemon.mjs';
import { waitFor } from '../lib/event-client.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { createWorkspaceRoot } from '../lib/workspace-root.mjs';

export const title = '取消与迟到事件';
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
/** How long the daemon gets to act on input while the stop is unconfirmed, in daemon ticks. */
const HOLD_TICKS = 20;
const INTERVAL_MS = 50;
/** How long a turn's writer keeps writing at most, in ms, if nothing stops it. */
const WRITER_LIFETIME_MS = 30000;
/** Usage the old turn reports after its stop; cost in USD. */
const LATE_USAGE = { input_tokens: 1200, output_tokens: 300, cost_usd: 0.42 };
const plan = {
  base_version: 0,
  headline: 'Cancel and late events',
  lanes: [{ id: 'main', title: 'Main' }],
  tasks: [
    {
      id: 'K',
      title: 'Task K',
      goal: 'Add k.txt',
      lane: 'main',
      depends_on: [],
      source: ['Add k.txt'],
      scope: ['k.txt'],
      acceptance: ['test -f k.txt'],
    },
  ],
  milestones: [],
  risks: [],
  assumptions: [],
};

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

export async function run({ workspace, evidenceDir }) {
  const sentinels = path.join(workspace, 'sentinels');
  // The first turn writes until it is stopped; the stop is confirmed only once the gate opens.
  const agent = new FakeAgentAdapter({
    dir: path.join(workspace, 'agents', 'interruptible'),
    name: 'interruptible-agent',
    capabilities: { interrupt: true },
    script: {
      interrupt: { gate: 'confirm-stop' },
      turns: [
        {
          steps: [
            {
              write_child: {
                file: path.join(sentinels, 'old-turn.log'),
                lifetime_ms: WRITER_LIFETIME_MS,
              },
            },
            { gate: 'never-opened' },
          ],
        },
        {
          steps: [
            { write_child: { file: path.join(sentinels, 'new-turn.log'), lifetime_ms: 200 } },
            { gate: 'release-next' },
          ],
        },
        { steps: [] },
      ],
    },
  });
  const lead = new FixtureAdapter();
  const managed = createWorkspaceRoot('cancel-late-events');
  const options = { intervalMs: INTERVAL_MS, workspaceRoot: managed.root };
  const fixture = await startFixtureDaemon(path.join(workspace, 'daemon'), [lead, agent], options);
  const { daemon } = fixture;
  const receipts = [],
    probes = [],
    views = {},
    ids = {},
    observations = {};
  let projectId, failure, evidence, ledger;

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
  const sessionRow = (board, id) => board.sessions.find((row) => row.id === id);
  const turnRow = (board, id) => board.session_turns.find((turn) => turn.id === id);
  const turnsOf = (board, id) => board.session_turns.filter((turn) => turn.session_id === id);
  const readLedger = () => agent.ledger(`fake-${ids.task}`).catch(() => []);
  const writersOf = (lines, turnId) =>
    lines.filter((line) => line.type === 'child' && line.turn_id === turnId);
  /** The pids of the session's writers and whether each is in the process table now. */
  const probe = async (moment) => {
    const lines = await readLedger();
    const entry = {
      moment,
      at: new Date().toISOString(),
      processes: lines
        .filter((line) => ['start', 'resume', 'child'].includes(line.type))
        .map((line) => ({
          kind: line.type === 'child' ? 'writer' : 'agent',
          pid: line.pid,
          file: line.file,
          alive: alive(line.pid),
        })),
    };
    probes.push(entry);
    return entry;
  };
  const sleepTicks = (ticks) => new Promise((resolve) => setTimeout(resolve, ticks * INTERVAL_MS));

  try {
    const repo = path.join(workspace, 'repo');
    await mkdir(repo, { recursive: true });
    await mkdir(sentinels, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Cancel Late Events');
    git(repo, 'config', 'user.email', 'cancel-late-events@example.invalid');
    git(repo, 'config', 'commit.gpgsign', 'false');
    await writeFile(path.join(repo, 'README.md'), 'Cancel and late events\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-q', '-m', 'Initial commit');
    projectId = (
      await call('open', 'project.open', { name: 'Cancel and late events', roots: [repo] })
    ).id;
    ids.lead = (
      await call('plan', 'session.create', {
        project_id: projectId,
        runtime: lead.name,
        purpose: 'lead',
        input: script({ tool: { name: 'update_board', arguments: plan } }),
      })
    ).id;
    await waitFor(
      async () => {
        const board = await snapshot();
        const turns = turnsOf(board, ids.lead);
        return sessionRow(board, ids.lead)?.state === 'open' && turns.length && turns.every(ended);
      },
      'the lead to write the plan',
      WAIT_MS,
    );

    // A session of task K whose first turn runs a writer.
    ids.task = (
      await call('task', 'session.create', {
        project_id: projectId,
        runtime: agent.name,
        task_id: `${ids.lead}:K`,
        input: 'Start task K',
      })
    ).id;
    const running = await waitFor(
      async () => {
        const board = await snapshot();
        const [first] = turnsOf(board, ids.task);
        const lines = await readLedger();
        return first?.state === 'running' &&
          first.delivery === 'delivered' &&
          writersOf(lines, first.id).length
          ? { board, first }
          : false;
      },
      'the first turn of task K to run its writer',
      WAIT_MS,
    );
    ids.old_turn = running.first.id;
    const handle = [...daemon.control.handles.values()].find(
      (candidate) => candidate.platform_session_id === ids.task,
    );
    if (!handle) throw new Error('No live handle for the session of task K');

    // The interrupt reaches the agent, which holds back the stop confirmation.
    await call(
      'interrupt',
      'session.interrupt',
      { session_id: ids.task },
      sessionRow(running.board, ids.task).revision,
    );
    await waitFor(
      async () => (await readLedger()).some((line) => line.type === 'interrupt'),
      'the interrupt to reach the agent',
      WAIT_MS,
    );
    let board = await snapshot();
    const sendBefore = await submit(
      'send before stop',
      'session.send',
      { session_id: ids.task, input: 'Next step for task K' },
      sessionRow(board, ids.task).revision,
    );
    board = await snapshot();
    const merge = await submit(
      'merge before stop',
      'session.merge',
      { session_id: ids.task },
      sessionRow(board, ids.task).revision,
    );
    await sleepTicks(HOLD_TICKS);
    views.before_stop = await snapshot();
    await probe('stop requested, not confirmed');

    // The agent stops its writer, then confirms the stop; the user sends the next step.
    agent.open('confirm-stop');
    const stopped = await waitFor(
      async () => {
        const current = await snapshot();
        return sessionRow(current, ids.task)?.state === 'open' &&
          turnsOf(current, ids.task).every(ended)
          ? current
          : false;
      },
      'the session to take input after the stop',
      WAIT_MS,
    );
    ids.new_turn = (
      await call(
        'send after stop',
        'session.send',
        { session_id: ids.task, input: 'Next step for task K' },
        sessionRow(stopped, ids.task).revision,
      )
    ).id;
    const next = await waitFor(
      async () => {
        const current = await snapshot();
        const turn = turnRow(current, ids.new_turn);
        return turn?.state === 'running' && turn.delivery === 'delivered' ? current : false;
      },
      'the new turn to run after the stop',
      WAIT_MS,
    );
    await probe('new turn running');

    // The agent reports a completion and usage for the old turn after its stop.
    const cursor = (await events()).at(-1)?.sequence ?? 0;
    agent.emitStale(handle, [
      { turn_id: ids.old_turn, kind: 'turn.completed', status: 'completed' },
      {
        turn_id: ids.old_turn,
        kind: 'usage.updated',
        ...LATE_USAGE,
        cost_source: 'provider_reported',
      },
    ]);
    await sleepTicks(HOLD_TICKS);
    views.after_late_events = await snapshot();

    agent.open('release-next');
    views.final = await waitFor(
      async () => {
        const current = await snapshot();
        const turns = turnsOf(current, ids.task);
        return sessionRow(current, ids.task)?.state === 'open' &&
          turns.every(ended) &&
          turnRow(current, ids.new_turn)?.state === 'completed'
          ? current
          : false;
      },
      'the new turn to complete',
      WAIT_MS,
    );
    await probe('settled');

    const all = await events();
    ledger = await readLedger();
    const stopConfirmed = all.find(
      (event) =>
        event.kind === 'agent.turn.completed' &&
        event.payload.turn_id === ids.old_turn &&
        event.payload.status === 'interrupted',
    );
    if (!stopConfirmed) throw new Error('The stop of the old turn was never recorded');
    const stopLine = ledger.findIndex(
      (line) => line.type === 'stop_confirmed' && line.turn_id === ids.old_turn,
    );
    /** Turns other than the stopped one that ran before its stop was confirmed. */
    const startedBeforeStop = [
      ...all
        .filter(
          (event) =>
            event.kind === 'turn.running' &&
            turnsOf(views.final, ids.task).some((turn) => turn.id === event.aggregate_id) &&
            event.aggregate_id !== ids.old_turn &&
            event.sequence < stopConfirmed.sequence,
        )
        .map((event) => event.aggregate_id),
      ...ledger
        .slice(0, stopLine === -1 ? ledger.length : stopLine)
        .filter((line) => line.type === 'input' && line.turn_id !== ids.old_turn)
        .map((line) => line.turn_id),
    ];
    /** Writers of earlier turns that had not exited when a later turn's input reached the agent. */
    const overlapping = (() => {
      const running = new Map();
      let count = 0;
      for (const line of ledger) {
        if (line.type === 'input')
          count += [...running.values()].filter((turnId) => turnId !== line.turn_id).length;
        if (line.type === 'child') running.set(line.pid, line.turn_id);
        if (line.type === 'writer_exit') running.delete(line.pid);
      }
      return count;
    })();
    const oldFinal = turnRow(views.final, ids.old_turn);
    const newAfterLate = turnRow(views.after_late_events, ids.new_turn);
    const sessionFinal = sessionRow(views.final, ids.task);
    observations.cancel = {
      new_turn_before_stop_confirmed:
        startedBeforeStop.length > 0 ||
        turnsOf(views.before_stop, ids.task).some(
          (turn) => turn.id !== ids.old_turn && turn.state === 'running',
        ),
      merge_before_stop_confirmed:
        merge.status === 200 ||
        all.some(
          (event) =>
            ['session.merge_started', 'session.merged'].includes(event.kind) &&
            event.aggregate_id === ids.task &&
            event.sequence < stopConfirmed.sequence,
        ),
      turn_state: oldFinal?.state ?? null,
    };
    observations.ownership = {
      concurrent_writers:
        overlapping +
        probes
          .filter((entry) => entry.moment === 'new turn running')
          .flatMap((entry) => entry.processes)
          .filter(
            (process) =>
              process.kind === 'writer' &&
              process.alive &&
              writersOf(ledger, ids.old_turn).some((line) => line.pid === process.pid),
          ).length,
    };
    observations.events = {
      stale_result_promoted:
        oldFinal?.state !== 'cancelled' ||
        newAfterLate?.state !== 'running' ||
        all.some(
          (event) =>
            event.sequence > cursor &&
            event.kind === 'agent.turn.completed' &&
            event.payload.turn_id === ids.old_turn,
        ),
    };
    observations.usage = {
      late_cost_preserved:
        oldFinal?.usage?.cost_usd === LATE_USAGE.cost_usd &&
        oldFinal.usage.input_tokens === LATE_USAGE.input_tokens &&
        oldFinal.usage.output_tokens === LATE_USAGE.output_tokens &&
        (sessionFinal?.usage?.cost_usd ?? 0) >= LATE_USAGE.cost_usd,
    };
    views.before_stop_receipts = {
      send: { status: sendBefore.status, error: sendBefore.data.error ?? null },
      merge: { status: merge.status, error: merge.data.error ?? null },
    };
    views.next_running = turnRow(next, ids.new_turn);
  } catch (error) {
    failure = error;
  } finally {
    try {
      evidence = await collectEvidence();
    } catch (error) {
      evidence = { 'collection-error.txt': String(error?.stack ?? error) };
    }
    await fixture.close();
    await agent.stopWriters().catch(() => {});
    // The evidence holds this list, so the read after the close still reaches it.
    if (ids.task) await probe('after the daemon closed').catch(() => {});
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
    adapters: [lead, agent].map((adapter) => `${adapter.name}@${adapter.report.version}`),
  };

  async function collectEvidence() {
    if (!projectId) return { 'session-turns.json': { commands: receipts } };
    const board = await snapshot(),
      all = await events();
    const turnView = (view) =>
      view &&
      turnsOf(view, ids.task).map(({ id, origin, state, delivery, delivery_reason, usage }) => ({
        id,
        origin,
        state,
        delivery,
        delivery_reason,
        usage,
      }));
    return {
      'session-turns.json': {
        ids,
        commands: receipts,
        before_stop: turnView(views.before_stop),
        after_late_events: turnView(views.after_late_events),
        final: turnView(board),
        session_usage: sessionRow(board, ids.task)?.usage ?? null,
        before_stop_receipts: views.before_stop_receipts ?? null,
        agent_ledger: ledger ?? (await readLedger()),
        observations,
      },
      'events.jsonl':
        all
          .filter((event) =>
            [ids.task, ...turnsOf(board, ids.task).map((t) => t.id)].includes(event.aggregate_id),
          )
          .map((event) => JSON.stringify(event))
          .join('\n') + '\n',
      'process-probes.json': probes,
    };
  }
}
