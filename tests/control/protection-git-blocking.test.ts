import { execFileSync } from 'node:child_process';
import {
  existsSync,
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
import { globalExcludesFile } from '../../packages/control/dist/checkpoint.js';
import { inPlaceSandbox } from '../../packages/control/dist/protection.js';

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'protection-git-blocking-')));
  restores.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Puts a git first on PATH that logs each call and sleeps a second before each `config`. */
function slowConfigGit() {
  const real = execFileSync('/bin/sh', ['-c', 'command -v git']).toString().trim(),
    directory = tempRoot(),
    log = path.join(directory, 'calls.log'),
    previous = process.env.PATH;
  writeFileSync(
    path.join(directory, 'git'),
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${log}'`,
      'for arg in "$@"; do case "$arg" in config) sleep 1; break;; esac; done',
      `exec '${real}' "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  process.env.PATH = `${directory}${path.delimiter}${previous}`;
  restores.push(() => {
    process.env.PATH = previous;
  });
  return {
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []),
    reset: () => writeFileSync(log, ''),
  };
}

/** Whether a 50 ms timer started now fired before the returned check runs. */
function timerFired(): () => boolean {
  let fired = false;
  const timer = setTimeout(() => (fired = true), 50);
  restores.push(() => clearTimeout(timer));
  return () => fired;
}

function useHome(home: string) {
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;
  restores.push(() => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
}

it('keeps the event loop running while an in-place sandbox reads git configuration', async () => {
  const root = tempRoot(),
    folder = path.join(root, 'project'),
    tempDir = path.join(root, 'temp');
  for (const name of ['project', 'temp', 'home']) mkdirSync(path.join(root, name));
  execFileSync('git', ['init', '--quiet'], { cwd: folder });
  const git = slowConfigGit();
  const fired = timerFired();

  const sandbox = await inPlaceSandbox({
    dataDir: path.join(root, 'state'),
    desktopUserDataDir: path.join(root, 'desktop'),
    backupDir: path.join(root, 'backups'),
    // A home of its own gives the configuration cache a new key.
    home: path.join(root, 'home'),
    codexHome: path.join(root, 'codex'),
    otherWorkspaces: [],
    projectRoot: folder,
    tempDir,
  });

  expect(fired()).toBe(true);
  expect(git.calls().some((call) => call.includes('config --null --show-origin --list'))).toBe(
    true,
  );
  expect(sandbox.protected_entries.map((entry) => entry.path)).toContain(
    path.join(folder, '.git/config'),
  );
});

it('keeps the event loop running while the global excludes file is read, and runs no git once it is cached', async () => {
  const home = tempRoot();
  useHome(home);
  const custom = path.join(home, 'custom-ignore');
  writeFileSync(custom, '.env\n');
  writeFileSync(path.join(home, '.gitconfig'), `[core]\n\texcludesFile = ${custom}\n`);
  const git = slowConfigGit();
  const fired = timerFired();

  expect(await globalExcludesFile()).toBe(custom);
  expect(fired()).toBe(true);
  expect(git.calls().filter((call) => call.includes('config --global'))).toHaveLength(1);

  git.reset();
  expect(await globalExcludesFile()).toBe(custom);
  expect(git.calls()).toEqual([]);
});
