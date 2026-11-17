import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { sourcing } from '../../packages/control/dist/baseline.js';
import { protectionList } from '../../packages/control/dist/protection.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempRoot() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'git-call-bounds-')));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Bounds Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Bounds Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
    encoding: 'utf8',
  });
}

function repository() {
  const root = tempRoot();
  git(root, 'init', '-q');
  writeFileSync(path.join(root, 'README.md'), '# Fixture\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'Add readme');
  return root;
}

const quoted = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** The arguments of every git `run` starts, through a script on PATH that logs them. */
async function gitRuns(run: () => unknown): Promise<string[]> {
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = tempRoot(),
    log = path.join(bin, 'runs.log');
  writeFileSync(log, '');
  writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quoted(log)}\nexec ${quoted(real)} "$@"\n`,
  );
  chmodSync(path.join(bin, 'git'), 0o755);
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}:${PATH}`;
  try {
    await run();
    return readFileSync(log, 'utf8').split('\n').filter(Boolean);
  } finally {
    process.env.PATH = PATH;
  }
}

it('checks every commit reference of a root with one git run', async () => {
  const root = repository();
  const head = git(root, 'rev-parse', '--short', 'HEAD').trim();
  let found: boolean[] = [];
  const runs = await gitRuns(async () => {
    const sourced = await sourcing(
      [root],
      ['commit:deadbee', 'commit:abcdef1', `commit:${head}`, 'commit:deadbee'],
    );
    found = [
      sourced(['commit:deadbee', 'commit:abcdef1', `commit:${head}`]),
      sourced(['commit:deadbee', 'commit:abcdef1']),
    ];
  });
  expect(found).toEqual([true, false]);
  expect(runs.filter((run) => run.includes(' cat-file '))).toEqual([
    expect.stringMatching(/ cat-file --batch-check$/),
  ]);
  expect(
    await gitRuns(async () =>
      expect((await sourcing([root], ['file:README.md']))(['file:README.md'])).toBe(true),
    ),
  ).toEqual([]);
});

it('reads git configuration again only after a configuration file changes', async () => {
  const root = tempRoot(),
    home = path.join(root, 'home'),
    workspace = path.join(root, 'workspace');
  for (const name of ['data', 'desktop', 'backups', 'home', 'codex', 'workspace'])
    mkdirSync(path.join(root, name));
  git(workspace, 'init', '-q');
  writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Bounds\n');
  const input = {
    dataDir: path.join(root, 'data'),
    desktopUserDataDir: path.join(root, 'desktop'),
    backupDir: path.join(root, 'backups'),
    home,
    codexHome: path.join(root, 'codex'),
    workspacePath: workspace,
    otherWorkspaces: [],
  };
  const included = path.join(workspace, 'shared.inc');
  const first = await protectionList(input);
  expect(first.some((entry) => entry.path === included)).toBe(false);
  expect(await gitRuns(async () => expect(await protectionList(input)).toEqual(first))).toEqual([]);

  writeFileSync(path.join(home, '.gitconfig'), `[include]\n\tpath = ${included}\n`);
  expect(await protectionList(input)).toContainEqual({
    path: included,
    deny: 'write',
    reason: 'Workspace git configuration',
  });
});
