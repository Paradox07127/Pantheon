import { afterEach, expect, it } from 'vitest';
import { id } from '@pantheon/domain';
import type {
  Approval,
  ApprovalQuestion,
  BoardPlan,
  Improvement,
  Milestone,
  Principal,
  Retrospective,
  WorkflowPolicy,
} from '@pantheon/domain';
import { fixture, insertSession, user } from '../helpers.js';

type Fixture = ReturnType<typeof fixture>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

const REQUEST = 'Ship the export API this week.';

function opened() {
  const f = fixture({ managedWorkspaces: true });
  fixtures.push(f);
  return f;
}

const principalOf = (f: Fixture, sessionId: string): Principal => ({
  id: `session:${sessionId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});

const items = (f: Fixture) => f.control.needsYou(user, f.project.id).items;

/** A lead whose plan has task api under milestone release. */
function leadWithMilestone(f: Fixture) {
  insertSession(f, { id: 'lead', turn_count: 1 });
  f.store.insert('session_turns', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    session_id: 'lead',
    input: REQUEST,
    kind: 'send',
    delivery: 'delivered',
    state: 'completed',
  });
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [
        {
          id: 'api',
          title: 'API',
          goal: 'Serve exports',
          lane: 'core',
          depends_on: [],
          source: ['Ship the export API'],
          scope: [],
          acceptance: [],
          done_when: 'report',
          milestone: 'release',
        },
      ],
      milestones: [
        { id: 'release', title: 'Release', criteria: ['Exports download'], tasks: ['api'] },
      ],
      risks: [],
      assumptions: [],
    },
    null,
    principalOf(f, 'lead'),
  );
  return f.store.list<Milestone>('milestones').find((row) => row.key === 'release')!;
}

it('gives a question item its questions and options', () => {
  const f = opened();
  insertSession(f, { id: 'asker', turn_count: 1 });
  const questions: ApprovalQuestion[] = [
    {
      question: 'Which format?',
      header: 'Format',
      options: [
        { label: 'CSV', description: 'Opens in spreadsheets' },
        { label: 'JSON', description: 'Keeps nested fields' },
      ],
      multiSelect: false,
    },
    {
      question: 'Which columns?',
      header: 'Columns',
      options: [
        { label: 'Name', description: 'The row name' },
        { label: 'Size', description: 'The file size' },
      ],
      multiSelect: true,
    },
  ];
  f.store.insert<Approval>('approvals', {
    id: 'ask',
    revision: 1,
    project_id: f.project.id,
    kind: 'permission',
    session_id: 'asker',
    request_id: 'request',
    tool: 'AskUserQuestion',
    input_hash: 'hash',
    decider: 'user',
    state: 'pending',
    created_at: f.store.now(),
    questions,
  });
  expect(items(f).find((item) => item.source.id === 'ask')?.questions).toEqual(questions);
});

it('lists a task session question relayed to its lead board once, as the board question', () => {
  const f = opened();
  leadWithMilestone(f);
  insertSession(f, { id: 'asker', turn_count: 1 });
  const questions: ApprovalQuestion[] = [
    {
      question: 'Which format?',
      header: 'Format',
      options: [
        { label: 'CSV', description: 'Opens in spreadsheets' },
        { label: 'JSON', description: 'Keeps nested fields' },
      ],
      multiSelect: false,
    },
  ];
  f.store.insert<Approval>('approvals', {
    id: 'ask',
    revision: 1,
    project_id: f.project.id,
    kind: 'permission',
    session_id: 'asker',
    request_id: 'request',
    tool: 'AskUserQuestion',
    input_hash: 'hash',
    decider: 'user',
    state: 'pending',
    created_at: f.store.now(),
    questions,
  });
  const plan = f.store.must<BoardPlan>('board_plans', 'lead');
  f.store.update<BoardPlan>(
    'board_plans',
    {
      ...plan,
      questions: [
        {
          id: 'relayed',
          at: f.store.now(),
          question: 'Which format?',
          options: ['CSV', 'JSON'],
          recommended: '',
          assumption: '',
          blocks: ['api'],
          source: { session_id: 'asker', approval_id: 'ask' },
          questions,
        },
      ],
    },
    plan.revision,
  );
  expect(
    items(f)
      .filter((item) => item.source.id === 'ask' || String(item.kind) === 'lead.question')
      .map((item) => [item.kind, item.request_id]),
  ).toEqual([['lead.question', 'relayed']]);
});

it('lists a lead milestone ready for acceptance until the user accepts it', () => {
  const f = opened();
  const milestone = leadWithMilestone(f);
  const milestoneItems = () => items(f).filter((item) => item.source.table === 'milestones');
  expect(milestoneItems()).toEqual([]);

  const plan = f.store.must<BoardPlan>('board_plans', 'lead');
  f.store.update<BoardPlan>(
    'board_plans',
    {
      ...plan,
      accepted: { api: { at: f.store.now(), evidence: 'The report answers it', generation: 1 } },
    },
    plan.revision,
  );
  expect(milestoneItems()).toEqual([
    expect.objectContaining({
      source: { table: 'milestones', id: milestone.id, revision: milestone.revision },
      project_id: f.project.id,
      session_id: 'lead',
      status: 'ready_for_acceptance',
      actions: [{ command: 'milestone.accept', allowed: true }],
    }),
  ]);

  f.call(
    'milestone.accept',
    { milestone_id: milestone.id, evidence_refs: ['task:api'] },
    f.store.must<Milestone>('milestones', milestone.id).revision,
  );
  expect(milestoneItems()).toEqual([]);
});

function withRetrospectives(f: Fixture) {
  insertSession(f, { id: 'lead', turn_count: 1 });
  for (const index of [1, 2])
    f.store.insert<Retrospective>('retrospectives', {
      id: `retrospective-${index}`,
      revision: 1,
      project_id: f.project.id,
      lead_session_id: 'lead',
      task_id: `task-${index}`,
      session_ids: [],
      outcome: 'merged',
      recorded_at: index,
    });
}

const propose = (f: Fixture, change: Record<string, unknown>) =>
  f.call<Improvement>(
    'improvement.propose',
    {
      project_id: f.project.id,
      retrospective_ids: ['retrospective-1', 'retrospective-2'],
      change,
    },
    null,
    principalOf(f, 'lead'),
  );

const improvementItems = (f: Fixture) =>
  items(f).filter((item) => item.source.table === 'improvements');

it('lists an improvement that waits for the user until the user confirms it', () => {
  const f = opened();
  withRetrospectives(f);
  const row = f.store.get<WorkflowPolicy>('workflow_policies', f.project.id);
  f.call(
    'workflow.policy.set',
    { project_id: f.project.id, improvement_mode: 'confirm' },
    row?.revision ?? null,
  );
  const improvement = propose(f, { type: 'policy_change', param: 'max_parallel', to: 2 });
  expect(improvement.status).toBe('candidate');
  expect(improvementItems(f)).toEqual([
    expect.objectContaining({
      source: { table: 'improvements', id: improvement.id, revision: improvement.revision },
      project_id: f.project.id,
      session_id: 'lead',
      status: 'candidate',
      actions: [{ command: 'improvement.decide', allowed: true }],
    }),
  ]);
  f.call('improvement.decide', {
    project_id: f.project.id,
    improvement_id: improvement.id,
    decision: 'confirm',
  });
  expect(improvementItems(f)).toEqual([]);
});

it('lists no item for the improvements auto mode tries at once', () => {
  const f = opened();
  withRetrospectives(f);
  expect(propose(f, { type: 'policy_change', param: 'max_parallel', to: 2 }).status).toBe('trial');
  expect(propose(f, { type: 'policy_change', param: 'handback_limit', to: 4 }).status).toBe(
    'trial',
  );
  expect(improvementItems(f)).toEqual([]);
});
