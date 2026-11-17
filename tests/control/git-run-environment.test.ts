import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { runGit } from '../../packages/control/dist/git.js';
import {
  automountRootFromConf,
  onWslAutomount,
  wslAutomountRoot,
  wslDrivePath,
} from '../../packages/control/dist/wsl-mount.js';

vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }));

const roots: string[] = [];
const fresh = (prefix: string) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
};

// The mount root WSL reads from /etc/wsl.conf; one per process, since the root is cached.
const mountRoot = `${realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pantheon-wsl-mount-')))}/`;
const readFile = fs.readFileSync;
vi.spyOn(fs, 'readFileSync').mockImplementation(((
  file: fs.PathOrFileDescriptor,
  options?: never,
) =>
  file === '/etc/wsl.conf'
    ? `[automount]\nroot = ${mountRoot}\n`
    : readFile(file, options)) as typeof fs.readFileSync);

const distro = process.env.WSL_DISTRO_NAME;
const searchPath = process.env.PATH;
afterEach(() => {
  if (distro === undefined) delete process.env.WSL_DISTRO_NAME;
  else process.env.WSL_DISTRO_NAME = distro;
  process.env.PATH = searchPath;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(() => rmSync(mountRoot, { recursive: true, force: true }));

function plainGit(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: {
      PATH: process.env.PATH,
      TMPDIR: os.tmpdir(),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Environment Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Environment Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function repository(root: string) {
  mkdirSync(root, { recursive: true });
  plainGit(root, ['init', '--quiet', '--initial-branch=main']);
  writeFileSync(path.join(root, 'file.txt'), 'base\n');
  plainGit(root, ['add', '.']);
  plainGit(root, ['commit', '--quiet', '-m', 'Initial file']);
  return root;
}

/** Puts a git first on PATH that logs each run; returns the number of runs so far. */
function countGitRuns() {
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = fresh('pantheon-git-wrapper-');
  const log = path.join(bin, 'runs.log');
  writeFileSync(log, '');
  writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`,
  );
  chmodSync(path.join(bin, 'git'), 0o700);
  process.env.PATH = `${bin}:${searchPath}`;
  return () => readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
}

const value = (cwd: string, key: string) =>
  runGit(cwd, ['config', '--get', key]).stdout.toString().trim();

it('turns off automatic maintenance and garbage collection in every repository', () => {
  const root = repository(fresh('pantheon-git-maintenance-'));
  expect(value(root, 'maintenance.auto')).toBe('false');
  expect(value(root, 'gc.auto')).toBe('0');
});

it('bounds synchronous output by the caller limit', () => {
  const root = repository(fresh('pantheon-git-bound-'));
  const result = runGit(root, ['log', '--format=%H%n%s'], undefined, false, { max_buffer: 16 });
  expect(result.exit_code).toBeNull();
  expect(result.error).toContain('ENOBUFS');
});

it.each([
  { key: 'GIT_INDEX_FILE', runs: 1 },
  { key: 'GIT_ALTERNATE_OBJECT_DIRECTORIES', runs: 1 },
  { key: 'GIT_DIR', runs: 2 },
])(
  'reuses the cached driver config under $key only when it keeps git on the same config',
  ({ key, runs }) => {
    const root = repository(fresh('pantheon-git-cache-'));
    const values: Record<string, string> = {
      GIT_INDEX_FILE: path.join(root, '.git', 'index'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: fresh('pantheon-git-alternates-'),
      GIT_DIR: path.join(root, '.git'),
    };
    const counted = countGitRuns();
    const env = { [key]: values[key]! };
    expect(runGit(root, ['rev-parse', 'HEAD'], undefined, false, { env }).exit_code).toBe(0);
    const before = counted();
    expect(runGit(root, ['rev-parse', 'HEAD'], undefined, false, { env }).exit_code).toBe(0);
    expect(counted() - before).toBe(runs);
  },
);

it('reads the automount root of wsl.conf and holds paths on a drive below it', () => {
  expect(automountRootFromConf('')).toBe('/mnt/');
  expect(automountRootFromConf('[automount]\nroot = "/windows"\n')).toBe('/windows/');
  expect(automountRootFromConf('[network]\nroot = /windows/\n')).toBe('/mnt/');
  expect(wslAutomountRoot({})).toBeUndefined();
  expect(wslAutomountRoot({ WSL_DISTRO_NAME: 'Fixture' })).toBe(mountRoot);
  const drive = path.join(mountRoot, 'c');
  mkdirSync(path.join(drive, 'project'), { recursive: true });
  mkdirSync(path.join(mountRoot, 'wslg'), { recursive: true });
  expect(onWslAutomount(path.join(drive, 'project'), mountRoot)).toBe(true);
  expect(onWslAutomount(drive, mountRoot)).toBe(true);
  expect(onWslAutomount(path.join(mountRoot, 'wslg'), mountRoot)).toBe(false);
  expect(onWslAutomount(os.tmpdir(), mountRoot)).toBe(false);
  expect(onWslAutomount(path.join(drive, 'project'), undefined)).toBe(false);
  rmSync(drive, { recursive: true, force: true });
  rmSync(path.join(mountRoot, 'wslg'), { recursive: true, force: true });
  expect(wslDrivePath('D:/coding warehouse/x', '/mnt/')).toBe('/mnt/d/coding warehouse/x');
  expect(wslDrivePath('D:\\x\\y', '/mnt/')).toBe('/mnt/d/x/y');
  expect(wslDrivePath('relative/x', '/mnt/')).toBeUndefined();
});

it.each([
  { wsl: true, onDrive: true, autocrlf: 'input', checkStat: 'minimal' },
  { wsl: true, onDrive: false, autocrlf: 'false', checkStat: '' },
  { wsl: false, onDrive: true, autocrlf: 'false', checkStat: '' },
])(
  'reads line endings and stat data the Windows way only on a WSL drive (wsl $wsl, drive $onDrive)',
  ({ wsl, onDrive, autocrlf, checkStat }) => {
    const root = onDrive
      ? path.join(mountRoot, 'c', `project-${wsl}`)
      : fresh('pantheon-git-linux-disk-');
    if (onDrive) roots.push(root);
    repository(root);
    if (wsl) process.env.WSL_DISTRO_NAME = 'Fixture';
    expect(value(root, 'core.autocrlf')).toBe(autocrlf);
    expect(value(root, 'core.checkStat')).toBe(checkStat);
    expect(value(root, 'core.trustctime')).toBe(checkStat ? 'false' : '');
  },
);

it.each([
  { gitdir: 'D:/coding warehouse/project/.git/worktrees/linked', commondir: '../..' },
  {
    gitdir: 'D:\\coding warehouse\\project\\.git\\worktrees\\linked',
    commondir: 'D:\\coding warehouse\\project\\.git',
  },
])('opens a worktree a Windows tool made at $gitdir', ({ gitdir, commondir }) => {
  const drive = fresh('pantheon-windows-drive-');
  symlinkSync(drive, path.join(mountRoot, 'd'));
  roots.push(path.join(mountRoot, 'd'));
  const project = repository(path.join(drive, 'coding warehouse', 'project'));
  const linked = path.join(drive, 'linked');
  plainGit(project, ['worktree', 'add', '--quiet', '-b', 'linked', linked]);
  writeFileSync(path.join(linked, '.git'), `gitdir: ${gitdir}\n`);
  writeFileSync(path.join(project, '.git', 'worktrees', 'linked', 'commondir'), `${commondir}\n`);
  plainGit(project, ['config', 'fixture.origin', 'common']);
  process.env.WSL_DISTRO_NAME = 'Fixture';
  const counted = countGitRuns();
  const located = runGit(linked, ['rev-parse', '--show-toplevel']);
  expect(located.stderr.toString()).toBe('');
  expect(located.stdout.toString()).toBe(`${linked}\n`);
  expect(value(linked, 'fixture.origin')).toBe('common');
  const before = counted();
  expect(runGit(linked, ['rev-parse', '--show-toplevel']).exit_code).toBe(0);
  expect(counted() - before).toBe(1);
});
