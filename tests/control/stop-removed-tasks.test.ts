import { expect, it } from 'vitest';
import type { BoardPlan, Principal, Session } from '@pantheon/domain';
import { settle } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = ReturnType<typeof workbenchFixture>;
type PlanTask = BoardPlan['tasks'][number];

const leadOf = (f: Fixture, leadId: string): Principal => ({
  id: `session:${leadId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: leadId,
  expires_at: f.store.now() + 60000,
});

const reportTask = (id: string): PlanTask => ({
  id,
  title: `Task ${id}`,
  goal: `Finish task ${id}`,
  lane: 'core',
  depends_on: [],
  source: ['Plan the export feature'],
  scope: [],
  acceptance: [],
  done_when: 'report',
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
    leadOf(f, leadId),
  );
}

it('stops each removed task against the plan its earlier stop wrote', async () => {
  const f = workbenchFixture();
  const lead = f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id, [reportTask('a'), reportTask('b'), reportTask('c')]);
  f.call(
    'task.start',
    { project_id: f.project.id, task_ids: ['a', 'b'] },
    null,
    leadOf(f, lead.id),
  );
  await f.control.tick();
  const removed = f.store
    .list<Session>('sessions')
    .filter((session) => session.task?.lead_session_id === lead.id);
  expect(removed.map((session) => session.task!.id).sort()).toEqual(['a', 'b']);
  for (const session of removed) await settle(f, session);

  writePlan(f, lead.id, [reportTask('c')]);
  await f.control.tick();
  const stops = f.store
    .kindEvents(f.project.id, ['task.stop_requested'])
    .filter((event) => event.aggregate_id === lead.id);
  expect(stops.map((event) => (event.payload as { task_id: string }).task_id).sort()).toEqual([
    'a',
    'b',
  ]);
  // The first stop's note updates the plan, so the second stop names the newer revision.
  expect(stops[1]!.aggregate_revision).toBeGreaterThan(stops[0]!.aggregate_revision);
});
