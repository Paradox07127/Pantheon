import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import { NATIVE_ENV_ALLOWLIST } from '@pantheon/domain';
import { Control, type ControlOptions } from '@pantheon/control';
import type {
  Approval,
  Project,
  Session,
  SessionSpec,
  SessionTurn,
  UserTurn,
  Workspace,
} from '@pantheon/domain';
import { command, type CommandType, type DeviceStatus } from '@pantheon/protocol';
import { ArtifactFiles, Store } from '@pantheon/store';
import type { ControlContext } from '../../packages/control/src/context.js';
import {
  prepareRemoteWorkspace,
  pullRemoteWorkspace,
  remoteSessionSpec,
} from '../../packages/control/src/remote-workspace.js';
import { awaitWorkspaceReady, countingGit, eventually, user } from '../helpers.js';
import { git } from './workbench-fixture.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const script = (...steps: unknown[]) =>
  `Work on the device\nfixture-script\n${JSON.stringify(steps)}`;

/** A project whose sessions can run on a device that is a directory of this machine. */
async function deviceFixture(options: ControlOptions = {}) {
  const cache = path.join(process.cwd(), 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(path.join(cache, 'pantheon-remote-')),
    source = path.join(root, 'project/source'),
    workspaceRoot = path.join(root, 'managed'),
    configDir = path.join(root, 'config'),
    home = path.join(root, 'device-home');
  for (const directory of [source, workspaceRoot, configDir, home])
    mkdirSync(directory, { recursive: true });
  git(source, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(path.join(source, '.gitignore'), 'node_modules/\n');
  writeFileSync(path.join(source, 'answer.txt'), 'base\n');
  git(source, 'add', '.');
  git(source, 'commit', '--quiet', '-m', 'Initial files');
  writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      version: 1,
      backends: [
        {
          id: 'proxy',
          protocol: 'anthropic',
          base_url: 'https://proxy.example.invalid',
          key: { env: 'PROXY_KEY' },
        },
      ],
      devices: { 'build-box': { ssh: 'builder@build-box' } },
    }),
  );
  const adapter = new FixtureAdapter(40),
    store = new Store(path.join(root, 'state/control.sqlite')),
    files = new ArtifactFiles(path.join(root, 'state/artifacts'));
  const control = new Control(store, files, [adapter], undefined, {
    workspaceRoot,
    userConfigDir: configDir,
    deviceLink: () => ({
      transport: ['/bin/sh', '-c'],
      gitUrl: (target) => target,
      withSocket: (localSocket) => ({ transport: ['/bin/sh', '-c'], socket: localSocket }),
    }),
    readProcess: () => undefined,
    ...options,
  });
  cleanups.push(async () => {
    await control.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const ctx = (control as unknown as { ctx: ControlContext }).ctx,
    devices = ctx.devices!;
  const probed = (status: Partial<DeviceStatus> = {}) =>
    devices.set('build-box', {
      id: 'build-box',
      name: 'build-box',
      ssh: 'builder@build-box',
      labels: [],
      resources: {},
      max_sessions: 1,
      online: true,
      checked_at: new Date().toISOString(),
      home,
      path: process.env.PATH,
      runtimes: {
        [adapter.name]: { binary: '/usr/local/bin/fixture', version: '1', logged_in: true },
      },
      tools: {},
      ...status,
    });
  probed();
  const call = <T = unknown>(
    type: CommandType,
    input: Record<string, unknown>,
    revision: number | null = null,
  ) => control.execute(user, command(user.id, type, input, revision)) as T;
  const project = await call<Project>('project.open', { name: 'Device project', roots: [source] });
  const current = (sessionId: string) => store.must<Session>('sessions', sessionId);
  const turns = (sessionId: string) =>
    store.list<SessionTurn>('session_turns').filter((turn) => turn.session_id === sessionId);
  const create = (input: string, extra: Record<string, unknown> = {}) =>
    call<Promise<Session>>('session.create', {
      project_id: project.id,
      runtime: adapter.name,
      input,
      device_id: 'build-box',
      ...extra,
    });
  const send = (sessionId: string, input: string) =>
    call('session.send', { session_id: sessionId, input }, current(sessionId).revision);
  const settle = async (session: Session) => {
    await awaitWorkspaceReady(control, session.workspace_id!);
    await eventually(
      () =>
        current(session.id).state === 'open' &&
        turns(session.id).every((turn) => !['queued', 'running'].includes(turn.state)),
      () => control.tick(),
      10000,
    );
  };
  const local = (session: Session) =>
    store.must<Workspace>('workspaces', session.workspace_id!).path;
  const deviceRepo = path.join(home, '.pantheon/remote', project.id, 'repo.git');
  const deviceWork = (session: Session) =>
    path.join(home, '.pantheon/remote', project.id, 'w', session.workspace_id!);
  return {
    ctx,
    store,
    control,
    adapter,
    call,
    project,
    source,
    probed,
    create,
    send,
    settle,
    turns,
    current,
    local,
    home,
    deviceRepo,
    deviceWork,
  };
}

const read = (directory: string, file: string) => readFileSync(path.join(directory, file), 'utf8');

/** A step that holds the running turn until `release` answers it. */
const hold = { ask: { tool: 'Bash', input: { command: 'true' } } };

/** Answers the request of the hold step, so the turn goes on to its later steps. */
async function release(f: Awaited<ReturnType<typeof deviceFixture>>, session: Session) {
  const pending = () =>
    f.store
      .list<Approval>('approvals')
      .find((approval) => approval.session_id === session.id && approval.state === 'pending');
  await eventually(
    () => !!pending(),
    () => f.control.tick(),
    10000,
  );
  const approval = pending()!;
  f.call('approval.respond', { approval_id: approval.id, decision: 'approve' }, approval.revision);
}

let specFixture: ReturnType<typeof twoSessions> | undefined;
afterAll(async () => {
  if (specFixture) await (await specFixture).cleanup();
});
/** Two settled sessions on the device, shared by the tests that only compute specs from them. */
async function twoSessions() {
  const f = await deviceFixture();
  // The fixture outlives each test; afterAll removes it.
  const cleanup = cleanups.pop()!;
  f.probed({ max_sessions: 2 });
  const session = await f.create(script({ say: 'Ready' }));
  await f.settle(session);
  const other = await f.create(script({ say: 'Ready' }));
  await f.settle(other);
  return { f, session, other, cleanup };
}
const sharedSessions = () => (specFixture ??= twoSessions());

it('brings a file the device wrote and committed back into the local worktree', async () => {
  const f = await deviceFixture();
  const session = await f.create(
    script(
      { write: { path: 'notes.txt', text: 'written on the device\n' } },
      { commit: 'Notes written on the device' },
    ),
  );
  await f.settle(session);

  const local = f.local(session),
    device = f.deviceWork(session);
  expect(f.turns(session.id).map((turn) => turn.state)).toEqual(['completed']);
  expect(read(local, 'notes.txt')).toBe('written on the device\n');
  expect(read(device, 'notes.txt')).toBe('written on the device\n');
  expect(git(local, 'rev-parse', 'HEAD')).toBe(git(device, 'rev-parse', 'HEAD'));
  expect(git(local, 'log', '-1', '--format=%s')).toBe('Notes written on the device');
  expect(git(local, 'status', '--porcelain')).toBe('');
});

it('authors a device commit as the local repository would', async () => {
  const f = await deviceFixture();
  git(f.source, 'config', 'user.name', 'Local Author');
  git(f.source, 'config', 'user.email', 'local-author@example.invalid');
  const session = await f.create(
    script({ write: { path: 'notes.txt', text: 'first\n' } }, { commit: 'First notes' }),
  );
  await f.settle(session);

  expect(git(f.local(session), 'log', '-1', '--format=%an <%ae>')).toBe(
    'Local Author <local-author@example.invalid>',
  );
});

it('carries uncommitted local changes to the device and the device turn back again', async () => {
  const f = await deviceFixture();
  const session = await f.create(
    script({ write: { path: 'notes.txt', text: 'first\n' } }, { commit: 'First notes' }),
  );
  await f.settle(session);
  const local = f.local(session),
    device = f.deviceWork(session);
  writeFileSync(path.join(local, 'answer.txt'), 'changed locally\n');
  writeFileSync(path.join(local, 'draft.txt'), 'untracked locally\n');

  f.send(session.id, script({ write: { path: 'second.txt', text: 'second turn\n' } }));
  await f.settle(session);

  expect(f.turns(session.id).map((turn) => turn.state)).toEqual(['completed', 'completed']);
  for (const directory of [local, device]) {
    expect(read(directory, 'answer.txt')).toBe('changed locally\n');
    expect(read(directory, 'draft.txt')).toBe('untracked locally\n');
    expect(read(directory, 'second.txt')).toBe('second turn\n');
  }
  expect(git(local, 'status', '--porcelain')).toBe(git(device, 'status', '--porcelain'));
});

it('does not bring back a file that was deleted locally between two turns', async () => {
  const f = await deviceFixture();
  const session = await f.create(
    script({ write: { path: 'scratch.txt', text: 'from the device\n' } }),
  );
  await f.settle(session);
  const local = f.local(session);
  expect(read(local, 'scratch.txt')).toBe('from the device\n');
  rmSync(path.join(local, 'scratch.txt'));

  f.send(session.id, script({ say: 'Nothing to change' }));
  await f.settle(session);

  expect(f.turns(session.id).map((turn) => turn.state)).toEqual(['completed', 'completed']);
  expect(existsSync(path.join(f.deviceWork(session), 'scratch.txt'))).toBe(false);
  expect(existsSync(path.join(local, 'scratch.txt'))).toBe(false);
});

it('leaves ignored files where they are on both sides', async () => {
  const f = await deviceFixture();
  const session = await f.create(script({ say: 'Ready' }));
  await f.settle(session);
  const local = f.local(session);
  mkdirSync(path.join(local, 'node_modules'));
  writeFileSync(path.join(local, 'node_modules/kept'), 'local only\n');

  f.send(session.id, script({ write: { path: 'node_modules/x', text: 'device only\n' } }));
  await f.settle(session);

  expect(f.turns(session.id).map((turn) => turn.state)).toEqual(['completed', 'completed']);
  expect(read(f.deviceWork(session), 'node_modules/x')).toBe('device only\n');
  expect(existsSync(path.join(local, 'node_modules/x'))).toBe(false);
  expect(read(local, 'node_modules/kept')).toBe('local only\n');
});

it('lets the device runtime write its worktree, temporary directory, repository objects and own metadata only', async () => {
  const { f, session } = await sharedSessions();
  const local = f.local(session),
    id = session.workspace_id!;

  const spec = remoteSessionSpec(f.ctx, f.current(session.id), {
    cwd: local,
    workspace: { id, path: local },
  } as SessionSpec);

  expect(spec.sandbox!.writable_roots).toEqual([
    f.deviceWork(session),
    path.join(path.dirname(f.deviceRepo), 'tmp', id),
    path.join(f.deviceRepo, 'objects'),
    path.join(f.deviceRepo, 'worktrees', id),
  ]);
  const work = f.deviceWork(session),
    metadata = path.join(f.deviceRepo, 'worktrees', id);
  expect(spec.sandbox!.protected_entries).toEqual([
    ...['.claude', '.codex', '.mcp.json'].map((name) => ({
      path: path.join(work, name),
      deny: 'write',
    })),
    ...['config.worktree', 'commondir', 'gitdir'].map((name) => ({
      path: path.join(metadata, name),
      deny: 'write',
    })),
    { path: path.join(work, '.git'), deny: 'write' },
  ]);
  // Git names the worktree's metadata folder after the worktree directory.
  expect(existsSync(path.join(f.deviceRepo, 'worktrees', id, 'HEAD'))).toBe(true);
});

it('keeps a device task session from reading the other device worktrees and the native session records there', async () => {
  const { f, session, other } = await sharedSessions();
  const local = f.local(session),
    base = { cwd: local, workspace: { id: session.workspace_id!, path: local } } as SessionSpec;
  const unreadable = [
    f.deviceWork(other),
    path.join(f.home, '.claude/projects'),
    path.join(f.home, '.codex/sessions'),
    path.join(f.home, '.codex/archived_sessions'),
    path.join(f.home, '.codex/session_index.jsonl'),
  ].map((target) => ({ path: target, deny: 'read_write' }));

  const task = remoteSessionSpec(
    f.ctx,
    { ...f.current(session.id), task: { lead_session_id: 'lead', id: 'task' } },
    base,
  );
  const direct = remoteSessionSpec(f.ctx, f.current(session.id), base);

  expect(task.sandbox!.protected_entries).toEqual(expect.arrayContaining(unreadable));
  expect(task.sandbox!.protected_entries).not.toContainEqual(
    expect.objectContaining({ path: f.deviceWork(session) }),
  );
  expect(direct.sandbox!.protected_entries.filter((entry) => entry.deny === 'read_write')).toEqual(
    [],
  );
});

it('points the device runtime at the forwarded session tools socket only when there are tools', async () => {
  const { f, session } = await sharedSessions();
  const local = f.local(session);
  const spec = {
    cwd: local,
    workspace: { id: session.workspace_id!, path: local },
    pantheon_mcp: {
      command: process.execPath,
      args: ['cli.js', 'mcp'],
      env: { PANTHEON_SESSION_TOKEN_FILE: '/session-tokens/one' },
      ask_tools: ['task_dispatch'],
    },
  } as unknown as SessionSpec;

  expect(
    remoteSessionSpec(f.ctx, f.current(session.id), spec, '/tmp/pantheon-tools.sock').pantheon_mcp,
  ).toEqual({
    command: 'nc',
    args: ['-U', '/tmp/pantheon-tools.sock'],
    env: {},
    ask_tools: ['task_dispatch'],
  });
  expect(
    remoteSessionSpec(f.ctx, f.current(session.id), spec, undefined).pantheon_mcp,
  ).toBeUndefined();
});

it('lets a device session call a session tool that runs on this machine', async () => {
  const root = mkdtempSync(path.join(process.cwd(), 'node_modules/.cache/pantheon-tools-'));
  const tools = path.join(root, 'tools.mjs'),
    log = path.join(root, 'requests.log');
  // Stands for the CLI's MCP server: logs each request and answers initialize and tools/call.
  writeFileSync(
    tools,
    [
      "import { appendFileSync } from 'node:fs';",
      "import { createInterface } from 'node:readline';",
      "createInterface({ input: process.stdin }).on('line', (line) => {",
      `  appendFileSync(${JSON.stringify(log)}, line + '\\n');`,
      '  const request = JSON.parse(line);',
      '  if (request.id === undefined) return;',
      "  const result = request.method === 'initialize'",
      "    ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'tools', version: '1' } }",
      "    : { content: [{ type: 'text', text: 'Report recorded' }] };",
      "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');",
      '});',
    ].join('\n'),
  );
  const f = await deviceFixture({
    issueSessionCredential: (sessionId) => ({
      token_file: path.join(root, 'session-tokens', sessionId),
      daemon_url: 'http://127.0.0.1:4321',
    }),
    mcpEntry: tools,
  });
  cleanups.push(async () => rmSync(root, { recursive: true, force: true }));
  const session = await f.create(
    script({ tool: { name: 'report', arguments: { summary: 'Done on the device' } } }),
    { purpose: 'lead' },
  );
  await f.settle(session);

  expect(f.turns(session.id).map((turn) => turn.state)).toEqual(['completed']);
  const calls = readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { method: string; params: unknown })
    .filter((request) => request.method === 'tools/call');
  expect(calls.map((request) => request.params)).toEqual([
    { name: 'report', arguments: { summary: 'Done on the device' } },
  ]);
  expect(
    f.store
      .events(0, undefined, Number.MAX_SAFE_INTEGER)
      .some(
        (event) =>
          event.kind === 'agent.tool.completed' &&
          (event.payload as { output?: unknown }).output === 'Report recorded',
      ),
  ).toBe(true);
});

it('refuses a session on an offline device or with a backend', async () => {
  const f = await deviceFixture();
  expect(() => f.create('Fix it', { backend: 'proxy' })).toThrow(
    expect.objectContaining({ code: 'invalid_input' }),
  );
  f.probed({ online: false, error: 'ssh: connect to host build-box' });
  expect(() => f.create('Fix it')).toThrow(
    expect.objectContaining({
      code: 'invalid_input',
      message: expect.stringContaining('offline'),
    }),
  );
});

it('fails the turn and keeps the pull pending when the device changes cannot be brought back', async () => {
  const f = await deviceFixture();
  const session = await f.create(
    script({ write: { path: 'notes.txt', text: 'stranded\n' } }, hold),
  );
  await eventually(
    () => existsSync(path.join(f.deviceWork(session), 'notes.txt')),
    () => f.control.tick(),
    10000,
  );
  renameSync(f.deviceRepo, `${f.deviceRepo}-moved`);
  await release(f, session);
  await f.settle(session);

  const [turn] = f.turns(session.id);
  expect(turn!.state).toBe('failed');
  const failed = f.store
    .events(0, undefined, Number.MAX_SAFE_INTEGER)
    .find((event) => event.kind === 'turn.failed' && event.aggregate_id === turn!.id);
  expect((failed?.payload as { error?: string }).error).toMatch(/^Remote workspace sync failed/);
  expect(f.current(session.id).remote_pull_pending).toBe(true);
});

it('deletes the device worktree, temporary files and sync refs when the session is discarded', async () => {
  const f = await deviceFixture();
  const session = await f.create(script({ write: { path: 'notes.txt', text: 'thrown away\n' } }));
  await f.settle(session);
  const device = f.deviceWork(session),
    tmp = device.replace('/w/', '/tmp/');
  expect(existsSync(device) && existsSync(tmp)).toBe(true);
  expect(git(f.source, 'for-each-ref', 'refs/pantheon/sync/')).not.toBe('');

  f.control.execute(
    user,
    command(user.id, 'session.discard', { session_id: session.id }, f.current(session.id).revision),
  );
  // The device deletes the worktree before the sync refs, in one script.
  await eventually(
    () => !existsSync(device) && git(f.deviceRepo, 'for-each-ref', 'refs/pantheon/sync/') === '',
    () => f.control.tick(),
    10000,
  );

  expect(existsSync(tmp) || existsSync(`${tmp}.index`)).toBe(false);
  expect(git(f.deviceRepo, 'for-each-ref', 'refs/pantheon/sync/')).toBe('');
  expect(git(f.deviceRepo, 'worktree', 'list', '--porcelain')).not.toContain(device);
  expect(git(f.source, 'for-each-ref', 'refs/pantheon/sync/')).toBe('');
});

it('deletes the sync refs on this machine with one git run', async () => {
  const f = await deviceFixture();
  const session = await f.create(script({ write: { path: 'notes.txt', text: 'thrown away\n' } }));
  await f.settle(session);
  // Logs each update-ref run on one line: its arguments, then what it read from stdin.
  const shims = path.join(path.dirname(f.deviceRepo), 'ref-shims'),
    log = path.join(shims, 'update-ref.log'),
    before = process.env.PATH!;
  mkdirSync(shims);
  writeFileSync(log, '');
  writeFileSync(
    path.join(shims, 'git'),
    [
      '#!/bin/sh',
      'case " $* " in',
      `  *" update-ref --stdin "*) input=$(mktemp); cat > "$input"; printf '%s | %s\\n' "$*" "$(tr '\\n' ' ' < "$input")" >> '${log}'; PATH='${before}' exec git "$@" < "$input" ;;`,
      `  *" update-ref "*) printf '%s\\n' "$*" >> '${log}' ;;`,
      'esac',
      `PATH='${before}' exec git "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(path.join(shims, 'git'), 0o755);
  process.env.PATH = `${shims}:${before}`;
  cleanups.unshift(async () => {
    process.env.PATH = before;
  });

  f.control.execute(
    user,
    command(user.id, 'session.discard', { session_id: session.id }, f.current(session.id).revision),
  );
  await eventually(
    () => git(f.deviceRepo, 'for-each-ref', 'refs/pantheon/sync/') === '',
    () => f.control.tick(),
    10000,
  );

  // The device's run names its repository with -C.
  const local = readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.includes('refs/pantheon/sync/') && !line.includes(' -C '));
  expect(local).toEqual([
    expect.stringMatching(/ update-ref --stdin \| delete refs\/pantheon\/sync\//),
  ]);
  expect(local[0]!.match(/delete /g)).toHaveLength(7);
  expect(git(f.source, 'for-each-ref', 'refs/pantheon/sync/')).toBe('');
});

it('deletes the sync refs on this machine without holding up the daemon', async () => {
  const f = await deviceFixture();
  const session = await f.create(script({ write: { path: 'notes.txt', text: 'thrown away\n' } }));
  await f.settle(session);
  const counter = countingGit();
  cleanups.unshift(async () => counter.restore());
  counter.slowOn('update-ref --stdin');
  // The longest the event loop went without running a 20 ms timer.
  let last = Date.now(),
    stall = 0;
  const beat = setInterval(() => {
    stall = Math.max(stall, Date.now() - last);
    last = Date.now();
  }, 20);
  cleanups.unshift(async () => clearInterval(beat));

  f.control.execute(
    user,
    command(user.id, 'session.discard', { session_id: session.id }, f.current(session.id).revision),
  );
  await eventually(
    () => git(f.source, 'for-each-ref', 'refs/pantheon/sync/') === '',
    () => f.control.tick(),
    10000,
  );
  expect(stall).toBeLessThan(500);
});

it('deletes the device worktree, temporary files and sync refs when an idle session is deleted', async () => {
  const f = await deviceFixture();
  const session = await f.create(script({ write: { path: 'notes.txt', text: 'thrown away\n' } }));
  await f.settle(session);
  const device = f.deviceWork(session),
    tmp = device.replace('/w/', '/tmp/');

  f.control.execute(
    user,
    command(user.id, 'session.delete', { session_id: session.id }, f.current(session.id).revision),
  );
  await eventually(
    () => !existsSync(device) && git(f.deviceRepo, 'for-each-ref', 'refs/pantheon/sync/') === '',
    () => f.control.tick(),
    10000,
  );

  expect(existsSync(tmp) || existsSync(`${tmp}.index`)).toBe(false);
  expect(git(f.source, 'for-each-ref', 'refs/pantheon/sync/')).toBe('');
});

it('keeps what each side staged where the sync changed nothing', async () => {
  const f = await deviceFixture();
  const session = await f.create(script({ say: 'Ready' }));
  await f.settle(session);
  const local = f.local(session),
    device = f.deviceWork(session);
  writeFileSync(path.join(local, 'draft.txt'), 'staged locally\n');
  git(local, 'add', 'draft.txt');
  writeFileSync(path.join(local, 'draft.txt'), 'saved after staging\n');
  writeFileSync(path.join(device, 'device.txt'), 'staged on the device\n');
  git(device, 'add', 'device.txt');

  f.send(session.id, script({ write: { path: 'notes.txt', text: 'device\n' } }));
  await f.settle(session);

  expect(f.turns(session.id).map((turn) => turn.state)).toEqual(['completed', 'completed']);
  expect(git(local, 'diff', '--cached', '--name-only')).toBe('draft.txt');
  expect(git(local, 'show', ':draft.txt')).toBe('staged locally');
  expect(git(device, 'diff', '--cached', '--name-only')).toBe('device.txt');
  for (const directory of [local, device]) {
    expect(read(directory, 'draft.txt')).toBe('saved after staging\n');
    expect(read(directory, 'notes.txt')).toBe('device\n');
  }
});

const failure = (f: Awaited<ReturnType<typeof deviceFixture>>, turn: SessionTurn) =>
  (
    f.store
      .events(0, undefined, Number.MAX_SAFE_INTEGER)
      .find((event) => event.kind === 'turn.failed' && event.aggregate_id === turn.id)?.payload as {
      error?: string;
    }
  )?.error;

it('keeps a device file whose pull failed when the next turn starts', async () => {
  const f = await deviceFixture();
  const session = await f.create(
    script({ write: { path: 'notes.txt', text: 'stranded\n' } }, hold),
  );
  await eventually(
    () => existsSync(path.join(f.deviceWork(session), 'notes.txt')),
    () => f.control.tick(),
    10000,
  );
  renameSync(f.deviceRepo, `${f.deviceRepo}-moved`);
  await release(f, session);
  await f.settle(session);
  renameSync(`${f.deviceRepo}-moved`, f.deviceRepo);

  f.send(session.id, script({ say: 'Nothing to change' }));
  await f.settle(session);

  expect(f.turns(session.id).map((turn) => turn.state)).toEqual(['failed', 'completed']);
  for (const directory of [f.local(session), f.deviceWork(session)])
    expect(read(directory, 'notes.txt')).toBe('stranded\n');
  expect(f.current(session.id).remote_pull_pending).toBeUndefined();
});

it('keeps a file that appeared on the device after the last turn ended', async () => {
  const f = await deviceFixture();
  const session = await f.create(script({ say: 'Ready' }));
  await f.settle(session);
  writeFileSync(path.join(f.deviceWork(session), 'late.txt'), 'written after the turn\n');

  f.send(session.id, script({ say: 'Nothing to change' }));
  await f.settle(session);

  expect(f.turns(session.id).map((turn) => turn.state)).toEqual(['completed', 'completed']);
  for (const directory of [f.local(session), f.deviceWork(session)])
    expect(read(directory, 'late.txt')).toBe('written after the turn\n');
});

/** Starts a second turn that runs `steps` on the device once `release` answers it, and waits until it runs. */
async function slowSecondTurn(f: Awaited<ReturnType<typeof deviceFixture>>, ...steps: unknown[]) {
  const session = await f.create(script({ say: 'Ready' }));
  await f.settle(session);
  f.send(session.id, script(hold, ...steps));
  await eventually(
    () => f.turns(session.id)[1]?.state === 'running',
    () => f.control.tick(),
    10000,
  );
  return session;
}

it('keeps the changes made on this machine while the device turn runs', async () => {
  const f = await deviceFixture();
  const session = await slowSecondTurn(f, { write: { path: 'notes.txt', text: 'device\n' } });
  const local = f.local(session);
  writeFileSync(path.join(local, 'answer.txt'), 'changed locally\n');
  writeFileSync(path.join(local, 'draft.txt'), 'untracked locally\n');
  await release(f, session);
  await f.settle(session);

  expect(f.turns(session.id).map((turn) => turn.state)).toEqual(['completed', 'completed']);
  expect(read(local, 'answer.txt')).toBe('changed locally\n');
  expect(read(local, 'draft.txt')).toBe('untracked locally\n');
  expect(read(local, 'notes.txt')).toBe('device\n');
});

it('fails the turn, marks the file and keeps the local version when both sides changed it', async () => {
  const f = await deviceFixture();
  const session = await slowSecondTurn(f, { write: { path: 'answer.txt', text: 'device\n' } });
  const local = f.local(session);
  writeFileSync(path.join(local, 'answer.txt'), 'local\n');
  await release(f, session);
  await f.settle(session);

  const turns = f.turns(session.id);
  expect(turns.map((turn) => turn.state)).toEqual(['completed', 'failed']);
  expect(failure(f, turns[1]!)).toContain('answer.txt');
  expect(read(local, 'answer.txt')).toMatch(/^<<<<<<<[^]*local\n[^]*device\n[^]*>>>>>>>/);
  expect(
    git(local, 'show', `refs/pantheon/sync/${session.workspace_id!}/local:answer.txt`),
  ).toContain('local');

  // The marked file is what the next turn starts from on both sides.
  f.send(session.id, script({ say: 'Look at the conflict' }));
  await f.settle(session);
  expect(f.turns(session.id).at(-1)!.state).toBe('completed');
  expect(read(f.deviceWork(session), 'answer.txt')).toBe(read(local, 'answer.txt'));
});

it('leaves a file only this machine ignores as it is when the device writes the same path', async () => {
  const f = await deviceFixture();
  mkdirSync(path.join(f.source, '.git/info'), { recursive: true });
  writeFileSync(path.join(f.source, '.git/info/exclude'), 'secret.txt\n');
  const session = await f.create(script({ say: 'Ready' }));
  await f.settle(session);
  const local = f.local(session);
  writeFileSync(path.join(local, 'secret.txt'), 'local only\n');

  f.send(session.id, script({ write: { path: 'secret.txt', text: 'device only\n' } }));
  await f.settle(session);

  expect(f.turns(session.id).map((turn) => turn.state)).toEqual(['completed', 'completed']);
  expect(read(local, 'secret.txt')).toBe('local only\n');
  expect(read(f.deviceWork(session), 'secret.txt')).toBe('device only\n');
});

it('keeps the project variables of a device session and gives it the temporary directory of the device', async () => {
  const { f, session } = await sharedSessions();
  const local = f.local(session),
    id = session.workspace_id!;

  const spec = remoteSessionSpec(f.ctx, f.current(session.id), {
    cwd: local,
    workspace: { id, path: local },
    env: { API_BASE: 'https://api.example.invalid', TMPDIR: '/local/tmp' },
  } as unknown as SessionSpec);

  expect(spec.env).toEqual({
    API_BASE: 'https://api.example.invalid',
    TMPDIR: path.join(path.dirname(f.deviceRepo), 'tmp', id),
  });
});

it('passes only the allowlisted variables to a device session the user opened', async () => {
  const { f, session } = await sharedSessions();
  const local = f.local(session);
  const spec = remoteSessionSpec(f.ctx, f.current(session.id), {
    cwd: local,
    workspace: { id: session.workspace_id!, path: local },
    user_session: true,
    env_allowlist: [...NATIVE_ENV_ALLOWLIST, 'PLAIN_DAEMON_VARIABLE'],
  } as unknown as SessionSpec);
  expect(spec.env_allowlist).toEqual(NATIVE_ENV_ALLOWLIST);
});

it('copies the attachments of a device turn to the device and names the copies there', async () => {
  const f = await deviceFixture();
  const session = await f.create(script({ say: 'Ready' }));
  await f.settle(session);
  const sent: UserTurn[] = [];
  const send = f.adapter.send.bind(f.adapter);
  f.adapter.send = (handle, turn) => {
    sent.push(turn);
    return send(handle, turn);
  };
  const upload = f.control.addAttachment(
    user,
    f.project.id,
    'notes.md',
    'text/markdown',
    Buffer.from('attached\n'),
  );

  f.call(
    'session.send',
    { session_id: session.id, input: script({ say: 'Read' }), attachments: [upload.id] },
    f.current(session.id).revision,
  );
  await f.settle(session);

  expect(f.turns(session.id).map((turn) => turn.state)).toEqual(['completed', 'completed']);
  const [attachment] = sent.at(-1)!.attachments!;
  const deviceTmp = path.join(path.dirname(f.deviceRepo), 'tmp', session.workspace_id!);
  expect(path.dirname(attachment!.path)).toBe(path.join(deviceTmp, 'attachments'));
  expect(readFileSync(attachment!.path, 'utf8')).toBe('attached\n');
  expect(attachment!.source).not.toBe(attachment!.path);
  expect(readFileSync(attachment!.source!, 'utf8')).toBe('attached\n');
});

it('keeps the commits of this machine and the files of the device when both committed during a turn', async () => {
  const f = await deviceFixture();
  const session = await slowSecondTurn(
    f,
    { write: { path: 'notes.txt', text: 'device\n' } },
    { commit: 'Notes from the device' },
  );
  const local = f.local(session);
  writeFileSync(path.join(local, 'draft.txt'), 'local\n');
  git(local, 'add', 'draft.txt');
  git(local, 'commit', '--quiet', '-m', 'Draft from this machine');
  await release(f, session);
  await f.settle(session);

  const turns = f.turns(session.id);
  expect(turns.map((turn) => turn.state)).toEqual(['completed', 'failed']);
  expect(failure(f, turns[1]!)).toContain('both committed');
  expect(git(local, 'log', '-1', '--format=%s')).toBe('Draft from this machine');
  expect(read(local, 'notes.txt')).toBe('device\n');
  expect(git(local, 'status', '--porcelain')).toBe('?? notes.txt');
});

it('finishes bringing the device changes back before shutdown returns', async () => {
  // Every device command takes a moment, as over a network.
  const slow = ['/bin/sh', '-c', 'sleep 0.4; eval "$1"', 'sh'];
  const f = await deviceFixture({
    deviceLink: () => ({
      transport: slow,
      gitUrl: (target) => target,
      withSocket: (localSocket) => ({ transport: slow, socket: localSocket }),
    }),
  });
  const session = await f.create(
    script({ write: { path: 'notes.txt', text: 'written on the device\n' } }, { wait: 60000 }),
  );
  // The file exists empty before its text is in; a stop between the two abandons the write.
  await eventually(
    () =>
      existsSync(path.join(f.deviceWork(session), 'notes.txt')) &&
      read(f.deviceWork(session), 'notes.txt') === 'written on the device\n',
    () => f.control.tick(),
    10000,
  );

  await f.control.shutdown();

  expect(read(f.local(session), 'notes.txt')).toBe('written on the device\n');
});

it('lands the local files again on a device that lost its worktree', async () => {
  const f = await deviceFixture();
  const session = await f.create(script({ write: { path: 'notes.txt', text: 'not committed\n' } }));
  await f.settle(session);
  const device = f.deviceWork(session);
  // An idle process that is past its limit closes; the next turn starts a new one, which prepares the device again.
  f.ctx.idleConversations.set(session.id, 0);
  await eventually(
    () => f.ctx.handles.size === 0,
    () => f.control.tick(),
    10000,
  );
  rmSync(device, { recursive: true });

  f.send(session.id, script({ say: 'Nothing to change' }));
  await f.settle(session);

  expect(f.turns(session.id).at(-1)!.state).toBe('completed');
  for (const directory of [f.local(session), device])
    expect(read(directory, 'notes.txt')).toBe('not committed\n');
});

it('applies an ignore rule of this machine that is newer than the last push to the device', async () => {
  const f = await deviceFixture();
  const session = await f.create(script({ say: 'Ready' }));
  await f.settle(session);
  const local = f.local(session),
    device = f.deviceWork(session);
  writeFileSync(path.join(device, 'secret.txt'), 'device only\n');
  mkdirSync(path.join(f.source, '.git/info'), { recursive: true });
  writeFileSync(path.join(f.source, '.git/info/exclude'), 'secret.txt\n');
  writeFileSync(path.join(local, 'secret.txt'), 'local only\n');

  f.send(session.id, script({ say: 'Nothing to change' }));
  await f.settle(session);

  expect(f.turns(session.id).map((turn) => turn.state)).toEqual(['completed', 'completed']);
  expect(read(local, 'secret.txt')).toBe('local only\n');
  expect(read(device, 'secret.txt')).toBe('device only\n');
});

it('keeps a file a rule of the repository takes back out of the global ignore rules', async () => {
  const f = await deviceFixture();
  const config = path.join(path.dirname(f.deviceRepo), 'global-gitconfig'),
    before = process.env.GIT_CONFIG_GLOBAL;
  mkdirSync(path.dirname(config), { recursive: true });
  writeFileSync(`${config}-ignore`, '*.log\n');
  writeFileSync(config, `[core]\n\texcludesFile = ${config}-ignore\n`);
  process.env.GIT_CONFIG_GLOBAL = config;
  cleanups.unshift(async () => {
    if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = before;
  });
  mkdirSync(path.join(f.source, '.git/info'), { recursive: true });
  writeFileSync(path.join(f.source, '.git/info/exclude'), '!notes.log\n');
  const session = await f.create(script({ say: 'Ready' }));
  await f.settle(session);
  const local = f.local(session);
  writeFileSync(path.join(local, 'notes.log'), 'kept\n');

  f.send(session.id, script({ say: 'Nothing to change' }));
  await f.settle(session);

  expect(f.turns(session.id).map((turn) => turn.state)).toEqual(['completed', 'completed']);
  for (const directory of [local, f.deviceWork(session)])
    expect(read(directory, 'notes.log')).toBe('kept\n');
});

it('replaces a link the device runtime planted where an attachment copy goes', async () => {
  const f = await deviceFixture();
  const session = await f.create(script({ say: 'Ready' }));
  await f.settle(session);
  const sent: UserTurn[] = [];
  const send = f.adapter.send.bind(f.adapter);
  f.adapter.send = (handle, turn) => {
    sent.push(turn);
    return send(handle, turn);
  };
  const upload = f.control.addAttachment(
    user,
    f.project.id,
    'notes.md',
    'text/markdown',
    Buffer.from('attached\n'),
  );
  const attach = async () => {
    f.call(
      'session.send',
      { session_id: session.id, input: script({ say: 'Read' }), attachments: [upload.id] },
      f.current(session.id).revision,
    );
    await f.settle(session);
  };
  await attach();
  const copy = sent.at(-1)!.attachments![0]!.path,
    outside = path.join(path.dirname(f.deviceRepo), 'outside.txt');
  writeFileSync(outside, 'outside the sandbox\n');
  rmSync(copy);
  symlinkSync(outside, copy);

  await attach();

  expect(f.turns(session.id).at(-1)!.state).toBe('completed');
  expect(readFileSync(outside, 'utf8')).toBe('outside the sandbox\n');
  expect(lstatSync(copy).isSymbolicLink()).toBe(false);
  expect(readFileSync(copy, 'utf8')).toBe('attached\n');
});

/** Runs `line` in a shell each time the merge of both file sets starts, after the local snapshot was taken. */
function duringMerge(f: Awaited<ReturnType<typeof deviceFixture>>, line: string) {
  beforeGit(f, ' merge-tree ', line);
}

/** Runs `line` in a shell before each git command whose arguments contain `call`. */
function beforeGit(f: Awaited<ReturnType<typeof deviceFixture>>, call: string, line: string) {
  const shims = path.join(path.dirname(f.deviceRepo), 'shims'),
    before = process.env.PATH!;
  mkdirSync(shims, { recursive: true });
  writeFileSync(
    path.join(shims, 'git'),
    `#!/bin/sh\ncase " $* " in *"${call}"*) ${line} ;; esac\nPATH='${before}' exec git "$@"\n`,
  );
  chmodSync(path.join(shims, 'git'), 0o755);
  process.env.PATH = `${shims}:${before}`;
  cleanups.unshift(async () => {
    process.env.PATH = before;
  });
}

it('keeps a file saved on this machine while the device changes are being brought back', async () => {
  const f = await deviceFixture();
  const session = await slowSecondTurn(f, { write: { path: 'notes.txt', text: 'device\n' } });
  const local = f.local(session);
  writeFileSync(path.join(local, 'mine.txt'), 'local\n');
  duringMerge(f, `printf 'saved late\\n' > '${path.join(local, 'late.txt')}'`);
  await release(f, session);
  await f.settle(session);

  expect(f.turns(session.id).map((turn) => turn.state)).toEqual(['completed', 'completed']);
  expect(read(local, 'late.txt')).toBe('saved late\n');
  expect(read(local, 'notes.txt')).toBe('device\n');
  expect(read(local, 'mine.txt')).toBe('local\n');
});

it('fails the turn instead of writing over a file saved while the device changes are being brought back', async () => {
  const f = await deviceFixture();
  const session = await slowSecondTurn(f, { write: { path: 'notes.txt', text: 'device\n' } });
  const local = f.local(session);
  writeFileSync(path.join(local, 'mine.txt'), 'local\n');
  duringMerge(f, `printf 'saved late\\n' > '${path.join(local, 'notes.txt')}'`);
  await release(f, session);
  await f.settle(session);

  const turns = f.turns(session.id);
  expect(turns.map((turn) => turn.state)).toEqual(['completed', 'failed']);
  expect(failure(f, turns[1]!)).toContain('notes.txt');
  expect(read(local, 'notes.txt')).toBe('saved late\n');
  expect(read(local, 'mine.txt')).toBe('local\n');
  expect(git(local, 'diff', '--cached', '--name-only')).toBe('');
});

it('names a transport without the session tools forward beside the one that carries it', async () => {
  const f = await deviceFixture();
  const session = await f.create(script({ say: 'Ready' }));
  await f.settle(session);
  const local = f.local(session);
  (f.ctx as { deviceLink: ControlContext['deviceLink'] }).deviceLink = () => ({
    transport: ['/bin/sh', '-c'],
    gitUrl: (target: string) => target,
    withSocket: (localSocket: string) => ({
      transport: ['forwarding', localSocket],
      socket: localSocket,
    }),
  });

  const { remote } = remoteSessionSpec(
    f.ctx,
    f.current(session.id),
    { cwd: local, workspace: { id: session.workspace_id!, path: local } } as SessionSpec,
    '/tmp/pantheon-tools.sock',
  );

  expect(remote!.transport).toEqual(['forwarding', '/tmp/pantheon-tools.sock']);
  expect(remote!.plain_transport).toEqual(['/bin/sh', '-c']);
});

it('publishes running and done pull states to event subscribers and session reads', async () => {
  const f = await deviceFixture();
  const session = await f.create(script({ say: 'Ready' }));
  await f.settle(session);
  const seen: unknown[] = [];
  f.control.on('events', () => {
    seen.push(
      f.control.sessionList(user, f.project.id).find((item) => item.id === session.id)!.remote_pull,
    );
  });
  const pulling = pullRemoteWorkspace(f.ctx, session.id);
  expect(f.current(session.id).remote_pull).toMatchObject({
    status: 'running',
    changed_at: expect.any(String),
  });
  await pulling;
  expect(seen).toEqual([
    expect.objectContaining({ status: 'running' }),
    expect.objectContaining({ status: 'done' }),
  ]);
  const events = f.store.kindEvents(f.project.id, ['session.remote_pull_changed']);
  expect(events.slice(-2).map((event) => event.payload)).toEqual(seen);
});

it('retries a failed pull, reports its reason and brings the stranded result back', async () => {
  const f = await deviceFixture();
  const session = await f.create(
    script({ write: { path: 'notes.txt', text: 'stranded\n' } }, hold),
  );
  await eventually(
    () => existsSync(path.join(f.deviceWork(session), 'notes.txt')),
    () => f.control.tick(),
    10000,
  );
  renameSync(f.deviceRepo, `${f.deviceRepo}-moved`);
  await release(f, session);
  await f.settle(session);
  const failed = f.current(session.id).remote_pull as {
    status: 'failed';
    reason: string;
    changed_at: string;
  };
  expect(failed).toMatchObject({
    status: 'failed',
    reason: expect.any(String),
    changed_at: expect.any(String),
  });
  await expect(f.call('session.reconnect', { session_id: session.id })).rejects.toMatchObject({
    code: 'remote_pull_failed',
    message: failed.reason,
  });
  expect(
    f.control.sessionList(user, f.project.id).find((item) => item.id === session.id)!.remote_pull,
  ).toMatchObject({ status: 'failed', reason: failed.reason });
  renameSync(`${f.deviceRepo}-moved`, f.deviceRepo);
  await expect(f.call('session.reconnect', { session_id: session.id })).resolves.toEqual({
    session_id: session.id,
    succeeded: true,
  });
  expect(read(f.local(session), 'notes.txt')).toBe('stranded\n');
  expect(f.current(session.id).remote_pull).toMatchObject({ status: 'done' });
  expect(() => f.call('session.reconnect', { session_id: session.id })).toThrow('has not failed');
});

it('refuses reconnect for a local session and lists its pull as not needed', async () => {
  const f = await deviceFixture();
  const session = await f.create(script({ say: 'Local' }), { device_id: 'local' });
  await f.settle(session);
  expect(
    f.control.sessionList(user, f.project.id).find((item) => item.id === session.id)!.remote_pull,
  ).toMatchObject({ status: 'not_needed', changed_at: expect.any(String) });
  expect(() => f.call('session.reconnect', { session_id: session.id })).toThrow('not remote');
});

it('lists a direct device session with its identity and opening time until it ends', async () => {
  const f = await deviceFixture();
  f.probed({ resources: { gpu: 1, 'test-db': 2 } });
  const session = await f.create(script({ say: 'Ready' }));
  await f.settle(session);
  const listed = (await f.control.listDevices(user)).find((device) => device.id === 'build-box')!;
  const opened = f.store
    .kindEvents(f.project.id, ['session.opened'])
    .find((event) => event.aggregate_id === session.id)!;
  expect(listed.load.active_sessions).toEqual([
    {
      id: session.id,
      title: f.current(session.id).title ?? '',
      runtime: f.adapter.name,
      started_at: new Date(opened.created_at).toISOString(),
    },
  ]);
  expect(listed.load).not.toHaveProperty('resource_sessions');
  f.call('session.discard', { session_id: session.id }, f.current(session.id).revision);
  // The discard ends the session after the device has deleted its worktree.
  await eventually(() => f.current(session.id).state === 'closed');
  expect(
    (await f.control.listDevices(user)).find((device) => device.id === 'build-box')!.load
      .active_sessions,
  ).toEqual([]);
});

it('runs the sync git commands on the device without the hooks and file monitor its repository names', async () => {
  const f = await deviceFixture();
  const session = await f.create(script({ say: 'Ready' }));
  await f.settle(session);
  const marker = path.join(path.dirname(f.deviceRepo), 'ran.log'),
    monitor = path.join(path.dirname(f.deviceRepo), 'monitor.sh'),
    hook = path.join(f.deviceRepo, 'hooks/reference-transaction');
  writeFileSync(monitor, `#!/bin/sh\necho fsmonitor >> '${marker}'\n`);
  writeFileSync(hook, `#!/bin/sh\ncat >/dev/null\necho reference-transaction >> '${marker}'\n`);
  for (const file of [monitor, hook]) chmodSync(file, 0o755);
  git(f.deviceRepo, 'config', 'core.fsmonitor', monitor);

  f.send(session.id, script({ write: { path: 'notes.txt', text: 'device\n' } }));
  await f.settle(session);

  expect(f.turns(session.id).map((turn) => turn.state)).toEqual(['completed', 'completed']);
  expect(read(f.local(session), 'notes.txt')).toBe('device\n');
  expect(existsSync(marker) ? read(marker, '') : '').toBe('');
});

it('keeps a commit made on this machine while the device commit is being brought back', async () => {
  const f = await deviceFixture();
  const session = await slowSecondTurn(
    f,
    { write: { path: 'notes.txt', text: 'device\n' } },
    { commit: 'Notes from the device' },
  );
  const local = f.local(session);
  beforeGit(
    f,
    ' update-ref --no-deref HEAD ',
    `c=$(git -C '${local}' commit-tree 'HEAD^{tree}' -p HEAD -m 'Commit on this machine') && git -C '${local}' update-ref HEAD "$c"`,
  );
  await release(f, session);
  await f.settle(session);

  const turns = f.turns(session.id);
  expect(turns.map((turn) => turn.state)).toEqual(['completed', 'failed']);
  expect(failure(f, turns[1]!)).toContain('both committed');
  expect(git(local, 'log', '-1', '--format=%s')).toBe('Commit on this machine');
  expect(read(local, 'notes.txt')).toBe('device\n');
});

it('gives up a device command that does not finish', async () => {
  const f = await deviceFixture();
  const session = await f.create(script({ say: 'Ready' }));
  await f.settle(session);
  const started = path.join(path.dirname(f.deviceRepo), 'hung');
  const hung = ['/bin/sh', '-c', `touch '${started}'; exec sleep 30`, 'sh'];
  (f.ctx as { deviceLink: ControlContext['deviceLink'] }).deviceLink = () => ({
    transport: hung,
    gitUrl: (target: string) => target,
    withSocket: (localSocket: string) => ({ transport: hung, socket: localSocket }),
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  cleanups.unshift(async () => {
    vi.useRealTimers();
  });

  let outcome: string | undefined;
  pullRemoteWorkspace(f.ctx, session.id).then(
    () => (outcome = 'done'),
    (error: Error) => (outcome = error.message),
  );
  await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: 10000 });
  vi.runOnlyPendingTimers();

  await vi.waitFor(() => expect(outcome).toMatch(/did not finish/), { timeout: 5000 });
  expect(f.current(session.id).remote_pull).toMatchObject({ status: 'failed' });
});

it('prepares two device sessions of one project one after the other on a device without its repository', async () => {
  const f = await deviceFixture();
  f.probed({ max_sessions: 2 });
  const sessions = [await f.create(script({ say: 'Ready' }))];
  await f.settle(sessions[0]!);
  sessions.push(await f.create(script({ say: 'Ready' })));
  await f.settle(sessions[1]!);
  // Each device command holds a lock while it runs and notes when another one already held it.
  const commands = path.join(f.home, 'commands');
  const locking = [
    '/bin/sh',
    '-c',
    'mkdir "$0.lock" 2>/dev/null && held=1 || echo overlap >> "$0.log"; sleep 0.2; eval "$1"; status=$?; [ -z "$held" ] || rmdir "$0.lock"; exit $status',
    commands,
  ];
  (f.ctx as { deviceLink: ControlContext['deviceLink'] }).deviceLink = () => ({
    transport: locking,
    gitUrl: (target: string) => target,
    withSocket: (localSocket: string) => ({ transport: locking, socket: localSocket }),
  });

  for (let trial = 0; trial < 2; trial++) {
    rmSync(path.dirname(f.deviceRepo), { recursive: true, force: true });
    await Promise.all(
      sessions.map((session) => prepareRemoteWorkspace(f.ctx, f.current(session.id))),
    );
    for (const session of sessions) expect(existsSync(f.deviceWork(session))).toBe(true);
  }
  expect(existsSync(`${commands}.log`)).toBe(false);
});
