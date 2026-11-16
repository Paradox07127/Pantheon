import { expect, it } from 'vitest';
import { inputSchemas, querySchemas } from '@pantheon/protocol';

const definition = {
  slots: { before_dispatch: [], before_merge: [], after_merge: [] },
  plan_review: { tiers: ['t3'] },
  review: { max_rounds: 3 },
};

it('accepts stored workflow slots, applicability and deferred step kinds', () => {
  const schema = inputSchemas['workflow.definition.set'];
  expect(schema).toBeDefined();
  for (const kind of [
    { type: 'command', command: 'pnpm test', timeout_seconds: 60 },
    { type: 'approval' },
    {
      type: 'prompt',
      prompt: 'Check the contract',
      target: 'task',
      skill: { name: 'check', path: '/skills/check' },
    },
    { type: 'review', runtime: 'reviewer', blocking: true },
  ]) {
    expect(
      schema.safeParse({
        project_id: 'project',
        base_version: 0,
        definition: {
          ...definition,
          slots: {
            ...definition.slots,
            after_merge: [
              {
                id: 'check',
                title: 'Check the contract',
                applies_to: { tiers: ['t2'], domains: ['backend-logic'] },
                kind,
              },
            ],
          },
        },
      }).success,
    ).toBe(true);
  }
  expect(querySchemas['workflow.definition'].safeParse({ project_id: 'project' }).success).toBe(
    true,
  );
});

it('validates workflow review bounds and approval decisions at the protocol boundary', () => {
  const schema = inputSchemas['workflow.definition.set'];
  expect(schema).toBeDefined();
  for (const max_rounds of [0, 6, 1.5])
    expect(
      schema.safeParse({
        project_id: 'project',
        base_version: 0,
        definition: { ...definition, review: { max_rounds } },
      }).success,
    ).toBe(false);
  for (const max_rounds of [1, 5])
    expect(
      schema.safeParse({
        project_id: 'project',
        base_version: 0,
        definition: { ...definition, review: { max_rounds } },
      }).success,
    ).toBe(true);
  for (const decision of ['approve', 'reject'])
    expect(
      inputSchemas['workflow.step.decide'].safeParse({
        step_run_id: 'run',
        decision,
        reason: 'Checked',
      }).success,
    ).toBe(true);
  expect(
    inputSchemas['workflow.step.decide'].safeParse({ step_run_id: 'run', decision: 'skip' })
      .success,
  ).toBe(false);
});

it('accepts named workflow commands and validates names', () => {
  expect(
    querySchemas['workflow.definition.list'].safeParse({ project_id: 'project' }).success,
  ).toBe(true);
  expect(
    querySchemas['workflow.definition'].safeParse({ project_id: 'project', id: 'release' }).success,
  ).toBe(true);
  expect(
    inputSchemas['workflow.definition.set'].safeParse({
      project_id: 'project',
      id: 'release',
      base_version: 0,
      definition,
    }).success,
  ).toBe(true);
  for (const name of ['Release', 'a'.repeat(60)])
    expect(
      inputSchemas['workflow.definition.save_as'].safeParse({
        project_id: 'project',
        from_id: 'source',
        name,
      }).success,
    ).toBe(true);
  for (const name of ['', 'a'.repeat(61)])
    expect(
      inputSchemas['workflow.definition.save_as'].safeParse({ project_id: 'project', name })
        .success,
    ).toBe(false);
  expect(
    inputSchemas['workflow.definition.set_default'].safeParse({
      project_id: 'project',
      id: 'release',
    }).success,
  ).toBe(true);
});

it('validates changed-path conditions and bounded non-nested parallel and loop steps', () => {
  const leaf = {
    id: 'check',
    title: 'Check',
    kind: { type: 'command', command: 'true', timeout_seconds: 5 },
  };
  const accepts = (step: unknown) =>
    inputSchemas['workflow.definition.set'].safeParse({
      project_id: 'project',
      base_version: 0,
      definition: { ...definition, slots: { ...definition.slots, before_merge: [step] } },
    }).success;
  expect(accepts({ ...leaf, when: { changed_paths: ['src/**/*.ts'] } })).toBe(true);
  expect(accepts({ ...leaf, when: { changed_paths: Array(17).fill('src/**') } })).toBe(false);
  const parallel = { ...leaf, kind: { type: 'parallel', steps: [leaf, { ...leaf, id: 'lint' }] } };
  const loop = { ...leaf, kind: { type: 'loop', step: leaf, max: 5, until: 'passes' } };
  expect(accepts(parallel)).toBe(true);
  expect(accepts(loop)).toBe(true);
  for (const steps of [[leaf], Array(5).fill(leaf)])
    expect(accepts({ ...parallel, kind: { type: 'parallel', steps } })).toBe(false);
  for (const max of [0, 6, 1.5])
    expect(accepts({ ...loop, kind: { ...loop.kind, max } })).toBe(false);
  expect(accepts({ ...parallel, kind: { type: 'parallel', steps: [loop, leaf] } })).toBe(false);
  expect(accepts({ ...loop, kind: { ...loop.kind, step: parallel } })).toBe(false);
});

it('accepts the parallel path on a task with two to four lead-defined parts, not as a tier default', () => {
  const task = {
    id: 'export',
    title: 'Export',
    goal: 'Export data',
    lane: 'core',
    depends_on: [],
    source: ['Export data'],
    scope: ['src'],
    acceptance: ['true'],
    path: 'parallel',
    workflow_id: 'release',
    parallel: [
      { title: 'Writer', goal: 'Write export', scope: ['src/export.ts'], acceptance: ['true'] },
      { title: 'Tests', goal: 'Test export', scope: ['src/export.test.ts'], acceptance: ['true'] },
    ],
  };
  const accepts = (parallel: unknown) =>
    inputSchemas['board.plan.edit'].safeParse({
      project_id: 'project',
      base_version: 0,
      ops: [{ type: 'add_task', task: { ...task, parallel } }],
    }).success;
  expect(accepts(task.parallel)).toBe(true);
  expect(accepts([task.parallel[0]])).toBe(false);
  expect(accepts(Array(5).fill(task.parallel[0]))).toBe(false);
  // A tier cannot default to parallel: only a task with lead-defined parts takes that path.
  expect(
    inputSchemas['workflow.policy.set'].safeParse({
      project_id: 'project',
      path: { t2: 'parallel' },
    }).success,
  ).toBe(false);
  expect(
    inputSchemas['workflow.policy.set'].safeParse({
      project_id: 'project',
      budget: { t2: { parallel: { input_tokens: 1, wall_ms: 1 } } },
    }).success,
  ).toBe(true);
});
