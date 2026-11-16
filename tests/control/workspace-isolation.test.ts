import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FixtureAdapter } from '@pantheon/adapters';
import { Control } from '@pantheon/control';
import { type Project, type SessionSpec, type Workspace } from '@pantheon/domain';
import { command, type CommandType } from '@pantheon/protocol';
import { ArtifactFiles, Store } from '@pantheon/store';
import { awaitWorkspaceReady, eventually, registerWorkspace, user } from '../helpers.js';
import { boundTaskSession, workbenchFixture } from './workbench-fixture.js';

vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }));

const roots: string[] = [];
const controls: Control[] = [];
const stores: Store[] = [];
afterEach(async () => {
  for (const control of controls.splice(0)) await control.shutdown();
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pantheon-worktree-')));
  roots.push(root);
  return root;
}

// Never inherit user git configuration, repository redirects or identity.
function plainGit(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
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
  });
}

async function worktreeFixture() {
  const root = tempRoot(),
    source = path.join(root, 'project/source'),
    workspaceRoot = path.join(root, 'managed'),
    state = path.join(root, 'state');
  mkdirSync(source, { recursive: true });
  mkdirSync(workspaceRoot);
  plainGit(source, 'init', '--quiet');
  writeFileSync(path.join(source, 'answer.txt'), 'base\n');
  plainGit(source, 'add', '.');
  plainGit(source, 'commit', '--quiet', '-m', 'Initial answer');

  const protection = await import('../../packages/control/dist/protection.js');
  const assertLocation = protection.assertManagedLocation;
  // Inject temporary prefixes only for this fixture; production has no location bypass.
  vi.spyOn(protection, 'assertManagedLocation').mockImplementation((target) =>
    assertLocation(target, [path.join(root, 'forbidden-temp')]),
  );
  const store = new Store(path.join(state, 'control.sqlite')),
    files = new ArtifactFiles(path.join(state, 'artifacts'));
  stores.push(store);
  const control = new Control(store, files, [], undefined, { workspaceRoot });
  controls.push(control);
  const call = <T>(type: CommandType, input: Record<string, unknown>) =>
    control.execute(user, command(user.id, type, input)) as T;
  const project = call<Project>('project.open', {
    name: 'Worktree project',
    roots: [source],
  });
  const register = (input: { base_ref?: string } = {}) =>
    registerWorkspace(control, {
      project_id: project.id,
      kind: 'linked_worktree',
      source,
      base_ref: 'HEAD',
      ...input,
    });
  const ctx = (
    control as unknown as {
      ctx: import('../../packages/control/dist/context.js').ControlContext;
    }
  ).ctx;
  return {
    root,
    source,
    workspaceRoot,
    state,
    store,
    files,
    control,
    call,
    project,
    register,
    ctx,
    async cancel(workspace: Workspace) {
      const { cancelProvisioning } = await import('../../packages/control/dist/workspace.js');
      ctx.store.transaction(() => cancelProvisioning(ctx, workspace, 'cancel-provisioning'));
    },
    async ready(workspace: Workspace) {
      const { startWorkspaceProvisioning } =
        await import('../../packages/control/dist/provisioning.js');
      startWorkspaceProvisioning(ctx, workspace.id);
      await eventually(
        () =>
          !['queued', 'running'].includes(
            store.must<Workspace>('workspaces', workspace.id).provisioning!.state,
          ),
      );
      return store.must<Workspace>('workspaces', workspace.id);
    },
  };
}

it('protects control state, original repositories, other workspaces and configuration at real paths', async () => {
  const { protectionList } = await import('../../packages/control/dist/protection.js');
  const root = tempRoot(),
    real = path.join(root, 'real'),
    alias = path.join(root, 'alias');
  mkdirSync(real);
  symlinkSync(real, alias);
  const readWrite = ['data', 'desktop', 'backups'];
  const writeDirectories = [
    'source',
    'source/.git',
    'other',
    'home/.claude',
    'codex-home',
    'worktree/.git/hooks',
    'worktree/.claude',
    'worktree/.codex',
  ];
  const writeFiles = [
    'home/.claude.json',
    ...['.zshrc', '.zprofile', '.zshenv', '.bashrc', '.bash_profile', '.profile'].map(
      (file) => `home/${file}`,
    ),
    'worktree/.git/config',
    'worktree/.mcp.json',
  ];
  for (const name of [...readWrite, ...writeDirectories])
    mkdirSync(path.join(real, name), { recursive: true });
  for (const name of writeFiles) writeFileSync(path.join(real, name), 'fixture\n');
  const input = {
    dataDir: path.join(alias, 'data'),
    desktopUserDataDir: path.join(alias, 'desktop'),
    home: path.join(alias, 'home'),
    codexHome: path.join(alias, 'codex-home'),
    sourceRepo: path.join(alias, 'source'),
    workspacePath: path.join(alias, 'worktree'),
    otherWorkspaces: [path.join(alias, 'other')],
    backupDir: path.join(alias, 'backups'),
  };
  const entries = protectionList(input);
  expect(entries).toEqual(protectionList(input));
  expect(entries.map(({ path: target, deny }) => ({ path: target, deny }))).toEqual(
    expect.arrayContaining([
      ...readWrite.map((name) => ({ path: path.join(real, name), deny: 'read_write' })),
      ...[...writeDirectories, ...writeFiles].map((name) => ({
        path: path.join(real, name),
        deny: 'write',
      })),
    ]),
  );
  expect(entries.every((entry) => entry.reason.length > 0)).toBe(true);
  expect(entries.some((entry) => entry.path === path.join(real, 'worktree'))).toBe(false);
});

it('protects configuration paths before they are created', async () => {
  const { protectionList } = await import('../../packages/control/dist/protection.js');
  const root = tempRoot();
  for (const name of ['data', 'desktop', 'backups', 'home', 'codex'])
    mkdirSync(path.join(root, name));
  const entries = protectionList({
    dataDir: path.join(root, 'data'),
    desktopUserDataDir: path.join(root, 'desktop'),
    backupDir: path.join(root, 'backups'),
    home: path.join(root, 'home'),
    codexHome: path.join(root, 'codex'),
    sourceRepo: path.join(root, 'missing-source'),
    workspacePath: path.join(root, 'missing-worktree'),
    otherWorkspaces: [path.join(root, 'missing-other')],
  });
  expect(entries.map((entry) => entry.path).sort()).toEqual(
    expect.arrayContaining(
      [
        'data',
        'desktop',
        'backups',
        'codex',
        'home/.claude',
        'home/.claude.json',
        'home/.zshrc',
        'missing-worktree/.claude',
        'missing-worktree/.codex',
        'missing-worktree/.mcp.json',
        'missing-worktree/.git/config',
        'missing-worktree/.git/hooks',
      ].map((name) => path.join(root, name)),
    ),
  );
});

it('rejects temporary managed locations, including aliases and missing descendants', async () => {
  const { assertManagedLocation } = await import('../../packages/control/dist/protection.js');
  for (const root of ['/tmp', '/private/tmp', '/private/var/folders', os.tmpdir()]) {
    expect(() => assertManagedLocation(root)).toThrow(/temporary/i);
    expect(() => assertManagedLocation(path.join(root, 'x'))).toThrow(/temporary/i);
  }
  const root = tempRoot(),
    forbidden = path.join(root, 'temporary'),
    alias = path.join(root, 'alias'),
    dangling = path.join(root, 'dangling');
  mkdirSync(forbidden);
  symlinkSync(forbidden, alias);
  symlinkSync(path.join(forbidden, 'missing'), dangling);
  expect(() => assertManagedLocation(path.join(alias, 'missing/worktree'), [forbidden])).toThrow(
    /temporary/i,
  );
  expect(() =>
    assertManagedLocation(path.join(root, 'managed/worktree'), [forbidden]),
  ).not.toThrow();
  expect(() => assertManagedLocation(`${forbidden}-sibling/worktree`, [forbidden])).not.toThrow();
  expect(() => assertManagedLocation(path.join(dangling, 'worktree'), [forbidden])).toThrow(
    /temporary/i,
  );
});

it('blocks planted fsmonitor and hooks while plain git proves the probes execute', async () => {
  const f = await worktreeFixture(),
    worktree = await f.ready(f.register()),
    marker = path.join(f.root, 'fsmonitor-ran'),
    monitor = path.join(f.root, 'monitor.sh'),
    hookMarker = path.join(f.root, 'hook-ran'),
    hook = path.join(f.source, '.git/hooks/post-checkout');
  writeFileSync(monitor, `#!/bin/sh\nprintf probe > '${marker}'\nprintf 'token\\0'\n`);
  writeFileSync(hook, `#!/bin/sh\nprintf probe > '${hookMarker}'\n`);
  chmodSync(monitor, 0o700);
  chmodSync(hook, 0o700);
  plainGit(worktree.path, 'config', 'core.fsmonitor', monitor);
  plainGit(worktree.path, 'status', '--porcelain');
  expect(existsSync(marker)).toBe(true);
  unlinkSync(marker);
  plainGit(worktree.path, 'checkout', '--detach', 'HEAD');
  expect(existsSync(hookMarker)).toBe(true);
  unlinkSync(hookMarker);
  if (existsSync(marker)) unlinkSync(marker);
  const { runGit } = await import('../../packages/control/dist/git.js');
  // An inherited redirect must not change which repository Pantheon examines.
  vi.stubEnv('GIT_DIR', path.join(f.root, 'nonexistent-git'));
  try {
    expect(runGit(worktree.path, ['status', '--porcelain']).exit_code).toBe(0);
    expect(runGit(worktree.path, ['checkout', '--detach', 'HEAD']).exit_code).toBe(0);
  } finally {
    vi.unstubAllEnvs();
  }
  expect(existsSync(marker)).toBe(false);
  expect(existsSync(hookMarker)).toBe(false);
});

it('rejects worktree paths overlapping an already registered workspace', async () => {
  const f = await worktreeFixture();
  // A worktree row left from before the managed root was moved into its folder.
  f.store.insert<Workspace>('workspaces', {
    id: 'earlier-worktree',
    revision: 1,
    project_id: f.project.id,
    kind: 'linked_worktree',
    source: f.source,
    path: f.workspaceRoot,
    owner: 'none',
    ownership_epoch: 0,
  });
  expect(() => f.register()).toThrow(/Overlapping workspaces/);
  expect(f.store.list('workspaces')).toHaveLength(1);
  expect(readdirSync(f.workspaceRoot)).toEqual([]);
});

it('refuses workspace roots inside control state through direct paths or symlinks', async () => {
  const f = await worktreeFixture(),
    alias = path.join(f.root, 'state-alias');
  symlinkSync(f.state, alias);
  for (const workspaceRoot of [
    f.state,
    path.join(f.state, 'worktrees'),
    path.join(alias, 'worktrees'),
  ])
    expect(() => new Control(f.store, f.files, [], undefined, { workspaceRoot })).toThrow(
      /data directory/i,
    );
  vi.restoreAllMocks();
  // A temporary root still lets the daemon start; each worktree is refused instead.
  expect(
    () => new Control(f.store, f.files, [], undefined, { workspaceRoot: f.workspaceRoot }),
  ).not.toThrow();
  expect(() => f.register()).toThrow(/temporary/i);
});

it('records failed provisioning and preserves its reserved directory', async () => {
  const f = await worktreeFixture();
  const worktree = await f.ready(f.register({ base_ref: 'missing-branch' }));
  expect(worktree.provisioning).toMatchObject({ state: 'failed' });
  expect(worktree.provisioning?.error).toMatch(/Git workspace setup failed/);
  expect(existsSync(worktree.path)).toBe(true);
  expect(worktree.base_sha).toBeUndefined();
  const option = await f.ready(f.register({ base_ref: '--orphan=unexpected' }));
  expect(option.provisioning?.state).toBe('failed');
  expect(option.base_sha).toBeUndefined();
});

it('does not delete newly arrived files when provisioning fails', async () => {
  const f = await worktreeFixture();
  const reserved = f.register();
  writeFileSync(path.join(reserved.path, 'user-work.txt'), 'preserve me');
  const worktree = await f.ready(reserved);
  expect(worktree.provisioning?.state).toBe('failed');
  expect(readFileSync(path.join(worktree.path, 'user-work.txt'), 'utf8')).toBe('preserve me');
});

it('removes a reserved worktree when the session start that made it rolls back', async () => {
  const f = await worktreeFixture();
  const adapter = new FixtureAdapter(),
    control = new Control(f.store, f.files, [adapter], undefined, {
      workspaceRoot: f.workspaceRoot,
    });
  controls.push(control);
  vi.spyOn(control, 'failpoint').mockImplementation((name) => {
    if (name === 'before_transaction_commit') throw new Error('commit refused');
  });
  expect(() =>
    control.execute(
      user,
      command(user.id, 'session.create', {
        project_id: f.project.id,
        runtime: adapter.name,
        input: 'Start the work',
      }),
    ),
  ).toThrow('commit refused');
  expect(f.store.list('workspaces')).toEqual([]);
  const [folder] = readdirSync(f.workspaceRoot);
  expect(readdirSync(path.join(f.workspaceRoot, folder!))).toEqual([]);
});

it('keeps the control loop available during provisioning and records owned process stop evidence', async () => {
  const f = await worktreeFixture();
  const worktree = f.register();
  const git = await import('../../packages/control/dist/git.js');
  const nativeGit = git.runGit;
  const provisioning = await import('../../packages/control/dist/provisioning.js');
  const ctx = (
    f.control as unknown as { ctx: import('../../packages/control/dist/context.js').ControlContext }
  ).ctx;
  const started = Promise.withResolvers<void>();
  const spy = vi
    .spyOn(git, 'runGit')
    .mockImplementation((cwd, args, input, asynchronous, options) => {
      if (args[0] !== 'worktree') return nativeGit(cwd, args, input, asynchronous as true, options);
      return new Promise((resolve) => {
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        child.once('close', (code) =>
          resolve({ exit_code: code, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
        );
        options?.on_spawn?.(child);
        started.resolve();
      });
    });
  try {
    provisioning.startWorkspaceProvisioning(ctx, worktree.id);
    await started.promise;
    expect(
      f.store.must<Workspace>('workspaces', worktree.id).provisioning?.process_identity?.pid,
    ).toBeGreaterThan(0);
    const separate = path.join(f.root, 'independent');
    mkdirSync(separate);
    const independent = f.call<Project>('project.open', {
      name: 'Responsive control',
      roots: [separate],
    });
    expect(independent.name).toBe('Responsive control');
    await f.cancel(f.store.must<Workspace>('workspaces', worktree.id));
    provisioning.startWorkspaceProvisioning(ctx, worktree.id);
    await eventually(
      () => f.store.must<Workspace>('workspaces', worktree.id).provisioning?.state === 'cancelled',
    );
    expect(f.store.must<Workspace>('workspaces', worktree.id).provisioning?.stop).toMatchObject({
      stopped: true,
      evidence: { method: 'process_group', live_count: 0 },
    });
    expect(existsSync(worktree.path)).toBe(true);
  } finally {
    provisioning.stopWorkspaceProvisioning(ctx);
    await Promise.all(ctx.completions);
    spy.mockRestore();
  }
});

it('reconciles interrupted provisioning without restarting or deleting partial work', async () => {
  const f = await worktreeFixture();
  const worktree = f.register();
  writeFileSync(path.join(worktree.path, 'partial.txt'), 'unlanded work');
  f.store.update(
    'workspaces',
    { ...worktree, provisioning: { ...worktree.provisioning!, state: 'running' } },
    worktree.revision,
  );
  const { recoverWorkspaceProvisioning, startWorkspaceProvisioning } =
    await import('../../packages/control/dist/provisioning.js');
  const ctx = (
    f.control as unknown as { ctx: import('../../packages/control/dist/context.js').ControlContext }
  ).ctx;
  recoverWorkspaceProvisioning(ctx);
  expect(f.store.must<Workspace>('workspaces', worktree.id).provisioning?.state).toBe(
    'reconciling',
  );
  startWorkspaceProvisioning(ctx, worktree.id);
  expect(readFileSync(path.join(worktree.path, 'partial.txt'), 'utf8')).toBe('unlanded work');
  expect(existsSync(path.join(worktree.path, '.git'))).toBe(false);
});

it('rejects a replaced reservation without changing the replacement directory', async () => {
  const f = await worktreeFixture();
  const worktree = f.register();
  rmSync(worktree.path, { recursive: true });
  const replacement = path.join(f.root, 'replacement');
  mkdirSync(replacement);
  writeFileSync(path.join(replacement, 'sentinel'), 'preserve');
  symlinkSync(replacement, worktree.path);
  const next = await f.ready(worktree);
  expect(next.provisioning?.state).toBe('failed');
  expect(readFileSync(path.join(replacement, 'sentinel'), 'utf8')).toBe('preserve');
  expect(existsSync(path.join(replacement, '.git'))).toBe(false);
});

it('reads workspace Git output while overriding repository worktree redirects', async () => {
  const f = await worktreeFixture();
  const worktree = await f.ready(f.register());
  writeFileSync(path.join(worktree.path, 'answer.txt'), 'workspace change\n');
  const outside = path.join(f.root, 'private-tree');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'answer.txt'), 'protected sentinel\n');
  plainGit(worktree.path, 'config', 'core.worktree', outside);
  const { workspaceReadAccess } = await import('../../packages/control/dist/workspace.js');
  const git = workspaceReadAccess(f.ctx, user, worktree).git!,
    bound = { max_buffer: 256 * 1024, timeout_ms: 5000 };
  const status = (await git(['status', '--porcelain=v1'], bound)).stdout.toString(),
    patch = (await git(['diff', 'HEAD', '--'], bound)).stdout.toString();
  expect(status).toContain('answer.txt');
  expect(patch).toContain('workspace change');
  expect(status + patch).not.toContain('protected sentinel');
});

async function sandboxInput(f: Awaited<ReturnType<typeof worktreeFixture>>) {
  const worktree = await f.ready(f.register());
  return {
    dataDir: path.join(f.root, 'state'),
    desktopUserDataDir: path.join(f.root, 'desktop'),
    home: path.join(f.root, 'home'),
    codexHome: path.join(f.root, 'codex'),
    backupDir: path.join(f.root, 'backup'),
    otherWorkspaces: [],
    sourceRepo: f.source,
    workspacePath: worktree.path,
    worktreeId: path.basename(worktree.path),
    tempDir: path.join(f.root, 'writer-temp'),
  };
}

it('refuses a writable sandbox root that was swapped for a symlink', async () => {
  const f = await worktreeFixture();
  const input = await sandboxInput(f);
  const { worktreeSandbox } = await import('../../packages/control/dist/protection.js');
  const outside = path.join(f.root, 'outside-target');
  mkdirSync(outside);
  mkdirSync(input.tempDir);
  expect(worktreeSandbox(input).writable_roots).toContain(input.tempDir);
  const metadata = path.join(f.source, '.git');
  for (const root of [
    input.tempDir,
    input.workspacePath,
    path.join(metadata, 'objects'),
    path.join(metadata, 'worktrees', input.worktreeId),
  ]) {
    const moved = `${root}-moved`;
    renameSync(root, moved);
    symlinkSync(outside, root);
    try {
      expect(() => worktreeSandbox(input)).toThrow(
        expect.objectContaining({ code: 'sandbox_path_replaced' }),
      );
    } finally {
      unlinkSync(root);
      renameSync(moved, root);
    }
  }
  writeFileSync(path.join(f.root, 'plain-file'), 'not a directory\n');
  expect(() => worktreeSandbox({ ...input, tempDir: path.join(f.root, 'plain-file') })).toThrow(
    expect.objectContaining({ code: 'sandbox_path_replaced' }),
  );
});

it('protects a symlinked configuration entry under its own name and its target', async () => {
  const f = await worktreeFixture();
  const input = await sandboxInput(f);
  const { worktreeSandbox, protectionList } =
    await import('../../packages/control/dist/protection.js');
  const shared = path.join(input.workspacePath, 'shared-agent-settings');
  mkdirSync(shared);
  symlinkSync(shared, path.join(input.workspacePath, '.claude'));
  const sandboxPaths = worktreeSandbox(input).protected_entries.map((entry) => entry.path);
  expect(sandboxPaths).toEqual(
    expect.arrayContaining([path.join(input.workspacePath, '.claude'), shared]),
  );
  const sharedHome = path.join(f.root, 'shared-claude-home');
  mkdirSync(input.home);
  mkdirSync(sharedHome);
  symlinkSync(sharedHome, path.join(input.home, '.claude'));
  const listPaths = protectionList({ ...input, workspacePath: undefined }).map(
    (entry) => entry.path,
  );
  expect(listPaths).toEqual(expect.arrayContaining([path.join(input.home, '.claude'), sharedHome]));
});

it('protects symlinked planner and reviewer entries under their own names and their targets', async () => {
  const root = tempRoot();
  const { plannerProtectionList, reviewerProtectionList } =
    await import('../../packages/control/dist/protection.js');
  const home = path.join(root, 'home'),
    skills = path.join(root, 'shared-skills'),
    otherTarget = path.join(root, 'other-workspace-target'),
    reviewerTarget = path.join(root, 'reviewer-target');
  for (const folder of [path.join(home, '.claude'), skills, otherTarget, reviewerTarget])
    mkdirSync(folder, { recursive: true });
  symlinkSync(skills, path.join(home, '.claude/skills'));
  symlinkSync(otherTarget, path.join(root, 'other-workspace'));
  symlinkSync(reviewerTarget, path.join(root, 'reviewer'));
  const input = {
    dataDir: path.join(root, 'state'),
    desktopUserDataDir: path.join(root, 'desktop'),
    home,
    codexHome: path.join(root, 'codex'),
    backupDir: path.join(root, 'backup'),
    otherWorkspaces: [path.join(root, 'other-workspace')],
  };
  expect(plannerProtectionList(input).map((entry) => entry.path)).toEqual(
    expect.arrayContaining([
      path.join(home, '.claude/skills'),
      skills,
      path.join(root, 'other-workspace'),
      otherTarget,
    ]),
  );
  expect(
    reviewerProtectionList({
      ...input,
      reviewerPath: path.join(root, 'reviewer'),
      otherReviewers: [],
    }).map((entry) => entry.path),
  ).toEqual(
    expect.arrayContaining([
      path.join(home, '.claude/skills'),
      skills,
      path.join(root, 'reviewer'),
      reviewerTarget,
    ]),
  );
});

/** Starts a session without a task and a task session of it, each in its own worktree. */
async function leadAndTaskSessions() {
  const f = workbenchFixture();
  const lead = f.create('Plan the export feature');
  const worker = boundTaskSession(f, lead.id, 'export');
  const { writerTempDirectory } = await import('../../packages/control/dist/workspace-removal.js');
  const workspaces = await Promise.all(
    [lead, worker].map(async (session) => {
      const ready = await awaitWorkspaceReady(f.control, session.workspace_id!);
      f.temporaryDirectories.push(writerTempDirectory(ready.id));
      return ready;
    }),
  );
  const spec = (session: { id: string }) =>
    f.start.mock.calls
      .map(([started]) => started as SessionSpec)
      .find((started) => started.platform_session_id === session.id);
  await eventually(
    () => spec(lead) !== undefined && spec(worker) !== undefined,
    () => f.control.tick(),
  );
  const denied = (session: { id: string }, deny: 'read_write' | 'write') =>
    spec(session)!
      .sandbox!.protected_entries.filter((entry) => entry.deny === deny)
      .map((entry) => entry.path);
  return {
    f,
    lead: { spec: spec(lead)!, workspace: workspaces[0]!, denied: denied.bind(null, lead) },
    worker: { spec: spec(worker)!, workspace: workspaces[1]!, denied: denied.bind(null, worker) },
    nativeRecords: [
      path.join(f.protectionPaths.home, '.claude/projects'),
      path.join(f.protectionPaths.codexHome, 'sessions'),
    ],
    reviews: path.join(path.dirname(workspaces[0]!.path), 'reviews'),
  };
}

it('denies a task session reading other worktrees, native session records and reviews', async () => {
  const { f, lead, worker, nativeRecords, reviews } = await leadAndTaskSessions();
  const hidden = worker.denied('read_write');
  expect(hidden).toEqual(expect.arrayContaining([lead.workspace.path, ...nativeRecords, reviews]));
  // Its own worktree, the source checkout and user skills stay readable.
  expect(hidden).not.toContain(path.join(f.protectionPaths.home, '.claude/skills'));
  for (const readable of [worker.workspace.path, f.source])
    expect(
      hidden.filter((entry) => readable === entry || readable.startsWith(`${entry}/`)),
    ).toEqual([]);
});

it('keeps the sandbox of a session without a task: other worktrees are only write-protected', async () => {
  const { f, lead, worker, nativeRecords, reviews } = await leadAndTaskSessions();
  const { worktreeSandbox } = await import('../../packages/control/dist/protection.js');
  const { writerTempDirectory } = await import('../../packages/control/dist/workspace-removal.js');
  const expected = worktreeSandbox({
    ...f.protectionPaths,
    otherWorkspaces: [worker.workspace.path],
    sourceRepo: f.source,
    workspacePath: lead.workspace.path,
    worktreeId: path.basename(lead.workspace.path),
    tempDir: writerTempDirectory(lead.workspace.id),
  });
  expect(lead.spec.sandbox!.protected_entries).toEqual(
    expect.arrayContaining(expected.protected_entries.map(({ path, deny }) => ({ path, deny }))),
  );
  expect(lead.denied('write')).toContain(worker.workspace.path);
  const hidden = lead.denied('read_write');
  for (const readable of [worker.workspace.path, ...nativeRecords, reviews])
    expect(hidden).not.toContain(readable);
});

it('denies a task session reading a symlinked other worktree under its own name and its target', async () => {
  const f = await worktreeFixture();
  const input = await sandboxInput(f);
  const { worktreeSandbox } = await import('../../packages/control/dist/protection.js');
  const otherTarget = path.join(f.root, 'other-workspace-target'),
    other = path.join(f.root, 'other-workspace');
  mkdirSync(otherTarget);
  mkdirSync(input.tempDir);
  symlinkSync(otherTarget, other);
  const hidden = worktreeSandbox({
    ...input,
    otherWorkspaces: [other],
    taskSession: { reviewsDirs: [path.join(f.workspaceRoot, f.project.id, 'reviews')] },
  })
    .protected_entries.filter((entry) => entry.deny === 'read_write')
    .map((entry) => entry.path);
  expect(hidden).toEqual(expect.arrayContaining([other, otherTarget]));
});

it('refuses a sandbox for a source folder whose Git metadata is not a directory', async () => {
  const f = await worktreeFixture();
  const input = await sandboxInput(f);
  const { worktreeSandbox } = await import('../../packages/control/dist/protection.js');
  const linked = path.join(f.root, 'linked-source');
  plainGit(f.source, 'worktree', 'add', '--quiet', '--detach', linked);
  mkdirSync(input.tempDir);
  expect(() => worktreeSandbox({ ...input, sourceRepo: linked })).toThrow(
    expect.objectContaining({ code: 'source_metadata_unsupported' }),
  );
});

it('rejects workspace reads from a project principal without a session', async () => {
  const f = await worktreeFixture();
  const worktree = await f.ready(f.register());
  const { workspaceReadAccess } = await import('../../packages/control/dist/workspace.js');
  const principal = { id: 'scoped-planner', role: 'planner' as const, project_id: f.project.id };
  expect(() => workspaceReadAccess(f.ctx, principal, worktree)).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
});

it('refuses linked Git metadata and read-protected workspace intersections', async () => {
  const f = await worktreeFixture();
  const worktree = await f.ready(f.register());
  const { workspaceReadAccess } = await import('../../packages/control/dist/workspace.js');
  const ctx = f.ctx;
  const privateMetadata = path.join(f.root, 'external-git');
  renameSync(path.join(worktree.path, '.git'), privateMetadata);
  symlinkSync(privateMetadata, path.join(worktree.path, '.git'));
  expect(() => workspaceReadAccess(ctx, user, worktree)).toThrow(
    expect.objectContaining({ code: 'scope_violation' }),
  );
  const protectedContext = {
    ...ctx,
    protectionPaths: {
      dataDir: worktree.path,
      desktopUserDataDir: path.join(f.root, 'desktop'),
      home: path.join(f.root, 'home'),
      codexHome: path.join(f.root, 'codex'),
      backupDir: path.join(f.root, 'backup'),
    },
  };
  expect(() => workspaceReadAccess(protectedContext, user, worktree)).toThrow(/protected data/);
});
