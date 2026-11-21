import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type {
  BoardPlan,
  LeadNote,
  Principal,
  Project,
  Review,
  Session,
  SessionHandle,
  StepRun,
  UserTurn,
  Workspace,
} from '@pantheon/domain';
import * as validation from '../../packages/control/dist/validation-executor.js';
import { eventually, settle, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
const current = (f: Fixture, id: string) => f.store.must<Session>('sessions', id);
const runs = (f: Fixture) => f.store.list<StepRun>('workflow_step_runs');
const principal = (f: Fixture, id: string, role: 'lead' | 'worker' | 'reviewer'): Principal => ({
  id: `session:${id}`,
  role,
  session_id: id,
  project_id: f.project.id,
  expires_at: Date.now() + 60000,
});
const workerOf = (f: Fixture, lead: Session) =>
  f.store.list<Session>('sessions').find((s) => s.task?.lead_session_id === lead.id)!;
const script = (...steps: object[]) => `fixture-script\n${JSON.stringify(steps)}`;

async function setup(fields: Partial<BoardPlan['tasks'][number]> = {}) {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue({
    exit_code: 0,
    signal: null,
    duration_ms: 1,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    log: Buffer.alloc(0),
    tail: '',
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
  });
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

const startTask = (f: Fixture, lead: Session) =>
  f.call('task.start', {
    project_id: f.project.id,
    lead_session_id: lead.id,
    task_ids: ['export'],
  });

/** Opens the task session and commits its work, then ends a turn so the automatic merge starts. */
async function build(f: Fixture, lead: Session) {
  startTask(f, lead);
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

/** A reviewer that replies with one line, then stays running long enough to hand in a verdict. */
class ReplyingReviewer extends FixtureAdapter {
  override send(handle: SessionHandle, turn: UserTurn) {
    return super.send(handle, {
      ...turn,
      input: script({ say: 'Checked answer.txt against the goal' }, { wait: 2000 }),
    });
  }
}

/** A reviewer that stays running long enough to hand in a verdict, then ends with no reply. */
class SilentReviewer extends FixtureAdapter {
  override send(handle: SessionHandle, turn: UserTurn) {
    return super.send(handle, { ...turn, input: script({ wait: 2000 }) });
  }
}

/** The review a review loop task gets before the merge, once its reviewer on another runtime is running. */
async function reviewingLoop(Reviewer: typeof FixtureAdapter = ReplyingReviewer) {
  const { f, lead } = await setup({ path: 'review_loop' });
  return reviewerRunning(f, lead, Reviewer);
}

async function reviewerRunning(f: Fixture, lead: Session, Reviewer: typeof FixtureAdapter) {
  const reviewer = new Reviewer(1);
  reviewer.name = 'reviewer';
  f.control.adapters.set(reviewer.name, reviewer);
  const worker = await build(f, lead);
  const review = () => f.store.must<Review>('reviews', runs(f)[0]!.review_id!);
  await eventually(
    () => !!runs(f)[0]?.review_id && f.turns(review().session_ids[0]!)[0]?.state === 'running',
    () => f.control.tick(),
    10000,
  );
  return { f, lead, worker, review, reviewerId: review().session_ids[0]! };
}

it("fails a blocking review step on a reviewer's fail verdict without findings and quotes its summary to the lead", async () => {
  const { f, worker, review, reviewerId } = await reviewingLoop();
  f.call(
    'review.verdict',
    { verdict: 'fail', summary: 'The export drops the header row' },
    null,
    principal(f, reviewerId, 'reviewer'),
  );
  await eventually(
    () => ['passed', 'failed'].includes(runs(f)[0]?.state ?? ''),
    () => f.control.tick(),
    10000,
  );
  expect(runs(f)[0]!.state).toBe('failed');
  expect(review()).toMatchObject({ state: 'completed', findings: [] });
  expect(
    f.store.kindEvents(f.project.id, ['lead.note_added']).map((e) => e.payload as LeadNote),
  ).toContainEqual(
    expect.objectContaining({
      kind: 'blocked',
      text: expect.stringContaining('reviewer: The export drops the header row'),
    }),
  );
  expect(current(f, worker.id).outcome).toBeUndefined();
});

it('fails a blocking review step whose reviewer hands in no verdict and wakes the lead with its name', async () => {
  const { f, lead, worker, review } = await reviewingLoop();
  await eventually(
    () => ['passed', 'failed'].includes(runs(f)[0]?.state ?? ''),
    () => f.control.tick(),
    10000,
  );
  expect(runs(f)[0]!.state).toBe('failed');
  expect(review()).toMatchObject({ state: 'completed', findings: [] });
  expect(review()).not.toHaveProperty('incomplete');
  expect(
    f.store.kindEvents(f.project.id, ['lead.note_added']).map((e) => e.payload as LeadNote),
  ).toContainEqual(
    expect.objectContaining({
      kind: 'blocked',
      text: expect.stringContaining(`Review ${review().id}: reviewer handed in no verdict`),
    }),
  );
  await eventually(
    () => f.turns(lead.id).some((turn) => turn.origin === 'tracker'),
    () => f.control.tick(),
    10000,
  );
  expect(current(f, worker.id).outcome).toBeUndefined();
});

/** The lead's request_review for its task session. */
const requestReview = (f: Fixture, lead: Session, worker: Session) =>
  f.call<Promise<Record<string, unknown>>>(
    'review.request',
    { session_id: worker.id, runtimes: ['reviewer'] },
    null,
    principal(f, lead.id, 'lead'),
  );
const notes = (f: Fixture) =>
  f.store.kindEvents(f.project.id, ['lead.note_added']).map((e) => e.payload as LeadNote);
const stepFailed = (f: Fixture) =>
  eventually(
    () => runs(f)[0]?.state === 'failed',
    () => f.control.tick(),
    10000,
  );

it("runs a review step whose reviewer handed in no verdict again on the lead's request_review, and merges once it passes", async () => {
  const { f, lead, worker, review } = await reviewingLoop();
  await stepFailed(f);
  const failed = runs(f)[0]!,
    first = review();
  expect(notes(f)).toContainEqual(
    expect.objectContaining({
      kind: 'blocked',
      text: expect.stringContaining(
        `Review ${first.id}: reviewer handed in no verdict.\nCall request_review for this task to run the review again.`,
      ),
    }),
  );
  expect(notes(f).map((note) => note.text)).not.toContainEqual(
    expect.stringContaining('send the verdict back'),
  );
  const turns = f.turns(worker.id).length;
  expect(await requestReview(f, lead, worker)).toEqual({ reopened: failed.id });
  expect(f.turns(worker.id)).toHaveLength(turns);
  expect(runs(f)[0]).toMatchObject({ id: failed.id, state: 'pending' });
  expect(runs(f)[0]).not.toHaveProperty('review_id');
  await eventually(
    () =>
      !!runs(f)[0]?.review_id &&
      review().id !== first.id &&
      f.turns(review().session_ids[0]!)[0]?.state === 'running',
    () => f.control.tick(),
    10000,
  );
  f.call(
    'review.verdict',
    { verdict: 'pass', summary: 'Checked answer.txt against the goal' },
    null,
    principal(f, review().session_ids[0]!, 'reviewer'),
  );
  await merged(f, worker);
  expect(runs(f)[0]).toMatchObject({ id: failed.id, state: 'passed' });
  expect(f.store.list<Review>('reviews').map((r) => r.requester?.step_run_id)).toEqual([
    failed.id,
    failed.id,
  ]);
});

/** Fails the running review step by the reviewer's verdict and waits for the step to fail. */
async function failedByVerdict(f: Fixture, reviewerId: string) {
  f.call(
    'review.verdict',
    { verdict: 'fail', summary: 'The export drops the header row' },
    null,
    principal(f, reviewerId, 'reviewer'),
  );
  await stepFailed(f);
  return runs(f)[0]!;
}

it("sends a reviewer's fail verdict and open findings to the task session on the lead's request_review, and reviews again after its turn", async () => {
  const { f, lead, worker, review, reviewerId } = await reviewingLoop();
  const first = review();
  f.store.update<Review>(
    'reviews',
    {
      ...first,
      findings: [
        {
          id: 'missing-header',
          runtime: 'reviewer',
          location: 'answer.txt:1',
          quote: 'exported',
          evidence: 'The export has no header row',
          impact: 'Readers cannot tell the columns apart',
          blocking: false,
          status: 'open',
        } as Review['findings'][number],
      ],
    },
    first.revision,
  );
  const failed = await failedByVerdict(f, reviewerId);
  expect(notes(f)).toContainEqual(
    expect.objectContaining({
      kind: 'blocked',
      text: expect.stringContaining(
        'reviewer: The export drops the header row\nCall request_review for this task to send the verdict back to the task session; the review runs again after its turn.',
      ),
    }),
  );
  const handed = await requestReview(f, lead, worker);
  expect(handed).toEqual({ handed_back: failed.id, turn_id: expect.any(String) });
  const input = f.turns(worker.id).find((t) => t.id === handed.turn_id)!.input;
  expect(input).toContain('reviewer: The export drops the header row');
  expect(input).toContain(
    'answer.txt:1\nQuote: exported\nEvidence: The export has no header row\nImpact: Readers cannot tell the columns apart',
  );
  expect(runs(f)[0]).toMatchObject({ id: failed.id, state: 'failed', turn_id: handed.turn_id });
  await eventually(
    () =>
      !!runs(f)[0]?.review_id &&
      review().id !== first.id &&
      f.turns(review().session_ids[0]!)[0]?.state === 'running',
    () => f.control.tick(),
    10000,
  );
  f.call(
    'review.verdict',
    { verdict: 'pass', summary: 'The export keeps the header row' },
    null,
    principal(f, review().session_ids[0]!, 'reviewer'),
  );
  await merged(f, worker);
  expect(runs(f)[0]).toMatchObject({ id: failed.id, state: 'passed' });
  expect(f.store.list<Review>('reviews').map((r) => r.requester?.step_run_id)).toEqual([
    failed.id,
    failed.id,
  ]);
});

it('refuses to send a fail verdict to a task session that takes no turn, and leaves the step as it was', async () => {
  const { f, lead, worker, reviewerId } = await reviewingLoop();
  const failed = await failedByVerdict(f, reviewerId);
  const held = current(f, worker.id);
  f.store.update<Session>('sessions', { ...held, stop_pending: true }, held.revision);
  const turns = f.turns(worker.id).length;
  await expect(() => requestReview(f, lead, worker)).rejects.toMatchObject({
    code: 'resource_busy',
  });
  expect(runs(f)[0]).toEqual(failed);
  expect(f.turns(worker.id)).toHaveLength(turns);
  expect(f.store.list<Review>('reviews')).toHaveLength(1);
});

it('fails a review step the lead ran again at the round limit and tells the lead', async () => {
  const { f, lead, worker } = await reviewingLoop();
  await stepFailed(f);
  const failed = runs(f)[0]!;
  for (let round = 1; round <= 3; round++) {
    expect(await requestReview(f, lead, worker)).toEqual({ reopened: failed.id });
    await stepFailed(f);
  }
  expect(runs(f)[0]).toMatchObject({
    id: failed.id,
    reason: 'Code review limit reached: at most 3 rounds per reviewed session',
  });
  expect(f.store.list<Review>('reviews')).toHaveLength(3);
  expect(notes(f)).toContainEqual(
    expect.objectContaining({
      kind: 'blocked',
      text: expect.stringContaining('Code review limit reached'),
    }),
  );
  await expect(() => requestReview(f, lead, worker)).rejects.toThrow('Code review limit reached');
  expect(current(f, worker.id).outcome).toBeUndefined();
});

it('refuses to send a fail verdict to the task session at the round limit', async () => {
  const { f, lead, worker, review } = await reviewingLoop();
  for (let round = 1; round < 3; round++) {
    await stepFailed(f);
    expect(await requestReview(f, lead, worker)).toEqual({ reopened: runs(f)[0]!.id });
  }
  await eventually(
    () =>
      !!runs(f)[0]?.review_id &&
      review().round === 3 &&
      f.turns(review().session_ids[0]!)[0]?.state === 'running',
    () => f.control.tick(),
    10000,
  );
  const failed = await failedByVerdict(f, review().session_ids[0]!);
  const turns = f.turns(worker.id).length;
  await expect(() => requestReview(f, lead, worker)).rejects.toThrow('Code review limit reached');
  expect(f.turns(worker.id)).toHaveLength(turns);
  expect(runs(f)[0]).toMatchObject({ id: failed.id, state: 'failed' });
  expect(runs(f)[0]).not.toHaveProperty('turn_id');
});

it("gives both the incomplete reason and the reviewer's fail verdict when a blocking review step fails", async () => {
  const { f, reviewerId } = await reviewingLoop(SilentReviewer);
  f.call(
    'review.verdict',
    { verdict: 'fail', summary: 'The export drops the header row' },
    null,
    principal(f, reviewerId, 'reviewer'),
  );
  await eventually(
    () => ['passed', 'failed'].includes(runs(f)[0]?.state ?? ''),
    () => f.control.tick(),
    10000,
  );
  const reason = runs(f)[0]!.reason!;
  expect(reason).toContain(
    'incomplete: reviewer reviewer ended its turn with no finding and no reply',
  );
  expect(reason).toContain('failed by verdict:\nreviewer: The export drops the header row');
  expect(reason.indexOf('incomplete')).toBeLessThan(reason.indexOf('failed by verdict'));
});

it('keeps the verdicts of two reviewers on the same runtime and fails the step by the fail verdict', async () => {
  const { f, review, reviewerId } = await reviewingLoop();
  const first = review();
  const second = f.store.insert<Session>('sessions', {
    id: 'second-reviewer',
    revision: 1,
    project_id: f.project.id,
    runtime: 'reviewer',
    review_id: first.id,
    state: 'running',
    turn_count: 1,
  });
  f.store.update<Review>(
    'reviews',
    { ...first, session_ids: [...first.session_ids, second.id] },
    first.revision,
  );
  f.call(
    'review.verdict',
    { verdict: 'fail', summary: 'The export drops the header row' },
    null,
    principal(f, reviewerId, 'reviewer'),
  );
  f.call(
    'review.verdict',
    { verdict: 'pass', summary: 'The export matches the goal' },
    null,
    principal(f, second.id, 'reviewer'),
  );
  expect(review().verdicts).toEqual([
    expect.objectContaining({ session_id: reviewerId, runtime: 'reviewer', verdict: 'fail' }),
    expect.objectContaining({ session_id: second.id, runtime: 'reviewer', verdict: 'pass' }),
  ]);
  await eventually(
    () => ['passed', 'failed'].includes(runs(f)[0]?.state ?? ''),
    () => f.control.tick(),
    10000,
  );
  expect(runs(f)[0]!.state).toBe('failed');
  expect(runs(f)[0]!.reason).toContain(
    'failed by verdict:\nreviewer: The export drops the header row',
  );
});
