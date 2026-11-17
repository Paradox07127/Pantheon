import { expect, it, vi } from 'vitest';
import type { AgentEvent, BoardPlan, Principal, Session, Timer } from '@pantheon/domain';
import { eventually, settle, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const RESUME_TEXT =
  '[Pantheon] Your last turn stopped because the usage limit was used up. The limit has reset. Check where your work stopped, then continue.';
const MINUTE = 60_000;

const sessionOf = (f: Fixture, sessionId: string, role: 'lead' | 'worker'): Principal => ({
  id: `session:${sessionId}`,
  role,
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});

function writePlan(f: Fixture, leadId: string) {
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [
        {
          id: 'a',
          title: 'Serve exports over HTTP',
          goal: 'Exports download',
          lane: 'core',
          depends_on: [],
          source: ['Plan the export feature'],
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
}

const startTask = (f: Fixture, leadId: string) =>
  f.call<Promise<Session>>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Build it',
    task_id: `${leadId}:a`,
  });

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const pendingResumes = (f: Fixture, sessionId: string) =>
  f.store
    .list<Timer>('timers')
    .filter(
      (timer) =>
        timer.kind === 'usage-limit-resume' &&
        timer.subject_id === sessionId &&
        timer.state === 'pending',
    );
const continuations = (f: Fixture, sessionId: string) =>
  f.turns(sessionId).filter((turn) => turn.origin === 'continuation');

/** Runs the store clock ahead of the wall clock; returns how to move it further. */
function skewedClock(f: Fixture) {
  let skew = 0;
  vi.spyOn(f.store, 'now').mockImplementation(() => Date.now() + skew);
  return (ms: number) => {
    skew += ms;
  };
}

/** Ends the next delivered turn as failed, the way an adapter reports it. */
function failNextTurn(
  f: Fixture,
  fields: Partial<Extract<AgentEvent, { kind: 'turn.completed' }>>,
) {
  // start opens through resume, so its calls hold the sink of every native session.
  const resume = vi.spyOn(f.adapter, 'resume');
  vi.spyOn(f.adapter, 'send').mockImplementationOnce(async (handle, turn) => {
    const [, , emit] = resume.mock.calls.findLast(
      ([spec]) => spec.platform_session_id === handle.platform_session_id,
    )!;
    setTimeout(() =>
      emit({
        key: `failed:${turn.turn_id}`,
        provider_sequence: 1000,
        turn_id: turn.turn_id,
        kind: 'turn.completed',
        status: 'failed',
        error: 'Turn failed',
        ...fields,
      }),
    );
    return { turn_id: turn.turn_id, status: 'delivered' };
  });
}

const usageLimit = (resets_at?: number) => ({
  error: 'Usage limit reached',
  error_code: 'usage_limit',
  ...(resets_at === undefined ? {} : { resets_at }),
});

/** Waits until the session's turns have ended and it takes input again. */

async function leadWithPlan(f: Fixture) {
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id);
  return lead;
}

/** Notes and tracker turns that tell the lead of a failed turn. */
function turnFailedNotes(f: Fixture, leadId: string, workerId: string) {
  const plan = f.store.must<BoardPlan>('board_plans', leadId);
  return [
    ...plan.inbox.filter((note) => note.kind === 'turn_failed'),
    ...(plan.notified[workerId] === 'turn_failed' ? ['notified'] : []),
    ...f
      .turns(leadId)
      .filter((turn) => turn.origin === 'tracker' && turn.input.includes('turn_failed')),
  ];
}

it('waits for the usage limit to reset without telling the lead the turn failed', async () => {
  const f = await workbenchFixture();
  skewedClock(f);
  const lead = await leadWithPlan(f);
  const resetsAt = f.store.now() + 2 * 60 * MINUTE;
  failNextTurn(f, usageLimit(resetsAt));
  const worker = await startTask(f, lead.id);
  await settle(f, worker);
  await f.control.tick();
  expect(f.turns(worker.id)).toMatchObject([{ state: 'failed' }]);
  expect(pendingResumes(f, worker.id)).toMatchObject([{ due_at: resetsAt + MINUTE }]);
  expect(turnFailedNotes(f, lead.id, worker.id)).toEqual([]);
});

it('continues the session once the usage limit has reset', async () => {
  const f = await workbenchFixture();
  const advance = skewedClock(f);
  const lead = await leadWithPlan(f);
  const resetsAt = f.store.now() + 2 * 60 * MINUTE;
  failNextTurn(f, usageLimit(resetsAt));
  const worker = await startTask(f, lead.id);
  await settle(f, worker);
  await f.control.tick();
  expect(continuations(f, worker.id)).toEqual([]);
  advance(2 * 60 * MINUTE + MINUTE + 1);
  await f.control.tick();
  expect(continuations(f, worker.id)).toMatchObject([{ input: RESUME_TEXT }]);
  expect(pendingResumes(f, worker.id)).toEqual([]);
  await settle(f, worker);
  await f.control.tick();
  expect(continuations(f, worker.id)).toHaveLength(1);
  expect(turnFailedNotes(f, lead.id, worker.id)).toEqual([]);
});

it('keeps the resume pending while the session refuses input and continues once it takes input', async () => {
  const f = await workbenchFixture();
  const advance = skewedClock(f);
  const lead = await leadWithPlan(f);
  const resetsAt = f.store.now() + 2 * 60 * MINUTE;
  failNextTurn(f, usageLimit(resetsAt));
  const worker = await startTask(f, lead.id);
  await settle(f, worker);
  await f.control.tick();
  const stopping = current(f, worker.id);
  f.store.update('sessions', { ...stopping, stop_pending: true }, stopping.revision);
  advance(2 * 60 * MINUTE + MINUTE + 1);
  await f.control.tick();
  expect(continuations(f, worker.id)).toEqual([]);
  expect(pendingResumes(f, worker.id)).toHaveLength(1);
  const stopped = current(f, worker.id);
  f.store.update('sessions', { ...stopped, stop_pending: false }, stopped.revision);
  advance(MINUTE + 1);
  await f.control.tick();
  expect(continuations(f, worker.id)).toMatchObject([{ input: RESUME_TEXT }]);
  expect(pendingResumes(f, worker.id)).toEqual([]);
});

it('drops the pending resume once a later turn of the session runs', async () => {
  const f = await workbenchFixture();
  const advance = skewedClock(f);
  const lead = await leadWithPlan(f);
  const resetsAt = f.store.now() + 2 * 60 * MINUTE;
  failNextTurn(f, usageLimit(resetsAt));
  const worker = await startTask(f, lead.id);
  await settle(f, worker);
  const [timer] = pendingResumes(f, worker.id);
  expect(timer).toBeDefined();
  f.call(
    'session.send',
    { session_id: worker.id, input: 'Try again' },
    current(f, worker.id).revision,
  );
  await settle(f, worker);
  expect(f.turns(worker.id)).toMatchObject([{ state: 'failed' }, { state: 'completed' }]);
  expect(f.store.must<Timer>('timers', timer!.id).state).toBe('cancelled');
  advance(2 * 60 * MINUTE + MINUTE + 1);
  await f.control.tick();
  expect(continuations(f, worker.id)).toEqual([]);
});

it('waits thirty minutes when the runtime does not say when the limit resets', async () => {
  const f = await workbenchFixture();
  skewedClock(f);
  const lead = await leadWithPlan(f);
  failNextTurn(f, usageLimit());
  const before = f.store.now();
  const worker = await startTask(f, lead.id);
  await settle(f, worker);
  const after = f.store.now();
  const [timer] = pendingResumes(f, worker.id);
  expect(timer!.due_at).toBeGreaterThanOrEqual(before + 30 * MINUTE);
  expect(timer!.due_at).toBeLessThanOrEqual(after + 30 * MINUTE);
});

it.each([
  {
    name: 'keeps one pending resume when another turn hits the usage limit before it fires',
    later: MINUTE,
    due: 2 * MINUTE,
  },
  {
    name: 'waits again when a retry hits the usage limit with the same reset time',
    later: 0,
    due: MINUTE,
  },
])('$name', async ({ later, due }) => {
  const f = await workbenchFixture();
  const advance = skewedClock(f);
  const lead = await leadWithPlan(f);
  const resetsAt = f.store.now() + 2 * 60 * MINUTE;
  failNextTurn(f, usageLimit(resetsAt));
  const worker = await startTask(f, lead.id);
  await settle(f, worker);
  advance(later);
  failNextTurn(f, usageLimit(resetsAt + later));
  f.call(
    'session.send',
    { session_id: worker.id, input: 'Try again' },
    current(f, worker.id).revision,
  );
  await settle(f, worker);
  expect(f.turns(worker.id)).toMatchObject([{ state: 'failed' }, { state: 'failed' }]);
  expect(pendingResumes(f, worker.id)).toMatchObject([{ due_at: resetsAt + due }]);
});

it('leaves a session a person drives failed after a usage-limit failure', async () => {
  const f = await workbenchFixture();
  const advance = skewedClock(f);
  failNextTurn(f, usageLimit(f.store.now() + MINUTE));
  const session = await f.create();
  await settle(f, session);
  expect(f.store.list<Timer>('timers')).toEqual([]);
  advance(10 * MINUTE);
  await f.control.tick();
  expect(f.turns(session.id)).toMatchObject([{ state: 'failed' }]);
  expect(current(f, session.id).state).toBe('open');
});

it('tells the lead of a task session turn that failed for another reason', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f);
  failNextTurn(f, { error: 'provider overloaded' });
  const worker = await startTask(f, lead.id);
  await settle(f, worker);
  await f.control.tick();
  expect(pendingResumes(f, worker.id)).toEqual([]);
  expect(
    f
      .turns(lead.id)
      .some(
        (turn) =>
          turn.origin === 'tracker' &&
          turn.input.includes(': turn_failed: The latest turn of the session failed.'),
      ),
  ).toBe(true);
});

const reportRequirement = (f: Fixture, workerId: string, text: string) =>
  f.call(
    'task.report',
    { project_id: f.project.id, kind: 'requirement', text },
    null,
    sessionOf(f, workerId, 'worker'),
  );
const trackerTurns = (f: Fixture, sessionId: string) =>
  f.turns(sessionId).filter((turn) => turn.origin === 'tracker');

it('resumes a lead after the reset with one board update turn', async () => {
  const f = await workbenchFixture();
  const advance = skewedClock(f);
  const lead = await leadWithPlan(f);
  const resetsAt = f.store.now() + 2 * 60 * MINUTE;
  failNextTurn(f, usageLimit(resetsAt));
  f.call(
    'session.send',
    { session_id: lead.id, input: 'Check the plan again' },
    current(f, lead.id).revision,
  );
  await settle(f, lead);
  advance(2 * 60 * MINUTE + MINUTE + 1);
  await eventually(
    () => trackerTurns(f, lead.id).length > 0,
    () => f.control.tick(),
  );
  expect(trackerTurns(f, lead.id)[0]!.input).toContain('The limit has reset.');
  expect(continuations(f, lead.id)).toEqual([]);
  expect(pendingResumes(f, lead.id)).toEqual([]);
});

it('holds a lead wake while the lead waits for its usage limit and delivers the digest with the reset in one turn', async () => {
  const f = await workbenchFixture();
  const advance = skewedClock(f);
  // The lead's native session stays open, so the spy must see the resume that opened it.
  vi.spyOn(f.adapter, 'resume');
  const lead = await leadWithPlan(f);
  const worker = await startTask(f, lead.id);
  await settle(f, worker);
  const resetsAt = f.store.now() + 2 * 60 * MINUTE;
  failNextTurn(f, usageLimit(resetsAt));
  f.call(
    'session.send',
    { session_id: lead.id, input: 'Check the plan again' },
    current(f, lead.id).revision,
  );
  await settle(f, lead);
  expect(pendingResumes(f, lead.id)).toHaveLength(1);

  reportRequirement(f, worker.id, 'Task a must change the import path too');
  await f.control.tick();
  expect(trackerTurns(f, lead.id)).toEqual([]);
  expect(f.store.must<BoardPlan>('board_plans', lead.id).inbox).toMatchObject([
    { kind: 'requirement', text: 'Task a must change the import path too' },
  ]);

  advance(2 * 60 * MINUTE + MINUTE + 1);
  await eventually(
    () => trackerTurns(f, lead.id).length > 0,
    () => f.control.tick(),
  );
  expect(trackerTurns(f, lead.id)).toHaveLength(1);
  expect(trackerTurns(f, lead.id)[0]!.input).toContain('Task a must change the import path too');
  expect(trackerTurns(f, lead.id)[0]!.input).toContain('The limit has reset.');
  expect(continuations(f, lead.id)).toEqual([]);
  expect(f.store.must<BoardPlan>('board_plans', lead.id).inbox).toEqual([]);
});

it('refuses a lead message to a task session that waits for its usage limit and names the reset time', async () => {
  const f = await workbenchFixture();
  skewedClock(f);
  const lead = await leadWithPlan(f);
  const resetsAt = f.store.now() + 2 * 60 * MINUTE;
  failNextTurn(f, usageLimit(resetsAt));
  const worker = await startTask(f, lead.id);
  await settle(f, worker);

  expect(() =>
    f.call(
      'task.message',
      { project_id: f.project.id, task_id: 'a', text: 'Use CSV' },
      null,
      sessionOf(f, lead.id, 'lead'),
    ),
  ).toThrow(
    expect.objectContaining({
      code: 'resource_busy',
      message: expect.stringContaining(new Date(resetsAt + MINUTE).toISOString()),
    }),
  );
  expect(f.turns(worker.id)).toHaveLength(1);
});

it('does not hand a merge problem back to a task session that waits for its usage limit', async () => {
  const f = await workbenchFixture();
  skewedClock(f);
  const lead = await leadWithPlan(f);
  failNextTurn(f, usageLimit(f.store.now() + 2 * 60 * MINUTE));
  const worker = await startTask(f, lead.id);
  await settle(f, worker);
  f.store.event('session.merge_started', current(f, worker.id), f.project.id, { auto: true }, '');
  const session = current(f, worker.id);
  f.store.update<Session>(
    'sessions',
    {
      ...session,
      merge: {
        state: 'blocked',
        reason: 'gate_failed',
        gate: { name: 'Unit tests', output: 'expected 1, received 2' },
      },
    },
    session.revision,
  );

  await f.control.tick();
  await f.control.tick();
  expect(f.turns(worker.id)).toHaveLength(1);
  expect(f.store.must<BoardPlan>('board_plans', lead.id).handed_back ?? {}).toEqual({});
});

it('lists a daemon-driven session waiting for a usage reset in needs-you with the reset time', async () => {
  const f = await workbenchFixture();
  skewedClock(f);
  const lead = await leadWithPlan(f);
  const resetsAt = f.store.now() + 2 * 60 * MINUTE;
  failNextTurn(f, usageLimit(resetsAt));
  const worker = await startTask(f, lead.id);
  await settle(f, worker);

  expect(
    f.control
      .needsYou(user, f.project.id)
      .items.filter((item) => item.reason === 'usage_limit_waiting'),
  ).toMatchObject([
    {
      source: { table: 'sessions', id: worker.id },
      kind: 'session.failed',
      project_id: f.project.id,
      resets_at: resetsAt + MINUTE,
      actions: [],
      next_step: expect.any(String),
    },
  ]);
});
