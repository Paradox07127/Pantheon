import { expect, it, vi } from 'vitest';
import type { AgentEventSink, HarnessAdapter, Session, SessionTurn } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

it.each(['succeeds', 'fails'] as const)(
  'checks a lost session before holding the runtime when the fresh start %s',
  async (outcome) => {
    const f = workbenchFixture();
    let finishCheck!: () => void;
    const checking = new Promise<void>((resolve) => {
      finishCheck = resolve;
    });
    const reconnect = vi
      .fn(async () => {})
      .mockImplementationOnce(async () => {
        await checking;
        if (outcome === 'fails') throw new Error('fresh startup refused');
      });
    Object.assign(f.adapter, { reconnect });
    let finishClose!: () => void;
    const closing = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const originalClose = f.adapter.close.bind(f.adapter);
    const close = vi.spyOn(f.adapter, 'close').mockImplementationOnce(async (handle, deadline) => {
      await closing;
      return originalClose(handle, deadline);
    });
    try {
      const send = vi.spyOn(f.adapter, 'send');
      send.mockImplementationOnce(async (_handle, turn) => ({
        turn_id: turn.turn_id,
        status: 'delivered',
      }));
      const session = f.create('First input');
      await awaitWorkspaceReady(f.control, session.workspace_id!);
      await eventually(
        () => send.mock.calls.length === 1,
        () => f.control.tick(),
      );
      const running = f.turns(session.id)[0]!;
      const queued = f.call<SessionTurn>(
        'session.steer',
        { session_id: session.id, input: 'Held input' },
        f.store.must<Session>('sessions', session.id).revision,
      );
      await f.control.tick();
      const sink: AgentEventSink = f.resume.mock.calls[0]![2];
      sink({
        key: 'lost',
        provider_sequence: 50,
        kind: 'runtime.disconnected',
        reason: 'fixture runtime transport closed',
      });
      sink({
        key: 'failed',
        provider_sequence: 51,
        kind: 'turn.completed',
        turn_id: running.id,
        status: 'failed',
        error: 'fixture runtime transport closed',
      });
      sink({ key: 'exited', provider_sequence: 52, kind: 'session.exited' });
      expect(
        (await f.control.runtimeStatus(user)).find((item) => item.runtime === 'fixture')!
          .connection,
      ).toEqual({ connected: true, held_session_count: 0, held_session_ids: [] });
      await eventually(() => reconnect.mock.calls.length === 1);
      await eventually(() => close.mock.calls.length === 1);
      for (let tick = 0; tick < 3; tick++) {
        await f.control.tick();
        expect(
          (await f.control.runtimeStatus(user)).find((item) => item.runtime === 'fixture')!
            .connection,
        ).toEqual({ connected: true, held_session_count: 0, held_session_ids: [] });
        expect(f.store.must<SessionTurn>('session_turns', queued.id).state).toBe('queued');
        expect(f.store.must<Session>('sessions', session.id).state).not.toBe('closed');
        expect(send).toHaveBeenCalledTimes(1);
      }
      expect(
        f.store
          .events(0, f.project.id, 10000)
          .filter((event) => event.kind === 'runtime.connection_changed'),
      ).toEqual([]);
      const sibling = f.create('Sibling input');
      await awaitWorkspaceReady(f.control, sibling.workspace_id!);
      expect(f.turns(sibling.id)[0]!.state).toBe('queued');
      finishCheck();
      if (outcome === 'fails') {
        await eventually(() =>
          f.store
            .events(0, f.project.id, 10000)
            .some((event) => event.kind === 'runtime.connection_changed'),
        );
        expect(
          (await f.control.runtimeStatus(user)).find((item) => item.runtime === 'fixture')!
            .connection,
        ).toMatchObject({
          connected: false,
          reason: 'fresh startup refused',
          held_session_ids: expect.arrayContaining([session.id, sibling.id]),
          disconnected_since: expect.any(String),
        });
        const events = f.store
          .events(0, f.project.id, 10000)
          .filter((event) => event.kind === 'runtime.connection_changed');
        expect(events).toHaveLength(1);
        expect(events[0]!.payload).toMatchObject({
          runtime: 'fixture',
          connected: false,
          reason: 'fresh startup refused',
        });
        finishClose();
        await eventually(
          () => f.store.must<SessionTurn>('session_turns', running.id).state === 'failed',
        );
        for (let tick = 0; tick < 3; tick++) await f.control.tick();
        expect(f.store.must<SessionTurn>('session_turns', queued.id).state).toBe('queued');
        expect(f.turns(sibling.id)[0]!.state).toBe('queued');
        expect(send).toHaveBeenCalledTimes(1);
        expect(await f.call('runtime.reconnect', { runtime: 'fixture' })).toEqual({
          runtime: 'fixture',
          connected: true,
        });
      } else {
        await f.control.tick();
        expect(send).toHaveBeenCalledTimes(1);
        finishClose();
      }
      await eventually(
        () =>
          f.store.must<SessionTurn>('session_turns', queued.id).state === 'completed' &&
          f.turns(sibling.id)[0]!.state === 'completed',
        () => f.control.tick(),
      );
      expect(f.store.must<SessionTurn>('session_turns', running.id).state).toBe('failed');
      expect(f.store.events(0, f.project.id, 10000)).toContainEqual(
        expect.objectContaining({
          kind: 'turn.failed',
          payload: expect.objectContaining({ error: 'fixture runtime transport closed' }),
        }),
      );
      expect(send.mock.calls.filter((call) => call[1].turn_id === running.id)).toHaveLength(1);
      expect(send.mock.calls.filter((call) => call[1].turn_id === queued.id)).toHaveLength(1);
      expect(reconnect).toHaveBeenCalledTimes(outcome === 'succeeds' ? 1 : 2);
      expect(
        (await f.control.runtimeStatus(user)).find((item) => item.runtime === 'fixture')!
          .connection,
      ).toEqual({ connected: true, held_session_count: 0, held_session_ids: [] });
      expect(
        f.store
          .events(0, f.project.id, 10000)
          .filter((event) => event.kind === 'runtime.connection_changed'),
      ).toHaveLength(outcome === 'succeeds' ? 0 : 2);
    } finally {
      finishCheck();
      finishClose();
    }
  },
);

it('shares one fresh start check between two lost sessions', async () => {
  const f = workbenchFixture();
  let finishCheck!: () => void;
  const checking = new Promise<void>((resolve) => {
    finishCheck = resolve;
  });
  const reconnect = vi.fn(() => checking);
  Object.assign(f.adapter, { reconnect });
  vi.spyOn(f.adapter, 'send').mockImplementation(async (_handle, turn) => ({
    turn_id: turn.turn_id,
    status: 'delivered',
  }));
  try {
    const first = f.create('First session');
    const second = f.create('Second session');
    await awaitWorkspaceReady(f.control, first.workspace_id!);
    await awaitWorkspaceReady(f.control, second.workspace_id!);
    await eventually(
      () => f.resume.mock.calls.length === 2,
      () => f.control.tick(),
    );
    for (const call of f.resume.mock.calls) {
      call[2]({
        key: 'lost',
        provider_sequence: 50,
        kind: 'runtime.disconnected',
        reason: 'session process ended',
      });
      call[2]({
        key: 'failed',
        provider_sequence: 51,
        kind: 'turn.completed',
        turn_id: f.turns(call[0].platform_session_id)[0]!.id,
        status: 'failed',
        error: 'session process ended',
      });
      await Promise.resolve();
    }
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(
      (await f.control.runtimeStatus(user)).find((item) => item.runtime === 'fixture')!.connection
        ?.connected,
    ).toBe(true);
  } finally {
    finishCheck();
  }
});

it('reports a reconnect failure with its runtime and reason', async () => {
  const f = workbenchFixture();
  Object.assign(f.adapter, {
    reconnect: vi.fn(async () => {
      throw new Error('startup refused');
    }),
  });
  await expect(f.call('runtime.reconnect', { runtime: 'fixture' })).rejects.toThrow(
    'fixture: startup refused',
  );
  expect(
    (await f.control.runtimeStatus(user)).find((item) => item.runtime === 'fixture')!.connection,
  ).toMatchObject({ connected: false, reason: 'startup refused' });
});

it('queries reporting and unsupported MCP runtimes and rejects unsupported reconnect', async () => {
  const f = workbenchFixture();
  const reported = [
    { name: 'files', state: 'connected' },
    { name: 'search', state: 'failed', reason: 'connection refused' },
    { name: 'account', state: 'needs_sign_in' },
  ];
  Object.assign(f.adapter, { mcpStatus: vi.fn(async () => reported) });
  expect(await f.control.mcpStatus(user, { project_id: f.project.id, runtime: 'fixture' })).toEqual(
    { runtime: 'fixture', reconnect_available: false, servers: reported },
  );
  const session = f.create();
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.control.handles.size > 0,
    () => f.control.tick(),
  );
  expect(await f.control.mcpStatus(user, { session_id: session.id })).toEqual({
    runtime: 'fixture',
    reconnect_available: false,
    servers: reported,
  });
  delete (f.adapter as HarnessAdapter).mcpStatus;
  expect(await f.control.mcpStatus(user, { session_id: session.id })).toEqual({
    runtime: 'fixture',
    reconnect_available: false,
  });
  await expect(
    f.call('mcp.reconnect', { session_id: session.id, server: 'files' }),
  ).rejects.toThrow('fixture does not support reconnecting MCP servers');
});

it('reconnects an MCP server through a supporting live session adapter', async () => {
  const f = workbenchFixture();
  const reconnectMcp = vi.fn(async () => {});
  Object.assign(f.adapter, { reconnectMcp });
  const session = f.create();
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.control.handles.size > 0,
    () => f.control.tick(),
  );
  expect(await f.control.mcpStatus(user, { session_id: session.id })).toEqual({
    runtime: 'fixture',
    reconnect_available: true,
  });
  expect(await f.call('mcp.reconnect', { session_id: session.id, server: 'files' })).toEqual({
    runtime: 'fixture',
    server: 'files',
    reconnected: true,
  });
  expect(reconnectMcp).toHaveBeenCalledWith('files', [...f.control.handles.values()][0]);
});

it.each([false, true])(
  'fails an undelivered first turn without marking the runtime when reconnect is available: %s',
  async (supportsReconnect) => {
    const f = workbenchFixture();
    const reconnect = vi.fn(async () => {});
    if (supportsReconnect) Object.assign(f.adapter, { reconnect });
    f.start.mockRejectedValueOnce(new Error('fixture could not start'));
    const session = f.create();
    await awaitWorkspaceReady(f.control, session.workspace_id!);
    await eventually(
      () => f.start.mock.calls.length > 0,
      () => f.control.tick(),
    );
    expect(f.turns(session.id)[0]).toMatchObject({ state: 'failed', delivery: 'failed' });
    if (supportsReconnect) await eventually(() => reconnect.mock.calls.length === 1);
    expect(
      (await f.control.runtimeStatus(user)).find((item) => item.runtime === 'fixture')!.connection,
    ).toEqual({ connected: true, held_session_count: 0, held_session_ids: [] });
    expect(
      f.store
        .events(0, f.project.id, 10000)
        .filter((event) => event.kind === 'runtime.connection_changed'),
    ).toEqual([]);
    expect(reconnect).toHaveBeenCalledTimes(supportsReconnect ? 1 : 0);
    expect(f.start).toHaveBeenCalledTimes(1);
  },
);
