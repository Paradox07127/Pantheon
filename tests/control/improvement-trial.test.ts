import { afterEach, expect, it } from 'vitest';
import type {
  Improvement,
  Principal,
  ProjectRead,
  Retrospective,
  Session,
  WorkflowPolicy,
} from '@pantheon/domain';
import { fixture, user } from '../helpers.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

const DAY_MS = 24 * 60 * 60 * 1000;

async function setup(improvementMode?: WorkflowPolicy['improvement_mode']) {
  const clock = { now: 1_000_000 };
  const f = await fixture({ now: () => clock.now });
  fixtures.push(f);
  if (improvementMode)
    f.call(
      'workflow.policy.set',
      { project_id: f.project.id, improvement_mode: improvementMode },
      null,
    );
  let rows = 0;
  /** Inserts a merged retrospective of a new task at the clock, then moves the clock on; returns its id. */
  const retro = (fields: Partial<Retrospective> = {}) => {
    rows++;
    const id = `retrospective-${rows}`;
    f.store.insert<Retrospective>('retrospectives', {
      id,
      revision: 1,
      project_id: f.project.id,
      lead_session_id: 'lead',
      task_id: `task-${rows}`,
      session_ids: [],
      outcome: 'merged',
      recorded_at: clock.now,
      ...fields,
    });
    clock.now += 1_000;
    return id;
  };
  const improvements = () =>
    f.store
      .list<Improvement>('improvements')
      .filter((row) => row.project_id === f.project.id)
      .sort((a, b) => a.proposed_at - b.proposed_at);
  const policy = () => f.control.workflowPolicy(user, f.project.id) as WorkflowPolicy;
  const statusEvents = () =>
    f.store
      .events(0, f.project.id)
      .filter((event) => event.kind === 'improvement.status_changed')
      .map((event) => event.payload as Record<string, unknown>);
  return { f, clock, retro, improvements, policy, statusEvents };
}

/** A task measured by the trial rules: first gate pass, input tokens and stage times. */
const measured = (inputTokens: number, wallMs: number, fields: Partial<Retrospective> = {}) => ({
  gate_passed_on_attempt: 1,
  lead_usage: { input_tokens: inputTokens / 2, output_tokens: 10 },
  task_usage: { input_tokens: inputTokens / 2, output_tokens: 10 },
  stage_ms: { planning: wallMs / 2, execution: wallMs / 2 },
  ...fields,
});
/** Two lead wakes, both without a decision; five of them make idle_wakeups. */
const idle = { lead_wakes: 2, lead_wakes_without_decision: 2 };
/** Two lead wakes, one of them without a decision. */
const lessIdle = { lead_wakes: 2, lead_wakes_without_decision: 1 };

/** Ten idle measured tasks, then a tick that starts the daemon's acceptance_wake trial. */
async function onTrial(given?: Awaited<ReturnType<typeof setup>>) {
  const harness = given ?? (await setup());
  for (let i = 0; i < 10; i++) harness.retro(measured(1000, 10_000, idle));
  await harness.f.control.tick();
  harness.clock.now += 1_000;
  const [improvement] = harness.improvements();
  expect(improvement?.status).toBe('trial');
  return { ...harness, improvement: improvement! };
}

it('starts the trial of a daemon proposal for a signal in auto mode and changes the policy', async () => {
  const { f, retro, improvements, policy } = await setup();
  const id = retro({ lead_wakes: 10, lead_wakes_without_decision: 8 });
  await f.control.tick();
  expect(improvements()).toMatchObject([
    {
      source: 'daemon',
      signal: 'idle_wakeups',
      retrospective_ids: [id],
      status: 'trial',
      change: {
        type: 'policy_change',
        param: 'acceptance_wake',
        from: 'each_merge',
        to: 'milestone',
      },
    },
  ]);
  expect(improvements()[0]).not.toHaveProperty('lead_session_id');
  expect(policy().acceptance_wake).toBe('milestone');
});

it('holds a daemon proposal as a candidate in confirm mode without changing the policy', async () => {
  const { f, retro, improvements, policy } = await setup('confirm');
  retro({ lead_wakes: 10, lead_wakes_without_decision: 8 });
  await f.control.tick();
  expect(improvements().map((row) => [row.source, row.status])).toEqual([['daemon', 'candidate']]);
  expect(policy().acceptance_wake).toBe('each_merge');
  await f.control.tick();
  expect(improvements()).toHaveLength(1);
});

it('makes no daemon proposal while improvements are off', async () => {
  const { f, retro, improvements } = await setup('off');
  retro({ lead_wakes: 10, lead_wakes_without_decision: 8 });
  await f.control.tick();
  expect(improvements()).toEqual([]);
});

it('makes no second proposal for a parameter whose trial is running', async () => {
  const { f, clock, retro, improvements } = await setup();
  f.store.insert<Improvement>('improvements', {
    id: 'running',
    revision: 1,
    project_id: f.project.id,
    source: 'lead',
    lead_session_id: 'lead',
    retrospective_ids: ['earlier-1', 'earlier-2'],
    status: 'trial',
    change: {
      type: 'policy_change',
      param: 'acceptance_wake',
      from: 'milestone',
      to: 'each_merge',
    },
    proposed_at: clock.now,
    trial_started_at: clock.now,
  });
  clock.now += 1_000;
  retro({ lead_wakes: 10, lead_wakes_without_decision: 8 });
  await f.control.tick();
  expect(improvements().map((row) => row.id)).toEqual(['running']);
});

it('makes no proposal of a change reverted within 14 days and makes it again after', async () => {
  const { f, clock, retro, improvements } = await setup();
  f.store.insert<Improvement>('improvements', {
    id: 'reverted',
    revision: 1,
    project_id: f.project.id,
    source: 'daemon',
    signal: 'idle_wakeups',
    retrospective_ids: ['earlier'],
    status: 'reverted',
    status_reason: 'not_better',
    change: {
      type: 'policy_change',
      param: 'acceptance_wake',
      from: 'each_merge',
      to: 'milestone',
    },
    proposed_at: clock.now,
    trial_started_at: clock.now,
    decided_at: clock.now,
  });
  retro({ lead_wakes: 10, lead_wakes_without_decision: 8 });
  clock.now += 14 * DAY_MS - 2_000;
  await f.control.tick();
  expect(improvements().map((row) => row.id)).toEqual(['reverted']);
  clock.now += 1_000;
  await f.control.tick();
  expect(improvements().map((row) => row.id)).toEqual(['reverted']);
  retro({ lead_wakes: 10, lead_wakes_without_decision: 8 });
  await f.control.tick();
  expect(improvements().map((row) => row.status)).toEqual(['reverted', 'trial']);
});

it('keeps a trial whose ten tasks woke the lead fewer times without a decision and spent less input', async () => {
  const { f, retro, improvements, policy, statusEvents, improvement } = await onTrial();
  for (let i = 0; i < 10; i++) retro(measured(800, 10_500, lessIdle));
  await f.control.tick();
  expect(improvements()).toMatchObject([
    { id: improvement.id, status: 'active', status_reason: 'trial_passed' },
  ]);
  expect(policy().acceptance_wake).toBe('milestone');
  expect(statusEvents().at(-1)).toEqual({
    improvement_id: improvement.id,
    from: 'trial',
    to: 'active',
    reason: 'trial_passed',
    comparison: {
      baseline: {
        tasks: 10,
        first_pass: 10,
        delivered: 10,
        input_tokens: 10_000,
        wall_ms: 100_000,
        wakes_without_decision_per_task: 2,
      },
      trial: {
        tasks: 10,
        first_pass: 10,
        delivered: 10,
        input_tokens: 8000,
        wall_ms: 105_000,
        wakes_without_decision_per_task: 1,
      },
    },
  });
});

/** A failed task the user did not stop, with the usage and stage time it spent. */
const failedAttempt = (fields: Partial<Retrospective> = {}): Partial<Retrospective> => ({
  outcome: 'failed',
  task_usage: { input_tokens: 400, output_tokens: 10 },
  stage_ms: { execution: 5_000 },
  ...fields,
});

it('reverts a trial whose tasks were delivered less often although each delivered task cost less', async () => {
  const harness = await setup();
  for (let i = 0; i < 10; i++) harness.retro(measured(1000, 10_000, idle));
  for (let i = 0; i < 4; i++)
    harness.retro(measured(1000, 10_000, { ...idle, gate_passed_on_attempt: 2 }));
  await harness.f.control.tick();
  harness.clock.now += 1_000;
  const { f, retro, improvements, policy, statusEvents } = harness;
  const [improvement] = improvements();
  expect(improvement?.status).toBe('trial');

  for (let i = 0; i < 10; i++) retro(measured(800, 10_500, lessIdle));
  for (let i = 0; i < 4; i++) retro(failedAttempt());
  await f.control.tick();
  expect(improvements()).toMatchObject([
    { id: improvement!.id, status: 'reverted', status_reason: 'not_better' },
  ]);
  expect(policy().acceptance_wake).toBe('each_merge');
  expect(statusEvents().at(-1)).toMatchObject({
    to: 'reverted',
    comparison: {
      baseline: { tasks: 14, first_pass: 10, delivered: 14 },
      trial: { tasks: 14, first_pass: 10, delivered: 10 },
    },
  });
});

it('leaves failed tasks the user stopped out of the trial sample', async () => {
  const { f, retro, improvements, statusEvents, improvement } = await onTrial();
  for (let i = 0; i < 10; i++) retro(measured(800, 10_500, lessIdle));
  for (let i = 0; i < 3; i++) retro(failedAttempt({ stopped_by: 'user' }));
  await f.control.tick();
  expect(improvements()).toMatchObject([{ id: improvement.id, status: 'active' }]);
  expect(statusEvents().at(-1)).toMatchObject({
    to: 'active',
    comparison: { trial: { tasks: 10 } },
  });
});

it('counts the dispatch wait of failed tasks without an execution time in a parallelism trial', async () => {
  const { f, clock, retro, improvements } = await setup();
  for (let i = 0; i < 6; i++) retro(measured(1000, 10_000));
  for (let i = 0; i < 4; i++) retro(failedAttempt({ stage_ms: { dispatch_wait: 100 } }));
  f.store.insert<Improvement>('improvements', {
    id: 'parallelism-trial',
    revision: 1,
    project_id: f.project.id,
    source: 'lead',
    lead_session_id: 'lead',
    retrospective_ids: [],
    status: 'trial',
    change: { type: 'policy_change', param: 'max_parallel', from: 3, to: 2 },
    proposed_at: clock.now,
    trial_started_at: clock.now,
  });
  clock.now += 1000;
  for (let i = 0; i < 6; i++) retro(measured(1000, 6_000));
  for (let i = 0; i < 4; i++) retro(failedAttempt({ stage_ms: { dispatch_wait: 60_000 } }));
  await f.control.tick();
  expect(improvements().find((row) => row.id === 'parallelism-trial')).toMatchObject({
    status: 'reverted',
    status_reason: 'not_better',
  });
});

it('keeps an acceptance wake trial whose tasks woke the lead fewer times without a decision at the same input and wall time', async () => {
  const { f, retro, improvements, policy, improvement } = await onTrial();
  for (let i = 0; i < 10; i++) retro(measured(1000, 10_000, lessIdle));
  await f.control.tick();
  expect(improvements()).toMatchObject([{ id: improvement.id, status: 'active' }]);
  expect(policy().acceptance_wake).toBe('milestone');
});

it('leaves the wait for workflow approvals out of the wall time a trial compares', async () => {
  const { f, retro, statusEvents } = await onTrial();
  for (let i = 0; i < 10; i++)
    retro(
      measured(1000, 10_000, {
        ...lessIdle,
        stage_ms: { planning: 5_000, execution: 5_000, step_approval: 60_000 },
      }),
    );
  await f.control.tick();
  const { baseline, trial } = (
    statusEvents().at(-1) as { comparison: Record<string, { wall_ms: number }> }
  ).comparison;
  expect(trial!.wall_ms).toBe(baseline!.wall_ms);
});

it.each([
  [
    'reverts an acceptance wake trial whose tasks took less wall time but as many wakes without a decision',
    1000,
    7_000,
    {
      baseline: { wall_ms: 100_000, wakes_without_decision_per_task: 2 },
      trial: { wall_ms: 70_000, wakes_without_decision_per_task: 2 },
    },
  ],
  [
    'reverts a trial whose ten tasks did not get better and restores the former value',
    950,
    10_000,
    {
      baseline: { tasks: 10, first_pass: 10, input_tokens: 10_000, wall_ms: 100_000 },
      trial: { tasks: 10, first_pass: 10, input_tokens: 9500, wall_ms: 100_000 },
    },
  ],
])('%s', async (_name, inputTokens, wallMs, comparison) => {
  const { f, retro, improvements, policy, statusEvents, improvement } = await onTrial();
  for (let i = 0; i < 10; i++) retro(measured(inputTokens, wallMs, idle));
  await f.control.tick();
  expect(improvements()).toMatchObject([
    { id: improvement.id, status: 'reverted', status_reason: 'not_better' },
  ]);
  expect(policy().acceptance_wake).toBe('each_merge');
  expect(statusEvents().at(-1)).toMatchObject({ to: 'reverted', reason: 'not_better', comparison });
});

it('leaves a task that started before the trial and merged after it out of the trial sample', async () => {
  const { f, retro, improvements, improvement } = await onTrial();
  retro(measured(800, 10_500, { ...lessIdle, started_at: improvement.trial_started_at! - 1 }));
  for (let i = 0; i < 9; i++) retro(measured(800, 10_500, lessIdle));
  await f.control.tick();
  expect(improvements()).toMatchObject([{ id: improvement.id, status: 'trial' }]);

  retro(measured(800, 10_500, lessIdle));
  await f.control.tick();
  expect(improvements()).toMatchObject([{ id: improvement.id, status: 'active' }]);
});

it('reverts a trial with fewer first gate passes even though it spent less input', async () => {
  const { f, retro, improvements, policy, improvement } = await onTrial();
  for (let i = 0; i < 9; i++) retro(measured(500, 10_000, lessIdle));
  retro(measured(500, 10_000, { ...lessIdle, gate_passed_on_attempt: 2, gate_failures: ['code'] }));
  await f.control.tick();
  expect(improvements()).toMatchObject([
    { id: improvement.id, status: 'reverted', status_reason: 'not_better' },
  ]);
  expect(policy().acceptance_wake).toBe('each_merge');
});

it('reverts a trial that saw fewer than ten tasks in 14 days for an insufficient sample', async () => {
  const { f, clock, retro, improvements, policy, improvement } = await onTrial();
  for (let i = 0; i < 4; i++) retro(measured(500, 10_000));
  clock.now = improvement.trial_started_at! + 14 * DAY_MS - 1;
  await f.control.tick();
  expect(improvements()[0]?.status).toBe('trial');
  clock.now += 1;
  await f.control.tick();
  expect(improvements()).toMatchObject([
    { id: improvement.id, status: 'reverted', status_reason: 'insufficient_sample' },
  ]);
  expect(policy().acceptance_wake).toBe('each_merge');
});

it('reverts a trial that saw nine tasks in 14 days and tells the evidence was weak', async () => {
  const { f, clock, retro, improvements, policy, improvement } = await onTrial();
  for (let i = 0; i < 9; i++) retro(measured(800, 10_500, lessIdle));
  await f.control.tick();
  expect(improvements()[0]?.status).toBe('trial');
  clock.now = improvement.trial_started_at! + 14 * DAY_MS;
  await f.control.tick();
  expect(improvements()).toMatchObject([
    {
      id: improvement.id,
      status: 'reverted',
      status_reason: 'insufficient_sample',
      status_detail: 'Weak evidence: 9 / 10 tasks',
    },
  ]);
  expect(policy().acceptance_wake).toBe('each_merge');
});

it('reverts a trial with four more tasks that failed their first gate run than tasks that passed it', async () => {
  const { f, clock, retro, improvements, policy } = await setup();
  const failed = { gate_passed_on_attempt: 2, gate_failures: ['code' as const] };
  // The newest earlier tasks failed, so the first-pass share of the trial is no lower.
  for (let i = 0; i < 10; i++) retro(measured(1000, 10_000, { ...idle, ...(i >= 3 && failed) }));
  await f.control.tick();
  clock.now += 1_000;
  expect(improvements()[0]?.status).toBe('trial');
  for (let i = 0; i < 10; i++) retro(measured(800, 10_000, { ...lessIdle, ...(i >= 3 && failed) }));
  await f.control.tick();
  expect(improvements()).toMatchObject([{ status: 'reverted', status_reason: 'not_better' }]);
  expect(policy().acceptance_wake).toBe('each_merge');
});

it('reverts an experience trial whose findings per task did not fall to half', async () => {
  const { f, clock, retro, improvements, statusEvents } = await setup();
  const codes = (list: (string | undefined)[]) => {
    for (const code of list)
      retro(measured(1000, 10_000, code ? { turn_failure_codes: [code] } : {}));
  };
  codes(['a', 'a', 'b', 'b', 'c', 'c', 'd', 'd', undefined, undefined]);
  f.store.insert<Improvement>('improvements', {
    id: 'experience',
    revision: 1,
    project_id: f.project.id,
    source: 'lead',
    lead_session_id: 'lead',
    signal: 'repeat_turn_failure',
    retrospective_ids: [],
    status: 'trial',
    change: { type: 'experience', procedure: 'Retry a failed turn with a smaller step' },
    proposed_at: clock.now,
    trial_started_at: clock.now,
  });
  clock.now += 1_000;
  // The first five trial tasks show no finding; the repeats come after them.
  codes([undefined, undefined, undefined, undefined, 'a', 'a', 'b', 'b', 'c', 'c']);
  await f.control.tick();

  expect(improvements()).toMatchObject([
    { id: 'experience', status: 'reverted', status_reason: 'not_better' },
  ]);
  expect(statusEvents().at(-1)).toMatchObject({
    comparison: {
      baseline: { tasks: 10, signal_findings: 4 },
      trial: { tasks: 10, signal_findings: 3 },
    },
  });
});

it('holds a trial without ten earlier tasks to compare for the user', async () => {
  const { f, clock, retro, improvements, policy } = await setup();
  retro(measured(1000, 10_000, { lead_wakes: 10, lead_wakes_without_decision: 8 }));
  await f.control.tick();
  clock.now += 1_000;
  for (let i = 0; i < 10; i++) retro(measured(500, 5_000));
  await f.control.tick();
  expect(improvements()).toMatchObject([{ status: 'trial', status_reason: 'no_baseline' }]);
  expect(policy().acceptance_wake).toBe('milestone');
});

it('tells of a trial held without earlier tasks once with a status event and keeps its start', async () => {
  const { f, clock, retro, improvements, statusEvents } = await setup();
  retro(measured(1000, 10_000, { lead_wakes: 10, lead_wakes_without_decision: 8 }));
  await f.control.tick();
  const [trial] = improvements();
  clock.now += 1_000;
  for (let i = 0; i < 10; i++) retro(measured(500, 5_000));
  await f.control.tick();
  retro(measured(500, 5_000));
  await f.control.tick();

  expect(improvements()).toMatchObject([
    { status: 'trial', status_reason: 'no_baseline', trial_started_at: trial!.trial_started_at },
  ]);
  expect(statusEvents().filter((event) => event.reason === 'no_baseline')).toMatchObject([
    { improvement_id: trial!.id, from: 'trial', to: 'trial', reason: 'no_baseline' },
  ]);
});

it('keeps the reason a trial was reverted for when the user changed its value meanwhile', async () => {
  const { f, retro, improvements, policy, statusEvents, improvement } = await onTrial();
  f.call(
    'workflow.policy.set',
    { project_id: f.project.id, acceptance_wake: 'each_merge' },
    policy().revision,
  );
  for (let i = 0; i < 10; i++) retro(measured(950, 10_000, idle));
  await f.control.tick();

  expect(improvements()).toMatchObject([
    {
      id: improvement.id,
      status: 'reverted',
      status_reason: 'not_better',
      status_detail: expect.stringContaining('acceptance_wake was changed'),
    },
  ]);
  expect(statusEvents().at(-1)).toMatchObject({ to: 'reverted', reason: 'not_better' });
  expect(policy().acceptance_wake).toBe('each_merge');
});

it('proposes nothing for a signal of a pinned parameter but still counts it against an experience trial', async () => {
  const { f, clock, retro, improvements } = await setup();
  f.call('workflow.policy.set', { project_id: f.project.id, pinned: ['acceptance_wake'] }, null);
  for (let i = 0; i < 10; i++) retro(measured(1000, 10_000, idle));
  await f.control.tick();
  expect(improvements()).toEqual([]);
  expect(f.control.improvementSignals(user, f.project.id)).toMatchObject([
    { signal: 'idle_wakeups', withheld: 'pinned' },
  ]);

  f.store.insert<Improvement>('improvements', {
    id: 'experience',
    revision: 1,
    project_id: f.project.id,
    source: 'lead',
    lead_session_id: 'lead',
    signal: 'idle_wakeups',
    retrospective_ids: [],
    status: 'trial',
    change: { type: 'experience', procedure: 'Answer each wake with a decision' },
    proposed_at: clock.now,
    trial_started_at: clock.now,
  });
  clock.now += 1_000;
  for (let i = 0; i < 10; i++) retro(measured(1000, 10_000, idle));
  await f.control.tick();

  expect(improvements()).toMatchObject([
    { id: 'experience', status: 'reverted', status_reason: 'not_better' },
  ]);
});

it('returns the signals from the query and lists them for a lead but no other role', async () => {
  const { f, retro } = await setup();
  const id = retro({ lead_wakes: 10, lead_wakes_without_decision: 8 });
  expect(f.control.improvementSignals(user, f.project.id)).toEqual([
    {
      signal: 'idle_wakeups',
      retrospective_ids: [id],
      suggestion: { type: 'policy_change', param: 'acceptance_wake', to: 'milestone' },
    },
  ]);
  const session = (sessionId: string, task?: Session['task']) =>
    f.store.insert<Session>('sessions', {
      id: sessionId,
      revision: 1,
      project_id: f.project.id,
      runtime: f.adapter.name,
      state: 'open',
      turn_count: 1,
      workspace_id: `${sessionId}-workspace`,
      ...(task && { task }),
    });
  session('lead');
  session('worker', { lead_session_id: 'lead', id: 'api' });
  const principalOf = (sessionId: string, role: 'lead' | 'worker'): Principal => ({
    id: `session:${sessionId}`,
    role,
    project_id: f.project.id,
    session_id: sessionId,
    expires_at: f.store.now() + 60000,
  });
  const read = (principal: Principal) =>
    f.call<ProjectRead>('project.read', { project_id: f.project.id }, null, principal);
  expect(read(principalOf('lead', 'lead')).lead?.signals).toEqual([
    { signal: 'idle_wakeups', retrospective_ids: [id] },
  ]);
  expect(read(principalOf('worker', 'worker'))).not.toHaveProperty('lead');
  expect(read(user)).not.toHaveProperty('lead');
});

it('lists the evaluator task sample and named comparison values with units', async () => {
  const { f, retro, improvement } = await onTrial();
  retro(measured(800, 10_500, { ...lessIdle, started_at: improvement.trial_started_at! - 1 }));
  for (let i = 0; i < 4; i++) retro(measured(800, 10_500, lessIdle));
  const read = () => f.control.improvementList(user, f.project.id)[0] as any;
  expect(read()).toMatchObject({
    trial_started_at: improvement.trial_started_at,
    source: 'daemon',
    retrospective_ids: improvement.retrospective_ids,
    trial: {
      tasks_seen: 4,
      tasks_required: 10,
      baseline_tasks: 4,
      metrics: [
        { name: 'first_pass', unit: 'tasks', baseline: 4, trial: 4 },
        { name: 'input_tokens', unit: 'tokens', baseline: 4000, trial: 3200 },
        { name: 'wall_ms', unit: 'milliseconds', baseline: 40000, trial: 42000 },
        { name: 'wakes_without_decision_per_task', unit: 'wakes/task', baseline: 2, trial: 1 },
      ],
    },
  });
  for (let i = 0; i < 6; i++) retro(measured(800, 10_500, lessIdle));
  await f.control.tick();
  expect(read().trial.tasks_seen).toBe(10);
  retro(measured(2000, 20_000, idle));
  expect(read().trial.tasks_seen).toBe(10);
  const ended = f.store.must<Improvement>('improvements', improvement.id);
  f.store.update<Improvement>(
    'improvements',
    { ...ended, trial_evaluation: undefined },
    ended.revision,
  );
  expect(read().trial.tasks_seen).toBe(10);
});

it('reports no baseline without fabricating zero comparison values', async () => {
  const { f, clock, retro } = await setup();
  f.store.insert<Improvement>('improvements', {
    id: 'without-baseline',
    revision: 1,
    project_id: f.project.id,
    source: 'lead',
    lead_session_id: 'lead',
    retrospective_ids: [],
    status: 'trial',
    change: { type: 'policy_change', param: 'max_parallel', from: 3, to: 2 },
    proposed_at: clock.now,
    trial_started_at: clock.now,
  });
  clock.now += 1000;
  for (let i = 0; i < 10; i++) retro(measured(800, 10000));
  await f.control.tick();
  const row = f.control.improvementList(user, f.project.id)[0] as any;
  expect(row).toMatchObject({
    status_reason: 'no_baseline',
    trial: { status_reason: 'no_baseline', tasks_seen: 10, baseline_tasks: 0 },
  });
  expect(row.trial.metrics).toEqual([
    { name: 'first_pass', unit: 'tasks', trial: 10 },
    { name: 'wait_and_execution_ms', unit: 'milliseconds', trial: 50000 },
  ]);
});

it('holds a trial when a baseline measurement is missing even if the trial measured it', async () => {
  const { f, retro, improvement } = await onTrial();
  const baseline = f.store.must<Retrospective>('retrospectives', 'retrospective-1');
  f.store.update<Retrospective>(
    'retrospectives',
    { ...baseline, lead_usage: undefined, task_usage: undefined },
    baseline.revision,
  );
  for (let i = 0; i < 10; i++) retro(measured(800, 10_500, lessIdle));
  await f.control.tick();
  const row = f.control.improvementList(user, f.project.id).find((r) => r.id === improvement.id)!;
  expect(row).toMatchObject({ status: 'trial', status_reason: 'no_baseline' });
  expect(row.trial?.metrics.find((metric) => metric.name === 'input_tokens')).toEqual({
    name: 'input_tokens',
    unit: 'tokens',
    trial: 8000,
  });
});
