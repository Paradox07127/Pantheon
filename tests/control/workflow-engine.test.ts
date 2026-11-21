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
  SessionTurn,
  StepRun,
  Workspace,
} from '@pantheon/domain';
import * as validation from '../../packages/control/dist/validation-executor.js';
import {
  REVIEW_LOOP_STEP_ID,
  REVIEW_MAX_ROUNDS,
} from '../../packages/control/dist/merge-review.js';
import { eventually, settle, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
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
const start = (f: Fixture, lead: Session, asLead = false) =>
  f.call(
    'task.start',
    { project_id: f.project.id, lead_session_id: lead.id, task_ids: ['export'] },
    null,
    asLead ? principal(f, lead.id) : user,
  );
const workerOf = (f: Fixture, lead: Session) =>
  f.store.list<Session>('sessions').find((s) => s.task?.lead_session_id === lead.id)!;

async function setup(path: BoardPlan['tasks'][number]['path'] = 'dispatch') {
  const f = await workbenchFixture({ delay: 1 });
  git(f.source, 'config', 'user.name', 'Source User');
  git(f.source, 'config', 'user.email', 'source@example.invalid');
  const lead = await f.create('Plan the export');
  await settle(f, lead);
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
        path,
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
/** Adds a reviewer runtime whose review sessions hand in a pass verdict as their turn starts. */
function passingReviewer(f: Fixture) {
  const reviewer = new FixtureAdapter(1);
  reviewer.name = 'reviewer';
  f.control.adapters.set(reviewer.name, reviewer);
  const send = reviewer.send.bind(reviewer);
  reviewer.send = async (handle, turn) => {
    const session = current(f, f.store.must<SessionTurn>('session_turns', turn.turn_id).session_id);
    if (session.review_id)
      f.call(
        'review.verdict',
        { verdict: 'pass', summary: 'No findings: checked answer.txt against the goal' },
        null,
        { ...principal(f, session.id), role: 'reviewer' },
      );
    return send(handle, turn);
  };
  return reviewer;
}
/** The payloads of the session's merge holds since its first merge started. */
function heldAfterFirstMerge(f: Fixture, sessionId: string) {
  const started = f.store
    .kindEvents(f.project.id, ['session.merge_started'])
    .find((event) => event.aggregate_id === sessionId)!;
  return f.store
    .events(started.sequence, f.project.id, 100000)
    .filter((event) => event.aggregate_id === sessionId && event.kind === 'session.merge_held')
    .map((event) => event.payload);
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

it('dispatches and merges through the existing path', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const { f, lead } = await setup();
  enableMerge(f);
  start(f, lead);
  await f.control.tick();
  const worker = workerOf(f, lead);
  expect(worker.task).toMatchObject({ generation: 1 });
  const head = await build(f, worker);
  await eventually(
    () => current(f, worker.id).outcome === 'merged',
    () => f.control.tick(),
    10000,
  );
  expect(git(f.source, 'rev-parse', 'HEAD')).toBe(head);
  expect(runs(f)).toEqual([]);
});

it('holds a t3 task for its plan review and a task session at the review round limit', async () => {
  const { f, lead } = await setup();
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
      tasks: plan.tasks.map((task) => ({ ...task, kind: { tier: 't3', domain: 'backend-logic' } })),
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    principal(f, lead.id),
  );
  start(f, lead);
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
  for (let round = 1; round <= REVIEW_MAX_ROUNDS; round++)
    f.store.insert<Review>('reviews', {
      id: `prior-review-${round}`,
      revision: 1,
      project_id: f.project.id,
      session_id: worker.id,
      state: 'completed',
      session_ids: [],
      runtimes: [reviewer.name],
      findings: [],
      executions: [],
      round,
    });
  await expect(
    f.call(
      'review.request',
      { session_id: worker.id, runtimes: [reviewer.name] },
      null,
      principal(f, lead.id),
    ),
  ).rejects.toThrowError(
    expect.objectContaining({
      code: 'invalid_state',
      message: expect.stringContaining('at most 3'),
    }),
  );
});

it('preserves an admitted scope override when a review step resumes its merge', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const { f, lead } = await setup('review_loop');
  passingReviewer(f);
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
    () => current(f, worker.id).outcome === 'merged',
    () => f.control.tick(),
  );
  expect(git(f.source, 'rev-parse', 'HEAD')).toBe(head);
  expect(runs(f).map((run) => [run.step.id, run.state])).toEqual([[REVIEW_LOOP_STEP_ID, 'passed']]);
  expect(heldAfterFirstMerge(f, worker.id)).toMatchObject([{ reason: 'workflow_approval' }]);
});

it('holds the merge after the gate for its review without a task place, and lands it after a daemon restart without gating again', async () => {
  const execute = vi
    .spyOn(validation, 'runValidationCommand')
    .mockResolvedValue(validationResult());
  const { f, lead } = await setup('review_loop');
  enableMerge(f);
  let gatesAtReview: number | undefined;
  const reviewer = passingReviewer(f);
  const send = reviewer.send;
  reviewer.send = async (handle, turn) => {
    gatesAtReview ??= execute.mock.calls.length;
    return send(handle, turn);
  };
  start(f, lead);
  await f.control.tick();
  const worker = workerOf(f, lead),
    sourceHead = git(f.source, 'rev-parse', 'HEAD');
  const head = await build(f, worker);
  await eventually(
    () =>
      current(f, worker.id).merge?.reason === 'workflow_approval' &&
      runs(f).some((run) => run.state === 'pending'),
    () => f.control.tick(),
    10000,
  );
  const gates = [['/bin/sh', '-c', 'true']];
  expect(execute.mock.calls.map((call) => call[0].argv)).toEqual(gates);
  expect(git(f.source, 'rev-parse', 'HEAD')).toBe(sourceHead);
  // A stopping daemon starts no review, so the review runs on the restarted one.
  await f.control.shutdown();
  expect(runs(f).map((run) => [run.state, run.review_id])).toEqual([['pending', undefined]]);
  await f.restart(() => undefined, { abandon: true });
  await eventually(
    () => current(f, worker.id).outcome === 'merged',
    () => f.control.tick(),
    10000,
  );
  expect(git(f.source, 'rev-parse', 'HEAD')).toBe(head);
  expect(runs(f).map((run) => [run.step.id, run.state])).toEqual([[REVIEW_LOOP_STEP_ID, 'passed']]);
  expect(gatesAtReview).toBe(1);
  expect(execute.mock.calls.map((call) => call[0].argv)).toEqual(gates);
});

it.each([
  [
    'is removed from the plan',
    (f: Fixture, plan: BoardPlan) =>
      f.store.update('board_plans', { ...plan, tasks: [], retired: { export: 1 } }, plan.revision),
    // The tracker closes the session of a removed task.
    (session: Session) => session.state === 'closed',
  ],
  [
    'moves to a new generation',
    (f: Fixture, plan: BoardPlan) =>
      f.store.update(
        'board_plans',
        { ...plan, generations: { export: { generation: 2, contract: 'changed' } } },
        plan.revision,
      ),
    (session: Session) => session.merge?.reason === 'task_retired',
  ],
])(
  'stops a merge held for its review when the task %s, without merging',
  async (_, change, stopped) => {
    vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
    const { f, lead } = await setup('review_loop');
    start(f, lead);
    await f.control.tick();
    const worker = workerOf(f, lead);
    await settle(f, worker);
    const workspace = f.store.must<Workspace>('workspaces', worker.workspace_id!);
    writeFileSync(path.join(workspace.path, 'answer.txt'), 'exported\n');
    git(workspace.path, 'add', 'answer.txt');
    git(workspace.path, 'commit', '--quiet', '-m', 'Export the report');
    const sourceHead = git(f.source, 'rev-parse', 'HEAD');
    const held = current(f, worker.id);
    f.store.update(
      'sessions',
      { ...held, merge: { state: 'blocked', reason: 'workflow_approval' } },
      held.revision,
    );
    await f.control.tick();
    expect(runs(f)).toHaveLength(1);
    change(f, planOf(f, lead.id));
    await f.control.tick();
    expect(runs(f).map((run) => run.state)).toEqual(['retired']);
    await eventually(
      () => stopped(current(f, worker.id)),
      () => f.control.tick(),
      10000,
    );
    expect(current(f, worker.id).outcome).not.toBe('merged');
    expect(git(f.source, 'rev-parse', 'HEAD')).toBe(sourceHead);
  },
);

it('uses the review round limit for sessions outside a plan task', async () => {
  const { f, lead } = await setup();
  const reviewer = new FixtureAdapter(1);
  reviewer.name = 'reviewer';
  f.control.adapters.set(reviewer.name, reviewer);
  const workspace = f.store.must<Workspace>('workspaces', lead.workspace_id!);
  writeFileSync(path.join(workspace.path, 'answer.txt'), 'review this change\n');
  git(workspace.path, 'add', 'answer.txt');
  git(workspace.path, 'commit', '--quiet', '-m', 'Export');
  for (let round = 1; round <= REVIEW_MAX_ROUNDS; round++)
    f.store.insert<Review>('reviews', {
      id: `prior-review-${round}`,
      revision: 1,
      project_id: f.project.id,
      session_id: lead.id,
      state: 'completed',
      session_ids: [],
      runtimes: [reviewer.name],
      findings: [],
      round,
    });
  await expect(
    f.call('review.request', { session_id: lead.id, runtimes: [reviewer.name] }),
  ).rejects.toThrowError(
    expect.objectContaining({
      code: 'invalid_state',
      message: expect.stringContaining('at most 3'),
    }),
  );
});
