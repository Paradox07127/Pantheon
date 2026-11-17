import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { Session } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = ReturnType<typeof workbenchFixture>;

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

/** Puts a git first on PATH that logs each call and sleeps a second before the slow subcommands. */
function gitWrapper(slow: string[]) {
  const real = execFileSync('/bin/sh', ['-c', 'command -v git']).toString().trim(),
    directory = mkdtempSync(path.join(os.tmpdir(), 'pantheon-git-wrapper-')),
    log = path.join(directory, 'calls.log'),
    previous = process.env.PATH;
  writeFileSync(
    path.join(directory, 'git'),
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${log}'`,
      ...(slow.length
        ? [`for arg in "$@"; do case "$arg" in ${slow.join('|')}) sleep 1; break;; esac; done`]
        : []),
      `exec '${real}' "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  process.env.PATH = `${directory}${path.delimiter}${previous}`;
  restores.push(() => {
    process.env.PATH = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  // Each call's subcommand, after the -c options runGit puts first.
  return () =>
    (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []).map((line) => {
      const words = line.split(' ');
      let index = 0;
      while (words[index] === '-c') index += 2;
      return words[index]!;
    });
}

/** Whether a 50 ms timer started now fired before the returned check runs. */
function timerFired(): () => boolean {
  let fired = false;
  const timer = setTimeout(() => (fired = true), 50);
  restores.push(() => clearTimeout(timer));
  return () => fired;
}

async function idleSession(f: Fixture) {
  const session = f.create();
  const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.turns(session.id)[0]!.state === 'completed' &&
      f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  return { session: f.store.must<Session>('sessions', session.id), workspace };
}

function commit(repository: string, name: string) {
  writeFileSync(path.join(repository, name), `${name}\n`);
  git(repository, 'add', '--', name);
  git(repository, 'commit', '--quiet', '-m', `Add ${name}`);
}

it('reads the project HEAD while the event loop runs, with status and log at once', async () => {
  const f = workbenchFixture();
  const calls = gitWrapper(['status', 'log']);
  const fired = timerFired(),
    started = performance.now();
  expect(await f.control.projectHead(user, f.project.id)).toMatchObject({
    branch: 'main',
    uncommitted: 0,
  });
  expect(fired()).toBe(true);
  expect(performance.now() - started).toBeLessThan(1800);
  expect(calls().sort()).toEqual(['log', 'status']);
});

it('reads merge preflight while the event loop runs, with one status per repository', async () => {
  const f = workbenchFixture();
  const { session, workspace } = await idleSession(f);
  commit(workspace.path, 'change.txt');
  // The first read of each repository also reads its Git configuration.
  await f.control.sessionPreflight(user, session.id);
  const calls = gitWrapper(['status']);
  const fired = timerFired();
  expect(await f.control.sessionPreflight(user, session.id)).toMatchObject({
    target_branch: 'main',
    commit_count: 1,
    worktree_clean: true,
    source_clean: true,
    can_merge: true,
  });
  expect(fired()).toBe(true);
  expect(calls().sort()).toEqual(['diff', 'merge-tree', 'rev-list', 'status', 'status']);
});

it('reports a detached source and an unborn worktree branch from the merged status reads', async () => {
  const f = workbenchFixture();
  const { session, workspace } = await idleSession(f);
  commit(workspace.path, 'change.txt');
  git(f.source, 'checkout', '--quiet', '--detach');
  expect(await f.control.sessionPreflight(user, session.id)).toMatchObject({
    target_branch: null,
    conflicts: { state: 'unknown' },
    can_merge: false,
    blocked_reason: 'source_detached',
  });
  git(workspace.path, 'checkout', '--quiet', '--orphan', 'empty');
  await expect(f.control.sessionPreflight(user, session.id)).rejects.toMatchObject({
    code: 'workspace_read_failed',
  });
});

it('lists a blocked merge without running Git and never as mergeable before its states are read', async () => {
  const f = workbenchFixture();
  const { session, workspace } = await idleSession(f);
  commit(workspace.path, 'change.txt');
  const blocked = f.store.update<Session>(
    'sessions',
    { ...session, merge: { state: 'blocked', reason: 'rebase_conflict' } },
    session.revision,
  );
  f.store.event('session.merge_blocked', blocked, blocked.project_id, blocked.merge);
  const calls = gitWrapper([]);
  // Other background work of the fixture reads the worktree too, but never its status.
  const statuses = () =>
    calls().filter((call) => call === 'status' || call === 'symbolic-ref').length;
  const actions = () => f.control.needsYou(user, f.project.id).items[0]!.actions;
  expect(actions()).toEqual([
    { command: 'session.merge', allowed: false, disabled_reason: 'workspace_read_failed' },
  ]);
  expect(statuses()).toBe(0);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(statuses()).toBe(0);
  const changes = () => f.store.kindEvents(f.project.id, ['workspace.repository_changed']).length,
    before = changes();
  await f.control.prefetchWorktreeReads(user, f.project.id);
  expect(changes()).toBeGreaterThan(before);
  const read = statuses();
  expect(actions()).toEqual([{ command: 'session.merge', allowed: true }]);
  expect(statuses()).toBe(read);
});

it('searches files while the event loop runs and lists a folder again only when HEAD moves', async () => {
  const f = workbenchFixture();
  const calls = gitWrapper(['ls-files']);
  const fired = timerFired();
  expect(await f.control.filesSearch(user, f.project.id, undefined, 'answer')).toEqual([
    'answer.txt',
  ]);
  expect(fired()).toBe(true);
  expect(await f.control.filesSearch(user, f.project.id, undefined, 'answer')).toEqual([
    'answer.txt',
  ]);
  const listings = () => calls().filter((call) => call === 'ls-files').length;
  expect(listings()).toBe(1);
  commit(f.source, 'later.txt');
  expect(await f.control.filesSearch(user, f.project.id, undefined, 'later')).toEqual([
    'later.txt',
  ]);
  expect(listings()).toBe(2);
});
