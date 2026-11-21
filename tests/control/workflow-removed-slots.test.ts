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
import { REVIEW_LOOP_STEP_ID } from '../../packages/control/dist/merge-review.js';
import { eventually, settle } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
const current = (f: Fixture, id: string) => f.store.must<Session>('sessions', id);
const runs = (f: Fixture) => f.store.list<StepRun>('workflow_step_runs');
const workerOf = (f: Fixture, lead: Session, taskId = 'export') =>
  f.store
    .list<Session>('sessions')
    .find((s) => s.task?.lead_session_id === lead.id && s.task.id === taskId);
const trackerTurns = (f: Fixture, id: string) =>
  f.turns(id).filter((turn) => turn.origin === 'tracker').length;
/** The tracker turns after the first `after` that carry a merge note to the lead. */
const mergeWakes = (f: Fixture, id: string, after: number) =>
  f
    .turns(id)
    .filter((turn) => turn.origin === 'tracker')
    .slice(after)
    .filter((turn) => turn.wake?.causes.includes('merged')).length;
const principal = (f: Fixture, id: string, role: Principal['role']): Principal => ({
  id: `session:${id}`,
  role,
  session_id: id,
  project_id: f.project.id,
  expires_at: Date.now() + 60000,
});
const review = (id: string) => ({
  id,
  title: id,
  kind: { type: 'review' as const, blocking: true },
});
const command = (id: string) => ({
  id,
  title: id,
  kind: { type: 'command', command: `${id}-command`, timeout_seconds: 10 },
});
const prompt = {
  id: 'tidy',
  title: 'Tidy the change',
  kind: { type: 'prompt', prompt: 'Simplify what you changed', expects: 'verdict' },
};

function validationResult(): validation.ValidationResult {
  return {
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
  };
}

/**
 * A project whose default definition an older daemon stored with custom steps in all three slots,
 * no plan review and one review round, and a plan with a dispatch task and a review loop task.
 */
async function setup() {
  const f = await workbenchFixture({ delay: 1 });
  git(f.source, 'config', 'user.name', 'Source User');
  git(f.source, 'config', 'user.email', 'source@example.invalid');
  const lead = await f.create('Plan the export');
  await settle(f, lead);
  const definition = {
    slots: {
      before_dispatch: [review('start-review')],
      before_merge: [
        review('merge-review'),
        command('merge-check'),
        { id: 'signoff', title: 'Approve the merge', kind: { type: 'approval' } },
        prompt,
        {
          id: 'grouped',
          title: 'Grouped checks',
          kind: { type: 'parallel', steps: [review('grouped-review'), command('grouped-check')] },
        },
        {
          id: 'repeated',
          title: 'Repeated check',
          kind: { type: 'loop', max: 2, until: 'passes', step: command('repeated-check') },
        },
      ],
      after_merge: [review('result-review')],
    },
    plan_review: { tiers: [] },
    review: { max_rounds: 1 },
  };
  f.store.db.prepare('INSERT INTO workflow_definitions (id, revision, data) VALUES (?, 1, ?)').run(
    f.project.id,
    JSON.stringify({
      id: f.project.id,
      revision: 1,
      project_id: f.project.id,
      name: 'Default',
      is_default: true,
      definition_version: 1,
      definition,
      versions: { 1: definition },
    }),
  );
  const task = {
    title: 'Export the report',
    goal: 'Export the report',
    lane: 'core',
    depends_on: [],
    source: ['Plan the export'],
    acceptance: ['true'],
    kind: { tier: 't2' as const, domain: 'backend-logic' as const },
  };
  f.store.insert<BoardPlan>('board_plans', {
    id: lead.id,
    revision: 1,
    project_id: f.project.id,
    headline: 'Ship export',
    lanes: [{ id: 'core', title: 'Core' }],
    tasks: [
      { ...task, id: 'export', scope: ['answer.txt'], path: 'dispatch' },
      {
        ...task,
        id: 'import',
        title: 'Import the report',
        scope: ['import.txt'],
        path: 'review_loop',
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
const start = (f: Fixture, lead: Session, taskIds = ['export']) =>
  f.call('task.start', {
    project_id: f.project.id,
    lead_session_id: lead.id,
    task_ids: taskIds,
  });

/** Adds a reviewer runtime whose code review sessions hand in a pass verdict as their turn starts. */
function passingReviewer(f: Fixture) {
  const reviewer = new FixtureAdapter(1);
  reviewer.name = 'reviewer';
  f.control.adapters.set(reviewer.name, reviewer);
  const send = reviewer.send.bind(reviewer);
  reviewer.send = async (handle, turn) => {
    const session = current(f, f.store.must<SessionTurn>('session_turns', turn.turn_id).session_id);
    if (session.review_id && !f.store.must<Review>('reviews', session.review_id).plan)
      f.call(
        'review.verdict',
        { verdict: 'pass', summary: 'No findings: checked the change against the goal' },
        null,
        principal(f, session.id, 'reviewer'),
      );
    return send(handle, turn);
  };
  return reviewer;
}

it('ignores a stored definition: runs no custom step, reviews only the review loop task, and keeps the fixed plan review tiers and round limit', async () => {
  const execute = vi
    .spyOn(validation, 'runValidationCommand')
    .mockResolvedValue(validationResult());
  const { f, lead } = await setup();
  const reviewer = passingReviewer(f);
  const plan = f.store.must<BoardPlan>('board_plans', lead.id);
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: plan.plan_version,
      headline: plan.headline,
      lanes: plan.lanes,
      tasks: [
        ...plan.tasks,
        {
          ...plan.tasks[0]!,
          id: 'audit',
          title: 'Audit the export',
          scope: ['audit.txt'],
          kind: { tier: 't3', domain: 'backend-logic' },
        },
      ],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    principal(f, lead.id, 'lead'),
  );
  expect(
    f.store.list<Review>('reviews').some((r) => r.plan?.tasks.some((t) => t.task_id === 'audit')),
  ).toBe(true);
  start(f, lead, ['export', 'import']);
  await f.control.tick();
  const workers = ['export', 'import'].map((id) => workerOf(f, lead, id)!);
  for (const worker of workers) {
    await settle(f, worker);
    const workspace = f.store.must<Workspace>('workspaces', worker.workspace_id!);
    const file = worker.task!.id === 'export' ? 'answer.txt' : 'import.txt';
    writeFileSync(path.join(workspace.path, file), 'done\n');
    git(workspace.path, 'add', file);
    git(workspace.path, 'commit', '--quiet', '-m', `Write ${file}`);
    f.call(
      'session.send',
      { session_id: worker.id, input: 'Finish the task' },
      current(f, worker.id).revision,
    );
  }
  const before = trackerTurns(f, lead.id);
  await eventually(
    () =>
      workers.every((worker) => current(f, worker.id).outcome === 'merged') &&
      mergeWakes(f, lead.id, before) > 0,
    () => f.control.tick(),
    15000,
  );
  expect(runs(f).map((run) => [run.task_id, run.slot, run.step.id, run.state])).toEqual([
    ['import', 'before_merge', REVIEW_LOOP_STEP_ID, 'passed'],
  ]);
  expect(f.store.list<Review>('reviews').filter((r) => r.requester?.task_id === 'export')).toEqual(
    [],
  );
  expect(execute.mock.calls.flatMap(([input]) => input.argv)).not.toContainEqual(
    expect.stringMatching(/-command$/),
  );
  expect(f.turns(workers[0]!.id).map((t) => t.input)).not.toContain('Simplify what you changed');
  const leadWorkspace = f.store.must<Workspace>('workspaces', lead.workspace_id!).path;
  writeFileSync(path.join(leadWorkspace, 'notes.txt'), 'review this change\n');
  git(leadWorkspace, 'add', 'notes.txt');
  git(leadWorkspace, 'commit', '--quiet', '-m', 'Add notes');
  for (let round = 1; round <= 3; round++)
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

it('retires a running custom review run of an older daemon on restart and lets the merge it held go on', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
  const { f, lead } = await setup();
  start(f, lead);
  await f.control.tick();
  const worker = workerOf(f, lead)!;
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
  const old = f.store.insert<StepRun>('workflow_step_runs', {
    id: 'older-review-run',
    revision: 1,
    project_id: f.project.id,
    lead_session_id: lead.id,
    task_id: 'export',
    generation: 1,
    slot: 'before_merge',
    step: review('merge-review'),
    state: 'running',
    created_at: Date.now(),
    session_id: worker.id,
  });
  await f.restart(() => undefined);
  expect(f.store.must<StepRun>('workflow_step_runs', old.id).state).toBe('retired');
  await eventually(
    () => current(f, worker.id).outcome === 'merged',
    () => f.control.tick(),
    10000,
  );
});

it.each([
  [
    'an approval run the user rejected',
    { id: 'signoff', title: 'Approve', kind: { type: 'approval' } },
    'rejected',
  ],
  ['a custom review run that failed', review('merge-review'), 'failed'],
])(
  'retires %s before the merge of an older daemon on restart and cancels the merge it held',
  async (_, step, state) => {
    vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult());
    const { f, lead } = await setup();
    start(f, lead);
    await f.control.tick();
    const worker = workerOf(f, lead)!;
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
    const old = f.store.insert('workflow_step_runs', {
      id: 'older-settled-run',
      revision: 1,
      project_id: f.project.id,
      lead_session_id: lead.id,
      task_id: 'export',
      generation: 1,
      definition_version: 1,
      slot: 'before_merge',
      step,
      state,
      created_at: Date.now(),
      finished_at: Date.now(),
      session_id: worker.id,
    } as unknown as StepRun);
    await f.restart(() => undefined);
    expect(f.store.must<StepRun>('workflow_step_runs', old.id).state).toBe('retired');
    await eventually(
      () => current(f, worker.id).merge?.reason !== 'workflow_approval',
      () => f.control.tick(),
      10000,
    );
    expect(current(f, worker.id).merge).toEqual({ state: 'blocked', reason: 'cancelled' });
    expect(
      f.store
        .kindEvents(f.project.id, ['session.merge_blocked'])
        .filter((e) => e.aggregate_id === worker.id)
        .map((e) => e.payload),
    ).toEqual([{ state: 'blocked', reason: 'cancelled' }]);
    expect(current(f, worker.id).outcome).toBeUndefined();
    expect(git(f.source, 'rev-parse', 'HEAD')).toBe(sourceHead);
  },
);

it('retires an unfinished run before dispatch of an older daemon on restart and dispatches the task it held', async () => {
  const { f, lead } = await setup();
  const old = f.store.insert('workflow_step_runs', {
    id: 'older-dispatch-run',
    revision: 1,
    project_id: f.project.id,
    lead_session_id: lead.id,
    task_id: 'export',
    generation: 1,
    definition_version: 1,
    slot: 'before_dispatch',
    step: review('start-review'),
    state: 'pending',
    created_at: Date.now(),
  } as unknown as StepRun);
  start(f, lead);
  await f.restart(() => undefined);
  expect(f.store.must<StepRun>('workflow_step_runs', old.id).state).toBe('retired');
  await eventually(
    () => workerOf(f, lead) !== undefined,
    () => f.control.tick(),
  );
});
