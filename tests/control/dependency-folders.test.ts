import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyDependencyFolders } from '../../packages/control/dist/dependency-folders.js';

const roots: string[] = [];
const globalConfig = process.env.GIT_CONFIG_GLOBAL;
afterEach(() => {
  if (globalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = globalConfig;
  for (const root of roots.splice(0)) {
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

/** A committed source with an installed node_modules/pkg, ignored by `ignore` when given. */
function dependencySource(ignore?: string) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pantheon-dependency-folders-')));
  roots.push(root);
  const source = path.join(root, 'source');
  mkdirSync(source);
  plainGit(source, 'init', '--quiet');
  if (ignore) writeFileSync(path.join(source, '.gitignore'), ignore);
  writeFileSync(path.join(source, 'answer.txt'), 'base\n');
  plainGit(source, 'add', '.');
  plainGit(source, 'commit', '--quiet', '-m', 'Initial answer');
  mkdirSync(path.join(source, 'node_modules/pkg'), { recursive: true });
  writeFileSync(path.join(source, 'node_modules/pkg/index.js'), 'module.exports = 42;\n');
  return { root, source };
}

it('copies dependency folders ignored only by the global excludes file', async () => {
  const { root, source } = dependencySource();
  const excludes = path.join(root, 'global-ignore'),
    config = path.join(root, 'global-config'),
    clone = path.join(root, 'clone');
  writeFileSync(excludes, 'node_modules/\n');
  writeFileSync(config, `[core]\n\texcludesFile = ${excludes}\n`);
  process.env.GIT_CONFIG_GLOBAL = config;
  mkdirSync(clone);
  await copyDependencyFolders(source, clone);
  expect(existsSync(path.join(clone, 'node_modules/pkg/index.js'))).toBe(true);
});

it('copies the ignored entries of a node_modules folder that tracks a placeholder', async () => {
  const { root, source } = dependencySource('node_modules/\n');
  writeFileSync(path.join(source, 'node_modules/.keep'), '');
  plainGit(source, 'add', '-f', 'node_modules/.keep');
  plainGit(source, 'commit', '--quiet', '-m', 'Keep node_modules');
  writeFileSync(path.join(source, 'node_modules/.package-lock.json'), '{}\n');
  const clone = path.join(root, 'clone');
  plainGit(source, 'worktree', 'add', '--quiet', '--detach', clone);
  await copyDependencyFolders(source, clone);
  expect(existsSync(path.join(clone, 'node_modules/pkg/index.js'))).toBe(true);
  expect(existsSync(path.join(clone, 'node_modules/.package-lock.json'))).toBe(true);
});

it('copies a dependency folder into the same folder the clone already has', async () => {
  const { root, source } = dependencySource('node_modules/\n');
  const clone = path.join(root, 'clone');
  mkdirSync(path.join(clone, 'node_modules'), { recursive: true });
  await copyDependencyFolders(source, clone);
  expect(readdirSync(path.join(clone, 'node_modules'))).toEqual(['pkg']);
});

// Root reads a folder with no permissions, so the copy cannot be made to fail this way.
it.skipIf(process.getuid?.() === 0)(
  'removes the half-made dependency folder of a failed copy and keeps one the clone had',
  async () => {
    const { root, source } = dependencySource('node_modules/\n');
    mkdirSync(path.join(source, 'node_modules/locked'));
    chmodSync(path.join(source, 'node_modules/locked'), 0);
    const fresh = path.join(root, 'fresh'),
      existing = path.join(root, 'existing');
    mkdirSync(fresh);
    mkdirSync(path.join(existing, 'node_modules'), { recursive: true });
    writeFileSync(path.join(existing, 'node_modules/kept.txt'), 'kept\n');
    await expect(copyDependencyFolders(source, fresh)).rejects.toThrow(
      'Could not copy dependency folder node_modules/',
    );
    await expect(copyDependencyFolders(source, existing)).rejects.toThrow(
      'Could not copy dependency folder node_modules/',
    );
    expect(readdirSync(fresh)).toEqual([]);
    expect(existsSync(path.join(existing, 'node_modules/kept.txt'))).toBe(true);
  },
);
