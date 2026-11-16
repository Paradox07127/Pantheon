import { expect, it, vi } from 'vitest';
import type { Principal, Session, SessionSpec } from '@pantheon/domain';
import { command } from '@pantheon/protocol';
import { awaitWorkspaceReady, eventually } from '../helpers.js';
import { agentEvent } from '../../packages/control/src/agent.js';
import { openWorktreeSession } from '../../packages/control/src/workbench-session.js';
import type { ControlContext } from '../../packages/control/src/context.js';
import { workbenchFixture } from './workbench-fixture.js';

const current = (f: ReturnType<typeof workbenchFixture>, id: string) =>
  f.store.must<Session>('sessions', id);
const context = (f: ReturnType<typeof workbenchFixture>) =>
  (f.control as unknown as { ctx: ControlContext }).ctx;
const lead: Principal = { id: 'lead', role: 'lead' };

it.each([['codex', 'auto']] as const)('refuses %s creation with %s', (runtime, permission_mode) => {
  const f = workbenchFixture();
  f.control.adapters.set(runtime, f.adapter);
  expect(() =>
    f.call('session.create', {
      project_id: f.project.id,
      runtime,
      permission_mode,
      input: 'Work',
    }),
  ).toThrow(expect.objectContaining({ code: 'unsupported_capability' }));
});

it.each([
  ['claude', 'auto', null],
  ['claude', 'full_access', null],
  ['codex', 'full_access', 'auto'],
  ['dsh', 'full_access', 'auto'],
] as const)(
  'lets the user create and select %s %s and refuses non-user choices',
  (runtime, permission_mode, refused) => {
    const f = workbenchFixture();
    f.control.adapters.set(runtime, f.adapter);
    const input = { project_id: f.project.id, runtime, permission_mode, input: 'Work' };
    expect(() => f.call('session.create', input, null, lead)).toThrow(
      expect.objectContaining({ code: 'unsupported_capability' }),
    );
    expect(() => openWorktreeSession(context(f), input, '', undefined, lead)).toThrow(
      expect.objectContaining({ code: 'unsupported_capability' }),
    );
    const session = f.call<Session>('session.create', input);
    expect(session.permission_mode).toBe(permission_mode);
    expect(() =>
      f.call(
        'session.setPermissionMode',
        { session_id: session.id, permission_mode },
        session.revision,
        lead,
      ),
    ).toThrow(expect.objectContaining({ code: 'unsupported_capability' }));
    expect(
      f.call<Session>(
        'session.setPermissionMode',
        { session_id: session.id, permission_mode },
        session.revision,
      ).permission_mode,
    ).toBe(permission_mode);
    if (refused)
      expect(() =>
        f.call(
          'session.setPermissionMode',
          { session_id: session.id, permission_mode: refused },
          current(f, session.id).revision,
        ),
      ).toThrow(expect.objectContaining({ code: 'unsupported_capability' }));
  },
);

it('creates, changes and clears fast mode while projecting runtime state', async () => {
  const f = workbenchFixture({ delay: 400 });
  const modes = ['plan', 'ask', 'auto_edit'] as const;
  vi.spyOn(f.adapter, 'models').mockResolvedValue([
    {
      id: 'fixture',
      label: 'Fixture',
      efforts: [],
      default_effort: null,
      default: true,
      permission_modes: [...modes],
      fast: true,
    },
    {
      id: 'standard',
      label: 'Standard',
      efforts: [],
      default_effort: null,
      default: false,
      permission_modes: [...modes],
    },
  ]);
  const setFastMode = vi.fn(async () => ({ ok: true }));
  const setModel = vi.fn(async () => ({ ok: true }));
  Object.assign(f.adapter, { setFastMode, setModel });
  const session = await f.call<Promise<Session>>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    model: 'fixture',
    fast: true,
    input: 'Work',
  });
  expect(session.fast).toBe(true);
  expect(f.list().find((row) => row.id === session.id)?.fast_mode).toEqual({ on: true });
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.turns(session.id)[0]?.state === 'running' && f.control.handles.size > 0,
    () => f.control.tick(),
  );
  expect(f.start.mock.calls[0]![0] as SessionSpec).toMatchObject({ fast: true });
  for (const fast of [false, true]) {
    const changed = await f.call<Promise<Session>>(
      'session.setFastMode',
      { session_id: session.id, fast },
      current(f, session.id).revision,
    );
    expect(changed.fast).toBe(fast ? true : undefined);
    expect(f.list().find((row) => row.id === session.id)?.fast_mode).toEqual({ on: fast });
    await eventually(() => setFastMode.mock.calls.length === (fast ? 2 : 1));
    expect(setFastMode).toHaveBeenLastCalledWith(
      expect.objectContaining({ platform_session_id: session.id }),
      fast,
    );
  }
  agentEvent(context(f), session.id, {
    key: 'fast-status',
    provider_sequence: 1,
    kind: 'fast_mode.changed',
    state: 'cooldown',
    reason: 'rate_limit',
  });
  expect(f.list().find((row) => row.id === session.id)?.fast_mode).toEqual({
    on: true,
    state: 'cooldown',
    reason: 'rate_limit',
  });
  agentEvent(context(f), session.id, {
    key: 'fast-on',
    provider_sequence: 2,
    kind: 'fast_mode.changed',
    state: 'on',
  });
  expect(f.list().find((row) => row.id === session.id)?.fast_mode).toEqual({
    on: true,
    state: 'on',
  });
  await f.call<Promise<Session>>(
    'session.setModel',
    { session_id: session.id, model: 'standard' },
    current(f, session.id).revision,
  );
  expect(current(f, session.id).fast).toBeUndefined();
  expect(f.list().find((row) => row.id === session.id)).not.toHaveProperty('fast_mode');
  await eventually(() => setModel.mock.calls.length > 0);
  expect(setModel).toHaveBeenLastCalledWith(expect.anything(), 'standard', undefined, false);
  await expect(
    f.call<Promise<Session>>(
      'session.setFastMode',
      { session_id: session.id, fast: true },
      current(f, session.id).revision,
    ),
  ).rejects.toMatchObject({ code: 'unsupported_capability' });
  await expect(
    f.call<Promise<Session>>('session.create', {
      project_id: f.project.id,
      runtime: f.adapter.name,
      model: 'standard',
      fast: true,
      input: 'Work',
    }),
  ).rejects.toMatchObject({ code: 'unsupported_capability' });
});

it('refuses fast mode from a session principal', () => {
  const f = workbenchFixture();
  const session = f.create();
  expect(() =>
    f.control.execute(
      lead,
      command(
        lead.id,
        'session.setFastMode',
        { session_id: session.id, fast: true },
        session.revision,
      ),
    ),
  ).toThrow(expect.objectContaining({ code: 'unsupported_capability' }));
  expect(() =>
    f.call(
      'session.create',
      { project_id: f.project.id, runtime: f.adapter.name, fast: true, input: 'Work' },
      null,
      lead,
    ),
  ).toThrow(expect.objectContaining({ code: 'unsupported_capability' }));
});

it('turns ultracode on and off in a Claude session and passes it to the native session', async () => {
  const f = workbenchFixture({ delay: 400 });
  f.control.adapters.set('claude', f.adapter);
  const setUltracode = vi.fn(async () => ({ ok: true }));
  Object.assign(f.adapter, { setUltracode });
  const session = f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: 'claude',
    ultracode: true,
    input: 'Work',
  });
  expect(session.ultracode).toBe(true);
  expect(f.list().find((row) => row.id === session.id)?.ultracode).toBe(true);
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.turns(session.id)[0]?.state === 'running' && f.control.handles.size > 0,
    () => f.control.tick(),
  );
  expect(f.start.mock.calls[0]![0] as SessionSpec).toMatchObject({ ultracode: true });
  expect(() =>
    f.call(
      'session.setUltracode',
      { session_id: session.id, ultracode: false },
      current(f, session.id).revision,
      lead,
    ),
  ).toThrow(expect.objectContaining({ code: 'unsupported_capability' }));
  const off = f.call<Session>(
    'session.setUltracode',
    { session_id: session.id, ultracode: false },
    current(f, session.id).revision,
  );
  expect(off.ultracode).toBeUndefined();
  expect(f.list().find((row) => row.id === session.id)?.ultracode).toBe(false);
  await eventually(() => setUltracode.mock.calls.length === 1);
  expect(setUltracode).toHaveBeenLastCalledWith(
    expect.objectContaining({ platform_session_id: session.id }),
    false,
  );
});

it('refuses ultracode outside a Claude session', () => {
  const f = workbenchFixture();
  expect(() =>
    f.call('session.create', {
      project_id: f.project.id,
      runtime: f.adapter.name,
      ultracode: true,
      input: 'Work',
    }),
  ).toThrow(expect.objectContaining({ code: 'unsupported_capability' }));
  const session = f.create();
  expect(f.list().find((row) => row.id === session.id)).not.toHaveProperty('ultracode');
  expect(() =>
    f.call(
      'session.setUltracode',
      { session_id: session.id, ultracode: true },
      current(f, session.id).revision,
    ),
  ).toThrow(expect.objectContaining({ code: 'unsupported_capability' }));
});
