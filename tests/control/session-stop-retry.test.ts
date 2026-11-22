import { expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type {
  AgentEvent,
  AgentEventSink,
  CancelReceipt,
  HarnessAdapter,
  Session,
  SessionHandle,
  SessionSpec,
  SessionTurn,
  UserTurn,
} from '@pantheon/domain';
import { eventually, fixture } from '../helpers.js';

function controlledAdapter() {
  const sinks = new Map<SessionHandle, AgentEventSink>(),
    turns = new Map<SessionHandle, UserTurn>();
  let sequence = 0;
  const emit = (handle: SessionHandle, event: AgentEvent) => sinks.get(handle)!(event);
  // A failed turn closes a conversation process; a completed one keeps it for the next input.
  const complete = (
    handle: SessionHandle,
    status: 'completed' | 'failed' | 'interrupted' = 'completed',
  ) => {
    const turn = turns.get(handle);
    if (!turn) return;
    turns.delete(handle);
    emit(handle, {
      key: String(++sequence),
      provider_sequence: sequence,
      kind: 'turn.completed',
      turn_id: turn.turn_id,
      status,
    });
  };
  const receipt = (stopped: boolean, deadline: number): CancelReceipt => ({
    stopped,
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
  const close = vi.fn(async (_handle: SessionHandle, deadline: number) => receipt(true, deadline)),
    cancel = vi.fn(async (handle: SessionHandle, deadline: number) => {
      complete(handle, 'interrupted');
      return receipt(true, deadline);
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
    async send(handle, turn) {
      turns.set(handle, turn);
      return { turn_id: turn.turn_id, status: 'delivered' };
    },
    async answerPermission() {
      return { ok: false };
    },
    close,
    cancel,
  };
  return { adapter, start, close, cancel, receipt, complete, emit };
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

/** A tick starts stop retries without waiting for them, and a retry's write audit runs git. */
const retries = (f: Awaited<ReturnType<typeof fixture>>) =>
  Promise.all([...f.control['ctx'].completions]);

function send(f: Awaited<ReturnType<typeof fixture>>, session: Session) {
  return f.call<SessionTurn>(
    'session.send',
    { session_id: session.id, input: 'Continue the conversation' },
    f.store.must<Session>('sessions', session.id).revision,
  );
}

it('records one unconfirmed-stop event while retries keep failing', async () => {
  const stub = controlledAdapter(),
    f = await fixture({ adapter: stub.adapter, now: () => 100000 });
  stub.close.mockImplementation(async (_handle, deadline) => stub.receipt(false, deadline));
  try {
    const session = open(f),
      turn = send(f, session);
    await f.control.tick();
    stub.complete(f.control.handles.get(turn.id)!, 'failed');
    await eventually(() => f.store.must<Session>('sessions', session.id).stop_pending === true);
    for (let i = 0; i < 20; i++) await f.control.tick();
    expect(
      f.store.events().filter((event) => event.kind === 'session.stop_unconfirmed'),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it('keeps scheduling while a pending stop hangs', async () => {
  const stub = controlledAdapter(),
    f = await fixture({ adapter: stub.adapter, now: () => 100000 });
  let hang = false;
  stub.close.mockImplementation(async (_handle, deadline) =>
    hang ? new Promise<CancelReceipt>(() => {}) : stub.receipt(false, deadline),
  );
  try {
    const session = open(f),
      turn = send(f, session);
    await f.control.tick();
    stub.complete(f.control.handles.get(turn.id)!, 'failed');
    await eventually(() => f.store.must<Session>('sessions', session.id).stop_pending === true);
    hang = true;
    const started = Date.now();
    await f.control.tick();
    expect(Date.now() - started).toBeLessThan(1000);
  } finally {
    await f.close();
  }
}, 30000);

it('spaces stop retries without rewriting the session and records confirmation once', async () => {
  let now = 100000;
  const stub = controlledAdapter(),
    f = await fixture({ adapter: stub.adapter, now: () => now });
  stub.close.mockImplementation(async (_handle, deadline) => stub.receipt(false, deadline));
  try {
    const session = open(f),
      turn = send(f, session);
    await f.control.tick();
    stub.complete(f.control.handles.get(turn.id)!, 'failed');
    await eventually(() => f.store.must<Session>('sessions', session.id).stop_pending === true);
    const pending = f.store.must<Session>('sessions', session.id);
    await f.control.tick();
    await retries(f);
    for (let i = 0; i < 19; i++) {
      now += 50;
      await f.control.tick();
    }
    expect(stub.close).toHaveBeenCalledTimes(2);
    expect(f.store.must<Session>('sessions', session.id)).toEqual(pending);
    now += 50;
    stub.close.mockRejectedValueOnce(new Error('Close still unavailable'));
    await f.control.tick();
    await retries(f);
    expect(stub.close).toHaveBeenCalledTimes(3);
    expect(f.store.must<Session>('sessions', session.id)).toEqual(pending);
    expect(
      f.store.events().filter((event) => event.kind === 'session.stop_unconfirmed'),
    ).toHaveLength(1);
    stub.close.mockImplementation(async (_handle, deadline) => stub.receipt(true, deadline));
    now += 1000;
    await f.control.tick();
    await eventually(() => !f.control.handles.has(turn.id));
    expect(f.store.must<Session>('sessions', session.id)).toEqual({
      ...pending,
      revision: pending.revision + 1,
      stop_pending: false,
    });
    now += 1000;
    await f.control.tick();
    expect(stub.close).toHaveBeenCalledTimes(4);
    expect(
      f.store.events().filter((event) => event.kind === 'session.stop_confirmed'),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it('schedules other work during one stop retry and waits for it on shutdown', async () => {
  let now = 100000;
  const stub = controlledAdapter(),
    f = await fixture({ adapter: stub.adapter, now: () => now });
  let release: (() => void) | undefined,
    retryTick: Promise<void> | undefined,
    shutdown: Promise<void> | undefined;
  try {
    const first = send(f, open(f)),
      second = send(f, open(f));
    stub.close.mockImplementation(async (_handle, deadline) => stub.receipt(false, deadline));
    await f.control.tick();
    const firstHandle = f.control.handles.get(first.id)!,
      secondHandle = f.control.handles.get(second.id)!;
    stub.complete(firstHandle, 'failed');
    stub.complete(secondHandle, 'failed');
    await eventually(() =>
      [first, second].every(
        (turn) => f.store.must<Session>('sessions', turn.session_id).stop_pending === true,
      ),
    );
    stub.close.mockImplementation(async (handle, deadline) => {
      if (handle === firstHandle)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return stub.receipt(true, deadline);
    });
    const next = send(f, open(f));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let tickFinished = false;
    retryTick = f.control.tick().then(() => {
      tickFinished = true;
    });
    // The next turn's start and the other retry each run the write audit's git in real time.
    await eventually(
      () => tickFinished && !f.control.handles.has(second.id),
      () => vi.advanceTimersByTimeAsync(0),
    );
    expect(tickFinished).toBe(true);
    expect(f.store.must<SessionTurn>('session_turns', next.id).state).toBe('running');
    expect(f.control.handles.has(second.id)).toBe(false);
    for (let i = 0; i < 5; i++) {
      now += 1000;
      await f.control.tick();
    }
    expect(stub.close.mock.calls.filter(([handle]) => handle === firstHandle)).toHaveLength(2);
    let shutdownFinished = false;
    shutdown = f.control.shutdown().then(() => {
      shutdownFinished = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(shutdownFinished).toBe(false);
    expect(stub.cancel.mock.calls.some(([handle]) => handle === firstHandle)).toBe(false);
    release!();
    await shutdown;
    expect(f.control.handles.size).toBe(0);
    const cursor = f.store.cursor(),
      closes = stub.close.mock.calls.length;
    now += 20000;
    await vi.advanceTimersByTimeAsync(20000);
    await f.control.tick();
    expect(stub.close).toHaveBeenCalledTimes(closes);
    expect(f.store.cursor()).toBe(cursor);
  } finally {
    release?.();
    await retryTick;
    await shutdown;
    vi.useRealTimers();
    await f.close();
  }
});

it('waits for an existing conversation close on shutdown without starting another stop', async () => {
  const stub = controlledAdapter(),
    f = await fixture({ adapter: stub.adapter });
  let release: (() => void) | undefined, shutdown: Promise<void> | undefined;
  stub.close.mockImplementation(async (_handle, deadline) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return stub.receipt(true, deadline);
  });
  try {
    const turn = send(f, open(f));
    await f.control.tick();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stub.complete(f.control.handles.get(turn.id)!, 'failed');
    // The turn's write audit runs git before the close starts.
    await eventually(
      () => release !== undefined,
      () => vi.advanceTimersByTimeAsync(0),
    );
    expect(release).toBeDefined();
    let finished = false;
    shutdown = f.control.shutdown().then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
    expect(stub.cancel).not.toHaveBeenCalled();
    release!();
    await shutdown;
    expect(f.control.handles.size).toBe(0);
    expect(f.store.must<SessionTurn>('session_turns', turn.id).state).toBe('failed');
  } finally {
    release?.();
    await shutdown;
    vi.useRealTimers();
    await f.close();
  }
});
