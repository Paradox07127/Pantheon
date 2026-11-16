import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Control } from '@pantheon/control';
import { type Project, type Workspace } from '@pantheon/domain';
import { command, type CommandType } from '@pantheon/protocol';
import { ArtifactFiles, Store } from '@pantheon/store';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { eventually, registerWorkspace, user } from '../helpers.js';

const slowCopy = vi.hoisted(() => ({ on: false, copies: [] as string[][] }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: ((file: string, args: string[], options: object) => {
      if (file === '/bin/cp') slowCopy.copies.push(args);
      return slowCopy.on && file === '/bin/cp'
        ? actual.spawn('/bin/sleep', ['20'], options)
        : actual.spawn(file, args, options);
    }) as typeof actual.spawn,
  };
});

const roots: string[] = [];
const controls: Control[] = [];
const stores: Store[] = [];
afterEach(async () => {
  slowCopy.on = false;
  slowCopy.copies = [];
  for (const control of controls.splice(0)) await control.shutdown();
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    // A failed copy leaves folders without permissions in the clone too; only root could remove them as they are.
    execFileSync('chmod', ['-R', 'u+rwx', root]);
    rmSync(root, { recursive: true, force: true });
  }
});

// Never inherit user git configuration, repository redirects or identity.
function plainGit(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Dependency Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Dependency Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function dependencyFixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pantheon-dependencies-')));
  roots.push(root);
  const source = path.join(root, 'project/source'),
    workspaceRoot = path.join(root, 'managed'),
    state = path.join(root, 'state');
  mkdirSync(source, { recursive: true });
  mkdirSync(workspaceRoot);
  plainGit(source, 'init', '--quiet');
  writeFileSync(path.join(source, '.gitignore'), 'node_modules/\n');
  writeFileSync(path.join(source, 'answer.txt'), 'base\n');
  plainGit(source, 'add', '.');
  plainGit(source, 'commit', '--quiet', '-m', 'Initial answer');
  mkdirSync(path.join(source, 'node_modules/pkg'), { recursive: true });
  writeFileSync(path.join(source, 'node_modules/pkg/index.js'), 'module.exports = 42;\n');
  mkdirSync(path.join(source, 'node_modules/.bin'));
  symlinkSync('../pkg/index.js', path.join(source, 'node_modules/.bin/tool'));

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
    name: 'Dependency project',
    roots: [source],
  });
  return {
    source,
    store,
    async provision(onDependencies?: (ctx: ControlContext) => void) {
      const workspace = registerWorkspace(control, {
        project_id: project.id,
        kind: 'linked_worktree',
        source,
        base_ref: 'HEAD',
      });
      const { startWorkspaceProvisioning } =
        await import('../../packages/control/dist/provisioning.js');
      const ctx = (control as unknown as { ctx: ControlContext }).ctx;
      startWorkspaceProvisioning(ctx, workspace.id);
      if (onDependencies) {
        await eventually(
          () =>
            store.must<Workspace>('workspaces', workspace.id).provisioning!.phase ===
            'dependencies',
        );
        onDependencies(ctx);
      }
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

/** A source with ignored dependency folders at its root and in a package, and an empty clone beside it. */
function dependencySource() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pantheon-dependencies-')));
  roots.push(root);
  const source = path.join(root, 'source'),
    clone = path.join(root, 'clone'),
    outside = path.join(root, 'outside');
  mkdirSync(path.join(source, 'packages/app'), { recursive: true });
  plainGit(source, 'init', '--quiet');
  writeFileSync(path.join(source, '.gitignore'), 'node_modules/\n');
  writeFileSync(path.join(source, 'packages/app/index.js'), 'export {};\n');
  plainGit(source, 'add', '.');
  plainGit(source, 'commit', '--quiet', '-m', 'Initial package');
  for (const folder of ['node_modules', 'packages/app/node_modules']) {
    mkdirSync(path.join(source, folder, 'pkg'), { recursive: true });
    writeFileSync(path.join(source, folder, 'pkg/index.js'), 'module.exports = 42;\n');
  }
  mkdirSync(clone);
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'kept.txt'), 'kept\n');
  return { source, clone, outside };
}

it('copies dependency folders into a clone on the first attempt', async () => {
  const { copyDependencyFolders } =
    await import('../../packages/control/dist/dependency-folders.js');
  const { source, clone } = dependencySource();
  await copyDependencyFolders(source, clone);
  expect(existsSync(path.join(clone, 'packages/app/node_modules/pkg/index.js'))).toBe(true);
  expect(slowCopy.copies).toHaveLength(2);
});

it('skips a dependency folder below a symbolic link in the clone and writes nothing through it', async () => {
  const { copyDependencyFolders } =
    await import('../../packages/control/dist/dependency-folders.js');
  const { source, clone, outside } = dependencySource();
  symlinkSync(outside, path.join(clone, 'packages'));
  const error = await copyDependencyFolders(source, clone).catch((failure: unknown) => failure);
  expect(readdirSync(outside)).toEqual(['kept.txt']);
  expect(existsSync(path.join(clone, 'node_modules/pkg/index.js'))).toBe(true);
  expect(String(error)).toContain('packages/app/node_modules/');
  expect(String(error)).toContain('symbolic link');
});

it("does not delete the source's dependencies through a dependency folder linked to them", async () => {
  const { copyDependencyFolders } =
    await import('../../packages/control/dist/dependency-folders.js');
  const { source, clone } = dependencySource();
  symlinkSync(path.join(source, 'node_modules'), path.join(clone, 'node_modules'));
  const error = await copyDependencyFolders(source, clone).catch((failure: unknown) => failure);
  expect(existsSync(path.join(source, 'node_modules/pkg/index.js'))).toBe(true);
  expect(String(error)).toContain('symbolic link');
});

it('copies ignored dependency folders into a new worktree with relative links kept inside it', async () => {
  const f = await dependencyFixture();
  const workspace = await f.provision();
  expect(workspace.provisioning?.state).toBe('ready');
  expect(existsSync(path.join(workspace.path, 'node_modules/pkg/index.js'))).toBe(true);
  const link = path.join(workspace.path, 'node_modules/.bin/tool');
  expect(readlinkSync(link)).toBe('../pkg/index.js');
  expect(realpathSync(link)).toBe(path.join(workspace.path, 'node_modules/pkg/index.js'));
  const phases = f.store
    .events(0, undefined, 1000)
    .filter((event) => event.kind === 'workspace.provisioning')
    .map((event) => (event.payload as { phase?: string }).phase);
  expect(phases).toContain('dependencies');
});

// Root reads a folder with no permissions, so the copy cannot be made to fail this way.
it.skipIf(process.getuid?.() === 0)(
  'marks the worktree ready and records the skip when dependency folders cannot be copied',
  async () => {
    const f = await dependencyFixture();
    const unreadable = path.join(f.source, 'node_modules/unreadable');
    mkdirSync(unreadable);
    chmodSync(unreadable, 0);
    const workspace = await f.provision();
    expect(workspace.provisioning?.state).toBe('ready');
    const skipped = f.store
      .events(0, undefined, 1000)
      .filter((event) => event.kind === 'workspace.dependencies_skipped');
    expect(skipped).toHaveLength(1);
    expect((skipped[0]!.payload as { reason: string }).reason).toContain('node_modules');
  },
);

it('stops a dependency copy when provisioning is stopped', async () => {
  const f = await dependencyFixture();
  slowCopy.on = true;
  const { stopWorkspaceProvisioning } = await import('../../packages/control/dist/provisioning.js');
  const workspace = await f.provision(stopWorkspaceProvisioning);
  expect(workspace.provisioning?.state).toBe('cancelled');
});
