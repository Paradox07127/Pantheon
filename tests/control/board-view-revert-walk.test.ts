import { renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as gitCommands from '../../packages/control/dist/git.js';
import { awaitWorkspaceReady, countingGit, eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

let counter: ReturnType<typeof countingGit> | undefined;
afterEach(() => {
  counter?.restore();
  counter = undefined;
});

/** A lead merged two commits onto main; `first` is the older one. */
async function mergedLead() {
  const f = await workbenchFixture();
  const lead = await f.create('Build exports');
  await awaitWorkspaceReady(f.control, lead.workspace_id!);
  await eventually(
    () => f.turns(lead.id)[0]?.state === 'completed',
    () => f.control.tick(),
  );
  const base = git(f.source, 'rev-parse', 'HEAD');
  const commit = (name: string) => {
    writeFileSync(path.join(f.source, name), name);
    git(f.source, 'add', name);
    git(f.source, 'commit', '--quiet', '-m', `Add ${name}`);
    return git(f.source, 'rev-parse', 'HEAD');
  };
  const first = commit('first.txt'),
    last = commit('last.txt');
  f.store.event('session.merged', lead, f.project.id, {
    branch: 'main',
    from_sha: base,
    to_sha: last,
  });
  return { f, first };
}

it('walks a repository for reverts again only after its merged branch moves', async () => {
  const { f, first } = await mergedLead();
  const run = vi.spyOn(gitCommands, 'runGit'),
    walks = () => run.mock.calls.filter(([, args]) => args.includes('--source')).length,
    changes = () =>
      f.store
        .events(0, f.project.id, 2000)
        .filter((event) => event.kind === 'workspace.repository_changed').length;
  await f.control.prefetchWorktreeReads(user, f.project.id);
  expect(f.control.boardView(user, f.project.id, 1).counts.reverted).toBe(0);
  expect(f.control.boardView(user, f.project.id, 1).counts.reverted).toBe(0);
  const read = changes();
  await f.control.prefetchWorktreeReads(user, f.project.id);
  expect(walks()).toBe(1);
  git(f.source, 'revert', '--no-edit', first);
  await f.control.prefetchWorktreeReads(user, f.project.id);
  expect(changes()).toBe(read + 1);
  expect(f.control.boardView(user, f.project.id, 1).counts.reverted).toBe(1);
  expect(walks()).toBe(2);
});

it('counts reverts from the walk read ahead and starts no git while it builds the board', async () => {
  const { f, first } = await mergedLead();
  git(f.source, 'revert', '--no-edit', first);
  counter = countingGit();
  await f.control.prefetchWorktreeReads(user, f.project.id);
  counter.reset();
  expect(f.control.boardView(user, f.project.id, 1, undefined, 'cached').counts.reverted).toBe(1);
  expect(f.control.boardView(user, f.project.id, 14, undefined, 'cached').counts.reverted).toBe(1);
  expect(counter.runs()).toEqual([]);
});

it('keeps the event loop running while it resolves the merged branches for the board', async () => {
  const { f } = await mergedLead();
  counter = countingGit();
  counter.slowOn('cat-file --batch-check');
  let during = 0;
  const timer = setInterval(() => {
    const log = counter!.log();
    if (log.includes('slow start') && !log.includes('slow done')) during++;
  }, 50);
  await f.control.prefetchWorktreeReads(user, f.project.id);
  f.control.boardView(user, f.project.id, 1, undefined, 'cached');
  clearInterval(timer);
  expect(during).toBeGreaterThan(0);
});

it('shows the board with no reverts counted once the repository of a merge in the range moved', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Build exports');
  await awaitWorkspaceReady(f.control, lead.workspace_id!);
  await eventually(
    () => f.turns(lead.id)[0]?.state === 'completed',
    () => f.control.tick(),
  );
  const head = git(f.source, 'rev-parse', 'HEAD');
  f.store.event('session.merged', lead, f.project.id, { branch: 'main', to_sha: head });
  renameSync(f.source, `${f.source}-moved`);
  expect(f.control.boardView(user, f.project.id, 1).counts).toMatchObject({
    merged: 1,
    reverted: 0,
  });
  renameSync(`${f.source}-moved`, f.source);
});
