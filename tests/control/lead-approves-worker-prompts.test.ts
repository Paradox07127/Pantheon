import { expect, it, vi } from 'vitest';
import type {
  AgentEvent,
  Approval,
  BoardPlan,
  LeadNote,
  Principal,
  Session,
  SessionTurn,
  WorkflowPolicy,
  Workspace,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { agentEvent } from '../../packages/control/dist/agent.js';
import { awaitWorkspaceReady, eventually, settle, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
type PlanTask = BoardPlan['tasks'][number];

const ctxOf = (f: Fixture) => (f.control as unknown as { ctx: ControlContext }).ctx;

const leadOf = (f: Fixture, sessionId: string): Principal => ({
  id: `session:${sessionId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});

const task: PlanTask = {
  id: 'a',
  title: 'Task a',
  goal: 'Finish task a',
  lane: 'core',
  depends_on: [],
  source: ['Plan the export feature'],
  scope: ['src/a'],
  acceptance: ['pnpm test'],
};

function setPolicy(f: Fixture, input: Record<string, unknown>) {
  const row = f.store.get<WorkflowPolicy>('workflow_policies', f.project.id);
  f.call('workflow.policy.set', { project_id: f.project.id, ...input }, row?.revision ?? null);
}

/** Runs a session's first turn until the runtime took it; the turn then stays running. */
async function running(f: Fixture, session: Session) {
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  const turn = f.turns(session.id)[0]!;
  await eventually(
    () =>
      f.control.handles.has(turn.id) &&
      f.store.must<Session>('sessions', session.id).state === 'running',
    () => f.control.tick(),
  );
  return { turn, handle: f.control.handles.get(turn.id)! };
}

/** A lead with a one-task plan and a worker of that task running a turn. */
async function workerFixture(policy?: Record<string, unknown>) {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
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
  const answer = vi.spyOn(f.adapter, 'answerPermission').mockResolvedValue({ ok: true });
  const worker = await f.call<Promise<Session>>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Build it',
    task_id: `${lead.id}:${task.id}`,
  });
  const { turn, handle } = await running(f, worker);
  const worktree = f.store.must<Workspace>('workspaces', worker.workspace_id!).path;
  return { f, lead, worker, worktree, answer, handle, prompt: prompter(f, worker, turn) };
}

/** Feeds the session's runtime permission requests into the daemon; returns the stored request. */
function prompter(f: Fixture, session: Session, turn: SessionTurn) {
  let sequence = 100;
  return (tool: string, detail: unknown, extra: Partial<AgentEvent> = {}) => {
    sequence++;
    agentEvent(ctxOf(f), session.id, {
      key: `prompt-${sequence}`,
      provider_sequence: sequence,
      turn_id: turn.id,
      kind: 'permission.requested',
      request_id: `request-${sequence}`,
      tool,
      detail,
      ...extra,
    } as AgentEvent);
    return f.store.list<Approval>('approvals').at(-1)!;
  };
}

const requestItem = (f: Fixture, approvalId: string) =>
  f.control
    .needsYou(user, f.project.id)
    .items.find((item) => item.source.table === 'approvals' && item.source.id === approvalId);

const powerUses = (f: Fixture) =>
  f.store
    .kindEvents(f.project.id, ['charter.power_used'])
    .filter((event) => (event.payload as { power: string }).power === 'approve_worker_prompts');

const approvedNotes = (f: Fixture, leadId: string) =>
  f.store
    .must<BoardPlan>('board_plans', leadId)
    .inbox.filter((note: LeadNote) => note.kind === 'prompts_approved');

const trackerTurns = (f: Fixture, leadId: string) =>
  f.turns(leadId).filter((turn) => turn.origin === 'tracker').length;

const question = {
  questions: [
    {
      question: 'Which format should the export use?',
      header: 'Format',
      options: [
        { label: 'CSV', description: 'Plain rows' },
        { label: 'JSON', description: 'Nested records' },
      ],
      multiSelect: false,
    },
  ],
};

it.each([
  [
    'an edit inside the worktree under the default charter',
    undefined,
    'Edit',
    { input: { file_path: '{worktree}/src/a.ts', old_string: 'a', new_string: 'b' } },
    'lead',
  ],
  [
    'an edit while the charter asks the user first',
    { charter: { approve_worker_prompts: 'ask' } },
    'Edit',
    { input: { file_path: '{worktree}/src/a.ts', old_string: 'a', new_string: 'b' } },
    'user',
  ],
  [
    'an edit while the charter withholds the power',
    { charter: { approve_worker_prompts: 'off' } },
    'Edit',
    { input: { file_path: '{worktree}/src/a.ts', old_string: 'a', new_string: 'b' } },
    'user',
  ],
  ['a forced push', undefined, 'Bash', { input: { command: 'git push --force origin x' } }, 'user'],
  [
    'a write outside the worktree',
    undefined,
    'Write',
    { input: { file_path: '/etc/hosts', content: 'x' } },
    'user',
  ],
  [
    'a network fetch',
    undefined,
    'WebFetch',
    { input: { url: 'https://example.com', prompt: 'summary' } },
    'user',
  ],
  [
    'a command the user added to the must-ask list',
    { must_ask_extra: ['Bash(pnpm publish)'] },
    'Bash',
    { input: { command: 'pnpm publish' } },
    'user',
  ],
  ['a question to the user', undefined, 'AskUserQuestion', question, 'board'],
  ['a plan to accept', undefined, 'ExitPlanMode', { input: { plan: 'Build the export' } }, 'user'],
  [
    'an edit whose summary was cut off',
    undefined,
    'Edit',
    { input: { file_path: '{worktree}/src/a.ts', old_string: 'a', new_string: 'b'.repeat(400) } },
    'user',
  ],
] as const)('settles a worker prompt for %s', async (_label, policy, tool, detail, expected) => {
  const { f, lead, worktree, answer, handle, prompt } = await workerFixture(policy);
  const approval = prompt(
    tool,
    JSON.parse(JSON.stringify(detail).replaceAll('{worktree}', worktree)),
  );
  await f.control.tick();
  const row = f.store.must<Approval>('approvals', approval.id);
  if (expected === 'lead') {
    expect(row).toMatchObject({
      state: 'approved',
      decider: 'lead',
      decided_by: `session:${lead.id}`,
    });
    expect(row).not.toHaveProperty('session_wide');
    expect(row).not.toHaveProperty('project_wide');
    expect(answer).toHaveBeenCalledWith(handle, approval.request_id, 'allow');
    expect(requestItem(f, approval.id)).toBeUndefined();
    expect(powerUses(f)).toHaveLength(1);
    expect(powerUses(f)[0]!.payload).toMatchObject({ mode: 'on', session_id: lead.id });
    return;
  }
  expect(row).toMatchObject({ state: 'pending', decider: 'user' });
  expect(row).not.toHaveProperty('decided_by');
  expect(answer).not.toHaveBeenCalled();
  expect(powerUses(f)).toHaveLength(0);
  expect(approvedNotes(f, lead.id)).toHaveLength(0);
  if (expected === 'board') {
    expect(
      f.store
        .must<BoardPlan>('board_plans', lead.id)
        .questions?.some((entry) => entry.source?.approval_id === approval.id),
    ).toBe(true);
    return;
  }
  expect(requestItem(f, approval.id)?.actions).toEqual([
    { command: 'approval.respond', allowed: true },
  ]);
});

it('leaves the prompt of a session with no task to the user', async () => {
  const f = await workbenchFixture();
  vi.spyOn(f.adapter, 'send').mockImplementation(async (_handle, turn) => ({
    turn_id: turn.turn_id,
    status: 'delivered',
  }));
  const answer = vi.spyOn(f.adapter, 'answerPermission').mockResolvedValue({ ok: true });
  const session = await f.create('Fix the parser');
  const { turn } = await running(f, session);
  const worktree = f.store.must<Workspace>('workspaces', session.workspace_id!).path;
  const approval = prompter(
    f,
    session,
    turn,
  )('Edit', {
    input: { file_path: `${worktree}/src/a.ts`, old_string: 'a', new_string: 'b' },
  });
  await f.control.tick();
  expect(f.store.must<Approval>('approvals', approval.id)).toMatchObject({
    state: 'pending',
    decider: 'user',
  });
  expect(answer).not.toHaveBeenCalled();
  expect(requestItem(f, approval.id)).toBeDefined();
  expect(powerUses(f)).toHaveLength(0);
});

it('lets a stored project rule answer a worker prompt before the charter does', async () => {
  const { f, lead, worker, worktree, prompt } = await workerFixture();
  f.call('permission.rule.add', { project_id: f.project.id, rule: 'Edit', session_id: worker.id });
  const approval = prompt(
    'Edit',
    { input: { file_path: `${worktree}/src/a.ts`, old_string: 'a', new_string: 'b' } },
    { project_rule_supported: true },
  );
  expect(f.store.must<Approval>('approvals', approval.id)).toMatchObject({
    state: 'approved',
    answered_by_rule: 'Edit',
    decider: 'user',
  });
  expect(approvedNotes(f, lead.id)).toHaveLength(0);
  expect(powerUses(f)).toHaveLength(0);
});

it('keeps one unread note per worker of the prompts approved for its lead, without waking the lead', async () => {
  const { f, lead, worker, worktree, prompt } = await workerFixture();
  await f.control.tick();
  const before = trackerTurns(f, lead.id);
  for (const name of ['a', 'b', 'c'])
    prompt('Edit', {
      input: { file_path: `${worktree}/src/${name}.ts`, old_string: 'a', new_string: 'b' },
    });
  await f.control.tick();
  await f.control.tick();
  const notes = approvedNotes(f, lead.id);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ session_id: worker.id, task_id: task.id });
  expect(notes[0]!.text).toContain('3');
  for (const name of ['a', 'b', 'c']) expect(notes[0]!.text).toContain(`src/${name}.ts`);
  expect(trackerTurns(f, lead.id)).toBe(before);
});

it("refuses the user's answer to a prompt the lead already approved", async () => {
  const { f, worktree, prompt } = await workerFixture();
  const approval = prompt('Edit', {
    input: { file_path: `${worktree}/src/a.ts`, old_string: 'a', new_string: 'b' },
  });
  const row = f.store.must<Approval>('approvals', approval.id);
  expect(row.state).toBe('approved');
  expect(() =>
    f.call('approval.respond', { approval_id: row.id, decision: 'approve' }, row.revision),
  ).toThrow(expect.objectContaining({ code: 'approval_not_pending' }));
});

it('gives the user a lead-approved prompt whose allow the runtime refused', async () => {
  const { f, worktree, answer, prompt } = await workerFixture();
  answer.mockResolvedValueOnce({
    ok: false,
    reason: 'The agent offers no allow-once option for this request',
    refused: true,
  });
  const approval = prompt('Edit', {
    input: { file_path: `${worktree}/src/a.ts`, old_string: 'a', new_string: 'b' },
  });
  await f.control.tick();
  const reopened = f.store.must<Approval>('approvals', approval.id);
  expect(reopened).toMatchObject({ state: 'pending', decider: 'user' });
  expect(reopened).not.toHaveProperty('decided_by');
  expect(requestItem(f, approval.id)?.actions).toEqual([
    { command: 'approval.respond', allowed: true },
  ]);
});
