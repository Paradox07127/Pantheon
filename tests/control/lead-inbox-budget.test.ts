import { expect, it } from 'vitest';
import type { BoardPlan, LeadNote, Principal, Session, SessionTurn } from '@pantheon/domain';
import { settle } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

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

/** A settled lead with a one-task plan and the settled session of that task, its inbox emptied of the note on that session. */
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
  expect(planOf(f, lead.id).inbox).toMatchObject([
    {
      kind: 'user_edit',
      session_id: '',
      task_id: 'a',
      text: `The user opened the session ${worker.id} for task a from the board; it works on the task now.`,
    },
  ]);
  setInbox(f, lead.id, []);
  return { lead, worker };
}

const report = (f: Fixture, workerId: string, text: string) =>
  f.call(
    'task.report',
    { project_id: f.project.id, kind: 'risk', text },
    null,
    sessionOf(f, workerId, 'worker'),
  );

const readNote = (f: Fixture, leadId: string, noteId: string) =>
  f.call<LeadNote>(
    'lead.note.read',
    { project_id: f.project.id, note_id: noteId },
    null,
    sessionOf(f, leadId, 'lead'),
  );

/** The digest the lead's next message carries. */
function nextDigest(f: Fixture, leadId: string): string {
  const sent = f.call<SessionTurn>(
    'session.send',
    { session_id: leadId, input: 'Keep going' },
    current(f, leadId).revision,
  );
  return sent.input.slice(sent.input.indexOf('[Pantheon]'));
}

function setInbox(f: Fixture, leadId: string, inbox: LeadNote[]) {
  const plan = planOf(f, leadId);
  f.store.update<BoardPlan>('board_plans', { ...plan, inbox }, plan.revision);
}

it('lists the notes past the digest budget by id only and says how to read them', async () => {
  const f = await workbenchFixture();
  const { lead, worker } = await leadWithTask(f);
  for (let index = 0; index < 30; index++)
    report(f, worker.id, `Risk ${String(index).padStart(2, '0')} ${'x'.repeat(380)}`);
  const ids = planOf(f, lead.id).inbox.map((note) => note.id!);
  expect(new Set(ids).size).toBe(30);

  const digest = nextDigest(f, lead.id),
    lines = digest.split('\n');
  const full = lines.filter((line) => line.includes('reports a risk: "Risk '));
  expect(full.length).toBeGreaterThan(0);
  expect(full.length).toBeLessThan(30);
  expect(full.join('\n').length).toBeLessThanOrEqual(6000);
  const folded = ids.slice(full.length);
  for (const id of folded) expect(lines).toContain(`- risk: task a (generation 1), note ${id}`);
  expect(digest).not.toContain('Risk 29');
  expect(lines.at(-1)).toBe(`${folded.length} more notes; read_note <id> reads each.`);
});

it('cuts a long note in the digest and names the id that reads it whole', async () => {
  const f = await workbenchFixture();
  const { lead, worker } = await leadWithTask(f);
  const text = `Start ${'y'.repeat(1200)} end`;
  setInbox(f, lead.id, [
    { id: 'long-note', at: 1, session_id: worker.id, task_id: 'a', kind: 'turn_failed', text },
  ]);

  const digest = nextDigest(f, lead.id);
  expect(digest).toContain(`(${text.length} chars; read_note long-note for the full text)`);
  expect(digest).toContain('What happened: Task a "Serve exports over HTTP": Start ');
  expect(digest).not.toContain(' end');
});

it('still lists a stored note that has no id', async () => {
  const f = await workbenchFixture();
  const { lead, worker } = await leadWithTask(f);
  setInbox(f, lead.id, [
    { at: 1, session_id: worker.id, task_id: 'a', kind: 'risk', text: 'An old note' },
  ]);

  expect(nextDigest(f, lead.id)).toContain('reports a risk: "An old note"');
});

it('reads a note back by id after the inbox is taken, for the lead that owns it only', async () => {
  const f = await workbenchFixture();
  const { lead, worker } = await leadWithTask(f);
  report(f, worker.id, 'The export format may change');
  const [note] = planOf(f, lead.id).inbox;

  expect(readNote(f, lead.id, note!.id!)).toMatchObject({
    id: note!.id,
    kind: 'risk',
    task_id: 'a',
    text: 'The export format may change',
  });
  nextDigest(f, lead.id);
  expect(planOf(f, lead.id).inbox).toEqual([]);
  expect(readNote(f, lead.id, note!.id!).text).toBe('The export format may change');

  const other = await f.create('Plan the import feature');
  await settle(f, other);
  writePlan(f, other.id);
  expect(() => readNote(f, other.id, note!.id!)).toThrow(
    expect.objectContaining({ code: 'not_found' }),
  );
  expect(() =>
    f.call(
      'lead.note.read',
      { project_id: f.project.id, note_id: note!.id! },
      null,
      sessionOf(f, worker.id, 'worker'),
    ),
  ).toThrow(expect.objectContaining({ code: 'permission_denied' }));
});

it("leaves the lead a note without waking it when the user writes to a task session, and not for the lead's own message", async () => {
  const f = await workbenchFixture();
  const { lead, worker } = await leadWithTask(f);
  const leadTurns = f.turns(lead.id).length;

  f.call(
    'task.message',
    { project_id: f.project.id, task_id: 'a', text: 'Use CSV' },
    null,
    sessionOf(f, lead.id, 'lead'),
  );
  expect(planOf(f, lead.id).inbox).toEqual([]);
  await settle(f, worker);

  const message = `Please also handle the header row ${'z'.repeat(300)}`;
  const sent = f.call<SessionTurn>(
    'session.send',
    { session_id: worker.id, input: message },
    current(f, worker.id).revision,
  );
  const [note] = planOf(f, lead.id).inbox;
  expect(note).toMatchObject({
    kind: 'user_message',
    session_id: worker.id,
    task_id: 'a',
    turn_id: sent.id,
    text: message,
  });
  expect(f.store.must<SessionTurn>('session_turns', note!.turn_id!).input).toContain(message);

  await f.control.tick();
  expect(f.turns(lead.id)).toHaveLength(leadTurns);
  expect(planOf(f, lead.id).inbox).toHaveLength(1);
  const digest = nextDigest(f, lead.id);
  expect(digest).toContain(
    `the user wrote to the session of task a "Serve exports over HTTP": "${message.slice(0, 200)}… (${message.length} chars; read_note ${note!.id} for the full text)"`,
  );
  expect(digest).not.toContain(message.slice(0, 201));
  expect(readNote(f, lead.id, note!.id!).text).toBe(message);
});

it('keeps the whole digest within its budget, with one closing line for the notes it leaves out', async () => {
  const f = await workbenchFixture();
  const { lead, worker } = await leadWithTask(f);
  setInbox(f, lead.id, [
    { at: 1, session_id: worker.id, task_id: 'a', kind: 'risk', text: `Old ${'o'.repeat(500)}` },
    ...Array.from({ length: 200 }, (_, index) => ({
      id: `note-${String(index).padStart(3, '0')}-${'n'.repeat(24)}`,
      at: 2 + index,
      session_id: worker.id,
      task_id: 'a',
      kind: 'risk' as const,
      text: `Risk ${index} ${'x'.repeat(380)}`,
    })),
  ]);

  const digest = nextDigest(f, lead.id),
    lines = digest.split('\n');
  expect(digest.length).toBeLessThanOrEqual(6000);
  expect(digest).toContain('reports a risk: "Old ');
  const listed = lines.filter((line) => /^- risk: task a, note note-/.test(line)).length,
    full = lines.filter((line) => line.includes('reports a risk: "')).length;
  expect(listed).toBeGreaterThan(0);
  expect(lines.at(-1)).toBe(
    `${listed} more notes; read_note <id> reads each. ${201 - full - listed} notes past the size limit are not listed; they come with your next update.`,
  );
});
