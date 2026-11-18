import { expect, it, vi } from 'vitest';
import type { BoardPlan, LeadNote, Principal, Session, SessionTurn } from '@pantheon/domain';
import { eventually, settle, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const MINUTE = 60_000;
/** Characters of one digest, as the inbox sets it. */
const DIGEST_BUDGET = 6000;
/** Unread notes past which a worker's report is refused, as the tracker sets it. */
const INBOX_LIMIT = 32;

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

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const planOf = (f: Fixture, leadId: string) => f.store.must<BoardPlan>('board_plans', leadId);
const told = (f: Fixture, leadId: string) =>
  f.turns(leadId).filter((turn) => turn.origin === 'tracker');

/** A settled lead with a one-task plan and the settled session of that task. */
async function leadWithTask(f: Fixture) {
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id);
  const worker = await f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Build it',
    task_id: `${lead.id}:a`,
  });
  await settle(f, worker);
  return { lead, worker };
}

const requirement = (f: Fixture, workerId: string, text: string) =>
  f.call(
    'task.report',
    { project_id: f.project.id, kind: 'requirement', text },
    null,
    sessionOf(f, workerId, 'worker'),
  );

/** Waking notes too many for one digest, each with a marker its whole text shows. */
const manyNotes = (workerId: string): LeadNote[] =>
  Array.from({ length: 120 }, (_, index) => ({
    id: `note-${String(index).padStart(3, '0')}-${'n'.repeat(40)}`,
    at: 1 + index,
    session_id: workerId,
    task_id: 'a',
    kind: 'requirement' as const,
    text: `Need ${String(index).padStart(3, '0')} ${'x'.repeat(300)}`,
  }));

function setInbox(f: Fixture, leadId: string, inbox: LeadNote[]) {
  const plan = planOf(f, leadId);
  f.store.update<BoardPlan>('board_plans', { ...plan, inbox }, plan.revision);
}

/** True when the inputs show the note whole or list its id. */
const delivered = (inputs: string, note: LeadNote) =>
  inputs.includes(`note ${note.id}`) || inputs.includes(note.text.slice(0, 9));

function skewedClock(f: Fixture) {
  let skew = 0;
  vi.spyOn(f.store, 'now').mockImplementation(() => Date.now() + skew);
  return (ms: number) => {
    skew += ms;
  };
}

/** Wakes the lead ten times with a requirement report, letting each turn end. */
async function wakeTenTimes(f: Fixture, lead: Session, worker: Session) {
  for (let index = 0; index < 10; index++) {
    requirement(f, worker.id, `Requirement ${index}`);
    await settle(f, lead);
  }
  expect(told(f, lead.id)).toHaveLength(10);
}

it('delivers the notes a digest leaves out with the next wake', async () => {
  const f = await workbenchFixture();
  const { lead, worker } = await leadWithTask(f);
  const notes = manyNotes(worker.id);
  setInbox(f, lead.id, notes);

  await f.control.tick();
  const [first] = told(f, lead.id);
  expect(first!.input.length).toBeLessThanOrEqual(DIGEST_BUDGET);
  expect(first!.input).toContain('they come with your next update');
  const left = planOf(f, lead.id).inbox;
  expect(left.length).toBeGreaterThan(0);
  expect(left.length).toBeLessThan(notes.length);
  for (const note of left) expect(delivered(first!.input, note)).toBe(false);

  await eventually(
    () => planOf(f, lead.id).inbox.length === 0,
    () => f.control.tick(),
  );
  await settle(f, lead);
  const inputs = told(f, lead.id).map((turn) => turn.input);
  expect(inputs.length).toBeGreaterThan(1);
  for (const input of inputs) expect(input.length).toBeLessThanOrEqual(DIGEST_BUDGET);
  for (const note of notes) expect(delivered(inputs.join('\n'), note)).toBe(true);
});

it('keeps one budget when wakes are folded into the queued lead turn', async () => {
  const f = await workbenchFixture({ delay: 1500 });
  const { lead, worker } = await leadWithTask(f);
  const running = f.call<SessionTurn>(
    'session.send',
    { session_id: lead.id, input: 'Check the plan again' },
    current(f, lead.id).revision,
  );
  await eventually(
    () => f.store.must<SessionTurn>('session_turns', running.id).state === 'running',
    () => f.control.tick(),
  );
  requirement(f, worker.id, 'Task a needs the import path too');
  const [queued] = told(f, lead.id);
  expect(queued).toMatchObject({ state: 'queued', delivery: 'pending' });

  const notes = manyNotes(worker.id);
  setInbox(f, lead.id, notes);
  await f.control.tick();
  const folded = f.store.must<SessionTurn>('session_turns', queued!.id);
  expect(told(f, lead.id)).toHaveLength(1);
  expect(folded.input).toContain('Task a needs the import path too');
  expect(folded.input.length).toBeLessThanOrEqual(DIGEST_BUDGET);
  expect(planOf(f, lead.id).inbox.length).toBeGreaterThan(0);

  await eventually(
    () => planOf(f, lead.id).inbox.length === 0,
    () => f.control.tick(),
  );
  await settle(f, lead);
  const inputs = told(f, lead.id).map((turn) => turn.input);
  for (const input of inputs) expect(input.length).toBeLessThanOrEqual(DIGEST_BUDGET);
  for (const note of notes) expect(delivered(inputs.join('\n'), note)).toBe(true);
});

it('records an event of the queued lead turn a tick folds notes into, and none without notes', async () => {
  const f = await workbenchFixture({ delay: 1500 });
  const { lead, worker } = await leadWithTask(f);
  const running = f.call<SessionTurn>(
    'session.send',
    { session_id: lead.id, input: 'Check the plan again' },
    current(f, lead.id).revision,
  );
  await eventually(
    () => f.store.must<SessionTurn>('session_turns', running.id).state === 'running',
    () => f.control.tick(),
  );
  requirement(f, worker.id, 'Task a needs the import path too');
  const [queued] = told(f, lead.id);
  expect(queued).toMatchObject({ state: 'queued', delivery: 'pending' });
  const last = () => f.store.events(0, undefined, 100000).at(-1)!.sequence;
  const turnEvents = (after: number) =>
    f.store
      .events(after, lead.project_id, 100000)
      .filter((event) => event.aggregate_id === queued!.id);

  const before = last();
  setInbox(f, lead.id, [
    {
      id: 'note-export-path',
      at: 1,
      session_id: worker.id,
      task_id: 'a',
      kind: 'requirement',
      text: 'Task a needs the export path too',
    },
  ]);
  await f.control.tick();
  expect(f.store.must<SessionTurn>('session_turns', queued!.id).input).toContain(
    'Task a needs the export path too',
  );
  expect(planOf(f, lead.id).inbox).toEqual([]);
  expect(turnEvents(before)).toHaveLength(1);

  const folded = last();
  await f.control.tick();
  expect(turnEvents(folded)).toEqual([]);
});

it('counts the notes folded into the queued lead turn in its one wake line', async () => {
  const f = await workbenchFixture({ delay: 1500 });
  const { lead, worker } = await leadWithTask(f);
  const running = f.call<SessionTurn>(
    'session.send',
    { session_id: lead.id, input: 'Check the plan again' },
    current(f, lead.id).revision,
  );
  await eventually(
    () => f.store.must<SessionTurn>('session_turns', running.id).state === 'running',
    () => f.control.tick(),
  );
  requirement(f, worker.id, 'Task a needs the import path too');
  requirement(f, worker.id, 'Task a needs the export path too');
  await f.control.tick();
  const [queued] = told(f, lead.id);
  expect(told(f, lead.id)).toHaveLength(1);
  expect(queued!.input).toContain('Task a needs the export path too');
  expect(queued!.input.match(/^Wake at /gm)).toHaveLength(1);
  expect(queued!.input).toMatch(/^Wake at \S+\. 2 update\(s\); not a user request\.$/m);
});

it('caps tracker notes in the inbox and keeps the overflow readable by id', async () => {
  const f = await workbenchFixture();
  const { lead, worker } = await leadWithTask(f);
  const report = (index: number) =>
    f.call(
      'task.report',
      { project_id: f.project.id, kind: 'risk', text: `Risk ${index} ${'r'.repeat(300)}` },
      null,
      sessionOf(f, worker.id, 'worker'),
    );
  // Risk reports do not wake the lead, so they fill its inbox to the limit a report may reach.
  for (let index = planOf(f, lead.id).inbox.length; index < INBOX_LIMIT; index++) report(index);
  expect(() => report(INBOX_LIMIT)).toThrow(expect.objectContaining({ code: 'resource_busy' }));
  const before = planOf(f, lead.id).inbox;

  const session = current(f, worker.id);
  f.store.update<Session>(
    'sessions',
    { ...session, merge: { state: 'blocked', reason: 'local_changes' } },
    session.revision,
  );
  await f.control.tick();
  const notes = f.store
    .kindEvents(f.project.id, ['lead.note_added'])
    .filter((event) => event.aggregate_id === lead.id)
    .map((event) => event.payload as LeadNote)
    .filter((note) => before.some((kept) => kept.id === note.id) || note.kind === 'blocked');
  expect(notes).toHaveLength(INBOX_LIMIT + 1);
  expect(notes.at(-1)).toMatchObject({ kind: 'blocked', session_id: worker.id });

  // The digest shows what fits whole and lists the rest by id, so the inbox it takes is empty.
  const [first] = told(f, lead.id);
  expect(told(f, lead.id)).toHaveLength(1);
  expect(first!.input.length).toBeLessThanOrEqual(DIGEST_BUDGET);
  expect(planOf(f, lead.id).inbox).toEqual([]);
  for (const note of notes) expect(delivered(first!.input, note)).toBe(true);
  const listed = notes.filter((note) => first!.input.includes(`note ${note.id}`));
  expect(listed.length).toBeGreaterThan(0);
  expect(first!.input).toContain(`${listed.length} more notes; read_note <id> reads each.`);
  for (const note of listed)
    expect(
      f.call(
        'lead.note.read',
        { project_id: f.project.id, note_id: note.id },
        null,
        sessionOf(f, lead.id, 'lead'),
      ),
    ).toEqual(note);
});

it('stops waking the lead and lists it in needs-you after too many wakes in a short window', async () => {
  const f = await workbenchFixture();
  const { lead, worker } = await leadWithTask(f);
  await wakeTenTimes(f, lead, worker);

  requirement(f, worker.id, 'One requirement too many');
  await f.control.tick();
  expect(told(f, lead.id)).toHaveLength(10);
  expect(planOf(f, lead.id).inbox).toMatchObject([{ text: 'One requirement too many' }]);
  const refused = planOf(f, lead.id).wake_failed!;
  expect(refused).toEqual({ reason: 'wake_limit', at: expect.any(Number) });
  expect(
    f.store
      .events(0, f.project.id, 10000)
      .filter((event) => event.kind === 'board.lead_wake_failed')
      .map((event) => event.payload),
  ).toEqual([{ reason: 'wake_limit' }]);
  expect(
    f.control
      .needsYou(user, f.project.id)
      .items.filter((item) => item.reason === 'lead_wake_limited'),
  ).toMatchObject([
    {
      source: { table: 'board_plans', id: lead.id },
      kind: 'session.failed',
      session_id: lead.id,
      created_at: refused.at,
      next_step: expect.any(String),
    },
  ]);
});

it('wakes the lead again once the wake window has passed', async () => {
  const f = await workbenchFixture();
  const advance = skewedClock(f);
  const { lead, worker } = await leadWithTask(f);
  await wakeTenTimes(f, lead, worker);
  requirement(f, worker.id, 'One requirement too many');
  await f.control.tick();
  expect(planOf(f, lead.id).wake_failed).toMatchObject({ reason: 'wake_limit' });

  advance(10 * MINUTE);
  // The idle lead's native process may close first, which refuses the wake until it has.
  await eventually(
    () => told(f, lead.id).length > 10,
    () => f.control.tick(),
  );
  const turns = told(f, lead.id);
  expect(turns).toHaveLength(11);
  expect(turns[10]!.input).toContain('One requirement too many');
  expect(planOf(f, lead.id).wake_failed).toBeUndefined();
  expect(planOf(f, lead.id).inbox).toEqual([]);
  expect(
    f.control
      .needsYou(user, f.project.id)
      .items.filter((item) => item.reason === 'lead_wake_limited'),
  ).toEqual([]);
});

it('delivers the lead update without reading or injecting trace evidence', async () => {
  const f = await workbenchFixture();
  const { lead, worker } = await leadWithTask(f);
  const sent = vi.spyOn(f.adapter, 'send');
  const traceRead = vi.spyOn(f.store, 'windowEvents').mockImplementation(() => {
    throw new Error('Trace unavailable');
  });

  requirement(f, worker.id, 'Keep the existing workflow');
  await settle(f, lead);

  expect(traceRead).not.toHaveBeenCalled();
  const update = told(f, lead.id).at(-1)!;
  expect(update.state).toBe('completed');
  expect(sent.mock.calls.find(([, turn]) => turn.turn_id === update.id)?.[1].input).toContain(
    'Keep the existing workflow',
  );
});
