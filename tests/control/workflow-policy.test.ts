import { afterEach, expect, it } from 'vitest';
import { DomainError, type Principal, type WorkflowPolicy } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { workflowPolicy } from '../../packages/control/dist/workflow-policy.js';
import { fixture, user } from '../helpers.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function opened() {
  const f = await fixture();
  fixtures.push(f);
  return f;
}
const policyOf = (f: Fixture) =>
  workflowPolicy((f.control as unknown as { ctx: ControlContext }).ctx, f.project.id);
const changes = (f: Fixture) =>
  f.store.events(0, f.project.id).filter((event) => event.kind === 'workflow.policy_changed');
function set(f: Fixture, input: Record<string, unknown>, principal?: Principal) {
  const row = f.store.get<WorkflowPolicy>('workflow_policies', f.project.id);
  return f.call<WorkflowPolicy>(
    'workflow.policy.set',
    { project_id: f.project.id, ...input },
    row?.revision ?? null,
    principal,
  );
}
function refused(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return (error as DomainError).code;
  }
  throw new Error('The command was accepted');
}

it('reads the default policy at version 0 when the project has none', async () => {
  const f = await opened();
  expect(policyOf(f)).toMatchObject({
    project_id: f.project.id,
    policy_version: 0,
    plan_changes: 'auto',
    path: { t1: 'direct', t2: 'dispatch', t3: 'dispatch' },
    acceptance_wake: 'each_merge',
    max_parallel: 3,
    max_parallel_limit: 3,
    handback_limit: 3,
    pinned: [],
  });
  expect(policyOf(f).task_size_hint).toBeUndefined();
  expect(f.store.get('workflow_policies', f.project.id)).toBeUndefined();
});

it('stores a user change to max_parallel at version 1 and records what changed', async () => {
  const f = await opened();
  set(f, { max_parallel: 2 });
  expect(policyOf(f)).toMatchObject({ max_parallel: 2, policy_version: 1 });
  expect(changes(f).map((event) => event.payload)).toEqual([
    { param: 'max_parallel', from: 3, to: 2, by: 'user', policy_version: 1 },
  ]);
});

it('stores a plan changes setting and reads it back', async () => {
  const f = await opened();
  set(f, { plan_changes: 'confirm' });
  expect(policyOf(f)).toMatchObject({ plan_changes: 'confirm', policy_version: 1 });
  expect(changes(f).map((event) => event.payload)).toEqual([
    { param: 'plan_changes', from: 'auto', to: 'confirm', by: 'user', policy_version: 1 },
  ]);
});

it('records one change per parameter but raises the version once', async () => {
  const f = await opened();
  set(f, { acceptance_wake: 'milestone', handback_limit: 4 });
  expect(policyOf(f)).toMatchObject({
    acceptance_wake: 'milestone',
    handback_limit: 4,
    policy_version: 1,
  });
  expect(changes(f).map((event) => event.payload)).toEqual([
    {
      param: 'acceptance_wake',
      from: 'each_merge',
      to: 'milestone',
      by: 'user',
      policy_version: 1,
    },
    { param: 'handback_limit', from: 3, to: 4, by: 'user', policy_version: 1 },
  ]);
});

it('refuses max_parallel above the user limit and keeps the stored policy', async () => {
  const f = await opened();
  set(f, { max_parallel: 2 });
  const before = f.store.get('workflow_policies', f.project.id);
  expect(refused(() => set(f, { max_parallel: 4 }))).toBe('invalid_input');
  expect(f.store.get('workflow_policies', f.project.id)).toEqual(before);
  expect(changes(f)).toHaveLength(1);
});

it('leaves the version and events alone when the input matches the project settings', async () => {
  const f = await opened();
  set(f, { max_parallel: 2, plan_changes: 'auto' });
  set(f, { max_parallel: 2 });
  set(f, { max_parallel: 2, plan_changes: 'auto' });
  expect(policyOf(f).policy_version).toBe(1);
  expect(changes(f)).toHaveLength(2);
});

it('stores a value equal to the one it follows as the project setting', async () => {
  const f = await opened();
  set(f, { max_parallel: 3, path: { t1: 'direct' } });
  expect(f.store.get<WorkflowPolicy>('workflow_policies', f.project.id)?.overridden).toEqual([
    'max_parallel',
    'path',
  ]);
  expect(changes(f).map((event) => event.payload)).toMatchObject([
    { param: 'path', from: { t1: 'direct' }, to: { t1: 'direct' } },
    { param: 'max_parallel', from: 3, to: 3 },
  ]);
});

it('reads a stored policy that still holds improvement_mode and eval_runner without them, and saves another parameter', async () => {
  const f = await opened();
  const stored = {
    id: f.project.id,
    revision: 1,
    project_id: f.project.id,
    policy_version: 1,
    improvement_mode: 'confirm',
    eval_runner: 'on',
    plan_changes: 'auto',
    path: { t1: 'direct', t2: 'dispatch', t3: 'dispatch' },
    acceptance_wake: 'each_merge',
    max_parallel: 3,
    max_parallel_limit: 3,
    handback_limit: 3,
    budget: {},
    pinned: [],
    overridden: ['improvement_mode', 'eval_runner', 'max_parallel'],
  };
  f.store.transaction(() =>
    f.store.insert<WorkflowPolicy>('workflow_policies', stored as unknown as WorkflowPolicy),
  );
  const read = f.control.workflowPolicy(user, f.project.id);
  expect(read).toMatchObject({ max_parallel: 3, policy_version: 1 });
  expect(read).not.toHaveProperty('improvement_mode');
  expect(read).not.toHaveProperty('eval_runner');
  set(f, { max_parallel: 2 });
  const after = f.store.get<WorkflowPolicy>('workflow_policies', f.project.id)!;
  expect(after).toMatchObject({ max_parallel: 2, policy_version: 2, overridden: ['max_parallel'] });
  expect(after).not.toHaveProperty('improvement_mode');
  expect(after).not.toHaveProperty('eval_runner');
  expect(changes(f).map((event) => event.payload)).toEqual([
    { param: 'max_parallel', from: 3, to: 2, by: 'user', policy_version: 2 },
  ]);
});

it('refuses a lead session that tries to change the policy', async () => {
  const f = await opened();
  const lead: Principal = {
    id: 'session:lead',
    role: 'lead',
    project_id: f.project.id,
    session_id: 'lead',
    expires_at: f.store.now() + 60000,
  };
  expect(refused(() => set(f, { max_parallel: 2 }, lead))).toBe('permission_denied');
  expect(f.store.get('workflow_policies', f.project.id)).toBeUndefined();
});

it('reads a default budget for the t1 cells only', async () => {
  const f = await opened();
  expect(policyOf(f).budget).toEqual({
    t1: {
      direct: { input_tokens: 400000, wall_ms: 95000 },
      dispatch: { input_tokens: 1120000, wall_ms: 255000 },
    },
  });
});

it('sets one budget cell, clears another with null and records the change', async () => {
  const f = await opened();
  set(f, {
    budget: {
      t1: { dispatch: null },
      t2: { dispatch: { input_tokens: 2000000, wall_ms: 600000 } },
    },
  });
  expect(policyOf(f)).toMatchObject({
    policy_version: 1,
    budget: {
      t1: { direct: { input_tokens: 400000, wall_ms: 95000 } },
      t2: { dispatch: { input_tokens: 2000000, wall_ms: 600000 } },
    },
  });
  expect(policyOf(f).budget.t1).not.toHaveProperty('dispatch');
  expect(changes(f).map((event) => (event.payload as { param: string }).param)).toEqual(['budget']);
});

it('refuses a budget that is not a positive integer and keeps the stored policy', async () => {
  const f = await opened();
  for (const cell of [
    { input_tokens: 0, wall_ms: 95000 },
    { input_tokens: 400000, wall_ms: -1 },
  ])
    expect(refused(() => set(f, { budget: { t1: { direct: cell } } }))).toBe('invalid_input');
  expect(f.store.get('workflow_policies', f.project.id)).toBeUndefined();
});

it('stores the review loop as a tier path and a budget cell', async () => {
  const f = await opened();
  const cell = { input_tokens: 2000000, wall_ms: 600000 };
  set(f, { path: { t2: 'review_loop' }, budget: { t2: { review_loop: cell } } });
  expect(policyOf(f)).toMatchObject({
    path: { t2: 'review_loop' },
    budget: { t2: { review_loop: cell } },
  });
});

it('reads the default budget for a policy stored without one', async () => {
  const f = await opened();
  set(f, { max_parallel: 2 });
  const row = f.store.must<WorkflowPolicy>('workflow_policies', f.project.id);
  const { budget: _, ...old } = row;
  f.store.update('workflow_policies', old, row.revision);
  expect(policyOf(f)).toMatchObject({
    max_parallel: 2,
    budget: { t1: { direct: { input_tokens: 400000, wall_ms: 95000 } } },
  });
});

it('stores and reads back the pinned parameters', async () => {
  const f = await opened();
  set(f, { pinned: ['path', 'task_size_hint'] });
  expect(policyOf(f).pinned).toEqual(['path', 'task_size_hint']);
  set(f, { pinned: [] });
  expect(policyOf(f)).toMatchObject({ pinned: [], policy_version: 2 });
});

it('allows quota and task budgets to be pinned alongside the existing parameters', async () => {
  const f = await opened();
  const pinned = [
    'path',
    'acceptance_wake',
    'max_parallel',
    'handback_limit',
    'task_size_hint',
    'runtime_quota_threshold',
    'budget',
  ];
  expect(set(f, { pinned }).pinned).toEqual(pinned);
});

it('defaults dispatch to active and stores runtime limits and pause changes', async () => {
  const f = await opened();
  expect(policyOf(f).dispatch_paused).toBe(false);
  expect(set(f, { runtime_parallel: { fixture: 1 }, dispatch_paused: true })).toMatchObject({
    runtime_parallel: { fixture: 1 },
    dispatch_paused: true,
  });
  expect(changes(f).map((event) => (event.payload as { param: string }).param)).toEqual([
    'runtime_parallel',
    'dispatch_paused',
  ]);
  expect(set(f, { runtime_parallel: {}, dispatch_paused: false })).toMatchObject({
    runtime_parallel: {},
    dispatch_paused: false,
  });
});

it('resets a changed policy to the defaults exposed by the query at the current revision', async () => {
  const f = await opened();
  const initial = f.control.workflowPolicy(user, f.project.id);
  expect(initial.max_parallel).toBe(initial.defaults.max_parallel);
  set(f, {
    max_parallel: 1,
    task_size_hint: 8,
    project_budget: { input_tokens: 1000 },
    pinned: ['path'],
  });
  const changed = f.control.workflowPolicy(user, f.project.id);
  expect(changed.max_parallel).not.toBe(changed.defaults.max_parallel);
  expect(() =>
    f.call('workflow.policy.reset', { project_id: f.project.id }, initial.revision),
  ).toThrowError(expect.objectContaining({ code: 'revision_conflict' }));
  expect(() =>
    f.call('workflow.policy.reset', { project_id: f.project.id }, changed.revision, {
      id: 'agent',
      role: 'planner',
    }),
  ).toThrowError(expect.objectContaining({ code: 'permission_denied' }));
  f.call('workflow.policy.reset', { project_id: f.project.id }, changed.revision);
  const reset = f.control.workflowPolicy(user, f.project.id);
  const { id, revision, project_id, policy_version, defaults, ...settings } = reset;
  expect(settings).toEqual(defaults);
  expect(reset.policy_version).toBe(changed.policy_version + 1);
  expect(reset.revision).toBeGreaterThan(changed.revision);
  expect(changes(f).at(-1)?.payload).toMatchObject({
    by: 'user',
    policy_version: reset.policy_version,
  });
});

it('stores disabled hand-backs and refuses a limit of one', async () => {
  const f = await opened();
  expect(set(f, { handback_limit: 0 }).handback_limit).toBe(0);
  expect(policyOf(f).handback_limit).toBe(0);
  expect(() => set(f, { handback_limit: 1 })).toThrow();
});
