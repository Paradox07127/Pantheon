import { expect, it } from 'vitest';
import type { BoardPlan, LeadNote, Principal, Session, SessionTurn } from '@pantheon/domain';
import { settle } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const leadOf = (f: Fixture, sessionId: string): Principal => ({
  id: `session:${sessionId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60_000,
});

const updatePlan = (f: Fixture, leadId: string, headline: string) =>
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: f.store.get<BoardPlan>('board_plans', leadId)?.plan_version ?? 0,
      headline,
      lanes: [
        { id: 'core', title: 'Core' },
        { id: 'docs', title: 'Docs' },
      ],
      tasks: [],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    leadOf(f, leadId),
  );

const otherPlanNotes = (f: Fixture, assistantId: string) =>
  (f.store.get<BoardPlan>('board_plans', assistantId)?.inbox ?? []).filter(
    (note: LeadNote) => note.kind === 'other_plan',
  );

/** A project with its Assistant open and a settled direct lead session. */
async function withDirectLead() {
  const f = await workbenchFixture();
  const assistant = f.call<Session>('resident.open', {
    project_id: f.project.id,
    kind: 'assistant',
  });
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  return { f, assistant, lead };
}

it("leaves the Assistant one note of a direct lead's plan and queues no Assistant turn", async () => {
  const { f, assistant, lead } = await withDirectLead();
  updatePlan(f, lead.id, 'Export ships this week');
  f.control.tick();
  const notes = otherPlanNotes(f, assistant.id);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ session_id: lead.id, task_id: '' });
  expect(notes[0]!.text).toContain(
    `(${lead.id}) planned: Export ships this week; lanes: Core, Docs`,
  );
  expect(f.turns(assistant.id)).toEqual([]);
});

it("replaces the Assistant's note when the same plan changes", async () => {
  const { f, assistant, lead } = await withDirectLead();
  updatePlan(f, lead.id, 'Export ships this week');
  updatePlan(f, lead.id, 'Export ships next week');
  const notes = otherPlanNotes(f, assistant.id);
  expect(notes).toHaveLength(1);
  expect(notes[0]!.text).toContain('planned: Export ships next week;');
});

it.each(['assistant', 'triage'] as const)(
  'leaves no note for a plan of the %s resident',
  async (kind) => {
    const { f, assistant } = await withDirectLead();
    const resident =
      kind === 'assistant'
        ? assistant
        : f.call<Session>('resident.open', { project_id: f.project.id, kind });
    updatePlan(f, resident.id, 'Sort the inbox');
    expect(otherPlanNotes(f, assistant.id)).toEqual([]);
  },
);

it('records nothing while the project has no open Assistant', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  updatePlan(f, lead.id, 'Export ships this week');
  expect(
    f.store.list<Session>('sessions').filter((session) => session.resident?.kind === 'assistant'),
  ).toEqual([]);
  expect(
    f.store.kindEvents(f.project.id, ['lead.note_added']).map((event) => event.payload as LeadNote),
  ).toEqual([]);
});

it("carries the note on the user's next message to the Assistant", async () => {
  const { f, assistant, lead } = await withDirectLead();
  updatePlan(f, lead.id, 'Export ships this week');
  const [note] = otherPlanNotes(f, assistant.id);
  const sent = f.call<SessionTurn>(
    'session.send',
    { session_id: assistant.id, input: 'Plan the export feature' },
    f.store.must<Session>('sessions', assistant.id).revision,
  );
  expect(sent.lead_note_ids).toContain(note!.id);
  expect(sent.input).toContain(`<note kind="other_plan" id="${note!.id}" session="${lead.id}">`);
  expect(otherPlanNotes(f, assistant.id)).toEqual([]);
});
