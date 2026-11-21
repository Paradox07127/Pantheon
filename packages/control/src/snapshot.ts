import { requireThat, type Principal, type Entity } from '@pantheon/domain';
import { projectAccess, type ControlContext } from './context.js';

/** The check snapshot() makes before reading, without reading. */
export function snapshotAccess(
  ctx: ControlContext,
  principal: Principal,
  projectId?: string,
): void {
  if (principal.role !== 'user') {
    requireThat(projectId, 'permission_denied', 'Project scope required');
    projectAccess(ctx, principal, projectId, 'project.read');
  }
}

export function snapshot(ctx: ControlContext, principal: Principal, projectId?: string): unknown {
  snapshotAccess(ctx, principal, projectId);
  const result: Record<string, unknown> = { cursor: ctx.store.cursor() };
  for (const table of [
    'projects',
    'project_briefs',
    'sessions',
    'session_turns',
    'workspaces',
    'reviews',
  ] as const)
    result[table] = ctx.store
      .list<Entity & { project_id?: string }>(table)
      .filter(
        (e) =>
          !projectId || (table === 'projects' ? e.id === projectId : e.project_id === projectId),
      );
  return result;
}
