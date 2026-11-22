import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Control } from '@pantheon/control';
import { ArtifactFiles, Store } from '@pantheon/store';
import type { Principal } from '@pantheon/protocol';
import type { ControlContext } from '../../packages/control/src/context.js';
import {
  deviceTransport,
  listDevices,
  parseDeviceProbe,
  probeDevice,
  refreshDevices,
  removeDevice,
  reprobeDevice,
  saveDevice,
  sshConfigHosts,
  sshDeviceLink,
  sshHosts,
} from '../../packages/control/src/devices.js';
import { fixture, user } from '../helpers.js';

const roots: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function context(): ControlContext {
  const cache = path.resolve('node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(path.join(cache, 'devices-'));
  roots.push(root);
  const store = new Store(path.join(root, 'control.sqlite'));
  stores.push(store);
  return {
    userConfigDir: root,
    store,
    devices: new Map(),
  } as unknown as ControlContext;
}
// The probe script's claude and codex are shell functions here, so the real ones never run.
const stubbedRuntimes = [
  '/bin/sh',
  '-c',
  'claude() { case "$1" in auth) echo "  \\"loggedIn\\": true,";; *) echo "2.1.0 (Claude Code)";; esac; }; codex() { case "$1" in login) echo "Not logged in";; *) echo "codex-cli 0.50.0";; esac; }; eval "$0"',
];
const unreachable = () => [
  '/bin/sh',
  '-c',
  'echo "ssh: connect to host build-box" >&2; exit 255 #',
];

it('parses a macOS probe', () => {
  const output = [
    'os=macos',
    'os_version=26.1',
    'cpus=12',
    'memory_bytes=38654705664',
    'load_1m=2.41',
    'arch=arm64',
    'home=/Users/builder',
    'path=/Users/builder/.local/bin:/opt/homebrew/bin:/usr/bin:/bin',
    'runtime.claude=/Users/builder/.local/bin/claude\t2.1.0 (Claude Code)\t0',
    'tool.git=git version 2.50.1 (Apple Git-155)',
    'tool.node=v24.3.0',
    'label.xcode=1',
    'shell=zsh',
  ].join('\n');
  expect(parseDeviceProbe(output)).toEqual({
    os: 'macos',
    os_version: '26.1',
    cpus: 12,
    memory_bytes: 38654705664,
    load_1m: 2.41,
    arch: 'arm64',
    home: '/Users/builder',
    path: '/Users/builder/.local/bin:/opt/homebrew/bin:/usr/bin:/bin',
    runtimes: {
      claude: {
        binary: '/Users/builder/.local/bin/claude',
        version: '2.1.0 (Claude Code)',
        logged_in: false,
      },
    },
    tools: { git: 'git version 2.50.1 (Apple Git-155)', node: 'v24.3.0' },
    labels: ['xcode'],
  });
});

it('parses a Linux probe with a GPU and docker', () => {
  const output = [
    'os=linux',
    'os_version=Ubuntu 24.04.2 LTS',
    'cpus=32',
    'memory_bytes=135089045504',
    'load_1m=0.07',
    'arch=x86_64',
    'home=/home/builder',
    'path=/home/builder/.local/bin:/usr/local/bin:/usr/bin',
    'runtime.codex=/usr/local/bin/codex\tcodex-cli 0.50.0\t1',
    'tool.docker=Docker version 28.3.2, build 578ccf6',
    'label.gpu=1',
    'uptime=12 days',
    '',
  ].join('\n');
  expect(parseDeviceProbe(output)).toEqual({
    os: 'linux',
    os_version: 'Ubuntu 24.04.2 LTS',
    cpus: 32,
    memory_bytes: 135089045504,
    load_1m: 0.07,
    arch: 'x86_64',
    home: '/home/builder',
    path: '/home/builder/.local/bin:/usr/local/bin:/usr/bin',
    runtimes: {
      codex: { binary: '/usr/local/bin/codex', version: 'codex-cli 0.50.0', logged_in: true },
    },
    tools: { docker: 'Docker version 28.3.2, build 578ccf6' },
    labels: ['gpu', 'docker'],
  });
});

it('probes this machine through a local shell', async () => {
  const found = await probeDevice(stubbedRuntimes);
  expect(found).toMatchObject({
    online: true,
    home: os.homedir(),
    runtimes: {
      claude: { binary: 'claude', version: '2.1.0 (Claude Code)', logged_in: true },
      codex: { binary: 'codex', version: 'codex-cli 0.50.0', logged_in: false },
    },
  });
  if (!found.online) throw new Error(found.error);
  expect(found.cpus).toBeGreaterThan(0);
  expect(found.memory_bytes).toBeGreaterThan(0);
  expect(found.arch).toBe(os.machine());
  expect(found.labels.filter((label) => /^(os|arch)=/.test(label))).toEqual([]);
});

it('forwards a device socket to a local one ahead of the SSH target', () => {
  const { transport, socket } = sshDeviceLink('builder@build-box').withSocket(
    '/tmp/local.sock',
    '/home/builder/.pantheon/s/w.sock',
  );
  expect(socket).toBe('/home/builder/.pantheon/s/w.sock');
  expect(transport.at(-1)).toBe('builder@build-box');
  const forward = transport.indexOf('-R');
  expect(transport[forward + 1]).toBe('/home/builder/.pantheon/s/w.sock:/tmp/local.sock');
  expect(transport.slice(0, forward)).toEqual(
    expect.arrayContaining(['-o', 'ExitOnForwardFailure=yes']),
  );
});

it('ends an SSH connection to a device that stopped answering', () => {
  const transport = deviceTransport('builder@build-box');
  expect(transport.at(-1)).toBe('builder@build-box');
  expect(transport).toEqual(
    expect.arrayContaining(['-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4']),
  );
});

it('reports a probe that exits with an error as offline', async () => {
  const found = await probeDevice(['/bin/sh', '-c', 'exit 7 #']);
  expect(found.online).toBe(false);
  expect(found).toHaveProperty('error', expect.any(String));
});

it('saves a device, lists it after this machine and removes it', async () => {
  const ctx = context();
  const saved = await saveDevice(
    ctx,
    user,
    { id: 'build-box', ssh: 'build-box', note: 'GPU box' },
    unreachable,
  );
  expect(saved).toMatchObject({ online: false, error: 'ssh: connect to host build-box' });
  const config = JSON.parse(readFileSync(path.join(ctx.userConfigDir!, 'config.json'), 'utf8'));
  expect(config.devices).toEqual({
    'build-box': { ssh: 'build-box', note: 'GPU box' },
  });
  const listed = listDevices(ctx);
  expect(listed.map((device) => device.id)).toEqual(['local', 'build-box']);
  expect(listed[1]).toMatchObject({
    name: 'build-box',
    ssh: 'build-box',
    note: 'GPU box',
    labels: [],
    online: false,
  });
  removeDevice(ctx, user, 'build-box');
  expect(listDevices(ctx).map((device) => device.id)).toEqual(['local']);
});

it('keeps a device removed during its probe out of the probed devices', async () => {
  const ctx = context();
  const probing = saveDevice(ctx, user, { id: 'build-box', ssh: 'build-box' }, () => [
    '/bin/sh',
    '-c',
    'sleep 0.3; printf "home=/home/builder\\ncpus=4\\n" #',
  ]);
  removeDevice(ctx, user, 'build-box');
  expect((await probing).online).toBe(true);

  expect(ctx.devices!.has('build-box')).toBe(false);
});

it('refuses to remove a device or change its SSH target while a session keeps a worktree on it', async () => {
  const ctx = context();
  await saveDevice(ctx, user, { id: 'build-box', ssh: 'build-box' }, unreachable);
  ctx.store.insert('workspaces', { id: 'w1', revision: 1, path: '/w1' });
  ctx.store.insert('sessions', {
    id: 's1',
    revision: 1,
    device_id: 'build-box',
    workspace_id: 'w1',
  });
  const busy = expect.objectContaining({ code: 'resource_busy' });
  expect(() => removeDevice(ctx, user, 'build-box')).toThrow(busy);
  expect(() =>
    saveDevice(ctx, user, { id: 'build-box', ssh: 'builder@other-box' }, unreachable),
  ).toThrow(busy);
  await saveDevice(ctx, user, { id: 'build-box', ssh: 'build-box', note: 'GPU box' }, unreachable);

  ctx.store.update('workspaces', { id: 'w1', revision: 1, path: '/w1', removed_at: 1 }, 1);
  removeDevice(ctx, user, 'build-box');
  expect(listDevices(ctx).map((device) => device.id)).toEqual(['local']);
});

it('lists each device with its configuration entry and what holds it now', async () => {
  const configDir = context().userConfigDir!;
  const entry = {
    ssh: 'builder@build-box',
    labels: ['cuda'],
    resources: { gpu: 2 },
    max_sessions: 3,
  };
  writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({ version: 1, devices: { 'build-box': entry } }),
  );
  const f = await fixture({ controlOptions: { userConfigDir: configDir } });
  try {
    const listed = await f.control.listDevices(user);
    expect(listed.map((device) => device.id)).toEqual(['local', 'build-box']);
    expect(listed[0]).not.toHaveProperty('config');
    expect(listed[1]!.config).toEqual(entry);
    expect(listed[1]).toMatchObject({ labels: [] });
    for (const key of ['resources', 'max_sessions']) expect(listed[1]).not.toHaveProperty(key);
    for (const device of listed) expect(device.load).toEqual({ active_sessions: [] });
  } finally {
    await f.close();
  }
});

it('refuses the device list to an expired principal', async () => {
  const f = await fixture();
  try {
    await expect(f.control.listDevices({ ...user, expires_at: 1 })).rejects.toMatchObject({
      code: 'permission_denied',
    });
  } finally {
    await f.close();
  }
});

it('refuses to save a device for a session principal', () => {
  const writer: Principal = {
    id: 'writer',
    role: 'writer',
    session_id: 'session',
    project_id: 'p',
  };
  expect(() =>
    saveDevice(context(), writer, { id: 'build-box', ssh: 'build-box' }, unreachable),
  ).toThrow(expect.objectContaining({ code: 'permission_denied' }));
});

it('keeps the last successful probe through an offline probe and a store restart', async () => {
  const ctx = context();
  const input = { id: 'build-box', ssh: 'build-box' };
  const never = await saveDevice(ctx, user, input, unreachable);
  expect(never).not.toHaveProperty('last_online_at');
  const online = await saveDevice(ctx, user, input, () => [
    '/bin/sh',
    '-c',
    'printf "home=/home/builder\\ncpus=4\\n" #',
  ]);
  expect(online.last_online_at).toBe(online.checked_at);
  const offline = await saveDevice(ctx, user, input, unreachable);
  expect(offline.online).toBe(false);
  expect(offline.last_online_at).toBe(online.last_online_at);
  ctx.store.close();
  stores.splice(stores.indexOf(ctx.store), 1);
  const reopened = new Store(path.join(ctx.userConfigDir!, 'control.sqlite'));
  stores.push(reopened);
  const restarted = new Control(
    reopened,
    new ArtifactFiles(path.join(ctx.userConfigDir!, 'artifacts')),
    [],
    undefined,
    { userConfigDir: ctx.userConfigDir },
  );
  expect((await restarted.listDevices(user))[1]).toMatchObject({
    online: false,
    last_online_at: online.last_online_at,
  });
  await restarted.shutdown();
});

it('keeps the name a save probed over the one an older refresh probed later', async () => {
  const ctx = context();
  writeFileSync(
    path.join(ctx.userConfigDir!, 'config.json'),
    JSON.stringify({ version: 1, devices: { 'build-box': { ssh: 'build-box', name: 'Old box' } } }),
  );
  const probe = (delay: number) => () => [
    '/bin/sh',
    '-c',
    `sleep ${delay}; printf "home=/home/builder\\ncpus=4\\n" #`,
  ];
  const refresh = refreshDevices(ctx, probe(1));
  await saveDevice(ctx, user, { id: 'build-box', ssh: 'build-box', name: 'New box' }, probe(0));
  await refresh;

  expect(listDevices(ctx)[1]).toMatchObject({ id: 'build-box', online: true, name: 'New box' });
  expect(ctx.devices!.get('build-box')!.name).toBe('New box');
});

it('names this machine by its system fields, not by os and arch labels', () => {
  const local = listDevices(context())[0]!;
  expect(local.arch).toBe(os.machine());
  expect(local.labels).toEqual([]);
});

it('probes only the one device it names', async () => {
  const ctx = context();
  writeFileSync(
    path.join(ctx.userConfigDir!, 'config.json'),
    JSON.stringify({
      version: 1,
      devices: { 'build-box': { ssh: 'build-box' }, 'gpu-box': { ssh: 'builder@gpu-box' } },
    }),
  );
  const reached: string[] = [];
  const transport = (ssh: string) => {
    reached.push(ssh);
    return ['/bin/sh', '-c', 'printf "home=/home/builder\\ncpus=4\\n" #'];
  };
  await reprobeDevice(ctx, 'gpu-box', transport);
  expect(reached).toEqual(['builder@gpu-box']);
  expect([...ctx.devices!.keys()]).toEqual(['gpu-box']);
  expect(listDevices(ctx).find((device) => device.id === 'gpu-box')).toMatchObject({
    online: true,
    cpus: 4,
  });
  await reprobeDevice(ctx, 'local', transport);
  expect(reached).toEqual(['builder@gpu-box']);
  await expect(reprobeDevice(ctx, 'cloud-box', transport)).rejects.toMatchObject({
    code: 'invalid_input',
  });
});

function sshConfig(files: Record<string, string>): string {
  const directory = path.join(context().userConfigDir!, 'ssh');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    writeFileSync(path.join(directory, name), text);
  }
  return path.join(directory, 'config');
}

it('lists the named hosts of an SSH config with their host name and user', () => {
  const file = sshConfig({
    config: [
      '# Build machines',
      'Host studio',
      '  HostName studio.lan',
      '  User builder',
      '',
      'Host *.corp !legacy ws ws-?',
      '  hostname=10.0.0.2',
      'Host *',
      '  ServerAliveInterval 30',
      'Match host other',
      '  User someone',
      'Include config.d/*',
      'Host studio',
      '  User later',
    ].join('\n'),
    'config.d/pi': 'Host pi5\n  HostName pi5.lan\nInclude nested\n',
    nested: 'Host deeper\n',
  });
  expect(sshConfigHosts(file)).toEqual([
    { host: 'studio', hostname: 'studio.lan', user: 'builder' },
    { host: 'ws', hostname: '10.0.0.2' },
    { host: 'pi5', hostname: 'pi5.lan' },
  ]);
  expect(sshConfigHosts(path.join(path.dirname(file), 'missing'))).toEqual([]);
});

it('reads SSH config arguments as OpenSSH does: quoted words, up to a comment', () => {
  const file = sshConfig({
    config: [
      'Host build # staging box',
      '  HostName build.lan # the rack',
      'Host "quoted"',
      '  HostName "quoted.example.com"',
      'Include "with space/hosts"',
    ].join('\n'),
    'with space/hosts': 'Host spaced\n',
  });
  expect(sshConfigHosts(file)).toEqual([
    { host: 'build', hostname: 'build.lan' },
    { host: 'quoted', hostname: 'quoted.example.com' },
    { host: 'spaced' },
  ]);
});

it('marks the SSH hosts that a configured device already reaches', () => {
  const ctx = context();
  writeFileSync(
    path.join(ctx.userConfigDir!, 'config.json'),
    JSON.stringify({ version: 1, devices: { 'mac-studio': { ssh: 'studio' } } }),
  );
  const file = sshConfig({ config: 'Host studio\nHost ws\n' });
  expect(sshHosts(ctx, file)).toEqual([
    { host: 'studio', device_id: 'mac-studio' },
    { host: 'ws' },
  ]);
});
