import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { readProcessIdentity } from '@pantheon/adapters';
import type { Control } from '@pantheon/control';
import type {
  AgentEventSink,
  Project,
  Session,
  SessionHandle,
  SessionTurn,
} from '@pantheon/domain';
import { agentEvent, saveSessionHandle } from '../../packages/control/dist/agent.js';
import { createTurnQueue } from '../../packages/control/dist/session.js';
import { confirmTermination, readProcess } from '../../packages/control/dist/process.js';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { awaitWorkspaceReady, eventually, fixture } from '../helpers.js';

vi.mock('@pantheon/adapters', async (original) => {
  const actual = await original<typeof import('@pantheon/adapters')>();
  return { ...actual, readProcessIdentity: vi.fn(actual.readProcessIdentity) };
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.restoreAllMocks();
});
const context = (control: Control) => (control as unknown as { ctx: ControlContext }).ctx;
function setup() {
  const f = fixture({ now: () => 1700000000000, managedWorkspaces: true });
  cleanups.push(() => f.close());
  // Worktree sessions clone a git root; the fixture's own project root is a plain folder.
  const root = path.join(f.root, 'sessions');
  mkdirSync(root);
  const sessionProject = f.call<Project>('project.open', {
    name: 'Worktree sessions',
    roots: [root],
  });
  return { ...f, sessionProject };
}
/** A worktree session and its queued first turn, which starts once the worktree is ready. */
function conversation(f: ReturnType<typeof setup>) {
  const session = f.call<Session>('session.create', {
    project_id: f.sessionProject.id,
    runtime: f.adapter.name,
    input: 'Work',
  });
  const turn = f.store
    .list<SessionTurn>('session_turns')
    .find((item) => item.session_id === session.id)!;
  return { session, turn };
}
function hold(f: ReturnType<typeof setup>) {
  let sink: AgentEventSink;
  const original = f.adapter.start.bind(f.adapter);
  const start = vi.spyOn(f.adapter, 'start').mockImplementation(async (spec, emit) => {
    sink = emit;
    return original(spec, emit);
  });
  const send = vi
    .spyOn(f.adapter, 'send')
    .mockImplementation(async (_h, turn) => ({ turn_id: turn.turn_id, status: 'delivered' }));
  return { start, send, emit: (event: Parameters<AgentEventSink>[0]) => sink(event) };
}

it('records session startup at the updated aggregate revision', () => {
  const f = setup(),
    { session } = conversation(f);
  agentEvent(context(f.control), session.id, {
    key: 'native-start',
    provider_sequence: 1,
    kind: 'session.started',
    native_session_id: 'native-session',
  });
  expect(f.store.events().at(-1)?.aggregate_revision).toBe(
    f.store.must<Session>('sessions', session.id).revision,
  );
});

it('closes an unconfirmed session when it exits', () => {
  const f = setup(),
    { session, turn } = conversation(f),
    ctx = context(f.control);
  const current = f.store.must<Session>('sessions', session.id);
  f.store.update('sessions', { ...current, stop_pending: true }, current.revision);
  ctx.handles.set(turn.id, {
    platform_session_id: session.id,
    native_session_id: 'native',
    adapter_version: '1',
    device_id: 'local',
  });
  try {
    agentEvent(ctx, session.id, {
      key: 'exit',
      provider_sequence: 2,
      kind: 'session.exited',
      code: 0,
    });
    expect(f.store.must<Session>('sessions', session.id)).toMatchObject({
      state: 'closed',
      stop_pending: false,
    });
  } finally {
    ctx.handles.clear();
  }
});

it('preserves startup diagnostics emitted before the adapter returns', async () => {
  const f = setup(),
    { session } = conversation(f),
    original = f.adapter.start.bind(f.adapter);
  vi.spyOn(f.adapter, 'start').mockImplementation(async (spec, sink) => {
    sink({
      key: 'auth',
      provider_sequence: 1,
      kind: 'auth.checked',
      channel: 'subscription',
      method: 'chatgpt',
    });
    sink({ key: 'notice', provider_sequence: 2, kind: 'native', native: { method: 'ready' } });
    return original(spec, sink);
  });
  const send = vi.spyOn(f.adapter, 'send').mockImplementation(async (_h, turn) => ({
    turn_id: turn.turn_id,
    status: 'delivered',
  }));
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => send.mock.calls.length > 0,
    () => f.control.tick(),
  );
  expect(
    f.store
      .events()
      .filter((e) => e.aggregate_id === session.id)
      .map((e) => e.kind),
  ).toEqual(expect.arrayContaining(['agent.auth.checked', 'agent.native']));
});

it('records a native message delta only once when it is delivered twice', async () => {
  const f = setup(),
    h = hold(f),
    { session, turn } = conversation(f);
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => h.send.mock.calls.length > 0,
    () => f.control.tick(),
  );
  const delta = {
    key: 'delta',
    provider_sequence: 2,
    kind: 'message.delta' as const,
    text: 'once',
    turn_id: turn.id,
  };
  h.emit(delta);
  h.emit(delta);
  h.emit({
    key: 'done',
    provider_sequence: 3,
    kind: 'turn.completed',
    turn_id: turn.id,
    status: 'completed',
  });
  await eventually(() => f.store.must<SessionTurn>('session_turns', turn.id).state === 'completed');
  expect(f.store.events().filter((event) => event.kind === 'agent.message.delta')).toEqual([
    expect.objectContaining({ payload: expect.objectContaining({ text: 'once' }) }),
  ]);
});

it('clears a failed turn error before the next successful queued turn', async () => {
  const f = setup(),
    { turn, session } = conversation(f),
    ctx = context(f.control);
  const next = f.store.insert<SessionTurn>('session_turns', {
    ...turn,
    id: 'next-input',
    revision: 1,
  });
  const queue = createTurnQueue(ctx, turn);
  const handle: SessionHandle = {
    platform_session_id: session.id,
    native_session_id: 'native',
    adapter_version: '1',
    device_id: 'local',
  };
  const send = vi.spyOn(f.adapter, 'send').mockImplementation(async (_h, input) => {
    queue.sink({
      key: input.turn_id,
      provider_sequence: 1,
      turn_id: input.turn_id,
      kind: 'turn.completed',
      status: input.turn_id === turn.id ? 'failed' : 'completed',
      ...(input.turn_id === turn.id ? { error: 'first turn failed' } : {}),
    });
    return { turn_id: input.turn_id, status: 'delivered' };
  });
  await queue.start(f.adapter, handle);
  await eventually(() => f.store.must<SessionTurn>('session_turns', next.id).state === 'completed');
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1]![1].turn_id).toBe(next.id);
  expect(queue.lastState).toBe('completed');
  expect(queue.failure).toBeUndefined();
});

it('refuses a process table observation that could not be read', () => {
  vi.mocked(readProcessIdentity).mockImplementationOnce(() => {
    throw new Error('unreadable');
  });
  expect(() => readProcess(41001)).toThrow(
    expect.objectContaining({ code: 'termination_unconfirmed' }),
  );
});

it.skipIf(process.platform === 'win32')(
  'keeps termination unconfirmed while the group of an exited leader still has members',
  async () => {
    const leader = spawn('/bin/sh', ['-c', 'sleep 30 & exit 0'], {
      detached: true,
      stdio: 'ignore',
    });
    const pid = leader.pid!;
    const groupAlive = () => {
      try {
        process.kill(-pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      await new Promise((resolve) => leader.once('exit', resolve));
      expect(groupAlive()).toBe(true);
      const ctx = { readProcess } as unknown as ControlContext,
        session = { process_identity: { pid, start_time_us: 1 } } as Session;
      expect(() => confirmTermination(ctx, session)).toThrow(
        expect.objectContaining({ code: 'termination_unconfirmed' }),
      );
      process.kill(-pid, 'SIGKILL');
      await eventually(() => !groupAlive());
      expect(() => confirmTermination(ctx, session)).not.toThrow();
    } finally {
      if (groupAlive()) process.kill(-pid, 'SIGKILL');
    }
  },
);

it('enriches a pid-only writer identity while the handle is live', () => {
  const f = setup(),
    { session } = conversation(f),
    ctx = context(f.control);
  const identity = { pid: 41001, start_time_us: 1700000000000000 };
  const read = vi.spyOn(ctx, 'readProcess').mockReturnValue(identity);
  const handle: SessionHandle = {
    platform_session_id: session.id,
    native_session_id: 'native',
    adapter_version: '1',
    device_id: 'local',
    process_identity: { pid: identity.pid },
  };
  saveSessionHandle(ctx, handle);
  saveSessionHandle(ctx, handle);
  expect(f.store.must<Session>('sessions', session.id).process_identity).toEqual(identity);
  expect(read).toHaveBeenCalledOnce();
});
