import type {
  AgentProfile,
  AgentProposal,
  BoardPlan,
  Improvement,
  Project,
  StepRun,
  StoredWorkflowDefinition,
} from '@pantheon/domain';
import { projectAccess, type ControlContext } from './context.js';
import { taskGeneration } from './board-plan.js';
import { projectBudgetUse, workflowPolicy } from './workflow-policy.js';
import { NEXT_STEP, action, type NeedsYouDraft, type NeedsYouScope } from './needs-you.js';

/** Workflow approval steps waiting for a decision. */
export function stepRunItems(
  ctx: ControlContext,
  scope: NeedsYouScope,
  planOf: Map<string, BoardPlan>,
): NeedsYouDraft[] {
  const { principal, projectId, removed } = scope;
  const items: NeedsYouDraft[] = [];
  for (const run of ctx.store.list<StepRun>('workflow_step_runs')) {
    if (
      run.state !== 'waiting' ||
      run.step.kind.type !== 'approval' ||
      removed.has(run.project_id) ||
      (projectId && run.project_id !== projectId)
    )
      continue;
    const plan = planOf.get(run.lead_session_id),
      task = plan?.tasks.find((t) => t.id === run.task_id);
    if (!task || taskGeneration(plan, run.task_id) !== run.generation) continue;
    items.push({
      source: { table: 'workflow_step_runs', id: run.id, revision: run.revision },
      kind: 'workflow.approval',
      project_id: run.project_id,
      session_id: run.session_id ?? run.lead_session_id,
      task_id: `${run.lead_session_id}:${run.task_id}`,
      task_title: task.title,
      step_title: run.step.title,
      status: 'waiting',
      created_at: run.created_at,
      reason: 'workflow_approval',
      decision: 'other',
      primary: 'workflow.step.decide',
      actions: (['approve', 'reject'] as const).map((decision) => ({
        ...action('workflow.step.decide', () =>
          projectAccess(ctx, principal, run.project_id, 'workflow.step.decide'),
        ),
        decision,
      })),
      next_step: `Approve or reject “${run.step.title}” for “${task.title}”.`,
    });
  }
  return items;
}

/** Workflow definition trials that ran all their tasks. */
export function definitionTrialItems(ctx: ControlContext, scope: NeedsYouScope): NeedsYouDraft[] {
  const { principal, projectId, removed } = scope;
  const items: NeedsYouDraft[] = [];
  for (const row of ctx.store.list<StoredWorkflowDefinition>('workflow_definitions')) {
    if (
      !row.trial ||
      row.trial.done !== row.trial.tasks ||
      removed.has(row.project_id) ||
      (projectId && row.project_id !== projectId)
    )
      continue;
    items.push({
      source: { table: 'workflow_definitions', id: row.id, revision: row.revision },
      kind: 'workflow.definition.trial',
      project_id: row.project_id,
      status: 'waiting',
      created_at: row.trial.started_at,
      reason: 'workflow_definition_trial_completed',
      decision: 'improvement',
      primary: 'workflow.definition.trial.decide',
      actions: (['keep', 'revert'] as const).map((decision) => ({
        ...action('workflow.definition.trial.decide', () =>
          projectAccess(ctx, principal, row.project_id, 'workflow.definition.trial.decide'),
        ),
        decision,
      })),
    });
  }
  return items;
}

/** Improvement candidates. */
export function improvementItems(ctx: ControlContext, scope: NeedsYouScope): NeedsYouDraft[] {
  const { principal, projectId, removed } = scope;
  const items: NeedsYouDraft[] = [];
  // A candidate waits for the user: auto mode starts each trial as it proposes the improvement.
  for (const improvement of ctx.store.list<Improvement>('improvements')) {
    if (
      improvement.status !== 'candidate' ||
      removed.has(improvement.project_id) ||
      (projectId && improvement.project_id !== projectId)
    )
      continue;
    items.push({
      source: { table: 'improvements', id: improvement.id, revision: improvement.revision },
      kind: 'improvement.candidate',
      project_id: improvement.project_id,
      ...(improvement.lead_session_id ? { session_id: improvement.lead_session_id } : {}),
      status: improvement.status,
      created_at: improvement.proposed_at,
      reason: 'improvement_awaiting_decision',
      decision: 'improvement',
      primary: 'improvement.decide',
      actions: [
        action('improvement.decide', () =>
          projectAccess(ctx, principal, improvement.project_id, 'improvement.decide'),
        ),
      ],
      next_step: NEXT_STEP.improvement_awaiting_decision,
    });
  }
  return items;
}

/** Pending agent proposals. */
export function agentProposalItems(ctx: ControlContext, scope: NeedsYouScope): NeedsYouDraft[] {
  const { principal, listedProject } = scope;
  const items: NeedsYouDraft[] = [];
  for (const proposal of ctx.store.list<AgentProposal>('agent_proposals')) {
    if (proposal.state !== 'pending' || !listedProject(proposal.project_id)) continue;
    const target = proposal.agent_id
      ? ctx.store.must<AgentProfile>('agents', proposal.agent_id)
      : undefined;
    items.push({
      source: { table: 'agent_proposals', id: proposal.id, revision: proposal.revision },
      kind: 'agent.proposal',
      project_id: proposal.project_id,
      session_id: proposal.session_id,
      status: proposal.state,
      created_at: proposal.at,
      reason: 'agent_proposal_awaiting_decision',
      decision: 'agent_proposal',
      primary: 'agent.proposal.resolve',
      actions: [
        action('agent.proposal.resolve', () =>
          projectAccess(ctx, principal, proposal.project_id, 'agent.proposal.resolve'),
        ),
      ],
      agent_proposal: {
        id: proposal.id,
        name: proposal.fields.name ?? target!.name,
        template: target?.template ?? proposal.fields.template!,
        ...(target && { agent_id: target.id }),
        waited_ms: ctx.store.now() - proposal.at,
      },
      next_step: NEXT_STEP.agent_proposal_awaiting_decision,
    });
  }
  return items;
}

/** Projects over their budget. */
export function projectBudgetItems(ctx: ControlContext, scope: NeedsYouScope): NeedsYouDraft[] {
  const { principal, projectId, removed } = scope;
  const items: NeedsYouDraft[] = [];
  for (const project of ctx.store.list<Project>('projects')) {
    if (removed.has(project.id) || (projectId && project.id !== projectId)) continue;
    const use = projectBudgetUse(ctx, project.id);
    if (use?.reached_at === undefined) continue;
    items.push({
      source: {
        table: 'workflow_policies',
        id: project.id,
        revision: workflowPolicy(ctx, project.id).revision,
      },
      kind: 'project.over_budget',
      project_id: project.id,
      status: 'over_budget',
      created_at: use.reached_at,
      reason: 'project_over_budget',
      decision: 'budget',
      primary: 'workflow.policy.set',
      actions: [
        action('workflow.policy.set', () =>
          projectAccess(ctx, principal, project.id, 'workflow.policy.set'),
        ),
      ],
      project_budget: {
        used_input_tokens: use.used_input_tokens,
        input_tokens: use.input_tokens,
      },
      next_step: `The project used ${use.used_input_tokens} input tokens since its budget was set, against a budget of ${use.input_tokens}; Pantheon opens no new task session and wakes no lead, and running turns finish. Work resumes once the user raises or clears the project budget.`,
    });
  }
  return items;
}
