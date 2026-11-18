import { expect, it, vi } from 'vitest';
import {
  id,
  type BoardPlan,
  type Principal,
  type SessionTurn,
  type WorkflowPolicy,
} from '@pantheon/domain';
import type { PersonalAnswerKind } from '@pantheon/protocol';
import { settle, user } from '../helpers.js';
import { dispatchEveryTier, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
type PlanTask = BoardPlan['tasks'][number];

const REQUEST = 'Plan the export feature';
const personal: Principal = { id: 'personal:k1', role: 'personal' };

const task = (id: string, tier: 't1' | 't2' | 't3'): PlanTask => ({
  id,
  title: `Task ${id}`,
  goal: `Finish task ${id}`,
  lane: 'core',
  depends_on: [],
  source: [REQUEST],
  scope: [`src/${id}`],
  acceptance: ['pnpm test'],
  kind: { domain: 'backend-logic', tier },
});

const leadOf = (f: Fixture, leadId: string): Principal => ({
  id: `session:${leadId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: leadId,
  expires_at: f.store.now() + 60000,
});

async function heldLane(answers: PersonalAnswerKind[] = [], reviewer = false) {
  const f = await workbenchFixture({ userConfig: true });
  dispatchEveryTier(f);
  f.call('app.settings.set', { personal_answers: answers });
  if (!reviewer)
    f.adapter.report.capabilities.read_isolation = { status: 'unsupported', evidence: 'Not here' };
  const lead = await f.create(REQUEST);
  await settle(f, lead);
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [task('risky', 't3')],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    leadOf(f, lead.id),
  );
  return { f, lead };
}

const laneItems = (f: Fixture, p: Principal = user) =>
  f.control.needsYou(p, f.project.id).items.filter((item) => item.kind === 'board.lane.approval');

const approve = (f: Fixture, leadId: string, p: Principal = user) =>
  f.call(
    'board.lane.approve',
    { project_id: f.project.id, lead_session_id: leadId, lane_id: 'core' },
    null,
    p,
  );

function failure(fn: () => unknown): { code?: string } {
  try {
    fn();
  } catch (error) {
    return error as { code?: string };
  }
  throw new Error('Expected the command to fail');
}

it('lists a lane waiting for plan approval as one item the user approves', async () => {
  const { f, lead } = await heldLane();
  const plan = f.store.must<BoardPlan>('board_plans', lead.id);
  expect(laneItems(f)).toEqual([
    expect.objectContaining({
      source: { table: 'board_plans', id: lead.id, revision: plan.revision },
      session_id: lead.id,
      request_id: 'core',
      lane_title: 'Core',
      created_at: plan.lane_stops!.core!.held_at,
      reason: 'lane_plan_awaiting_approval',
      decision: 'plan_change',
      primary: 'board.lane.approve',
      actions: [{ command: 'board.lane.approve', allowed: true }],
      plan_review_running: false,
      next_step: 'Approve the plan to let its tasks start, or tell the lead what to change.',
    }),
  ]);
  approve(f, lead.id);
  expect(laneItems(f)).toEqual([]);
});

it('marks the item while the automatic plan review of its tasks still runs', async () => {
  const { f } = await heldLane([], true);
  expect(laneItems(f).map((item) => item.plan_review_running)).toEqual([true]);
});

it.each<[PersonalAnswerKind[], boolean]>([
  [['plan_change'], true],
  [['question', 'milestone_accept'], false],
])('lets a personal agent with %j allowed approve the plan: %s', async (answers, allowed) => {
  const { f, lead } = await heldLane(answers);
  expect(laneItems(f, personal).map((item) => [item.lane_title, item.actions[0]!.allowed])).toEqual(
    [['Core', allowed]],
  );
  const recorded = () =>
    (
      f.store.db.prepare("SELECT payload FROM events WHERE kind='personal.called'").all() as {
        payload: string;
      }[]
    ).map((row) => JSON.parse(row.payload));
  if (allowed) {
    approve(f, lead.id, personal);
    expect(f.store.must<BoardPlan>('board_plans', lead.id).lane_stops?.core).toMatchObject({
      approved_by: 'personal',
    });
    expect(recorded()).toEqual([
      { key_id: 'k1', type: 'board.lane.approve', project_id: f.project.id },
    ]);
  } else {
    expect(failure(() => approve(f, lead.id, personal)).code).toBe('permission_denied');
    expect(laneItems(f)).toHaveLength(1);
    expect(recorded()).toEqual([]);
  }
});

it('leaves the approval to the user once the project is over budget', async () => {
  const { f, lead } = await heldLane(['plan_change']);
  f.call(
    'workflow.policy.set',
    { project_id: f.project.id, project_budget: { input_tokens: 100 } },
    f.store.get<WorkflowPolicy>('workflow_policies', f.project.id)?.revision ?? null,
  );
  const now = Date.now.bind(Date);
  vi.spyOn(f.store, 'now').mockImplementation(() => now() + 1000);
  const turn = f.store.insert<SessionTurn>('session_turns', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    session_id: lead.id,
    input: 'work',
    kind: 'send',
    delivery: 'delivered',
    state: 'completed',
    usage: { input_tokens: 150, output_tokens: 0 },
  } as SessionTurn);
  f.store.event('turn.completed', turn, f.project.id, {});

  expect(laneItems(f, personal).map((item) => item.actions[0]!.allowed)).toEqual([false]);
  expect(failure(() => approve(f, lead.id, personal)).code).toBe('permission_denied');
  approve(f, lead.id);
  expect(laneItems(f)).toEqual([]);
});
