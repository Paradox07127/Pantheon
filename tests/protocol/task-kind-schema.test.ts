import { expect, it } from 'vitest';
import { inputSchemas } from '@pantheon/protocol';

const task = {
  id: 'api',
  title: 'Export API',
  goal: 'Serve exports over HTTP',
  lane: 'core',
  depends_on: [],
  source: ['Plan the export feature'],
  scope: ['src/export'],
  acceptance: ['pnpm test'],
};
const planWith = (extra: object) => ({
  project_id: 'project',
  base_version: 0,
  headline: 'Export',
  lanes: [{ id: 'core', title: 'Core' }],
  tasks: [{ ...task, ...extra }],
  milestones: [],
  risks: [],
  assumptions: [],
});
const validPlan = (extra: object) =>
  inputSchemas['board.plan.update'].safeParse(planWith(extra)).success;
const validPatch = (patch: object) =>
  inputSchemas['board.plan.edit'].safeParse({
    project_id: 'project',
    base_version: 3,
    ops: [{ type: 'set_task', task_id: 'api', patch }],
  }).success;

it('accepts a planned task with a kind and the reasons for leaving the routing and flow defaults', () => {
  expect(
    validPlan({
      kind: { domain: 'backend-logic', tier: 't2' },
      route_reason: 'The routed model is out of quota',
      flow_reason: 'Small enough to change directly',
    }),
  ).toBe(true);
});

it('accepts the review loop as the path of a planned task and refuses an unknown path', () => {
  expect(validPlan({ path: 'review_loop' })).toBe(true);
  expect(validPlan({ path: 'pairing' })).toBe(false);
});

it('refuses a task kind whose domain or tier is not a known value', () => {
  expect(validPlan({ kind: { domain: 'database', tier: 't2' } })).toBe(false);
  expect(validPlan({ kind: { domain: 'review', tier: 't4' } })).toBe(false);
});

it('lets a task patch set the kind, route reason and flow reason', () => {
  expect(validPatch({ kind: { domain: 'frontend-ui', tier: 't1' } })).toBe(true);
  expect(validPatch({ route_reason: 'Cheaper with the same pass rate' })).toBe(true);
  expect(validPatch({ flow_reason: 'Small enough to change directly' })).toBe(true);
});

it('stops a task with or without the lead whose plan the user acts on', () => {
  const stop = { project_id: 'project', task_id: 'api', reason: 'No longer needed' };
  expect(inputSchemas['task.stop'].safeParse(stop).success).toBe(true);
  expect(inputSchemas['task.stop'].safeParse({ ...stop, lead_session_id: 'lead' }).success).toBe(
    true,
  );
});

it('accepts optional task types and token budgets in plans and edits', () => {
  const schema = inputSchemas['board.plan.update'];
  const legacy = schema.parse(planWith({})).tasks[0]!;
  expect(legacy).not.toHaveProperty('task_type');
  expect(legacy).not.toHaveProperty('token_budget');
  for (const task_type of ['feature', 'fix', 'research', 'infra', 'docs']) {
    const fields = { task_type, token_budget: 120000 };
    expect(schema.parse(planWith(fields)).tasks[0]).toMatchObject(fields);
    expect(validPatch(fields)).toBe(true);
    expect(
      inputSchemas['board.plan.edit'].safeParse({
        project_id: 'project',
        base_version: 0,
        ops: [{ type: 'add_task', task: { ...task, ...fields } }],
      }).success,
    ).toBe(true);
  }
  expect(validPlan({ task_type: 'backend-logic' })).toBe(false);
  for (const token_budget of [0, -1, 1.5]) {
    expect(validPlan({ token_budget })).toBe(false);
    expect(validPatch({ token_budget })).toBe(false);
  }
});
