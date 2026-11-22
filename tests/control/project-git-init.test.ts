import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import { Control } from '@pantheon/control';
import type { Project } from '@pantheon/domain';
import { command, type CommandType } from '@pantheon/protocol';
import { ArtifactFiles, Store } from '@pantheon/store';
import { countingGit, user } from '../helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function setup() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'pantheon-git-init-'))),
    store = new Store(path.join(root, 'state/control.sqlite')),
    control = new Control(
      store,
      new ArtifactFiles(path.join(root, 'state/artifacts')),
      [new FixtureAdapter(100)],
      undefined,
      { workspaceRoot: path.join(root, 'managed'), userConfigDir: path.join(root, 'config') },
    );
  cleanups.push(async () => {
    await control.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const call = <T>(type: CommandType, input: Record<string, unknown>) =>
    control.execute(user, command(user.id, type, input, null)) as T;
  return { root, control, store, call };
}

function folders(root: string) {
  const plain = path.join(root, 'plain'),
    uncommitted = path.join(root, 'uncommitted'),
    committed = path.join(root, 'committed');
  for (const folder of [plain, uncommitted, committed]) {
    mkdirSync(folder);
    writeFileSync(path.join(folder, 'notes.txt'), 'notes\n');
  }
  git(uncommitted, 'init', '--quiet');
  git(committed, 'init', '--quiet');
  git(committed, 'add', '--all');
  git(committed, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'First');
  return { plain, uncommitted, committed };
}

it('makes one first commit when the same plain folder is opened twice at once', async () => {
  const f = setup(),
    { plain } = folders(f.root);
  const open = () => f.call<Promise<Project>>('project.open', { name: 'Notes', roots: [plain] });
  // A slow first commit lets the second open check HEAD while the first is still committing.
  const counter = countingGit();
  counter.slowOn('commit --quiet --allow-empty');
  try {
    await Promise.allSettled([open(), open()]);
  } finally {
    counter.restore();
  }
  expect(git(plain, 'rev-list', '--count', 'HEAD')).toBe('1');
});

it('makes a plain project folder a git repository whose first commit holds its files', async () => {
  const f = setup(),
    folder = path.join(f.root, 'notes'),
    empty = path.join(f.root, 'empty');
  mkdirSync(path.join(folder, 'drafts'), { recursive: true });
  mkdirSync(empty);
  writeFileSync(path.join(folder, 'notes.txt'), 'plain notes\n');
  writeFileSync(path.join(folder, 'drafts/plan.md'), '# Plan\n');
  const project = await f.call<Project>('project.open', {
    name: 'Notes',
    roots: [folder, empty],
  });
  for (const root of project.roots) {
    expect(git(root, 'rev-parse', '--show-toplevel')).toBe(root);
    expect(git(root, 'status', '--porcelain')).toBe('');
  }
  expect(git(project.roots[0]!, 'ls-files').split('\n').sort()).toEqual([
    'drafts/plan.md',
    'notes.txt',
  ]);
  expect(git(project.roots[1]!, 'rev-list', '--count', 'HEAD')).toBe('1');
});

it('refuses a folder whose files another repository tracks and gives an untracked folder its own repository', async () => {
  const f = setup(),
    outer = path.join(f.root, 'outer'),
    tracked = path.join(outer, 'tracked'),
    ignored = path.join(outer, 'ignored');
  mkdirSync(tracked, { recursive: true });
  mkdirSync(ignored);
  writeFileSync(path.join(tracked, 'kept.txt'), 'kept\n');
  writeFileSync(path.join(outer, '.gitignore'), 'ignored/\n');
  git(outer, 'init', '--quiet');
  git(outer, 'add', '--all');
  git(outer, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Outer files');
  await expect(f.call('project.open', { name: 'Tracked', roots: [tracked] })).rejects.toThrowError(
    expect.objectContaining({
      code: 'invalid_project',
      message: expect.stringContaining('add that repository as the project folder'),
    }),
  );
  expect(git(tracked, 'rev-parse', '--show-toplevel')).toBe(outer);
  const project = await f.call<Project>('project.open', { name: 'Ignored', roots: [ignored] });
  expect(git(project.roots[0]!, 'rev-parse', '--show-toplevel')).toBe(ignored);
  expect(git(outer, 'status', '--porcelain')).toBe('');
});

it('refuses a plain folder and a repository without commits once git init is turned off', async () => {
  const f = setup(),
    { plain, uncommitted, committed } = folders(f.root);
  expect(f.call('app.settings.set', { auto_git_init: false })).toEqual({
    auto_git_init: false,
    auto_archive_merged: false,
    session_recap: true,
    brief_prose: true,
    attention_delivery: expect.objectContaining({ question: 'now' }),
  });
  expect(f.control.appSettings(user)).toEqual({
    auto_git_init: false,
    auto_archive_merged: false,
    session_recap: true,
    brief_prose: true,
    attention_delivery: expect.objectContaining({ question: 'now' }),
  });
  for (const root of [plain, uncommitted])
    await expect(f.call('project.open', { name: 'Refused', roots: [root] })).rejects.toThrowError(
      expect.objectContaining({
        code: 'git_required',
        message: `${root} is not a git repository`,
      }),
    );
  expect(() => git(plain, 'rev-parse', '--git-dir')).toThrow();
  expect(() => git(uncommitted, 'rev-parse', '--verify', 'HEAD')).toThrow();
  const project = await f.call<Project>('project.open', { name: 'Committed', roots: [committed] });
  expect(git(committed, 'rev-list', '--count', 'HEAD')).toBe('1');
  for (const root of [plain, uncommitted])
    await expect(
      f.control.execute(
        user,
        command(
          user.id,
          'project.environment.set',
          { project_id: project.id, name: 'Committed', roots: [committed, root], env: {} },
          project.revision,
        ),
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: 'git_required' }));
  expect(f.store.must<Project>('projects', project.id).roots).toEqual([committed]);
});

it('runs git init again on the next project.open after the setting is turned back on', async () => {
  const f = setup(),
    { plain } = folders(f.root);
  expect(f.control.appSettings(user)).toEqual({
    auto_git_init: true,
    auto_archive_merged: false,
    session_recap: true,
    brief_prose: true,
    attention_delivery: expect.objectContaining({ question: 'now' }),
  });
  f.call('app.settings.set', { auto_git_init: false });
  await expect(f.call('project.open', { name: 'Plain', roots: [plain] })).rejects.toThrowError(
    expect.objectContaining({ code: 'git_required' }),
  );
  f.call('app.settings.set', { auto_git_init: true });
  const project = await f.call<Project>('project.open', { name: 'Plain', roots: [plain] });
  expect(git(project.roots[0]!, 'ls-files')).toBe('notes.txt');
  expect(
    f.store.db
      .prepare("SELECT payload FROM events WHERE kind='app.settings_set' ORDER BY sequence")
      .all()
      .map((row) => JSON.parse((row as { payload: string }).payload) as unknown),
  ).toEqual([{ auto_git_init: false }, { auto_git_init: true }]);
  expect(() =>
    f.control.execute(
      { id: 'agent', role: 'planner' },
      command('agent', 'app.settings.set', { auto_git_init: false }, null),
    ),
  ).toThrowError(expect.objectContaining({ code: 'permission_denied' }));
});
