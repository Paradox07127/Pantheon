import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { command } from '@pantheon/protocol';
import { DaemonBridge } from '../../apps/desktop/src/main/daemon.js';
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true }));
});
it('gives inventory and the model list a longer deadline than daemon discovery while ordinary queries keep five seconds', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bridge-deadline-'));
  roots.push(root);
  const token = path.join(root, 'user.token');
  writeFileSync(token, 'token');
  writeFileSync(
    path.join(root, 'daemon.json'),
    JSON.stringify({ url: 'http://127.0.0.1:1234', token_file: token, pid: 1 }),
  );
  const timeouts: number[] = [];
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    timeouts.push(ms);
    return new AbortController().signal;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ version: '0.1.0', protocol_version: 1 }))),
  );
  const bridge = new DaemonBridge({
    directory: root,
    packaged: true,
    repo: root,
    logFile: path.join(root, 'daemon.log'),
  });
  await bridge.daemon();
  timeouts.length = 0;
  await bridge.query('extensions.inventory', { project_id: 'project', runtime: 'claude' });
  await bridge.query('runtime.models', { project_id: 'project', runtime: 'claude' });
  await bridge.query('board');
  expect(timeouts[0]).toBeGreaterThan(12_000);
  expect(timeouts[1]).toBeGreaterThan(12_000);
  expect(timeouts[2]).toBe(5000);
});

it('waits for the runtime preflight behind the runtime status', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bridge-deadline-'));
  roots.push(root);
  const token = path.join(root, 'user.token');
  writeFileSync(token, 'token');
  writeFileSync(
    path.join(root, 'daemon.json'),
    JSON.stringify({ url: 'http://127.0.0.1:1234', token_file: token, pid: 1 }),
  );
  const timeouts: number[] = [];
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    timeouts.push(ms);
    return new AbortController().signal;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ version: '0.1.0', protocol_version: 1 }))),
  );
  const bridge = new DaemonBridge({
    directory: root,
    packaged: true,
    repo: root,
    logFile: path.join(root, 'daemon.log'),
  });
  await bridge.daemon();
  timeouts.length = 0;
  await bridge.query('runtime.status', { refresh: 'true' });
  expect(timeouts).toEqual([45_000]);
});

it('waits for refreshed device probes and for MCP servers to start', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bridge-deadline-'));
  roots.push(root);
  const token = path.join(root, 'user.token');
  writeFileSync(token, 'token');
  writeFileSync(
    path.join(root, 'daemon.json'),
    JSON.stringify({ url: 'http://127.0.0.1:1234', token_file: token, pid: 1 }),
  );
  const timeouts: number[] = [];
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    timeouts.push(ms);
    return new AbortController().signal;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ version: '0.1.0', protocol_version: 1 }))),
  );
  const bridge = new DaemonBridge({
    directory: root,
    packaged: true,
    repo: root,
    logFile: path.join(root, 'daemon.log'),
  });
  await bridge.daemon();
  timeouts.length = 0;
  await bridge.query('device.list', { refresh: 'true' });
  await bridge.query('device.list');
  await bridge.query('device.probe', { id: 'd' });
  await bridge.query('mcp.status', { project_id: 'project' });
  expect(timeouts).toEqual([25_000, 5000, 25_000, 65_000]);
});

it('waits for a merge to commit the uncommitted files while other commands keep five seconds', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bridge-deadline-'));
  roots.push(root);
  const token = path.join(root, 'user.token');
  writeFileSync(token, 'token');
  writeFileSync(
    path.join(root, 'daemon.json'),
    JSON.stringify({ url: 'http://127.0.0.1:1234', token_file: token, pid: 1 }),
  );
  const timeouts: number[] = [];
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    timeouts.push(ms);
    return new AbortController().signal;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ version: '0.1.0', protocol_version: 1 }))),
  );
  const bridge = new DaemonBridge({
    directory: root,
    packaged: true,
    repo: root,
    logFile: path.join(root, 'daemon.log'),
  });
  await bridge.daemon();
  timeouts.length = 0;
  await bridge.command(command('user', 'session.merge', { session_id: 'session' }, 1));
  await bridge.command(
    command('user', 'session.send', { session_id: 'session', input: 'Next' }, 1),
  );
  expect(timeouts).toEqual([250_000, 5000]);
});
