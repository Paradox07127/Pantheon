import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  id,
  type AgentEvent,
  type Approval,
  type BoardPlan,
  type Principal,
  type Session,
  type SessionTurn,
  type WorkflowPolicy,
  type Workspace,
} from '@pantheon/domain';
import type { DecisionForUser } from '@pantheon/protocol';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { agentEvent } from '../../packages/control/dist/agent.js';
import { awaitWorkspaceReady, eventually, fixture, insertSession, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Plain = Awaited<ReturnType<typeof fixture>>;
type Caller = Pick<Plain, 'call' | 'store' | 'project' | 'control'>;

const plains: Plain[] = [];
afterEach(async () => {
  for (const f of plains.splice(0)) await f.close();
});

async function plain() {
  const f = await fixture({ managedWorkspaces: true });
  plains.push(f);
  return f;
}

const ctxOf = (f: Caller) => (f.control as unknown as { ctx: ControlContext }).ctx;

const leadOf = (f: Caller, sessionId: string): Principal => ({
  id: `session:${sessionId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60_000_000,
});

function setPolicy(f: Caller, input: Record<string, unknown>) {
  const row = f.store.get<WorkflowPolicy>('workflow_policies', f.project.id);
  f.call('workflow.policy.set', { project_id: f.project.id, ...input }, row?.revision ?? null);
}

const task: BoardPlan['tasks'][number] = {
  id: 'a',
  title: 'Task a',
  goal: 'Finish task a',
  lane: 'core',
  depends_on: [],
  source: ['Plan the export feature'],
  scope: ['src/a'],
  acceptance: ['pnpm test'],
};

/** A lead with a one-task plan and a worker of that task running a turn; prompt feeds it a runtime permission request. */
async function workerFixture(policy?: Record<string, unknown>) {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await awaitWorkspaceReady(f.control, lead.workspace_id!);
  await eventually(
    () => f.turns(lead.id).every((turn) => turn.state === 'completed'),
    () => f.control.tick(),
  );
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [task],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    leadOf(f, lead.id),
  );
  if (policy) setPolicy(f, policy);
  vi.spyOn(f.adapter, 'send').mockImplementation(async (_handle, turn) => ({
    turn_id: turn.turn_id,
    status: 'delivered',
  }));
  vi.spyOn(f.adapter, 'answerPermission').mockResolvedValue({ ok: true });
  const worker = await f.call<Promise<Session>>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Build it',
    task_id: `${lead.id}:${task.id}`,
  });
  await awaitWorkspaceReady(f.control, worker.workspace_id!);
  const turn: SessionTurn = f.turns(worker.id)[0]!;
  await eventually(
    () =>
      f.control.handles.has(turn.id) &&
      f.store.must<Session>('sessions', worker.id).state === 'running',
    () => f.control.tick(),
  );
  const worktree = f.store.must<Workspace>('workspaces', worker.workspace_id!).path;
  let sequence = 100;
  const prompt = async (name: string, extra: Partial<AgentEvent> = {}) => {
    sequence++;
    agentEvent(ctxOf(f), worker.id, {
      key: `prompt-${sequence}`,
      provider_sequence: sequence,
      turn_id: turn.id,
      kind: 'permission.requested',
      request_id: `request-${sequence}`,
      tool: 'Edit',
      detail: {
        input: { file_path: `${worktree}/src/${name}.ts`, old_string: 'a', new_string: 'b' },
      },
      ...extra,
    } as AgentEvent);
    await f.control.tick();
    return f.store.list<Approval>('approvals').at(-1)!;
  };
  return { f, lead, worker, prompt };
}

/** A lead named lead whose plan has task api under milestone release. */
function leadWithPlan(f: Plain): Principal {
  insertSession(f, { id: 'lead', turn_count: 1 });
  f.store.insert('session_turns', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    session_id: 'lead',
    input: 'Ship the export API this week.',
    kind: 'send',
    delivery: 'delivered',
    state: 'completed',
  });
  const lead = leadOf(f, 'lead');
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
    lead,
  );
  return lead;
}

async function proposed(planChanges: 'auto' | 'confirm') {
  const f = await plain();
  setPolicy(f, { plan_changes: planChanges });
  const lead = leadWithPlan(f);
  const plan = f.store.must<BoardPlan>('board_plans', 'lead');
  f.call(
    'board.plan.propose',
    {
      project_id: f.project.id,
      base_version: plan.plan_version,
      reason: 'The export needs a narrower contract',
      ops: [{ type: 'set_task', task_id: 'api', patch: { title: 'Export API' } }],
    },
    null,
    lead,
  );
  return {
    f,
    match: {
      power: 'plan_change',
      subject: plan.id,
      session_id: 'lead',
      reason: 'The export needs a narrower contract',
    },
  };
}

const mergeReason = 'The README names the new module';

function commit(repository: string, name: string, contents: string) {
  mkdirSync(path.dirname(path.join(repository, name)), { recursive: true });
  writeFileSync(path.join(repository, name), contents);
  git(repository, 'add', '--', name);
  git(repository, 'commit', '--quiet', '-m', `Update ${name}`);
}

/** A lead that merges its task's session whose merge stopped on a file outside the task's scope. */
async function mergedOutOfScope() {
  const f = await workbenchFixture();
  git(f.source, 'config', 'user.name', 'Source User');
  git(f.source, 'config', 'user.email', 'source@example.invalid');
  setPolicy(f, { charter: { merge_out_of_scope: 'on' } });
  const current = (sessionId: string) => f.store.must<Session>('sessions', sessionId);
  const lead = await f.create('Plan the export feature');
  await awaitWorkspaceReady(f.control, lead.workspace_id!);
  await eventually(
    () => f.turns(lead.id).every((turn) => turn.state === 'completed'),
    () => f.control.tick(),
  );
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [task],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    leadOf(f, lead.id),
  );
  const session = await f.call<Promise<Session>>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Build it',
    task_id: `${lead.id}:${task.id}`,
  });
  const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.turns(session.id).every((turn) => turn.state === 'completed') &&
      current(session.id).state === 'open',
    () => f.control.tick(),
  );
  commit(workspace.path, 'src/a/x.ts', 'export const x = 1;\n');
  commit(workspace.path, 'README.md', 'Names the new module\n');
  await f.call('session.merge', { session_id: session.id }, current(session.id).revision);
  await eventually(
    () => current(session.id).merge?.state === 'blocked',
    () => f.control.tick(),
    10000,
  );
  await f.call(
    'session.merge',
    { project_id: f.project.id, task_id: task.id, allow_out_of_scope: true, reason: mergeReason },
    null,
    leadOf(f, lead.id),
  );
  return {
    f,
    match: {
      power: 'merge_out_of_scope',
      subject: session.id,
      session_id: lead.id,
      reason: mergeReason,
    },
  };
}

const formatQuestion = 'Which format should the export use?';
const citations = [{ kind: 'user_words', ref: 'Plan the export feature' }];

/** A worker's question relayed to its lead's board; answer lets the lead answer it. */
async function questionFixture() {
  const { f, lead, worker, prompt } = await workerFixture();
  const approval = await prompt('question', {
    tool: 'AskUserQuestion',
    detail: {
      questions: [
        {
          question: formatQuestion,
          header: 'Format',
          options: [
            { label: 'CSV', description: 'Plain rows' },
            { label: 'JSON', description: 'Nested records' },
          ],
          multiSelect: false,
        },
      ],
    },
  });
  const card = f.store
    .must<BoardPlan>('board_plans', lead.id)
    .questions!.find((entry) => entry.source?.approval_id === approval.id)!;
  const answer = () =>
    f.call(
      'lead.worker_question.answer',
      {
        project_id: f.project.id,
        question_id: card.id,
        answers: { [formatQuestion]: 'CSV' },
        citations,
      },
      null,
      leadOf(f, lead.id),
    );
  const match = {
    lead_session_id: lead.id,
    question_id: card.id,
    session_id: worker.id,
    question: formatQuestion,
    answer: 'CSV',
    citations,
  };
  return { f, lead, card, answer, match };
}

type Act = () => Promise<{ f: Caller; match: Record<string, unknown> }>;

const personal: Principal = { id: 'personal:k1', role: 'personal' };
const leadQuestion = 'Which file format comes first?';
const proposalReason = 'The export needs a narrower contract';

/** What by did in a project whose lead has a plan, with the personal key let to answer every kind. */
const answeredBy =
  (by: Principal, act: (f: Plain, by: Principal) => Record<string, unknown>): Act =>
  async () => {
    const userConfigDir = mkdtempSync(path.join(os.tmpdir(), 'pantheon-decisions-'));
    const f = await fixture({ managedWorkspaces: true, controlOptions: { userConfigDir } });
    plains.push({
      ...f,
      close: async () => {
        await f.close();
        rmSync(userConfigDir, { recursive: true, force: true });
      },
    });
    f.call('app.settings.set', {
      personal_answers: ['question', 'plan_change', 'milestone_accept'],
    });
    setPolicy(f, { plan_changes: 'confirm' });
    leadWithPlan(f);
    return { f, match: act(f, by) };
  };

function answerLeadQuestion(f: Plain, by: Principal) {
  const question = f.call<{ id: string }>(
    'lead.ask',
    {
      project_id: f.project.id,
      question: leadQuestion,
      options: ['CSV', 'JSON'],
      recommended: 'CSV',
      assumption: 'CSV comes first',
      blocks: ['api'],
    },
    null,
    leadOf(f, 'lead'),
  ).id;
  f.call(
    'lead.question.answer',
    { project_id: f.project.id, lead_session_id: 'lead', question_id: question, answer: 'CSV' },
    null,
    by,
  );
  return {
    key_id: 'k1',
    command: 'lead.question.answer',
    subject: question,
    lead_session_id: 'lead',
    text: leadQuestion,
    decision: 'CSV',
  };
}

const resolveProposal = (decision: 'accept' | 'reject') => (f: Plain, by: Principal) => {
  const proposal = f.call<{ proposal_id: string }>(
    'board.plan.propose',
    {
      project_id: f.project.id,
      base_version: f.store.must<BoardPlan>('board_plans', 'lead').plan_version,
      reason: proposalReason,
      ops: [{ type: 'set_task', task_id: 'api', patch: { title: 'Export API' } }],
    },
    null,
    leadOf(f, 'lead'),
  ).proposal_id;
  f.call(
    'board.plan.proposal.resolve',
    {
      project_id: f.project.id,
      lead_session_id: 'lead',
      proposal_id: proposal,
      decision,
      reason: 'Keeps the contract small',
    },
    null,
    by,
  );
  return {
    key_id: 'k1',
    command: 'board.plan.proposal.resolve',
    subject: proposal,
    lead_session_id: 'lead',
    text: proposalReason,
    decision: decision === 'accept' ? 'accepted' : 'rejected',
    reason: 'Keeps the contract small',
  };
};

it.each<[string, Act, DecisionForUser['kind'] | undefined]>([
  [
    'a worker prompt approved for the lead',
    async () => {
      const { f, lead, worker, prompt } = await workerFixture();
      const approval = await prompt('a');
      return {
        f,
        match: {
          approval_id: approval.id,
          decided_by: `session:${lead.id}`,
          session_id: worker.id,
          tool: 'Edit',
          input_summary: expect.stringContaining('src/a.ts'),
        },
      };
    },
    'prompt_approved',
  ],
  [
    'a prompt answered by a stored project rule',
    async () => {
      const { f, worker, prompt } = await workerFixture();
      f.call('permission.rule.add', {
        project_id: f.project.id,
        rule: 'Edit',
        session_id: worker.id,
      });
      const approval = await prompt('a', { project_rule_supported: true });
      return {
        f,
        match: { approval_id: approval.id, rule: 'Edit', session_id: worker.id, tool: 'Edit' },
      };
    },
    'prompt_by_rule',
  ],
  ['a plan proposal applied with plan changes on auto', () => proposed('auto'), 'power_used'],
  ['a merge of files outside the task scope', mergedOutOfScope, 'power_used'],
  ['a plan proposal while plan changes need confirming', () => proposed('confirm'), undefined],
  [
    'a task session question the lead answered',
    async () => {
      const { f, answer, match } = await questionFixture();
      answer();
      return { f, match };
    },
    'question_answered',
  ],
  [
    'a lead answer the user overruled',
    async () => {
      const { f, lead, card, answer, match } = await questionFixture();
      answer();
      f.call('lead.question.overrule', {
        project_id: f.project.id,
        lead_session_id: lead.id,
        question_id: card.id,
        answer: 'JSON',
      });
      return { f, match: { ...match, overruled: { answer: 'JSON', at: expect.any(Number) } } };
    },
    'question_answered',
  ],
  [
    'a task session question the user answered',
    async () => {
      const { f, lead, card } = await questionFixture();
      f.call('lead.question.answer', {
        project_id: f.project.id,
        lead_session_id: lead.id,
        question_id: card.id,
        answer: 'CSV',
      });
      return { f, match: {} };
    },
    undefined,
  ],
  [
    "the lead's question the personal key answered",
    answeredBy(personal, answerLeadQuestion),
    'personal_answer',
  ],
  [
    'a plan proposal the personal key accepted',
    answeredBy(personal, resolveProposal('accept')),
    'personal_answer',
  ],
  [
    'a plan proposal the personal key rejected',
    answeredBy(personal, resolveProposal('reject')),
    'personal_answer',
  ],
  [
    'the personal key marking the project seen',
    answeredBy(personal, (f, by) => {
      f.call('project.seen', { project_id: f.project.id }, null, by);
      return {};
    }),
    undefined,
  ],
  ["the lead's question the user answered", answeredBy(user, answerLeadQuestion), undefined],
  ['a plan proposal the user accepted', answeredBy(user, resolveProposal('accept')), undefined],
])('lists what %s decided', async (_label, act, kind) => {
  const { f, match } = await act();
  const { items } = f.control.decisionsForUser(user, f.project.id);
  expect(items).toEqual(kind ? [expect.objectContaining({ kind, ...match })] : []);
  if (kind) expect(items[0]!.at).toBeGreaterThan(0);
  if (kind === 'power_used' && !('reason' in match)) expect(items[0]).not.toHaveProperty('reason');
});

it('drops the decisions made before since and lists the rest newest first', async () => {
  const { f, prompt } = await workerFixture();
  const first = await prompt('a');
  await eventually(() => f.store.now() > first.created_at);
  const since = f.store.now();
  const second = await prompt('b');
  const ids = (since?: number) =>
    f.control
      .decisionsForUser(user, f.project.id, since)
      .items.map((item) => (item as { approval_id: string }).approval_id);
  expect(ids()).toEqual([second.id, first.id]);
  expect(ids(since)).toEqual([second.id]);
});

it('refuses a principal of another project', async () => {
  const f = await plain();
  const stranger = { ...leadWithPlan(f), project_id: 'another-project' };
  expect(() => f.control.decisionsForUser(stranger, f.project.id)).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
});

it('lists no row for a prompt the user approved', async () => {
  const { f, prompt } = await workerFixture({ charter: { approve_worker_prompts: 'ask' } });
  const approval = await prompt('a');
  expect(approval).toMatchObject({ state: 'pending', decider: 'user' });
  f.call('approval.respond', { approval_id: approval.id, decision: 'approve' }, approval.revision);
  await f.control.tick();
  expect(f.store.must<Approval>('approvals', approval.id).state).toBe('approved');
  expect(f.control.decisionsForUser(user, f.project.id).items).toEqual([]);
});

it('keeps the row of a prompt whose approval left with its deleted session', async () => {
  const { f, lead, prompt } = await workerFixture();
  const approval = await prompt('a');
  const settled = f.store.must<Approval>('approvals', approval.id);
  f.store.remove('approvals', settled.id, settled.revision);
  expect(f.control.decisionsForUser(user, f.project.id).items).toEqual([
    expect.objectContaining({
      kind: 'prompt_approved',
      approval_id: approval.id,
      decided_by: `session:${lead.id}`,
    }),
  ]);
});
