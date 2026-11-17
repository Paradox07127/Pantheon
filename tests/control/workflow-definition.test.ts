import { afterEach, expect, it } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import { type ExtensionInventory, type Principal, type Project } from '@pantheon/domain';
import { fixture, user } from '../helpers.js';

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
const opened = async () => {
  const f = await fixture();
  fixtures.push(f);
  return f;
};
const empty = () => ({
  slots: { before_dispatch: [], before_merge: [], after_merge: [] },
  plan_review: { tiers: ['t3'] },
  review: { max_rounds: 3 },
});

it('stores and versions definitions, refuses stale writes, and projects the fixed path', async () => {
  const f = await opened();
  const set = (base_version: number, definition = empty()) =>
    f.call('workflow.definition.set', { project_id: f.project.id, definition, base_version });
  expect(set(0)).toMatchObject({ definition_version: 1 });
  expect(() => set(0)).toThrowError(expect.objectContaining({ code: 'version_conflict' }));
  const next = empty();
  next.review.max_rounds = 5;
  expect(set(1, next)).toMatchObject({ definition_version: 2 });
  const view = f.control.workflowDefinition(user, f.project.id);
  expect(view).toMatchObject({ definition: next, definition_version: 2 });
  expect(view.fixed_steps.map((step) => step.id)).toEqual([
    'plan',
    'plan_review',
    'dispatch',
    'build',
    'gate',
    'merge',
    'handback',
    'wake',
    'review',
    'acceptance',
  ]);
  expect(view.fixed_steps.find((step) => step.id === 'dispatch')?.policy).toMatchObject({
    max_parallel: 3,
    path: { t1: 'direct' },
  });
});

it('allows only the user to store a definition, with prompt and review steps where they have a task to work on', async () => {
  const f = await opened();
  const lead: Principal = {
    id: 'session:lead',
    role: 'lead',
    project_id: f.project.id,
    session_id: 'lead',
  };
  expect(() =>
    f.call(
      'workflow.definition.set',
      { project_id: f.project.id, definition: empty(), base_version: 0 },
      null,
      lead,
    ),
  ).toThrowError(expect.objectContaining({ code: 'permission_denied' }));
  const set = (slot: string, kind: object, base_version: number) =>
    f.call('workflow.definition.set', {
      project_id: f.project.id,
      definition: {
        ...empty(),
        slots: { ...empty().slots, [slot]: [{ id: 'check', title: 'Check it', kind }] },
      },
      base_version,
    });
  for (const [slot, kind] of [
    ['before_dispatch', { type: 'review', blocking: true }],
    ['before_dispatch', { type: 'prompt', prompt: 'Check it' }],
    ['after_merge', { type: 'prompt', prompt: 'Check it', target: 'task' }],
  ] as const)
    expect(() => set(slot, kind, 0)).toThrowError(
      expect.objectContaining({ code: 'invalid_input', message: expect.stringContaining(slot) }),
    );
  expect(f.store.get('workflow_definitions', f.project.id)).toBeUndefined();
  let version = 0;
  for (const [slot, kind] of [
    ['before_dispatch', { type: 'prompt', prompt: 'Check it', target: 'lead' }],
    ['before_merge', { type: 'prompt', prompt: 'Check it', target: 'task' }],
    ['before_merge', { type: 'review', blocking: true }],
    ['after_merge', { type: 'review', runtime: 'reviewer' }],
    ['after_merge', { type: 'prompt', prompt: 'Check it', target: 'lead' }],
  ] as const)
    expect(set(slot, kind, version++)).toMatchObject({ definition_version: version });
});

const inventory = (skills: ExtensionInventory['skills']): ExtensionInventory => ({
  runtime: 'fixture',
  mcp_servers: [],
  plugins: [],
  skills,
  apps: false,
  connectors: [],
  hooks: [],
});
const withSkill = (skill: { name: string; path: string }) => ({
  ...empty(),
  slots: {
    ...empty().slots,
    before_merge: [
      { id: 'tidy', title: 'Tidy up', kind: { type: 'prompt', prompt: 'Tidy it', skill } },
    ],
  },
});

it("checks a prompt step's skill against the runtimes' inventories and the project's disabled skills", async () => {
  const f = await opened();
  const adapter = f.adapter as FixtureAdapter & {
    inventory?: () => Promise<ExtensionInventory>;
  };
  adapter.inventory = async () =>
    inventory([
      { id: 'simplify', name: 'simplify', enabled: true, path: '/skills/simplify/SKILL.md' },
      { id: 'release-notes', name: 'release-notes', enabled: true, path: '/skills/notes/SKILL.md' },
    ]);
  const set = (skill: { name: string; path: string }) =>
    f.call('workflow.definition.set', {
      project_id: f.project.id,
      definition: withSkill(skill),
      base_version: 0,
    });
  await expect(set({ name: 'unknown', path: '/skills/unknown/SKILL.md' })).rejects.toMatchObject({
    code: 'skill_unavailable',
  });
  f.call(
    'project.extensions.set',
    {
      project_id: f.project.id,
      runtime: 'fixture',
      overrides: {
        disabled_mcp_servers: [],
        disabled_plugins: [],
        disabled_skills: ['release-notes'],
        disable_apps: false,
        disable_hooks: false,
      },
    },
    f.store.must<Project>('projects', f.project.id).revision,
  );
  await expect(
    set({ name: 'release-notes', path: '/skills/notes/SKILL.md' }),
  ).rejects.toMatchObject({ code: 'skill_unavailable' });
  expect(f.store.get('workflow_definitions', f.project.id)).toBeUndefined();
  await expect(set({ name: 'simplify', path: '/skills/simplify/SKILL.md' })).resolves.toMatchObject(
    { definition_version: 1 },
  );
});

it('limits a definition trial to tasks reaching the changed slot and asks the user to keep or revert', async () => {
  const f = await opened();
  const { startSlot } = await import('../../packages/control/dist/workflow-engine.js');
  const ctx = (
    f.control as unknown as { ctx: import('../../packages/control/dist/context.js').ControlContext }
  ).ctx;
  f.call('workflow.definition.set', {
    project_id: f.project.id,
    definition: empty(),
    base_version: 0,
  });
  const definition = {
    ...empty(),
    slots: {
      ...empty().slots,
      before_merge: [{ id: 'signoff', title: 'Sign off', kind: { type: 'approval' } }],
    },
  };
  f.call('workflow.definition.set', {
    project_id: f.project.id,
    definition,
    base_version: 1,
    trial_tasks: 1,
  });
  const plan = f.store.insert<import('@pantheon/domain').BoardPlan>('board_plans', {
    id: 'trial-lead',
    revision: 1,
    project_id: f.project.id,
    headline: 'Trial',
    lanes: [{ id: 'core', title: 'Core' }],
    tasks: ['first', 'second'].map((id) => ({
      id,
      title: id,
      goal: id,
      lane: 'core',
      depends_on: [],
      source: [],
      scope: [],
      acceptance: [],
    })),
    plan_version: 1,
    pending_edits: [],
    risks: [],
    assumptions: [],
    inbox: [],
    notified: {},
    updated_at: Date.now(),
  });
  expect(f.control.workflowDefinition(user, f.project.id).trial).toEqual({
    tasks: 1,
    done: 0,
    previous_version: 1,
  });
  const runs = f.store.transaction(() => startSlot(ctx, plan, plan.tasks[0]!, 'before_merge'));
  expect(runs).toMatchObject([{ definition_version: 2, step: { id: 'signoff' } }]);
  expect(
    f.store.transaction(() => startSlot(ctx, plan, plan.tasks[0]!, 'before_merge')),
  ).toHaveLength(1);
  expect(f.store.transaction(() => startSlot(ctx, plan, plan.tasks[1]!, 'before_merge'))).toEqual(
    [],
  );
  f.store.update('workflow_step_runs', { ...runs[0]!, state: 'passed' }, runs[0]!.revision);
  await f.control.tick();
  expect(f.control.needsYou(user, f.project.id).items).toContainEqual(
    expect.objectContaining({
      kind: 'workflow.definition.trial',
      source: expect.objectContaining({ id: f.project.id }),
    }),
  );
  f.call('workflow.definition.trial.decide', { project_id: f.project.id, decision: 'revert' });
  expect(f.control.workflowDefinition(user, f.project.id)).toMatchObject({ definition: empty() });
  expect(f.control.workflowDefinition(user, f.project.id)).not.toHaveProperty('trial');
  f.call('workflow.definition.set', {
    project_id: f.project.id,
    definition,
    base_version: 3,
    trial_tasks: 1,
  });
  const keptRuns = f.store.transaction(() => startSlot(ctx, plan, plan.tasks[1]!, 'before_merge'));
  f.store.update('workflow_step_runs', { ...keptRuns[0]!, state: 'passed' }, keptRuns[0]!.revision);
  await f.control.tick();
  f.call('workflow.definition.trial.decide', { project_id: f.project.id, decision: 'keep' });
  expect(f.control.workflowDefinition(user, f.project.id).definition.slots.before_merge).toEqual(
    definition.slots.before_merge,
  );
});

it('copies independent named definitions, switches the default and enforces project ownership and unique names', async () => {
  const f = await opened();
  const project_id = f.project.id;
  const original = f.control.workflowDefinition(user, project_id);
  expect(original).toMatchObject({ id: project_id, name: 'Default', is_default: true });
  const copy = f.call<{ id: string }>('workflow.definition.save_as', {
    project_id,
    name: 'Release',
  });
  expect(f.control.workflowDefinitionList(user, project_id)).toEqual([
    { id: project_id, name: 'Default', version: 0, is_default: true },
    { id: copy.id, name: 'Release', version: 1, is_default: false },
  ]);
  expect(() => f.call('workflow.definition.save_as', { project_id, name: 'Release' })).toThrowError(
    expect.objectContaining({ code: 'invalid_input' }),
  );
  const next = empty();
  next.review.max_rounds = 5;
  f.call('workflow.definition.set', { project_id, id: copy.id, definition: next, base_version: 1 });
  expect(f.control.workflowDefinition(user, project_id).definition.review.max_rounds).toBe(3);
  f.call('workflow.definition.set_default', { project_id, id: copy.id });
  expect(f.control.workflowDefinition(user, project_id)).toMatchObject({
    id: copy.id,
    name: 'Release',
    definition_version: 2,
  });
  expect(
    f.control.workflowDefinition(user, project_id, project_id).definition.review.max_rounds,
  ).toBe(3);
  const other = await f.call<Project>('project.open', {
    name: 'Other',
    roots: [(await opened()).projectRoot],
  });
  expect(() => f.control.workflowDefinition(user, other.id, copy.id)).toThrow();
  const { taskWorkflow, sessionWorkflow } =
    await import('../../packages/control/dist/workflow-engine.js');
  const ctx = (
    f.control as unknown as { ctx: import('../../packages/control/dist/context.js').ControlContext }
  ).ctx;
  const plan = f.store.insert<import('@pantheon/domain').BoardPlan>('board_plans', {
    id: 'named-lead',
    revision: 1,
    project_id,
    headline: 'Named workflow',
    lanes: [{ id: 'core', title: 'Core' }],
    tasks: [
      {
        id: 'export',
        title: 'Export',
        goal: 'Export',
        lane: 'core',
        depends_on: [],
        source: [],
        scope: [],
        acceptance: [],
        workflow_id: copy.id,
      },
    ],
    plan_version: 1,
    pending_edits: [],
    risks: [],
    assumptions: [],
    inbox: [],
    notified: {},
    updated_at: Date.now(),
  });
  expect(taskWorkflow(ctx, plan, 'export')).toMatchObject({
    id: copy.id,
    definition_version: 2,
    definition: next,
  });
  const legacy: import('@pantheon/domain').Session = {
    id: 'legacy-worker',
    revision: 1,
    project_id,
    runtime: 'fixture',
    state: 'open',
    turn_count: 0,
    task: { lead_session_id: plan.id, id: 'export', definition_version: 0 },
  };
  expect(sessionWorkflow(ctx, legacy)).toMatchObject({
    id: project_id,
    definition_version: 0,
    definition: empty(),
  });
});

const engine = async (f: Awaited<ReturnType<typeof opened>>) => ({
  ...(await import('../../packages/control/dist/workflow-engine.js')),
  ctx: (
    f.control as unknown as { ctx: import('../../packages/control/dist/context.js').ControlContext }
  ).ctx,
});
const signoff = (id: string) => ({ id, title: id, kind: { type: 'approval' as const } });
const inSlot = (slot: 'before_dispatch' | 'before_merge' | 'after_merge', ...ids: string[]) => ({
  ...empty(),
  slots: { ...empty().slots, [slot]: ids.map(signoff) },
});
const insertPlan = (
  f: Awaited<ReturnType<typeof opened>>,
  ids: string[],
  extra: Partial<import('@pantheon/domain').BoardPlan> = {},
) =>
  f.store.insert<import('@pantheon/domain').BoardPlan>('board_plans', {
    id: 'trial-lead',
    revision: 1,
    project_id: f.project.id,
    headline: 'Trial',
    lanes: [{ id: 'core', title: 'Core' }],
    tasks: ids.map((id) => ({
      id,
      title: id,
      goal: id,
      lane: 'core',
      depends_on: [],
      source: [],
      scope: [],
      acceptance: [],
    })),
    plan_version: 1,
    pending_edits: [],
    risks: [],
    assumptions: [],
    inbox: [],
    notified: {},
    updated_at: Date.now(),
    ...extra,
  });
const trialOf = (f: Awaited<ReturnType<typeof opened>>) =>
  f.store.must<import('@pantheon/domain').StoredWorkflowDefinition>(
    'workflow_definitions',
    f.project.id,
  ).trial;

it('keeps a task that already has runs in the changed slot on its pinned version and out of the trial', async () => {
  const f = await opened();
  const { startSlot, ctx } = await engine(f);
  f.call('workflow.definition.set', {
    project_id: f.project.id,
    definition: inSlot('before_merge', 'signoff'),
    base_version: 0,
  });
  const plan = insertPlan(f, ['first', 'second']);
  f.store.transaction(() => startSlot(ctx, plan, plan.tasks[0]!, 'before_merge'));
  f.call('workflow.definition.set', {
    project_id: f.project.id,
    definition: inSlot('before_merge', 'signoff', 'security'),
    base_version: 1,
    trial_tasks: 1,
  });
  const slot = (index: number) =>
    f.store
      .transaction(() => startSlot(ctx, plan, plan.tasks[index]!, 'before_merge'))
      .map((run) => [run.step.id, run.definition_version]);
  expect(slot(0)).toEqual([['signoff', 1]]);
  expect(trialOf(f)?.enrolled).toEqual([]);
  expect(slot(1)).toEqual([
    ['signoff', 2],
    ['security', 2],
  ]);
});

it('keeps a step run without a workflow id on the original definition after the default changes', async () => {
  const f = await opened();
  const { startSlot, taskWorkflow, ctx } = await engine(f);
  const project_id = f.project.id;
  f.call('workflow.definition.set', {
    project_id,
    definition: inSlot('before_dispatch', 'signoff'),
    base_version: 0,
  });
  f.call('workflow.definition.set', {
    project_id,
    definition: inSlot('before_dispatch', 'signoff', 'security'),
    base_version: 1,
  });
  const plan = insertPlan(f, ['first']);
  f.store.insert<import('@pantheon/domain').StepRun>('workflow_step_runs', {
    id: 'unpinned-run',
    revision: 1,
    project_id,
    lead_session_id: plan.id,
    task_id: 'first',
    generation: 1,
    definition_version: 2,
    slot: 'before_dispatch',
    step: signoff('signoff'),
    state: 'waiting',
    created_at: Date.now(),
  });
  const named = f.call<{ id: string }>('workflow.definition.save_as', {
    project_id,
    name: 'Named',
  });
  f.call('workflow.definition.set', {
    project_id,
    id: named.id,
    definition: inSlot('before_dispatch', 'release'),
    base_version: 1,
  });
  f.call('workflow.definition.set_default', { project_id, id: named.id });
  expect(taskWorkflow(ctx, plan, 'first')).toMatchObject({ id: project_id, definition_version: 2 });
  expect(
    f.store
      .transaction(() => startSlot(ctx, plan, plan.tasks[0]!, 'before_dispatch'))
      .map((run) => [run.step.id, run.workflow_id ?? null, run.state]),
  ).toEqual([
    ['signoff', null, 'waiting'],
    ['security', project_id, 'pending'],
  ]);
});

it('enrolls only tasks that reach the changed after-merge slot after the trial started', async () => {
  const f = await opened();
  const { advanceSteps, ctx } = await engine(f);
  f.call('workflow.definition.set', {
    project_id: f.project.id,
    definition: empty(),
    base_version: 0,
  });
  const merged = (at: number) => ({
    generation: 1,
    at,
    session_id: 'trial-lead',
    from_sha: 'a',
    to_sha: 'b',
  });
  const plan = insertPlan(f, ['old', 'later'], {
    direct_merged: { old: merged(Date.now() - 5 * 86_400_000) },
  });
  f.call('workflow.definition.set', {
    project_id: f.project.id,
    definition: inSlot('after_merge', 'notify'),
    base_version: 1,
    trial_tasks: 1,
  });
  f.store.transaction(() => advanceSteps(ctx));
  expect(f.store.list('workflow_step_runs')).toEqual([]);
  expect(trialOf(f)?.enrolled).toEqual([]);
  const current = f.store.must<import('@pantheon/domain').BoardPlan>('board_plans', plan.id);
  f.store.update(
    'board_plans',
    { ...current, direct_merged: { ...current.direct_merged, later: merged(Date.now() + 1000) } },
    current.revision,
  );
  f.store.transaction(() => advanceSteps(ctx));
  expect(
    f.store
      .list<import('@pantheon/domain').StepRun>('workflow_step_runs')
      .map((run) => [run.task_id, run.step.id, run.state]),
  ).toEqual([['later', 'notify', 'waiting']]);
  expect(trialOf(f)?.enrolled).toHaveLength(1);
});
