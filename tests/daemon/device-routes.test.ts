import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import { startDaemon } from '@pantheon/daemon';
import { command } from '@pantheon/protocol';
import { user } from '../helpers.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('probes one device and lists the hosts of the SSH config over HTTP', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-device-routes-'));
  roots.push(root);
  const bin = path.join(root, 'bin'),
    home = path.join(root, 'home'),
    config = path.join(root, 'config');
  for (const directory of [bin, path.join(home, '.ssh'), config])
    mkdirSync(directory, { recursive: true });
  // Answers every probe with the same findings and reaches no host.
  writeFileSync(
    path.join(bin, 'ssh'),
    `#!/bin/sh\nprintf 'os=linux\\narch=x86_64\\ncpus=8\\nhome=/home/builder\\n'\n`,
  );
  chmodSync(path.join(bin, 'ssh'), 0o755);
  writeFileSync(
    path.join(home, '.ssh', 'config'),
    'Host build-box\n  HostName build.lan\n  User builder\nHost gpu-box\n',
  );
  writeFileSync(
    path.join(config, 'config.json'),
    JSON.stringify({ version: 1, devices: { 'build-box': { ssh: 'build-box' } } }),
  );
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
  vi.stubEnv('HOME', home);
  const daemon = await startDaemon({
    directory: path.join(root, 'state'),
    adapters: [new FixtureAdapter()],
    userConfigDir: config,
  });
  const headers = { Authorization: `Bearer ${daemon.token}` };
  try {
    const probed = await fetch(daemon.url + '/v1/device.probe?id=build-box', { headers });
    expect(await probed.json()).toMatchObject({
      id: 'build-box',
      online: true,
      os: 'linux',
      arch: 'x86_64',
      cpus: 8,
      labels: [],
      load: { sessions: 0 },
    });
    const unknown = await fetch(daemon.url + '/v1/device.probe?id=cloud-box', { headers });
    expect(await unknown.json()).toMatchObject({ error: 'invalid_input' });
    const hosts = await fetch(daemon.url + '/v1/device.ssh_hosts', { headers });
    expect(await hosts.json()).toEqual([
      { host: 'build-box', hostname: 'build.lan', user: 'builder', device_id: 'build-box' },
      { host: 'gpu-box' },
    ]);
  } finally {
    await daemon.close();
  }
});

it('reaches a device added and then tested over SSH only once', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-device-routes-'));
  roots.push(root);
  const bin = path.join(root, 'bin'),
    config = path.join(root, 'config'),
    calls = path.join(root, 'ssh-calls');
  for (const directory of [bin, config]) mkdirSync(directory, { recursive: true });
  // Notes each run, then answers after a moment so the second request finds the first still running.
  writeFileSync(
    path.join(bin, 'ssh'),
    `#!/bin/sh\necho run >> '${calls}'\nsleep 0.3\nprintf 'os=linux\\narch=x86_64\\ncpus=8\\n'\n`,
  );
  chmodSync(path.join(bin, 'ssh'), 0o755);
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
  const daemon = await startDaemon({
    directory: path.join(root, 'state'),
    adapters: [new FixtureAdapter()],
    userConfigDir: config,
  });
  const headers = { Authorization: `Bearer ${daemon.token}` };
  try {
    const saved = await fetch(daemon.url + '/v1/commands', {
      method: 'POST',
      headers,
      body: JSON.stringify(command(user.id, 'device.save', { id: 'build-box', ssh: 'build-box' })),
    });
    expect(saved.status).toBe(200);
    const probed = await fetch(daemon.url + '/v1/device.probe?id=build-box', { headers });
    expect(await probed.json()).toMatchObject({ id: 'build-box', online: true, cpus: 8 });
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['run']);
  } finally {
    await daemon.close();
  }
});
