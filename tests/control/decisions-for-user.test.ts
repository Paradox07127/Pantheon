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
import { workbenchFixture } from './workbench-fixture.js';

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
  return { f, match: { power: 'plan_change', subject: plan.id, session_id: 'lead' } };
}

type Act = () => Promise<{ f: Caller; match: Record<string, unknown> }>;

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
  [
    'a milestone accepted by the lead',
    async () => {
      const f = await plain();
      const lead = leadWithPlan(f);
      const plan = f.store.must<BoardPlan>('board_plans', 'lead');
      f.store.update<BoardPlan>(
        'board_plans',
        {
          ...plan,
          accepted: {
            api: { at: f.store.now(), evidence: 'The report answers it', generation: 1 },
          },
        },
        plan.revision,
      );
      f.call(
        'milestone.accept',
        { milestone_id: 'release', evidence_refs: ['task:api'] },
        null,
        lead,
      );
      return { f, match: { power: 'accept_milestone', session_id: 'lead' } };
    },
    'power_used',
  ],
  ['a plan proposal while plan changes need confirming', () => proposed('confirm'), undefined],
])('lists what %s decided', async (_label, act, kind) => {
  const { f, match } = await act();
  const { items } = f.control.decisionsForUser(user, f.project.id);
  expect(items).toEqual(kind ? [expect.objectContaining({ kind, ...match })] : []);
  if (kind) expect(items[0]!.at).toBeGreaterThan(0);
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
