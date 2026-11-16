import { expect, it } from 'vitest';
import type { BoardPlan, LeadNote, Principal, Session } from '@pantheon/domain';
import { eventually, settle, user } from '../helpers.js';
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

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const sessionsOf = (f: Fixture, leadId: string, taskId: string) =>
  f.store
    .list<Session>('sessions')
    .filter((session) => session.task?.lead_session_id === leadId && session.task.id === taskId);

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

const startTasks = (f: Fixture, leadId: string, taskIds: string[]) =>
  f.call('task.start', { project_id: f.project.id, task_ids: taskIds }, null, leadOf(f, leadId));

async function leadWithPlan(f: Fixture, tasks: PlanTask[]) {
  const lead = f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id, tasks);
  return lead;
}

/** Every note the lead was given about the task, read or not. */
const notesOn = (f: Fixture, leadId: string, taskId: string) =>
  f.store
    .kindEvents(f.project.id, ['lead.note_added'])
    .filter((event) => event.aggregate_id === leadId)
    .map((event) => event.payload as LeadNote)
    .filter((note) => note.task_id === taskId);

it('tells the lead when a downstream task waits on an upstream task that was never started', async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [reportTask('a'), reportTask('b', { depends_on: ['a'] })]);
  startTasks(f, lead.id, ['b']);
  await f.control.tick();
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'b')).toEqual([]);
  const notes = notesOn(f, lead.id, 'b');
  expect(notes).toEqual([
    expect.objectContaining({ session_id: '', task_id: 'b', kind: 'blocked' }),
  ]);
  expect(notes[0]!.text).toContain('upstream task a');
  expect(notes[0]!.text).toContain('never started');
  expect(waitingOnUpstream(f)).toMatchObject([
    { task_id: `${lead.id}:b`, upstream: { task_id: `${lead.id}:a`, stuck: 'never_started' } },
  ]);
});

it('tells the lead once when the upstream session of a queued task was discarded', async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [reportTask('a'), reportTask('b', { depends_on: ['a'] })]);
  startTasks(f, lead.id, ['a', 'b']);
  await f.control.tick();
  const [upstream] = sessionsOf(f, lead.id, 'a');
  await settle(f, upstream!);
  expect(notesOn(f, lead.id, 'b')).toEqual([]);

  f.call('session.discard', { session_id: upstream!.id }, current(f, upstream!.id).revision);
  await eventually(() => current(f, upstream!.id).outcome === 'discarded');
  await f.control.tick();
  await f.control.tick();
  await f.control.tick();
  const notes = notesOn(f, lead.id, 'b');
  expect(notes).toEqual([expect.objectContaining({ task_id: 'b', kind: 'blocked' })]);
  expect(notes[0]!.text).toContain('upstream task a');
  expect(notes[0]!.text).toContain(upstream!.id);
  expect(sessionsOf(f, lead.id, 'b')).toEqual([]);
});

const mergedTask = reportTask('a', {
  done_when: 'merged',
  scope: ['src/export'],
  acceptance: ['pnpm test'],
});

/** The needs-you items of queued tasks that wait for an upstream task nobody moves. */
const waitingOnUpstream = (f: Fixture) =>
  f.control
    .needsYou(user, f.project.id)
    .items.filter((item) => item.reason === 'task_upstream_stuck');

it('tells the lead and lists needs-you while the merge of an upstream session stays blocked', async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [mergedTask, reportTask('b', { depends_on: ['a'] })]);
  startTasks(f, lead.id, ['a', 'b']);
  await f.control.tick();
  const [upstream] = sessionsOf(f, lead.id, 'a');
  await settle(f, upstream!);
  expect(waitingOnUpstream(f)).toEqual([]);

  const session = current(f, upstream!.id);
  f.store.update<Session>(
    'sessions',
    { ...session, merge: { state: 'blocked', reason: 'local_changes' } },
    session.revision,
  );
  await f.control.tick();
  await f.control.tick();
  const notes = notesOn(f, lead.id, 'b');
  expect(notes).toEqual([expect.objectContaining({ task_id: 'b', kind: 'blocked' })]);
  expect(notes[0]!.text).toContain('upstream task a');
  expect(notes[0]!.text).toContain(`${upstream!.id} is blocked: local_changes`);
  expect(waitingOnUpstream(f)).toMatchObject([
    {
      source: { table: 'board_plans', id: lead.id },
      kind: 'session.failed',
      session_id: lead.id,
      task_id: `${lead.id}:b`,
      status: 'queued',
      upstream: { task_id: `${lead.id}:a`, stuck: 'merge_blocked' },
      next_step: expect.any(String),
    },
  ]);
  expect(sessionsOf(f, lead.id, 'b')).toEqual([]);

  writePlan(f, lead.id, [mergedTask, reportTask('b')]);
  expect(waitingOnUpstream(f)).toEqual([]);
});

it('tells the lead and lists needs-you when the lead stopped the upstream task of a queued task', async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [reportTask('a'), reportTask('b', { depends_on: ['a'] })]);
  startTasks(f, lead.id, ['a', 'b']);
  await f.control.tick();
  const [upstream] = sessionsOf(f, lead.id, 'a');
  await settle(f, upstream!);

  f.call(
    'task.stop',
    { project_id: f.project.id, task_id: 'a', reason: 'The approach is wrong' },
    null,
    leadOf(f, lead.id),
  );
  await eventually(
    () => current(f, upstream!.id).outcome === 'discarded',
    () => f.control.tick(),
  );
  await f.control.tick();
  await f.control.tick();
  const notes = notesOn(f, lead.id, 'b');
  expect(notes).toEqual([expect.objectContaining({ task_id: 'b', kind: 'blocked' })]);
  expect(notes[0]!.text).toContain('upstream task a');
  expect(notes[0]!.text).toContain('was stopped by the lead: The approach is wrong');
  expect(notes[0]!.text).toContain('it has no new start request');
  expect(waitingOnUpstream(f)).toMatchObject([
    {
      task_id: `${lead.id}:b`,
      upstream: { task_id: `${lead.id}:a`, stuck: 'stopped' },
    },
  ]);

  startTasks(f, lead.id, ['a']);
  expect(waitingOnUpstream(f)).toEqual([]);
});

it('stops the session of a task that left the plan and tells the lead', async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [reportTask('a'), reportTask('b')]);
  startTasks(f, lead.id, ['a']);
  await f.control.tick();
  const [removed] = sessionsOf(f, lead.id, 'a');
  await settle(f, removed!);

  writePlan(f, lead.id, [reportTask('b')]);
  await eventually(
    () => current(f, removed!.id).outcome === 'discarded',
    () => f.control.tick(),
  );
  expect(current(f, removed!.id).stop_requested).toMatchObject({ by: 'lead' });
  await f.control.tick();
  const notes = notesOn(f, lead.id, 'a');
  expect(notes).toEqual([
    expect.objectContaining({ session_id: removed!.id, task_id: 'a', kind: 'discarded' }),
  ]);
  expect(notes[0]!.text).toContain('left the plan');
});
