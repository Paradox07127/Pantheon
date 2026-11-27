import {
  canonical,
  requireThat,
  type Entity,
  type Project,
  type WorkflowPolicy,
} from '@pantheon/domain';
import { nativeRuntimes, acpProfiles } from '@pantheon/adapters';
import { inputSchemas, SPAWNED_SESSION_LIMIT, workflowPolicyParams } from '@pantheon/protocol';
import {
  projectAccess,
  revision,
  userOnly,
  type ControlContext,
  type Handlers,
} from './context.js';
import { turnInputTokens } from './turn-usage.js';
import { projectDefaults } from './user-config.js';

type PolicySettings = Omit<
  WorkflowPolicy,
  keyof Entity | 'project_id' | 'policy_version' | 'overridden'
>;
type InheritedParam = NonNullable<WorkflowPolicy['overridden']>[number];

export const DEFAULT_WORKFLOW_POLICY: PolicySettings = {
  gate_on_fail: 'stop',
  gate_runner: 'daemon',
  max_spawned: SPAWNED_SESSION_LIMIT,
};

/** The settings a project follows from the global values unless it sets them itself. */
const INHERITED = workflowPolicyParams;
const SETTINGS: (keyof PolicySettings)[] = [...INHERITED, 'project_budget'];

/**
 * The settings the stored policy sets itself; one stored before global values sets each it holds.
 * A setting no longer in use is left out, and a stored `handback` reads as `stop`.
 */
export function ownPolicySettings(stored: WorkflowPolicy | undefined): Partial<PolicySettings> {
  if (!stored) return {};
  return Object.fromEntries(
    (stored.overridden ?? INHERITED)
      .filter((param) => INHERITED.includes(param) && stored[param] !== undefined)
      .map((param) => [param, readSetting(param, stored[param])]),
  );
}

const readSetting = (param: InheritedParam, value: unknown) =>
  param === 'gate_on_fail' && value === 'handback' ? 'stop' : value;

/** The built-in defaults under the global values, which a project follows where it sets nothing. */
export function inheritedPolicy(ctx: ControlContext): PolicySettings {
  return {
    ...structuredClone(DEFAULT_WORKFLOW_POLICY),
    ...structuredClone(projectDefaults(ctx.userConfigDir).workflow_policy),
  };
}

/** The project's own settings over the inherited ones, at version 0 when it has no stored policy. */
export function workflowPolicy(ctx: ControlContext, projectId: string): WorkflowPolicy {
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

/** The runtime catalog includes supported runtimes that are currently uninstalled. */
export function checkPolicyDefaults(settings: {
  runtime_parallel?: Record<string, number> | null;
}): void {
  for (const name of Object.keys(settings.runtime_parallel ?? {}))
    requireThat(
      (nativeRuntimes as readonly string[]).includes(name) || Object.hasOwn(acpProfiles, name),
      'invalid_input',
      `Unknown runtime ${name}`,
    );
}

function checkPolicy(policy: WorkflowPolicy): void {
  requireThat(
    policy.project_budget === undefined ||
      (Number.isInteger(policy.project_budget.input_tokens) &&
        policy.project_budget.input_tokens > 0),
    'invalid_input',
    'project_budget must be a positive integer of input tokens',
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

function writePolicy(
  ctx: ControlContext,
  current: WorkflowPolicy,
  next: WorkflowPolicy,
  overridden: InheritedParam[],
  changed: (keyof PolicySettings)[],
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
        by: 'user',
        policy_version: stored.policy_version,
      },
      commandId,
    );
  return stored;
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
  const overridden = param ? own.filter((p) => p !== param) : [];
  const changed = changedParams(current, next, own, overridden);
  if (!changed.length) return current;
  return writePolicy(ctx, current, next, overridden, changed, commandId);
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
    const { project_id, project_budget, ...input } = c.input as ReturnType<
      (typeof inputSchemas)['workflow.policy.set']['parse']
    >;
    projectAccess(ctx, p, project_id, c.type);
    ctx.store.must<Project>('projects', project_id);
    const old = ctx.store.get<WorkflowPolicy>('workflow_policies', project_id);
    revision(ctx, c, old);
    const current = workflowPolicy(ctx, project_id),
      own = ownParams(ctx, project_id);
    checkPolicyDefaults(input);
    const inherited = inheritedPolicy(ctx);
    const overrides = new Set(own);
    const next = { ...current };
    for (const key of Object.keys(input) as InheritedParam[]) {
      const value = input[key];
      if (value === null) overrides.delete(key);
      else overrides.add(key);
      Object.assign(next, { [key]: value ?? inherited[key] });
    }
    const overridden = [...overrides];
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
    return writePolicy(ctx, current, next, overridden, changed, c.command_id);
  },
};
