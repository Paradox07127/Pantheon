import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type {
  AgentEvent,
  Approval,
  Project,
  Retrospective,
  Session,
  WorkflowPolicy,
} from '@pantheon/domain';
import type { ProjectDefaultsRead } from '@pantheon/protocol';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { requestApproval } from '../../packages/control/dist/approvals.js';
import { improvementSignals } from '../../packages/control/dist/improvement-signals.js';
import { usageTargets } from '../../packages/control/dist/user-config.js';
import { fixture, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function configDirectory() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-project-defaults-'));
  cleanups.push(async () => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, '.pantheon');
  mkdirSync(dir);
  writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ version: 1, model_families: { 'fixture-': 'fixture' } }),
  );
  return dir;
}

function defaultsFixture() {
  const dir = configDirectory();
  const f = fixture({ managedWorkspaces: true, controlOptions: { userConfigDir: dir } });
  cleanups.push(f.close);
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const current = () => f.store.must<Project>('projects', f.project.id);
  const policy = () => f.control.workflowPolicy(user, f.project.id);
  const storedPolicy = () => f.store.get<WorkflowPolicy>('workflow_policies', f.project.id);
  const mergePolicy = () =>
    f.control
      .workflowDefinition(user, f.project.id)
      .fixed_steps.find((step) => step.id === 'merge')!.policy.auto_merge;
  const externalMode = () => f.control.externalRead(user, f.project.id).mode;
  const setGlobal = (key: string, value: unknown) =>
    f.call<ProjectDefaultsRead>('project.defaults.set', { key, value });
  return { ...f, dir, ctx, current, policy, storedPolicy, mergePolicy, externalMode, setGlobal };
}

it('follows the global values where a project has none of its own', () => {
  const f = defaultsFixture();
  f.setGlobal('workflow_policy', { max_parallel: 2, gate_on_fail: 'stop' });
  f.setGlobal('session_defaults', {
    runtime: 'fixture',
    permission_mode: 'plan',
    model: 'fixture-large',
    effort: 'low',
  });
  f.setGlobal('usage_targets', { fixture: 500 });
  f.setGlobal('external_events', 'approve');
  f.setGlobal('auto_merge', true);
  expect(JSON.parse(readFileSync(path.join(f.dir, 'config.json'), 'utf8'))).toMatchObject({
    model_families: { 'fixture-': 'fixture' },
    project_defaults: { auto_merge: true, external_events: 'approve' },
  });
  expect(f.policy()).toMatchObject({ max_parallel: 2, gate_on_fail: 'stop', policy_version: 0 });
  expect(f.policy().defaults).toMatchObject({ max_parallel: 2, gate_on_fail: 'stop' });
  expect(usageTargets(f.ctx, f.current())).toEqual({ fixture: 500 });
  expect(f.externalMode()).toBe('approve');
  expect(f.mergePolicy()).toBe(true);
  const { session_ids } = f.call<{ session_ids: string[] }>('board.sync', {
    project_id: f.project.id,
  });
  expect(f.store.must<Session>('sessions', session_ids[0]!)).toMatchObject({
    runtime: 'fixture',
    permission_mode: 'plan',
    requested_model: 'fixture-large',
    requested_effort: 'low',
  });
});

it('reads the project value over the global one, also when it equals the built-in default', () => {
  const f = defaultsFixture();
  f.setGlobal('workflow_policy', { max_parallel: 2 });
  f.setGlobal('usage_targets', { fixture: 500, claude: 900 });
  f.setGlobal('external_events', 'approve');
  f.setGlobal('auto_merge', true);
  f.call('workflow.policy.set', { project_id: f.project.id, max_parallel: 2 }, null);
  f.call(
    'project.usageTargets.set',
    {
      project_id: f.project.id,
      targets: { fixture: 100 },
    },
    f.current().revision,
  );
  f.call(
    'project.externalEvents.set',
    { project_id: f.project.id, mode: 'off' },
    f.current().revision,
  );
  f.call(
    'project.autoMerge.set',
    { project_id: f.project.id, enabled: false },
    f.current().revision,
  );
  expect(f.current()).toMatchObject({ auto_merge: false, external_events: 'off' });
  expect(f.policy().max_parallel).toBe(2);
  expect(usageTargets(f.ctx, f.current())).toEqual({ fixture: 100, claude: 900 });
  expect(f.externalMode()).toBeUndefined();
  expect(f.mergePolicy()).toBe(false);
  // A value set equal to the global one stays the project's own when the global one changes.
  f.setGlobal('workflow_policy', { max_parallel: 1, acceptance_wake: 'milestone' });
  expect(f.policy()).toMatchObject({ max_parallel: 2, acceptance_wake: 'milestone' });
});

it('returns a project to the global value once its own value is cleared', () => {
  const f = defaultsFixture();
  f.setGlobal('workflow_policy', { max_parallel: 2, task_size_hint: 6 });
  f.setGlobal('session_defaults', { runtime: 'fixture', permission_mode: 'plan' });
  f.setGlobal('external_events', 'auto');
  f.setGlobal('auto_merge', true);
  f.call('workflow.policy.set', {
    project_id: f.project.id,
    max_parallel: 1,
    task_size_hint: 3,
  });
  f.call(
    'project.sessionDefaults.set',
    {
      project_id: f.project.id,
      runtime: 'fixture',
      permission_mode: 'ask',
    },
    f.current().revision,
  );
  f.call(
    'project.externalEvents.set',
    { project_id: f.project.id, mode: 'off' },
    f.current().revision,
  );
  f.call(
    'project.autoMerge.set',
    { project_id: f.project.id, enabled: false },
    f.current().revision,
  );
  f.call(
    'workflow.policy.set',
    { project_id: f.project.id, task_size_hint: null },
    f.storedPolicy()!.revision,
  );
  expect(f.policy()).toMatchObject({ max_parallel: 1, task_size_hint: 6 });
  for (const key of ['session_defaults', 'external_events', 'auto_merge'])
    f.call('project.override.clear', { project_id: f.project.id, key }, f.current().revision);
  expect(f.current()).not.toHaveProperty('session_defaults');
  expect(f.current()).not.toHaveProperty('external_events');
  expect(f.current()).not.toHaveProperty('auto_merge');
  expect(f.externalMode()).toBe('auto');
  expect(f.mergePolicy()).toBe(true);
  expect(() =>
    f.call('project.override.clear', { project_id: f.project.id, key: 'workflow_policy' }, null),
  ).toThrowError(expect.objectContaining({ code: 'revision_conflict' }));
  f.call(
    'project.override.clear',
    { project_id: f.project.id, key: 'workflow_policy' },
    f.storedPolicy()!.revision,
  );
  expect(f.policy()).toMatchObject({ max_parallel: 2, task_size_hint: 6 });
  f.setGlobal('workflow_policy', { max_parallel: 3 });
  expect(f.policy().max_parallel).toBe(3);
  expect(f.policy()).not.toHaveProperty('task_size_hint');
  f.call(
    'project.sessionDefaults.set',
    {
      project_id: f.project.id,
      runtime: 'fixture',
      permission_mode: 'ask',
    },
    f.current().revision,
  );
  f.call('project.sessionDefaults.clear', { project_id: f.project.id }, f.current().revision);
  const { session_ids } = f.call<{ session_ids: string[] }>('board.sync', {
    project_id: f.project.id,
  });
  expect(f.store.must<Session>('sessions', session_ids[0]!).permission_mode).toBe('plan');
  f.call(
    'workflow.policy.set',
    { project_id: f.project.id, max_parallel: 1 },
    f.storedPolicy()!.revision,
  );
  f.call('workflow.policy.reset', { project_id: f.project.id }, f.storedPolicy()!.revision);
  expect(f.policy().max_parallel).toBe(3);
  f.call('project.defaults.clear', { key: 'workflow_policy' });
  expect(f.policy().max_parallel).toBe(3);
  expect(f.policy().defaults.max_parallel).toBe(3);
});

it('clears one workflow setting of a project and keeps its other own settings', () => {
  const f = defaultsFixture();
  f.setGlobal('workflow_policy', { max_parallel: 2, task_size_hint: 6 });
  f.call('workflow.policy.set', { project_id: f.project.id, max_parallel: 1, task_size_hint: 3 });
  f.call(
    'project.override.clear',
    { project_id: f.project.id, key: 'workflow_policy', param: 'max_parallel' },
    f.storedPolicy()!.revision,
  );
  expect(f.policy()).toMatchObject({ max_parallel: 2, task_size_hint: 3 });
  expect(f.storedPolicy()!.overridden).toEqual(['task_size_hint']);
  expect(() =>
    f.call(
      'project.override.clear',
      { project_id: f.project.id, key: 'auto_merge', param: 'max_parallel' },
      f.current().revision,
    ),
  ).toThrowError(expect.objectContaining({ code: 'invalid_input' }));
});

it('records a change of the global workflow settings and reads the hand-back limit a task started under from it', () => {
  const f = defaultsFixture();
  const retro = (id: string, started_at: number) =>
    f.store.insert<Retrospective>('retrospectives', {
      id,
      revision: 1,
      project_id: f.project.id,
      lead_session_id: 'lead',
      task_id: id,
      session_ids: [],
      outcome: 'merged',
      recorded_at: started_at + 1,
      started_at,
      policy_version: 0,
      handbacks: Array.from({ length: 3 }, () => ({ reason: 'gate_failed' })),
    });
  const before = f.store.now() - 1000;
  f.setGlobal('workflow_policy', { handback_limit: 5 });
  expect(f.store.kindEvents('', ['workflow.policy_changed']).map((e) => e.payload)).toEqual([
    { param: 'handback_limit', from: 3, to: 5, by: 'global' },
  ]);
  retro('started-before', before);
  retro('started-after', f.store.now() + 1000);
  expect(
    improvementSignals(f.ctx, f.project.id).filter((s) => s.signal === 'handback_loop'),
  ).toEqual([{ signal: 'handback_loop', retrospective_ids: ['started-before'] }]);
});

it('refuses global values that are invalid alone or under a project value, and non-user callers', () => {
  const f = defaultsFixture();
  f.call('workflow.policy.set', { project_id: f.project.id, max_parallel: 2 });
  expect(() => f.setGlobal('workflow_policy', { max_parallel: 5 })).toThrowError(
    expect.objectContaining({ code: 'invalid_input' }),
  );
  expect(() => f.setGlobal('workflow_policy', { max_parallel: 1, max_parallel_limit: 1 })).toThrow(
    'in project fixture',
  );
  expect(() =>
    f.setGlobal('session_defaults', { runtime: 'unknown-runtime', permission_mode: 'ask' }),
  ).toThrowError(expect.objectContaining({ code: 'invalid_input' }));
  expect(() =>
    f.call('project.defaults.set', { key: 'auto_merge', value: true }, null, {
      id: 'agent',
      role: 'planner',
    }),
  ).toThrowError(expect.objectContaining({ code: 'permission_denied' }));
  expect(JSON.parse(readFileSync(path.join(f.dir, 'config.json'), 'utf8'))).not.toHaveProperty(
    'project_defaults',
  );
});

it('lists each global value, built-in default and the projects that set their own', () => {
  const f = defaultsFixture();
  const otherRoot = path.join(f.root, 'other');
  mkdirSync(otherRoot);
  const other = f.call<Project>('project.open', { name: 'other', roots: [otherRoot] });
  f.setGlobal('auto_merge', true);
  f.call('project.autoMerge.set', { project_id: other.id, enabled: false }, other.revision);
  f.call('workflow.policy.set', { project_id: other.id, max_parallel: 2 });
  f.call(
    'project.usageTargets.set',
    {
      project_id: f.project.id,
      targets: { fixture: 10 },
    },
    f.current().revision,
  );
  const read = f.control.projectDefaults(user);
  const setting = (key: string) => read.settings.find((entry) => entry.key === key)!;
  expect(read.settings.map((entry) => entry.key)).toEqual([
    'workflow_policy',
    'session_defaults',
    'usage_targets',
    'external_events',
    'auto_merge',
  ]);
  expect(setting('auto_merge')).toEqual({
    key: 'auto_merge',
    global: true,
    builtin: false,
    overrides: [{ project_id: other.id, name: 'other', value: false }],
  });
  expect(setting('workflow_policy')).toMatchObject({
    builtin: { max_parallel: 3 },
    overrides: [{ project_id: other.id, name: 'other', value: { max_parallel: 2 } }],
  });
  expect(setting('workflow_policy')).not.toHaveProperty('global');
  expect(setting('session_defaults')).toEqual({ key: 'session_defaults', overrides: [] });
  expect(setting('usage_targets')).toEqual({
    key: 'usage_targets',
    builtin: {},
    overrides: [{ project_id: f.project.id, name: 'fixture', value: { fixture: 10 } }],
  });
  expect(setting('external_events')).toEqual({
    key: 'external_events',
    builtin: 'off',
    overrides: [],
  });
  expect(read.projects.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
    { project_id: f.project.id, name: 'fixture', overridden: 1 },
    { project_id: other.id, name: 'other', overridden: 2 },
  ]);
  expect(read.permission_rules).toEqual([]);
});

it('keeps a policy stored before global values as the project value, and absent fields follow the global ones', () => {
  const f = defaultsFixture();
  const otherRoot = path.join(f.root, 'other');
  mkdirSync(otherRoot);
  const other = f.call<Project>('project.open', { name: 'other', roots: [otherRoot] });
  // A policy as a set wrote it before global values: every setting stored, none marked as its own.
  f.store.transaction(() =>
    f.store.insert<WorkflowPolicy>('workflow_policies', {
      id: other.id,
      revision: 1,
      project_id: other.id,
      policy_version: 1,
      improvement_mode: 'auto',
      path: { t1: 'direct', t2: 'dispatch', t3: 'dispatch' },
      acceptance_wake: 'each_merge',
      max_parallel: 3,
      max_parallel_limit: 3,
      handback_limit: 3,
      budget: {},
      pinned: [],
    }),
  );
  f.setGlobal('workflow_policy', { max_parallel: 1, gate_runner: 'session' });
  f.setGlobal('auto_merge', true);
  expect(f.control.workflowPolicy(user, other.id)).toMatchObject({
    max_parallel: 3,
    gate_runner: 'session',
  });
  expect(
    f.control.workflowDefinition(user, other.id).fixed_steps.find((s) => s.id === 'merge'),
  ).toMatchObject({ policy: { auto_merge: true } });
  const listed = f.control
    .projectDefaults(user)
    .settings.find((entry) => entry.key === 'workflow_policy')!.overrides;
  expect(listed).toEqual([
    {
      project_id: other.id,
      name: 'other',
      value: expect.objectContaining({ max_parallel: 3, budget: {} }),
    },
  ]);
  expect(listed[0]!.value).not.toHaveProperty('gate_runner');
});

it('answers matching requests in every project by the global rules besides the project ones', () => {
  const f = workbenchFixture();
  const dir = configDirectory();
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  (ctx as { userConfigDir?: string }).userConfigDir = dir;
  const session = f.create();
  const otherRoot = path.join(f.root, 'other');
  mkdirSync(otherRoot);
  const other = f.call<Project>('project.open', { name: 'other', roots: [otherRoot] });
  const request = (target: Session, request_id: string, rule: string) => {
    const event: Extract<AgentEvent, { kind: 'permission.requested' }> = {
      key: request_id,
      provider_sequence: 1,
      kind: 'permission.requested',
      request_id,
      tool: 'Bash',
      rule,
      project_rule_supported: true,
      detail: { input: { command: 'pnpm test' } },
    };
    f.store.transaction(() => requestApproval(ctx, target, event));
    return f.store.list<Approval>('approvals').at(-1)!;
  };
  const elsewhere = { ...session, id: 'session-of-other-project', project_id: other.id };
  expect(() =>
    f.call('permission.globalRule.add', { rule: 'Bash(pnpm test)' }, null, {
      id: 'agent',
      role: 'planner',
    }),
  ).toThrowError(expect.objectContaining({ code: 'permission_denied' }));
  expect(f.call('permission.globalRule.add', { rule: 'Bash(pnpm test)' })).toEqual([
    { rule: 'Bash(pnpm test)', added_at: expect.any(Number) },
  ]);
  f.call('permission.globalRule.add', { rule: 'Bash(pnpm test)' });
  f.call('permission.rule.add', {
    project_id: f.project.id,
    rule: 'Bash(pnpm lint)',
    session_id: session.id,
  });
  f.call('permission.rule.add', {
    project_id: f.project.id,
    rule: 'Bash(pnpm test)',
    session_id: session.id,
  });
  expect(request(session, 'global-here', 'Bash(pnpm test)')).toMatchObject({
    state: 'approved',
    answered_by_rule: 'Bash(pnpm test)',
  });
  expect(request(elsewhere, 'global-elsewhere', 'Bash(pnpm test)')).toMatchObject({
    state: 'approved',
    answered_by_rule: 'Bash(pnpm test)',
  });
  expect(request(session, 'project-here', 'Bash(pnpm lint)')).toMatchObject({
    state: 'approved',
  });
  expect(request(elsewhere, 'project-elsewhere', 'Bash(pnpm lint)').state).toBe('pending');
  expect(f.control.projectDefaults(user).permission_rules).toEqual([
    { rule: 'Bash(pnpm test)', added_at: expect.any(Number) },
  ]);
  expect(f.control.permissionRules(user, f.project.id).map((entry) => entry.rule)).toEqual([
    'Bash(pnpm test)',
    'Bash(pnpm lint)',
  ]);
  expect(f.call('permission.globalRule.remove', { rule: 'Bash(pnpm test)' })).toEqual([]);
  // The project's own copy of the rule still answers there.
  expect(request(session, 'project-after', 'Bash(pnpm test)').state).toBe('approved');
  expect(request(elsewhere, 'elsewhere-after', 'Bash(pnpm test)').state).toBe('pending');
});
