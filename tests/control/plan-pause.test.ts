import { expect, it } from 'vitest';
import type { BoardPlan, BoardPlanView, Principal, Session } from '@pantheon/domain';
import { settle, user } from '../helpers.js';
import { dispatchEveryTier, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
type PlanTask = BoardPlan['tasks'][number];

const leadOf = (f: Fixture, leadId: string): Principal => ({
  id: `session:${leadId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: leadId,
  expires_at: f.store.now() + 60000,
});

const reportTask = (id: string, fields: Partial<PlanTask> = {}): PlanTask => ({
  id,
  title: `Task ${id}`,
  goal: `Finish task ${id}`,
  lane: 'core',
  depends_on: [],
  source: ['Plan the export feature'],
  scope: [],
  acceptance: [],
  done_when: 'report',
  ...fields,
});

const { done_when: _, ...mergeTask } = reportTask('direct', {
  scope: ['src/direct'],
  acceptance: ['pnpm test'],
});
const directTask: PlanTask = { ...mergeTask, path: 'direct', flow_reason: 'The lead handles it' };

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
    leadOf(f, leadId),
  );
}

async function leadWithPlan(f: Fixture, tasks: PlanTask[]) {
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id, tasks);
  return lead;
}

const startTasks = (f: Fixture, leadId: string, taskIds: string[]) =>
  f.call('task.start', { project_id: f.project.id, task_ids: taskIds }, null, leadOf(f, leadId));
const sessionsOf = (f: Fixture, leadId: string, taskId: string) =>
  f.store
    .list<Session>('sessions')
    .filter((session) => session.task?.lead_session_id === leadId && session.task.id === taskId);
const planOf = (f: Fixture, leadId: string) => f.store.must<BoardPlan>('board_plans', leadId);
const waitOf = (f: Fixture, leadId: string, taskId: string) =>
  f.control.boardView(user, f.project.id, 1).tasks.find((row) => row.id === `${leadId}:${taskId}`)
    ?.dispatch_wait;
const reassessmentItems = (f: Fixture) =>
  f.control
    .needsYou(user, f.project.id)
    .items.filter((item) => item.reason === 'plan_reassessment_ready');
const pause = (f: Fixture, leadId: string) =>
  f.call('board.plan.pause', { project_id: f.project.id, lead_session_id: leadId });
const resume = (f: Fixture, leadId: string) =>
  f.call('board.plan.resume', { project_id: f.project.id, lead_session_id: leadId });
const reassess = (f: Fixture, leadId: string) =>
  f.call(
    'board.plan.reassess',
    {
      project_id: f.project.id,
      done: 'The export runs',
      blocked: 'The import waits on a schema',
      change: 'Drop the CSV task',
    },
    null,
    leadOf(f, leadId),
  );

function failure(fn: () => unknown): { code?: string; message?: string } {
  try {
    fn();
  } catch (error) {
    return error as { code?: string; message?: string };
  }
  throw new Error('Expected the command to fail');
}

it('holds new task sessions of the paused plan only, and keeps its running ones', async () => {
  const f = await workbenchFixture();
  dispatchEveryTier(f);
  const paused = await leadWithPlan(f, [reportTask('active'), reportTask('queued')]);
  const other = await leadWithPlan(f, [reportTask('elsewhere')]);
  startTasks(f, paused.id, ['active']);
  await f.control.tick();
  const worker = sessionsOf(f, paused.id, 'active')[0]!;
  pause(f, paused.id);
  startTasks(f, paused.id, ['queued']);
  startTasks(f, other.id, ['elsewhere']);
  expect(waitOf(f, paused.id, 'queued')).toBe('paused');
  await f.control.tick();
  expect(sessionsOf(f, paused.id, 'queued')).toHaveLength(0);
  expect(sessionsOf(f, other.id, 'elsewhere')).toHaveLength(1);
  expect(f.store.must<Session>('sessions', worker.id).stop_requested).toBeUndefined();
  resume(f, paused.id);
  await f.control.tick();
  expect(sessionsOf(f, paused.id, 'queued')).toHaveLength(1);
  expect(planOf(f, paused.id).paused).toBeUndefined();
});

it('wakes the lead once with a note to write a re-assessment', async () => {
  const f = await workbenchFixture();
  dispatchEveryTier(f);
  const lead = await leadWithPlan(f, [reportTask('queued')]);
  const before = f.turns(lead.id).length;
  pause(f, lead.id);
  await settle(f, f.store.must<Session>('sessions', lead.id));
  expect(f.turns(lead.id)).toHaveLength(before + 1);
  expect(planOf(f, lead.id).paused).toMatchObject({ by: 'user' });
  expect(f.turns(lead.id).at(-1)!.input).toContain(
    'The user paused this plan: write a re-assessment with reassess',
  );
});

it('lists the re-assessment for the user until the plan resumes', async () => {
  const f = await workbenchFixture();
  dispatchEveryTier(f);
  const lead = await leadWithPlan(f, [reportTask('queued')]);
  expect(failure(() => reassess(f, lead.id)).code).toBe('invalid_state');
  pause(f, lead.id);
  expect(reassessmentItems(f)).toEqual([]);
  reassess(f, lead.id);
  expect(planOf(f, lead.id).reassessment).toMatchObject({
    done: 'The export runs',
    blocked: 'The import waits on a schema',
    change: 'Drop the CSV task',
  });
  expect(reassessmentItems(f)).toEqual([
    expect.objectContaining({
      kind: 'board.plan.reassessment',
      session_id: lead.id,
      reassessment: planOf(f, lead.id).reassessment,
      decision: 'plan_change',
      primary: 'board.plan.resume',
      actions: [{ command: 'board.plan.resume', allowed: true }],
    }),
  ]);
  resume(f, lead.id);
  expect(reassessmentItems(f)).toEqual([]);
});

it('keeps the pause through a plan write and refuses a direct claim', async () => {
  const f = await workbenchFixture();
  dispatchEveryTier(f);
  const lead = await leadWithPlan(f, [reportTask('queued'), directTask]);
  pause(f, lead.id);
  writePlan(f, lead.id, [reportTask('queued'), reportTask('added')]);
  expect(planOf(f, lead.id).paused).toBeDefined();
  writePlan(f, lead.id, [reportTask('queued'), directTask]);
  expect(failure(() => startTasks(f, lead.id, ['direct'])).message).toMatch(/paused/i);
});

it('shows the pause and the re-assessment on the plan view', async () => {
  const f = await workbenchFixture();
  dispatchEveryTier(f);
  const lead = await leadWithPlan(f, [reportTask('queued')]);
  const view = () =>
    f
      .call<{ plans: BoardPlanView[] }>(
        'project.read',
        { project_id: f.project.id },
        null,
        leadOf(f, lead.id),
      )
      .plans.find((plan) => plan.lead_session_id === lead.id)!;
  expect(view()).not.toHaveProperty('paused');
  const paused = pause(f, lead.id) as BoardPlanView;
  expect(paused.paused).toEqual({ at: planOf(f, lead.id).paused!.at });
  expect(paused).not.toHaveProperty('reassessment');
  reassess(f, lead.id);
  expect(view()).toMatchObject({
    paused: { at: planOf(f, lead.id).paused!.at },
    reassessment: planOf(f, lead.id).reassessment,
  });
  expect(resume(f, lead.id)).not.toHaveProperty('paused');
});
