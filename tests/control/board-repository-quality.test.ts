import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Session, Workspace } from '@pantheon/domain';
import * as gitCommands from '../../packages/control/dist/git.js';
import { DISK_REFRESH_MS } from '../../packages/control/dist/workspace-stale.js';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir), lstat: vi.fn(actual.lstat) };
});

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

afterEach(() => vi.useRealTimers());

async function idleSession(f: Fixture) {
  const session = await f.create();
  const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.turns(session.id)[0]?.state === 'completed' &&
      f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  return { session, workspace };
}

function commit(directory: string, file: string, text: string) {
  writeFileSync(path.join(directory, file), text);
  git(directory, 'add', '--', file);
  git(directory, 'commit', '--quiet', '-m', `Update ${file}`);
}

it('totals measured linked worktrees and excludes missing and removed worktrees', async () => {
  const f = await workbenchFixture();
  const workspaces = ['first', 'second'].map((id) => {
    const directory = path.join(f.root, id);
    mkdirSync(directory);
    writeFileSync(path.join(directory, 'file'), id);
    return f.store.insert<Workspace>('workspaces', {
      id,
      revision: 1,
      project_id: f.project.id,
      kind: 'linked_worktree',
      path: directory,
      owner: user.id,
      ownership_epoch: 1,
    });
  });
  const disk = () => f.control.workspaceStale(user, f.project.id).worktree_disk;
  expect(disk()).toEqual({ count: 2, size_bytes: 0, unmeasured: 2 });
  await eventually(() => disk()?.unmeasured === 0);
  expect(disk()).toEqual({ count: 2, size_bytes: 11, unmeasured: 0 });
  rmSync(workspaces[1]!.path, { recursive: true });
  expect(disk()).toEqual({ count: 1, size_bytes: 5, unmeasured: 0 });
  const first = workspaces[0]!;
  f.store.update<Workspace>('workspaces', { ...first, removed_at: f.store.now() }, first.revision);
  expect(disk()).toBeUndefined();
});

it('reads cached repository facts without starting git or walking directories', async () => {
  const f = await workbenchFixture();
  const { workspace } = await idleSession(f);
  commit(workspace.path, 'answer.txt', 'session answer\n');
  vi.useFakeTimers({ toFake: ['Date'] });
  await f.control.prefetchWorktreeReads(user, f.project.id);
  const runGit = vi.spyOn(gitCommands, 'runGit'),
    walk = vi.mocked(fs.readdir),
    stat = vi.mocked(fs.lstat);
  walk.mockClear();
  stat.mockClear();
  const read = () => {
    f.list();
    return f.control.workspaceStale(user, f.project.id);
  };
  read();
  expect(runGit).not.toHaveBeenCalled();
  expect(walk).not.toHaveBeenCalled();
  expect(stat).not.toHaveBeenCalled();
  await eventually(() => read().worktree_disk?.unmeasured === 0);
  runGit.mockClear();
  walk.mockClear();
  stat.mockClear();
  read();
  expect(runGit).not.toHaveBeenCalled();
  expect(walk).not.toHaveBeenCalled();
  expect(stat).not.toHaveBeenCalled();
});

const immediates = async () => {
  for (let turn = 0; turn < 3; turn++) await new Promise((resolve) => setImmediate(resolve));
};
const sessionEvent = (f: Fixture, session: { id: string }) =>
  f.store.event(
    'session.gate_checked',
    f.store.must<Session>('sessions', session.id),
    f.project.id,
    { commit: 'head', results: [] },
  );

it('keeps the measured size of a worktree after a session event and walks it again only after the refresh interval', async () => {
  const f = await workbenchFixture();
  const { session } = await idleSession(f);
  const disk = () => f.control.workspaceStale(user, f.project.id).worktree_disk!;
  await eventually(() => disk().unmeasured === 0);
  const measured = disk();
  expect(measured.size_bytes).toBeGreaterThan(0);
  vi.useFakeTimers({ toFake: ['Date'] });
  const walk = vi.mocked(fs.readdir);
  walk.mockClear();
  sessionEvent(f, session);
  expect(disk()).toEqual(measured);
  await immediates();
  expect(walk).not.toHaveBeenCalled();
  vi.setSystemTime(Date.now() + DISK_REFRESH_MS);
  expect(disk()).toEqual(measured);
  await eventually(() => walk.mock.calls.length > 0);
  expect(disk()).toEqual(measured);
});
