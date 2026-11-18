import { afterEach, expect, it } from 'vitest';
import type { BoardPlan, Improvement, Principal, Retrospective, Session } from '@pantheon/domain';
import { prepareMemoryDelivery } from '../../packages/control/dist/memory.js';
import { eventually, fixture, settle } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type PlanTask = BoardPlan['tasks'][number];

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

/** A project whose lead plans four tasks, with sessions inserted directly. */
async function plannedProject(status: Improvement['status'] = 'trial') {
  const f = await fixture();
  fixtures.push(f);
  f.store.insert<Improvement>('improvements', {
    id: 'check-schema',
    revision: 1,
    project_id: f.project.id,
    source: 'lead',
    lead_session_id: 'lead',
    retrospective_ids: [],
    status,
    proposed_at: 1,
    trial_started_at: 1,
    change: { type: 'experience', procedure: 'Inspect the schema before changing storage' },
  });
  f.store.insert('board_plans', {
    id: 'lead',
    revision: 1,
    project_id: f.project.id,
    tasks: ['a', 'b', 'c', 'd'].map((id) => ({ id })),
  } as any);
  const ctx = (f.control as any).ctx;
  const open = (id: string, task?: Session['task']) => {
    const session = f.store.insert<Session>('sessions', {
      id,
      revision: 1,
      project_id: f.project.id,
      runtime: f.adapter.name,
      title: id,
      state: 'open',
      turn_count: 0,
      ...(task && { task }),
    });
    return prepareMemoryDelivery(ctx, session, `${id}-turn`);
  };
  const arms = () =>
    f.store
      .events(0, f.project.id, 1000, ['improvement.arm_assigned'])
      .map((event) => event.payload as { task_id: string; generation: number; arm: string });
  return { f, open, arms };
}

it('gives tasks started in order the arms new, old, new, old, and leaves the experience out of an old-arm packet', async () => {
  const { open, arms } = await plannedProject();
  const packets = ['a', 'b', 'c', 'd'].map((id) =>
    open(`session-${id}`, { lead_session_id: 'lead', id }),
  );
  expect(arms().map((a) => [a.task_id, a.arm])).toEqual([
    ['a', 'new'],
    ['b', 'old'],
    ['c', 'new'],
    ['d', 'old'],
  ]);
  expect(packets.map((packet) => packet?.experiences.map((e) => e.id) ?? [])).toEqual([
    ['check-schema'],
    [],
    ['check-schema'],
    [],
  ]);
});

it('keeps the arm for a second session of the task generation and gives a new generation the next arm', async () => {
  const { open, arms } = await plannedProject();
  open('first', { lead_session_id: 'lead', id: 'a' });
  open('second-of-a', { lead_session_id: 'lead', id: 'a' });
  const retried = open('a-again', { lead_session_id: 'lead', id: 'a', generation: 2 });
  expect(arms().map((a) => [a.task_id, a.generation, a.arm])).toEqual([
    ['a', 1, 'new'],
    ['a', 2, 'old'],
  ]);
  expect(retried?.experiences ?? []).toEqual([]);
});

it('still delivers a trial experience to the lead, which takes no arm', async () => {
  const { open, arms } = await plannedProject();
  open('first', { lead_session_id: 'lead', id: 'a' });
  const lead = open('lead');
  expect(lead!.experiences.map((e) => e.id)).toEqual(['check-schema']);
  expect(arms()).toHaveLength(1);
});

it('writes no arm event when no experience is on trial', async () => {
  const { open, arms } = await plannedProject('active');
  const packets = ['a', 'b'].map((id) => open(`session-${id}`, { lead_session_id: 'lead', id }));
  expect(packets.map((packet) => packet!.experiences.map((e) => e.id))).toEqual([
    ['check-schema'],
    ['check-schema'],
  ]);
  expect(arms()).toEqual([]);
});

const task = (id: string): PlanTask => ({
  id,
  title: `Task ${id}`,
  goal: `Finish task ${id}`,
  lane: 'core',
  depends_on: [],
  source: ['Plan the export feature'],
  scope: [`src/${id}`],
  acceptance: ['true'],
});

it('records the arm of each task in its retrospective and leaves an old-arm experience out of experience_ids', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  const leadPrincipal: Principal = {
    id: `session:${lead.id}`,
    role: 'lead',
    project_id: f.project.id,
    session_id: lead.id,
    expires_at: f.store.now() + 60000,
  };
  const writePlan = (tasks: PlanTask[]) =>
    f.call(
      'board.plan.update',
      {
        project_id: f.project.id,
        base_version: f.store.get<BoardPlan>('board_plans', lead.id)?.plan_version ?? 0,
        headline: 'Export ships this week',
        lanes: [{ id: 'core', title: 'Core' }],
        tasks,
        milestones: [],
        risks: [],
        assumptions: [],
      },
      null,
      leadPrincipal,
    );
  writePlan([task('a'), task('b'), task('c')]);
  const now = f.store.now();
  f.store.insert<Improvement>('improvements', {
    id: 'check-schema',
    revision: 1,
    project_id: f.project.id,
    source: 'lead',
    retrospective_ids: ['earlier-1', 'earlier-2'],
    status: 'trial',
    proposed_at: now - 60000,
    trial_started_at: now - 60000,
    change: { type: 'experience', procedure: 'Inspect the schema before changing storage' },
  });
  for (const id of ['a', 'b']) {
    f.call('task.start', { project_id: f.project.id, task_ids: [id] }, null, leadPrincipal);
    await f.control.tick();
    await settle(
      f,
      f.store
        .list<Session>('sessions')
        .find((session) => session.task?.lead_session_id === lead.id && session.task.id === id)!,
    );
  }
  writePlan([task('c')]);
  const recorded = () => f.store.list<Retrospective>('retrospectives');
  await eventually(
    () => ['a', 'b'].every((id) => recorded().some((row) => row.task_id === id)),
    () => f.control.tick(),
  );
  const row = (id: string) => recorded().find((r) => r.task_id === id)!;
  expect(row('a')).toMatchObject({
    trial_arms: { 'check-schema': 'new' },
    experience_ids: ['check-schema'],
  });
  expect(row('b')).toMatchObject({ trial_arms: { 'check-schema': 'old' }, experience_ids: [] });
});
