import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Session, Workspace } from '@pantheon/domain';
import * as gitCommands from '../../packages/control/dist/git.js';
import { IDLE_REFRESH_MS } from '../../packages/control/dist/repository-insights.js';
import { DISK_REFRESH_MS } from '../../packages/control/dist/workspace-stale.js';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { git, gitRuns, workbenchFixture } from './workbench-fixture.js';

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

it('predicts clean and conflicting merges only for open sessions ahead of their target', async () => {
  const f = await workbenchFixture();
  const conflicting = await idleSession(f),
    clean = await idleSession(f),
    unchanged = await idleSession(f),
    unrelated = await idleSession(f);
  git(unrelated.workspace.path, 'checkout', '--quiet', '--orphan', 'unrelated');
  commit(unrelated.workspace.path, 'other.txt', 'other\n');
  commit(conflicting.workspace.path, 'answer.txt', 'session answer\n');
  commit(clean.workspace.path, 'clean.txt', 'clean\n');
  commit(f.source, 'answer.txt', 'target answer\n');
  const predictions = () => f.list();
  expect(
    predictions().find((row) => row.id === conflicting.session.id)?.predicted_conflicts,
  ).toBeUndefined();
  await eventually(
    () =>
      predictions().find((row) => row.id === conflicting.session.id)?.predicted_conflicts !==
      undefined,
  );
  const rows = predictions();
  expect(rows.find((row) => row.id === conflicting.session.id)?.predicted_conflicts).toEqual({
    files: ['answer.txt'],
    total: 1,
  });
  expect(rows.find((row) => row.id === clean.session.id)?.predicted_conflicts).toEqual({
    files: [],
    total: 0,
  });
  expect(rows.find((row) => row.id === unchanged.session.id)).not.toHaveProperty(
    'predicted_conflicts',
  );
  // A worktree that shares no history with its target has no merge to predict.
  expect(rows.find((row) => row.id === unrelated.session.id)).not.toHaveProperty(
    'predicted_conflicts',
  );
});

it('recomputes the prediction when only the target head moves', async () => {
  const f = await workbenchFixture();
  const { session, workspace } = await idleSession(f);
  commit(workspace.path, 'answer.txt', 'session answer\n');
  const prediction = () => f.list().find((row) => row.id === session.id)?.predicted_conflicts;
  await eventually(() => prediction() !== undefined);
  expect(prediction()).toEqual({ files: [], total: 0 });
  vi.useFakeTimers({ toFake: ['Date'] });
  commit(f.source, 'answer.txt', 'target answer\n');
  vi.setSystemTime(Date.now() + IDLE_REFRESH_MS);
  await eventually(() => prediction()?.total === 1);
  expect(prediction()).toEqual({ files: ['answer.txt'], total: 1 });
});

it('lists shared paths with open session ids and ignores private and finished changes', async () => {
  const f = await workbenchFixture();
  const first = await idleSession(f),
    second = await idleSession(f),
    third = await idleSession(f),
    finished = await idleSession(f);
  for (const row of [first, second, third, finished])
    commit(row.workspace.path, 'answer.txt', `${row.session.id}\n`);
  writeFileSync(path.join(first.workspace.path, 'private.txt'), 'private\n');
  writeFileSync(path.join(first.workspace.path, 'untracked.txt'), 'first\n');
  writeFileSync(path.join(second.workspace.path, 'untracked.txt'), 'second\n');
  for (const row of [first, finished])
    commit(row.workspace.path, 'finished-only.txt', 'finished\n');
  const ended = f.store.must<Session>('sessions', finished.session.id);
  f.store.update<Session>(
    'sessions',
    { ...ended, state: 'closed', outcome: 'discarded' },
    ended.revision,
  );
  const shared = () => f.control.workspaceStale(user, f.project.id).shared_files;
  expect(shared()).toBeUndefined();
  await eventually(() => shared() !== undefined);
  const ids = [first.session.id, second.session.id].sort();
  expect(shared()).toEqual({
    files: [
      { path: 'answer.txt', session_ids: [...ids, third.session.id].sort() },
      { path: 'untracked.txt', session_ids: ids },
    ],
    total: 2,
  });
});

it('keeps the same path in two project folders out of the shared files', async () => {
  const f = await workbenchFixture();
  const first = await idleSession(f);
  const other = path.join(f.root, 'project/other'),
    worktree = path.join(f.root, 'other-worktree');
  git(f.root, 'clone', '--quiet', f.source, other);
  git(other, 'worktree', 'add', '--quiet', '-b', 'other-work', worktree);
  const workspace = f.store.insert<Workspace>('workspaces', {
    id: 'other-workspace',
    revision: 1,
    project_id: f.project.id,
    kind: 'linked_worktree',
    path: worktree,
    source: other,
    source_branch: 'main',
    base_sha: git(other, 'rev-parse', 'HEAD'),
    owner: user.id,
    ownership_epoch: 1,
  });
  f.store.insert<Session>('sessions', {
    id: 'other-session',
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    workspace_id: workspace.id,
    state: 'open',
    turn_count: 0,
  } as Session);
  for (const directory of [first.workspace.path, worktree])
    commit(directory, 'answer.txt', `${directory}\n`);
  const shared = () => f.control.workspaceStale(user, f.project.id).shared_files;
  await eventually(() => shared() !== undefined);
  expect(shared()).toEqual({ files: [], total: 0 });
});

it('limits conflict and shared path lists while preserving their full counts', async () => {
  const f = await workbenchFixture();
  for (let index = 0; index < 55; index++)
    writeFileSync(path.join(f.source, `file-${String(index).padStart(2, '0')}`), 'base\n');
  git(f.source, 'add', '.');
  git(f.source, 'commit', '--quiet', '-m', 'Add shared files');
  const first = await idleSession(f),
    second = await idleSession(f);
  for (const directory of [first.workspace.path, second.workspace.path, f.source]) {
    for (let index = 0; index < 55; index++)
      writeFileSync(
        path.join(directory, `file-${String(index).padStart(2, '0')}`),
        `${directory}\n`,
      );
    git(directory, 'add', '.');
    git(directory, 'commit', '--quiet', '-m', 'Change shared files');
  }
  const prediction = () => f.list().find((row) => row.id === first.session.id)?.predicted_conflicts;
  const shared = () => f.control.workspaceStale(user, f.project.id).shared_files;
  await eventually(() => prediction() !== undefined && shared() !== undefined);
  expect(prediction()?.total).toBe(55);
  expect(prediction()?.files).toHaveLength(20);
  expect(shared()?.total).toBe(55);
  expect(shared()?.files).toHaveLength(50);
});

it('summarizes repeated gate command failures in the board range and detects same-commit flakes', async () => {
  const f = await workbenchFixture();
  const { session } = await idleSession(f);
  const now = new Date(2027, 2, 16, 12).getTime();
  const clock = vi.spyOn(f.store, 'now').mockReturnValue(now);
  const record = (commit: string, results: [string, number][]) =>
    f.store.event('session.gate_checked', session, f.project.id, {
      commit,
      results: results.map(([name, exit_code]) => ({ name, exit_code, timed_out: false })),
    });
  record('first-head', [
    ['Flaky', 1],
    ['Stable failure', 1],
    ['Once', 1],
  ]);
  record('first-head', [['Flaky', 0]]);
  record('second-head', [
    ['Flaky', 1],
    ['Stable failure', 1],
  ]);
  record('third-head', [['Stable failure', 0]]);
  f.store.event('session.gate_checked', session, f.project.id, {
    commit: 'first-head',
    results: [{ name: 'Stable failure', exit_code: 0, timed_out: false, carried: true }],
  });
  clock.mockReturnValue(now - 4 * 24 * 60 * 60 * 1000);
  record('old-head', [['Old failure', 1]]);
  record('old-head', [['Old failure', 1]]);
  clock.mockReturnValue(now);
  expect(f.control.boardView(user, f.project.id, 3).gate_failures).toEqual([
    { name: 'Flaky', failed_runs: 2, runs: 3, flaky: true },
    { name: 'Stable failure', failed_runs: 2, runs: 3, flaky: false },
  ]);
  expect(f.control.boardView(user, f.project.id, 1, '2027-03-12').gate_failures).toEqual([
    { name: 'Old failure', failed_runs: 2, runs: 2, flaky: false },
  ]);
});

it('leaves gate commands that were skipped after failing out of repeated gate failures', async () => {
  const f = await workbenchFixture();
  const { session } = await idleSession(f);
  for (const head of ['first-head', 'second-head'])
    f.store.event('session.gate_checked', session, f.project.id, {
      commit: head,
      results: [
        { name: 'Unit', exit_code: 0, timed_out: false },
        { name: 'E2E', state: 'skipped', reason: 'flaky', exit_code: 1, timed_out: false },
      ],
    });
  expect(f.control.boardView(user, f.project.id, 3).gate_failures).toBeUndefined();
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
    f.control.boardView(user, f.project.id, 7);
    f.list();
    return f.control.workspaceStale(user, f.project.id);
  };
  read();
  expect(runGit).not.toHaveBeenCalled();
  expect(walk).not.toHaveBeenCalled();
  expect(stat).not.toHaveBeenCalled();
  await eventually(
    () => read().worktree_disk?.unmeasured === 0 && read().shared_files !== undefined,
  );
  runGit.mockClear();
  walk.mockClear();
  stat.mockClear();
  read();
  expect(runGit).not.toHaveBeenCalled();
  expect(walk).not.toHaveBeenCalled();
  expect(stat).not.toHaveBeenCalled();
});

it('takes the changed paths of worktrees from a fresh list prefetch instead of reading them again', async () => {
  const f = await workbenchFixture();
  const first = await idleSession(f),
    second = await idleSession(f);
  for (const row of [first, second]) {
    commit(row.workspace.path, 'answer.txt', `${row.session.id}\n`);
    writeFileSync(path.join(row.workspace.path, 'untracked.txt'), `${row.session.id}\n`);
  }
  vi.useFakeTimers({ toFake: ['Date'] });
  const shared = () => f.control.workspaceStale(user, f.project.id).shared_files;
  const runs = await gitRuns(async () => {
    await f.control.prefetchWorktreeReads(user, f.project.id);
    await eventually(() => shared() !== undefined);
  });
  const ids = [first.session.id, second.session.id].sort();
  expect(shared()).toEqual({
    files: [
      { path: 'answer.txt', session_ids: ids },
      { path: 'untracked.txt', session_ids: ids },
    ],
    total: 2,
  });
  // The prefetch reads each worktree's changed and untracked paths once; nothing reads them again.
  expect(runs.filter((run) => / diff --name-only | ls-files /.test(run))).toHaveLength(2);
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

it('keeps the predictions after a session event and reads only the worktree of that session again', async () => {
  const f = await workbenchFixture();
  const changed = await idleSession(f),
    quiet = await idleSession(f);
  commit(f.source, 'answer.txt', 'target answer\n');
  commit(changed.workspace.path, 'changed.txt', 'changed\n');
  commit(quiet.workspace.path, 'quiet.txt', 'quiet\n');
  const predictions = () =>
    [changed, quiet].map(
      (row) => f.list().find((listed) => listed.id === row.session.id)?.predicted_conflicts,
    );
  await eventually(() => predictions().every((prediction) => prediction !== undefined));
  const clean = { files: [], total: 0 };
  expect(predictions()).toEqual([clean, clean]);
  commit(changed.workspace.path, 'answer.txt', 'session answer\n');
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const runGit = vi.spyOn(gitCommands, 'runGit');
  // The read of the changed paths of a worktree.
  const pathReads = () =>
    runGit.mock.calls
      .filter(([, args]) => args[0] === 'diff' && args[1] === '--name-only')
      .map(([directory]) => directory);
  sessionEvent(f, changed.session);
  expect(predictions()).toEqual([clean, clean]);
  await immediates();
  // Within the interval after the last read nothing starts.
  expect(pathReads()).toEqual([]);
  vi.advanceTimersByTime(2000);
  vi.useRealTimers();
  const changes = () => f.store.kindEvents(f.project.id, ['workspace.repository_changed']).length;
  const told = changes();
  await eventually(() => predictions()[0]?.total === 1);
  expect(predictions()).toEqual([{ files: ['answer.txt'], total: 1 }, clean]);
  expect(pathReads()).toEqual([changed.workspace.path]);
  // Clients read again after an event; a read that finds the same facts records none.
  expect(changes()).toBe(told + 1);
  vi.setSystemTime(Date.now() + IDLE_REFRESH_MS);
  // The read after the recorded event comes first; the next read then takes every worktree.
  await eventually(() => {
    predictions();
    return pathReads().length === 3;
  });
  await f.control.shutdown();
  expect(changes()).toBe(told + 1);
});

it('orders gate failures by failed runs then name and limits the summary to ten commands', async () => {
  const f = await workbenchFixture();
  const { session } = await idleSession(f);
  const results = Array.from({ length: 12 }, (_, index) => ({
    name: `Check ${String(index).padStart(2, '0')}`,
    exit_code: 1,
    timed_out: false,
  }));
  for (let run = 0; run < 2; run++)
    f.store.event('session.gate_checked', session, f.project.id, { commit: 'head', results });
  f.store.event('session.gate_checked', session, f.project.id, {
    commit: 'head',
    results: [results[11]!],
  });
  const summary = f.control.boardView(user, f.project.id, 1).gate_failures!;
  expect(summary).toHaveLength(10);
  expect(summary.map((command) => command.name)).toEqual([
    'Check 11',
    ...results.slice(0, 9).map((result) => result.name),
  ]);
  expect(summary[0]).toEqual({ name: 'Check 11', failed_runs: 3, runs: 3, flaky: false });
});
