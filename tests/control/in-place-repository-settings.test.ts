import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
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
  const denied = async (projectRoot: string, target: string) =>
    (await sandbox(projectRoot)).protected_entries.find((entry) => entry.path === target)?.deny;
  return { base, folder, denied, sandbox };
}

it('keeps an in-place session from writing the per-worktree git configuration', async () => {
  const { folder, denied } = repository();
  git(folder, 'config', 'extensions.worktreeConfig', 'true');
  expect(await denied(folder, path.join(folder, '.git/config.worktree'))).toBe('write');
});

const MARKER = '[fixture]\n\tmarker = included\n';

it.each<[string, (folder: string, home: string) => void, string[], boolean]>([
  [
    'relative, nested and conditional includes',
    (folder) => {
      writeFileSync(
        path.join(folder, 'shared.gitconfig'),
        '[include]\n\tpath = nested.gitconfig\n',
      );
      writeFileSync(path.join(folder, 'nested.gitconfig'), MARKER);
      git(folder, 'config', 'include.path', '../shared.gitconfig');
      git(folder, 'config', 'includeIf.onbranch:other.path', path.join(folder, 'branch.gitconfig'));
    },
    ['shared.gitconfig', 'nested.gitconfig', 'branch.gitconfig'],
    true,
  ],
  [
    'an include that is a symlink to a file with its own relative include',
    (folder) => {
      mkdirSync(path.join(folder, 'sub'));
      writeFileSync(
        path.join(folder, 'sub/real.gitconfig'),
        '[include]\n\tpath = nested.gitconfig\n',
      );
      symlinkSync('sub/real.gitconfig', path.join(folder, 'shared.gitconfig'));
      writeFileSync(path.join(folder, 'nested.gitconfig'), MARKER);
      git(folder, 'config', 'include.path', '../shared.gitconfig');
    },
    ['shared.gitconfig', 'sub/real.gitconfig', 'nested.gitconfig'],
    true,
  ],
  [
    'an include that goes up after a symlinked folder',
    (folder) => {
      mkdirSync(path.join(folder, 'deep/inner'), { recursive: true });
      symlinkSync('deep/inner', path.join(folder, 'alias'));
      writeFileSync(path.join(folder, 'deep/nested.gitconfig'), MARKER);
      git(folder, 'config', 'include.path', '../alias/../nested.gitconfig');
    },
    ['alias', 'deep/nested.gitconfig'],
    true,
  ],
  [
    'an include through a symlinked folder the session could point elsewhere',
    (folder) => {
      mkdirSync(path.join(folder, 'good'));
      writeFileSync(path.join(folder, 'good/shared.gitconfig'), MARKER);
      symlinkSync('good', path.join(folder, 'link'));
      git(folder, 'config', 'include.path', '../link/shared.gitconfig');
    },
    ['link', 'good/shared.gitconfig'],
    true,
  ],
  [
    'an include through a folder the session has not created yet',
    (folder) => git(folder, 'config', 'include.path', '../later/shared.gitconfig'),
    ['later'],
    false,
  ],
  [
    "a conditional include in the user's global configuration",
    (folder, home) =>
      writeFileSync(
        path.join(home, '.gitconfig'),
        `[includeIf "gitdir:/nowhere/"]\n\tpath = ${folder}/global.gitconfig\n`,
      ),
    ['global.gitconfig'],
    false,
  ],
  [
    "an include in the user's XDG configuration that names a home-relative path",
    (folder, home) => {
      mkdirSync(path.join(home, '.config/git'), { recursive: true });
      writeFileSync(
        path.join(home, '.config/git/config'),
        '[include]\n\tpath = ~/../project/xdg.gitconfig\n',
      );
      writeFileSync(path.join(folder, 'xdg.gitconfig'), '[include]\n\tpath = nested.gitconfig\n');
    },
    ['xdg.gitconfig', 'nested.gitconfig'],
    false,
  ],
])(
  'keeps an in-place session from writing project files the git configuration reads: %s',
  async (_name, setup, names, gitReadsMarker) => {
    const { base, folder, denied } = repository();
    mkdirSync(path.join(base, 'home'));
    setup(folder, path.join(base, 'home'));
    if (gitReadsMarker) expect(git(folder, 'config', 'fixture.marker')).toBe('included');
    for (const name of names)
      expect(await denied(folder, path.join(folder, name)), name).toBe('write');
    expect(await denied(folder, folder)).toBeUndefined();
  },
);

it('keeps an in-place session in a linked worktree from writing its pointer and the git metadata it points to', async () => {
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
    expect(await denied(linked, target)).toBe('write');
});

it('finds the metadata of a linked worktree whose pointer goes up after a symlinked folder', async () => {
  const { base, folder, denied } = repository();
  const linked = path.join(base, 'linked');
  git(folder, 'worktree', 'add', '--quiet', '-b', 'side', linked);
  mkdirSync(path.join(base, 'deep/inner'), { recursive: true });
  symlinkSync('deep/inner', path.join(base, 'alias'));
  symlinkSync(path.join(folder, '.git/worktrees/linked'), path.join(base, 'deep/metadata'));
  writeFileSync(path.join(linked, '.git'), 'gitdir: ../alias/../metadata\n');
  expect(git(linked, 'rev-parse', '--path-format=absolute', '--git-common-dir')).toBe(
    path.join(folder, '.git'),
  );
  for (const target of [path.join(folder, '.git/config'), path.join(folder, '.git/hooks')])
    expect(await denied(linked, target)).toBe('write');
});

it('lets an in-place session in a linked worktree commit through its own metadata but not write other worktrees', async () => {
  const { base, folder, sandbox: sandboxOf } = repository();
  const linked = path.join(base, 'linked');
  git(folder, 'worktree', 'add', '--quiet', '-b', 'side', linked);
  git(folder, 'worktree', 'add', '--quiet', '-b', 'other', path.join(base, 'other'));
  const sandbox = await sandboxOf(linked);
  const writable = (target: string) =>
    sandbox.writable_roots.some((root) => !path.relative(root, target).startsWith('..')) &&
    !sandbox.protected_entries.some((entry) => !path.relative(entry.path, target).startsWith('..'));
  const metadata = path.join(folder, '.git');
  for (const target of [
    'worktrees/linked/index',
    'worktrees/linked/HEAD',
    'worktrees/linked/logs/HEAD',
    'objects/ab/cdef',
    'refs/heads/side',
    'logs/refs/heads/side',
  ])
    expect(writable(path.join(metadata, target)), target).toBe(true);
  for (const target of [
    'worktrees/other/HEAD',
    'worktrees/linked/commondir',
    'worktrees/linked/gitdir',
    'config',
    'hooks/pre-commit',
    'HEAD',
    'index',
  ])
    expect(writable(path.join(metadata, target)), target).toBe(false);
  expect(writable(path.join(folder, 'a.txt'))).toBe(false);
});

it.each(['.git/config', '.git/hooks/pre-commit'])(
  'refuses an in-place session while a project file is a hard link to the protected %s',
  async (name) => {
    const { folder, sandbox } = repository();
    const target = path.join(folder, name);
    if (!existsSync(target)) writeFileSync(target, '#!/bin/sh\n');
    linkSync(target, path.join(folder, 'alias.txt'));
    await expect(sandbox(folder)).rejects.toThrow(
      expect.objectContaining({ code: 'scope_violation' }),
    );
  },
);

it('keeps an in-place session on macOS from creating a commondir that would redirect the repository metadata', async () => {
  const { folder, denied } = repository();
  expect(await denied(folder, path.join(folder, '.git/commondir'))).toBe(
    process.platform === 'darwin' ? 'write' : undefined,
  );
});

it('runs no signature program from repository configuration when git checks a signature', async () => {
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
    const marker = path.join(base, `${key}'-ran`),
      program = path.join(base, `${key}.sh`);
    writeFileSync(program, `#!/bin/sh\ntouch '${marker.replaceAll("'", `'\\''`)}'\nexit 1\n`);
    chmodSync(program, 0o755);
    spawnSync(program);
    expect(existsSync(marker), key).toBe(true);
    rmSync(marker);
    git(folder, 'config', key, program);
    await runGit(folder, ['verify-commit', signed(armor)], undefined, true);
    git(folder, 'config', '--unset', key);
    expect(existsSync(marker), key).toBe(false);
  }
});
