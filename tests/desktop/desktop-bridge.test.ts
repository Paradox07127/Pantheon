import { afterEach, it, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startDaemon } from '@pantheon/daemon';
import { FixtureAdapter } from '@pantheon/adapters';
import { command, type DesktopBridge, type EventFrame } from '@pantheon/protocol';
import type { Project } from '@pantheon/domain';
import type { MenuItemConstructorOptions } from 'electron';
import {
  DaemonBridge,
  ownsDaemon,
  userDataDirectory,
  wslOwns,
} from '../../apps/desktop/src/main/daemon.js';
import { PANTHEON_VERSION } from '@pantheon/domain/version';
import { titleBarOverlay } from '../../apps/desktop/src/main/window.js';
import { awaitWorkspaceReady, eventually, registerWorkspace, user } from '../helpers.js';

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const spawn = vi.fn(actual.spawn);
  return {
    ...actual,
    spawn,
    // Sandboxes cannot run setuid ps; answer command lines for processes this test knows.
    execFile: vi.fn((file: string, args: string[], ...rest: unknown[]) => {
      if (file !== 'ps')
        return (actual.execFile as (...all: unknown[]) => unknown)(file, args, ...rest);
      const callback = rest.at(-1) as ExecFileCallback;
      const pid = Number(args.at(-1));
      const argv =
        pid === process.pid
          ? process.argv
          : spawn.mock.results.find((result) => result.value?.pid === pid)?.value.spawnargs;
      queueMicrotask(() =>
        argv
          ? callback(null, `${argv.join(' ')}\n`, '')
          : callback(new Error('No such process'), '', ''),
      );
    }),
  };
});
type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-desktop-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
async function liveDaemon(options: { workspaceRoot?: string } = {}) {
  const root = tempRoot();
  mkdirSync(path.join(root, 'project'));
  const directory = path.join(root, 'state');
  const daemon = await startDaemon({ directory, adapters: [new FixtureAdapter()], ...options });
  cleanups.push(() => daemon.close());
  const bridge = new DaemonBridge({
    directory,
    packaged: true,
    repo: root,
    logFile: path.join(root, 'daemon.log'),
  });
  return { root, directory, daemon, bridge };
}
const openProject = (root: string) =>
  command(user.id, 'project.open', {
    name: 'desktop',
    roots: [path.join(root, 'project')],
  });

it('finds a live daemon from daemon.json and relays commands and queries', async () => {
  const { root, directory, daemon, bridge } = await liveDaemon();
  expect(await bridge.daemon()).toEqual({
    ok: true,
    value: {
      url: daemon.url,
      version: PANTHEON_VERSION,
      protocol_version: 1,
      started_here: false,
      data_dir: directory,
    },
  });
  const opened = await bridge.command(openProject(root));
  expect(opened.ok).toBe(true);
  const project = (opened as { value: Project }).value;
  expect(project.name).toBe('desktop');
  const board = await bridge.query('board', { project_id: project.id });
  expect(board.ok && (board.value as { projects: Project[] }).projects.map((p) => p.id)).toEqual([
    project.id,
  ]);
  expect(await bridge.query('needs_you.list', { project_id: project.id })).toMatchObject({
    ok: true,
  });
});

it('maps a daemon error to a failed result with its code and HTTP status', async () => {
  const { bridge } = await liveDaemon();
  const result = await bridge.command(
    command(user.id, 'session.rename', { session_id: 'missing', title: 'Renamed' }),
  );
  expect(result).toEqual({
    ok: false,
    error: {
      code: 'not_found',
      message: 'sessions/missing',
      status: 400,
    },
  });
});

it('maps unknown routes and missing session queries to the daemon error code', async () => {
  const { bridge } = await liveDaemon();
  expect(await bridge.query('nothing')).toEqual({
    ok: false,
    error: { code: 'unknown_route', message: 'GET /v1/nothing', status: 404 },
  });
  expect(await bridge.query('session.reviews', { session_id: 'w' })).toEqual({
    ok: false,
    error: {
      code: 'not_found',
      message: 'sessions/w',
      status: 400,
    },
  });
});

it('reports a command that outlasts the bridge timeout as still running and keeps the connection', async () => {
  const root = tempRoot();
  const directory = path.join(root, 'state');
  mkdirSync(directory);
  writeFileSync(path.join(directory, 'user.token'), 'token');
  let probes = 0;
  const timers: NodeJS.Timeout[] = [];
  const server = createServer((request, response) => {
    if (request.url === '/v1/capabilities') probes++;
    const reply = () => {
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify(
          request.url === '/health'
            ? { service: 'pantheon', protocol_version: 1, version: '0.1.0' }
            : request.url === '/v1/commands'
              ? { receipt: null }
              : [],
        ),
      );
    };
    if (request.url === '/v1/commands') timers.push(setTimeout(reply, 6000));
    else reply();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const timer of timers) clearTimeout(timer);
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  writeFileSync(
    path.join(directory, 'daemon.json'),
    JSON.stringify({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token_file: path.join(directory, 'user.token'),
      pid: process.pid,
    }),
  );
  const bridge = new DaemonBridge({
    directory,
    packaged: true,
    repo: root,
    logFile: path.join(root, 'daemon.log'),
  });
  const result = await bridge.command(openProject(root));
  expect(!result.ok && result.error.code).toBe('command_timeout');
  expect(await bridge.query('capabilities')).toMatchObject({ ok: true });
  expect(probes).toBe(1);
}, 15000);

/** A daemon.json pointing at a server that answers the given routes after the given delays. */
async function slowDaemon(delay: (url: string, count: number) => number) {
  const root = tempRoot();
  const directory = path.join(root, 'state');
  mkdirSync(directory);
  writeFileSync(path.join(directory, 'user.token'), 'token');
  const counts = new Map<string, number>();
  const timers: NodeJS.Timeout[] = [];
  const server = createServer((request, response) => {
    const url = request.url!.split('?')[0]!;
    const count = (counts.get(url) ?? 0) + 1;
    counts.set(url, count);
    const reply = () => {
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify(
          url === '/health' ? { service: 'pantheon', protocol_version: 1, version: '0.1.0' } : [],
        ),
      );
    };
    const wait = delay(url, count);
    if (wait > 0) timers.push(setTimeout(reply, wait));
    else reply();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const timer of timers) clearTimeout(timer);
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  writeFileSync(
    path.join(directory, 'daemon.json'),
    JSON.stringify({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token_file: path.join(directory, 'user.token'),
      pid: process.pid,
    }),
  );
  const bridge = new DaemonBridge({
    directory,
    packaged: false,
    repo: root,
    logFile: path.join(root, 'daemon.log'),
  });
  return { bridge, counts };
}

it('reports a query that outlasts the bridge timeout as slow and keeps the connection', async () => {
  const { bridge, counts } = await slowDaemon((url) => (url === '/v1/slow.read' ? 6000 : 0));
  const result = await bridge.query('slow.read');
  expect(!result.ok && result.error).toMatchObject({
    code: 'query_timeout',
    message: 'GET /v1/slow.read? did not answer within 5000 ms',
  });
  expect(await bridge.query('capabilities')).toMatchObject({ ok: true });
  expect(counts.get('/v1/capabilities')).toBe(2);
}, 15000);

it('waits for a device probe that outlasts an ordinary query', async () => {
  const { bridge } = await slowDaemon((url) => (url === '/v1/device.probe' ? 6000 : 0));
  expect(await bridge.query('device.probe', { id: 'd' })).toEqual({ ok: true, value: [] });
}, 15000);

it('waits for a live but slow daemon instead of starting another one', async () => {
  const { bridge } = await slowDaemon((url, count) =>
    url === '/v1/capabilities' && count === 1 ? 6000 : 0,
  );
  const start = vi
    .spyOn(bridge as unknown as { start: () => Promise<unknown> }, 'start')
    .mockResolvedValue({ ok: false, error: { code: 'daemon_unavailable', message: 'spawned' } });
  const found = await bridge.daemon();
  expect(start).not.toHaveBeenCalled();
  expect(found).toMatchObject({ ok: true, value: { started_here: false } });
}, 15000);

it('carries the details and stack of a daemon error and repeats a query parameter given as a list', async () => {
  const root = tempRoot();
  const directory = path.join(root, 'state');
  mkdirSync(directory);
  writeFileSync(path.join(directory, 'user.token'), 'token');
  const queries: string[] = [];
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/commands') {
      response.statusCode = 400;
      response.end(
        JSON.stringify({
          error: 'memory_budget_exceeded',
          message: 'Decisions do not fit',
          details: { used_bytes: 12500, limit_bytes: 12000 },
          stack:
            'DomainError: Decisions do not fit\n    at budget (packages/control/src/memory.ts:12:9)',
        }),
      );
      return;
    }
    if (request.url?.startsWith('/v1/memory.read')) queries.push(request.url);
    response.end(
      JSON.stringify(
        request.url === '/health'
          ? { service: 'pantheon', protocol_version: 1, version: '0.1.0' }
          : [],
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  writeFileSync(
    path.join(directory, 'daemon.json'),
    JSON.stringify({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token_file: path.join(directory, 'user.token'),
      pid: process.pid,
    }),
  );
  const bridge = new DaemonBridge({
    directory,
    packaged: true,
    repo: root,
    logFile: path.join(root, 'daemon.log'),
  });
  expect(await bridge.command(openProject(root))).toEqual({
    ok: false,
    error: {
      code: 'memory_budget_exceeded',
      message: 'Decisions do not fit',
      status: 400,
      details: { used_bytes: 12500, limit_bytes: 12000 },
      stack:
        'DomainError: Decisions do not fit\n    at budget (packages/control/src/memory.ts:12:9)',
    },
  });
  await bridge.query('memory.read', { project_id: 'p', tag: ['storage', 'local'] });
  expect(queries).toEqual(['/v1/memory.read?project_id=p&tag=storage&tag=local']);
});

it('refuses a daemon of another protocol version and connects once the versions match', async () => {
  const root = tempRoot();
  const directory = path.join(root, 'state');
  mkdirSync(directory);
  writeFileSync(path.join(directory, 'user.token'), 'token');
  let protocol_version = 2;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify(
        request.url === '/health'
          ? { service: 'pantheon', protocol_version, version: '0.1.0' }
          : request.url === '/v1/commands'
            ? { receipt: null }
            : [],
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  writeFileSync(
    path.join(directory, 'daemon.json'),
    JSON.stringify({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token_file: path.join(directory, 'user.token'),
      pid: process.pid,
    }),
  );
  const bridge = new DaemonBridge({
    directory,
    packaged: true,
    repo: root,
    logFile: path.join(root, 'daemon.log'),
  });
  const mismatch = {
    ok: false,
    error: { code: 'protocol_mismatch', message: 'daemon protocol 2, app 1' },
  };
  expect(await bridge.command(openProject(root))).toEqual(mismatch);
  expect(await bridge.query('capabilities')).toEqual(mismatch);
  protocol_version = 1;
  expect(await bridge.command(openProject(root))).toEqual({ ok: true, value: null });
  expect(await bridge.query('capabilities')).toEqual({ ok: true, value: [] });
});

it('reports no live daemon without daemon.json or with a token the daemon does not accept', async () => {
  const root = tempRoot();
  const missing = new DaemonBridge({
    directory: path.join(root, 'none'),
    packaged: true,
    repo: root,
    logFile: path.join(root, 'daemon.log'),
  });
  const absent = await missing.daemon();
  expect(absent.ok).toBe(false);
  expect(!absent.ok && absent.error.code).toBe('daemon_unavailable');
  expect(!absent.ok && absent.error.message).toContain('daemon.json');

  const { directory, bridge } = await liveDaemon();
  writeFileSync(path.join(directory, 'user.token'), 'not-the-token');
  const refused = await bridge.daemon();
  expect(refused.ok).toBe(false);
  expect(!refused.ok && refused.error.message).toContain('403');
});

it('refuses an invalid query method without calling the daemon', async () => {
  const root = tempRoot();
  const bridge = new DaemonBridge({
    directory: path.join(root, 'none'),
    packaged: true,
    repo: root,
    logFile: path.join(root, 'daemon.log'),
  });
  for (const method of ['../commands', 'Board', 'board?x=1', ''])
    expect(await bridge.query(method)).toMatchObject({
      ok: false,
      error: { code: 'invalid_query' },
    });
});

it('relays event frames from a cursor and ends with one closed frame', async () => {
  const { root, daemon, bridge } = await liveDaemon();
  await daemon.control.execute(user, openProject(root));
  mkdirSync(path.join(root, 'second'));
  const second = command(user.id, 'project.open', {
    name: 'second',
    roots: [path.join(root, 'second')],
  });
  await daemon.control.execute(user, second);
  const frames: EventFrame[] = [];
  const end = bridge.subscribe({ cursor: 1 }, (frame) => frames.push(frame));
  await eventually(() => frames.some((f) => f.type === 'event'));
  expect(frames[0]).toEqual({ type: 'subscribed', cursor: 1 });
  expect(frames.flatMap((f) => (f.type === 'event' ? [f.event.sequence] : []))).toEqual([2]);
  end();
  await eventually(() => frames.some((f) => f.type === 'closed'));
  await sleep(300);
  expect(frames.filter((f) => f.type === 'closed')).toEqual([
    { type: 'closed', code: 1000, reason: '' },
  ]);
});

it('opens only a registered workspace whose directory exists', async () => {
  const cache = path.join(process.cwd(), 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  // Worktrees need a managed workspace root outside temporary directories.
  const workspaceRoot = mkdtempSync(path.join(cache, 'pantheon-desktop-'));
  cleanups.push(() => rmSync(workspaceRoot, { recursive: true, force: true }));
  const { root, daemon, bridge } = await liveDaemon({ workspaceRoot });
  const project = ((await bridge.command(openProject(root))) as { value: Project }).value;
  const workspace = await awaitWorkspaceReady(
    daemon.control,
    registerWorkspace(daemon.control, {
      project_id: project.id,
      kind: 'linked_worktree',
      source: project.roots[0]!,
      base_ref: 'HEAD',
    }),
  );
  const launched: string[] = [];
  const launch = async (directory: string) => {
    launched.push(directory);
    return { ok: true as const, value: null };
  };
  expect(await bridge.openWorkspace('unregistered', launch)).toMatchObject({
    ok: false,
    error: { code: 'not_found' },
  });
  expect(launched).toEqual([]);
  expect(await bridge.openWorkspace(workspace.id, launch)).toEqual({ ok: true, value: null });
  expect(launched).toEqual([workspace.path]);
  rmSync(workspace.path, { recursive: true, force: true });
  expect(await bridge.openWorkspace(workspace.id, launch)).toMatchObject({
    ok: false,
    error: { code: 'workspace_missing' },
  });
  expect(launched).toHaveLength(1);
});

async function startDevelopmentDaemon() {
  const root = tempRoot();
  const directory = path.join(root, 'state');
  const bridge = new DaemonBridge({
    directory,
    packaged: false,
    repo: path.resolve(import.meta.dirname, '../..'),
    logFile: path.join(root, 'logs/daemon.log'),
  });
  const started = () =>
    vi.mocked(spawn).mock.results.find((result) => result.value?.pid === bridge.startedPid)?.value;
  cleanups.push(async () => {
    if (bridge.startedPid === undefined) return;
    const child = started();
    expect(child).toBeDefined();
    child.kill('SIGTERM');
    await eventually(() => !existsSync(path.join(directory, 'daemon.json')), undefined, 10000);
  });
  const info = await bridge.daemon();
  return { directory, bridge, info, started };
}

it('starts a daemon in development when none is live', async () => {
  vi.stubEnv('PANTHEON_ALLOW_FIXTURE', undefined);
  cleanups.push(() => {
    vi.unstubAllEnvs();
  });
  const { directory, bridge, info, started } = await startDevelopmentDaemon();
  expect(info).toMatchObject({
    ok: true,
    value: { started_here: true, version: PANTHEON_VERSION },
  });
  expect(bridge.startedPid).toBeTypeOf('number');
  expect(started().spawnargs).not.toContain('--allow-fixture');
  expect(existsSync(path.join(directory, 'daemon.json'))).toBe(true);
  expect(await bridge.query('capabilities')).toMatchObject({ ok: true });
});

it('starts the development daemon with the fixture runtime only when PANTHEON_ALLOW_FIXTURE is 1', async () => {
  vi.stubEnv('PANTHEON_ALLOW_FIXTURE', '1');
  cleanups.push(() => {
    vi.unstubAllEnvs();
  });
  const { info, started } = await startDevelopmentDaemon();
  expect(info).toMatchObject({ ok: true, value: { started_here: true } });
  expect(started().spawnargs).toContain('--allow-fixture');
});

it('says it is starting the daemon from the spawn until the daemon is live, and not when one is live', async () => {
  const root = tempRoot();
  const directory = path.join(root, 'state');
  const bridge = new DaemonBridge({
    directory,
    packaged: false,
    repo: path.resolve(import.meta.dirname, '../..'),
    logFile: path.join(root, 'logs/daemon.log'),
  });
  cleanups.push(async () => {
    const child = vi
      .mocked(spawn)
      .mock.results.find((result) => result.value?.pid === bridge.startedPid)?.value;
    child?.kill('SIGTERM');
    await eventually(() => !existsSync(path.join(directory, 'daemon.json')), undefined, 10000);
  });
  /** Each value set on starting, with whether the daemon had a manifest at that moment. */
  const watch = (target: DaemonBridge, dir: string) => {
    const sets: [boolean, boolean][] = [];
    let value = target.starting;
    Object.defineProperty(target, 'starting', {
      get: () => value,
      set: (next: boolean) => {
        sets.push([next, existsSync(path.join(dir, 'daemon.json'))]);
        value = next;
      },
    });
    return sets;
  };
  expect(bridge.starting).toBe(false);
  const starts = watch(bridge, directory);
  expect(await bridge.daemon()).toMatchObject({ ok: true, value: { started_here: true } });
  expect(starts).toEqual([
    [true, false],
    [false, true],
  ]);
  expect(bridge.starting).toBe(false);

  const live = await liveDaemon();
  const other = new DaemonBridge({
    directory: live.directory,
    packaged: false,
    repo: path.resolve(import.meta.dirname, '../..'),
    logFile: path.join(live.root, 'daemon.log'),
  });
  const connects = watch(other, live.directory);
  expect(await other.daemon()).toMatchObject({ ok: true, value: { started_here: false } });
  expect(connects).toEqual([[false, true]]);
});

it('treats only this repo daemon for this data directory as its own', () => {
  const daemon = (repo: string, directory: string) =>
    `node ${repo}/apps/daemon/dist/main.js --data-dir ${directory}`;
  const repo = '/work/pantheon';
  const directory = '/data/Application Support/Pantheon';
  expect(ownsDaemon(daemon(repo, directory), repo, directory)).toBe(true);
  expect(ownsDaemon(`${daemon(repo, directory)} --allow-fixture`, repo, directory)).toBe(true);
  expect(ownsDaemon(`${daemon(repo, directory)} --allow-fixture x`, repo, directory)).toBe(false);
  expect(ownsDaemon(daemon('/work/other', directory), repo, directory)).toBe(false);
  expect(ownsDaemon(daemon(repo, '/data/elsewhere'), repo, directory)).toBe(false);
  expect(ownsDaemon(daemon(repo, `${directory} 2`), repo, directory)).toBe(false);
  expect(ownsDaemon(`node ${repo}/tests/fake.js --data-dir ${directory}`, repo, directory)).toBe(
    false,
  );
});

it('does not reload a daemon whose command line is not its own', async () => {
  const { root, directory } = await liveDaemon();
  const bridge = new DaemonBridge({
    directory,
    packaged: false,
    repo: path.resolve(import.meta.dirname, '../..'),
    logFile: path.join(root, 'daemon.log'),
  });
  const query = vi.spyOn(bridge, 'query');
  await bridge.reloadDaemon();
  expect(query).not.toHaveBeenCalled();
  expect(existsSync(path.join(root, 'daemon.log'))).toBe(false);
  expect(await bridge.query('capabilities')).toMatchObject({ ok: true });
});

it('defers a daemon reload while a session is running and restarts once idle', async () => {
  const root = tempRoot();
  const directory = path.join(root, 'state');
  const logFile = path.join(root, 'logs/daemon.log');
  const bridge = new DaemonBridge({
    directory,
    packaged: false,
    repo: path.resolve(import.meta.dirname, '../..'),
    logFile,
  });
  const children = () =>
    vi
      .mocked(spawn)
      .mock.results.map((result) => result.value)
      .filter((child) => child?.spawnargs.includes(directory));
  cleanups.push(async () => {
    for (const child of children()) if (child.exitCode === null) child.kill('SIGTERM');
    await eventually(() => !existsSync(path.join(directory, 'daemon.json')), undefined, 10000);
  });
  expect(await bridge.daemon()).toMatchObject({ ok: true });
  const first = bridge.startedPid!;
  vi.spyOn(bridge, 'query').mockResolvedValueOnce({
    ok: true,
    value: { sessions: [{ state: 'running' }] },
  });
  await bridge.reloadDaemon();
  const log = readFileSync(logFile, 'utf8');
  expect(log.match(/daemon reload deferred: 1 sessions active/g)).toHaveLength(1);
  expect(log).toContain(`daemon reloaded: pid ${first} stopped`);
  expect(children().map((child) => child.pid)).toEqual([first, bridge.startedPid]);
  expect(() => process.kill(first, 0)).toThrow();
  expect(JSON.parse(readFileSync(path.join(directory, 'daemon.json'), 'utf8')).pid).toBe(
    bridge.startedPid,
  );
  expect(await bridge.query('capabilities')).toMatchObject({ ok: true });
}, 30000);

it('reloads a daemon on start of watching only when the build is newer than the daemon', async () => {
  const root = tempRoot();
  const directory = path.join(root, 'state');
  const logFile = path.join(root, 'logs/daemon.log');
  const bridge = new DaemonBridge({
    directory,
    packaged: false,
    repo: path.resolve(import.meta.dirname, '../..'),
    logFile,
  });
  cleanups.push(async () => {
    if (bridge.startedPid && existsSync(path.join(directory, 'daemon.json')))
      process.kill(bridge.startedPid, 'SIGTERM');
    await eventually(() => !existsSync(path.join(directory, 'daemon.json')), undefined, 10000);
  });
  expect(await bridge.daemon()).toMatchObject({ ok: true });
  const first = bridge.startedPid!;
  let stop = bridge.watchBuilds();
  await sleep(1500);
  stop();
  expect(readFileSync(logFile, 'utf8')).not.toContain('daemon reload');

  const manifest = path.join(directory, 'daemon.json');
  const info = JSON.parse(readFileSync(manifest, 'utf8'));
  writeFileSync(manifest, JSON.stringify({ ...info, started_at: '2000-01-01T00:00:00.000Z' }));
  stop = bridge.watchBuilds();
  cleanups.push(stop);
  await eventually(
    () => readFileSync(logFile, 'utf8').includes(`daemon reloaded: pid ${first} stopped`),
    undefined,
    15000,
  );
  expect(bridge.startedPid).not.toBe(first);
}, 30000);

it('replaces a daemon another app version started, then keeps the one it started', async () => {
  const root = tempRoot();
  const directory = path.join(root, 'state');
  const logFile = path.join(root, 'logs/daemon.log');
  const options = {
    directory,
    packaged: true,
    repo: root,
    logFile,
    launch: {
      node: process.execPath,
      entry: path.resolve(import.meta.dirname, '../../apps/daemon/dist/main.js'),
      env: {},
    },
  };
  cleanups.push(async () => {
    for (const child of vi.mocked(spawn).mock.results.map((result) => result.value))
      if (child?.spawnargs.includes(directory) && child.exitCode === null) child.kill('SIGTERM');
    await eventually(() => !existsSync(path.join(directory, 'daemon.json')), undefined, 10000);
  });
  const older = new DaemonBridge(options);
  expect(await older.daemon()).toMatchObject({ ok: true });
  const first = older.startedPid!;
  const upgraded = new DaemonBridge({ ...options, version: '0.0.0-upgraded' });
  expect(await upgraded.daemon()).toMatchObject({ ok: true, value: { started_here: false } });
  await eventually(
    () => readFileSync(logFile, 'utf8').includes(`daemon reloaded: pid ${first} stopped`),
    undefined,
    15000,
  );
  expect(() => process.kill(first, 0)).toThrow();
  expect(await upgraded.daemon()).toMatchObject({ ok: true, value: { started_here: true } });
  await sleep(500);
  expect(readFileSync(logFile, 'utf8').match(/is not app 0\.0\.0-upgraded/g)).toHaveLength(1);
}, 30000);

it('owns a WSL daemon started from any runtime version beside its own', () => {
  const runtime = { root: '/home/u/.local/share/pantheon/runtime/0.2.0+2', data: '/home/u/data' };
  const line = (version: string, data = runtime.data) =>
    `/home/u/.local/share/pantheon/runtime/${version}/node/bin/node /home/u/.local/share/pantheon/runtime/${version}/daemon/dist/main.js --data-dir ${data}`;
  expect(wslOwns(line('0.2.0+2'), runtime)).toBe(true);
  expect(wslOwns(line('0.1.0+1'), runtime)).toBe(true);
  expect(wslOwns(`${line('0.1.0+1')} --allow-fixture`, runtime)).toBe(true);
  expect(wslOwns(line('0.1.0+1', '/home/u/other'), runtime)).toBe(false);
  expect(
    wslOwns(
      '/home/u/.local/share/pantheon/runtime/0.1.0+1/node/bin/node /home/u/.local/share/pantheon/runtime/0.2.0+2/daemon/dist/main.js --data-dir /home/u/data',
      runtime,
    ),
  ).toBe(false);
  expect(wslOwns(line('..'), runtime)).toBe(false);
});

const ELECTRON = '../../apps/desktop/node_modules/electron/index.js';
type Handler = (...args: any[]) => unknown;
/** Records listeners by name and calls them on emit. */
class Emitter {
  listeners = new Map<string, Handler[]>();
  on(name: string, fn: Handler) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
    return this;
  }
  once(name: string, fn: Handler) {
    const wrapped = (...args: unknown[]) => {
      this.listeners.set(
        name,
        (this.listeners.get(name) ?? []).filter((l) => l !== wrapped),
      );
      fn(...args);
    };
    return this.on(name, wrapped);
  }
  emit(name: string, ...args: unknown[]) {
    for (const fn of this.listeners.get(name) ?? []) fn(...args);
  }
}

function fakeMainElectron(root: string, lock = true) {
  const handlers = new Map<string, Handler>();
  const windows: FakeWindow[] = [];
  const notifications: FakeNotification[] = [];
  class FakeContents extends Emitter {
    mainFrame = {};
    loading = true;
    sent: unknown[][] = [];
    send(...args: unknown[]) {
      this.sent.push(args);
    }
    isLoading() {
      return this.loading;
    }
    isDestroyed() {
      return false;
    }
    getOSProcessId() {
      return 1;
    }
    zoom = 1;
    getZoomFactor() {
      return this.zoom;
    }
    url = '';
    title = '';
    navigationHistory = {
      canGoBack: vi.fn(() => false),
      canGoForward: vi.fn(() => false),
      goBack: vi.fn(),
      goForward: vi.fn(),
    };
    loadURL = vi.fn(async (url: string) => {
      this.url = url;
    });
    getURL() {
      return this.url;
    }
    getTitle() {
      return this.title;
    }
    reload = vi.fn();
    close = vi.fn();
    popup?: Handler;
    setWindowOpenHandler(handler: Handler) {
      this.popup = handler;
    }
  }
  class FakeWindow extends Emitter {
    static getFocusedWindow() {
      return null;
    }
    static getAllWindows() {
      return windows;
    }
    contentView = { addChildView: vi.fn(), removeChildView: vi.fn() };
    webContents = new FakeContents();
    shown = 0;
    focused = 0;
    hidden = 0;
    overlays: unknown[] = [];
    constructor(public options: Record<string, unknown>) {
      super();
      // The tray's hidden popover is left out; these tests count the other windows.
      if (options.frame !== false) windows.push(this);
    }
    setTitleBarOverlay(overlay: unknown) {
      this.overlays.push(overlay);
    }
    setBackgroundColor() {}
    setIcon() {}
    show() {
      this.shown++;
    }
    hide() {
      this.hidden++;
    }
    isFullScreen() {
      return false;
    }
    focus() {
      this.focused++;
    }
    maximize() {}
    loadURL() {
      return Promise.resolve();
    }
    loadFile() {
      return Promise.resolve();
    }
    getNormalBounds() {
      return { x: 0, y: 0, width: 1200, height: 800 };
    }
    getContentSize() {
      return [1200, 800];
    }
    getMediaSourceId() {
      return `window:${windows.indexOf(this) + 1}:0`;
    }
    isMaximized() {
      return false;
    }
  }
  class FakeNotification extends Emitter {
    constructor(public options: { title: string; body: string }) {
      super();
      notifications.push(this);
    }
    show() {}
  }
  const app = Object.assign(new Emitter(), {
    isPackaged: true,
    name: 'Pantheon',
    setPath() {},
    getPath: (name: string) => path.join(root, name),
    getAppPath: () => path.join(root, 'app'),
    getPreferredSystemLanguages: () => ['zh-Hans-CN'],
    whenReady: () => Promise.resolve(),
    getVersion: () => '1.2.3',
    setAboutPanelOptions() {},
    requestSingleInstanceLock: () => lock,
    setAppUserModelId() {},
    setUserTasks() {},
    setAsDefaultProtocolClient() {},
    quits: 0,
    quit() {
      app.quits++;
    },
  });
  const workArea = { x: 0, y: 0, width: 1600, height: 1000 };
  const menus: MenuItemConstructorOptions[][] = [];
  const views: FakeView[] = [];
  class FakeView {
    webContents = new FakeContents();
    setBounds = vi.fn();
    constructor(public options: unknown) {
      views.push(this);
    }
  }
  const protocol = {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn(),
  };
  const sessions = new Map<string, { requestHandler?: Handler; checkHandler?: Handler }>();
  const module = {
    app,
    protocol,
    session: {
      defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
      fromPartition(partition: string) {
        const found = sessions.get(partition) ?? {};
        sessions.set(partition, found);
        return {
          setPermissionRequestHandler: (handler: Handler) => (found.requestHandler = handler),
          setPermissionCheckHandler: (handler: Handler) => (found.checkHandler = handler),
        };
      },
    },
    WebContentsView: FakeView,
    BrowserWindow: FakeWindow,
    Notification: FakeNotification,
    dialog: {},
    powerMonitor: new Emitter(),
    systemPreferences: Object.assign(new Emitter(), {
      getMediaAccessStatus: vi.fn((_media: string) => 'granted'),
    }),
    desktopCapturer: { getSources: vi.fn(async (_options: unknown): Promise<unknown[]> => []) },
    nativeTheme: { shouldUseDarkColors: false, on() {} },
    shell: { openExternal: vi.fn(async () => {}) },
    ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn), on() {} },
    Menu: {
      buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
        menus.push(template);
        return { popup() {} };
      },
      setApplicationMenu() {},
    },
    screen: {
      getAllDisplays: () => [{ workArea, size: workArea, scaleFactor: 2 }],
      getPrimaryDisplay: () => ({ workArea }),
    },
    Tray: class extends Emitter {
      setTitle() {}
      setToolTip() {}
      setContextMenu() {}
    },
    nativeImage: { createFromBuffer: () => ({ setTemplateImage() {} }) },
  };
  return { module, handlers, windows, notifications, menus, views, protocol, sessions, root };
}

async function startMain(platform: NodeJS.Platform = process.platform) {
  const root = tempRoot();
  vi.stubEnv('PANTHEON_DATA_DIR', path.join(root, 'state'));
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...real, value: platform });
  cleanups.push(() => {
    Object.defineProperty(process, 'platform', real);
    vi.unstubAllEnvs();
    vi.doUnmock(ELECTRON);
    vi.resetModules();
  });
  const electron = fakeMainElectron(root);
  vi.doMock(ELECTRON, () => ({ ...electron.module, default: electron.module }));
  vi.resetModules();
  await import('../../apps/desktop/src/main/index.js');
  await eventually(() => electron.windows.length === 1);
  return electron;
}

it('hides the window on close in macOS, so its page keeps the notices and the badge going', async () => {
  const electron = await startMain('darwin');
  const first = electron.windows[0]!;
  const close = { preventDefault: vi.fn() };
  first.emit('close', close);
  expect(close.preventDefault).toHaveBeenCalled();
  expect(first.hidden).toBe(1);
  electron.module.app.emit('activate');
  expect(first.shown).toBe(1);
  expect(electron.windows).toHaveLength(1);

  const request = { preventDefault: vi.fn() };
  electron.module.app.emit('before-quit', request);
  expect(request.preventDefault).toHaveBeenCalled();
  await electron.handlers.get('pantheon:confirmQuit')!({
    sender: first.webContents,
    senderFrame: first.webContents.mainFrame,
  });
  const quit = { preventDefault: vi.fn() };
  first.emit('close', quit);
  expect(quit.preventDefault).not.toHaveBeenCalled();
});

it('brings the hidden window to the front when the app is opened a second time', async () => {
  const electron = await startMain('darwin');
  const first = electron.windows[0]!;
  first.emit('close', { preventDefault() {} });
  electron.module.app.emit('second-instance', {}, ['Pantheon'], '/');
  expect([first.shown, first.focused]).toEqual([1, 1]);
  expect(electron.windows).toHaveLength(1);
});

it('quits a packaged app that another instance already holds, without a window', async () => {
  const root = tempRoot();
  vi.stubEnv('PANTHEON_DATA_DIR', path.join(root, 'state'));
  cleanups.push(() => {
    vi.unstubAllEnvs();
    vi.doUnmock(ELECTRON);
    vi.resetModules();
  });
  const electron = fakeMainElectron(root, false);
  vi.doMock(ELECTRON, () => ({ ...electron.module, default: electron.module }));
  vi.resetModules();
  await import('../../apps/desktop/src/main/index.js');
  await sleep(50);
  expect(electron.module.app.quits).toBe(1);
  expect(electron.windows).toHaveLength(0);
});

it('recolours the window buttons outside macOS when the page changes its theme', async () => {
  const electron = await startMain('win32');
  const shown = electron.windows[0]!;
  expect(shown.options).toMatchObject({
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(false),
  });
  const setTheme = (dark: unknown) =>
    electron.handlers.get('pantheon:setTitleBarTheme')!(
      { sender: shown.webContents, senderFrame: shown.webContents.mainFrame },
      dark,
    );
  expect(
    await setTheme({ dark: true, color: '#20201e', symbolColor: '#f0f0ea', background: '#121211' }),
  ).toEqual({ ok: true, value: null });
  expect(shown.overlays).toEqual([{ color: '#20201e', symbolColor: '#f0f0ea', height: 44 }]);
  expect(await setTheme('dark')).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  expect(shown.overlays).toHaveLength(1);
});

it('stops a framed page from navigating away from its own document and keeps the window on its page', async () => {
  vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173/');
  const electron = await startMain();
  const contents = electron.windows[0]!.webContents;
  const stopped = (name: string, url: string, isMainFrame: boolean) => {
    const event = { url, isMainFrame, preventDefault: vi.fn() };
    contents.emit(name, event);
    return event.preventDefault.mock.calls.length > 0;
  };
  expect(stopped('will-frame-navigate', 'https://example.com/', false)).toBe(true);
  expect(stopped('will-frame-navigate', 'about:srcdoc', false)).toBe(false);
  expect(stopped('will-frame-navigate', 'about:blank', false)).toBe(false);
  expect(stopped('will-frame-navigate', 'https://example.com/', true)).toBe(false);
  expect(stopped('will-navigate', 'https://example.com/', true)).toBe(true);
  expect(stopped('will-navigate', 'http://localhost:5173/?session=a', true)).toBe(false);
});

it('sends a menu action once the page has loaded, also to a window opened for it', async () => {
  const electron = await startMain();
  const click = (label: string) => {
    const item = electron.menus[0]!.flatMap(
      (menu) => menu.submenu as MenuItemConstructorOptions[],
    ).find((entry) => entry.label === label)!;
    (item.click as () => void)();
  };
  const first = electron.windows[0]!;
  click('设置…');
  expect(first.webContents.sent).toEqual([]);
  first.webContents.loading = false;
  first.webContents.emit('did-finish-load');
  expect(first.webContents.sent).toEqual([['pantheon:menu', 'settings']]);
  click('新会话');
  expect(first.webContents.sent).toEqual([
    ['pantheon:menu', 'settings'],
    ['pantheon:menu', 'new-session'],
  ]);

  first.emit('closed');
  click('打开项目…');
  expect(electron.windows).toHaveLength(2);
  const second = electron.windows[1]!;
  expect(second.webContents.sent).toEqual([]);
  second.webContents.loading = false;
  second.webContents.emit('did-finish-load');
  expect(second.webContents.sent).toEqual([['pantheon:menu', 'open-project']]);
});

it('sends a clicked notification target to the window, once a new window has loaded', async () => {
  const root = tempRoot();
  vi.stubEnv('PANTHEON_DATA_DIR', path.join(root, 'state'));
  cleanups.push(() => {
    vi.unstubAllEnvs();
    vi.doUnmock(ELECTRON);
    vi.resetModules();
  });
  const electron = fakeMainElectron(root);
  vi.doMock(ELECTRON, () => ({ ...electron.module, default: electron.module }));
  vi.resetModules();
  await import('../../apps/desktop/src/main/index.js');
  await eventually(() => electron.windows.length === 1);
  const first = electron.windows[0]!;
  first.webContents.loading = false;
  const notify = (input: object) =>
    electron.handlers.get('pantheon:notify')!(
      {
        sender: electron.windows.at(-1)!.webContents,
        senderFrame: electron.windows.at(-1)!.webContents.mainFrame,
      },
      input,
    );
  const target = { project_id: 'beta', session_id: 'beta-login' };

  expect(await notify({ title: 'Beta app · Fix login', body: '回合结束', target })).toEqual({
    ok: true,
    value: null,
  });
  electron.notifications[0]!.emit('click');
  expect([first.shown, first.focused]).toEqual([1, 1]);
  expect(first.webContents.sent).toEqual([['pantheon:notification-click', target]]);

  await notify({ title: 'Beta app', body: '已合并', target });
  first.emit('closed');
  electron.notifications[1]!.emit('click');
  expect(electron.windows).toHaveLength(2);
  const second = electron.windows[1]!;
  expect(second.webContents.sent).toEqual([]);
  second.webContents.loading = false;
  second.webContents.emit('did-finish-load');
  expect(second.webContents.sent).toEqual([['pantheon:notification-click', target]]);

  await notify({ title: 'Alpha app', body: '回合结束' });
  electron.notifications[2]!.emit('click');
  expect(second.webContents.sent).toHaveLength(1);

  for (const input of [
    null,
    { title: 1, body: 'b' },
    { title: 't', body: 'b', silent: 'yes' },
    { title: 't', body: 'b', target: { project_id: 'beta' } },
  ])
    expect(await notify(input as object)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
  expect(electron.notifications).toHaveLength(3);
});

it('passes the notification target and hands a click to the renderer listener', async () => {
  const ipc = new Emitter();
  const invoke = vi.fn(async () => ({ ok: true, value: null }));
  let exposed: any;
  cleanups.push(() => {
    vi.doUnmock(ELECTRON);
    vi.resetModules();
  });
  const module = {
    contextBridge: { exposeInMainWorld: (_name: string, api: unknown) => (exposed = api) },
    ipcRenderer: Object.assign(ipc, {
      invoke,
      send() {},
      sendSync: () => ({ choice: 'system', resolved: 'zh-CN' }),
      removeListener(name: string, fn: Handler) {
        ipc.listeners.set(
          name,
          (ipc.listeners.get(name) ?? []).filter((l) => l !== fn),
        );
      },
    }),
  };
  vi.doMock(ELECTRON, () => ({ ...module, default: module }));
  vi.resetModules();
  await import('../../apps/desktop/src/preload/index.js');
  const target = { project_id: 'beta', session_id: 'beta-login' };
  await exposed.notify({ title: 't', body: 'b', target });
  expect(invoke).toHaveBeenCalledWith('pantheon:notify', { title: 't', body: 'b', target });

  // A click that arrives before the page listens is handed over when it does.
  ipc.emit('pantheon:notification-click', {}, target);
  const clicked: unknown[] = [];
  const stop = exposed.onNotificationClick((t: unknown) => clicked.push(t));
  expect(clicked).toEqual([target]);
  const other = { project_id: 'alpha', session_id: 'alpha-1' };
  ipc.emit('pantheon:notification-click', {}, other);
  expect(clicked).toEqual([target, other]);
  stop();
  ipc.emit('pantheon:notification-click', {}, target);
  expect(clicked).toHaveLength(2);
});

it('keeps desktop settings inside an overridden data directory', () => {
  const appData = path.join(os.homedir(), 'Library/Application Support');
  vi.stubEnv('PANTHEON_DATA_DIR', '/scenario/state');
  try {
    expect(userDataDirectory(appData)).toBe('/scenario/state/desktop');
  } finally {
    vi.unstubAllEnvs();
  }
  vi.stubEnv('PANTHEON_DATA_DIR', undefined);
  try {
    expect(userDataDirectory(appData)).toBe(path.join(appData, 'Pantheon Desktop'));
  } finally {
    vi.unstubAllEnvs();
  }
});

it('owns one isolated browser view per window, reports state and releases it on close', async () => {
  const electron = await startMain();
  const first = electron.windows[0]!;
  const call = (name: string, input: unknown, window = first) =>
    electron.handlers.get(`pantheon:${name}`)!(
      { sender: window.webContents, senderFrame: window.webContents.mainFrame },
      input,
    ) as Promise<any>;
  const bounds = { x: 12, y: 40, width: 640, height: 480 };
  const opened = await call('browserOpen', { url: 'http://localhost:3000', bounds });
  expect(opened).toMatchObject({ ok: true, value: { id: expect.any(String) } });
  const id = opened.value.id;
  const view = electron.views[0]!;
  expect(view.options).toEqual({
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      partition: 'persist:pantheon-browser',
    },
  });
  expect(first.contentView.addChildView).toHaveBeenCalledWith(view);
  expect(view.setBounds).toHaveBeenCalledWith(bounds);
  expect(await call('browserOpen', { url: 'https://example.com', bounds })).toEqual(opened);
  expect(electron.views).toHaveLength(1);
  expect(view.webContents.loadURL).toHaveBeenLastCalledWith('https://example.com/');
  expect(await call('browserNavigate', { id, url: 'http://127.0.0.1:9000/app' })).toEqual({
    ok: true,
    value: null,
  });
  view.webContents.title = 'Preview';
  view.webContents.navigationHistory.canGoBack.mockReturnValue(true);
  for (const event of [
    'did-start-loading',
    'did-stop-loading',
    'did-navigate',
    'did-navigate-in-page',
    'page-title-updated',
  ]) {
    view.webContents.emit(event);
    expect(first.webContents.sent.at(-1)).toEqual([
      'pantheon:browser-state',
      {
        id,
        url: 'http://127.0.0.1:9000/app',
        title: 'Preview',
        can_go_back: true,
        can_go_forward: false,
        loading: true,
      },
    ]);
  }
  await call('browserBack', { id });
  await call('browserForward', { id });
  await call('browserReload', { id });
  expect(view.webContents.navigationHistory.goBack).toHaveBeenCalledOnce();
  expect(view.webContents.navigationHistory.goForward).not.toHaveBeenCalled();
  expect(view.webContents.reload).toHaveBeenCalledOnce();
  await call('browserSetBounds', { id, bounds: { ...bounds, width: 800 } });
  expect(view.setBounds).toHaveBeenLastCalledWith({ ...bounds, width: 800 });
  expect(view.webContents.popup!({ url: 'https://example.com/popup' })).toEqual({ action: 'deny' });
  expect(electron.module.shell.openExternal).toHaveBeenCalledWith('https://example.com/popup');
  for (const event of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
    const blocked = { url: 'file:///etc/passwd', preventDefault: vi.fn() };
    view.webContents.emit(event, blocked);
    expect(blocked.preventDefault).toHaveBeenCalledOnce();
  }
  await call('openWindow', { kind: 'project', project_id: 'preview-project' });
  const second = electron.windows[1]!;
  expect(await call('browserReload', { id }, second)).toMatchObject({ ok: false });
  const other = await call('browserOpen', { url: 'https://example.org', bounds }, second);
  expect(other.value.id).not.toBe(id);
  await call('browserClose', { id });
  expect(first.contentView.removeChildView).toHaveBeenCalledWith(view);
  expect(view.webContents.close).toHaveBeenCalledOnce();
  expect(await call('browserReload', { id })).toMatchObject({ ok: false });
  second.emit('closed');
  expect(electron.views[1]!.webContents.close).toHaveBeenCalledOnce();
});

it('denies every permission request and check of the browser view session', async () => {
  const electron = await startMain();
  const first = electron.windows[0]!;
  await electron.handlers.get('pantheon:browserOpen')!(
    { sender: first.webContents, senderFrame: first.webContents.mainFrame },
    { url: 'https://example.com', bounds: { x: 0, y: 0, width: 400, height: 300 } },
  );
  const browserSession = electron.sessions.get('persist:pantheon-browser');
  expect(browserSession?.requestHandler).toBeTypeOf('function');
  expect(browserSession?.checkHandler).toBeTypeOf('function');
  const view = electron.views[0]!;
  for (const [permission, details] of [
    ['media', { mediaTypes: ['audio'] }],
    ['media', { mediaTypes: ['video'] }],
    ['notifications', {}],
    ['geolocation', {}],
    ['clipboard-read', {}],
  ] as const) {
    const answer = vi.fn();
    browserSession!.requestHandler!(view.webContents, permission, answer, details);
    expect(answer).toHaveBeenCalledExactlyOnceWith(false);
    expect(
      browserSession!.checkHandler!(view.webContents, permission, 'https://example.com', {}),
    ).toBe(false);
  }
});

it('closes the browser view when the page that owns it reloads', async () => {
  const electron = await startMain();
  const first = electron.windows[0]!;
  const call = (name: string, input: unknown) =>
    electron.handlers.get(`pantheon:${name}`)!(
      { sender: first.webContents, senderFrame: first.webContents.mainFrame },
      input,
    ) as Promise<any>;
  const bounds = { x: 0, y: 0, width: 400, height: 300 };
  const opened = await call('browserOpen', { url: 'https://example.com', bounds });
  const view = electron.views[0]!;
  first.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  first.webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  expect(view.webContents.close).not.toHaveBeenCalled();
  first.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  expect(first.contentView.removeChildView).toHaveBeenCalledWith(view);
  expect(view.webContents.close).toHaveBeenCalledOnce();
  expect(await call('browserReload', { id: opened.value.id })).toMatchObject({ ok: false });
  const reopened = await call('browserOpen', { url: 'https://example.com', bounds });
  expect(reopened.value.id).not.toBe(opened.value.id);
  expect(electron.views).toHaveLength(2);
});

it('places the browser view in window coordinates at the page zoom', async () => {
  const electron = await startMain();
  const first = electron.windows[0]!;
  const call = (name: string, input: unknown) =>
    electron.handlers.get(`pantheon:${name}`)!(
      { sender: first.webContents, senderFrame: first.webContents.mainFrame },
      input,
    ) as Promise<any>;
  first.webContents.zoom = 1.25;
  const bounds = { x: 12, y: 40, width: 640, height: 480 };
  const opened = await call('browserOpen', { url: 'https://example.com', bounds });
  const view = electron.views[0]!;
  expect(view.setBounds).toHaveBeenLastCalledWith({ x: 15, y: 50, width: 800, height: 600 });
  first.webContents.zoom = 0.9;
  await call('browserSetBounds', { id: opened.value.id, bounds: { ...bounds, width: 801 } });
  expect(view.setBounds).toHaveBeenLastCalledWith({ x: 11, y: 36, width: 721, height: 432 });
});

it('rejects browser IPC from other senders, invalid URLs, bounds and ids before touching a view', async () => {
  const electron = await startMain();
  const window = electron.windows[0]!;
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const open = electron.handlers.get('pantheon:browserOpen')!;
  const bounds = { x: 0, y: 0, width: 400, height: 300 };
  for (const input of [
    null,
    {},
    { url: 10, bounds },
    ...[
      'file:///etc/passwd',
      'javascript:alert(1)',
      'mailto:a@b.com',
      'pantheon-visual://page/',
      'invalid',
    ].map((url) => ({ url, bounds })),
    ...[
      { ...bounds, width: -1 },
      { ...bounds, x: NaN },
      { ...bounds, height: 1.5 },
      { x: 0, y: 0 },
    ].map((bounds) => ({ url: 'https://example.com', bounds })),
  ]) {
    expect(await open(event, input)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
  }
  expect(electron.views).toHaveLength(0);
  for (const name of [
    'browserOpen',
    'browserNavigate',
    'browserBack',
    'browserForward',
    'browserReload',
    'browserSetBounds',
    'browserClose',
    'visualServe',
    'listBrowsers',
    'chooseBrowser',
  ]) {
    expect(
      await electron.handlers.get(`pantheon:${name}`)!({ sender: {}, senderFrame: {} }, {}),
    ).toMatchObject({ ok: false, error: { code: 'forbidden_sender' } });
    expect(
      await electron.handlers.get(`pantheon:${name}`)!({ ...event, senderFrame: {} }, {}),
    ).toMatchObject({ ok: false, error: { code: 'forbidden_sender' } });
  }
  const opened: any = await open(event, { url: 'https://example.com', bounds });
  const id = opened.value.id;
  for (const name of [
    'browserNavigate',
    'browserBack',
    'browserForward',
    'browserReload',
    'browserSetBounds',
    'browserClose',
  ]) {
    expect(await electron.handlers.get(`pantheon:${name}`)!(event, { id: 1 })).toMatchObject({
      ok: false,
    });
    expect(
      await electron.handlers.get(`pantheon:${name}`)!(event, { id: 'missing' }),
    ).toMatchObject({ ok: false });
  }
  expect(
    await electron.handlers.get('pantheon:browserNavigate')!(event, {
      id,
      url: 'file:///etc/passwd',
    }),
  ).toMatchObject({ ok: false });
  expect(
    await electron.handlers.get('pantheon:browserSetBounds')!(event, { id, bounds: null }),
  ).toMatchObject({ ok: false });
  electron.views[0]!.webContents.loadURL.mockRejectedValueOnce(new Error('Connection refused'));
  expect(
    await electron.handlers.get('pantheon:browserNavigate')!(event, {
      id,
      url: 'http://localhost:3000',
    }),
  ).toMatchObject({ ok: false, error: { code: 'browser_load_failed' } });
});

it('registers isolated visual origins before readiness and serves only stored pages and chart assets', async () => {
  const electron = await startMain();
  expect(electron.protocol.registerSchemesAsPrivileged).toHaveBeenCalledWith([
    {
      scheme: 'pantheon-visual',
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
    { scheme: 'pantheon-app', privileges: { standard: true, secure: true } },
  ]);
  expect(electron.protocol.registerSchemesAsPrivileged.mock.invocationCallOrder[0]).toBeLessThan(
    electron.protocol.handle.mock.invocationCallOrder[0]!,
  );
  const serve = electron.handlers.get('pantheon:visualServe')!;
  const window = electron.windows[0]!;
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const html = '<h1>Visual</h1><script>window.drawn = true</script>';
  const first: any = await serve(event, { html });
  const second: any = await serve(event, { html: 'second' });
  expect(new URL(first.value.url).host).not.toBe(new URL(second.value.url).host);
  const respond = electron.protocol.handle.mock.calls[0]![1] as (
    request: Request,
  ) => Promise<Response>;
  const response = await respond(new Request(first.value.url));
  expect(await response.text()).toBe(html);
  expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
  expect(response.headers.get('Content-Security-Policy')).toBe(
    "default-src 'none'; script-src 'unsafe-inline' pantheon-visual://" +
      new URL(first.value.url).host +
      "/libraries/charts.js; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'",
  );
  for (const suffix of ['private', 'libraries/unknown.js', 'libraries/../../main/index.js'])
    expect((await respond(new Request(first.value.url + suffix))).status).toBe(404);
  expect(await serve(event, { html: 1 })).toMatchObject({
    ok: false,
    error: { code: 'invalid_input' },
  });
  for (let index = 0; index < 199; index++) await serve(event, { html: String(index) });
  expect((await respond(new Request(first.value.url))).status).toBe(404);
  expect((await respond(new Request(second.value.url))).status).toBe(200);
  window.emit('closed');
  expect((await respond(new Request(second.value.url))).status).toBe(404);
});

it('allows a served visual as a frame while keeping network frame navigation blocked', async () => {
  const electron = await startMain();
  const window = electron.windows[0]!;
  const served: any = await electron.handlers.get('pantheon:visualServe')!(
    { sender: window.webContents, senderFrame: window.webContents.mainFrame },
    { html: 'visual' },
  );
  for (const [url, allowed] of [
    [served.value.url, true],
    ['https://example.com', false],
    ['pantheon-visual://unknown/', false],
  ] as const) {
    const event = { url, isMainFrame: false, preventDefault: vi.fn() };
    window.webContents.emit('will-frame-navigate', event);
    expect(event.preventDefault.mock.calls.length === 0).toBe(allowed);
  }
});

it('exposes the browser and visual IPC and unsubscribes browser state listeners', async () => {
  const ipc = new Emitter();
  const invoke = vi.fn(async () => ({ ok: true, value: null }));
  let exposed: DesktopBridge;
  cleanups.push(() => {
    vi.doUnmock(ELECTRON);
    vi.resetModules();
  });
  const module = {
    contextBridge: {
      exposeInMainWorld: (_name: string, api: DesktopBridge) => {
        exposed = api;
      },
    },
    ipcRenderer: Object.assign(ipc, {
      invoke,
      send() {},
      sendSync() {},
      removeListener(name: string, fn: Handler) {
        ipc.listeners.set(
          name,
          (ipc.listeners.get(name) ?? []).filter((listener) => listener !== fn),
        );
      },
    }),
  };
  vi.doMock(ELECTRON, () => ({ ...module, default: module }));
  vi.resetModules();
  await import('../../apps/desktop/src/preload/index.js');
  const open = { url: 'https://example.com', bounds: { x: 0, y: 0, width: 400, height: 300 } };
  await exposed!.browserOpen(open);
  await exposed!.browserNavigate({ id: 'browser', url: open.url });
  for (const name of ['browserBack', 'browserForward', 'browserReload', 'browserClose'] as const)
    await exposed![name]({ id: 'browser' });
  await exposed!.browserSetBounds({ id: 'browser', bounds: open.bounds });
  await exposed!.visualServe({ html: '<h1>Hello</h1>' });
  await exposed!.listBrowsers();
  await exposed!.chooseBrowser(null);
  expect(invoke.mock.calls).toEqual([
    ['pantheon:browserOpen', open],
    ['pantheon:browserNavigate', { id: 'browser', url: open.url }],
    ...['browserBack', 'browserForward', 'browserReload', 'browserClose'].map((name) => [
      `pantheon:${name}`,
      { id: 'browser' },
    ]),
    ['pantheon:browserSetBounds', { id: 'browser', bounds: open.bounds }],
    ['pantheon:visualServe', { html: '<h1>Hello</h1>' }],
    ['pantheon:listBrowsers'],
    ['pantheon:chooseBrowser', null],
  ]);
  const listener = vi.fn();
  const stop = exposed!.onBrowserState(listener);
  const state = {
    id: 'browser',
    url: open.url,
    title: 'Preview',
    can_go_back: false,
    can_go_forward: false,
    loading: false,
  };
  ipc.emit('pantheon:browser-state', {}, state);
  expect(listener).toHaveBeenCalledWith(state);
  stop();
  ipc.emit('pantheon:browser-state', {}, state);
  expect(listener).toHaveBeenCalledOnce();
});

it('streams a terminal through the preload until the page ends it', async () => {
  const ipc = new Emitter();
  const send = vi.fn();
  const invoke = vi.fn(async () => ({ ok: true, value: 'Firefox' }));
  let exposed: DesktopBridge;
  cleanups.push(() => {
    vi.doUnmock(ELECTRON);
    vi.resetModules();
  });
  const module = {
    contextBridge: {
      exposeInMainWorld: (_name: string, api: DesktopBridge) => {
        exposed = api;
      },
    },
    ipcRenderer: Object.assign(ipc, { invoke, send, sendSync() {}, removeListener() {} }),
  };
  vi.doMock(ELECTRON, () => ({ ...module, default: module }));
  vi.resetModules();
  await import('../../apps/desktop/src/preload/index.js');
  expect(await exposed!.chosenBrowser()).toEqual({ ok: true, value: 'Firefox' });
  expect(invoke).toHaveBeenCalledWith('pantheon:chosenBrowser');
  await exposed!.visualServe({ html: '<p>x</p>', hosts: ['https://cdn.example.com'] });
  expect(invoke).toHaveBeenLastCalledWith('pantheon:visualServe', {
    html: '<p>x</p>',
    hosts: ['https://cdn.example.com'],
  });
  const frames: unknown[] = [];
  const end = exposed!.terminalSubscribe('terminal-1', (frame) => frames.push(frame));
  const [channel, id, terminal] = send.mock.calls.at(-1)!;
  expect([channel, terminal]).toEqual(['pantheon:terminalSubscribe', 'terminal-1']);
  const bytes = new Uint8Array([104, 105]);
  ipc.emit('pantheon:terminal', {}, id, { data: bytes });
  ipc.emit('pantheon:terminal', {}, id + 1, { data: bytes });
  ipc.emit('pantheon:terminal', {}, id, { exit: 0 });
  expect(frames).toEqual([{ data: bytes }, { exit: 0 }]);
  end();
  expect(send).toHaveBeenLastCalledWith('pantheon:terminalUnsubscribe', id);
  ipc.emit('pantheon:terminal', {}, id, { data: bytes });
  expect(frames).toHaveLength(2);
});

it('serves a visual with allowed https hosts in its policy and refuses other hosts', async () => {
  const electron = await startMain();
  const window = electron.windows[0]!;
  const serve = (input: unknown) =>
    electron.handlers.get('pantheon:visualServe')!(
      { sender: window.webContents, senderFrame: window.webContents.mainFrame },
      input,
    );
  for (const hosts of [['http://cdn.example.com'], ['https://cdn.example.com/x'], 'https://a.b'])
    expect(await serve({ html: '<p>x</p>', hosts })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
  const served: any = await serve({ html: '<p>x</p>', hosts: ['https://cdn.example.com'] });
  const respond = electron.protocol.handle.mock.calls.find(
    ([scheme]: unknown[]) => scheme === 'pantheon-visual',
  )![1] as (request: { url: string }) => Promise<Response>;
  const response = await respond({ url: served.value.url });
  expect(response.headers.get('Content-Security-Policy')).toContain(
    'connect-src https://cdn.example.com',
  );
});

it('lists installed browsers, saves the choice beside the terminal, and opens links with it on macOS', async () => {
  const electron = await startMain('darwin');
  const browsers = await import('../../apps/desktop/src/main/browsers.js');
  const installed = [{ id: 'Firefox', name: 'Firefox', path: '/Applications/Firefox.app' }];
  const scan = vi.spyOn(browsers, 'scanBrowsers').mockReturnValue(installed);
  cleanups.push(() => scan.mockRestore());
  const window = electron.windows[0]!;
  const call = (name: string, input?: unknown) =>
    electron.handlers.get(`pantheon:${name}`)!(
      { sender: window.webContents, senderFrame: window.webContents.mainFrame },
      input,
    );
  const settings = path.join(electron.root, 'userData/settings.json');
  mkdirSync(path.dirname(settings), { recursive: true });
  writeFileSync(settings, '{"terminal":"Ghostty"}');
  expect(await call('chosenBrowser')).toEqual({ ok: true, value: null });
  expect(await call('listBrowsers')).toEqual({ ok: true, value: installed });
  expect(await call('chooseBrowser', 1)).toMatchObject({
    ok: false,
    error: { code: 'invalid_input' },
  });
  expect(await call('chooseBrowser', 'Unknown')).toMatchObject({
    ok: false,
    error: { code: 'browser_unavailable' },
  });
  expect(await call('chooseBrowser', 'Firefox')).toEqual({ ok: true, value: null });
  expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({
    terminal: 'Ghostty',
    browser: 'Firefox',
  });
  expect(await call('chosenBrowser')).toEqual({ ok: true, value: 'Firefox' });
  const childProcess = await import('node:child_process');
  const exec = vi.mocked(childProcess.execFile).mockImplementation(((
    _file: string,
    _args: string[],
    callback: ExecFileCallback,
  ) => {
    callback(null, '', '');
  }) as any);
  cleanups.push(() => exec.mockRestore());
  expect(await call('openLink', 'https://example.com')).toEqual({ ok: true, value: null });
  expect(exec).toHaveBeenCalledWith(
    'open',
    ['-a', installed[0]!.path, 'https://example.com/'],
    expect.any(Function),
  );
  scan.mockReturnValue([]);
  await call('openLink', 'https://example.org');
  expect(electron.module.shell.openExternal).toHaveBeenLastCalledWith('https://example.org/');
  scan.mockReturnValue(installed);
  expect(await call('chooseBrowser', null)).toEqual({ ok: true, value: null });
  expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ terminal: 'Ghostty' });
  await call('openLink', 'mailto:a@example.com');
  expect(electron.module.shell.openExternal).toHaveBeenLastCalledWith('mailto:a@example.com');
});

it('opens links the browser panel pops out in the browser chosen on macOS', async () => {
  const electron = await startMain('darwin');
  const browsers = await import('../../apps/desktop/src/main/browsers.js');
  const installed = [{ id: 'Firefox', name: 'Firefox', path: '/Applications/Firefox.app' }];
  const scan = vi.spyOn(browsers, 'scanBrowsers').mockReturnValue(installed);
  cleanups.push(() => scan.mockRestore());
  const window = electron.windows[0]!;
  const call = (name: string, input?: unknown) =>
    electron.handlers.get(`pantheon:${name}`)!(
      { sender: window.webContents, senderFrame: window.webContents.mainFrame },
      input,
    );
  expect(await call('chooseBrowser', 'Firefox')).toEqual({ ok: true, value: null });
  const childProcess = await import('node:child_process');
  const exec = vi.mocked(childProcess.execFile).mockImplementation(((
    _file: string,
    _args: string[],
    callback: ExecFileCallback,
  ) => {
    callback(null, '', '');
  }) as any);
  cleanups.push(() => exec.mockRestore());
  await call('browserOpen', {
    url: 'http://localhost:3000',
    bounds: { x: 0, y: 0, width: 640, height: 480 },
  });
  const view = electron.views[0]!;
  expect(view.webContents.popup!({ url: 'https://example.com/popup' })).toEqual({ action: 'deny' });
  expect(exec).toHaveBeenCalledWith(
    'open',
    ['-a', installed[0]!.path, 'https://example.com/popup'],
    expect.any(Function),
  );
  expect(electron.module.shell.openExternal).not.toHaveBeenCalled();
});

it.each(['linux', 'win32'] as const)(
  'keeps external links in the system browser on %s',
  async (platform) => {
    const electron = await startMain(platform);
    const window = electron.windows[0]!;
    const settings = path.join(electron.root, 'userData/settings.json');
    mkdirSync(path.dirname(settings), { recursive: true });
    writeFileSync(settings, '{"browser":"Firefox"}');
    const result = await electron.handlers.get('pantheon:openLink')!(
      { sender: window.webContents, senderFrame: window.webContents.mainFrame },
      'https://example.com',
    );
    expect(result).toEqual({ ok: true, value: null });
    expect(electron.module.shell.openExternal).toHaveBeenCalledWith('https://example.com/');
    expect(
      await electron.handlers.get('pantheon:listBrowsers')!({
        sender: window.webContents,
        senderFrame: window.webContents.mainFrame,
      }),
    ).toEqual({ ok: true, value: [] });
  },
);

it('lists only the folders of a folder, hidden ones last, and refuses a path that is no folder', async () => {
  const electron = await startMain();
  const window = electron.windows[0]!;
  const browse = (input: unknown) =>
    electron.handlers.get('pantheon:browseDirectory')!(
      { sender: window.webContents, senderFrame: window.webContents.mainFrame },
      input,
    );
  const folder = path.join(tempRoot(), 'browse');
  mkdirSync(path.join(folder, 'a'), { recursive: true });
  mkdirSync(path.join(folder, '.b'));
  writeFileSync(path.join(folder, 'c.txt'), 'text');
  expect(await browse(folder)).toEqual({
    ok: true,
    value: {
      path: folder,
      parent: path.dirname(folder),
      entries: [
        { name: 'a', path: path.join(folder, 'a'), hidden: false },
        { name: '.b', path: path.join(folder, '.b'), hidden: true },
      ],
    },
  });
  for (const missing of [path.join(folder, 'none'), path.join(folder, 'c.txt')])
    expect(await browse(missing)).toMatchObject({
      ok: false,
      error: { code: 'not_a_directory' },
    });
  expect(await browse('~')).toMatchObject({ ok: true, value: { path: os.homedir() } });
});

/** A captured image as desktopCapturer hands it over; no bytes is an empty image. */
const capturedImage = (bytes: number[]) => ({
  isEmpty: () => bytes.length === 0,
  toDataURL: () => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`,
  toPNG: () => Buffer.from(bytes),
});

it('lists the windows of other apps with a thumbnail each and leaves its own windows out', async () => {
  const electron = await startMain('darwin');
  const window = electron.windows[0]!;
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const { getSources } = electron.module.desktopCapturer;
  getSources.mockResolvedValue([
    { id: window.getMediaSourceId(), name: 'Pantheon', thumbnail: capturedImage([1]) },
    { id: 'window:200:0', name: 'Safari', thumbnail: capturedImage([2]) },
    { id: 'window:201:0', name: 'Minimized', thumbnail: capturedImage([]) },
  ]);
  expect(await electron.handlers.get('pantheon:listWindowSnapshots')!(event)).toEqual({
    ok: true,
    value: {
      permission: 'granted',
      windows: [{ id: 'window:200:0', name: 'Safari', thumbnail: 'data:image/png;base64,Ag==' }],
    },
  });
  expect(getSources).toHaveBeenCalledWith({
    types: ['window'],
    thumbnailSize: expect.objectContaining({ width: expect.any(Number) }),
  });
});

it('reports the screen recording permission as denied when no window of another app shows', async () => {
  const electron = await startMain('darwin');
  const window = electron.windows[0]!;
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  electron.module.systemPreferences.getMediaAccessStatus.mockReturnValue('denied');
  electron.module.desktopCapturer.getSources.mockResolvedValue([
    { id: window.getMediaSourceId(), name: 'Pantheon', thumbnail: capturedImage([1]) },
    { id: 'window:200:0', name: 'Safari', thumbnail: capturedImage([]) },
  ]);
  expect(await electron.handlers.get('pantheon:listWindowSnapshots')!(event)).toEqual({
    ok: true,
    value: { permission: 'denied', windows: [] },
  });
  expect(await electron.handlers.get('pantheon:openPrivacySettings')!(event, 'screen')).toEqual({
    ok: true,
    value: null,
  });
  expect(electron.module.shell.openExternal).toHaveBeenLastCalledWith(
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  );
});

it('captures a window at the display pixel size and attaches it to the project as a PNG', async () => {
  const electron = await startMain('darwin');
  const daemon = await import('../../apps/desktop/src/main/daemon.js');
  const meta = { id: 'attachment', name: 'Safari-Start Page.png', mime: 'image/png', size: 3 };
  const attach = vi
    .spyOn(daemon.DaemonBridge.prototype, 'attach')
    .mockResolvedValue({ ok: true, value: meta });
  cleanups.push(() => attach.mockRestore());
  const window = electron.windows[0]!;
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const { getSources } = electron.module.desktopCapturer;
  getSources.mockResolvedValue([
    { id: window.getMediaSourceId(), name: 'Pantheon', thumbnail: capturedImage([1]) },
    { id: 'window:200:0', name: 'Safari/Start Page', thumbnail: capturedImage([7, 8, 9]) },
  ]);
  const snapshot = electron.handlers.get('pantheon:snapshotWindow')!;
  // Only a window the picker listed can be captured.
  expect(await snapshot(event, 'project-a', 'window:200:0')).toMatchObject({
    ok: false,
    error: { code: 'window_unavailable' },
  });
  await electron.handlers.get('pantheon:listWindowSnapshots')!(event);
  expect(await snapshot(event, 'project-a', 'window:200:0')).toEqual({ ok: true, value: meta });
  expect(getSources).toHaveBeenLastCalledWith({
    types: ['window'],
    thumbnailSize: { width: 3200, height: 2000 },
  });
  expect(attach).toHaveBeenCalledOnce();
  const [project, name, mime, bytes] = attach.mock.calls[0]!;
  expect([project, name, mime, [...bytes]]).toEqual([
    'project-a',
    'Safari-Start Page.png',
    'image/png',
    [7, 8, 9],
  ]);
  expect(await snapshot(event, 'project-a', window.getMediaSourceId())).toMatchObject({
    ok: false,
    error: { code: 'window_unavailable' },
  });
  expect(attach).toHaveBeenCalledOnce();
});

it('exposes listing and capturing windows and the screen recording settings through the preload', async () => {
  const invoke = vi.fn(async () => ({ ok: true, value: null }));
  let exposed: DesktopBridge;
  cleanups.push(() => {
    vi.doUnmock(ELECTRON);
    vi.resetModules();
  });
  const module = {
    contextBridge: {
      exposeInMainWorld: (_name: string, api: DesktopBridge) => {
        exposed = api;
      },
    },
    ipcRenderer: Object.assign(new Emitter(), { invoke, send() {}, sendSync() {} }),
  };
  vi.doMock(ELECTRON, () => ({ ...module, default: module }));
  vi.resetModules();
  await import('../../apps/desktop/src/preload/index.js');
  await exposed!.listWindowSnapshots();
  await exposed!.snapshotWindow('project-a', 'window:200:0');
  await exposed!.openPrivacySettings('screen');
  expect(invoke.mock.calls).toEqual([
    ['pantheon:listWindowSnapshots'],
    ['pantheon:snapshotWindow', 'project-a', 'window:200:0'],
    ['pantheon:openPrivacySettings', 'screen'],
  ]);
});
