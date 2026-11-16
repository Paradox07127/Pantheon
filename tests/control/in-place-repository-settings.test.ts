import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runGit } from '../../packages/control/dist/git.js';
import { inPlaceSandbox } from '../../packages/control/dist/protection.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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
        GIT_AUTHOR_NAME: 'Config Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Config Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      },
      encoding: 'utf8',
    },
  ).trim();
}

function repository() {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'in-place-git-config-')));
  roots.push(base);
  const folder = path.join(base, 'project'),
    tempDir = path.join(base, 'temp');
  mkdirSync(folder);
  mkdirSync(tempDir);
  git(folder, 'init', '--quiet', '-b', 'main');
  writeFileSync(path.join(folder, 'a.txt'), 'a\n');
  git(folder, 'add', '.');
  git(folder, 'commit', '--quiet', '-m', 'First change');
  const sandbox = (projectRoot = folder) =>
    inPlaceSandbox({
      dataDir: path.join(base, 'state'),
      desktopUserDataDir: path.join(base, 'desktop'),
      backupDir: path.join(base, 'backups'),
      home: path.join(base, 'home'),
      codexHome: path.join(base, 'codex'),
      otherWorkspaces: [],
      projectRoot,
      tempDir,
    });
  const denied = (projectRoot: string, target: string) =>
    sandbox(projectRoot).protected_entries.find((entry) => entry.path === target)?.deny;
  return { base, folder, denied };
}

it('keeps an in-place session from writing the per-worktree git configuration', () => {
  const { folder, denied } = repository();
  git(folder, 'config', 'extensions.worktreeConfig', 'true');
  expect(denied(folder, path.join(folder, '.git/config.worktree'))).toBe('write');
});

it('keeps an in-place session from writing project files the git configuration includes', () => {
  const { folder, denied } = repository();
  writeFileSync(path.join(folder, 'shared.gitconfig'), '[include]\n\tpath = nested.gitconfig\n');
  writeFileSync(path.join(folder, 'nested.gitconfig'), '');
  git(folder, 'config', 'include.path', '../shared.gitconfig');
  git(folder, 'config', 'includeIf.onbranch:other.path', path.join(folder, 'branch.gitconfig'));
  for (const name of ['shared.gitconfig', 'nested.gitconfig', 'branch.gitconfig'])
    expect(denied(folder, path.join(folder, name))).toBe('write');
});

it('keeps an in-place session in a linked worktree from writing its pointer and the git metadata it points to', () => {
  const { base, folder, denied } = repository();
  const linked = path.join(base, 'linked');
  git(folder, 'worktree', 'add', '--quiet', '-b', 'side', linked);
  const metadata = path.join(folder, '.git/worktrees/linked');
  for (const target of [
    path.join(linked, '.git'),
    path.join(metadata, 'config.worktree'),
    path.join(folder, '.git/config'),
    path.join(folder, '.git/hooks'),
  ])
    expect(denied(linked, target)).toBe('write');
});

it('keeps an in-place session on macOS from creating a commondir that would redirect the repository metadata', () => {
  const { folder, denied } = repository();
  expect(denied(folder, path.join(folder, '.git/commondir'))).toBe(
    process.platform === 'darwin' ? 'write' : undefined,
  );
});

it('runs no signature program from repository configuration when git checks a signature', () => {
  const { base, folder } = repository();
  git(folder, 'config', 'gpg.ssh.allowedSignersFile', path.join(base, 'allowed-signers'));
  writeFileSync(path.join(base, 'allowed-signers'), '');
  const signed = (armor: string) =>
    execFileSync('git', ['hash-object', '-w', '-t', 'commit', '--stdin'], {
      cwd: folder,
      input:
        `tree ${git(folder, 'rev-parse', 'HEAD^{tree}')}\nparent ${git(folder, 'rev-parse', 'HEAD')}\n` +
        'author Config Fixture <fixture@example.invalid> 1700000000 +0000\n' +
        'committer Config Fixture <fixture@example.invalid> 1700000000 +0000\n' +
        `gpgsig -----BEGIN ${armor}-----\n \n c2lnbmF0dXJl\n -----END ${armor}-----\n\nSigned change\n`,
      env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      encoding: 'utf8',
    }).trim();
  for (const [key, armor] of [
    ['gpg.program', 'PGP SIGNATURE'],
    ['gpg.openpgp.program', 'PGP SIGNATURE'],
    ['gpg.x509.program', 'SIGNED MESSAGE'],
    ['gpg.ssh.program', 'SSH SIGNATURE'],
  ] as const) {
    const marker = path.join(base, `${key}-ran`),
      program = path.join(base, `${key}.sh`);
    writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(program, 0o755);
    git(folder, 'config', key, program);
    runGit(folder, ['verify-commit', signed(armor)]);
    git(folder, 'config', '--unset', key);
    expect(existsSync(marker), key).toBe(false);
  }
});
