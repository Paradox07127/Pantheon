import { expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type {
  BoardPlan,
  Milestone,
  Principal,
  Project,
  ProjectRead,
  Session,
  SessionTurn,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/src/context.js';
import { awaitWorkspaceReady, eventually, settle, user } from '../helpers.js';
import { reviewerRuntime, startReview } from '../../packages/control/dist/review.js';
import { dispatchEveryTier, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
type PlanTask = BoardPlan['tasks'][number];

const sessionOf = (f: Fixture, sessionId: string, role: 'lead' | 'worker'): Principal => ({
  id: `session:${sessionId}`,
  role,
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
  acceptance: ['pnpm test'],
  ...fields,
});

type PlanMilestone = { id: string; title: string; criteria: string[]; tasks: string[] };

function writePlan(
  f: Fixture,
  leadId: string,
  tasks: PlanTask[],
  milestones: PlanMilestone[] = [],
) {
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: f.store.get<BoardPlan>('board_plans', leadId)?.plan_version ?? 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks,
      milestones,
      risks: [],
      assumptions: [],
    },
    null,
    sessionOf(f, leadId, 'lead'),
  );
}

const startTasks = (f: Fixture, leadId: string, taskIds: string[], principal?: Principal) =>
  f.call(
    'task.start',
    { project_id: f.project.id, task_ids: taskIds },
    null,
    principal ?? sessionOf(f, leadId, 'lead'),
  );

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const planOf = (f: Fixture, leadId: string) => f.store.must<BoardPlan>('board_plans', leadId);
const sessionsOf = (f: Fixture, leadId: string, taskId: string) =>
  f.store
    .list<Session>('sessions')
    .filter((session) => session.task?.lead_session_id === leadId && session.task.id === taskId);
const blockersOf = (f: Fixture, leadId: string, taskId: string) =>
  f.control.boardView(user, f.project.id, 1).tasks.find((row) => row.id === `${leadId}:${taskId}`)!
    .blockers;

function patch(f: Fixture, sessionId: string, fields: Partial<Session>) {
  const session = current(f, sessionId);
  f.store.update<Session>('sessions', { ...session, ...fields }, session.revision);
}

async function leadWithPlan(f: Fixture, tasks: PlanTask[], milestones: PlanMilestone[] = []) {
  dispatchEveryTier(f);
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id, tasks, milestones);
  return lead;
}

const reportTask = (id: string, fields: Partial<PlanTask> = {}) =>
  task(id, { done_when: 'report', scope: [], acceptance: [], ...fields });

/** Opens the report task's session, reports it done and has the lead accept the report. */
async function acceptReport(f: Fixture, leadId: string, taskId: string) {
  startTasks(f, leadId, [taskId]);
  await f.control.tick();
  const [worker] = sessionsOf(f, leadId, taskId);
  await settle(f, worker!);
  await f.call(
    'task.report',
    { project_id: f.project.id, kind: 'done', text: `Task ${taskId} is answered` },
    null,
    sessionOf(f, worker!.id, 'worker'),
  );
  await settle(f, current(f, leadId));
  f.call(
    'task.accept',
    { project_id: f.project.id, task_id: taskId, evidence: 'The report answers the goal' },
    null,
    sessionOf(f, leadId, 'lead'),
  );
}

const statusOf = (f: Fixture, leadId: string, taskId: string) =>
  f.control.boardView(user, f.project.id, 1).tasks.find((row) => row.id === `${leadId}:${taskId}`)!
    .status;

/** Points the task at another runtime without the plan update checks, as when an adapter goes away. */
function setTaskRuntime(f: Fixture, leadId: string, taskId: string, runtime: string) {
  const plan = planOf(f, leadId);
  f.store.update<BoardPlan>(
    'board_plans',
    {
      ...plan,
      tasks: plan.tasks.map((each) => (each.id === taskId ? { ...each, runtime } : each)),
    },
    plan.revision,
  );
}

/** Runs the store clock ahead of the wall clock; returns how to move it further. */
function skewedClock(f: Fixture) {
  let skew = 0;
  vi.spyOn(f.store, 'now').mockImplementation(() => Date.now() + skew);
  return (ms: number) => {
    skew += ms;
  };
}

const stopTask = (f: Fixture, leadId: string, taskId: string, principal?: Principal) =>
  f.call<Record<string, unknown>>(
    'task.stop',
    { project_id: f.project.id, task_id: taskId, reason: 'The approach changed' },
    null,
    principal ?? sessionOf(f, leadId, 'lead'),
  );

/** True while the control holds a native process of the session. */
const hasProcess = (f: Fixture, sessionId: string) =>
  [...(f.control as unknown as { ctx: ControlContext }).ctx.handles.values()].some(
    (handle) => handle.platform_session_id === sessionId,
  );

/** Holds every close of a native process until the returned release is called. */
function holdClose(f: Fixture) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const close = f.adapter.close.bind(f.adapter);
  vi.spyOn(f.adapter, 'close').mockImplementation(async (handle, deadline) => {
    await released;
    return close(handle, deadline);
  });
  return release;
}

/** The discard notes the lead got, read or not. */
const discardNotes = (f: Fixture, leadId: string) =>
  planOf(f, leadId).inbox.filter((note) => note.kind === 'discarded').length +
  f.turns(leadId).filter((turn) => turn.input.includes(': discarded: ')).length;

/** The dispatch failure notes the lead got, read or not. */
const dispatchNotes = (f: Fixture, leadId: string) =>
  planOf(f, leadId).inbox.filter((note) => note.kind === 'dispatch_failed').length +
  f.turns(leadId).filter((turn) => turn.input.includes('<note kind="dispatch_failed"')).length;

it('tells the lead and the user once when the session of a started task cannot open', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  startTasks(f, lead.id, ['a']);
  setTaskRuntime(f, lead.id, 'a', 'missing-runtime');
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'a')).toEqual([]);
  const error = planOf(f, lead.id).dispatch!.a!.error!;
  expect(error).toEqual({
    code: expect.any(String),
    message: expect.any(String),
    at: expect.any(Number),
    attempts: 1,
  });
  expect(planOf(f, lead.id).inbox).toEqual([
    {
      at: error.at,
      session_id: '',
      task_id: 'a',
      kind: 'dispatch_failed',
      text: expect.stringContaining(error.message),
      id: expect.any(String),
      causal_depth: expect.any(Number),
    },
  ]);
  expect(f.control.needsYou(user, f.project.id).items).toEqual([
    {
      source: { table: 'board_plans', id: lead.id, revision: planOf(f, lead.id).revision },
      kind: 'session.failed',
      project_id: f.project.id,
      session_id: lead.id,
      task_id: `${lead.id}:a`,
      status: 'queued',
      created_at: error.at,
      reason: 'task_dispatch_failed',
      rung: 'retry',
      decision: 'other',
      blocks: 0,
      actions: [],
      next_step: expect.any(String),
    },
  ]);
  expect(blockersOf(f, lead.id, 'a')[0]).toContain(error.message);
});

it('retries a task whose session cannot open only after its backoff, and clears the failure once it opens', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const advance = skewedClock(f);
  startTasks(f, lead.id, ['a']);
  setTaskRuntime(f, lead.id, 'a', 'missing-runtime');
  await f.control.tick();
  const attempts = () => planOf(f, lead.id).dispatch!.a!.error!.attempts;
  expect(attempts()).toBe(1);

  await f.control.tick();
  advance(29_000);
  await f.control.tick();
  expect(attempts()).toBe(1);
  advance(2_000);
  await f.control.tick();
  expect(attempts()).toBe(2);

  setTaskRuntime(f, lead.id, 'a', f.adapter.name);
  advance(59_000);
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'a')).toEqual([]);
  advance(2_000);
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'a')).toHaveLength(1);
  expect(planOf(f, lead.id).dispatch).toEqual({});
  expect(dispatchNotes(f, lead.id)).toBe(1);
  expect(
    f.control.needsYou(user, f.project.id).items.filter((item) => item.source.id === lead.id),
  ).toEqual([]);
});

it('opens a session for a started task with the runtime, model and effort the plan chose', async () => {
  const f = await workbenchFixture();
  const second = new FixtureAdapter();
  second.name = 'second';
  f.control.adapters.set(second.name, second);
  const lead = await leadWithPlan(f, [
    task('a', { runtime: second.name, model: 'fixture-large', effort: 'high' }),
  ]);
  expect(startTasks(f, lead.id, ['a'])).toEqual({ requested: ['a'] });
  expect(planOf(f, lead.id).dispatch).toEqual({
    a: { requested_at: expect.any(Number), causal_depth: expect.any(Number) },
  });
  expect(blockersOf(f, lead.id, 'a')).toContain('Queued');

  await f.control.tick();
  const [opened] = sessionsOf(f, lead.id, 'a');
  expect(opened).toMatchObject({
    task: { lead_session_id: lead.id, id: 'a' },
    runtime: second.name,
    requested_model: 'fixture-large',
    requested_effort: 'high',
    permission_mode: 'ask',
    title: 'Task a',
  });
  expect(f.turns(opened!.id)[0]!.input).toMatch(
    /^Task a\n\nTask a of the plan "[^"]*", lane "[^"]*"\.\n\nGoal:\nFinish task a\n/,
  );
  expect(planOf(f, lead.id).dispatch).toEqual({});
  expect(
    f.store
      .events(0, undefined, 10000)
      .filter((event) => event.kind === 'task.dispatched')
      .map((event) => event.payload),
  ).toEqual([{ task_id: 'a', session_id: opened!.id }]);

  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'a')).toHaveLength(1);
});

it('queues a task until its upstream task merges', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a'), task('b', { depends_on: ['a'] })]);
  startTasks(f, lead.id, ['a', 'b']);
  await f.control.tick();
  const [upstream] = sessionsOf(f, lead.id, 'a');
  expect(upstream).toBeDefined();
  expect(sessionsOf(f, lead.id, 'b')).toEqual([]);
  expect(blockersOf(f, lead.id, 'b')).toContain('Queued: waiting for dependencies');

  await settle(f, upstream!);
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'b')).toEqual([]);

  patch(f, upstream!.id, { state: 'closed', outcome: 'merged' });
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'b')).toHaveLength(1);
  expect(planOf(f, lead.id).dispatch).toEqual({});
});

it('opens only one of two tasks whose scopes overlap by path segment', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [
    task('folder', { scope: ['src/a'] }),
    task('file', { scope: ['src/a/b.ts'] }),
    task('sibling', { scope: ['src/ab'] }),
  ]);
  startTasks(f, lead.id, ['folder', 'file', 'sibling']);
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'folder')).toHaveLength(1);
  expect(sessionsOf(f, lead.id, 'file')).toEqual([]);
  expect(sessionsOf(f, lead.id, 'sibling')).toHaveLength(1);
  expect(blockersOf(f, lead.id, 'file')).toContain('Queued: waiting for the scope to free up');
});

it('runs at most three task sessions in a project and queues the rest', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a'), task('b'), task('c'), task('d')]);
  startTasks(f, lead.id, ['a', 'b', 'c', 'd']);
  await f.control.tick();
  expect(['a', 'b', 'c', 'd'].map((id) => sessionsOf(f, lead.id, id).length)).toEqual([1, 1, 1, 0]);
  expect(blockersOf(f, lead.id, 'd')).toContain('Queued: waiting for a free slot');

  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'd')).toEqual([]);
});

it('refuses task.start from other roles, for tasks outside the plan and for tasks with a session', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a'), task('b')]);
  const other = await leadWithPlan(f, [task('c')]);
  expect(() => startTasks(f, lead.id, ['a'], user)).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
  expect(() => startTasks(f, lead.id, ['c'])).toThrow(
    expect.objectContaining({ code: 'not_found' }),
  );
  const worker = await f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Build it',
    task_id: `${other.id}:c`,
  });
  expect(() => startTasks(f, other.id, ['c'], sessionOf(f, worker.id, 'worker'))).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
  expect(() => startTasks(f, other.id, ['c'])).toThrow(
    expect.objectContaining({ code: 'invalid_state' }),
  );
  expect(planOf(f, lead.id).dispatch).toBeUndefined();
  expect(planOf(f, other.id).dispatch).toBeUndefined();
});

it('drops the request of a queued task the user opened a session for', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a'), task('b')]);
  startTasks(f, lead.id, ['b']);
  const opened = await f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Task b\n\nFinish task b',
    task_id: `${lead.id}:b`,
  });
  await f.control.tick();
  expect(planOf(f, lead.id).dispatch).toEqual({});
  expect(sessionsOf(f, lead.id, 'b').map((session) => session.id)).toEqual([opened.id]);
});

it('keeps the requests of tasks that stay in a rewritten plan', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [
    task('a'),
    task('b', { depends_on: ['a'] }),
    task('c', { depends_on: ['a'] }),
  ]);
  startTasks(f, lead.id, ['b', 'c']);
  writePlan(f, lead.id, [task('a'), task('b', { depends_on: ['a'] })]);
  expect(Object.keys(planOf(f, lead.id).dispatch!)).toEqual(['b']);
});

it('keeps a task named like an object prototype property apart from the accepted tasks', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [reportTask('r'), task('constructor')]);
  await acceptReport(f, lead.id, 'r');
  const planned = (f.control.projectRead(user, f.project.id) as ProjectRead).plans
    .find((view) => view.lead_session_id === lead.id)!
    .tasks.find((view) => view.id === 'constructor')!;
  expect(planned.state).toBe('todo');
  expect(statusOf(f, lead.id, 'constructor')).toBe('todo');

  expect(startTasks(f, lead.id, ['constructor'])).toEqual({ requested: ['constructor'] });
  expect(Object.hasOwn(planOf(f, lead.id).dispatch!, 'constructor')).toBe(true);
  expect(blockersOf(f, lead.id, 'constructor')).toContain('Queued');
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'constructor')).toHaveLength(1);
});

it('accepts a milestone of report tasks on the accepted tasks as evidence', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(
    f,
    [reportTask('r', { milestone: 'm1' }), reportTask('q')],
    [{ id: 'm1', title: 'Format chosen', criteria: ['A format'], tasks: ['r'] }],
  );
  await acceptReport(f, lead.id, 'r');
  const accept = (evidence_refs: string[]) =>
    f.call<Milestone>(
      'milestone.accept',
      { milestone_id: 'm1', evidence_refs },
      null,
      sessionOf(f, lead.id, 'lead'),
    );
  expect(() => accept(['task:q'])).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  expect(() => accept(['task:missing'])).toThrow(
    expect.objectContaining({ code: 'invalid_input' }),
  );
  expect(accept(['task:r']).acceptance).toMatchObject({ evidence_refs: ['task:r'] });
  const read = f.control.projectRead(user, f.project.id) as ProjectRead;
  expect(read.milestones.find((view) => view.milestone.key === 'm1')!.status).toBe('completed');
});

it('frees the place and scope of accepted report tasks for the next task', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [
    reportTask('r1', { scope: ['src/r1'] }),
    reportTask('r2'),
    reportTask('r3'),
    task('d', { scope: ['src/r1/d.ts'] }),
  ]);
  for (const id of ['r1', 'r2', 'r3']) await acceptReport(f, lead.id, id);
  expect(['r1', 'r2', 'r3'].map((id) => sessionsOf(f, lead.id, id).length)).toEqual([1, 1, 1]);

  startTasks(f, lead.id, ['d']);
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'd')).toHaveLength(1);
});

it('gives a task that reuses a removed task id none of its merged sessions', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a'), task('b', { depends_on: ['a'] })]);
  startTasks(f, lead.id, ['a']);
  await f.control.tick();
  const [old] = sessionsOf(f, lead.id, 'a');
  patch(f, old!.id, { state: 'closed', outcome: 'merged' });
  expect(statusOf(f, lead.id, 'a')).toBe('done');

  writePlan(f, lead.id, [task('other')]);
  writePlan(f, lead.id, [task('a'), task('b', { depends_on: ['a'] })]);
  const planned = (f.control.projectRead(user, f.project.id) as ProjectRead).plans
    .find((view) => view.lead_session_id === lead.id)!
    .tasks.find((view) => view.id === 'a')!;
  expect(planned).toMatchObject({ state: 'todo', session_ids: [] });
  expect(statusOf(f, lead.id, 'a')).toBe('todo');
  startTasks(f, lead.id, ['b']);
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'b')).toEqual([]);
  expect(blockersOf(f, lead.id, 'b')).toContain('Queued: waiting for dependencies');
  expect(startTasks(f, lead.id, ['a'])).toEqual({ requested: ['b', 'a'] });
});

it('refuses a done report from before the goal of the report task changed', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [reportTask('r')]);
  startTasks(f, lead.id, ['r']);
  await f.control.tick();
  const [worker] = sessionsOf(f, lead.id, 'r');
  await settle(f, worker!);
  const report = () =>
    f.call(
      'task.report',
      { project_id: f.project.id, kind: 'done', text: 'Task r is answered' },
      null,
      sessionOf(f, worker!.id, 'worker'),
    );
  const accept = () =>
    f.call(
      'task.accept',
      { project_id: f.project.id, task_id: 'r', evidence: 'The report answers the goal' },
      null,
      sessionOf(f, lead.id, 'lead'),
    );
  await report();
  await settle(f, current(f, lead.id));
  writePlan(f, lead.id, [reportTask('r', { goal: 'Answer another question' })]);
  expect(accept).toThrow(expect.objectContaining({ code: 'invalid_state' }));

  // The next tick tells the idle session of the change.
  await f.control.tick();
  await settle(f, current(f, worker!.id));
  await report();
  await settle(f, current(f, lead.id));
  accept();
  expect(statusOf(f, lead.id, 'r')).toBe('done');
});

it('reopens an accepted task and its accepted milestone when the task contract changes', async () => {
  const f = await workbenchFixture();
  const milestones = [{ id: 'm1', title: 'Format chosen', criteria: ['A format'], tasks: ['r'] }];
  const lead = await leadWithPlan(f, [reportTask('r', { milestone: 'm1' })], milestones);
  await acceptReport(f, lead.id, 'r');
  const acceptMilestone = () =>
    f.call<Milestone>(
      'milestone.accept',
      { milestone_id: 'm1', evidence_refs: ['task:r'] },
      null,
      sessionOf(f, lead.id, 'lead'),
    );
  const milestoneStatus = () =>
    (f.control.projectRead(user, f.project.id) as ProjectRead).milestones.find(
      (view) => view.milestone.key === 'm1',
    )!.status;
  acceptMilestone();
  expect(milestoneStatus()).toBe('completed');

  writePlan(
    f,
    lead.id,
    [reportTask('r', { milestone: 'm1', acceptance: ['Names the chosen format'] })],
    milestones,
  );
  expect(statusOf(f, lead.id, 'r')).not.toBe('done');
  expect(milestoneStatus()).toBe('active');
  expect(acceptMilestone).toThrow(expect.objectContaining({ code: 'invalid_input' }));

  const [worker] = sessionsOf(f, lead.id, 'r');
  // The next tick tells the idle session of the change.
  await f.control.tick();
  await settle(f, current(f, worker!.id));
  await f.call(
    'task.report',
    { project_id: f.project.id, kind: 'done', text: 'Task r names the format' },
    null,
    sessionOf(f, worker!.id, 'worker'),
  );
  await settle(f, current(f, lead.id));
  f.call(
    'task.accept',
    { project_id: f.project.id, task_id: 'r', evidence: 'The report names the format' },
    null,
    sessionOf(f, lead.id, 'lead'),
  );
  expect(statusOf(f, lead.id, 'r')).toBe('done');
  expect(milestoneStatus()).toBe('ready_for_acceptance');
});

it('keeps the generation of a task whose title or lane is all that changed', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [reportTask('r')]);
  await acceptReport(f, lead.id, 'r');
  expect(planOf(f, lead.id).generations).toEqual({
    r: { generation: 1, contract: expect.any(String) },
  });
  const contract = planOf(f, lead.id).generations!.r!.contract;
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: planOf(f, lead.id).plan_version,
      headline: 'Export ships this week',
      lanes: [
        { id: 'core', title: 'Core' },
        { id: 'docs', title: 'Docs' },
      ],
      tasks: [reportTask('r', { title: 'Renamed task', lane: 'docs' })],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    sessionOf(f, lead.id, 'lead'),
  );
  expect(planOf(f, lead.id).generations).toEqual({ r: { generation: 1, contract } });
  expect(statusOf(f, lead.id, 'r')).toBe('done');
});

it('stops a queued task by dropping its start request, which leaves it todo', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [reportTask('a'), reportTask('b', { depends_on: ['a'] })]);
  startTasks(f, lead.id, ['b']);
  expect(stopTask(f, lead.id, 'b')).toEqual({
    task_id: 'b',
    dequeued: true,
    sessions: [],
    task_state: 'todo',
  });
  expect(planOf(f, lead.id).dispatch).toEqual({});
  expect(statusOf(f, lead.id, 'b')).toBe('todo');
  expect(blockersOf(f, lead.id, 'b')).not.toContain('Queued: waiting for dependencies');
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'b')).toEqual([]);
});

it('discards a stopped task session only once its process stopped, then frees its place and lets the task start again', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(
    f,
    ['a', 'b', 'c', 'd'].map((id) => reportTask(id)),
  );
  startTasks(f, lead.id, ['a', 'b', 'c', 'd']);
  await f.control.tick();
  const [first] = sessionsOf(f, lead.id, 'a');
  await eventually(
    () => hasProcess(f, first!.id),
    () => f.control.tick(),
  );
  const release = holdClose(f);
  expect(stopTask(f, lead.id, 'a')).toEqual({
    task_id: 'a',
    dequeued: false,
    sessions: [{ session_id: first!.id, step: 'stopping' }],
    task_state: 'active',
  });
  expect(current(f, first!.id).stop_requested).toEqual({
    reason: 'The approach changed',
    at: expect.any(Number),
    by: 'lead',
  });
  await f.control.tick();
  expect(current(f, first!.id).outcome).toBeUndefined();
  expect(sessionsOf(f, lead.id, 'd')).toEqual([]);
  expect(() => startTasks(f, lead.id, ['a'])).toThrow(
    expect.objectContaining({ code: 'invalid_state' }),
  );

  release();
  await eventually(
    () => current(f, first!.id).outcome === 'discarded',
    () => f.control.tick(),
  );
  expect(hasProcess(f, first!.id)).toBe(false);
  expect(current(f, first!.id).state).toBe('closed');
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'd')).toHaveLength(1);
  expect(statusOf(f, lead.id, 'a')).toBe('todo');

  expect(startTasks(f, lead.id, ['a'])).toEqual({ requested: ['a'] });
  const [other] = sessionsOf(f, lead.id, 'b');
  stopTask(f, lead.id, 'b');
  await eventually(
    () => sessionsOf(f, lead.id, 'a').length === 2,
    () => f.control.tick(),
  );
  expect(current(f, other!.id).outcome).toBe('discarded');
  expect(sessionsOf(f, lead.id, 'a').filter((session) => !session.outcome)).toHaveLength(1);
});

it('finishes a lead stop that a daemon restart interrupted before the process confirmed it stopped', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [reportTask('a')]);
  // The task's turn stays running with a recorded process, as a turn the crash interrupted.
  vi.spyOn(f.adapter, 'send').mockImplementationOnce(async (handle, turn) => {
    handle.process_identity = { pid: 4000001, start_time_us: 1700000000123456 };
    return { turn_id: turn.turn_id, status: 'delivered' };
  });
  startTasks(f, lead.id, ['a']);
  await f.control.tick();
  const [stopped] = sessionsOf(f, lead.id, 'a');
  await eventually(
    () => current(f, stopped!.id).process_identity !== undefined,
    () => f.control.tick(),
  );
  const crashed = f.control,
    release = holdClose(f);
  stopTask(f, lead.id, 'a');
  expect(current(f, stopped!.id)).toMatchObject({
    state: 'running',
    stop_requested: { by: 'lead' },
  });

  await f.restart(() => undefined);
  await f.control.tick();
  expect(current(f, stopped!.id)).toMatchObject({ state: 'closed', outcome: 'discarded' });
  expect(f.turns(stopped!.id).map((turn: SessionTurn) => turn.state)).toEqual(['failed']);
  expect(statusOf(f, lead.id, 'a')).toBe('todo');
  expect(discardNotes(f, lead.id)).toBe(0);
  expect(startTasks(f, lead.id, ['a'])).toEqual({ requested: ['a'] });
  release();
  await crashed.shutdown();
});

it('tells the lead when the user discards a task session, but not when the lead stops one', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [
    reportTask('a'),
    reportTask('b', { depends_on: ['a'] }),
    reportTask('c'),
  ]);
  startTasks(f, lead.id, ['a', 'b', 'c']);
  await f.control.tick();
  const [discarded] = sessionsOf(f, lead.id, 'a'),
    [stopped] = sessionsOf(f, lead.id, 'c');
  await settle(f, discarded!);
  await settle(f, stopped!);
  f.call('session.discard', { session_id: discarded!.id }, current(f, discarded!.id).revision);
  stopTask(f, lead.id, 'c');
  await eventually(() =>
    [discarded, stopped].every((session) => current(f, session!.id).outcome === 'discarded'),
  );
  expect(planOf(f, lead.id).inbox).toEqual([
    {
      at: expect.any(Number),
      session_id: discarded!.id,
      task_id: 'a',
      kind: 'discarded',
      text: expect.stringContaining('todo'),
      id: expect.any(String),
      causal_depth: expect.any(Number),
    },
  ]);
  await f.control.tick();
  await settle(f, current(f, lead.id));
  expect(discardNotes(f, lead.id)).toBe(1);
  // The user discarded it, so the note waits for the lead's next message instead of waking it;
  // the queued task b, which now waits on a stopped upstream, gets a note of its own.
  expect(planOf(f, lead.id).inbox.map((note) => note.kind)).toEqual(['discarded', 'blocked']);
  expect(sessionsOf(f, lead.id, 'b')).toEqual([]);
});

it('tells the lead that a task it accepted stays done when the user discards its session', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [reportTask('a')]);
  await acceptReport(f, lead.id, 'a');
  const [worker] = sessionsOf(f, lead.id, 'a');
  await settle(f, current(f, worker!.id));
  f.call('session.discard', { session_id: worker!.id }, current(f, worker!.id).revision);
  await eventually(() => current(f, worker!.id).outcome === 'discarded');
  const notes = planOf(f, lead.id).inbox.filter((note) => note.kind === 'discarded');
  expect(notes).toEqual([
    expect.objectContaining({
      session_id: worker!.id,
      text: expect.not.stringContaining('todo again'),
    }),
  ]);
  expect(notes[0]!.text).toContain('stays done');
  expect(statusOf(f, lead.id, 'a')).toBe('done');
});

it('refuses task.stop from other roles, for tasks outside the plan and for tasks with nothing to stop', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [reportTask('a'), reportTask('b')]);
  startTasks(f, lead.id, ['a']);
  expect(() => stopTask(f, lead.id, 'a', user)).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
  await f.control.tick();
  const [worker] = sessionsOf(f, lead.id, 'a');
  expect(() => stopTask(f, lead.id, 'a', sessionOf(f, worker!.id, 'worker'))).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
  expect(() => stopTask(f, lead.id, 'missing')).toThrow(
    expect.objectContaining({ code: 'not_found' }),
  );
  expect(() => stopTask(f, lead.id, 'b')).toThrow(
    expect.objectContaining({ code: 'invalid_state' }),
  );
  expect(current(f, worker!.id).stop_requested).toBeUndefined();
});

it('leaves the session and its process as they were when the stop command rolls back', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [reportTask('a')]);
  startTasks(f, lead.id, ['a']);
  await f.control.tick();
  const [worker] = sessionsOf(f, lead.id, 'a');
  await eventually(
    () => hasProcess(f, worker!.id),
    () => f.control.tick(),
  );
  const close = vi.spyOn(f.adapter, 'close');
  const control = f.control as unknown as { failpoint: (name: string) => void };
  control.failpoint = (name) => {
    if (name === 'before_transaction_commit') throw new Error('Commit interrupted');
  };
  expect(() => stopTask(f, lead.id, 'a')).toThrow('Commit interrupted');
  control.failpoint = () => {};
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(close).not.toHaveBeenCalled();
  expect(current(f, worker!.id).stop_requested).toBeUndefined();
  expect(current(f, worker!.id).outcome).toBeUndefined();
  expect(hasProcess(f, worker!.id)).toBe(true);
  expect(f.store.pending().some((job) => job.kind === 'workspace.remove')).toBe(false);
});

it('keeps the stop of a session a restart left reconciling until its old process is confirmed gone', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [reportTask('a')]);
  const identity = { pid: 4000001, start_time_us: 1700000000123456 };
  vi.spyOn(f.adapter, 'send').mockImplementationOnce(async (handle, turn) => {
    handle.process_identity = identity;
    return { turn_id: turn.turn_id, status: 'delivered' };
  });
  startTasks(f, lead.id, ['a']);
  await f.control.tick();
  const [stopped] = sessionsOf(f, lead.id, 'a');
  await eventually(
    () => current(f, stopped!.id).process_identity !== undefined,
    () => f.control.tick(),
  );
  const crashed = f.control;
  await f.restart(() => identity);
  const unconfirmed = f.control;
  expect(current(f, stopped!.id).state).toBe('reconciling');
  // The lead's own reconciliation is not what this covers.
  patch(f, lead.id, { state: 'open' });

  expect(stopTask(f, lead.id, 'a')).toMatchObject({
    sessions: [{ session_id: stopped!.id, step: 'stopping' }],
  });
  expect(current(f, stopped!.id)).toMatchObject({
    state: 'reconciling',
    stop_requested: { by: 'lead' },
  });
  expect(current(f, stopped!.id).outcome).toBeUndefined();
  expect(f.store.pending().some((job) => job.kind === 'workspace.remove')).toBe(false);

  await f.restart(() => undefined);
  await f.control.tick();
  expect(current(f, stopped!.id)).toMatchObject({ state: 'closed', outcome: 'discarded' });
  await unconfirmed.shutdown();
  await crashed.shutdown();
});

it('stops a task session whose process is still starting once the process has started', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [reportTask('a')]);
  let started!: () => void;
  const held = new Promise<void>((resolve) => {
    started = resolve;
  });
  const start = f.adapter.start.bind(f.adapter),
    calls = f.start.mock.calls.length;
  f.start.mockImplementationOnce(async (spec, sink) => {
    await held;
    return start(spec, sink);
  });
  startTasks(f, lead.id, ['a']);
  // The tick that starts the process waits on it, so later ticks pass until it has started.
  await eventually(
    () => f.start.mock.calls.length > calls,
    async () => void f.control.tick(),
  );
  const [worker] = sessionsOf(f, lead.id, 'a');
  expect(stopTask(f, lead.id, 'a')).toMatchObject({
    sessions: [{ session_id: worker!.id, step: 'stopping' }],
  });
  expect(current(f, worker!.id).outcome).toBeUndefined();
  expect(f.store.pending().some((job) => job.kind === 'workspace.remove')).toBe(false);

  started();
  await eventually(
    () => current(f, worker!.id).outcome === 'discarded',
    () => f.control.tick(),
  );
  expect(hasProcess(f, worker!.id)).toBe(false);
});

it('discards a stopped task session once a retried close confirms its process stopped', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [reportTask('a')]);
  startTasks(f, lead.id, ['a']);
  await f.control.tick();
  const [worker] = sessionsOf(f, lead.id, 'a');
  await settle(f, worker!);
  await eventually(
    () => hasProcess(f, worker!.id),
    () => f.control.tick(),
  );
  // The idle worker keeps a recorded process, as a runtime that holds its process between turns.
  const identity = { pid: 4000001, start_time_us: 1700000000123456 };
  for (const handle of (f.control as unknown as { ctx: ControlContext }).ctx.handles.values())
    if (handle.platform_session_id === worker!.id) handle.process_identity = identity;
  patch(f, worker!.id, { process_identity: identity });
  vi.spyOn(f.adapter, 'close').mockImplementationOnce(async (_handle, deadline) => ({
    stopped: false,
    deadline,
    finished_at: new Date().toISOString(),
    evidence: { method: 'none', members: [] },
  }));
  stopTask(f, lead.id, 'a');
  await eventually(() => current(f, worker!.id).stop_pending === true);
  await eventually(
    () => !hasProcess(f, worker!.id),
    () => f.control.tick(),
  );
  await eventually(
    () => current(f, worker!.id).outcome === 'discarded',
    () => f.control.tick(),
  );
});

it('takes back the acceptance of a report task the lead stops', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [reportTask('r')]);
  await acceptReport(f, lead.id, 'r');
  expect(statusOf(f, lead.id, 'r')).toBe('done');
  const [worker] = sessionsOf(f, lead.id, 'r');
  stopTask(f, lead.id, 'r');
  expect(Object.hasOwn(planOf(f, lead.id).accepted ?? {}, 'r')).toBe(false);
  await eventually(
    () => current(f, worker!.id).outcome === 'discarded',
    () => f.control.tick(),
  );
  expect(statusOf(f, lead.id, 'r')).toBe('todo');
});

it('refuses to accept a report task on the done report of a session the lead stopped', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [reportTask('r')]);
  startTasks(f, lead.id, ['r']);
  await f.control.tick();
  const [stopped] = sessionsOf(f, lead.id, 'r');
  await settle(f, stopped!);
  await f.call(
    'task.report',
    { project_id: f.project.id, kind: 'done', text: 'Task r is answered' },
    null,
    sessionOf(f, stopped!.id, 'worker'),
  );
  await settle(f, current(f, lead.id));
  stopTask(f, lead.id, 'r');
  await eventually(
    () => current(f, stopped!.id).outcome === 'discarded',
    () => f.control.tick(),
  );
  startTasks(f, lead.id, ['r']);
  await eventually(
    () => sessionsOf(f, lead.id, 'r').length === 2,
    () => f.control.tick(),
  );
  expect(() =>
    f.call(
      'task.accept',
      { project_id: f.project.id, task_id: 'r', evidence: 'The report answers the goal' },
      null,
      sessionOf(f, lead.id, 'lead'),
    ),
  ).toThrow(expect.objectContaining({ code: 'invalid_state' }));
});

it('refuses a done report sent before the changed contract reached the session, which still holds the task', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [reportTask('r')]);
  startTasks(f, lead.id, ['r']);
  await f.control.tick();
  const [worker] = sessionsOf(f, lead.id, 'r');
  await settle(f, worker!);
  const report = () =>
    f.call(
      'task.report',
      { project_id: f.project.id, kind: 'done', text: 'Task r is answered' },
      null,
      sessionOf(f, worker!.id, 'worker'),
    );
  const accept = () =>
    f.call(
      'task.accept',
      { project_id: f.project.id, task_id: 'r', evidence: 'The report answers the goal' },
      null,
      sessionOf(f, lead.id, 'lead'),
    );
  writePlan(f, lead.id, [reportTask('r', { goal: 'Answer another question' })]);
  await report();
  expect(() => startTasks(f, lead.id, ['r'])).toThrow(
    expect.objectContaining({ code: 'invalid_state' }),
  );
  expect(statusOf(f, lead.id, 'r')).not.toBe('done');
  await settle(f, current(f, lead.id));
  expect(accept).toThrow(expect.objectContaining({ code: 'invalid_state' }));

  await settle(f, current(f, worker!.id));
  expect(f.turns(worker!.id).at(-1)!.input).toContain('[Pantheon] The lead changed this task.');
  await report();
  await settle(f, current(f, lead.id));
  accept();
  expect(statusOf(f, lead.id, 'r')).toBe('done');
});

it('does not hold the scope of a task id the lead removed and reused against other tasks', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a', { scope: ['src/a'] })]);
  startTasks(f, lead.id, ['a']);
  await f.control.tick();
  const [old] = sessionsOf(f, lead.id, 'a');
  expect(old).toBeDefined();
  writePlan(f, lead.id, [task('other')]);
  writePlan(f, lead.id, [
    task('a', { scope: ['src/shared'] }),
    task('c', { scope: ['src/shared/c.ts'] }),
  ]);
  startTasks(f, lead.id, ['c']);
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'c')).toHaveLength(1);
  expect(current(f, old!.id).outcome).toBeUndefined();
});

it('stops the session left from a removed task when the lead stops the task that reuses its id', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [reportTask('a')]);
  startTasks(f, lead.id, ['a']);
  await f.control.tick();
  const [old] = sessionsOf(f, lead.id, 'a');
  await settle(f, old!);
  writePlan(f, lead.id, [reportTask('b')]);
  writePlan(f, lead.id, [reportTask('a')]);
  expect(stopTask(f, lead.id, 'a')).toMatchObject({
    sessions: [{ session_id: old!.id }],
    task_state: 'todo',
  });
  await eventually(
    () => current(f, old!.id).outcome === 'discarded',
    () => f.control.tick(),
  );
});

it('holds the place and scope of an accepted report task while its session has a turn to run', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [
    reportTask('r', { scope: ['src/r'] }),
    task('d', { scope: ['src/r/d.ts'] }),
  ]);
  await acceptReport(f, lead.id, 'r');
  const [worker] = sessionsOf(f, lead.id, 'r');
  f.call(
    'session.send',
    { session_id: worker!.id, input: 'Check one more source' },
    current(f, worker!.id).revision,
  );
  startTasks(f, lead.id, ['d']);
  expect(blockersOf(f, lead.id, 'd')).toContain('Queued: waiting for the scope to free up');

  await settle(f, current(f, worker!.id));
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'd')).toHaveLength(1);
});

it('refuses a lead message to a report task it accepted', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [reportTask('r')]);
  await acceptReport(f, lead.id, 'r');
  const [worker] = sessionsOf(f, lead.id, 'r');
  const turns = f.turns(worker!.id).length;
  expect(() =>
    f.call(
      'task.message',
      { project_id: f.project.id, task_id: 'r', text: 'Look at one more source' },
      null,
      sessionOf(f, lead.id, 'lead'),
    ),
  ).toThrow(expect.objectContaining({ code: 'task_accepted' }));
  expect(f.turns(worker!.id)).toHaveLength(turns);
});

it('refuses to remove a project while a started task waits to open its session', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a'), task('b', { depends_on: ['a'] })]);
  startTasks(f, lead.id, ['b']);
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'b')).toEqual([]);
  const remove = () =>
    f.call<Project>(
      'project.remove',
      { project_id: f.project.id },
      f.store.must<Project>('projects', f.project.id).revision,
    );
  expect(remove).toThrow(expect.objectContaining({ code: 'resource_busy' }));
  expect(f.store.must<Project>('projects', f.project.id)).not.toHaveProperty('removed_at');
  stopTask(f, lead.id, 'b');
  expect(remove().removed_at).toEqual(expect.any(Number));
});

it('refuses a user revision of a lead milestone, whose sessions follow its tasks', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(
    f,
    [task('a', { milestone: 'm1' })],
    [{ id: 'm1', title: 'Export ready', criteria: ['Exports download'], tasks: ['a'] }],
  );
  const milestone = f.store.list<Milestone>('milestones').find((row) => row.key === 'm1')!;
  expect(() =>
    f.call(
      'milestone.revise',
      {
        milestone_id: milestone.id,
        title: 'Export ready',
        required_sessions: [lead.id],
        criteria: ['Exports download'],
      },
      milestone.revision,
    ),
  ).toThrow(expect.objectContaining({ code: 'invalid_state' }));
  expect(f.store.must<Milestone>('milestones', milestone.id)).toEqual(milestone);
});

it('waits for a free place before telling an accepted report task that its lead renamed it', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [reportTask('r'), task('b'), task('c'), task('d')]);
  await acceptReport(f, lead.id, 'r');
  const [worker] = sessionsOf(f, lead.id, 'r');
  startTasks(f, lead.id, ['b', 'c', 'd']);
  await f.control.tick();
  expect(['b', 'c', 'd'].map((id) => sessionsOf(f, lead.id, id).length)).toEqual([1, 1, 1]);
  const turns = f.turns(worker!.id).length;

  writePlan(f, lead.id, [
    reportTask('r', { title: 'Pick the export format' }),
    task('b'),
    task('c'),
    task('d'),
  ]);
  await f.control.tick();
  expect(f.turns(worker!.id)).toHaveLength(turns);
  expect(planOf(f, lead.id).contract_changed).toContain(worker!.id);

  const [freed] = sessionsOf(f, lead.id, 'b');
  await settle(f, freed!);
  expect(f.turns(worker!.id)).toHaveLength(turns);
  patch(f, freed!.id, { state: 'closed', outcome: 'merged' });
  await f.control.tick();
  expect(f.turns(worker!.id).at(-1)!.input).toContain('Title: Pick the export format');
});

it('holds every path for a running task session until its changed contract reaches it', async () => {
  const f = await workbenchFixture({ delay: 400 });
  const lead = await leadWithPlan(f, [task('a', { scope: ['src/a'] })]);
  startTasks(f, lead.id, ['a']);
  await f.control.tick();
  const [worker] = sessionsOf(f, lead.id, 'a');
  await awaitWorkspaceReady(f.control, worker!.workspace_id!);
  await eventually(
    () => f.turns(worker!.id).some((turn) => turn.state === 'running'),
    () => f.control.tick(),
  );

  writePlan(f, lead.id, [task('a', { scope: ['src/x'] }), task('b', { scope: ['src/a'] })]);
  startTasks(f, lead.id, ['b']);
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'b')).toEqual([]);
  expect(blockersOf(f, lead.id, 'b')).toContain('Queued: waiting for the scope to free up');

  await eventually(
    () => sessionsOf(f, lead.id, 'b').length === 1,
    () => f.control.tick(),
  );
  expect(f.turns(worker!.id).at(-1)!.input).toContain('[Pantheon] The lead changed this task.');
});

it('keeps the downstream tasks of a report task whose session merged until the lead accepts its report', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [reportTask('r'), task('d', { depends_on: ['r'] })]);
  startTasks(f, lead.id, ['r', 'd']);
  await f.control.tick();
  const [worker] = sessionsOf(f, lead.id, 'r');
  await settle(f, worker!);
  await f.call(
    'task.report',
    { project_id: f.project.id, kind: 'done', text: 'CSV is the format' },
    null,
    sessionOf(f, worker!.id, 'worker'),
  );
  await settle(f, current(f, lead.id));
  patch(f, worker!.id, { state: 'closed', outcome: 'merged' });
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'd')).toEqual([]);
  const stateOf = (taskId: string) =>
    (f.control.projectRead(user, f.project.id) as ProjectRead).plans
      .find((view) => view.lead_session_id === lead.id)!
      .tasks.find((view) => view.id === taskId)!.state;
  expect(stateOf('r')).toBe('active');

  f.call(
    'task.accept',
    { project_id: f.project.id, task_id: 'r', evidence: 'The report picks a format' },
    null,
    sessionOf(f, lead.id, 'lead'),
  );
  expect(stateOf('r')).toBe('done');
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'd')).toHaveLength(1);
});

it('opens a high priority task first when one place is left', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [
    reportTask('a'),
    reportTask('b'),
    reportTask('c'),
    reportTask('d', { priority: 'high' }),
  ]);
  startTasks(f, lead.id, ['a', 'b']);
  await f.control.tick();
  startTasks(f, lead.id, ['c', 'd']);
  await f.control.tick();
  expect(['a', 'b', 'c', 'd'].map((id) => sessionsOf(f, lead.id, id).length)).toEqual([1, 1, 0, 1]);
  expect(blockersOf(f, lead.id, 'c')).toContain('Queued: waiting for a free slot');
});

const userOn = (f: Fixture, leadId: string, command: 'task.start' | 'task.stop', input: object) =>
  f.call<Record<string, unknown>>(
    command,
    { project_id: f.project.id, lead_session_id: leadId, ...input },
    null,
    user,
  );

it('lets the user stop a running task at once, telling its lead, and only with the lead named', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [reportTask('a')]);
  startTasks(f, lead.id, ['a']);
  await f.control.tick();
  const [worker] = sessionsOf(f, lead.id, 'a');
  await settle(f, worker!);
  expect(() =>
    f.call(
      'task.stop',
      { project_id: f.project.id, task_id: 'a', reason: 'Wrong approach' },
      null,
      user,
    ),
  ).toThrow(expect.objectContaining({ code: 'permission_denied' }));

  expect(userOn(f, lead.id, 'task.stop', { task_id: 'a', reason: 'Wrong approach' })).toMatchObject(
    { task_id: 'a', sessions: [{ session_id: worker!.id }] },
  );
  expect(current(f, worker!.id).stop_requested).toMatchObject({
    reason: 'Wrong approach',
    by: 'user',
  });
  await eventually(
    () => current(f, worker!.id).outcome === 'discarded',
    () => f.control.tick(),
  );
  const edits = planOf(f, lead.id).inbox.filter((note) => note.kind === 'user_edit');
  expect(edits).toEqual([expect.objectContaining({ task_id: 'a' })]);
  expect(edits[0]!.text).toContain('Wrong approach');
});

it('lets the user start a task with no unfinished session, through the same queue', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [reportTask('a'), reportTask('b', { depends_on: ['a'] })]);
  startTasks(f, lead.id, ['a']);
  await f.control.tick();
  expect(() => userOn(f, lead.id, 'task.start', { task_ids: ['a'] })).toThrow(
    expect.objectContaining({ code: 'invalid_state', message: expect.stringContaining('stop') }),
  );
  expect(() =>
    f.call('task.start', { project_id: f.project.id, task_ids: ['b'] }, null, user),
  ).toThrow(expect.objectContaining({ code: 'permission_denied' }));

  expect(userOn(f, lead.id, 'task.start', { task_ids: ['b'] })).toEqual({ requested: ['b'] });
  expect(Object.keys(planOf(f, lead.id).dispatch!)).toEqual(['b']);
  expect(planOf(f, lead.id).inbox.filter((note) => note.kind === 'user_edit')).toEqual([
    expect.objectContaining({ task_id: 'b' }),
  ]);
  await f.control.tick();
  expect(blockersOf(f, lead.id, 'b')).toContain('Queued: waiting for dependencies');
});

it('tells a task session that opens again how the earlier session of the task ended', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [reportTask('a')]);
  startTasks(f, lead.id, ['a']);
  await f.control.tick();
  const [first] = sessionsOf(f, lead.id, 'a');
  await settle(f, first!);
  stopTask(f, lead.id, 'a');
  await eventually(
    () => current(f, first!.id).outcome === 'discarded',
    () => f.control.tick(),
  );
  startTasks(f, lead.id, ['a']);
  await f.control.tick();
  const second = sessionsOf(f, lead.id, 'a').find((session) => session.id !== first!.id);
  const input = f.turns(second!.id)[0]!.input;
  expect(input).toMatch(/^Task a\n\nTask a of the plan [^\n]*\n\nGoal:\nFinish task a\n/);
  expect(input).toContain('The approach changed');
});

it('reserves runtime capacity across the queue and admits a different runtime', async () => {
  const f = await workbenchFixture(),
    second = new FixtureAdapter();
  second.name = 'second';
  f.control.adapters.set(second.name, second);
  const lead = await leadWithPlan(f, [
    reportTask('first'),
    reportTask('second'),
    reportTask('other', { runtime: second.name }),
  ]);
  f.call(
    'workflow.policy.set',
    {
      project_id: f.project.id,
      runtime_parallel: { [f.adapter.name]: 1 },
    },
    f.store.must('workflow_policies', f.project.id).revision,
  );
  startTasks(f, lead.id, ['first', 'second', 'other']);
  const board = f.control.boardView(user, f.project.id, 1);
  expect(board.tasks.find((row) => row.id === `${lead.id}:second`)?.dispatch_wait).toBe(
    'runtime_capacity',
  );
  expect(board.tasks.find((row) => row.id === `${lead.id}:other`)?.dispatch_wait).toBeUndefined();
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'first')).toHaveLength(1);
  expect(sessionsOf(f, lead.id, 'second')).toHaveLength(0);
  expect(sessionsOf(f, lead.id, 'other')).toHaveLength(1);
  patch(f, sessionsOf(f, lead.id, 'first')[0]!.id, { state: 'closed', outcome: 'merged' });
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'second')).toHaveLength(1);
});

it('pauses dispatch and direct claims while running task sessions continue', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [
    reportTask('active'),
    reportTask('queued'),
    task('direct', { path: 'direct', flow_reason: 'The lead handles it' }),
  ]);
  startTasks(f, lead.id, ['active']);
  await f.control.tick();
  const worker = sessionsOf(f, lead.id, 'active')[0]!;
  f.call(
    'workflow.policy.set',
    { project_id: f.project.id, dispatch_paused: true },
    f.store.must('workflow_policies', f.project.id).revision,
  );
  startTasks(f, lead.id, ['queued']);
  expect(
    f.control.boardView(user, f.project.id, 1).tasks.find((row) => row.id === `${lead.id}:queued`)
      ?.dispatch_wait,
  ).toBe('paused');
  expect(() => startTasks(f, lead.id, ['direct'])).toThrow(/paused/i);
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'queued')).toHaveLength(0);
  expect(current(f, worker.id).stop_requested).toBeUndefined();
  f.call(
    'workflow.policy.set',
    { project_id: f.project.id, dispatch_paused: false },
    f.store.must('workflow_policies', f.project.id).revision,
  );
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'queued')).toHaveLength(1);
  expect(startTasks(f, lead.id, ['direct'])).toMatchObject({ claimed: 'direct' });
});

it('reads the routing statistics no more often when more tasks queue', async () => {
  const f = await workbenchFixture();
  const kind = { domain: 'backend-logic', tier: 't1' } as const;
  const lead = await leadWithPlan(f, [
    reportTask('one', { kind }),
    reportTask('two', { kind }),
    reportTask('three', { kind }),
  ]);
  f.call(
    'workflow.policy.set',
    { project_id: f.project.id, dispatch_paused: true },
    f.store.must('workflow_policies', f.project.id).revision,
  );
  const list = f.store.list.bind(f.store);
  let statsReads = 0;
  vi.spyOn(f.store, 'list').mockImplementation(((table: string) => {
    if (table === 'retrospectives' && new Error().stack!.includes('routingStats')) statsReads++;
    return list(table as never);
  }) as typeof f.store.list);
  const paused = () =>
    f.control
      .boardView(user, f.project.id, 1)
      .tasks.filter((row) => row.dispatch_wait === 'paused');
  startTasks(f, lead.id, ['one']);
  // The first read after a plan change also fills what later reads reuse.
  paused();
  statsReads = 0;
  expect(paused()).toHaveLength(1);
  const readsForOne = statsReads;
  startTasks(f, lead.id, ['two', 'three']);
  statsReads = 0;
  expect(paused()).toHaveLength(3);
  expect(statsReads).toBe(readsForOne);
});

it.each(
  (['records', 'writer', 'user'] as const).flatMap((source) =>
    ['dispatch', 'composer'].map((entry) => ({ source, entry })),
  ),
)('routes the $entry task using the $source choice', async ({ source, entry }) => {
  const f = await workbenchFixture({ delay: 10 });
  for (const name of ['claude', 'codex']) {
    const adapter = new FixtureAdapter(10);
    adapter.name = name;
    f.control.adapters.set(name, adapter);
  }
  const kind = { domain: 'backend-logic', tier: 't2' } as const;
  f.store.insert('retrospectives', {
    id: 'routing-history',
    revision: 1,
    project_id: f.project.id,
    lead_session_id: 'earlier-lead',
    task_id: 'earlier-task',
    session_ids: [],
    outcome: 'merged',
    recorded_at: f.store.now(),
    runtime: 'codex',
    model: 'gpt-fixture',
    measured_kind: kind,
    gate_passed_on_attempt: 1,
  });
  const selected = { runtime: 'claude', model: 'claude-fixture', effort: 'low' } as const;
  if (source === 'writer')
    f.call(
      'project.sessionDefaults.set',
      {
        project_id: f.project.id,
        runtime: 'fixture',
        permission_mode: 'ask',
        writer: selected,
      },
      f.project.revision,
    );
  if (source === 'user')
    f.call(
      'routing.set',
      { project_id: f.project.id, ...kind, slot: 'first', choice: selected },
      f.project.revision,
    );
  const lead = await leadWithPlan(f, [reportTask('explain-export', { kind })]);
  if (entry === 'dispatch') {
    startTasks(f, lead.id, ['explain-export']);
    await f.control.tick();
  } else
    await f.call('session.create', {
      project_id: f.project.id,
      task_id: `${lead.id}:explain-export`,
      input: 'Explain the export',
    });
  const [writer] = sessionsOf(f, lead.id, 'explain-export');
  expect(writer).toMatchObject(
    source === 'records'
      ? { runtime: 'codex', requested_model: 'gpt-fixture' }
      : {
          runtime: selected.runtime,
          requested_model: selected.model,
          requested_effort: selected.effort,
        },
  );
});

it.each(['admission', 'quota'] as const)(
  'uses the writer fallback at the existing %s check',
  async (unavailable) => {
    const f = await workbenchFixture({ delay: 10 });
    const backup = new FixtureAdapter(10);
    backup.name = 'claude';
    f.control.adapters.set(backup.name, backup);
    f.call(
      'project.sessionDefaults.set',
      {
        project_id: f.project.id,
        runtime: 'fixture',
        permission_mode: 'ask',
        fallbacks: { writer: { runtime: 'claude', model: 'claude-fixture', effort: 'low' } },
      },
      f.project.revision,
    );
    const lead = await leadWithPlan(f, [reportTask('explain-export')]);
    startTasks(f, lead.id, ['explain-export']);
    const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
    if (unavailable === 'admission') f.control.adapters.delete('fixture');
    else
      ctx.runtimeStatus.set('fixture', {
        quota: {
          windows: [{ window: 'five_hour', used_percent: 100 }],
          seen_at: f.store.now(),
        },
      });
    await f.control.tick();
    expect(sessionsOf(f, lead.id, 'explain-export')[0]).toMatchObject({
      runtime: 'claude',
      requested_model: 'claude-fixture',
      requested_effort: 'low',
    });
  },
);

it.each(['runtime_capacity', 'runtime_limited'] as const)(
  'waits with %s when the writer fallback that admission would take is limited',
  async (wait) => {
    const f = await workbenchFixture({ delay: 10 });
    const backup = new FixtureAdapter(10);
    backup.name = 'claude';
    f.control.adapters.set(backup.name, backup);
    f.call(
      'project.sessionDefaults.set',
      {
        project_id: f.project.id,
        runtime: 'fixture',
        permission_mode: 'ask',
        fallbacks: { writer: { runtime: 'claude', model: 'claude-fixture', effort: 'low' } },
      },
      f.project.revision,
    );
    const lead = await leadWithPlan(f, [reportTask('first'), reportTask('second')]);
    const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
    if (wait === 'runtime_capacity')
      f.call(
        'workflow.policy.set',
        { project_id: f.project.id, runtime_parallel: { claude: 1 } },
        f.store.must('workflow_policies', f.project.id).revision,
      );
    else
      ctx.runtimeStatus.set('claude', {
        quota: { windows: [{ window: 'five_hour', used_percent: 100 }], seen_at: f.store.now() },
      });
    startTasks(f, lead.id, ['first', 'second']);
    f.control.adapters.delete('fixture');
    const waiting = wait === 'runtime_capacity' ? 'second' : 'first';
    expect(
      f.control
        .boardView(user, f.project.id, 1)
        .tasks.find((row) => row.id === `${lead.id}:${waiting}`)?.dispatch_wait,
    ).toBe(wait);
    await f.control.tick();
    expect(sessionsOf(f, lead.id, waiting)).toHaveLength(0);
  },
);

it('keeps the runtime the user names for a task session when it is over the quota threshold', async () => {
  const f = await workbenchFixture({ delay: 10 });
  const backup = new FixtureAdapter(10);
  backup.name = 'claude';
  f.control.adapters.set(backup.name, backup);
  f.call(
    'project.sessionDefaults.set',
    {
      project_id: f.project.id,
      runtime: 'fixture',
      permission_mode: 'ask',
      fallbacks: { writer: { runtime: 'claude', model: 'claude-fixture', effort: 'low' } },
    },
    f.project.revision,
  );
  const lead = await leadWithPlan(f, [reportTask('explain-export')]);
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  ctx.runtimeStatus.set('fixture', {
    quota: { windows: [{ window: 'five_hour', used_percent: 100 }], seen_at: f.store.now() },
  });
  await f.call('session.create', {
    project_id: f.project.id,
    task_id: `${lead.id}:explain-export`,
    runtime: 'fixture',
    input: 'Explain the export',
  });
  expect(sessionsOf(f, lead.id, 'explain-export')[0]).toMatchObject({ runtime: 'fixture' });
});

it.each(['runtime', 'model'] as const)(
  'opens a task session the user gives another %s with a model of that runtime',
  async (given) => {
    const f = await workbenchFixture({ delay: 10 });
    for (const name of ['claude', 'codex']) {
      const adapter = new FixtureAdapter(10);
      adapter.name = name;
      f.control.adapters.set(name, adapter);
    }
    const lead = await leadWithPlan(f, [
      reportTask(
        'explain-export',
        given === 'runtime'
          ? {
              runtime: 'claude',
              model: 'claude-fixture',
              effort: 'high',
              route_reason: 'The export needs the larger model',
            }
          : {},
      ),
    ]);
    await f.call('session.create', {
      project_id: f.project.id,
      task_id: `${lead.id}:explain-export`,
      ...(given === 'runtime' ? { runtime: 'codex' } : { model: 'gpt-5-codex' }),
      input: 'Explain the export',
    });
    const [writer] = sessionsOf(f, lead.id, 'explain-export');
    expect(writer!.runtime).toBe('codex');
    expect(writer!.requested_model).not.toBe('claude-fixture');
  },
);

it.each(['absent', 'reviewer', 'fallback'] as const)(
  'selects the %s reviewer and starts it on its selected model',
  async (source) => {
    const f = await workbenchFixture({ delay: 10 });
    for (const name of ['claude', 'codex']) {
      const adapter = new FixtureAdapter(10);
      adapter.name = name;
      f.control.adapters.set(name, adapter);
    }
    f.store.insert('retrospectives', {
      id: 'review-routing-history',
      revision: 1,
      project_id: f.project.id,
      lead_session_id: 'earlier-lead',
      task_id: 'earlier-review',
      session_ids: [],
      outcome: 'merged',
      recorded_at: f.store.now(),
      runtime: 'claude',
      model: 'claude-fixture',
      measured_kind: { domain: 'review', tier: 't2' },
      gate_passed_on_attempt: 1,
    });
    expect(f.control.routingTable(user, f.project.id).cells[0]?.first?.runtime).toBe('claude');
    if (source !== 'absent')
      f.call(
        'project.sessionDefaults.set',
        {
          project_id: f.project.id,
          runtime: 'fixture',
          permission_mode: 'ask',
          reviewer: { runtime: 'codex', model: 'gpt-fixture' },
          fallbacks: { reviewer: { runtime: 'claude', model: 'claude-fixture', effort: 'low' } },
        },
        f.project.revision,
      );
    if (source === 'fallback') f.control.adapters.delete('codex');
    const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
    const name = reviewerRuntime(ctx, f.project.id, 'fixture');
    expect(name).toBe(source === 'reviewer' ? 'codex' : 'claude');
    const review = f.store.transaction(() =>
      startReview(ctx, f.project.id, [name!], {
        round: 1,
        cause: 'review-export',
        prompt: 'Review the export',
        artifact: { name: 'changes.diff', content: Buffer.from('export') },
      }),
    );
    const reviewer = f.store.must<Session>('sessions', review.session_ids[0]!);
    if (source === 'absent') expect(reviewer.requested_model).toBeUndefined();
    else
      expect(reviewer).toMatchObject(
        source === 'reviewer'
          ? { runtime: 'codex', requested_model: 'gpt-fixture' }
          : { runtime: 'claude', requested_model: 'claude-fixture', requested_effort: 'low' },
      );
  },
);

it.each([
  ['claude', 'auto'],
  ['codex', 'full_access'],
] as const)('refuses a lead dispatch inheriting %s %s', async (runtime, permission_mode) => {
  const f = await workbenchFixture();
  f.control.adapters.set(runtime, f.adapter);
  const lead = await leadWithPlan(f, [task('export', { runtime })]);
  const project = f.store.must<Project>('projects', f.project.id);
  f.store.update(
    'projects',
    { ...project, session_defaults: { runtime, permission_mode } },
    project.revision,
  );
  expect(() => startTasks(f, lead.id, ['export'])).toThrow(
    expect.objectContaining({ code: 'unsupported_capability' }),
  );
  expect(sessionsOf(f, lead.id, 'export')).toEqual([]);
});

it.each([
  ['claude', 'auto'],
  ['codex', 'full_access'],
] as const)('dispatches the %s %s mode selected by the user', async (runtime, permission_mode) => {
  const f = await workbenchFixture();
  f.control.adapters.set(runtime, f.adapter);
  const lead = await leadWithPlan(f, [task('export', { runtime })]);
  const project = f.store.must<Project>('projects', f.project.id);
  f.store.update(
    'projects',
    { ...project, session_defaults: { runtime, permission_mode } },
    project.revision,
  );
  f.call(
    'task.start',
    { project_id: f.project.id, lead_session_id: lead.id, task_ids: ['export'] },
    null,
    user,
  );
  await eventually(
    () => sessionsOf(f, lead.id, 'export').length === 1,
    () => f.control.tick(),
  );
  expect(sessionsOf(f, lead.id, 'export')[0]?.permission_mode).toBe(permission_mode);
});

it.each([
  ['claude', 'auto'],
  ['codex', 'full_access'],
] as const)(
  'refuses %s %s defaults added after a lead queued dispatch',
  async (runtime, permission_mode) => {
    const f = await workbenchFixture();
    f.control.adapters.set(runtime, f.adapter);
    const lead = await leadWithPlan(f, [task('export', { runtime })]);
    startTasks(f, lead.id, ['export']);
    const project = f.store.must<Project>('projects', f.project.id);
    f.store.update(
      'projects',
      { ...project, session_defaults: { runtime, permission_mode } },
      project.revision,
    );
    await f.control.tick();
    expect(sessionsOf(f, lead.id, 'export')).toEqual([]);
    expect(planOf(f, lead.id).dispatch?.export?.error?.code).toBe('unsupported_capability');
  },
);
