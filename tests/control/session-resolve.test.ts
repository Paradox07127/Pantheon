import { afterEach, expect, it, vi } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Control } from '@pantheon/control';
import { FixtureAdapter } from '@pantheon/adapters';
import { command } from '@pantheon/protocol';
import {
  SessionStartError,
  type AgentEventSink,
  type Approval,
  type HarnessAdapter,
  type Principal,
  type ProcessIdentity,
  type Review,
  type Session,
  type SessionHandle,
  type SessionSpec,
  type SessionTurn,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { awaitWorkspaceReady, eventually, fixture, user } from '../helpers.js';
import { git } from './workbench-fixture.js';

// Above the largest Linux pid_max (2 ** 22): termination is confirmed by probing the real process
// group table, where a live group with the same id fails the test.
const oldIdentity = { pid: 2 ** 22 + 1, start_time_us: 1700000000123456 };
const newIdentity = { pid: 2 ** 22 + 2, start_time_us: 1700000001123456 };
const choices = ['resume_session', 'close'] as const;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

/** Worktree sessions branch from a commit of the project root. */
function commitProjectRoot(root: string) {
  git(root, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'Initial files');
}

/** A session review reads the committed changes of the session worktree. */
function commitWorktree(worktree: string) {
  git(worktree, 'commit', '--quiet', '-am', 'Change the readme');
}

async function restartedFixture(options: { reviewer?: boolean; identityOnSend?: boolean } = {}) {
  const base = new FixtureAdapter();
  const sinks = new Map<SessionHandle, AgentEventSink>();
  const open = (spec: SessionSpec, nativeId: string, sink: AgentEventSink, resumed = false) => {
    const handle: SessionHandle = {
      platform_session_id: spec.platform_session_id,
      native_session_id: nativeId,
      adapter_version: '1',
      device_id: 'local',
      process_identity: resumed ? newIdentity : options.identityOnSend ? undefined : oldIdentity,
    };
    sinks.set(handle, sink);
    return handle;
  };
  // The writer of a reviewed session keeps a native session of its own.
  const start = vi.fn(async (spec: SessionSpec, sink: AgentEventSink) =>
    open(
      spec,
      options.reviewer && spec.role === 'writer'
        ? 'reviewed-writer-session'
        : 'saved-direct-session',
      sink,
    ),
  );
  const resume = vi.fn(async (spec: SessionSpec, nativeId: string, sink: AgentEventSink) =>
    open(spec, nativeId, sink, true),
  );
  const send = vi.fn<HarnessAdapter['send']>(async (handle, turn) => {
    handle.process_identity ??= oldIdentity;
    return { turn_id: turn.turn_id, status: 'delivered' };
  });
  const runtime = (name: string): HarnessAdapter => ({
    name,
    report: {
      ...base.report,
      capabilities: {
        ...base.report.capabilities,
        resume: { status: 'supported', evidence: 'Fixture native session' },
      },
    },
    async probe() {
      return this.report;
    },
    start,
    resume,
    send,
    inspect: base.inspect.bind(base),
    answerPermission: base.answerPermission.bind(base),
    cancel: vi.fn(async (_handle, deadline) => ({
      stopped: true,
      deadline,
      finished_at: new Date().toISOString(),
      evidence: { method: 'none' as const, members: [] },
    })),
    close: vi.fn(async (_handle, deadline) => ({
      stopped: true,
      deadline,
      finished_at: new Date().toISOString(),
      evidence: { method: 'none' as const, members: [] },
    })),
  });
  // A session review needs a runtime other than the one that wrote the session.
  const adapter = runtime('fixture'),
    reviewer = runtime('session-reviewer');
  const f = fixture({ adapter, now: () => 1700000000000, managedWorkspaces: true });
  commitProjectRoot(f.projectRoot);
  const readProcess = vi.fn<(pid: number) => ProcessIdentity | undefined>(() => undefined);
  const controlOptions = { ...f.controlOptions, readProcess };
  let control = new Control(f.store, f.files, [adapter, reviewer], undefined, controlOptions);
  cleanups.push(async () => {
    await control.shutdown();
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.controlOptions!.workspaceRoot!, { recursive: true, force: true });
  });
  const written = control.execute(
    user,
    command(user.id, 'session.create', {
      project_id: f.project.id,
      runtime: adapter.name,
      input: 'Interrupted input',
    }),
  ) as Session;
  const workspace = await awaitWorkspaceReady(control, written.workspace_id!);
  await eventually(
    () => control.handles.size === 1,
    () => control.tick(),
  );
  let sessionId = written.id;
  let review: Review | undefined;
  if (options.reviewer) {
    const [turnId, handle] = [...control.handles][0]!;
    sinks.get(handle!)!({
      key: 'written',
      provider_sequence: 1,
      kind: 'turn.completed',
      status: 'completed',
      turn_id: turnId!,
    });
    await eventually(() => f.store.must<Session>('sessions', written.id).state === 'open');
    writeFileSync(path.join(workspace.path, 'README.md'), 'reviewed\n');
    commitWorktree(workspace.path);
    review = (await control.execute(
      user,
      command(user.id, 'review.request', { session_id: written.id, runtimes: [reviewer.name] }),
    )) as Review;
    sessionId = review.session_ids[0]!;
    await eventually(
      () => [...control.handles.values()].some((h) => h.platform_session_id === sessionId),
      () => control.tick(),
    );
  }
  const originalSession = f.store.must<Session>('sessions', sessionId);
  // Keep resolution tests independent of the handle persistence regression.
  f.store.update(
    'sessions',
    { ...originalSession, native_id: 'saved-direct-session', process_identity: oldIdentity },
    originalSession.revision,
  );
  const restart = () => {
    control = new Control(f.store, f.files, [adapter, reviewer], undefined, controlOptions);
    control.recover();
    return control;
  };
  if (!options.reviewer) restart();
  // Worktree setup and recovery read the process table too; tests count only later reads.
  readProcess.mockClear();
  const session = () => f.store.must<Session>('sessions', sessionId);
  const resolve = (
    choice: (typeof choices)[number],
    principal = user,
    revision = session().revision,
  ) =>
    control.execute(
      principal,
      command(principal.id, 'session.resolve', { session_id: sessionId, choice }, revision),
    );
  const snapshot = () => ({
    sessions: f.store.list('sessions'),
    turns: f.store.list('session_turns'),
    approvals: f.store.list('approvals'),
    events: f.store.events(),
    outbox: f.store.db.prepare('SELECT * FROM outbox').all(),
  });
  return {
    ...f,
    adapter,
    start,
    resume,
    send,
    readProcess,
    originalSession,
    review,
    written,
    get control() {
      return control;
    },
    session,
    resolve,
    snapshot,
    restart,
    complete(handle: SessionHandle, turn: SessionTurn) {
      sinks.get(handle)!({
        key: 'done',
        provider_sequence: 1,
        kind: 'turn.completed',
        status: 'completed',
        turn_id: turn.id,
      });
    },
  };
}

it.each([false, true])('saves session identity with identityOnSend=%s', async (identityOnSend) => {
  const f = await restartedFixture({ identityOnSend });
  expect(f.originalSession).toMatchObject({
    native_id: 'saved-direct-session',
    process_identity: oldIdentity,
  });
});

it('resumes a session without replaying input and delivers the next send', async () => {
  const f = await restartedFixture();
  expect(f.session().state).toBe('reconciling');
  f.resolve('resume_session');
  await f.control.tick();
  expect(f.readProcess).toHaveBeenCalledWith(oldIdentity.pid);
  expect(f.resume).toHaveBeenCalledExactlyOnceWith(
    f.start.mock.calls[0]![0],
    'saved-direct-session',
    expect.any(Function),
  );
  expect(f.session()).toMatchObject({
    state: 'open',
    process_identity: newIdentity,
    stop_pending: false,
  });
  expect(f.send).toHaveBeenCalledOnce();
  expect(f.store.list<SessionTurn>('session_turns')).toEqual([
    expect.objectContaining({
      state: 'failed',
      delivery_reason: 'Previous execution ended during reconciliation',
    }),
  ]);
  const turn = f.control.execute(
    user,
    command(
      user.id,
      'session.send',
      {
        session_id: f.session().id,
        input: 'Continue the native conversation',
      },
      f.session().revision,
    ),
  ) as SessionTurn;
  await f.control.tick();
  const handle = await f.resume.mock.results[0]!.value;
  expect(f.send).toHaveBeenLastCalledWith(
    handle,
    expect.objectContaining({ turn_id: turn.id, input: turn.input }),
  );
  expect(f.resume).toHaveBeenCalledOnce();
  f.complete(handle, turn);
  await eventually(() => f.session().state === 'open' && f.control.handles.size === 1);
  expect(f.store.must<SessionTurn>('session_turns', turn.id).state).toBe('completed');
});

it('counts a resumed session that waits for input as idle, so the idle limit can close it', async () => {
  const f = await restartedFixture();
  f.resolve('resume_session');
  await f.control.tick();
  expect(f.session().state).toBe('open');
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  expect(ctx.idleConversations.has(f.session().id)).toBe(true);
});

it('closes a session, loses approvals and fails running and queued turns', async () => {
  const f = await restartedFixture();
  const running = f.store.list<SessionTurn>('session_turns')[0]!;
  f.store.insert<SessionTurn>('session_turns', {
    ...running,
    id: 'queued-input',
    state: 'queued',
    delivery: 'pending',
  });
  f.store.enqueue('session.turn', { turn_id: 'queued-input' });
  const approval = f.store.insert<Approval>('approvals', {
    id: 'lost-permission',
    revision: 1,
    project_id: f.project.id,
    kind: 'permission',
    session_id: f.session().id,
    request_id: 'native-permission',
    input_hash: 'saved-input',
    decider: 'user',
    state: 'pending',
    created_at: f.store.now(),
  });
  f.resolve('close');
  expect(f.readProcess).toHaveBeenCalledWith(oldIdentity.pid);
  expect(f.session()).toMatchObject({ state: 'closed', stop_pending: false });
  expect(f.store.must<Approval>('approvals', approval.id)).toMatchObject({
    state: 'void',
    reason: 'session_lost',
  });
  for (const turn of f.store.list<SessionTurn>('session_turns'))
    expect(turn).toMatchObject({
      state: 'failed',
      delivery_reason: 'Previous execution ended during reconciliation',
    });
  await f.control.tick();
  expect(f.resume).not.toHaveBeenCalled();
  expect(f.send).toHaveBeenCalledOnce();
  expect(f.control.needsYou(user).items).toMatchObject([
    {
      source: { table: 'sessions', id: f.session().id, revision: f.session().revision },
      kind: 'session.failed',
      reason: 'session_failed',
      actions: [],
    },
  ]);
  expect(() =>
    f.control.execute(
      user,
      command(
        user.id,
        'session.send',
        {
          session_id: f.session().id,
          input: 'Cannot send to a closed session',
        },
        f.session().revision,
      ),
    ),
  ).toThrow(expect.objectContaining({ code: 'resource_busy' }));
});

it.each(choices)(
  'keeps a session reconciling when termination is unconfirmed for %s',
  async (choice) => {
    const f = await restartedFixture();
    f.readProcess.mockReturnValue(oldIdentity);
    const before = f.snapshot();
    expect(() => f.resolve(choice)).toThrow(
      expect.objectContaining({ code: 'termination_unconfirmed' }),
    );
    expect(f.snapshot()).toEqual(before);
    expect(f.resume).not.toHaveBeenCalled();
  },
);

it.each(['missing identity', 'unreadable process table'])(
  'refuses resolution with %s',
  async (reason) => {
    const f = await restartedFixture();
    if (reason === 'missing identity') {
      const session = f.session();
      f.store.update('sessions', { ...session, process_identity: undefined }, session.revision);
    } else
      f.readProcess.mockImplementation(() => {
        throw new Error('Process table unavailable');
      });
    const before = f.snapshot();
    expect(() => f.resolve('close')).toThrow(
      expect.objectContaining({ code: 'termination_unconfirmed' }),
    );
    expect(f.snapshot()).toEqual(before);
  },
);

it.each(['missing native id', 'missing resume', 'unsupported resume'])(
  'refuses resuming with %s',
  async (reason) => {
    const f = await restartedFixture();
    if (reason === 'missing native id') {
      const session = f.session();
      f.store.update('sessions', { ...session, native_id: undefined }, session.revision);
    } else if (reason === 'missing resume') f.adapter.resume = undefined;
    else
      f.adapter.report.capabilities.resume = {
        status: 'unsupported',
        evidence: 'Fixture has no resume',
      };
    const before = f.snapshot();
    expect(() => f.resolve('resume_session')).toThrow(
      expect.objectContaining({ code: 'unsupported_capability' }),
    );
    expect(f.readProcess).toHaveBeenCalledWith(oldIdentity.pid);
    expect(f.snapshot()).toEqual(before);
  },
);

it('requires the current revision and reconciliation', async () => {
  const f = await restartedFixture();
  expect(() => f.resolve('close', user, f.session().revision - 1)).toThrow(
    expect.objectContaining({ code: 'revision_conflict' }),
  );
  const session = f.session();
  f.store.update('sessions', { ...session, state: 'open' as const }, session.revision);
  expect(() => f.resolve('close')).toThrow(expect.objectContaining({ code: 'invalid_state' }));
  expect(f.readProcess).not.toHaveBeenCalled();
});

it('requires the user to resolve a session', async () => {
  const f = await restartedFixture();
  const planner: Principal = { id: 'planner', role: 'planner', project_id: f.project.id };
  for (const principal of [planner, { ...planner, role: 'writer' as const }])
    expect(() => f.resolve('close', principal)).toThrow(
      expect.objectContaining({ code: 'permission_denied' }),
    );
  f.resolve('close');
  expect(f.session().state).toBe('closed');
});

it('lists reconciling sessions in needs-you with session resolution', async () => {
  const f = await restartedFixture();
  expect(f.control.needsYou(user, f.project.id).items).toContainEqual(
    expect.objectContaining({
      source: { table: 'sessions', id: f.session().id, revision: f.session().revision },
      kind: 'session.reconciling',
      status: 'reconciling',
      created_at: f.store.now(),
      actions: [{ command: 'session.resolve', allowed: true }],
    }),
  );
  expect(f.control.needsYou(user, 'other-project').items).toEqual([]);
});

it('deduplicates resume and refuses competing resolutions during its handshake', async () => {
  const f = await restartedFixture();
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const resume = f.resume.getMockImplementation()!;
  f.resume.mockImplementationOnce(async (...args) => {
    await ready;
    return resume(...args);
  });
  const sent = command(
    user.id,
    'session.resolve',
    { session_id: f.session().id, choice: 'resume_session' },
    f.session().revision,
  );
  const receipt = f.control.execute(user, sent);
  expect(f.control.execute(user, sent)).toEqual(receipt);
  for (const choice of choices)
    expect(() => f.resolve(choice)).toThrow(expect.objectContaining({ code: 'resource_busy' }));
  const pending = f.control.tick();
  try {
    await eventually(() => f.resume.mock.calls.length === 1);
    const before = f.snapshot();
    for (const choice of choices)
      expect(() => f.resolve(choice)).toThrow(expect.objectContaining({ code: 'resource_busy' }));
    expect(f.snapshot()).toEqual(before);
  } finally {
    release();
    await pending;
  }
  expect(f.control.execute(user, sent)).toEqual(receipt);
  await f.control.tick();
  expect(f.resume).toHaveBeenCalledOnce();
});

it('keeps a failed resume reconciling and allows a safe retry', async () => {
  const f = await restartedFixture();
  f.resume.mockRejectedValueOnce(new Error('Native resume failed'));
  f.resolve('resume_session');
  await f.control.tick();
  expect(f.session().state).toBe('reconciling');
  expect(f.control.handles.size).toBe(0);
  expect(f.store.events().find((event) => event.kind === 'session.resume_failed')).toMatchObject({
    payload: { error: expect.stringContaining('Native resume failed') },
  });
  f.resolve('resume_session');
  await f.control.tick();
  expect(f.session().state).toBe('open');
  expect(f.send).toHaveBeenCalledOnce();
});

it('discards a session the user discarded during its resume handshake only after closing the resumed process', async () => {
  const f = await restartedFixture();
  const resumed = f.resume.getMockImplementation()!;
  let release: (() => void) | undefined;
  f.resume.mockImplementationOnce(async (spec, nativeId, sink) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return resumed(spec, nativeId, sink);
  });
  f.resolve('resume_session');
  const ticking = f.control.tick();
  await eventually(() => release !== undefined);
  f.control.execute(
    user,
    command(user.id, 'session.discard', { session_id: f.session().id }, f.session().revision),
  );
  release!();
  await ticking;
  expect(f.session().outcome).toBeUndefined();
  await eventually(
    () => f.session().state === 'closed' && f.control.handles.size === 0,
    () => f.control.tick(),
  );
  expect(f.session().outcome).toBe('discarded');
  expect(f.adapter.close).toHaveBeenCalled();
});

it('never uses an old process identity after an unconfirmed resume spawn', async () => {
  const f = await restartedFixture();
  f.resume.mockRejectedValueOnce(
    new SessionStartError('Resume handshake lost', {
      stopped: false,
      deadline: Date.now(),
      finished_at: new Date().toISOString(),
      evidence: { method: 'none', members: [newIdentity] },
    }),
  );
  f.resolve('resume_session');
  await f.control.tick();
  expect(f.session().state).toBe('reconciling');
  expect(f.session().process_identity).toBeUndefined();
  expect(() => f.resolve('close')).toThrow(
    expect.objectContaining({ code: 'termination_unconfirmed' }),
  );
});

it('does not replay a pending resume after another daemon restart', async () => {
  const f = await restartedFixture();
  f.resolve('resume_session');
  f.restart();
  await f.control.tick();
  expect(f.resume).not.toHaveBeenCalled();
  f.resolve('resume_session');
  await f.control.tick();
  expect(f.resume).toHaveBeenCalledOnce();
});

it('quarantines an idle resumed session after another restart', async () => {
  const f = await restartedFixture();
  f.resolve('resume_session');
  await f.control.tick();
  expect(f.session().state).toBe('open');
  f.readProcess.mockReturnValue(newIdentity);
  f.restart();
  expect(f.session().state).toBe('reconciling');
  expect(() => f.resolve('close')).toThrow(
    expect.objectContaining({ code: 'termination_unconfirmed' }),
  );
});

it('closes a terminated reviewer session during recovery', async () => {
  const f = await restartedFixture({ reviewer: true });
  f.restart();
  expect(f.readProcess).toHaveBeenCalledWith(oldIdentity.pid);
  expect(f.session().state).toBe('closed');
  expect(f.store.must<Review>('reviews', f.review!.id).state).toBe('failed');
  expect(
    f.store.list<SessionTurn>('session_turns').find((turn) => turn.session_id === f.session().id)!
      .state,
  ).toBe('failed');
  // Only the reviewed writer, idle with a recorded process, waits for resolution.
  expect(f.control.needsYou(user).items.map((item) => item.source.id)).toEqual([f.written.id]);
});

it('keeps an unconfirmed reviewer visible until session resolution can close it', async () => {
  const f = await restartedFixture({ reviewer: true });
  f.readProcess.mockReturnValue(oldIdentity);
  f.restart();
  expect(f.session().state).toBe('reconciling');
  expect(f.control.needsYou(user).items).toContainEqual(
    expect.objectContaining({
      source: { table: 'sessions', id: f.session().id, revision: f.session().revision },
      actions: [{ command: 'session.resolve', allowed: true }],
    }),
  );
  expect(() => f.resolve('close')).toThrow(
    expect.objectContaining({ code: 'termination_unconfirmed' }),
  );
  f.readProcess.mockReturnValue(undefined);
  f.resolve('close');
  expect(f.session().state).toBe('closed');
});
