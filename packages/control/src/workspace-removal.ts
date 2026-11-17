import { existsSync, lstatSync, realpathSync, rmdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Session, Workspace } from '@pantheon/domain';
import { managedRootOf, resolvedPath, type ControlContext } from './context.js';
import { deleteCheckpoints } from './checkpoint.js';
import { runGit } from './git.js';
import { removeRemoteWorkspace } from './remote-workspace.js';
import { onWslAutomount } from './wsl-mount.js';

// Kept short: tests create unix sockets under TMPDIR and macOS caps socket paths at 104 bytes.
export function writerTempDirectory(workspaceId: string): string {
  return path.join(realpathSync(os.tmpdir()), `pantheon-${workspaceId.slice(0, 12)}`);
}

/** By workspace id, the removal running now; a second call for it waits on that one. */
const removals = new WeakMap<ControlContext, Map<string, Promise<void>>>();

/** Removes the worktree; git runs outside the store's transactions. Call it outside one. */
export function removeWorkspace(
  ctx: ControlContext,
  workspaceId: string,
  jobId: string,
): Promise<void> {
  let running = removals.get(ctx);
  if (!running) removals.set(ctx, (running = new Map()));
  const current = running.get(workspaceId);
  // The later job stays pending; the next tick finds the workspace removed and marks it done.
  if (current) return current;
  const removal = removeOnce(ctx, workspaceId, jobId).finally(() => running.delete(workspaceId));
  running.set(workspaceId, removal);
  return removal;
}

async function removeOnce(ctx: ControlContext, workspaceId: string, jobId: string): Promise<void> {
  const workspace = ctx.store.must<Workspace>('workspaces', workspaceId);
  const skip = () => ctx.store.transaction(() => ctx.store.mark(jobId, 'done'));
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
    const head = await runGit(
      workspace.path,
      ['rev-parse', '--verify', 'HEAD^{commit}'],
      undefined,
      true,
    );
    if (head.exit_code !== 0 || head.stdout.toString().trim() !== landed?.to_sha) return skip();
  }
  // Provisioning locks worktrees of a drive repository, and remove refuses a locked one.
  if (onWslAutomount(workspace.source!))
    await runGit(workspace.source!, ['worktree', 'unlock', workspace.path], undefined, true);
  // Without --force Git refuses a worktree with changed or untracked files; it clears the
  // metadata of a folder deleted by hand and leaves other worktrees' metadata alone.
  await runGit(
    workspace.source!,
    ['worktree', 'remove', ...(merged ? [] : ['--force']), workspace.path],
    undefined,
    true,
  );
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
  await deleteCheckpoints(workspace);
  rmSync(writerTempDirectory(workspace.id), { recursive: true, force: true });
  ctx.failpoint('after_workspace_delete');
  ctx.store.transaction(() => {
    // Read again: the row may have changed while git ran.
    const latest = ctx.store.must<Workspace>('workspaces', workspaceId);
    const next = ctx.store.update<Workspace>(
      'workspaces',
      { ...latest, removed_at: ctx.store.now() },
      latest.revision,
    );
    ctx.store.event('workspace.removed', next, workspace.project_id, {});
    removeRemoteWorkspace(ctx, latest);
    ctx.store.mark(jobId, 'done');
  });
}
