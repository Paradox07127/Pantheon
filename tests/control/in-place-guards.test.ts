import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
  DomainError,
  type Project,
  type ProcessIdentity,
  type Session,
  type SessionTurn,
  type Workspace,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { withoutNativeConversation } from '../../packages/control/dist/session.js';
import { eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const contextOf = (f: Fixture) => (f.control as unknown as { ctx: ControlContext }).ctx;
const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const events = (f: Fixture, kind: string, aggregateId?: string) =>
  f.store
    .events(0, undefined, 10000)
    .filter(
      (event) =>
        event.kind === kind && (aggregateId === undefined || event.aggregate_id === aggregateId),
    );

/** Everything a write to the folder or its repository would change. */
const folderState = (folder: string) => ({
  entries: readdirSync(folder, { recursive: true }).map(String).sort(),
  head: git(folder, 'rev-parse', 'HEAD'),
  refs: git(folder, 'for-each-ref'),
  worktrees: git(folder, 'worktree', 'list', '--porcelain'),
});

function refusal(run: () => unknown): DomainError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return error as DomainError;
  }
  throw new Error('Expected a refusal');
}

/** The row an adoption leaves for the user's folder. */
function inPlaceWorkspace(f: Fixture, folder = f.source, extra: Partial<Workspace> = {}) {
  const resolved = realpathSync(folder);
  return f.store.insert<Workspace>('workspaces', {
    id: randomUUID(),
    revision: 1,
    project_id: f.project.id,
    kind: 'in_place',
    path: resolved,
    source: resolved,
    owner: 'none',
    ownership_epoch: 0,
    ...extra,
  });
}

/** A session that continues the user's native session in the workspace, as an adoption opens it. */
function inPlaceSession(f: Fixture, workspace: Workspace, extra: Partial<Session> = {}) {
  return f.store.insert<Session>('sessions', {
    id: randomUUID(),
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    device_id: 'local',
    native_id: randomUUID(),
    state: 'open',
    turn_count: 0,
    workspace_id: workspace.id,
    permission_mode: 'ask',
    ...extra,
  });
}

async function send(f: Fixture, session: Session, input = 'Continue') {
  f.call('session.send', { session_id: session.id, input }, current(f, session.id).revision);
  await eventually(
    () =>
      current(f, session.id).state === 'open' &&
      f.turns(session.id).every((turn) => !['queued', 'running'].includes(turn.state)),
    () => f.control.tick(),
  );
  return f.turns(session.id).at(-1)!;
}

it('writes no checkpoint ref into the user folder before a turn', async () => {
  const f = await workbenchFixture({ adoptable: true });
  // A detached HEAD is where a worktree session's checkpoint would be written.
  git(f.source, 'checkout', '--quiet', '--detach');
  const session = inPlaceSession(f, inPlaceWorkspace(f));
  const turn = await send(f, session);
  expect(turn.state).toBe('completed');
  expect(git(f.source, 'for-each-ref', 'refs/pantheon/')).toBe('');
  expect(events(f, 'session.checkpoint_failed', session.id)).toEqual([]);
});

it('lists no turn to roll back to for a session in the user folder', async () => {
  const f = await workbenchFixture({ adoptable: true });
  git(f.source, 'checkout', '--quiet', '--detach');
  const session = inPlaceSession(f, inPlaceWorkspace(f));
  expect((await send(f, session)).state).toBe('completed');
  const row = f.list().find((each) => each.id === session.id);
  expect(row).toBeDefined();
  expect(row).not.toHaveProperty('checkpoint_turn_id');
});

it('refuses to roll back a session in the user folder and keeps its native session', async () => {
  const f = await workbenchFixture({ adoptable: true });
  git(f.source, 'checkout', '--quiet', '--detach');
  const session = inPlaceSession(f, inPlaceWorkspace(f));
  const turn = await send(f, session);
  expect(turn.state).toBe('completed');
  writeFileSync(path.join(f.source, 'after.txt'), 'kept\n');
  const before = folderState(f.source);
  const refused = refusal(() =>
    f.call(
      'session.rollback',
      { session_id: session.id, turn_id: turn.id },
      current(f, session.id).revision,
    ),
  );
  expect(refused.code).toBe('invalid_state');
  expect(folderState(f.source)).toEqual(before);
  expect(current(f, session.id).native_id).toBe(session.native_id);
});

it('refuses to clear the native session of a session in the user folder for a runtime change', async () => {
  const f = await workbenchFixture({ adoptable: true });
  const ctx = contextOf(f);
  const session = inPlaceSession(f, inPlaceWorkspace(f));
  expect(refusal(() => withoutNativeConversation(ctx, session)).code).toBe('invalid_state');
  const worktree = await f.create();
  expect(withoutNativeConversation(ctx, { ...worktree, native_id: 'native' }).native_id).toBe(
    undefined,
  );
});

it("sends a turn to Pantheon's own live process but refuses it while another process holds the native session", async () => {
  const f = await workbenchFixture({ adoptable: true });
  const ctx = contextOf(f);
  // Pids above the platform maximum, so no real process is ever named.
  const own = 999_999,
    other = 999_998,
    startedMs = Date.now() - 60_000;
  const identities = new Map<number, ProcessIdentity>([
    [own, { pid: own, start_time_us: startedMs * 1000 }],
    [other, { pid: other, start_time_us: startedMs * 1000 }],
  ]);
  Object.assign(ctx, { readProcess: (pid: number) => identities.get(pid) });
  const session = inPlaceSession(f, inPlaceWorkspace(f));
  expect((await send(f, session)).state).toBe('completed');
  const sessions = path.join(f.protectionPaths.home, '.claude/sessions');
  mkdirSync(sessions, { recursive: true });
  const holds = (pid: number) =>
    writeFileSync(
      path.join(sessions, `${pid}.json`),
      JSON.stringify({ pid, procStart: startedMs, sessionId: session.native_id, cwd: f.source }),
    );
  const ownProcess = () => {
    const live = current(f, session.id);
    f.store.update<Session>(
      'sessions',
      { ...live, process_identity: identities.get(own) },
      live.revision,
    );
  };

  holds(own);
  ownProcess();
  expect((await send(f, session)).state).toBe('completed');

  holds(other);
  ownProcess();
  const refused = await send(f, session);
  expect(refused.state).toBe('failed');
  expect(events(f, 'turn.failed', refused.id).at(-1)?.payload).toMatchObject({
    error_code: 'native_session_busy',
  });
  expect(current(f, session.id).state).toBe('open');
  expect(f.resume).toHaveBeenCalledTimes(1);
  Object.assign(ctx, { readProcess: () => undefined });
});

it('adopts again from a folder whose in-place row belonged to a removed project', async () => {
  const f = await workbenchFixture({ adoptable: true });
  const removed = f.store.insert<Project>('projects', {
    id: randomUUID(),
    revision: 1,
    name: 'Removed project',
    roots: [path.join(f.root, 'gone')],
    removed_at: f.store.now(),
  });
  const stale = inPlaceWorkspace(f, f.source, { project_id: removed.id });
  const nativeId = randomUUID();
  f.nativeRecord(nativeId);
  await f.control.traceScan(5000);
  const session = f.call<Session>('session.adopt', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    native_session_id: nativeId,
  });
  expect(session.workspace_id).toBe(stale.id);
  expect(f.store.must<Workspace>('workspaces', stale.id)).toMatchObject({
    project_id: f.project.id,
    source: realpathSync(f.source),
    kind: 'in_place',
  });
});

it('deletes a session in the user folder without removing the folder', async () => {
  const f = await workbenchFixture({ adoptable: true });
  // Inside the managed root, so only the workspace kind keeps the removal away.
  const folder = path.join(f.root, 'managed', 'user-folder');
  mkdirSync(folder);
  git(folder, 'init', '--quiet', '--initial-branch=main');
  // The commit would start background maintenance, whose lock file comes and goes.
  git(folder, 'config', 'maintenance.auto', 'false');
  writeFileSync(path.join(folder, 'notes.txt'), 'mine\n');
  git(folder, 'add', '.');
  git(folder, 'commit', '--quiet', '-m', 'User files');
  const workspace = inPlaceWorkspace(f, folder);
  const session = inPlaceSession(f, workspace);
  const before = folderState(folder);
  f.call('session.delete', { session_id: session.id }, session.revision);
  await eventually(
    () => !f.store.pending().some((job) => job.kind === 'workspace.remove'),
    () => f.control.tick(),
  );
  expect(existsSync(folder)).toBe(true);
  expect(folderState(folder)).toEqual(before);
  expect(f.store.must<Workspace>('workspaces', workspace.id).removed_at).toBeUndefined();
  expect(events(f, 'workspace.removed', workspace.id)).toEqual([]);
});

it('leaves the user folder and its sessions alone when provisioning reaches its row', async () => {
  const f = await workbenchFixture({ adoptable: true });
  const ctx = contextOf(f);
  const workspace = inPlaceWorkspace(f, f.source, {
    provisioning: { state: 'queued', base_ref: 'HEAD' },
  });
  const session = inPlaceSession(f, workspace);
  const before = folderState(f.source);
  f.store.enqueue('workspace.provision', { workspace_id: workspace.id });
  await f.control.tick();
  await Promise.all([...ctx.completions]);
  expect(f.store.pending().some((job) => job.kind === 'workspace.provision')).toBe(false);
  expect(f.store.must<Workspace>('workspaces', workspace.id).revision).toBe(workspace.revision);
  expect(current(f, session.id).state).toBe('open');
  expect(folderState(f.source)).toEqual(before);
});

it('keeps an in-place session whose turns never ran out of reconciling after a restart', async () => {
  const f = await workbenchFixture({ adoptable: true });
  const workspace = inPlaceWorkspace(f);
  const idle = inPlaceSession(f, workspace);
  const waiting = inPlaceSession(f, workspace, { state: 'running', turn_count: 1 });
  const turn = f.store.insert<SessionTurn>('session_turns', {
    id: randomUUID(),
    revision: 1,
    project_id: f.project.id,
    session_id: waiting.id,
    input: 'Continue',
    kind: 'send',
    delivery: 'pending',
    state: 'queued',
  });
  await f.restart();
  expect(current(f, idle.id).state).toBe('open');
  expect(current(f, waiting.id).state).not.toBe('reconciling');
  await eventually(
    () => f.store.must<SessionTurn>('session_turns', turn.id).state === 'completed',
    () => f.control.tick(),
  );
  expect(events(f, 'session.reconciling', waiting.id)).toEqual([]);
});

it('offers no discard or merge for a session in the user folder', async () => {
  const f = await workbenchFixture({ adoptable: true });
  const workspace = inPlaceWorkspace(f);
  const reconciling = inPlaceSession(f, workspace, { state: 'reconciling' });
  const blocked = inPlaceSession(f, workspace, { merge: { state: 'blocked', reason: 'conflict' } });
  f.store.event('session.reconciling', reconciling, f.project.id, { reason: 'daemon_restart' });
  const items = f.control.needsYou(user, f.project.id).items;
  const actions = (sessionId: string) =>
    items
      .filter((item) => item.source.id === sessionId)
      .flatMap((item) => item.actions.map((action) => action.command));
  expect(actions(reconciling.id)).toEqual(['session.resolve']);
  expect(actions(blocked.id)).not.toContain('session.merge');
});

it('records the error code of a turn whose launch failed with a domain error, and none for other errors', async () => {
  const f = await workbenchFixture({ adoptable: true });
  const session = inPlaceSession(f, inPlaceWorkspace(f));
  f.resume.mockRejectedValueOnce(
    new DomainError('billing_channel_mismatch', 'Backend provider is not in effect'),
  );
  const coded = await send(f, session);
  expect(coded.state).toBe('failed');
  expect(events(f, 'turn.failed', coded.id).at(-1)?.payload).toMatchObject({
    error_code: 'billing_channel_mismatch',
  });
  const lastTurn = () => f.list().find((row) => row.id === session.id)!.last_turn;
  expect(lastTurn()).toMatchObject({ id: coded.id, error_code: 'billing_channel_mismatch' });
  f.resume.mockRejectedValueOnce(new Error('spawn failed'));
  const plain = await send(f, session);
  expect(plain.state).toBe('failed');
  expect(events(f, 'turn.failed', plain.id).at(-1)?.payload).not.toHaveProperty('error_code');
  expect(lastTurn()).toMatchObject({ id: plain.id, state: 'failed' });
  expect(lastTurn()).not.toHaveProperty('error_code');
});
