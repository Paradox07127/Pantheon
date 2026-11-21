import { expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type {
  AgentEventSink,
  CancelReceipt,
  DeliveryReceipt,
  HarnessAdapter,
  Session,
  SessionHandle,
  SessionSpec,
  SessionTurn,
  UserTurn,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { eventually, fixture } from '../helpers.js';

function controlledAdapter() {
  const sinks = new Map<SessionHandle, AgentEventSink>();
  let sequence = 0;
  const receipt = (deadline: number): CancelReceipt => ({
    stopped: true,
    deadline,
    finished_at: new Date().toISOString(),
    evidence: { method: 'none', members: [] },
  });
  const start = vi.fn(async (spec: SessionSpec, sink: AgentEventSink): Promise<SessionHandle> => {
    const handle = {
      platform_session_id: spec.platform_session_id,
      native_session_id: `native-${sinks.size}`,
      adapter_version: '1',
      device_id: 'local',
    };
    sinks.set(handle, sink);
    sink({
      key: String(++sequence),
      provider_sequence: sequence,
      kind: 'session.started',
      native_session_id: handle.native_session_id,
    });
    return handle;
  });
  const send = vi.fn(async (_handle: SessionHandle, turn: UserTurn): Promise<DeliveryReceipt> => ({
    turn_id: turn.turn_id,
    status: 'delivered',
  }));
  const steer = vi.fn(async (_handle: SessionHandle, turn: UserTurn): Promise<DeliveryReceipt> => ({
    turn_id: turn.turn_id,
    status: 'queued',
  }));
  const complete = (
    handle: SessionHandle,
    turnId: string,
    status: 'completed' | 'failed' = 'completed',
  ) =>
    sinks.get(handle)!({
      key: String(++sequence),
      provider_sequence: sequence,
      kind: 'turn.completed',
      turn_id: turnId,
      status,
    });
  const adapter: HarnessAdapter = {
    name: 'fixture',
    report: new FixtureAdapter().report,
    async probe() {
      return this.report;
    },
    start,
    resume: (spec, _nativeId, sink) => start(spec, sink),
    async inspect(handle) {
      return {
        state: 'unknown',
        native_session_id: handle.native_session_id,
        observed_at: new Date().toISOString(),
      };
    },
    send,
    steer,
    async answerPermission() {
      return { ok: false };
    },
    close: async (_handle, deadline) => receipt(deadline),
    cancel: async (_handle, deadline) => receipt(deadline),
  };
  return { adapter, start, send, steer, complete };
}

let opened = 0;
function open(f: Awaited<ReturnType<typeof fixture>>) {
  return f.store.insert<Session>('sessions', {
    id: `conversation-${++opened}`,
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    device_id: 'local',
    state: 'open',
    turn_count: 0,
  });
}

function send(
  f: Awaited<ReturnType<typeof fixture>>,
  session: Session,
  input = 'Continue the conversation',
  type: 'session.send' | 'session.steer' = 'session.send',
) {
  return f.call<SessionTurn>(
    type,
    { session_id: session.id, input },
    f.store.must<Session>('sessions', session.id).revision,
  );
}

const contextOf = (f: Awaited<ReturnType<typeof fixture>>) =>
  (f.control as unknown as { ctx: ControlContext }).ctx;

it('starts no queued session and keeps their inputs pending once shutdown begins', async () => {
  const stub = controlledAdapter(),
    f = await fixture({ adapter: stub.adapter });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = stub.start.getMockImplementation()!;
  stub.start.mockImplementationOnce(async (spec, sink) => {
    await gate;
    return started(spec, sink);
  });
  try {
    const turns = [send(f, open(f)), send(f, open(f)), send(f, open(f))];
    const tick = f.control.tick();
    await eventually(() => stub.start.mock.calls.length === 1);
    const shutdown = f.control.shutdown();
    release();
    await tick;
    await shutdown;
    expect(stub.start).toHaveBeenCalledTimes(1);
    const later = turns.filter(
      (turn) => turn.session_id !== stub.start.mock.calls[0]![0].platform_session_id,
    );
    expect(
      later.map((turn) => {
        const current = f.store.must<SessionTurn>('session_turns', turn.id);
        return [current.state, current.delivery];
      }),
    ).toEqual([
      ['queued', 'pending'],
      ['queued', 'pending'],
    ]);
  } finally {
    release();
    await f.close();
  }
});

it('keeps the interface context for the turn a queued steer becomes', async () => {
  const stub = controlledAdapter(),
    f = await fixture({ adapter: stub.adapter });
  try {
    const session = open(f),
      first = send(f, session);
    await f.control.tick();
    f.call('session.app_context', {
      session_id: session.id,
      server: 'charts',
      content: 'Selected row 42',
    });
    send(f, session, 'Explain this row', 'session.steer');
    await f.control.tick();
    expect(stub.steer).toHaveBeenCalledTimes(1);
    stub.complete(f.control.handles.get(first.id)!, first.id);
    await eventually(() => stub.send.mock.calls.length === 2);
    expect(stub.send.mock.calls[1]![1].input).toBe(
      '<app-context server="charts">\nSelected row 42\n</app-context>\n\nExplain this row',
    );
  } finally {
    await f.close();
  }
});

it('closes the session tool relay once the process is confirmed stopped', async () => {
  const stub = controlledAdapter(),
    f = await fixture({ adapter: stub.adapter });
  try {
    const session = open(f),
      turn = send(f, session);
    await f.control.tick();
    const closeRelay = vi.fn();
    contextOf(f).toolRelays.set(session.id, closeRelay);
    stub.complete(f.control.handles.get(turn.id)!, turn.id, 'failed');
    await eventually(() => !f.control.handles.has(turn.id));
    expect(closeRelay).toHaveBeenCalledTimes(1);
    expect(contextOf(f).toolRelays.has(session.id)).toBe(false);
  } finally {
    await f.close();
  }
});

it('keeps the native conversation of a rolled-back first turn cleared when usage arrives as the idle process closes', async () => {
  const stub = controlledAdapter(),
    f = await fixture({ adapter: stub.adapter });
  stub.adapter.close = async (handle, deadline) => {
    stub.start.mock.calls.find(
      ([spec]) => spec.platform_session_id === handle.platform_session_id,
    )![1]({
      key: 'usage-on-close',
      provider_sequence: 100,
      kind: 'usage.updated',
      cost_source: 'unknown',
      output_tokens: 1,
    });
    return {
      stopped: true,
      deadline,
      finished_at: new Date().toISOString(),
      evidence: { method: 'none', members: [] },
    };
  };
  try {
    const session = open(f),
      turn = send(f, session);
    await f.control.tick();
    stub.complete(f.control.handles.get(turn.id)!, turn.id);
    await eventually(() => contextOf(f).idleConversations.has(session.id));
    expect(f.store.must<Session>('sessions', session.id).native_id).toBe('native-0');
    f.call(
      'session.rollback',
      { session_id: session.id, turn_id: turn.id, scope: 'conversation' },
      f.store.must<Session>('sessions', session.id).revision,
    );
    await eventually(() => !f.control.handles.has(turn.id));
    expect(f.store.must<Session>('sessions', session.id).native_id).toBeUndefined();
  } finally {
    await f.close();
  }
});
