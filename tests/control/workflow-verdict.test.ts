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

/** A blocking review step before the merge, once its reviewer on another runtime is running. */
async function reviewing() {
  const definition = empty();
  definition.slots.before_merge = [
    { id: 'second-look', title: 'Review the diff', kind: { type: 'review', blocking: true } },
  ];
  const { f, lead } = await setup(definition);
  const reviewer = new ReplyingReviewer(1);
  reviewer.name = 'reviewer';
  f.control.adapters.set(reviewer.name, reviewer);
  const worker = await build(f, lead);
  const review = () => f.store.must<Review>('reviews', runs(f)[0]!.review_id!);
  await eventually(
    () => !!runs(f)[0]?.review_id && f.turns(review().session_ids[0]!)[0]?.state === 'running',
    () => f.control.tick(),
    10000,
  );
  return { f, worker, review, reviewerId: review().session_ids[0]! };
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

it('passes a blocking review step whose review completes with a reply and no verdict, as before', async () => {
  const { f, worker, review } = await reviewing();
  await merged(f, worker);
  expect(runs(f)[0]!.state).toBe('passed');
  expect(review()).toMatchObject({ state: 'completed', findings: [] });
  expect(review()).not.toHaveProperty('incomplete');
  expect(review()).not.toHaveProperty('verdicts');
});
