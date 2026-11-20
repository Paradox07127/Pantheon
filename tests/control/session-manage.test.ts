import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type {
  Approval,
  Milestone,
  Principal,
  Review,
  Session,
  SessionTurn,
  Workspace,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const planner = (f: Fixture): Principal => ({
  id: 'planner',
  role: 'planner',
  project_id: f.project.id,
});
const run = <T = Session>(
  f: Fixture,
  type: 'session.pin' | 'session.archive' | 'session.unarchive' | 'session.delete',
  sessionId: string,
  extra: Record<string, unknown> = {},
  principal: Principal = user,
) =>
  f.call<T>(type, { session_id: sessionId, ...extra }, current(f, sessionId).revision, principal);
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

async function idleSession(f: Fixture) {
  const session = await f.create();
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.turns(session.id).every((turn) => turn.state === 'completed') &&
      current(f, session.id).state === 'open',
    () => f.control.tick(),
  );
  return current(f, session.id);
}

it('pins and unpins a session for the user only', async () => {
  const f = await workbenchFixture();
  const session = await f.create();
  expect(() => run(f, 'session.pin', session.id, { pinned: true }, planner(f))).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
  const pinned = run(f, 'session.pin', session.id, { pinned: true });
  expect(pinned.pinned_at).toBe(new Date(Date.parse(pinned.pinned_at!)).toISOString());
  expect(f.list()[0]).toMatchObject({ id: session.id, pinned_at: pinned.pinned_at });
  const unpinned = run(f, 'session.pin', session.id, { pinned: false });
  expect(unpinned).not.toHaveProperty('pinned_at');
  expect(f.list()[0]).not.toHaveProperty('pinned_at');
  expect(kinds(f, session.id)).toEqual(
    expect.arrayContaining(['session.pinned', 'session.unpinned']),
  );
});

it('archives an ended session, keeps it listed and restores it', async () => {
  const f = await workbenchFixture();
  const session = await f.create();
  expect(() => run(f, 'session.archive', session.id)).toThrow(
    expect.objectContaining({ code: 'invalid_state' }),
  );
  end(f, session.id, { outcome: 'discarded' });
  expect(() => run(f, 'session.archive', session.id, {}, planner(f))).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
  const archived = run(f, 'session.archive', session.id);
  expect(typeof archived.archived_at).toBe('string');
  expect(f.list()).toMatchObject([
    { id: session.id, state: 'discarded', archived_at: archived.archived_at },
  ]);
  expect(() => run(f, 'session.unarchive', session.id, {}, planner(f))).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
  expect(run(f, 'session.unarchive', session.id)).not.toHaveProperty('archived_at');
  expect(f.list()[0]).not.toHaveProperty('archived_at');
  expect(kinds(f, session.id)).toEqual(
    expect.arrayContaining(['session.archived', 'session.unarchived']),
  );
});

it('archives a failed session', async () => {
  const f = await workbenchFixture();
  const session = await f.create();
  end(f, session.id, {});
  expect(f.list()[0]).toMatchObject({ state: 'failed' });
  expect(typeof run(f, 'session.archive', session.id).archived_at).toBe('string');
});

it.each(['idle', 'ready'] as const)(
  'archives a listed %s session without removing its worktree or closing its native session',
  async (state) => {
    const f = await workbenchFixture();
    const session = await idleSession(f);
    const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
    if (state === 'ready') {
      writeFileSync(path.join(workspace.path, 'answer.txt'), 'changed\n');
      git(workspace.path, 'add', '.');
      git(workspace.path, 'commit', '--quiet', '-m', 'Change answer');
    }
    await f.prefetch();
    expect(f.list()[0]).toMatchObject({ state });
    const handle = [...f.control.handles.values()].find(
      (handle) => handle.platform_session_id === session.id,
    );
    expect(handle).toBeDefined();
    const close = vi.spyOn(f.adapter, 'close'),
      cancel = vi.spyOn(f.adapter, 'cancel');

    const archived = run(f, 'session.archive', session.id);
    expect(archived).toEqual({
      ...session,
      revision: session.revision + 1,
      archived_at: expect.any(String),
    });
    expect(f.list()[0]).toMatchObject({ state, archived_at: archived.archived_at });
    await f.control.tick();
    expect(existsSync(workspace.path)).toBe(true);
    expect(f.store.must<Workspace>('workspaces', workspace.id)).toEqual(workspace);
    expect([...f.control.handles.values()]).toContain(handle);
    expect(close).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();

    expect(run(f, 'session.unarchive', session.id)).not.toHaveProperty('archived_at');
    expect(f.list()[0]).toMatchObject({ state });
    expect(f.list()[0]).not.toHaveProperty('archived_at');
  },
);

it('refuses to archive a running session and names the allowed states', async () => {
  const f = await workbenchFixture({ delay: 4000 });
  const session = await f.create();
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.turns(session.id)[0]?.state === 'running',
    () => f.control.tick(),
  );
  expect(f.list()[0]).toMatchObject({ state: 'running' });
  expect(() => run(f, 'session.archive', session.id)).toThrow(
    expect.objectContaining({
      code: 'invalid_state',
      message: 'Only merged, discarded, failed, done, idle or ready sessions can be archived',
    }),
  );
  expect(current(f, session.id)).not.toHaveProperty('archived_at');
});

it.each(['waiting', 'merging', 'reconciling'] as const)(
  'refuses to archive a %s session',
  async (state) => {
    const f = await workbenchFixture();
    const session = await idleSession(f);
    if (state === 'waiting')
      f.store.insert<Approval>('approvals', {
        id: 'pending-permission',
        revision: 1,
        project_id: f.project.id,
        kind: 'permission',
        session_id: session.id,
        request_id: 'request-1',
        tool: 'Bash',
        input_hash: 'a'.repeat(64),
        decider: 'user',
        state: 'pending',
        created_at: f.store.now(),
      });
    else
      f.store.update<Session>(
        'sessions',
        {
          ...session,
          ...(state === 'merging' ? { merge: { state: 'running' as const } } : { state }),
        },
        session.revision,
      );
    expect(f.list()[0]).toMatchObject(
      state === 'reconciling' ? { state: 'idle', reconciling: true } : { state },
    );
    expect(() => run(f, 'session.archive', session.id)).toThrow(
      expect.objectContaining({ code: 'invalid_state' }),
    );
    expect(current(f, session.id)).not.toHaveProperty('archived_at');
  },
);

it.each(['session.send', 'session.steer'] as const)(
  '%s restores an archived idle session before queuing the turn',
  async (type) => {
    const f = await workbenchFixture();
    const session = await idleSession(f);
    const archived = f.store.update<Session>(
      'sessions',
      { ...session, archived_at: new Date(f.store.now()).toISOString() },
      session.revision,
    );
    const turn = f.call<SessionTurn>(
      type,
      { session_id: session.id, input: 'Continue the work' },
      archived.revision,
    );
    const restored = current(f, session.id);
    expect(restored).not.toHaveProperty('archived_at');
    expect(restored).toMatchObject({ state: 'running', turn_count: session.turn_count + 1 });
    expect(f.list()[0]).not.toHaveProperty('archived_at');
    expect(turn).toMatchObject({
      session_id: session.id,
      input: 'Continue the work',
      kind: type === 'session.send' ? 'send' : 'steer',
      state: 'queued',
      delivery: 'pending',
    });
    expect(f.turns(session.id)).toHaveLength(2);
    expect(f.turns(session.id)).toContainEqual(turn);
    expect(
      f.store
        .pending()
        .some((job) => job.kind === 'session.turn' && JSON.parse(job.payload).turn_id === turn.id),
    ).toBe(true);
    const events = f.store
      .events(0, undefined, 100000)
      .filter(
        (event) =>
          (event.aggregate_id === session.id && event.kind === 'session.unarchived') ||
          (event.aggregate_id === turn.id && event.kind === 'turn.queued'),
      );
    expect(events).toMatchObject([
      {
        kind: 'session.unarchived',
        aggregate_id: session.id,
        aggregate_revision: restored.revision,
        project_id: session.project_id,
        payload: {},
      },
      { kind: 'turn.queued', aggregate_id: turn.id },
    ]);
    expect(events[0]!.payload).toEqual({});
    expect(events[0]!.causation_id).toBe(events[1]!.causation_id);
    expect(existsSync(f.store.must<Workspace>('workspaces', session.workspace_id!).path)).toBe(
      true,
    );
  },
);

it('refuses to delete for another principal, a merged session and one a milestone names', async () => {
  const f = await workbenchFixture();
  const merged = await f.create('Merged work'),
    named = await f.create('Named work'),
    free = await f.create('Free work');
  end(f, merged.id, { outcome: 'merged' });
  end(f, named.id, { outcome: 'discarded' });
  end(f, free.id, { outcome: 'discarded' });
  f.call<Milestone>('milestone.create', {
    project_id: f.project.id,
    title: 'Ship it',
    required_sessions: [named.id],
    criteria: ['It ships'],
  });
  expect(() => run(f, 'session.delete', free.id, {}, planner(f))).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
  expect(() => run(f, 'session.delete', merged.id)).toThrow(
    expect.objectContaining({ code: 'invalid_state' }),
  );
  expect(() => run(f, 'session.delete', named.id)).toThrow(
    expect.objectContaining({ code: 'invalid_state' }),
  );
  expect(f.list().map((session) => session.id)).toEqual([merged.id, named.id, free.id]);
});

it('deletes a running worktree session: closes its process, removes its worktree and rows, keeps its events', async () => {
  const f = await workbenchFixture({ delay: 4000 });
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
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
    // A session the user opened has no managed native store to remove.
    purpose: 'lead',
  });
  const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.turns(session.id)[0]?.state === 'running',
    () => f.control.tick(),
  );
  const nativeDir = current(f, session.id).native_state_dir!;
  mkdirSync(nativeDir, { recursive: true });
  const uploaded = path.join(f.root, 'state/attachments', f.project.id, upload.id);
  expect(existsSync(uploaded)).toBe(true);
  const title = current(f, session.id).title;

  run(f, 'session.delete', session.id);
  await eventually(
    () => f.store.get<Session>('sessions', session.id) === undefined,
    () => f.control.tick(),
  );
  await eventually(
    () => f.store.must<Workspace>('workspaces', workspace.id).removed_at !== undefined,
    () => f.control.tick(),
  );
  expect([...ctx.handles.values()].some((h) => h.platform_session_id === session.id)).toBe(false);
  expect(existsSync(workspace.path)).toBe(false);
  expect(f.turns(session.id)).toEqual([]);
  expect(
    f.store.list<Approval>('approvals').filter((approval) => approval.session_id === session.id),
  ).toEqual([]);
  expect(f.list()).toEqual([]);
  expect(existsSync(uploaded)).toBe(false);
  expect(existsSync(nativeDir)).toBe(false);
  expect(kinds(f, session.id)).toEqual(
    expect.arrayContaining(['session.opened', 'session.discarded', 'session.deleted']),
  );
  expect(
    f.store
      .events(0, undefined, 100000)
      .find((event) => event.kind === 'session.deleted' && event.aggregate_id === session.id)
      ?.payload,
  ).toEqual({ title });
});

it('deletes an ended session with its reviews and keeps native history outside the state root or still in use', async () => {
  const f = await workbenchFixture();
  const outside = path.join(f.root, 'outside-history'),
    shared = path.join(f.root, 'state/native-sessions/shared');
  for (const directory of [outside, shared]) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'history.jsonl'), '{}\n');
  }
  const legacy = await f.create('Legacy history'),
    first = await f.create('First sharer'),
    second = await f.create('Second sharer');
  end(f, legacy.id, { outcome: 'discarded', native_state_dir: outside });
  end(f, first.id, { outcome: 'discarded', native_state_dir: shared });
  end(f, second.id, { outcome: 'discarded', native_state_dir: shared });
  f.store.insert<Review>('reviews', {
    id: 'review-of-first',
    revision: 1,
    project_id: f.project.id,
    session_id: first.id,
    round: 1,
    runtimes: ['codex'],
    state: 'completed',
    findings: [],
    session_ids: [],
  });

  // Files go once the command has committed.
  const committed = () => new Promise((resolve) => setImmediate(resolve));
  run(f, 'session.delete', legacy.id);
  await committed();
  expect(f.store.get<Session>('sessions', legacy.id)).toBeUndefined();
  expect(existsSync(outside)).toBe(true);
  run(f, 'session.delete', first.id);
  await committed();
  expect(f.store.get<Review>('reviews', 'review-of-first')).toBeUndefined();
  expect(existsSync(shared)).toBe(true);
  run(f, 'session.delete', second.id);
  await committed();
  expect(existsSync(shared)).toBe(false);
  expect(
    f.store
      .list<SessionTurn>('session_turns')
      .filter((turn) => [legacy.id, first.id, second.id].includes(turn.session_id)),
  ).toEqual([]);
  expect(f.store.list<Workspace>('workspaces').map((workspace) => workspace.id)).toEqual(
    expect.arrayContaining([legacy.workspace_id, first.workspace_id, second.workspace_id]),
  );
});

it('shows a plan task whose only session was deleted as a task without sessions', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export');
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
    {
      id: `session:${lead.id}`,
      role: 'lead',
      project_id: f.project.id,
      session_id: lead.id,
      expires_at: f.store.now() + 60000,
    },
  );
  const worker = await f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Build it',
    task_id: `${lead.id}:a`,
  });
  await awaitWorkspaceReady(f.control, worker.workspace_id!);
  end(f, worker.id, { outcome: 'discarded' });
  run(f, 'session.delete', worker.id);
  const task = f.control
    .boardView(user, f.project.id, 1)
    .tasks.find((row) => row.id === `${lead.id}:a`);
  expect(task).toMatchObject({ status: 'todo', segments: [] });
});
