import type { WorkflowParam, WorkflowPolicy } from '@pantheon/domain';
import type { WorkflowPolicyView } from '@pantheon/protocol';
import { t } from '../i18n';
import { sendProjectCommand, useProjectQuery, type MutationResult } from './project-read';

export type { WorkflowParam, WorkflowPolicy, WorkflowPolicyView };

/** The fields of workflow.policy.set besides project_id; an absent field stays as it is. */
export interface PolicyPatch {
  /** null turns it off. */
  question_defaults?: WorkflowPolicy['question_defaults'] | null;
  runtime_quota_threshold?: number;
  gate_on_fail?: WorkflowPolicy['gate_on_fail'];
  gate_runner?: WorkflowPolicy['gate_runner'];
  /** null clears the budget. */
  project_budget?: { input_tokens: number } | null;
  pinned?: WorkflowParam[];
}

/** The daemon's runtime_quota_threshold for a policy that stores none. */
export const DEFAULT_QUOTA_THRESHOLD = 90;

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object';

export const isPolicy = (value: unknown): value is WorkflowPolicy =>
  isObject(value) &&
  typeof value.project_id === 'string' &&
  typeof value.policy_version === 'number' &&
  Array.isArray(value.pinned);

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

/** The pinned list with the parameter added or taken out. */
export const togglePin = (policy: WorkflowPolicy, param: WorkflowParam): WorkflowParam[] =>
  policy.pinned.includes(param)
    ? policy.pinned.filter((p) => p !== param)
    : [...policy.pinned, param];

// Labels are getters, so each is read in the language loaded by then.
export const PARAM_LABEL: Record<
  'gate_on_fail' | 'question_defaults' | 'project_budget' | 'runtime_quota_threshold',
  string
> = {
  get gate_on_fail() {
    return t({ id: 'settings.gate.onFail', defaultMessage: 'When a gate fails' });
  },
  get question_defaults() {
    return t({
      id: 'settings.workflow.questionDefaults',
      defaultMessage: "Apply the lead's recommended answer to reversible questions after N hours",
    });
  },
  get project_budget() {
    return t({
      id: 'data.workflowPolicy.param.projectBudget',
      defaultMessage: 'Project budget (input tokens)',
    });
  },
  get runtime_quota_threshold() {
    return t({
      id: 'data.workflowPolicy.param.runtimeQuotaThreshold',
      defaultMessage: 'Runtime quota threshold (%)',
    });
  },
};
