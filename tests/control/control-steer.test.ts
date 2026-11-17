import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import { command } from '@pantheon/protocol';
import type {
  AgentEventSink,
  BoardPlan,
  CancelReceipt,
  DeliveryReceipt,
  HarnessAdapter,
  Session,
  SessionHandle,
  SessionSpec,
  SessionTurn,
  UserTurn,
  Workspace,
} from '@pantheon/domain';
import { eventually, fixture, user } from '../helpers.js';
import { git } from './workbench-fixture.js';

/** Worktree sessions branch from a commit of the project root. */
function commitProjectRoot(root: string) {
  git(root, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'Initial files');
}

function steeringFixture(support = false) {
  let sink: AgentEventSink,
    active: UserTurn | undefined,
    sequence = 0;
  const complete = (status: 'completed' | 'failed' | 'interrupted' = 'completed') => {
    if (!active) return;
    const turn = active;
    active = undefined;
    sink({
      key: String(++sequence),
      provider_sequence: sequence,
      kind: 'turn.completed',
      turn_id: turn.turn_id,
      status,
    });
  };
  const start = vi.fn(async (spec: SessionSpec, emit: AgentEventSink): Promise<SessionHandle> => {
    sink = emit;
    sink({
      key: String(++sequence),
      provider_sequence: sequence,
      kind: 'session.started',
      native_session_id: 'steering-session',
    });
    return {
      platform_session_id: spec.platform_session_id,
      native_session_id: 'steering-session',
      adapter_version: '1',
      device_id: 'local',
    };
  });
  const send = vi.fn(async (_handle: SessionHandle, turn: UserTurn): Promise<DeliveryReceipt> => {
    expect(active, 'only one input executes at a time').toBeUndefined();
    active = turn;
    return { turn_id: turn.turn_id, status: 'delivered' };
  });
  const steer = vi.fn(async (_handle: SessionHandle, turn: UserTurn): Promise<DeliveryReceipt> => {
    expect(active, 'steering requires an executing turn').toBeDefined();
    return { turn_id: turn.turn_id, status: 'delivered' };
  });
  const stop = async (_handle: SessionHandle, deadline: number): Promise<CancelReceipt> => {
    complete('interrupted');
    return {
      stopped: true,
      deadline,
      finished_at: new Date().toISOString(),
      evidence: { method: 'none', members: [] },
    };
  };
  const close = vi.fn(stop),
    cancel = vi.fn(stop);
  const adapter: HarnessAdapter = {
    name: 'fixture',
    report: new FixtureAdapter().report,
    async probe() {
      return this.report;
    },
    start,
    resume: (spec, _nativeId, emit) => start(spec, emit),
    async inspect(handle) {
      return {
        state: active ? 'running' : 'idle',
        native_session_id: handle.native_session_id,
        observed_at: new Date().toISOString(),
      };
    },
    send,
    steer: support ? steer : undefined,
    async answerPermission() {
      return { ok: false };
    },
    close,
    cancel,
  };
  const f = fixture({ adapter, managedWorkspaces: true });
  commitProjectRoot(f.projectRoot);
  /** Creates a session with its first send and prepares the worktree without starting that turn. */
  const open = async (text = 'send') => {
    const session = f.call<Session>('session.create', {
      project_id: f.project.id,
      runtime: adapter.name,
      input: text,
    });
    await f.control.tick();
    await eventually(
      () =>
        f.store.must<Workspace>('workspaces', session.workspace_id!).provisioning?.state ===
        'ready',
    );
    return { session, first: f.store.list<SessionTurn>('session_turns')[0]! };
  };
  const input = (session: Session, kind: 'send' | 'steer', text: string = kind) =>
    f.call<SessionTurn>(
      `session.${kind}`,
      { session_id: session.id, input: text },
      f.store.must<Session>('sessions', session.id).revision,
    );
  const row = (turn: SessionTurn) => f.store.must<SessionTurn>('session_turns', turn.id);
  const deliveries = (turn: SessionTurn) =>
    f.store
      .events()
      .filter((event) => event.kind === 'session.turn.delivery' && event.aggregate_id === turn.id)
      .map((event) => event.payload);
  return {
    f,
    adapter,
    start,
    send,
    steer,
    close,
    cancel,
    complete,
    open,
    input,
    row,
    deliveries,
  };
}

describe('session input delivery', () => {
  it('injects steering with the receipt row id and completes its execution with delivery', async () => {
    const s = steeringFixture(true);
    try {
      const { session, first } = await s.open();
      expect(first).toMatchObject({ kind: 'send', delivery: 'pending', state: 'queued' });
      await s.f.control.tick();
      const steer = s.input(session, 'steer');
      expect(steer).toMatchObject({ kind: 'steer', delivery: 'pending', state: 'queued' });
      await s.f.control.tick();
      expect(s.steer).toHaveBeenCalledWith(s.send.mock.calls[0]![0], {
        turn_id: steer.id,
        input: steer.input,
      });
      expect(s.row(steer)).toMatchObject({ delivery: 'delivered', state: 'completed' });
      expect(s.row(first)).toMatchObject({ delivery: 'delivered', state: 'running' });
      expect(s.send).toHaveBeenCalledTimes(1);
      expect(s.deliveries(steer)).toEqual([{ delivery: 'pending' }, { delivery: 'delivered' }]);
      s.complete();
      await eventually(() => s.row(first).state === 'completed');
      await s.f.control.tick();
      expect(s.deliveries(first)).toEqual([{ delivery: 'pending' }, { delivery: 'delivered' }]);
      expect(s.deliveries(steer)).toHaveLength(2);
    } finally {
      await s.f.close();
    }
  });

  it('queues steering without support and sends it on the same live session after completion', async () => {
    const s = steeringFixture();
    try {
      const { session, first } = await s.open();
      await s.f.control.tick();
      const steer = s.input(session, 'steer');
      await s.f.control.tick();
      await s.f.control.tick();
      expect(s.row(steer)).toMatchObject({ delivery: 'queued', state: 'queued' });
      expect(s.send).toHaveBeenCalledTimes(1);
      expect(s.deliveries(steer)).toEqual([{ delivery: 'pending' }, { delivery: 'queued' }]);
      s.complete();
      await eventually(() => s.row(steer).delivery === 'delivered');
      expect(s.row(first).state).toBe('completed');
      expect(s.row(steer).state).toBe('running');
      expect(s.start).toHaveBeenCalledTimes(1);
      expect(s.send.mock.calls[1]).toEqual([
        s.send.mock.calls[0]![0],
        { turn_id: steer.id, input: steer.input },
      ]);
      expect(s.close).not.toHaveBeenCalled();
      s.complete();
      await eventually(() => s.row(steer).state === 'completed');
      expect(s.row(steer).state).toBe('completed');
      expect(s.deliveries(steer)).toEqual([
        { delivery: 'pending' },
        { delivery: 'queued' },
        { delivery: 'delivered' },
      ]);
    } finally {
      await s.f.close();
    }
  });

  it.each([false, true])(
    'sends idle steering as a new turn with steer support=%s',
    async (support) => {
      const s = steeringFixture(support);
      try {
        const { session, first } = await s.open();
        await s.f.control.tick();
        s.complete();
        await eventually(() => s.row(first).state === 'completed');
        for (const text of ['First input', 'After completion']) {
          const steer = s.input(session, 'steer', text);
          await s.f.control.tick();
          expect(s.row(steer)).toMatchObject({
            kind: 'steer',
            delivery: 'delivered',
            state: 'running',
          });
          expect(s.send.mock.calls.at(-1)![1].turn_id).toBe(steer.id);
          expect(s.steer).not.toHaveBeenCalled();
          s.complete();
          await eventually(() => s.row(steer).state === 'completed');
          expect(s.row(steer).state).toBe('completed');
          expect(s.deliveries(steer)).toEqual([{ delivery: 'pending' }, { delivery: 'delivered' }]);
        }
        expect(s.f.store.list('sessions')).toHaveLength(1);
      } finally {
        await s.f.close();
      }
    },
  );

  it.each(['send', 'steer'] as const)(
    'records an unsupported %s as failed with the adapter reason',
    async (kind) => {
      const s = steeringFixture(true);
      try {
        const refuse = async (
          _handle: SessionHandle,
          turn: UserTurn,
        ): Promise<DeliveryReceipt> => ({
          turn_id: turn.turn_id,
          status: 'unsupported',
          reason: 'Provider refused this input',
        });
        if (kind === 'send') s.send.mockImplementationOnce(refuse);
        const { session, first } = await s.open();
        let turn = first;
        if (kind === 'steer') {
          await s.f.control.tick();
          s.steer.mockImplementationOnce(refuse);
          turn = s.input(session, kind);
        }
        await s.f.control.tick();
        await eventually(() => s.row(turn).state === 'failed');
        expect(s.row(turn)).toMatchObject({
          delivery: 'failed',
          delivery_reason: 'Provider refused this input',
        });
        expect(s.deliveries(turn)).toEqual([
          { delivery: 'pending' },
          { delivery: 'failed', reason: 'Provider refused this input' },
        ]);
        if (kind === 'steer') expect(s.send).toHaveBeenCalledTimes(1);
      } finally {
        await s.f.close();
      }
    },
  );

  it('waits for the adapter receipt even when completion arrives before send returns', async () => {
    const s = steeringFixture();
    let release!: () => void;
    try {
      const { first: turn } = await s.open(),
        send = s.adapter.send;
      s.adapter.send = async (handle, turn) => {
        const receipt = await send(handle, turn);
        s.complete();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return receipt;
      };
      const ticking = s.f.control.tick();
      await eventually(() => release !== undefined);
      expect(s.row(turn).delivery).toBe('pending');
      expect(s.close).not.toHaveBeenCalled();
      expect(s.deliveries(turn)).toEqual([{ delivery: 'pending' }]);
      release();
      await ticking;
      await eventually(() => s.row(turn).state === 'completed');
      expect(s.row(turn)).toMatchObject({ delivery: 'delivered', state: 'completed' });
      expect(s.deliveries(turn)).toEqual([{ delivery: 'pending' }, { delivery: 'delivered' }]);
    } finally {
      release?.();
      await s.f.close();
    }
  });

  it('keeps an adapter-queued steer visible until a later send delivers it', async () => {
    const s = steeringFixture(true);
    try {
      const { session } = await s.open();
      await s.f.control.tick();
      s.steer.mockImplementationOnce(async (_handle, turn) => ({
        turn_id: turn.turn_id,
        status: 'queued',
        reason: 'Waiting for a turn boundary',
      }));
      const turn = s.input(session, 'steer');
      await s.f.control.tick();
      expect(s.row(turn)).toMatchObject({ delivery: 'queued', state: 'queued' });
      s.complete();
      await eventually(() => s.row(turn).delivery === 'delivered');
      expect(s.row(turn).delivery_reason).toBeUndefined();
      expect(s.deliveries(turn)).toEqual([
        { delivery: 'pending' },
        { delivery: 'queued', reason: 'Waiting for a turn boundary' },
        { delivery: 'delivered' },
      ]);
    } finally {
      await s.f.close();
    }
  });

  it('waits for an injected steer receipt before closing the current session', async () => {
    const s = steeringFixture(true);
    let release!: () => void;
    try {
      const { session } = await s.open();
      await s.f.control.tick();
      s.steer.mockImplementationOnce(async (_handle, turn) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { turn_id: turn.turn_id, status: 'delivered' };
      });
      const turn = s.input(session, 'steer'),
        ticking = s.f.control.tick();
      await eventually(() => release !== undefined);
      s.complete();
      await Promise.resolve();
      expect(s.row(turn).delivery).toBe('pending');
      expect(s.close).not.toHaveBeenCalled();
      release();
      await ticking;
      await eventually(() => s.f.store.must<Session>('sessions', session.id).state === 'open');
      expect(s.row(turn)).toMatchObject({ delivery: 'delivered', state: 'completed' });
      expect(s.deliveries(turn)).toEqual([{ delivery: 'pending' }, { delivery: 'delivered' }]);
    } finally {
      release?.();
      await s.f.close();
    }
  });

  it('keeps a steer cancelled by an interrupt cancelled when its queued receipt arrives later', async () => {
    const s = steeringFixture(true);
    let release!: () => void;
    try {
      s.adapter.interrupt = async () => {
        s.complete('interrupted');
        return { ok: true };
      };
      const { session } = await s.open();
      await s.f.control.tick();
      s.steer.mockImplementationOnce(async (_handle, turn) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { turn_id: turn.turn_id, status: 'queued' };
      });
      const turn = s.input(session, 'steer'),
        ticking = s.f.control.tick();
      await eventually(() => release !== undefined);
      s.f.call(
        'session.interrupt',
        { session_id: session.id },
        s.f.store.must<Session>('sessions', session.id).revision,
      );
      await eventually(() => s.row(turn).state === 'cancelled');
      release();
      await ticking;
      await eventually(
        () =>
          s.send.mock.calls.length > 1 ||
          s.f.store.must<Session>('sessions', session.id).state === 'open',
      );
      expect(s.row(turn).state).toBe('cancelled');
      expect(s.send).toHaveBeenCalledTimes(1);
    } finally {
      release?.();
      await s.f.close();
    }
  });

  it('holds a steer during a compaction and sends it afterwards as a read-only turn of a lead with an unfinished plan', async () => {
    const s = steeringFixture(true);
    try {
      const { session, first } = await s.open();
      await s.f.control.tick();
      s.complete();
      await eventually(() => s.row(first).state === 'completed');
      s.f.store.insert<BoardPlan>('board_plans', {
        id: session.id,
        revision: 1,
        project_id: s.f.project.id,
        headline: 'Export ships',
        lanes: [{ id: 'core', title: 'Core' }],
        tasks: [
          {
            id: 'a',
            title: 'Task a',
            goal: 'Finish task a',
            lane: 'core',
            depends_on: [],
            source: ['send'],
            scope: ['src/a.ts'],
            acceptance: ['pnpm test'],
          },
        ],
        plan_version: 1,
        pending_edits: [],
        risks: [],
        assumptions: [],
        inbox: [],
        notified: {},
        updated_at: s.f.store.now(),
      });
      const compaction = s.f.call<SessionTurn>(
        'session.compact',
        { session_id: session.id },
        s.f.store.must<Session>('sessions', session.id).revision,
      );
      await s.f.control.tick();
      await eventually(() => s.row(compaction).delivery === 'delivered');
      const turn = s.input(session, 'steer', 'Write a file');
      await s.f.control.tick();
      expect(s.steer).not.toHaveBeenCalled();
      expect(s.row(turn)).toMatchObject({ delivery: 'queued', state: 'queued' });
      s.complete();
      await eventually(() => s.row(turn).delivery === 'delivered');
      expect(s.send.mock.calls.at(-1)![1]).toMatchObject({ turn_id: turn.id, read_only: true });
      expect(s.row(turn)).toMatchObject({ state: 'running', read_only: true });
    } finally {
      await s.f.close();
    }
  });

  it('acknowledges the memory of a delivered turn when a steer prepared later stays queued', async () => {
    const s = steeringFixture(true);
    let release!: () => void;
    try {
      const draft = s.f.call<{ id: string; revision: number }>('memory.propose', {
        project_id: s.f.project.id,
        key: 'language',
        kind: 'decision',
        text: 'Use precise terminology',
      });
      s.f.call('memory.commit', { memory_id: draft.id }, draft.revision);
      const { session, first } = await s.open();
      await s.f.control.tick();
      s.steer.mockImplementation(async (_handle, turn) => ({
        turn_id: turn.turn_id,
        status: 'queued',
        reason: 'Waiting for a turn boundary',
      }));
      const earlier = s.input(session, 'steer', 'Earlier');
      await s.f.control.tick();
      expect(s.row(earlier).delivery).toBe('queued');
      const send = s.adapter.send;
      s.adapter.send = async (handle, turn) => {
        const receipt = await send(handle, turn);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return receipt;
      };
      // The queued steer goes out as its own turn after the first one, outside a scheduler tick.
      s.complete();
      await eventually(() => release !== undefined);
      const later = s.input(session, 'steer', 'Later');
      await s.f.control.tick();
      expect(s.row(later).delivery).toBe('queued');
      expect(s.steer.mock.calls.at(-1)![1].input).toContain('[Pantheon current project memory]');
      release();
      await eventually(() => s.row(earlier).delivery === 'delivered');
      expect(
        s.f.store
          .kindEvents(s.f.project.id, ['memory.delivered'])
          .map((event) => (event.payload as { turn_id: string }).turn_id),
      ).toEqual([first.id, earlier.id]);
    } finally {
      release?.();
      await s.f.close();
    }
  });

  it('deduplicates a steering command and atomically rolls back its row, event and outbox', async () => {
    const s = steeringFixture();
    try {
      const { session } = await s.open(),
        c = command(
          user.id,
          'session.steer',
          { session_id: session.id, input: 'Once' },
          s.f.store.must<Session>('sessions', session.id).revision,
        ),
        turn = s.f.control.execute(user, c) as SessionTurn;
      expect(s.f.control.execute(user, c)).toEqual(turn);
      expect(s.f.store.list('session_turns')).toHaveLength(2);
      expect(s.deliveries(turn)).toEqual([{ delivery: 'pending' }]);
      const before = s.f.store.cursor(),
        pending = s.f.store.pending(),
        current = s.f.store.must<Session>('sessions', session.id),
        event = s.f.store.event.bind(s.f.store);
      const fail = vi.spyOn(s.f.store, 'event').mockImplementation((...args) => {
        const result = event(...args);
        if (args[0] === 'session.turn.delivery') throw new Error('Delivery event failure');
        return result;
      });
      expect(() => s.input(session, 'steer')).toThrow('Delivery event failure');
      fail.mockRestore();
      expect(s.f.store.cursor()).toBe(before);
      expect(s.f.store.pending()).toEqual(pending);
      expect(s.f.store.must<Session>('sessions', session.id)).toEqual(current);
      expect(s.f.store.list('session_turns')).toHaveLength(2);
    } finally {
      await s.f.close();
    }
  });
});
