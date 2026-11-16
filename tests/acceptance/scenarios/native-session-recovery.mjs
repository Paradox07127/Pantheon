import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ClaudeAdapter, CodexAdapter, readProcessIdentity } from '@pantheon/adapters';
import { closeDaemon, MINUTE, watchApprovals } from '../lib/codex-live.mjs';
import { startNativeDaemon } from '../lib/daemon.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import {
  cheapModel,
  createGitProject,
  daemonClient,
  disableUserExtensions,
  eventLog,
  identityAlive,
  installedVersion,
  poll,
  redactedLines,
  replyOf,
  runsWithMarker,
} from '../lib/native-live.mjs';

export const title = '续聊、取消与通道故障';
export const mode = 'live';

const RUNTIMES = ['claude', 'codex'];
const SCENARIO_MS = 13 * MINUTE;
const HEARTBEAT_MS = 4 * MINUTE;
const STOP_MS = 2 * MINUTE;
const RESOLVE_MS = 2 * MINUTE;
const FOLLOW_UP_MS = 4 * MINUTE;
const CHILD_MS = MINUTE;
/** How long the heartbeat file is watched after the interrupted turn ended, in ms. */
const SETTLE_MS = 3000;
const WATCH_MS = 5000;
const MAX_DENIALS_PER_SESSION = 3;
const childScript = fileURLToPath(new URL('../lib/native-daemon-child.mjs', import.meta.url));
const HEARTBEAT = `// Appends "<pid> <tick> <ms>" to heartbeat.log next to this file every second, until
// heartbeat.stop appears there or four minutes pass.
import { appendFileSync, existsSync } from 'node:fs';
const log = new URL('heartbeat.log', import.meta.url);
const stop = new URL('heartbeat.stop', import.meta.url);
const started = Date.now();
let tick = 0;
const beat = () => {
  if (existsSync(stop) || Date.now() - started > 240000) process.exit(0);
  appendFileSync(log, \`\${process.pid} \${++tick} \${Date.now()}\\n\`);
};
beat();
setInterval(beat, 1000);
`;
const heartbeatPrompt = (marker) =>
  `Run this command in the foreground from the current directory and wait for it to finish: node heartbeat.mjs ${marker}\nIt writes a line every second for about four minutes. Do not run it in the background, do not change any file and run no other command.`;
const followUpPrompt = (marker) =>
  `Reply with exactly this text and nothing else, without using any tool: ${marker}`;
const ended = (turn) => !['queued', 'running'].includes(turn.state);

export async function run({ workspace, evidenceDir }) {
  const startedAt = Date.now(),
    deadline = startedAt + SCENARIO_MS;
  const heartbeatMarker = `heartbeat-${randomUUID()}`;
  const childMarker = `native-daemon-${randomUUID()}`;
  const repo = path.join(workspace, 'project');
  const receipts = [],
    probes = [],
    timings = {},
    denials = [],
    sessions = {},
    processes = new Map(),
    observations = { cancel: {}, recovery: {} };
  const daemonChild = { marker_in_argv: false };
  let child, childExit, fixture, endpoint, projectId, versions, adapters, failure;
  let watcher,
    watchFailure,
    stopWatch = false;
  const sessionLists = {};
  const { send, call, get } = daemonClient(() => endpoint, receipts);
  const log = eventLog(get, () => projectId);
  const timed = async (name, step) => {
    const started = Date.now();
    try {
      return await step();
    } finally {
      timings[name] = Date.now() - started;
    }
  };
  const board = () => get('board', { project_id: projectId });
  const sessionRow = (current, runtime) =>
    current.sessions.find((row) => row.id === sessions[runtime].id);
  const turnRow = (current, id) => current.session_turns.find((turn) => turn.id === id);
  /** Remembers the native process of each session, so probes and the close check can find it. */
  const recordNative = (current) => {
    for (const runtime of RUNTIMES) {
      const identity = sessionRow(current, runtime)?.process_identity;
      if (!identity) continue;
      const key = `${identity.pid}:${identity.start_time_us ?? ''}`;
      sessions[runtime].natives.set(key, identity);
      processes.set(key, identity);
    }
  };
  const heartbeatLines = async (runtime) => {
    const file =
      sessions[runtime].worktree && path.join(sessions[runtime].worktree, 'heartbeat.log');
    const text = file ? await readFile(file, 'utf8').catch(() => '') : '';
    return text.split('\n').filter(Boolean);
  };
  const heartbeatSize = async (runtime) =>
    (await stat(path.join(sessions[runtime].worktree, 'heartbeat.log')).catch(() => null))?.size ??
    0;
  /** Reads the process table for the daemon process, every native process and every heartbeat. */
  const probe = (moment) => {
    const entries = [];
    if (daemonChild.pid)
      entries.push({
        kind: 'daemon',
        pid: daemonChild.pid,
        alive:
          identityAlive({ pid: daemonChild.pid, start_time_us: daemonChild.start_time_us }) &&
          runsWithMarker(daemonChild.pid, childMarker),
      });
    for (const runtime of RUNTIMES) {
      if (!sessions[runtime]) continue;
      for (const identity of sessions[runtime].natives.values())
        entries.push({
          kind: 'native',
          runtime,
          pid: identity.pid,
          start_time_us: identity.start_time_us ?? null,
          alive: identityAlive(identity),
        });
      for (const pid of sessions[runtime].heartbeat_pids)
        entries.push({
          kind: 'heartbeat',
          runtime,
          pid,
          alive: runsWithMarker(pid, heartbeatMarker),
        });
    }
    const entry = { moment, at: new Date().toISOString(), processes: entries };
    probes.push(entry);
    return entry;
  };
  const startWatcher = () => {
    stopWatch = false;
    watcher = watchApprovals({
      projectId,
      get,
      send,
      pullEvents: log.pull,
      events: log.all,
      denials,
      deadline,
      stopped: () => stopWatch,
      fail: (error) => (watchFailure = error),
      maxPerSession: MAX_DENIALS_PER_SESSION,
    });
  };
  const stopWatcher = async () => {
    stopWatch = true;
    await watcher;
    if (watchFailure) throw watchFailure;
  };
  /** Sends session.interrupt at the session's current revision; a revision race is sent again. */
  const interrupt = async (runtime, moment) => {
    for (;;) {
      const current = await board();
      const row = sessionRow(current, runtime);
      const turn =
        turnRow(current, sessions[runtime].turn_id) ??
        current.session_turns.find((candidate) => candidate.session_id === row.id);
      const result = await send(
        `interrupt ${moment}`,
        'session.interrupt',
        { session_id: row.id },
        row.revision,
      );
      sessions[runtime].interrupts.push({
        moment,
        session_state: row.state,
        turn_state: turn?.state ?? null,
        status: result.status,
        error: result.data.error ?? null,
        message: result.data.message ?? null,
      });
      if (result.data.error !== 'conflict') return result;
    }
  };

  /** Interrupts the runtime's turn once its heartbeat writes, then watches whether the heartbeat stops. */
  const cancel = async (runtime) => {
    const own = sessions[runtime];
    const running = await poll(
      async () => {
        if (watchFailure) throw watchFailure;
        const current = await board();
        recordNative(current);
        const row = sessionRow(current, runtime);
        const turn = current.session_turns.find((candidate) => candidate.session_id === row.id);
        own.worktree ??= current.workspaces.find(
          (candidate) => candidate.id === row.workspace_id,
        )?.path;
        if (turn && ended(turn))
          throw new Error(`The ${runtime} turn ended ${turn.state} before its heartbeat ran`);
        const lines = await heartbeatLines(runtime);
        return turn?.state === 'running' && lines.length >= 2 ? { turn, lines } : false;
      },
      `the ${runtime} heartbeat to run`,
      HEARTBEAT_MS,
      deadline,
    );
    own.turn_id = running.turn.id;
    for (const line of running.lines) own.heartbeat_pids.add(Number(line.split(' ')[0]));
    probe(`${runtime} heartbeat running`);
    await interrupt(runtime, 'after turn.running');
    const stopped = await poll(
      async () => {
        const current = await board();
        const turn = turnRow(current, own.turn_id);
        return turn && ended(turn) ? current : false;
      },
      `the interrupted ${runtime} turn to end`,
      STOP_MS,
      deadline,
    );
    await delay(SETTLE_MS);
    for (const line of await heartbeatLines(runtime))
      own.heartbeat_pids.add(Number(line.split(' ')[0]));
    const before = await heartbeatSize(runtime);
    await delay(WATCH_MS);
    const after = await heartbeatSize(runtime);
    const alive = probe(`${runtime} after the interrupt`).processes.filter(
      (entry) => entry.kind === 'heartbeat' && entry.runtime === runtime && entry.alive,
    ).length;
    await log.pull();
    const row = sessionRow(stopped, runtime);
    own.cancel = {
      turn_state: turnRow(stopped, own.turn_id).state,
      turn_running_event: log.all.some(
        (event) => event.kind === 'turn.running' && event.aggregate_id === own.turn_id,
      ),
      stop_pending: Boolean(row.stop_pending),
      stop_unconfirmed_event: log.all.some(
        (event) => event.kind === 'session.stop_unconfirmed' && event.aggregate_id === row.id,
      ),
      interrupt_failed: log.all
        .filter(
          (event) => event.kind === 'session.interrupt_failed' && event.aggregate_id === row.id,
        )
        .map((event) => event.payload.error),
      heartbeat_lines_at_interrupt: running.lines.length,
      heartbeat_bytes: { settled: before, [`${WATCH_MS} ms later`]: after },
      heartbeat_writers_alive: alive,
    };
    own.writers_remaining = Math.max(alive, after > before ? 1 : 0);
  };

  try {
    await timed('versions', async () => {
      versions = {
        claude: await installedVersion('claude'),
        codex: await installedVersion('codex'),
      };
    });
    await createGitProject(repo, {
      'README.md': 'Native session recovery\n',
      'heartbeat.mjs': HEARTBEAT,
    });

    // The first daemon runs in its own process, so it can stop without a shutdown.
    child = spawn(
      process.execPath,
      [
        childScript,
        JSON.stringify({ workspace, versions, intervalMs: 200 }),
        `--marker=${childMarker}`,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let childErr = '';
    child.stderr
      .setEncoding('utf8')
      .on('data', (chunk) => (childErr = (childErr + chunk).slice(-8000)));
    childExit = once(child, 'exit');
    daemonChild.pid = child.pid;
    daemonChild.start_time_us = readProcessIdentity(child.pid)?.start_time_us;
    daemonChild.marker_in_argv = runsWithMarker(child.pid, childMarker);
    daemonChild.stderr_tail = () => childErr;
    const [line] = await Promise.race([
      once(createInterface({ input: child.stdout }), 'line'),
      childExit.then(([code, signal]) => {
        throw new Error(`The daemon process exited before it started: ${code ?? signal}`);
      }),
      delay(CHILD_MS).then(() => {
        throw new Error('The daemon process did not start within a minute');
      }),
    ]);
    endpoint = JSON.parse(line);
    probe('daemon process started');

    const project = await call('open', 'project.open', {
      name: 'Native session recovery',
      roots: [repo],
    });
    projectId = project.id;
    await disableUserExtensions({ get, call, project, runtimes: RUNTIMES });
    const models = {};
    for (const runtime of RUNTIMES) models[runtime] = await cheapModel(get, projectId, runtime);
    startWatcher();

    // Each runtime opens a session whose turn runs a heartbeat; one interrupt before the turn runs.
    for (const runtime of RUNTIMES) {
      const { model, effort } = models[runtime];
      const session = await call('session', 'session.create', {
        project_id: projectId,
        runtime,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        permission_mode: 'auto_edit',
        input: heartbeatPrompt(heartbeatMarker),
      });
      sessions[runtime] = {
        id: session.id,
        model: models[runtime],
        natives: new Map(),
        heartbeat_pids: new Set(),
        interrupts: [],
        resolve: [],
      };
      await interrupt(runtime, 'before turn.running');
    }
    await timed('cancel', () => Promise.all(RUNTIMES.map(cancel)));
    observations.cancel.child_writers_remaining = RUNTIMES.reduce(
      (sum, runtime) => sum + sessions[runtime].writers_remaining,
      0,
    );
    observations.cancel.confirmed_or_explicitly_unconfirmed = RUNTIMES.every((runtime) => {
      const { cancel: own } = sessions[runtime];
      return own.turn_state === 'cancelled' || own.stop_pending || own.stop_unconfirmed_event;
    });

    // Record the native sessions, then stop the daemon process with SIGKILL.
    const idle = await poll(
      async () => {
        const current = await board();
        recordNative(current);
        return RUNTIMES.every((runtime) => sessionRow(current, runtime).state === 'open')
          ? current
          : false;
      },
      'both sessions to be idle',
      STOP_MS,
      deadline,
    );
    sessionLists.before_stop = await get('session.list', { project_id: projectId });
    for (const runtime of RUNTIMES) {
      const row = sessionRow(idle, runtime);
      sessions[runtime].native_before = row.native_id ?? null;
      sessions[runtime].listed_before = sessionLists.before_stop.find((item) => item.id === row.id);
    }
    await stopWatcher();
    probe('before the daemon process stops');
    child.stdin.write('crash\n');
    const [code, signal] = await Promise.race([
      childExit,
      delay(CHILD_MS).then(() => {
        throw new Error('The daemon process did not stop within a minute');
      }),
    ]);
    daemonChild.exit = { code, signal };
    endpoint = undefined;
    probe('after the daemon process stopped');
    if (signal !== 'SIGKILL') throw new Error(`The daemon process ended with ${code ?? signal}`);

    // The same data directory, in this process; each session resumes its native session.
    adapters = [
      new ClaudeAdapter('claude', versions.claude),
      new CodexAdapter('codex', versions.codex),
    ];
    fixture = await startNativeDaemon(workspace, adapters, { intervalMs: 200 });
    endpoint = fixture.daemon;
    const restarted = await board();
    await log.pull();
    probe('daemon restarted');
    startWatcher();
    for (const runtime of RUNTIMES) {
      const own = sessions[runtime];
      const row = sessionRow(restarted, runtime);
      const after = (kind) =>
        log.all.some((event) => event.kind === kind && event.aggregate_id === row.id);
      own.after_restart = {
        state: row.state,
        reconciling_event: after('session.reconciling'),
        recovered_event: after('session.recovered'),
      };
      const resolve = async () => {
        const current = sessionRow(await board(), runtime);
        const result = await send(
          'resolve',
          'session.resolve',
          { session_id: row.id, choice: 'resume_session' },
          current.revision,
        );
        own.resolve.push({
          state: current.state,
          status: result.status,
          error: result.data.error ?? null,
          message: result.data.message ?? null,
        });
        return result.status === 200;
      };
      // A session still reconciling waits until its old process is gone and the resolve is accepted.
      if (row.state === 'reconciling')
        await poll(resolve, `session.resolve of the ${runtime} session`, RESOLVE_MS, deadline);
      else await resolve();
    }
    await poll(
      async () => {
        const current = await board();
        recordNative(current);
        return RUNTIMES.every((runtime) => sessionRow(current, runtime).state === 'open')
          ? current
          : false;
      },
      'both sessions to take input after the restart',
      RESOLVE_MS,
      deadline,
    );

    // One unique follow-up per session.
    for (const runtime of RUNTIMES) {
      const own = sessions[runtime];
      own.follow_up_marker = `${runtime}-follow-up-${randomUUID()}`;
      own.follow_up_turn_id = (
        await call(
          'follow-up',
          'session.send',
          { session_id: own.id, input: followUpPrompt(own.follow_up_marker) },
          sessionRow(await board(), runtime).revision,
        )
      ).id;
    }
    const answered = await timed('follow-up', () =>
      poll(
        async () => {
          if (watchFailure) throw watchFailure;
          const current = await board();
          recordNative(current);
          return RUNTIMES.every((runtime) => {
            const turn = turnRow(current, sessions[runtime].follow_up_turn_id);
            return turn && ended(turn);
          })
            ? current
            : false;
        },
        'both follow-up turns to end',
        FOLLOW_UP_MS,
        deadline,
      ),
    );
    await stopWatcher();
    sessionLists.after_follow_up = await get('session.list', { project_id: projectId });
    const events = await log.pull();
    for (const runtime of RUNTIMES) {
      const own = sessions[runtime];
      const row = sessionRow(answered, runtime);
      const input = followUpPrompt(own.follow_up_marker);
      own.native_after = row.native_id ?? null;
      own.session_started = events
        .filter((event) => event.kind === 'agent.session.started' && event.aggregate_id === own.id)
        .map((event) => ({
          sequence: event.sequence,
          native_session_id: event.payload.native_session_id,
        }));
      own.follow_up = {
        turn_state: turnRow(answered, own.follow_up_turn_id).state,
        reply_has_marker: replyOf(events, own.follow_up_turn_id).includes(own.follow_up_marker),
        rows_with_input: answered.session_turns.filter(
          (turn) => turn.session_id === own.id && turn.input === input,
        ).length,
        running_events: events.filter(
          (event) => event.kind === 'turn.running' && event.aggregate_id === own.follow_up_turn_id,
        ).length,
      };
      own.native_identity_consistent =
        Boolean(own.native_before) &&
        own.native_after === own.native_before &&
        own.session_started.every((row) => row.native_session_id === own.native_before) &&
        own.follow_up.reply_has_marker;
    }
    observations.recovery.native_identity_consistent = RUNTIMES.every(
      (runtime) => sessions[runtime].native_identity_consistent,
    );
    observations.recovery.duplicate_turn_submission = RUNTIMES.reduce((sum, runtime) => {
      const { follow_up } = sessions[runtime];
      return (
        sum + Math.max(0, follow_up.rows_with_input - 1) + Math.max(0, follow_up.running_events - 1)
      );
    }, 0);
  } catch (error) {
    failure = error;
  } finally {
    stopWatch = true;
    await watcher;
    // A heartbeat ends at its stop file; a failed run may have left one writing.
    for (const runtime of RUNTIMES)
      if (sessions[runtime]?.worktree)
        await writeFile(path.join(sessions[runtime].worktree, 'heartbeat.stop'), '').catch(
          () => {},
        );
    if (fixture) {
      try {
        await log.pull();
        recordNative(await board());
      } catch (error) {
        timings.collection_error = String(error?.message ?? error);
      }
      observations.shutdown = {
        processes_stopped: await closeDaemon({ fixture, processes, timed, timings }),
      };
    }
    // The end of stdin closes a daemon process that is still running.
    if (child && child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      const [code, signal] = await Promise.race([childExit, delay(CHILD_MS).then(() => [])]);
      daemonChild.closed = { code: code ?? null, signal: signal ?? null };
    }
    await delay(1500);
    if (probes.length) probe('after cleanup');
    timings.total = Date.now() - startedAt;
  }
  const evidence = {
    'process-probes.json': probes,
    'recovery-receipt.json': {
      daemon_process: {
        pid: daemonChild.pid ?? null,
        marker_in_argv: daemonChild.marker_in_argv,
        exit: daemonChild.exit ?? null,
        closed: daemonChild.closed ?? null,
        stderr_tail: daemonChild.stderr_tail?.() ?? '',
      },
      sessions: Object.fromEntries(
        Object.entries(sessions).map(([runtime, { natives, heartbeat_pids, ...own }]) => [
          runtime,
          { ...own, natives: [...natives.values()], heartbeat_pids: [...heartbeat_pids] },
        ]),
      ),
      session_list: sessionLists,
      denials,
      commands: receipts,
      observations,
      timings,
    },
    'redacted-native-events.jsonl': redactedLines(log.all),
  };
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
