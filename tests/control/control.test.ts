import { describe, it, expect, vi } from 'vitest';
import { existsSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { command } from '@pantheon/protocol';
import { Store } from '@pantheon/store';
import { FixtureAdapter } from '@pantheon/adapters';
import type {
  AgentEvent,
  AgentEventSink,
  CancelReceipt,
  HarnessAdapter,
  SessionHandle,
  Workspace,
  Project,
  Session,
  SessionTurn,
} from '@pantheon/domain';
import { fixture, user, eventually, registerWorkspace } from '../helpers.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Worktree sessions in a git project beside the fixture's plain-folder one; needs managed workspaces. */
async function sessions(f: Fixture) {
  const root = path.join(f.root, 'sessions');
  mkdirSync(root);
  const project = await f.call<Project>('project.open', {
    name: 'Worktree sessions',
    roots: [root],
  });
  const create = (input = 'Discuss') =>
    f.call<Promise<Session>>('session.create', {
      project_id: project.id,
      runtime: f.adapter.name,
      input,
    });
  return { project, create };
}

/** Provisions the session's worktree; the queued first turn starts only on a later tick. */
async function ready(f: Fixture, session: Session) {
  await f.control.tick();
  await eventually(
    () =>
      f.store.must<Workspace>('workspaces', session.workspace_id!).provisioning?.state === 'ready',
  );
}

async function conversation(f: Fixture) {
  const session = await (await sessions(f)).create();
  await ready(f, session);
  const turn = f.store
    .list<SessionTurn>('session_turns')
    .find((item) => item.session_id === session.id)!;
  return { session, turn };
}

describe('transactional control', () => {
  it('deduplicates 100 session create commands and rejects altered input', async () => {
    const f = await fixture({ managedWorkspaces: true });
    try {
      const { project } = await sessions(f);
      const c = command(user.id, 'session.create', {
        project_id: project.id,
        runtime: f.adapter.name,
        input: 'Discuss',
      });
      const receipts = await Promise.all(
        Array.from({ length: 100 }, async () => f.control.execute(user, c) as Session),
      );
      expect(new Set(receipts.map((r) => r.id)).size).toBe(1);
      expect(f.store.list('sessions')).toHaveLength(1);
      expect(() =>
        f.control.execute(user, { ...c, input: { ...c.input, input: 'Different' } }),
      ).toThrow(/different input/);
    } finally {
      await f.close();
    }
  });
  it('gives adapters a real-time stop deadline when the store clock runs ahead', async () => {
    const f = await fixture({ now: () => Date.now() + 100 * 60000, managedWorkspaces: true });
    try {
      const cancel = vi.spyOn(f.adapter, 'cancel');
      await conversation(f);
      await f.control.tick();
      await f.control.shutdown();
      expect(cancel).toHaveBeenCalled();
      expect(cancel.mock.calls[0]![1] - Date.now()).toBeLessThanOrEqual(10000);
    } finally {
      await f.close();
    }
  });
  it('reaches the turn start failpoint', async () => {
    const reached: string[] = [],
      f = await fixture({ failpoint: (name) => reached.push(name), managedWorkspaces: true });
    try {
      await conversation(f);
      await f.control.tick();
      expect(reached).toContain('during_turn_start');
    } finally {
      await f.close();
    }
  });
  it('rolls back state, events, receipts and outbox together', async () => {
    let fail = false;
    const f = await fixture({
      failpoint: () => {
        if (fail) throw new Error('injected crash');
      },
      managedWorkspaces: true,
    });
    try {
      const { create } = await sessions(f);
      const before = f.store.cursor();
      fail = true;
      await expect(create()).rejects.toThrow('injected crash');
      expect(f.store.list('sessions')).toHaveLength(0);
      expect(f.store.pending()).toHaveLength(0);
      expect(f.store.cursor()).toBe(before);
      fail = false;
      expect((await create()).state).toBe('running');
    } finally {
      await f.close();
    }
  });
  it('rejects symlink scope escapes', async () => {
    const f = await fixture();
    try {
      const outside = path.join(f.root, 'outside');
      mkdirSync(outside);
      const link = path.join(f.projectRoot, 'escape');
      symlinkSync(outside, link);
      expect(() =>
        registerWorkspace(f.control, {
          project_id: f.project.id,
          kind: 'linked_worktree',
          source: link,
          base_ref: 'HEAD',
        }),
      ).toThrow(/outside project/);
    } finally {
      await f.close();
    }
  });
  it('denies a spoofed actor identity', async () => {
    const f = await fixture({ managedWorkspaces: true });
    try {
      const { project } = await sessions(f);
      const worker = {
        id: 'worker',
        role: 'planner' as const,
        project_id: f.project.id,
      };
      expect(() =>
        f.control.execute(
          worker,
          command(user.id, 'session.create', {
            project_id: project.id,
            runtime: f.adapter.name,
            input: 'Discuss',
          }),
        ),
      ).toThrow(/Actor/);
    } finally {
      await f.close();
    }
  });
  it('does not admit a project containing the control plane directory', async () => {
    const f = await fixture();
    try {
      expect(() => f.call('project.open', { name: 'too broad', roots: [f.root] })).toThrow(
        /control database/,
      );
    } finally {
      await f.close();
    }
  });
});
describe('execution and ownership', () => {
  it('supports a conversation over several turns', async () => {
    const f = await fixture({ managedWorkspaces: true });
    try {
      const { session: created, turn } = await conversation(f);
      await eventually(
        () => f.store.must<SessionTurn>('session_turns', turn.id).state === 'completed',
        () => f.control.tick(),
      );
      const session = f.store.must<Session>('sessions', created.id);
      const second = f.call<SessionTurn>(
        'session.send',
        { session_id: session.id, input: 'Continue' },
        session.revision,
      );
      await eventually(
        () => f.store.must<SessionTurn>('session_turns', second.id).state === 'completed',
        () => f.control.tick(),
      );
    } finally {
      await f.close();
    }
  });
});
it('enforces a conversation wall-clock limit without claiming completion', async () => {
  const adapter = new FixtureAdapter(1000),
    start = adapter.start.bind(adapter);
  vi.spyOn(adapter, 'start').mockImplementation((spec, sink) =>
    start({ ...spec, budget: { ...spec.budget, wall_time_ms: 30 } }, sink),
  );
  const f = await fixture({ adapter, managedWorkspaces: true });
  try {
    const { session, turn } = await conversation(f);
    await eventually(
      () => f.store.must<SessionTurn>('session_turns', turn.id).state === 'failed',
      () => f.control.tick(),
    );
    expect(f.store.must<Session>('sessions', session.id).state).toBe('open');
  } finally {
    await f.close();
  }
});

describe('storage boundaries', () => {
  it('retains monotonic event history across database reopen', async () => {
    const f = await fixture();
    try {
      const events = f.store.events();
      const db = new Store(f.store.file);
      expect(db.events()).toEqual(events);
      db.close();
      expect(events.map((e) => e.sequence)).toEqual(
        [...events.map((e) => e.sequence)].sort((a, b) => a - b),
      );
    } finally {
      await f.close();
    }
  });
  it('detects missing or modified artifacts and collects only orphan content', async () => {
    const f = await fixture();
    try {
      const a = f.files.put(Buffer.from('expected')),
        b = f.files.put(Buffer.from('orphan'));
      expect(f.files.valid(a.hash)).toBe(true);
      writeFileSync(a.uri, 'tampered');
      expect(f.files.valid(a.hash)).toBe(false);
      expect(f.files.collect(new Set([a.hash]))).toBe(1);
      expect(existsSync(b.uri)).toBe(false);
    } finally {
      await f.close();
    }
  });
});

function controlledAdapter() {
  let sink: AgentEventSink,
    turnId: string | undefined,
    sequence = 0;
  const receipt = (stopped = true, deadline = Date.now() + 10000): CancelReceipt => ({
    stopped,
    deadline,
    finished_at: new Date().toISOString(),
    evidence: { method: 'none', members: [] },
    reason: stopped ? undefined : 'Stop was not observed',
  });
  const complete = (
    status: Extract<AgentEvent, { kind: 'turn.completed' }>['status'],
    error?: string,
  ) => {
    if (!turnId) return;
    const turn_id = turnId;
    turnId = undefined;
    sink({
      key: String(++sequence),
      provider_sequence: sequence,
      kind: 'turn.completed',
      turn_id,
      status,
      error,
    });
  };
  const adapter: HarnessAdapter = {
    name: 'fixture',
    report: new FixtureAdapter().report,
    async probe() {
      return this.report;
    },
    async start(spec, emit) {
      sink = emit;
      return {
        platform_session_id: spec.platform_session_id,
        native_session_id: `controlled-${spec.platform_session_id}`,
        adapter_version: '1',
        device_id: 'local',
      };
    },
    async inspect(handle) {
      return {
        state: 'unknown',
        native_session_id: handle.native_session_id,
        observed_at: new Date().toISOString(),
      };
    },
    async send(_handle, turn) {
      turnId = turn.turn_id;
      return { turn_id: turnId, status: 'delivered' };
    },
    async answerPermission() {
      return { ok: false };
    },
    close: vi.fn(async (_handle: SessionHandle, deadline: number) => receipt(true, deadline)),
    cancel: vi.fn(async (_handle: SessionHandle, deadline: number) => {
      complete('interrupted');
      return receipt(true, deadline);
    }),
  };
  return { adapter, receipt, complete };
}

function eventFixtureAdapter() {
  const adapter = new FixtureAdapter(),
    sinks = new Map<SessionHandle, AgentEventSink>(),
    resume = adapter.resume.bind(adapter);
  vi.spyOn(adapter, 'resume').mockImplementation(async (spec, nativeId, sink) => {
    const handle = await resume(spec, nativeId, sink);
    sinks.set(handle, sink);
    return handle;
  });
  vi.spyOn(adapter, 'send').mockImplementation(async (_handle, turn) => ({
    turn_id: turn.turn_id,
    status: 'delivered',
  }));
  return {
    adapter,
    emit(handle: SessionHandle, event: AgentEvent) {
      sinks.get(handle)!(event);
    },
  };
}

describe('reconciliation and late accounting', () => {
  it('records late usage without changing the old conversation result', async () => {
    const stub = eventFixtureAdapter(),
      f = await fixture({ adapter: stub.adapter, managedWorkspaces: true });
    try {
      const { session: created, turn } = await conversation(f);
      await f.control.tick();
      const key = turn.id,
        handle = f.control.handles.get(key)!,
        usage: AgentEvent = {
          key: 'on-time-usage',
          provider_sequence: 2,
          turn_id: key,
          kind: 'usage.updated',
          cost_usd: 0.11,
          cost_source: 'provider_reported',
        };
      stub.emit(handle, usage);
      stub.emit(handle, {
        key: 'completion',
        provider_sequence: 3,
        turn_id: key,
        kind: 'turn.completed',
        status: 'failed',
        error: 'Original result',
      });
      const closingUsage: AgentEvent = {
        ...usage,
        key: 'closing-usage',
        provider_sequence: 4,
        cost_usd: 0.13,
      };
      stub.emit(handle, closingUsage);
      await eventually(() => !f.control.handles.has(key));
      const session = f.store.must<Session>('sessions', created.id);
      f.call('session.send', { session_id: session.id, input: 'Continue' }, session.revision);
      await f.control.tick();
      const owner = f.store.must<Workspace>('workspaces', created.workspace_id!),
        oldResult = f.store.must<SessionTurn>('session_turns', key),
        lateUsage: AgentEvent = {
          ...usage,
          key: 'late-usage',
          provider_sequence: 5,
          cost_usd: 0.37,
        };
      for (const event of [usage, closingUsage, lateUsage, lateUsage]) stub.emit(handle, event);
      stub.emit(handle, {
        key: 'late-message',
        provider_sequence: 6,
        turn_id: key,
        kind: 'message.delta',
        text: 'Stale output',
      });
      stub.emit(handle, {
        key: 'late-completion',
        provider_sequence: 7,
        turn_id: key,
        kind: 'turn.completed',
        status: 'completed',
      });
      await f.control.tick();
      const result = f.store.must<SessionTurn>('session_turns', key);
      // Late usage still counts toward the old record's totals; only its outcome must not change.
      expect({ ...result, usage: undefined, revision: 0 }).toEqual({
        ...oldResult,
        usage: undefined,
        revision: 0,
      });
      expect(result.usage?.cost_usd).toBe(0.37);
      expect(f.store.must<Workspace>('workspaces', created.workspace_id!)).toEqual(owner);
      expect(f.store.events().some((e) => e.kind === 'agent.message.delta')).toBe(false);
    } finally {
      await f.close();
    }
  });
});

describe('conversation termination', () => {
  it('fails an interrupted conversation turn', async () => {
    const stub = controlledAdapter(),
      f = await fixture({ adapter: stub.adapter, managedWorkspaces: true });
    try {
      const { turn } = await conversation(f);
      await f.control.tick();
      stub.complete('interrupted');
      await eventually(() => f.control.handles.size === 0);
      expect(f.store.must<SessionTurn>('session_turns', turn.id).state).toBe('failed');
    } finally {
      await f.close();
    }
  });

  it('preserves a failed conversation completion error in its event', async () => {
    const stub = controlledAdapter(),
      f = await fixture({ adapter: stub.adapter, managedWorkspaces: true });
    try {
      const { turn } = await conversation(f);
      await f.control.tick();
      stub.complete('failed', 'conversation provider error');
      await eventually(() => f.control.handles.size === 0);
      expect(
        f.store.events().find((e) => e.kind === 'turn.failed' && e.aggregate_id === turn.id)
          ?.payload,
      ).toMatchObject({ error: 'conversation provider error' });
    } finally {
      await f.close();
    }
  });

  it('records an unconfirmed conversation close receipt while leaving its session open', async () => {
    const stub = controlledAdapter(),
      stop = stub.receipt(false);
    vi.mocked(stub.adapter.close).mockResolvedValue(stop);
    const f = await fixture({ adapter: stub.adapter, managedWorkspaces: true });
    try {
      const { session, turn } = await conversation(f);
      await f.control.tick();
      // A completed turn keeps the process for the next input; a failed one closes it.
      stub.complete('failed');
      await eventually(
        () =>
          f.control.handles.size === 1 &&
          f.store.must<Session>('sessions', session.id).state === 'open',
      );
      expect(f.store.must<Session>('sessions', session.id).state).toBe('open');
      expect(f.store.must<SessionTurn>('session_turns', turn.id).state).toBe('failed');
      expect(
        f.store.events().find((e) => e.kind === 'turn.failed' && e.aggregate_id === turn.id)
          ?.payload,
      ).toMatchObject({ receipt: stop });
    } finally {
      await f.close();
    }
  });

  it('shutdown fails a conversation turn with daemon_shutdown and waits for completion', async () => {
    const stub = controlledAdapter(),
      f = await fixture({ adapter: stub.adapter, managedWorkspaces: true });
    try {
      const { turn } = await conversation(f);
      await f.control.tick();
      await f.control.shutdown();
      expect(f.store.must<SessionTurn>('session_turns', turn.id).state).toBe('failed');
      expect(
        f.store.events().find((e) => e.kind === 'turn.failed' && e.aggregate_id === turn.id)
          ?.payload,
      ).toMatchObject({ error: 'daemon_shutdown' });
      expect(f.control.handles.size).toBe(0);
    } finally {
      await f.close();
    }
  });
});

it.each(['rejected', 'timeout'])(
  'shutdown settles a conversation when cancel is %s without a completion event',
  async (outcome) => {
    const stub = controlledAdapter();
    let release!: (receipt: CancelReceipt) => void;
    vi.mocked(stub.adapter.cancel).mockImplementation(async () => {
      if (outcome === 'rejected') throw new Error('shutdown cancel failed');
      return new Promise<CancelReceipt>((resolve) => {
        release = resolve;
      });
    });
    const f = await fixture({ adapter: stub.adapter, managedWorkspaces: true });
    let shutdown: Promise<void> | undefined;
    try {
      // Provisioning waits in real time, so the worktree is ready before timers are faked.
      await conversation(f);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await f.control.tick();
      let settled = false;
      shutdown = f.control.shutdown().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(10001);
      expect(settled, 'shutdown must settle even when cancel never completes the turn').toBe(true);
      expect(f.store.list<SessionTurn>('session_turns')[0]?.state).toBe('failed');
      expect(f.store.events().find((e) => e.kind === 'turn.failed')?.payload).toMatchObject({
        error: 'daemon_shutdown',
      });
      expect(f.control.handles.size).toBe(1);
    } finally {
      release?.(stub.receipt(false));
      stub.complete('interrupted');
      await vi.advanceTimersByTimeAsync(0);
      await shutdown;
      vi.mocked(stub.adapter.cancel).mockResolvedValue(stub.receipt(true));
      vi.useRealTimers();
      await f.close();
    }
  },
);

it('records daemon_shutdown when a conversation completes while dispatch is returning', async () => {
  const stub = controlledAdapter(),
    send = stub.adapter.send.bind(stub.adapter);
  let release: (() => void) | undefined;
  stub.adapter.send = async (handle, turn) => {
    const receipt = await send(handle, turn);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return receipt;
  };
  const f = await fixture({ adapter: stub.adapter, managedWorkspaces: true });
  try {
    await conversation(f);
    const ticking = f.control.tick();
    await eventually(() => release !== undefined);
    const shutdown = f.control.shutdown();
    stub.complete('completed');
    release!();
    await ticking;
    await shutdown;
    expect(f.store.list<SessionTurn>('session_turns')[0]?.state).toBe('failed');
    expect(f.store.events().find((e) => e.kind === 'turn.failed')?.payload).toMatchObject({
      error: 'daemon_shutdown',
    });
  } finally {
    release?.();
    await f.close();
  }
});
