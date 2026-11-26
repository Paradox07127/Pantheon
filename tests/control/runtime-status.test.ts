import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import { Control } from '@pantheon/control';
import type { RuntimeStatus } from '@pantheon/domain';
import { ArtifactFiles, Store } from '@pantheon/store';
import { user } from '../helpers.js';
import type { ControlContext } from '../../packages/control/dist/context.js';
import {
  reconnectRuntime,
  refreshRuntimeStatus,
  runtimeConnection,
  updateRuntimeConnection,
} from '../../packages/control/dist/runtime-status.js';

type Found = Omit<RuntimeStatus, 'runtime' | 'checked_at'>;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const found = (version: string): Found => ({
  installed: true,
  version,
  min_version: '1.0.0',
  version_ok: true,
  auth: { state: 'ok', email: 'owner@example.com', plan: 'max' },
});

class CheckedAdapter extends FixtureAdapter {
  name = 'checked';
  preflight = vi.fn<() => Promise<Found>>();
  reconnect = vi.fn<() => Promise<void>>();
}

function setup(config?: Record<string, unknown>) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-runtime-status-'));
  if (config) writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  let clock = Date.UTC(2026, 0, 2, 3, 4, 5);
  const store = new Store(path.join(root, 'state/control.sqlite'), () => clock),
    checked = new CheckedAdapter(),
    control = new Control(
      store,
      new ArtifactFiles(path.join(root, 'state/artifacts')),
      [new FixtureAdapter(), checked],
      undefined,
      { userConfigDir: root },
    );
  cleanups.push(async () => {
    await control.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    control,
    checked,
    store,
    ctx: (control as unknown as { ctx: ControlContext }).ctx,
    advance: (ms: number) => (clock += ms),
    now: () => clock,
  };
}

it('shares one running check between callers and lists every registered runtime', async () => {
  const f = setup();
  let finish!: (value: Found) => void;
  f.checked.preflight.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  const first = f.control.runtimeStatus(user, true),
    second = f.control.runtimeStatus(user, true),
    daemon = f.control.refreshRuntimeStatus();
  expect(f.checked.preflight).toHaveBeenCalledTimes(1);
  finish(found('2.0.0'));
  await daemon;
  const expected = [
    expect.objectContaining({ runtime: 'fixture' }),
    {
      capabilities: f.checked.report.capabilities,
      runtime: 'checked',
      unverified_isolation: false,
      enabled: true,
      connection: { connected: true, held_session_count: 0, held_session_ids: [] },
      ...found('2.0.0'),
      checked_at: new Date(f.now()).toISOString(),
    },
    expect.objectContaining({ runtime: 'claude', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'codex', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'opencode', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'grok', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'agy', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'dsh', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'muse', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'cursor', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'copilot', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'gemini', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'kilo', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'cline', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'qwen', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'kimi', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'goose', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'openhands', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'auggie', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'kiro', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'junie', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'devin', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'vibe', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'hermes', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'omp', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'codebuddy', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'droid', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'qoder', enabled: true, installed: false }),
  ];
  expect(await first).toEqual(expected);
  expect(await second).toEqual(expected);
  expect(f.checked.preflight).toHaveBeenCalledTimes(1);
});

it('answers from the last check unless asked to refresh, and stamps each check with the store clock', async () => {
  const f = setup();
  f.checked.preflight.mockResolvedValueOnce(found('2.0.0')).mockResolvedValueOnce(found('2.1.0'));
  const checkedAt = new Date(f.now()).toISOString();
  expect(await f.control.runtimeStatus(user)).toEqual([
    expect.objectContaining({ runtime: 'fixture' }),
    {
      capabilities: f.checked.report.capabilities,
      runtime: 'checked',
      unverified_isolation: false,
      enabled: true,
      connection: { connected: true, held_session_count: 0, held_session_ids: [] },
      ...found('2.0.0'),
      checked_at: checkedAt,
    },
    expect.objectContaining({ runtime: 'claude', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'codex', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'opencode', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'grok', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'agy', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'dsh', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'muse', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'cursor', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'copilot', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'gemini', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'kilo', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'cline', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'qwen', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'kimi', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'goose', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'openhands', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'auggie', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'kiro', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'junie', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'devin', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'vibe', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'hermes', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'omp', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'codebuddy', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'droid', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'qoder', enabled: true, installed: false }),
  ]);
  f.advance(60_000);
  expect(await f.control.runtimeStatus(user)).toEqual([
    expect.objectContaining({ runtime: 'fixture' }),
    {
      capabilities: f.checked.report.capabilities,
      runtime: 'checked',
      unverified_isolation: false,
      enabled: true,
      connection: { connected: true, held_session_count: 0, held_session_ids: [] },
      ...found('2.0.0'),
      checked_at: checkedAt,
    },
    expect.objectContaining({ runtime: 'claude', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'codex', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'opencode', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'grok', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'agy', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'dsh', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'muse', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'cursor', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'copilot', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'gemini', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'kilo', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'cline', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'qwen', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'kimi', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'goose', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'openhands', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'auggie', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'kiro', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'junie', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'devin', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'vibe', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'hermes', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'omp', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'codebuddy', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'droid', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'qoder', enabled: true, installed: false }),
  ]);
  expect(f.checked.preflight).toHaveBeenCalledTimes(1);
  expect(await f.control.runtimeStatus(user, true)).toEqual([
    expect.objectContaining({ runtime: 'fixture' }),
    {
      capabilities: f.checked.report.capabilities,
      runtime: 'checked',
      unverified_isolation: false,
      enabled: true,
      connection: { connected: true, held_session_count: 0, held_session_ids: [] },
      ...found('2.1.0'),
      checked_at: new Date(f.now()).toISOString(),
    },
    expect.objectContaining({ runtime: 'claude', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'codex', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'opencode', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'grok', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'agy', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'dsh', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'muse', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'cursor', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'copilot', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'gemini', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'kilo', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'cline', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'qwen', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'kimi', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'goose', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'openhands', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'auggie', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'kiro', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'junie', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'devin', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'vibe', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'hermes', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'omp', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'codebuddy', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'droid', enabled: true, installed: false }),
    expect.objectContaining({ runtime: 'qoder', enabled: true, installed: false }),
  ]);
  expect(f.checked.preflight).toHaveBeenCalledTimes(2);
  expect(() => f.control.runtimeStatus({ id: 'agent', role: 'planner' })).toThrowError(
    expect.objectContaining({ code: 'permission_denied' }),
  );
});

it('reads an unregistered runtime without storing a disconnection or publishing an event', () => {
  const f = setup();
  const cursor = f.store.cursor();
  expect(runtimeConnection(f.ctx, 'missing')).toEqual({
    connected: false,
    held_session_count: 0,
    held_session_ids: [],
  });
  expect(f.ctx.runtimeStatus.has('missing')).toBe(false);
  expect(f.store.cursor()).toBe(cursor);
});

it('reports an uninstalled runtime without storing a disconnection or publishing an event', async () => {
  const f = setup();
  f.checked.preflight.mockResolvedValue({
    ...found('2.0.0'),
    installed: false,
    error: 'binary missing',
  });
  const cursor = f.store.cursor();
  expect(
    (await f.control.runtimeStatus(user)).find((status) => status.runtime === 'checked'),
  ).toMatchObject({
    installed: false,
    connection: { connected: false, held_session_count: 0, held_session_ids: [] },
  });
  expect(runtimeConnection(f.ctx, 'checked')).toEqual({
    connected: false,
    held_session_count: 0,
    held_session_ids: [],
  });
  expect(f.ctx.runtimeStatus.get('checked')?.connection).toBeUndefined();
  expect(f.store.cursor()).toBe(cursor);
});

it.each(['error', 'timeout'] as const)(
  'keeps an installed runtime disconnected after a preflight %s',
  async (failure) => {
    const f = setup();
    f.checked.preflight.mockResolvedValue({
      ...found('2.0.0'),
      ...(failure === 'error'
        ? { error: 'startup failed' }
        : { auth: { state: 'unknown' as const, reason: 'timeout' } }),
    });
    expect(
      (await f.control.runtimeStatus(user)).find((status) => status.runtime === 'checked')
        ?.connection,
    ).toMatchObject({
      connected: false,
      reason: failure === 'error' ? 'startup failed' : 'timeout',
      disconnected_since: new Date(f.now()).toISOString(),
    });
  },
);

it('does not store or publish a connected update for a runtime that was never marked', () => {
  const f = setup();
  const cursor = f.store.cursor();
  updateRuntimeConnection(f.ctx, 'checked', true);
  expect(f.ctx.runtimeStatus.has('checked')).toBe(false);
  expect(f.store.cursor()).toBe(cursor);
});

const RETRY_WAITS = [30_000, 60_000, 120_000, 300_000, 600_000, 600_000];

it('retries a disconnected runtime after 30 s, 1, 2 and 5 min, then every 10 min, and from 30 s again once it connected', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const f = setup();
    f.checked.reconnect.mockRejectedValue(new Error('account/read timed out'));
    updateRuntimeConnection(f.ctx, 'checked', false, 'transport closed');
    let cursor = f.store.cursor();
    for (const [index, wait] of RETRY_WAITS.entries()) {
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(f.checked.reconnect).toHaveBeenCalledTimes(index);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.checked.reconnect).toHaveBeenCalledTimes(index + 1);
      // Only the first failure changes the reason, so only it publishes.
      expect(f.store.cursor() > cursor).toBe(index === 0);
      cursor = f.store.cursor();
    }
    expect(runtimeConnection(f.ctx, 'checked')).toMatchObject({
      connected: false,
      reason: 'account/read timed out',
    });
    f.checked.reconnect.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.checked.reconnect).toHaveBeenCalledTimes(RETRY_WAITS.length + 1);
    expect(runtimeConnection(f.ctx, 'checked').connected).toBe(true);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(f.checked.reconnect).toHaveBeenCalledTimes(RETRY_WAITS.length + 1);
    f.checked.reconnect.mockRejectedValue(new Error('transport closed'));
    updateRuntimeConnection(f.ctx, 'checked', false, 'transport closed');
    await vi.advanceTimersByTimeAsync(29_999);
    expect(f.checked.reconnect).toHaveBeenCalledTimes(RETRY_WAITS.length + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.checked.reconnect).toHaveBeenCalledTimes(RETRY_WAITS.length + 2);
  } finally {
    vi.useRealTimers();
  }
});

it('waits 30 s again after a reconnect the user asked for fails', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const f = setup();
    f.checked.reconnect.mockRejectedValue(new Error('transport closed'));
    updateRuntimeConnection(f.ctx, 'checked', false, 'transport closed');
    await vi.advanceTimersByTimeAsync(30_000 + 50_000);
    expect(f.checked.reconnect).toHaveBeenCalledTimes(1);
    await expect(reconnectRuntime(f.ctx, user, 'checked')).rejects.toThrow(
      'checked: transport closed',
    );
    expect(f.checked.reconnect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(f.checked.reconnect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.checked.reconnect).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});

it('keeps retrying on its own after a reconnect the user asked for cannot read the config', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const f = setup();
    f.checked.reconnect.mockRejectedValue(new Error('transport closed'));
    updateRuntimeConnection(f.ctx, 'checked', false, 'transport closed');
    writeFileSync(path.join(f.root, 'config.json'), '{');
    await expect(reconnectRuntime(f.ctx, user, 'checked')).rejects.toThrow();
    rmSync(path.join(f.root, 'config.json'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.checked.reconnect).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it('starts a retry only after the runtime changes queued before it end', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const f = setup();
    f.checked.reconnect.mockRejectedValue(new Error('transport closed'));
    updateRuntimeConnection(f.ctx, 'checked', false, 'transport closed');
    let release!: () => void;
    const change = f.ctx.runtimeChange(() => new Promise<void>((done) => (release = done)));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.checked.reconnect).not.toHaveBeenCalled();
    release();
    await change;
    await vi.advanceTimersByTimeAsync(0);
    expect(f.checked.reconnect).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it('does not register an adapter a retry found after the daemon began to stop', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const f = setup();
    let found!: (adapter: unknown) => void;
    const create = vi.fn(() => new Promise((done) => (found = done)));
    Object.assign(f.ctx, { createRuntimeAdapter: create });
    updateRuntimeConnection(f.ctx, 'codex', false, 'codex is not installed');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(create).toHaveBeenCalledTimes(1);
    f.ctx.closing = true;
    const cursor = f.store.cursor();
    found({ name: 'codex', report: f.checked.report, reconnect: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.ctx.adapters.has('codex')).toBe(false);
    expect(f.store.cursor()).toBe(cursor);
  } finally {
    vi.useRealTimers();
  }
});

it('does not start a retry for a runtime that disconnects while the daemon stops', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const f = setup();
    f.ctx.closing = true;
    const timers = vi.getTimerCount();
    updateRuntimeConnection(f.ctx, 'checked', false, 'transport closed');
    expect(vi.getTimerCount()).toBe(timers);
  } finally {
    vi.useRealTimers();
  }
});

it('reads the preflight again once a runtime it found uninstalled reconnects', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const f = setup();
    f.checked.preflight.mockResolvedValue({ ...found('1.0.0'), installed: false });
    await refreshRuntimeStatus(f.ctx);
    f.checked.preflight.mockResolvedValue(found('1.0.0'));
    f.checked.reconnect.mockResolvedValue(undefined);
    updateRuntimeConnection(f.ctx, 'checked', false, 'checked is not installed');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runtimeConnection(f.ctx, 'checked').connected).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it('does not retry a disabled runtime on its own', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const f = setup({ version: 1, runtimes: { checked: { enabled: false } } });
    f.checked.reconnect.mockRejectedValue(new Error('transport closed'));
    updateRuntimeConnection(f.ctx, 'checked', false, 'transport closed');
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(f.checked.reconnect).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it('retries again after a runtime whose status was reset reconnected on its own and then disconnects', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const f = setup();
    updateRuntimeConnection(f.ctx, 'checked', false, 'transport closed');
    // Setting a runtime's config forgets its status.
    f.ctx.runtimeStatus.delete('checked');
    f.checked.reconnect.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.checked.reconnect).toHaveBeenCalledTimes(1);
    f.checked.reconnect.mockRejectedValue(new Error('transport closed'));
    updateRuntimeConnection(f.ctx, 'checked', false, 'transport closed');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.checked.reconnect).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it('keeps retrying at the next wait when the config cannot be read at a retry', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const f = setup();
    f.checked.reconnect.mockRejectedValue(new Error('transport closed'));
    updateRuntimeConnection(f.ctx, 'checked', false, 'transport closed');
    writeFileSync(path.join(f.root, 'config.json'), '{');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.checked.reconnect).not.toHaveBeenCalled();
    rmSync(path.join(f.root, 'config.json'));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(f.checked.reconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.checked.reconnect).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it('finds the adapter of a known runtime again at a retry, and never retries an unknown name', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const f = setup();
    const reconnect = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn(async (_runtime: string) => ({
      name: 'codex',
      report: f.checked.report,
      reconnect,
    }));
    Object.assign(f.ctx, { createRuntimeAdapter: create });
    // An upgrade removed the binary, so the daemon holds no adapter for it.
    updateRuntimeConnection(f.ctx, 'codex', false, 'codex is not installed');
    updateRuntimeConnection(f.ctx, 'codx', false, 'Unknown runtime codx');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(create.mock.calls.map(([runtime]) => runtime)).toEqual(['codex']);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(f.ctx.runtimeStatus.get('codex')?.connection?.connected).toBe(true);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(create).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
