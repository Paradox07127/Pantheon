import { expect, it } from 'vitest';
import { inputSchemas, leadToolEffects, sessionTools } from '@pantheon/protocol';

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

it('accepts an experience proposal and refuses a long procedure or a single retrospective', () => {
  const schema = inputSchemas['improvement.propose'];
  const experience = {
    project_id: 'project',
    retrospective_ids: ['first', 'second'],
    change: {
      type: 'experience',
      domain: 'backend-logic',
      tier: 't2',
      procedure: 'Run the migration test before the gate.',
      countercondition: 'The task changes no schema.',
    },
  };
  expect(schema.safeParse(experience).success).toBe(true);
  expect(
    schema.safeParse({
      ...experience,
      change: { ...experience.change, procedure: 'é'.repeat(301) },
    }).success,
  ).toBe(false);
  expect(schema.safeParse({ ...experience, retrospective_ids: ['first'] }).success).toBe(false);
  expect(
    schema.safeParse({
      ...experience,
      change: { type: 'policy_change', param: 'max_parallel', from: 3, to: 4 },
    }).success,
  ).toBe(false);
});

it('counts cited evidence of any kind toward the two items a proposal rests on', () => {
  const schema = inputSchemas['improvement.propose'];
  const proposal = {
    project_id: 'project',
    change: { type: 'policy_change', param: 'max_parallel', to: 2 },
  };
  const gateRun = { kind: 'gate_run', id: 'run' };
  expect(schema.safeParse({ ...proposal, evidence: [gateRun, gateRun] }).success).toBe(true);
  expect(
    schema.safeParse({
      ...proposal,
      evidence: [{ kind: 'retrospective', id: 'first' }, gateRun],
    }).success,
  ).toBe(true);
  expect(schema.safeParse({ ...proposal, evidence: [gateRun] }).success).toBe(false);
  const receipt = {
    kind: 'eval_receipt',
    path: '/evals/runs.jsonl',
    sha256: 'a'.repeat(64),
    verdict: 'no_conclusion',
  };
  expect(schema.safeParse({ ...proposal, evidence: [receipt] }).success).toBe(true);
  expect(
    schema.safeParse({ ...proposal, evidence: [gateRun, { kind: 'rumour', id: 'run' }] }).success,
  ).toBe(false);
});

it('accepts a known improvement decision and refuses an unknown one', () => {
  const schema = inputSchemas['improvement.decide'];
  const decision = { project_id: 'project', improvement_id: 'improvement' };
  for (const value of ['confirm', 'reject', 'revert', 'pin'])
    expect(schema.safeParse({ ...decision, decision: value }).success, value).toBe(true);
  expect(schema.safeParse({ ...decision, decision: 'approve' }).success).toBe(false);
});

it('maps the lead proposal tool to the proposal command with the board edit permission', () => {
  expect(sessionTools.lead).toMatchObject({ propose_improvement: 'improvement.propose' });
  expect(leadToolEffects.propose_improvement).toBe(leadToolEffects.edit_board);
});

it('accepts all seven pinned workflow parameters and proposals for quota and task budgets', () => {
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
  for (const [param, to] of [
    ['runtime_quota_threshold', 85],
    ['budget', { t2: { dispatch: { input_tokens: 500000, wall_ms: 200000 } } }],
  ])
    expect(
      inputSchemas['improvement.propose'].safeParse({
        project_id: 'project',
        retrospective_ids: ['first', 'second'],
        change: { type: 'policy_change', param, to },
      }).success,
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

it('validates optional reject metadata only on reject and trims before the note limit', () => {
  const schema = inputSchemas['improvement.decide'];
  const input = { project_id: 'project', improvement_id: 'rule', decision: 'reject' };
  expect(
    schema.parse({
      ...input,
      reject_reason: 'not_useful',
      reject_note: '  ' + 'x'.repeat(200) + '  ',
    }),
  ).toMatchObject({ reject_reason: 'not_useful', reject_note: 'x'.repeat(200) });
  expect(schema.safeParse({ ...input, reject_reason: 'unknown' }).success).toBe(false);
  expect(schema.safeParse({ ...input, reject_note: 'x'.repeat(201) }).success).toBe(false);
  expect(
    schema.safeParse({ ...input, decision: 'confirm', reject_reason: 'duplicate' }).success,
  ).toBe(false);
});

it('accepts disabled hand-backs or two through five and refuses one or values outside the range', () => {
  const schema = inputSchemas['workflow.policy.set'];
  for (const handback_limit of [0, 2, 3, 4, 5])
    expect(schema.safeParse({ project_id: 'project', handback_limit }).success).toBe(true);
  for (const handback_limit of [-1, 1, 6, 2.5])
    expect(schema.safeParse({ project_id: 'project', handback_limit }).success).toBe(false);
});
