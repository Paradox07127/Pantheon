import { expect, it, vi } from 'vitest';
import type {
  BoardPlan,
  Principal,
  Retrospective,
  Session,
  StepRun,
  WorkflowPolicy,
} from '@pantheon/domain';
import { awaitWorkspaceReady, eventually } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = ReturnType<typeof workbenchFixture>;
type PlanTask = BoardPlan['tasks'][number];

const MINUTE = 60_000;
const leadOf = (f: Fixture, sessionId: string): Principal => ({
  id: `session:${sessionId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});
const task = (id: string, fields: Partial<PlanTask> = {}): PlanTask => ({
  id,
  title: `Task ${id}`,
  goal: `Finish task ${id}`,
  lane: 'core',
  depends_on: [],
  source: ['Plan the export feature'],
  scope: [`src/${id}`],
  acceptance: ['true'],
  ...fields,
});
const writePlan = (f: Fixture, leadId: string, tasks: PlanTask[]) =>
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: f.store.get<BoardPlan>('board_plans', leadId)?.plan_version ?? 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks,
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    leadOf(f, leadId),
  );
const settled = (f: Fixture, id: string) =>
  eventually(
    () =>
      f.store.must<Session>('sessions', id).state === 'open' &&
      f.turns(id).every((turn) => !['queued', 'running'].includes(turn.state)),
    () => f.control.tick(),
  );

it('times the wait for a workflow approval as its own stage, outside the budget ratio', async () => {
  const f = workbenchFixture();
  let skew = 0;
  vi.spyOn(f.store, 'now').mockImplementation(() => Date.now() + skew);
  f.call(
    'workflow.policy.set',
    {
      project_id: f.project.id,
      path: { t1: 'dispatch' },
      budget: { t1: { dispatch: { input_tokens: 1_000_000_000, wall_ms: 30 * MINUTE } } },
    },
    f.store.get<WorkflowPolicy>('workflow_policies', f.project.id)?.revision ?? null,
  );
  f.call('workflow.definition.set', {
    project_id: f.project.id,
    base_version: 0,
    definition: {
      slots: {
        before_dispatch: [
          { id: 'signoff', title: 'Approve the start', kind: { type: 'approval' } },
        ],
        before_merge: [],
        after_merge: [],
      },
      plan_review: { tiers: ['t3'] },
      review: { max_rounds: 3 },
    },
  });
  const lead = f.create('Plan the export feature');
  await awaitWorkspaceReady(f.control, lead.workspace_id!);
  await settled(f, lead.id);
  writePlan(f, lead.id, [
    task('a', { kind: { domain: 'backend-logic', tier: 't1' }, scope: ['src/a.ts'] }),
    task('b'),
  ]);
  f.call('task.start', { project_id: f.project.id, task_ids: ['a'] }, null, leadOf(f, lead.id));
  await f.control.tick();
  const run = f.store.list<StepRun>('workflow_step_runs')[0]!;
  expect(run).toMatchObject({ state: 'waiting' });
  skew += 60 * MINUTE;
  f.call('workflow.step.decide', { step_run_id: run.id, decision: 'approve' });
  await f.control.tick();
  const worker = f.store.list<Session>('sessions').find((s) => s.task?.id === 'a')!;
  await awaitWorkspaceReady(f.control, worker.workspace_id!);
  await settled(f, worker.id);
  writePlan(f, lead.id, [task('b')]);
  await eventually(
    () => f.store.list<Retrospective>('retrospectives').some((row) => row.task_id === 'a'),
    () => f.control.tick(),
  );
  const row = f.store.list<Retrospective>('retrospectives').find((r) => r.task_id === 'a')!;
  expect(row.stage_ms?.step_approval).toBeGreaterThanOrEqual(60 * MINUTE);
  expect(row.stage_ms?.dispatch_wait).toBeLessThan(MINUTE);
  expect(row.budget_ratio).toBeLessThan(1);
});

it('times concurrent approval leaves of a parallel step by their union', async () => {
  const f = workbenchFixture();
  let skew = 0;
  vi.spyOn(f.store, 'now').mockImplementation(() => Date.now() + skew);
  f.call('workflow.definition.set', {
    project_id: f.project.id,
    base_version: 0,
    definition: {
      slots: {
        before_dispatch: [
          {
            id: 'signoffs',
            title: 'Sign off the start',
            kind: {
              type: 'parallel',
              steps: [
                { id: 'legal', title: 'Legal sign-off', kind: { type: 'approval' } },
                { id: 'security', title: 'Security sign-off', kind: { type: 'approval' } },
              ],
            },
          },
        ],
        before_merge: [],
        after_merge: [],
      },
      plan_review: { tiers: ['t3'] },
      review: { max_rounds: 3 },
    },
  });
  const lead = f.create('Plan the export feature');
  await awaitWorkspaceReady(f.control, lead.workspace_id!);
  await settled(f, lead.id);
  writePlan(f, lead.id, [task('a'), task('b')]);
  f.call('task.start', { project_id: f.project.id, task_ids: ['a'] }, null, leadOf(f, lead.id));
  await f.control.tick();
  const leaf = (id: string) =>
    f.store.list<StepRun>('workflow_step_runs').find((run) => run.step.id === id)!;
  expect([leaf('legal').state, leaf('security').state]).toEqual(['waiting', 'waiting']);
  skew += 10 * MINUTE;
  f.call('workflow.step.decide', { step_run_id: leaf('legal').id, decision: 'approve' });
  await f.control.tick();
  skew += 50 * MINUTE;
  f.call('workflow.step.decide', { step_run_id: leaf('security').id, decision: 'approve' });
  await f.control.tick();
  const worker = f.store.list<Session>('sessions').find((s) => s.task?.id === 'a')!;
  await awaitWorkspaceReady(f.control, worker.workspace_id!);
  await settled(f, worker.id);
  writePlan(f, lead.id, [task('b')]);
  await eventually(
    () => f.store.list<Retrospective>('retrospectives').some((row) => row.task_id === 'a'),
    () => f.control.tick(),
  );
  const row = f.store.list<Retrospective>('retrospectives').find((r) => r.task_id === 'a')!;
  expect(row.stage_ms?.step_approval).toBeGreaterThanOrEqual(60 * MINUTE);
  expect(row.stage_ms?.step_approval).toBeLessThan(61 * MINUTE);
  expect(row.stage_ms?.dispatch_wait).toBeLessThan(MINUTE);
});
