import {
  id,
  requireThat,
  type AgentProfile,
  type CharterPower,
  type Project,
  type Session,
  type SettingProposal,
  type WorkflowPolicy,
} from '@pantheon/domain';
import { inputSchemas, settingValues } from '@pantheon/protocol';
import { callingResident, wakeAgent } from './agent-always-on.js';
import { projectAccess, userOnly, type Handlers } from './context.js';
import { projectHandlers } from './project.js';
import { sourceProblem } from './project-board.js';
import { externalEvents } from './user-config.js';
import { workflowPolicy, workflowPolicyHandlers } from './workflow-policy.js';

/** The charter power a charter.<power> setting names, or undefined for another setting. */
const charterPower = (param: SettingProposal['param']) =>
  param.startsWith('charter.') ? (param.slice('charter.'.length) as CharterPower) : undefined;

export const settingProposalHandlers: Handlers = {
  'setting.propose': (ctx, p, c) => {
    const { project_id, param, value, quote } = inputSchemas['setting.propose'].parse(c.input);
    const { session, profile } = callingResident(ctx, p, project_id, c.type);
    requireThat(
      profile.template === 'assistant',
      'permission_denied',
      "Only the project's Assistant proposes setting changes",
    );
    const checked = settingValues[param].safeParse(value);
    requireThat(
      checked.success,
      'invalid_input',
      `${value} is not a value of ${param}; see the param description for its values`,
    );
    const unquoted = sourceProblem(ctx, {
      project_id: session.project_id,
      tasks: [{ id: 'setting', source: [quote] }],
    } as unknown as Parameters<typeof sourceProblem>[1]);
    requireThat(
      !unquoted,
      'invalid_input',
      `No message of the user contains "${quote}"; quote the words of the user that ask for the change exactly`,
    );
    const policy = workflowPolicy(ctx, session.project_id),
      power = charterPower(param);
    const current =
      param === 'external_events'
        ? externalEvents(ctx, ctx.store.must<Project>('projects', session.project_id))
        : power
          ? policy.charter![power]!
          : policy[
              param as 'plan_changes' | 'max_parallel' | 'dispatch_paused' | 'acceptance_wake'
            ]!;
    const proposal = ctx.store.insert<SettingProposal>('setting_proposals', {
      id: id(),
      revision: 1,
      project_id: session.project_id,
      session_id: session.id,
      param,
      current,
      value,
      quote,
      state: 'pending',
      at: ctx.store.now(),
    });
    ctx.store.event(
      'setting_proposal.created',
      proposal,
      proposal.project_id,
      proposal,
      c.command_id,
    );
    return proposal;
  },
  'setting.proposal.resolve': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['setting.proposal.resolve'].parse(c.input);
    const proposal = ctx.store.must<SettingProposal>('setting_proposals', input.proposal_id);
    projectAccess(ctx, p, proposal.project_id, c.type);
    requireThat(proposal.state === 'pending', 'invalid_state', 'The proposal is decided already');
    let policyVersion: number | undefined;
    if (input.decision === 'approve' && proposal.param === 'external_events') {
      const project = ctx.store.must<Project>('projects', proposal.project_id);
      projectHandlers['project.externalEvents.set']!(ctx, p, {
        ...c,
        type: 'project.externalEvents.set',
        expected_revision: project.revision,
        input: { project_id: project.id, mode: proposal.value },
      });
    } else if (input.decision === 'approve') {
      const power = charterPower(proposal.param);
      const stored = ctx.store.get<WorkflowPolicy>('workflow_policies', proposal.project_id);
      const policy = workflowPolicyHandlers['workflow.policy.set']!(ctx, p, {
        ...c,
        type: 'workflow.policy.set',
        expected_revision: stored?.revision ?? null,
        input: {
          project_id: proposal.project_id,
          ...(power
            ? { charter: { [power]: proposal.value } }
            : { [proposal.param]: proposal.value }),
        },
      }) as WorkflowPolicy;
      policyVersion = policy.policy_version;
    }
    const next = ctx.store.update<SettingProposal>(
      'setting_proposals',
      {
        ...proposal,
        state: input.decision === 'approve' ? 'applied' : 'declined',
        ...(policyVersion !== undefined && { policy_version: policyVersion }),
        resolved_at: ctx.store.now(),
      },
      proposal.revision,
    );
    ctx.store.event(
      'setting_proposal.resolved',
      next,
      next.project_id,
      { decision: input.decision, state: next.state, policy_version: next.policy_version },
      c.command_id,
    );
    const proposer = ctx.store.must<Session>('sessions', proposal.session_id);
    wakeAgent(
      ctx,
      ctx.store.must<AgentProfile>('agents', proposer.resident!.agent_id!),
      'setting_proposal',
      next.state === 'applied'
        ? `The user approved your proposal ${next.id}: ${next.param} is now ${next.value}.`
        : `The user declined your proposal ${next.id} to set ${next.param} to ${next.value}; it stays ${next.current}.`,
      c.command_id,
    );
    return next;
  },
};
