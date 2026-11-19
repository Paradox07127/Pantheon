import type { Principal, Project } from '@pantheon/domain';
import type { ProjectSummary } from '@pantheon/protocol';
import { projectAccess, type ControlContext } from './context.js';
import { boardView, midnight } from './board-view.js';
import { needsYou } from './needs-you.js';
import { cursorId, projectBrief, type SeenCursor } from './project-brief.js';
import { sessionList } from './workbench-session.js';

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
      const counts = { running: 0, waiting: 0, ready: 0, failed: 0, queued: 0 };
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
      const board = boardView(ctx, principal, project.id, 14, undefined, sessions, needs);
      counts.queued = board.slots?.queued ?? 0;
      const open = board.milestones.find((m) => m.status !== 'completed');
      const milestoneStates = open?.tasks
        ? board.tasks.filter((task) => task.milestone_id === open.id).map((task) => task.status)
        : sessions
            .filter((session) => open?.session_ids.includes(session.id))
            .map((session) => (session.reconciling ? 'running' : COUNTED[session.state]));
      return {
        project_id: project.id,
        name: project.name,
        counts,
        merged_today: board.merges.filter((merge) => merge.merged_at >= midnight(board.now)).length,
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
        milestone: open
          ? {
              id: open.id,
              title: open.title,
              done: open.tasks?.done ?? open.merged,
              total: open.tasks?.total ?? open.session_ids.length,
              running: milestoneStates.filter((state) => state === 'running').length,
              failed: milestoneStates.filter((state) => state === 'failed').length,
            }
          : null,
        done_daily: board.task_progress.daily.map((d) => ({ date: d.day, done: d.done })),
        last_activity_at:
          sessions
            .map((s) => s.last_activity_at)
            .sort()
            .at(-1) ?? null,
      };
    }),
  };
}
