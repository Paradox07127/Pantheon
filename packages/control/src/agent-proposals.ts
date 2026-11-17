import {
  id,
  requireThat,
  type AgentFields,
  type AgentProfile,
  type AgentProposal,
  type AgentRoutine,
  type AgentToolGroup,
  type Principal,
  type Session,
} from '@pantheon/domain';
import { inputSchemas } from '@pantheon/protocol';
import { callingResident, wakeAgent } from './agent-always-on.js';
import { residentProfile } from './agent-templates.js';
import { checkAgentFields } from './agents.js';
import {
  projectAccess,
  userOnly,
  type ControlContext,
  type Handlers,
  type Preparers,
} from './context.js';
import { createAgent, updateAgent } from './resident.js';

export interface AgentListItem {
  id: string;
  name: string;
  template: AgentProfile['template'];
  role: string;
  tools: AgentToolGroup[];
  routines: AgentRoutine[];
  archived_at?: number;
}

/** The text the proposing agent reads once the user decided on its proposal. */
function decisionText(proposal: AgentProposal, name: string): string {
  if (proposal.state === 'declined')
    return `The user declined your proposal ${proposal.id} for the agent ${name}.`;
  return proposal.state === 'created'
    ? `The user approved your proposal ${proposal.id}: the agent ${name} was created.`
    : `The user approved your proposal ${proposal.id}: the agent ${name} was changed.`;
}

export function agentProposal(
  ctx: ControlContext,
  p: Principal,
  proposalId: string,
): AgentProposal {
  userOnly(p);
  const proposal = ctx.store.must<AgentProposal>('agent_proposals', proposalId);
  projectAccess(ctx, p, proposal.project_id, 'agent.proposal');
  return proposal;
}

export const agentProposalHandlers: Handlers = {
  'agent.propose': (ctx, p, c) => {
    const { project_id, agent_id, ...fields } = inputSchemas['agent.propose'].parse(c.input);
    const { session } = callingResident(ctx, p, project_id, c.type);
    const target =
      agent_id === undefined ? undefined : ctx.store.must<AgentProfile>('agents', agent_id);
    requireThat(
      !target || target.project_id === session.project_id,
      'permission_denied',
      'Agent of another project',
    );
    requireThat(
      !target || Object.keys(fields).length > 0,
      'invalid_input',
      'Give the fields that change',
    );
    checkAgentFields(ctx, session.project_id, fields, target);
    const proposal = ctx.store.insert<AgentProposal>('agent_proposals', {
      id: id(),
      revision: 1,
      project_id: session.project_id,
      session_id: session.id,
      ...(target && { agent_id: target.id }),
      fields,
      state: 'pending',
      at: ctx.store.now(),
    });
    ctx.store.event(
      'agent_proposal.created',
      proposal,
      proposal.project_id,
      proposal,
      c.command_id,
    );
    return proposal;
  },
  'agent.proposal.resolve': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['agent.proposal.resolve'].parse(c.input);
    const proposal = ctx.store.must<AgentProposal>('agent_proposals', input.proposal_id);
    projectAccess(ctx, p, proposal.project_id, c.type);
    requireThat(proposal.state === 'pending', 'invalid_state', 'The proposal is decided already');
    const fields = { ...proposal.fields, ...input.fields };
    const agent =
      input.decision === 'decline'
        ? undefined
        : proposal.agent_id
          ? updateAgent(
              ctx,
              ctx.store.must<AgentProfile>('agents', proposal.agent_id),
              fields,
              c.command_id,
            )
          : createAgent(
              ctx,
              proposal.project_id,
              fields as AgentFields,
              { kind: 'agent', session_id: proposal.session_id },
              c.command_id,
            );
    const next = ctx.store.update<AgentProposal>(
      'agent_proposals',
      {
        ...proposal,
        state: !agent ? 'declined' : proposal.agent_id ? 'changed' : 'created',
        ...(agent && { result_agent_id: agent.id }),
        ...(input.fields && { edited_fields: input.fields }),
        resolved_at: ctx.store.now(),
      },
      proposal.revision,
    );
    ctx.store.event(
      'agent_proposal.resolved',
      next,
      next.project_id,
      { decision: input.decision, state: next.state, result_agent_id: next.result_agent_id },
      c.command_id,
    );
    const proposer = ctx.store.must<Session>('sessions', proposal.session_id);
    wakeAgent(
      ctx,
      ctx.store.must<AgentProfile>('agents', proposer.resident!.agent_id!),
      'agent_proposal',
      decisionText(next, agent?.name ?? fields.name ?? ''),
      c.command_id,
    );
    return next;
  },
};

export const agentProposalPreparers: Preparers = {
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
