import { expect, it } from 'vitest';
import { inputSchemas, leadToolEffects, sessionTools } from '@pantheon/protocol';

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
const edit = (ops: unknown[]) => ({
  project_id: 'project',
  lead_session_id: 'lead',
  base_version: 3,
  ops,
});
const valid = (ops: unknown[]) => inputSchemas['board.plan.edit'].safeParse(edit(ops)).success;

it('accepts a plan edit of each kind of op', () => {
  for (const op of [
    { type: 'add_task', task: { ...task, priority: 'high' } },
    { type: 'remove_task', task_id: 'api' },
    {
      type: 'set_task',
      task_id: 'api',
      patch: {
        runtime: 'codex',
        model: 'gpt-5',
        effort: 'high',
        title: 'Export API v2',
        lane: 'core',
        priority: 'low',
      },
    },
    { type: 'set_dependencies', task_id: 'ui', depends_on: ['api'] },
    { type: 'refute_assumption', assumption_id: 'csv', instead: 'Exports are CSV and JSON.' },
    { type: 'resolve_edit', edit_id: 'edit-1', decision: 'apply' },
    { type: 'resolve_edit', edit_id: 'edit-1', decision: 'reject', reason: 'Wait for review' },
  ])
    expect(valid([op]), op.type).toBe(true);
});

it('accepts task contract and milestone patches', () => {
  for (const patch of [
    { goal: 'Serve exports over gRPC' },
    { scope: ['src/grpc'] },
    { acceptance: ['pnpm lint'] },
    { done_when: 'report' },
    { milestone: 'release' },
    { milestone: null },
    { brief: 'b'.repeat(2000) },
  ])
    expect(valid([{ type: 'set_task', task_id: 'api', patch }]), Object.keys(patch)[0]).toBe(true);
});

it('accepts each flow path or null as a task path patch and refuses other paths', () => {
  const setPath = (path: unknown) =>
    valid([{ type: 'set_task', task_id: 'api', patch: { path, flow_reason: 'Small change' } }]);
  for (const path of ['direct', 'dispatch', 'review_loop', null])
    expect(setPath(path), String(path)).toBe(true);
  for (const path of ['review', 'Direct', '']) expect(setPath(path), String(path)).toBe(false);
});

it('accepts null as a task model or effort patch and refuses an unknown effort', () => {
  const setTask = (patch: Record<string, unknown>) =>
    valid([{ type: 'set_task', task_id: 'api', patch }]);
  for (const patch of [{ model: null }, { effort: null }, { runtime: 'acp', model: null }])
    expect(setTask(patch), JSON.stringify(patch)).toBe(true);
  expect(setTask({ effort: 'huge' })).toBe(false);
});

it('takes the device, its reason, the labels a task needs and the resources it uses', () => {
  const placed = {
    device: 'build-box',
    device_reason: 'Only the build box has a GPU',
    needs: ['gpu', 'os=linux'],
    uses: { gpu: 1, 'test-db': 2 },
  };
  expect(valid([{ type: 'add_task', task: { ...task, ...placed } }])).toBe(true);
  expect(valid([{ type: 'set_task', task_id: 'api', patch: placed }])).toBe(true);
  for (const amount of [0, -1, 1.5])
    expect(valid([{ type: 'add_task', task: { ...task, uses: { gpu: amount } } }])).toBe(false);
  for (const needs of [[''], ['x'.repeat(65)], Array.from({ length: 9 }, (_, i) => `l${i}`)])
    expect(valid([{ type: 'add_task', task: { ...task, needs } }])).toBe(false);
});

it('refuses parallel parts without a scope path or acceptance command within the task bounds', () => {
  const part = { title: 'Writer', goal: 'Write export', scope: ['src/a'], acceptance: ['true'] };
  const withParts = (other: Record<string, unknown>) => {
    const parallel = [part, { ...part, ...other }];
    return [
      valid([{ type: 'add_task', task: { ...task, path: 'parallel', parallel } }]),
      valid([{ type: 'set_task', task_id: 'api', patch: { parallel } }]),
    ];
  };
  expect(withParts({})).toEqual([true, true]);
  for (const other of [
    { scope: [''] },
    { scope: [] },
    { scope: ['x'.repeat(201)] },
    { scope: Array(17).fill('src/b') },
    { acceptance: [] },
    { acceptance: [''] },
    { acceptance: ['x'.repeat(401)] },
    { acceptance: Array(9).fill('true') },
  ])
    expect(withParts(other), JSON.stringify(other).slice(0, 40)).toEqual([false, false]);
});

it('takes between one and 32 ops in a plan edit', () => {
  const remove = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ type: 'remove_task', task_id: `t${index}` }));
  expect(valid([])).toBe(false);
  expect(valid(remove(32))).toBe(true);
  expect(valid(remove(33))).toBe(false);
});

it('refuses a whole plan update without the plan version it was based on', () => {
  const plan = {
    project_id: 'project',
    headline: 'Export',
    lanes: [{ id: 'core', title: 'Core' }],
    tasks: [task],
    milestones: [],
    risks: [],
    assumptions: [],
  };
  expect(inputSchemas['board.plan.update'].safeParse(plan).success).toBe(false);
  expect(inputSchemas['board.plan.update'].safeParse({ ...plan, base_version: 0 }).success).toBe(
    true,
  );
});

it('gives the lead write tools to edit its plan and interrupt a task', () => {
  expect(sessionTools.lead).toMatchObject({
    edit_board: 'board.plan.edit',
    interrupt_task: 'task.interrupt',
  });
  expect(leadToolEffects).toMatchObject({ edit_board: 'write', interrupt_task: 'write' });
  expect(
    inputSchemas['task.interrupt'].safeParse({ project_id: 'project', task_id: 'api' }).success,
  ).toBe(true);
});

it('takes a brief of up to 2000 characters beside the 400-character goal', () => {
  expect(valid([{ type: 'add_task', task: { ...task, brief: 'b'.repeat(2000) } }])).toBe(true);
  for (const fields of [{ brief: 'b'.repeat(2001) }, { brief: '' }, { goal: 'g'.repeat(401) }])
    expect(valid([{ type: 'add_task', task: { ...task, ...fields } }])).toBe(false);
  expect(valid([{ type: 'set_task', task_id: 'api', patch: { brief: 'b'.repeat(2001) } }])).toBe(
    false,
  );
});

it('takes report text of up to 4000 characters, which the daemon allows a report task done report alone', () => {
  const report = (kind: string, length: number) =>
    inputSchemas['task.report'].safeParse({
      project_id: 'project',
      kind,
      text: 'r'.repeat(length),
      ...(kind === 'blocked' ? { reason: 'missing_context' } : {}),
    }).success;
  for (const kind of ['done', 'risk', 'task', 'dependency', 'requirement', 'blocked']) {
    expect(report(kind, 4000), kind).toBe(true);
    expect(report(kind, 4001), kind).toBe(false);
  }
});

it.each(['task.interrupt', 'task.message'] as const)(
  '%s takes an optional part: its number from 1 or its session id',
  (type) => {
    const input = {
      project_id: 'project',
      task_id: 'api',
      ...(type === 'task.message' ? { text: 'Go on' } : {}),
    };
    const parse = (fields: Record<string, unknown>) =>
      inputSchemas[type].safeParse({ ...input, ...fields }).success;
    for (const fields of [{}, { part: 1 }, { part: 4 }, { part: 'session' }])
      expect(parse(fields), JSON.stringify(fields)).toBe(true);
    for (const fields of [
      { part: 0 },
      { part: 5 },
      { part: 1.5 },
      { part: '' },
      { session_id: 's' },
    ])
      expect(parse(fields), JSON.stringify(fields)).toBe(false);
  },
);

it('accepts moves before another task or to the end', () => {
  for (const before of ['ui', null])
    expect(valid([{ type: 'move_task', task_id: 'api', before }])).toBe(true);
});

it('accepts iteration planning and validates dates, unique ids, references and estimates', () => {
  const iteration = {
    id: 'spring',
    title: 'Spring',
    starts_on: '2027-03-13',
    ends_on: '2027-03-16',
  };
  const plan = {
    project_id: 'project',
    base_version: 0,
    headline: 'Export',
    lanes: [{ id: 'core', title: 'Core' }],
    tasks: [{ ...task, iteration: 'spring', estimate: 5 }],
    iterations: [iteration],
    milestones: [],
    risks: [],
    assumptions: [],
  };
  const schema = inputSchemas['board.plan.update'];
  expect(schema.safeParse(plan).success).toBe(true);
  for (const iterations of [
    [iteration, iteration],
    [{ ...iteration, starts_on: '2027-03-17' }],
    [{ ...iteration, ends_on: '2027-02-30' }],
    [{ ...iteration, starts_on: '2027-3-13' }],
    [],
  ])
    expect(schema.safeParse({ ...plan, iterations }).success).toBe(false);
  expect(valid([{ type: 'set_iterations', iterations: [iteration] }])).toBe(true);
  expect(valid([{ type: 'set_iterations', iterations: [iteration, iteration] }])).toBe(false);
  expect(
    valid([{ type: 'set_task', task_id: 'api', patch: { iteration: null, estimate: 13 } }]),
  ).toBe(true);
  for (const estimate of [0, 14, 1.5]) {
    expect(schema.safeParse({ ...plan, tasks: [{ ...plan.tasks[0], estimate }] }).success).toBe(
      false,
    );
    expect(valid([{ type: 'set_task', task_id: 'api', patch: { estimate } }])).toBe(false);
  }
});

it('accepts a milestone due day as a calendar day and edits it with set_milestone', () => {
  const plan = {
    project_id: 'project',
    base_version: 0,
    headline: 'Export',
    lanes: [{ id: 'core', title: 'Core' }],
    tasks: [{ ...task, milestone: 'release' }],
    milestones: [
      {
        id: 'release',
        title: 'Release',
        criteria: ['Exports download'],
        tasks: ['api'],
        due_on: '2027-03-20',
      },
    ],
    risks: [],
    assumptions: [],
  };
  const schema = inputSchemas['board.plan.update'];
  expect(schema.safeParse(plan).success).toBe(true);
  const setMilestone = (patch: unknown) => ({
    type: 'set_milestone',
    milestone_id: 'release',
    patch,
  });
  expect(valid([setMilestone({ title: 'Launch', due_on: '2027-04-01' })])).toBe(true);
  expect(valid([setMilestone({ due_on: null })])).toBe(true);
  for (const due_on of ['2027-02-30', '2027-3-20', '20 March 2027', '']) {
    expect(
      schema.safeParse({ ...plan, milestones: [{ ...plan.milestones[0], due_on }] }).success,
    ).toBe(false);
    expect(valid([setMilestone({ due_on })])).toBe(false);
  }
  expect(valid([setMilestone({ criteria: ['More'] })])).toBe(false);
});

it("takes a lane's depth and stops, a milestone's re-plan triggers and an assumption's links, and refuses them out of bounds", () => {
  const lane = { id: 'core', title: 'Core' };
  const milestone = {
    id: 'release',
    title: 'Release',
    criteria: ['Exports download'],
    tasks: ['api'],
  };
  const plan = (fields: {
    lane?: Record<string, unknown>;
    milestone?: Record<string, unknown>;
    assumption?: Record<string, unknown>;
    risk?: Record<string, unknown>;
  }) =>
    inputSchemas['board.plan.update'].safeParse({
      project_id: 'project',
      base_version: 0,
      headline: 'Export',
      lanes: [{ ...lane, ...fields.lane }],
      tasks: [{ ...task, milestone: 'release' }],
      milestones: [{ ...milestone, ...fields.milestone }],
      risks: [{ text: 'The API may be slow.', ...fields.risk }],
      assumptions: [{ text: 'Exports are CSV only.', ...fields.assumption }],
    }).success;
  const trigger = { type: 'handbacks', count: 2 };
  for (const fields of [
    { lane: { depth: 'just_do' } },
    { lane: { depth: 'spec_first', depth_reason: 'The format needs the user first.' } },
    { lane: { stops: ['plan', 'milestone:release'] } },
    {
      milestone: {
        replan_if: [
          trigger,
          { type: 'budget_ratio', at: 2 },
          { type: 'stall' },
          { type: 'assumption_false', assumption_id: 'csv' },
        ],
      },
    },
    { assumption: { id: 'csv', affects: ['api'], milestone: 'release' } },
  ])
    expect(plan(fields), JSON.stringify(fields)).toBe(true);
  for (const fields of [
    { lane: { depth: 'deep' } },
    { lane: { stops: ['milestone:'] } },
    { milestone: { replan_if: Array(5).fill(trigger) } },
    { milestone: { replan_if: [{ type: 'handbacks', count: 0 }] } },
    { risk: { id: 'slow' } },
  ])
    expect(plan(fields), JSON.stringify(fields)).toBe(false);
});

it('accepts user order lock and unlock operations', () => {
  expect.soft(valid([{ type: 'lock_order', task_ids: ['api', 'ui'] }])).toBe(true);
  expect.soft(valid([{ type: 'unlock_order' }])).toBe(true);
});
