import {
  canonical,
  DomainError,
  FLOW_PATHS,
  requireThat,
  TASK_TIERS,
  type CharterMode,
  type CharterPower,
  type Entity,
  type FlowPath,
  type Project,
  type TaskBudget,
  type TaskKind,
  type WorkflowParam,
  type WorkflowPolicy,
} from '@pantheon/domain';
import { inputSchemas } from '@pantheon/protocol';
import {
  projectAccess,
  revision,
  userOnly,
  type ControlContext,
  type Handlers,
} from './context.js';
import { turnInputTokens } from './turn-usage.js';
import { projectDefaults, type ProjectDefaults } from './user-config.js';

type PolicySettings = Omit<
  WorkflowPolicy,
  keyof Entity | 'project_id' | 'policy_version' | 'overridden'
>;
type InheritedParam = NonNullable<WorkflowPolicy['overridden']>[number];

export const DEFAULT_WORKFLOW_POLICY: PolicySettings & {
  runtime_quota_threshold: number;
  charter: Record<Exclude<CharterPower, 'plan_change' | 'start_external'>, CharterMode>;
} = {
  improvement_mode: 'auto',
  plan_changes: 'auto',
  // plan_change and start_external follow plan_changes and the project's external events.
  charter: {
    approve_worker_prompts: 'on',
    answer_worker_questions: 'on',
    create_agent: 'ask',
    accept_milestone: 'on',
    merge_out_of_scope: 'on',
  },
  path: { t1: 'direct', t2: 'dispatch', t3: 'dispatch' },
  acceptance_wake: 'each_merge',
  max_parallel: 3,
  max_parallel_limit: 3,
  runtime_parallel: {},
  dispatch_paused: false,
  runtime_quota_threshold: 90,
  handback_limit: 3,
  gate_on_fail: 'handback',
  gate_runner: 'daemon',
  // The largest of the simple-task baselines on each path; tiers without a baseline have none.
  budget: {
    t1: {
      direct: { input_tokens: 400000, wall_ms: 95000 },
      dispatch: { input_tokens: 1120000, wall_ms: 255000 },
    },
  },
  pinned: [],
};

/** The settings a project follows from the global values unless it sets them itself. */
const INHERITED = [...Object.keys(DEFAULT_WORKFLOW_POLICY), 'task_size_hint'] as InheritedParam[];
const SETTINGS: (keyof PolicySettings)[] = [...INHERITED, 'project_budget'];

/** The settings the stored policy sets itself; one stored before global values sets each it holds. */
export function ownPolicySettings(stored: WorkflowPolicy | undefined): Partial<PolicySettings> {
  if (!stored) return {};
  return Object.fromEntries(
    (stored.overridden ?? INHERITED)
      .filter((param) => stored[param] !== undefined)
      .map((param) => [param, stored[param]]),
  );
}

/** The built-in defaults under the global values, which a project follows where it sets nothing. */
export function inheritedPolicy(
  ctx: ControlContext,
): PolicySettings & { runtime_quota_threshold: number } {
  return {
    ...structuredClone(DEFAULT_WORKFLOW_POLICY),
    ...structuredClone(projectDefaults(ctx.userConfigDir).workflow_policy),
  };
}

/** The project's own settings over the inherited ones, at version 0 when it has no stored policy. */
export function workflowPolicy(
  ctx: ControlContext,
  projectId: string,
): WorkflowPolicy & { runtime_quota_threshold: number } {
  const stored = ctx.store.get<WorkflowPolicy>('workflow_policies', projectId);
  const settings = { ...inheritedPolicy(ctx), ...ownPolicySettings(stored) };
  if (stored)
    return {
      ...settings,
      id: stored.id,
      revision: stored.revision,
      project_id: stored.project_id,
      policy_version: stored.policy_version,
      ...(stored.project_budget && { project_budget: stored.project_budget }),
    };
  return { ...settings, id: projectId, revision: 0, project_id: projectId, policy_version: 0 };
}

const ownParams = (ctx: ControlContext, projectId: string) =>
  Object.keys(
    ownPolicySettings(ctx.store.get<WorkflowPolicy>('workflow_policies', projectId)),
  ) as InheritedParam[];

/** Settings whose value, or whether the project sets them itself, differs between the two. */
function changedParams(
  current: WorkflowPolicy,
  next: WorkflowPolicy,
  ownBefore: InheritedParam[],
  ownAfter: InheritedParam[],
): (keyof PolicySettings)[] {
  return SETTINGS.filter(
    (param) =>
      canonical(current[param]) !== canonical(next[param]) ||
      ownBefore.includes(param as InheritedParam) !== ownAfter.includes(param as InheritedParam),
  );
}

function checkPolicy(policy: WorkflowPolicy): void {
  const between = (value: number, low: number, high: number) =>
    Number.isInteger(value) && value >= low && value <= high;
  // An improvement's value arrives untyped, so the shapes the input schema enforces are checked here too.
  requireThat(
    Object.entries(policy.path).every(
      ([tier, way]) =>
        TASK_TIERS.includes(tier as never) &&
        FLOW_PATHS.filter((flow) => flow !== 'parallel').includes(way),
    ),
    'invalid_input',
    'path must map t1, t2 or t3 to direct, dispatch or review_loop',
  );
  requireThat(
    ['each_merge', 'milestone'].includes(policy.acceptance_wake),
    'invalid_input',
    'acceptance_wake must be each_merge or milestone',
  );
  requireThat(
    between(policy.max_parallel_limit, 1, 8),
    'invalid_input',
    'max_parallel_limit must be from 1 to 8',
  );
  requireThat(
    between(policy.max_parallel, 1, policy.max_parallel_limit),
    'invalid_input',
    `max_parallel must be from 1 to max_parallel_limit (${policy.max_parallel_limit})`,
  );
  requireThat(
    policy.runtime_quota_threshold === undefined ||
      (Number.isFinite(policy.runtime_quota_threshold) &&
        policy.runtime_quota_threshold >= 0 &&
        policy.runtime_quota_threshold <= 100),
    'invalid_input',
    'runtime_quota_threshold must be a percentage from 0 to 100',
  );
  requireThat(
    policy.handback_limit === 0 || between(policy.handback_limit, 2, 5),
    'invalid_input',
    'handback_limit must be 0 or from 2 to 5',
  );
  requireThat(
    policy.task_size_hint === undefined ||
      (Number.isInteger(policy.task_size_hint) && policy.task_size_hint > 0),
    'invalid_input',
    'task_size_hint must be a positive integer',
  );
  requireThat(
    Object.entries(policy.budget).every(
      ([tier, cells]) =>
        TASK_TIERS.includes(tier as never) &&
        Object.entries(cells).every(
          ([way, cell]) =>
            FLOW_PATHS.includes(way as never) &&
            [cell.input_tokens, cell.wall_ms].every(
              (limit) => Number.isInteger(limit) && limit > 0,
            ),
        ),
    ),
    'invalid_input',
    'budget must map t1, t2 or t3 and direct, dispatch or review_loop to positive integer input_tokens and wall_ms',
  );
  requireThat(
    policy.project_budget === undefined ||
      (Number.isInteger(policy.project_budget.input_tokens) &&
        policy.project_budget.input_tokens > 0),
    'invalid_input',
    'project_budget must be a positive integer of input tokens',
  );
  requireThat(
    policy.charter?.create_agent !== 'on',
    'invalid_input',
    'create_agent cannot be on: the user approves each agent the lead creates',
  );
}

/** What the project spent of its budget, and when it reached it; undefined without a budget. */
export function projectBudgetUse(
  ctx: ControlContext,
  projectId: string,
): { used_input_tokens: number; input_tokens: number; reached_at?: number } | undefined {
  const budget = workflowPolicy(ctx, projectId).project_budget;
  if (!budget) return;
  const rows = turnInputTokens(ctx, { project_id: projectId, since: budget.since });
  let used = 0,
    reachedAt: number | undefined;
  for (const row of rows) {
    used += row.input_tokens;
    if (reachedAt === undefined && used >= budget.input_tokens) reachedAt = row.ended_at;
  }
  return {
    used_input_tokens: used,
    input_tokens: budget.input_tokens,
    ...(reachedAt === undefined ? {} : { reached_at: reachedAt }),
  };
}

/** True once the project's ended turns spent its whole budget. */
export function projectOverBudget(ctx: ControlContext, projectId: string): boolean {
  return projectBudgetUse(ctx, projectId)?.reached_at !== undefined;
}

/** One parameter to change; tier names the one path tier to change and fits no other parameter. */
export interface PolicyChange {
  param: WorkflowParam;
  tier?: TaskKind['tier'];
  to: unknown;
}
/** Who changed the policy: the user directly, or an improvement by id. */
export type PolicyChangeBy = 'user' | { improvement_id: string };

/** The value a change addresses: the tier's path when it names a tier, else the whole parameter. */
export function policyValue(policy: WorkflowPolicy, change: Omit<PolicyChange, 'to'>): unknown {
  return change.tier ? policy.path[change.tier] : policy[change.param];
}

/** The policy with the change applied and checked; throws invalid_input when it does not fit. */
export function changedPolicy(policy: WorkflowPolicy, change: PolicyChange): WorkflowPolicy {
  requireThat(
    !change.tier || change.param === 'path',
    'invalid_input',
    'Only a path change names a tier',
  );
  const next: WorkflowPolicy = change.tier
    ? { ...policy, path: { ...policy.path, [change.tier]: change.to } }
    : { ...policy, [change.param]: change.to };
  checkPolicy(next);
  return next;
}

function writePolicy(
  ctx: ControlContext,
  current: WorkflowPolicy,
  next: WorkflowPolicy,
  overridden: InheritedParam[],
  changed: (keyof PolicySettings)[],
  by: PolicyChangeBy,
  commandId?: string,
): WorkflowPolicy {
  const old = ctx.store.get<WorkflowPolicy>('workflow_policies', current.project_id);
  // Stored settings outside overridden only record what the project followed when written.
  const value = {
    ...next,
    overridden,
    revision: old?.revision ?? 1,
    policy_version: current.policy_version + 1,
  };
  const stored = old
    ? ctx.store.update('workflow_policies', value, old.revision)
    : ctx.store.insert('workflow_policies', value);
  for (const param of changed)
    ctx.store.event(
      'workflow.policy_changed',
      stored,
      current.project_id,
      {
        param,
        from: current[param],
        to: next[param],
        ...(by === 'user' ? { by } : { by: 'improvement', improvement_id: by.improvement_id }),
        policy_version: stored.policy_version,
      },
      commandId,
    );
  return stored;
}

/** Writes one parameter change as a new policy version and returns the value it replaced. */
export function applyPolicyChange(
  ctx: ControlContext,
  projectId: string,
  change: PolicyChange,
  by: PolicyChangeBy,
  commandId?: string,
): unknown {
  const current = workflowPolicy(ctx, projectId);
  writePolicy(
    ctx,
    current,
    changedPolicy(current, change),
    [...new Set([...ownParams(ctx, projectId), change.param])],
    [change.param],
    by,
    commandId,
  );
  return policyValue(current, change);
}

/** Adds the parameter to the pinned list unless it is there already. */
export function pinParam(
  ctx: ControlContext,
  projectId: string,
  param: WorkflowParam,
  by: PolicyChangeBy,
  commandId?: string,
): void {
  const current = workflowPolicy(ctx, projectId);
  if (current.pinned.includes(param)) return;
  const next = { ...current, pinned: [...current.pinned, param] };
  const overridden = [...new Set([...ownParams(ctx, projectId), 'pinned' as const])];
  writePolicy(ctx, current, next, overridden, ['pinned'], by, commandId);
}

/** Drops the project's own settings and budget, or only the named setting, so it follows the global values. */
export function clearPolicyOverrides(
  ctx: ControlContext,
  projectId: string,
  commandId: string,
  param?: InheritedParam,
): WorkflowPolicy {
  const current = workflowPolicy(ctx, projectId),
    own = ownParams(ctx, projectId),
    inherited = inheritedPolicy(ctx);
  const next: WorkflowPolicy = param
    ? { ...current, [param]: inherited[param] }
    : {
        ...inherited,
        id: current.id,
        revision: current.revision,
        project_id: projectId,
        policy_version: current.policy_version,
      };
  if (param === 'task_size_hint' && inherited.task_size_hint === undefined)
    delete next.task_size_hint;
  const overridden = param ? own.filter((p) => p !== param) : [];
  const changed = changedParams(current, next, own, overridden);
  if (!changed.length) return current;
  return writePolicy(ctx, current, next, overridden, changed, 'user', commandId);
}

/** Records each setting the global values changed, for the projects that follow them. */
export function writeGlobalPolicyChanges(
  ctx: ControlContext,
  before: PolicySettings,
  commandId: string,
): void {
  const after = inheritedPolicy(ctx);
  for (const param of INHERITED)
    if (canonical(before[param]) !== canonical(after[param]))
      ctx.store.event(
        'workflow.policy_changed',
        { id: 'project.defaults', revision: 1 },
        '',
        { param, from: before[param], to: after[param], by: 'global' },
        commandId,
      );
}

/** Refuses global values that make no valid policy alone or under a project's own settings. */
export function checkPolicyDefaults(
  ctx: ControlContext,
  value: NonNullable<ProjectDefaults['workflow_policy']>,
): void {
  const inherited = { ...structuredClone(DEFAULT_WORKFLOW_POLICY), ...value } as WorkflowPolicy;
  checkPolicy(inherited);
  for (const project of ctx.store.list<Project>('projects')) {
    if (project.removed_at !== undefined) continue;
    const own = ownPolicySettings(ctx.store.get<WorkflowPolicy>('workflow_policies', project.id));
    try {
      checkPolicy({ ...inherited, ...own });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      throw new DomainError(error.code, `${error.message} in project ${project.name}`);
    }
  }
}

export const workflowPolicyHandlers: Handlers = {
  'workflow.policy.reset': (ctx, p, c) => {
    userOnly(p);
    const { project_id } = c.input as ReturnType<
      (typeof inputSchemas)['workflow.policy.reset']['parse']
    >;
    projectAccess(ctx, p, project_id, c.type);
    ctx.store.must<Project>('projects', project_id);
    revision(ctx, c, ctx.store.get<WorkflowPolicy>('workflow_policies', project_id));
    return clearPolicyOverrides(ctx, project_id, c.command_id);
  },
  'workflow.policy.set': (ctx, p, c) => {
    userOnly(p);
    const { project_id, task_size_hint, path, budget, project_budget, charter, ...input } =
      inputSchemas['workflow.policy.set'].parse(c.input);
    projectAccess(ctx, p, project_id, c.type);
    ctx.store.must<Project>('projects', project_id);
    const old = ctx.store.get<WorkflowPolicy>('workflow_policies', project_id);
    revision(ctx, c, old);
    const current = workflowPolicy(ctx, project_id),
      own = ownParams(ctx, project_id);
    const given = [
      ...Object.keys(input),
      ...(path ? ['path'] : []),
      ...(budget ? ['budget'] : []),
      ...(charter ? ['charter'] : []),
      ...(task_size_hint === undefined ? [] : ['task_size_hint']),
    ] as InheritedParam[];
    // A cleared hint is no longer the project's own, so the global one applies.
    const overridden = [...new Set([...own, ...given])].filter(
      (param) => param !== 'task_size_hint' || task_size_hint !== null,
    );
    const next: WorkflowPolicy = {
      ...current,
      ...input,
      path: { ...current.path, ...path },
      ...(charter && { charter: { ...current.charter, ...charter } }),
      budget: structuredClone(current.budget),
    };
    for (const [tier, cells] of Object.entries(budget ?? {}) as [TaskKind['tier'], object][])
      for (const [way, cell] of Object.entries(cells) as [FlowPath, TaskBudget | null][]) {
        const tierCells = (next.budget[tier] ??= {});
        if (cell) tierCells[way] = cell;
        else delete tierCells[way];
        if (!Object.keys(tierCells).length) delete next.budget[tier];
      }
    if (task_size_hint === null) {
      delete next.task_size_hint;
      const inherited = inheritedPolicy(ctx).task_size_hint;
      if (inherited !== undefined) next.task_size_hint = inherited;
    } else if (task_size_hint !== undefined) next.task_size_hint = task_size_hint;
    // A changed budget keeps counting from when the first one was set.
    if (project_budget === null) delete next.project_budget;
    else if (project_budget)
      next.project_budget = {
        input_tokens: project_budget.input_tokens,
        since: current.project_budget?.since ?? ctx.store.now(),
      };
    checkPolicy(next);
    const changed = changedParams(current, next, own, overridden);
    if (!changed.length) return current;
    return writePolicy(ctx, current, next, overridden, changed, 'user', c.command_id);
  },
};
