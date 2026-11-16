import { expect, it, vi } from 'vitest';
import type {
  BoardPlan,
  Principal,
  Session,
  SessionTurn,
  Usage,
  WorkflowPolicy,
} from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, settle, user } from '../helpers.js';
import { dispatchEveryTier, workbenchFixture } from './workbench-fixture.js';

type Fixture = ReturnType<typeof workbenchFixture>;
type PlanTask = BoardPlan['tasks'][number];

const sessionOf = (f: Fixture, sessionId: string, role: 'lead' | 'worker'): Principal => ({
  id: `session:${sessionId}`,
  role,
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});

const task = (id: string): PlanTask => ({
  id,
  title: `Task ${id}`,
  goal: `Finish task ${id}`,
  lane: 'core',
  depends_on: [],
  source: ['Plan the export feature'],
  scope: [`src/${id}`],
  acceptance: ['pnpm test'],
});

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const planOf = (f: Fixture, leadId: string) => f.store.must<BoardPlan>('board_plans', leadId);
const sessionsOf = (f: Fixture, leadId: string, taskId: string) =>
  f.store
    .list<Session>('sessions')
    .filter((session) => session.task?.lead_session_id === leadId && session.task.id === taskId);
const blockersOf = (f: Fixture, leadId: string, taskId: string) =>
  f.control.boardView(user, f.project.id, 1).tasks.find((row) => row.id === `${leadId}:${taskId}`)!
    .blockers;
const overBudgetItems = (f: Fixture) =>
  f.control
    .needsYou(user, f.project.id)
    .items.filter((item) => item.kind === 'project.over_budget');
const trackerTurns = (f: Fixture, leadId: string) =>
  f.turns(leadId).filter((turn) => turn.origin === 'tracker');
const WRAP_UP =
  'The project has used its input-token budget. Wrap up now: commit the work that is done, say in your report or reply what remains, and end your turn. Pantheon opens no new sessions until the user raises the budget.';
const wrapUps = (f: Fixture, sessionId: string) =>
  f.turns(sessionId).filter((turn) => turn.input === WRAP_UP);
const wrapUpEvents = (f: Fixture) =>
  f.store
    .events(0, f.project.id, 10000)
    .filter((event) => event.kind === 'project.budget_wrap_up')
    .map((event) => event.payload);
const close = (f: Fixture, sessionId: string, outcome: Session['outcome']) =>
  f.store.update<Session>(
    'sessions',
    { ...current(f, sessionId), state: 'closed', outcome },
    current(f, sessionId).revision,
  );

async function leadWithPlan(f: Fixture, tasks: PlanTask[]) {
  dispatchEveryTier(f);
  const lead = f.create('Plan the export feature');
  await settle(f, lead);
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks,
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    sessionOf(f, lead.id, 'lead'),
  );
  return lead;
}

const startTasks = (f: Fixture, leadId: string, taskIds: string[]) =>
  f.call(
    'task.start',
    { project_id: f.project.id, task_ids: taskIds },
    null,
    sessionOf(f, leadId, 'lead'),
  );

const setBudget = (f: Fixture, inputTokens: number | null) =>
  f.call<WorkflowPolicy>(
    'workflow.policy.set',
    {
      project_id: f.project.id,
      project_budget: inputTokens === null ? null : { input_tokens: inputTokens },
    },
    f.store.get<WorkflowPolicy>('workflow_policies', f.project.id)?.revision ?? null,
  );

/** Sets the usage of the session's latest turn, as its runtime would have reported it. */
function spend(f: Fixture, sessionId: string, usage: Partial<Usage>) {
  const turn = f.turns(sessionId).at(-1)!;
  f.store.update<SessionTurn>(
    'session_turns',
    { ...turn, usage: { input_tokens: 0, output_tokens: 0, ...usage } },
    turn.revision,
  );
}

/** Runs the store clock ahead of the wall clock; returns how to move it further. */
function skewedClock(f: Fixture) {
  let skew = 0;
  vi.spyOn(f.store, 'now').mockImplementation(() => Date.now() + skew);
  return (ms: number) => {
    skew += ms;
  };
}

/** A project whose budget of 100 input tokens a task session's ended turn spent with 150; task b waits. */
async function overspent(f: Fixture) {
  const lead = await leadWithPlan(f, [task('a'), task('b')]);
  const advance = skewedClock(f);
  advance(1000);
  setBudget(f, 100);
  advance(1000);
  startTasks(f, lead.id, ['a']);
  await f.control.tick();
  const [worker] = sessionsOf(f, lead.id, 'a');
  await settle(f, worker!);
  spend(f, worker!.id, { input_tokens: 150 });
  await settle(f, current(f, lead.id));
  startTasks(f, lead.id, ['b']);
  await f.control.tick();
  return { lead, worker: worker!, advance };
}

it('dispatches and lists no budget item without a project budget, however much was spent', async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  spend(f, lead.id, { input_tokens: 10_000_000 });
  startTasks(f, lead.id, ['a']);
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'a')).toHaveLength(1);
  expect(f.control.workflowPolicy(user, f.project.id).project_budget).toBeUndefined();
  expect(overBudgetItems(f)).toEqual([]);
});

it('opens no task session, keeps the lead asleep and lists the project once its ended turns spend the budget', async () => {
  const f = workbenchFixture();
  const { lead, worker } = await overspent(f);
  expect(sessionsOf(f, lead.id, 'b')).toEqual([]);
  expect(blockersOf(f, lead.id, 'b')).toContain('Queued: project over budget');

  const wakes = trackerTurns(f, lead.id).length;
  f.call(
    'task.report',
    { project_id: f.project.id, kind: 'requirement', text: 'Exports need a size limit' },
    null,
    sessionOf(f, worker.id, 'worker'),
  );
  await f.control.tick();
  await f.control.tick();
  expect(trackerTurns(f, lead.id)).toHaveLength(wakes);
  expect(planOf(f, lead.id).inbox.map((note) => note.text)).toContain('Exports need a size limit');

  const policy = f.store.must<WorkflowPolicy>('workflow_policies', f.project.id);
  expect(overBudgetItems(f)).toEqual([
    {
      source: { table: 'workflow_policies', id: f.project.id, revision: policy.revision },
      kind: 'project.over_budget',
      project_id: f.project.id,
      status: 'over_budget',
      created_at: expect.any(Number),
      reason: 'project_over_budget',
      actions: [{ command: 'workflow.policy.set', allowed: true }],
      project_budget: { used_input_tokens: 150, input_tokens: 100 },
      next_step: expect.stringContaining('150'),
    },
  ]);
});

it('takes the user message to an over-budget lead', async () => {
  const f = workbenchFixture();
  const { lead } = await overspent(f);
  await settle(f, current(f, lead.id));
  const turns = f.turns(lead.id).length;
  f.call(
    'session.send',
    { session_id: lead.id, input: 'Go on anyway' },
    current(f, lead.id).revision,
  );
  expect(f.turns(lead.id)).toHaveLength(turns + 1);
});

it('dispatches again and wakes the lead once when the budget rises above what was spent', async () => {
  const f = workbenchFixture();
  const { lead, worker } = await overspent(f);
  f.call(
    'task.report',
    { project_id: f.project.id, kind: 'requirement', text: 'Exports need a size limit' },
    null,
    sessionOf(f, worker.id, 'worker'),
  );
  const wakes = trackerTurns(f, lead.id).length;

  // Raising the budget keeps the time it was set, so what was spent still counts.
  setBudget(f, 120);
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'b')).toEqual([]);
  expect(trackerTurns(f, lead.id)).toHaveLength(wakes);

  setBudget(f, 1000);
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'b')).toHaveLength(1);
  expect(trackerTurns(f, lead.id)).toHaveLength(wakes + 1);
  expect(trackerTurns(f, lead.id).at(-1)!.input).toContain('Exports need a size limit');
  expect(overBudgetItems(f)).toEqual([]);
});

it('lets a turn that goes over the budget while it runs end as usual, and counts it once it ended', async () => {
  const f = workbenchFixture({ delay: 1500 });
  const lead = await leadWithPlan(f, [task('a'), task('b'), task('c')]);
  const advance = skewedClock(f);
  advance(1000);
  setBudget(f, 100);
  advance(1000);
  startTasks(f, lead.id, ['a']);
  await f.control.tick();
  const [worker] = sessionsOf(f, lead.id, 'a');
  await awaitWorkspaceReady(f.control, worker!.workspace_id!);
  await eventually(
    () => f.turns(worker!.id)[0]?.state === 'running',
    () => f.control.tick(),
  );
  spend(f, worker!.id, { input_tokens: 500 });
  startTasks(f, lead.id, ['b']);
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'b')).toHaveLength(1);
  expect(overBudgetItems(f)).toEqual([]);

  await settle(f, worker!);
  expect(f.turns(worker!.id)[0]!.state).toBe('completed');
  startTasks(f, lead.id, ['c']);
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'c')).toEqual([]);
  expect(overBudgetItems(f)[0]!.project_budget).toEqual({
    used_input_tokens: 500,
    input_tokens: 100,
  });
});

it('counts neither the turns that ended before the budget was set nor those that reported no tokens', async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [task('a'), task('b')]);
  const advance = skewedClock(f);
  spend(f, lead.id, { input_tokens: 5000 });
  advance(1000);
  expect(setBudget(f, 100).project_budget).toEqual({
    input_tokens: 100,
    since: expect.any(Number),
  });
  advance(1000);
  startTasks(f, lead.id, ['a']);
  await f.control.tick();
  const [worker] = sessionsOf(f, lead.id, 'a');
  await settle(f, worker!);
  spend(f, worker!.id, { input_tokens: 5000, tokens_unreported: true });
  startTasks(f, lead.id, ['b']);
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'b')).toHaveLength(1);
  expect(overBudgetItems(f)).toEqual([]);
  expect(setBudget(f, null).project_budget).toBeUndefined();
});

it('tells each lead and unfinished task session to wrap up once when the project goes over its budget', async () => {
  const f = workbenchFixture({ delay: 1500 });
  const lead = await leadWithPlan(f, [task('a'), task('b')]);
  const own = f.create('Look at the answer file');
  await settle(f, own);
  const advance = skewedClock(f);
  advance(1000);
  setBudget(f, 100);
  advance(1000);
  startTasks(f, lead.id, ['a', 'b']);
  await f.control.tick();
  const [idle] = sessionsOf(f, lead.id, 'a');
  const [busy] = sessionsOf(f, lead.id, 'b');
  await settle(f, idle!);
  await settle(f, current(f, busy!.id));
  await settle(f, current(f, lead.id));
  const running = f.call<SessionTurn>(
    'session.send',
    { session_id: busy!.id, input: 'Check the export again' },
    current(f, busy!.id).revision,
  );
  await eventually(
    () => f.store.must<SessionTurn>('session_turns', running.id).state === 'running',
    () => f.control.tick(),
  );
  const idleTurns = f.turns(idle!.id).length,
    leadTurns = f.turns(lead.id).length,
    ownTurns = f.turns(own.id).length;

  spend(f, idle!.id, { input_tokens: 150 });
  await f.control.tick();
  expect(f.turns(idle!.id)).toHaveLength(idleTurns + 1);
  expect(f.turns(idle!.id).at(-1)).toMatchObject({ input: WRAP_UP, kind: 'send' });
  expect(wrapUps(f, busy!.id)).toEqual([expect.objectContaining({ kind: 'steer' })]);
  expect(f.store.must<SessionTurn>('session_turns', running.id).state).toBe('running');
  expect(f.turns(lead.id)).toHaveLength(leadTurns + 1);
  expect(f.turns(lead.id).at(-1)!.input).toBe(WRAP_UP);
  expect(f.turns(own.id)).toHaveLength(ownTurns);
  expect(wrapUpEvents(f)).toEqual([
    expect.objectContaining({
      since: expect.any(Number),
      input_tokens: 100,
      session_ids: expect.arrayContaining([lead.id, idle!.id, busy!.id]),
    }),
  ]);

  await settle(f, current(f, lead.id));
  await f.control.tick();
  await f.control.tick();
  for (const session of [lead, idle!, busy!]) expect(wrapUps(f, session.id)).toHaveLength(1);
  expect(wrapUps(f, own.id)).toEqual([]);
  expect(wrapUpEvents(f)).toHaveLength(1);
});

it('tells the sessions to wrap up again when the project goes over a raised budget', async () => {
  const f = workbenchFixture();
  const { lead, worker } = await overspent(f);
  await settle(f, current(f, worker.id));
  expect(wrapUps(f, lead.id)).toHaveLength(1);
  expect(wrapUps(f, worker.id)).toHaveLength(1);

  setBudget(f, 1000);
  await f.control.tick();
  await settle(f, current(f, lead.id));
  await settle(f, current(f, worker.id));
  expect(wrapUps(f, lead.id)).toHaveLength(1);
  expect(wrapUps(f, worker.id)).toHaveLength(1);

  spend(f, worker.id, { input_tokens: 2000 });
  await f.control.tick();
  expect(wrapUps(f, lead.id)).toHaveLength(2);
  expect(wrapUps(f, worker.id)).toHaveLength(2);
  expect(wrapUpEvents(f)).toHaveLength(2);
});

it('tells no session to wrap up without a budget or under it', async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  spend(f, lead.id, { input_tokens: 10_000_000 });
  startTasks(f, lead.id, ['a']);
  await f.control.tick();
  const [worker] = sessionsOf(f, lead.id, 'a');
  await settle(f, worker!);
  const advance = skewedClock(f);
  advance(1000);
  setBudget(f, 100);
  advance(1000);
  await f.control.tick();
  expect(wrapUps(f, lead.id)).toEqual([]);
  expect(wrapUps(f, worker!.id)).toEqual([]);
  expect(wrapUpEvents(f)).toEqual([]);

  f.call(
    'session.send',
    { session_id: worker!.id, input: 'Check the export again' },
    current(f, worker!.id).revision,
  );
  await settle(f, current(f, worker!.id));
  spend(f, worker!.id, { input_tokens: 150 });
  await f.control.tick();
  expect(wrapUps(f, lead.id)).toHaveLength(1);
});

it('tells no merged or discarded task session to wrap up', async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [task('a'), task('b'), task('c')]);
  const advance = skewedClock(f);
  advance(1000);
  setBudget(f, 100);
  advance(1000);
  startTasks(f, lead.id, ['a', 'b', 'c']);
  await f.control.tick();
  const [merged] = sessionsOf(f, lead.id, 'a');
  const [discarded] = sessionsOf(f, lead.id, 'b');
  const [open] = sessionsOf(f, lead.id, 'c');
  for (const session of [merged!, discarded!, open!]) await settle(f, current(f, session.id));
  await settle(f, current(f, lead.id));
  close(f, merged!.id, 'merged');
  close(f, discarded!.id, 'discarded');

  spend(f, open!.id, { input_tokens: 150 });
  await f.control.tick();
  expect(wrapUps(f, open!.id)).toHaveLength(1);
  expect(wrapUps(f, lead.id)).toHaveLength(1);
  expect(wrapUps(f, merged!.id)).toEqual([]);
  expect(wrapUps(f, discarded!.id)).toEqual([]);
});
