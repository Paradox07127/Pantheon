import type { WorkflowPolicy } from '@pantheon/domain';
import type { WorkflowPolicyView } from '@pantheon/protocol';
import { t } from '../i18n';
import { sendProjectCommand, useProjectQuery, type MutationResult } from './project-read';

export type { WorkflowPolicy, WorkflowPolicyView };

/** The fields of workflow.policy.set besides project_id; an absent field stays as it is. */
export interface PolicyPatch {
  gate_on_fail?: WorkflowPolicy['gate_on_fail'];
  gate_runner?: WorkflowPolicy['gate_runner'];
  /** null on any of these five follows the global value. */
  max_spawned?: WorkflowPolicy['max_spawned'] | null;
  runtime_parallel?: WorkflowPolicy['runtime_parallel'] | null;
  task_size?: WorkflowPolicy['task_size'] | null;
  verify_timing?: WorkflowPolicy['verify_timing'] | null;
  kind_routes?: WorkflowPolicy['kind_routes'] | null;
  /** null clears the budget. */
  project_budget?: { input_tokens: number } | null;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object';

export const isPolicy = (value: unknown): value is WorkflowPolicy =>
  isObject(value) &&
  typeof value.project_id === 'string' &&
  typeof value.policy_version === 'number';

/** GET /v1/workflow.policy; the defaults at version 0 until the project stores its own. */
export const useWorkflowPolicy = (project_id: string | null) =>
  useProjectQuery<WorkflowPolicyView>('workflow.policy', project_id, isPolicy, undefined, {
    events: true,
  });

/** A project without a stored policy reads it at version 0, and its first write expects no row. */
const policyRevision = (policy: WorkflowPolicy) =>
  policy.policy_version === 0 ? null : policy.revision;

export const setPolicy = (policy: WorkflowPolicy, patch: PolicyPatch): Promise<MutationResult> =>
  sendProjectCommand(
    'workflow.policy.set',
    { project_id: policy.project_id, ...patch },
    policyRevision(policy),
  );

// Labels are getters, so each is read in the language loaded by then.
export const PARAM_LABEL: Record<'gate_on_fail' | 'project_budget', string> = {
  get gate_on_fail() {
    return t({ id: 'settings.gate.onFail', defaultMessage: 'When a gate fails' });
  },
  get project_budget() {
    return t({
      id: 'data.workflowPolicy.param.projectBudget',
      defaultMessage: 'Project budget (input tokens)',
    });
  },
};
