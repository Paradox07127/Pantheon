import { expect, it } from 'vitest';
import type {
  AgentProfile,
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

it('lists a policy trial, a workflow trial and an agent note, each with its diff and group', async () => {
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
  expect(items).toHaveLength(3);
  const [memory, policy, workflow] = items;
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

  const items = f.control.learnedList(user, f.project.id);
  const titles = Object.fromEntries(items.map((item) => [item.id, item.title]));
  expect(titles).toMatchObject({
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

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

it.each<[string, (f: Fixture) => { change: Improvement['change']; today: unknown }]>([
  [
    "the project's gate",
    (f) => {
      const root = f.project.roots[0]!;
      const gate = [{ name: 'test', argv: ['true'] }];
      const project = f.store.must<Project>('projects', f.project.id);
      f.store.update('projects', { ...project, gates: { [root]: gate } }, project.revision);
      return {
        change: { type: 'gate_command', root, to: [{ ...gate[0]!, skippable: true }] },
        today: gate,
      };
    },
  ],
  [
    "the project's worktree setup",
    (f) => {
      const worktree = { copy_paths: ['.env'], command: { argv: ['pnpm', 'install'] } };
      const project = f.store.must<Project>('projects', f.project.id);
      f.store.update('projects', { ...project, worktree }, project.revision);
      return {
        change: { type: 'worktree_setup', to: { ...worktree, copy_paths: ['.env', '.npmrc'] } },
        today: worktree,
      };
    },
  ],
  [
    "the agent's instructions",
    (f) => {
      const ideas = f.call<AgentProfile>('agent.create', {
        project_id: f.project.id,
        template: 'ideas',
        name: 'Ideas',
        role: 'Idea',
      });
      f.call('agent.update', {
        agent_id: ideas.id,
        revision: ideas.revision,
        instructions: 'Plan monthly.',
      });
      return {
        change: { type: 'agent_instructions', agent_id: ideas.id, to: 'Plan weekly.' },
        today: 'Plan monthly.',
      };
    },
  ],
])('shows a change that waits for the user against %s today', async (_, arrange) => {
  const f = await workbenchFixture();
  const { change, today } = arrange(f);
  f.store.insert<Improvement>('improvements', {
    id: 'waiting',
    revision: 1,
    project_id: f.project.id,
    source: 'lead',
    retrospective_ids: [],
    status: 'candidate',
    change,
    proposed_at: f.store.now(),
  });

  const item = f.control.learnedList(user, f.project.id).find((i) => i.id === 'waiting')!;
  expect(item.group).toBe('needs_you');
  expect(typeof today === 'string' ? item.diff.from : JSON.parse(item.diff.from)).toEqual(today);
});

it.each<[string, Improvement['change'], LearnedItem['scope']]>([
  ['a gate command', { type: 'gate_command', root: '/repo/app', to: [] }, { root: '/repo/app' }],
  [
    'a policy change',
    { type: 'policy_change', param: 'path', tier: 't2', from: 'direct', to: 'dispatch' },
    { tier: 't2' },
  ],
  [
    'an experience',
    {
      type: 'experience',
      domain: 'frontend-ui',
      tier: 't1',
      runtime: 'codex',
      procedure: 'Run the export tests first.',
    },
    { domain: 'frontend-ui', tier: 't1', runtime: 'codex' },
  ],
])('gives %s the scope it changes', async (_, change, scope) => {
  const f = await workbenchFixture();
  f.store.insert<Improvement>('improvements', {
    id: 'scoped',
    revision: 1,
    project_id: f.project.id,
    source: 'lead',
    retrospective_ids: [],
    status: 'candidate',
    change,
    proposed_at: f.store.now(),
  });

  const item = f.control.learnedList(user, f.project.id).find((i) => i.id === 'scoped')!;
  expect(item.scope).toEqual(scope);
});

it('gives a runtime review the revision of its memory record', async () => {
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
  const read = f.call<MemoryContext>(
    'memory.context',
    { project_id: f.project.id },
    null,
    resident,
  );
  const review = f.call<MemoryRecord>(
    'memory.propose',
    {
      project_id: f.project.id,
      key: 'runtime-review',
      kind: 'note',
      text: 'Codex stalls on long installs.',
      based_on: read.signature,
    },
    null,
    resident,
  );
  const session = f.store.must<Session>('sessions', assistant.id);
  f.store.update(
    'sessions',
    { ...session, runtime_review: { memory_id: review.id } } as Session,
    session.revision,
  );

  const item = f.control.learnedList(user, f.project.id).find((i) => i.kind === 'runtime_review')!;
  expect(item.revision).toBe(review.revision);
});
