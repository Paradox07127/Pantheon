import { memoryContext } from './memory.js';
import {
  id,
  requireThat,
  type Project,
  type ProjectBrief,
  type ProjectRead,
  type Principal,
  type Session,
} from '@pantheon/domain';
import { inputSchemas } from '@pantheon/protocol';
import { projectAccess, revision, type ControlContext, type Handlers } from './context.js';

export function userOnly(principal: Principal): void {
  requireThat(
    principal.role === 'user',
    'permission_denied',
    'Changing project commitments requires user authority',
  );
}
export function history(
  ctx: ControlContext,
  kind: 'brief',
  value: { id: string; revision: number; project_id: string },
  actor: string,
): void {
  ctx.store.insert('project_fact_versions', {
    id: id(),
    revision: 1,
    project_id: value.project_id,
    kind,
    target_id: value.id,
    target_revision: value.revision,
    actor,
    created_at: ctx.store.now(),
    value,
  });
}
/** Facts only: this projection never schedules work or mutates acceptance. */
export function projectRead(
  ctx: ControlContext,
  principal: Principal,
  projectId: string,
): ProjectRead {
  projectAccess(ctx, principal, projectId, 'project.read');
  const session = principal.session_id
    ? ctx.store.get<Session>('sessions', principal.session_id)
    : undefined;
  return {
    ...projectFacts(ctx, projectId),
    memory: memoryContext(ctx, projectId, session, 12000, !!session),
    ...(session ? { you: { session_id: session.id, role: principal.role } } : {}),
  };
}
/** Internal evidence projection; no authority changes and no dispatch side effects. */
export function projectFacts(ctx: ControlContext, projectId: string): ProjectRead {
  const project = ctx.store.must<Project>('projects', projectId);
  return {
    project,
    brief: ctx.store.get<ProjectBrief>('project_briefs', projectId),
    cursor: ctx.store.cursor(),
  };
}

export const projectFactHandlers: Handlers = {
  'project.read': (ctx, p, c) => {
    revision(ctx, c);
    return projectRead(ctx, p, inputSchemas['project.read'].parse(c.input).project_id);
  },
  'project.brief.set': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['project.brief.set'].parse(c.input);
    projectAccess(ctx, p, input.project_id, c.type);
    ctx.store.must<Project>('projects', input.project_id);
    const old = ctx.store.get<ProjectBrief>('project_briefs', input.project_id);
    revision(ctx, c, old);
    const value: ProjectBrief = {
      ...input,
      id: input.project_id,
      revision: old?.revision ?? 1,
      created_at: old?.created_at ?? ctx.store.now(),
      updated_by: p.id,
    };
    const next = old
      ? ctx.store.update('project_briefs', value, old.revision)
      : ctx.store.insert('project_briefs', value);
    history(ctx, 'brief', next, p.id);
    ctx.store.event('project.brief_updated', next, input.project_id, next, c.command_id);
    return next;
  },
};
