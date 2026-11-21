import { afterEach, expect, it } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import { id } from '@pantheon/domain';
import type { BoardPlan, LeadNote, Principal } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { inboxDigest } from '../../packages/control/dist/lead-inbox.js';
import { fixture, insertSession, user } from '../helpers.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

function failure(fn: () => unknown): { code?: string; message?: string } {
  try {
    fn();
  } catch (error) {
    return error as { code?: string; message?: string };
  }
  throw new Error('Expected the command to fail');
}

async function setup() {
  const f = await fixture({ adapter: new FixtureAdapter(100), managedWorkspaces: true });
  cleanups.push(() => f.close());
  return f;
}

function leadOf(f: Fixture): Principal {
  const lead = insertSession(f);
  f.store.insert('session_turns', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    session_id: lead.id,
    input: 'Ship the export API and a download button this week.',
    kind: 'send',
    delivery: 'delivered',
    state: 'completed',
  });
  return {
    id: `session:${lead.id}`,
    role: 'lead',
    project_id: f.project.id,
    session_id: lead.id,
    expires_at: f.store.now() + 60_000_000,
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
    depends_on: [],
    source: ['a download button'],
    scope: ['apps/web/src/export'],
    acceptance: ['pnpm test'],
    milestone: 'release',
  },
];
const CSV = { id: 'csv', text: 'Exports are CSV only.', affects: ['ui'] };
const LOOSE = { id: 'size', text: 'Exports stay under 10 MB.' };

function writePlan(f: Fixture, lead: Principal, assumptions: unknown[] = [CSV, LOOSE]) {
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: planOf(f, lead)?.plan_version ?? 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: TASKS,
      milestones: [
        { id: 'release', title: 'Release', criteria: ['Exports download'], tasks: ['ui'] },
      ],
      risks: [],
      assumptions,
    },
    null,
    lead,
  );
}

const planOf = (f: Fixture, lead: Principal) =>
  f.store.get<BoardPlan>('board_plans', lead.session_id!);
const plan = (f: Fixture, lead: Principal) => planOf(f, lead)!;

function edit(f: Fixture, principal: Principal, lead: Principal, ops: unknown[]) {
  return f.call<{ edit_id: string; applied: boolean }>(
    'board.plan.edit',
    {
      project_id: f.project.id,
      ...(principal.role === 'user' ? { lead_session_id: lead.session_id } : {}),
      base_version: plan(f, lead).plan_version,
      ops,
    },
    null,
    principal,
  );
}

const refute = (assumption_id: string, instead = 'Exports are CSV and JSON.') => ({
  type: 'refute_assumption',
  assumption_id,
  instead,
});

const resolve = (
  f: Fixture,
  lead: Principal,
  editId: string,
  decision: 'apply' | 'reject',
  reason?: string,
) =>
  edit(f, lead, lead, [
    { type: 'resolve_edit', edit_id: editId, decision, ...(reason ? { reason } : {}) },
  ]);

const userEditNotes = (f: Fixture, lead: Principal) =>
  plan(f, lead).inbox.filter((note) => note.kind === 'user_edit');

const digest = (f: Fixture, lead: Principal, notes: LeadNote[]) =>
  inboxDigest((f.control as unknown as { ctx: ControlContext }).ctx, plan(f, lead), notes, 20_000)
    .text;

const pendingEdit = (f: Fixture, lead: Principal, taskId: string) =>
  f.control
    .boardView(user, f.project.id, 1)
    .tasks.find((row) => row.id === `${lead.session_id}:${taskId}`)!.pending_edit;

it('holds a refuted assumption for the lead even with no task session open, and marks the tasks resting on it', async () => {
  const f = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  const version = plan(f, lead).plan_version;

  const result = edit(f, user, lead, [refute('csv')]);

  expect(result.applied).toBe(false);
  expect(plan(f, lead).plan_version).toBe(version);
  expect(plan(f, lead).assumptions[0]).toEqual(CSV);
  expect(plan(f, lead).pending_edits).toMatchObject([
    {
      edit_id: result.edit_id,
      status: 'pending',
      ops: [],
      task_ids: ['ui'],
      refutes: [
        {
          assumption_id: 'csv',
          text: 'Exports are CSV only.',
          instead: 'Exports are CSV and JSON.',
        },
      ],
    },
  ]);
  const notes = userEditNotes(f, lead);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({
    task_id: 'ui',
    edit_state: 'pending',
    edit: {
      edit_id: result.edit_id,
      applied: false,
      wake: true,
      refutes: [{ assumption_id: 'csv', instead: 'Exports are CSV and JSON.' }],
    },
  });
  expect(notes[0]!.text).toContain(
    'the user says assumption csv "Exports are CSV only." is wrong: Exports are CSV and JSON.; tasks resting on it: ui',
  );
  const text = digest(f, lead, notes);
  expect(text).toContain(
    '- the user says assumption csv "Exports are CSV only." is wrong: Exports are CSV and JSON.; tasks resting on it: ui',
  );
  expect(text).toContain(
    'For an assumption the user says is wrong: apply the edit with resolve_edit and change the tasks resting on it in the same edit_board call, or reject it with the reason it stands.',
  );
  expect(pendingEdit(f, lead, 'ui')).toBe(true);
  expect(pendingEdit(f, lead, 'api')).toBe(false);
});

it("sets the assumption's text to the user's words when the lead applies the refute, keeping its id and tasks", async () => {
  const f = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  const version = plan(f, lead).plan_version;
  const { edit_id } = edit(f, user, lead, [refute('csv')]);

  resolve(f, lead, edit_id, 'apply');

  expect(plan(f, lead).assumptions).toEqual([{ ...CSV, text: 'Exports are CSV and JSON.' }, LOOSE]);
  expect(plan(f, lead).plan_version).toBe(version + 1);
  expect(plan(f, lead).pending_edits[0]).toMatchObject({ edit_id, status: 'applied' });
  expect(pendingEdit(f, lead, 'ui')).toBe(false);
});

it('keeps the plan when the lead rejects the refute, with its reason', async () => {
  const f = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  const version = plan(f, lead).plan_version;
  const { edit_id } = edit(f, user, lead, [refute('csv')]);

  resolve(f, lead, edit_id, 'reject', 'JSON waits for the next release');

  expect(plan(f, lead).assumptions).toEqual([CSV, LOOSE]);
  expect(plan(f, lead).plan_version).toBe(version);
  expect(plan(f, lead).pending_edits[0]).toMatchObject({
    edit_id,
    status: 'rejected',
    reason: 'JSON waits for the next release',
  });
});

it('refuses a refute from the lead and a refute of an assumption the plan does not have', async () => {
  const f = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);

  expect(failure(() => edit(f, lead, lead, [refute('csv')]))).toMatchObject({
    code: 'permission_denied',
    message: 'Only the user refutes an assumption',
  });
  expect(failure(() => edit(f, user, lead, [refute('json')]))).toMatchObject({
    code: 'not_found',
  });
  expect(plan(f, lead).pending_edits).toEqual([]);
});

it('holds a refute and a task change of one edit together', async () => {
  const f = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  const setGoal = { type: 'set_task', task_id: 'api', patch: { goal: 'Serve CSV and JSON' } };

  const result = edit(f, user, lead, [refute('csv'), setGoal]);

  expect(result.applied).toBe(false);
  expect(plan(f, lead).tasks.find((task) => task.id === 'api')!.goal).toBe('Serve exports');
  expect(plan(f, lead).pending_edits).toMatchObject([
    {
      edit_id: result.edit_id,
      ops: [setGoal],
      task_ids: ['api', 'ui'],
      refutes: [{ assumption_id: 'csv' }],
    },
  ]);
  expect(digest(f, lead, userEditNotes(f, lead))).toContain(
    '- set goal Serve CSV and JSON of task api\n- the user says assumption csv',
  );
});

it.each([
  ['csv', 'ui', 'tasks resting on it: ui'],
  ['size', '', 'tasks resting on it: none'],
])(
  'tells the lead the user withdrew a refute of %s, with its refute line',
  async (assumptionId, taskId, tasks) => {
    const f = await setup();
    const lead = leadOf(f);
    writePlan(f, lead);
    const { edit_id } = edit(f, user, lead, [refute(assumptionId, 'Exports may be large.')]);

    f.call('board.plan.edit.withdraw', {
      project_id: f.project.id,
      lead_session_id: lead.session_id,
      edit_id,
    });

    expect(plan(f, lead).pending_edits[0]).toMatchObject({ edit_id, status: 'withdrawn' });
    const withdrawn = userEditNotes(f, lead).at(-1)!;
    expect(withdrawn).toMatchObject({ edit_state: 'withdrawn', task_id: taskId });
    expect(withdrawn.text).toContain(`- the user says assumption ${assumptionId} "`);
    expect(withdrawn.text).toContain(`is wrong: Exports may be large.; ${tasks}`);
  },
);

it("applies the edit's other changes and names the assumption the lead removed while the refute waited", async () => {
  const f = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  const setGoal = { type: 'set_task', task_id: 'api', patch: { goal: 'Serve CSV and JSON' } };
  const { edit_id } = edit(f, user, lead, [refute('csv'), setGoal]);
  writePlan(f, lead, [LOOSE]);

  resolve(f, lead, edit_id, 'apply');

  expect(plan(f, lead).tasks.find((task) => task.id === 'api')!.goal).toBe('Serve CSV and JSON');
  expect(plan(f, lead).assumptions).toEqual([LOOSE]);
  expect(plan(f, lead).pending_edits[0]).toMatchObject({ edit_id, status: 'applied' });
  expect(userEditNotes(f, lead).at(-1)!.text).toBe(
    `Assumption csv is no longer in your plan, so edit ${edit_id} did not change it; its other changes were applied.`,
  );
});

it('leaves project memory one plan decision for each refute the lead resolved, none for a withdrawn one', async () => {
  const f = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  const decisions = () =>
    f.control
      .memoryRead(user, f.project.id, { origin: 'plan' })
      .records.map((record) => record.origin);

  const applied = edit(f, user, lead, [refute('csv')]);
  resolve(f, lead, applied.edit_id, 'apply');
  const withdrawn = edit(f, user, lead, [refute('size', 'Exports may be large.')]);
  f.call('board.plan.edit.withdraw', {
    project_id: f.project.id,
    lead_session_id: lead.session_id,
    edit_id: withdrawn.edit_id,
  });

  expect(decisions()).toMatchObject([
    { subject: 'assumption', subject_id: 'csv', outcome: 'refuted', edit_id: applied.edit_id },
  ]);
});
