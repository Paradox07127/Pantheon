import { expect, it } from 'vitest';
import type { BoardPlan, LeadNote, Principal, Session, WorkflowPolicy } from '@pantheon/domain';
import { planViews } from '../../packages/control/dist/board-plan.js';
import { settle, user } from '../helpers.js';
import { dispatchEveryTier, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
type PlanTask = BoardPlan['tasks'][number];

const REQUEST = 'Plan the export feature';

const task = (id: string, tier: 't1' | 't2' | 't3', fields: Partial<PlanTask> = {}): PlanTask => ({
  id,
  title: `Task ${id}`,
  goal: `Finish task ${id}`,
  lane: 'core',
  depends_on: [],
  source: [REQUEST],
  scope: [`src/${id}`],
  acceptance: ['pnpm test'],
  kind: { domain: 'backend-logic', tier },
  ...fields,
});

const leadOf = (f: Fixture, leadId: string): Principal => ({
  id: `session:${leadId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: leadId,
  expires_at: f.store.now() + 60000,
});

function failure(fn: () => unknown): { code?: string; message?: string } {
  try {
    fn();
  } catch (error) {
    return error as { code?: string; message?: string };
  }
  throw new Error('Expected the command to fail');
}

const planOf = (f: Fixture, leadId: string) => f.store.must<BoardPlan>('board_plans', leadId);

function writePlan(
  f: Fixture,
  leadId: string,
  tasks: PlanTask[],
  lanes = [{ id: 'core', title: 'Core' }],
) {
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: f.store.get<BoardPlan>('board_plans', leadId)?.plan_version ?? 0,
      headline: 'Export ships this week',
      lanes,
      tasks,
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    leadOf(f, leadId),
  );
}

const start = (f: Fixture, leadId: string, taskIds: string[]) =>
  f.call('task.start', { project_id: f.project.id, task_ids: taskIds }, null, leadOf(f, leadId));

const approve = (f: Fixture, leadId: string, laneId = 'core', principal: Principal = user) =>
  f.call(
    'board.lane.approve',
    { project_id: f.project.id, lead_session_id: leadId, lane_id: laneId },
    null,
    principal,
  );

const sessionsOf = (f: Fixture, leadId: string, taskId: string) =>
  f.store
    .list<Session>('sessions')
    .filter((session) => session.task?.lead_session_id === leadId && session.task.id === taskId);

const waitOf = (f: Fixture, leadId: string, taskId: string) =>
  planViews(f.control['ctx'], f.project.id)
    .find((view) => view.lead_session_id === leadId)!
    .tasks.find((row) => row.id === taskId)!.dispatch_wait;

const notes = (f: Fixture, kind: LeadNote['kind']) =>
  f.store
    .kindEvents(f.project.id, ['lead.note_added'])
    .map((event) => event.payload as LeadNote)
    .filter((note) => note.kind === kind);

async function setup(policy: Record<string, unknown> = {}) {
  const f = await workbenchFixture();
  dispatchEveryTier(f);
  if (Object.keys(policy).length)
    f.call(
      'workflow.policy.set',
      { project_id: f.project.id, ...policy },
      f.store.get<WorkflowPolicy>('workflow_policies', f.project.id)?.revision ?? null,
    );
  // No runtime reviews the plan, so only the user's approval holds a high-risk task.
  f.adapter.report.capabilities.read_isolation = { status: 'unsupported', evidence: 'Not here' };
  const lead = await f.create(REQUEST);
  await settle(f, lead);
  return { f, lead };
}

it("queues the started tasks of a lead's new lane with a high-risk task until the user approves its plan", async () => {
  const { f, lead } = await setup();
  writePlan(f, lead.id, [task('risky', 't3'), task('small', 't1')]);
  start(f, lead.id, ['risky', 'small']);
  await f.control.tick();
  expect(waitOf(f, lead.id, 'risky')).toBe('plan_approval');
  expect(waitOf(f, lead.id, 'small')).toBe('plan_approval');
  expect(sessionsOf(f, lead.id, 'risky')).toEqual([]);
  expect(sessionsOf(f, lead.id, 'small')).toEqual([]);
  expect(notes(f, 'plan_held').map((note) => note.text)).toEqual([
    'Lane core waits for the user to approve its plan; start_task queues its tasks until then.',
  ]);
});

it('opens the queued tasks of an approved lane on the next tick and leaves the lead one note', async () => {
  const { f, lead } = await setup();
  writePlan(f, lead.id, [task('risky', 't3')]);
  start(f, lead.id, ['risky']);
  await f.control.tick();
  approve(f, lead.id);
  expect(planOf(f, lead.id).lane_stops?.core).toMatchObject({
    approved_by: 'user',
    via: 'approve',
  });
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'risky')).toHaveLength(1);
  expect(
    notes(f, 'user_edit').filter((note) => note.text.includes('approved the plan of lane core')),
  ).toHaveLength(1);
});

it.each(['auto', 'confirm'] as const)(
  'starts a new lane without high-risk tasks at once with plan changes %s',
  async (planChanges) => {
    const { f, lead } = await setup({ plan_changes: planChanges });
    writePlan(f, lead.id, [task('small', 't1'), task('medium', 't2')]);
    start(f, lead.id, ['small', 'medium']);
    await f.control.tick();
    expect(planOf(f, lead.id).lane_stops).toBeUndefined();
    expect(sessionsOf(f, lead.id, 'small')).toHaveLength(1);
    expect(sessionsOf(f, lead.id, 'medium')).toHaveLength(1);
  },
);

it('holds a new lane whose task its scope raises to high risk', async () => {
  const { f, lead } = await setup();
  writePlan(f, lead.id, [
    task('wide', 't1', { scope: ['packages/export/src/a.ts', 'packages/web/src/b.ts'] }),
  ]);
  start(f, lead.id, ['wide']);
  await f.control.tick();
  expect(waitOf(f, lead.id, 'wide')).toBe('plan_approval');
  expect(sessionsOf(f, lead.id, 'wide')).toEqual([]);
});

it("keeps the hold and then the approval through the lead's resend of the whole plan", async () => {
  const { f, lead } = await setup();
  writePlan(f, lead.id, [task('risky', 't3')]);
  writePlan(f, lead.id, [task('risky', 't3', { title: 'Renamed risky task' })]);
  start(f, lead.id, ['risky']);
  await f.control.tick();
  expect(waitOf(f, lead.id, 'risky')).toBe('plan_approval');
  expect(notes(f, 'plan_held')).toHaveLength(1);
  approve(f, lead.id);
  writePlan(f, lead.id, [task('risky', 't3', { title: 'Risky task again' })]);
  expect(planOf(f, lead.id).lane_stops?.core?.approved_at).toBeDefined();
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'risky')).toHaveLength(1);
});

it('does not hold a high-risk task added to an approved lane', async () => {
  const { f, lead } = await setup();
  writePlan(f, lead.id, [task('risky', 't3')]);
  approve(f, lead.id);
  writePlan(f, lead.id, [task('risky', 't3'), task('later', 't3')]);
  start(f, lead.id, ['later']);
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'later')).toHaveLength(1);
});

it("holds a new lane with a high-risk task in a lead's proposal applied at once", async () => {
  const { f, lead } = await setup();
  writePlan(f, lead.id, [task('small', 't1')]);
  f.call(
    'board.plan.propose',
    {
      project_id: f.project.id,
      base_version: planOf(f, lead.id).plan_version,
      reason: 'The export needs a risky task.',
      ops: [
        { type: 'add_lane', lane: { id: 'extra', title: 'Extra' } },
        { type: 'add_task', task: task('risky', 't3', { lane: 'extra' }) },
      ],
    },
    null,
    leadOf(f, lead.id),
  );
  start(f, lead.id, ['risky']);
  await f.control.tick();
  expect(waitOf(f, lead.id, 'risky')).toBe('plan_approval');
});

it.each(['proposal', 'own ops'] as const)(
  'does not hold a new lane with a high-risk task the user accepts as the %s',
  async (accepted) => {
    const { f, lead } = await setup({ plan_changes: 'confirm' });
    writePlan(f, lead.id, [task('small', 't1')]);
    const ops = [
      { type: 'add_lane', lane: { id: 'extra', title: 'Extra' } },
      { type: 'add_task', task: task('risky', 't3', { lane: 'extra' }) },
    ];
    const { proposal_id } = f.call<{ proposal_id: string }>(
      'board.plan.propose',
      {
        project_id: f.project.id,
        base_version: planOf(f, lead.id).plan_version,
        reason: 'The export needs a risky task.',
        ops,
      },
      null,
      leadOf(f, lead.id),
    );
    f.call('board.plan.proposal.resolve', {
      project_id: f.project.id,
      lead_session_id: lead.id,
      proposal_id,
      decision: 'accept',
      ...(accepted === 'own ops' ? { ops } : {}),
    });
    expect(planOf(f, lead.id).lane_stops).toBeUndefined();
    start(f, lead.id, ['risky']);
    await f.control.tick();
    expect(sessionsOf(f, lead.id, 'risky')).toHaveLength(1);
  },
);

it("refuses the lead's claim of a direct high-risk task of a held lane", async () => {
  const { f, lead } = await setup({ path: { t3: 'direct' } });
  writePlan(f, lead.id, [task('risky', 't3')]);
  expect(failure(() => start(f, lead.id, ['risky']))).toMatchObject({
    code: 'invalid_state',
    message: expect.stringContaining('waits for the user to approve'),
  });
});

it('refuses a lead approving a lane and finds no lane without a hold', async () => {
  const { f, lead } = await setup();
  writePlan(
    f,
    lead.id,
    [task('risky', 't3'), task('small', 't1', { lane: 'side' })],
    [
      { id: 'core', title: 'Core' },
      { id: 'side', title: 'Side' },
    ],
  );
  expect(failure(() => approve(f, lead.id, 'core', leadOf(f, lead.id)))).toMatchObject({
    code: 'permission_denied',
  });
  expect(failure(() => approve(f, lead.id, 'side'))).toMatchObject({ code: 'not_found' });
  approve(f, lead.id);
  expect(failure(() => approve(f, lead.id))).toMatchObject({ code: 'not_found' });
});
