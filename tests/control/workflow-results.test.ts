import { afterEach, expect, it, vi } from 'vitest';
import type { Retrospective, Review, StepRun, WorkflowDefinition } from '@pantheon/domain';
import type { WorkflowDefinitionView } from '@pantheon/protocol';
import { fixture, user } from '../helpers.js';

const now = new Date(2027, 2, 16, 12).getTime();
const at = (daysAgo: number) => new Date(2027, 2, 16 - daysAgo, 12).getTime();
const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
const opened = async () => {
  const f = await fixture({ now: () => now });
  fixtures.push(f);
  const definition: WorkflowDefinition = {
    slots: {
      before_dispatch: [{ id: 'approval', title: 'Approve dispatch', kind: { type: 'approval' } }],
      before_merge: [{ id: 'unused', title: 'Approve merge', kind: { type: 'approval' } }],
      after_merge: [],
    },
    plan_review: { tiers: ['t3'] },
    review: { max_rounds: 3 },
  };
  f.call('workflow.definition.set', { project_id: f.project.id, definition, base_version: 0 });
  return f;
};
const view = (f: Awaited<ReturnType<typeof opened>>): WorkflowDefinitionView =>
  f.control.workflowDefinition(user, f.project.id);

function run(
  f: Awaited<ReturnType<typeof opened>>,
  task_id: string,
  daysAgo: number,
  state: StepRun['state'],
) {
  return f.store.insert<StepRun>('workflow_step_runs', {
    id: `run-${task_id}`,
    revision: 1,
    project_id: f.project.id,
    lead_session_id: 'lead',
    task_id,
    generation: 1,
    definition_version: 1,
    slot: 'before_dispatch',
    step: { id: 'approval', title: 'Approve dispatch', kind: { type: 'approval' } },
    state,
    created_at: at(daysAgo),
    ...(['passed', 'failed', 'rejected', 'retired'].includes(state)
      ? { finished_at: at(daysAgo) }
      : {}),
  });
}

it('counts each task’s first step attempt once and omits unfinished or unused steps', async () => {
  const f = await opened();
  run(f, 'clean', 2, 'passed');
  run(f, 'approved', 1, 'passed');
  const repaired = run(f, 'repaired', 1, 'failed');
  f.store.event('workflow.step_changed', repaired, f.project.id, { state: 'failed' });
  const passed = f.store.update(
    'workflow_step_runs',
    { ...repaired, state: 'passed' as const },
    repaired.revision,
  );
  f.store.event('workflow.step_changed', passed, f.project.id, { state: 'passed' });
  run(f, 'old', 31, 'passed');
  run(f, 'unfinished', 0, 'running');
  const result = view(f);
  expect(result.step_results?.approval).toMatchObject({ tasks: 3, passed: 2 });
  expect(result.step_results).not.toHaveProperty('unused');
  expect(result.fixed_steps.every((step) => step.result === undefined)).toBe(true);
  expect(result.definition.slots.before_dispatch[0]).not.toHaveProperty('result');
  expect(view(await opened())).not.toHaveProperty('step_results');
});

it('counts the earliest run of a task only, and no run of a step that the definition does not list', async () => {
  const f = await opened();
  const first = run(f, 'retried', 3, 'failed');
  f.store.insert<StepRun>('workflow_step_runs', {
    ...first,
    id: 'run-retried-again',
    generation: 2,
    state: 'passed',
    created_at: at(1),
    finished_at: at(1),
  });
  const listed = run(f, 'removed', 1, 'passed');
  f.store.insert<StepRun>('workflow_step_runs', {
    ...listed,
    id: 'run-removed-step',
    step: { ...listed.step, id: 'removed' },
  });
  const result = view(f).step_results;
  expect(result?.approval).toMatchObject({ tasks: 2, passed: 1 });
  expect(result).not.toHaveProperty('removed');
});

it("does not count a skipped step as an attempt, and counts the task's first run that executed", async () => {
  const f = await opened();
  const skipped = run(f, 'conditional', 3, 'skipped');
  f.store.event('workflow.step_changed', skipped, f.project.id, { state: 'skipped' });
  const retired = f.store.update(
    'workflow_step_runs',
    { ...skipped, state: 'retired' as const },
    skipped.revision,
  );
  f.store.event('workflow.step_changed', retired, f.project.id, { state: 'retired' });
  const later = f.store.insert<StepRun>('workflow_step_runs', {
    ...skipped,
    id: 'run-conditional-again',
    revision: 1,
    generation: 2,
    state: 'passed',
    created_at: at(1),
    finished_at: at(1),
  });
  f.store.event('workflow.step_changed', later, f.project.id, { state: 'passed' });
  expect(view(f).step_results?.approval).toMatchObject({ tasks: 1, passed: 1 });
});

it('counts a step whose condition first skipped it and then applied once it ran', async () => {
  const f = await opened();
  const first = run(f, 'reapplied', 2, 'skipped');
  f.store.event('workflow.step_changed', first, f.project.id, { state: 'skipped' });
  let next = first;
  for (const state of ['pending', 'passed'] as const) {
    next = f.store.update('workflow_step_runs', { ...next, state }, next.revision);
    f.store.event('workflow.step_changed', next, f.project.id, { state });
  }
  expect(view(f).step_results?.approval).toMatchObject({ tasks: 1, passed: 1 });
});

it("counts only a workflow's own runs, and runs without a workflow id for the original one", async () => {
  const f = await opened();
  const copy = f.call<{ id: string }>('workflow.definition.save_as', {
    project_id: f.project.id,
    name: 'Copy',
  });
  run(f, 'unpinned', 2, 'passed');
  expect(f.control.workflowDefinition(user, f.project.id, copy.id)).not.toHaveProperty(
    'step_results',
  );
  const own = run(f, 'copied', 1, 'failed');
  f.store.update('workflow_step_runs', { ...own, workflow_id: copy.id }, own.revision);
  expect(
    f.control.workflowDefinition(user, f.project.id, copy.id).step_results?.approval,
  ).toMatchObject({ tasks: 1, passed: 0 });
  expect(view(f).step_results?.approval).toMatchObject({ tasks: 1, passed: 1 });
});

it('buckets completed first attempts into six local five-day windows, oldest first', async () => {
  const f = await opened();
  run(f, 'oldest', 29, 'passed');
  run(f, 'next', 24, 'passed');
  run(f, 'rejected', 20, 'rejected');
  run(f, 'newest', 0, 'retired');
  const result = view(f).step_results?.approval;
  expect(result).toEqual({
    tasks: 4,
    passed: 2,
    buckets: [
      { tasks: 1, passed: 1 },
      { tasks: 2, passed: 1 },
      { tasks: 0, passed: 0 },
      { tasks: 0, passed: 0 },
      { tasks: 0, passed: 0 },
      { tasks: 1, passed: 0 },
    ],
  });
  expect(result!.buckets.reduce((sum, bucket) => sum + bucket.tasks, 0)).toBe(result!.tasks);
  expect(result!.buckets.reduce((sum, bucket) => sum + bucket.passed, 0)).toBe(result!.passed);
});

it('uses the board gate first-pass rule and newest task retrospective for the same thirty days', async () => {
  const f = await opened();
  const record = (task_id: string, daysAgo: number, gate_passed_on_attempt?: number) =>
    f.store.insert<Retrospective>('retrospectives', {
      id: `retrospective-${task_id}-${daysAgo}`,
      revision: 1,
      project_id: f.project.id,
      lead_session_id: 'lead',
      task_id,
      session_ids: [],
      outcome: gate_passed_on_attempt ? 'merged' : 'failed',
      recorded_at: at(daysAgo),
      ...(gate_passed_on_attempt === undefined ? {} : { gate_passed_on_attempt }),
    });
  record('clean', 29, 2);
  record('repaired', 4, 2);
  record('never', 0);
  record('old', 31, 1);
  record('clean', 10, 1);
  const gate = view(f).fixed_steps.find((step) => step.id === 'gate')?.result;
  const board = f.control.boardView(user, f.project.id, 30).counts.gate_first_pass;
  expect(board).toEqual({ tasks: 3, passed: 1 });
  expect(gate).toMatchObject(board!);
  expect(gate!.buckets).toEqual([
    { tasks: 0, passed: 0 },
    { tasks: 0, passed: 0 },
    { tasks: 0, passed: 0 },
    { tasks: 1, passed: 1 },
    { tasks: 0, passed: 0 },
    { tasks: 2, passed: 0 },
  ]);
});

it('counts first review rounds without an upheld change request and preserves failures after a later clean round', async () => {
  const f = await opened();
  const record = (
    task_id: string,
    round: number,
    daysAgo: number,
    state: Review['state'],
    blocking = false,
  ) => {
    const clock = vi.spyOn(f.store, 'now').mockReturnValue(at(daysAgo));
    const review = f.store.insert<Review>('reviews', {
      id: `review-${task_id}-${round}`,
      revision: 1,
      project_id: f.project.id,
      session_id: `worker-${task_id}`,
      requester: { lead_session_id: 'lead', task_id, generation: 1 },
      round,
      runtimes: ['fixture'],
      state,
      session_ids: [],
      findings: [
        {
          id: `finding-${task_id}-${round}`,
          review_id: `review-${task_id}-${round}`,
          runtime: 'fixture',
          round,
          location: 'answer.ts:1',
          quote: 'answer',
          evidence: 'The answer needs a change',
          impact: 'The answer is incorrect',
          blocking,
          status: blocking ? 'stale' : 'open',
        },
      ],
    });
    f.store.event('review.requested', review, f.project.id, review);
    if (state !== 'running') f.store.event(`review.${state}`, review, f.project.id, {});
    clock.mockRestore();
    return review;
  };
  record('clean', 1, 29, 'completed');
  record('repaired', 1, 24, 'completed', true);
  record('repaired', 2, 1, 'completed');
  record('failed', 1, 1, 'failed');
  record('running', 1, 0, 'running');
  record('old', 1, 31, 'completed');
  const dismissed = record('dismissed', 1, 2, 'completed', true);
  f.store.update(
    'reviews',
    {
      ...dismissed,
      findings: dismissed.findings.map((finding) => ({ ...finding, status: 'rejected' as const })),
    },
    dismissed.revision,
  );
  const refused = record('refused', 1, 3, 'completed');
  f.store.update(
    'reviews',
    {
      ...refused,
      verdicts: [{ runtime: 'fixture', verdict: 'fail' as const, summary: 'Wrong answer', at: 1 }],
    },
    refused.revision,
  );
  const planReview = record('plan', 1, 0, 'completed');
  const { session_id: _, ...plan } = planReview;
  f.store.update('reviews', plan, plan.revision);
  expect(view(f).fixed_steps.find((step) => step.id === 'review')?.result).toEqual({
    tasks: 5,
    passed: 2,
    buckets: [
      { tasks: 1, passed: 1 },
      { tasks: 1, passed: 0 },
      { tasks: 0, passed: 0 },
      { tasks: 0, passed: 0 },
      { tasks: 0, passed: 0 },
      { tasks: 3, passed: 1 },
    ],
  });
});
