import { expect, it, vi } from 'vitest';
import type { AgentMessage, AgentProfile, LeadNote, Principal, Session } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const lead = (f: Fixture, sessionId: string): Principal => ({
  id: `session:${sessionId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 3_600_000,
});

/** A project on a fixed clock with an open resident of the template's agent. */
async function reporterFixture(template: AgentProfile['template'], tools?: AgentProfile['tools']) {
  const f = await workbenchFixture();
  const now = Date.now();
  vi.spyOn(f.store, 'now').mockImplementation(() => now);
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const session =
    template === 'assistant' || template === 'triage'
      ? f.call<Session>('resident.open', { project_id: f.project.id, kind: template })
      : f.call<Session>('resident.open', {
          agent_id: f.call<AgentProfile>('agent.create', {
            project_id: f.project.id,
            template,
            name: `The ${template} agent`,
            role: template,
            instructions: 'You keep the changelog current.',
            ...(tools && { tools }),
          }).id,
        });
  const profile = f.store.must<AgentProfile>('agents', session.resident!.agent_id!);
  const assistant = () =>
    f.store
      .list<AgentProfile>('agents')
      .find((agent) => agent.project_id === f.project.id && agent.template === 'assistant')!;
  const assistantResidents = () =>
    f.store
      .list<Session>('sessions')
      .filter((each) => each.resident?.agent_id === assistant().id)
      .map((each) => each.id);
  const tell = (input: Record<string, unknown>) =>
    f.call<AgentMessage>(
      'agent.tell_user',
      { project_id: f.project.id, urgency: 'normal', ...input },
      null,
      lead(f, session.id),
    );
  const events = (kind: string) => f.store.events(0, f.project.id, 1000, [kind]);
  /** The notes of the kind the Assistant's residents got. */
  const assistantNotes = (kind: LeadNote['kind']) => {
    const ids = new Set(assistantResidents());
    return events('lead.note_added')
      .filter((event) => ids.has(event.aggregate_id))
      .map((event) => event.payload as LeadNote)
      .filter((note) => note.kind === kind);
  };
  const assistantWakes = () =>
    assistantResidents()
      .flatMap((id) => f.turns(id))
      .filter((turn) => turn.origin === 'tracker');
  return {
    f,
    ctx,
    session,
    profile,
    assistant,
    tell,
    events,
    assistantNotes,
    assistantWakes,
  };
}

it.each([
  ['triage', undefined],
  ['goals', undefined],
  ['ideas', undefined],
  ['custom', ['board', 'memory', 'always_on']],
] as const)(
  'sends what a %s agent tells the user to the Assistant instead',
  async (template, tools) => {
    const r = await reporterFixture(template, tools ? [...tools] : undefined);
    const message = r.tell({ text: 'The nightly import failed twice; t4 covers it.' });

    expect(r.f.store.list<AgentMessage>('agent_messages')).toEqual([
      expect.objectContaining({
        id: message.id,
        agent_id: r.profile.id,
        session_id: r.session.id,
        text: 'The nightly import failed twice; t4 covers it.',
        routed_to: r.assistant().id,
      }),
    ]);
    expect(r.events('agent_message.created')).toEqual([]);
    expect(r.events('agent_message.routed')).toEqual([
      expect.objectContaining({
        aggregate_id: message.id,
        payload: expect.objectContaining({ agent_name: r.profile.name }),
      }),
    ]);
    const notes = r.assistantNotes('agent_report');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toBe(
      `${r.profile.name} (message ${message.id}): The nightly import failed twice; t4 covers it.`,
    );
    expect(notes[0]!.session_id).toBe(r.session.id);
    const wakes = r.assistantWakes();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.lead_note_ids).toContain(notes[0]!.id);
  },
);

it("delivers the Assistant's own message to the user unchanged", async () => {
  const r = await reporterFixture('assistant');
  const message = r.tell({ text: 'The export task merged.' });
  expect(message.routed_to).toBeUndefined();
  expect(r.f.store.list<AgentMessage>('agent_messages')).toEqual([
    expect.not.objectContaining({ routed_to: expect.anything() }),
  ]);
  expect(r.events('agent_message.created')).toHaveLength(1);
  expect(r.events('agent_message.routed')).toEqual([]);
  expect(r.assistantNotes('agent_report')).toEqual([]);
});

it('lets a high-urgency message reach the user directly, and routes a normal one', async () => {
  const r = await reporterFixture('triage');
  const direct = r.tell({ text: 'typecheck fails on main.', urgency: 'high' });
  expect(direct.routed_to).toBeUndefined();
  expect(r.events('agent_message.created')).toHaveLength(1);

  const routed = r.tell({ text: 'unit fails on task branches.' });
  expect(routed.routed_to).toBe(r.assistant().id);
  expect(r.events('agent_message.created')).toHaveLength(1);
  expect(r.events('agent_message.routed')).toHaveLength(1);
});

it("keeps a routed report as the reporter's own message", async () => {
  const r = await reporterFixture('triage');
  const message = r.tell({ text: 'PR #12 is blocked by a failing check.' });
  expect(r.f.store.must<AgentMessage>('agent_messages', message.id)).toMatchObject({
    agent_id: r.profile.id,
    session_id: r.session.id,
    text: 'PR #12 is blocked by a failing check.',
  });
});
