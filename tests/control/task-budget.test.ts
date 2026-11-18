import { expect, it, vi } from 'vitest';
import type { BoardPlan, Principal, Retrospective, Session, SessionTurn } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, settle, user } from '../helpers.js';
import { dispatchEveryTier, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
type PlanTask = BoardPlan['tasks'][number];

/** The default budget of a simple task dispatched to a task session. */
const SIMPLE_DISPATCH = { input_tokens: 1_120_000, wall_ms: 255_000 };

const sessionOf = (f: Fixture, sessionId: string, role: 'lead' | 'worker'): Principal => ({
  id: `session:${sessionId}`,
  role,
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});

const script = (...steps: object[]) => `fixture-script\n${JSON.stringify(steps)}`;

const task = (id: string, fields: Partial<PlanTask> = {}): PlanTask => ({
  id,
  title: `Task ${id}`,
  goal: `Finish task ${id}`,
  lane: 'core',
  depends_on: [],
  source: ['Plan the export feature'],
  scope: [`src/${id}.ts`],
  acceptance: ['true'],
  kind: { domain: 'backend-logic', tier: 't1' },
  ...fields,
});

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const rowOf = (f: Fixture, leadId: string, taskId: string) =>
  f.control.boardView(user, f.project.id, 1).tasks.find((row) => row.id === `${leadId}:${taskId}`)!;

async function leadWithPlan(f: Fixture, tasks: PlanTask[]) {
  dispatchEveryTier(f);
  const lead = await f.create('Plan the export feature');
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

/** Starts the task through its lead and returns its session once its workspace is ready. */
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

function setInputTokens(f: Fixture, turn: SessionTurn, inputTokens: number) {
  const stored = f.store.must<SessionTurn>('session_turns', turn.id);
  f.store.update<SessionTurn>(
    'session_turns',
    { ...stored, usage: { input_tokens: inputTokens, output_tokens: 10 } },
    stored.revision,
  );
}

it('shows the share of its budget a running task spent as its turns end', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const worker = await startTask(f, lead.id, 'a');
  await settle(f, worker);
  setInputTokens(f, f.turns(worker.id)[0]!, 560_000);

  expect(rowOf(f, lead.id, 'a').budget).toMatchObject({
    ratio: 0.5,
    input_tokens: 560_000,
    limit: SIMPLE_DISPATCH,
  });

  f.call(
    'task.message',
    { project_id: f.project.id, task_id: 'a', text: 'Add the export button' },
    null,
    sessionOf(f, lead.id, 'lead'),
  );
  await eventually(
    () => f.turns(worker.id).length === 2,
    () => f.control.tick(),
  );
  await settle(f, worker);
  setInputTokens(f, f.turns(worker.id)[1]!, 336_000);

  expect(rowOf(f, lead.id, 'a').budget).toMatchObject({ ratio: 0.8, input_tokens: 896_000 });
});

it('lets the wall time decide the ratio once it is the larger share', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const worker = await startTask(f, lead.id, 'a');
  await settle(f, worker);
  setInputTokens(f, f.turns(worker.id)[0]!, 560_000);
  const later = f.store.now() + 2 * SIMPLE_DISPATCH.wall_ms;
  vi.spyOn(f.store, 'now').mockReturnValue(later);

  const budget = rowOf(f, lead.id, 'a').budget!;
  expect(budget.wall_ms).toBeGreaterThanOrEqual(2 * SIMPLE_DISPATCH.wall_ms);
  expect(budget.ratio).toBe(budget.wall_ms / SIMPLE_DISPATCH.wall_ms);
});

it('shows no budget on a started task of a tier without one', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [
    task('a', { kind: { domain: 'backend-logic', tier: 't2' } }),
  ]);
  const worker = await startTask(f, lead.id, 'a');
  await settle(f, worker);
  setInputTokens(f, f.turns(worker.id)[0]!, 560_000);

  expect(rowOf(f, lead.id, 'a')).not.toHaveProperty('budget');
});

it('counts the tokens of a running turn only once it ends', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a', { goal: script({ hang: true }) })]);
  const worker = await startTask(f, lead.id, 'a');
  await eventually(
    () => f.turns(worker.id)[0]!.state === 'running',
    () => f.control.tick(),
  );
  setInputTokens(f, f.turns(worker.id)[0]!, 560_000);

  expect(rowOf(f, lead.id, 'a').budget).toMatchObject({ input_tokens: 0 });

  f.call<Session>('session.interrupt', { session_id: worker.id }, current(f, worker.id).revision);
  await settle(f, worker);
  setInputTokens(f, f.turns(worker.id)[0]!, 560_000);

  expect(rowOf(f, lead.id, 'a').budget).toMatchObject({ ratio: 0.5, input_tokens: 560_000 });
});

it('counts the wall time of a dispatched task from its plan write, ending at the recorded ratio', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const plannedAt = f.store
    .events(0, undefined, 100000)
    .find((event) => event.kind === 'board.plan_updated')!.created_at;
  const later = plannedAt + 2 * SIMPLE_DISPATCH.wall_ms;
  vi.spyOn(f.store, 'now').mockReturnValue(later);
  const worker = await startTask(f, lead.id, 'a');
  await settle(f, worker);
  setInputTokens(f, f.turns(worker.id)[0]!, 560_000);

  const live = rowOf(f, lead.id, 'a').budget!;
  expect(live.wall_ms).toBe(later - plannedAt);

  f.call(
    'task.stop',
    { project_id: f.project.id, task_id: 'a', reason: 'The approach changed' },
    null,
    sessionOf(f, lead.id, 'lead'),
  );
  await eventually(
    () => f.store.list<Retrospective>('retrospectives').some((row) => row.task_id === 'a'),
    () => f.control.tick(),
  );
  expect(rowOf(f, lead.id, 'a').retrospective?.budget_ratio).toBe(live.ratio);
});

it('shows the ratio its retrospective recorded on a finished task instead of a live one', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const worker = await startTask(f, lead.id, 'a');
  await settle(f, worker);
  setInputTokens(f, f.turns(worker.id)[0]!, 560_000);
  f.call(
    'task.stop',
    { project_id: f.project.id, task_id: 'a', reason: 'The approach changed' },
    null,
    sessionOf(f, lead.id, 'lead'),
  );
  await eventually(
    () => f.store.list<Retrospective>('retrospectives').some((row) => row.task_id === 'a'),
    () => f.control.tick(),
  );

  const row = rowOf(f, lead.id, 'a');
  expect(row.retrospective).toMatchObject({ outcome: 'failed', budget_ratio: 0.5 });
  expect(row).not.toHaveProperty('budget');
});
