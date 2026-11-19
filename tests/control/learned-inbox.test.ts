import { expect, it } from 'vitest';
import type {
  AgentProfile,
  AgentProposal,
  Improvement,
  MemoryContext,
  MemoryRecord,
  Principal,
  Project,
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
    kind: 'agent_instructions',
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
    revision: note.revision,
    diff: { from: '', to: 'Finance reads exports as CSV.' },
    evidence: [{ kind: 'session', id: assistant.id }],
    actions: [{ command: 'memory.archive' }],
  });
  expect(policy).not.toHaveProperty('revision');
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

it('names each item and the retrospective or session behind it, and gives a trial the tasks it needs', async () => {
  const f = await workbenchFixture();
  const assistant = f.call<Session>('resident.open', {
    project_id: f.project.id,
    kind: 'assistant',
  });
  const opened = f.store.must<Session>('sessions', assistant.id);
  f.store.update('sessions', { ...opened, title: 'Export questions' }, opened.revision);
  const resident: Principal = {
    id: `session:${assistant.id}`,
    role: 'lead',
    project_id: f.project.id,
    session_id: assistant.id,
    expires_at: f.store.now() + 60_000,
  };
  const helper = f.call<AgentProfile>('agent.create', {
    project_id: f.project.id,
    template: 'ideas',
    name: 'Ideas',
    role: 'Idea',
  });
  f.store.insert('board_plans', {
    id: 'lead-1',
    revision: 1,
    project_id: f.project.id,
    tasks: [{ id: 'task-1', title: 'Fix the CSV export', depends_on: [] }],
  } as any);
  f.store.insert('retrospectives', {
    id: 'retrospective-1',
    revision: 1,
    project_id: f.project.id,
    lead_session_id: 'lead-1',
    task_id: 'task-1',
    session_ids: [],
    outcome: 'merged',
    recorded_at: f.store.now(),
  });
  const improvement = (id: string, change: Improvement['change'], status = 'candidate') =>
    f.store.insert<Improvement>('improvements', {
      id,
      revision: 1,
      project_id: f.project.id,
      source: 'daemon',
      retrospective_ids: ['retrospective-1'],
      evidence: [{ kind: 'session', id: assistant.id }],
      status: status as Improvement['status'],
      change,
      proposed_at: f.store.now(),
      ...(status === 'trial' && { trial_started_at: f.store.now() }),
    });
  improvement('policy', { type: 'policy_change', param: 'max_parallel', from: 2, to: 3 }, 'trial');
  improvement('experience', {
    type: 'experience',
    procedure: 'Run the export tests first. Then open the file.',
  });
  improvement('gate', { type: 'gate_command', root: '/repo/app', to: [] });
  improvement('instructions', {
    type: 'agent_instructions',
    agent_id: helper.id,
    to: 'Plan weekly.',
  });
  improvement('playbook', { type: 'playbook', to: 2 });
  improvement('codex-playbook', { type: 'playbook', runtime: 'codex', to: 2 });
  const evalRuns = {
    kind: 'eval_receipt' as const,
    path: '/evals/playbook/runs.jsonl',
    sha256: '0'.repeat(64),
    verdict: 'playbook=2_passes_more',
  };
  f.store.insert<Improvement>('improvements', {
    id: 'tried-playbook',
    revision: 1,
    project_id: f.project.id,
    source: 'lead',
    retrospective_ids: [],
    evidence: [evalRuns],
    status: 'candidate',
    change: { type: 'playbook', runtime: 'claude', to: 2 },
    proposed_at: f.store.now(),
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
      title: 'Export format',
      text: 'Finance reads exports as CSV.',
      based_on: read.signature,
    },
    null,
    resident,
  );
  const proposal = f.call<AgentProposal>(
    'agent.propose',
    { project_id: f.project.id, agent_id: helper.id, role: 'Plan', instructions: 'Plan weekly.' },
    null,
    resident,
  );

  const items = f.control.learnedList(user, f.project.id);
  const titles = Object.fromEntries(items.map((item) => [item.id, item.title]));
  expect(titles).toMatchObject({
    [proposal.id]: 'Ideas',
    policy: 'max_parallel',
    experience: 'Run the export tests first.',
    gate: '/repo/app',
    instructions: 'Ideas',
    playbook: 'default',
    'codex-playbook': 'codex',
    [note.id]: 'Export format',
  });
  const policy = items.find((item) => item.id === 'policy')!;
  expect(policy.tasks_required).toBe(10);
  expect(policy.evidence).toEqual([
    { kind: 'retrospective', id: 'retrospective-1', title: 'Fix the CSV export' },
    { kind: 'session', id: assistant.id, title: 'Export questions' },
  ]);
  expect(items.find((item) => item.id === 'experience')!.tasks_required).toBeUndefined();
  expect(items.find((item) => item.id === 'tried-playbook')!.evidence).toEqual([
    { kind: 'eval_receipt', id: evalRuns.path, title: evalRuns.verdict },
  ]);
});

it('lists a proposal for several fields of an agent as an agent change and leaves out one for a removed agent', async () => {
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
  const ideas = f.call<AgentProfile>('agent.create', {
    project_id: f.project.id,
    template: 'ideas',
    name: 'Ideas',
    role: 'Idea',
  });
  const removed = f.call<AgentProfile>('agent.create', {
    project_id: f.project.id,
    template: 'ideas',
    name: 'Drafts',
    role: 'Idea',
  });
  const proposalFor = (agent: AgentProfile) =>
    f.call<AgentProposal>(
      'agent.propose',
      { project_id: f.project.id, agent_id: agent.id, role: 'Plan', instructions: 'Plan weekly.' },
      null,
      resident,
    );
  const kept = proposalFor(ideas);
  proposalFor(removed);
  f.store.remove('agents', removed.id, removed.revision);

  const items = f.control.learnedList(user, f.project.id);
  expect(items.map((item) => [item.kind, item.id])).toEqual([['agent_change', kept.id]]);
});

it("shows a gate change that waits for the user against the project's gate today", async () => {
  const f = await workbenchFixture();
  const root = f.project.roots[0]!;
  const gate = [{ name: 'test', argv: ['true'] }];
  const project = f.store.must<Project>('projects', f.project.id);
  f.store.update('projects', { ...project, gates: { [root]: gate } }, project.revision);
  f.store.insert<Improvement>('improvements', {
    id: 'gate',
    revision: 1,
    project_id: f.project.id,
    source: 'lead',
    retrospective_ids: [],
    status: 'candidate',
    change: { type: 'gate_command', root, to: [{ ...gate[0]!, skippable: true }] },
    proposed_at: f.store.now(),
  });

  const item = f.control.learnedList(user, f.project.id).find((i) => i.id === 'gate')!;
  expect(item.group).toBe('needs_you');
  expect(JSON.parse(item.diff.from)).toEqual(gate);
});
