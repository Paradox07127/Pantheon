import {
  requireThat,
  type Principal,
  type Project,
  type Session,
  type SessionTurn,
} from '@pantheon/domain';
import { inputSchemas } from '@pantheon/protocol';
import { gitFolder, projectAccess, type ControlContext } from './context.js';
import { sessionDefaults } from './user-config.js';
import { openWorktreeSession } from './workbench-session.js';

/** Opens a lead session with the project's session defaults; undefined when the project has no git root. */
export function startLead(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
  title: string,
  input: string,
  cause: string,
  origin: 'sync' | 'baseline' | 'external',
): Session | undefined {
  const project = ctx.store.must<Project>('projects', projectId);
  if (!gitFolder(project.roots[0]!)) return;
  const defaults = sessionDefaults(ctx, project);
  const runtime =
    defaults?.runtime ??
    [...ctx.adapters].find(
      ([, adapter]) => adapter.report.capabilities.write_isolation?.status === 'supported',
    )?.[0];
  requireThat(runtime, 'unsupported_capability', 'No runtime can work in a worktree');
  requireThat(p.role === 'user', 'permission_denied', 'Only user can create a session');
  projectAccess(ctx, p, projectId, 'session.create');
  // The worktree folder is named after the title; the first message is an instruction.
  const session = openWorktreeSession(
    ctx,
    inputSchemas['session.create'].parse({
      project_id: projectId,
      runtime,
      permission_mode: defaults?.permission_mode ?? 'ask',
      ...(defaults?.model !== undefined && { model: defaults.model }),
      ...(defaults?.effort !== undefined && { effort: defaults.effort }),
      input,
    }),
    cause,
    undefined,
    p,
    title,
  );
  // The first message is an instruction to the model, not a title for the user.
  for (const turn of ctx.store.list<SessionTurn>('session_turns'))
    if (turn.session_id === session.id)
      ctx.store.update('session_turns', { ...turn, origin }, turn.revision);
  const next = ctx.store.update('sessions', { ...session, title }, session.revision);
  ctx.store.event('session.renamed', next, next.project_id, { title }, cause);
  return next;
}
