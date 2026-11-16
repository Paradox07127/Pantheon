import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import type { Principal, Session, Workspace } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = ReturnType<typeof workbenchFixture>;

/** A session whose first turn has ended, with its ready worktree and the source HEAD it started from. */
async function idleSession(f: Fixture) {
  const sourceHead = git(f.source, 'rev-parse', 'HEAD');
  const session = f.create();
  const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.turns(session.id)[0]!.state === 'completed' &&
      f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  return { session, workspace, sourceHead };
}

/** Leaves one uncommitted edit, one untracked file and one committed new file in the worktree. */
function changeWorktree(work: string) {
  writeFileSync(path.join(work, 'answer.txt'), 'changed\nsecond\n');
  writeFileSync(path.join(work, 'notes.txt'), 'one\ntwo\nthree\n');
  writeFileSync(path.join(work, 'committed.txt'), 'kept\n');
  git(work, 'add', 'committed.txt');
  git(work, 'commit', '--quiet', '-m', 'Add a committed file');
}

const discard = (f: Fixture, sessionId: string, principal: Principal = user) =>
  f.call<Session>(
    'session.discard',
    { session_id: sessionId },
    f.store.must<Session>('sessions', sessionId).revision,
    principal,
  );

it('lists committed, uncommitted and untracked changes against the session base commit', async () => {
  const f = workbenchFixture();
  const { session, workspace, sourceHead } = await idleSession(f);
  changeWorktree(workspace.path);
  const diff = await f.control.sessionDiff(user, session.id);
  expect(diff).toMatchObject({
    session_id: session.id,
    base_sha: sourceHead,
    head_sha: git(workspace.path, 'rev-parse', 'HEAD'),
    truncated: false,
  });
  expect(workspace.base_sha).toBe(sourceHead);
  expect([...diff.files].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
    { path: 'answer.txt', additions: 2, deletions: 1, untracked: false },
    { path: 'committed.txt', additions: 1, deletions: 0, untracked: false },
    { path: 'notes.txt', additions: 3, deletions: 0, untracked: true },
  ]);
  expect(diff.patch).toContain('+changed');
  expect(diff.patch).toContain('+kept');
  expect(diff.patch).toContain('+three');
});

it.each(['answer.txt', 'answer.txt\n'])(
  'counts the lines of an untracked symbolic link to %j in the list as the diff does',
  async (target) => {
    const f = workbenchFixture();
    const { session, workspace } = await idleSession(f);
    symlinkSync(target, path.join(workspace.path, 'link.txt'));
    const diff = await f.control.sessionDiff(user, session.id);
    expect(diff.files).toEqual([{ path: 'link.txt', additions: 1, deletions: 0, untracked: true }]);
    expect(f.list()[0]!.changes).toEqual({ files: 1, additions: 1, deletions: 0 });
  },
);

it('lists a session as ready only once it has commits and nothing uncommitted', async () => {
  const f = workbenchFixture();
  const { session, workspace } = await idleSession(f);
  // The list reuses a worktree read for two seconds; an edit outside a turn shows after that.
  vi.useFakeTimers({ toFake: ['Date'] });
  onTestFinished(() => void vi.useRealTimers());
  const later = () => vi.setSystemTime(Date.now() + 2000);
  expect(f.list()[0]).toMatchObject({
    state: 'idle',
    changes: { files: 0, additions: 0, deletions: 0 },
  });
  writeFileSync(path.join(workspace.path, 'notes.txt'), 'uncommitted only\n');
  later();
  expect(f.list()[0]).toMatchObject({
    state: 'idle',
    changes: { files: 1, additions: 1, deletions: 0 },
  });
  changeWorktree(workspace.path);
  const diff = await f.control.sessionDiff(user, session.id);
  later();
  expect(f.list()[0]).toMatchObject({
    state: 'idle',
    changes: {
      files: diff.files.length,
      additions: diff.files.reduce((sum, file) => sum + file.additions!, 0),
      deletions: diff.files.reduce((sum, file) => sum + file.deletions!, 0),
    },
  });
  git(workspace.path, 'add', '--all');
  git(workspace.path, 'commit', '--quiet', '-m', 'Commit the rest');
  later();
  expect(f.list()[0]).toMatchObject({
    state: 'ready',
    changes: { files: diff.files.length },
  });
});

it('counts untracked lines without Git, binary files as none and only the first 2000 files', async () => {
  const f = workbenchFixture();
  const { workspace } = await idleSession(f);
  writeFileSync(path.join(workspace.path, 'a-last-line.txt'), 'one\ntwo');
  writeFileSync(path.join(workspace.path, 'binary.bin'), 'a\0b\nc\n');
  mkdirSync(path.join(workspace.path, 'many'));
  for (let index = 0; index <= 2000; index++)
    writeFileSync(
      path.join(workspace.path, 'many', `file-${String(index).padStart(4, '0')}.txt`),
      'first\nsecond\n',
    );
  // Lines come from a-last-line.txt, binary.bin and the first 1998 files under many/.
  expect(f.list()[0]!.changes).toEqual({ files: 2003, additions: 2 + 1998 * 2, deletions: 0 });
}, 120000);

it('stops reading untracked files one by one past the diff bound and leaves their counts unknown', async () => {
  const f = workbenchFixture();
  const { session, workspace } = await idleSession(f);
  mkdirSync(path.join(workspace.path, 'many'));
  for (let index = 0; index <= 200; index++)
    writeFileSync(
      path.join(workspace.path, 'many', `file-${String(index).padStart(3, '0')}.txt`),
      'first\n',
    );
  const diff = await f.control.sessionDiff(user, session.id);
  expect(diff.files).toHaveLength(201);
  expect(diff.files[199]).toEqual({
    path: 'many/file-199.txt',
    additions: 1,
    deletions: 0,
    untracked: true,
  });
  expect(diff.files[200]).toEqual({
    path: 'many/file-200.txt',
    additions: null,
    deletions: null,
    untracked: true,
  });
  expect(diff).toMatchObject({ patch: null, truncated: true });
}, 120000);

it('discards an idle session and removes its worktree', async () => {
  const f = workbenchFixture();
  const { session, workspace } = await idleSession(f);
  changeWorktree(workspace.path);
  discard(f, session.id);
  await eventually(
    () => f.store.must<Workspace>('workspaces', workspace.id).removed_at !== undefined,
    () => f.control.tick(),
  );
  expect(f.store.must<Session>('sessions', session.id)).toMatchObject({
    state: 'closed',
    outcome: 'discarded',
  });
  expect(f.list()[0]).toMatchObject({ state: 'discarded', changes: null });
  expect(existsSync(workspace.path)).toBe(false);
  expect(git(f.source, 'worktree', 'list')).not.toContain(workspace.path);
});

it('closes the native process of a running session before discarding it', async () => {
  const f = workbenchFixture({ delay: 4000 });
  const close = vi.spyOn(f.adapter, 'close');
  const session = f.create();
  const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.turns(session.id)[0]!.state === 'running',
    () => f.control.tick(),
  );
  expect(f.list()[0]).toMatchObject({
    state: 'running',
    changes: { files: 0, additions: 0, deletions: 0 },
  });
  discard(f, session.id);
  await eventually(
    () => f.store.must<Workspace>('workspaces', workspace.id).removed_at !== undefined,
    () => f.control.tick(),
  );
  expect(close).toHaveBeenCalled();
  expect(f.store.must<Session>('sessions', session.id)).toMatchObject({
    state: 'closed',
    outcome: 'discarded',
  });
  expect(f.turns(session.id)[0]!.state).not.toBe('running');
});

it('refuses to discard twice, a session without a worktree and a non-user principal', async () => {
  const f = workbenchFixture();
  const { session } = await idleSession(f);
  const planner: Principal = {
    id: 'planner',
    role: 'planner',
    project_id: f.project.id,
  };
  expect(() => discard(f, session.id, planner)).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
  const plain = f.store.insert<Session>('sessions', {
    id: 'plain-conversation',
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    state: 'open',
    turn_count: 0,
  });
  expect(() => discard(f, plain.id)).toThrow(expect.objectContaining({ code: 'invalid_state' }));
  discard(f, session.id);
  await eventually(
    () => f.store.must<Session>('sessions', session.id).outcome === 'discarded',
    () => f.control.tick(),
  );
  expect(() => discard(f, session.id)).toThrow(expect.objectContaining({ code: 'invalid_state' }));
});

it('refuses a session diff to a principal outside the project', async () => {
  const f = workbenchFixture();
  const { session } = await idleSession(f);
  const outsider: Principal = {
    id: 'outsider',
    role: 'planner',
    project_id: 'another-project',
  };
  await expect(f.control.sessionDiff(outsider, session.id)).rejects.toMatchObject({
    code: 'permission_denied',
  });
});
