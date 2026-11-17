import { afterEach, expect, it } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import { id } from '@pantheon/domain';
import type {
  BoardPlan,
  LeadNote,
  Principal,
  ProjectRead,
  Session,
  SessionTurn,
} from '@pantheon/domain';
import { fixture, insertSession, user } from '../helpers.js';
import { git } from './workbench-fixture.js';

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

/** A fixture whose clock moves only when the test moves it. */
async function setup() {
  const clock = { now: 1_700_000_000_000 };
  const f = await fixture({
    adapter: new FixtureAdapter(100),
    managedWorkspaces: true,
    now: () => clock.now,
  });
  cleanups.push(() => f.close());
  return { f, clock };
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
  },
];

function writePlan(f: Fixture, lead: Principal) {
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
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
const leadRow = (f: Fixture, lead: Principal) =>
  f.control
    .boardView(user, f.project.id, 1)
    .leads!.find((row) => row.session_id === lead.session_id)!;

function edit(f: Fixture, principal: Principal, lead: Principal, ops: unknown[]) {
  return f.call<{ edit_id: string; applied: boolean }>(
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

const withdraw = (f: Fixture, principal: Principal, lead: Principal, editId: string) =>
  f.call(
    'board.plan.edit.withdraw',
    { project_id: f.project.id, lead_session_id: lead.session_id, edit_id: editId },
    null,
    principal,
  );

/** A task session of the lead's plan that has not finished. */
const running = (f: Fixture, lead: Principal, taskId: string) =>
  insertSession(f, {
    state: 'running',
    task: { lead_session_id: lead.session_id!, id: taskId, generation: 1 },
  });

const setModel = (taskId: string, model = 'claude-opus-4-5') => ({
  type: 'set_task',
  task_id: taskId,
  patch: { model },
});

it('gives each pending user edit its ops, base version and creation time', async () => {
  const { f, clock } = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  running(f, lead, 'api');
  const version = planOf(f, lead).plan_version;
  clock.now += 1000;
  const { edit_id } = edit(f, user, lead, [setModel('api')]);
  expect(leadRow(f, lead).pending_edits).toEqual([
    {
      id: edit_id,
      task_ids: ['api'],
      summary: 'set_task api',
      state: 'pending',
      ops: [setModel('api')],
      base_version: version,
      created_at: clock.now,
    },
  ]);
});

it('lists an edit the lead rejected with its reason until a later user edit touches its tasks', async () => {
  const { f, clock } = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  running(f, lead, 'api');
  running(f, lead, 'ui');
  const { edit_id } = edit(f, user, lead, [setModel('api')]);
  expect(leadRow(f, lead).rejected_edits).toEqual([]);
  clock.now += 1000;
  resolve(f, lead, edit_id, 'reject', 'The API keeps its model');
  expect(leadRow(f, lead).rejected_edits).toEqual([
    {
      id: edit_id,
      task_ids: ['api'],
      ops: [setModel('api')],
      reason: 'The API keeps its model',
      resolved_at: clock.now,
    },
  ]);
  clock.now += 1000;
  edit(f, user, lead, [setModel('ui')]);
  expect(leadRow(f, lead).rejected_edits!.map((row) => row.id)).toEqual([edit_id]);
  clock.now += 1000;
  // A rename takes effect at once, so it is recorded only in the lead's notes.
  expect(
    edit(f, user, lead, [{ type: 'set_task', task_id: 'api', patch: { title: 'Export API' } }])
      .applied,
  ).toBe(true);
  expect(leadRow(f, lead).rejected_edits).toEqual([]);
});

it('keeps only the 20 newest rejected edits, newest first', async () => {
  const { f, clock } = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  running(f, lead, 'api');
  const ids: string[] = [];
  for (let index = 0; index < 22; index++) {
    clock.now += 1000;
    ids.push(edit(f, user, lead, [setModel('api', `model-${index}`)]).edit_id);
  }
  for (const editId of ids) {
    clock.now += 1000;
    resolve(f, lead, editId, 'reject');
  }
  expect(leadRow(f, lead).rejected_edits!.map((row) => row.id)).toEqual(ids.slice(2).reverse());
});

it('withdraws a pending user edit, leaves the lead a note that does not wake it, and resolving it is not found', async () => {
  const { f } = await setup();
  // Real worktrees, so a tick reports no failed provisioning that would wake the lead itself.
  git(f.projectRoot, 'init', '--quiet', '--initial-branch=main');
  git(f.projectRoot, 'commit', '--quiet', '--allow-empty', '-m', 'Initial commit');
  const lead = leadOf(f);
  writePlan(f, lead);
  running(f, lead, 'api');
  const { edit_id } = edit(f, user, lead, [setModel('api')]);
  // The lead has read the note of the held edit.
  const held = planOf(f, lead);
  f.store.update<BoardPlan>('board_plans', { ...held, inbox: [] }, held.revision);

  withdraw(f, user, lead, edit_id);
  expect(leadRow(f, lead).pending_edits).toEqual([]);
  expect(planOf(f, lead).pending_edits[0]).toMatchObject({
    edit_id,
    status: 'withdrawn',
    resolved_at: expect.any(Number),
  });
  expect(planOf(f, lead).tasks.find((task) => task.id === 'api')?.model).toBeUndefined();
  const notes: LeadNote[] = planOf(f, lead).inbox;
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ kind: 'user_edit', task_id: 'api' });
  expect(notes[0]!.text).toContain(edit_id);
  expect(notes[0]!.edit).toBeUndefined();

  await f.control.tick();
  expect(
    f.store
      .list<SessionTurn>('session_turns')
      .filter((turn) => turn.session_id === lead.session_id && turn.origin === 'tracker'),
  ).toHaveLength(0);
  expect(failure(() => resolve(f, lead, edit_id, 'apply')).code).toBe('not_found');
});

it('refuses to withdraw an edit in effect, decided or withdrawn with invalid_state', async () => {
  const { f } = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  running(f, lead, 'api');
  const atOnce = edit(f, user, lead, [
    { type: 'set_task', task_id: 'ui', patch: { title: 'Download' } },
  ]);
  expect(atOnce.applied).toBe(true);
  const applied = edit(f, user, lead, [setModel('api')]).edit_id;
  resolve(f, lead, applied, 'apply');
  const rejected = edit(f, user, lead, [setModel('api', 'claude-sonnet-4-5')]).edit_id;
  resolve(f, lead, rejected, 'reject');
  const withdrawn = edit(f, user, lead, [setModel('api', 'claude-haiku-4-5')]).edit_id;
  withdraw(f, user, lead, withdrawn);
  for (const editId of [atOnce.edit_id, applied, rejected, withdrawn])
    expect(failure(() => withdraw(f, user, lead, editId)).code, editId).toBe('invalid_state');
  expect(failure(() => withdraw(f, user, lead, 'missing')).code).toBe('not_found');
});

it('refuses a withdraw from the lead', async () => {
  const { f } = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  running(f, lead, 'api');
  const { edit_id } = edit(f, user, lead, [setModel('api')]);
  expect(failure(() => withdraw(f, lead, lead, edit_id)).code).toBe('permission_denied');
  expect(planOf(f, lead).pending_edits[0]!.status).toBe('pending');
  withdraw(f, user, lead, edit_id);
  expect(planOf(f, lead).pending_edits[0]!.status).toBe('withdrawn');
});

it('exposes only edits waiting for the lead in the project plan view', async () => {
  const { f, clock } = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  running(f, lead, 'api');
  const { edit_id } = edit(f, user, lead, [setModel('api')]);
  const read = () =>
    (f.control.projectRead(user, f.project.id) as ProjectRead).plans[0]!.pending_edits;
  expect(read()).toEqual([{ id: edit_id, ops: [setModel('api')], created_at: clock.now }]);
  resolve(f, lead, edit_id, 'reject');
  expect(read()).toEqual([]);
});

it('tracks immediate and pending edit delivery from stored application and turn events', async () => {
  const { f, clock } = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  const worker = running(f, lead, 'api');
  const immediate = edit(f, user, lead, [{ type: 'move_task', task_id: 'ui', before: 'api' }]);
  const held = edit(f, user, lead, [setModel('api')]);
  const recent = () => leadRow(f, lead).recent_edits!;
  const appliedEvent = () => f.store.kindEvents(f.project.id, ['board.user_edit_applied']).at(-1)!;
  const applied = appliedEvent();
  const notes = planOf(f, lead).inbox;
  expect(recent()).toEqual([
    {
      id: immediate.edit_id,
      created_at: notes[0]!.at,
      plan_written_at: applied.created_at,
      lead_read_at: null,
      sessions_notified_at: applied.created_at,
    },
    {
      id: held.edit_id,
      created_at: notes[1]!.at,
      plan_written_at: null,
      lead_read_at: null,
      sessions_notified_at: null,
    },
  ]);
  const queued = f.call<SessionTurn>(
    'session.send',
    { session_id: lead.session_id, input: 'Read the edits' },
    f.store.must<Session>('sessions', lead.session_id!).revision,
  );
  expect(queued.lead_note_ids).toEqual(notes.map((note) => note.id));
  expect(recent()[0]!.lead_read_at).toBeNull();
  clock.now += 1000;
  const started = f.store.event('turn.running', queued, f.project.id, {});
  expect(recent().map((row) => row.lead_read_at)).toEqual([started.created_at, started.created_at]);
  resolve(f, lead, held.edit_id, 'apply');
  const written = appliedEvent();
  expect(written.payload).toEqual({ edit_id: held.edit_id, session_ids: [worker.id] });
  expect(recent()[1]).toMatchObject({
    plan_written_at: written.created_at,
    sessions_notified_at: null,
  });
  clock.now += 1000;
  const delivered = f.store.event('session.contract_notified', worker, f.project.id, {
    plan_sequence: written.sequence,
  });
  expect(recent()[1]!.sessions_notified_at).toBe(delivered.created_at);
  clock.now += 24 * 60 * 60 * 1000;
  expect(recent()).toEqual([]);
});

it('keeps rejected and withdrawn edits out of recent delivery progress', async () => {
  const { f } = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  running(f, lead, 'api');
  const rejected = edit(f, user, lead, [setModel('api')]);
  const withdrawn = edit(f, user, lead, [setModel('api')]);
  resolve(f, lead, rejected.edit_id, 'reject');
  withdraw(f, user, lead, withdrawn.edit_id);
  expect(leadRow(f, lead).recent_edits).toEqual([]);
});

it('lets only the user lock and unlock task order and refuses reordering through edits or updates', async () => {
  const { f } = await setup(),
    lead = leadOf(f);
  writePlan(f, lead);
  running(f, lead, 'api');
  for (const op of [{ type: 'lock_order', task_ids: ['api', 'ui'] }, { type: 'unlock_order' }])
    expect(failure(() => edit(f, lead, lead, [op])).code).toBe('permission_denied');
  expect(edit(f, user, lead, [{ type: 'lock_order', task_ids: ['ui', 'api'] }]).applied).toBe(true);
  expect(
    f.control
      .boardView(user, f.project.id, 1)
      .tasks.filter((row) => row.owner_session_id === lead.session_id)
      .every((row) => row.order_locked === true),
  ).toBe(true);
  const refused = failure(() =>
    edit(f, lead, lead, [{ type: 'move_task', task_id: 'ui', before: 'api' }]),
  );
  expect(refused).toMatchObject({
    code: 'invalid_input',
    message: expect.stringContaining('order lock'),
  });
  expect(
    failure(() =>
      f.call(
        'board.plan.update',
        {
          project_id: f.project.id,
          base_version: planOf(f, lead).plan_version,
          headline: 'Export ships this week',
          lanes: [{ id: 'core', title: 'Core' }],
          tasks: [...TASKS].reverse(),
          milestones: [],
          risks: [],
          assumptions: [],
        },
        null,
        lead,
      ),
    ).code,
  ).toBe('invalid_input');
  edit(f, lead, lead, [{ type: 'set_task', task_id: 'ui', patch: { estimate: 5 } }]);
  expect(
    failure(() => edit(f, lead, lead, [{ type: 'move_task', task_id: 'api', before: null }])).code,
  ).toBe('invalid_input');
  const unlocked = edit(f, user, lead, [setModel('api'), { type: 'unlock_order' }]);
  expect(unlocked.applied).toBe(false);
  expect(planOf(f, lead).pending_edits.at(-1)!.ops).toEqual([setModel('api')]);
  edit(f, lead, lead, [{ type: 'move_task', task_id: 'ui', before: 'api' }]);
  expect(planOf(f, lead).tasks.map((task) => task.id)).toEqual(['ui', 'api']);
  expect(
    f.control.boardView(user, f.project.id, 1).tasks.every((row) => row.order_locked === undefined),
  ).toBe(true);
});

it('takes a named workflow off a task with null, so the default one applies again', async () => {
  const { f } = await setup();
  const lead = leadOf(f);
  writePlan(f, lead);
  const workflow = (id: string | null) =>
    edit(f, user, lead, [{ type: 'set_task', task_id: 'api', patch: { workflow_id: id } }]);
  workflow(f.project.id);
  expect(planOf(f, lead).tasks.find((task) => task.id === 'api')?.workflow_id).toBe(f.project.id);
  workflow(null);
  expect(planOf(f, lead).tasks.find((task) => task.id === 'api')).not.toHaveProperty('workflow_id');
});
