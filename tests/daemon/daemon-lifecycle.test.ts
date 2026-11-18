import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const mock = vi.hoisted(() => ({
  lock: null as any,
  server: null as any,
  fetch: null as any,
  listenError: false,
}));
vi.mock('node:net', async (actual) => {
  const value = await actual<any>();
  return { ...value, default: { ...value.default, createServer: () => mock.lock } };
});
vi.mock('node:fs', async (actual) => {
  const value = await actual<any>();
  return {
    ...value,
    chmodSync: (file: string, mode: number) => {
      if (!file.endsWith('.sock')) value.chmodSync(file, mode);
    },
  };
});
vi.mock('../../apps/daemon/node_modules/@hono/node-server/dist/index.mjs', () => ({
  serve: (options: any) => {
    mock.fetch = options.fetch;
    if (mock.listenError)
      queueMicrotask(() => mock.server.emit('error', new Error('listen failed')));
    return mock.server;
  },
}));
import { startDaemon } from '../../apps/daemon/src/index.js';
import { Store } from '@pantheon/store';
import { Control } from '@pantheon/control';
import type { Project } from '@pantheon/domain';
import { command, USER_PRINCIPAL_ID } from '@pantheon/protocol';
const roots: string[] = [];
let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
const directory = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'daemon-lifecycle-'));
  roots.push(root);
  return root;
};
beforeEach(() => {
  mock.lock = Object.assign(new EventEmitter(), {
    listen: (_socket: string, ready: () => void) => {
      queueMicrotask(ready);
    },
    close: vi.fn((ready: () => void) => ready()),
  });
  mock.server = Object.assign(new EventEmitter(), {
    listening: true,
    address: () => ({ port: 1234 }),
    close: vi.fn((ready: () => void) => ready()),
  });
  mock.listenError = false;
});
afterEach(async () => {
  vi.useRealTimers();
  if (daemon) await daemon.close();
  daemon = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
  roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true }));
});

it('closes the store and directory lock after recovery throws', async () => {
  const close = vi.spyOn(Store.prototype, 'close');
  vi.spyOn(Control.prototype, 'recover').mockImplementation(() => {
    throw new Error('recovery failed');
  });
  await expect(startDaemon({ directory: directory(), adapters: [] })).rejects.toThrow(
    'recovery failed',
  );
  expect(close).toHaveBeenCalledTimes(1);
  expect(mock.lock.close).toHaveBeenCalledTimes(1);
});

it('closes acquired resources after the HTTP listener fails', async () => {
  const close = vi.spyOn(Store.prototype, 'close');
  mock.listenError = true;
  mock.server.listening = false;
  await expect(startDaemon({ directory: directory(), adapters: [] })).rejects.toThrow(
    'listen failed',
  );
  expect(close).toHaveBeenCalledTimes(1);
  expect(mock.server.close).toHaveBeenCalledTimes(1);
  expect(mock.lock.close).toHaveBeenCalledTimes(1);
});

// The tick beat reads Date.now for its quiet period, so the clock is faked with the interval.
const startOnFakeBeat = async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  daemon = await startDaemon({ directory: directory(), adapters: [] });
  return daemon;
};
const writeStore = (started: NonNullable<typeof daemon>) =>
  started.store.event('test.write', { id: 'written', revision: 1 }, '', {});

it('runs the tick about once a second while the store stays unwritten', async () => {
  const started = await startOnFakeBeat();
  const tick = vi.spyOn(started.control, 'tick');
  await vi.advanceTimersByTimeAsync(3_000);
  expect(tick.mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(tick.mock.calls.length).toBeLessThanOrEqual(4);
});

it.each([
  ['the store is written', writeStore],
  [
    'the control announces a change',
    (started: NonNullable<typeof daemon>) =>
      void started.control.emit('events', started.store.cursor()),
  ],
])('runs the tick on the next beat after %s', async (_, change) => {
  const started = await startOnFakeBeat();
  const tick = vi.spyOn(started.control, 'tick').mockResolvedValue();
  await vi.advanceTimersByTimeAsync(100);
  const settled = tick.mock.calls.length;
  await vi.advanceTimersByTimeAsync(400);
  expect(tick.mock.calls.length).toBe(settled);
  change(started);
  await vi.advanceTimersByTimeAsync(50);
  expect(tick.mock.calls.length).toBe(settled + 1);
});

it('runs the tick again on the next beat after a tick wrote the store', async () => {
  const started = await startOnFakeBeat();
  let writes = 1;
  const tick = vi.spyOn(started.control, 'tick').mockImplementation(async () => {
    if (writes-- > 0) writeStore(started);
  });
  await vi.advanceTimersByTimeAsync(50);
  expect(tick).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(50);
  expect(tick).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(800);
  expect(tick).toHaveBeenCalledTimes(2);
});

it('returns an inventory deadline error before the desktop transport deadline', async () => {
  daemon = await startDaemon({ directory: directory(), adapters: [], intervalMs: 60_000 });
  vi.spyOn(daemon.control, 'extensionsInventory').mockImplementation(() => new Promise(() => {}));
  vi.useFakeTimers();
  let response: Response | undefined;
  const pending = mock
    .fetch(
      new Request('http://daemon/v1/extensions.inventory?project_id=project&runtime=claude', {
        headers: { authorization: `Bearer ${daemon.token}` },
      }),
    )
    .then((r: Response) => {
      response = r;
    });
  await vi.advanceTimersByTimeAsync(12_001);
  expect(response).toBeDefined();
  await pending;
  expect(await response!.json()).toMatchObject({ error: 'inventory_timeout' });
});

it('returns a model list deadline error when the runtime is slow to list its models', async () => {
  daemon = await startDaemon({ directory: directory(), adapters: [], intervalMs: 60_000 });
  vi.spyOn(daemon.control, 'runtimeModels').mockImplementation(() => new Promise(() => {}));
  vi.useFakeTimers();
  let response: Response | undefined;
  const pending = mock
    .fetch(
      new Request('http://daemon/v1/runtime.models?project_id=project&runtime=claude', {
        headers: { authorization: `Bearer ${daemon.token}` },
      }),
    )
    .then((r: Response) => {
      response = r;
    });
  await vi.advanceTimersByTimeAsync(12_001);
  expect(response).toBeDefined();
  await pending;
  expect(await response!.json()).toMatchObject({ error: 'models_timeout' });
});

it('stores an uploaded attachment up to 20 MiB and searches the project files', async () => {
  daemon = await startDaemon({ directory: directory(), adapters: [], intervalMs: 60_000 });
  const projectRoot = path.join(directory(), 'project');
  mkdirSync(projectRoot);
  writeFileSync(path.join(projectRoot, 'answer.txt'), 'base\n');
  const project = (await daemon.control.execute(
    { id: USER_PRINCIPAL_ID, role: 'user' },
    command(USER_PRINCIPAL_ID, 'project.open', { name: 'Upload project', roots: [projectRoot] }),
  )) as Project;
  const headers = { authorization: `Bearer ${daemon.token}` };
  const upload = (bytes: number, type?: string): Promise<Response> =>
    mock.fetch(
      new Request(`http://daemon/v1/attachments?project_id=${project.id}&name=big.bin`, {
        method: 'POST',
        headers: type ? { ...headers, 'content-type': type } : headers,
        body: new Uint8Array(bytes),
      }),
    );
  const stored = await upload(2 * 1024 * 1024);
  expect(stored.status).toBe(200);
  expect(await stored.json()).toEqual({
    id: expect.any(String),
    name: 'big.bin',
    mime: 'application/octet-stream',
    size: 2 * 1024 * 1024,
  });
  expect(await (await upload(16, 'image/png')).json()).toMatchObject({ mime: 'image/png' });
  const refused = await upload(20 * 1024 * 1024 + 1);
  expect(refused.status).toBe(413);
  expect(await refused.json()).toMatchObject({ error: 'attachment_too_large' });
  const found = await mock.fetch(
    new Request(`http://daemon/v1/files.search?project_id=${project.id}&q=answer`, { headers }),
  );
  expect(await found.json()).toEqual(['answer.txt']);
});

it('refuses a command body over 1 MiB with 413 and a clear message', async () => {
  daemon = await startDaemon({ directory: directory(), adapters: [], intervalMs: 60_000 });
  const refused = await mock.fetch(
    new Request('http://daemon/v1/commands', {
      method: 'POST',
      headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(1024 * 1024) }),
    }),
  );
  expect(refused.status).toBe(413);
  expect(await refused.json()).toEqual({
    error: 'payload_too_large',
    message: 'Request body is larger than 1 MiB',
  });
});

it('routes workspace listing, file reading and symbol search through validated queries', async () => {
  daemon = await startDaemon({ directory: directory(), adapters: [], intervalMs: 60_000 });
  const projectRoot = path.join(directory(), 'project');
  mkdirSync(projectRoot);
  writeFileSync(path.join(projectRoot, 'answer.ts'), 'export function answer() {}\n');
  const project = (await daemon.control.execute(
    { id: USER_PRINCIPAL_ID, role: 'user' },
    command(USER_PRINCIPAL_ID, 'project.open', { name: 'Files project', roots: [projectRoot] }),
  )) as Project;
  const query = (method: string, params = {}) =>
    mock.fetch(
      new Request(
        `http://daemon/v1/${method}?${new URLSearchParams({ project_id: project.id, ...params })}`,
        { headers: { authorization: `Bearer ${daemon!.token}` } },
      ),
    );
  expect(await (await query('files.list')).json()).toEqual({
    entries: [{ name: 'answer.ts', kind: 'file', size: 28 }],
    truncated: false,
  });
  expect(await (await query('files.read', { path: 'answer.ts' })).json()).toEqual({
    path: 'answer.ts',
    text: 'export function answer() {}\n',
    size: 28,
    truncated: false,
  });
  expect(await (await query('symbols.search', { q: 'answer' })).json()).toEqual({
    symbols: [{ name: 'answer', kind: 'function', path: 'answer.ts', line: 1 }],
  });
  expect(await (await query('files.read')).json()).toMatchObject({ error: 'invalid_input' });
  expect(await (await query('files.read', { path: '../outside' })).json()).toMatchObject({
    error: 'invalid_input',
  });
});
