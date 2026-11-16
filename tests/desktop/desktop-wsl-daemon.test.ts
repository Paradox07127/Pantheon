import { afterEach, expect, it, vi } from 'vitest';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { command, PROTOCOL_VERSION } from '@pantheon/protocol';
import {
  DaemonBridge,
  INSTALL_RUNTIME_SCRIPT,
  MANIFEST_SEPARATOR,
  MANIFEST_START,
  READ_MANIFEST_SCRIPT,
  parseManifestOutput,
} from '../../apps/desktop/src/main/daemon.js';
import { wslUnavailable, type RunWsl } from '../../apps/desktop/src/main/wsl.js';

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.mocked(spawn).mockReset();
});
function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-wsl-daemon-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const archive = 'C:\\Program Files\\Pantheon\\resources\\linux-runtime.tar.gz';
const desktopDataDir = 'C:\\Users\\ada\\AppData\\Roaming\\Pantheon Desktop';
const runtime = '/home/ada/.local/share/pantheon/runtime/0.2.0';
const data = '/home/ada/.local/share/pantheon/data';
const daemonLine = `${runtime}/node/bin/node ${runtime}/daemon/dist/main.js --data-dir ${data}`;
const token = 'secret-token';

/** A daemon stand-in on loopback, which a Windows app reaches the same way as one in WSL. */
async function server() {
  const http = createServer((request, response) => {
    if (request.url === '/health')
      return response.end(JSON.stringify({ version: '0.2.0', protocol_version: PROTOCOL_VERSION }));
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.statusCode = 401;
      return response.end(JSON.stringify({ error: 'unauthorized' }));
    }
    if (request.url?.startsWith('/v1/board'))
      return response.end(JSON.stringify({ sessions: [], projects: [], workspaces: [] }));
    response.end('{}');
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => http.close(() => resolve())));
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}

/** Answers the bridge's wsl.exe calls as a distro whose daemon runs while `state.pid` is set. */
async function distro(state: { pid: number | undefined; next: number }) {
  const url = await server();
  const run = vi.fn<RunWsl>(async (_file, args, input) => {
    const command = args.slice(args.indexOf('--exec') + 1);
    if (input === INSTALL_RUNTIME_SCRIPT)
      return Buffer.from(`Welcome to Ubuntu\n${runtime}\n${data}\n`);
    if (input === READ_MANIFEST_SCRIPT) {
      if (state.pid === undefined) throw new Error('cat: daemon.json: No such file or directory');
      const manifest = { pid: state.pid, url, token_file: `${data}/user.token` };
      return Buffer.from(
        `${MANIFEST_START}\n${JSON.stringify(manifest, null, 2)}\n\n${MANIFEST_SEPARATOR}\n${token}\n`,
      );
    }
    if (command[0] === 'ps' && Number(command.at(-1)) === state.pid)
      return Buffer.from(`${daemonLine}\n`);
    if (command[0] === 'kill' && Number(command.at(-1)) === state.pid) {
      if (command[1] === '-TERM') state.pid = undefined;
      return Buffer.from('');
    }
    throw new Error(`exit status 1: ${command.join(' ')}`);
  });
  vi.mocked(spawn).mockImplementation((() => {
    const child = Object.assign(new EventEmitter(), { pid: 70000, unref: vi.fn() });
    setImmediate(() => {
      child.emit('spawn');
      state.pid = state.next++;
    });
    return child;
  }) as unknown as typeof spawn);
  const root = tempRoot();
  const logFile = path.join(root, 'logs/daemon.log');
  const bridge = new DaemonBridge({
    directory: path.join(root, 'state'),
    packaged: true,
    repo: root,
    logFile,
    wsl: {
      distro: 'Ubuntu',
      runtimeArchive: archive,
      runtimeVersion: '0.2.0',
      desktopDataDir,
      run,
    },
  });
  return { bridge, run, url, logFile };
}

it('installs the runtime from the Windows archive, then starts the daemon in a wsl.exe that outlives the app', async () => {
  const { bridge, run, url } = await distro({ pid: undefined, next: 4242 });
  expect(await bridge.daemon()).toEqual({
    ok: true,
    value: {
      url,
      version: '0.2.0',
      protocol_version: PROTOCOL_VERSION,
      started_here: true,
      data_dir: data,
    },
  });
  expect(run.mock.calls[0]).toEqual([
    'wsl.exe',
    ['-d', 'Ubuntu', '--exec', 'bash', '-l', '-s', '--', archive, '0.2.0'],
    INSTALL_RUNTIME_SCRIPT,
  ]);
  expect(run.mock.calls.filter((call) => call[2] === INSTALL_RUNTIME_SCRIPT)).toHaveLength(1);
  expect(run).toHaveBeenCalledWith(
    'wsl.exe',
    ['-d', 'Ubuntu', '--exec', 'bash', '-l', '-s', '--', data],
    READ_MANIFEST_SCRIPT,
  );
  expect(spawn).toHaveBeenCalledTimes(1);
  const [file, args, options] = vi.mocked(spawn).mock.calls[0]! as unknown as [
    string,
    string[],
    Record<string, unknown>,
  ];
  expect(file).toBe('wsl.exe');
  expect(args.slice(0, 5)).toEqual(['-d', 'Ubuntu', '--exec', 'bash', '-lc']);
  expect(args.slice(6)).toEqual([
    `${runtime}/node/bin/node`,
    `${runtime}/daemon/dist/main.js`,
    data,
    desktopDataDir,
    `${runtime}/cli/dist/index.js`,
    ...(process.env.PANTHEON_ALLOW_FIXTURE === '1' ? ['--allow-fixture'] : []),
  ]);
  expect(options).toMatchObject({ detached: true, windowsHide: true });
  const child = vi.mocked(spawn).mock.results[0]!.value as { unref: () => void };
  expect(child.unref).toHaveBeenCalled();
});

it("starts the WSL app's own wsl.exe, since the System32 stub opens a console window for it", async () => {
  const programs = mkdtempSync(path.join(os.tmpdir(), 'pantheon-program-files-'));
  mkdirSync(path.join(programs, 'WSL'));
  writeFileSync(path.join(programs, 'WSL', 'wsl.exe'), '');
  vi.stubEnv('ProgramFiles', programs);
  try {
    const { bridge } = await distro({ pid: undefined, next: 4242 });
    expect(await bridge.daemon()).toMatchObject({ ok: true });
    expect(vi.mocked(spawn).mock.calls[0]![0]).toBe(path.join(programs, 'WSL', 'wsl.exe'));
  } finally {
    vi.unstubAllEnvs();
    rmSync(programs, { recursive: true, force: true });
  }
});

it('connects to a daemon already running in the distro without starting another', async () => {
  const { bridge } = await distro({ pid: 4242, next: 5000 });
  expect(await bridge.daemon()).toMatchObject({ ok: true, value: { started_here: false } });
  expect(spawn).not.toHaveBeenCalled();
});

it('reads the manifest and token between the markers, past login profile output', () => {
  const manifest = { pid: 7, url: 'http://127.0.0.1:1234', token_file: `${data}/user.token` };
  const printed = `${MANIFEST_START}\n${JSON.stringify(manifest, null, 2)}\n\n${MANIFEST_SEPARATOR}\n${token}\n`;
  expect(parseManifestOutput(`Welcome to Ubuntu\n${printed}`)).toEqual({ manifest, token });
  expect(parseManifestOutput(`{"login":"ready"}\n${printed}`)).toEqual({ manifest, token });
  expect(() => parseManifestOutput(JSON.stringify(manifest))).toThrow();
});

it('stops the daemon for a reload with kill inside the distro, never a Windows process.kill', async () => {
  const { bridge, run, logFile } = await distro({ pid: 4242, next: 4243 });
  const kill = vi.spyOn(process, 'kill');
  await bridge.reloadDaemon();
  expect(kill).not.toHaveBeenCalled();
  const calls = run.mock.calls.map(([file, args]) => [file, args]);
  expect(calls).toContainEqual([
    'wsl.exe',
    ['-d', 'Ubuntu', '--exec', 'ps', '-ww', '-o', 'command=', '-p', '4242'],
  ]);
  expect(calls).toContainEqual(['wsl.exe', ['-d', 'Ubuntu', '--exec', 'kill', '-TERM', '4242']]);
  expect(calls).toContainEqual(['wsl.exe', ['-d', 'Ubuntu', '--exec', 'kill', '-0', '4242']]);
  expect(readFileSync(logFile, 'utf8')).toContain('daemon reloaded: pid 4242 stopped');
  expect(bridge.startedPid).toBe(4243);
});

it('leaves a distro process alone whose command line is not the daemon it starts', async () => {
  const { bridge, run } = await distro({ pid: 4242, next: 5000 });
  const answer = run.getMockImplementation()!;
  run.mockImplementation(async (file, args, input) =>
    args.includes('ps') ? Buffer.from('/usr/bin/python3 server.py\n') : answer(file, args, input),
  );
  await bridge.reloadDaemon();
  expect(run.mock.calls.some((call) => call[1].includes('ps'))).toBe(true);
  expect(run.mock.calls.some((call) => call[1].includes('kill'))).toBe(false);
});

it('answers with the reason WSL cannot run the daemon, without touching the distro', async () => {
  const { bridge, run } = await distro({ pid: 4242, next: 5000 });
  const reason =
    'WSL distribution Ubuntu lacks socat. Install them in Ubuntu with: sudo apt install socat';
  const unavailable = new DaemonBridge({ ...bridge['options'], unavailable: reason });
  const failed = { ok: false, error: { code: 'daemon_unavailable', message: reason } };
  expect(await unavailable.daemon()).toEqual(failed);
  const open = command('local-user', 'project.open', { name: 'app', roots: ['/home/ada/app'] });
  expect(await unavailable.command(open)).toEqual(failed);
  expect(await unavailable.query('board')).toEqual(failed);
  expect(run).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});

it('names what WSL lacks and the command that installs it', () => {
  expect(wslUnavailable(undefined, [])).toBe(
    'Pantheon runs its daemon in WSL 2. Install WSL and a Linux distribution with: wsl --install',
  );
  expect(wslUnavailable('Ubuntu', [])).toBeUndefined();
  // A distro without bubblewrap cannot create namespaces either; installing it is the fix.
  expect(wslUnavailable('Ubuntu', ['git', 'bwrap', 'socat', 'userns'])).toBe(
    'WSL distribution Ubuntu lacks git, bwrap, socat. Install them in Ubuntu with: sudo apt install git bubblewrap socat',
  );
  expect(wslUnavailable('Debian', ['socat', 'userns'])).toBe(
    'bubblewrap cannot create user namespaces in Debian; WSL 1 is not supported. WSL distribution Debian lacks socat. Install them in Debian with: sudo apt install socat',
  );
  expect(wslUnavailable('Debian', ['userns'])).toBe(
    'bubblewrap cannot create user namespaces in Debian; WSL 1 is not supported.',
  );
});

it('does not watch builds for a daemon in WSL', async () => {
  const { bridge, run } = await distro({ pid: 4242, next: 5000 });
  bridge.watchBuilds()();
  expect(run).not.toHaveBeenCalled();
});

// The scripts run here with plain bash; a stand-in wslpath maps C:\ to a folder of this test.
function bashDistro(root: string): RunWsl {
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, 'wslpath'),
    `#!/bin/sh\nprintf '%s\\n' "$2" | sed -e 's|\\\\|/|g' -e 's|^C:|${root}/c|'\n`,
  );
  chmodSync(path.join(bin, 'wslpath'), 0o755);
  return (_file, args, input) =>
    new Promise((resolve, reject) => {
      // Without -l: a login profile may reset PATH and lose the wslpath stand-in.
      const child = execFile(
        'bash',
        args.slice(args.indexOf('bash') + 1).filter((arg) => arg !== '-l'),
        {
          encoding: 'buffer',
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            XDG_DATA_HOME: path.join(root, 'xdg'),
          },
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
      child.stdin?.end(input);
    });
}

it.runIf(process.platform === 'linux')(
  'unpacks the runtime archive once into the versioned runtime folder and prints it with the data folder',
  async () => {
    const root = tempRoot();
    const run = bashDistro(root);
    const content = path.join(root, 'content');
    for (const file of ['node/bin/node', 'daemon/dist/main.js', 'cli/dist/index.js']) {
      mkdirSync(path.dirname(path.join(content, file)), { recursive: true });
      writeFileSync(path.join(content, file), file);
    }
    mkdirSync(path.join(root, 'c/fixture'), { recursive: true });
    execFileSync('tar', [
      '-czf',
      path.join(root, 'c/fixture/linux-runtime.tar.gz'),
      '-C',
      content,
      '.',
    ]);
    const install = async (runtime = '0.2.0') =>
      (
        await run(
          'wsl.exe',
          [
            '-d',
            'X',
            '--exec',
            'bash',
            '-l',
            '-s',
            '--',
            'C:\\fixture\\linux-runtime.tar.gz',
            runtime,
          ],
          INSTALL_RUNTIME_SCRIPT,
        )
      ).toString('utf8');
    const target = path.join(root, 'xdg/pantheon/runtime/0.2.0');
    expect(await install()).toBe(`${target}\n${path.join(root, 'xdg/pantheon/data')}\n`);
    expect(readFileSync(path.join(target, 'daemon/dist/main.js'), 'utf8')).toBe(
      'daemon/dist/main.js',
    );
    expect(readdirSync(path.join(root, 'xdg/pantheon/runtime'))).toEqual(['0.2.0']);

    // An installed runtime is kept as it is, even with no archive left to unpack.
    rmSync(path.join(root, 'c/fixture/linux-runtime.tar.gz'));
    writeFileSync(path.join(target, 'kept'), '');
    expect(await install()).toBe(`${target}\n${path.join(root, 'xdg/pantheon/data')}\n`);
    expect(readdirSync(target).sort()).toEqual(['cli', 'daemon', 'kept', 'node']);

    // A new build of the same app version unpacks into its own folder and removes the earlier ones.
    execFileSync('tar', [
      '-czf',
      path.join(root, 'c/fixture/linux-runtime.tar.gz'),
      '-C',
      content,
      '.',
    ]);
    await install('0.2.0+2');
    expect(readdirSync(path.join(root, 'xdg/pantheon/runtime'))).toEqual(['0.2.0+2']);
  },
);

const installArgs = (runtime: string) => [
  '-d',
  'X',
  '--exec',
  'bash',
  '-l',
  '-s',
  '--',
  'C:\\fixture\\linux-runtime.tar.gz',
  runtime,
];

it.runIf(process.platform === 'linux')(
  'keeps an earlier runtime a running process uses and removes the unused ones',
  async () => {
    const root = tempRoot();
    const run = bashDistro(root);
    const content = path.join(root, 'content');
    mkdirSync(path.join(content, 'daemon/dist'), { recursive: true });
    writeFileSync(path.join(content, 'daemon/dist/main.js'), '');
    mkdirSync(path.join(root, 'c/fixture'), { recursive: true });
    execFileSync('tar', [
      '-czf',
      path.join(root, 'c/fixture/linux-runtime.tar.gz'),
      '-C',
      content,
      '.',
    ]);
    const runtimes = path.join(root, 'xdg/pantheon/runtime');
    for (const old of ['0.1.0', '0.1.0+1'])
      mkdirSync(path.join(runtimes, old, 'node/bin'), { recursive: true });
    const sleeper = path.join(runtimes, '0.1.0+1/node/bin/sleep');
    copyFileSync('/bin/sleep', sleeper);
    chmodSync(sleeper, 0o755);
    const child = execFile(sleeper, ['600']);
    cleanups.push(() => {
      child.kill();
    });
    await new Promise((resolve) => child.once('spawn', resolve));

    await run('wsl.exe', installArgs('0.2.0'), INSTALL_RUNTIME_SCRIPT);
    expect(readdirSync(runtimes).sort()).toEqual(['0.1.0+1', '0.2.0']);
  },
);

it('leaves no staging folder behind when the archive does not unpack', async () => {
  const root = tempRoot();
  const run = bashDistro(root);
  mkdirSync(path.join(root, 'c/fixture'), { recursive: true });
  writeFileSync(path.join(root, 'c/fixture/linux-runtime.tar.gz'), 'not an archive');
  await expect(run('wsl.exe', installArgs('0.2.0'), INSTALL_RUNTIME_SCRIPT)).rejects.toThrow();
  expect(readdirSync(path.join(root, 'xdg/pantheon/runtime'))).toEqual([]);
});

it.runIf(process.platform === 'linux')(
  'prints the manifest, the separator and the token file the manifest names',
  async () => {
    const root = tempRoot();
    const run = bashDistro(root);
    const directory = path.join(root, 'xdg/pantheon/data');
    mkdirSync(directory, { recursive: true });
    const manifest = {
      protocol_version: PROTOCOL_VERSION,
      pid: 7,
      started_at: '2026-01-01T00:00:00.000Z',
      url: 'http://127.0.0.1:1234',
      token_file: path.join(directory, 'user.token'),
    };
    writeFileSync(path.join(directory, 'daemon.json'), JSON.stringify(manifest, null, 2) + '\n');
    writeFileSync(manifest.token_file, token);
    const stdout = (
      await run(
        'wsl.exe',
        ['-d', 'X', '--exec', 'bash', '-l', '-s', '--', directory],
        READ_MANIFEST_SCRIPT,
      )
    ).toString('utf8');
    expect(stdout).toBe(
      `${MANIFEST_START}\n${JSON.stringify(manifest, null, 2)}\n\n${MANIFEST_SEPARATOR}\n${token}`,
    );
    expect(parseManifestOutput(stdout)).toEqual({ manifest, token });

    rmSync(path.join(directory, 'daemon.json'));
    await expect(
      run(
        'wsl.exe',
        ['-d', 'X', '--exec', 'bash', '-l', '-s', '--', directory],
        READ_MANIFEST_SCRIPT,
      ),
    ).rejects.toThrow();
  },
);

it.runIf(process.platform === 'linux')(
  'reads the token of a data folder whose path has a quote and a backslash',
  async () => {
    const root = tempRoot();
    const run = bashDistro(root);
    const directory = path.join(root, 'x"y\\z/pantheon/data');
    mkdirSync(directory, { recursive: true });
    const manifest = {
      pid: 7,
      url: 'http://127.0.0.1:1234',
      token_file: path.join(directory, 'user.token'),
    };
    writeFileSync(path.join(directory, 'daemon.json'), JSON.stringify(manifest, null, 2) + '\n');
    writeFileSync(manifest.token_file, token);
    const stdout = (
      await run(
        'wsl.exe',
        ['-d', 'X', '--exec', 'bash', '-l', '-s', '--', directory],
        READ_MANIFEST_SCRIPT,
      )
    ).toString('utf8');
    expect(parseManifestOutput(stdout)).toEqual({ manifest, token });
  },
);
