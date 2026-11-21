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
    runtime_quota_threshold: 90,
    gate_on_fail: 'handback',
    gate_runner: 'daemon',
    pinned: [],
  });
  expect(f.store.get('workflow_policies', f.project.id)).toBeUndefined();
});

it('stores a user change to gate_on_fail at version 1 and records what changed', async () => {
  const f = await opened();
  set(f, { gate_on_fail: 'stop' });
  expect(policyOf(f)).toMatchObject({ gate_on_fail: 'stop', policy_version: 1 });
  expect(changes(f).map((event) => event.payload)).toEqual([
    { param: 'gate_on_fail', from: 'handback', to: 'stop', by: 'user', policy_version: 1 },
  ]);
});

it('records one change per parameter but raises the version once', async () => {
  const f = await opened();
  set(f, { gate_on_fail: 'retry', gate_runner: 'session' });
  expect(policyOf(f)).toMatchObject({
    gate_on_fail: 'retry',
    gate_runner: 'session',
    policy_version: 1,
  });
  expect(changes(f).map((event) => event.payload)).toEqual([
    { param: 'gate_on_fail', from: 'handback', to: 'retry', by: 'user', policy_version: 1 },
    { param: 'gate_runner', from: 'daemon', to: 'session', by: 'user', policy_version: 1 },
  ]);
});

it('leaves the version and events alone when the input matches the project settings', async () => {
  const f = await opened();
  set(f, { gate_on_fail: 'stop', gate_runner: 'daemon' });
  set(f, { gate_on_fail: 'stop' });
  set(f, { gate_on_fail: 'stop', gate_runner: 'daemon' });
  expect(policyOf(f).policy_version).toBe(1);
  expect(changes(f)).toHaveLength(2);
});

it('stores a value equal to the one it follows as the project setting', async () => {
  const f = await opened();
  set(f, { gate_on_fail: 'handback', gate_runner: 'daemon' });
  expect(f.store.get<WorkflowPolicy>('workflow_policies', f.project.id)?.overridden).toEqual([
    'gate_on_fail',
    'gate_runner',
  ]);
  expect(changes(f).map((event) => event.payload)).toMatchObject([
    { param: 'gate_on_fail', from: 'handback', to: 'handback' },
    { param: 'gate_runner', from: 'daemon', to: 'daemon' },
  ]);
});

it('reads a stored policy that still holds removed settings without them, and saves another parameter', async () => {
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
    question_defaults: { after_hours: 8 },
    gate_on_fail: 'retry',
    pinned: [],
    overridden: [
      'improvement_mode',
      'eval_runner',
      'max_parallel',
      'question_defaults',
      'gate_on_fail',
    ],
  };
  f.store.transaction(() =>
    f.store.insert<WorkflowPolicy>('workflow_policies', stored as unknown as WorkflowPolicy),
  );
  const removed = [
    'improvement_mode',
    'eval_runner',
    'plan_changes',
    'max_parallel',
    'budget',
    'question_defaults',
  ];
  const read = f.control.workflowPolicy(user, f.project.id);
  expect(read).toMatchObject({ gate_on_fail: 'retry', policy_version: 1 });
  for (const key of removed) expect(read).not.toHaveProperty(key);
  set(f, { gate_on_fail: 'stop' });
  const after = f.store.get<WorkflowPolicy>('workflow_policies', f.project.id)!;
  expect(after).toMatchObject({
    gate_on_fail: 'stop',
    policy_version: 2,
    overridden: ['gate_on_fail'],
  });
  for (const key of removed) expect(after).not.toHaveProperty(key);
  expect(changes(f).map((event) => event.payload)).toEqual([
    { param: 'gate_on_fail', from: 'retry', to: 'stop', by: 'user', policy_version: 2 },
  ]);
});

it('refuses a writer session that tries to change the policy', async () => {
  const f = await opened();
  const writer: Principal = {
    id: 'session:writer',
    role: 'writer',
    project_id: f.project.id,
    session_id: 'writer',
    expires_at: f.store.now() + 60000,
  };
  expect(refused(() => set(f, { gate_on_fail: 'stop' }, writer))).toBe('permission_denied');
  expect(f.store.get('workflow_policies', f.project.id)).toBeUndefined();
});

it('stores and reads back the pinned parameters', async () => {
  const f = await opened();
  set(f, { pinned: ['runtime_quota_threshold'] });
  expect(policyOf(f).pinned).toEqual(['runtime_quota_threshold']);
  set(f, { pinned: [] });
  expect(policyOf(f)).toMatchObject({ pinned: [], policy_version: 2 });
});

it('resets a changed policy to the defaults exposed by the query at the current revision', async () => {
  const f = await opened();
  const initial = f.control.workflowPolicy(user, f.project.id);
  expect(initial.gate_on_fail).toBe(initial.defaults.gate_on_fail);
  set(f, {
    gate_on_fail: 'stop',
    project_budget: { input_tokens: 1000 },
    pinned: ['runtime_quota_threshold'],
  });
  const changed = f.control.workflowPolicy(user, f.project.id);
  expect(changed.gate_on_fail).not.toBe(changed.defaults.gate_on_fail);
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
