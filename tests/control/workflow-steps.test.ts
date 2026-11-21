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
  SessionHandle,
  SessionTurn,
  StepRun,
  UserTurn,
  Workspace,
} from '@pantheon/domain';
import { DomainError } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import * as gitCommands from '../../packages/control/dist/git.js';
import * as landingDiff from '../../packages/control/dist/landing-diff.js';
import * as validation from '../../packages/control/dist/validation-executor.js';
import { workerInstructions } from '../../packages/control/dist/workbench-session.js';
import { REVIEW_LOOP_STEP_ID } from '../../packages/control/dist/merge-review.js';
import { eventually, settle, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
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

/** A reviewer whose turns end with no finding and no reply. */
class SilentReviewer extends FixtureAdapter {
  override send(handle: SessionHandle, turn: UserTurn) {
    return super.send(handle, { ...turn, input: script() });
  }
}

async function setup(
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

it("shows the step runs of the task's current generation on its board row", async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const { f, lead } = await setup([], { path: 'review_loop' });
  const reviewer = new SilentReviewer(1);
  reviewer.name = 'reviewer';
  f.control.adapters.set(reviewer.name, reviewer);
  const worker = await build(f, lead);
  await eventually(
    () => runs(f).some((r) => r.state === 'failed'),
    () => f.control.tick(),
    10000,
  );
  const row = () =>
    f.control.boardView(user, f.project.id, 1).tasks.find((t) => t.id === `${lead.id}:export`)!;
  const [old] = runs(f);
  expect(row().step_runs).toEqual([
    {
      id: old!.id,
      slot: 'before_merge',
      step_id: REVIEW_LOOP_STEP_ID,
      title: 'Code review',
      kind: 'review',
      state: 'failed',
      reason: old!.reason,
      session_id: worker.id,
      created_at: old!.created_at,
      finished_at: old!.finished_at,
      reviewers: [{ runtime: 'reviewer' }],
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
});

it('reviews on another runtime, returns blocking findings to the task session, and reviews again after its turn', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const { f, lead } = await setup([], { path: 'review_loop' });
  const reviewer = new FixtureAdapter(1);
  reviewer.name = 'reviewer';
  f.control.adapters.set(reviewer.name, reviewer);
  passReviews(f, reviewer);
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

it('fails a blocking review step whose reviewer ends its turn with no finding and no reply', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const { f, lead } = await setup([], { path: 'review_loop' });
  const reviewer = new SilentReviewer(1);
  reviewer.name = 'reviewer';
  f.control.adapters.set(reviewer.name, reviewer);
  const worker = await build(f, lead);
  await eventually(
    () => ['passed', 'failed'].includes(runs(f)[0]?.state ?? ''),
    () => f.control.tick(),
    10000,
  );
  const run = runs(f)[0]!;
  expect(run.state).toBe('failed');
  expect(f.store.must<Review>('reviews', run.review_id!)).toMatchObject({
    state: 'completed',
    findings: [],
    incomplete: 'reviewer reviewer ended its turn with no finding and no reply',
  });
  expect(current(f, worker.id).outcome).toBeUndefined();
});

it("reviews on the writer's runtime in a new read-only session when no other runtime can review, and merges once the review passes", async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const { f, lead } = await setup([], { path: 'review_loop' });
  passReviews(f, f.adapter);
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

it("opens the task session and its review on the project's defaults when the project uses one model", async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const { f, lead } = await setup([], { path: 'review_loop' });
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
  });
});

it('stops reviewing at the default round limit and hands the task back to the lead', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const { f, lead } = await setup([], { path: 'review_loop' });
  const reviewer = new FixtureAdapter(1);
  reviewer.name = 'reviewer';
  f.control.adapters.set(reviewer.name, reviewer);
  const worker = await build(f, lead);
  await eventually(
    () => !!runs(f)[0]?.review_id,
    () => f.control.tick(),
    10000,
  );
  const first = runs(f)[0]!;
  const reviewsOf = () =>
    f.store.list<Review>('reviews').filter((r) => r.requester?.step_run_id === first.id);
  for (let round = 1; round <= 3; round++) {
    await eventually(
      () =>
        reviewsOf().length === round &&
        f.store.must<StepRun>('workflow_step_runs', first.id).state === 'running',
      () => f.control.tick(),
      10000,
    );
    addBlockingFinding(f, f.store.must<StepRun>('workflow_step_runs', first.id).review_id!);
  }
  await eventually(
    () =>
      /at most 3 round/.test(f.store.must<StepRun>('workflow_step_runs', first.id).reason ?? ''),
    () => f.control.tick(),
    10000,
  );
  expect(f.store.must<StepRun>('workflow_step_runs', first.id).state).toBe('failed');
  expect(current(f, worker.id).outcome).toBeUndefined();
  expect(reviewsOf()).toHaveLength(3);
  expect(
    f.store
      .kindEvents(f.project.id, ['task.reported'])
      .some((e) => /at most 3 round/.test((e.payload as LeadNote).text)),
  ).toBe(true);
});

/** Adds a reviewer runtime besides the writer's fixture runtime; its reviews find nothing and pass. */
function addReviewer(f: Fixture) {
  const reviewer = new FixtureAdapter(1);
  reviewer.name = 'reviewer';
  f.control.adapters.set(reviewer.name, reviewer);
  passReviews(f, reviewer);
}
/** Each reviewer session on this adapter hands in a pass verdict as its turn starts, as review_verdict does. */
function passReviews(f: Fixture, adapter: FixtureAdapter) {
  const send = adapter.send.bind(adapter);
  adapter.send = async (handle, turn) => {
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
  const { f, lead } = await setup([], { path: 'review_loop' });
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
      kind: { type: 'review' },
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
  const { f, lead } = await setup([], { path: 'review_loop' });
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
  const { f, lead } = await setup([], { path: 'review_loop' });
  passReviews(f, f.adapter);
  const worker = await build(f, lead);
  await merged(f, worker);
  const run = runs(f)[0]!;
  expect(run).toMatchObject({ step: { id: REVIEW_LOOP_STEP_ID }, state: 'passed' });
  expect(f.store.must<Review>('reviews', run.review_id!).runtimes).toEqual(['fixture']);
});

it("reviews a task without a path whose tier's policy path is the review loop", async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const { f, lead } = await setup([], { path: undefined });
  f.call('workflow.policy.set', { project_id: f.project.id, path: { t2: 'review_loop' } }, null);
  addReviewer(f);
  const worker = await build(f, lead);
  await merged(f, worker);
  expect(runs(f)).toMatchObject([{ step: { id: REVIEW_LOOP_STEP_ID }, state: 'passed' }]);
});

it('does not review a dispatch task when the policy gives its tier the review loop', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const { f, lead } = await setup();
  f.call('workflow.policy.set', { project_id: f.project.id, path: { t2: 'review_loop' } }, null);
  addReviewer(f);
  const worker = await build(f, lead);
  await merged(f, worker);
  expect(runs(f)).toEqual([]);
  expect(f.store.list<Review>('reviews')).toEqual([]);
});

/** The adapter's first turn waits a while and ends with no finding and no reply; later turns run as before. */
function slowFirstReview(adapter: FixtureAdapter) {
  const send = adapter.send.bind(adapter);
  let first = true;
  adapter.send = async (handle, turn) => {
    if (!first) return send(handle, turn);
    first = false;
    return FixtureAdapter.prototype.send.call(adapter, handle, {
      ...turn,
      input: script({ wait: 1500 }),
    });
  };
}
/** Commits a header row in the task session's worktree and returns the new head. */
function commitHeader(f: Fixture, worker: Session) {
  const workspace = f.store.must<Workspace>('workspaces', worker.workspace_id!);
  writeFileSync(path.join(workspace.path, 'answer.txt'), 'name\nexported\n');
  git(workspace.path, 'add', 'answer.txt');
  git(workspace.path, 'commit', '--quiet', '-m', 'Add the header row');
  return git(workspace.path, 'rev-parse', 'HEAD');
}
const reviewsOf = (f: Fixture, sessionId: string) =>
  f.store.list<Review>('reviews').filter((r) => r.session_id === sessionId);
const handBacks = (f: Fixture, sessionId: string) =>
  f.store
    .kindEvents(f.project.id, ['task.reported'])
    .map((e) => e.payload as LeadNote)
    .filter((note) => note.session_id === sessionId);

it('hands the task back once when the turn sent the review findings fails, and reopens the review on request_review', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const { f, lead } = await setup([], { path: 'review_loop' });
  const reviewer = new FixtureAdapter(1);
  reviewer.name = 'reviewer';
  f.control.adapters.set(reviewer.name, reviewer);
  const send = f.adapter.send.bind(f.adapter);
  f.adapter.send = async (handle, turn) =>
    send(
      handle,
      turn.input.includes('found problems to fix')
        ? { ...turn, input: script({ fail: 'The model went away' }) }
        : turn,
    );
  const worker = await build(f, lead);
  await reviewStarted(f);
  const run = runs(f)[0]!;
  addBlockingFinding(f, run.review_id!);
  await eventually(
    () =>
      f
        .turns(worker.id)
        .some((t) => t.input.includes('found problems to fix') && t.state === 'failed'),
    () => f.control.tick(),
    10000,
  );
  for (let i = 0; i < 3; i++) await f.control.tick();
  expect(f.store.must<StepRun>('workflow_step_runs', run.id)).toMatchObject({ state: 'failed' });
  expect(f.store.must<StepRun>('workflow_step_runs', run.id)).not.toHaveProperty('turn_id');
  expect(
    handBacks(f, worker.id).filter((note) =>
      /turn with the review findings failed/.test(note.text),
    ),
  ).toHaveLength(1);
  passReviews(f, reviewer);
  f.call(
    'session.send',
    { session_id: worker.id, input: 'Fix the findings' },
    current(f, worker.id).revision,
  );
  await eventually(
    () => current(f, worker.id).merge?.reason === 'workflow_approval',
    () => f.control.tick(),
    10000,
  );
  await expect(
    f.call(
      'review.request',
      { session_id: worker.id, runtimes: [reviewer.name] },
      null,
      principal(f, lead.id),
    ),
  ).resolves.toEqual({ reopened: run.id });
  await merged(f, worker);
  expect(f.store.must<StepRun>('workflow_step_runs', run.id).state).toBe('passed');
});

it('reopens on request_review a review step that failed before its review started', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const range = landingDiff.sessionRangeAsync;
  let broken = false;
  vi.spyOn(landingDiff, 'sessionRangeAsync').mockImplementation(async (ctx, session, ...rest) => {
    if (!broken && session.merge?.reason === 'workflow_approval') {
      broken = true;
      throw new DomainError('git_failed', 'The changes could not be read');
    }
    return range(ctx, session, ...rest);
  });
  const { f, lead } = await setup([], { path: 'review_loop' });
  addReviewer(f);
  const worker = await build(f, lead);
  await eventually(
    () => runs(f)[0]?.state === 'failed',
    () => f.control.tick(),
    10000,
  );
  const run = runs(f)[0]!;
  expect(run).not.toHaveProperty('review_id');
  expect(current(f, worker.id).merge?.reason).toBe('workflow_approval');
  await f.call(
    'review.request',
    { session_id: worker.id, runtimes: ['reviewer'] },
    null,
    principal(f, lead.id),
  );
  expect(f.store.must<StepRun>('workflow_step_runs', run.id).state).toBe('pending');
  await merged(f, worker);
  expect(f.store.must<StepRun>('workflow_step_runs', run.id).state).toBe('passed');
  expect(reviewsOf(f, worker.id)).toHaveLength(1);
});

it('reviews again a commit made while the review ran, after its turn cleared the held merge', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const { f, lead } = await setup([], { path: 'review_loop' });
  const reviewer = new FixtureAdapter(1);
  reviewer.name = 'reviewer';
  f.control.adapters.set(reviewer.name, reviewer);
  passReviews(f, reviewer);
  slowFirstReview(reviewer);
  const worker = await build(f, lead);
  await reviewStarted(f);
  const run = runs(f)[0]!,
    first = git(
      f.store.must<Workspace>('workspaces', worker.workspace_id!).path,
      'rev-parse',
      'HEAD',
    );
  const second = commitHeader(f, worker);
  f.call(
    'session.send',
    { session_id: worker.id, input: 'Add the header row' },
    current(f, worker.id).revision,
  );
  await f.control.tick();
  expect(f.store.must<StepRun>('workflow_step_runs', run.id)).toMatchObject({ state: 'pending' });
  expect(f.store.must<StepRun>('workflow_step_runs', run.id)).not.toHaveProperty('review_id');
  await merged(f, worker);
  expect(f.store.must<StepRun>('workflow_step_runs', run.id).state).toBe('passed');
  expect(reviewsOf(f, worker.id).map((r) => r.range?.to_sha)).toEqual([first, second]);
  expect(git(f.source, 'rev-parse', 'HEAD')).toBe(second);
});

it('starts no review for a held merge that a turn cleared while the changes were read', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const range = landingDiff.sessionRangeAsync;
  let read!: () => void;
  const reading = new Promise<void>((resolve) => (read = resolve));
  let heldReads = 0;
  // The diff read right after the held range; the review step decides once it resolves.
  let diffed: Promise<unknown> | undefined;
  vi.spyOn(landingDiff, 'sessionRangeAsync').mockImplementation(async (ctx, session, ...rest) => {
    if (session.merge?.reason !== 'workflow_approval' || heldReads++)
      return range(ctx, session, ...rest);
    await reading;
    const read = await range(ctx, session, ...rest);
    const diff = gitCommands.runGit;
    const spy = vi.spyOn(gitCommands, 'runGit').mockImplementation((...args) => {
      const result = diff(...args);
      if (args[1][0] === 'diff' && !diffed) {
        diffed = result.then(() => new Promise((resolve) => setImmediate(resolve)));
        spy.mockRestore();
      }
      return result;
    });
    return read;
  });
  const { f, lead } = await setup([], { path: 'review_loop' });
  addReviewer(f);
  const worker = await build(f, lead);
  await eventually(
    () => heldReads > 0,
    () => f.control.tick(),
    10000,
  );
  const second = commitHeader(f, worker);
  f.call(
    'session.send',
    { session_id: worker.id, input: 'Add the header row' },
    current(f, worker.id).revision,
  );
  read();
  await eventually(() => diffed !== undefined);
  await diffed;
  expect(reviewsOf(f, worker.id)).toEqual([]);
  expect(runs(f).map((r) => r.state)).toEqual(['pending']);
  await merged(f, worker);
  expect(reviewsOf(f, worker.id).map((r) => r.range?.to_sha)).toEqual([second]);
});

it('retires the review run of a task session discarded while its review runs, and hands nothing back for it', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const { f, lead } = await setup([], { path: 'review_loop' });
  const reviewer = new FixtureAdapter(1);
  reviewer.name = 'reviewer';
  f.control.adapters.set(reviewer.name, reviewer);
  slowFirstReview(reviewer);
  const worker = await build(f, lead);
  await reviewStarted(f);
  const run = runs(f)[0]!;
  f.call('session.discard', { session_id: worker.id }, current(f, worker.id).revision);
  await eventually(
    () => current(f, worker.id).state === 'closed',
    () => f.control.tick(),
    10000,
  );
  await f.control.tick();
  expect(f.store.must<StepRun>('workflow_step_runs', run.id).state).toBe('retired');
  await eventually(
    () => f.store.must<Review>('reviews', run.review_id!).state !== 'running',
    () => f.control.tick(),
    10000,
  );
  for (let i = 0; i < 3; i++) await f.control.tick();
  expect(f.store.must<StepRun>('workflow_step_runs', run.id).state).toBe('retired');
  expect(handBacks(f, worker.id)).toEqual([]);
});

const storedCommand = (id: string) => ({
  id,
  title: id,
  kind: { type: 'command', command: `${id}-command`, timeout_seconds: 10 },
});

it('retires an unfinished command run of an older daemon on restart and lets the merge it held go on', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const { f, lead } = await setup();
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
  const held = current(f, worker.id);
  f.store.update(
    'sessions',
    { ...held, merge: { state: 'blocked', reason: 'workflow_approval' } },
    held.revision,
  );
  const old = f.store.insert('workflow_step_runs', {
    id: 'older-command-run',
    revision: 1,
    project_id: f.project.id,
    lead_session_id: lead.id,
    task_id: 'export',
    generation: 1,
    definition_version: 1,
    slot: 'before_merge',
    step: storedCommand('merge-check'),
    state: 'running',
    created_at: Date.now(),
    session_id: worker.id,
  } as unknown as StepRun);
  await f.restart(() => undefined);
  expect(f.store.must<StepRun>('workflow_step_runs', old.id).state).toBe('retired');
  await merged(f, worker);
});

const storedApproval = { id: 'signoff', title: 'Approve the merge', kind: { type: 'approval' } };

it('retires an approval run an older daemon left waiting on restart and lets the merge it held go on', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const { f, lead } = await setup();
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
  const held = current(f, worker.id);
  f.store.update(
    'sessions',
    { ...held, merge: { state: 'blocked', reason: 'workflow_approval' } },
    held.revision,
  );
  const old = f.store.insert('workflow_step_runs', {
    id: 'older-approval-run',
    revision: 1,
    project_id: f.project.id,
    lead_session_id: lead.id,
    task_id: 'export',
    generation: 1,
    definition_version: 1,
    slot: 'before_merge',
    step: storedApproval,
    state: 'waiting',
    created_at: Date.now(),
    session_id: worker.id,
  } as unknown as StepRun);
  await f.restart(() => undefined);
  expect(f.store.must<StepRun>('workflow_step_runs', old.id).state).toBe('retired');
  await merged(f, worker);
});

const storedPrompt = {
  id: 'tidy',
  title: 'Tidy the change',
  kind: { type: 'prompt', prompt: 'Simplify what you changed', expects: 'verdict' },
};

it.each(['inconclusive', 'waiting', 'running'])(
  'retires a prompt run an older daemon left %s on restart and lets the merge it held go on',
  async (state) => {
    vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
    const { f, lead } = await setup();
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
    const held = current(f, worker.id);
    f.store.update(
      'sessions',
      { ...held, merge: { state: 'blocked', reason: 'workflow_approval' } },
      held.revision,
    );
    const old = f.store.insert('workflow_step_runs', {
      id: 'older-prompt-run',
      revision: 1,
      project_id: f.project.id,
      lead_session_id: lead.id,
      task_id: 'export',
      generation: 1,
      definition_version: 1,
      slot: 'before_merge',
      step: storedPrompt,
      state,
      created_at: Date.now(),
      session_id: worker.id,
    } as unknown as StepRun);
    await f.restart(() => undefined);
    expect(f.store.must<StepRun>('workflow_step_runs', old.id).state).toBe('retired');
    await merged(f, worker);
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
  const { f, lead } = await setup([], {
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
  await f.call(
    'project.gate.set',
    {
      project_id: f.project.id,
      root: f.source,
      commands: [{ name: 'Audit part', argv: ['audit-part'] }],
    },
    f.store.must<Project>('projects', f.project.id).revision,
  );
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
  expect((merges[1]!.payload as { from_sha: string }).from_sha).toBe(
    (merges[0]!.payload as { to_sha: string }).to_sha,
  );
});

it("lists each parallel worker with its part's goal and keeps briefing it after the plan drops the parts", async () => {
  const { f, lead } = await setup([], {
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
