import { expect, it } from 'vitest';
import type { AgentProfile, AgentProposal, LeadNote, Principal, Session } from '@pantheon/domain';
import { IDEAS_TEMPLATE } from '../../packages/control/dist/agent-templates.js';
import { user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const lead = (f: Fixture, sessionId: string): Principal => ({
  id: `session:${sessionId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60_000,
});

const IDEAS = {
  template: 'ideas',
  name: 'Ideas',
  role: 'Ideas',
  instructions: IDEAS_TEMPLATE.instructions,
  brief: 'The user keeps dropping loose ideas into the main conversation.',
};

/** A project whose Assistant resident is open, and a way to call tools as a resident. */
async function proposalFixture() {
  const f = await workbenchFixture();
  const resident = (kind: 'assistant' | 'triage') =>
    f.call<Session>('resident.open', { project_id: f.project.id, kind });
  const assistant = resident('assistant');
  const as = <T = unknown>(
    session: Session,
    type: Parameters<Fixture['call']>[0],
    input: Record<string, unknown>,
  ) => f.call<T>(type, { project_id: f.project.id, ...input }, null, lead(f, session.id));
  const refusal = async (run: () => unknown) => {
    try {
      await run();
    } catch (error) {
      return (error as { code?: string }).code;
    }
    return 'accepted';
  };
  const proposals = () => f.store.list<AgentProposal>('agent_proposals');
  const notes = (sessionId: string) =>
    f.store
      .kindEvents(f.project.id, ['lead.note_added'])
      .filter((event) => event.aggregate_id === sessionId)
      .map((event) => event.payload as LeadNote)
      .filter((note) => note.kind === 'agent_proposal');
  const wakes = (sessionId: string) =>
    f.turns(sessionId).filter((turn) => turn.origin === 'tracker');
  return { f, resident, assistant, as, refusal, proposals, notes, wakes };
}

it('records a pending proposal from the Assistant with its needs-you item and event, and refuses triage and a taken name', async () => {
  const { f, resident, assistant, as, refusal, proposals } = await proposalFixture();
  const listed = await as<{ agents: Pick<AgentProfile, 'name' | 'template' | 'tools'>[] }>(
    assistant,
    'agent.agents',
    {},
  );
  expect(listed.agents.map((agent) => [agent.template, agent.name]).sort()).toEqual([
    ['assistant', 'Assistant'],
    ['triage', 'Triage'],
  ]);
  expect(listed.agents.find((agent) => agent.template === 'assistant')!.tools).toContain('agents');

  const proposal = as<AgentProposal>(assistant, 'agent.propose', IDEAS);
  expect(proposals()).toEqual([
    {
      id: proposal.id,
      revision: 1,
      project_id: f.project.id,
      session_id: assistant.id,
      fields: IDEAS,
      state: 'pending',
      at: proposal.at,
    },
  ]);
  expect(proposal.at).toBeLessThanOrEqual(f.store.now());
  const [item] = f.control
    .needsYou(user, f.project.id)
    .items.filter((each) => each.kind === 'agent.proposal');
  expect(item).toMatchObject({
    source: { table: 'agent_proposals', id: proposal.id },
    session_id: assistant.id,
    reason: 'agent_proposal_awaiting_decision',
    agent_proposal: { id: proposal.id, name: 'Ideas', template: 'ideas' },
    actions: [{ command: 'agent.proposal.resolve', allowed: true }],
  });
  expect(item!.agent_proposal!.waited_ms).toBeGreaterThanOrEqual(0);
  expect(
    f.store
      .events(0, f.project.id, 1000, ['agent_proposal.created'])
      .map((event) => event.aggregate_id),
  ).toEqual([proposal.id]);

  const triage = resident('triage');
  expect(await refusal(() => as(triage, 'agent.propose', { ...IDEAS, name: 'Notes' }))).toBe(
    'permission_denied',
  );
  expect(await refusal(() => as(assistant, 'agent.propose', { ...IDEAS, name: 'Triage' }))).toBe(
    'invalid_input',
  );
  expect(proposals()).toHaveLength(1);
});

it('creates the proposed agent under the name the user edited, declines another, and tells the Assistant either way', async () => {
  const { f, assistant, as, proposals, notes, wakes } = await proposalFixture();
  const accepted = as<AgentProposal>(assistant, 'agent.propose', IDEAS);
  const created = f.call<AgentProposal>('agent.proposal.resolve', {
    proposal_id: accepted.id,
    decision: 'create',
    fields: { name: 'Idea box' },
  });
  const agent = f.control
    .agentList(user, f.project.id)
    .find((profile) => profile.name === 'Idea box')!;
  expect(agent).toMatchObject({
    template: 'ideas',
    role: 'Ideas',
    instructions: IDEAS_TEMPLATE.instructions,
    brief: IDEAS.brief,
    created_by: { kind: 'agent', session_id: assistant.id },
  });
  expect(created).toMatchObject({ state: 'created', result_agent_id: agent.id });
  expect(notes(assistant.id)).toHaveLength(1);
  expect(notes(assistant.id)[0]!.text).toContain('Idea box');
  expect(wakes(assistant.id)).toHaveLength(1);

  const declined = as<AgentProposal>(assistant, 'agent.propose', {
    ...IDEAS,
    name: 'Second ideas',
  });
  f.call('agent.proposal.resolve', { proposal_id: declined.id, decision: 'decline' });
  expect(proposals().find((each) => each.id === declined.id)).toMatchObject({
    state: 'declined',
  });
  expect(proposals().find((each) => each.id === declined.id)).not.toHaveProperty('result_agent_id');
  expect(notes(assistant.id)).toHaveLength(2);
  expect(notes(assistant.id)[1]!.text).toContain('declined');
  expect(
    f.store
      .events(0, f.project.id, 1000, ['agent_proposal.resolved'])
      .map((event) => event.aggregate_id),
  ).toEqual([accepted.id, declined.id]);
  expect(
    f.control.needsYou(user, f.project.id).items.filter((each) => each.kind === 'agent.proposal'),
  ).toEqual([]);
});
