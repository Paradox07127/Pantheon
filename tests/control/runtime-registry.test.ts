import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AcpAdapter, acpProfiles, FixtureAdapter } from '@pantheon/adapters';
import type { HarnessAdapter, Session, SessionTurn } from '@pantheon/domain';
import { command } from '@pantheon/protocol';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { awaitWorkspaceReady, eventually, fixture, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

it('lists ACP capabilities and unknown login alongside every native preflight field', async () => {
  const f = await fixture();
  cleanups.push(f.close);
  const grok = new AcpAdapter({ name: 'grok', profile: acpProfiles.grok!, version: '1.0.77' });
  const native = {
    installed: false,
    version: null,
    min_version: '2.0.0',
    version_ok: null,
    auth: { state: 'logged_out' as const, reason: 'Sign in first' },
    error: 'Login required',
  };
  f.control.adapters.set('grok', grok);
  f.control.adapters.set(
    'claude',
    Object.assign(new FixtureAdapter(), {
      name: 'claude',
      preflight: async () => native,
    }),
  );
  const statuses = await f.control.runtimeStatus(user, true);
  expect(statuses.map((status) => status.runtime)).toEqual([
    'fixture',
    'grok',
    'claude',
    'codex',
    'opencode',
    'agy',
    'dsh',
    'muse',
    'cursor',
    'copilot',
    'gemini',
    'kilo',
    'cline',
    'qwen',
    'kimi',
    'goose',
    'openhands',
    'auggie',
    'kiro',
    'junie',
    'devin',
    'vibe',
    'hermes',
    'omp',
    'codebuddy',
    'droid',
    'qoder',
  ]);
  expect(statuses[1]).toMatchObject({
    runtime: 'grok',
    version: '1.0.77',
    installed: true,
    auth: { state: 'unknown' },
    capabilities: grok.report.capabilities,
  });
  expect(statuses[2]).toMatchObject(native);
});

it('reports the ACP handshake of each enabled ACP-profile runtime, and a failed one disconnects nothing', async () => {
  const f = await fixture();
  cleanups.push(f.close);
  const answered = Object.assign(
    new AcpAdapter({ name: 'grok', profile: acpProfiles.grok!, version: '1.0.77' }),
    { reconnect: async () => {} },
  );
  const refused = Object.assign(
    new AcpAdapter({ name: 'cursor', profile: acpProfiles.cursor!, version: '2026.1' }),
    {
      reconnect: async () => {
        throw new Error('Protocol transport closed');
      },
    },
  );
  f.control.adapters.set('grok', answered);
  f.control.adapters.set('cursor', refused);
  const statuses = await f.control.runtimeStatus(user, true);
  const of = (runtime: string) => statuses.find((status) => status.runtime === runtime)!;
  expect(of('grok')).toMatchObject({ installed: true, handshake: true });
  expect(of('cursor')).toMatchObject({
    installed: true,
    handshake: false,
    connection: { connected: true },
  });
  expect(of('gemini')).toMatchObject({ installed: false, handshake: false });
  expect(of('fixture')).not.toHaveProperty('handshake');
  expect(of('claude')).not.toHaveProperty('handshake');
});

it('waits for an ACP handshake still running instead of reporting it failed', async () => {
  const f = await fixture();
  cleanups.push(f.close);
  let answer = () => {};
  const grok = Object.assign(
    new AcpAdapter({ name: 'grok', profile: acpProfiles.grok!, version: '1.0.77' }),
    { reconnect: () => new Promise<void>((resolve) => (answer = resolve)) },
  );
  f.control.adapters.set('grok', grok);
  // As at daemon start: one preflight has answered while the handshake still runs.
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  ctx.runtimeStatus.set('claude', { runtime: 'claude', checked_at: new Date().toISOString() });
  const refresh = f.control.refreshRuntimeStatus();
  const read = f.control.runtimeStatus(user, false);
  answer();
  await refresh;
  expect((await read).find((status) => status.runtime === 'grok')).toMatchObject({
    handshake: true,
  });
});

it('records a changed ACP handshake in each project, so the interface reads the status again', async () => {
  const f = await fixture();
  cleanups.push(f.close);
  let answers = false;
  const grok = Object.assign(
    new AcpAdapter({ name: 'grok', profile: acpProfiles.grok!, version: '1.0.77' }),
    {
      reconnect: async () => {
        if (!answers) throw new Error('RPC timeout: initialize');
      },
    },
  );
  f.control.adapters.set('grok', grok);
  const grokOf = async () =>
    (await f.control.runtimeStatus(user, true)).find((status) => status.runtime === 'grok');
  const changed = () =>
    f.store
      .events(0, f.project.id)
      .filter((event) => event.kind === 'runtime.handshake_changed')
      .map((event) => event.payload);
  expect(await grokOf()).toMatchObject({ handshake: false });
  expect(changed()).toEqual([]);
  answers = true;
  expect(await grokOf()).toMatchObject({ handshake: true });
  expect(changed()).toEqual([{ runtime: 'grok', handshake: true }]);
});

it('finds a runtime installed after the start only when the status is checked again', async () => {
  let installed = false;
  const createRuntimeAdapter = vi.fn(async (runtime: string) =>
    installed && runtime === 'grok'
      ? new AcpAdapter({ name: 'grok', profile: acpProfiles.grok!, version: '1.0.77' })
      : undefined,
  );
  const directory = mkdtempSync(path.join(process.cwd(), 'node_modules/.cache/runtime-detect-'));
  writeFileSync(
    path.join(directory, 'config.json'),
    JSON.stringify({ version: 1, runtimes: { agy: { enabled: false } } }),
  );
  const f = await fixture({ controlOptions: { userConfigDir: directory, createRuntimeAdapter } });
  cleanups.push(async () => {
    await f.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const grok = async (refresh: boolean) =>
    (await f.control.runtimeStatus(user, refresh)).find((status) => status.runtime === 'grok');
  expect(await grok(false)).toMatchObject({ installed: false });
  installed = true;
  expect(await grok(false)).toMatchObject({ installed: false });
  expect(createRuntimeAdapter).not.toHaveBeenCalled();
  expect(await grok(true)).toMatchObject({
    installed: true,
    version: '1.0.77',
    connection: { connected: true },
  });
  expect(createRuntimeAdapter.mock.calls.map(([runtime]) => runtime)).not.toContain('agy');
});

it('persists runtime patches, swaps or removes adapters, and refuses unknown names and agents', async () => {
  const replacement = Object.assign(new FixtureAdapter(), { name: 'grok' });
  const createRuntimeAdapter = vi.fn(async (): Promise<HarnessAdapter | undefined> => replacement);
  const directory = mkdtempSync(path.join(process.cwd(), 'node_modules/.cache/runtime-config-'));
  const f = await fixture({ controlOptions: { userConfigDir: directory, createRuntimeAdapter } });
  cleanups.push(async () => {
    await f.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, 'config.json');
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      auto_git_init: false,
      model_families: { 'grok-': 'grok' },
      runtimes: { codex: { args: ['--verbose'] }, grok: { binary: '/old/grok', args: ['old'] } },
    }),
  );
  const set = (input: Record<string, unknown>) =>
    f.control.execute(user, command(user.id, 'runtime.config.set', input));
  await set({ runtime: 'grok', binary: '/new/grok', args: ['--verbose'] });
  expect(createRuntimeAdapter).toHaveBeenLastCalledWith('grok', {
    binary: '/new/grok',
    args: ['--verbose'],
  });
  expect(f.control.adapters.get('grok')).toBe(replacement);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
    version: 1,
    auto_git_init: false,
    model_families: { 'grok-': 'grok' },
    runtimes: {
      codex: { args: ['--verbose'] },
      grok: { binary: '/new/grok', args: ['--verbose'] },
    },
  });
  await set({ runtime: 'grok', enabled: false });
  expect(f.control.adapters.has('grok')).toBe(false);
  await set({ runtime: 'grok', enabled: true });
  expect(f.control.adapters.get('grok')).toBe(replacement);
  const before = readFileSync(file, 'utf8');
  await expect(async () => set({ runtime: 'invented' })).rejects.toThrow(
    /Unknown runtime.*invented/,
  );
  await expect(async () =>
    f.control.execute(
      { id: 'agent', role: 'planner' },
      command('agent', 'runtime.config.set', { runtime: 'grok', enabled: false }),
    ),
  ).rejects.toMatchObject({ code: 'permission_denied' });
  createRuntimeAdapter.mockRejectedValueOnce(new Error('Invalid arguments'));
  await expect(async () => set({ runtime: 'grok', args: ['invalid'] })).rejects.toThrow(
    'Invalid arguments',
  );
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(f.control.adapters.get('grok')).toBe(replacement);
});

it('keeps a running session on its starting adapter after replacement and disabling', async () => {
  const f = await workbenchFixture();
  const original = f.adapter;
  const interrupt = vi.spyOn(original, 'interrupt');
  const session = await f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: 'fixture',
    input: 'fixture-script\n[{"hang":true}]',
  });
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.store
        .list<SessionTurn>('session_turns')
        .some((turn) => turn.session_id === session.id && turn.state === 'running'),
    () => f.control.tick(),
  );
  f.control.adapters.set('fixture', new FixtureAdapter());
  f.call(
    'session.interrupt',
    { session_id: session.id },
    f.store.must<Session>('sessions', session.id).revision,
  );
  await eventually(() => interrupt.mock.calls.length === 1);
  await eventually(() => f.store.must<Session>('sessions', session.id).state === 'open');
  f.control.adapters.delete('fixture');
  const send = vi.spyOn(original, 'send');
  f.call(
    'session.send',
    { session_id: session.id, input: 'fixture-script\n[{"say":"still on original"}]' },
    f.store.must<Session>('sessions', session.id).revision,
  );
  await eventually(
    () => send.mock.calls.length === 1,
    () => f.control.tick(),
  );
  await eventually(
    () =>
      f.store
        .list<SessionTurn>('session_turns')
        .filter((turn) => turn.session_id === session.id)
        .every((turn) => turn.state !== 'running'),
    () => f.control.tick(),
  );
  expect(send.mock.calls[0]![1].input).toContain('still on original');
});
