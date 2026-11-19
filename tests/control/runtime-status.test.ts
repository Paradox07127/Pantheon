import { mkdtempSync, rmSync } from 'node:fs';
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
}

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-runtime-status-'));
  let clock = Date.UTC(2026, 0, 2, 3, 4, 5);
  const store = new Store(path.join(root, 'state/control.sqlite'), () => clock),
    checked = new CheckedAdapter(),
    control = new Control(store, new ArtifactFiles(path.join(root, 'state/artifacts')), [
      new FixtureAdapter(),
      checked,
    ]);
  cleanups.push(async () => {
    await control.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
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
