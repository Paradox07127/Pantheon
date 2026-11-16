import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type {
  AgentEventSink,
  Session,
  SessionHandle,
  SessionSpec,
  SessionTurn,
} from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, fixture, user } from '../helpers.js';
import { git } from './workbench-fixture.js';

const backendKey = 'sk-relay-secret-for-backend-tests';
const keyVariable = 'PANTHEON_TEST_BACKEND_KEY';

const userConfig = {
  version: 1,
  backends: [
    {
      id: 'relay',
      protocol: 'anthropic',
      base_url: 'https://relay.example.invalid/anthropic',
      key: { env: keyVariable },
    },
    {
      id: 'second-relay',
      protocol: 'anthropic',
      base_url: 'https://second.example.invalid/anthropic',
      key: { env: keyVariable },
    },
    {
      id: 'gemini-relay',
      protocol: 'gemini',
      base_url: 'https://gemini.example.invalid',
      key: { env: keyVariable },
    },
    {
      id: 'keychain-relay',
      protocol: 'openai-responses',
      base_url: 'https://keychain.example.invalid/v1',
      key: { keychain: 'pantheon-test-relay' },
      models: ['fixture-a', 'fixture-b'],
    },
  ],
  model_families: { 'fixture-': 'fixture' },
};

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.unstubAllEnvs();
});

/** Records the spec of every native start and resume. */
class RecordingAdapter extends FixtureAdapter {
  launches: { kind: 'start' | 'resume'; spec: SessionSpec }[] = [];
  override async start(spec: SessionSpec, emit: AgentEventSink): Promise<SessionHandle> {
    this.launches.push({ kind: 'start', spec });
    return super.resume(spec, randomUUID(), emit);
  }
  override async resume(
    spec: SessionSpec,
    nativeSessionId: string,
    emit: AgentEventSink,
  ): Promise<SessionHandle> {
    this.launches.push({ kind: 'resume', spec });
    return super.resume(spec, nativeSessionId, emit);
  }
}

function setup(delay = 40) {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'pantheon-user-config-'));
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(userConfig));
  const adapter = new RecordingAdapter(delay);
  const f = fixture({
    adapter,
    managedWorkspaces: true,
    controlOptions: { userConfigDir: configDir, readProcess: () => undefined },
  });
  cleanup.push(async () => {
    await f.close();
    rmSync(configDir, { recursive: true, force: true });
  });
  git(f.projectRoot, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(path.join(f.projectRoot, 'README.md'), 'fixture\n');
  git(f.projectRoot, 'add', '.');
  git(f.projectRoot, 'commit', '--quiet', '-m', 'Initial files');
  const create = (input: Record<string, unknown>) =>
    f.call<Session>('session.create', {
      project_id: f.project.id,
      input: 'Work through the backend',
      ...input,
    });
  const turns = (session: Session) =>
    f.store.list<SessionTurn>('session_turns').filter((turn) => turn.session_id === session.id);
  const settled = async (session: Session, state: SessionTurn['state'] = 'completed') => {
    await awaitWorkspaceReady(f.control, session.workspace_id!);
    await eventually(
      () => turns(session).at(-1)!.state === state,
      () => f.control.tick(),
    );
  };
  const live = (session: Session) =>
    [...f.control.handles.values()].some((handle) => handle.platform_session_id === session.id);
  const revision = (session: Session) => f.store.must<Session>('sessions', session.id).revision;
  return { f, adapter, configDir, create, turns, settled, live, revision };
}

it('hands the user configuration directory to the native session', async () => {
  const { adapter, configDir, create, settled } = setup();
  const session = create({ runtime: 'fixture' });
  await settled(session);
  expect(adapter.launches[0]!.spec.user_config_dir).toBe(configDir);
});

it('starts a session on the chosen backend and keeps its key out of the database', async () => {
  vi.stubEnv(keyVariable, backendKey);
  const { f, adapter, create, settled } = setup();
  const session = create({ runtime: 'fixture', backend: 'relay' });
  expect(session.backend_id).toBe('relay');
  await settled(session);
  expect(adapter.launches).toHaveLength(1);
  expect(adapter.launches[0]!.spec.backend).toEqual({
    id: 'relay',
    protocol: 'anthropic',
    base_url: 'https://relay.example.invalid/anthropic',
    api_key: backendKey,
  });
  const tables = f.store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[];
  expect(tables.map((table) => table.name)).toContain('events');
  for (const { name } of tables)
    for (const row of f.store.db.prepare(`SELECT * FROM "${name}"`).all())
      expect(JSON.stringify(row)).not.toContain(backendKey);
});

it('refuses a backend the configuration lacks or the runtime cannot send to', () => {
  const { create } = setup();
  expect(() => create({ runtime: 'fixture', backend: 'missing' })).toThrow(
    expect.objectContaining({ code: 'invalid_input', message: 'Unknown backend missing' }),
  );
  expect(() => create({ runtime: 'fixture', backend: 'gemini-relay' })).toThrow(
    expect.objectContaining({
      code: 'unsupported_capability',
      message: 'Runtime fixture cannot send to a gemini backend',
    }),
  );
});

it('lists the configured backends with the runtimes that can send to each, never the key', () => {
  vi.stubEnv(keyVariable, backendKey);
  const { f } = setup();
  const listed = f.control.backendList(user);
  expect(listed).toEqual([
    {
      id: 'relay',
      protocol: 'anthropic',
      base_url: 'https://relay.example.invalid/anthropic',
      models: [],
      runtimes: ['fixture'],
      key: { env: keyVariable },
      key_present: true,
    },
    {
      id: 'second-relay',
      protocol: 'anthropic',
      base_url: 'https://second.example.invalid/anthropic',
      models: [],
      runtimes: ['fixture'],
      key: { env: keyVariable },
      key_present: true,
    },
    {
      id: 'gemini-relay',
      protocol: 'gemini',
      base_url: 'https://gemini.example.invalid',
      models: [],
      runtimes: [],
      key: { env: keyVariable },
      key_present: true,
    },
    {
      id: 'keychain-relay',
      protocol: 'openai-responses',
      base_url: 'https://keychain.example.invalid/v1',
      models: ['fixture-a', 'fixture-b'],
      runtimes: ['fixture'],
      key: { keychain: 'pantheon-test-relay' },
    },
  ]);
  expect(JSON.stringify(listed)).not.toContain(backendKey);
  vi.stubEnv(keyVariable, undefined);
  expect(f.control.backendList(user).map((backend) => backend.key_present)).toEqual([
    false,
    false,
    false,
    undefined,
  ]);
});

it('lists backends only to the user', () => {
  const { f } = setup();
  expect(() => f.control.backendList({ id: 'agent', role: 'planner' })).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
});

it('shows the backend of a session in the session list until it is cleared', async () => {
  vi.stubEnv(keyVariable, backendKey);
  const { f, create, settled, revision } = setup();
  const session = create({ runtime: 'fixture', backend: 'relay' });
  await settled(session);
  const listed = () => f.control.sessionList(user, f.project.id).find((s) => s.id === session.id)!;
  expect(listed().backend_id).toBe('relay');
  f.call('session.setBackend', { session_id: session.id, backend: null }, revision(session));
  expect(listed()).not.toHaveProperty('backend_id');
});

it('takes the runtime from the model family when none is given', () => {
  const { create } = setup();
  const session = create({ model: 'fixture-x' });
  expect(session).toMatchObject({ runtime: 'fixture', requested_model: 'fixture-x' });
  const missing = expect.objectContaining({
    code: 'invalid_input',
    message: 'Give a runtime, or a model whose family names one',
  });
  expect(() => create({ model: 'mystery-model' })).toThrow(missing);
  expect(() => create({})).toThrow(missing);
});

it('turns fast mode off when the model on the new backend has none', async () => {
  vi.stubEnv(keyVariable, backendKey);
  const { f, adapter, settled, revision } = setup();
  vi.spyOn(adapter, 'models').mockResolvedValue([
    {
      id: 'fixture',
      label: 'Fixture',
      efforts: [],
      default_effort: null,
      default: true,
      permission_modes: ['plan', 'ask', 'auto_edit'],
      fast: true,
    },
  ]);
  const session = await f.call<Promise<Session>>('session.create', {
    project_id: f.project.id,
    runtime: 'fixture',
    model: 'fixture',
    fast: true,
    input: 'Work fast',
  });
  expect(session.fast).toBe(true);
  await settled(session);
  const changed = await f.call<Promise<Session>>(
    'session.setBackend',
    { session_id: session.id, backend: 'relay', model: 'relay-model' },
    revision(session),
  );
  expect(changed).toMatchObject({ backend_id: 'relay', requested_model: 'relay-model' });
  expect(changed.fast).toBeUndefined();
});

it('switches the backend between turns and resumes the native session on it', async () => {
  vi.stubEnv(keyVariable, backendKey);
  const { f, adapter, create, settled, live, revision } = setup();
  const session = create({ runtime: 'fixture', backend: 'relay' });
  await settled(session);
  expect(live(session)).toBe(true);
  const changed = f.call<Session>(
    'session.setBackend',
    { session_id: session.id, backend: 'second-relay', model: 'fixture-next' },
    revision(session),
  );
  expect(changed).toMatchObject({ backend_id: 'second-relay', requested_model: 'fixture-next' });
  expect(f.store.must<Session>('sessions', session.id)).not.toHaveProperty('reported_model');
  expect(
    f.store
      .events(0, undefined, 10000)
      .filter((event) => event.kind === 'session.backend_changed')
      .map((event) => event.payload),
  ).toEqual([{ backend: 'second-relay', model: 'fixture-next' }]);
  await eventually(
    () => !live(session),
    () => f.control.tick(),
  );
  const send = () =>
    f.call('session.send', { session_id: session.id, input: 'Continue' }, revision(session));
  send();
  await settled(session);
  expect(adapter.launches.map((launch) => launch.kind)).toEqual(['start', 'resume']);
  expect(adapter.launches[1]!.spec).toMatchObject({
    model: 'fixture-next',
    backend: { id: 'second-relay', api_key: backendKey },
  });
  const cleared = f.call<Session>(
    'session.setBackend',
    { session_id: session.id, backend: null },
    revision(session),
  );
  expect(cleared).not.toHaveProperty('backend_id');
  await eventually(
    () => !live(session),
    () => f.control.tick(),
  );
  send();
  await settled(session);
  expect(adapter.launches.map((launch) => launch.kind)).toEqual(['start', 'resume', 'resume']);
  expect(adapter.launches[2]!.spec).not.toHaveProperty('backend');
});

it('takes the effort chosen with the backend and keeps the stored one when none is given', async () => {
  vi.stubEnv(keyVariable, backendKey);
  const { f, create, settled, revision } = setup();
  const session = create({ runtime: 'fixture', backend: 'relay', effort: 'low' });
  await settled(session);
  const changed = f.call<Session>(
    'session.setBackend',
    { session_id: session.id, backend: 'second-relay', model: 'fixture-next', effort: 'high' },
    revision(session),
  );
  expect(changed).toMatchObject({ backend_id: 'second-relay', requested_effort: 'high' });
  const kept = f.call<Session>(
    'session.setBackend',
    { session_id: session.id, backend: 'relay' },
    revision(session),
  );
  expect(kept).toMatchObject({ backend_id: 'relay', requested_effort: 'high' });
  expect(
    f.store
      .events(0, undefined, 10000)
      .filter((event) => event.kind === 'session.backend_changed')
      .map((event) => event.payload),
  ).toEqual([
    { backend: 'second-relay', model: 'fixture-next', effort: 'high' },
    { backend: 'relay', model: null },
  ]);
});

it('refuses a backend for a session on a remote device and still clears one', async () => {
  vi.stubEnv(keyVariable, backendKey);
  const { f, create, settled, revision } = setup();
  const session = create({ runtime: 'fixture' });
  await settled(session);
  const idle = f.store.must<Session>('sessions', session.id);
  f.store.update<Session>('sessions', { ...idle, device_id: 'build-box' }, idle.revision);
  expect(() =>
    f.call('session.setBackend', { session_id: session.id, backend: 'relay' }, revision(session)),
  ).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  expect(f.store.must<Session>('sessions', session.id).backend_id).toBeUndefined();
  f.call('session.setBackend', { session_id: session.id, backend: null }, revision(session));
});

it('refuses to switch the backend during a turn', async () => {
  vi.stubEnv(keyVariable, backendKey);
  const { f, create, settled, revision } = setup(1000);
  const session = create({ runtime: 'fixture', backend: 'relay' });
  await settled(session, 'running');
  expect(() =>
    f.call(
      'session.setBackend',
      { session_id: session.id, backend: 'second-relay' },
      revision(session),
    ),
  ).toThrow(
    expect.objectContaining({ code: 'invalid_state', message: 'Change the backend between turns' }),
  );
  expect(f.store.must<Session>('sessions', session.id).backend_id).toBe('relay');
});

it('fails the turn with the reason when the backend key is not set', async () => {
  vi.stubEnv(keyVariable, undefined);
  const { adapter, create, settled, turns } = setup();
  const session = create({ runtime: 'fixture', backend: 'relay' });
  await settled(session, 'failed');
  expect(adapter.launches).toHaveLength(0);
  expect(turns(session)[0]!.delivery_reason).toMatch(/backend_key_missing|environment variable/);
});
