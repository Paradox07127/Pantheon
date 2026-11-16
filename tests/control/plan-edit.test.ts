import { afterEach, expect, it } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import { id } from '@pantheon/domain';
import type {
  BoardPlan,
  LeadNote,
  Milestone,
  Principal,
  Session,
  SessionTurn,
} from '@pantheon/domain';
import { fixture, insertSession, user } from '../helpers.js';
import { git } from './workbench-fixture.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

type Fixture = ReturnType<typeof fixture>;

function failure(fn: () => unknown): { code?: string; message?: string } {
  try {
    fn();
  } catch (error) {
    return error as { code?: string; message?: string };
  }
  throw new Error('Expected the command to fail');
}

function setup() {
  const f = fixture({ adapter: new FixtureAdapter(100), managedWorkspaces: true });
  cleanups.push(() => f.close());
  return f;
}

const REQUEST = 'Ship the export API and a download button this week.';

function leadOf(f: Fixture): Principal {
  const lead = insertSession(f);
  f.store.insert('session_turns', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    session_id: lead.id,
    input: REQUEST,
    kind: 'send',
    delivery: 'delivered',
    state: 'completed',
  });
  return {
    id: `session:${lead.id}`,
    role: 'lead',
    project_id: f.project.id,
    session_id: lead.id,
    expires_at: f.store.now() + 60000,
  };
}

const TASKS = [
  {
    id: 'api',
    title: 'API',
    goal: 'Serve exports',
    lane: 'core',
    depends_on: [],
    source: ['Ship the export API'],
    scope: ['packages/export'],
    acceptance: ['pnpm test'],
  },
  {
    id: 'ui',
    title: 'UI',
    goal: 'Download button',
    lane: 'core',
    depends_on: ['api'],
    source: ['a download button'],
    scope: ['apps/web/src/export'],
    acceptance: ['pnpm build', 'pnpm test'],
  },
];

function writePlan(f: Fixture, lead: Principal) {
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [
        { id: 'core', title: 'Core' },
        { id: 'docs', title: 'Docs' },
      ],
      tasks: TASKS,
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    lead,
  );
}

const planOf = (f: Fixture, lead: Principal) =>
  f.store.must<BoardPlan>('board_plans', lead.session_id!);
const taskOf = (f: Fixture, lead: Principal, taskId: string) =>
  planOf(f, lead).tasks.find((task) => task.id === taskId);

function edit(f: Fixture, principal: Principal, lead: Principal, ops: unknown[]) {
  return f.call<Record<string, unknown>>(
    'board.plan.edit',
    {
      project_id: f.project.id,
      ...(principal.role === 'user' ? { lead_session_id: lead.session_id } : {}),
      base_version: planOf(f, lead).plan_version,
      ops,
    },
    null,
    principal,
  );
}

/** A task session of the lead's plan that has not finished. */
function running(f: Fixture, lead: Principal, taskId: string) {
  return insertSession(f, {
    state: 'running',
    task: { lead_session_id: lead.session_id!, id: taskId, generation: 1 },
  });
}

const userEdits = (f: Fixture, lead: Principal): LeadNote[] =>
  planOf(f, lead).inbox.filter((note) => note.kind === 'user_edit');

const setModel = (taskId = 'api') => ({
  type: 'set_task',
  task_id: taskId,
  patch: { model: 'claude-opus-4-5' },
});

it('lets the lead set one field of a task by id', () => {
  const f = setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  const before = planOf(f, lead);
  edit(f, lead, lead, [setModel()]);
  const after = planOf(f, lead);
  expect(after.tasks).toEqual([{ ...before.tasks[0]!, model: 'claude-opus-4-5' }, before.tasks[1]]);
  expect(after.headline).toBe(before.headline);
});

it('refuses a lead edit that adds a task closing a dependency cycle', () => {
  const f = setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  const before = planOf(f, lead);
  const error = failure(() =>
    edit(f, lead, lead, [
      { type: 'add_task', task: { ...TASKS[0]!, id: 'docs', depends_on: ['ui'] } },
      { type: 'set_dependencies', task_id: 'api', depends_on: ['docs'] },
    ]),
  );
  expect(error.code).toBe('invalid_input');
  expect(error.message).toContain('cycle');
  expect(planOf(f, lead).tasks).toEqual(before.tasks);
});

it('applies a user edit of a task without a session and tells the lead it is in effect', () => {
  const f = setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  const result = edit(f, user, lead, [setModel()]);
  expect(result.plan_version).toBe(planOf(f, lead).plan_version);
  expect(taskOf(f, lead, 'api')?.model).toBe('claude-opus-4-5');
  const notes = userEdits(f, lead);
  expect(notes).toHaveLength(1);
  expect(notes[0]!.edit).toMatchObject({ applied: true, ops: [setModel()] });
  expect(planOf(f, lead).pending_edits).toEqual([]);
});

it('holds a user edit of the model of a task with a running session for the lead', () => {
  const f = setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  running(f, lead, 'api');
  const before = planOf(f, lead);
  const result = edit(f, user, lead, [setModel()]);
  expect(result).not.toHaveProperty('plan_version');
  const after = planOf(f, lead);
  expect(after.tasks).toEqual(before.tasks);
  expect(after.plan_version).toBe(before.plan_version);
  expect(after.pending_edits).toEqual([
    expect.objectContaining({ status: 'pending', task_ids: ['api'], ops: [setModel()] }),
  ]);
  const notes = userEdits(f, lead);
  expect(notes).toHaveLength(1);
  expect(notes[0]!.edit).toMatchObject({
    edit_id: after.pending_edits[0]!.edit_id,
    applied: false,
  });
});

it('applies or rejects a held user edit when the lead resolves it', () => {
  const f = setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  running(f, lead, 'api');
  running(f, lead, 'ui');
  edit(f, user, lead, [setModel('api')]);
  edit(f, user, lead, [setModel('ui')]);
  const [first, second] = planOf(f, lead).pending_edits;

  edit(f, lead, lead, [{ type: 'resolve_edit', edit_id: first!.edit_id, decision: 'apply' }]);
  expect(taskOf(f, lead, 'api')?.model).toBe('claude-opus-4-5');
  expect(planOf(f, lead).pending_edits[0]).toMatchObject({
    status: 'applied',
    resolved_at: expect.any(Number),
  });

  edit(f, lead, lead, [
    { type: 'resolve_edit', edit_id: second!.edit_id, decision: 'reject', reason: 'Keep it' },
  ]);
  expect(taskOf(f, lead, 'ui')?.model).toBeUndefined();
  expect(planOf(f, lead).pending_edits[1]).toMatchObject({
    status: 'rejected',
    reason: 'Keep it',
    resolved_at: expect.any(Number),
  });

  for (const editId of [first!.edit_id, 'missing'])
    expect(
      failure(() =>
        edit(f, lead, lead, [{ type: 'resolve_edit', edit_id: editId, decision: 'apply' }]),
      ).code,
      editId,
    ).toBe('not_found');
});

it('wakes the idle lead for a held edit and leaves record edits for its next message', async () => {
  const f = setup();
  // Real worktrees, so a tick reports no failed provisioning that would wake the lead itself.
  git(f.projectRoot, 'init', '--quiet', '--initial-branch=main');
  git(f.projectRoot, 'commit', '--quiet', '--allow-empty', '-m', 'Initial commit');
  const lead = leadOf(f);
  writePlan(f, lead);
  running(f, lead, 'api');
  const wakes = () =>
    f.store
      .list<SessionTurn>('session_turns')
      .filter((turn) => turn.session_id === lead.session_id && turn.origin === 'tracker').length;
  edit(f, user, lead, [{ type: 'set_task', task_id: 'ui', patch: { title: 'Download' } }]);
  expect(userEdits(f, lead)[0]!.edit?.applied).toBe(true);
  await f.control.tick();
  expect(wakes()).toBe(0);
  edit(f, user, lead, [setModel()]);
  expect(userEdits(f, lead)[1]!.edit?.applied).toBe(false);
  await f.control.tick();
  expect(wakes()).toBe(1);
});

it('applies a user edit of the title of a task with a running session', () => {
  const f = setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  running(f, lead, 'api');
  edit(f, user, lead, [{ type: 'set_task', task_id: 'api', patch: { title: 'Export API' } }]);
  expect(taskOf(f, lead, 'api')?.title).toBe('Export API');
  expect(planOf(f, lead).pending_edits).toEqual([]);
  expect(userEdits(f, lead)[0]!.edit?.applied).toBe(true);
});

it('takes a removed task out of the dependencies of the tasks after it', () => {
  const f = setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  expect(edit(f, user, lead, [{ type: 'remove_task', task_id: 'api' }])).toMatchObject({
    applied: true,
  });
  expect(planOf(f, lead).tasks.map((task) => [task.id, task.depends_on])).toEqual([['ui', []]]);
});

it('holds a whole user edit when one of its ops waits for the lead', () => {
  const f = setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  running(f, lead, 'api');
  const before = planOf(f, lead);
  edit(f, user, lead, [
    { type: 'set_task', task_id: 'ui', patch: { title: 'Download' } },
    { type: 'remove_task', task_id: 'api' },
    { type: 'set_dependencies', task_id: 'ui', depends_on: [] },
  ]);
  expect(planOf(f, lead).tasks).toEqual(before.tasks);
  expect(planOf(f, lead).pending_edits[0]).toMatchObject({
    status: 'pending',
    task_ids: ['ui', 'api'],
  });
});

it('refuses a user edit that waits for a lead whose session has closed', () => {
  const f = setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  running(f, lead, 'api');
  const leadSession = f.store.must<Session>('sessions', lead.session_id!);
  f.store.update('sessions', { ...leadSession, state: 'closed' }, leadSession.revision);
  const before = planOf(f, lead);
  expect(failure(() => edit(f, user, lead, [setModel()])).code).toBe('lead_unavailable');
  expect(planOf(f, lead)).toEqual(before);
});

it('refuses a user edit that resolves a held edit or names no lead', () => {
  const f = setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  running(f, lead, 'api');
  edit(f, user, lead, [setModel()]);
  const editId = planOf(f, lead).pending_edits[0]!.edit_id;
  expect(
    failure(() =>
      edit(f, user, lead, [{ type: 'resolve_edit', edit_id: editId, decision: 'apply' }]),
    ).code,
  ).toBe('permission_denied');
  expect(planOf(f, lead).pending_edits[0]!.status).toBe('pending');
  expect(
    failure(() =>
      f.call(
        'board.plan.edit',
        { project_id: f.project.id, base_version: planOf(f, lead).plan_version, ops: [setModel()] },
        null,
        user,
      ),
    ).code,
  ).toBe('invalid_input');
});

it('takes the source of a task the user adds as the user own words', () => {
  const f = setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  const docs = {
    ...TASKS[0]!,
    id: 'docs',
    lane: 'docs',
    source: ['Document the export format'],
    scope: ['docs/export.md'],
  };
  edit(f, user, lead, [{ type: 'add_task', task: docs }]);
  expect(taskOf(f, lead, 'docs')).toEqual({ ...docs, kind: { domain: 'docs-chore', tier: 't1' } });
  // The lead may send the task back in a whole plan, quoting the user's edit.
  edit(f, lead, lead, [{ type: 'set_task', task_id: 'docs', patch: { title: 'Docs' } }]);
  expect(taskOf(f, lead, 'docs')?.title).toBe('Docs');
  const error = failure(() =>
    edit(f, lead, lead, [
      { type: 'add_task', task: { ...docs, id: 'faq', source: ['Write an FAQ'] } },
    ]),
  );
  expect(error.code).toBe('invalid_input');
  expect(error.message).toContain('verbatim');
});

it.each([
  { goal: 'Serve compressed exports' },
  { scope: ['packages/download'] },
  { acceptance: ['pnpm build'] },
  { done_when: 'report' },
])('edits a task contract and starts its next generation: %j', (patch) => {
  const f = setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  const before = planOf(f, lead).generations!.api!.generation;
  expect(edit(f, user, lead, [{ type: 'set_task', task_id: 'api', patch }]).applied).toBe(true);
  expect(taskOf(f, lead, 'api')).toMatchObject(patch);
  expect(planOf(f, lead).generations!.api!.generation).toBe(before + 1);
});

it.each([
  { goal: 'Serve compressed exports' },
  { scope: ['packages/download'] },
  { acceptance: ['pnpm build'] },
  { done_when: 'report' },
])('holds a contract patch on unfinished work until the lead applies it: %j', (patch) => {
  const f = setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  running(f, lead, 'api');
  const before = planOf(f, lead);
  const result = edit(f, user, lead, [{ type: 'set_task', task_id: 'api', patch }]);
  expect(result.applied).toBe(false);
  expect(planOf(f, lead).tasks).toEqual(before.tasks);
  edit(f, lead, lead, [{ type: 'resolve_edit', edit_id: result.edit_id, decision: 'apply' }]);
  expect(taskOf(f, lead, 'api')).toMatchObject(patch);
  expect(planOf(f, lead).generations!.api!.generation).toBe(2);
});

it('validates the merged task when changing completion mode or clearing its contract', () => {
  const f = setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  for (const patch of [{ scope: [] }, { acceptance: [] }]) {
    const before = planOf(f, lead);
    const error = failure(() => edit(f, user, lead, [{ type: 'set_task', task_id: 'api', patch }]));
    expect(error.message).toContain('done when merged needs');
    expect(planOf(f, lead)).toEqual(before);
  }
  edit(f, user, lead, [
    {
      type: 'set_task',
      task_id: 'api',
      patch: { done_when: 'report', scope: [], acceptance: [] },
    },
  ]);
  const error = failure(() =>
    edit(f, user, lead, [
      {
        type: 'set_task',
        task_id: 'api',
        patch: { done_when: 'merged' },
      },
    ]),
  );
  expect(error.message).toContain('done when merged needs');
});

it('moves unfinished tasks before another task and to the end without changing contracts', () => {
  const f = setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  running(f, lead, 'ui');
  const before = planOf(f, lead);
  expect(edit(f, user, lead, [{ type: 'move_task', task_id: 'ui', before: 'api' }]).applied).toBe(
    true,
  );
  expect(planOf(f, lead).tasks.map((task) => task.id)).toEqual(['ui', 'api']);
  edit(f, user, lead, [{ type: 'move_task', task_id: 'ui', before: null }]);
  expect(planOf(f, lead).tasks).toEqual(before.tasks);
  expect(planOf(f, lead).generations).toEqual(before.generations);
  expect(planOf(f, lead).contract_changed).toEqual(before.contract_changed);
  expect(planOf(f, lead).pending_edits).toEqual([]);
  expect(userEdits(f, lead).every((note) => note.edit?.wake === false)).toBe(true);
});

it('updates milestone membership at once for unfinished work and removes it with null', () => {
  const f = setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  const plan = planOf(f, lead);
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: plan.plan_version,
      headline: plan.headline,
      lanes: plan.lanes,
      tasks: plan.tasks.map((task) => ({
        ...task,
        milestone: task.id === 'ui' ? 'release' : undefined,
      })),
      milestones: [
        { id: 'release', title: 'Release', criteria: ['Exports download'], tasks: ['ui'] },
      ],
      risks: [],
      assumptions: [],
    },
    null,
    lead,
  );
  running(f, lead, 'api');
  const generations = planOf(f, lead).generations;
  for (const milestone of ['release', null]) {
    expect(
      edit(f, user, lead, [{ type: 'set_task', task_id: 'api', patch: { milestone } }]).applied,
    ).toBe(true);
    expect(taskOf(f, lead, 'api')?.milestone).toBe(milestone ?? undefined);
    const release = f.store.list<Milestone>('milestones').find((row) => row.key === 'release')!;
    expect(release.task_ids).toEqual(milestone ? ['ui', 'api'] : ['ui']);
  }
  expect(planOf(f, lead).generations).toEqual(generations);
});

it.each([
  [{ type: 'add_task', task: { ...TASKS[0]!, id: 'docs' } }],
  [{ type: 'remove_task', task_id: 'ui' }],
  [{ type: 'set_dependencies', task_id: 'ui', depends_on: [] }],
  ...(['goal', 'scope', 'acceptance', 'done_when', 'runtime', 'model', 'effort'] as const).map(
    (field) => [
      {
        type: 'set_task',
        task_id: 'api',
        patch: {
          [field]: {
            goal: 'Serve compressed exports',
            scope: ['packages/download'],
            acceptance: ['pnpm build'],
            done_when: 'report',
            runtime: 'codex',
            model: 'new-model',
            effort: 'high',
          }[field],
        },
      },
    ],
  ),
])('records that an effective planning edit wakes the lead: %j', (...ops) => {
  const f = setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  edit(f, user, lead, ops);
  expect(userEdits(f, lead)[0]!.edit).toMatchObject({ applied: true, wake: true });
});

const USER_FLOW_REASON = 'Chosen by the user';

/** A plan whose api task is t2, a tier the default workflow policy dispatches. */
function dispatchedTierPlan(f: Fixture, lead: Principal) {
  writePlan(f, lead);
  edit(f, lead, lead, [
    { type: 'set_task', task_id: 'api', patch: { kind: { domain: 'backend-logic', tier: 't2' } } },
  ]);
}

const setPath = (path: string | null) => ({ type: 'set_task', task_id: 'api', patch: { path } });

it("sets a task's path from a user edit with the user as its reason and clears both with null", () => {
  const f = setup();
  const lead = leadOf(f);
  dispatchedTierPlan(f, lead);
  expect(edit(f, user, lead, [setPath('review_loop')]).applied).toBe(true);
  expect(taskOf(f, lead, 'api')).toMatchObject({
    path: 'review_loop',
    flow_reason: USER_FLOW_REASON,
  });
  expect(userEdits(f, lead).at(-1)!.edit).toMatchObject({ applied: true, wake: true });

  edit(f, user, lead, [setPath(null)]);
  expect(taskOf(f, lead, 'api')).not.toHaveProperty('path');
  expect(taskOf(f, lead, 'api')).not.toHaveProperty('flow_reason');
});

it("holds a user's path edit of a task with a running session until the lead applies it", () => {
  const f = setup();
  const lead = leadOf(f);
  dispatchedTierPlan(f, lead);
  running(f, lead, 'api');
  expect(edit(f, user, lead, [setPath('review_loop')]).applied).toBe(false);
  expect(taskOf(f, lead, 'api')?.path).toBeUndefined();

  // The lead's own op on the same task makes the write check the task's path.
  edit(f, lead, lead, [
    { type: 'resolve_edit', edit_id: planOf(f, lead).pending_edits[0]!.edit_id, decision: 'apply' },
    { type: 'set_task', task_id: 'api', patch: { title: 'Export API' } },
  ]);
  expect(taskOf(f, lead, 'api')).toMatchObject({
    path: 'review_loop',
    flow_reason: USER_FLOW_REASON,
  });
});

it("still refuses the lead's path edit that leaves its tier's path without flow_reason", () => {
  const f = setup();
  const lead = leadOf(f);
  dispatchedTierPlan(f, lead);
  const error = failure(() => edit(f, lead, lead, [setPath('review_loop')]));
  expect(error.code).toBe('invalid_input');
  expect(error.message).toContain('flow_reason');
  expect(taskOf(f, lead, 'api')?.path).toBeUndefined();
});

it('does not mark record changes or unchanged contract values as waking edits', () => {
  const f = setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  for (const patch of [
    { title: 'Exports' },
    { lane: 'docs' },
    { kind: { domain: 'docs-chore', tier: 't1' } },
    { priority: 'high' },
    { route_reason: 'Prefer this runtime' },
    { milestone: null },
    { goal: TASKS[0]!.goal },
  ]) {
    edit(f, user, lead, [{ type: 'set_task', task_id: 'api', patch }]);
    expect(userEdits(f, lead).at(-1)!.edit?.wake).toBe(false);
  }
});

it('applies iteration and estimate record edits immediately without waking the lead', async () => {
  const f = setup(),
    lead = leadOf(f);
  writePlan(f, lead);
  running(f, lead, 'api');
  const iterations = [
    { id: 'spring', title: 'Spring', starts_on: '2027-03-13', ends_on: '2027-03-16' },
  ];
  const result = edit(f, user, lead, [
    { type: 'set_iterations', iterations },
    { type: 'set_task', task_id: 'api', patch: { iteration: 'spring', estimate: 5 } },
  ]);
  expect(result.applied).toBe(true);
  expect(planOf(f, lead)).toMatchObject({ iterations, pending_edits: [], contract_changed: [] });
  expect(taskOf(f, lead, 'api')).toMatchObject({ iteration: 'spring', estimate: 5 });
  await f.control.tick();
  expect(
    f.store
      .list<SessionTurn>('session_turns')
      .filter((turn) => turn.session_id === lead.session_id && turn.origin === 'tracker'),
  ).toEqual([]);
  edit(f, user, lead, [{ type: 'set_task', task_id: 'api', patch: { iteration: null } }]);
  expect(taskOf(f, lead, 'api')?.iteration).toBeUndefined();
  edit(f, lead, lead, [{ type: 'set_task', task_id: 'api', patch: { iteration: 'spring' } }]);
  edit(f, user, lead, [{ type: 'set_iterations', iterations: [] }]);
  expect(taskOf(f, lead, 'api')?.iteration).toBeUndefined();
  expect(taskOf(f, lead, 'api')?.estimate).toBe(5);
  expect(
    failure(() =>
      edit(f, user, lead, [{ type: 'set_task', task_id: 'api', patch: { iteration: 'missing' } }]),
    ).code,
  ).toBe('invalid_input');
});

it('sets a milestone title and due day at once without waking the lead or a new generation', async () => {
  const f = setup(),
    lead = leadOf(f);
  writePlan(f, lead);
  const plan = planOf(f, lead);
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: plan.plan_version,
      headline: plan.headline,
      lanes: plan.lanes,
      tasks: plan.tasks.map((task) => ({
        ...task,
        milestone: task.id === 'ui' ? 'release' : undefined,
      })),
      milestones: [
        {
          id: 'release',
          title: 'Release',
          criteria: ['Exports download'],
          tasks: ['ui'],
          due_on: '2027-03-20',
        },
      ],
      risks: [],
      assumptions: [],
    },
    null,
    lead,
  );
  const release = () => f.store.list<Milestone>('milestones').find((row) => row.key === 'release')!;
  expect(release().due_on).toBe('2027-03-20');
  running(f, lead, 'ui');
  const generations = planOf(f, lead).generations;
  const result = edit(f, user, lead, [
    {
      type: 'set_milestone',
      milestone_id: 'release',
      patch: { title: 'Launch', due_on: '2027-04-01' },
    },
  ]);
  expect(result.applied).toBe(true);
  expect(release()).toMatchObject({ title: 'Launch', due_on: '2027-04-01', task_ids: ['ui'] });
  expect(planOf(f, lead)).toMatchObject({ pending_edits: [], contract_changed: [], generations });
  expect(userEdits(f, lead).at(-1)!.edit?.wake).toBe(false);
  await f.control.tick();
  expect(
    f.store
      .list<SessionTurn>('session_turns')
      .filter((turn) => turn.session_id === lead.session_id && turn.origin === 'tracker'),
  ).toEqual([]);
  edit(f, user, lead, [
    { type: 'set_milestone', milestone_id: 'release', patch: { due_on: null } },
  ]);
  expect(release()).not.toHaveProperty('due_on');
  expect(release().title).toBe('Launch');
  expect(
    failure(() =>
      edit(f, user, lead, [
        { type: 'set_milestone', milestone_id: 'missing', patch: { title: 'X' } },
      ]),
    ).code,
  ).toBe('invalid_input');
});

it('stores iterations from the lead plan tool and includes them in plan reads', () => {
  const f = setup(),
    lead = leadOf(f);
  const iterations = [
    { id: 'spring', title: 'Spring', starts_on: '2027-03-13', ends_on: '2027-03-16' },
  ];
  const result = f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export',
      lanes: [{ id: 'core', title: 'Core' }],
      iterations,
      tasks: [{ ...TASKS[0], iteration: 'spring', estimate: 3 }],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    lead,
  );
  expect(result).toMatchObject({ iterations, tasks: [{ iteration: 'spring', estimate: 3 }] });
});
