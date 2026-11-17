import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Session, Workspace } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import {
  captureCheckpoint,
  deleteCheckpoints,
  forkCheckpoint,
  globalExcludesFile,
  readTurnDiff,
} from '../../packages/control/dist/checkpoint.js';
import { removeWorkspace } from '../../packages/control/dist/workspace-removal.js';
import { awaitWorkspaceReady, registerWorkspace, settle, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const contextOf = (f: Fixture) => (f.control as unknown as { ctx: ControlContext }).ctx;
const worktree = (f: Fixture, session: Session) =>
  f.store.must<Workspace>('workspaces', session.workspace_id!).path;

let home: string;
const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
beforeEach(() => {
  // A home of its own keeps the user's global git settings out and gives the excludes cache a new key.
  home = mkdtempSync(path.join(os.tmpdir(), 'pantheon-git-calls-home-'));
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  rmSync(home, { recursive: true, force: true });
});

/**
 * Runs `run` with a git first on PATH that logs the arguments of each call. Before `add -A` on a
 * temporary index it logs how many entries carry stat data; a call matching `slow` waits a second.
 */
async function recordGit(run: () => Promise<unknown>, slow?: string): Promise<string[]> {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pantheon-git-calls-'));
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const log = path.join(directory, 'calls.log');
  writeFileSync(
    path.join(directory, 'git'),
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${log}'`,
      'case " $* " in',
      `  *" add -A "*) [ -n "$GIT_INDEX_FILE" ] && printf 'stat %s\\n' "$('${real}' ls-files --debug | grep -c 'mtime: [1-9]')" >> '${log}' ;;`,
      ...(slow ? [`  *" ${slow} "*) sleep 1 ;;`] : []),
      'esac',
      `exec '${real}' "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(path.join(directory, 'git'), 0o755);
  const pathBefore = process.env.PATH;
  process.env.PATH = `${directory}:${pathBefore}`;
  try {
    await run();
  } finally {
    process.env.PATH = pathBefore;
  }
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  rmSync(directory, { recursive: true, force: true });
  return calls;
}

const count = (calls: string[], part: string) => calls.filter((call) => call.includes(part)).length;
const statCounts = (calls: string[]) =>
  calls.filter((call) => call.startsWith('stat ')).map((call) => Number(call.slice(5)));

/** The tree a fresh index read from HEAD gives once `add -A` took the worktree's files. */
function freshTree(work: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pantheon-fresh-index-'));
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_INDEX_FILE: path.join(directory, 'index'),
  };
  const run = (...args: string[]) =>
    execFileSync('git', args, { cwd: work, env, encoding: 'utf8' }).trim();
  try {
    run('read-tree', 'HEAD');
    run('add', '-A');
    return run('write-tree');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** A session whose worktree holds staged, changed, deleted, untracked, ignored and force-added ignored files. */
async function changedWorktree() {
  const f = await workbenchFixture();
  const session = await f.create('Start the export');
  await settle(f, session);
  const work = worktree(f, session);
  writeFileSync(path.join(work, '.gitignore'), '*.log\n');
  writeFileSync(path.join(work, 'kept.txt'), 'kept\n');
  writeFileSync(path.join(work, 'gone.txt'), 'gone\n');
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'Export started');
  writeFileSync(path.join(work, 'staged.txt'), 'staged\n');
  git(work, 'add', 'staged.txt');
  writeFileSync(path.join(work, 'forced.log'), 'forced\n');
  git(work, 'add', '-f', 'forced.log');
  writeFileSync(path.join(work, 'kept.txt'), 'changed\n');
  rmSync(path.join(work, 'gone.txt'));
  writeFileSync(path.join(work, 'untracked.txt'), 'untracked\n');
  writeFileSync(path.join(work, 'debug.log'), 'ignored\n');
  return { f, session, work };
}

it('captures the tree a fresh index gives, starting add from the stat data of the worktree index', async () => {
  const { f, session, work } = await changedWorktree();
  const expected = freshTree(work);

  const calls = await recordGit(() =>
    captureCheckpoint(contextOf(f), session.id, 'checkpoint-probe'),
  );

  const ref = `refs/pantheon/checkpoints/${session.workspace_id}/${session.id}/checkpoint-probe`;
  expect(git(work, 'rev-parse', `${ref}^{tree}`)).toBe(expected);
  expect(git(work, 'ls-tree', '-r', '--name-only', ref).split('\n').sort()).toEqual([
    '.gitignore',
    'answer.txt',
    'kept.txt',
    'staged.txt',
    'untracked.txt',
  ]);
  expect(statCounts(calls)).toHaveLength(1);
  expect(statCounts(calls)[0]).toBeGreaterThan(0);
});

it('freezes a fork as the tree a fresh index gives, starting add from the stat data of the worktree index', async () => {
  const { f, session, work } = await changedWorktree();
  const expected = freshTree(work);
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
  const ref = `refs/pantheon/checkpoints/${workspace.id}/${session.id}/fork-probe`;

  const calls = await recordGit(async () => forkCheckpoint(workspace, ref));

  expect(git(work, 'rev-parse', `${ref}^{tree}`)).toBe(expected);
  expect(git(work, 'rev-parse', `${ref}^`)).toBe(git(work, 'rev-parse', 'HEAD'));
  expect(statCounts(calls)).toHaveLength(1);
  expect(statCounts(calls)[0]).toBeGreaterThan(0);
});

it('looks up turn checkpoints with one ref listing and stages the worktree from its index', async () => {
  const f = await workbenchFixture();
  const session = await f.create('Start the export');
  await settle(f, session);
  f.call(
    'session.send',
    { session_id: session.id, input: 'Add a header row' },
    f.store.must<Session>('sessions', session.id).revision,
  );
  await settle(f, session);
  const [first, second] = f.turns(session.id);
  const work = worktree(f, session);
  writeFileSync(path.join(work, 'answer.txt'), 'header\n');
  const ctx = contextOf(f);

  const calls = await recordGit(async () => {
    expect((await readTurnDiff(ctx, user, session.id, first!.id)).turn_id).toBe(first!.id);
    const latest = await readTurnDiff(ctx, user, session.id, second!.id);
    expect(latest.files.map((file) => file.path)).toEqual(['answer.txt']);
  });

  expect(count(calls, 'for-each-ref')).toBe(2);
  expect(count(calls, 'rev-parse --verify --quiet refs/pantheon/checkpoints/')).toBe(0);
  expect(statCounts(calls)).toHaveLength(1);
  expect(statCounts(calls)[0]).toBeGreaterThan(0);
});

it('reads the global excludes setting again only after a global git config file changes', async () => {
  const first = await recordGit(async () => {
    expect(await globalExcludesFile()).toBeUndefined();
    expect(await globalExcludesFile()).toBeUndefined();
  });
  expect(count(first, 'config --global')).toBe(1);

  const custom = path.join(home, 'custom-ignore');
  writeFileSync(custom, '.env\n');
  writeFileSync(path.join(home, '.gitconfig'), `[core]\n\texcludesFile = ${custom}\n`);
  const changed = await recordGit(async () => {
    expect(await globalExcludesFile()).toBe(custom);
    expect(await globalExcludesFile()).toBe(custom);
  });
  expect(count(changed, 'config --global')).toBe(1);

  mkdirSync(path.join(home, '.config/git'), { recursive: true });
  writeFileSync(path.join(home, '.config/git/config'), '');
  const added = await recordGit(async () => {
    expect(await globalExcludesFile()).toBe(custom);
  });
  expect(count(added, 'config --global')).toBe(1);
});

it('deletes checkpoint refs with one listing and one batched update while timers keep firing', async () => {
  const f = await workbenchFixture();
  const session = await f.create('Start the export');
  await settle(f, session);
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
  const head = git(f.source, 'rev-parse', 'HEAD');
  for (const turn of ['first-turn', 'second-turn'])
    git(
      f.source,
      'update-ref',
      `refs/pantheon/checkpoints/${workspace.id}/${session.id}/${turn}`,
      head,
    );
  const order: string[] = [];

  const calls = await recordGit(async () => {
    setTimeout(() => order.push('timer'), 50);
    await deleteCheckpoints(workspace);
    order.push('deleted');
  }, 'for-each-ref');

  expect(order).toEqual(['timer', 'deleted']);
  expect(count(calls, 'for-each-ref')).toBe(1);
  expect(count(calls, 'update-ref')).toBe(1);
  expect(count(calls, 'update-ref --stdin')).toBe(1);
  expect(
    git(
      f.source,
      'for-each-ref',
      '--format=%(refname)',
      `refs/pantheon/checkpoints/${workspace.id}/`,
    ),
  ).toBe('');
});

/** A ready worktree with no session, which a queued removal job deletes. */
async function unownedWorktree() {
  const f = await workbenchFixture();
  const workspace = registerWorkspace(f.control, {
    project_id: f.project.id,
    kind: 'linked_worktree',
    source: f.source,
    base_ref: 'HEAD',
  });
  await awaitWorkspaceReady(f.control, workspace);
  const queue = () =>
    f.store.enqueue('workspace.remove', { workspace_id: workspace.id, reason: 'discarded' });
  return { f, workspace, queue };
}

it('keeps timers firing while git removes a worktree', async () => {
  const { f, workspace, queue } = await unownedWorktree();
  queue();
  const order: string[] = [];

  await recordGit(async () => {
    setTimeout(() => order.push('timer'), 50);
    await f.control.tick();
    order.push('tick');
  }, 'worktree remove');

  expect(order).toEqual(['timer', 'tick']);
  expect(f.store.must<Workspace>('workspaces', workspace.id).removed_at).toBeDefined();
});

it('runs one git worktree remove while a second removal of the same worktree is asked for', async () => {
  const { f, workspace, queue } = await unownedWorktree();
  queue();
  const second = queue();

  const calls = await recordGit(async () => {
    const ticking = f.control.tick();
    await Promise.all([ticking, removeWorkspace(contextOf(f), workspace.id, second)]);
  }, 'worktree remove');
  await f.control.tick();

  expect(count(calls, 'worktree remove')).toBe(1);
  expect(f.store.must<Workspace>('workspaces', workspace.id).removed_at).toBeDefined();
  expect(f.store.pending().filter((job) => job.kind === 'workspace.remove')).toEqual([]);
});

it('captures a file rewritten within the second its index was written, at the same size', async () => {
  const f = await workbenchFixture();
  const session = await f.create('Start the export');
  await settle(f, session);
  const work = worktree(f, session);
  const file = path.join(work, 'racy.txt');
  // Git only compares whole seconds here, so the steps below start right after a second begins.
  while (Date.now() % 1000 > 50) await new Promise((resolve) => setTimeout(resolve, 5));
  writeFileSync(file, 'before\n');
  git(work, 'add', 'racy.txt');
  git(work, 'commit', '--quiet', '-m', 'Racy file');
  const { atime, mtime } = statSync(file);
  writeFileSync(file, 'after!\n');
  utimesSync(file, atime, mtime);
  const index = path.resolve(work, git(work, 'rev-parse', '--git-path', 'index'));
  utimesSync(index, atime, mtime);
  // The copy of the index must not look newer than the rewrite.
  await new Promise((resolve) => setTimeout(resolve, 1100));

  await captureCheckpoint(contextOf(f), session.id, 'racy-probe');

  const ref = `refs/pantheon/checkpoints/${session.workspace_id}/${session.id}/racy-probe`;
  expect(git(work, 'show', `${ref}:racy.txt`)).toBe('after!');
});
