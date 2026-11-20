import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Project, Session, Workspace } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const settled = (f: Awaited<ReturnType<typeof workbenchFixture>>, sessionId: string) =>
  eventually(
    () =>
      f.turns(sessionId).every((turn) => turn.state === 'completed') &&
      f.store.must<Session>('sessions', sessionId).state === 'open',
    () => f.control.tick(),
  );

/** An idle session with an uncommitted file, and a count of the Git calls in its worktree. */
async function idleWorktree(adoptable = false) {
  const f = await workbenchFixture({ adoptable });
  const session = await f.create();
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await settled(f, session.id);
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
  writeFileSync(path.join(workspace.path, 'note.txt'), 'uncommitted\n');
  const gitModule = await import('../../packages/control/dist/git.js');
  const runGit = vi.spyOn(gitModule, 'runGit');
  const calls = () => runGit.mock.calls.filter(([cwd]) => cwd === workspace.path).length;
  const files = () => f.list().find((row) => row.id === session.id)?.changes?.files;
  // The fourth argument of runGit selects its asynchronous form.
  const syncCalls = () => runGit.mock.calls.filter((call) => call[3] !== true).length;
  const asyncCalls = () => runGit.mock.calls.filter((call) => call[3] === true);
  const prefetch = () => f.control.prefetchWorktreeReads(user, f.project.id);
  /** Prefetches, then waits for the reads the prefetch left running after it answered. */
  const landedPrefetch = async () => {
    const { completions } = f.control['ctx'],
      running = new Set(completions);
    await prefetch();
    await Promise.all([...completions].filter((each) => !running.has(each)));
  };
  return { f, session, workspace, calls, files, syncCalls, asyncCalls, prefetch, landedPrefetch };
}

/** Besides the idle session with an uncommitted file: one with a commit and no uncommitted files, one with no changes and a recorded gate run, and an adopted folder session. */
async function sessionsOfEachRead() {
  const listed = await idleWorktree(true);
  const { f } = listed;
  const committed = await f.create(),
    checked = await f.create();
  for (const session of [committed, checked]) {
    await awaitWorkspaceReady(f.control, session.workspace_id!);
    await settled(f, session.id);
  }
  const committedPath = f.store.must<Workspace>('workspaces', committed.workspace_id!).path;
  writeFileSync(path.join(committedPath, 'note.txt'), 'committed\n');
  git(committedPath, 'add', '.');
  git(committedPath, 'commit', '--quiet', '-m', 'Add the note');
  await f.call(
    'project.gate.set',
    {
      project_id: f.project.id,
      root: f.source,
      commands: [
        { name: 'Prints ok', argv: [process.execPath, '-e', "process.stdout.write('ok')"] },
      ],
    },
    f.store.must<Project>('projects', f.project.id).revision,
  );
  f.store.event(
    'session.gate_checked',
    f.store.must<Session>('sessions', checked.id),
    f.project.id,
    {
      results: [],
      check_spec_hash: 'an older gate',
      commit: 'an older commit',
    },
  );
  const folder = await f.adopt();
  await eventually(
    () => f.list().find((row) => row.id === committed.id)?.predicted_conflicts !== undefined,
  );
  return { ...listed, committed, checked, folder };
}

it('reuses the worktree read of an idle session until the session has a new event', async () => {
  const { f, session, workspace, calls, files, prefetch } = await idleWorktree();
  vi.useFakeTimers({ toFake: ['Date'] });
  await prefetch();
  const first = files();
  const read = calls();
  expect(read).toBeGreaterThan(0);
  writeFileSync(path.join(workspace.path, 'second.txt'), 'uncommitted\n');
  await prefetch();
  expect(files()).toBe(first);
  expect(calls()).toBe(read);

  f.call(
    'session.send',
    { session_id: session.id, input: 'Go on' },
    f.store.must<Session>('sessions', session.id).revision,
  );
  await settled(f, session.id);
  const sent = calls();
  await prefetch();
  expect(files()).toBeGreaterThan(first!);
  expect(calls()).toBeGreaterThan(sent);
});

it('reads the worktree again two seconds after the last read', async () => {
  const { workspace, calls, files, prefetch, landedPrefetch } = await idleWorktree();
  vi.useFakeTimers({ toFake: ['Date'] });
  await prefetch();
  const first = files();
  const read = calls();
  writeFileSync(path.join(workspace.path, 'second.txt'), 'uncommitted\n');
  vi.setSystemTime(Date.now() + 1_999);
  await prefetch();
  expect(files()).toBe(first);
  expect(calls()).toBe(read);
  vi.setSystemTime(Date.now() + 2);
  await landedPrefetch();
  expect(files()).toBe(first! + 1);
  expect(calls()).toBeGreaterThan(read);
});

it('lists the same sessions after a prefetch without a synchronous Git call', async () => {
  const { f, session, committed, checked, folder, syncCalls, landedPrefetch } =
    await sessionsOfEachRead();
  vi.useFakeTimers({ toFake: ['Date'] });
  await landedPrefetch();
  const read = f.list();
  const row = (id: string) => read.find((each) => each.id === id);
  expect(row(session.id)).toMatchObject({ state: 'ready', changes: { files: 1 } });
  expect(row(committed.id)).toMatchObject({ state: 'ready', changes: { files: 1 } });
  expect(row(checked.id)).toMatchObject({
    state: 'idle',
    changes: { files: 0 },
    gate: { state: 'stale' },
  });
  expect(row(folder.id)).toMatchObject({ workspace_kind: 'in_place', changes: { files: 0 } });

  vi.setSystemTime(Date.now() + 2000);
  await landedPrefetch();
  const before = syncCalls();
  expect(f.list()).toEqual(read);
  expect(syncCalls()).toBe(before);
});

it('runs each Git read of a workspace once for two prefetches at the same time', async () => {
  const { asyncCalls, landedPrefetch } = await sessionsOfEachRead();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 2000);
  const before = asyncCalls().length;
  await Promise.all([landedPrefetch(), landedPrefetch()]);
  const reads = asyncCalls()
    .slice(before)
    .map(([cwd, args]) => `${cwd} ${args.join(' ')}`);
  expect(reads.length).toBeGreaterThan(0);
  expect(new Set(reads).size).toBe(reads.length);
});

it('reads the worktree again after a prefetch once the session has a new event', async () => {
  const { f, session, workspace, files, asyncCalls, prefetch } = await idleWorktree();
  vi.useFakeTimers({ toFake: ['Date'] });
  await prefetch();
  const first = files();
  writeFileSync(path.join(workspace.path, 'second.txt'), 'uncommitted\n');
  f.call(
    'session.send',
    { session_id: session.id, input: 'Go on' },
    f.store.must<Session>('sessions', session.id).revision,
  );
  await settled(f, session.id);
  const before = asyncCalls().length;
  await prefetch();
  expect(files()).toBe(first! + 1);
  expect(asyncCalls().length).toBeGreaterThan(before);
});

it('reads the worktree again two seconds after a prefetch', async () => {
  const { workspace, files, asyncCalls, prefetch, landedPrefetch } = await idleWorktree();
  vi.useFakeTimers({ toFake: ['Date'] });
  await prefetch();
  const first = files();
  const before = asyncCalls().length;
  writeFileSync(path.join(workspace.path, 'second.txt'), 'uncommitted\n');
  vi.setSystemTime(Date.now() + 1_999);
  await prefetch();
  expect(files()).toBe(first);
  expect(asyncCalls().length).toBe(before);
  vi.setSystemTime(Date.now() + 2);
  await landedPrefetch();
  expect(files()).toBe(first! + 1);
  expect(asyncCalls().length).toBeGreaterThan(before);
});

it('lists the Git fields of an unread worktree as unknown without a Git call until a prefetch reads them', async () => {
  const { f, session, calls, prefetch } = await idleWorktree();
  vi.useFakeTimers({ toFake: ['Date'] });
  const row = () =>
    f.control.sessionList(user, f.project.id, 'cached').find((each) => each.id === session.id);
  const unread = row();
  expect(unread).toMatchObject({ state: 'idle', changes: null });
  expect(unread).not.toHaveProperty('branch');
  expect(calls()).toBe(0);
  await prefetch();
  const read = row();
  expect(read).toMatchObject({ changes: { files: 1 } });
  expect(read).toHaveProperty('branch');
  expect(f.store.kindEvents(f.project.id, ['workspace.repository_changed'])).toHaveLength(1);
});

it('lists the last read of a worktree until a prefetch reads it again, and emits only when it differs', async () => {
  const { f, session, workspace, calls, prefetch, landedPrefetch } = await idleWorktree();
  vi.useFakeTimers({ toFake: ['Date'] });
  const row = () =>
    f.control.sessionList(user, f.project.id, 'cached').find((each) => each.id === session.id);
  const changed = () => f.store.kindEvents(f.project.id, ['workspace.repository_changed']).length;
  row();
  await prefetch();
  const read = calls();
  writeFileSync(path.join(workspace.path, 'second.txt'), 'uncommitted\n');
  vi.setSystemTime(Date.now() + 2000);
  const last = row();
  expect(last).toMatchObject({ changes: { files: 1 } });
  expect(last).toHaveProperty('branch');
  expect(calls()).toBe(read);
  await landedPrefetch();
  expect(row()).toMatchObject({ changes: { files: 2 } });
  expect(changed()).toBe(2);
  vi.setSystemTime(Date.now() + 2000);
  await landedPrefetch();
  expect(calls()).toBeGreaterThan(read);
  expect(changed()).toBe(2);
});

it('emits no repository change for repeated prefetches of two sessions in one unchanged project folder, and one after a folder edit', async () => {
  const f = await workbenchFixture();
  const open = (extra: Record<string, unknown> = {}) =>
    f.call<Promise<Session>>('session.create', {
      project_id: f.project.id,
      runtime: f.adapter.name,
      input: 'Read the answer file',
      workspace: 'in_place',
      ...extra,
    });
  const first = await open();
  await settled(f, first.id);
  // An archived writer leaves the folder to the next session and stays in the list.
  f.call(
    'session.archive',
    { session_id: first.id },
    f.store.must<Session>('sessions', first.id).revision,
  );
  const second = await open();
  await settled(f, second.id);
  expect(second.workspace_id).toBe(first.workspace_id);
  vi.useFakeTimers({ toFake: ['Date'] });
  const changed = () => f.store.kindEvents(f.project.id, ['workspace.repository_changed']).length;
  await f.prefetch();
  const read = changed();
  for (let call = 0; call < 5; call++) await f.prefetch();
  expect(changed()).toBe(read);
  writeFileSync(path.join(f.source, 'folder-note.txt'), 'uncommitted\n');
  vi.setSystemTime(Date.now() + 2000);
  await f.prefetch();
  expect(changed()).toBe(read + 1);
});

it('prefetches the workspaces of every project in the summary when no project is given', async () => {
  const { f, syncCalls } = await sessionsOfEachRead();
  const otherSource = path.join(f.root, 'project/other');
  mkdirSync(otherSource);
  git(otherSource, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(path.join(otherSource, 'answer.txt'), 'other\n');
  git(otherSource, 'add', '.');
  git(otherSource, 'commit', '--quiet', '-m', 'Initial files');
  const other = await f.call<Project>('project.open', {
    name: 'Other project',
    roots: [otherSource],
  });
  const otherSession = await f.call<Session>('session.create', {
    project_id: other.id,
    runtime: f.adapter.name,
    input: 'Read the answer file',
  });
  await awaitWorkspaceReady(f.control, otherSession.workspace_id!);
  await settled(f, otherSession.id);
  const otherPath = f.store.must<Workspace>('workspaces', otherSession.workspace_id!).path;
  writeFileSync(path.join(otherPath, 'note.txt'), 'uncommitted\n');

  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 2000);
  // The answer does not wait for reads that only aged out; they land with the prefetch's completion.
  const { completions } = f.control['ctx'],
    running = new Set(completions);
  await f.control.prefetchWorktreeReads(user);
  await Promise.all([...completions].filter((each) => !running.has(each)));
  const before = syncCalls();
  const summary = f.control.projectsSummary(user);
  expect(syncCalls()).toBe(before);
  expect(summary.projects.map((project) => project.project_id).sort()).toEqual(
    [f.project.id, other.id].sort(),
  );
});
