import {
  id,
  requireThat,
  type AgentProfile,
  type PersonalKey,
  type Project,
} from '@pantheon/domain';
import { scheduleRoutine } from './agent-always-on.js';
import { AGENT_TEMPLATES } from './agent-templates.js';
import type { ControlContext } from './context.js';
import { openOf } from './resident.js';
import { releaseIdleConversation } from './session.js';
import { afterCommit } from './workbench-session.js';

/** Issues and records a new built-in key; the caller owns the transaction. */
function builtInKey(ctx: ControlContext, cause: string): string {
  requireThat(ctx.issuePersonalKey, 'daemon_unavailable', 'Personal keys are issued by the daemon');
  const keyId = id(),
    issued = ctx.issuePersonalKey(keyId);
  // The token file and its principal live outside the transaction.
  ctx.rollback?.push(() => ctx.discardPersonalKey?.(keyId));
  const key = ctx.store.insert<PersonalKey>('personal_keys', {
    id: keyId,
    revision: 1,
    label: 'Built-in personal agent',
    digest: issued.digest,
    created_at: ctx.store.now(),
  });
  ctx.store.event('personal_key.created', key, '', { label: key.label }, cause);
  return keyId;
}

/**
 * The personal agent's home project and profile, created with its own personal key on first use.
 * Called when the user opens the agent, it replaces a revoked built-in key with a new one.
 * The caller owns the transaction.
 */
export function personalHome(
  ctx: ControlContext,
  cause: string,
): { project: Project; profile: AgentProfile } {
  let project = ctx.store.list<Project>('projects').find((each) => each.kind === 'personal');
  if (!project) {
    project = ctx.store.insert<Project>('projects', {
      id: id(),
      revision: 1,
      name: 'Personal',
      roots: [],
      kind: 'personal',
    });
    ctx.store.event('project.opened', project, project.id, project, cause);
  }
  const homeId = project.id;
  const found = ctx.store
    .list<AgentProfile>('agents')
    .find((agent) => agent.project_id === homeId && agent.template === 'personal');
  if (found && !ctx.store.get<PersonalKey>('personal_keys', found.personal_key_id!)?.revoked_at)
    return { project, profile: found };
  const keyId = builtInKey(ctx, cause);
  if (found) {
    const next = ctx.store.update<AgentProfile>(
      'agents',
      { ...found, personal_key_id: keyId },
      found.revision,
    );
    ctx.store.event('agent_profile.updated', next, homeId, { personal_key_id: keyId }, cause);
    const open = openOf(ctx, next);
    if (open) {
      // An idle process holds the revoked key's file; the next input resumes it on the new one.
      const committed = afterCommit(ctx);
      const completion = Promise.resolve()
        .then(() => {
          if (committed()) releaseIdleConversation(ctx, open);
        })
        .finally(() => ctx.completions.delete(completion));
      ctx.completions.add(completion);
    }
    return { project, profile: next };
  }
  const defaults = AGENT_TEMPLATES.personal;
  const profile = ctx.store.insert<AgentProfile>('agents', {
    id: id(),
    revision: 1,
    project_id: homeId,
    template: 'personal',
    name: defaults.name,
    role: defaults.role,
    routines: defaults.routines ?? [],
    personal_key_id: keyId,
    created_by: { kind: 'user' },
    created_at: ctx.store.now(),
  });
  ctx.store.event('agent_profile.created', profile, homeId, profile, cause);
  for (const routine of profile.routines) scheduleRoutine(ctx, profile, routine);
  return { project, profile };
}
