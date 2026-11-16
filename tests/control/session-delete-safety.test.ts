import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type {
  BoardPlan,
  HarnessAdapter,
  Milestone,
  Principal,
  Session,
  SessionHandle,
  Workspace,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { eventually, settle, user } from '../helpers.js';
import { dispatchEveryTier, workbenchFixture } from './workbench-fixture.js';

type Fixture = ReturnType<typeof workbenchFixture>;

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const contextOf = (f: Fixture) => (f.control as unknown as { ctx: ControlContext }).ctx;
const remove = (f: Fixture, sessionId: string) =>
  f.call<Session>('session.delete', { session_id: sessionId }, current(f, sessionId).revision);
const end = (f: Fixture, sessionId: string, fields: Partial<Session>) => {
  const session = current(f, sessionId);
  return f.store.update<Session>(
    'sessions',
    { ...session, state: 'closed', ...fields },
    session.revision,
  );
};
const kinds = (f: Fixture, sessionId: string) =>
  f.store
    .events(0, undefined, 100000)
    .filter((event) => event.aggregate_id === sessionId)
    .map((event) => event.kind);
const refuseCommit = (f: Fixture) =>
  vi.spyOn(f.control, 'failpoint').mockImplementation((name) => {
    if (name === 'before_transaction_commit') throw new Error('commit refused');
  });

/** Provisions the sessions' worktrees with one tick, so their first turns wait for the next tick. */
async function provisioned(f: Fixture, ...sessions: Session[]) {
  await f.control.tick();
  await eventually(() =>
    sessions.every(
      (session) =>
        f.store.must<Workspace>('workspaces', session.workspace_id!).provisioning?.state ===
        'ready',
    ),
  );
}

/** Holds the next adapter.start until the returned release is called. */
function holdStart(f: Fixture) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  f.start.mockImplementationOnce(async (spec, sink) => {
    await gate;
    return f.adapter.start(spec, sink);
  });
  return release;
}

/** True while the control holds a native process of the session. */
const hasProcess = (f: Fixture, sessionId: string) =>
  [...contextOf(f).handles.values()].some((handle) => handle.platform_session_id === sessionId);

/** Holds every close of a native process until the returned release is called. */
function holdClose(f: Fixture) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const close = f.adapter.close.bind(f.adapter);
  vi.spyOn(f.adapter, 'close').mockImplementation(async (handle, deadline) => {
    await released;
    return close(handle, deadline);
  });
  return release;
}

async function runningSession(f: Fixture) {
  const session = f.create();
  await provisioned(f, session);
  await eventually(
    () => f.turns(session.id)[0]?.state === 'running',
    () => f.control.tick(),
  );
  return current(f, session.id);
}

it('refuses to delete a session whose native process is still starting', async () => {
  const f = workbenchFixture();
  const release = holdStart(f);
  const session = f.create();
  await provisioned(f, session);
  const ticking = f.control.tick();
  await eventually(() => f.start.mock.calls.length > 0);

  expect(() => remove(f, session.id)).toThrow(expect.objectContaining({ code: 'resource_busy' }));
  release();
  await ticking;
  expect(current(f, session.id).outcome).toBeUndefined();
});

it('refuses to delete a reconciling or stop-pending session without a native handle', () => {
  const f = workbenchFixture();
  const reconciling = f.create('Reconciling work'),
    stopping = f.create('Stopping work');
  for (const [session, fields] of [
    [reconciling, { state: 'reconciling' as const }],
    [stopping, { state: 'open' as const, stop_pending: true }],
  ] as const) {
    const row = current(f, session.id);
    f.store.update<Session>(
      'sessions',
      { ...row, ...fields, process_identity: { pid: process.pid } },
      row.revision,
    );
    expect(() => remove(f, session.id)).toThrow(expect.objectContaining({ code: 'resource_busy' }));
    expect(f.store.get<Session>('sessions', session.id)).toBeDefined();
  }
});

it('keeps a session a milestone came to require while its native process was closing', async () => {
  const f = workbenchFixture({ delay: 4000 });
  const session = await runningSession(f);

  remove(f, session.id);
  f.call<Milestone>('milestone.create', {
    project_id: f.project.id,
    title: 'Ship it',
    required_sessions: [session.id],
    criteria: ['It ships'],
  });
  await eventually(
    () =>
      !f.store.get<Session>('sessions', session.id) ||
      kinds(f, session.id).includes('session.delete_failed'),
    () => f.control.tick(),
  );
  expect(f.store.get<Session>('sessions', session.id)).toBeDefined();
  expect(kinds(f, session.id)).not.toContain('session.deleted');
});

it('leaves a session whose delete was refused after its native process closed as it was', async () => {
  const f = workbenchFixture({ delay: 4000 });
  const session = await runningSession(f);
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);

  remove(f, session.id);
  f.call<Milestone>('milestone.create', {
    project_id: f.project.id,
    title: 'Ship it',
    required_sessions: [session.id],
    criteria: ['It ships'],
  });
  await eventually(
    () => kinds(f, session.id).includes('session.delete_failed'),
    () => f.control.tick(),
  );
  for (let i = 0; i < 3; i++) await f.control.tick();
  expect(current(f, session.id).outcome).toBeUndefined();
  expect(current(f, session.id).stop_requested).toBeUndefined();
  expect(kinds(f, session.id)).not.toContain('session.discarded');
  expect(existsSync(workspace.path)).toBe(true);
  expect(
    f.store
      .pending()
      .some(
        (job) =>
          job.kind === 'workspace.remove' &&
          (JSON.parse(job.payload) as { workspace_id: string }).workspace_id === workspace.id,
      ),
  ).toBe(false);
  expect(() =>
    f.call(
      'session.send',
      { session_id: session.id, input: 'Carry on' },
      current(f, session.id).revision,
    ),
  ).not.toThrow();
});

it('keeps the files and the session of a delete whose command rolled back', async () => {
  const f = workbenchFixture();
  const upload = f.control.addAttachment(
    user,
    f.project.id,
    'notes.txt',
    'text/plain',
    new TextEncoder().encode('notes'),
  );
  const session = f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Read the notes',
    attachments: [upload.id],
  });
  const history = path.join(f.root, 'state/native-sessions/own'),
    uploaded = path.join(f.root, 'state/attachments', f.project.id, upload.id);
  mkdirSync(history, { recursive: true });
  writeFileSync(path.join(history, 'history.jsonl'), '{}\n');
  end(f, session.id, { outcome: 'discarded', native_state_dir: history });

  const refused = refuseCommit(f);
  expect(() => remove(f, session.id)).toThrow('commit refused');
  refused.mockRestore();
  await new Promise((resolve) => setImmediate(resolve));
  expect(f.store.get<Session>('sessions', session.id)).toBeDefined();
  expect(existsSync(history)).toBe(true);
  expect(existsSync(uploaded)).toBe(true);

  remove(f, session.id);
  await new Promise((resolve) => setImmediate(resolve));
  expect(f.store.get<Session>('sessions', session.id)).toBeUndefined();
  expect(existsSync(history)).toBe(false);
  expect(existsSync(uploaded)).toBe(false);
});

it('does not finish a delete of a running session whose command rolled back', async () => {
  const f = workbenchFixture({ delay: 4000 });
  const ctx = contextOf(f);
  const session = await runningSession(f);
  const before = new Set(ctx.completions);

  const refused = refuseCommit(f);
  expect(() => remove(f, session.id)).toThrow('commit refused');
  refused.mockRestore();
  await Promise.all([...ctx.completions].filter((completion) => !before.has(completion)));
  expect(f.store.get<Session>('sessions', session.id)).toBeDefined();
  expect(kinds(f, session.id)).not.toContain('session.discarded');
});

it('keeps the files of a delete whose transaction failed after its native process closed', async () => {
  const f = workbenchFixture({ delay: 4000 });
  const ctx = contextOf(f);
  const upload = f.control.addAttachment(
    user,
    f.project.id,
    'notes.txt',
    'text/plain',
    new TextEncoder().encode('notes'),
  );
  const session = f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Read the notes',
    attachments: [upload.id],
  });
  await provisioned(f, session);
  await eventually(
    () => f.turns(session.id)[0]?.state === 'running',
    () => f.control.tick(),
  );
  const history = path.join(f.root, 'state/native-sessions/own'),
    uploaded = path.join(f.root, 'state/attachments', f.project.id, upload.id);
  mkdirSync(history, { recursive: true });
  writeFileSync(path.join(history, 'history.jsonl'), '{}\n');
  const row = current(f, session.id);
  f.store.update<Session>('sessions', { ...row, native_state_dir: history }, row.revision);
  const before = new Set(ctx.completions);

  remove(f, session.id);
  const transaction = f.store.transaction.bind(f.store);
  vi.spyOn(f.store, 'transaction').mockImplementation((fn) =>
    transaction(() => {
      const result = fn();
      if (!f.store.get<Session>('sessions', session.id)) throw new Error('commit failed');
      return result;
    }),
  );
  await Promise.allSettled([...ctx.completions].filter((completion) => !before.has(completion)));
  await new Promise((resolve) => setImmediate(resolve));
  vi.mocked(f.store.transaction).mockRestore();
  expect(f.store.get<Session>('sessions', session.id)).toBeDefined();
  expect(existsSync(history)).toBe(true);
  expect(existsSync(uploaded)).toBe(true);
});

it('does not reject a failed model or mode change once the session row is gone', async () => {
  const { applyModel, applyPermissionMode } =
    await import('../../packages/control/dist/workbench-session.js');
  const f = workbenchFixture();
  const ctx = contextOf(f);
  const handle = { platform_session_id: 'deleted-session' } as SessionHandle;
  const refusing = {
    setPermissionMode: async () => ({ ok: false, reason: 'The transport closed' }),
    setModel: async () => {
      throw new Error('The transport closed');
    },
  } as unknown as HarnessAdapter;
  await expect(applyPermissionMode(ctx, refusing, handle, 'ask', 'plan')).resolves.toBeUndefined();
  await expect(
    applyModel(ctx, refusing, handle, {}, 'other-model', undefined),
  ).resolves.toBeUndefined();
});

it('records the delete of a session with a live process on its row and refuses new input', async () => {
  const f = workbenchFixture();
  const session = f.create();
  await provisioned(f, session);
  await eventually(
    () =>
      f.turns(session.id)[0]?.state === 'completed' &&
      current(f, session.id).state === 'open' &&
      hasProcess(f, session.id),
    () => f.control.tick(),
  );
  const release = holdClose(f);

  remove(f, session.id);
  expect(current(f, session.id).stop_requested).toMatchObject({ by: 'user' });
  expect(() =>
    f.call(
      'session.send',
      { session_id: session.id, input: 'One more thing' },
      current(f, session.id).revision,
    ),
  ).toThrow(expect.objectContaining({ code: 'invalid_state' }));
  release();
  await eventually(() => !f.store.get<Session>('sessions', session.id));
});

it('removes a deleted session once a retried close confirms its process stopped', async () => {
  const f = workbenchFixture();
  const session = f.create();
  await provisioned(f, session);
  await eventually(
    () =>
      f.turns(session.id)[0]?.state === 'completed' &&
      current(f, session.id).state === 'open' &&
      hasProcess(f, session.id),
    () => f.control.tick(),
  );
  vi.spyOn(f.adapter, 'close').mockImplementationOnce(async (_handle, deadline) => ({
    stopped: false,
    deadline,
    finished_at: new Date().toISOString(),
    evidence: { method: 'none', members: [] },
  }));

  remove(f, session.id);
  await eventually(
    () => kinds(f, session.id).includes('session.delete_failed'),
    () => f.control.tick(),
  );
  await eventually(
    () => !f.store.get<Session>('sessions', session.id),
    () => f.control.tick(),
  );
  expect(f.turns(session.id)).toEqual([]);
  expect(kinds(f, session.id)).toContain('session.deleted');
});

it('keeps a session a milestone came to require before a retried close confirmed its delete', async () => {
  const f = workbenchFixture();
  const session = f.create();
  await provisioned(f, session);
  await eventually(
    () =>
      f.turns(session.id)[0]?.state === 'completed' &&
      current(f, session.id).state === 'open' &&
      hasProcess(f, session.id),
    () => f.control.tick(),
  );
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const close = f.adapter.close.bind(f.adapter);
  vi.spyOn(f.adapter, 'close')
    .mockImplementationOnce(async (_handle, deadline) => ({
      stopped: false,
      deadline,
      finished_at: new Date().toISOString(),
      evidence: { method: 'none', members: [] },
    }))
    .mockImplementation(async (handle, deadline) => {
      await released;
      return close(handle, deadline);
    });

  remove(f, session.id);
  await eventually(
    () => kinds(f, session.id).includes('session.delete_failed'),
    () => f.control.tick(),
  );
  f.call<Milestone>('milestone.create', {
    project_id: f.project.id,
    title: 'Ship it',
    required_sessions: [session.id],
    criteria: ['It ships'],
  });
  await f.control.tick();
  release();
  await eventually(
    () =>
      kinds(f, session.id).includes('session.discarded') ||
      kinds(f, session.id).filter((kind) => kind === 'session.delete_failed').length === 2,
    () => f.control.tick(),
  );
  for (let i = 0; i < 3; i++) await f.control.tick();
  expect(current(f, session.id).outcome).toBeUndefined();
  expect(current(f, session.id).stop_requested).toBeUndefined();
  expect(kinds(f, session.id)).not.toContain('session.discarded');
  expect(existsSync(workspace.path)).toBe(true);
});

it('removes a session deleted before a restart once recovery discards it', async () => {
  const f = workbenchFixture();
  const session = f.create();
  await provisioned(f, session);
  await eventually(
    () => f.turns(session.id)[0]?.state === 'completed' && current(f, session.id).state === 'open',
    () => f.control.tick(),
  );
  // As the delete command leaves the row of a session whose process was still live.
  f.store.update<Session>(
    'sessions',
    {
      ...current(f, session.id),
      stop_requested: { reason: 'Deleted by the user', by: 'user', at: f.store.now() },
    },
    current(f, session.id).revision,
  );
  await f.restart(() => undefined);
  expect(f.store.get<Session>('sessions', session.id)).toBeUndefined();
  expect(kinds(f, session.id)).toContain('session.deleted');
});

it('keeps the files of a delete recovery finished in a transaction that failed', async () => {
  const f = workbenchFixture();
  const upload = f.control.addAttachment(
    user,
    f.project.id,
    'notes.txt',
    'text/plain',
    new TextEncoder().encode('notes'),
  );
  const session = f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Read the notes',
    attachments: [upload.id],
  });
  await settle(f, session);
  const history = path.join(f.root, 'state/native-sessions/own'),
    uploaded = path.join(f.root, 'state/attachments', f.project.id, upload.id);
  mkdirSync(history, { recursive: true });
  writeFileSync(path.join(history, 'history.jsonl'), '{}\n');
  f.store.update<Session>(
    'sessions',
    {
      ...current(f, session.id),
      native_state_dir: history,
      stop_requested: { reason: 'Deleted by the user', by: 'user', at: f.store.now() },
    },
    current(f, session.id).revision,
  );
  const transaction = f.store.transaction.bind(f.store);
  vi.spyOn(f.store, 'transaction').mockImplementation((fn) =>
    transaction(() => {
      const result = fn();
      if (!f.store.get<Session>('sessions', session.id)) throw new Error('commit failed');
      return result;
    }),
  );

  await expect(f.restart(() => undefined)).rejects.toThrow('commit failed');
  await new Promise((resolve) => setImmediate(resolve));
  vi.mocked(f.store.transaction).mockRestore();
  expect(f.store.get<Session>('sessions', session.id)).toBeDefined();
  expect(existsSync(history)).toBe(true);
  expect(existsSync(uploaded)).toBe(true);
});

it('discards without deleting a task session its lead stopped with the reason a delete records', async () => {
  const f = workbenchFixture();
  dispatchEveryTier(f);
  const lead = f.create('Plan the export');
  await settle(f, lead);
  const leadPrincipal: Principal = {
    id: `session:${lead.id}`,
    role: 'lead',
    project_id: f.project.id,
    session_id: lead.id,
    expires_at: f.store.now() + 60000,
  };
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [
        {
          id: 'a',
          title: 'Serve exports',
          goal: 'Exports work',
          lane: 'core',
          depends_on: [],
          source: ['Plan the export'],
          scope: [],
          acceptance: [],
          done_when: 'report',
        },
      ],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    leadPrincipal,
  );
  f.call('task.start', { project_id: f.project.id, task_ids: ['a'] }, null, leadPrincipal);
  await f.control.tick();
  const worker = f.store
    .list<Session>('sessions')
    .find((session) => session.task?.lead_session_id === lead.id)!;
  await eventually(
    () => hasProcess(f, worker.id),
    () => f.control.tick(),
  );

  f.call(
    'task.stop',
    { project_id: f.project.id, task_id: 'a', reason: 'Deleted by the user' },
    null,
    leadPrincipal,
  );
  await eventually(
    () => kinds(f, worker.id).includes('session.discarded'),
    () => f.control.tick(),
  );
  expect(f.store.get<Session>('sessions', worker.id)).toMatchObject({ outcome: 'discarded' });
  expect(kinds(f, worker.id)).not.toContain('session.deleted');
});

it('keeps native history another session reaches through an alias or a descendant', () => {
  const f = workbenchFixture();
  const root = path.join(f.root, 'state/native-sessions'),
    shared = path.join(root, 'shared'),
    parent = path.join(root, 'parent'),
    child = path.join(parent, 'child');
  for (const directory of [shared, child]) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'history.jsonl'), '{}\n');
  }
  symlinkSync(shared, path.join(root, 'alias'));
  const first = f.create('First'),
    second = f.create('Second'),
    third = f.create('Third'),
    fourth = f.create('Fourth');
  end(f, first.id, { outcome: 'discarded', native_state_dir: shared });
  end(f, second.id, { outcome: 'discarded', native_state_dir: path.join(root, 'alias') });
  end(f, third.id, { outcome: 'discarded', native_state_dir: parent });
  end(f, fourth.id, { outcome: 'discarded', native_state_dir: child });

  remove(f, first.id);
  expect(existsSync(path.join(shared, 'history.jsonl'))).toBe(true);
  remove(f, third.id);
  expect(existsSync(path.join(child, 'history.jsonl'))).toBe(true);
});

it('removes the worktree of a session deleted while it was still provisioning', async () => {
  const f = workbenchFixture();
  const session = f.create();
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);

  remove(f, session.id);
  await eventually(
    () => f.store.must<Workspace>('workspaces', workspace.id).removed_at !== undefined,
    () => f.control.tick(),
  );
  expect(existsSync(workspace.path)).toBe(false);
});

it('refuses to delete a lead that owns a board plan', () => {
  const f = workbenchFixture();
  const lead = f.create('Plan the export');
  const leadPrincipal: Principal = {
    id: `session:${lead.id}`,
    role: 'lead',
    project_id: f.project.id,
    session_id: lead.id,
    expires_at: f.store.now() + 60000,
  };
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [
        {
          id: 'a',
          title: 'Serve exports',
          goal: 'Exports work',
          lane: 'core',
          depends_on: [],
          source: ['Plan the export'],
          scope: ['src/export'],
          acceptance: ['pnpm test'],
        },
      ],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    leadPrincipal,
  );
  end(f, lead.id, { outcome: 'discarded' });

  expect(() => remove(f, lead.id)).toThrow(expect.objectContaining({ code: 'invalid_state' }));
  expect(f.store.get<Session>('sessions', lead.id)).toBeDefined();
  expect(f.store.get<BoardPlan>('board_plans', lead.id)).toBeDefined();
});

it('does not dispatch the turn of a session deleted while the scheduler awaited another start', async () => {
  const f = workbenchFixture();
  const release = holdStart(f);
  const first = f.create('First work'),
    second = f.create('Second work');
  await provisioned(f, first, second);
  const turnOf = new Map([first, second].map((session) => [f.turns(session.id)[0]!.id, session]));
  const order = f.store
    .pending()
    .filter((job) => job.kind === 'session.turn')
    .map((job) => turnOf.get((JSON.parse(job.payload) as { turn_id: string }).turn_id)!);
  expect(order).toHaveLength(2);
  const ticking = f.control.tick();
  await eventually(() => f.start.mock.calls.length > 0);

  remove(f, order[1]!.id);
  release();
  await expect(ticking).resolves.toBeUndefined();
  expect(f.store.get<Session>('sessions', order[1]!.id)).toBeUndefined();
});
