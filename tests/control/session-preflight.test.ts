import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import * as gitCommands from '../../packages/control/dist/git.js';
import { hash, type Project, type Session } from '@pantheon/domain';
import {
  awaitWorkspaceReady,
  eventually,
  insideSandbox,
  user,
  waitOutStatusReuse,
} from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

async function idleSession(f: Fixture) {
  const session = await f.create();
  const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.turns(session.id)[0]!.state === 'completed' &&
      f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  return { session: f.store.must<Session>('sessions', session.id), workspace };
}

function commit(repository: string, name: string, contents: string) {
  writeFileSync(path.join(repository, name), contents);
  git(repository, 'add', '--', name);
  git(repository, 'commit', '--quiet', '-m', `Update ${name}`);
  return git(repository, 'rev-parse', 'HEAD');
}

async function setGate(f: Fixture) {
  await f.call<Project>(
    'project.gate.set',
    {
      project_id: f.project.id,
      root: f.source,
      commands: [
        { name: 'First check', argv: [process.execPath, '-e', 'process.exit(0)'] },
        { name: 'Second check', argv: [process.execPath, '-e', 'process.exit(0)'] },
      ],
    },
    f.store.must<Project>('projects', f.project.id).revision,
  );
}

function gateChecked(
  f: Fixture,
  session: Session,
  head: string,
  results: { exit_code: number | null; timed_out: boolean }[],
) {
  f.store.event('session.gate_checked', session, session.project_id, {
    workspace_id: session.workspace_id,
    commit: head,
    check_spec_hash: hash(
      Object.values(f.store.must<Project>('projects', f.project.id).gates ?? {})[0],
    ),
    results: results.map((result, index) => ({
      name: index === 0 ? 'First check' : 'Second check',
      argv: [process.execPath, '-e', 'process.exit(0)'],
      duration_ms: 5,
      output: '',
      ...result,
    })),
  });
}

it('blocks a session with no new commits', async () => {
  const f = await workbenchFixture();
  const { session } = await idleSession(f);
  expect(await f.control.sessionPreflight(user, session.id)).toEqual({
    target_branch: 'main',
    source_root: f.source,
    commit_count: 0,
    files_changed: 0,
    worktree_clean: true,
    source_clean: true,
    conflicts: { state: 'none' },
    gate: { configured_total: 0, last: 'none' },
    can_merge: false,
    blocked_reason: 'no_changes',
  });
});

it('lets a session the user opened merge its uncommitted worktree changes and counts the files its merge commits', async () => {
  const f = await workbenchFixture();
  const { session, workspace } = await idleSession(f);
  commit(workspace.path, 'answer.txt', 'committed\n');
  writeFileSync(path.join(workspace.path, 'untracked.txt'), 'uncommitted\n');
  const preflight = await f.control.sessionPreflight(user, session.id);
  expect(preflight).toMatchObject({
    commit_count: 1,
    files_changed: 2,
    worktree_clean: false,
    source_clean: true,
    can_merge: true,
  });
  expect(preflight).not.toHaveProperty('blocked_reason');
});

it('reports unknown conflicts and a stale gate for the commit a merge makes of the uncommitted files', async () => {
  const f = await workbenchFixture();
  const { session, workspace } = await idleSession(f);
  await setGate(f);
  const head = commit(workspace.path, 'answer.txt', 'committed\n');
  gateChecked(f, session, head, [
    { exit_code: 0, timed_out: false },
    { exit_code: 0, timed_out: false },
  ]);
  writeFileSync(path.join(workspace.path, 'answer.txt'), 'uncommitted\n');
  writeFileSync(path.join(workspace.path, 'untracked.txt'), 'uncommitted\n');
  expect(await f.control.sessionPreflight(user, session.id)).toMatchObject({
    commit_count: 1,
    files_changed: 2,
    worktree_clean: false,
    conflicts: { state: 'unknown' },
    gate: { configured_total: 2, last: 'stale' },
    can_merge: true,
  });
});

it('blocks edited tracked files in the source folder but not untracked ones', async () => {
  const f = await workbenchFixture();
  const { session, workspace } = await idleSession(f);
  commit(workspace.path, 'answer.txt', 'committed\n');
  writeFileSync(path.join(f.source, 'source-only.txt'), 'untracked source file\n');
  expect(await f.control.sessionPreflight(user, session.id)).toMatchObject({
    source_clean: true,
    can_merge: true,
  });
  writeFileSync(path.join(f.source, 'answer.txt'), 'edited in the source folder\n');
  waitOutStatusReuse();
  expect(await f.control.sessionPreflight(user, session.id)).toMatchObject({
    target_branch: 'main',
    source_root: f.source,
    worktree_clean: true,
    source_clean: false,
    can_merge: false,
    blocked_reason: 'source_dirty',
  });
});

it('blocks a detached source repository and reports no target branch', async () => {
  const f = await workbenchFixture();
  const { session, workspace } = await idleSession(f);
  commit(workspace.path, 'answer.txt', 'committed\n');
  git(f.source, 'checkout', '--quiet', '--detach', 'HEAD');
  expect(await f.control.sessionPreflight(user, session.id)).toMatchObject({
    target_branch: null,
    conflicts: { state: 'unknown' },
    source_root: f.source,
    source_clean: true,
    can_merge: false,
    blocked_reason: 'source_detached',
  });
});

it('blocks a source repository that checked out another branch than the session started from', async () => {
  const f = await workbenchFixture();
  const { session, workspace } = await idleSession(f);
  commit(workspace.path, 'answer.txt', 'committed\n');
  git(f.source, 'checkout', '--quiet', '-b', 'release');
  expect(await f.control.sessionPreflight(user, session.id)).toMatchObject({
    target_branch: 'release',
    can_merge: false,
    blocked_reason: 'target_branch_changed',
  });
  git(f.source, 'checkout', '--quiet', 'main');
  waitOutStatusReuse();
  expect(await f.control.sessionPreflight(user, session.id)).toMatchObject({
    target_branch: 'main',
    can_merge: true,
  });
});

it('refuses to queue a merge into a dirty or detached source repository', async () => {
  const f = await workbenchFixture();
  const { session, workspace } = await idleSession(f);
  commit(workspace.path, 'answer.txt', 'committed\n');
  const merge = () =>
    f.call<Session>(
      'session.merge',
      { session_id: session.id },
      f.store.must<Session>('sessions', session.id).revision,
    );
  writeFileSync(path.join(f.source, 'answer.txt'), 'edited in the source folder\n');
  await expect(merge()).rejects.toThrow(expect.objectContaining({ code: 'source_dirty' }));
  git(f.source, 'checkout', '--quiet', '--', 'answer.txt');
  git(f.source, 'checkout', '--quiet', '--detach', 'HEAD');
  await expect(merge()).rejects.toThrow(expect.objectContaining({ code: 'source_detached' }));
  expect(f.store.must<Session>('sessions', session.id).merge).toBeUndefined();
});

it('allows a clean session whose configured gates have never run', async () => {
  const f = await workbenchFixture();
  const { session, workspace } = await idleSession(f);
  await setGate(f);
  commit(workspace.path, 'answer.txt', 'unchecked\n');
  expect(await f.control.sessionPreflight(user, session.id)).toMatchObject({
    gate: { configured_total: 2, last: 'none' },
    can_merge: true,
  });
  expect(await f.control.sessionPreflight(user, session.id)).not.toHaveProperty('blocked_reason');
});

it('allows a clean session with a gate checked on an older commit', async () => {
  const f = await workbenchFixture();
  const { session, workspace } = await idleSession(f);
  await setGate(f);
  const checked = commit(workspace.path, 'answer.txt', 'checked\n');
  gateChecked(f, session, checked, [{ exit_code: 0, timed_out: false }]);
  commit(workspace.path, 'answer.txt', 'newer\n');
  expect(await f.control.sessionPreflight(user, session.id)).toMatchObject({
    commit_count: 2,
    files_changed: 1,
    gate: { configured_total: 2, last: 'stale' },
    can_merge: true,
  });
});

it('previews a clean session with a passed gate without changing repositories or session state', async () => {
  const f = await workbenchFixture();
  git(f.source, 'checkout', '--quiet', '-b', 'destination');
  const { session, workspace } = await idleSession(f);
  await setGate(f);
  const first = commit(workspace.path, 'answer.txt', 'first\n');
  gateChecked(f, session, first, [{ exit_code: 1, timed_out: false }]);
  commit(workspace.path, 'answer.txt', 'second\n');
  const head = commit(workspace.path, 'new.txt', 'third\n');
  gateChecked(f, session, head, [
    { exit_code: 0, timed_out: false },
    { exit_code: 0, timed_out: false },
  ]);
  // A newer event from a different session must not replace this session's result.
  f.store.event('session.gate_checked', { id: 'other-session', revision: 1 }, f.project.id, {
    commit: head,
    results: [{ exit_code: 1, timed_out: false }],
  });
  const sourceHead = git(f.source, 'rev-parse', 'HEAD'),
    cursor = f.store.cursor(),
    pending = f.store.pending();
  expect(await f.control.sessionPreflight(user, session.id)).toEqual({
    target_branch: 'destination',
    source_root: f.source,
    commit_count: 3,
    files_changed: 2,
    worktree_clean: true,
    source_clean: true,
    conflicts: { state: 'none' },
    gate: { configured_total: 2, last: 'passed' },
    can_merge: true,
  });
  expect(git(workspace.path, 'rev-parse', 'HEAD')).toBe(head);
  expect(git(f.source, 'rev-parse', 'HEAD')).toBe(sourceHead);
  expect(f.store.must<Session>('sessions', session.id)).toEqual(session);
  expect(f.store.cursor()).toBe(cursor);
  expect(f.store.pending()).toEqual(pending);
});

it.each([
  { exit_code: 1, timed_out: false },
  { exit_code: null, timed_out: false },
  { exit_code: 0, timed_out: true },
])('allows a clean session with a failed gate result %j', async (result) => {
  const f = await workbenchFixture();
  const { session, workspace } = await idleSession(f);
  await setGate(f);
  const head = commit(workspace.path, 'answer.txt', 'committed\n');
  // Only the first command ran; configured_total still counts both commands.
  gateChecked(f, session, head, [result]);
  expect(await f.control.sessionPreflight(user, session.id)).toMatchObject({
    gate: { configured_total: 2, last: 'failed' },
    can_merge: true,
  });
});

it.skipIf(insideSandbox)(
  'reports a passed gate as stale once its commands change on the same head',
  async () => {
    const f = await workbenchFixture();
    const { session, workspace } = await idleSession(f);
    await setGate(f);
    commit(workspace.path, 'answer.txt', 'checked\n');
    await f.call('session.gates.run', { session_id: session.id }, session.revision);
    await eventually(
      () => !f.control.sessionGates(user, session.id).running,
      () => f.control.tick(),
      10000,
    );
    expect((await f.control.sessionPreflight(user, session.id)).gate.last).toBe('passed');
    expect(f.list().find((listed) => listed.id === session.id)?.gate?.state).toBe('passed');

    await f.call<Project>(
      'project.gate.set',
      {
        project_id: f.project.id,
        root: f.source,
        commands: [
          { name: 'First check', argv: [process.execPath, '-e', 'process.exit(0)'] },
          { name: 'Replaced check', argv: [process.execPath, '-e', 'process.exit(1)'] },
        ],
      },
      f.store.must<Project>('projects', f.project.id).revision,
    );
    expect((await f.control.sessionPreflight(user, session.id)).gate.last).toBe('stale');
    expect(f.list().find((listed) => listed.id === session.id)?.gate?.state).toBe('stale');
  },
);

it.each<Partial<Session>>([
  { state: 'running' },
  { stop_pending: true },
  { merge: { state: 'running' } },
])('reports a busy session before other merge blocks for %j', async (fields) => {
  const f = await workbenchFixture();
  const { session } = await idleSession(f);
  f.store.update<Session>('sessions', { ...session, ...fields }, session.revision);
  expect(await f.control.sessionPreflight(user, session.id)).toMatchObject({
    can_merge: false,
    blocked_reason: 'resource_busy',
  });
});

it('blocks a session while its gates are running', async () => {
  const f = await workbenchFixture();
  const { session } = await idleSession(f);
  await setGate(f);
  await f.call('session.gates.run', { session_id: session.id }, session.revision);
  expect(await f.control.sessionPreflight(user, session.id)).toMatchObject({
    can_merge: false,
    blocked_reason: 'resource_busy',
  });
});

it.each(['closed', 'reconciling'] as const)('blocks a session that is %s', async (state) => {
  const f = await workbenchFixture();
  const { session } = await idleSession(f);
  f.store.update<Session>('sessions', { ...session, state }, session.revision);
  expect(await f.control.sessionPreflight(user, session.id)).toMatchObject({
    can_merge: false,
    blocked_reason: 'invalid_state',
  });
});

it('requires project read access and rejects a session without a worktree', async () => {
  const f = await workbenchFixture();
  const session = f.store.insert<Session>('sessions', {
    id: 'baseline-session',
    revision: 1,
    project_id: f.project.id,
    runtime: 'fixture',
    state: 'open',
    turn_count: 0,
  });
  await expect(
    f.control.sessionPreflight(
      { id: 'outsider', role: 'planner', project_id: 'another-project' },
      session.id,
    ),
  ).rejects.toThrow(expect.objectContaining({ code: 'permission_denied' }));
  await expect(f.control.sessionPreflight(user, session.id)).rejects.toThrow(
    expect.objectContaining({ code: 'invalid_state' }),
  );
});

it('previews conflicting commits without changing either checkout or merge eligibility', async () => {
  const f = await workbenchFixture();
  const { session, workspace } = await idleSession(f);
  const head = commit(workspace.path, 'answer.txt', 'session change\n');
  const target = commit(f.source, 'answer.txt', 'target change\n');
  const cursor = f.store.cursor();
  expect(await f.control.sessionPreflight(user, session.id)).toMatchObject({
    conflicts: { state: 'conflicts', files: ['answer.txt'] },
    can_merge: true,
  });
  expect(git(workspace.path, 'rev-parse', 'HEAD')).toBe(head);
  expect(git(f.source, 'rev-parse', 'HEAD')).toBe(target);
  expect(git(workspace.path, 'status', '--porcelain')).toBe('');
  expect(git(f.source, 'status', '--porcelain')).toBe('');
  expect(f.store.cursor()).toBe(cursor);
});

it('reports unknown conflicts when merge-tree does not support write-tree', async () => {
  const f = await workbenchFixture();
  const { session } = await idleSession(f);
  const run = gitCommands.runGit;
  vi.spyOn(gitCommands, 'runGit').mockImplementation(((...args: Parameters<typeof run>) => {
    if (args[1][0] === 'merge-tree')
      return {
        exit_code: 129,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from('unknown option: write-tree'),
      };
    return run(...args);
  }) as typeof run);
  expect((await f.control.sessionPreflight(user, session.id)).conflicts).toEqual({
    state: 'unknown',
  });
});
