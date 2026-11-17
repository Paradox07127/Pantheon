import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { Session, Workspace } from '@pantheon/domain';
import { workbenchFixture, git } from './workbench-fixture.js';
import { eventually } from '../helpers.js';
import type { ControlContext } from '../../packages/control/dist/context.js';

it('keeps an archived worktree whose unheld commits could not be recorded under an archive ref', async () => {
  const f = workbenchFixture();
  const session = f.create('Unmerged session');
  const { startWorkspaceProvisioning } =
    await import('../../packages/control/dist/provisioning.js');
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  startWorkspaceProvisioning(ctx, session.workspace_id!);
  await eventually(
    () =>
      f.store.must<Workspace>('workspaces', session.workspace_id!).provisioning?.state === 'ready',
  );
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
  writeFileSync(path.join(workspace.path, 'unmerged.txt'), 'unmerged work\n');
  git(workspace.path, 'add', 'unmerged.txt');
  git(workspace.path, 'commit', '--quiet', '-m', 'Unmerged work');
  const commit = git(workspace.path, 'rev-parse', 'HEAD');
  const current = f.store.must<Session>('sessions', session.id);
  f.store.update(
    'sessions',
    { ...current, state: 'closed', archived_at: '2026-11-13T00:00:00Z' },
    current.revision,
  );
  // A lock file left by an interrupted Git makes the archive ref update fail.
  const archive = path.join(f.source, '.git/refs/pantheon/archive');
  mkdirSync(archive, { recursive: true });
  writeFileSync(path.join(archive, `${workspace.id}.lock`), '');
  expect(await f.call('workspace.prune_stale', { project_id: f.project.id })).toEqual({
    removed: 0,
  });
  expect(existsSync(workspace.path)).toBe(true);
  expect(f.store.must<Workspace>('workspaces', workspace.id).removed_at).toBeUndefined();
  expect(git(workspace.path, 'rev-parse', 'HEAD')).toBe(commit);
});
