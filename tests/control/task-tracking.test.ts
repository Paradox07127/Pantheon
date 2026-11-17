import { expect, it, onTestFinished, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type {
  Approval,
  BoardPlan,
  Principal,
  Project,
  Session,
  SessionTurn,
  WorkflowPolicy,
} from '@pantheon/domain';
import {
  awaitWorkspaceReady,
  countingGit,
  eventually,
  gitRunsOf,
  settle,
  user,
} from '../helpers.js';
import { boundTaskSession, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const sessionOf = (f: Fixture, sessionId: string, role: 'lead' | 'worker'): Principal => ({
  id: `session:${sessionId}`,
  role,
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});

const planTasks: BoardPlan['tasks'] = [
  {
    id: 'a',
    title: 'Serve exports over HTTP',
    goal: 'Exports download',
    lane: 'core',
    depends_on: [] as string[],
    source: ['Plan the export feature'],
    scope: ['src/export'],
    acceptance: ['pnpm test'],
  },
  {
    id: 'b',
    title: 'Add a download button',
    goal: 'Users can click it',
    lane: 'core',
    depends_on: ['a'],
    source: ['the export feature'],
    scope: ['src/ui'],
    acceptance: ['pnpm test'],
  },
];

function writePlan(
  f: Fixture,
  leadId: string,
  tasks = planTasks,
  milestones: { id: string; title: string; criteria: string[]; tasks: string[] }[] = [],
) {
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: f.store.get<BoardPlan>('board_plans', leadId)?.plan_version ?? 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks,
      milestones,
      risks: [],
      assumptions: [],
    },
    null,
    sessionOf(f, leadId, 'lead'),
  );
}

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const planOf = (f: Fixture, leadId: string) => f.store.must<BoardPlan>('board_plans', leadId);
const told = (f: Fixture, leadId: string) =>
  f.turns(leadId).filter((turn) => turn.origin === 'tracker');

/** Runs the store clock ahead of the wall clock; returns how to move it further. */
function skewedClock(f: Fixture) {
  let skew = 0;
  vi.spyOn(f.store, 'now').mockImplementation(() => Date.now() + skew);
  return (ms: number) => {
    skew += ms;
  };
}

/** Makes the fixture runtime's later turns run for 1.5 s, so one still runs while the test acts. */
const slowTurns = (f: Fixture) => Object.assign(f.adapter, { delay: 1500 });

/** A merge wakes the lead once no merge came in for the window that merges share. */
const MERGE_WAKE_MS = 30_000;

function patch(f: Fixture, sessionId: string, fields: Partial<Session>) {
  const session = current(f, sessionId);
  f.store.update<Session>('sessions', { ...session, ...fields }, session.revision);
}

/** Waits until the session's turns have ended and it takes input again. */
function permissionRequest(f: Fixture, id: string, sessionId: string): Approval {
  return {
    id,
    revision: 1,
    project_id: f.project.id,
    kind: 'permission',
    session_id: sessionId,
    request_id: id,
    tool: 'Bash',
    input_hash: 'a'.repeat(64),
    decider: 'user',
    state: 'pending',
    created_at: f.store.now(),
  };
}

it('tells the lead once when a task session merges', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id);
  const worker = await boundTaskSession(f, lead.id, 'a');
  await settle(f, worker);
  expect(told(f, lead.id)).toEqual([]);

  // No other task session runs or merges, so the merge wakes the lead without the merge window.
  patch(f, worker.id, { state: 'closed', outcome: 'merged' });
  await f.control.tick();
  const turns = told(f, lead.id);
  expect(turns).toHaveLength(1);
  expect(turns[0]!.input).toContain('Serve exports over HTTP');
  expect(turns[0]!.input).toContain('merged');
  expect(planOf(f, lead.id)).toMatchObject({ inbox: [], notified: { [worker.id]: 'merged' } });

  await f.control.tick();
  expect(told(f, lead.id)).toHaveLength(1);
});

it('does not hand back or wake the lead for a merge the user cancelled', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id);
  const worker = await boundTaskSession(f, lead.id, 'a');
  await settle(f, worker);
  const before = f.turns(worker.id).length;
  patch(f, worker.id, { merge: { state: 'blocked', reason: 'cancelled' } });
  f.store.event('session.merge_started', current(f, worker.id), f.project.id, { auto: true });
  writePlan(f, lead.id, [{ ...planTasks[0]!, goal: 'Export JSON files' }, planTasks[1]!]);

  for (let index = 0; index < 3; index++) await f.control.tick();
  expect(f.turns(worker.id)).toHaveLength(before);
  expect(told(f, lead.id)).toEqual([]);
  expect(planOf(f, lead.id).inbox).toEqual([]);
  expect(planOf(f, lead.id).contract_changed).toEqual([worker.id]);
  expect(current(f, worker.id).merge).toEqual({ state: 'blocked', reason: 'cancelled' });
});

it('brings an archived idle lead back when a task session merge wakes it', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id);
  const worker = await boundTaskSession(f, lead.id, 'a');
  await settle(f, worker);
  f.call('session.archive', { session_id: lead.id }, current(f, lead.id).revision);
  expect(current(f, lead.id).archived_at).toBeDefined();

  const advance = skewedClock(f);
  patch(f, worker.id, { state: 'closed', outcome: 'merged' });
  await f.control.tick();
  advance(MERGE_WAKE_MS);
  await f.control.tick();
  expect(told(f, lead.id)).toHaveLength(1);
  expect(current(f, lead.id)).not.toHaveProperty('archived_at');
  expect(
    f.store
      .events(0, undefined, 10000)
      .filter((event) => event.kind === 'session.unarchived' && event.aggregate_id === lead.id)
      .map((event) => event.payload),
  ).toEqual([{}]);
});

it('queues the message after the running turn instead of steering', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id);
  const worker = await boundTaskSession(f, lead.id, 'a');
  await settle(f, worker);
  slowTurns(f);
  const running = f.call<SessionTurn>(
    'session.send',
    { session_id: lead.id, input: 'Check the plan again' },
    current(f, lead.id).revision,
  );
  await eventually(
    () => f.store.must<SessionTurn>('session_turns', running.id).state === 'running',
    () => f.control.tick(),
  );

  const advance = skewedClock(f);
  patch(f, worker.id, { state: 'closed', outcome: 'merged' });
  await f.control.tick();
  advance(MERGE_WAKE_MS);
  await f.control.tick();
  const [message] = told(f, lead.id);
  expect(message).toMatchObject({ state: 'queued', delivery: 'pending' });
  const outbox = f.store.db
    .prepare("SELECT payload FROM outbox WHERE kind='session.turn'")
    .all() as { payload: string }[];
  expect(outbox.some((row) => row.payload.includes(message!.id))).toBe(false);
  expect(f.store.must<SessionTurn>('session_turns', running.id).state).toBe('running');

  await eventually(
    () => f.store.must<SessionTurn>('session_turns', message!.id).delivery === 'delivered',
    () => f.control.tick(),
  );
  expect(f.store.must<SessionTurn>('session_turns', running.id).state).toBe('completed');
});

it('tells the lead when a task session fails or waits, and again after it waits a second time', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id);
  const waiting = await boundTaskSession(f, lead.id, 'a'),
    failing = await boundTaskSession(f, lead.id, 'b');
  await settle(f, waiting);
  await settle(f, failing);

  f.store.insert('approvals', permissionRequest(f, 'first-request', waiting.id));
  await f.control.tick();
  expect(told(f, lead.id)).toHaveLength(1);
  expect(planOf(f, lead.id).notified).toEqual({ [waiting.id]: 'waiting' });
  await settle(f, lead);

  const first = f.store.must<Approval>('approvals', 'first-request');
  f.store.update<Approval>('approvals', { ...first, state: 'approved' }, first.revision);
  await f.control.tick();
  expect(planOf(f, lead.id).notified).toEqual({});
  expect(told(f, lead.id)).toHaveLength(1);

  f.store.insert('approvals', permissionRequest(f, 'second-request', waiting.id));
  patch(f, failing.id, { state: 'closed' });
  await f.control.tick();
  await settle(f, lead);
  await f.control.tick();

  const text = told(f, lead.id)
    .map((turn) => turn.input)
    .join('\n');
  expect(text.match(/: waiting:/g)).toHaveLength(2);
  expect(text.match(/: failed:/g)).toHaveLength(1);
  expect(text).toContain('Add a download button');
  expect(planOf(f, lead.id)).toMatchObject({
    inbox: [],
    notified: { [waiting.id]: 'waiting', [failing.id]: 'failed' },
  });
});

it('tells the lead with its next message that a wait it was told of ended', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id);
  const worker = await boundTaskSession(f, lead.id, 'a');
  await settle(f, worker);

  f.store.insert('approvals', permissionRequest(f, 'answered-request', worker.id));
  await f.control.tick();
  expect(told(f, lead.id)).toHaveLength(1);
  await settle(f, lead);

  const request = f.store.must<Approval>('approvals', 'answered-request');
  f.store.update<Approval>('approvals', { ...request, state: 'approved' }, request.revision);
  await f.control.tick();
  expect(told(f, lead.id)).toHaveLength(1);
  expect(planOf(f, lead.id).inbox).toMatchObject([
    {
      session_id: worker.id,
      task_id: 'a',
      kind: 'wait_ended',
      text: 'The session no longer waits for a permission request.',
    },
  ]);
});

it("delivers worker reports with the lead's next message", async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id);
  const worker = await boundTaskSession(f, lead.id, 'a');
  const report = (principal: Principal, text = 'The export format may change') =>
    f.call('task.report', { project_id: f.project.id, kind: 'risk', text }, null, principal);

  expect(report(sessionOf(f, worker.id, 'worker'))).toEqual({ pending: 1 });
  expect(planOf(f, lead.id).inbox).toMatchObject([
    { session_id: worker.id, task_id: 'a', kind: 'risk', text: 'The export format may change' },
  ]);
  await f.control.tick();
  expect(f.turns(lead.id)).toHaveLength(1);

  const sent = f.call<SessionTurn>(
    'session.send',
    { session_id: lead.id, input: 'Keep going' },
    current(f, lead.id).revision,
  );
  expect(sent.input.startsWith('Keep going\n\n')).toBe(true);
  expect(sent.input).toContain('The export format may change');
  expect(planOf(f, lead.id).inbox).toEqual([]);

  expect(() => report(sessionOf(f, lead.id, 'lead'))).toThrow(
    expect.objectContaining({ code: 'invalid_state' }),
  );

  const plan = planOf(f, lead.id),
    note = { at: 1, session_id: worker.id, task_id: 'a', kind: 'risk' as const, text: 'Old' };
  f.store.update<BoardPlan>(
    'board_plans',
    { ...plan, inbox: Array.from({ length: 32 }, () => note) },
    plan.revision,
  );
  expect(() => report(sessionOf(f, worker.id, 'worker'))).toThrow(
    expect.objectContaining({ code: 'resource_busy' }),
  );
});

it('hands worker reports to the lead with a steer as well', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id);
  const worker = await boundTaskSession(f, lead.id, 'a');
  f.call(
    'task.report',
    { project_id: f.project.id, kind: 'risk', text: 'The export format may change' },
    null,
    sessionOf(f, worker.id, 'worker'),
  );
  patch(f, lead.id, { state: 'running' });
  const steered = f.call<SessionTurn>(
    'session.steer',
    { session_id: lead.id, input: 'Also check the CSV header' },
    current(f, lead.id).revision,
  );
  expect(steered.input).toContain('The export format may change');
  expect(planOf(f, lead.id).inbox).toEqual([]);
});

const reportAs = (f: Fixture, workerId: string, kind: string, text: string) =>
  f.call(
    'task.report',
    { project_id: f.project.id, kind, text },
    null,
    sessionOf(f, workerId, 'worker'),
  );

it('wakes an idle lead at once with a requirement report', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id);
  const worker = await boundTaskSession(f, lead.id, 'a');

  reportAs(f, worker.id, 'requirement', 'The user asked for CSV but the goal says JSON');
  const turns = told(f, lead.id);
  expect(turns).toHaveLength(1);
  expect(turns[0]).toMatchObject({ state: 'queued', delivery: 'pending' });
  expect(turns[0]!.input).toContain(': requirement: The user asked for CSV but the goal says JSON');
  expect(planOf(f, lead.id).inbox).toEqual([]);
});

it('leaves a risk report for the lead to read with its next message', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id);
  const worker = await boundTaskSession(f, lead.id, 'a');

  reportAs(f, worker.id, 'risk', 'The export format may change');
  await f.control.tick();
  expect(told(f, lead.id)).toEqual([]);
  expect(planOf(f, lead.id).inbox).toHaveLength(1);
});

it('delivers a requirement report once the lead takes input again after a refused wake', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id);
  const worker = await boundTaskSession(f, lead.id, 'a');

  patch(f, lead.id, { state: 'reconciling' });
  reportAs(f, worker.id, 'requirement', 'Task a must change files outside its scope');
  expect(told(f, lead.id)).toEqual([]);

  patch(f, lead.id, { state: 'open' });
  await f.control.tick();
  expect(told(f, lead.id)).toHaveLength(1);
  expect(planOf(f, lead.id).inbox).toEqual([]);
});

it('tells the lead once it can take input again after a refused wake', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id);
  const worker = await boundTaskSession(f, lead.id, 'a');
  await settle(f, worker);

  const advance = skewedClock(f);
  patch(f, lead.id, { state: 'reconciling' });
  patch(f, worker.id, { state: 'closed', outcome: 'merged' });
  await f.control.tick();
  advance(MERGE_WAKE_MS);
  await f.control.tick();
  expect(told(f, lead.id)).toEqual([]);

  patch(f, lead.id, { state: 'open' });
  await f.control.tick();
  expect(told(f, lead.id)).toHaveLength(1);
  expect(planOf(f, lead.id).inbox).toEqual([]);
});

it('tells the lead when the merge of a task session is blocked, with the reason', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id);
  const worker = await boundTaskSession(f, lead.id, 'a');
  await settle(f, worker);

  patch(f, worker.id, { merge: { state: 'blocked', reason: 'local_changes' } });
  await f.control.tick();
  const turns = told(f, lead.id);
  expect(turns).toHaveLength(1);
  expect(turns[0]!.input).toContain(': blocked:');
  expect(turns[0]!.input).toContain('local_changes');
  expect(planOf(f, lead.id).notified).toEqual({ [worker.id]: 'blocked' });
});

/** Fails the session's latest turn the way the runtime reports it: the row and a turn.failed event. */
function failLatestTurn(f: Fixture, sessionId: string, error: string) {
  const turn = f.turns(sessionId).at(-1)!;
  const failed = f.store.update<SessionTurn>(
    'session_turns',
    { ...turn, state: 'failed' },
    turn.revision,
  );
  f.store.event('turn.failed', failed, failed.project_id, { error });
}

it('tells the lead when the latest turn of a task session fails, and again after a later one fails', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id);
  const worker = await boundTaskSession(f, lead.id, 'a');
  await settle(f, worker);

  failLatestTurn(f, worker.id, 'provider overloaded');
  await f.control.tick();
  const [first] = told(f, lead.id);
  expect(told(f, lead.id)).toHaveLength(1);
  expect(first!.input).toContain(
    ': turn_failed: The latest turn of the session failed. Reason: provider overloaded',
  );
  expect(planOf(f, lead.id).notified).toEqual({ [worker.id]: 'turn_failed' });
  await settle(f, lead);

  f.call<SessionTurn>(
    'session.send',
    { session_id: worker.id, input: 'Try again' },
    current(f, worker.id).revision,
  );
  await settle(f, worker);
  await f.control.tick();
  expect(f.turns(worker.id).at(-1)!.state).toBe('completed');
  expect(planOf(f, lead.id).notified).toEqual({});
  expect(told(f, lead.id)).toHaveLength(1);

  failLatestTurn(f, worker.id, 'context window exceeded');
  await f.control.tick();
  await settle(f, lead);
  const text = told(f, lead.id)
    .map((turn) => turn.input)
    .join('\n');
  expect(text.match(/: turn_failed:/g)).toHaveLength(2);
  expect(text).toContain('Reason: context window exceeded');
  expect(planOf(f, lead.id)).toMatchObject({
    inbox: [],
    notified: { [worker.id]: 'turn_failed' },
  });
});

it('tells the lead of a failed task turn that a steer was delivered into', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id);
  const worker = await boundTaskSession(f, lead.id, 'a');
  await settle(f, worker);

  failLatestTurn(f, worker.id, 'provider overloaded');
  f.store.insert<SessionTurn>('session_turns', {
    ...f.turns(worker.id).at(-1)!,
    id: 'steer-into-failed-turn',
    revision: 1,
    input: 'Also look at the import path',
    kind: 'steer',
    delivery: 'delivered',
    state: 'completed',
  });
  await f.control.tick();
  expect(planOf(f, lead.id).notified).toEqual({ [worker.id]: 'turn_failed' });
  expect(told(f, lead.id)[0]!.input).toContain('Reason: provider overloaded');
});

it('reports a closed task session as ended even when its latest turn failed', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id);
  const worker = await boundTaskSession(f, lead.id, 'a');
  await settle(f, worker);

  failLatestTurn(f, worker.id, 'provider overloaded');
  patch(f, worker.id, { state: 'closed' });
  await f.control.tick();
  const turns = told(f, lead.id);
  expect(turns).toHaveLength(1);
  expect(turns[0]!.input).toContain(': failed:');
  expect(turns[0]!.input).not.toContain('turn_failed');
  expect(planOf(f, lead.id).notified).toEqual({ [worker.id]: 'failed' });
});

const synced = (f: Fixture, leadId: string) =>
  f.turns(leadId).filter((turn) => turn.origin === 'sync');
const sync = (f: Fixture, principal?: Principal) =>
  f.call<{ session_ids: string[] }>('board.sync', { project_id: f.project.id }, null, principal);
const inOutbox = (f: Fixture, turnId: string) =>
  (
    f.store.db.prepare("SELECT payload FROM outbox WHERE kind='session.turn'").all() as {
      payload: string;
    }[]
  ).some((row) => row.payload.includes(turnId));

it('asks an idle lead to rewrite its plan once, however often the board is synced', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id);

  expect(await sync(f)).toEqual({ session_ids: [lead.id] });
  const [message] = synced(f, lead.id);
  expect(message).toMatchObject({ state: 'queued', delivery: 'pending' });
  expect(message!.input).toContain('update_board');
  expect(message!.input).toContain('Recent commits in');
  expect(inOutbox(f, message!.id)).toBe(true);
  expect(current(f, lead.id).state).toBe('running');

  expect(await sync(f)).toEqual({ session_ids: [lead.id] });
  expect(synced(f, lead.id)).toHaveLength(1);
});

it('hands a lead that syncs the board the brief a user sync sends it, without queueing a turn', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id);
  const worker = await boundTaskSession(f, lead.id, 'a');
  const turns = f.store.list<SessionTurn>('session_turns').length;

  const { brief } = await f.call<{ brief: string }>(
    'board.sync',
    { project_id: f.project.id },
    null,
    sessionOf(f, lead.id, 'lead'),
  );
  expect(f.store.list<SessionTurn>('session_turns')).toHaveLength(turns);
  expect(brief).toContain(`- a "Serve exports over HTTP": active; sessions: ${worker.id} `);
  expect(brief).toContain('- b "Add a download button": todo; sessions: none');

  expect(await sync(f)).toEqual({ session_ids: [lead.id] });
  expect(synced(f, lead.id).map((turn) => turn.input)).toEqual([brief]);
});

it('reads the recent commits once for all the leads a sync briefs, while other work goes on', async () => {
  const f = await workbenchFixture();
  const leads = [
    await f.create('Plan the export feature'),
    await f.create('Plan the export feature'),
  ];
  for (const lead of leads) {
    await settle(f, lead);
    writePlan(f, lead.id);
  }
  const counter = countingGit();
  onTestFinished(counter.restore);
  counter.slowOn('log -20');
  let fired = false;
  const timer = setTimeout(() => (fired = true), 50);
  onTestFinished(() => clearTimeout(timer));
  expect((await sync(f)).session_ids.sort()).toEqual(leads.map((lead) => lead.id).sort());
  expect(fired).toBe(true);
  expect(gitRunsOf(counter.runs(), 'log')).toHaveLength(1);
  for (const lead of leads) expect(synced(f, lead.id)[0]!.input).toContain('Recent commits in');
});

it('queues the sync after the running turn of a lead', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id);
  slowTurns(f);
  const running = f.call<SessionTurn>(
    'session.send',
    { session_id: lead.id, input: 'Check the plan again' },
    current(f, lead.id).revision,
  );
  await eventually(
    () => f.store.must<SessionTurn>('session_turns', running.id).state === 'running',
    () => f.control.tick(),
  );

  expect(await sync(f)).toEqual({ session_ids: [lead.id] });
  expect(await sync(f)).toEqual({ session_ids: [lead.id] });
  const messages = synced(f, lead.id);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ state: 'queued', delivery: 'pending' });
  expect(inOutbox(f, messages[0]!.id)).toBe(false);
  expect(f.store.must<SessionTurn>('session_turns', running.id).state).toBe('running');
});

it('opens a new lead to sync the board when no lead takes input', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id);
  patch(f, lead.id, { state: 'closed' });

  const { session_ids } = await sync(f);
  expect(session_ids).toHaveLength(1);
  expect(session_ids[0]).not.toBe(lead.id);
  const opened = current(f, session_ids[0]!);
  expect(opened.workspace_id).toBeTruthy();
  expect(opened).not.toHaveProperty('task');
  expect(opened.title).toBe('Board sync');
  expect(f.turns(opened.id)[0]!.input).toContain('update_board');
  expect(synced(f, lead.id)).toEqual([]);

  expect(() => sync(f, sessionOf(f, lead.id, 'lead'))).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
});

it('does not sync a lead again while its sync turn runs', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id);
  slowTurns(f);
  await sync(f);
  await eventually(
    () => synced(f, lead.id)[0]?.state === 'running',
    () => f.control.tick(),
  );
  expect(await sync(f)).toEqual({ session_ids: [lead.id] });
  expect(synced(f, lead.id)).toHaveLength(1);
});

it('lets the lead opened by a sync take over the plan of an ended lead', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id);
  const worker = await boundTaskSession(f, lead.id, 'a');
  patch(f, lead.id, { state: 'closed', outcome: 'discarded' });

  const [successor] = (await sync(f)).session_ids;
  expect(f.store.get<BoardPlan>('board_plans', lead.id)).toBeUndefined();
  expect(planOf(f, successor!).tasks.map((task) => task.id)).toEqual(['a', 'b']);
  expect(current(f, worker.id).task).toEqual({
    lead_session_id: successor,
    id: 'a',
    generation: 1,
  });
  expect(f.turns(successor!)[0]!.input).toContain('take over');
});

/** Writes the lead's plan with one task quoting `quote` as its source. */
const quoting = (f: Fixture, leadId: string, quote: string) => () =>
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: f.store.get<BoardPlan>('board_plans', leadId)?.plan_version ?? 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [
        {
          id: 'a',
          title: 'Serve exports over HTTP',
          goal: 'Exports download',
          lane: 'core',
          depends_on: [],
          source: [quote],
          scope: ['src/export'],
          acceptance: ['pnpm test'],
        },
      ],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    sessionOf(f, leadId, 'lead'),
  );

it("refuses a worker report delivered with the user's message as a source quote", async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id);
  const worker = await boundTaskSession(f, lead.id, 'a');
  reportAs(f, worker.id, 'risk', 'The export format may change');
  f.call<SessionTurn>(
    'session.send',
    { session_id: lead.id, input: 'Keep going with the export' },
    current(f, lead.id).revision,
  );

  expect(quoting(f, lead.id, 'The export format may change')).toThrow(
    expect.objectContaining({ code: 'invalid_input' }),
  );
  expect(quoting(f, lead.id, 'Keep going with the export')).not.toThrow();
});

it('refuses the instructions a sync opens a lead with as a source quote', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id);
  patch(f, lead.id, { state: 'closed' });
  const [successor] = (await sync(f)).session_ids;

  expect(quoting(f, successor!, 'Sync the board with the project as it is now.')).toThrow(
    expect.objectContaining({ code: 'invalid_input' }),
  );
  expect(quoting(f, successor!, 'Plan the export feature')).not.toThrow();
});

const sendTo = (f: Fixture, sessionId: string, input: string) =>
  f.call<SessionTurn>(
    'session.send',
    { session_id: sessionId, input },
    current(f, sessionId).revision,
  );

it('tells a task session the contract its lead changed, with its next message, once', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id);
  const worker = await boundTaskSession(f, lead.id, 'a');
  await settle(f, worker);

  writePlan(f, lead.id, [
    { ...planTasks[0]!, acceptance: ['pnpm exec vitest run tests/export.test.ts'] },
    planTasks[1]!,
  ]);
  sendTo(f, worker.id, 'Continue');
  await settle(f, worker);
  const changed = f.turns(worker.id).at(-1)!.input;
  expect(changed).toContain('[Pantheon] The lead changed this task.');
  expect(changed).toContain('- pnpm exec vitest run tests/export.test.ts');
  expect(changed.startsWith('Continue\n\n')).toBe(true);

  sendTo(f, worker.id, 'Again');
  await settle(f, worker);
  expect(f.turns(worker.id).at(-1)!.input).toBe('Again');
});

it('tells a task session the lead changed when its task is done', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id);
  const worker = await boundTaskSession(f, lead.id, 'a');
  await settle(f, worker);

  writePlan(f, lead.id, [{ ...planTasks[0]!, done_when: 'report' }, planTasks[1]!]);
  sendTo(f, worker.id, 'Continue');
  await settle(f, worker);
  const changed = f.turns(worker.id).at(-1)!.input;
  expect(changed).toContain('[Pantheon] The lead changed this task.');
  expect(changed).toContain('Done when: the lead accepts your done report');
});

it('does not tell a task session of a plan resent with its task unchanged', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id);
  const worker = await boundTaskSession(f, lead.id, 'a');
  await settle(f, worker);

  writePlan(f, lead.id, [planTasks[0]!, { ...planTasks[1]!, goal: 'Users can click it twice' }]);
  sendTo(f, worker.id, 'Continue');
  expect(f.turns(worker.id).at(-1)!.input).toBe('Continue');
});

/** A task session opened on the plan's model for task a, idle after its first turn. */
async function modelTask(f: Fixture, model: string, effort?: 'low' | 'high') {
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id, [{ ...planTasks[0]!, model, ...(effort ? { effort } : {}) }]);
  const worker = await f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    model,
    ...(effort ? { effort } : {}),
    input: 'Build it',
    task_id: `${lead.id}:a`,
  });
  await settle(f, worker);
  return { lead, worker };
}

it('moves an idle task session to the model its lead changed and sends it a turn on it', async () => {
  const f = await workbenchFixture();
  const { lead, worker } = await modelTask(f, 'fixture');

  writePlan(f, lead.id, [{ ...planTasks[0]!, model: 'fixture-next' }]);
  await f.control.tick();
  const told = f.turns(worker.id).filter((turn) => turn.origin === 'lead');
  expect(told).toHaveLength(1);
  expect(told[0]!.model).toBe('fixture-next');
  expect(told[0]!.input).toContain('[Pantheon] The lead changed this task.');
  expect(told[0]!.input).toContain('Model: fixture-next');
  expect(current(f, worker.id).requested_model).toBe('fixture-next');
});

it('moves an idle task session to the effort its lead changed', async () => {
  const f = await workbenchFixture();
  const { lead, worker } = await modelTask(f, 'fixture', 'low');

  writePlan(f, lead.id, [{ ...planTasks[0]!, model: 'fixture', effort: 'high' }]);
  await f.control.tick();
  const told = f.turns(worker.id).filter((turn) => turn.origin === 'lead');
  expect(told).toHaveLength(1);
  expect(told[0]!.input).toContain('Model: fixture, effort high');
  expect(current(f, worker.id).requested_effort).toBe('high');
});

it('does not tell a task session its lead changed only the runtime of its task', async () => {
  const f = await workbenchFixture();
  const second = new FixtureAdapter();
  second.name = 'second';
  f.control.adapters.set(second.name, second);
  f.call(
    'project.sessionDefaults.set',
    { project_id: f.project.id, runtime: second.name, permission_mode: 'ask' },
    f.store.must<Project>('projects', f.project.id).revision,
  );
  const { lead, worker } = await modelTask(f, 'fixture');

  writePlan(f, lead.id, [{ ...planTasks[0]!, model: 'fixture', runtime: second.name }]);
  await f.control.tick();
  expect(f.turns(worker.id).filter((turn) => turn.origin === 'lead')).toHaveLength(0);
});

/** Blocks the session's merge on a failed gate the way the automatic merge does. */
function gateFails(f: Fixture, sessionId: string, output: string) {
  const session = current(f, sessionId);
  f.store.event('session.merge_started', session, session.project_id, { auto: true }, '');
  patch(f, sessionId, {
    merge: { state: 'blocked', reason: 'gate_failed', gate: { name: 'Unit tests', output } },
  });
}

const fromTracker = (f: Fixture, sessionId: string) =>
  f.turns(sessionId).filter((turn) => turn.origin === 'tracker');

async function leadWithWorker(f: Fixture) {
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id);
  const worker = await boundTaskSession(f, lead.id, 'a');
  await settle(f, worker);
  return { lead, worker };
}

it('hands a failed gate back again when its output changed, without telling the lead', async () => {
  const f = await workbenchFixture();
  const { lead, worker } = await leadWithWorker(f);

  gateFails(f, worker.id, 'expected 1, received 2');
  await f.control.tick();
  await settle(f, worker);
  gateFails(f, worker.id, 'expected 3, received 4');
  await f.control.tick();

  const handed = fromTracker(f, worker.id);
  expect(handed).toHaveLength(2);
  expect(handed[1]!.input).toContain('expected 3, received 4');
  expect(told(f, lead.id)).toEqual([]);
  expect(planOf(f, lead.id).inbox).toEqual([]);
  expect(planOf(f, lead.id).handed_back).toEqual({ [worker.id]: ['gate_failed', 'gate_failed'] });
});

it.each([
  ['hands failed gates back three times, then tells the lead of the fourth', undefined, 3],
  ['hands a failed gate back as often as the workflow policy allows, then tells the lead', 2, 2],
])('%s', async (_, limit, handbacks) => {
  const f = await workbenchFixture();
  if (limit !== undefined) setPolicy(f, { handback_limit: limit });
  const { lead, worker } = await leadWithWorker(f);
  const outputs = ['first failure', 'second failure', 'third failure', 'fourth failure'];

  for (const output of outputs.slice(0, handbacks)) {
    gateFails(f, worker.id, output);
    await f.control.tick();
    await settle(f, worker);
  }
  expect(fromTracker(f, worker.id)).toHaveLength(handbacks);
  expect(told(f, lead.id)).toEqual([]);

  gateFails(f, worker.id, outputs[handbacks]!);
  await f.control.tick();
  expect(fromTracker(f, worker.id)).toHaveLength(handbacks);
  expect(told(f, lead.id)[0]!.input).toContain(
    ': blocked: The merge of the session is blocked. Reason: gate_failed',
  );
});

it('tells the lead instead of handing back a failed gate whose last lines did not change', async () => {
  const f = await workbenchFixture();
  const { lead, worker } = await leadWithWorker(f);
  const tail = Array.from({ length: 20 }, (_, index) => `gate line ${index + 1}`).join('\n');

  gateFails(f, worker.id, `took 3s\n${tail}`);
  await f.control.tick();
  await settle(f, worker);
  gateFails(f, worker.id, `took 4s\n${tail}`);
  await f.control.tick();

  expect(fromTracker(f, worker.id)).toHaveLength(1);
  expect(told(f, lead.id)[0]!.input).toContain(
    ': blocked: The merge of the session is blocked. Reason: gate_failed',
  );
});

it('hands a turn without commits back once, then tells the lead when the next one has none either', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id);
  const project = () => f.store.must<Project>('projects', f.project.id);
  await f.call(
    'project.gate.set',
    {
      project_id: f.project.id,
      root: f.source,
      commands: [{ name: 'Passes', argv: [process.execPath, '-e', 'process.exit(0)'] }],
    },
    project().revision,
  );
  f.call('project.autoMerge.set', { project_id: f.project.id, enabled: true }, project().revision);
  const worker = await boundTaskSession(f, lead.id, 'a');
  await eventually(
    () => told(f, lead.id).length > 0,
    () => f.control.tick(),
  );
  await settle(f, worker);
  for (let i = 0; i < 3; i++) await f.control.tick();

  expect(fromTracker(f, worker.id)).toHaveLength(1);
  expect(planOf(f, lead.id).handed_back).toEqual({ [worker.id]: ['no_changes'] });
  const wakes = told(f, lead.id);
  expect(wakes).toHaveLength(1);
  expect(wakes[0]!.input).toContain(': no_changes: ');
});

it('hands a blocked merge back with the contract its lead changed in the meantime', async () => {
  const f = await workbenchFixture();
  const { lead, worker } = await leadWithWorker(f);

  writePlan(f, lead.id, [{ ...planTasks[0]!, goal: 'Exports download as CSV' }, planTasks[1]!]);
  gateFails(f, worker.id, 'expected 1, received 2');
  await f.control.tick();

  const handed = fromTracker(f, worker.id);
  expect(handed).toHaveLength(1);
  expect(handed[0]!.input).toContain('expected 1, received 2');
  expect(handed[0]!.input).toContain('[Pantheon] The lead changed this task.');
  expect(handed[0]!.input).toContain('Goal: Exports download as CSV');
  expect(f.turns(worker.id).filter((turn) => turn.origin === 'lead')).toEqual([]);
  expect(planOf(f, lead.id).contract_changed).toEqual([]);
  expect(current(f, worker.id).task?.generation).toBe(2);
});

it('hands a merge blocked on agent configuration or on merge commits back to the session', async () => {
  const f = await workbenchFixture();
  const { lead, worker } = await leadWithWorker(f);
  const blockMerge = (merge: Session['merge']) => {
    const session = current(f, worker.id);
    f.store.event('session.merge_started', session, session.project_id, { auto: true }, '');
    patch(f, worker.id, { merge });
  };

  blockMerge({ state: 'blocked', reason: 'protected_paths', conflicts: ['.claude/settings.json'] });
  await f.control.tick();
  await settle(f, worker);
  blockMerge({ state: 'blocked', reason: 'merge_commits' });
  await f.control.tick();

  const handed = fromTracker(f, worker.id);
  expect(handed).toHaveLength(2);
  expect(handed[0]!.input).toContain('- .claude/settings.json');
  expect(handed[1]!.input).toContain('merge commit');
  expect(told(f, lead.id)).toEqual([]);
  expect(planOf(f, lead.id).handed_back).toEqual({
    [worker.id]: ['protected_paths', 'merge_commits'],
  });
});

it('moves an idle task session back to the default model when its lead drops the model of its task', async () => {
  const f = await workbenchFixture();
  const { lead, worker } = await modelTask(f, 'fixture-large', 'high');

  writePlan(f, lead.id, [planTasks[0]!]);
  await eventually(
    () => f.turns(worker.id).some((turn) => turn.origin === 'lead'),
    () => f.control.tick(),
  );
  const told = f.turns(worker.id).filter((turn) => turn.origin === 'lead');
  expect(told).toHaveLength(1);
  expect(told[0]!.input).toContain('[Pantheon] The lead changed this task.');
  expect(told[0]!.model).toBeNull();
  expect(current(f, worker.id).requested_model).toBeUndefined();
  expect(current(f, worker.id).requested_effort).toBeUndefined();
});

it('moves an idle task session to the effort its lead gives a task without a model', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id, [planTasks[0]!]);
  const worker = await boundTaskSession(f, lead.id, 'a');
  await settle(f, worker);

  writePlan(f, lead.id, [{ ...planTasks[0]!, effort: 'high' }]);
  await eventually(
    () => f.turns(worker.id).some((turn) => turn.origin === 'lead'),
    () => f.control.tick(),
  );
  expect(f.turns(worker.id).filter((turn) => turn.origin === 'lead')).toHaveLength(1);
  expect(current(f, worker.id).requested_model).toBeUndefined();
  expect(current(f, worker.id).requested_effort).toBe('high');
});

it('writes the lead no notes of a session left from a removed task whose id a new task reuses', async () => {
  const f = await workbenchFixture();
  const { lead, worker } = await leadWithWorker(f);
  writePlan(f, lead.id, [{ ...planTasks[1]!, depends_on: [] }]);
  writePlan(f, lead.id);
  patch(f, worker.id, { state: 'closed' });
  await f.control.tick();
  await f.control.tick();
  expect(planOf(f, lead.id).inbox).toEqual([]);
  expect(planOf(f, lead.id).notified).toEqual({});
  expect(told(f, lead.id)).toEqual([]);
});

/** Input the fixture runtime runs as a script. */
const script = (...steps: object[]) => `fixture-script\n${JSON.stringify(steps)}`;

function setPolicy(f: Fixture, input: Record<string, unknown>) {
  f.call(
    'workflow.policy.set',
    { project_id: f.project.id, ...input },
    f.store.get<WorkflowPolicy>('workflow_policies', f.project.id)?.revision ?? null,
  );
}

const independent = [planTasks[0]!, { ...planTasks[1]!, depends_on: [] }];

it('waits the merge window before waking the lead while another task session runs', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id, independent);
  const worker = await boundTaskSession(f, lead.id, 'a');
  await settle(f, worker);
  const other = await f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: script({ hang: true }),
    task_id: `${lead.id}:b`,
  });
  await awaitWorkspaceReady(f.control, other.workspace_id!);
  await eventually(
    () => f.turns(other.id).some((turn) => turn.state === 'running'),
    () => f.control.tick(),
  );

  const advance = skewedClock(f);
  patch(f, worker.id, { state: 'closed', outcome: 'merged' });
  await f.control.tick();
  expect(told(f, lead.id)).toEqual([]);
  advance(MERGE_WAKE_MS);
  await f.control.tick();
  expect(told(f, lead.id)).toHaveLength(1);
  expect(told(f, lead.id)[0]!.input).toContain('merged');
});

it('wakes the lead for merges in a milestone only once every task of the milestone has ended', async () => {
  const f = await workbenchFixture();
  setPolicy(f, { acceptance_wake: 'milestone' });
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(
    f,
    lead.id,
    independent.map((task) => ({ ...task, milestone: 'export' })),
    [{ id: 'export', title: 'Export works', criteria: ['Exports download'], tasks: ['a', 'b'] }],
  );
  const first = await boundTaskSession(f, lead.id, 'a');
  await settle(f, first);
  const second = await boundTaskSession(f, lead.id, 'b');
  await settle(f, second);

  const advance = skewedClock(f);
  patch(f, first.id, { state: 'closed', outcome: 'merged' });
  await f.control.tick();
  advance(MERGE_WAKE_MS);
  await f.control.tick();
  expect(told(f, lead.id)).toEqual([]);
  expect(planOf(f, lead.id).inbox).toMatchObject([{ kind: 'merged', session_id: first.id }]);

  patch(f, second.id, { state: 'closed', outcome: 'merged' });
  await f.control.tick();
  const turns = told(f, lead.id);
  expect(turns).toHaveLength(1);
  expect(turns[0]!.input).toContain('Serve exports over HTTP');
  expect(turns[0]!.input).toContain('Add a download button');
});

it('wakes the lead for a merge in a milestone whose other tasks it has not started', async () => {
  const f = await workbenchFixture();
  setPolicy(f, { acceptance_wake: 'milestone' });
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(
    f,
    lead.id,
    independent.map((task) => ({ ...task, milestone: 'export' })),
    [{ id: 'export', title: 'Export works', criteria: ['Exports download'], tasks: ['a', 'b'] }],
  );
  const first = await boundTaskSession(f, lead.id, 'a');
  await settle(f, first);

  patch(f, first.id, { state: 'closed', outcome: 'merged' });
  await f.control.tick();
  expect(told(f, lead.id)).toHaveLength(1);
});

it('tells the lead that a turn stopped at its wall-clock limit kept its changes and goes on with the next message', async () => {
  const f = await workbenchFixture();
  const { lead, worker } = await leadWithWorker(f);
  failLatestTurn(f, worker.id, 'Turn deadline exceeded');
  f.store.event('agent.turn.completed', current(f, worker.id), f.project.id, {
    kind: 'turn.completed',
    turn_id: f.turns(worker.id).at(-1)!.id,
    status: 'failed',
    error: 'Turn deadline exceeded',
    error_code: 'turn_deadline',
  });

  await f.control.tick();
  const [note] = told(f, lead.id);
  expect(note!.input).toContain(': turn_failed: The latest turn of the session failed.');
  expect(note!.input).toContain('wall-clock time limit');
  expect(note!.input).toContain('uncommitted changes in its worktree are still there');
  expect(note!.input).toContain('another message to the session continues where it stopped');
});

it('keeps a second task queued for a place while the workflow policy allows one task session, and starts it once it allows more', async () => {
  const f = await workbenchFixture();
  setPolicy(f, { max_parallel: 1, path: { t1: 'dispatch' } });
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(
    f,
    lead.id,
    independent.map((task) => ({ ...task, goal: script({ hang: true }) })),
  );
  f.call(
    'task.start',
    { project_id: f.project.id, task_ids: ['a', 'b'] },
    null,
    sessionOf(f, lead.id, 'lead'),
  );
  const sessionsOf = (taskId: string) =>
    f.store
      .list<Session>('sessions')
      .filter((session) => session.task?.lead_session_id === lead.id && session.task.id === taskId);

  await f.control.tick();
  await f.control.tick();
  expect(sessionsOf('a')).toHaveLength(1);
  expect(sessionsOf('b')).toEqual([]);
  expect(Object.keys(planOf(f, lead.id).dispatch ?? {})).toEqual(['b']);

  setPolicy(f, { max_parallel: 3 });
  await f.control.tick();
  expect(sessionsOf('b')).toHaveLength(1);
});

it('wakes the lead once for an effective user contract edit', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id);
  f.call(
    'board.plan.edit',
    {
      project_id: f.project.id,
      lead_session_id: lead.id,
      base_version: planOf(f, lead.id).plan_version,
      ops: [{ type: 'set_task', task_id: 'a', patch: { model: 'new-model' } }],
    },
    null,
    user,
  );
  await f.control.tick();
  expect(told(f, lead.id)).toHaveLength(1);
  await f.control.tick();
  expect(told(f, lead.id)).toHaveLength(1);
});

it('hands an unfinished task back to the lead at the user request and holds automatic repairs', async () => {
  const f = await workbenchFixture(),
    lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id);
  const worker = await boundTaskSession(f, lead.id, 'a');
  await settle(f, worker);
  gateFails(f, worker.id, 'The implementation needs another approach');
  const before = f.turns(worker.id).length;
  f.call('task.handback', {
    lead_session_id: lead.id,
    task_id: 'a',
    reason: 'Use a different approach',
  });
  expect(told(f, lead.id).at(-1)?.input).toContain('Use a different approach');
  await f.control.tick();
  expect(f.turns(worker.id)).toHaveLength(before);
  expect(planOf(f, lead.id).handed_back?.[worker.id] ?? []).toEqual([]);
  expect(
    f.control.boardHistory(user, f.project.id).tasks.find((row) => row.id === `${lead.id}:a`)
      ?.handbacks,
  ).toBe(1);
  expect(
    f.control.boardView(user, f.project.id, 1).leads?.find((row) => row.session_id === lead.id)
      ?.messages_today,
  ).toContainEqual({ session_id: worker.id, lead: 0, tracker: 0, handbacks: 1 });
  expect(() =>
    f.call(
      'task.handback',
      { lead_session_id: lead.id, task_id: 'a', reason: 'Again' },
      null,
      sessionOf(f, lead.id, 'lead'),
    ),
  ).toThrow();
  patch(f, worker.id, { state: 'closed', outcome: 'merged' });
  expect(() =>
    f.call('task.handback', { lead_session_id: lead.id, task_id: 'a', reason: 'Again' }),
  ).toThrow(/unfinished/i);
  expect(() =>
    f.call('task.handback', { lead_session_id: lead.id, task_id: 'b', reason: 'Again' }),
  ).toThrow(/unfinished/i);
});

it('sends the first gate failure to the lead when hand-backs are disabled', async () => {
  const f = await workbenchFixture();
  setPolicy(f, { handback_limit: 0 });
  const { lead, worker } = await leadWithWorker(f);
  gateFails(f, worker.id, 'The export test failed');
  await f.control.tick();
  expect(fromTracker(f, worker.id)).toEqual([]);
  expect(told(f, lead.id)[0]!.input).toContain('Reason: gate_failed');
});

it('stops gate hand-backs immediately and lists the failure for the user', async () => {
  const f = await workbenchFixture();
  f.call('workflow.policy.set', { project_id: f.project.id, gate_on_fail: 'stop' });
  const { worker } = await leadWithWorker(f);
  gateFails(f, worker.id, 'The export test failed');
  await f.control.tick();
  expect(fromTracker(f, worker.id)).toEqual([]);
  expect(f.control.needsYou(user, f.project.id).items).toContainEqual(
    expect.objectContaining({
      source: expect.objectContaining({ id: worker.id }),
      reason: 'merge_blocked',
    }),
  );
});
