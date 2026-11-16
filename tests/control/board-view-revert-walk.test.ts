import { renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import * as gitCommands from '../../packages/control/dist/git.js';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

it('walks a repository for reverts again only after its merged branch moves', async () => {
  const f = workbenchFixture();
  const lead = f.create('Build exports');
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
  await f.control.prefetchWorktreeReads(user, f.project.id);
  const run = vi.spyOn(gitCommands, 'runGit'),
    walks = () => run.mock.calls.filter(([, args]) => args.includes('--source')).length;
  expect(f.control.boardView(user, f.project.id, 1).counts.reverted).toBe(0);
  expect(f.control.boardView(user, f.project.id, 1).counts.reverted).toBe(0);
  expect(walks()).toBe(1);
  git(f.source, 'revert', '--no-edit', first);
  expect(f.control.boardView(user, f.project.id, 1).counts.reverted).toBe(1);
  expect(walks()).toBe(2);
});

it('shows the board with no reverts counted once the repository of a merge in the range moved', async () => {
  const f = workbenchFixture();
  const lead = f.create('Build exports');
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
