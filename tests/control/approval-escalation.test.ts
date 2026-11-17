import { expect, it, vi } from 'vitest';
import type { Approval, BoardPlan, LeadNote, Principal, Session } from '@pantheon/domain';
import { eventually, settle, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
type PlanTask = BoardPlan['tasks'][number];

const MINUTE = 60_000;

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

const told = (f: Fixture, leadId: string) =>
  f.turns(leadId).filter((turn) => turn.origin === 'tracker');

/** The notes the tracker left the lead, of one kind, oldest first. */
const notes = (f: Fixture, leadId: string, kind: LeadNote['kind']) =>
  f.store
    .kindEvents(f.project.id, ['lead.note_added'])
    .filter((event) => event.aggregate_id === leadId)
    .map((event) => event.payload as LeadNote)
    .filter((note) => note.kind === kind);

async function leadWithPlan(f: Fixture, tasks: PlanTask[]) {
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

const openTask = (f: Fixture, leadId: string, taskId: string) =>
  f.call<Promise<Session>>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Build it',
    task_id: `${leadId}:${taskId}`,
  });

function permissionRequest(f: Fixture, id: string, sessionId: string): Approval {
  return {
    id,
    revision: 1,
    project_id: f.project.id,
    kind: 'permission',
    session_id: sessionId,
    request_id: id,
    tool: 'mcp__docs__search',
    input_hash: 'a'.repeat(64),
    decider: 'user',
    state: 'pending',
    created_at: f.store.now(),
  };
}

/** Runs the store clock ahead of the wall clock; returns how to move it further. */
function skewedClock(f: Fixture) {
  let skew = 0;
  vi.spyOn(f.store, 'now').mockImplementation(() => Date.now() + skew);
  return (ms: number) => {
    skew += ms;
  };
}

const requestItem = (f: Fixture, id: string) =>
  f.control
    .needsYou(user, f.project.id)
    .items.find((item) => item.source.table === 'approvals' && item.source.id === id)!;

it('reminds the user and the lead again when a permission request stays unanswered past the escalation window', async () => {
  const f = await workbenchFixture();
  const advance = skewedClock(f);
  const lead = await leadWithPlan(f, [task('a')]);
  const worker = await openTask(f, lead.id, 'a');
  await settle(f, worker);

  f.store.insert('approvals', permissionRequest(f, 'unanswered-request', worker.id));
  await f.control.tick();
  expect(notes(f, lead.id, 'waiting')).toHaveLength(1);
  await settle(f, lead);

  advance(9 * MINUTE);
  await f.control.tick();
  expect(notes(f, lead.id, 'waiting')).toHaveLength(1);
  expect(requestItem(f, 'unanswered-request')).not.toHaveProperty('escalated');

  advance(2 * MINUTE);
  await f.control.tick();
  await f.control.tick();
  const waits = notes(f, lead.id, 'waiting');
  expect(waits).toHaveLength(2);
  expect(waits[1]!.text).toContain(
    'The session has waited 11 minutes for the user to answer a permission request',
  );
  const item = requestItem(f, 'unanswered-request');
  expect(item).toMatchObject({ reason: 'permission_requested', escalated: true });
  expect(item.waited_ms).toBeGreaterThanOrEqual(11 * MINUTE);
  await eventually(
    () => told(f, lead.id).length === 2,
    () => f.control.tick(),
  );

  advance(20 * MINUTE);
  await f.control.tick();
  expect(notes(f, lead.id, 'waiting')).toHaveLength(2);
});

it('sends no reminder for a question relayed to the lead board', async () => {
  const f = await workbenchFixture();
  const advance = skewedClock(f);
  const lead = await leadWithPlan(f, [task('a')]);
  const worker = await openTask(f, lead.id, 'a');
  await settle(f, worker);
  f.store.insert('approvals', {
    ...permissionRequest(f, 'relayed-question', worker.id),
    tool: 'AskUserQuestion',
  });
  const plan = f.store.must<BoardPlan>('board_plans', lead.id);
  f.store.update<BoardPlan>(
    'board_plans',
    {
      ...plan,
      questions: [
        {
          id: 'relayed',
          at: f.store.now(),
          question: 'Which format?',
          options: ['CSV', 'JSON'],
          recommended: '',
          assumption: '',
          blocks: ['a'],
          source: { session_id: worker.id, approval_id: 'relayed-question' },
        },
      ],
    },
    plan.revision,
  );
  await f.control.tick();
  const before = notes(f, lead.id, 'waiting').length;

  advance(11 * MINUTE);
  await f.control.tick();
  await f.control.tick();
  expect(f.store.events().filter((event) => event.kind === 'approval.escalated')).toEqual([]);
  expect(notes(f, lead.id, 'waiting')).toHaveLength(before);
});

it('lists a lead session that waits for its own permission request with a next step', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  f.store.insert('approvals', permissionRequest(f, 'lead-request', lead.id));

  expect(requestItem(f, 'lead-request')).toMatchObject({
    session_id: lead.id,
    reason: 'permission_requested',
    next_step: expect.stringContaining('lead'),
  });
});

it('tells the lead which queued tasks wait for a place held by a session that waits for approval', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a'), task('b'), task('c'), task('d')]);
  const workers: Session[] = [];
  for (const id of ['a', 'b', 'c']) workers.push(await openTask(f, lead.id, id));
  for (const worker of workers) await settle(f, worker);
  f.call(
    'task.start',
    { project_id: f.project.id, task_ids: ['d'] },
    null,
    sessionOf(f, lead.id, 'lead'),
  );

  f.store.insert('approvals', permissionRequest(f, 'held-place', workers[0]!.id));
  await f.control.tick();
  const [wait] = notes(f, lead.id, 'waiting');
  expect(wait!.session_id).toBe(workers[0]!.id);
  expect(wait!.text).toContain('Tasks that wait for a place: d.');
});
