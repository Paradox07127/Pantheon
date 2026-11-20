import {
  id,
  requireThat,
  type AgentFields,
  type AgentProfile,
  type AgentRoutine,
  type AgentToolGroup,
  type Principal,
  type Project,
  type Session,
} from '@pantheon/domain';
import { inputSchemas } from '@pantheon/protocol';
import { runtime } from './admission.js';
import { callingResident } from './agent-always-on.js';
import { ROLE_PROMPTS } from './agent-prompts.js';
import {
  AGENT_TEMPLATES,
  BUILT_IN_TEMPLATES,
  residentProfile,
  type AgentTemplate,
} from './agent-templates.js';
import { projectAccess, userOnly, type ControlContext, type Preparers } from './context.js';

interface AgentListItem {
  id: string;
  name: string;
  template: AgentProfile['template'];
  role: string;
  tools: AgentToolGroup[];
  routines: AgentRoutine[];
  archived_at?: number;
}

/**
 * The project's agent profiles: creates the missing built-in ones and links the project's resident
 * sessions without a profile to the one of their kind. The caller owns the transaction.
 */
export function ensureAgents(ctx: ControlContext, projectId: string): AgentProfile[] {
  const existing = ctx.store
    .list<AgentProfile>('agents')
    .filter((agent) => agent.project_id === projectId);
  if (ctx.store.get<Project>('projects', projectId)?.kind === 'personal') return existing;
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

/**
 * An agent profile as agent.list returns it, with the built-in role prompt of its template and the
 * tools and listens it works with: its own, or its template's while it stores none.
 */
export type AgentListed = AgentProfile & {
  role_prompt: string;
  effective_tools: NonNullable<AgentProfile['tools']>;
  effective_listens: NonNullable<AgentProfile['listens']>;
};

export function agentList(ctx: ControlContext, p: Principal, projectId: string): AgentListed[] {
  userOnly(p);
  projectAccess(ctx, p, projectId, 'agent.list');
  return ctx.store
    .list<AgentProfile>('agents')
    .filter((agent) => agent.project_id === projectId)
    .map((agent) => {
      const { tools, listens } = residentProfile(ctx.store, {
        kind: agent.template,
        agent_id: agent.id,
      });
      return {
        ...agent,
        role_prompt: ROLE_PROMPTS[agent.template],
        effective_tools: tools,
        effective_listens: listens,
      };
    });
}

/** The defaults of a template agent.create starts a new agent from, with its built-in role prompt. */
export type AgentTemplateDefaults = Required<AgentTemplate> & {
  template: (typeof CREATED_TEMPLATES)[number];
  role_prompt: string;
};

const CREATED_TEMPLATES = ['ideas', 'goals', 'custom'] as const;

export function agentTemplates(p: Principal): AgentTemplateDefaults[] {
  userOnly(p);
  return CREATED_TEMPLATES.map((template) => ({
    template,
    routines: [],
    ...AGENT_TEMPLATES[template],
    role_prompt: ROLE_PROMPTS[template],
  }));
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
      fields.name !== undefined && fields.role !== undefined,
      'invalid_input',
      'Give the name and role of the new agent',
    );
    // A custom agent has no built-in role prompt.
    requireThat(
      template !== 'custom' || fields.instructions !== undefined,
      'invalid_input',
      'Give the instructions of the new custom agent',
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
  for (const routine of fields.routines) {
    requireThat(
      (routine.every_minutes === undefined) !== (routine.at === undefined),
      'invalid_input',
      'Give each routine exactly one of every_minutes or at',
    );
    const timeout = routine.precheck?.timeout_seconds;
    requireThat(
      !routine.precheck ||
        (routine.precheck.argv.length > 0 &&
          (timeout === undefined || (timeout >= 1 && timeout <= 300))),
      'invalid_input',
      'Give a precheck a command and a timeout of 1-300 seconds',
    );
  }
  const ids = fields.routines.flatMap((routine) => (routine.id === undefined ? [] : [routine.id]));
  requireThat(new Set(ids).size === ids.length, 'invalid_input', 'Give each routine its own id');
}

export const agentPreparers: Preparers = {
  'agent.agents': (ctx, p, c) => {
    const input = inputSchemas['agent.agents'].parse(c.input);
    callingResident(ctx, p, input.project_id, c.type);
    const agents = ctx.store
      .list<AgentProfile>('agents')
      .filter((agent) => agent.project_id === input.project_id)
      .map((agent): AgentListItem => ({
        id: agent.id,
        name: agent.name,
        template: agent.template,
        role: agent.role,
        tools: residentProfile(ctx.store, { kind: agent.template, agent_id: agent.id }).tools,
        routines: agent.routines,
        ...(agent.archived_at !== undefined && { archived_at: agent.archived_at }),
      }));
    return () => ({ agents });
  },
};
