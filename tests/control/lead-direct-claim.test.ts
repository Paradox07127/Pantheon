import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import type {
  BoardPlan,
  Principal,
  Project,
  Session,
  SessionTurn,
  UserTurn,
  Workspace,
} from '@pantheon/domain';
import { countingGit, eventually, settle, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
type PlanTask = BoardPlan['tasks'][number];

const sessionOf = (f: Fixture, sessionId: string, role: 'lead' | 'worker'): Principal => ({
  id: `session:${sessionId}`,
  role,
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});

const simple = { domain: 'backend-logic', tier: 't1' } as const;

const task = (id: string, fields: Partial<PlanTask> = {}): PlanTask => ({
  id,
  title: `Task ${id}`,
  goal: `Finish task ${id}`,
  lane: 'core',
  depends_on: [],
  source: ['Plan the export feature'],
  scope: [`src/${id}.ts`],
  acceptance: ['pnpm test'],
  kind: simple,
  ...fields,
});

const dispatched = (id: string, fields: Partial<PlanTask> = {}) =>
  task(id, { path: 'dispatch', flow_reason: 'It needs a session of its own', ...fields });

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const planOf = (f: Fixture, leadId: string) => f.store.must<BoardPlan>('board_plans', leadId);
const sessionsOf = (f: Fixture, leadId: string, taskId: string) =>
  f.store
    .list<Session>('sessions')
    .filter((session) => session.task?.lead_session_id === leadId && session.task.id === taskId);
const blockersOf = (f: Fixture, leadId: string, taskId: string) =>
  f.control.boardView(user, f.project.id, 1).tasks.find((row) => row.id === `${leadId}:${taskId}`)!
    .blockers;
const eventsOf = (f: Fixture, aggregateId: string, kind: string) =>
  (
    f.store.db
      .prepare('SELECT payload FROM events WHERE aggregate_id=? AND kind=? ORDER BY sequence')
      .all(aggregateId, kind) as { payload: string }[]
  ).map((row) => JSON.parse(row.payload) as Record<string, unknown>);

async function leadWithPlan(f: Fixture, tasks: PlanTask[]) {
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks,
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    sessionOf(f, lead.id, 'lead'),
  );
  return lead;
}

const start = (f: Fixture, leadId: string, taskIds: string[]) =>
  f.call<Record<string, unknown>>(
    'task.start',
    { project_id: f.project.id, task_ids: taskIds },
    null,
    sessionOf(f, leadId, 'lead'),
  );

const report = (f: Fixture, sessionId: string, role: 'lead' | 'worker', kind = 'done') =>
  f.call<Record<string, unknown>>(
    'task.report',
    { project_id: f.project.id, kind, text: 'The export works' },
    null,
    sessionOf(f, sessionId, role),
  );

/** A goal the fixture runtime runs as a script. */
const script = (...steps: object[]) => `fixture-script\n${JSON.stringify(steps)}`;

/** Declares that the fixture runtime cannot let a turn that started read-only write. */
const lockedTurns = (f: Fixture) => {
  f.adapter.report.capabilities.turn_write_unlock = {
    status: 'unsupported',
    evidence: 'A fixture turn keeps the read-only flag it started with',
  };
};

/** Sends the lead a turn that runs for a while and waits until it runs. */
async function runningTurn(f: Fixture, lead: Session) {
  const turn = f.call<SessionTurn>(
    'session.send',
    { session_id: lead.id, input: script({ wait: 500 }) },
    current(f, lead.id).revision,
  );
  await eventually(
    () => f.turns(lead.id).find((each) => each.id === turn.id)?.state === 'running',
    () => f.control.tick(),
  );
  return turn;
}

/** The turns the adapter received after the given one. */
const sentAfter = (send: { mock: { calls: unknown[][] } }, turnId: string) => {
  const sent = send.mock.calls.map(([, turn]) => turn as UserTurn);
  return sent.slice(sent.findIndex((turn) => turn.turn_id === turnId) + 1);
};

/** Sends one more turn to the session and returns the turn the adapter received. */
async function delivered(f: Fixture, send: { mock: { calls: unknown[][] } }, session: Session) {
  const turn = f.call<SessionTurn>(
    'session.send',
    { session_id: session.id, input: 'Go on with the export' },
    current(f, session.id).revision,
  );
  await settle(f, session);
  const call = send.mock.calls.find(([, sent]) => (sent as UserTurn).turn_id === turn.id);
  expect(call).toBeDefined();
  return call![1] as UserTurn;
}

it('lets a lead claim a direct task itself, without a task session, and write in its turns', async () => {
  const f = await workbenchFixture();
  const send = vi.spyOn(f.adapter, 'send');
  const lead = await leadWithPlan(f, [task('a')]);

  start(f, lead.id, ['a']);
  await f.control.tick();

  expect(sessionsOf(f, lead.id, 'a')).toEqual([]);
  expect(planOf(f, lead.id).dispatch ?? {}).toEqual({});
  expect(current(f, lead.id).direct_task).toEqual({
    id: 'a',
    generation: 1,
  });
  expect(eventsOf(f, lead.id, 'task.claimed')).toEqual([{ task_id: 'a', generation: 1 }]);
  expect((await delivered(f, send, lead)).read_only ?? false).toBe(false);
});

it('gives a lead the task memory of the direct task it works on', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  start(f, lead.id, ['a']);
  const scope = { lead_session_id: lead.id, id: 'a', generation: 1 };
  const draft = f.call<{ id: string; revision: number }>('memory.propose', {
    project_id: f.project.id,
    key: 'own-rule',
    kind: 'decision',
    text: 'Use the v2 API for this task',
    task: scope,
  });
  f.call('memory.commit', { memory_id: draft.id }, draft.revision);
  const p = sessionOf(f, lead.id, 'lead');
  const packet = f.call<{
    signature: string;
    items: { key: string }[];
  }>('memory.context', { project_id: f.project.id }, null, p);
  expect(packet.items.map((item) => item.key)).toEqual(['own-rule']);
  const note = f.call<{ task?: unknown }>(
    'memory.propose',
    {
      project_id: f.project.id,
      key: 'own-note',
      kind: 'note',
      text: 'The v2 API pages by cursor',
      based_on: packet.signature,
    },
    null,
    p,
  );
  expect(note.task).toEqual(scope);
});

it('dispatches a task whose path is dispatch, and a task without a kind', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [
    dispatched('a'),
    task('r', { kind: undefined, done_when: 'report', scope: [], acceptance: [] }),
  ]);
  expect(planOf(f, lead.id).tasks.find((each) => each.id === 'r')!.kind).toBeUndefined();

  expect(start(f, lead.id, ['a', 'r'])).toEqual({ requested: ['a', 'r'] });
  await f.control.tick();

  expect(current(f, lead.id).direct_task).toBeUndefined();
  expect(sessionsOf(f, lead.id, 'a')).toHaveLength(1);
  expect(sessionsOf(f, lead.id, 'r')).toHaveLength(1);
});

it('dispatches a report task even when its tier takes the direct path', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [
    task('r', { done_when: 'report', scope: [], acceptance: [] }),
  ]);

  expect(start(f, lead.id, ['r'])).toEqual({ requested: ['r'] });
  await f.control.tick();

  expect(current(f, lead.id).direct_task).toBeUndefined();
  expect(eventsOf(f, lead.id, 'task.claimed')).toEqual([]);
  expect(sessionsOf(f, lead.id, 'r')).toHaveLength(1);
});

it('queues a writable turn after the read-only turn in which the lead claims a direct task', async () => {
  const f = await workbenchFixture();
  lockedTurns(f);
  const send = vi.spyOn(f.adapter, 'send');
  const lead = await leadWithPlan(f, [task('a')]);
  const turn = await runningTurn(f, lead);

  expect(start(f, lead.id, ['a'])).toEqual({
    claimed: 'a',
    generation: 1,
    note: expect.stringContaining('end this turn'),
  });
  await settle(f, lead);

  expect(send.mock.calls.find(([, sent]) => (sent as UserTurn).turn_id === turn.id)![1]).toEqual(
    expect.objectContaining({ read_only: true }),
  );
  const later = sentAfter(send, turn.id);
  expect(later).toHaveLength(1);
  expect(later[0]!.input).toMatch(/^\[Pantheon\] .*task a/);
  expect(later[0]!.read_only ?? false).toBe(false);
});

it('queues no extra turn when the lead claims a direct task in a turn that started writable', async () => {
  const f = await workbenchFixture();
  lockedTurns(f);
  const send = vi.spyOn(f.adapter, 'send');
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  const turn = await runningTurn(f, lead);
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [task('a')],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    sessionOf(f, lead.id, 'lead'),
  );

  expect(start(f, lead.id, ['a'])).toEqual({ claimed: 'a', generation: 1 });
  await settle(f, lead);

  expect(sentAfter(send, turn.id)).toEqual([]);
});

it('refuses a direct task started with others, and a second one while the lead works on one', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a'), task('b'), dispatched('c')]);

  expect(() => start(f, lead.id, ['a', 'c'])).toThrow(
    expect.objectContaining({ code: 'invalid_input', message: expect.stringContaining('direct') }),
  );
  expect(planOf(f, lead.id).dispatch ?? {}).toEqual({});
  start(f, lead.id, ['a']);
  expect(() => start(f, lead.id, ['b'])).toThrow(
    expect.objectContaining({ code: 'invalid_state', message: expect.stringContaining('task a') }),
  );
  expect(current(f, lead.id).direct_task).toEqual({
    id: 'a',
    generation: 1,
  });
});

it('keeps the scope of a direct task and of running task sessions apart', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [
    dispatched('running', { scope: ['src/shared'] }),
    task('inside', { scope: ['src/shared/inside.ts'] }),
    task('own', { scope: ['src/own.ts'] }),
    dispatched('later', { scope: ['src/own.ts'] }),
  ]);
  start(f, lead.id, ['running']);
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'running')).toHaveLength(1);

  expect(() => start(f, lead.id, ['inside'])).toThrow(
    expect.objectContaining({
      code: 'resource_busy',
      message: expect.stringContaining('task running'),
    }),
  );
  expect(current(f, lead.id).direct_task).toBeUndefined();

  start(f, lead.id, ['own']);
  start(f, lead.id, ['later']);
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'later')).toEqual([]);
  expect(blockersOf(f, lead.id, 'later')).toContain('Queued: waiting for the scope to free up');
});

it('records the worktree head when the lead reports its direct task done', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a'), dispatched('b')]);
  expect(() => report(f, lead.id, 'lead')).toThrow(
    expect.objectContaining({ code: 'invalid_state' }),
  );

  start(f, lead.id, ['a']);
  const worktree = f.store.must<Workspace>('workspaces', lead.workspace_id!).path;
  writeFileSync(path.join(worktree, 'answer.txt'), 'done\n');
  git(worktree, 'commit', '--quiet', '-am', 'Finish task a');
  expect(() => report(f, lead.id, 'lead', 'risk')).toThrow(
    expect.objectContaining({ code: 'invalid_input' }),
  );
  await report(f, lead.id, 'lead');

  expect(current(f, lead.id).direct_task).toEqual({
    id: 'a',
    generation: 1,
    reported_head: git(worktree, 'rev-parse', 'HEAD'),
    reported_at: expect.any(Number),
  });
  expect(eventsOf(f, lead.id, 'task.reported')).toEqual([
    { task_id: 'a', generation: 1, direct: true, status: 'done' },
  ]);
  expect(planOf(f, lead.id).inbox).toEqual([]);

  start(f, lead.id, ['b']);
  await f.control.tick();
  const [worker] = sessionsOf(f, lead.id, 'b');
  await settle(f, worker!);
  report(f, worker!.id, 'worker', 'risk');
  expect(planOf(f, lead.id).inbox).toEqual([
    expect.objectContaining({ session_id: worker!.id, task_id: 'b', kind: 'risk' }),
  ]);
  expect(current(f, lead.id).direct_task?.id).toBe('a');
});

it.each([
  [false, 'Auto-merge is off, so these commits wait for the user to merge them from your session'],
  [true, 'Pantheon now runs the gates and merges these commits'],
])(
  'tells the lead who merges its reported direct task when auto-merge is %s',
  async (autoMerge, next) => {
    const f = await workbenchFixture();
    const lead = await leadWithPlan(f, [task('a')]);
    const project = f.store.must<Project>('projects', f.project.id);
    f.store.update('projects', { ...project, auto_merge: autoMerge }, project.revision);
    start(f, lead.id, ['a']);
    const worktree = f.store.must<Workspace>('workspaces', lead.workspace_id!).path;
    writeFileSync(path.join(worktree, 'answer.txt'), 'done\n');
    git(worktree, 'commit', '--quiet', '-am', 'Finish task a');

    expect(await report(f, lead.id, 'lead')).toMatchObject({ next: expect.stringContaining(next) });
  },
);

it('refuses the done report of a direct task when the worktree head cannot be read', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  start(f, lead.id, ['a']);
  const worktree = f.store.must<Workspace>('workspaces', lead.workspace_id!).path;
  git(worktree, 'symbolic-ref', 'HEAD', 'refs/heads/unborn');

  await expect(report(f, lead.id, 'lead')).rejects.toThrow(
    expect.objectContaining({ code: 'git_failed' }),
  );
  expect(current(f, lead.id).direct_task?.reported_head).toBeUndefined();
  expect(eventsOf(f, lead.id, 'task.reported')).toEqual([]);
});

it('reads the worktree head of a direct task report while other work goes on', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  start(f, lead.id, ['a']);
  const worktree = f.store.must<Workspace>('workspaces', lead.workspace_id!).path;
  writeFileSync(path.join(worktree, 'answer.txt'), 'done\n');
  git(worktree, 'commit', '--quiet', '-am', 'Finish task a');
  const head = git(worktree, 'rev-parse', 'HEAD');
  const counter = countingGit();
  onTestFinished(counter.restore);
  counter.slowOn('rev-parse --verify HEAD^{commit}');
  let fired = false;
  const timer = setTimeout(() => (fired = true), 50);
  onTestFinished(() => clearTimeout(timer));
  expect(await report(f, lead.id, 'lead')).toMatchObject({ reported_head: head });
  expect(fired).toBe(true);
});

it('releases the direct task the lead stops, and makes its turns read-only again', async () => {
  const f = await workbenchFixture();
  const send = vi.spyOn(f.adapter, 'send');
  const lead = await leadWithPlan(f, [task('a')]);
  start(f, lead.id, ['a']);

  f.call(
    'task.stop',
    { project_id: f.project.id, task_id: 'a', reason: 'The lead gives the task up' },
    null,
    sessionOf(f, lead.id, 'lead'),
  );

  expect(current(f, lead.id).direct_task).toBeUndefined();
  expect(eventsOf(f, lead.id, 'task.released')).toEqual([{ task_id: 'a' }]);
  expect((await delivered(f, send, lead)).read_only).toBe(true);
});

it('releases the direct task the user stops on the board', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  start(f, lead.id, ['a']);

  f.call('task.stop', {
    project_id: f.project.id,
    lead_session_id: lead.id,
    task_id: 'a',
    reason: 'The user wants it later',
  });

  expect(current(f, lead.id).direct_task).toBeUndefined();
});

it('dispatches a direct task the user starts', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);

  expect(
    f.call('task.start', { project_id: f.project.id, lead_session_id: lead.id, task_ids: ['a'] }),
  ).toEqual({ requested: ['a'] });
  await f.control.tick();

  expect(current(f, lead.id).direct_task).toBeUndefined();
  expect(sessionsOf(f, lead.id, 'a')).toHaveLength(1);
});

it('refuses a direct task whose upstream task is not done', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [dispatched('a'), task('b', { depends_on: ['a'] })]);

  expect(() => start(f, lead.id, ['b'])).toThrow(
    expect.objectContaining({ code: 'invalid_state', message: expect.stringContaining('task a') }),
  );
  expect(current(f, lead.id).direct_task).toBeUndefined();
});

it('releases the direct task the lead takes out of its plan', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a'), task('b')]);
  start(f, lead.id, ['a']);

  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: planOf(f, lead.id).plan_version,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [task('b')],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    sessionOf(f, lead.id, 'lead'),
  );

  expect(current(f, lead.id).direct_task).toBeUndefined();
  expect(eventsOf(f, lead.id, 'task.released')).toEqual([{ task_id: 'a' }]);
});

it('releases the direct task whose goal the lead rewrites and lets the lead claim it again', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  start(f, lead.id, ['a']);

  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: planOf(f, lead.id).plan_version,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [task('a', { goal: 'Finish task a another way' })],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    sessionOf(f, lead.id, 'lead'),
  );

  expect(current(f, lead.id).direct_task).toBeUndefined();
  expect(eventsOf(f, lead.id, 'task.released')).toEqual([{ task_id: 'a' }]);
  start(f, lead.id, ['a']);
  expect(current(f, lead.id).direct_task).toMatchObject({ id: 'a', generation: 2 });
});

it('does not call a queued task stuck while the lead works on the direct task it waits for', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a'), dispatched('b', { depends_on: ['a'] })]);

  start(f, lead.id, ['a']);
  start(f, lead.id, ['b']);
  await f.control.tick();
  await f.control.tick();

  expect(current(f, lead.id).direct_task?.id).toBe('a');
  expect(planOf(f, lead.id).dispatch).toHaveProperty('b');
  expect(
    f.control
      .needsYou(user, f.project.id)
      .items.filter((item) => item.reason === 'task_upstream_stuck'),
  ).toEqual([]);
  expect(eventsOf(f, lead.id, 'lead.note_added').filter((note) => note.task_id === 'b')).toEqual(
    [],
  );
});
