import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type {
  BoardPlan,
  ExtensionInventory,
  LeadNote,
  Principal,
  Project,
  Retrospective,
  Review,
  Session,
  StepRun,
  WorkflowDefinition,
  WorkflowStep,
  Workspace,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import * as validation from '../../packages/control/dist/validation-executor.js';
import { workerInstructions } from '../../packages/control/dist/workbench-session.js';
import { REVIEW_LOOP_STEP_ID } from '../../packages/control/dist/workflow-engine.js';
import { eventually, settle, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
const empty = (): WorkflowDefinition => ({
  slots: { before_dispatch: [], before_merge: [], after_merge: [] },
  plan_review: { tiers: ['t3'] },
  review: { max_rounds: 3 },
});
const current = (f: Fixture, id: string) => f.store.must<Session>('sessions', id);
const runs = (f: Fixture) => f.store.list<StepRun>('workflow_step_runs');
const principal = (f: Fixture, id: string): Principal => ({
  id: `session:${id}`,
  role: 'lead',
  session_id: id,
  project_id: f.project.id,
  expires_at: Date.now() + 60000,
});
const workerOf = (f: Fixture, lead: Session) =>
  f.store.list<Session>('sessions').find((s) => s.task?.lead_session_id === lead.id)!;
const script = (...steps: object[]) => `fixture-script\n${JSON.stringify(steps)}`;

async function setup(
  definition: WorkflowDefinition,
  skills: ExtensionInventory['skills'] = [],
  fields: Partial<BoardPlan['tasks'][number]> = {},
) {
  const f = await workbenchFixture({ delay: 1 });
  git(f.source, 'config', 'user.name', 'Source User');
  git(f.source, 'config', 'user.email', 'source@example.invalid');
  const lead = await f.create('Plan the export');
  await settle(f, lead);
  if (skills.length)
    (f.adapter as FixtureAdapter & { inventory?: () => Promise<ExtensionInventory> }).inventory =
      async () => ({
        runtime: 'fixture',
        mcp_servers: [],
        plugins: [],
        skills,
        apps: false,
        connectors: [],
        hooks: [],
      });
  await f.call('workflow.definition.set', {
    project_id: f.project.id,
    definition,
    base_version: 0,
  });
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
        path: 'dispatch',
        kind: { tier: 't2', domain: 'backend-logic' },
        ...fields,
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
  const project = f.store.must<Project>('projects', f.project.id);
  f.call('project.autoMerge.set', { project_id: project.id, enabled: true }, project.revision);
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
    tail: exit_code ? 'release notice failed' : '',
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
/** Opens the task session and commits its work, then ends a turn so the automatic merge starts. */
async function build(f: Fixture, lead: Session) {
  f.call('task.start', {
    project_id: f.project.id,
    lead_session_id: lead.id,
    task_ids: ['export'],
  });
  await f.control.tick();
  const worker = workerOf(f, lead);
  await settle(f, worker);
  const workspace = f.store.must<Workspace>('workspaces', worker.workspace_id!);
  writeFileSync(path.join(workspace.path, 'answer.txt'), 'exported\n');
  git(workspace.path, 'add', 'answer.txt');
  git(workspace.path, 'commit', '--quiet', '-m', 'Export the report');
  f.call(
    'session.send',
    { session_id: worker.id, input: 'Finish the export' },
    current(f, worker.id).revision,
  );
  return worker;
}
const merged = (f: Fixture, worker: Session) =>
  eventually(
    () => current(f, worker.id).outcome === 'merged',
    () => f.control.tick(),
    10000,
  );

it('names the workflow of each board task and of its step runs', async () => {
  const definition = empty();
  definition.slots.before_dispatch = [
    { id: 'signoff', title: 'Approve the start', kind: { type: 'approval' } },
  ];
  const { f, lead } = await setup(definition);
  const copy = f.call<{ id: string }>('workflow.definition.save_as', {
    project_id: f.project.id,
    name: 'Release',
  });
  const plan = f.store.must<BoardPlan>('board_plans', lead.id);
  f.store.update(
    'board_plans',
    {
      ...plan,
      tasks: [
        ...plan.tasks,
        { ...plan.tasks[0]!, id: 'import', title: 'Import the report', workflow_id: copy.id },
      ],
    },
    plan.revision,
  );
  f.call('task.start', {
    project_id: f.project.id,
    lead_session_id: lead.id,
    task_ids: ['export', 'import'],
  });
  await f.control.tick();
  const tasks = f.control.boardView(user, f.project.id, 1).tasks;
  const row = (id: string) => tasks.find((t) => t.id === `${lead.id}:${id}`)!;
  expect(row('export')).toMatchObject({
    workflow_id: f.project.id,
    step_runs: [{ step_id: 'signoff', workflow_id: f.project.id }],
  });
  expect(row('import')).toMatchObject({
    workflow_id: copy.id,
    step_runs: [{ step_id: 'signoff', workflow_id: copy.id }],
  });
});

it("lists the project's custom steps by slot in the lead's guidance", async () => {
  const definition = empty();
  definition.slots.before_dispatch = [
    { id: 'signoff', title: 'Approve the start', kind: { type: 'approval' } },
  ];
  definition.slots.before_merge = [
    { id: 'second-look', title: 'Review the diff', kind: { type: 'review' } },
  ];
  const { f, lead } = await setup(definition);
  const read = f.control.projectRead(principal(f, lead.id), f.project.id) as {
    lead: { workflow: { steps: unknown } };
  };
  expect(read.lead.workflow.steps).toEqual({
    before_dispatch: [{ id: 'signoff', title: 'Approve the start', kind: 'approval' }],
    before_merge: [{ id: 'second-look', title: 'Review the diff', kind: 'review' }],
    after_merge: [],
  });
});

it("shows the step runs of the task's current generation on its board row", async () => {
  const definition = empty();
  definition.slots.before_dispatch = [
    { id: 'signoff', title: 'Approve the start', kind: { type: 'approval' } },
  ];
  const { f, lead } = await setup(definition);
  f.call('task.start', {
    project_id: f.project.id,
    lead_session_id: lead.id,
    task_ids: ['export'],
  });
  await f.control.tick();
  const row = () =>
    f.control.boardView(user, f.project.id, 1).tasks.find((t) => t.id === `${lead.id}:export`)!;
  const [old] = runs(f);
  expect(row().step_runs).toEqual([
    {
      id: old!.id,
      slot: 'before_dispatch',
      step_id: 'signoff',
      workflow_id: f.project.id,
      title: 'Approve the start',
      kind: 'approval',
      state: 'waiting',
      created_at: old!.created_at,
    },
  ]);

  const plan = f.store.must<BoardPlan>('board_plans', lead.id);
  f.store.update(
    'board_plans',
    { ...plan, generations: { export: { generation: 2, contract: 'changed' } } },
    plan.revision,
  );
  expect(row()).not.toHaveProperty('step_runs');
  await f.control.tick();
  expect(f.store.must<StepRun>('workflow_step_runs', old!.id).state).toBe('retired');
  const fresh = runs(f).find((r) => r.generation === 2)!;
  expect(row().step_runs).toMatchObject([{ id: fresh.id, step_id: 'signoff', state: 'waiting' }]);
});

it('sends a prompt with its skill to the task session before the merge and merges once the turn completes', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const skill = { name: 'simplify', path: '/skills/simplify/SKILL.md' };
  const definition = empty();
  definition.slots.before_merge = [
    {
      id: 'tidy',
      title: 'Tidy the change',
      kind: { type: 'prompt', prompt: 'Simplify what you changed', skill },
    },
  ];
  const { f, lead } = await setup(definition, [
    { id: 'simplify', name: 'simplify', enabled: true, path: skill.path },
  ]);
  const worker = await build(f, lead);
  await merged(f, worker);
  const run = runs(f)[0]!;
  const turn = f.turns(worker.id).find((t) => t.input === 'Simplify what you changed')!;
  expect(turn).toMatchObject({ skills: [skill], state: 'completed' });
  expect(run).toMatchObject({ state: 'passed', turn_id: turn.id, slot: 'before_merge' });
});

it('passes task prompts inside a group before the merge once their turns complete, and merges', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const definition = empty();
  definition.slots.before_merge = [
    {
      id: 'polish',
      title: 'Polish the change',
      kind: {
        type: 'parallel',
        steps: [
          {
            id: 'tidy',
            title: 'Tidy',
            kind: { type: 'prompt', prompt: 'Simplify what you changed' },
          },
          {
            id: 'notes',
            title: 'Notes',
            kind: { type: 'prompt', prompt: 'Note what you changed' },
          },
        ],
      },
    },
  ];
  const { f, lead } = await setup(definition);
  const worker = await build(f, lead);
  await merged(f, worker);
  expect(runs(f).map((r) => [r.step.id, r.state])).toEqual([
    ['polish', 'passed'],
    ['tidy', 'passed'],
    ['notes', 'passed'],
  ]);
  expect(
    f.turns(worker.id).filter((t) => /(Simplify|Note) what you changed/.test(t.input)),
  ).toHaveLength(2);
});

it('hands the task back when a task prompt inside a group fails its turn before the merge', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const definition = empty();
  definition.slots.before_merge = [
    {
      id: 'polish',
      title: 'Polish the change',
      kind: {
        type: 'parallel',
        steps: [
          {
            id: 'notes',
            title: 'Notes',
            kind: { type: 'prompt', prompt: 'Note what you changed' },
          },
          {
            id: 'tidy',
            title: 'Tidy',
            kind: { type: 'prompt', prompt: script({ fail: 'model unavailable' }) },
          },
        ],
      },
    },
  ];
  const { f, lead } = await setup(definition);
  const worker = await build(f, lead);
  await eventually(
    () => runs(f).find((r) => r.step.id === 'tidy')?.state === 'failed',
    () => f.control.tick(),
    10000,
  );
  for (let i = 0; i < 3; i++) await f.control.tick();
  expect(runs(f).map((r) => [r.step.id, r.state])).toEqual([
    ['polish', 'failed'],
    ['notes', 'passed'],
    ['tidy', 'failed'],
  ]);
  expect(f.store.kindEvents(f.project.id, ['task.handed_back'])).toHaveLength(1);
  expect(current(f, worker.id).outcome).toBeUndefined();
});

it("fails a prompt step when the lead's turn fails and tells the lead", async () => {
  const definition = empty();
  definition.slots.before_dispatch = [
    {
      id: 'brief',
      title: 'Brief the lead',
      kind: { type: 'prompt', prompt: script({ fail: 'model unavailable' }), target: 'lead' },
    },
  ];
  const { f, lead } = await setup(definition);
  f.call('task.start', {
    project_id: f.project.id,
    lead_session_id: lead.id,
    task_ids: ['export'],
  });
  await eventually(
    () => runs(f)[0]?.state === 'failed',
    () => f.control.tick(),
  );
  expect(runs(f)[0]!.turn_id).toBe(
    f.turns(lead.id).find((t) => t.input.includes('model unavailable'))!.id,
  );
  expect(workerOf(f, lead)).toBeUndefined();
  expect(
    f.store.kindEvents(f.project.id, ['lead.note_added']).map((e) => e.payload as LeadNote),
  ).toContainEqual(
    expect.objectContaining({ kind: 'blocked', text: expect.stringContaining('Brief the lead') }),
  );
});

it('reviews on another runtime, returns blocking findings to the task session, and reviews again after its turn', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const definition = empty();
  definition.slots.before_merge = [
    { id: 'second-look', title: 'Review the diff', kind: { type: 'review', blocking: true } },
  ];
  const { f, lead } = await setup(definition);
  const reviewer = new FixtureAdapter(1);
  reviewer.name = 'reviewer';
  f.control.adapters.set(reviewer.name, reviewer);
  const worker = await build(f, lead);
  await eventually(
    () => !!runs(f)[0]?.review_id,
    () => f.control.tick(),
    10000,
  );
  const first = runs(f)[0]!,
    review = f.store.must<Review>('reviews', first.review_id!);
  expect(review).toMatchObject({
    runtimes: ['reviewer'],
    session_id: worker.id,
    requester: { lead_session_id: lead.id, task_id: 'export', step_run_id: first.id },
  });
  f.store.update<Review>(
    'reviews',
    {
      ...review,
      findings: [
        {
          id: 'missing-header',
          runtime: 'reviewer',
          location: 'answer.txt:1',
          quote: 'exported',
          evidence: 'The export has no header row',
          impact: 'Readers cannot tell the columns apart',
          blocking: true,
          reproduction: 'head -1 answer.txt',
          status: 'open',
        } as Review['findings'][number],
      ],
    },
    review.revision,
  );
  await eventually(
    () => f.turns(worker.id).some((t) => t.input.includes('The export has no header row')),
    () => f.control.tick(),
    10000,
  );
  expect(f.store.must<StepRun>('workflow_step_runs', first.id)).toMatchObject({ state: 'failed' });
  await merged(f, worker);
  const again = f.store.must<StepRun>('workflow_step_runs', first.id);
  expect(again.state).toBe('passed');
  expect(again.review_id).not.toBe(first.review_id);
  expect(
    f.store.list<Review>('reviews').filter((r) => r.requester?.step_run_id === first.id),
  ).toHaveLength(2);
  expect(
    f.store
      .kindEvents(f.project.id, ['lead.note_added'])
      .some((e) => (e.payload as LeadNote).kind === 'review_completed'),
  ).toBe(false);
});

it("reviews on the writer's runtime in a new read-only session when no other runtime can review, and merges once the review passes", async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const definition = empty();
  definition.slots.before_merge = [
    { id: 'second-look', title: 'Review the diff', kind: { type: 'review', blocking: true } },
  ];
  const { f, lead } = await setup(definition);
  const worker = await build(f, lead);
  await merged(f, worker);
  const run = runs(f)[0]!,
    review = f.store.must<Review>('reviews', run.review_id!);
  expect(run.state).toBe('passed');
  expect(review).toMatchObject({ runtimes: ['fixture'], session_id: worker.id });
  expect(review.session_ids).not.toContain(worker.id);
  expect(current(f, review.session_ids[0]!)).toMatchObject({
    runtime: 'fixture',
    review_id: review.id,
  });
});

it.each([
  [
    "opens the task session and its review on the project's defaults when the project uses one model",
    {},
    {},
  ],
  [
    "opens the review on the step's model and effort over the project's defaults",
    { model: 'review-model', effort: 'low' },
    { requested_model: 'review-model', requested_effort: 'low' },
  ],
  [
    "opens the review on the step's model without the project's effort",
    { model: 'review-model' },
    { requested_model: 'review-model', requested_effort: undefined },
  ],
] as const)('%s', async (_name, choice, reviewed) => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const definition = empty();
  definition.slots.before_merge = [
    {
      id: 'second-look',
      title: 'Review the diff',
      kind: { type: 'review', blocking: true, ...choice },
    },
  ];
  const { f, lead } = await setup(definition);
  addReviewer(f);
  const project = f.store.must<Project>('projects', f.project.id);
  const defaults = { runtime: 'fixture', model: 'single-model', effort: 'high' } as const;
  f.store.update<Project>(
    'projects',
    {
      ...project,
      session_defaults: { ...defaults, permission_mode: 'ask', single_model: true },
    },
    project.revision,
  );
  const worker = await build(f, lead);
  expect(current(f, worker.id)).toMatchObject({
    runtime: defaults.runtime,
    requested_model: defaults.model,
    requested_effort: defaults.effort,
  });
  await eventually(
    () => !!runs(f)[0]?.review_id,
    () => f.control.tick(),
    10000,
  );
  const review = f.store.must<Review>('reviews', runs(f)[0]!.review_id!);
  expect(review.runtimes).toEqual([defaults.runtime]);
  const { runtime, requested_model, requested_effort } = current(f, review.session_ids[0]!);
  expect({ runtime, requested_model, requested_effort }).toEqual({
    runtime: defaults.runtime,
    requested_model: defaults.model,
    requested_effort: defaults.effort,
    ...reviewed,
  });
});

it('returns blocking findings of a review inside a group to the task session and runs the group again after its turn', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const definition = empty();
  definition.slots.before_merge = [
    {
      id: 'reviews',
      title: 'Reviews',
      kind: {
        type: 'parallel',
        steps: [
          { id: 'second-look', title: 'Review the diff', kind: { type: 'review', blocking: true } },
          {
            id: 'pages-look',
            title: 'Review the pages',
            when: { changed_paths: ['src/**/*.tsx'] },
            kind: { type: 'review', blocking: true },
          },
        ],
      },
    },
  ];
  const { f, lead } = await setup(definition);
  addReviewer(f);
  const worker = await build(f, lead);
  const child = () => runs(f).find((r) => r.step.id === 'second-look')!;
  await eventually(
    () => !!child()?.review_id,
    () => f.control.tick(),
    10000,
  );
  const first = child();
  addBlockingFinding(f, first.review_id!);
  await eventually(
    () =>
      f
        .turns(worker.id)
        .some((t) => t.state === 'completed' && t.input.includes('The export has no header row')),
    () => f.control.tick(),
    10000,
  );
  for (let i = 0; i < 3; i++) await f.control.tick();
  expect(f.store.kindEvents(f.project.id, ['task.handed_back'])).toEqual([]);
  await merged(f, worker);
  expect(runs(f).map((r) => [r.step.id, r.state])).toEqual([
    ['reviews', 'passed'],
    ['second-look', 'passed'],
    ['pages-look', 'skipped'],
  ]);
  expect(
    f.store.list<Review>('reviews').filter((r) => r.requester?.step_run_id === first.id),
  ).toHaveLength(2);
});

it('keeps a step its condition skipped skipped when the slot runs again after review findings', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const definition = empty();
  definition.slots.before_merge = [
    { id: 'second-look', title: 'Review the diff', kind: { type: 'review', blocking: true } },
    {
      id: 'pages-signoff',
      title: 'Approve the pages',
      when: { changed_paths: ['src/**/*.tsx'] },
      kind: { type: 'approval' },
    },
  ];
  const { f, lead } = await setup(definition);
  addReviewer(f);
  const worker = await build(f, lead);
  await reviewStarted(f);
  addBlockingFinding(f, runs(f)[0]!.review_id!);
  await eventually(
    () => current(f, worker.id).outcome === 'merged' || runs(f).some((r) => r.state === 'waiting'),
    () => f.control.tick(),
    10000,
  );
  expect(runs(f).map((r) => [r.step.id, r.state])).toEqual([
    ['second-look', 'passed'],
    ['pages-signoff', 'skipped'],
  ]);
  await merged(f, worker);
});

it('stops reviewing at the round limit of the definition and hands the task back to the lead', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const definition = empty();
  definition.review.max_rounds = 1;
  definition.slots.before_merge = [
    { id: 'second-look', title: 'Review the diff', kind: { type: 'review', blocking: true } },
  ];
  const { f, lead } = await setup(definition);
  const reviewer = new FixtureAdapter(1);
  reviewer.name = 'reviewer';
  f.control.adapters.set(reviewer.name, reviewer);
  const worker = await build(f, lead);
  await eventually(
    () => !!runs(f)[0]?.review_id,
    () => f.control.tick(),
    10000,
  );
  const first = runs(f)[0]!,
    review = f.store.must<Review>('reviews', first.review_id!);
  f.store.update<Review>(
    'reviews',
    {
      ...review,
      findings: [
        {
          id: 'missing-header',
          runtime: 'reviewer',
          location: 'answer.txt:1',
          quote: 'exported',
          evidence: 'The export has no header row',
          impact: 'Readers cannot tell the columns apart',
          blocking: true,
          status: 'open',
        } as Review['findings'][number],
      ],
    },
    review.revision,
  );
  await eventually(
    () =>
      /at most 1 round/.test(f.store.must<StepRun>('workflow_step_runs', first.id).reason ?? ''),
    () => f.control.tick(),
    10000,
  );
  expect(f.store.must<StepRun>('workflow_step_runs', first.id).state).toBe('failed');
  expect(current(f, worker.id).outcome).toBeUndefined();
  expect(
    f.store.list<Review>('reviews').filter((r) => r.requester?.step_run_id === first.id),
  ).toHaveLength(1);
  expect(
    f.store
      .kindEvents(f.project.id, ['task.reported'])
      .some((e) => /at most 1 round/.test((e.payload as LeadNote).text)),
  ).toBe(true);
});

/** Adds a reviewer runtime besides the writer's fixture runtime. */
function addReviewer(f: Fixture) {
  const reviewer = new FixtureAdapter(1);
  reviewer.name = 'reviewer';
  f.control.adapters.set(reviewer.name, reviewer);
}
function addBlockingFinding(f: Fixture, reviewId: string) {
  const review = f.store.must<Review>('reviews', reviewId);
  f.store.update<Review>(
    'reviews',
    {
      ...review,
      findings: [
        {
          id: 'missing-header',
          runtime: 'reviewer',
          location: 'answer.txt:1',
          quote: 'exported',
          evidence: 'The export has no header row',
          impact: 'Readers cannot tell the columns apart',
          blocking: true,
          status: 'open',
        } as Review['findings'][number],
      ],
    },
    review.revision,
  );
}
const reviewStarted = (f: Fixture) =>
  eventually(
    () => !!runs(f)[0]?.review_id,
    () => f.control.tick(),
    10000,
  );

it('reviews a review loop task on another runtime before the merge, sends blocking findings back and reviews again', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const { f, lead } = await setup(empty(), [], { path: 'review_loop' });
  addReviewer(f);
  const worker = await build(f, lead);
  await reviewStarted(f);
  expect(runs(f)).toHaveLength(1);
  const first = runs(f)[0]!;
  expect(first).toMatchObject({
    slot: 'before_merge',
    session_id: worker.id,
    step: {
      id: REVIEW_LOOP_STEP_ID,
      title: 'Code review',
      kind: { type: 'review', blocking: true },
    },
  });
  expect(f.store.must<Review>('reviews', first.review_id!)).toMatchObject({
    runtimes: ['reviewer'],
    session_id: worker.id,
  });
  addBlockingFinding(f, first.review_id!);
  await eventually(
    () => f.turns(worker.id).some((t) => t.input.includes('The export has no header row')),
    () => f.control.tick(),
    10000,
  );
  expect(f.store.must<StepRun>('workflow_step_runs', first.id).state).toBe('failed');
  expect(current(f, worker.id).outcome).toBeUndefined();
  await merged(f, worker);
  expect(f.store.must<StepRun>('workflow_step_runs', first.id).state).toBe('passed');
  expect(
    f.store.list<Review>('reviews').filter((r) => r.requester?.step_run_id === first.id),
  ).toHaveLength(2);
});

it('merges a review loop task whose review has no blocking findings and records its path', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const { f, lead } = await setup(empty(), [], { path: 'review_loop' });
  addReviewer(f);
  const worker = await build(f, lead);
  await merged(f, worker);
  expect(runs(f)).toMatchObject([{ step: { id: REVIEW_LOOP_STEP_ID }, state: 'passed' }]);
  await eventually(
    () => f.store.list<Retrospective>('retrospectives').some((r) => r.outcome === 'merged'),
    () => f.control.tick(),
    10000,
  );
  expect(f.store.list<Retrospective>('retrospectives')[0]).toMatchObject({
    task_id: 'export',
    path: 'review_loop',
  });
});

it("reviews a review loop task on the writer's runtime when no other runtime can review", async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const { f, lead } = await setup(empty(), [], { path: 'review_loop' });
  const worker = await build(f, lead);
  await merged(f, worker);
  const run = runs(f)[0]!;
  expect(run).toMatchObject({ step: { id: REVIEW_LOOP_STEP_ID }, state: 'passed' });
  expect(f.store.must<Review>('reviews', run.review_id!).runtimes).toEqual(['fixture']);
});

it('hands a review loop task back to the lead at the round limit of the definition', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const definition = empty();
  definition.review.max_rounds = 1;
  const { f, lead } = await setup(definition, [], { path: 'review_loop' });
  addReviewer(f);
  const worker = await build(f, lead);
  await reviewStarted(f);
  const first = runs(f)[0]!;
  addBlockingFinding(f, first.review_id!);
  await eventually(
    () =>
      f.store.must<StepRun>('workflow_step_runs', first.id).reason?.includes('Code review limit') ??
      false,
    () => f.control.tick(),
    10000,
  );
  expect(f.store.must<StepRun>('workflow_step_runs', first.id)).toMatchObject({
    state: 'failed',
    reason: 'Code review limit reached: at most 1 rounds per reviewed session',
  });
  expect(current(f, worker.id).outcome).toBeUndefined();
});

it('runs only the blocking review of the definition for a review loop task', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const definition = empty();
  definition.slots.before_merge = [
    {
      id: 'second-look',
      title: 'Review the diff',
      applies_to: { tiers: ['t2'] },
      kind: { type: 'review', blocking: true },
    },
  ];
  const { f, lead } = await setup(definition, [], { path: 'review_loop' });
  addReviewer(f);
  const worker = await build(f, lead);
  await merged(f, worker);
  expect(runs(f)).toMatchObject([{ step: { id: 'second-look' }, state: 'passed' }]);
});

it('runs only the blocking reviews inside a group of the definition for a review loop task', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const definition = empty();
  const review = { title: 'Review the diff', kind: { type: 'review', blocking: true } } as const;
  definition.slots.before_merge = [
    {
      id: 'reviews',
      title: 'Reviews',
      kind: {
        type: 'parallel',
        steps: [
          { ...review, id: 'logic' },
          { ...review, id: 'style' },
        ],
      },
    },
  ];
  const { f, lead } = await setup(definition, [], { path: 'review_loop' });
  addReviewer(f);
  const worker = await build(f, lead);
  await merged(f, worker);
  expect(runs(f).some((r) => r.step.id === REVIEW_LOOP_STEP_ID)).toBe(false);
  const children = new Set(
    runs(f)
      .filter((r) => r.parent_run_id)
      .map((r) => r.id),
  );
  expect(
    f.store.list<Review>('reviews').map((r) => children.has(r.requester!.step_run_id!)),
  ).toEqual([true, true]);
});

it("reviews a task without a path whose tier's policy path is the review loop", async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const { f, lead } = await setup(empty(), [], { path: undefined });
  f.call('workflow.policy.set', { project_id: f.project.id, path: { t2: 'review_loop' } }, null);
  addReviewer(f);
  const worker = await build(f, lead);
  await merged(f, worker);
  expect(runs(f)).toMatchObject([{ step: { id: REVIEW_LOOP_STEP_ID }, state: 'passed' }]);
});

it('does not review a dispatch task when the policy gives its tier the review loop', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const { f, lead } = await setup(empty());
  f.call('workflow.policy.set', { project_id: f.project.id, path: { t2: 'review_loop' } }, null);
  addReviewer(f);
  const worker = await build(f, lead);
  await merged(f, worker);
  expect(runs(f)).toEqual([]);
  expect(f.store.list<Review>('reviews')).toEqual([]);
});

it('leaves a merge command the gate did not reach pending after an earlier one fails, and passes both once fixed', async () => {
  let totalsFixed = false;
  vi.spyOn(validation, 'runValidationCommand').mockImplementation(async (input) =>
    validationResult(input.argv.includes('check-totals') && !totalsFixed ? 7 : 0),
  );
  const definition = empty();
  definition.slots.before_merge = [
    {
      id: 'totals',
      title: 'Check the totals',
      kind: { type: 'command', command: 'check-totals', timeout_seconds: 30 },
    },
    {
      id: 'format',
      title: 'Check the format',
      kind: { type: 'command', command: 'check-format', timeout_seconds: 30 },
    },
  ] satisfies WorkflowStep[];
  const { f, lead } = await setup(definition);
  const worker = await build(f, lead);
  await eventually(
    () =>
      f.store
        .kindEvents(f.project.id, ['session.merge_blocked'])
        .some((e) => (e.payload as { reason: string }).reason === 'gate_failed'),
    () => f.control.tick(),
    10000,
  );
  const stateOf = (id: string) => runs(f).find((r) => r.step.id === id)?.state;
  expect(stateOf('totals')).toBe('failed');
  expect(stateOf('format')).toBe('pending');

  totalsFixed = true;
  await settle(f, worker);
  f.call(
    'session.send',
    { session_id: worker.id, input: 'Fix the totals' },
    current(f, worker.id).revision,
  );
  await merged(f, worker);
  expect(stateOf('totals')).toBe('passed');
  expect(stateOf('format')).toBe('passed');
});

it('runs after-merge commands in the source repository and holds the merged wake until they end', async () => {
  const release = Promise.withResolvers<validation.ValidationResult>();
  const execute = vi
    .spyOn(validation, 'runValidationCommand')
    .mockImplementation(async (input) =>
      input.argv.includes('notify-release') ? release.promise : validationResult(),
    );
  const definition = empty();
  definition.slots.after_merge = [
    {
      id: 'announce',
      title: 'Announce the release',
      kind: { type: 'command', command: 'notify-release', timeout_seconds: 30 },
    } satisfies WorkflowStep,
  ];
  const { f, lead } = await setup(definition);
  const worker = await build(f, lead);
  await merged(f, worker);
  await eventually(
    () => runs(f)[0]?.state === 'running',
    () => f.control.tick(),
  );
  const leadTurns = f.turns(lead.id).length;
  for (let i = 0; i < 3; i++) await f.control.tick();
  expect(f.turns(lead.id)).toHaveLength(leadTurns);
  expect(
    f.store.must<BoardPlan>('board_plans', lead.id).inbox.some((note) => note.kind === 'merged'),
  ).toBe(true);
  expect(execute.mock.calls.at(-1)![0]).toMatchObject({ cwd: f.source, timeoutMs: 30000 });
  release.resolve(validationResult(7));
  await eventually(
    () =>
      f
        .turns(lead.id)
        .some(
          (t) =>
            t.origin === 'tracker' &&
            t.input.includes('Workflow step “Announce the release” after the merge failed'),
        ),
    () => f.control.tick(),
  );
  expect(runs(f)[0]).toMatchObject({ state: 'failed', reason: 'release notice failed' });
  expect(current(f, worker.id).outcome).toBe('merged');
  expect(f.control.boardView(user, f.project.id, 1).tasks[0]).toBeDefined();
});

it('skips unmatched changed-path steps and runs matching glob conditions before the merge', async () => {
  const execute = vi
    .spyOn(validation, 'runValidationCommand')
    .mockResolvedValue(validationResult());
  const definition = empty();
  definition.slots.before_merge = [
    {
      id: 'frontend',
      title: 'Frontend',
      when: { changed_paths: ['src/**/*.tsx'] },
      kind: { type: 'command', command: 'frontend-check', timeout_seconds: 10 },
    },
    {
      id: 'text',
      title: 'Text',
      when: { changed_paths: ['**/*.txt'] },
      kind: { type: 'command', command: 'text-check', timeout_seconds: 10 },
    },
  ];
  const { f, lead } = await setup(definition);
  const worker = await build(f, lead);
  await merged(f, worker);
  expect(runs(f)).toMatchObject([
    { step: { id: 'frontend' }, state: 'skipped', reason: 'condition' },
    { step: { id: 'text' }, state: 'passed' },
  ]);
  expect(execute.mock.calls.some(([input]) => input.argv.includes('frontend-check'))).toBe(false);
  expect(execute.mock.calls.some(([input]) => input.argv.includes('text-check'))).toBe(true);
});

it('skips a parallel group whose steps all have unmatched changed-path conditions', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const definition = empty();
  definition.slots.before_merge = [
    {
      id: 'ui',
      title: 'UI',
      kind: {
        type: 'parallel',
        steps: [
          {
            id: 'pages',
            title: 'Pages',
            when: { changed_paths: ['src/**/*.tsx'] },
            kind: { type: 'command', command: 'pages-check', timeout_seconds: 10 },
          },
          {
            id: 'styles',
            title: 'Styles',
            when: { changed_paths: ['src/**/*.css'] },
            kind: { type: 'command', command: 'styles-check', timeout_seconds: 10 },
          },
        ],
      },
    },
  ];
  const { f, lead } = await setup(definition);
  const worker = await build(f, lead);
  await merged(f, worker);
  expect(runs(f).find((run) => run.step.id === 'ui')).toMatchObject({ state: 'skipped' });
});

it('starts parallel commands together and waits for the whole group before advancing', async () => {
  const left = Promise.withResolvers<validation.ValidationResult>();
  const right = Promise.withResolvers<validation.ValidationResult>();
  const execute = vi
    .spyOn(validation, 'runValidationCommand')
    .mockImplementation(async (input) =>
      input.argv.includes('left-check') ? left.promise : right.promise,
    );
  const definition = empty();
  definition.slots.before_dispatch = [
    {
      id: 'checks',
      title: 'Checks',
      kind: {
        type: 'parallel',
        steps: [
          {
            id: 'left',
            title: 'Left',
            kind: { type: 'command', command: 'left-check', timeout_seconds: 10 },
          },
          {
            id: 'right',
            title: 'Right',
            kind: { type: 'command', command: 'right-check', timeout_seconds: 10 },
          },
        ],
      },
    },
  ];
  const { f, lead } = await setup(definition);
  f.call('task.start', {
    project_id: f.project.id,
    lead_session_id: lead.id,
    task_ids: ['export'],
  });
  await eventually(
    () => execute.mock.calls.length === 2,
    () => f.control.tick(),
  );
  expect(workerOf(f, lead)).toBeUndefined();
  left.resolve(validationResult());
  await eventually(
    () => runs(f).some((r) => r.step.id === 'left' && r.state === 'passed'),
    () => f.control.tick(),
  );
  expect(workerOf(f, lead)).toBeUndefined();
  right.resolve(validationResult());
  await eventually(
    () => !!workerOf(f, lead),
    () => f.control.tick(),
  );
  expect(runs(f).find((r) => r.step.id === 'checks')?.state).toBe('passed');
});

it('loops until a command passes and reports a failure only when its attempts run out', async () => {
  let attempts = 0;
  const execute = vi
    .spyOn(validation, 'runValidationCommand')
    .mockImplementation(async () => validationResult(++attempts < 3 ? 7 : 0));
  const definition = empty();
  definition.slots.before_dispatch = [
    {
      id: 'retry-check',
      title: 'Retry check',
      kind: {
        type: 'loop',
        max: 3,
        until: 'passes',
        step: {
          id: 'check',
          title: 'Check',
          kind: { type: 'command', command: 'check', timeout_seconds: 10 },
        },
      },
    },
  ];
  const { f, lead } = await setup(definition);
  f.call('task.start', {
    project_id: f.project.id,
    lead_session_id: lead.id,
    task_ids: ['export'],
  });
  await eventually(
    () => !!workerOf(f, lead),
    () => f.control.tick(),
  );
  expect(execute).toHaveBeenCalledTimes(3);
  expect(runs(f).find((r) => r.step.id === 'retry-check')?.state).toBe('passed');
  expect(f.store.kindEvents(f.project.id, ['task.handed_back'])).toEqual([]);
});

it.each(['parallel', 'loop'] as const)(
  'fails a %s group when its commands exhaust their allowed attempts',
  async (type) => {
    const execute = vi
      .spyOn(validation, 'runValidationCommand')
      .mockResolvedValue(validationResult(7));
    const definition = empty();
    const step = {
      id: 'check',
      title: 'Check',
      kind: { type: 'command' as const, command: 'check', timeout_seconds: 10 },
    };
    definition.slots.before_dispatch = [
      {
        id: 'checks',
        title: 'Checks',
        kind:
          type === 'parallel'
            ? { type, steps: [step, { ...step, id: 'other' }] }
            : { type, step, max: 2, until: 'passes' },
      },
    ];
    const { f, lead } = await setup(definition);
    f.call('task.start', {
      project_id: f.project.id,
      lead_session_id: lead.id,
      task_ids: ['export'],
    });
    await eventually(
      () => runs(f).some((r) => r.step.id === 'checks' && r.state === 'failed'),
      () => f.control.tick(),
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect(workerOf(f, lead)).toBeUndefined();
    expect(f.store.kindEvents(f.project.id, ['task.handed_back'])).toHaveLength(1);
  },
);

it('dispatches parallel task parts into separate worktrees and merges them in sequence', async () => {
  let auditedCombined = false;
  const execute = vi.spyOn(validation, 'runValidationCommand').mockImplementation(async (input) => {
    if (
      input.argv.includes('audit-part') &&
      existsSync(path.join(input.cwd, 'output.txt')) &&
      existsSync(path.join(input.cwd, 'tests.txt'))
    )
      auditedCombined = true;
    return validationResult();
  });
  const definition = empty();
  definition.slots.before_merge = [
    {
      id: 'part-check',
      title: 'Check each part',
      kind: {
        type: 'loop',
        max: 1,
        until: 'passes',
        step: {
          id: 'audit',
          title: 'Audit part',
          kind: { type: 'command', command: 'audit-part', timeout_seconds: 10 },
        },
      },
    },
  ];
  definition.slots.after_merge = [
    {
      id: 'announce',
      title: 'Announce',
      when: { changed_paths: ['tests.txt'] },
      kind: { type: 'command', command: 'announce-complete', timeout_seconds: 10 },
    },
  ];
  const { f, lead } = await setup(definition, [], {
    path: 'parallel',
    parallel: [
      {
        title: 'Write output',
        goal: 'Write output',
        scope: ['output.txt'],
        acceptance: ['check-output'],
      },
      {
        title: 'Write tests',
        goal: 'Write tests',
        scope: ['tests.txt'],
        acceptance: ['check-tests'],
      },
    ],
  });
  f.call('task.start', {
    project_id: f.project.id,
    lead_session_id: lead.id,
    task_ids: ['export'],
  });
  await f.control.tick();
  const workers = f.store
    .list<Session>('sessions')
    .filter((s) => s.task?.lead_session_id === lead.id);
  expect(workers).toHaveLength(2);
  expect(new Set(workers.map((s) => s.workspace_id)).size).toBe(2);
  const parts = f.control
    .boardView(user, f.project.id, 1)
    .tasks.find((task) => task.id.endsWith(':export'))?.parallel;
  expect(parts?.map(({ title, session_id }) => ({ title, session_id }))).toEqual([
    { title: 'Write output', session_id: workers.find((s) => s.task?.parallel_index === 0)!.id },
    { title: 'Write tests', session_id: workers.find((s) => s.task?.parallel_index === 1)!.id },
  ]);
  for (const [index, worker] of workers.entries()) {
    await settle(f, worker);
    const workspace = f.store.must<Workspace>('workspaces', worker.workspace_id!);
    const file = index ? 'tests.txt' : 'output.txt';
    writeFileSync(path.join(workspace.path, file), 'complete\n');
    git(workspace.path, 'add', file);
    git(workspace.path, 'commit', '--quiet', '-m', `Write ${file}`);
    f.call(
      'session.send',
      { session_id: worker.id, input: 'Finish this part' },
      current(f, worker.id).revision,
    );
  }
  await eventually(
    () => workers.every((worker) => current(f, worker.id).outcome === 'merged'),
    () => f.control.tick(),
    15000,
  );
  const merges = f.store
    .kindEvents(f.project.id, ['session.merged'])
    .filter((e) => workers.some((w) => w.id === e.aggregate_id));
  expect(merges).toHaveLength(2);
  expect(
    execute.mock.calls.filter(([input]) => input.argv.includes('audit-part')).length,
  ).toBeGreaterThanOrEqual(2);
  expect(auditedCombined).toBe(true);
  await eventually(
    () => execute.mock.calls.some(([input]) => input.argv.includes('announce-complete')),
    () => f.control.tick(),
  );
  expect(
    execute.mock.calls.filter(([input]) => input.argv.includes('announce-complete')),
  ).toHaveLength(1);
  expect((merges[1]!.payload as { from_sha: string }).from_sha).toBe(
    (merges[0]!.payload as { to_sha: string }).to_sha,
  );
});

it('merges a parallel part whose steps before the merge pass while an earlier part stays blocked', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockImplementation(async (input) =>
    validationResult(
      input.argv.includes('audit-part') && existsSync(path.join(input.cwd, 'output.txt')) ? 7 : 0,
    ),
  );
  const definition = empty();
  definition.slots.before_merge = [
    {
      id: 'part-check',
      title: 'Check each part',
      kind: {
        type: 'loop',
        max: 1,
        until: 'passes',
        step: {
          id: 'audit',
          title: 'Audit part',
          kind: { type: 'command', command: 'audit-part', timeout_seconds: 10 },
        },
      },
    },
  ];
  const { f, lead } = await setup(definition, [], {
    path: 'parallel',
    parallel: [
      { title: 'Write output', goal: 'Write output', scope: ['output.txt'], acceptance: ['true'] },
      { title: 'Write tests', goal: 'Write tests', scope: ['tests.txt'], acceptance: ['true'] },
    ],
  });
  // A hand-back would rerun the first part's steps, holding its merge again while they run.
  f.call('workflow.policy.set', { project_id: f.project.id, gate_on_fail: 'stop' });
  f.call('task.start', {
    project_id: f.project.id,
    lead_session_id: lead.id,
    task_ids: ['export'],
  });
  await f.control.tick();
  const workers = f.store
    .list<Session>('sessions')
    .filter((s) => s.task?.lead_session_id === lead.id)
    .sort((a, b) => a.task!.parallel_index! - b.task!.parallel_index!);
  const finish = async (worker: Session, file: string) => {
    await settle(f, worker);
    const workspace = f.store.must<Workspace>('workspaces', worker.workspace_id!);
    writeFileSync(path.join(workspace.path, file), 'complete\n');
    git(workspace.path, 'add', file);
    git(workspace.path, 'commit', '--quiet', '-m', `Write ${file}`);
    f.call(
      'session.send',
      { session_id: worker.id, input: 'Finish this part' },
      current(f, worker.id).revision,
    );
  };
  await finish(workers[0]!, 'output.txt');
  await eventually(
    () =>
      runs(f).some(
        (r) =>
          r.step.id === 'part-check' && r.session_id === workers[0]!.id && r.state === 'failed',
      ),
    () => f.control.tick(),
    10000,
  );
  await finish(workers[1]!, 'tests.txt');
  await merged(f, workers[1]!);
  expect(current(f, workers[0]!.id).outcome).toBeUndefined();
  expect(current(f, workers[0]!.id).merge).toMatchObject({ reason: 'gate_failed' });
});

it("lists each parallel worker with its part's goal and keeps briefing it after the plan drops the parts", async () => {
  const { f, lead } = await setup(empty(), [], {
    path: 'parallel',
    parallel: [
      { title: 'Write output', goal: 'Write output', scope: ['output.txt'], acceptance: ['true'] },
      { title: 'Write tests', goal: 'Write tests', scope: ['tests.txt'], acceptance: ['true'] },
    ],
  });
  f.call('task.start', {
    project_id: f.project.id,
    lead_session_id: lead.id,
    task_ids: ['export'],
  });
  await f.control.tick();
  const workers = f.store
    .list<Session>('sessions')
    .filter((s) => s.task?.lead_session_id === lead.id)
    .sort((a, b) => a.task!.parallel_index! - b.task!.parallel_index!);
  expect(workers.map((worker) => f.list().find((row) => row.id === worker.id)?.goal?.text)).toEqual(
    ['Write output', 'Write tests'],
  );
  const plan = f.store.must<BoardPlan>('board_plans', lead.id);
  f.store.update(
    'board_plans',
    {
      ...plan,
      tasks: plan.tasks.map(({ parallel: _, ...task }) => ({ ...task, path: 'dispatch' as const })),
    },
    plan.revision,
  );
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  for (const worker of workers)
    expect(workerInstructions(ctx, worker.task!, undefined)).toContain('"Export the report"');
});
