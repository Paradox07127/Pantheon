import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { AgentEvent, Approval, Project, Session, WorkflowPolicy } from '@pantheon/domain';
import { RETIRED_POLICY_SETTINGS, type ProjectDefaultsRead } from '@pantheon/protocol';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { requestApproval } from '../../packages/control/dist/approvals.js';
import { sessionDefaults } from '../../packages/control/dist/user-config.js';
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

async function defaultsFixture() {
  const dir = configDirectory();
  const f = await fixture({ managedWorkspaces: true, controlOptions: { userConfigDir: dir } });
  cleanups.push(f.close);
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const current = () => f.store.must<Project>('projects', f.project.id);
  const policy = () => f.control.workflowPolicy(user, f.project.id);
  const storedPolicy = () => f.store.get<WorkflowPolicy>('workflow_policies', f.project.id);
  const setGlobal = (key: string, value: unknown) =>
    f.call<ProjectDefaultsRead>('project.defaults.set', { key, value });
  return { ...f, dir, ctx, current, policy, storedPolicy, setGlobal };
}

it('follows the global values where a project has none of its own', async () => {
  const f = await defaultsFixture();
  f.setGlobal('workflow_policy', { gate_on_fail: 'stop', gate_runner: 'session' });
  f.setGlobal('session_defaults', {
    runtime: 'fixture',
    permission_mode: 'plan',
    model: 'fixture-large',
    effort: 'low',
  });
  expect(JSON.parse(readFileSync(path.join(f.dir, 'config.json'), 'utf8'))).toMatchObject({
    model_families: { 'fixture-': 'fixture' },
    project_defaults: { workflow_policy: { gate_on_fail: 'stop', gate_runner: 'session' } },
  });
  expect(f.policy()).toMatchObject({
    gate_on_fail: 'stop',
    gate_runner: 'session',
    policy_version: 0,
  });
  expect(f.policy().defaults).toMatchObject({ gate_on_fail: 'stop', gate_runner: 'session' });
  expect(sessionDefaults(f.ctx, f.current())?.permission_mode).toBe('plan');
});

it('reads the project value over the global one, also when it equals the built-in default', async () => {
  const f = await defaultsFixture();
  f.setGlobal('workflow_policy', { gate_on_fail: 'stop', gate_runner: 'session' });
  f.call(
    'workflow.policy.set',
    { project_id: f.project.id, gate_on_fail: 'stop', gate_runner: 'daemon' },
    null,
  );
  expect(f.policy()).toMatchObject({ gate_on_fail: 'stop', gate_runner: 'daemon' });
  // A value set equal to the global one stays the project's own when the global one changes.
  f.setGlobal('workflow_policy', { gate_on_fail: 'retry', gate_runner: 'session' });
  expect(f.policy()).toMatchObject({ gate_on_fail: 'stop', gate_runner: 'daemon' });
});

it('returns a project to the global value once its own value is cleared', async () => {
  const f = await defaultsFixture();
  f.setGlobal('workflow_policy', { gate_on_fail: 'stop', gate_runner: 'session' });
  f.setGlobal('session_defaults', { runtime: 'fixture', permission_mode: 'plan' });
  f.call('workflow.policy.set', {
    project_id: f.project.id,
    gate_on_fail: 'retry',
    gate_runner: 'daemon',
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
  expect(f.policy()).toMatchObject({ gate_on_fail: 'retry', gate_runner: 'daemon' });
  f.call(
    'project.override.clear',
    { project_id: f.project.id, key: 'session_defaults' },
    f.current().revision,
  );
  expect(f.current()).not.toHaveProperty('session_defaults');
  expect(() =>
    f.call('project.override.clear', { project_id: f.project.id, key: 'workflow_policy' }, null),
  ).toThrowError(expect.objectContaining({ code: 'revision_conflict' }));
  f.call(
    'project.override.clear',
    { project_id: f.project.id, key: 'workflow_policy' },
    f.storedPolicy()!.revision,
  );
  expect(f.policy()).toMatchObject({ gate_on_fail: 'stop', gate_runner: 'session' });
  f.setGlobal('workflow_policy', { gate_on_fail: 'retry' });
  expect(f.policy()).toMatchObject({ gate_on_fail: 'retry', gate_runner: 'daemon' });
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
  expect(sessionDefaults(f.ctx, f.current())?.permission_mode).toBe('plan');
  f.call(
    'workflow.policy.set',
    { project_id: f.project.id, gate_on_fail: 'stop' },
    f.storedPolicy()!.revision,
  );
  f.call('workflow.policy.reset', { project_id: f.project.id }, f.storedPolicy()!.revision);
  expect(f.policy().gate_on_fail).toBe('retry');
  f.call('project.defaults.clear', { key: 'workflow_policy' });
  expect(f.policy().gate_on_fail).toBe('stop');
  expect(f.policy().defaults.gate_on_fail).toBe('stop');
});

it('clears one workflow setting of a project and keeps its other own settings', async () => {
  const f = await defaultsFixture();
  f.setGlobal('workflow_policy', { gate_on_fail: 'stop', gate_runner: 'session' });
  f.call('workflow.policy.set', {
    project_id: f.project.id,
    gate_on_fail: 'retry',
    gate_runner: 'daemon',
  });
  f.call(
    'project.override.clear',
    { project_id: f.project.id, key: 'workflow_policy', param: 'gate_on_fail' },
    f.storedPolicy()!.revision,
  );
  expect(f.policy()).toMatchObject({ gate_on_fail: 'stop', gate_runner: 'daemon' });
  expect(f.storedPolicy()!.overridden).toEqual(['gate_runner']);
  expect(() =>
    f.call(
      'project.override.clear',
      { project_id: f.project.id, key: 'session_defaults', param: 'gate_on_fail' },
      f.current().revision,
    ),
  ).toThrowError(expect.objectContaining({ code: 'invalid_input' }));
});

it('reads a configuration file whose global workflow settings still hold removed ones without them', async () => {
  const f = await defaultsFixture();
  const file = path.join(f.dir, 'config.json');
  const removed = Object.fromEntries(RETIRED_POLICY_SETTINGS.map((key) => [key, 1]));
  writeFileSync(
    file,
    JSON.stringify({
      ...JSON.parse(readFileSync(file, 'utf8')),
      project_defaults: {
        workflow_policy: { gate_on_fail: 'handback', ...removed },
        external_events: 'approve',
        usage_targets: { fixture: 500 },
      },
    }),
  );
  expect(f.policy()).toMatchObject({ gate_on_fail: 'stop' });
  for (const key of RETIRED_POLICY_SETTINGS) {
    expect(f.policy()).not.toHaveProperty(key);
    expect(f.policy().defaults).not.toHaveProperty(key);
  }
  const global = () =>
    f.control.projectDefaults(user).settings.find((entry) => entry.key === 'workflow_policy')
      ?.global;
  expect(global()).toEqual({ gate_on_fail: 'stop' });
  f.setGlobal('session_defaults', { runtime: 'fixture', permission_mode: 'ask' });
  expect(global()).toEqual({ gate_on_fail: 'stop' });
  expect(f.control.projectDefaults(user).settings.map((entry) => entry.key)).toEqual([
    'workflow_policy',
    'session_defaults',
  ]);
});

it('reads pinned parameters that are no longer settings, globally and on a project, without them', async () => {
  const f = await defaultsFixture();
  const file = path.join(f.dir, 'config.json');
  writeFileSync(
    file,
    JSON.stringify({
      ...JSON.parse(readFileSync(file, 'utf8')),
      project_defaults: { workflow_policy: { gate_on_fail: 'stop', pinned: ['path'] } },
    }),
  );
  expect(f.policy()).toMatchObject({ gate_on_fail: 'stop' });
  expect(f.policy().defaults).not.toHaveProperty('pinned');
  f.store.transaction(() =>
    f.store.insert<WorkflowPolicy>('workflow_policies', {
      id: f.project.id,
      revision: 1,
      project_id: f.project.id,
      policy_version: 1,
      gate_on_fail: 'retry',
      pinned: ['max_parallel'],
    } as unknown as WorkflowPolicy),
  );
  expect(f.policy()).not.toHaveProperty('pinned');
  f.call(
    'workflow.policy.set',
    { project_id: f.project.id, gate_runner: 'session' },
    f.storedPolicy()!.revision,
  );
  expect(f.policy()).toMatchObject({ gate_on_fail: 'retry', gate_runner: 'session' });
});

it('records a change of the global workflow settings', async () => {
  const f = await defaultsFixture();
  f.setGlobal('workflow_policy', { gate_on_fail: 'retry' });
  expect(f.store.kindEvents('', ['workflow.policy_changed']).map((e) => e.payload)).toEqual([
    { param: 'gate_on_fail', from: 'stop', to: 'retry', by: 'global' },
  ]);
});

it('refuses global values that are invalid, and non-user callers', async () => {
  const f = await defaultsFixture();
  f.call('workflow.policy.set', { project_id: f.project.id, gate_on_fail: 'stop' });
  expect(() => f.setGlobal('workflow_policy', { gate_on_fail: 'handback' })).toThrowError(
    expect.objectContaining({ name: 'ZodError' }),
  );
  expect(() =>
    f.setGlobal('session_defaults', { runtime: 'unknown-runtime', permission_mode: 'ask' }),
  ).toThrowError(expect.objectContaining({ code: 'invalid_input' }));
  expect(() =>
    f.call(
      'project.defaults.set',
      { key: 'workflow_policy', value: { gate_on_fail: 'stop' } },
      null,
      {
        id: 'agent',
        role: 'planner',
      },
    ),
  ).toThrowError(expect.objectContaining({ code: 'permission_denied' }));
  expect(JSON.parse(readFileSync(path.join(f.dir, 'config.json'), 'utf8'))).not.toHaveProperty(
    'project_defaults',
  );
});

it('lists each global value, built-in default and the projects that set their own', async () => {
  const f = await defaultsFixture();
  const otherRoot = path.join(f.root, 'other');
  mkdirSync(otherRoot);
  const other = await f.call<Project>('project.open', { name: 'other', roots: [otherRoot] });
  f.call('workflow.policy.set', { project_id: other.id, gate_on_fail: 'retry' });
  f.call(
    'project.sessionDefaults.set',
    { project_id: f.project.id, runtime: 'fixture', permission_mode: 'ask' },
    f.current().revision,
  );
  const read = f.control.projectDefaults(user);
  const setting = (key: string) => read.settings.find((entry) => entry.key === key)!;
  expect(read.settings.map((entry) => entry.key)).toEqual(['workflow_policy', 'session_defaults']);
  expect(setting('workflow_policy')).toMatchObject({
    builtin: { gate_on_fail: 'stop' },
    overrides: [{ project_id: other.id, name: 'other', value: { gate_on_fail: 'retry' } }],
  });
  expect(setting('workflow_policy')).not.toHaveProperty('global');
  expect(setting('session_defaults')).toEqual({
    key: 'session_defaults',
    overrides: [
      {
        project_id: f.project.id,
        name: 'fixture',
        value: { runtime: 'fixture', permission_mode: 'ask' },
      },
    ],
  });
  expect(read.projects.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
    { project_id: f.project.id, name: 'fixture', overridden: 1 },
    { project_id: other.id, name: 'other', overridden: 1 },
  ]);
  expect(read.permission_rules).toEqual([]);
});

it('keeps a policy stored before global values as the project value, and absent fields follow the global ones', async () => {
  const f = await defaultsFixture();
  const otherRoot = path.join(f.root, 'other');
  mkdirSync(otherRoot);
  const other = await f.call<Project>('project.open', { name: 'other', roots: [otherRoot] });
  // A policy as a set wrote it before global values: every setting stored, none marked as its own.
  f.store.transaction(() =>
    f.store.insert<WorkflowPolicy>('workflow_policies', {
      id: other.id,
      revision: 1,
      project_id: other.id,
      policy_version: 1,
      runtime_quota_threshold: 90,
      gate_on_fail: 'handback',
      pinned: [],
    } as unknown as WorkflowPolicy),
  );
  f.setGlobal('workflow_policy', { gate_on_fail: 'retry', gate_runner: 'session' });
  expect(f.control.workflowPolicy(user, other.id)).toMatchObject({
    gate_on_fail: 'stop',
    gate_runner: 'session',
  });
  const listed = f.control
    .projectDefaults(user)
    .settings.find((entry) => entry.key === 'workflow_policy')!.overrides;
  expect(listed).toEqual([
    {
      project_id: other.id,
      name: 'other',
      value: { gate_on_fail: 'stop' },
    },
  ]);
});

it('answers matching requests in every project by the global rules besides the project ones', async () => {
  const f = await workbenchFixture();
  const dir = configDirectory();
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  (ctx as { userConfigDir?: string }).userConfigDir = dir;
  const session = await f.create();
  const otherRoot = path.join(f.root, 'other');
  mkdirSync(otherRoot);
  const other = await f.call<Project>('project.open', { name: 'other', roots: [otherRoot] });
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
