import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type {
  BoardPlan,
  Principal,
  Project,
  Review,
  Session,
  StepRun,
  WorkflowDefinition,
  WorkflowStep,
  Workspace,
} from '@pantheon/domain';
import { blockedReport } from '../../packages/control/dist/lead-inbox.js';
import type { ControlContext } from '../../packages/control/dist/context.js';
import * as validation from '../../packages/control/dist/validation-executor.js';
import { eventually, settle, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = ReturnType<typeof workbenchFixture>;
const empty = (): WorkflowDefinition => ({
  slots: { before_dispatch: [], before_merge: [], after_merge: [] },
  plan_review: { tiers: ['t3'] },
  review: { max_rounds: 3 },
});
const approval: WorkflowStep = {
  id: 'signoff',
  title: 'Approve the result',
  kind: { type: 'approval' },
};
const commandStep: WorkflowStep = {
  id: 'verify',
  title: 'Verify the contract',
  kind: { type: 'command', command: 'check-contract', timeout_seconds: 17 },
};
const current = (f: Fixture, id: string) => f.store.must<Session>('sessions', id);
const planOf = (f: Fixture, id: string) => f.store.must<BoardPlan>('board_plans', id);
const runs = (f: Fixture) => f.store.list<StepRun>('workflow_step_runs');
const principal = (f: Fixture, id: string, role: 'lead' | 'worker' = 'lead'): Principal => ({
  id: `session:${id}`,
  role,
  session_id: id,
  project_id: f.project.id,
  expires_at: Date.now() + 60000,
});
const define = (f: Fixture, definition: WorkflowDefinition) =>
  f.call('workflow.definition.set', {
    project_id: f.project.id,
    definition,
    base_version: f.control.workflowDefinition(user, f.project.id).definition_version,
  });
const start = (f: Fixture, lead: Session, asLead = false) =>
  f.call(
    'task.start',
    { project_id: f.project.id, lead_session_id: lead.id, task_ids: ['export'] },
    null,
    asLead ? principal(f, lead.id) : user,
  );
const workerOf = (f: Fixture, lead: Session) =>
  f.store.list<Session>('sessions').find((s) => s.task?.lead_session_id === lead.id)!;
const decide = (f: Fixture, run: StepRun, decision = 'approve', reason?: string) =>
  f.call('workflow.step.decide', { step_run_id: run.id, decision, reason });

async function setup(definition = empty(), direct = false) {
  const f = workbenchFixture({ delay: 1 });
  git(f.source, 'config', 'user.name', 'Source User');
  git(f.source, 'config', 'user.email', 'source@example.invalid');
  const lead = f.create('Plan the export');
  await settle(f, lead);
  define(f, definition);
  f.store.insert<BoardPlan>('board_plans', {
    id: lead.id,
    revision: 1,
    project_id: f.project.id,
    headline: 'Ship export',
    lanes: [{ id: 'core', title: 'Core' }],
    tasks: [
      {
        id: 'export',
        title: 'Export the report',
        goal: 'Export the report',
        lane: 'core',
        depends_on: [],
        source: ['Plan the export'],
        scope: ['.'],
        acceptance: ['true'],
        path: direct ? 'direct' : 'dispatch',
        kind: { tier: 't2', domain: 'backend-logic' },
      },
    ],
    risks: [],
    assumptions: [],
    plan_version: 1,
    pending_edits: [],
    inbox: [],
    notified: {},
    updated_at: Date.now(),
  });
  return { f, lead };
}
function validationResult(exit_code = 0): validation.ValidationResult {
  return {
    exit_code,
    signal: null,
    duration_ms: 1,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    log: Buffer.alloc(0),
    tail: exit_code ? 'contract failed' : '',
    timedOut: false,
    stdout_sha256: '',
    stderr_sha256: '',
    output_truncated: false,
    boundary: {
      kind: 'macos-seatbelt',
      network: 'loopback',
      supported: true,
      stop_scope: 'process-group',
    },
  };
}
function enableMerge(f: Fixture) {
  const project = f.store.must<Project>('projects', f.project.id);
  f.call('project.autoMerge.set', { project_id: project.id, enabled: true }, project.revision);
}
async function build(f: Fixture, worker: Session) {
  await settle(f, worker);
  const workspace = f.store.must<Workspace>('workspaces', worker.workspace_id!);
  writeFileSync(path.join(workspace.path, 'answer.txt'), 'exported\n');
  git(workspace.path, 'add', 'answer.txt');
  git(workspace.path, 'commit', '--quiet', '-m', 'Export the report');
  const head = git(workspace.path, 'rev-parse', 'HEAD');
  f.call(
    'session.send',
    { session_id: worker.id, input: 'Finish the export' },
    current(f, worker.id).revision,
  );
  return head;
}

it('dispatches and merges through the existing path with an empty definition stored', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const { f, lead } = await setup();
  enableMerge(f);
  start(f, lead);
  await f.control.tick();
  const worker = workerOf(f, lead);
  expect(worker.task).toMatchObject({ generation: 1, definition_version: 1 });
  const head = await build(f, worker);
  await eventually(
    () => current(f, worker.id).outcome === 'merged',
    () => f.control.tick(),
    10000,
  );
  expect(git(f.source, 'rev-parse', 'HEAD')).toBe(head);
  expect(runs(f)).toEqual([]);
});

it('waits before dispatch, exposes the step on both views and needs-you, and pins its version', async () => {
  const definition = empty();
  definition.slots.before_dispatch = [approval];
  const { f, lead } = await setup(definition);
  start(f, lead);
  await f.control.tick();
  expect(workerOf(f, lead)).toBeUndefined();
  const [run] = runs(f);
  expect(run).toMatchObject({
    slot: 'before_dispatch',
    state: 'waiting',
    generation: 1,
    definition_version: 1,
  });
  const row = f.control
    .boardView(user, f.project.id, 1)
    .tasks.find((t) => t.id === `${lead.id}:export`)!;
  expect(row).toMatchObject({
    dispatch_wait: 'step',
    waiting_step: { id: approval.id, title: approval.title, kind: 'approval' },
  });
  const project = f.control.projectRead(user, f.project.id) as { plans: { tasks: unknown[] }[] };
  expect(JSON.stringify(project)).toContain('waiting_step');
  expect(
    f.control.needsYou(user, f.project.id).items.find((i) => i.source.id === run!.id),
  ).toMatchObject({
    kind: 'workflow.approval',
    task_title: 'Export the report',
    step_title: approval.title,
    actions: [
      { command: 'workflow.step.decide', decision: 'approve', allowed: true },
      { command: 'workflow.step.decide', decision: 'reject', allowed: true },
    ],
  });
  expect(() =>
    f.call(
      'workflow.step.decide',
      { step_run_id: run!.id, decision: 'approve' },
      null,
      principal(f, lead.id),
    ),
  ).toThrowError(expect.objectContaining({ code: 'permission_denied' }));
  const newer = empty();
  newer.slots.before_dispatch = [{ ...approval, id: 'new-signoff' }];
  define(f, newer);
  decide(f, run!);
  await f.control.tick();
  expect(workerOf(f, lead).task?.definition_version).toBe(1);
});

it('brings a snoozed lead back when a workflow approval starts waiting for the user', async () => {
  const definition = empty();
  definition.slots.before_dispatch = [approval];
  const { f, lead } = await setup(definition);
  f.call('session.snooze', { session_id: lead.id, snoozed: true }, current(f, lead.id).revision);
  start(f, lead);
  await f.control.tick();
  expect(runs(f)[0]).toMatchObject({ state: 'waiting' });
  expect(current(f, lead.id)).not.toHaveProperty('snoozed_at');
  expect(
    f.store
      .events(0, undefined, 100000)
      .filter((event) => event.aggregate_id === lead.id && event.kind === 'session.unsnoozed')
      .map((event) => event.payload),
  ).toEqual([{ reason: 'needs_you' }]);
});

it('checks the direct claim after plan review and pins the definition when it claims', async () => {
  const definition = empty();
  definition.slots.before_dispatch = [approval];
  const { f, lead } = await setup(definition, true);
  expect(start(f, lead, true)).toMatchObject({ wait: 'step' });
  expect(current(f, lead.id).direct_task).toBeUndefined();
  await f.control.tick();
  decide(f, runs(f)[0]!);
  expect(start(f, lead, true)).toMatchObject({ claimed: 'export', generation: 1 });
  expect(current(f, lead.id).direct_task).toMatchObject({ definition_version: 1 });
});

it('checks the condition of an after-merge step against the files a direct task merged', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const definition = empty();
  definition.slots.after_merge = [{ ...approval, when: { changed_paths: ['answer.txt'] } }];
  const { f, lead } = await setup(definition, true);
  enableMerge(f);
  expect(start(f, lead, true)).toMatchObject({ claimed: 'export' });
  const workspace = f.store.must<Workspace>('workspaces', lead.workspace_id!);
  writeFileSync(path.join(workspace.path, 'answer.txt'), 'exported\n');
  git(workspace.path, 'add', 'answer.txt');
  git(workspace.path, 'commit', '--quiet', '-m', 'Export the report');
  f.call(
    'task.report',
    { project_id: f.project.id, kind: 'done', text: 'The export is done' },
    null,
    principal(f, lead.id),
  );
  f.call('session.send', { session_id: lead.id, input: 'Go on' }, current(f, lead.id).revision);
  await eventually(
    () => runs(f).some((r) => r.slot === 'after_merge'),
    () => f.control.tick(),
    10000,
  );
  expect(planOf(f, lead.id).direct_merged?.export).toBeDefined();
  expect(runs(f).find((r) => r.slot === 'after_merge')).toMatchObject({ state: 'waiting' });
});

it('runs dispatch commands in order, filters applicability, and stores but does not run after-merge steps', async () => {
  const execute = vi
    .spyOn(validation, 'runValidationCommand')
    .mockResolvedValue(validationResult());
  const definition = empty();
  definition.slots.before_dispatch = [
    { ...approval, id: 'other-domain', applies_to: { domains: ['frontend-ui'] } },
    commandStep,
    approval,
  ];
  definition.slots.after_merge = [commandStep, approval];
  const { f, lead } = await setup(definition);
  start(f, lead);
  await eventually(
    () => runs(f).some((r) => r.step.id === approval.id && r.state === 'waiting'),
    () => f.control.tick(),
  );
  expect(workerOf(f, lead)).toBeUndefined();
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0]![0]).toMatchObject({
    argv: ['/bin/sh', '-c', 'check-contract'],
    cwd: f.source,
    timeoutMs: 17000,
  });
  expect(runs(f).map((r) => [r.step.id, r.state])).toEqual([
    ['verify', 'passed'],
    ['signoff', 'waiting'],
  ]);
  decide(
    f,
    runs(f).find((r) => r.step.id === approval.id)!,
  );
  await f.control.tick();
  expect(workerOf(f, lead)).toBeDefined();
});

it('skips a step inside a group whose tiers or domains exclude the task', async () => {
  const definition = empty();
  const leaf = { ...approval, kind: { type: 'approval' } } as const;
  definition.slots.before_dispatch = [
    {
      id: 'signoffs',
      title: 'Sign-offs',
      kind: {
        type: 'parallel',
        steps: [
          { ...leaf, id: 'senior-signoff', applies_to: { tiers: ['t3'] } },
          { ...leaf, id: 'ui-signoff', applies_to: { domains: ['frontend-ui'] } },
          leaf,
        ],
      },
    },
  ];
  const { f, lead } = await setup(definition);
  start(f, lead);
  await f.control.tick();
  expect(
    runs(f)
      .filter((r) => r.parent_run_id)
      .map((r) => [r.step.id, r.state]),
  ).toEqual([
    ['senior-signoff', 'skipped'],
    ['ui-signoff', 'skipped'],
    ['signoff', 'waiting'],
  ]);
  decide(
    f,
    runs(f).find((r) => r.step.id === approval.id)!,
  );
  await f.control.tick();
  expect(workerOf(f, lead)).toBeDefined();
});

it('keeps a failed dispatch command blocked and retires its run on a new contract generation', async () => {
  const execute = vi
    .spyOn(validation, 'runValidationCommand')
    .mockResolvedValue(validationResult(7));
  const definition = empty();
  definition.slots.before_dispatch = [commandStep];
  const { f, lead } = await setup(definition);
  start(f, lead);
  await eventually(
    () => runs(f).some((r) => r.state === 'failed'),
    () => f.control.tick(),
  );
  await f.control.tick();
  expect(workerOf(f, lead)).toBeUndefined();
  expect(execute).toHaveBeenCalledOnce();
  const old = runs(f)[0]!;
  const plan = planOf(f, lead.id);
  f.store.update(
    'board_plans',
    { ...plan, generations: { export: { generation: 2, contract: 'changed' } } },
    plan.revision,
  );
  execute.mockResolvedValue(validationResult());
  await eventually(
    () => !!workerOf(f, lead),
    () => f.control.tick(),
  );
  expect(f.store.must<StepRun>('workflow_step_runs', old.id).state).toBe('retired');
  expect(runs(f).find((r) => r.generation === 2)?.state).toBe('passed');
});

it('waits for merge approval after the gate, frees capacity, and resumes across daemon restart', async () => {
  const execute = vi
    .spyOn(validation, 'runValidationCommand')
    .mockResolvedValue(validationResult());
  const definition = empty();
  definition.slots.before_merge = [commandStep, approval];
  const { f, lead } = await setup(definition);
  enableMerge(f);
  start(f, lead);
  await f.control.tick();
  const worker = workerOf(f, lead),
    sourceHead = git(f.source, 'rev-parse', 'HEAD');
  const head = await build(f, worker);
  await eventually(
    () => runs(f).some((r) => r.step.id === approval.id && r.state === 'waiting'),
    () => f.control.tick(),
    10000,
  );
  expect(execute.mock.calls.map((call) => call[0].argv)).toEqual([
    ['/bin/sh', '-c', 'true'],
    ['/bin/sh', '-c', 'check-contract'],
  ]);
  expect(git(f.source, 'rev-parse', 'HEAD')).toBe(sourceHead);
  expect(f.control.boardView(user, f.project.id, 1).task_places?.used).toBe(0);
  const waiting = runs(f).find((r) => r.state === 'waiting')!;
  define(f, empty());
  await f.restart(() => undefined);
  expect(f.control.needsYou(user, f.project.id).items.some((i) => i.source.id === waiting.id)).toBe(
    true,
  );
  decide(f, waiting);
  await eventually(
    () => current(f, worker.id).outcome === 'merged',
    () => f.control.tick(),
    10000,
  );
  expect(git(f.source, 'rev-parse', 'HEAD')).toBe(head);
});

it('hands a rejected merge approval back to the lead with the user reason', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const definition = empty();
  definition.slots.before_merge = [approval];
  const { f, lead } = await setup(definition);
  enableMerge(f);
  start(f, lead);
  await f.control.tick();
  const worker = workerOf(f, lead),
    sourceHead = git(f.source, 'rev-parse', 'HEAD');
  await build(f, worker);
  await eventually(
    () => runs(f).some((r) => r.state === 'waiting'),
    () => f.control.tick(),
    10000,
  );
  decide(f, runs(f)[0]!, 'reject', 'The export omits totals');
  expect(
    blockedReport((f.control as unknown as { ctx: ControlContext }).ctx, current(f, worker.id)),
  ).toMatchObject({ text: expect.stringContaining('The export omits totals') });
  await f.control.tick();
  expect(git(f.source, 'rev-parse', 'HEAD')).toBe(sourceHead);
  expect(
    f.store.kindEvents(f.project.id, ['lead.note_added']).map((e) => e.payload),
  ).toContainEqual(
    expect.objectContaining({
      kind: 'blocked',
      text: expect.stringContaining('The export omits totals'),
    }),
  );
  expect(f.store.kindEvents(f.project.id, ['task.handed_back'])).toHaveLength(1);
});

it('sends a failed merge command through the existing gate hand-back path before any approval', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockImplementation(async (input) =>
    validationResult(input.argv.includes('check-contract') ? 7 : 0),
  );
  const definition = empty();
  definition.slots.before_merge = [commandStep, approval];
  const { f, lead } = await setup(definition);
  enableMerge(f);
  start(f, lead);
  await f.control.tick();
  const worker = workerOf(f, lead);
  await build(f, worker);
  await eventually(
    () =>
      f.store
        .kindEvents(f.project.id, ['session.merge_blocked'])
        .some((e) => (e.payload as { reason: string }).reason === 'gate_failed'),
    () => f.control.tick(),
    10000,
  );
  expect(runs(f).find((r) => r.step.id === 'verify')?.state).toBe('failed');
  expect(runs(f).some((r) => r.state === 'waiting')).toBe(false);
  await f.control.tick();
  expect(
    f.turns(worker.id).some((t) => t.input.includes(commandStep.title) && t.origin === 'tracker'),
  ).toBe(true);
});

it('keeps legacy unpinned sessions on the empty definition', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const definition = empty();
  definition.slots.before_merge = [approval];
  const { f, lead } = await setup(definition);
  start(f, lead);
  await f.control.tick();
  const worker = workerOf(f, lead);
  await settle(f, worker);
  const session = current(f, worker.id),
    { definition_version: _, ...task } = session.task!;
  f.store.update('sessions', { ...session, task }, session.revision);
  enableMerge(f);
  await build(f, worker);
  await eventually(
    () => current(f, worker.id).outcome === 'merged',
    () => f.control.tick(),
    10000,
  );
  expect(runs(f)).toEqual([]);
});

it('uses the definition tiers for plan review and the pinned review round limit', async () => {
  const definition = empty();
  definition.plan_review.tiers = ['t2'];
  definition.review.max_rounds = 1;
  const { f, lead } = await setup(definition);
  const reviewer = new FixtureAdapter(1);
  reviewer.name = 'reviewer';
  f.control.adapters.set(reviewer.name, reviewer);
  const plan = planOf(f, lead.id);
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: plan.plan_version,
      headline: plan.headline,
      lanes: plan.lanes,
      tasks: plan.tasks,
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    principal(f, lead.id),
  );
  expect(
    f.store.list<Review>('reviews').some((r) => r.plan?.tasks.some((t) => t.task_id === 'export')),
  ).toBe(true);
  start(f, lead);
  expect(
    f.control.boardView(user, f.project.id, 1).tasks.find((t) => t.id === `${lead.id}:export`)
      ?.dispatch_wait,
  ).toBe('plan_review');
  await eventually(
    () => !!workerOf(f, lead),
    () => f.control.tick(),
  );
  const worker = workerOf(f, lead);
  await settle(f, worker);
  const workspace = f.store.must<Workspace>('workspaces', worker.workspace_id!);
  writeFileSync(path.join(workspace.path, 'answer.txt'), 'review me\n');
  git(workspace.path, 'add', '.');
  git(workspace.path, 'commit', '--quiet', '-m', 'Export');
  f.store.insert<Review>('reviews', {
    id: 'prior-review',
    revision: 1,
    project_id: f.project.id,
    session_id: worker.id,
    state: 'completed',
    session_ids: [],
    runtimes: [reviewer.name],
    findings: [],
    executions: [],
    round: 1,
  });
  define(f, empty());
  expect(() =>
    f.call(
      'review.request',
      { session_id: worker.id, runtimes: [reviewer.name] },
      null,
      principal(f, lead.id),
    ),
  ).toThrowError(
    expect.objectContaining({
      code: 'invalid_state',
      message: expect.stringContaining('at most 1'),
    }),
  );
});

it('preserves an admitted scope override when approval resumes its merge', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const definition = empty();
  definition.slots.before_merge = [approval];
  const { f, lead } = await setup(definition);
  const plan = planOf(f, lead.id);
  f.store.update(
    'board_plans',
    { ...plan, tasks: plan.tasks.map((task) => ({ ...task, scope: ['src'] })) },
    plan.revision,
  );
  start(f, lead);
  await f.control.tick();
  const worker = workerOf(f, lead);
  const head = await build(f, worker);
  await eventually(
    () => current(f, worker.id).state === 'open',
    () => f.control.tick(),
  );
  f.call(
    'session.merge',
    { session_id: worker.id, allow_out_of_scope: true },
    current(f, worker.id).revision,
  );
  await eventually(
    () => runs(f).some((run) => run.state === 'waiting'),
    () => f.control.tick(),
  );
  decide(f, runs(f)[0]!);
  await eventually(
    () => current(f, worker.id).outcome === 'merged',
    () => f.control.tick(),
  );
  expect(git(f.source, 'rev-parse', 'HEAD')).toBe(head);
});

it('uses the project review limit for sessions outside a plan task', async () => {
  const definition = empty();
  definition.review.max_rounds = 1;
  const { f, lead } = await setup(definition);
  const reviewer = new FixtureAdapter(1);
  reviewer.name = 'reviewer';
  f.control.adapters.set(reviewer.name, reviewer);
  const workspace = f.store.must<Workspace>('workspaces', lead.workspace_id!);
  writeFileSync(path.join(workspace.path, 'answer.txt'), 'review this change\n');
  git(workspace.path, 'add', 'answer.txt');
  git(workspace.path, 'commit', '--quiet', '-m', 'Export');
  f.store.insert<Review>('reviews', {
    id: 'prior-review',
    revision: 1,
    project_id: f.project.id,
    session_id: lead.id,
    state: 'completed',
    session_ids: [],
    runtimes: [reviewer.name],
    findings: [],
    round: 1,
  });
  expect(() =>
    f.call('review.request', { session_id: lead.id, runtimes: [reviewer.name] }),
  ).toThrowError(
    expect.objectContaining({
      code: 'invalid_state',
      message: expect.stringContaining('at most 1'),
    }),
  );
});
