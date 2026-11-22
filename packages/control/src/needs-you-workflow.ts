import type { Project } from '@pantheon/domain';
import { projectAccess, type ControlContext } from './context.js';
import { projectBudgetUse, workflowPolicy } from './workflow-policy.js';
import { action, type NeedsYouDraft, type NeedsYouScope } from './needs-you.js';

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
      next_step: `The project used ${use.used_input_tokens} input tokens since its budget was set, against a budget of ${use.input_tokens}; turns the user sends still run, but Pantheon sends no notices to sessions, runs no runtime analysis and writes no recaps or brief summaries until the user raises or clears the project budget.`,
    });
  }
  return items;
}
