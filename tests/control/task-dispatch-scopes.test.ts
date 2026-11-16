import { expect, it } from 'vitest';
import type { BoardPlan, Principal, Session } from '@pantheon/domain';
import { settle, user } from '../helpers.js';
import { dispatchEveryTier, workbenchFixture } from './workbench-fixture.js';

type Fixture = ReturnType<typeof workbenchFixture>;
type PlanTask = BoardPlan['tasks'][number];

const leadOf = (f: Fixture, leadId: string): Principal => ({
  id: `session:${leadId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: leadId,
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

const part = (name: string, scope: string) => ({
  title: `Part ${name}`,
  goal: `Write part ${name}`,
  scope: [scope],
  acceptance: ['true'],
});

const sessionsOf = (f: Fixture, leadId: string, taskId: string) =>
  f.store
    .list<Session>('sessions')
    .filter((session) => session.task?.lead_session_id === leadId && session.task.id === taskId);
const rowOf = (f: Fixture, leadId: string, taskId: string) =>
  f.control.boardView(user, f.project.id, 1).tasks.find((row) => row.id === `${leadId}:${taskId}`)!;

it('keeps a task waiting while a part of a parallel task holds a path outside the parent scope', async () => {
  const f = workbenchFixture();
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
      tasks: [
        task('a', {
          path: 'parallel',
          flow_reason: 'Two independent parts',
          parallel: [part('shared', 'src/shared'), part('own', 'src/a')],
        }),
        task('b', { scope: ['src/shared'] }),
      ],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    leadOf(f, lead.id),
  );
  f.call(
    'task.start',
    { project_id: f.project.id, task_ids: ['a', 'b'] },
    null,
    leadOf(f, lead.id),
  );
  expect(rowOf(f, lead.id, 'b').dispatch_wait).toBe('scope');
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'a')).toHaveLength(2);
  expect(sessionsOf(f, lead.id, 'b')).toEqual([]);
  expect(rowOf(f, lead.id, 'b').dispatch_wait).toBe('scope');
  for (const session of sessionsOf(f, lead.id, 'a')) await settle(f, session);
});
