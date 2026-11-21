import type { Principal, Project } from '@pantheon/domain';
import type { ProjectSummary } from '@pantheon/protocol';
import { projectAccess, type ControlContext } from './context.js';
import { needsYou } from './needs-you.js';
import { cursorId, projectBrief, type SeenCursor } from './project-brief.js';
import { sessionList } from './workbench-session.js';

/** Local midnight `days` days after the day of `at`. */
export const midnight = (at: number, days = 0) => {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d.getTime();
};

const COUNTED: Record<string, keyof ProjectSummary['counts']> = {
  starting: 'running',
  running: 'running',
  merging: 'running',
  waiting: 'waiting',
  ready: 'ready',
  failed: 'failed',
};

/** The projects of the all-projects grid; a planner principal sees only its own project. */
export const summaryProjects = (ctx: ControlContext, principal: Principal) =>
  ctx.store
    .list<Project>('projects')
    .filter(
      (project) =>
        project.removed_at === undefined &&
        project.kind !== 'personal' &&
        (principal.role === 'user' ||
          principal.role === 'personal' ||
          project.id === principal.project_id),
    );

/** The all-projects grid's numbers. */
export function projectsSummary(
  ctx: ControlContext,
  principal: Principal,
  readChanges: true | 'cached' = true,
): { projects: ProjectSummary[] } {
  const projects = summaryProjects(ctx, principal);
  const items = needsYou(ctx, principal).items;
  // A session principal reads through its project_read tool, any other under this query's name.
  const action = principal.session_id ? 'project.read' : 'projects.summary';
  return {
    projects: projects.map((project) => {
      projectAccess(ctx, principal, project.id, action);
      const sessions = sessionList(ctx, principal, project.id, readChanges, action);
      const counts = { running: 0, waiting: 0, ready: 0, failed: 0 };
      for (const session of sessions) {
        if (session.archived_at) continue;
        const key = session.reconciling ? 'running' : COUNTED[session.state];
        if (key) counts[key]++;
      }
      const needs = items.filter((item) => item.project_id === project.id);
      // Only a cursor with prose can give a brief; the brief checks the prose still fits its items.
      const brief =
        ctx.store.get<SeenCursor>('seen_cursors', cursorId(principal, project.id))?.prose &&
        projectBrief(ctx, principal, project.id, undefined, needs).prose?.sentences[0]?.text;
      return {
        project_id: project.id,
        name: project.name,
        counts,
        merged_today: ctx.store.kindEventsSince(
          project.id,
          ['session.merged'],
          midnight(ctx.store.now()),
        ).length,
        needs_you: needs.length,
        ...(brief ? { brief } : {}),
        ...(needs.length
          ? {
              waiting: {
                by_decision: needs.reduce<NonNullable<ProjectSummary['waiting']>['by_decision']>(
                  (by, item) => ({ ...by, [item.decision]: (by[item.decision] ?? 0) + 1 }),
                  {},
                ),
                longest_wait_ms:
                  ctx.store.now() - Math.min(...needs.map((item) => item.created_at)),
                blocked_tasks: needs.reduce((sum, item) => sum + item.blocks, 0),
              },
            }
          : {}),
        last_activity_at:
          sessions
            .map((s) => s.last_activity_at)
            .sort()
            .at(-1) ?? null,
      };
    }),
  };
}
