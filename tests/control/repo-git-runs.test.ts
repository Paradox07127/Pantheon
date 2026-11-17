import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { git, workbenchFixture } from './workbench-fixture.js';
import { heldIndexLock, user } from '../helpers.js';

const DAY = 24 * 60 * 60 * 1000,
  WEEK = 7 * DAY;

/** Puts a git first on PATH that logs each run's start, end and arguments, and traces what git runs itself. */
function recordedGit() {
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = mkdtempSync(path.join(tmpdir(), 'pantheon-recorded-git-'));
  const log = path.join(bin, 'runs.log'),
    trace = path.join(bin, 'trace.log');
  writeFileSync(
    path.join(bin, 'git'),
    [
      '#!/bin/sh',
      `echo "start $$ $*" >> '${log}'`,
      // Status runs last long enough that the ones started together overlap.
      `case " $* " in *" status --porcelain=v2 "*) sleep 0.3;; esac`,
      `GIT_TRACE='${trace}' '${real}' "$@"`,
      'code=$?',
      `echo "end $$" >> '${log}'`,
      'exit $code',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${PATH}`;
  onTestFinished(() => {
    process.env.PATH = PATH;
    rmSync(bin, { recursive: true, force: true });
  });
  const lines = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return {
    clear() {
      writeFileSync(log, '');
      writeFileSync(trace, '');
    },
    /** The arguments of each run whose arguments match. */
    runs: (match: RegExp) =>
      lines()
        .filter((line) => line.startsWith('start ') && match.test(line))
        .map((line) => line.split(' ').slice(2).join(' ')),
    /** The most runs whose arguments match that were running at once. */
    overlap(match: RegExp) {
      const running = new Set<string>();
      let most = 0;
      for (const line of lines()) {
        const [mark, pid] = line.split(' ');
        if (mark === 'start' && match.test(line)) running.add(pid!);
        if (mark === 'end') running.delete(pid!);
        most = Math.max(most, running.size);
      }
      return most;
    },
    trace: () => readFileSync(trace, 'utf8'),
  };
}

function commitAt(cwd: string, file: string, content: string, at: number) {
  writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', file);
  const date = `@${Math.floor(at / 1000)} +0000`;
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', file], {
    cwd,
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Workbench Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Workbench Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  });
  return git(cwd, 'rev-parse', 'HEAD');
}

/** The weekly counts and extent of HEAD's whole history, as a fresh read gives them for a project without merges. */
function wholeHistory(cwd: string) {
  const times = git(cwd, 'log', '--format=%ct', 'HEAD')
    .split('\n')
    .map((time) => Number(time) * 1000);
  const weeks = new Map<number, number>();
  for (const at of times) {
    const week = Math.floor(at / WEEK) * WEEK;
    weeks.set(week, (weeks.get(week) ?? 0) + 1);
  }
  const overview = [];
  for (let start = Math.min(...weeks.keys()); start <= Math.max(...weeks.keys()); start += WEEK)
    overview.push({ start, agent: 0, user: weeks.get(start) ?? 0 });
  return { overview, extent: { first: Math.min(...times), last: Math.max(...times) } };
}

it('reads at most four worktrees at once', async () => {
  const f = await workbenchFixture();
  for (let index = 0; index < 10; index++)
    git(f.source, 'worktree', 'add', '--quiet', '--detach', path.join(f.root, `tree-${index}`));
  const recorded = recordedGit();
  recorded.clear();
  const worktrees = await f.control.repoWorktrees(user, f.project.id);
  expect(worktrees).toHaveLength(11);
  expect(worktrees[0]).toMatchObject({ kind: 'checkout', uncommitted: 0 });
  expect(recorded.runs(/ status --porcelain=v2 /)).toHaveLength(11);
  expect(recorded.overlap(/ status --porcelain=v2 /)).toBeLessThanOrEqual(4);
});

it('reads only the new commits of a HEAD that moved forward, and the whole history otherwise', async () => {
  const f = await workbenchFixture();
  const now = Date.now();
  commitAt(f.source, 'one.txt', 'one\n', now - 5 * WEEK);
  const old = commitAt(f.source, 'two.txt', 'two\n', now - 3 * WEEK);
  const timeline = async () => {
    const { overview, extent } = await f.control.repoTimeline(user, {
      project_id: f.project.id,
      from: now - DAY,
      to: now + DAY,
      group: 'branch',
    });
    return { overview, extent };
  };
  expect(await timeline()).toEqual(wholeHistory(f.source));
  const recorded = recordedGit();
  const head = commitAt(f.source, 'three.txt', 'three\n', now - WEEK);
  recorded.clear();
  expect(await timeline()).toEqual(wholeHistory(f.source));
  expect(recorded.runs(/ log .*%H %ct/)).toEqual([expect.stringContaining(` ${old}..${head} `)]);
  git(f.source, 'reset', '--quiet', '--hard', old);
  commitAt(f.source, 'four.txt', 'four\n', now - 2 * DAY);
  recorded.clear();
  expect(await timeline()).toEqual(wholeHistory(f.source));
  expect(recorded.runs(/ log .*%H %ct/)).toEqual([expect.not.stringContaining('..')]);
});

it('traces every range a commit added in one log run', async () => {
  const f = await workbenchFixture();
  const lines = Array.from({ length: 12 }, (_, index) => `line ${index}`);
  const write = (change: (copy: string[]) => void) => {
    const copy = [...lines];
    change(copy);
    lines.splice(0, lines.length, ...copy);
    return commitAt(f.source, 'ranges.txt', `${lines.join('\n')}\n`, Date.now());
  };
  write(() => {});
  const added = write((copy) => {
    copy[1] = 'first added';
    copy[10] = 'second added';
  });
  const first = write((copy) => (copy[1] = 'first changed'));
  const second = write((copy) => (copy[10] = 'second changed'));
  const recorded = recordedGit();
  recorded.clear();
  const after = await f.control.repoCommitAfter(user, { project_id: f.project.id, sha: added });
  expect(after.later.map((commit) => commit.sha).sort()).toEqual([first, second].sort());
  expect(recorded.runs(/ log .*-L/)).toHaveLength(1);
});

/** The fixture checkout with tracked files of each kind, and changes to all of them. */
async function changedCheckout() {
  const f = await workbenchFixture();
  const root = f.project.roots[0]!;
  const write = (file: string, content: string | Buffer) =>
    writeFileSync(path.join(root, file), content);
  write('gone.txt', 'soon gone\n');
  write('lines.txt', 'one\ntwo\n');
  write('bin.dat', Buffer.from([0, 1, 2]));
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'Add the files');
  write('answer.txt', 'base\nmore\n');
  git(root, 'mv', 'gone.txt', 'moved.txt');
  write('bin.dat', Buffer.from([0, 3, 4]));
  unlinkSync(path.join(root, 'lines.txt'));
  write('space é.txt', 'x\n');
  git(root, 'add', 'space é.txt');
  write('fresh.txt', 'one\ntwo\n');
  return { f, root, write };
}

it('reads the changes against HEAD in one diff run, as the separate runs listed them', async () => {
  const { f, root } = await changedCheckout();
  const recorded = recordedGit();
  recorded.clear();
  const diff = await f.control.repoWorkingDiff(user, f.project.id);
  expect(recorded.runs(/ diff .* HEAD --$/)).toHaveLength(1);
  const files = [
    { path: 'answer.txt', status: 'modified', additions: 1, deletions: 0 },
    { path: 'bin.dat', status: 'modified', additions: null, deletions: null },
    { path: 'lines.txt', status: 'deleted', additions: 0, deletions: 2 },
    { path: 'moved.txt', old_path: 'gone.txt', status: 'renamed', additions: 0, deletions: 0 },
    { path: 'space é.txt', status: 'added', additions: 1, deletions: 0 },
    { path: 'fresh.txt', status: 'untracked', additions: 2, deletions: 0 },
  ];
  expect(diff.files).toEqual(expect.arrayContaining(files));
  expect(diff.files).toHaveLength(files.length);
  expect(diff.truncated).toBe(false);
  const tracked = git(
    root,
    ...['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-relative'],
    ...['--src-prefix=a/', '--dst-prefix=b/', '--find-renames', 'HEAD', '--'],
  );
  expect(diff.patch!.startsWith(`${tracked}\n`)).toBe(true);
  expect(diff.patch!.slice(tracked.length)).toContain('+++ b/fresh.txt\n@@ -0,0 +1,2 @@\n+one');
});

it.each([2, 5])(
  'lists the files and no patch when the tracked patch takes %i MiB',
  async (size) => {
    const { f, write } = await changedCheckout();
    write('answer.txt', `${'x'.repeat(1023)}\n`.repeat(size * 1024));
    const diff = await f.control.repoWorkingDiff(user, f.project.id);
    expect(diff).toMatchObject({ truncated: true, patch: null });
    expect(diff.files).toContainEqual({
      path: 'answer.txt',
      status: 'modified',
      additions: size * 1024,
      deletions: 1,
    });
    expect(diff.files).toHaveLength(6);
  },
);

it('commits in the user’s repository without starting its automatic maintenance', async () => {
  const f = await workbenchFixture();
  const root = f.project.roots[0]!;
  git(root, 'config', 'user.name', 'Repository Owner');
  git(root, 'config', 'user.email', 'owner@example.invalid');
  git(root, 'config', 'gc.auto', '1');
  git(root, 'config', 'maintenance.auto', 'true');
  writeFileSync(path.join(root, 'answer.txt'), 'base\ncommitted\n');
  const recorded = recordedGit();
  recorded.clear();
  await f.call<Promise<unknown>>('repo.commit', {
    project_id: f.project.id,
    paths: ['answer.txt'],
    message: 'Commit through the user’s git',
  });
  expect(git(root, 'log', '-1', '--format=%s')).toBe('Commit through the user’s git');
  expect(recorded.runs(/ commit /).length).toBeGreaterThan(0);
  expect(recorded.trace()).not.toMatch(/maintenance run|gc --auto/);
});

it('commits once another git gives up the index lock it held', async () => {
  const f = await workbenchFixture();
  const root = f.project.roots[0]!;
  git(root, 'config', 'user.name', 'Repository Owner');
  git(root, 'config', 'user.email', 'owner@example.invalid');
  writeFileSync(path.join(root, 'answer.txt'), 'base\ncommitted\n');
  const held = heldIndexLock('commit');
  onTestFinished(held.restore);
  await f.call<Promise<unknown>>('repo.commit', {
    project_id: f.project.id,
    paths: ['answer.txt'],
    message: 'Commit after the lock',
  });
  expect(git(root, 'log', '-1', '--format=%s')).toBe('Commit after the lock');
});
