import { existsSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  requireThat,
  type Project,
  type Principal,
  type Session,
  type Workspace,
} from '@pantheon/domain';
import { inputSchemas, type Command, type StaleWorkspaces } from '@pantheon/protocol';
import { projectAccess, type ControlContext, type Handler } from './context.js';
import { runGit } from './git.js';
import { removeWorkspace } from './workspace-removal.js';

/** A worktree is measured again at most this often, in milliseconds. */
export const DISK_REFRESH_MS = 300_000;

/** By workspace id. `at`: when the last measurement started; `size_bytes` stays during the next one. */
const sizes = new WeakMap<
  ControlContext,
  Map<string, { size_bytes?: number; at: number; pending: boolean }>
>();

function staleWorkspaces(ctx: ControlContext, projectId: string): Workspace[] {
  const sessions = ctx.store
    .list<Session>('sessions')
    .filter((session) => session.project_id === projectId);
  return ctx.store.list<Workspace>('workspaces').filter((workspace) => {
    if (
      workspace.project_id !== projectId ||
      workspace.kind !== 'linked_worktree' ||
      workspace.removed_at !== undefined ||
      !existsSync(workspace.path)
    )
      return false;
    const bound = sessions.filter((session) => session.workspace_id === workspace.id);
    return bound.length > 0 && bound.every((session) => session.archived_at !== undefined);
  });
}

/** Logical file bytes, including symlinks themselves without following their targets. */
async function directoryBytes(target: string): Promise<number> {
  try {
    const stat = await lstat(target);
    if (!stat.isDirectory()) return stat.size;
    let bytes = 0;
    for (const entry of await readdir(target))
      bytes += await directoryBytes(path.join(target, entry));
    return bytes;
  } catch (error) {
    // A prune or manual deletion can race an off-request measurement.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

export function workspaceStale(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
): StaleWorkspaces {
  projectAccess(ctx, p, projectId, 'project.read');
  const project = ctx.store.must<Project>('projects', projectId);
  const workspaces = ctx.store
    .list<Workspace>('workspaces')
    .filter(
      (workspace) =>
        workspace.project_id === projectId &&
        workspace.kind === 'linked_worktree' &&
        workspace.removed_at === undefined &&
        existsSync(workspace.path),
    );
  let cache = sizes.get(ctx);
  if (!cache) sizes.set(ctx, (cache = new Map()));
  let bytes = 0,
    unmeasured = 0;
  const stale = staleWorkspaces(ctx, projectId);
  let staleBytes = 0,
    staleUnmeasured = 0;
  const now = Date.now();
  for (const workspace of workspaces) {
    let entry = cache.get(workspace.id);
    if (!entry) cache.set(workspace.id, (entry = { at: 0, pending: false }));
    if (!entry.pending && (entry.at === 0 || now - entry.at >= DISK_REFRESH_MS)) {
      entry.pending = true;
      entry.at = now;
      const measuring = entry;
      setImmediate(() => {
        if (ctx.closing) return;
        let work!: Promise<void>;
        work = (async () => {
          try {
            const size = await directoryBytes(workspace.path);
            if (size !== measuring.size_bytes) {
              measuring.size_bytes = size;
              ctx.changed();
            }
          } catch (error) {
            ctx.store.event('workspace.stale_size_failed', project, projectId, {
              error: String(error),
            });
            ctx.changed();
          } finally {
            measuring.pending = false;
            ctx.completions.delete(work);
          }
        })();
        ctx.completions.add(work);
      });
    }
    bytes += entry.size_bytes ?? 0;
    if (entry.size_bytes === undefined) unmeasured++;
    if (stale.some((candidate) => candidate.id === workspace.id)) {
      staleBytes += entry.size_bytes ?? 0;
      if (entry.size_bytes === undefined) staleUnmeasured++;
    }
  }
  return {
    count: stale.length,
    ...(staleUnmeasured ? {} : { size_bytes: staleBytes }),
    ...(workspaces.length
      ? { worktree_disk: { count: workspaces.length, size_bytes: bytes, unmeasured } }
      : {}),
    ...(ctx.workspaceRoot ? { worktree_root: ctx.workspaceRoot } : {}),
  };
}

/** workspace.prune_stale; git runs outside the store's transactions, and the handler returns the count. */
export function prepareStalePrune(ctx: ControlContext, p: Principal, c: Command): Promise<Handler> {
  requireThat(p.role === 'user', 'permission_denied', 'Only the user can prune worktrees');
  const { project_id } = c.input as ReturnType<
    (typeof inputSchemas)['workspace.prune_stale']['parse']
  >;
  projectAccess(ctx, p, project_id, c.type);
  ctx.store.must<Project>('projects', project_id);
  const git = (cwd: string, args: string[]) => runGit(cwd, args, undefined, true);
  return (async () => {
    let removed = 0;
    for (const workspace of staleWorkspaces(ctx, project_id)) {
      // Worktrees are detached: commits no branch or tag holds would become unreachable,
      // so a worktree whose HEAD is not shown held or archived is kept.
      const head = await git(workspace.path, ['rev-parse', '--verify', 'HEAD^{commit}']);
      const sha = head.stdout.toString().trim();
      if (head.exit_code !== 0) continue;
      // Prints nothing when a branch or tag contains the commit.
      const unheld = await git(workspace.path, [
        'rev-list',
        '-n1',
        sha,
        '--not',
        '--branches',
        '--tags',
      ]);
      if (unheld.exit_code !== 0) continue;
      if (unheld.stdout.toString().trim()) {
        const archive = `refs/pantheon/archive/${workspace.id}`;
        if ((await git(workspace.path, ['update-ref', archive, sha])).exit_code !== 0) continue;
        const archived = await git(workspace.path, ['rev-parse', '--verify', archive]);
        if (archived.exit_code !== 0 || archived.stdout.toString().trim() !== sha) continue;
      }
      const jobId = ctx.store.transaction(() =>
        ctx.store.enqueue('workspace.remove', { workspace_id: workspace.id, reason: 'stale' }),
      );
      await removeWorkspace(ctx, workspace.id, jobId);
      if (!existsSync(workspace.path)) removed++;
    }
    for (const workspace of ctx.store.list<Workspace>('workspaces'))
      if (workspace.project_id === project_id) sizes.get(ctx)?.delete(workspace.id);
    return () => ({ removed });
  })();
}
