import {
  id,
  requireThat,
  type Project,
  type ProjectGoal,
  type ProjectGoalView,
} from '@pantheon/domain';
import { inputSchemas } from '@pantheon/protocol';
import { projectAccess, revision, type ControlContext, type Handlers } from './context.js';
import { userOnly } from './project-facts.js';

const MAX_ACTIVE_GOALS = 7;

/** The project's active goals, by order then creation. */
export function projectGoals(ctx: ControlContext, projectId: string): ProjectGoal[] {
  return ctx.store
    .list<ProjectGoal>('project_goals')
    .filter((goal) => goal.project_id === projectId && goal.archived_at === undefined)
    .sort((a, b) => a.order - b.order || a.created_at - b.created_at);
}

export function goalViews(ctx: ControlContext, projectId: string): ProjectGoalView[] {
  return projectGoals(ctx, projectId).map((goal) => ({ goal }));
}

export const projectGoalHandlers: Handlers = {
  'goal.set': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['goal.set'].parse(c.input);
    projectAccess(ctx, p, input.project_id, c.type);
    ctx.store.must<Project>('projects', input.project_id);
    if (input.goal_id) {
      const old = ctx.store.must<ProjectGoal>('project_goals', input.goal_id);
      requireThat(
        old.project_id === input.project_id,
        'invalid_input',
        `Goal ${old.id} belongs to another project`,
      );
      revision(ctx, c, old);
      const next = ctx.store.update('project_goals', { ...old, text: input.text }, old.revision);
      ctx.store.event('goal.revised', next, input.project_id, next, c.command_id);
      return next;
    }
    revision(ctx, c);
    const active = projectGoals(ctx, input.project_id);
    requireThat(
      active.length < MAX_ACTIVE_GOALS,
      'invalid_state',
      `A project has at most ${MAX_ACTIVE_GOALS} active goals; archive one first`,
    );
    const goal: ProjectGoal = {
      id: id(),
      revision: 1,
      project_id: input.project_id,
      text: input.text,
      order: Math.max(-1, ...active.map((g) => g.order)) + 1,
      created_at: ctx.store.now(),
    };
    ctx.store.insert('project_goals', goal);
    ctx.store.event('goal.created', goal, input.project_id, goal, c.command_id);
    return goal;
  },
  'goal.archive': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['goal.archive'].parse(c.input);
    const old = ctx.store.must<ProjectGoal>('project_goals', input.goal_id);
    projectAccess(ctx, p, old.project_id, c.type);
    revision(ctx, c, old);
    requireThat(
      old.archived_at === undefined,
      'invalid_state',
      `Goal ${old.id} is already archived`,
    );
    const next = ctx.store.update(
      'project_goals',
      { ...old, archived_at: ctx.store.now() },
      old.revision,
    );
    ctx.store.event('goal.archived', next, old.project_id, next, c.command_id);
    return next;
  },
  'goal.reorder': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['goal.reorder'].parse(c.input);
    projectAccess(ctx, p, input.project_id, c.type);
    revision(ctx, c);
    const active = projectGoals(ctx, input.project_id);
    const ids = new Set(input.goal_ids);
    requireThat(
      ids.size === input.goal_ids.length &&
        ids.size === active.length &&
        active.every((goal) => ids.has(goal.id)),
      'revision_conflict',
      'The goals changed; read them again',
    );
    const byId = new Map(active.map((goal) => [goal.id, goal]));
    return input.goal_ids.map((goalId, order) => {
      const old = byId.get(goalId)!;
      if (old.order === order) return old;
      const next = ctx.store.update('project_goals', { ...old, order }, old.revision);
      ctx.store.event('goal.reordered', next, input.project_id, next, c.command_id);
      return next;
    });
  },
};
