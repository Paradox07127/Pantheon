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
  WorkflowDefinition,
  WorkflowStep,
  Workspace,
} from '@pantheon/domain';
import * as validation from '../../packages/control/dist/validation-executor.js';
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
/** A turn that runs one shell command, then stays running long enough to hand in a verdict. */
const shellTurn = (command: string) =>
  script({ trace: { tool: 'Bash', input: { command } } }, { wait: 2000 });
const verdictStep = (prompt: string, target?: 'lead'): WorkflowStep => ({
  id: 'check',
  title: 'Check the export',
  kind: { type: 'prompt', prompt, expects: 'verdict', ...(target ? { target } : {}) },
});

async function setup(definition: WorkflowDefinition) {
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

/** Waits until the step's turn is running and has recorded its shell call. */
const shellRan = (f: Fixture, sessionId: string) =>
  eventually(
    () => {
      const run = runs(f)[0];
      return (
        run?.state === 'running' &&
        f.store.db
          .prepare(
            "SELECT 1 FROM events WHERE aggregate_id=? AND kind='agent.tool.started' AND payload ->> '$.turn_id'=?",
          )
          .get(sessionId, run.turn_id!) !== undefined
      );
    },
    () => f.control.tick(),
    10000,
  );

const verdict = (
  f: Fixture,
  sessionId: string,
  role: 'lead' | 'worker',
  input: { verdict: 'pass' | 'fail'; summary: string; evidence: { kind: string; ref: string }[] },
) =>
  f.call<NonNullable<StepRun['verdict']>>(
    'workflow.step.verdict',
    input,
    null,
    principal(f, sessionId, role),
  );

/** A verdict step before the merge whose turn ended without a verdict, once the merge after that turn stopped at it. */
async function inconclusive() {
  const definition = empty();
  definition.slots.before_merge = [verdictStep('Check that the export keeps the header row')];
  const { f, lead } = await setup(definition);
  const worker = await build(f, lead);
  await eventually(
    () => runs(f)[0]?.state === 'inconclusive' && current(f, worker.id).merge?.state === 'blocked',
    () => f.control.tick(),
    10000,
  );
  for (let i = 0; i < 3; i++) await f.control.tick();
  return { f, lead, worker, run: runs(f)[0]! };
}

it('holds the merge of a verdict step whose turn ends without a verdict and asks the user', async () => {
  const { f, worker, run } = await inconclusive();
  expect(f.turns(worker.id).find((t) => t.id === run.turn_id)!.input).toContain('step_verdict');
  expect(current(f, worker.id)).toMatchObject({
    merge: { state: 'blocked', reason: 'workflow_approval' },
  });
  expect(current(f, worker.id).outcome).toBeUndefined();
  expect(
    f.control.needsYou(user, f.project.id).items.find((i) => i.source.id === run.id),
  ).toMatchObject({
    kind: 'workflow.approval',
    status: 'inconclusive',
    step_title: 'Check the export',
    actions: [
      { command: 'workflow.step.decide', decision: 'approve', allowed: true },
      { command: 'workflow.step.decide', decision: 'reject', allowed: true },
    ],
  });
});

it('passes an inconclusive step the user approves and merges, and refuses the lead', async () => {
  const { f, lead, worker, run } = await inconclusive();
  expect(() =>
    f.call(
      'workflow.step.decide',
      { step_run_id: run.id, decision: 'approve' },
      null,
      principal(f, lead.id, 'lead'),
    ),
  ).toThrowError(expect.objectContaining({ code: 'permission_denied' }));
  f.call('workflow.step.decide', { step_run_id: run.id, decision: 'approve' });
  expect(f.store.must<StepRun>('workflow_step_runs', run.id).state).toBe('passed');
  await merged(f, worker);
});

it('passes a verdict step on a pass whose command ran in its turn, and merges', async () => {
  const definition = empty();
  definition.slots.before_merge = [verdictStep(shellTurn('pnpm test --filter export'))];
  const { f, lead } = await setup(definition);
  const worker = await build(f, lead);
  await shellRan(f, worker.id);
  expect(
    verdict(f, worker.id, 'worker', {
      verdict: 'pass',
      summary: 'The export tests pass',
      evidence: [{ kind: 'command', ref: 'pnpm   test --filter export' }],
    }),
  ).toMatchObject({
    verdict: 'pass',
    evidence: [{ kind: 'command', ref: 'pnpm   test --filter export', checked: true }],
    session_id: worker.id,
    turn_id: runs(f)[0]!.turn_id,
  });
  await merged(f, worker);
  expect(runs(f)[0]!.state).toBe('passed');
});

it("fails a verdict step on a fail and quotes its summary in the lead's blocked note", async () => {
  const definition = empty();
  definition.slots.before_merge = [verdictStep(shellTurn('pnpm test'))];
  const { f, lead } = await setup(definition);
  const worker = await build(f, lead);
  await shellRan(f, worker.id);
  verdict(f, worker.id, 'worker', {
    verdict: 'fail',
    summary: 'The export drops the header row',
    evidence: [{ kind: 'command', ref: 'pnpm test' }],
  });
  await eventually(
    () => runs(f)[0]?.state === 'failed',
    () => f.control.tick(),
    10000,
  );
  expect(
    f.store.kindEvents(f.project.id, ['lead.note_added']).map((e) => e.payload as LeadNote),
  ).toContainEqual(
    expect.objectContaining({
      kind: 'blocked',
      text: expect.stringContaining('The export drops the header row'),
    }),
  );
  expect(current(f, worker.id).outcome).toBeUndefined();
});

it('refuses evidence naming a command its turn did not run', async () => {
  const definition = empty();
  definition.slots.before_dispatch = [verdictStep(shellTurn('pnpm test'), 'lead')];
  const { f, lead } = await setup(definition);
  startTask(f, lead);
  await shellRan(f, lead.id);
  expect(() =>
    verdict(f, lead.id, 'lead', {
      verdict: 'fail',
      summary: 'Lint reports two errors',
      evidence: [{ kind: 'command', ref: 'pnpm lint' }],
    }),
  ).toThrowError(
    expect.objectContaining({
      code: 'invalid_input',
      message: expect.stringContaining('pnpm test'),
    }),
  );
  expect(runs(f)[0]).not.toHaveProperty('verdict');
});

it('lists only the last ten commands of the turn in a refusal and counts the earlier ones', async () => {
  const commands = Array.from(
    { length: 12 },
    (_, i) => `echo step-${String(i + 1).padStart(2, '0')}`,
  );
  const definition = empty();
  definition.slots.before_dispatch = [
    verdictStep(
      script(...commands.map((command) => ({ trace: { tool: 'Bash', input: { command } } })), {
        wait: 2000,
      }),
      'lead',
    ),
  ];
  const { f, lead } = await setup(definition);
  startTask(f, lead);
  await eventually(
    () => {
      const run = runs(f)[0];
      return (
        run?.state === 'running' &&
        (
          f.store.db
            .prepare(
              "SELECT count(*) AS n FROM events WHERE aggregate_id=? AND kind='agent.tool.started' AND payload ->> '$.turn_id'=?",
            )
            .get(lead.id, run.turn_id!) as { n: number }
        ).n === 12
      );
    },
    () => f.control.tick(),
    10000,
  );
  let message = '';
  try {
    verdict(f, lead.id, 'lead', {
      verdict: 'fail',
      summary: 'Lint reports two errors',
      evidence: [{ kind: 'command', ref: 'pnpm lint' }],
    });
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toContain(`(2 earlier commands not shown) ${commands.slice(2).join('; ')}`);
  expect(message).not.toContain('echo step-02');
});

it('treats a shell call without command text as no command, so a pass with an unchecked item is accepted', async () => {
  const definition = empty();
  definition.slots.before_dispatch = [
    verdictStep(script({ trace: { tool: 'Bash', input: {} } }, { wait: 2000 }), 'lead'),
  ];
  const { f, lead } = await setup(definition);
  startTask(f, lead);
  await shellRan(f, lead.id);
  expect(
    verdict(f, lead.id, 'lead', {
      verdict: 'pass',
      summary: 'The tests pass',
      evidence: [{ kind: 'command', ref: 'pnpm test' }],
    }),
  ).toMatchObject({ evidence: [{ kind: 'command', ref: 'pnpm test', checked: false }] });
});

it.each([
  ['without expects', {}],
  ['expecting its turn', { expects: 'turn' as const }],
])('refuses a verdict for a running prompt step %s', async (_, fields) => {
  const definition = empty();
  definition.slots.before_dispatch = [
    {
      id: 'brief',
      title: 'Brief the lead',
      kind: { type: 'prompt', prompt: shellTurn('pnpm test'), target: 'lead', ...fields },
    },
  ];
  const { f, lead } = await setup(definition);
  startTask(f, lead);
  await shellRan(f, lead.id);
  expect(() =>
    verdict(f, lead.id, 'lead', {
      verdict: 'pass',
      summary: 'The tests pass',
      evidence: [{ kind: 'command', ref: 'pnpm test' }],
    }),
  ).toThrowError(
    expect.objectContaining({
      code: 'invalid_state',
      message: expect.stringContaining('does not ask for a verdict'),
    }),
  );
  expect(runs(f)[0]).not.toHaveProperty('verdict');
});

it('refuses a verdict from a session that is not the step target', async () => {
  const definition = empty();
  definition.slots.before_merge = [verdictStep(shellTurn('pnpm test'))];
  const { f, lead } = await setup(definition);
  const worker = await build(f, lead);
  await shellRan(f, worker.id);
  expect(() =>
    verdict(f, lead.id, 'lead', {
      verdict: 'pass',
      summary: 'The tests pass',
      evidence: [{ kind: 'command', ref: 'pnpm test' }],
    }),
  ).toThrowError(expect.objectContaining({ code: 'invalid_state' }));
});

it.each([
  ['without expects', {}],
  ['expecting its turn', { expects: 'turn' as const }],
])('passes a prompt step %s once its turn completes', async (_, fields) => {
  const definition = empty();
  definition.slots.before_dispatch = [
    {
      id: 'brief',
      title: 'Brief the lead',
      kind: { type: 'prompt', prompt: 'Brief the lead on the export', target: 'lead', ...fields },
    },
  ];
  const { f, lead } = await setup(definition);
  startTask(f, lead);
  await eventually(
    () => runs(f)[0]?.state === 'passed',
    () => f.control.tick(),
    10000,
  );
  expect(f.turns(lead.id).find((t) => t.id === runs(f)[0]!.turn_id)!.input).toBe(
    'Brief the lead on the export',
  );
});

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

/** A review step before the merge, once its reviewer on another runtime is running. */
async function reviewing(
  Reviewer: typeof FixtureAdapter = ReplyingReviewer,
  blocking = true,
  maxRounds = 3,
) {
  const definition = empty();
  definition.review.max_rounds = maxRounds;
  definition.slots.before_merge = [
    { id: 'second-look', title: 'Review the diff', kind: { type: 'review', blocking } },
  ];
  const { f, lead } = await setup(definition);
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
  const { f, worker, review, reviewerId } = await reviewing();
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
  const { f, lead, worker, review } = await reviewing();
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
  const { f, lead, worker, review } = await reviewing();
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
  expect(await requestReview(f, lead, worker)).toEqual({ reopened: failed.id });
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

it('keeps a review step a reviewer failed by verdict failed and held when the lead requests a review', async () => {
  const { f, lead, worker, reviewerId } = await reviewing();
  f.call(
    'review.verdict',
    { verdict: 'fail', summary: 'The export drops the header row' },
    null,
    principal(f, reviewerId, 'reviewer'),
  );
  await stepFailed(f);
  const failed = runs(f)[0]!;
  expect(failed.reason).not.toContain('request_review');
  const separate = await requestReview(f, lead, worker);
  expect(separate).toMatchObject({
    review_id: expect.any(String),
    requester: { lead_session_id: lead.id, task_id: 'export' },
  });
  expect(separate.requester).not.toHaveProperty('step_run_id');
  for (let i = 0; i < 3; i++) await f.control.tick();
  expect(runs(f)[0]).toMatchObject({
    id: failed.id,
    state: 'failed',
    review_id: failed.review_id,
  });
  expect(current(f, worker.id).merge).toMatchObject({
    state: 'blocked',
    reason: 'workflow_approval',
  });
  expect(current(f, worker.id).outcome).toBeUndefined();
});

it('fails a review step the lead ran again at the round limit and tells the lead', async () => {
  const { f, lead, worker } = await reviewing(ReplyingReviewer, true, 1);
  await stepFailed(f);
  const failed = runs(f)[0]!;
  expect(await requestReview(f, lead, worker)).toEqual({ reopened: failed.id });
  await stepFailed(f);
  expect(runs(f)[0]).toMatchObject({
    id: failed.id,
    reason: 'Code review limit reached: at most 1 rounds per reviewed session',
  });
  expect(f.store.list<Review>('reviews')).toHaveLength(1);
  expect(notes(f)).toContainEqual(
    expect.objectContaining({
      kind: 'blocked',
      text: expect.stringContaining('Code review limit reached'),
    }),
  );
  await expect(() => requestReview(f, lead, worker)).rejects.toThrow('Code review limit reached');
  expect(current(f, worker.id).outcome).toBeUndefined();
});

it('passes a non-blocking review step whose review completes with a reply and no verdict', async () => {
  const { f, worker, review } = await reviewing(ReplyingReviewer, false);
  await merged(f, worker);
  expect(runs(f)[0]!.state).toBe('passed');
  expect(review()).toMatchObject({ state: 'completed', findings: [] });
  expect(review()).not.toHaveProperty('incomplete');
  expect(review()).not.toHaveProperty('verdicts');
});

it("gives both the incomplete reason and the reviewer's fail verdict when a blocking review step fails", async () => {
  const { f, reviewerId } = await reviewing(SilentReviewer);
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
  const { f, review, reviewerId } = await reviewing();
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
