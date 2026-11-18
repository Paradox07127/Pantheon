import { expect, it, vi } from 'vitest';
import { statSync } from 'node:fs';
import path from 'node:path';
import type {
  HarnessAdapter,
  Project,
  Session,
  SessionHandle,
  SessionSpec,
} from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, user, waitOutStatusReuse } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const createWith = (f: Fixture, model: string, effort: string) =>
  f.call<Promise<Session>>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    model,
    effort,
    input: 'Rename the answer file and explain why',
  });

const modelEvents = (f: Fixture) =>
  f.store
    .events(0, undefined, 10000)
    .filter((event) => event.kind.startsWith('session.model_'))
    .map((event) => [event.kind, event.payload]);

async function runningSession(f: Fixture): Promise<Session> {
  const session = await createWith(f, 'fixture', 'low');
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.turns(session.id)[0]!.state === 'running',
    () => f.control.tick(),
  );
  return session;
}

it('starts a session with the requested effort and lists it', async () => {
  const f = await workbenchFixture();
  const session = await createWith(f, 'fixture', 'high');
  expect(session).toMatchObject({ requested_model: 'fixture', requested_effort: 'high' });
  expect(f.list()[0]).toMatchObject({ model: 'fixture', effort: 'high' });
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.start.mock.calls.length > 0,
    () => f.control.tick(),
  );
  expect(f.start.mock.calls[0]![0] as SessionSpec).toMatchObject({
    model: 'fixture',
    effort: 'high',
  });
});

it('stores a new model of a session without a live native session', async () => {
  const f = await workbenchFixture();
  const session = await createWith(f, 'fixture', 'low');
  const reported = f.store.update(
    'sessions',
    { ...f.store.must<Session>('sessions', session.id), reported_model: 'fixture-reported' },
    f.store.must<Session>('sessions', session.id).revision,
  );
  expect(f.list()[0]!.model).toBe('fixture-reported');
  const changed = f.call<Session>(
    'session.setModel',
    { session_id: session.id, model: 'fixture-next', effort: 'high' },
    reported.revision,
  );
  expect(changed).toMatchObject({ requested_model: 'fixture-next', requested_effort: 'high' });
  expect(f.store.must<Session>('sessions', session.id)).not.toHaveProperty('reported_model');
  expect(f.list()[0]).toMatchObject({ model: 'fixture-next', effort: 'high' });
  expect(modelEvents(f)).toEqual([
    ['session.model_changed', { model: 'fixture-next', effort: 'high' }],
  ]);
});

it('records the model a queued turn runs on when the model changed before it started', async () => {
  const f = await workbenchFixture();
  const session = await createWith(f, 'fixture', 'low');
  expect(f.turns(session.id)[0]!.model).toBe('fixture');
  f.call(
    'session.setModel',
    { session_id: session.id, model: 'fixture-next', effort: 'high' },
    f.store.must<Session>('sessions', session.id).revision,
  );
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.turns(session.id)[0]!.state === 'completed',
    () => f.control.tick(),
  );
  expect((f.start.mock.calls[0]![0] as SessionSpec).model).toBe('fixture-next');
  expect(f.turns(session.id)[0]!.model).toBe('fixture-next');
});

it('changes the model of a live native session through the runtime', async () => {
  const f = await workbenchFixture({ delay: 400 });
  const setModel = vi.fn(async () => ({ ok: true }));
  Object.assign(f.adapter, { setModel });
  const session = await runningSession(f);
  f.call(
    'session.setModel',
    { session_id: session.id, model: 'fixture-next', effort: 'high' },
    f.store.must<Session>('sessions', session.id).revision,
  );
  await eventually(() => setModel.mock.calls.length > 0);
  expect(setModel).toHaveBeenCalledWith(
    expect.objectContaining({ platform_session_id: session.id }),
    'fixture-next',
    'high',
  );
});

it('applies a model chosen while the native session was starting', async () => {
  const f = await workbenchFixture({ delay: 400 });
  // Like the native adapters, the handle carries the requested model from the spec and setModel on.
  const setModel = vi.fn(async (handle: SessionHandle, model: string, effort?: string) => {
    Object.assign(handle, { requested_model: model, requested_effort: effort });
    return { ok: true };
  });
  Object.assign(f.adapter, { setModel });
  const release = Promise.withResolvers<void>();
  const start = f.adapter.start.bind(f.adapter);
  f.start.mockImplementationOnce(async (spec, sink) => {
    await release.promise;
    const handle = await start(spec, sink);
    return Object.assign(handle, {
      requested_model: spec.model,
      requested_effort: spec.effort,
    });
  });
  const session = await createWith(f, 'fixture', 'low');
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  // The tick that launches the session waits for the held start.
  const launch = f.control.tick();
  await eventually(() => f.start.mock.calls.length > 0);
  f.call(
    'session.setModel',
    { session_id: session.id, model: 'fixture-next', effort: 'high' },
    f.store.must<Session>('sessions', session.id).revision,
  );
  release.resolve();
  await launch;
  expect(f.store.must<Session>('sessions', session.id)).toMatchObject({
    requested_model: 'fixture-next',
    requested_effort: 'high',
  });
  await eventually(() => setModel.mock.calls.length > 0);
  expect(setModel).toHaveBeenCalledOnce();
  expect(setModel).toHaveBeenCalledWith(
    expect.objectContaining({ platform_session_id: session.id }),
    'fixture-next',
    'high',
  );
});

it('restores the previous model when the runtime refuses the new one', async () => {
  const f = await workbenchFixture({ delay: 400 });
  const setModel = vi.fn(async () => ({ ok: false, reason: 'native refused' }));
  Object.assign(f.adapter, { setModel });
  const session = await runningSession(f);
  f.call(
    'session.setModel',
    { session_id: session.id, model: 'fixture-next', effort: 'high' },
    f.store.must<Session>('sessions', session.id).revision,
  );
  await eventually(
    () => f.store.must<Session>('sessions', session.id).requested_model === 'fixture',
  );
  expect(f.store.must<Session>('sessions', session.id).requested_effort).toBe('low');
  expect(modelEvents(f)).toEqual([
    ['session.model_changed', { model: 'fixture-next', effort: 'high' }],
    ['session.model_failed', { error: 'native refused' }],
    ['session.model_changed', { model: 'fixture', effort: 'low' }],
  ]);
});

it('refuses a model the runtime cannot apply to a running turn', async () => {
  const f = await workbenchFixture({ delay: 400 });
  const adapter: HarnessAdapter = f.adapter;
  expect(adapter.setModel).toBeUndefined();
  const session = await runningSession(f);
  expect(() =>
    f.call(
      'session.setModel',
      { session_id: session.id, model: 'fixture-next' },
      f.store.must<Session>('sessions', session.id).revision,
    ),
  ).toThrow(expect.objectContaining({ code: 'unsupported_capability' }));
  expect(f.store.must<Session>('sessions', session.id)).toMatchObject({
    requested_model: 'fixture',
    requested_effort: 'low',
  });
});

it('lists the models of a runtime', async () => {
  const f = await workbenchFixture();
  expect(await f.control.runtimeModels(user, f.project.id, f.adapter.name)).toEqual([
    {
      id: 'fixture',
      label: 'Fixture',
      permission_modes: ['plan', 'ask', 'auto_edit'],
      efforts: ['low', 'high'],
      default_effort: 'low',
      default: true,
    },
  ]);
});

it('lists the models of a runtime for the personal home, which has no roots, in the personal agent folder', async () => {
  const f = await workbenchFixture();
  const home = f.store.transaction(() =>
    f.store.insert<Project>('projects', {
      id: 'personal-home',
      revision: 1,
      name: 'Personal',
      roots: [],
      kind: 'personal',
    }),
  );
  const models = vi.spyOn(f.adapter, 'models');
  await f.control.runtimeModels(user, home.id, f.adapter.name);
  const cwd = models.mock.calls[0]![0];
  expect(path.basename(cwd)).toBe('personal-agent');
  expect(statSync(cwd).isDirectory()).toBe(true);
});

it('reads the branch and commit at the project HEAD', async () => {
  const f = await workbenchFixture();
  const sha = git(f.source, 'rev-parse', 'HEAD');
  expect(await f.control.projectHead(user, f.project.id)).toEqual({
    branch: 'main',
    sha,
    subject: 'Initial files',
    committed_at: Number(git(f.source, 'log', '-1', '--format=%ct')) * 1000,
    uncommitted: 0,
  });
  git(f.source, 'checkout', '--quiet', '--detach');
  waitOutStatusReuse();
  expect(await f.control.projectHead(user, f.project.id)).toEqual({
    branch: null,
    sha,
    subject: 'Initial files',
    committed_at: Number(git(f.source, 'log', '-1', '--format=%ct')) * 1000,
    uncommitted: 0,
  });
});
