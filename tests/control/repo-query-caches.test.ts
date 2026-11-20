import { execFileSync } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { id, type Session, type Workspace } from '@pantheon/domain';
import { git, workbenchFixture } from './workbench-fixture.js';
import { user } from '../helpers.js';

const DAY = 24 * 60 * 60 * 1000;

/** A session whose worktree is on the branch feature, made from main's tip. */
function sessionWorktree(f: Awaited<ReturnType<typeof workbenchFixture>>) {
  const tree = path.join(f.root, 'session-tree');
  git(f.source, 'worktree', 'add', '--quiet', '-b', 'feature', tree);
  const workspace = f.store.insert<Workspace>('workspaces', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    kind: 'linked_worktree',
    path: realpathSync(tree),
    source: f.source,
    owner: 'none',
    ownership_epoch: 0,
  });
  const session = f.store.insert<Session>('sessions', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    workspace_id: workspace.id,
    state: 'open',
    turn_count: 0,
  });
  return { tree, session };
}

function commitFile(cwd: string, file: string, content: string, message: string) {
  writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '--quiet', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

it('reads the timeline, blame and history of a HEAD with 120 000 commits', async () => {
  const f = await workbenchFixture();
  const parent = git(f.source, 'rev-parse', 'HEAD'),
    start = Math.floor((Date.now() - 3 * 365 * DAY) / 1000);
  const commits = Array.from(
    { length: 120000 },
    (_, index) =>
      `commit refs/heads/main\ncommitter Workbench Fixture <fixture@example.invalid> ${start + index} +0000\n` +
      `data 0\n${index === 0 ? `from ${parent}\n` : ''}\n`,
  );
  execFileSync('git', ['fast-import', '--quiet'], {
    cwd: f.source,
    input: commits.join(''),
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  // Every imported commit points at the fixture's one loose tree; unpacked, a path walk reads it per commit.
  git(f.source, 'repack', '-q', '-a', '-d');
  const input = { project_id: f.project.id, path: 'answer.txt' };
  expect(await f.control.repoFileHistory(user, input)).toMatchObject({ scanned: 500 });
  const timeline = await f.control.repoTimeline(user, {
    project_id: f.project.id,
    from: Date.now() - DAY,
    to: Date.now() + DAY,
    group: 'branch',
  });
  expect(timeline.overview.reduce((sum, week) => sum + week.agent + week.user, 0)).toBe(120001);
  expect((await f.control.repoBlame(user, input)).chunks).toEqual([
    expect.objectContaining({ start: 1, count: 1, sha: parent }),
  ]);
});

it('counts a session worktree ahead again after it commits', async () => {
  const f = await workbenchFixture();
  const { tree } = sessionWorktree(f);
  const ahead = async () =>
    (await f.control.repoWorktrees(user, f.project.id)).find(
      (worktree) => worktree.kind === 'session',
    )?.ahead;
  commitFile(tree, 'notes.txt', 'one\n', 'Add notes');
  expect(await ahead()).toBe(1);
  commitFile(tree, 'notes.txt', 'one\ntwo\n', 'Add a second note');
  expect(await ahead()).toBe(2);
});

it('blames the commit HEAD moved to and the lines a session worktree changed since', async () => {
  const f = await workbenchFixture();
  const { tree, session } = sessionWorktree(f);
  const input = { project_id: f.project.id, path: 'answer.txt' };
  const first = git(f.source, 'rev-parse', 'HEAD');
  expect((await f.control.repoBlame(user, input)).chunks).toEqual([
    expect.objectContaining({ start: 1, count: 1, sha: first }),
  ]);
  const second = commitFile(f.source, 'answer.txt', 'base\nsecond\n', 'Second answer line');
  const blamed = await f.control.repoBlame(user, input);
  expect(blamed.chunks).toEqual([
    expect.objectContaining({ start: 1, count: 1, sha: first }),
    expect.objectContaining({ start: 2, count: 1, sha: second }),
  ]);
  expect(blamed.pending).toEqual([]);
  commitFile(tree, 'answer.txt', 'changed\n', 'Change the answer');
  expect((await f.control.repoBlame(user, input)).pending).toEqual([
    { session_id: session.id, ranges: [{ start: 1, count: 1 }] },
  ]);
});

it('names the session of a merge recorded after the log was first read', async () => {
  const f = await workbenchFixture();
  const { tree, session } = sessionWorktree(f);
  const first = git(f.source, 'rev-parse', 'HEAD');
  const second = commitFile(f.source, 'answer.txt', 'base\nsecond\n', 'Second answer line');
  const third = commitFile(tree, 'notes.txt', 'one\n', 'Add notes');
  f.store.event('session.merged', session, f.project.id, { from_sha: first, to_sha: third });
  const log = () => f.control.repoLog(user, { project_id: f.project.id, limit: 10, skip: 0 });
  expect((await log()).commits.map((commit) => commit.session_id)).toEqual([undefined, undefined]);
  const other = f.store.insert<Session>('sessions', { ...session, id: id() });
  f.store.event('session.merged', other, f.project.id, { from_sha: first, to_sha: second });
  expect((await log()).commits.map((commit) => commit.session_id)).toEqual([other.id, undefined]);
});
