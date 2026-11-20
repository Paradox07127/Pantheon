import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type {
  Approval,
  BoardPlan,
  Principal,
  Project,
  Retrospective,
  Session,
  SessionTurn,
  WorkflowPolicy,
  Workspace,
} from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, insideSandbox, settle, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
type PlanTask = BoardPlan['tasks'][number];

const sessionOf = (f: Fixture, sessionId: string, role: 'lead' | 'worker'): Principal => ({
  id: `session:${sessionId}`,
  role,
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});

const task = (id: string, fields: Partial<PlanTask> = {}): PlanTask => ({
  id,
  title: `Task ${id}`,
  goal: `Finish task ${id}`,
  lane: 'core',
  depends_on: [],
  source: ['Plan the export feature'],
  scope: [`src/${id}`],
  acceptance: ['true'],
  ...fields,
});

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const planOf = (f: Fixture, leadId: string) => f.store.must<BoardPlan>('board_plans', leadId);

function writePlan(f: Fixture, leadId: string, tasks: PlanTask[]) {
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: f.store.get<BoardPlan>('board_plans', leadId)?.plan_version ?? 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks,
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    sessionOf(f, leadId, 'lead'),
  );
}

async function leadWithPlan(f: Fixture, tasks: PlanTask[]) {
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id, tasks);
  return lead;
}

/** Starts the task through its lead and waits for its session's first turn to end. */
async function startedTask(f: Fixture, leadId: string, taskId: string) {
  f.call(
    'task.start',
    { project_id: f.project.id, task_ids: [taskId] },
    null,
    sessionOf(f, leadId, 'lead'),
  );
  await f.control.tick();
  const worker = f.store
    .list<Session>('sessions')
    .find((session) => session.task?.lead_session_id === leadId && session.task.id === taskId)!;
  await settle(f, worker);
  return worker;
}

async function setGate(f: Fixture, commands: { name: string; argv: string[] }[]) {
  const project = f.store.must<Project>('projects', f.project.id);
  await f.call<Project>(
    'project.gate.set',
    { project_id: f.project.id, root: f.source, commands },
    project.revision,
  );
  f.call<Project>(
    'project.autoMerge.set',
    { project_id: f.project.id, enabled: true },
    f.store.must<Project>('projects', f.project.id).revision,
  );
}

/** Commits a file under the scope of task a. */
function commit(f: Fixture, session: Session, name: string) {
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
  mkdirSync(path.join(workspace.path, 'src/a'), { recursive: true });
  name = `src/a/${name}`;
  writeFileSync(path.join(workspace.path, name), `${name}\n`);
  git(workspace.path, 'add', '--', name);
  git(workspace.path, 'commit', '--quiet', '-m', `Add ${name}`);
}

function setUsage(f: Fixture, sessionId: string, usage: SessionTurn['usage']) {
  const turn = f.turns(sessionId)[0]!;
  f.store.update<SessionTurn>('session_turns', { ...turn, usage }, turn.revision);
}

const message = (f: Fixture, leadId: string, taskId: string, text: string) =>
  f.call(
    'task.message',
    { project_id: f.project.id, task_id: taskId, text },
    null,
    sessionOf(f, leadId, 'lead'),
  );

const recorded = (f: Fixture) => f.store.list<Retrospective>('retrospectives');
const recordedEvents = (f: Fixture) =>
  f.store.events(0, undefined, 100000).filter((event) => event.kind === 'retrospective.recorded');

const mergeFixture = async () => {
  const f = await workbenchFixture();
  git(f.source, 'config', 'user.name', 'Source User');
  git(f.source, 'config', 'user.email', 'source@example.invalid');
  return f;
};

const MINUTE = 60_000;
const script = (...steps: object[]) => `fixture-script\n${JSON.stringify(steps)}`;

/** Runs the store clock ahead of the wall clock; returns how to move it further. */
function skewedClock(f: Fixture) {
  let skew = 0;
  vi.spyOn(f.store, 'now').mockImplementation(() => Date.now() + skew);
  return (ms: number) => {
    skew += ms;
  };
}

/** Starts the task through its lead and waits for its session's workspace. */
async function startTask(f: Fixture, leadId: string, taskId: string) {
  f.call(
    'task.start',
    { project_id: f.project.id, task_ids: [taskId] },
    null,
    sessionOf(f, leadId, 'lead'),
  );
  await f.control.tick();
  const worker = f.store
    .list<Session>('sessions')
    .find((session) => session.task?.lead_session_id === leadId && session.task.id === taskId)!;
  await awaitWorkspaceReady(f.control, worker.workspace_id!);
  return worker;
}

/** Removes every task but b from the plan, and waits for the record of task a. */
async function removeTaskA(f: Fixture, leadId: string) {
  writePlan(f, leadId, [task('b')]);
  await eventually(
    () => recorded(f).some((row) => row.task_id === 'a'),
    () => f.control.tick(),
  );
  return recorded(f).find((row) => row.task_id === 'a')!;
}

/** Waits for the record of the merged task, which the lead's wake about the merge holds back. */
const mergedRecord = (f: Fixture) =>
  eventually(
    () => recorded(f).some((row) => row.outcome === 'merged'),
    () => f.control.tick(),
    10000,
  );

const trackerTurns = (f: Fixture, leadId: string) =>
  f.turns(leadId).filter((turn) => turn.origin === 'tracker');

it.skipIf(insideSandbox)(
  'records one retrospective of a task whose session passed the gate and merged on its own',
  async () => {
    const f = await mergeFixture();
    const lead = await leadWithPlan(f, [
      task('a', { kind: { domain: 'script-infra', tier: 't2' } }),
    ]);
    const worker = await startedTask(f, lead.id, 'a');
    setUsage(f, worker.id, { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30 });
    await setGate(f, [{ name: 'Passes', argv: [process.execPath, '-e', 'process.exit(0)'] }]);
    commit(f, worker, 'export.txt');
    message(f, lead.id, 'a', 'Commit your work');
    await eventually(
      () => current(f, worker.id).outcome === 'merged',
      () => f.control.tick(),
      10000,
    );
    await mergedRecord(f);

    const [row] = recorded(f);
    expect(row).toMatchObject({
      project_id: f.project.id,
      lead_session_id: lead.id,
      task_id: 'a',
      outcome: 'merged',
      session_ids: [worker.id],
      planned_kind: { domain: 'script-infra', tier: 't2' },
      runtime: f.adapter.name,
      gate_passed_on_attempt: 1,
      handbacks: [],
      task_usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30 },
    });
    expect(row!.stage_ms).toMatchObject({
      planning: expect.any(Number),
      dispatch_wait: expect.any(Number),
      execution: expect.any(Number),
      gate_and_merge: expect.any(Number),
    });
    expect(recordedEvents(f).map((event) => event.payload)).toEqual([
      {
        retrospective_id: row!.id,
        project_id: f.project.id,
        lead_session_id: lead.id,
        task_id: 'a',
      },
    ]);

    for (let i = 0; i < 3; i++) await f.control.tick();
    expect(recorded(f)).toHaveLength(1);
    expect(recordedEvents(f)).toHaveLength(1);
  },
);

it.skipIf(insideSandbox)(
  'records one retrospective of a session the user opened in the project folder once it lands',
  async () => {
    const f = await mergeFixture();
    await f.call<Project>(
      'project.gate.set',
      {
        project_id: f.project.id,
        root: f.source,
        commands: [{ name: 'Passes', argv: [process.execPath, '-e', 'process.exit(0)'] }],
      },
      f.store.must<Project>('projects', f.project.id).revision,
    );
    const { id } = await f.call<Promise<Session>>('session.create', {
      project_id: f.project.id,
      runtime: f.adapter.name,
      input: script({ write: { path: 'notes.txt', text: 'notes\n' } }, { commit: 'Add notes' }),
      workspace: 'in_place',
    });
    await eventually(
      () => f.turns(id).every((turn) => !['queued', 'running'].includes(turn.state)),
      () => f.control.tick(),
    );
    setUsage(f, id, { input_tokens: 90, output_tokens: 15 });
    await f.call('session.gates.run', { session_id: id }, current(f, id).revision);
    await eventually(
      () => !f.control.sessionGates(user, id).running,
      () => f.control.tick(),
    );
    await f.call('session.merge', { session_id: id }, current(f, id).revision);
    expect(current(f, id).outcome).toBe('merged');
    await eventually(
      () => recorded(f).length > 0,
      () => f.control.tick(),
    );

    const [row] = recorded(f);
    expect(row).toMatchObject({
      id: `${id}:session:1`,
      origin: 'session',
      project_id: f.project.id,
      lead_session_id: id,
      task_id: 'session',
      session_ids: [id],
      outcome: 'merged',
      runtime: f.adapter.name,
      gate_passed_on_attempt: 1,
      task_usage: { input_tokens: 90, output_tokens: 15 },
      stage_ms: { execution: expect.any(Number) },
    });
    expect(recordedEvents(f).map((event) => event.payload)).toEqual([
      {
        retrospective_id: row!.id,
        project_id: f.project.id,
        lead_session_id: id,
        task_id: 'session',
      },
    ]);

    for (let i = 0; i < 3; i++) await f.control.tick();
    expect(recorded(f)).toHaveLength(1);
  },
);

const passes = { name: 'Passes', argv: [process.execPath, '-e', 'process.exit(0)'] };
const needsFix = {
  name: 'Needs the fix',
  argv: [process.execPath, '-e', "process.exit(require('fs').existsSync('src/a/fix.txt') ? 0 : 3)"],
};

it.skipIf(insideSandbox).each([
  {
    name: 'counts the gate run that passed after a failed gate was handed back',
    gate: [needsFix],
    check: (f: Fixture, leadId: string, workerId: string) => {
      expect(planOf(f, leadId).handed_back).toEqual({ [workerId]: ['gate_failed'] });
      expect(recorded(f)).toEqual([
        expect.objectContaining({
          task_id: 'a',
          outcome: 'merged',
          gate_passed_on_attempt: 2,
          handbacks: [{ reason: 'gate_failed' }],
        }),
      ]);
    },
  },
  {
    name: 'records the class of each failed gate run before the pass',
    gate: [needsFix],
    check: (f: Fixture) =>
      expect(recorded(f)).toEqual([
        expect.objectContaining({ gate_passed_on_attempt: 2, gate_failures: ['code'] }),
      ]),
  },
  {
    name: 'records the name of the check that failed in each failed gate run',
    gate: [passes, needsFix],
    check: (f: Fixture) =>
      expect(recorded(f)).toEqual([
        expect.objectContaining({ gate_failures: ['code'], gate_failed_checks: ['Needs the fix'] }),
      ]),
  },
])('$name', async ({ gate, check }) => {
  const f = await mergeFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const worker = await startedTask(f, lead.id, 'a');
  await setGate(f, gate);
  commit(f, worker, 'export.txt');
  message(f, lead.id, 'a', 'Commit your work');
  await eventually(
    () => current(f, worker.id).merge?.reason === 'gate_failed',
    () => f.control.tick(),
    10000,
  );
  commit(f, worker, 'fix.txt');
  await eventually(
    () => current(f, worker.id).outcome === 'merged',
    () => f.control.tick(),
    10000,
  );
  await mergedRecord(f);

  check(f, lead.id, worker.id);
});

it.skipIf(insideSandbox)('records the kind measured from the merged diff', async () => {
  const f = await mergeFixture();
  const lead = await leadWithPlan(f, [task('a', { kind: { domain: 'docs-chore', tier: 't2' } })]);
  const worker = await startedTask(f, lead.id, 'a');
  await setGate(f, [{ name: 'Passes', argv: [process.execPath, '-e', 'process.exit(0)'] }]);
  commit(f, worker, 'export.txt');
  message(f, lead.id, 'a', 'Commit your work');
  await eventually(
    () => current(f, worker.id).outcome === 'merged',
    () => f.control.tick(),
    10000,
  );
  await mergedRecord(f);

  expect(recorded(f)).toEqual([
    expect.objectContaining({
      outcome: 'merged',
      planned_kind: { domain: 'docs-chore', tier: 't2' },
      measured_kind: { domain: 'backend-logic', tier: 't1' },
    }),
  ]);
});

it('records a task the lead removed from its plan as removed', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a'), task('b')]);
  writePlan(f, lead.id, [task('a')]);
  await f.control.tick();
  await f.control.tick();

  expect(recorded(f)).toEqual([
    expect.objectContaining({
      id: expect.any(String),
      lead_session_id: lead.id,
      task_id: 'b',
      outcome: 'removed',
      session_ids: [],
    }),
  ]);
});

it('lists the retrospectives of one task at the retrospective.list query', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a'), task('b'), task('c')]);
  writePlan(f, lead.id, [task('c')]);
  await f.control.tick();

  expect(f.control.retrospectiveList(user, f.project.id)).toHaveLength(2);
  expect(f.control.retrospectiveList(user, f.project.id, 'a')).toEqual([
    expect.objectContaining({ task_id: 'a', outcome: 'removed' }),
  ]);
  expect(() => f.control.retrospectiveList(sessionOf(f, lead.id, 'lead'), f.project.id)).toThrow();
});

it.skipIf(insideSandbox)(
  'replaces the failed record of a stopped task once the task is started again and merges',
  async () => {
    const f = await mergeFixture();
    const lead = await leadWithPlan(f, [task('a')]);
    const stopped = await startedTask(f, lead.id, 'a');
    f.call(
      'task.stop',
      { project_id: f.project.id, task_id: 'a', reason: 'The approach changed' },
      null,
      sessionOf(f, lead.id, 'lead'),
    );
    await eventually(
      () => recorded(f).some((row) => row.outcome === 'failed'),
      () => f.control.tick(),
    );

    f.call(
      'task.start',
      { project_id: f.project.id, task_ids: ['a'] },
      null,
      sessionOf(f, lead.id, 'lead'),
    );
    await f.control.tick();
    const worker = f.store
      .list<Session>('sessions')
      .find((session) => session.task?.id === 'a' && session.id !== stopped.id)!;
    await settle(f, worker);
    await setGate(f, [{ name: 'Passes', argv: [process.execPath, '-e', 'process.exit(0)'] }]);
    commit(f, worker, 'export.txt');
    message(f, lead.id, 'a', 'Commit your work');
    await eventually(
      () => current(f, worker.id).outcome === 'merged',
      () => f.control.tick(),
      10000,
    );
    await mergedRecord(f);

    expect(recorded(f)).toEqual([
      expect.objectContaining({
        task_id: 'a',
        outcome: 'merged',
        session_ids: expect.arrayContaining([stopped.id, worker.id]),
        gate_passed_on_attempt: 1,
      }),
    ]);
  },
);

const failedRecord = async (f: Fixture) => {
  await eventually(
    () => recorded(f).some((row) => row.outcome === 'failed'),
    () => f.control.tick(),
  );
  return recorded(f).find((row) => row.outcome === 'failed')!;
};

it('records that the lead stopped a task it stopped with the stop command', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  await startedTask(f, lead.id, 'a');
  f.call(
    'task.stop',
    { project_id: f.project.id, task_id: 'a', reason: 'The approach changed' },
    null,
    sessionOf(f, lead.id, 'lead'),
  );

  expect(await failedRecord(f)).toMatchObject({ outcome: 'failed', stopped_by: 'lead' });
});

it('records that the user stopped a task whose session the user discarded', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const worker = await startedTask(f, lead.id, 'a');
  f.call('session.discard', { session_id: worker.id }, current(f, worker.id).revision);

  expect(await failedRecord(f)).toMatchObject({ outcome: 'failed', stopped_by: 'user' });
});

it('records no stopper of a task whose session closed on its own without merging', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const worker = await startedTask(f, lead.id, 'a');
  const open = current(f, worker.id);
  f.store.update<Session>('sessions', { ...open, state: 'closed' }, open.revision);

  const row = await failedRecord(f);
  expect(row.outcome).toBe('failed');
  expect(row).not.toHaveProperty('stopped_by');
});

it('records how long a failed task ran, up to the end of its last turn', async () => {
  const f = await workbenchFixture();
  const advance = skewedClock(f);
  const lead = await leadWithPlan(f, [task('a')]);
  const worker = await startedTask(f, lead.id, 'a');
  advance(30 * MINUTE);
  const open = current(f, worker.id);
  f.store.update<Session>('sessions', { ...open, state: 'closed' }, open.revision);

  const row = await failedRecord(f);
  expect(row.stage_ms?.execution).toEqual(expect.any(Number));
  expect(row.stage_ms!.execution).toBeLessThan(MINUTE);
});

it('rewrites the failed record when the task fails again in the same generation', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const discarded = await startedTask(f, lead.id, 'a');
  f.call('session.discard', { session_id: discarded.id }, current(f, discarded.id).revision);
  expect(await failedRecord(f)).toMatchObject({ outcome: 'failed', stopped_by: 'user' });

  f.call(
    'task.start',
    { project_id: f.project.id, task_ids: ['a'] },
    null,
    sessionOf(f, lead.id, 'lead'),
  );
  await f.control.tick();
  const worker = f.store
    .list<Session>('sessions')
    .find((session) => session.task?.id === 'a' && session.id !== discarded.id)!;
  await settle(f, worker);
  const open = current(f, worker.id);
  f.store.update<Session>('sessions', { ...open, state: 'closed' }, open.revision);
  await f.control.tick();

  const [row] = recorded(f);
  expect(row).not.toHaveProperty('stopped_by');
  expect(row!.session_ids).toEqual(expect.arrayContaining([discarded.id, worker.id]));
});

it('records the dispatch path, and the policy version in force when the task session opened', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a'), task('b')]);
  const setPolicy = (handback_limit: number) =>
    f.call(
      'workflow.policy.set',
      { project_id: f.project.id, handback_limit },
      f.store.get<WorkflowPolicy>('workflow_policies', f.project.id)?.revision ?? null,
    );
  setPolicy(4);
  await startTask(f, lead.id, 'a');
  setPolicy(5);

  const row = await removeTaskA(f, lead.id);
  expect(row).toMatchObject({
    outcome: 'removed',
    path: 'dispatch',
    policy_version: 1,
    started_at: expect.any(Number),
  });
});

const setBudget = (f: Fixture, cell: { input_tokens: number; wall_ms: number }) =>
  f.call(
    'workflow.policy.set',
    { project_id: f.project.id, path: { t1: 'dispatch' }, budget: { t1: { dispatch: cell } } },
    f.store.get<WorkflowPolicy>('workflow_policies', f.project.id)?.revision ?? null,
  );

/** The record of task a of the tier, started and then removed, whose session spent 120 input tokens. */
async function spentTask(f: Fixture, tier: 't1' | 't2') {
  const lead = await leadWithPlan(f, [
    task('a', { kind: { domain: 'backend-logic', tier }, scope: ['src/a.ts'] }),
    task('b'),
  ]);
  const worker = await startedTask(f, lead.id, 'a');
  setUsage(f, worker.id, { input_tokens: 120, output_tokens: 30 });
  return removeTaskA(f, lead.id);
}

const wallOf = (row: Retrospective) =>
  Object.values(row.stage_ms ?? {}).reduce((sum, ms) => sum + ms, 0);

it("records the budget ratio of a dispatched task over its tier's input token budget", async () => {
  const f = await workbenchFixture();
  setBudget(f, { input_tokens: 100, wall_ms: 3_600_000 });

  const row = await spentTask(f, 't1');
  expect(row).toMatchObject({ path: 'dispatch', task_usage: { input_tokens: 120 } });
  expect(row).not.toHaveProperty('lead_usage');
  expect(row.budget_ratio).toBe(1.2);
});

it('records the wall-clock ratio of a task within its budget when it is the larger one', async () => {
  const f = await workbenchFixture();
  setBudget(f, { input_tokens: 1_000_000_000, wall_ms: 3_600_000 });

  const row = await spentTask(f, 't1');
  expect(wallOf(row)).toBeGreaterThan(0);
  expect(row.budget_ratio).toBe(wallOf(row) / 3_600_000);
  expect(row.budget_ratio).toBeLessThan(1);
});

it('leaves the budget ratio absent for a tier without a budget', async () => {
  const f = await workbenchFixture();

  const row = await spentTask(f, 't2');
  expect(row).toMatchObject({ path: 'dispatch', task_usage: { input_tokens: 120 } });
  expect(row).not.toHaveProperty('budget_ratio');
});

it.skipIf(insideSandbox)(
  'counts the merges of the task session refused for files outside its scope',
  async () => {
    const f = await mergeFixture();
    const lead = await leadWithPlan(f, [task('a'), task('b')]);
    const worker = await startedTask(f, lead.id, 'a');
    const workspace = f.store.must<Workspace>('workspaces', worker.workspace_id!);
    writeFileSync(path.join(workspace.path, 'README.md'), 'Outside the scope\n');
    git(workspace.path, 'add', '--', 'README.md');
    git(workspace.path, 'commit', '--quiet', '-m', 'Change the readme');
    f.call<Session>('session.merge', { session_id: worker.id }, current(f, worker.id).revision);
    await eventually(
      () => current(f, worker.id).merge?.state === 'blocked',
      () => f.control.tick(),
      10000,
    );
    expect(current(f, worker.id).merge?.reason).toBe('out_of_scope');

    const row = await removeTaskA(f, lead.id);
    expect(row.scope_violations).toBe(1);
  },
);

it('counts one stall and one loop of a turn, not the reminders that follow them', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a'), task('b')]);
  const advance = skewedClock(f);
  (f.adapter as { delay: number }).delay = 60000;
  const worker = await startTask(f, lead.id, 'a');
  await eventually(
    () => f.turns(worker.id)[0]?.state === 'running',
    () => f.control.tick(),
  );
  const turn = f.turns(worker.id)[0]!;
  advance(11 * MINUTE);
  await f.control.tick();
  advance(11 * MINUTE);
  await f.control.tick();
  let calls = 0;
  const event = (kind: string, fields: Record<string, unknown>) =>
    f.store.event(kind, current(f, worker.id), f.project.id, { turn_id: turn.id, ...fields });
  const fail = async (times: number) => {
    for (let index = 0; index < times; index++) {
      const id = `call-${++calls}`;
      event('agent.tool.started', {
        tool_call_id: id,
        name: 'Bash',
        input: { command: 'pnpm test' },
      });
      event('agent.tool.completed', { tool_call_id: id, ok: false, output: 'exit 1' });
    }
    await f.control.tick();
  };
  await fail(3);
  await fail(3);
  const kinds = f.store
    .kindEvents(f.project.id, ['lead.note_added'])
    .map((note) => (note.payload as { kind: string }).kind);
  expect(kinds.filter((kind) => kind === 'stalled')).toHaveLength(1);
  expect(kinds.filter((kind) => kind === 'looping')).toHaveLength(2);

  const row = await removeTaskA(f, lead.id);
  expect(row).toMatchObject({ stalls: 1, loops: 1 });
});

it('sums the time each permission request of the task session waited for its answer', async () => {
  const f = await workbenchFixture();
  f.call(
    'workflow.policy.set',
    { project_id: f.project.id, charter: { approve_worker_prompts: 'ask' } },
    null,
  );
  const lead = await leadWithPlan(f, [
    task('a', {
      goal: script({ ask: { tool: 'Bash', input: { command: 'pnpm test' } } }, { hang: true }),
    }),
    task('b'),
  ]);
  const advance = skewedClock(f);
  const worker = await startTask(f, lead.id, 'a');
  const pending = () =>
    f.store
      .list<Approval>('approvals')
      .find((approval) => approval.session_id === worker.id && approval.state === 'pending');
  await eventually(
    () => !!pending(),
    () => f.control.tick(),
  );
  advance(5 * MINUTE);
  const approval = pending()!;
  f.call('approval.respond', { approval_id: approval.id, decision: 'approve' }, approval.revision);
  await eventually(
    () => f.store.must<Approval>('approvals', approval.id).resolved_at !== undefined,
    () => f.control.tick(),
  );

  const row = await removeTaskA(f, lead.id);
  expect(row.approval_wait_ms).toBeGreaterThanOrEqual(5 * MINUTE);
  expect(row.approval_wait_ms).toBeLessThan(6 * MINUTE);
});

/** Starts task a, whose turn fails, and waits for the lead's wake about it, which runs for wakeDelay, to start. */
async function wokenLead(f: Fixture, wakeDelay = 0) {
  const lead = await leadWithPlan(f, [
    task('a', { goal: script({ fail: 'The build broke' }) }),
    task('b'),
  ]);
  (f.adapter as { delay: number }).delay = wakeDelay;
  await startTask(f, lead.id, 'a');
  await eventually(
    () => trackerTurns(f, lead.id).some((turn) => turn.state !== 'queued'),
    () => f.control.tick(),
    10000,
  );
  return lead;
}

const wakeEnded = (f: Fixture, leadId: string) =>
  eventually(
    () =>
      trackerTurns(f, leadId).length > 0 &&
      trackerTurns(f, leadId).every((turn) => !['queued', 'running'].includes(turn.state)),
    () => f.control.tick(),
    10000,
  );

it('counts a wake of the lead for the task that ended without a decision, with its usage', async () => {
  const f = await workbenchFixture();
  const lead = await wokenLead(f);
  await wakeEnded(f, lead.id);
  const [wake] = trackerTurns(f, lead.id);
  f.store.update<SessionTurn>(
    'session_turns',
    { ...wake!, usage: { input_tokens: 900, cached_input_tokens: 100, output_tokens: 50 } },
    wake!.revision,
  );

  const row = await removeTaskA(f, lead.id);
  expect(row).toMatchObject({
    lead_wakes: 1,
    lead_wakes_without_decision: 1,
    lead_usage: { input_tokens: 900, cached_input_tokens: 100, output_tokens: 50 },
  });
});

it('does not count a wake in which the lead messaged the task as one without a decision', async () => {
  const f = await workbenchFixture();
  const lead = await wokenLead(f, 3000);
  expect(trackerTurns(f, lead.id)[0]!.state).toBe('running');
  message(f, lead.id, 'a', 'Clear the build cache and try again');
  await wakeEnded(f, lead.id);

  const row = await removeTaskA(f, lead.id);
  expect(row).toMatchObject({ lead_wakes: 1, lead_wakes_without_decision: 0 });
});

const fastTasks = (f: Fixture) => ((f.adapter as { delay: number }).delay = 200);

it.skipIf(insideSandbox)(
  'records a merged task after the wake about the merge ended, with the decision the lead made in it',
  async () => {
    const f = await mergeFixture();
    const lead = await leadWithPlan(f, [task('a'), task('b')]);
    fastTasks(f);
    const worker = await startedTask(f, lead.id, 'a');
    await setGate(f, [{ name: 'Passes', argv: [process.execPath, '-e', 'process.exit(0)'] }]);
    commit(f, worker, 'export.txt');
    message(f, lead.id, 'a', 'Commit your work');
    await eventually(
      () => trackerTurns(f, lead.id).some((turn) => turn.state === 'running'),
      () => f.control.tick(),
      15000,
    );
    await f.control.tick();
    expect(recorded(f)).toEqual([]);

    f.call(
      'task.start',
      { project_id: f.project.id, task_ids: ['b'] },
      null,
      sessionOf(f, lead.id, 'lead'),
    );
    await wakeEnded(f, lead.id);
    await f.control.tick();

    expect(recorded(f)).toEqual([
      expect.objectContaining({
        task_id: 'a',
        outcome: 'merged',
        lead_wakes: 1,
        lead_wakes_without_decision: 0,
      }),
    ]);
  },
);

it('counts a wake that carried notes about two tasks for one of them', async () => {
  const f = await workbenchFixture();
  const failing = { goal: script({ wait: 1500 }, { fail: 'The build broke' }) };
  const lead = await leadWithPlan(f, [task('a', failing), task('b', failing), task('c')]);
  f.call(
    'task.start',
    { project_id: f.project.id, task_ids: ['a', 'b'] },
    null,
    sessionOf(f, lead.id, 'lead'),
  );
  await f.control.tick();
  const workers = f.store.list<Session>('sessions').filter((session) => session.task);
  expect(workers).toHaveLength(2);
  await eventually(
    () => workers.every((worker) => f.turns(worker.id).some((turn) => turn.state === 'running')),
    () => f.control.tick(),
    10000,
  );
  // Both failures reach the tracker in one tick, so one wake carries both notes.
  await eventually(
    () => workers.every((worker) => f.turns(worker.id).some((turn) => turn.state === 'failed')),
    undefined,
    10000,
  );
  await wakeEnded(f, lead.id);
  expect(trackerTurns(f, lead.id)).toHaveLength(1);

  writePlan(f, lead.id, [task('c')]);
  await eventually(
    () => recorded(f).length === 2,
    () => f.control.tick(),
  );
  expect(
    recorded(f)
      .map((row) => row.lead_wakes)
      .sort(),
  ).toEqual([0, 1]);
});
