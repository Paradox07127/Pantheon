import { expect, it, vi } from 'vitest';
import type { BoardPlan, Principal, Session, SessionTurn } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, settle, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';
import { taskReportGeneration } from '../../packages/control/dist/session.js';
import type { ControlContext } from '../../packages/control/dist/context.js';

type Fixture = ReturnType<typeof workbenchFixture>;
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
  acceptance: ['pnpm test'],
  ...fields,
});

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

const messageTask = (
  f: Fixture,
  leadId: string,
  taskId: string,
  text: string,
  principal?: Principal,
) =>
  f.call<SessionTurn>(
    'task.message',
    { project_id: f.project.id, task_id: taskId, text },
    null,
    principal ?? sessionOf(f, leadId, 'lead'),
  );

const openTask = (f: Fixture, leadId: string, taskId: string) =>
  f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Build it',
    task_id: `${leadId}:${taskId}`,
  });

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const planOf = (f: Fixture, leadId: string) => f.store.must<BoardPlan>('board_plans', leadId);

function patch(f: Fixture, sessionId: string, fields: Partial<Session>) {
  const session = current(f, sessionId);
  f.store.update<Session>('sessions', { ...session, ...fields }, session.revision);
}

async function leadWithPlan(f: Fixture, tasks: PlanTask[]) {
  const lead = f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id, tasks);
  return lead;
}

it('starts a turn from the lead on an idle task session', async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const worker = openTask(f, lead.id, 'a');
  await settle(f, worker);

  const turn = messageTask(f, lead.id, 'a', 'Keep the CSV header as it is');
  expect(turn).toMatchObject({
    session_id: worker.id,
    kind: 'send',
    origin: 'lead',
    input: '[Lead] Keep the CSV header as it is',
  });
  expect(current(f, worker.id).state).toBe('running');
  expect(
    f.store
      .events(0, undefined, 10000)
      .filter((event) => event.kind === 'task.messaged')
      .map((event) => event.payload),
  ).toEqual([{ task_id: 'a', turn_id: turn.id }]);

  await settle(f, worker);
  expect(f.turns(worker.id).at(-1)).toMatchObject({ id: turn.id, state: 'completed' });
});

it('queues the message of the lead after the running turn without steering it', async () => {
  const f = workbenchFixture({ delay: 400 });
  const lead = await leadWithPlan(f, [task('a')]);
  const worker = openTask(f, lead.id, 'a');
  await awaitWorkspaceReady(f.control, worker.workspace_id!);
  await eventually(
    () => f.turns(worker.id).some((turn) => turn.state === 'running'),
    () => f.control.tick(),
  );

  const turn = messageTask(f, lead.id, 'a', 'Also cover empty exports');
  expect(turn).toMatchObject({ kind: 'send', origin: 'lead', state: 'queued' });
  expect(f.turns(worker.id).map((row) => row.kind)).toEqual(['send', 'send']);
  expect(f.turns(worker.id)[0]!.state).toBe('running');

  await settle(f, worker);
  expect(f.turns(worker.id).map((row) => row.state)).toEqual(['completed', 'completed']);
});

it("counts the lead's message queued behind the running turn among the session's turns", async () => {
  const f = workbenchFixture({ delay: 400 });
  const lead = await leadWithPlan(f, [task('a')]);
  const worker = openTask(f, lead.id, 'a');
  await awaitWorkspaceReady(f.control, worker.workspace_id!);
  await eventually(
    () => f.turns(worker.id).some((turn) => turn.state === 'running'),
    () => f.control.tick(),
  );
  const before = current(f, worker.id).turn_count;

  messageTask(f, lead.id, 'a', 'Also cover empty exports');
  expect(current(f, worker.id).turn_count).toBe(before + 1);
});

it("refuses messages from other roles, for another lead's tasks and to closed or missing sessions", async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [task('a'), task('b')]);
  const other = await leadWithPlan(f, [task('c')]);
  const worker = openTask(f, lead.id, 'a');
  openTask(f, other.id, 'c');
  await settle(f, worker);

  expect(() => messageTask(f, lead.id, 'a', 'Go on', user)).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
  expect(() => messageTask(f, lead.id, 'a', 'Go on', sessionOf(f, worker.id, 'worker'))).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
  expect(() => messageTask(f, lead.id, 'c', 'Go on')).toThrow(
    expect.objectContaining({ code: 'not_found' }),
  );
  expect(() => messageTask(f, lead.id, 'b', 'Go on')).toThrow(
    expect.objectContaining({ code: 'invalid_state' }),
  );
  patch(f, worker.id, { state: 'closed' });
  expect(() => messageTask(f, lead.id, 'a', 'Go on')).toThrow(
    expect.objectContaining({ code: 'invalid_state' }),
  );
  expect(f.turns(worker.id).some((turn) => turn.origin === 'lead')).toBe(false);
});

it("refuses the lead's message to a task session as a source quote", async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const worker = openTask(f, lead.id, 'a');
  await settle(f, worker);
  messageTask(f, lead.id, 'a', 'Ship the export as CSV');

  expect(() => writePlan(f, lead.id, [task('a', { source: ['Ship the export as CSV'] })])).toThrow(
    expect.objectContaining({ code: 'invalid_input' }),
  );
});

it('tells an idle task session the contract its lead changed on the next tick, once', async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const worker = openTask(f, lead.id, 'a');
  await settle(f, worker);

  writePlan(f, lead.id, [task('a', { acceptance: ['pnpm exec vitest run tests/export.test.ts'] })]);
  expect(planOf(f, lead.id).contract_changed).toEqual([worker.id]);
  await f.control.tick();
  const told = f.turns(worker.id).filter((turn) => turn.origin === 'lead');
  expect(told).toHaveLength(1);
  expect(told[0]!.input.startsWith('[Pantheon] The lead changed this task.')).toBe(true);
  expect(told[0]!.input).toContain('- pnpm exec vitest run tests/export.test.ts');
  expect(planOf(f, lead.id).contract_changed).toEqual([]);

  await settle(f, worker);
  await f.control.tick();
  expect(f.turns(worker.id).filter((turn) => turn.origin === 'lead')).toHaveLength(1);
});

it("carries the changed contract in the lead's message that comes before the tick", async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const worker = openTask(f, lead.id, 'a');
  await settle(f, worker);

  writePlan(f, lead.id, [task('a', { acceptance: ['pnpm exec vitest run tests/export.test.ts'] })]);
  const turn = messageTask(f, lead.id, 'a', 'Go on with the export');
  expect(
    turn.input.startsWith('[Lead] Go on with the export\n\n[Pantheon] The lead changed this task.'),
  ).toBe(true);
  expect(turn.input).toContain('- pnpm exec vitest run tests/export.test.ts');
  expect(planOf(f, lead.id).contract_changed).toEqual([worker.id]);
  expect(current(f, worker.id).task?.generation ?? 1).toBe(1);

  await settle(f, worker);
  await f.control.tick();
  expect(f.turns(worker.id).filter((row) => row.origin === 'lead')).toHaveLength(1);
});

it("tells a task session the changed contract with the user's message once its turn starts", async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const worker = openTask(f, lead.id, 'a');
  await settle(f, worker);

  writePlan(f, lead.id, [task('a', { goal: 'Export as JSON instead' })]);
  const turn = f.call<SessionTurn>(
    'session.send',
    { session_id: worker.id, input: 'Go on with the export' },
    current(f, worker.id).revision,
  );
  expect(turn.input).toBe('Go on with the export');
  expect(planOf(f, lead.id).contract_changed).toEqual([worker.id]);
  expect(current(f, worker.id).task?.generation ?? 1).toBe(1);

  await settle(f, worker);
  const started = f.store.must<SessionTurn>('session_turns', turn.id);
  expect(
    started.input.startsWith('Go on with the export\n\n[Pantheon] The lead changed this task.'),
  ).toBe(true);
  expect(started.input).toContain('Export as JSON instead');
  expect(current(f, worker.id).task?.generation).toBe(2);
  expect(planOf(f, lead.id).contract_changed).toEqual([]);
  await f.control.tick();
  expect(f.turns(worker.id).filter((row) => row.origin === 'lead')).toHaveLength(0);
});

it("keeps the changed contract when a restart fails the user's message before its turn starts", async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const worker = openTask(f, lead.id, 'a');
  await settle(f, worker);

  writePlan(f, lead.id, [task('a', { goal: 'Export as JSON instead' })]);
  const turn = f.call<SessionTurn>(
    'session.send',
    { session_id: worker.id, input: 'Go on with the export' },
    current(f, worker.id).revision,
  );
  // The restart finds the stored identity of the worker's exited process.
  patch(f, worker.id, { process_identity: { pid: 2_000_000_000 } });
  await f.restart();
  expect(f.store.must<SessionTurn>('session_turns', turn.id).state).toBe('failed');
  expect(planOf(f, lead.id).contract_changed).toEqual([worker.id]);
  expect(current(f, worker.id).task?.generation ?? 1).toBe(1);

  await eventually(
    () => f.turns(worker.id).some((row) => row.input.includes('The lead changed this task.')),
    () => f.control.tick(),
  );
  await settle(f, worker);
  const told = f
    .turns(worker.id)
    .filter((row) => row.input.includes('The lead changed this task.'));
  expect(told).toHaveLength(1);
  expect(told[0]!.input).toContain('Export as JSON instead');
  expect(current(f, worker.id).task?.generation).toBe(2);
});

it("keeps the changed contract when a restart fails the lead's queued message before delivery", async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const worker = openTask(f, lead.id, 'a');
  await settle(f, worker);

  writePlan(f, lead.id, [task('a', { goal: 'Export as JSON instead' })]);
  const queued = messageTask(f, lead.id, 'a', 'Go on with the export');
  expect(queued.input).toContain('Export as JSON instead');
  // The restart finds the stored identity of the worker's exited process.
  patch(f, worker.id, { process_identity: { pid: 2_000_000_000 } });
  await f.restart();
  expect(f.store.must<SessionTurn>('session_turns', queued.id).state).toBe('failed');
  expect(planOf(f, lead.id).contract_changed).toEqual([worker.id]);
  expect(current(f, worker.id).task?.generation ?? 1).toBe(1);

  await settle(f, worker);
  const delivered = f
    .turns(worker.id)
    .filter(
      (turn) => turn.state === 'completed' && turn.input.includes('The lead changed this task.'),
    );
  expect(delivered).toHaveLength(1);
  expect(delivered[0]!.input).toContain('Export as JSON instead');
  expect(current(f, worker.id).task?.generation).toBe(2);
  expect(planOf(f, lead.id).contract_changed).toEqual([]);
});

it.each(['start', 'resume'] as const)(
  'keeps a changed contract pending when the native %s fails before input delivery',
  async (launch) => {
    const f = workbenchFixture();
    const lead = await leadWithPlan(f, [task('a')]);
    const worker = openTask(f, lead.id, 'a');
    await settle(f, worker);
    await f.restart();
    if (launch === 'start') patch(f, worker.id, { native_id: undefined });
    const failedLaunch = vi
      .spyOn(f.adapter, launch)
      .mockRejectedValueOnce(new Error('Native launch failed before delivery'));
    const sent = vi.spyOn(f.adapter, 'send');
    writePlan(f, lead.id, [task('a', { goal: 'Export as JSON instead' })]);
    const queued = messageTask(f, lead.id, 'a', 'Go on with the export');

    await f.control.tick();
    expect(failedLaunch).toHaveBeenCalled();
    expect(sent).not.toHaveBeenCalled();
    expect(f.store.must<SessionTurn>('session_turns', queued.id).state).toBe('failed');
    expect(planOf(f, lead.id).contract_changed).toEqual([worker.id]);
    expect(current(f, worker.id).task?.generation ?? 1).toBe(1);

    await eventually(
      () => current(f, worker.id).task?.generation === 2,
      () => f.control.tick(),
    );
    await settle(f, worker);
    const delivered = f
      .turns(worker.id)
      .filter(
        (turn) => turn.state === 'completed' && turn.input.includes('The lead changed this task.'),
      );
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.input).toContain('Export as JSON instead');
    expect(current(f, worker.id).task?.generation).toBe(2);
    expect(planOf(f, lead.id).contract_changed).toEqual([]);
  },
);

it.each(['refuses', 'throws'] as const)(
  'keeps a changed contract pending when input delivery %s it',
  async (failure) => {
    const f = workbenchFixture();
    const lead = await leadWithPlan(f, [task('a')]);
    const worker = openTask(f, lead.id, 'a');
    await settle(f, worker);
    const send = vi.spyOn(f.adapter, 'send');
    if (failure === 'throws') send.mockRejectedValueOnce(new Error('Transport closed'));
    else
      send.mockImplementationOnce(async (_handle, turn) => ({
        turn_id: turn.turn_id,
        status: 'unsupported',
        reason: 'Input was not delivered',
      }));
    writePlan(f, lead.id, [task('a', { goal: 'Export as JSON instead' })]);
    const queued = messageTask(f, lead.id, 'a', 'Go on with the export');

    await f.control.tick();
    await eventually(
      () => f.store.must<SessionTurn>('session_turns', queued.id).state === 'failed',
    );
    expect(planOf(f, lead.id).contract_changed).toEqual([worker.id]);
    expect(current(f, worker.id).task?.generation ?? 1).toBe(1);

    await eventually(
      () => current(f, worker.id).task?.generation === 2,
      () => f.control.tick(),
    );
    await settle(f, worker);
    expect(current(f, worker.id).task?.generation).toBe(2);
    expect(planOf(f, lead.id).contract_changed).toEqual([]);
  },
);

it.each([
  { goal: 'Export as XML instead', generation: 3 },
  { goal: 'Export as JSON instead', generation: 4 },
])(
  'keeps contract generation $generation pending when an older delivery receipt arrives',
  async ({ goal, generation }) => {
    const f = workbenchFixture();
    const lead = await leadWithPlan(f, [task('a')]);
    const worker = openTask(f, lead.id, 'a');
    await settle(f, worker);
    const send = f.adapter.send.bind(f.adapter);
    vi.spyOn(f.adapter, 'send').mockImplementationOnce(async (handle, turn) => {
      writePlan(f, lead.id, [task('a', { goal: 'Export as XML instead' })]);
      if (generation === 4) writePlan(f, lead.id, [task('a', { goal })]);
      return send(handle, turn);
    });
    writePlan(f, lead.id, [task('a', { goal: 'Export as JSON instead' })]);
    messageTask(f, lead.id, 'a', 'Go on with the export');

    await f.control.tick();
    expect(planOf(f, lead.id).contract_changed).toEqual([worker.id]);
    expect(current(f, worker.id).task?.generation ?? 1).toBe(1);

    await eventually(
      () => current(f, worker.id).task?.generation === generation,
      () => f.control.tick(),
    );
    await settle(f, worker);
    expect(planOf(f, lead.id).contract_changed).toEqual([]);
    expect(f.turns(worker.id).at(-1)!.input).toContain(goal);
  },
);

it('confirms the new contract generation only with its delivery receipt and keeps early reports attributed', async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [task('a', { done_when: 'report' })]);
  const worker = openTask(f, lead.id, 'a');
  await settle(f, worker);
  let release!: () => void;
  const receipt = new Promise<void>((resolve) => (release = resolve));
  let reported = false;
  const send = f.adapter.send.bind(f.adapter);
  vi.spyOn(f.adapter, 'send').mockImplementationOnce(async (handle, turn) => {
    const accepted = await send(handle, turn);
    await f.call(
      'task.report',
      { project_id: f.project.id, kind: 'done', text: 'JSON export is ready' },
      null,
      sessionOf(f, worker.id, 'worker'),
    );
    reported = true;
    await receipt;
    return accepted;
  });
  writePlan(f, lead.id, [task('a', { done_when: 'report', goal: 'Export as JSON instead' })]);
  messageTask(f, lead.id, 'a', 'Continue with the new format');
  const ticking = f.control.tick();
  const accept = () =>
    f.call(
      'task.accept',
      { project_id: f.project.id, task_id: 'a', evidence: 'The JSON report meets the goal' },
      null,
      sessionOf(f, lead.id, 'lead'),
    );
  try {
    await eventually(() => reported);
    expect(current(f, worker.id).task?.generation ?? 1).toBe(1);
    expect(planOf(f, lead.id).contract_changed).toEqual([worker.id]);
    expect(taskReportGeneration({} as ControlContext, current(f, worker.id))).toBe(1);
    expect(() => accept()).toThrow(expect.objectContaining({ code: 'invalid_state' }));
  } finally {
    release();
  }
  await ticking;
  expect(current(f, worker.id).task?.generation).toBe(2);
  expect(planOf(f, lead.id).contract_changed).toEqual([]);
  expect(accept()).toMatchObject({ id: 'a', state: 'done' });
});

it("refuses the lead's tools while its session is being discarded", async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const worker = openTask(f, lead.id, 'a');
  await settle(f, worker);

  patch(f, lead.id, {
    stop_requested: { reason: 'Discarded by the user', by: 'user', at: f.store.now() },
  });
  expect(() => messageTask(f, lead.id, 'a', 'Go on with the export')).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
  expect(f.turns(worker.id).some((turn) => turn.origin === 'lead')).toBe(false);
});

it('leaves the changed contract of a running task session for its next message', async () => {
  const f = workbenchFixture({ delay: 400 });
  const lead = await leadWithPlan(f, [task('a')]);
  const worker = openTask(f, lead.id, 'a');
  await awaitWorkspaceReady(f.control, worker.workspace_id!);
  await eventually(
    () => f.turns(worker.id).some((turn) => turn.state === 'running'),
    () => f.control.tick(),
  );

  writePlan(f, lead.id, [task('a', { acceptance: ['pnpm exec vitest run tests/export.test.ts'] })]);
  await f.control.tick();
  expect(f.turns(worker.id)).toHaveLength(1);
  expect(planOf(f, lead.id).contract_changed).toEqual([worker.id]);
});

it("keeps a running task session on its old contract when the lead's message waits behind its turn", async () => {
  const f = workbenchFixture({ delay: 400 });
  const lead = await leadWithPlan(f, [task('a', { done_when: 'report' })]);
  const worker = openTask(f, lead.id, 'a');
  await awaitWorkspaceReady(f.control, worker.workspace_id!);
  await eventually(
    () => f.turns(worker.id).some((turn) => turn.state === 'running'),
    () => f.control.tick(),
  );

  writePlan(f, lead.id, [task('a', { done_when: 'report', goal: 'Export as JSON instead' })]);
  const turn = messageTask(f, lead.id, 'a', 'Go on with the export');
  expect(turn).toMatchObject({ state: 'queued', input: '[Lead] Go on with the export' });
  expect(current(f, worker.id).task?.generation ?? 1).toBe(1);
  expect(planOf(f, lead.id).contract_changed).toEqual([worker.id]);

  await f.call(
    'task.report',
    { project_id: f.project.id, kind: 'done', text: 'CSV export works' },
    null,
    sessionOf(f, worker.id, 'worker'),
  );
  expect(f.turns(worker.id)[0]!.state).toBe('running');
  expect(() =>
    f.call(
      'task.accept',
      { project_id: f.project.id, task_id: 'a', evidence: 'CSV export works' },
      null,
      sessionOf(f, lead.id, 'lead'),
    ),
  ).toThrow(expect.objectContaining({ code: 'invalid_state' }));

  await settle(f, worker);
  await f.control.tick();
  await settle(f, worker);
  const told = f
    .turns(worker.id)
    .filter((row) => row.input.includes('The lead changed this task.'));
  expect(told).toHaveLength(1);
  expect(told[0]!.input).toContain('Export as JSON instead');
  expect(current(f, worker.id).task?.generation).toBe(2);
  expect(planOf(f, lead.id).contract_changed).toEqual([]);
});
