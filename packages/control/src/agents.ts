import {
  id,
  requireThat,
  type AgentFields,
  type AgentProfile,
  type Principal,
  type Session,
} from '@pantheon/domain';
import { runtime } from './admission.js';
import { AGENT_TEMPLATES, BUILT_IN_TEMPLATES } from './agent-templates.js';
import { projectAccess, userOnly, type ControlContext } from './context.js';

/**
 * The project's agent profiles: creates the missing built-in ones and links the project's resident
 * sessions without a profile to the one of their kind. The caller owns the transaction.
 */
export function ensureAgents(ctx: ControlContext, projectId: string): AgentProfile[] {
  const existing = ctx.store
    .list<AgentProfile>('agents')
    .filter((agent) => agent.project_id === projectId);
  const profiles = BUILT_IN_TEMPLATES.map((template) => {
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

const ROUTINE_LIMIT = 10;

/**
 * Refuses the fields agent.create would refuse for a new agent of the project, or agent.update for a
 * change of the agent.
 */
export function checkAgentFields(
  ctx: ControlContext,
  projectId: string,
  fields: Partial<AgentFields>,
  agent?: AgentProfile,
): void {
  const template = agent?.template ?? fields.template;
  requireThat(template, 'invalid_input', 'Give the template of the new agent');
  if (!agent) {
    requireThat(
      !(BUILT_IN_TEMPLATES as readonly string[]).includes(template),
      'invalid_input',
      `The project has its ${template} agent already`,
    );
    requireThat(
      fields.name !== undefined && fields.role !== undefined && fields.instructions !== undefined,
      'invalid_input',
      'Give the name, role and instructions of the new agent',
    );
  } else requireThat(fields.template === undefined, 'invalid_input', 'The template stays');
  if (fields.name !== undefined)
    requireThat(
      !ctx.store
        .list<AgentProfile>('agents')
        .some(
          (other) =>
            other.project_id === projectId &&
            other.id !== agent?.id &&
            !other.archived_at &&
            other.name === fields.name,
        ),
      'invalid_input',
      `Another agent of the project is named ${fields.name}`,
    );
  requireThat(
    template === 'assistant' || !fields.tools?.includes('agents'),
    'invalid_input',
    'Only the assistant has the agents tools',
  );
  if (fields.runtime !== undefined) runtime(ctx, fields.runtime, 'reviewer');
  if (!fields.routines) return;
  requireThat(
    fields.routines.length <= ROUTINE_LIMIT,
    'invalid_input',
    `An agent has at most ${ROUTINE_LIMIT} routines`,
  );
  for (const routine of fields.routines)
    requireThat(
      (routine.every_minutes === undefined) !== (routine.at === undefined),
      'invalid_input',
      'Give each routine exactly one of every_minutes or at',
    );
  const ids = fields.routines.flatMap((routine) => (routine.id === undefined ? [] : [routine.id]));
  requireThat(new Set(ids).size === ids.length, 'invalid_input', 'Give each routine its own id');
}
