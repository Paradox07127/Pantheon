import { expect, it } from 'vitest';
import type { BoardPlan, LeadNote, Principal, Session } from '@pantheon/domain';
import { planViews } from '../../packages/control/dist/board-plan.js';
import { effectiveDepth } from '../../packages/control/dist/lane-stops.js';
import { settle, user } from '../helpers.js';
import { dispatchEveryTier, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
type PlanTask = BoardPlan['tasks'][number];
type PlanLane = BoardPlan['lanes'][number];

const REQUEST = 'Plan the export feature';

const task = (id: string, tier: 't1' | 't3'): PlanTask => ({
  id,
  title: `Task ${id}`,
  goal: `Finish task ${id}`,
  lane: 'core',
  depends_on: [],
  source: [REQUEST],
  scope: [`src/${id}`],
  acceptance: ['pnpm test'],
  kind: { domain: 'backend-logic', tier },
});

const leadOf = (f: Fixture, leadId: string): Principal => ({
  id: `session:${leadId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: leadId,
  expires_at: f.store.now() + 60000,
});

function failure(fn: () => unknown): { code?: string } {
  try {
    fn();
  } catch (error) {
    return error as { code?: string };
  }
  throw new Error('Expected the command to fail');
}

const planOf = (f: Fixture, leadId: string) => f.store.must<BoardPlan>('board_plans', leadId);

function writePlan(
  f: Fixture,
  leadId: string,
  tasks: PlanTask[],
  lane: PlanLane = { id: 'core', title: 'Core' },
) {
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: f.store.get<BoardPlan>('board_plans', leadId)?.plan_version ?? 0,
      headline: 'Export ships this week',
      lanes: [lane],
      tasks,
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    leadOf(f, leadId),
  );
}

const start = (f: Fixture, leadId: string, taskIds: string[]) =>
  f.call('task.start', { project_id: f.project.id, task_ids: taskIds }, null, leadOf(f, leadId));

const setDepth = (f: Fixture, leadId: string, depth: string, principal: Principal = user) =>
  f.call(
    'board.lane.depth.set',
    { project_id: f.project.id, lead_session_id: leadId, lane_id: 'core', depth },
    null,
    principal,
  );

const sessionsOf = (f: Fixture, leadId: string, taskId: string) =>
  f.store
    .list<Session>('sessions')
    .filter((session) => session.task?.lead_session_id === leadId && session.task.id === taskId);

const waitOf = (f: Fixture, leadId: string, taskId: string) =>
  planViews(f.control['ctx'], f.project.id)
    .find((view) => view.lead_session_id === leadId)!
    .tasks.find((row) => row.id === taskId)!.dispatch_wait;

const depthNotes = (f: Fixture) =>
  f.store
    .kindEvents(f.project.id, ['lead.note_added'])
    .map((event) => event.payload as LeadNote)
    .filter((note) => note.kind === 'user_edit' && note.text.includes('depth of lane core'));

async function setup() {
  const f = await workbenchFixture();
  dispatchEveryTier(f);
  // No runtime reviews the plan, so only the user's approval holds a high-risk task.
  f.adapter.report.capabilities.read_isolation = { status: 'unsupported', evidence: 'Not here' };
  const lead = await f.create(REQUEST);
  await settle(f, lead);
  return { f, lead };
}

it('opens the queued task of a held lane the user sets to just do, with one override event', async () => {
  const { f, lead } = await setup();
  writePlan(f, lead.id, [task('risky', 't3')]);
  start(f, lead.id, ['risky']);
  await f.control.tick();
  expect(waitOf(f, lead.id, 'risky')).toBe('plan_approval');
  setDepth(f, lead.id, 'just_do');
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'risky')).toHaveLength(1);
  expect(
    f.store.kindEvents(f.project.id, ['board.lane_depth_overridden']).map((event) => event.payload),
  ).toEqual([{ lane_id: 'core', from: 'plan_first', to: 'just_do' }]);
});

it('holds the unopened tasks of a just-do lane the user sets to plan first and leaves a running one running', async () => {
  const { f, lead } = await setup();
  writePlan(f, lead.id, [task('running', 't1'), task('waiting', 't1')], {
    id: 'core',
    title: 'Core',
    depth: 'just_do',
    depth_reason: 'Two small fixes the gates can check.',
  });
  start(f, lead.id, ['running']);
  await f.control.tick();
  const [running] = sessionsOf(f, lead.id, 'running');
  expect(running).toBeDefined();
  setDepth(f, lead.id, 'plan_first');
  start(f, lead.id, ['waiting']);
  await f.control.tick();
  expect(waitOf(f, lead.id, 'waiting')).toBe('plan_approval');
  expect(sessionsOf(f, lead.id, 'waiting')).toEqual([]);
  expect(f.store.must<Session>('sessions', running!.id).state).toBe(running!.state);
});

it("keeps the user's depth as the lane's depth through the lead's next whole plan", async () => {
  const { f, lead } = await setup();
  writePlan(f, lead.id, [task('small', 't1')], { id: 'core', title: 'Core', depth: 'just_do' });
  setDepth(f, lead.id, 'spec_first');
  writePlan(f, lead.id, [task('small', 't1')], { id: 'core', title: 'Core', depth: 'plan_first' });
  const plan = planOf(f, lead.id);
  expect(effectiveDepth(plan, plan.lanes[0]!)).toBe('spec_first');
});

it('leaves the lead one note naming the new depth', async () => {
  const { f, lead } = await setup();
  writePlan(f, lead.id, [task('small', 't1')], { id: 'core', title: 'Core', depth: 'just_do' });
  setDepth(f, lead.id, 'plan_first');
  expect(depthNotes(f)).toHaveLength(1);
  expect(depthNotes(f)[0]!.text).toContain('plan_first');
});

it.each([
  ['a lead', (f: Fixture, leadId: string) => leadOf(f, leadId)],
  ['a personal agent', () => ({ id: 'personal:k1', role: 'personal' }) as Principal],
])("refuses %s setting a lane's depth", async (_who, principal) => {
  const { f, lead } = await setup();
  writePlan(f, lead.id, [task('small', 't1')]);
  expect(failure(() => setDepth(f, lead.id, 'plan_first', principal(f, lead.id)))).toMatchObject({
    code: 'permission_denied',
  });
});
