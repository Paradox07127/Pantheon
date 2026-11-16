import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import { Control } from '@pantheon/control';
import type { Project, Workspace } from '@pantheon/domain';
import { command, type CommandType } from '@pantheon/protocol';
import { ArtifactFiles, Store } from '@pantheon/store';
import { createVirtualClock } from '../acceptance/lib/clock.mjs';
import { awaitWorkspaceReady, eventually, registerWorkspace, user } from '../helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function git(cwd: string, ...args: string[]) {
  return execFileSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
    {
      cwd,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Cleanup Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Cleanup Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
}

async function removalFixture() {
  const cache = path.join(process.cwd(), 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(path.join(cache, 'pantheon-removal-')),
    source = path.join(root, 'project/source'),
    workspaceRoot = path.join(root, 'managed'),
    database = path.join(root, 'state/control.sqlite'),
    clock = createVirtualClock(1700000000000);
  for (const directory of [source, workspaceRoot]) mkdirSync(directory, { recursive: true });
  git(source, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(path.join(source, 'answer.txt'), 'base\n');
  git(source, 'add', '.');
  git(source, 'commit', '--quiet', '-m', 'Initial answer');
  const adapter = new FixtureAdapter(5),
    files = new ArtifactFiles(path.join(root, 'state/artifacts')),
    failpoint = vi.fn<(name: string) => void>();
  let store = new Store(database, clock.now),
    control = new Control(store, files, [adapter], failpoint, { workspaceRoot });
  cleanups.push(async () => {
    await control.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const call = <T = unknown>(
    type: CommandType,
    input: Record<string, unknown>,
    revision: number | null = null,
  ) => control.execute(user, command(user.id, type, input, revision)) as T;
  const project = call<Project>('project.open', {
    name: 'Workspace cleanup',
    roots: [source],
  });
  const worktree = registerWorkspace(control, {
    project_id: project.id,
    kind: 'linked_worktree',
    source,
    base_ref: 'HEAD',
  });
  await awaitWorkspaceReady(control, worktree);
  const workspace = () => store.must<Workspace>('workspaces', worktree.id);
  return {
    root,
    source,
    workspaceRoot,
    worktree,
    clock,
    failpoint,
    call,
    workspace,
    get store() {
      return store;
    },
    get control() {
      return control;
    },
    /** Queues the worktree's removal as discarding its session would. */
    queueRemoval() {
      store.enqueue('workspace.remove', { workspace_id: worktree.id, reason: 'discarded' });
    },
    async drain() {
      await control.tick();
      await control.tick();
    },
    async restart(options: ConstructorParameters<typeof Control>[4] = { workspaceRoot }) {
      await control.shutdown();
      store.close();
      store = new Store(database, clock.now);
      control = new Control(store, files, [adapter], failpoint, options);
      control.recover();
    },
  };
}

it.each(['outside', 'symlink', 'root'])(
  'refuses to delete a crafted worktree path at %s',
  async (location) => {
    const f = await removalFixture();
    const outside = path.join(f.root, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'keep.txt'), 'keep\n');
    const alias = path.join(f.workspaceRoot, 'escape');
    symlinkSync(outside, alias);
    // Model a corrupted workspace row; no product success is fabricated.
    f.store.update<Workspace>(
      'workspaces',
      {
        ...f.workspace(),
        path: location === 'outside' ? outside : location === 'symlink' ? alias : f.workspaceRoot,
      },
      f.workspace().revision,
    );
    f.queueRemoval();
    await f.drain();
    expect(readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep\n');
    expect(existsSync(f.worktree.path)).toBe(true);
    expect(f.workspace()).not.toHaveProperty('removed_at');
    expect(f.store.events().some((event) => event.kind === 'workspace.removed')).toBe(false);
  },
);

/** Restarts with a new managed root, keeping the fixture's root as an earlier one. */
async function movedRoot(f: Awaited<ReturnType<typeof removalFixture>>) {
  const current = path.join(f.root, 'current');
  mkdirSync(current);
  await f.restart({ workspaceRoot: current, formerWorkspaceRoots: [f.workspaceRoot] });
}

it('removes a worktree left under the earlier managed root', async () => {
  const f = await removalFixture();
  await movedRoot(f);
  f.queueRemoval();
  await f.drain();
  expect(f.workspace()).toHaveProperty('removed_at');
  expect(existsSync(f.worktree.path)).toBe(false);
  expect(git(f.source, 'worktree', 'list', '--porcelain')).not.toContain(f.worktree.path);
});

it('refuses to delete a worktree path outside both the current and the earlier managed root', async () => {
  const f = await removalFixture();
  await movedRoot(f);
  const outside = path.join(f.root, 'outside');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'keep.txt'), 'keep\n');
  f.store.update<Workspace>(
    'workspaces',
    { ...f.workspace(), path: outside },
    f.workspace().revision,
  );
  f.queueRemoval();
  await f.drain();
  expect(readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep\n');
  expect(f.workspace()).not.toHaveProperty('removed_at');
});

it('keeps the metadata of another worktree whose folder is on a volume not mounted now', async () => {
  const f = await removalFixture();
  const volume = path.join(f.root, 'volume'),
    unmounted = path.join(f.root, 'volume-unmounted'),
    other = path.join(volume, 'other');
  git(f.source, 'worktree', 'add', '--quiet', '--detach', other, 'HEAD');
  renameSync(volume, unmounted);
  f.queueRemoval();
  await f.drain();
  renameSync(unmounted, volume);
  expect(f.workspace()).toHaveProperty('removed_at');
  expect(existsSync(f.worktree.path)).toBe(false);
  expect(existsSync(path.join(f.source, '.git/worktrees/other'))).toBe(true);
  expect(git(other, 'rev-parse', 'HEAD')).toBe(git(f.source, 'rev-parse', 'HEAD'));
});

it('removes the empty reservation of a worktree whose provisioning failed before a later removal', async () => {
  const f = await removalFixture();
  const failed = registerWorkspace(f.control, {
    project_id: f.worktree.project_id,
    kind: 'linked_worktree',
    source: f.source,
    base_ref: 'no-such-ref',
  });
  await eventually(
    () => f.store.must<Workspace>('workspaces', failed.id).provisioning?.state === 'failed',
    () => f.control.tick(),
  );
  expect(existsSync(failed.path)).toBe(true);
  f.store.enqueue('workspace.remove', { workspace_id: failed.id, reason: 'discarded' });
  await f.drain();
  expect(existsSync(failed.path)).toBe(false);
  expect(f.store.must<Workspace>('workspaces', failed.id)).toHaveProperty('removed_at');
});

it('replays removal after a restart between deleting the worktree and recording it', async () => {
  const f = await removalFixture();
  f.queueRemoval();
  f.failpoint.mockImplementation((name) => {
    if (name === 'after_workspace_delete') throw new Error('interrupted workspace removal');
  });
  await expect(f.control.tick()).rejects.toThrow('interrupted workspace removal');
  expect(existsSync(f.worktree.path)).toBe(false);
  expect(f.workspace()).not.toHaveProperty('removed_at');
  expect(f.store.pending().some((job) => job.kind === 'workspace.remove')).toBe(true);
  f.failpoint.mockReset();
  await f.restart();
  await f.drain();
  expect(f.workspace()).toHaveProperty('removed_at', f.clock.now());
  expect(f.store.events().filter((event) => event.kind === 'workspace.removed')).toHaveLength(1);
});
