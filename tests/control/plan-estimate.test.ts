import { expect, it } from 'vitest';
import type { BoardPlan, Principal, Retrospective, WorkflowPolicy } from '@pantheon/domain';
import { settle, user } from '../helpers.js';
import { dispatchEveryTier, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
type PlanTask = BoardPlan['tasks'][number];

const REQUEST = 'Plan the export feature';

const task = (id: string, kind: PlanTask['kind'], fields: Partial<PlanTask> = {}): PlanTask => ({
  id,
  title: `Task ${id}`,
  goal: `Finish task ${id}`,
  lane: 'core',
  depends_on: [],
  source: [REQUEST],
  scope: [`src/${id}.ts`],
  acceptance: ['pnpm test'],
  kind,
  ...fields,
});

const backend = (tier: 't1' | 't2' | 't3') => ({ domain: 'backend-logic' as const, tier });

const leadOf = (f: Fixture, leadId: string): Principal => ({
  id: `session:${leadId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: leadId,
  expires_at: f.store.now() + 60000,
});

const setPolicy = (f: Fixture, settings: Record<string, unknown>) =>
  f.call(
    'workflow.policy.set',
    { project_id: f.project.id, ...settings },
    f.store.get<WorkflowPolicy>('workflow_policies', f.project.id)?.revision ?? null,
  );

/** Writes the lead's plan of one lane, holds the lane by the user's depth, and reads its estimate. */
async function estimateOf(
  f: Fixture,
  tasks: PlanTask[],
  milestones: { id: string; title: string; criteria: string[]; tasks: string[] }[] = [],
) {
  const lead = await f.create(REQUEST);
  await settle(f, lead);
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks,
      milestones,
      risks: [],
      assumptions: [],
    },
    null,
    leadOf(f, lead.id),
  );
  f.call(
    'board.lane.depth.set',
    { project_id: f.project.id, lead_session_id: lead.id, lane_id: 'core', depth: 'plan_first' },
    null,
  );
  return f.control.boardView(user, f.project.id, 1).lanes[0]!.estimate!;
}

it.each([
  { tier: 't2' as const, planReview: 0 },
  { tier: 't3' as const, planReview: 1 },
])(
  'counts a session per task, the review rounds, the milestone check and a plan review for a $tier task',
  async ({ tier, planReview }) => {
    const f = await workbenchFixture();
    dispatchEveryTier(f);
    setPolicy(f, { milestone_verify: 'auto' });
    f.call('workflow.definition.set', {
      project_id: f.project.id,
      base_version: 0,
      definition: {
        slots: { before_dispatch: [], before_merge: [], after_merge: [] },
        plan_review: { tiers: ['t3'] },
        review: { max_rounds: 2 },
      },
    });
    const estimate = await estimateOf(
      f,
      [
        task('a', backend('t2'), { milestone: 'm1' }),
        task('b', backend('t2'), { milestone: 'm1' }),
        task('c', backend(tier), {
          milestone: 'm1',
          path: 'review_loop',
          flow_reason: 'Another runtime checks it',
        }),
      ],
      [{ id: 'm1', title: 'Export', criteria: ['Exports download'], tasks: ['a', 'b', 'c'] }],
    );
    expect(estimate).toMatchObject({
      tasks: 3,
      milestones: 1,
      sessions: {
        total: 3 + 2 + 1 + planReview,
        by_part: { tasks: 3, reviews: 2, plan_review: planReview, milestone_verify: 1 },
      },
    });
    expect(estimate.runtimes).toContainEqual({
      role: 'writer',
      runtime: f.adapter.name,
      count: 3,
    });
  },
);

it('sums tokens from the budget and counts the rest as unknown, whatever history the store holds', async () => {
  const f = await workbenchFixture();
  dispatchEveryTier(f);
  const kind = backend('t2');
  for (const [index, tokens] of [1000, 3000].entries())
    f.store.insert<Retrospective>('retrospectives', {
      id: `retrospective-${index}`,
      revision: 1,
      project_id: f.project.id,
      lead_session_id: 'earlier-lead',
      task_id: `earlier-${index}`,
      session_ids: [],
      outcome: 'merged',
      recorded_at: index,
      runtime: f.adapter.name,
      model: 'fixture-model',
      measured_kind: kind,
      gate_passed_on_attempt: 1,
      task_usage: { input_tokens: tokens - 100, output_tokens: 100 },
    });
  const estimate = await estimateOf(f, [
    task('seen', kind),
    task('again', kind),
    task('small', backend('t1')),
    task('risky', { domain: 'frontend-ui', tier: 't3' }),
  ]);
  expect(estimate.tokens).toEqual({
    history: { total: 0, tasks: 0, min_n: 0 },
    budget: { total: 1120000, tasks: 1 },
    unknown_tasks: 3,
  });
  expect(estimate.wall_ms).toEqual({ total: 255000, tasks: 1 });
});
