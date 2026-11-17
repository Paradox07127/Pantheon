import { lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync, type Stats } from 'node:fs';
import path from 'node:path';
import { id, requireThat, type Project, type Workspace, type Principal } from '@pantheon/domain';
import {
  inside,
  managedRootOf,
  projectFolder,
  readableFolderName,
  resolvedPath,
  projectAccess,
  checkedPath,
  insert,
  type ControlContext,
} from './context.js';
import { runGit } from './git.js';
import { assertManagedLocation, protectionListWithoutWorkspace } from './protection.js';
import { workspaceReady } from './provisioning.js';

export function assertWorkspaceAvailable(workspace: Workspace): void {
  requireThat(
    workspace.removed_at === undefined,
    'invalid_workspace',
    'Workspace was removed; register a new workspace',
  );
}

export type WorkspaceRegistration = {
  project_id: string;
  kind: 'linked_worktree';
  source: string;
  base_ref: string;
  /** The session title or task name the worktree folder is named after. */
  name?: string;
  /** The id, when a ref named after it was written before the workspace is registered. */
  id?: string;
};

/** The caller owns the transaction, has checked project access and read gitFolderAsync of the source. */
export function registerWorkspace(
  ctx: ControlContext,
  input: WorkspaceRegistration,
  cause: string,
  sourceGit: boolean,
): Workspace {
  const project = ctx.store.must<Project>('projects', input.project_id),
    workspaceId = input.id ?? id();
  const source = checkedPath(ctx, project, input.source);
  requireThat(
    project.roots.includes(source) && sourceGit,
    'scope_violation',
    'A worktree source must be a project folder that is itself a git checkout',
  );
  // A linked worktree, submodule or separate Git directory keeps its metadata elsewhere, which
  // the sandbox and the worktree reads cannot name.
  const metadata = path.join(source, '.git');
  requireThat(
    lstatSync(metadata, { throwIfNoEntry: false })?.isDirectory(),
    'source_metadata_unsupported',
    `The source folder's .git is not a directory: ${metadata}`,
  );
  requireThat(
    ctx.workspaceRoot !== undefined,
    'invalid_workspace',
    'A managed workspace root is required for linked worktrees',
  );
  const workspacePath = resolvedPath(
    path.join(projectFolder(ctx, project.id), readableFolderName(input.name, workspaceId)),
  );
  assertManagedLocation(workspacePath);
  requireThat(
    inside(ctx.workspaceRoot, workspacePath),
    'scope_violation',
    'Worktree path outside managed workspace root',
  );
  for (const w of ctx.store.list<Workspace>('workspaces'))
    if (w.kind !== 'in_place')
      requireThat(
        !inside(w.path, workspacePath) && !inside(workspacePath, w.path),
        'resource_busy',
        'Overlapping workspaces are not independently writable',
      );
  const w: Workspace = {
    project_id: project.id,
    kind: input.kind,
    path: workspacePath,
    id: workspaceId,
    revision: 1,
    owner: 'none',
    ownership_epoch: 0,
  };
  mkdirSync(path.dirname(workspacePath), { recursive: true, mode: 0o700 });
  // Reserve synchronously; `git worktree add` runs only after this metadata commits.
  mkdirSync(workspacePath, { mode: 0o700 });
  const reservation = lstatSync(workspacePath);
  // Rollback removes only our still-empty reservation, never recursively removes new files.
  ctx.rollback?.push(() => {
    try {
      const current = lstatSync(workspacePath);
      if (current.dev === reservation.dev && current.ino === reservation.ino)
        rmdirSync(workspacePath);
    } catch {
      /* Preserve anything that arrived in the reserved directory. */
    }
  });
  w.source = source;
  w.provisioning = {
    state: 'queued',
    base_ref: input.base_ref,
    directory_identity: { dev: reservation.dev, ino: reservation.ino },
  };
  ctx.store.enqueue('workspace.provision', { workspace_id: w.id });
  return insert(ctx, 'workspaces', w, 'workspace.registered', project.id, cause);
}

/**
 * The one row for a folder of the user's own checkout, shared by every session adopted there and
 * never marked removed, since the path index covers removed rows too. Creates and provisions nothing.
 * The caller owns the transaction and has checked project access.
 */
export function registerInPlaceWorkspace(
  ctx: ControlContext,
  input: { project_id: string; cwd: string },
  cause: string,
): Workspace {
  const project = ctx.store.must<Project>('projects', input.project_id);
  const folder = checkedPath(ctx, project, input.cwd);
  const existing = ctx.store.list<Workspace>('workspaces').find((w) => w.path === folder);
  const source = project.roots.find((root) => inside(root, folder))!;
  // The row of a removed project's folder moves to the project that holds the folder now.
  if (
    existing?.kind === 'in_place' &&
    existing.project_id !== project.id &&
    ctx.store.get<Project>('projects', existing.project_id)?.removed_at !== undefined
  ) {
    const moved = ctx.store.update<Workspace>(
      'workspaces',
      { ...existing, project_id: project.id, source },
      existing.revision,
    );
    ctx.store.event('workspace.registered', moved, project.id, moved, cause);
    return moved;
  }
  if (existing) {
    requireThat(
      existing.kind === 'in_place' && existing.project_id === project.id,
      'resource_busy',
      'The folder is registered as another workspace',
    );
    return existing;
  }
  return insert<Workspace>(
    ctx,
    'workspaces',
    {
      project_id: project.id,
      kind: 'in_place',
      path: folder,
      source,
      id: id(),
      revision: 1,
      owner: 'none',
      ownership_epoch: 0,
    },
    'workspace.registered',
    project.id,
    cause,
  );
}

/** The caller owns the transaction and has checked that the workspace is provisioning. */
export function cancelProvisioning(
  ctx: ControlContext,
  workspace: Workspace,
  cause: string,
): Workspace {
  const next = ctx.store.update(
    'workspaces',
    {
      ...workspace,
      provisioning: { ...workspace.provisioning!, cancel_requested: true },
    },
    workspace.revision,
  );
  ctx.store.enqueue('workspace.provision', { workspace_id: workspace.id });
  ctx.store.event('workspace.provisioning_cancel_requested', next, next.project_id, {}, cause);
  return next;
}

/**
 * Authorizes a read of a registered workspace and returns a Git runner that re-authorizes before
 * each spawn; git is undefined while the workspace is not ready or has no local Git metadata.
 */
export function workspaceReadAccess(
  ctx: ControlContext,
  principal: Principal,
  workspace: Workspace,
) {
  const authorize = () => {
    projectAccess(ctx, principal, workspace.project_id, 'workspace.read');
    assertWorkspaceAvailable(workspace);
    const project = ctx.store.must<Project>('projects', workspace.project_id);
    checkedPath(ctx, project, workspace.source!);
    if (principal.role !== 'user')
      requireThat(
        !(principal.session_id && ['writer', 'reviewer'].includes(principal.role)),
        'permission_denied',
        'Session does not own this workspace',
      );
    requireThat(
      realpathSync(workspace.path) === workspace.path,
      'scope_violation',
      'Workspace path changed',
    );
    requireThat(
      managedRootOf(ctx, workspace.path),
      'scope_violation',
      'Worktree path is outside managed root',
    );
    if (ctx.protectionPaths) {
      const protectedEntries = protectionListWithoutWorkspace({
        ...ctx.protectionPaths,
        otherWorkspaces: [],
      });
      requireThat(
        !protectedEntries.some(
          (entry) =>
            entry.deny === 'read_write' &&
            (inside(entry.path, workspace.path) || inside(workspace.path, entry.path)),
        ),
        'scope_violation',
        'Workspace intersects protected data',
      );
    }
  };
  authorize();
  if (!workspaceReady(workspace)) return { authorize, git: undefined };
  // Linked/symlinked metadata may point outside the authorized workspace. Do not follow it.
  const gitPath = path.join(workspace.path, '.git');
  let metadata: Stats;
  try {
    metadata = lstatSync(gitPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { authorize, git: undefined };
    throw error;
  }
  // A worktree's pointer file may name only its own metadata folder in the source repository.
  const worktreeMetadata = path.join(
    realpathSync(workspace.source!),
    '.git/worktrees',
    path.basename(workspace.path),
  );
  const pointsToOwnMetadata = (stat: Stats) => {
    if (!stat.isFile()) return false;
    try {
      return (
        readFileSync(gitPath, 'utf8').trimEnd() === `gitdir: ${worktreeMetadata}` &&
        lstatSync(worktreeMetadata).isDirectory() &&
        realpathSync(worktreeMetadata) === worktreeMetadata
      );
    } catch {
      return false;
    }
  };
  requireThat(
    pointsToOwnMetadata(metadata),
    'scope_violation',
    'Workspace Git metadata is not local',
  );
  const git = (
    args: string[],
    bound: { max_buffer: number; timeout_ms: number; env?: NodeJS.ProcessEnv },
  ) =>
    runGit(workspace.path, args, undefined, true, {
      ...bound,
      work_tree: workspace.path,
      before_spawn: () => {
        authorize();
        const currentMetadata = lstatSync(gitPath);
        requireThat(
          pointsToOwnMetadata(currentMetadata) &&
            currentMetadata.dev === metadata.dev &&
            currentMetadata.ino === metadata.ino,
          'scope_violation',
          'Workspace Git metadata changed',
        );
      },
    });
  return { authorize, git };
}
