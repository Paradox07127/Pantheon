import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { id } from '@pantheon/domain';
import type {
  HarnessAdapter,
  Principal,
  Session,
  SessionHandle,
  Workspace,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { eventually, settle, user } from '../helpers.js';
import { dispatchEveryTier, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

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
  const session = await f.create();
  await provisioned(f, session);
  await eventually(
    () => f.turns(session.id)[0]?.state === 'running',
    () => f.control.tick(),
  );
  return current(f, session.id);
}

it('refuses to delete a session whose native process is still starting', async () => {
  const f = await workbenchFixture();
  const release = holdStart(f);
  const session = await f.create();
  await provisioned(f, session);
  const ticking = f.control.tick();
  await eventually(() => f.start.mock.calls.length > 0);

  expect(() => remove(f, session.id)).toThrow(expect.objectContaining({ code: 'resource_busy' }));
  release();
  await ticking;
  expect(current(f, session.id).outcome).toBeUndefined();
});

it('refuses to delete a reconciling or stop-pending session without a native handle', async () => {
  const f = await workbenchFixture();
  const reconciling = await f.create('Reconciling work'),
    stopping = await f.create('Stopping work');
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

it('keeps the files and the session of a delete whose command rolled back', async () => {
  const f = await workbenchFixture();
  const upload = f.control.addAttachment(
    user,
    f.project.id,
    'notes.txt',
    'text/plain',
    new TextEncoder().encode('notes'),
  );
  const session = await f.call<Session>('session.create', {
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
  const f = await workbenchFixture({ delay: 4000 });
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
  const f = await workbenchFixture({ delay: 4000 });
  const ctx = contextOf(f);
  const upload = f.control.addAttachment(
    user,
    f.project.id,
    'notes.txt',
    'text/plain',
    new TextEncoder().encode('notes'),
  );
  const session = await f.call<Session>('session.create', {
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
  const f = await workbenchFixture();
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
  const f = await workbenchFixture();
  const session = await f.create();
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
  const f = await workbenchFixture();
  const session = await f.create();
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

it('removes a session deleted before a restart once recovery discards it', async () => {
  const f = await workbenchFixture();
  const session = await f.create();
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
  await f.restart(() => undefined, { abandon: true });
  expect(f.store.get<Session>('sessions', session.id)).toBeUndefined();
  expect(kinds(f, session.id)).toContain('session.deleted');
});

it('discards, not deletes, a session whose stored stop names the earlier lead closer', async () => {
  const f = await workbenchFixture();
  const session = await f.create();
  await provisioned(f, session);
  await eventually(
    () => f.turns(session.id)[0]?.state === 'completed' && current(f, session.id).state === 'open',
    () => f.control.tick(),
  );
  const stored = {
    ...current(f, session.id),
    stop_requested: { reason: 'Deleted by the user', by: 'lead', at: f.store.now() },
  };
  f.store.update<Session>(
    'sessions',
    stored as unknown as Session,
    current(f, session.id).revision,
  );
  await f.restart(() => undefined, { abandon: true });
  expect(current(f, session.id).outcome).toBe('discarded');
  expect(kinds(f, session.id)).not.toContain('session.deleted');
});

it('keeps the files of a delete recovery finished in a transaction that failed', async () => {
  const f = await workbenchFixture();
  const upload = f.control.addAttachment(
    user,
    f.project.id,
    'notes.txt',
    'text/plain',
    new TextEncoder().encode('notes'),
  );
  const session = await f.call<Session>('session.create', {
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

it('keeps native history another session reaches through an alias or a descendant', async () => {
  const f = await workbenchFixture();
  const root = path.join(f.root, 'state/native-sessions'),
    shared = path.join(root, 'shared'),
    parent = path.join(root, 'parent'),
    child = path.join(parent, 'child');
  for (const directory of [shared, child]) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'history.jsonl'), '{}\n');
  }
  symlinkSync(shared, path.join(root, 'alias'));
  const first = await f.create('First'),
    second = await f.create('Second'),
    third = await f.create('Third'),
    fourth = await f.create('Fourth');
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
  const f = await workbenchFixture();
  const session = await f.create();
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);

  remove(f, session.id);
  await eventually(
    () => f.store.must<Workspace>('workspaces', workspace.id).removed_at !== undefined,
    () => f.control.tick(),
  );
  expect(existsSync(workspace.path)).toBe(false);
});

it('does not dispatch the turn of a session deleted while the scheduler awaited another start', async () => {
  const f = await workbenchFixture();
  const release = holdStart(f);
  const first = await f.create('First work'),
    second = await f.create('Second work');
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
