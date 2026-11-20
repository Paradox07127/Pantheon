import type {
  FlowPath,
  Improvement,
  Retrospective,
  TaskBudget,
  TaskKind,
  WorkflowParam,
  WorkflowPolicy,
} from '@pantheon/domain';
import type { ImprovementListItem, WorkflowPolicyView } from '@pantheon/protocol';
import { t } from '../i18n';
import { listText } from '../lib/list-text';
import { useBoard } from './board';
import { sendProjectCommand, useProjectQuery, type MutationResult } from './project-read';
import { useQuery, useRefetchTick } from './workbench-sessions';

export type {
  Improvement,
  ImprovementListItem,
  Retrospective,
  WorkflowParam,
  WorkflowPolicy,
  WorkflowPolicyView,
};

/** The fields of workflow.policy.set besides project_id; an absent field stays as it is. */
export interface PolicyPatch {
  improvement_mode?: WorkflowPolicy['improvement_mode'];
  plan_changes?: WorkflowPolicy['plan_changes'];
  /** null turns it off. */
  question_defaults?: WorkflowPolicy['question_defaults'] | null;
  path?: WorkflowPolicy['path'];
  acceptance_wake?: WorkflowPolicy['acceptance_wake'];
  max_parallel?: number;
  max_parallel_limit?: number;
  /** Replaces the whole record; a runtime left out has no limit of its own. */
  runtime_parallel?: Record<string, number>;
  dispatch_paused?: boolean;
  runtime_quota_threshold?: number;
  handback_limit?: number;
  gate_on_fail?: WorkflowPolicy['gate_on_fail'];
  gate_runner?: WorkflowPolicy['gate_runner'];
  recovery_switch?: WorkflowPolicy['recovery_switch'];
  milestone_verify?: WorkflowPolicy['milestone_verify'];
  /** null clears the hint. */
  task_size_hint?: number | null;
  /** null clears the budget. */
  project_budget?: { input_tokens: number } | null;
  /** Merged by tier and path; a null cell clears its budget. */
  budget?: Partial<Record<TaskKind['tier'], Partial<Record<FlowPath, TaskBudget | null>>>>;
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
  typeof value.max_parallel === 'number' &&
  isObject(value.path) &&
  Array.isArray(value.pinned);

const isImprovements = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.every(
    (i) =>
      isObject(i) &&
      typeof i.id === 'string' &&
      isObject(i.change) &&
      (i.trial === undefined ||
        (isObject(i.trial) &&
          typeof i.trial.tasks_seen === 'number' &&
          typeof i.trial.tasks_required === 'number' &&
          typeof i.trial.baseline_tasks === 'number' &&
          Array.isArray(i.trial.metrics))),
  );

/** GET /v1/workflow.policy; the defaults at version 0 until the project stores its own. */
export const useWorkflowPolicy = (project_id: string | null) =>
  useProjectQuery<WorkflowPolicyView>('workflow.policy', project_id, isPolicy, undefined, {
    events: true,
  });

/** GET /v1/improvement.list: the project's improvements of every status, newest first. */
export const useImprovements = (project_id: string | null) =>
  useProjectQuery<ImprovementListItem[]>(
    'improvement.list',
    project_id,
    isImprovements,
    undefined,
    { events: true },
  );

/** A plan task of a project, by the task id its plan gives it. */
export interface TaskRef {
  project_id: string;
  task_id: string;
}

const acceptRetrospectives = (value: unknown): Retrospective[] | null =>
  Array.isArray(value) && value.every((r) => isObject(r) && typeof r.id === 'string')
    ? (value as Retrospective[])
    : null;

// Ids hold no newline, so one joins the two parts of the query key.
const taskParams = (key: string) => {
  const at = key.indexOf('\n');
  return { project_id: key.slice(0, at), task_id: key.slice(at + 1) };
};

/**
 * GET /v1/retrospective.list of one task, newest first, again after one of its retrospectives is
 * recorded; reads nothing without a task.
 */
export const useTaskRetrospectives = (task: TaskRef | null) => {
  const sequence = useBoard(
    (s) =>
      (task &&
        s.events.findLast(
          (e) =>
            e.kind === 'retrospective.recorded' &&
            e.project_id === task.project_id &&
            (e.payload as { task_id?: unknown } | null)?.task_id === task.task_id,
        )?.sequence) ??
      0,
  );
  return useQuery(
    'retrospective.list',
    task && `${task.project_id}\n${task.task_id}`,
    taskParams,
    acceptRetrospectives,
    useRefetchTick(sequence, false),
  );
};

/** A project without a stored policy reads it at version 0, and its first write expects no row. */
const policyRevision = (policy: WorkflowPolicy) =>
  policy.policy_version === 0 ? null : policy.revision;

export const setPolicy = (policy: WorkflowPolicy, patch: PolicyPatch): Promise<MutationResult> =>
  sendProjectCommand(
    'workflow.policy.set',
    { project_id: policy.project_id, ...patch },
    policyRevision(policy),
  );

export type CountParam = 'max_parallel' | 'max_parallel_limit' | 'handback_limit';

/** The values the daemon accepts for a count, given the rest of the policy. */
export function countRange(policy: WorkflowPolicy, param: CountParam): [number, number] {
  if (param === 'max_parallel') return [1, policy.max_parallel_limit];
  if (param === 'max_parallel_limit') return [Math.max(1, policy.max_parallel), 8];
  return [2, 5];
}

/** The pinned list with the parameter added or taken out. */
export const togglePin = (policy: WorkflowPolicy, param: WorkflowParam): WorkflowParam[] =>
  policy.pinned.includes(param)
    ? policy.pinned.filter((p) => p !== param)
    : [...policy.pinned, param];

// Labels are getters, so each is read in the language loaded by then.
export const PARAM_LABEL: Record<
  | WorkflowParam
  | 'max_parallel_limit'
  | 'runtime_parallel'
  | 'dispatch_paused'
  | 'runtime_quota_threshold'
  | 'improvement_mode'
  | 'plan_changes'
  | 'question_defaults'
  | 'project_budget'
  | 'budget'
  | 'gate_on_fail',
  string
> = {
  get max_parallel() {
    return t({ id: 'data.workflowPolicy.param.maxParallel', defaultMessage: 'Concurrency limit' });
  },
  get max_parallel_limit() {
    return t({
      id: 'data.workflowPolicy.param.maxParallelLimit',
      defaultMessage: 'Concurrency limit cap',
    });
  },
  get runtime_parallel() {
    return t({
      id: 'data.workflowPolicy.param.runtimeParallel',
      defaultMessage: 'Concurrency per runtime',
    });
  },
  get dispatch_paused() {
    return t({ id: 'data.workflowPolicy.param.dispatchPaused', defaultMessage: 'Pause dispatch' });
  },
  get handback_limit() {
    return t({ id: 'data.workflowPolicy.param.handbackLimit', defaultMessage: 'Handback limit' });
  },
  get gate_on_fail() {
    return t({ id: 'settings.gate.onFail', defaultMessage: 'When a gate fails' });
  },
  get acceptance_wake() {
    return t({ id: 'data.workflowPolicy.param.acceptanceWake', defaultMessage: 'When to accept' });
  },
  get path() {
    return t({ id: 'data.workflowPolicy.param.path', defaultMessage: 'Task path' });
  },
  get task_size_hint() {
    return t({
      id: 'data.workflowPolicy.param.taskSizeHint',
      defaultMessage: 'Task file count hint',
    });
  },
  get improvement_mode() {
    return t({
      id: 'data.workflowPolicy.param.improvementMode',
      defaultMessage: 'Workflow improvement',
    });
  },
  get plan_changes() {
    return t({ id: 'settings.workflow.planChanges', defaultMessage: 'Plan changes' });
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
  get budget() {
    return t({ id: 'data.workflowPolicy.param.budget', defaultMessage: 'Task budget' });
  },
};

/** The paths a tier or a task can be set to; a task takes the parallel path with its parts. */
export const CHOSEN_PATHS = [
  'direct',
  'dispatch',
  'review_loop',
] as const satisfies readonly FlowPath[];

export const PATH_LABEL: Record<FlowPath, string> = {
  get direct() {
    return t({
      id: 'data.workflowPolicy.path.direct',
      defaultMessage: 'The lead does it directly',
    });
  },
  get dispatch() {
    return t({
      id: 'data.workflowPolicy.path.dispatch',
      defaultMessage: 'Dispatch a task session',
    });
  },
  get review_loop() {
    return t({
      id: 'data.workflowPolicy.path.reviewLoop',
      defaultMessage: 'Write and review in turns',
    });
  },
  get parallel() {
    return t({
      id: 'data.workflowPolicy.path.parallel',
      defaultMessage: 'Split into parallel task sessions',
    });
  },
};

export const WAKE_LABEL: Record<WorkflowPolicy['acceptance_wake'], string> = {
  get each_merge() {
    return t({ id: 'data.workflowPolicy.wake.eachMerge', defaultMessage: 'After each merge' });
  },
  get milestone() {
    return t({
      id: 'data.workflowPolicy.wake.milestone',
      defaultMessage: 'After the milestone ends',
    });
  },
};

export const PLAN_CHANGES_LABEL: Record<WorkflowPolicy['plan_changes'], string> = {
  get auto() {
    return t({ id: 'settings.workflow.planChanges.auto', defaultMessage: 'Lead applies them' });
  },
  get confirm() {
    return t({
      id: 'settings.workflow.planChanges.confirm',
      defaultMessage: 'Wait for my approval',
    });
  },
};

export const DOMAIN_LABEL: Record<TaskKind['domain'], string> = {
  get review() {
    return t({ id: 'data.workflowPolicy.domain.review', defaultMessage: 'Review' });
  },
  get 'frontend-ui'() {
    return t({ id: 'data.workflowPolicy.domain.frontendUi', defaultMessage: 'Frontend UI' });
  },
  get 'script-infra'() {
    return t({
      id: 'data.workflowPolicy.domain.scriptInfra',
      defaultMessage: 'Scripts and infrastructure',
    });
  },
  get 'backend-logic'() {
    return t({ id: 'data.workflowPolicy.domain.backendLogic', defaultMessage: 'Backend logic' });
  },
  get 'docs-chore'() {
    return t({ id: 'data.workflowPolicy.domain.docsChore', defaultMessage: 'Docs and chores' });
  },
};

export const tierText = (tier: TaskKind['tier']) => tier.toUpperCase();

export const kindText = (domain: TaskKind['domain'], tier: TaskKind['tier']) =>
  `${DOMAIN_LABEL[domain]} ${tierText(tier)}`;

function valueText(param: WorkflowParam, value: unknown): string {
  if (value === undefined || value === null)
    return t({ id: 'data.workflowPolicy.noLimit', defaultMessage: 'No limit' });
  if (param === 'path' && typeof value === 'string' && value in PATH_LABEL)
    return PATH_LABEL[value as FlowPath];
  if (param === 'acceptance_wake' && (value === 'each_merge' || value === 'milestone'))
    return WAKE_LABEL[value];
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** What an improvement asks for: the procedure of an experience, or the parameter change. */
export function changeText(change: Improvement['change']): string {
  if (change.type === 'experience') return change.procedure;
  if (change.type === 'gate_command')
    return t(
      {
        id: 'data.workflowPolicy.change.gate',
        defaultMessage: 'Change the gate commands of {root}',
      },
      { root: change.root },
    );
  if (change.type === 'worktree_setup')
    return t({
      id: 'data.workflowPolicy.change.worktree',
      defaultMessage: 'Change the worktree setup',
    });
  if (change.type !== 'policy_change') return String(change.to);
  const what = change.tier
    ? `${PARAM_LABEL.path} ${tierText(change.tier)}`
    : PARAM_LABEL[change.param];
  return t(
    { id: 'data.workflowPolicy.change', defaultMessage: '{what} from {from} to {to}' },
    { what, from: valueText(change.param, change.from), to: valueText(change.param, change.to) },
  );
}

/** Which tasks an improvement applies to. */
export function scopeText(change: Improvement['change']): string {
  if (change.type === 'gate_command') return change.root;
  if (change.type !== 'experience')
    return change.type === 'policy_change' && change.tier
      ? tierText(change.tier)
      : t({ id: 'data.workflowPolicy.wholeProject', defaultMessage: 'Whole project' });
  return (
    listText(
      change.domain && DOMAIN_LABEL[change.domain],
      change.tier && tierText(change.tier),
      change.runtime,
    ) || t({ id: 'data.workflowPolicy.allTasks', defaultMessage: 'All tasks' })
  );
}
