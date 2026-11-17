import { id, type AgentProfile, type Principal, type Session } from '@pantheon/domain';
import { AGENT_TEMPLATES } from './agent-templates.js';
import { projectAccess, userOnly, type ControlContext } from './context.js';

/**
 * The project's agent profiles: creates the missing built-in ones and links the project's resident
 * sessions without a profile to the one of their kind. The caller owns the transaction.
 */
export function ensureAgents(ctx: ControlContext, projectId: string): AgentProfile[] {
  const existing = ctx.store
    .list<AgentProfile>('agents')
    .filter((agent) => agent.project_id === projectId);
  const profiles = (Object.keys(AGENT_TEMPLATES) as AgentProfile['template'][]).map((template) => {
    const found = existing.find((agent) => agent.template === template);
    if (found) return found;
    const defaults = AGENT_TEMPLATES[template];
    // No event: opening a project adds none, and kinds under agent. are runtime events.
    return ctx.store.insert<AgentProfile>('agents', {
      id: id(),
      revision: 1,
      project_id: projectId,
      template,
      name: defaults.name,
      role: defaults.role,
      instructions: defaults.instructions,
      routines: [],
      created_by: { kind: 'user' },
      created_at: ctx.store.now(),
    });
  });
  for (const session of ctx.store.list<Session>('sessions'))
    if (session.project_id === projectId && session.resident && !session.resident.agent_id) {
      const profile = profiles.find((agent) => agent.template === session.resident!.kind)!;
      ctx.store.update<Session>(
        'sessions',
        { ...session, resident: { ...session.resident, agent_id: profile.id } },
        session.revision,
      );
    }
  return profiles;
}

export function agentList(ctx: ControlContext, p: Principal, projectId: string): AgentProfile[] {
  userOnly(p);
  projectAccess(ctx, p, projectId, 'agent.list');
  return ctx.store.list<AgentProfile>('agents').filter((agent) => agent.project_id === projectId);
}
