import { expect, it, vi } from 'vitest';
import type { BoardPlan, HarnessAdapter, Principal, Session, SessionTurn } from '@pantheon/domain';
import { eventually, settle } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = ReturnType<typeof workbenchFixture>;
type PlanTask = BoardPlan['tasks'][number];

const leadOf = (f: Fixture, sessionId: string): Principal => ({
  id: `session:${sessionId}`,
  role: 'lead',
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
  scope: [`src/${id}.ts`],
  acceptance: ['pnpm test'],
  kind: { domain: 'backend-logic', tier: 't1' },
});

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);

const updatePlan = (f: Fixture, leadId: string, tasks: PlanTask[]) =>
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

/** Declares whether the fixture runtime can change a running turn's write access. */
const turnWriteUnlock = (f: Fixture, status: 'supported' | 'unsupported') => {
  f.adapter.report.capabilities.turn_write_unlock = {
    status,
    evidence: 'Declared by the test',
  };
};

/** A lead that claimed direct task a and runs a writable turn on it. */
async function writingLead(f: Fixture) {
  const lead = f.create('Plan the export feature');
  await settle(f, lead);
  updatePlan(f, lead.id, [task('a'), task('b')]);
  f.call('task.start', { project_id: f.project.id, task_ids: ['a'] }, null, leadOf(f, lead.id));
  const turn = f.call<SessionTurn>(
    'session.send',
    { session_id: lead.id, input: `fixture-script\n${JSON.stringify([{ wait: 2000 }])}` },
    current(f, lead.id).revision,
  );
  await eventually(
    () => f.turns(lead.id).find((each) => each.id === turn.id)?.state === 'running',
    () => f.control.tick(),
  );
  expect(f.turns(lead.id).find((each) => each.id === turn.id)!.read_only).toBeUndefined();
  return lead;
}

const stopTask = (f: Fixture, leadId: string) =>
  f.call(
    'task.stop',
    { project_id: f.project.id, task_id: 'a', reason: 'The lead gives the task up' },
    null,
    leadOf(f, leadId),
  );

it('interrupts the writable lead turn whose direct task is stopped when the runtime cannot take write access back', async () => {
  const f = workbenchFixture();
  turnWriteUnlock(f, 'unsupported');
  const interrupt = vi.spyOn(f.adapter, 'interrupt');
  const lead = await writingLead(f);

  stopTask(f, lead.id);
  await settle(f, lead);

  expect(interrupt).toHaveBeenCalledOnce();
});

it('interrupts the writable lead turn whose direct task leaves the plan when the runtime cannot take write access back', async () => {
  const f = workbenchFixture();
  turnWriteUnlock(f, 'unsupported');
  const interrupt = vi.spyOn(f.adapter, 'interrupt');
  const lead = await writingLead(f);

  updatePlan(f, lead.id, [task('b')]);
  await settle(f, lead);

  expect(current(f, lead.id).direct_task).toBeUndefined();
  expect(interrupt).toHaveBeenCalledOnce();
});

it('continues the lead read-only after interrupting its writable turn for a stopped direct task', async () => {
  const f = workbenchFixture();
  turnWriteUnlock(f, 'unsupported');
  const lead = await writingLead(f);
  const before = f.turns(lead.id).length;

  stopTask(f, lead.id);
  await settle(f, lead);

  expect(f.turns(lead.id).slice(before)).toEqual([
    expect.objectContaining({ origin: 'tracker', state: 'completed', read_only: true }),
  ]);
});

it('only makes the lead turn read-only when the runtime can take write access back', async () => {
  const f = workbenchFixture();
  turnWriteUnlock(f, 'supported');
  const interrupt = vi.spyOn(f.adapter, 'interrupt');
  const setTurnReadOnly = vi.fn();
  (f.adapter as HarnessAdapter).setTurnReadOnly = setTurnReadOnly;
  const lead = await writingLead(f);

  stopTask(f, lead.id);
  await settle(f, lead);

  expect(setTurnReadOnly).toHaveBeenLastCalledWith(expect.anything(), true);
  expect(interrupt).not.toHaveBeenCalled();
});
