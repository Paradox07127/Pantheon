import type { MemoryRecord, Project } from '@pantheon/domain';
import { projectAccess, type ControlContext } from './context.js';
import { alive } from './memory-access.js';
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
      next_step: `The project used ${use.used_input_tokens} input tokens since its budget was set, against a budget of ${use.input_tokens}; Pantheon opens no new task session and wakes no lead, and running turns finish. Work resumes once the user raises or clears the project budget.`,
    });
  }
  return items;
}

/** Plan decisions kept as notes because the project's decisions did not fit the memory budget. */
export function memoryBudgetItems(ctx: ControlContext, scope: NeedsYouScope): NeedsYouDraft[] {
  const { projectId, removed } = scope;
  const notes = ctx.store
    .statement(
      "SELECT data FROM memory_records WHERE json_extract(data,'$.origin.kind')='plan' AND json_extract(data,'$.kind')='note' AND json_extract(data,'$.state')='active' ORDER BY rowid",
    )
    .all()
    .map((row) => JSON.parse(String(row.data)) as MemoryRecord)
    .filter(
      (r) =>
        !removed.has(r.project_id) && (!projectId || r.project_id === projectId) && alive(ctx, r),
    );
  return [...new Set(notes.map((r) => r.project_id))].map((project) => {
    const kept = notes.filter((r) => r.project_id === project),
      newest = kept.at(-1)!;
    return {
      source: { table: 'memory_records', id: newest.id, revision: newest.revision },
      kind: 'memory.decision_budget',
      project_id: project,
      status: 'over_budget',
      created_at: kept[0]!.created_at,
      reason: 'plan_decisions_over_budget',
      decision: 'budget',
      actions: [],
      memory_notes: { count: kept.length, memory_ids: kept.map((r) => r.id) },
      next_step: `${kept.length} decisions from the plan did not fit the memory budget for decisions, so Pantheon kept them as notes; the user reads them in project memory, shortens or archives decisions to make room, and archives each note once it is handled.`,
    };
  });
}
