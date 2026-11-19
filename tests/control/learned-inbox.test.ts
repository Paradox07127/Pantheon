import { expect, it } from 'vitest';
import type {
  AgentProfile,
  AgentProposal,
  Improvement,
  MemoryContext,
  MemoryRecord,
  Principal,
  Session,
} from '@pantheon/domain';
import type { LearnedItem } from '@pantheon/protocol';
import { user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

const empty = () => ({
  slots: { before_dispatch: [], before_merge: [], after_merge: [] },
  plan_review: { tiers: ['t3'] },
  review: { max_rounds: 3 },
});

it('lists a policy trial, an agent change, a workflow trial and an agent note, each with its diff and group', async () => {
  const f = await workbenchFixture();
  const assistant = f.call<Session>('resident.open', {
    project_id: f.project.id,
    kind: 'assistant',
  });
  const resident: Principal = {
    id: `session:${assistant.id}`,
    role: 'lead',
    project_id: f.project.id,
    session_id: assistant.id,
    expires_at: f.store.now() + 60_000,
  };
  const assistantProfile = f.store
    .list<AgentProfile>('agents')
    .find((agent) => agent.project_id === f.project.id && agent.template === 'assistant')!;
  const profile = f.call<AgentProfile>('agent.update', {
    agent_id: assistantProfile.id,
    revision: assistantProfile.revision,
    instructions: 'Answer with the reasons.',
  });

  f.store.insert<Improvement>('improvements', {
    id: 'policy-trial',
    revision: 1,
    project_id: f.project.id,
    source: 'daemon',
    retrospective_ids: ['retrospective-1', 'retrospective-2'],
    status: 'trial',
    change: { type: 'policy_change', param: 'max_parallel', from: 2, to: 3 },
    proposed_at: f.store.now(),
    trial_started_at: f.store.now(),
  });
  const proposal = f.call<AgentProposal>(
    'agent.propose',
    { project_id: f.project.id, agent_id: profile.id, instructions: 'Answer in one line.' },
    null,
    resident,
  );
  f.call('workflow.definition.set', {
    project_id: f.project.id,
    definition: {
      ...empty(),
      slots: {
        ...empty().slots,
        before_merge: [{ id: 'signoff', title: 'Sign off', kind: { type: 'approval' } }],
      },
    },
    base_version: 0,
    trial_tasks: 2,
  });
  const read = f.call<MemoryContext>(
    'memory.context',
    { project_id: f.project.id },
    null,
    resident,
  );
  const note = f.call<MemoryRecord>(
    'memory.propose',
    {
      project_id: f.project.id,
      key: 'export-format',
      kind: 'note',
      text: 'Finance reads exports as CSV.',
      based_on: read.signature,
    },
    null,
    resident,
  );

  const items = f.control
    .learnedList(user, f.project.id)
    .sort((a: LearnedItem, b: LearnedItem) => a.kind.localeCompare(b.kind));
  expect(items).toHaveLength(4);
  const [agent, memory, policy, workflow] = items;
  expect(agent).toMatchObject({
    kind: 'agent_change',
    id: proposal.id,
    grade: 'confirm',
    status: 'pending',
    group: 'needs_you',
    diff: { from: 'Answer with the reasons.', to: 'Answer in one line.' },
    evidence: [{ kind: 'session', id: assistant.id }],
    actions: [
      { command: 'agent.proposal.resolve', decision: 'create' },
      { command: 'agent.proposal.resolve', decision: 'decline' },
    ],
  });
  expect(memory).toMatchObject({
    kind: 'memory_note',
    id: note.id,
    grade: 'auto',
    status: 'active',
    group: 'in_force',
    diff: { from: '', to: 'Finance reads exports as CSV.' },
    evidence: [{ kind: 'session', id: assistant.id }],
    actions: [{ command: 'memory.archive' }],
  });
  expect(policy).toMatchObject({
    kind: 'policy_change',
    id: 'policy-trial',
    grade: 'trial',
    status: 'trial',
    group: 'on_trial',
    diff: { from: '2', to: '3' },
    evidence: [
      { kind: 'retrospective', id: 'retrospective-1' },
      { kind: 'retrospective', id: 'retrospective-2' },
    ],
    n: 0,
    actions: [
      { command: 'improvement.decide', decision: 'revert' },
      { command: 'improvement.decide', decision: 'pin' },
    ],
  });
  expect(workflow).toMatchObject({
    kind: 'workflow_definition',
    id: f.project.id,
    grade: 'trial',
    status: 'trial',
    group: 'on_trial',
    n: 0,
    actions: [],
  });
  expect(JSON.parse(workflow!.diff.from)).toEqual(empty());
  expect(JSON.parse(workflow!.diff.to).slots.before_merge).toEqual([
    { id: 'signoff', title: 'Sign off', kind: { type: 'approval' } },
  ]);
});
