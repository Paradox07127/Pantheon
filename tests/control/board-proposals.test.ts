import { afterEach, expect, it } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import { id } from '@pantheon/domain';
import type { BoardPlan, Principal, Project, ProjectRead, SessionTurn } from '@pantheon/domain';
import { fixture, insertSession, user } from '../helpers.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

function failure(fn: () => unknown): { code?: string; message?: string } {
  try {
    fn();
  } catch (error) {
    return error as { code?: string; message?: string };
  }
  throw new Error('Expected the command to fail');
}

/** A fixture whose clock moves only when the test moves it. */
async function setup() {
  const clock = { now: 1_700_000_000_000 };
  const f = await fixture({
    adapter: new FixtureAdapter(100),
    managedWorkspaces: true,
    now: () => clock.now,
  });
  cleanups.push(() => f.close());
  return { f, clock };
}

const REQUEST = 'Ship the export API and a download button this week.';

function leadOf(f: Fixture): Principal {
  const lead = insertSession(f);
  f.store.insert('session_turns', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    session_id: lead.id,
    input: REQUEST,
    kind: 'send',
    delivery: 'delivered',
    state: 'completed',
  });
  return {
    id: `session:${lead.id}`,
    role: 'lead',
    project_id: f.project.id,
    session_id: lead.id,
    expires_at: f.store.now() + 60_000_000,
  };
}

const TASKS = [
  {
    id: 'api',
    title: 'API',
    goal: 'Serve exports',
    lane: 'core',
    depends_on: [],
    source: ['Ship the export API'],
    scope: ['packages/export'],
    acceptance: ['pnpm test'],
  },
  {
    id: 'ui',
    title: 'UI',
    goal: 'Download button',
    lane: 'core',
    depends_on: [],
    source: ['a download button'],
    scope: ['apps/web/src/export'],
    acceptance: ['pnpm test'],
  },
];

function writePlan(f: Fixture, lead: Principal) {
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: TASKS,
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    lead,
  );
}

const planOf = (f: Fixture, lead: Principal) =>
  f.store.must<BoardPlan>('board_plans', lead.session_id!);
const leadRow = (f: Fixture, lead: Principal) =>
  f.control
    .boardView(user, f.project.id, 1)
    .leads!.find((row) => row.session_id === lead.session_id)!;

const rename = (title = 'Export API') => ({
  type: 'set_task',
  task_id: 'api',
  patch: { title },
});
const dependency = { type: 'set_dependencies', task_id: 'ui', depends_on: ['api'] };

function propose(
  f: Fixture,
  lead: Principal,
  ops: unknown[] = [rename()],
  principal = lead,
  baseVersion = planOf(f, lead).plan_version,
) {
  return f.call<{ proposal_id: string }>(
    'board.plan.propose',
    {
      project_id: f.project.id,
      base_version: baseVersion,
      reason: 'The export needs a narrower contract',
      ops,
    },
    null,
    principal,
  ).proposal_id;
}

function decide(
  f: Fixture,
  lead: Principal,
  proposalId: string,
  decision: 'accept' | 'reject',
  extra: Record<string, unknown> = {},
  principal = user,
) {
  return f.call(
    'board.plan.proposal.resolve',
    {
      project_id: f.project.id,
      lead_session_id: lead.session_id,
      proposal_id: proposalId,
      decision,
      ...extra,
    },
    null,
    principal,
  );
}

function withdraw(f: Fixture, lead: Principal, proposalId: string, principal = lead) {
  return f.call(
    'board.plan.proposal.withdraw',
    { project_id: f.project.id, proposal_id: proposalId },
    null,
    principal,
  );
}

function edit(f: Fixture, lead: Principal, ops: unknown[]) {
  return f.call(
    'board.plan.edit',
    { project_id: f.project.id, base_version: planOf(f, lead).plan_version, ops },
    null,
    lead,
  );
}

const readPlan = (f: Fixture, lead: Principal) =>
  (f.control.projectRead(lead, f.project.id) as ProjectRead).plans.find(
    (plan) => plan.lead_session_id === lead.session_id,
  )!;
/** The note the lead was woken with. */
const woken = (f: Fixture, lead: Principal) =>
  f.store
    .list<SessionTurn>('session_turns')
    .filter((turn) => turn.session_id === lead.session_id && turn.origin === 'tracker')
    .at(-1)!.input;
const needs = (f: Fixture) =>
  f.control
    .needsYou(user, f.project.id)
    .items.filter((item) => item.kind === 'board.plan.proposal');

it('holds a lead proposal without changing tasks and lists it in both plan views and needs-you', async () => {
  const { f, clock } = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  const before = planOf(f, lead);
  const proposalId = propose(f, lead);
  expect(planOf(f, lead)).toMatchObject({ tasks: before.tasks, plan_version: before.plan_version });
  const view = {
    id: proposalId,
    lead_session_id: lead.session_id,
    reason: 'The export needs a narrower contract',
    ops: [rename()],
    base_version: before.plan_version,
    created_at: clock.now,
    task_ids: ['api'],
  };
  expect(leadRow(f, lead).pending_proposals).toEqual([view]);
  expect(readPlan(f, lead).pending_proposals).toEqual([view]);
  expect(needs(f)).toEqual([
    expect.objectContaining({
      source: { table: 'board_plans', id: lead.session_id, revision: planOf(f, lead).revision },
      request_id: proposalId,
      kind: 'board.plan.proposal',
      session_id: lead.session_id,
      created_at: clock.now,
      reason: 'plan_proposal_awaiting_decision',
      actions: [{ command: 'board.plan.proposal.resolve', allowed: true }],
      next_step: expect.any(String),
    }),
  ]);
});

it('refuses users and other sessions proposing or withdrawing a lead proposal', async () => {
  const { f } = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  const other = leadOf(f),
    worker = { ...other, role: 'worker' as const };
  for (const principal of [user, worker])
    expect(failure(() => propose(f, lead, [rename()], principal)).code).toBe('permission_denied');
  expect(failure(() => propose(f, lead, [rename()], other)).code).toBe('not_found');
  const proposalId = propose(f, lead);
  for (const principal of [user, worker])
    expect(failure(() => withdraw(f, lead, proposalId, principal)).code).toBe('permission_denied');
  expect(failure(() => withdraw(f, lead, proposalId, other)).code).toBe('not_found');
  expect(planOf(f, lead).pending_proposals![0]!.status).toBe('pending');
});

it('validates proposal ops and the base version before storing anything', async () => {
  const { f } = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  for (const [ops, code] of [
    [[{ type: 'remove_task', task_id: 'missing' }], 'not_found'],
    [[{ type: 'set_dependencies', task_id: 'api', depends_on: ['api'] }], 'invalid_input'],
    [
      [{ type: 'add_task', task: { ...TASKS[0], id: 'docs', source: ['Invented user request'] } }],
      'invalid_input',
    ],
    [[{ type: 'set_task', task_id: 'api', patch: { runtime: 'fixture' } }], 'invalid_input'],
  ] as const)
    expect(failure(() => propose(f, lead, [...ops])).code).toBe(code);
  expect(failure(() => propose(f, lead, [rename()], lead, 0)).code).toBe('revision_conflict');
  expect(planOf(f, lead).pending_proposals ?? []).toEqual([]);
});

it('refuses the ninth pending proposal and frees a place when one is withdrawn', async () => {
  const { f } = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  const ids = Array.from({ length: 8 }, () => propose(f, lead));
  expect(failure(() => propose(f, lead)).message).toContain('8 pending proposals');
  withdraw(f, lead, ids[0]!);
  expect(() => propose(f, lead)).not.toThrow();
});

it('withdraws only pending proposals and keeps the resolved record in the lead view', async () => {
  const { f, clock } = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  const proposalId = propose(f, lead);
  withdraw(f, lead, proposalId);
  expect(planOf(f, lead).pending_proposals![0]).toMatchObject({
    proposal_id: proposalId,
    status: 'withdrawn',
    resolved_at: clock.now,
  });
  expect(leadRow(f, lead).pending_proposals).toEqual([]);
  expect(readPlan(f, lead)).toMatchObject({
    pending_proposals: [],
    recent_proposals: [expect.objectContaining({ id: proposalId, status: 'withdrawn' })],
  });
  expect(needs(f)).toEqual([]);
  expect(failure(() => withdraw(f, lead, proposalId)).code).toBe('not_found');
  expect(failure(() => decide(f, lead, proposalId, 'accept')).code).toBe('not_found');
});

it('accepts with lead edit events, version and task contract notifications and tells the lead', async () => {
  const { f } = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  const worker = insertSession(f, {
    state: 'running',
    task: { lead_session_id: lead.session_id!, id: 'api', generation: 1 },
  });
  const before = planOf(f, lead),
    events = f.store.kindEvents(f.project.id, ['board.plan_updated']).length;
  const proposalId = propose(f, lead, [
    { type: 'set_task', task_id: 'api', patch: { goal: 'Serve compressed exports' } },
  ]);
  decide(f, lead, proposalId, 'accept');
  const plan = planOf(f, lead);
  expect(plan.tasks[0]!.goal).toBe('Serve compressed exports');
  expect(plan.plan_version).toBe(before.plan_version + 1);
  expect(plan.contract_changed).toContain(worker.id);
  expect(f.store.kindEvents(f.project.id, ['board.plan_updated'])).toHaveLength(events + 1);
  expect(woken(f, lead)).toContain(proposalId);
  expect(woken(f, lead)).toContain('accept');
  expect(readPlan(f, lead).recent_proposals).toMatchObject([
    { id: proposalId, status: 'accepted', reason: 'The export needs a narrower contract' },
  ]);
  expect(needs(f)).toEqual([]);
  expect(failure(() => decide(f, lead, proposalId, 'accept')).code).toBe('not_found');
});

it('accepts changed ops in place of the proposal and includes their summary in the note', async () => {
  const { f } = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  const proposalId = propose(f, lead);
  decide(f, lead, proposalId, 'accept', { ops: [rename('Streaming exports')] });
  expect(planOf(f, lead).tasks[0]!.title).toBe('Streaming exports');
  expect(woken(f, lead)).toContain('set title Streaming exports of task api');
});

it("applies a user-adjusted acceptance under the user's edit rules", async () => {
  const { f } = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  const docs = { ...TASKS[0], id: 'docs', source: ['Also document the export format'] };
  decide(f, lead, propose(f, lead), 'accept', { ops: [{ type: 'add_task', task: docs }] });
  expect(planOf(f, lead).tasks.map((task) => task.id)).toEqual(['api', 'ui', 'docs']);

  const project = f.store.must<Project>('projects', f.project.id);
  f.store.update<Project>(
    'projects',
    {
      ...project,
      session_defaults: {
        runtime: f.adapter.name,
        model: 'm1',
        permission_mode: 'ask',
        single_model: true,
      },
    },
    project.revision,
  );
  decide(f, lead, propose(f, lead), 'accept', {
    ops: [{ type: 'set_task', task_id: 'api', patch: { model: 'm2' } }],
  });
  expect(planOf(f, lead).tasks[0]!.model).toBe('m2');
});

it('leaves a proposal pending when later plan changes make its ops invalid', async () => {
  const { f } = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  const proposalId = propose(f, lead);
  edit(f, lead, [{ type: 'remove_task', task_id: 'api' }]);
  const before = planOf(f, lead);
  expect(failure(() => decide(f, lead, proposalId, 'accept')).code).toBe('not_found');
  expect(planOf(f, lead)).toEqual(before);
  expect(needs(f)).toHaveLength(1);
});

it('accepts a proposal against the current plan when its ops still apply', async () => {
  const { f } = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  const proposalId = propose(f, lead);
  edit(f, lead, [{ type: 'set_task', task_id: 'ui', patch: { title: 'Downloads' } }]);
  decide(f, lead, proposalId, 'accept');
  expect(planOf(f, lead).tasks.map((task) => task.title)).toEqual(['Export API', 'Downloads']);
});

it('rejects without changing the plan and delivers the user reason to the lead', async () => {
  const { f } = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  const before = planOf(f, lead),
    proposalId = propose(f, lead);
  decide(f, lead, proposalId, 'reject', { reason: 'Keep the original deliverable' });
  const plan = planOf(f, lead);
  expect(plan.tasks).toEqual(before.tasks);
  expect(plan.plan_version).toBe(before.plan_version);
  expect(woken(f, lead)).toContain(proposalId);
  expect(woken(f, lead)).toContain('reject');
  expect(woken(f, lead)).toContain('Keep the original deliverable');
  expect(readPlan(f, lead).recent_proposals).toMatchObject([
    { id: proposalId, status: 'rejected', resolution_reason: 'Keep the original deliverable' },
  ]);
  expect(needs(f)).toEqual([]);
  expect(failure(() => decide(f, lead, proposalId, 'reject')).code).toBe('not_found');
});

it('refuses session decisions and rejects ops accompanying a rejection', async () => {
  const { f } = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  const proposalId = propose(f, lead);
  expect(failure(() => decide(f, lead, proposalId, 'accept', {}, lead)).code).toBe(
    'permission_denied',
  );
  expect(failure(() => decide(f, lead, proposalId, 'reject', { ops: [rename()] })).code).toBe(
    'invalid_input',
  );
  expect(planOf(f, lead).pending_proposals![0]!.status).toBe('pending');
});

it('shows proposed dependencies once, removes them on rejection and makes them plain on acceptance', async () => {
  const { f } = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  const edges = () => {
    const view = f.control.boardView(user, f.project.id, 1);
    return { plan: view.edges, proposed: view.proposed_edges };
  };
  const edge = { from: `${lead.session_id}:api`, to: `${lead.session_id}:ui`, state: 'pending' };
  const rejected = propose(f, lead, [dependency]);
  const accepted = propose(f, lead, [dependency]);
  expect(edges()).toEqual({ plan: [], proposed: [edge] });
  decide(f, lead, rejected, 'reject');
  expect(edges()).toEqual({ plan: [], proposed: [edge] });
  decide(f, lead, accepted, 'reject');
  expect(edges()).toEqual({ plan: [], proposed: [] });
  const proposalId = propose(f, lead, [dependency]);
  decide(f, lead, proposalId, 'accept');
  propose(f, lead, [dependency]);
  expect(edges()).toEqual({ plan: [edge], proposed: [] });
});

it('does not draw dependencies for tasks only a proposal adds and lists only existing touched tasks', async () => {
  const { f } = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  propose(f, lead, [
    { type: 'add_task', task: { ...TASKS[0], id: 'docs' } },
    { type: 'set_dependencies', task_id: 'docs', depends_on: ['api'] },
    { type: 'set_dependencies', task_id: 'ui', depends_on: ['docs'] },
  ]);
  expect(f.control.boardView(user, f.project.id, 1).edges).toEqual([]);
  expect(leadRow(f, lead).pending_proposals![0]!.task_ids).toEqual(['ui']);
});
