import { expect, it, vi } from 'vitest';
import type {
  BoardPlan,
  LeadNote,
  Milestone,
  Principal,
  ReplanTrigger,
  Session,
  SessionTurn,
  WorkflowPolicy,
} from '@pantheon/domain';
import { transferPlan } from '../../packages/control/dist/board-plan.js';
import type { ControlContext } from '../../packages/control/src/context.js';
import { settle } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const leadPrincipal = (f: Fixture, leadId: string): Principal => ({
  id: `session:${leadId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: leadId,
  expires_at: f.store.now() + 60000,
});

/** A plan with one milestone over the tasks given, with these re-plan conditions. */
const planInput = (f: Fixture, replanIf: ReplanTrigger[], taskIds: string[], baseVersion = 0) => ({
  project_id: f.project.id,
  base_version: baseVersion,
  headline: 'Export ships this week',
  lanes: [{ id: 'core', title: 'Core' }],
  tasks: taskIds.map((id) => ({
    id,
    title: id,
    depends_on: [],
    goal: id,
    lane: 'core',
    milestone: 'm1',
    source: ['Plan the export feature'],
    scope: [`src/${id}.ts`],
    acceptance: ['pnpm test'],
    kind: { domain: 'backend-logic', tier: 't1' },
  })),
  milestones: [
    {
      id: 'm1',
      title: 'Export ships',
      criteria: ['Exports download'],
      tasks: taskIds,
      replan_if: replanIf,
    },
  ],
  risks: [],
  assumptions: [],
});

/** An idle lead whose plan has one milestone over the tasks given, with these re-plan conditions. */
async function leadWithMilestone(f: Fixture, replanIf: ReplanTrigger[], taskIds = ['exports']) {
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  f.call('board.plan.update', planInput(f, replanIf, taskIds), null, leadPrincipal(f, lead.id));
  return lead;
}

function taskWorker(f: Fixture, leadId: string, taskId: string) {
  const worker = f.store.insert<Session>('sessions', {
    id: `${taskId}-worker`,
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    workspace_id: f.store.must<Session>('sessions', leadId).workspace_id,
    state: 'open',
    turn_count: 0,
    task: { lead_session_id: leadId, id: taskId, generation: 1 },
  });
  f.store.event('session.opened', worker, f.project.id, worker);
  return worker;
}

/** Records this many of Pantheon's hand-backs to the session. */
function handBack(f: Fixture, leadId: string, sessionId: string, times: number) {
  const plan = f.store.must<BoardPlan>('board_plans', leadId);
  f.store.update<BoardPlan>(
    'board_plans',
    {
      ...plan,
      handed_back: { ...plan.handed_back, [sessionId]: Array(times).fill('gate_failed') },
    },
    plan.revision,
  );
}

const fired = (f: Fixture) => f.store.kindEvents(f.project.id, ['board.replan_triggered']);
const replanNotes = (f: Fixture) =>
  f.store
    .kindEvents(f.project.id, ['lead.note_added'])
    .map((event) => event.payload as LeadNote)
    .filter((note) => note.kind === 'replan');
const milestoneRow = (f: Fixture) =>
  f.store.list<Milestone>('milestones').find((row) => row.key === 'm1')!;

it('fires a hand-back condition once per task generation, tells the lead and wakes it', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithMilestone(f, [{ type: 'handbacks', count: 2 }]);
  const worker = taskWorker(f, lead.id, 'exports');
  handBack(f, lead.id, worker.id, 1);
  await f.control.tick();
  expect(fired(f)).toEqual([]);

  handBack(f, lead.id, worker.id, 2);
  await f.control.tick();
  const events = fired(f);
  expect(events.map((event) => event.payload)).toEqual([
    {
      milestone_id: milestoneRow(f).id,
      trigger: { type: 'handbacks', count: 2 },
      task_id: 'exports',
      generation: 1,
      value: 2,
    },
  ]);
  expect(events[0]!.aggregate_id).toBe(lead.id);
  expect(replanNotes(f)).toEqual([
    expect.objectContaining({
      task_id: 'exports',
      generation: 1,
      replan_event: events[0]!.event_id,
      text: 'Milestone m1 "Export ships": task exports was handed back 2 times, which meets the replan_if condition you set (handbacks 2).',
    }),
  ]);
  const wake = f
    .turns(lead.id)
    .find((turn: SessionTurn) => turn.origin === 'tracker' && turn.input.includes('kind="replan"'));
  expect(wake?.input).toContain(`event="${events[0]!.event_id}"`);

  handBack(f, lead.id, worker.id, 3);
  await f.control.tick();
  expect(fired(f)).toHaveLength(1);
  expect(replanNotes(f)).toHaveLength(1);
});

it('folds a condition met again on the same milestone while its note still waits', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithMilestone(
    f,
    [{ type: 'handbacks', count: 2 }],
    ['exports', 'imports'],
  );
  for (const taskId of ['exports', 'imports'])
    handBack(f, lead.id, taskWorker(f, lead.id, taskId).id, 2);
  await f.control.tick();
  expect(fired(f).map((event) => (event.payload as { task_id: string }).task_id)).toEqual([
    'exports',
    'imports',
  ]);
  expect(replanNotes(f)).toHaveLength(1);
});

it('fires a budget condition once the task reaches the share of its budget', async () => {
  const f = await workbenchFixture();
  f.call(
    'workflow.policy.set',
    {
      project_id: f.project.id,
      budget: { t1: { dispatch: { input_tokens: 1_000_000_000, wall_ms: 1000 } } },
    },
    f.store.get<WorkflowPolicy>('workflow_policies', f.project.id)?.revision ?? null,
  );
  const start = Date.now(),
    now = vi.spyOn(f.store, 'now').mockReturnValue(start);
  const lead = await leadWithMilestone(f, [{ type: 'budget_ratio', at: 0.8 }]);
  const worker = taskWorker(f, lead.id, 'exports');
  f.store.event('task.dispatched', lead, f.project.id, {
    task_id: 'exports',
    session_id: worker.id,
  });
  now.mockReturnValue(start + 799);
  await f.control.tick();
  expect(fired(f)).toEqual([]);
  now.mockReturnValue(start + 800);
  await f.control.tick();
  expect(fired(f).map((event) => event.payload)).toEqual([
    expect.objectContaining({ trigger: { type: 'budget_ratio', at: 0.8 }, value: 0.8 }),
  ]);
  expect(replanNotes(f)).toHaveLength(1);
});

it('fires a stall condition when a session of the task stalled', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithMilestone(f, [{ type: 'stall' }]);
  const worker = taskWorker(f, lead.id, 'exports');
  const turn = f.store.insert<SessionTurn>('session_turns', {
    id: 'exports-turn',
    revision: 1,
    project_id: f.project.id,
    session_id: worker.id,
    input: 'Build it',
    kind: 'send',
    delivery: 'delivered',
    state: 'running',
  });
  const plan = f.store.must<BoardPlan>('board_plans', lead.id);
  f.store.update<BoardPlan>(
    'board_plans',
    { ...plan, alerted: { [turn.id]: ['stalled'] } },
    plan.revision,
  );
  await f.control.tick();
  expect(fired(f).map((event) => event.payload)).toEqual([
    {
      milestone_id: milestoneRow(f).id,
      trigger: { type: 'stall' },
      task_id: 'exports',
      generation: 1,
    },
  ]);
});

/** The lead works on the task itself. */
function claimDirect(f: Fixture, leadId: string, taskId: string) {
  const lead = f.store.must<Session>('sessions', leadId);
  f.store.update<Session>(
    'sessions',
    { ...lead, direct_task: { id: taskId, generation: 1 } },
    lead.revision,
  );
}

it('fires a hand-back condition for a task the lead works on itself', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithMilestone(f, [{ type: 'handbacks', count: 2 }]);
  claimDirect(f, lead.id, 'exports');
  handBack(f, lead.id, `${lead.id}:exports`, 2);
  await f.control.tick();
  expect(fired(f).map((event) => event.payload)).toEqual([
    expect.objectContaining({ trigger: { type: 'handbacks', count: 2 }, value: 2 }),
  ]);
});

it('fires a stall condition when the lead stalled on a task it works on itself', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithMilestone(f, [{ type: 'stall' }]);
  claimDirect(f, lead.id, 'exports');
  const turn = f.store.insert<SessionTurn>('session_turns', {
    id: 'lead-turn',
    revision: 1,
    project_id: f.project.id,
    session_id: lead.id,
    input: 'Build it',
    kind: 'send',
    delivery: 'delivered',
    state: 'running',
  });
  const plan = f.store.must<BoardPlan>('board_plans', lead.id);
  f.store.update<BoardPlan>(
    'board_plans',
    { ...plan, alerted: { [turn.id]: ['stalled'] } },
    plan.revision,
  );
  await f.control.tick();
  expect(fired(f).map((event) => event.payload)).toEqual([
    expect.objectContaining({ trigger: { type: 'stall' }, task_id: 'exports' }),
  ]);
});

it('fires an assumption condition once the lead applies the user saying the assumption is wrong', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  const trigger: ReplanTrigger = { type: 'assumption_false', assumption_id: 'csv-only' };
  f.call(
    'board.plan.update',
    {
      ...planInput(f, [trigger], ['exports']),
      assumptions: [{ id: 'csv-only', text: 'Exports are CSV only.', milestone: 'm1' }],
    },
    null,
    leadPrincipal(f, lead.id),
  );
  const { edit_id } = f.call<{ edit_id: string }>('board.plan.edit', {
    project_id: f.project.id,
    lead_session_id: lead.id,
    base_version: f.store.must<BoardPlan>('board_plans', lead.id).plan_version,
    ops: [
      {
        type: 'refute_assumption',
        assumption_id: 'csv-only',
        instead: 'Exports are CSV and JSON.',
      },
    ],
  });
  await f.control.tick();
  expect(fired(f)).toEqual([]);

  f.call(
    'board.plan.edit',
    {
      project_id: f.project.id,
      base_version: f.store.must<BoardPlan>('board_plans', lead.id).plan_version,
      ops: [{ type: 'resolve_edit', edit_id, decision: 'apply' }],
    },
    null,
    leadPrincipal(f, lead.id),
  );
  await f.control.tick();
  const events = fired(f);
  expect(events.map((event) => event.payload)).toEqual([
    { milestone_id: milestoneRow(f).id, trigger, task_id: 'exports', generation: 1, edit_id },
  ]);
  expect(replanNotes(f)).toEqual([
    expect.objectContaining({
      task_id: 'exports',
      replan_event: events[0]!.event_id,
      text: 'Milestone m1 "Export ships": assumption csv-only behind task exports turned out false, which meets the replan_if condition you set (assumption_false csv-only).',
    }),
  ]);

  await f.control.tick();
  expect(fired(f)).toHaveLength(1);
  expect(replanNotes(f)).toHaveLength(1);

  // A later re-plan changes the task's goal and keeps the assumption listed.
  const input = planInput(
    f,
    [trigger],
    ['exports'],
    f.store.must<BoardPlan>('board_plans', lead.id).plan_version,
  );
  f.call(
    'board.plan.update',
    {
      ...input,
      tasks: input.tasks.map((task) => ({ ...task, goal: 'Export CSV and JSON' })),
      assumptions: [{ id: 'csv-only', text: 'Exports are CSV only.', milestone: 'm1' }],
    },
    null,
    leadPrincipal(f, lead.id),
  );
  await f.control.tick();
  expect(fired(f)).toHaveLength(1);
});

it('fires an assumption condition again for a later applied edit that refutes it again', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  const trigger: ReplanTrigger = { type: 'assumption_false', assumption_id: 'csv-only' };
  f.call(
    'board.plan.update',
    {
      ...planInput(f, [trigger], ['exports']),
      assumptions: [{ id: 'csv-only', text: 'Exports are CSV only.', milestone: 'm1' }],
    },
    null,
    leadPrincipal(f, lead.id),
  );
  const refuteAndApply = (instead: string) => {
    const { edit_id } = f.call<{ edit_id: string }>('board.plan.edit', {
      project_id: f.project.id,
      lead_session_id: lead.id,
      base_version: f.store.must<BoardPlan>('board_plans', lead.id).plan_version,
      ops: [{ type: 'refute_assumption', assumption_id: 'csv-only', instead }],
    });
    f.call(
      'board.plan.edit',
      {
        project_id: f.project.id,
        base_version: f.store.must<BoardPlan>('board_plans', lead.id).plan_version,
        ops: [{ type: 'resolve_edit', edit_id, decision: 'apply' }],
      },
      null,
      leadPrincipal(f, lead.id),
    );
    return edit_id;
  };
  const first = refuteAndApply('Exports are CSV and JSON.');
  await f.control.tick();
  const second = refuteAndApply('Exports are CSV, JSON and XML.');
  await f.control.tick();
  expect(fired(f).map((event) => (event.payload as { edit_id?: string }).edit_id)).toEqual([
    first,
    second,
  ]);
});

it('accepts the re-plan event fired before the plan moved to a new lead', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithMilestone(f, [{ type: 'handbacks', count: 2 }]);
  handBack(f, lead.id, taskWorker(f, lead.id, 'exports').id, 2);
  await f.control.tick();
  const [event] = fired(f);
  const successor = await f.create('Carry on with the export feature');
  await settle(f, successor);
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  ctx.store.transaction(() =>
    transferPlan(ctx, ctx.store.must<BoardPlan>('board_plans', lead.id), successor.id, ''),
  );
  const version = f.store.must<BoardPlan>('board_plans', successor.id).plan_version!;
  f.call(
    'board.plan.update',
    {
      ...planInput(f, [{ type: 'handbacks', count: 3 }], ['exports'], version),
      trigger_event: event!.event_id,
    },
    null,
    leadPrincipal(f, successor.id),
  );
  expect(f.store.must<BoardPlan>('board_plans', successor.id).plan_version).toBe(version + 1);
});

it('refuses a plan change that answers an event no condition of the plan fired', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithMilestone(f, [{ type: 'stall' }]);
  expect(() =>
    f.call(
      'board.plan.edit',
      {
        project_id: f.project.id,
        base_version: 1,
        trigger_event: 'no-such-event',
        ops: [{ type: 'set_task', task_id: 'exports', patch: { title: 'Exports v2' } }],
      },
      null,
      leadPrincipal(f, lead.id),
    ),
  ).toThrow('Not found: re-plan event no-such-event of your plan');
});
