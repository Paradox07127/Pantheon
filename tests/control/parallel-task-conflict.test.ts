import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { Session } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

async function mergeFixture() {
  const f = await workbenchFixture();
  git(f.source, 'config', 'user.name', 'Source User');
  git(f.source, 'config', 'user.email', 'source@example.invalid');
  return f;
}

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const idle = (f: Fixture, sessionId: string) =>
  current(f, sessionId).state === 'open' &&
  f.turns(sessionId).every((turn) => !['queued', 'running'].includes(turn.state));

it('aborts a failed rebase that left no conflicted files instead of leaving the worktree mid-rebase', async () => {
  const f = await mergeFixture();
  const session = await f.create();
  const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => idle(f, session.id),
    () => f.control.tick(),
  );
  const commit = (repository: string, name: string, contents: string) => {
    mkdirSync(path.dirname(path.join(repository, name)), { recursive: true });
    writeFileSync(path.join(repository, name), contents);
    git(repository, 'add', '--', name);
    git(repository, 'commit', '--quiet', '-m', `Add ${name}`);
    return git(repository, 'rev-parse', 'HEAD');
  };
  // A commit that adds a file, and a later one that deletes it again.
  commit(workspace.path, 'notes.txt', 'draft notes\n');
  git(workspace.path, 'rm', '--quiet', 'notes.txt');
  git(workspace.path, 'commit', '--quiet', '-m', 'Remove notes.txt');
  const ours = commit(workspace.path, 'session.txt', 'session\n');
  const theirs = commit(f.source, 'source.txt', 'source\n');
  await f.call<Session>(
    'session.merge',
    { session_id: session.id },
    current(f, session.id).revision,
  );
  // An untracked file written after the merge was admitted stops the rebase at the first commit, with no conflict.
  writeFileSync(path.join(workspace.path, 'notes.txt'), 'kept by the user\n');
  await eventually(
    () => current(f, session.id).merge?.state === 'blocked',
    () => f.control.tick(),
  );
  expect(current(f, session.id).merge!.reason).toMatch(/^git_failed: /);
  const rebaseDirectories = git(
    workspace.path,
    'rev-parse',
    '--git-path',
    'rebase-merge',
    '--git-path',
    'rebase-apply',
  )
    .split('\n')
    .map((directory) => path.resolve(workspace.path, directory));
  expect(rebaseDirectories.filter((directory) => existsSync(directory))).toEqual([]);
  expect(git(workspace.path, 'rev-parse', 'HEAD')).toBe(ours);
  expect(git(workspace.path, 'status', '--porcelain=v1', '--untracked-files=no')).toBe('');
  expect(readFileSync(path.join(workspace.path, 'notes.txt'), 'utf8')).toBe('kept by the user\n');
  expect(git(f.source, 'rev-parse', 'main')).toBe(theirs);
  expect(f.control.needsYou(user, f.project.id).items).toMatchObject([
    { source: { id: session.id }, reason: 'merge_blocked' },
  ]);
});
