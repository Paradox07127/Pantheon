import { execFile, execFileSync } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { nativeEnvironment } from '@pantheon/adapters';
import { Control } from '@pantheon/control';
import { ArtifactFiles, Store } from '@pantheon/store';
import { runValidationCommand } from '../../../packages/control/dist/validation-executor.js';

export const MINUTE = 60000;
export const REQUEST_MS = 30000;
export const POLL_MS = 1000;
const CLOSE_MS = 10 * MINUTE;
const INSTALL_MS = 10 * MINUTE;
const BUILD_MS = 15 * MINUTE;
const TEST_MS = 20 * MINUTE;
const GATE_TIMEOUT_MS = 15 * MINUTE;
const DENY_REASON = 'stay inside the sandbox';
const PANTHEON_SERVER = 'pantheon';

export const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const gitEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
export const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    env: gitEnv,
    encoding: 'utf8',
    timeout: REQUEST_MS,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const ANSI = /\x1b\[[0-9;]*m/g;
const tail = (text, size = 8000) => (text.length > size ? text.slice(-size) : text);

/** Runs a command to completion; a nonzero exit or timeout is a result, not an error. */
async function runCommand(file, args, { cwd, env = process.env, timeout }) {
  const started = Date.now();
  try {
    const { stdout, stderr } = await promisify(execFile)(file, args, {
      cwd,
      env,
      timeout,
      maxBuffer: 256 * 1024 * 1024,
      encoding: 'utf8',
    });
    return {
      argv: [file, ...args],
      exit_code: 0,
      duration_ms: Date.now() - started,
      stdout,
      stderr,
    };
  } catch (error) {
    return {
      argv: [file, ...args],
      exit_code: typeof error.code === 'number' ? error.code : null,
      timed_out: error.killed === true,
      error: typeof error.code === 'number' ? undefined : String(error.message),
      duration_ms: Date.now() - started,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}
const brief = ({ stdout, stderr, ...result }) => ({
  ...result,
  stdout_tail: tail(stdout.replace(ANSI, '')),
  stderr_tail: tail(stderr.replace(ANSI, '')),
});

/** The vitest summary counts in a test run's output; null when it printed none. */
export function testCounts(text) {
  const line = text
    .replace(ANSI, '')
    .split('\n')
    .find((row) => /^\s*Tests\s+\d/.test(row));
  if (!line) return null;
  const count = (word) => Number(line.match(new RegExp(`(\\d+) ${word}`))?.[1] ?? 0);
  return {
    passed: count('passed'),
    skipped: count('skipped'),
    failed: count('failed'),
    todo: count('todo'),
  };
}

/** Whether a recorded native process still runs: same pid and the same start time. */
function stillRunning(identity) {
  let started;
  try {
    started = execFileSync('ps', ['-o', 'lstart=', '-p', String(identity.pid)], {
      env: { ...process.env, LC_ALL: 'C' },
      encoding: 'utf8',
      timeout: REQUEST_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    // ps exits 1 with no output when the pid is gone; anything else leaves it unknown.
    if (error.status === 1 && !String(error.stdout ?? '').trim()) return false;
    return true;
  }
  if (!started) return false;
  if (identity.start_time_us === undefined) return true;
  return Math.abs(Date.parse(started) - identity.start_time_us / 1000) < 2000;
}

/** Installs the clone, runs the baseline gate in the gate sandbox and checks the Codex login; throws on the first failure. */
export async function checkClone({
  workspace,
  clone,
  budget,
  timed,
  flush,
  preflight,
  gates,
  observations,
}) {
  await timed('preflight.install', async () => {
    const offline = await runCommand('pnpm', ['install', '--frozen-lockfile', '--offline'], {
      cwd: clone,
      timeout: budget(INSTALL_MS),
    });
    preflight.install = [brief(offline)];
    if (offline.exit_code === 0) return;
    const online = await runCommand('pnpm', ['install', '--frozen-lockfile'], {
      cwd: clone,
      timeout: budget(INSTALL_MS),
    });
    preflight.install.push(brief(online));
    if (online.exit_code !== 0) throw new Error('Preflight: pnpm install failed in the clone');
  });
  await flush();
  // The baseline runs in the gate sandbox, so sandbox-only failures show before any paid session.
  const baselineState = path.join(workspace, 'baseline-state');
  const baselineStore = new Store(path.join(baselineState, 'control.sqlite'));
  const baselineControl = new Control(
    baselineStore,
    new ArtifactFiles(path.join(baselineState, 'artifacts')),
    [],
  );
  const sandboxed = async (argv, timeoutMs) => {
    const result = await runValidationCommand({
      ctx: baselineControl.ctx,
      key: `baseline:${argv.join(' ')}`,
      argv,
      cwd: clone,
      root: clone,
      // The same variables a gate gets (packages/control/src/landing.ts runGateCommand).
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        LANG: 'en_US.UTF-8',
        pnpm_config_verify_deps_before_run: 'false',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
      timeoutMs,
    });
    return {
      argv,
      exit_code: result.exit_code,
      timed_out: result.timedOut,
      error: result.error,
      duration_ms: Math.round(result.duration_ms),
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  };
  let build, test;
  try {
    build = await timed('preflight.build', () => sandboxed(['pnpm', 'build'], budget(BUILD_MS)));
    test =
      build.exit_code === 0
        ? await timed('preflight.test', () => sandboxed(['pnpm', 'test'], budget(TEST_MS)))
        : null;
  } finally {
    await baselineControl.shutdown();
    baselineStore.close();
  }
  gates.baseline = {
    build: brief(build),
    test: test && brief(test),
    counts: test && testCounts(test.stdout + test.stderr),
  };
  observations.preflight = {
    baseline_gate_passed: build.exit_code === 0 && test?.exit_code === 0,
  };
  await flush();
  if (!observations.preflight.baseline_gate_passed)
    throw new Error('Preflight: pnpm build or pnpm test failed on the unchanged clone');
  const version = await runCommand('codex', ['--version'], {
    env: nativeEnvironment(),
    timeout: REQUEST_MS,
  });
  const login = await runCommand('codex', ['login', 'status'], {
    env: nativeEnvironment(),
    timeout: REQUEST_MS,
  });
  const loginText = `${login.stdout}\n${login.stderr}`.trim().split('\n')[0] ?? '';
  preflight.codex = {
    version: version.stdout.trim(),
    version_exit_code: version.exit_code,
    login_exit_code: login.exit_code,
    login: loginText,
  };
  await flush();
  if (version.exit_code !== 0 || !version.stdout.trim())
    throw new Error('Preflight: codex --version failed');
  if (login.exit_code !== 0 || !/Logged in using ChatGPT/i.test(loginText))
    throw new Error(`Preflight: Codex is not logged in with a subscription: ${loginText}`);
}

/** Turns off the user's MCP servers, plugins, apps and hooks for Codex and sets the build and test gate; returns the project receipt. */
export async function configureCodexProject({ call, get, project, preflight }) {
  const inventory = await get('extensions.inventory', {
    project_id: project.id,
    runtime: 'codex',
  });
  preflight.inventory = inventory;
  const overrides = {
    disabled_mcp_servers: inventory.mcp_servers
      .filter((server) => !server.plugin)
      .map((server) => server.name),
    disabled_plugins: inventory.plugins.map((plugin) => plugin.id),
    disabled_skills: [],
    disable_apps: true,
    disable_hooks: true,
  };
  const overridden = await call(
    'preflight',
    'project.extensions.set',
    { project_id: project.id, runtime: 'codex', overrides },
    project.revision,
  );
  return call(
    'preflight',
    'project.gate.set',
    {
      project_id: project.id,
      root: project.roots[0],
      commands: [
        { name: 'build', argv: ['pnpm', 'build'], timeout_ms: GATE_TIMEOUT_MS },
        { name: 'test', argv: ['pnpm', 'test'], timeout_ms: GATE_TIMEOUT_MS },
      ],
    },
    overridden.revision,
  );
}

/** Fails when a session loaded a user MCP server or left an override unapplied. */
export function checkExtensions(events, observations) {
  const applied = events.filter((event) => event.kind === 'agent.extensions.applied');
  const loaded = [
    ...new Set(
      applied.flatMap((event) =>
        event.payload.loaded.mcp_servers.filter((name) => name !== PANTHEON_SERVER),
      ),
    ),
  ].sort();
  observations.extensions = { user_servers_loaded: loaded };
  const unapplied = applied.filter((event) => event.payload.not_applied?.length);
  if (loaded.length) throw new Error(`User MCP servers loaded: ${loaded.join(', ')}`);
  if (unapplied.length)
    throw new Error(`Extension overrides not applied: ${JSON.stringify(unapplied[0].payload)}`);
  return applied;
}

/** Rejects every pending permission request of the project until stopped; hands its first error to fail. */
export async function watchApprovals({
  projectId,
  get,
  send,
  pullEvents,
  events,
  denials,
  deadline,
  stopped,
  fail,
  maxPerSession,
}) {
  while (!stopped() && Date.now() < deadline) {
    try {
      const { items } = await get('needs_you.list', { project_id: projectId });
      for (const item of items) {
        if (item.source.table !== 'approvals' || !item.actions[0]?.allowed) continue;
        const result = await send(
          'approvals',
          'approval.respond',
          { approval_id: item.source.id, decision: 'reject', reason: DENY_REASON },
          item.source.revision,
        );
        if (result.status !== 200 || result.data.receipt?.error) continue;
        await pullEvents();
        const requested = events.find(
          (event) => event.kind === 'approval.requested' && event.aggregate_id === item.source.id,
        );
        const sessionId = requested?.payload.session_id ?? null;
        denials.push({
          approval_id: item.source.id,
          session_id: sessionId,
          tool: item.binding?.action,
        });
        if (denials.filter((row) => row.session_id === sessionId).length > maxPerSession)
          throw new Error(
            `Session ${sessionId} asked for permission more than ${maxPerSession} times`,
          );
      }
    } catch (error) {
      fail(error);
      return;
    }
    await delay(POLL_MS);
  }
}

/** Closes the daemon and reports whether it closed and every recorded native process stopped. */
export async function closeDaemon({ fixture, processes, timed, timings, capMs = CLOSE_MS }) {
  let closed = false;
  await timed('shutdown', () =>
    Promise.race([
      fixture.close().then(
        () => (closed = true),
        (error) => (timings.close_error = String(error?.message ?? error)),
      ),
      // Unreferenced, so a prompt close does not keep the process alive.
      delay(capMs, undefined, { ref: false }),
    ]),
  );
  const running = [...processes.values()].filter(stillRunning);
  timings.shutdown_detail = {
    closed,
    recorded_processes: processes.size,
    still_running: running,
  };
  return closed && !running.length;
}
