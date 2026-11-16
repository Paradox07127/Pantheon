import { existsSync, lstatSync, realpathSync, rmdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Session, Workspace } from '@pantheon/domain';
import { managedRootOf, resolvedPath, type ControlContext } from './context.js';
import { deleteCheckpoints } from './checkpoint.js';
import { runGit } from './git.js';
import { removeRemoteWorkspace } from './remote-workspace.js';

// Kept short: tests create unix sockets under TMPDIR and macOS caps socket paths at 104 bytes.
export function writerTempDirectory(workspaceId: string): string {
  return path.join(realpathSync(os.tmpdir()), `pantheon-${workspaceId.slice(0, 12)}`);
}

/** Removes the worktree inside the caller's transaction. */
export function removeWorkspaceInTransaction(
  ctx: ControlContext,
  workspaceId: string,
  jobId: string,
): void {
  const workspace = ctx.store.must<Workspace>('workspaces', workspaceId);
  const skip = () => ctx.store.mark(jobId, 'done');
  if (workspace.kind !== 'linked_worktree') return skip();
  // The job stays pending until provisioning has stopped writing the worktree.
  if (['queued', 'running'].includes(workspace.provisioning?.state ?? '')) return;
  if (workspace.removed_at !== undefined) return skip();
  if (workspace.owner !== 'none') return skip();
  let target: string;
  try {
    // Resolve existing ancestors even when a prior deletion has not been recorded yet.
    target = resolvedPath(workspace.path);
  } catch {
    return skip();
  }
  const root = managedRootOf(ctx, target);
  if (root === undefined || target === root) return skip();
  const merged = ctx.store
    .list<Session>('sessions')
    .find((session) => session.workspace_id === workspace.id && session.outcome === 'merged');
  // A merged worktree written after its merge holds work that did not land, so it is kept.
  if (merged && existsSync(workspace.path)) {
    const landed = ctx.store
      .kindEvents(workspace.project_id, ['session.merged'])
      .findLast((event) => event.aggregate_id === merged.id)?.payload as
      { to_sha?: string } | undefined;
    const head = runGit(workspace.path, ['rev-parse', '--verify', 'HEAD^{commit}']);
    if (head.exit_code !== 0 || head.stdout.toString().trim() !== landed?.to_sha) return skip();
  }
  // Without --force Git refuses a worktree with changed or untracked files; it clears the
  // metadata of a folder deleted by hand and leaves other worktrees' metadata alone.
  runGit(workspace.source!, ['worktree', 'remove', ...(merged ? [] : ['--force']), workspace.path]);
  // Git refuses the reservation a failed provisioning never populated; rmdir takes only an empty one.
  const identity = workspace.provisioning?.directory_identity;
  if (identity && ['failed', 'cancelled'].includes(workspace.provisioning!.state))
    try {
      const stat = lstatSync(workspace.path);
      if (stat.isDirectory() && stat.dev === identity.dev && stat.ino === identity.ino)
        rmdirSync(workspace.path);
    } catch {
      /* A populated or replaced folder stays. */
    }
  if (existsSync(workspace.path)) return skip();
  // A linked worktree's checkpoint refs live in its source repository.
  deleteCheckpoints(workspace);
  rmSync(writerTempDirectory(workspace.id), { recursive: true, force: true });
  ctx.failpoint('after_workspace_delete');
  const next = ctx.store.update<Workspace>(
    'workspaces',
    { ...workspace, removed_at: ctx.store.now() },
    workspace.revision,
  );
  ctx.store.event('workspace.removed', next, workspace.project_id, {});
  removeRemoteWorkspace(ctx, workspace);
  ctx.store.mark(jobId, 'done');
}

export function removeWorkspace(ctx: ControlContext, workspaceId: string, jobId: string): void {
  ctx.store.transaction(() => removeWorkspaceInTransaction(ctx, workspaceId, jobId));
}
