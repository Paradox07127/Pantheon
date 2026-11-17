import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { acpProfiles, FixtureAdapter } from '@pantheon/adapters';
import { command } from '@pantheon/protocol';
import { fixture, user } from '../helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(runtimes: Record<string, unknown>) {
  const directory = mkdtempSync(path.join(process.cwd(), 'node_modules/.cache/status-config-'));
  writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ version: 1, runtimes }));
  const adapter = Object.assign(new FixtureAdapter(), { name: 'grok' });
  const createRuntimeAdapter = vi.fn(async () => adapter);
  const f = await fixture({ controlOptions: { userConfigDir: directory, createRuntimeAdapter } });
  cleanups.push(async () => {
    await f.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { ...f, adapter, createRuntimeAdapter };
}

it('lists registered, configured and ACP runtimes once, including disabled configuration', async () => {
  const f = await setup({
    claude: { enabled: false, binary: '/configured/claude', args: ['--verbose'] },
    codex: { binary: '/missing/codex', args: [] },
  });
  const statuses = await f.control.runtimeStatus(user);
  expect(statuses.map((s) => s.runtime).sort()).toEqual(
    [...new Set(['fixture', 'claude', 'codex', ...Object.keys(acpProfiles)])].sort(),
  );
  expect(statuses.find((s) => s.runtime === 'claude')).toMatchObject({
    enabled: false,
    binary: '/configured/claude',
    args: ['--verbose'],
  });
  expect(statuses.find((s) => s.runtime === 'claude')?.capabilities).toBeUndefined();
  expect(statuses.find((s) => s.runtime === 'codex')).toMatchObject({
    enabled: true,
    installed: false,
    binary: '/missing/codex',
    args: [],
  });
  expect(statuses.find((s) => s.runtime === 'agy')).toMatchObject({
    enabled: true,
    installed: false,
  });
});

it('keeps saved paths and arguments in status through disabling and re-enabling an adapter', async () => {
  const f = await setup({ grok: { binary: '/configured/grok', args: ['agent', 'stdio'] } });
  f.control.adapters.set('grok', f.adapter);
  await f.control.runtimeStatus(user, true);
  const set = (enabled: boolean) =>
    f.control.execute(user, command(user.id, 'runtime.config.set', { runtime: 'grok', enabled }));
  await set(false);
  expect(f.control.adapters.has('grok')).toBe(false);
  expect(
    (await f.control.runtimeStatus(user, true)).find((s) => s.runtime === 'grok'),
  ).toMatchObject({
    enabled: false,
    binary: '/configured/grok',
    args: ['agent', 'stdio'],
  });
  expect(
    (await f.control.runtimeStatus(user)).find((s) => s.runtime === 'grok')?.capabilities,
  ).toBeUndefined();
  expect(f.createRuntimeAdapter).not.toHaveBeenCalledWith('grok', expect.anything());
  await set(true);
  expect((await f.control.runtimeStatus(user)).find((s) => s.runtime === 'grok')).toMatchObject({
    enabled: true,
    binary: '/configured/grok',
    args: ['agent', 'stdio'],
    capabilities: f.adapter.report.capabilities,
  });
});
