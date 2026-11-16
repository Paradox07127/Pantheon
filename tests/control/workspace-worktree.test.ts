import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import { Control } from '@pantheon/control';
import type { Project, Session, Workspace } from '@pantheon/domain';
import { command, type CommandType } from '@pantheon/protocol';
import { ArtifactFiles, Store } from '@pantheon/store';
import type { ControlContext } from '../../packages/control/src/context.js';
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
        GIT_AUTHOR_NAME: 'Worktree Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Worktree Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
}

const contains = (root: string, file: string) => {
  const rel = path.relative(root, file);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};

async function worktreeFixture() {
  const cache = path.join(process.cwd(), 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(path.join(cache, 'pantheon-worktree-')),
    source = path.join(root, 'project/source'),
    workspaceRoot = path.join(root, 'managed'),
    database = path.join(root, 'state/control.sqlite');
  mkdirSync(source, { recursive: true });
  mkdirSync(workspaceRoot);
  git(source, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(path.join(source, 'answer.txt'), 'base\n');
  writeFileSync(path.join(source, 'notes.txt'), 'notes\n');
  git(source, 'add', '.');
  git(source, 'commit', '--quiet', '-m', 'Initial files');
  const base = git(source, 'rev-parse', 'HEAD'),
    store = new Store(database),
    control = new Control(
      store,
      new ArtifactFiles(path.join(root, 'state/artifacts')),
      [new FixtureAdapter(5)],
      undefined,
      { workspaceRoot },
    );
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
    name: 'Worktree project',
    roots: [source],
  });
  const ctx = (control as unknown as { ctx: ControlContext }).ctx;
  return {
    root,
    source,
    base,
    store,
    control,
    ctx,
    call,
    project,
    workspaceRoot,
    register: (name?: string) =>
      registerWorkspace(control, {
        project_id: project.id,
        kind: 'linked_worktree',
        source,
        base_ref: 'HEAD',
        ...(name === undefined ? {} : { name }),
      }),
    listed: () => git(source, 'worktree', 'list', '--porcelain'),
  };
}

it('provisions a detached worktree of the source repository at its frozen head', async () => {
  const f = await worktreeFixture();
  const worktree = await awaitWorkspaceReady(f.control, f.register());
  expect(worktree).toMatchObject({ kind: 'linked_worktree', source: f.source, base_sha: f.base });
  const entry = f
    .listed()
    .split('\n\n')
    .find((block) => block.startsWith(`worktree ${worktree.path}\n`));
  expect(entry).toContain(`HEAD ${f.base}`);
  expect(entry).toContain('detached');
  expect(git(worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
});

it('names worktree folders after the project and the work, then the start of their ids', async () => {
  const f = await worktreeFixture();
  const projectFolder = path.join(
    realpathSync(f.workspaceRoot),
    `worktree-project-${f.project.id.slice(0, 8)}`,
  );
  const named = f.register('  Fix the Login -- Bug! (again) and new tests later');
  expect(named.path).toBe(
    path.join(projectFolder, `fix-the-login-bug-again-and-new-${named.id.slice(0, 8)}`),
  );
  for (const name of [undefined, '修复登录'])
    expect(f.register(name).path).toMatch(new RegExp(`^${projectFolder}/[0-9a-f]{8}$`));
  const session = f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: [...f.control.adapters.keys()][0],
    input: '\nRename the Export button\nThen tidy up',
  });
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
  expect(workspace.path).toBe(
    path.join(projectFolder, `rename-the-export-button-${workspace.id.slice(0, 8)}`),
  );
  expect(readdirSync(f.workspaceRoot)).toEqual([path.basename(projectFolder)]);
});

it('commits in the worktree without moving source branches or head', async () => {
  const f = await worktreeFixture();
  const worktree = await awaitWorkspaceReady(f.control, f.register());
  const branches = () => git(f.source, 'for-each-ref', '--format=%(refname) %(objectname)');
  const before = branches();
  writeFileSync(path.join(worktree.path, 'answer.txt'), 'worktree change\n');
  git(worktree.path, 'commit', '--quiet', '-am', 'Change in worktree');
  expect(git(worktree.path, 'rev-parse', 'HEAD')).not.toBe(f.base);
  expect(branches()).toBe(before);
  expect(git(f.source, 'rev-parse', 'HEAD')).toBe(f.base);
  expect(git(f.source, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
});

it.each([
  [
    'removes the worktree directory and its source metadata',
    (dir: string) => writeFileSync(path.join(dir, 'answer.txt'), 'uncommitted\n'),
  ],
  [
    'removes worktree metadata after its directory was deleted by hand',
    (dir: string) => rmSync(dir, { recursive: true, force: true }),
  ],
])('%s', async (_, prepare) => {
  const f = await worktreeFixture();
  const worktree = await awaitWorkspaceReady(f.control, f.register());
  prepare(worktree.path);
  f.store.enqueue('workspace.remove', { workspace_id: worktree.id, reason: 'discarded' });
  await f.control.tick();
  expect(f.store.must<Workspace>('workspaces', worktree.id).removed_at).toBeDefined();
  expect(existsSync(worktree.path)).toBe(false);
  expect(f.listed()).not.toContain(worktree.path);
  expect(existsSync(path.join(f.source, '.git/worktrees', path.basename(worktree.path)))).toBe(
    false,
  );
});

it('reads a worktree only while its git pointer names its own source metadata', async () => {
  const f = await worktreeFixture();
  const worktree = await awaitWorkspaceReady(f.control, f.register());
  const { workspaceReadAccess } = await import('../../packages/control/dist/workspace.js');
  const head = await workspaceReadAccess(f.ctx, user, worktree).git!(['rev-parse', 'HEAD'], {
    max_buffer: 4096,
    timeout_ms: 5000,
  });
  expect(head.stdout.toString().trim()).toBe(f.base);
  const other = path.join(f.root, 'other-worktree');
  git(f.source, 'worktree', 'add', '--detach', other, 'HEAD');
  writeFileSync(
    path.join(worktree.path, '.git'),
    `gitdir: ${path.join(f.source, '.git/worktrees/other-worktree')}\n`,
  );
  expect(() => workspaceReadAccess(f.ctx, user, worktree)).toThrow(
    expect.objectContaining({ code: 'scope_violation' }),
  );
  writeFileSync(path.join(worktree.path, '.git'), `gitdir: ${path.join(f.source, '.git')}\n`);
  expect(() => workspaceReadAccess(f.ctx, user, worktree)).toThrow(
    expect.objectContaining({ code: 'scope_violation' }),
  );
});

it('lets the worktree sandbox write commits while protecting source refs and metadata', async () => {
  const f = await worktreeFixture();
  const worktree = await awaitWorkspaceReady(f.control, f.register());
  git(f.source, 'worktree', 'add', '--detach', path.join(f.root, 'other-worktree'), 'HEAD');
  const { worktreeSandbox } = await import('../../packages/control/dist/protection.js');
  const id = path.basename(worktree.path),
    tempDir = path.join(f.root, 'writer-temp'),
    metadata = path.join(f.source, '.git');
  const sandbox = worktreeSandbox({
    dataDir: path.join(f.root, 'state'),
    desktopUserDataDir: path.join(f.root, 'desktop'),
    home: path.join(f.root, 'home'),
    codexHome: path.join(f.root, 'codex'),
    backupDir: path.join(f.root, 'backup'),
    otherWorkspaces: [],
    sourceRepo: f.source,
    workspacePath: worktree.path,
    worktreeId: id,
    tempDir,
  });
  expect(sandbox.writable_roots).toEqual([
    worktree.path,
    path.join(metadata, 'objects'),
    path.join(metadata, 'worktrees', id),
    tempDir,
  ]);
  for (const entry of sandbox.protected_entries)
    for (const root of sandbox.writable_roots) expect(contains(entry.path, root)).toBe(false);
  const protectedPaths = sandbox.protected_entries.map((entry) => entry.path);
  for (const name of ['hooks', 'config', 'HEAD', 'refs', 'packed-refs', 'index'])
    expect(protectedPaths).toContain(path.join(metadata, name));
  expect(protectedPaths).toEqual(
    expect.arrayContaining([
      path.join(worktree.path, '.git'),
      path.join(metadata, 'worktrees/other-worktree'),
      path.join(metadata, 'worktrees', id, 'config.worktree'),
      path.join(metadata, 'worktrees', id, 'commondir'),
      path.join(metadata, 'worktrees', id, 'gitdir'),
      path.join(f.source, 'answer.txt'),
      path.join(f.source, 'notes.txt'),
    ]),
  );
  expect(protectedPaths).not.toContain(f.source);
  expect(protectedPaths).not.toContain(metadata);
});

it('cancels worktree provisioning without leaving worktree metadata', async () => {
  const f = await worktreeFixture();
  const gitModule = await import('../../packages/control/dist/git.js');
  const nativeGit = gitModule.runGit;
  const reached = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  vi.spyOn(gitModule, 'runGit').mockImplementation((cwd, args, input, asynchronous, options) => {
    if (!asynchronous || args[0] !== 'rev-parse' || args[1] !== '--verify')
      return nativeGit(cwd, args, input, asynchronous as true, options);
    reached.resolve();
    return release.promise.then(() => nativeGit(cwd, args, input, true, options));
  });
  const worktree = f.register();
  await f.control.tick();
  await reached.promise;
  const current = f.store.must<Workspace>('workspaces', worktree.id);
  const { cancelProvisioning } = await import('../../packages/control/dist/workspace.js');
  f.ctx.store.transaction(() => cancelProvisioning(f.ctx, current, 'cancel-provisioning'));
  await f.control.tick();
  release.resolve();
  await eventually(
    () => f.store.must<Workspace>('workspaces', worktree.id).provisioning?.state === 'cancelled',
    () => f.control.tick(),
  );
  expect(f.listed()).not.toContain(worktree.path);
  expect(existsSync(path.join(f.source, '.git/worktrees'))).toBe(false);
  expect(readdirSync(worktree.path)).toEqual([]);
});
