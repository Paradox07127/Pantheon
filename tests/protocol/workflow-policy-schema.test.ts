import { expect, it } from 'vitest';
import { inputSchemas } from '@pantheon/protocol';

it('accepts a workflow policy change and refuses an unknown parameter value', () => {
  const schema = inputSchemas['workflow.policy.set'];
  expect(
    schema.safeParse({
      project_id: 'project',
      improvement_mode: 'confirm',
      plan_changes: 'confirm',
      path: { t1: 'dispatch' },
      max_parallel: 2,
      task_size_hint: null,
      pinned: ['max_parallel'],
    }).success,
  ).toBe(true);
  expect(schema.safeParse({ project_id: 'project', acceptance_wake: 'hourly' }).success).toBe(
    false,
  );
  expect(schema.safeParse({ project_id: 'project', pinned: ['gate'] }).success).toBe(false);
  expect(schema.safeParse({ project_id: 'project', plan_changes: 'off' }).success).toBe(false);
});

it('accepts a budget cell and null for one, and refuses a cell without its wall-clock limit', () => {
  const schema = inputSchemas['workflow.policy.set'];
  expect(
    schema.safeParse({
      project_id: 'project',
      budget: { t1: { direct: { input_tokens: 400000, wall_ms: 95000 }, dispatch: null } },
    }).success,
  ).toBe(true);
  expect(
    schema.safeParse({ project_id: 'project', budget: { t1: { direct: { input_tokens: 1 } } } })
      .success,
  ).toBe(false);
  expect(
    schema.safeParse({
      project_id: 'project',
      budget: { t4: { direct: { input_tokens: 1, wall_ms: 1 } } },
    }).success,
  ).toBe(false);
});

it('accepts the review loop as a path and a budget cell, and refuses an unknown path', () => {
  const schema = inputSchemas['workflow.policy.set'];
  const cell = { input_tokens: 400000, wall_ms: 95000 };
  expect(
    schema.safeParse({
      project_id: 'project',
      path: { t2: 'review_loop' },
      budget: { t2: { review_loop: cell } },
    }).success,
  ).toBe(true);
  expect(schema.safeParse({ project_id: 'project', path: { t2: 'pairing' } }).success).toBe(false);
  expect(
    schema.safeParse({ project_id: 'project', budget: { t2: { pairing: cell } } }).success,
  ).toBe(false);
});

it('accepts a project budget and null for it, and refuses one that is not positive', () => {
  const schema = inputSchemas['workflow.policy.set'];
  const budget = (project_budget: unknown) =>
    schema.safeParse({ project_id: 'project', project_budget }).success;
  expect(budget({ input_tokens: 5000000 })).toBe(true);
  expect(budget(null)).toBe(true);
  expect(budget({ input_tokens: 0 })).toBe(false);
  expect(budget({ input_tokens: -1 })).toBe(false);
  expect(budget({ input_tokens: 1, since: 1 })).toBe(false);
});

it('accepts all seven pinned workflow parameters', () => {
  const pinned = [
    'path',
    'acceptance_wake',
    'max_parallel',
    'handback_limit',
    'task_size_hint',
    'runtime_quota_threshold',
    'budget',
  ];
  expect(
    inputSchemas['workflow.policy.set'].safeParse({ project_id: 'project', pinned }).success,
  ).toBe(true);
});

it('accepts runtime parallel limits and dispatch pause with schema validation', () => {
  const schema = inputSchemas['workflow.policy.set'];
  expect(
    schema.safeParse({
      project_id: 'project',
      runtime_parallel: { codex: 2, claude: 8 },
      dispatch_paused: true,
    }).success,
  ).toBe(true);
  for (const value of [0, 9, 1.5, '2'])
    expect(
      schema.safeParse({ project_id: 'project', runtime_parallel: { codex: value } }).success,
    ).toBe(false);
  expect(schema.safeParse({ project_id: 'project', runtime_parallel: {} }).success).toBe(true);
  expect(schema.safeParse({ project_id: 'project', dispatch_paused: 'true' }).success).toBe(false);
});

it('accepts a user hand-back with the lead, task and reason', () => {
  const schema = inputSchemas['task.handback'];
  expect(schema).toBeDefined();
  expect(
    schema.safeParse({ lead_session_id: 'lead', task_id: 'api', reason: 'Replan the approach' })
      .success,
  ).toBe(true);
  expect(schema.safeParse({ lead_session_id: 'lead', task_id: 'api' }).success).toBe(false);
});

it('accepts disabled hand-backs or two through five and refuses one or values outside the range', () => {
  const schema = inputSchemas['workflow.policy.set'];
  for (const handback_limit of [0, 2, 3, 4, 5])
    expect(schema.safeParse({ project_id: 'project', handback_limit }).success).toBe(true);
  for (const handback_limit of [-1, 1, 6, 2.5])
    expect(schema.safeParse({ project_id: 'project', handback_limit }).success).toBe(false);
});
