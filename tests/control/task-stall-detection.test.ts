import { expect, it, vi } from 'vitest';
import type { Approval, BoardPlan, LeadNote, Principal, Session } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, settle, user } from '../helpers.js';
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

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);

/** The notes the tracker left the lead, of one kind, oldest first. */
const notes = (f: Fixture, leadId: string, kind: LeadNote['kind']) =>
  f.store
    .kindEvents(f.project.id, ['lead.note_added'])
    .filter((event) => event.aggregate_id === leadId)
    .map((event) => event.payload as LeadNote)
    .filter((note) => note.kind === kind);

const itemsOf = (f: Fixture, sessionId: string) =>
  f.control
    .needsYou(user, f.project.id)
    .items.filter((item) => item.source.table === 'sessions' && item.source.id === sessionId);

/** Runs the store clock ahead of the wall clock; returns how to move it further. */
function skewedClock(f: Fixture) {
  let skew = 0;
  vi.spyOn(f.store, 'now').mockImplementation(() => Date.now() + skew);
  return (ms: number) => {
    skew += ms;
  };
}

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

/** A task session whose first turn runs for longer than the test. */
async function runningWorker(f: Fixture, leadId: string) {
  (f.adapter as { delay: number }).delay = 60000;
  const worker = await f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Build it',
    task_id: `${leadId}:a`,
  });
  await awaitWorkspaceReady(f.control, worker.workspace_id!);
  await eventually(
    () => f.turns(worker.id)[0]?.state === 'running',
    () => f.control.tick(),
  );
  const turn = f.turns(worker.id)[0]!;
  const event = (kind: string, fields: Record<string, unknown>) =>
    f.store.event(kind, current(f, worker.id), f.project.id, { turn_id: turn.id, ...fields });
  return { worker, turn, event };
}

it('tells the lead when one tool call stays open far past the stall window', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const advance = skewedClock(f);
  const { worker, turn, event } = await runningWorker(f, lead.id);
  event('agent.tool.started', {
    tool_call_id: 'watch',
    name: 'Bash',
    input: { command: 'pnpm test --watch' },
  });

  advance(29 * MINUTE);
  await f.control.tick();
  expect(notes(f, lead.id, 'stalled')).toEqual([]);
  advance(2 * MINUTE);
  await f.control.tick();
  const [note] = notes(f, lead.id, 'stalled');
  expect(note).toMatchObject({ session_id: worker.id, task_id: 'a' });
  expect(note!.text).toBe(
    'The running turn of the session makes no progress. Its tool call Bash has been open for 31 minutes, with the input {"command":"pnpm test --watch"}.',
  );
  expect(f.store.must<BoardPlan>('board_plans', lead.id).alerted?.[turn.id]).toEqual(['stalled']);
});

it('does not call a turn stalled while its permission request waits for the user, and counts the answer as progress', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const advance = skewedClock(f);
  const { worker, event } = await runningWorker(f, lead.id);
  event('agent.tool.started', {
    tool_call_id: 'push',
    name: 'Bash',
    input: { command: 'git push' },
  });
  f.store.insert<Approval>('approvals', {
    id: 'push-request',
    revision: 1,
    project_id: f.project.id,
    kind: 'permission',
    session_id: worker.id,
    request_id: 'push-request',
    tool: 'Bash',
    input_hash: 'a'.repeat(64),
    decider: 'user',
    state: 'pending',
    created_at: f.store.now(),
  });

  advance(31 * MINUTE);
  await f.control.tick();
  expect(notes(f, lead.id, 'stalled')).toEqual([]);
  const request = f.store.must<Approval>('approvals', 'push-request');
  f.store.update<Approval>(
    'approvals',
    { ...request, state: 'approved', resolved_at: f.store.now() },
    request.revision,
  );
  advance(29 * MINUTE);
  await f.control.tick();
  expect(notes(f, lead.id, 'stalled')).toEqual([]);
  advance(2 * MINUTE);
  await f.control.tick();
  expect(notes(f, lead.id, 'stalled')).toHaveLength(1);
});

it('lists a task session in needs-you when its stall alert gets no lead action within the window', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const advance = skewedClock(f);
  const { worker } = await runningWorker(f, lead.id);

  advance(11 * MINUTE);
  await f.control.tick();
  expect(notes(f, lead.id, 'stalled')).toHaveLength(1);
  expect(itemsOf(f, worker.id)).toEqual([]);
  advance(9 * MINUTE);
  await f.control.tick();
  expect(itemsOf(f, worker.id)).toEqual([]);

  advance(2 * MINUTE);
  await f.control.tick();
  expect(itemsOf(f, worker.id)).toEqual([
    expect.objectContaining({
      kind: 'session.failed',
      reason: 'task_turn_stalled',
      next_step: expect.any(String),
    }),
  ]);
  expect(notes(f, lead.id, 'stalled')).toHaveLength(1);
});

it('tells the user when a lead turn makes no progress for the stall window', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const advance = skewedClock(f);
  f.call(
    'session.send',
    { session_id: lead.id, input: 'fixture-script\n[{"hang":true}]' },
    current(f, lead.id).revision,
  );
  await eventually(
    () => f.turns(lead.id).at(-1)?.state === 'running',
    () => f.control.tick(),
  );

  advance(9 * MINUTE);
  await f.control.tick();
  expect(itemsOf(f, lead.id)).toEqual([]);
  advance(2 * MINUTE);
  await f.control.tick();
  expect(itemsOf(f, lead.id)).toEqual([
    expect.objectContaining({
      kind: 'session.failed',
      reason: 'lead_turn_stalled',
      next_step: expect.any(String),
    }),
  ]);
});

it('clears the stall of a lead turn from needs-you once the turn makes progress again', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const advance = skewedClock(f);
  f.call(
    'session.send',
    { session_id: lead.id, input: 'fixture-script\n[{"hang":true}]' },
    current(f, lead.id).revision,
  );
  await eventually(
    () => f.turns(lead.id).at(-1)?.state === 'running',
    () => f.control.tick(),
  );
  const turn = f.turns(lead.id).at(-1)!;
  advance(11 * MINUTE);
  await f.control.tick();
  expect(itemsOf(f, lead.id)).toEqual([expect.objectContaining({ reason: 'lead_turn_stalled' })]);

  f.store.event('agent.message.delta', current(f, lead.id), f.project.id, {
    turn_id: turn.id,
    kind: 'message.delta',
    text: 'Back at work',
  });
  await f.control.tick();
  expect(itemsOf(f, lead.id)).toEqual([]);
});

it('drops the stall of a task turn that made progress again, and tells the lead of its stalls once', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const advance = skewedClock(f);
  const { turn, event } = await runningWorker(f, lead.id);
  const alerted = () => f.store.must<BoardPlan>('board_plans', lead.id).alerted?.[turn.id];

  advance(11 * MINUTE);
  await f.control.tick();
  expect(alerted()).toEqual(['stalled']);
  event('agent.message.delta', { kind: 'message.delta', text: 'Back at work' });
  await f.control.tick();
  expect(alerted()).toBeUndefined();

  // The lead was told of the first stall long ago and did nothing, so the second goes to needs-you.
  advance(11 * MINUTE);
  await f.control.tick();
  expect(alerted()).toEqual(['stalled', 'stall_unanswered']);
  expect(notes(f, lead.id, 'stalled')).toHaveLength(1);
});

/** A session a person drives whose turn runs for longer than the test. */
async function hangingSession(f: Fixture) {
  const session = await f.create();
  await settle(f, session);
  f.call(
    'session.send',
    { session_id: session.id, input: 'fixture-script\n[{"hang":true}]' },
    current(f, session.id).revision,
  );
  await eventually(
    () => f.turns(session.id).at(-1)?.state === 'running',
    () => f.control.tick(),
  );
  return { session, turn: f.turns(session.id).at(-1)! };
}

it('tells the user when the turn of a session a person drives makes no progress for the stall window', async () => {
  const f = await workbenchFixture();
  const advance = skewedClock(f);
  const { session } = await hangingSession(f);

  advance(9 * MINUTE);
  await f.control.tick();
  expect(itemsOf(f, session.id)).toEqual([]);
  advance(2 * MINUTE);
  await f.control.tick();
  expect(itemsOf(f, session.id)).toEqual([
    expect.objectContaining({
      kind: 'session.failed',
      reason: 'session_turn_stalled',
      decision: 'other',
      actions: [],
      next_step: 'Open the session to see where it stopped.',
    }),
  ]);
});

it('does not call the turn of a session a person drives stalled while its permission request waits', async () => {
  const f = await workbenchFixture();
  const advance = skewedClock(f);
  const { session } = await hangingSession(f);
  f.store.insert<Approval>('approvals', {
    id: 'push-request',
    revision: 1,
    project_id: f.project.id,
    kind: 'permission',
    session_id: session.id,
    request_id: 'push-request',
    tool: 'Bash',
    input_hash: 'a'.repeat(64),
    decider: 'user',
    state: 'pending',
    created_at: f.store.now(),
  });

  advance(11 * MINUTE);
  await f.control.tick();
  expect(itemsOf(f, session.id)).toEqual([]);
});

it('records each stall of the turn of a session a person drives once', async () => {
  const f = await workbenchFixture();
  const advance = skewedClock(f);
  const { session, turn } = await hangingSession(f);
  const stalls = () =>
    f.store
      .kindEvents(f.project.id, ['session.turn_stalled'])
      .filter((event) => event.aggregate_id === session.id);

  advance(11 * MINUTE);
  await f.control.tick();
  await f.control.tick();
  expect(stalls()).toHaveLength(1);
  f.store.event('agent.message.delta', current(f, session.id), f.project.id, {
    turn_id: turn.id,
    kind: 'message.delta',
    text: 'Back at work',
  });
  await f.control.tick();
  expect(itemsOf(f, session.id)).toEqual([]);
  expect(stalls()).toHaveLength(1);

  advance(11 * MINUTE);
  await f.control.tick();
  await f.control.tick();
  expect(stalls()).toHaveLength(2);
});

it('does not call a turn stalled while it streams text', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const advance = skewedClock(f);
  const { event } = await runningWorker(f, lead.id);

  advance(6 * MINUTE);
  event('agent.message.delta', { kind: 'message.delta', text: 'Comparing the export formats' });
  advance(6 * MINUTE);
  await f.control.tick();
  expect(notes(f, lead.id, 'stalled')).toEqual([]);

  advance(5 * MINUTE);
  await f.control.tick();
  expect(notes(f, lead.id, 'stalled')).toHaveLength(1);
});
