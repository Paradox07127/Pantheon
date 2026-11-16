import { expect, it, vi } from 'vitest';
import {
  hash,
  type BoardPlan,
  type Principal,
  type Project,
  type Session,
  type SessionTurn,
  type Workspace,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/src/context.js';
import { gateCommands } from '../../packages/control/src/landing.js';
import {
  chainDepth,
  nextDepth,
  quiet,
  stalled,
  turnLoop,
  verifiedProgress,
  type TurnActivity,
} from '../../packages/control/src/progress.js';
import { settle, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = ReturnType<typeof workbenchFixture>;
type PlanTask = BoardPlan['tasks'][number];

const MINUTE = 60_000;

const activity = (fields: Partial<TurnActivity> = {}): TurnActivity => ({
  started_at: 0,
  acted_at: 0,
  completed: [],
  ...fields,
});

const failed = (input: unknown) => ({ ok: false, call: { name: 'Bash', input } });

it('calls a running turn quiet after two minutes without progress or a tool call under way', () => {
  expect(quiet(activity(), 2 * MINUTE)).toBe(false);
  expect(quiet(activity(), 2 * MINUTE + 1)).toBe(true);
  expect(quiet(activity({ acted_at: MINUTE }), 2 * MINUTE + 1)).toBe(false);
  expect(quiet(activity({ open_call: { at: 0, name: 'Bash' } }), 30 * MINUTE)).toBe(false);
});

it('calls a running turn stalled after ten minutes without progress or a tool call under way', () => {
  expect(stalled(activity(), 9 * MINUTE)).toBe(false);
  expect(stalled(activity(), 10 * MINUTE)).toBe(false);
  expect(stalled(activity(), 10 * MINUTE + 1)).toBe(true);
  expect(stalled(activity({ open_call: { at: 0, name: 'Bash' } }), 30 * MINUTE)).toBe(false);
});

it('calls a running turn looping when the same tool call failed three times in a row', () => {
  const test = { command: 'pnpm test' };
  expect(turnLoop(activity({ completed: [failed(test), failed(test)] }))).toBeUndefined();
  expect(
    turnLoop(
      activity({ completed: [failed(test), failed({ command: 'pnpm build' }), failed(test)] }),
    ),
  ).toBeUndefined();
  expect(
    turnLoop(
      activity({
        completed: [failed(test), failed(test), { ok: true, call: { name: 'Bash', input: test } }],
      }),
    ),
  ).toBeUndefined();
  expect(
    turnLoop(activity({ completed: [failed(test), failed(test), failed(test)] }))?.call,
  ).toEqual({
    name: 'Bash',
    input: test,
  });
});

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

const contextOf = (f: Fixture) => (f.control as unknown as { ctx: ControlContext }).ctx;
const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);

const writePlan = (f: Fixture, lead: Session, tasks: PlanTask[]) =>
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: f.store.get<BoardPlan>('board_plans', lead.id)?.plan_version ?? 0,
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

/** A lead with a plan of the tasks given and an idle session of the first. */
async function leadAndWorker(f: Fixture, tasks: PlanTask[]) {
  const lead = f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead, tasks);
  const worker = f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Build it',
    task_id: `${lead.id}:${tasks[0]!.id}`,
  });
  await settle(f, worker);
  return { lead, worker };
}

const report = (f: Fixture, worker: Session, kind: string, text: string) =>
  f.call(
    'task.report',
    { project_id: f.project.id, kind, text },
    null,
    sessionOf(f, worker.id, 'worker'),
  );

const message = (f: Fixture, lead: Session, text: string) =>
  f.call<SessionTurn>(
    'task.message',
    { project_id: f.project.id, task_id: 'a', text },
    null,
    sessionOf(f, lead.id, 'lead'),
  );

/** The worker asks and the lead answers in turn, each a turn the daemon queues. */
async function roundTrips(f: Fixture, lead: Session, worker: Session, count: number) {
  for (let i = 0; i < count; i++)
    if (i % 2 === 0) {
      report(f, worker, 'requirement', `Which delimiter, question ${i}?`);
      await settle(f, lead);
    } else {
      message(f, lead, `Use a comma, answer ${i}`);
      await settle(f, worker);
    }
}

/** A gate result of the commit under the session's current gate commands. */
function gateChecked(f: Fixture, sessionId: string, commit: string, exit_code: number) {
  const session = current(f, sessionId);
  const commands = gateCommands(
    contextOf(f),
    f.store.must<Project>('projects', f.project.id),
    f.store.must<Workspace>('workspaces', session.workspace_id!),
    session,
  );
  return f.store.event('session.gate_checked', session, f.project.id, {
    commit,
    check_spec_hash: hash(commands),
    results: [{ name: 'pnpm test', exit_code, timed_out: false }],
  });
}

/** Gives the stored turn the causal depth, as if a turn of that depth queued it. */
function deepen(f: Fixture, turnId: string, causal_depth: number) {
  const turn = f.store.must<SessionTurn>('session_turns', turnId);
  f.store.update<SessionTurn>('session_turns', { ...turn, causal_depth }, turn.revision);
}

const depths = (f: Fixture, sessionId: string) =>
  f.turns(sessionId).map((turn) => turn.causal_depth ?? 0);

const activityOf = (f: Fixture, taskId: string) =>
  f.control.boardView(user, f.project.id, 1).tasks.find((each) => each.id === taskId)?.activity;

it('finds the verified progress of a task in a merge, a new commit passing its gate and an accepted done report', async () => {
  const f = workbenchFixture();
  const { lead, worker } = await leadAndWorker(f, [
    task('a'),
    task('r', { done_when: 'report', scope: [], acceptance: [] }),
  ]);
  const ctx = contextOf(f),
    a = current(f, worker.id).task!;
  const gate = (commit: string, exit_code: number) => gateChecked(f, worker.id, commit, exit_code);
  expect(verifiedProgress(ctx, a)).toBeUndefined();
  gate('first', 1);
  expect(verifiedProgress(ctx, a)).toBeUndefined();
  const passed = gate('first', 0);
  gate('first', 0);
  expect(verifiedProgress(ctx, a)?.sequence).toBe(passed.sequence);
  const merged = f.store.event('session.merged', current(f, worker.id), f.project.id, {
    to_sha: 'abc',
  });
  expect(verifiedProgress(ctx, a)?.sequence).toBe(merged.sequence);

  const reporter = f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Report on it',
    task_id: `${lead.id}:r`,
  });
  await settle(f, reporter);
  const r = current(f, reporter.id).task!;
  report(f, reporter, 'done', 'The export format is CSV');
  expect(verifiedProgress(ctx, r)).toBeUndefined();
  f.call(
    'task.accept',
    { project_id: f.project.id, task_id: 'r', evidence: 'The report names the format' },
    null,
    sessionOf(f, lead.id, 'lead'),
  );
  const accepted = f.store.kindEvents(f.project.id, ['task.accepted']).at(-1)!;
  expect(verifiedProgress(ctx, r)?.sequence).toBe(accepted.sequence);
  expect(chainDepth(ctx, f.turns(reporter.id).at(-1), r)).toBe(0);
});

it('counts ten round trips between a lead and a task session, and ends the chain when the lead accepts the task', async () => {
  const f = workbenchFixture();
  const { lead, worker } = await leadAndWorker(f, [
    task('a', { done_when: 'report', scope: [], acceptance: [] }),
  ]);

  await roundTrips(f, lead, worker, 10);
  expect(f.turns(worker.id).at(-1)!.causal_depth).toBe(10);
  expect(depths(f, worker.id)).toEqual([0, 2, 4, 6, 8, 10]);
  expect(depths(f, lead.id)).toEqual([0, 1, 3, 5, 7, 9]);
  expect(activityOf(f, `${lead.id}:a`)?.causal_depth).toBe(10);

  report(f, worker, 'done', 'The delimiter is a comma');
  await settle(f, lead);
  expect(f.turns(lead.id).at(-1)!.causal_depth).toBe(11);
  f.call(
    'task.accept',
    { project_id: f.project.id, task_id: 'a', evidence: 'The report answers it' },
    null,
    sessionOf(f, lead.id, 'lead'),
  );
  // An accepted task takes no more messages; its chain is closed by the verified progress.
  expect(() => message(f, lead, 'Also write it down')).toThrow(
    expect.objectContaining({ code: 'task_accepted' }),
  );
  expect(nextDepth(contextOf(f), worker.id, { lead_session_id: lead.id, id: 'a' })).toBe(1);
});

it('starts a new chain when a task session merges', async () => {
  const f = workbenchFixture();
  const { lead, worker } = await leadAndWorker(f, [task('a')]);
  await roundTrips(f, lead, worker, 3);
  expect(f.turns(lead.id).at(-1)!.causal_depth).toBe(3);

  let skew = 0;
  vi.spyOn(f.store, 'now').mockImplementation(() => Date.now() + skew);
  const merged = current(f, worker.id);
  f.store.update<Session>(
    'sessions',
    { ...merged, state: 'closed', outcome: 'merged' },
    merged.revision,
  );
  await f.control.tick();
  skew += 30_000;
  await f.control.tick();
  const wake = f.turns(lead.id).at(-1)!;
  expect(wake.input).toContain('merged');
  expect(wake.causal_depth).toBe(1);
});

it('leaves the causal depth off the turns a person sends', async () => {
  const f = workbenchFixture();
  const { lead, worker } = await leadAndWorker(f, [task('a')]);
  await roundTrips(f, lead, worker, 2);
  const sent = f.call<SessionTurn>(
    'session.send',
    { session_id: worker.id, input: 'Use a semicolon instead' },
    current(f, worker.id).revision,
  );
  expect(sent.causal_depth).toBeUndefined();
  await settle(f, worker);
  expect(activityOf(f, `${lead.id}:a`)).not.toHaveProperty('causal_depth');
  expect(f.turns(lead.id)[0]!.causal_depth).toBeUndefined();
});

it('counts a gate pass as verified progress only under the acceptance the task has now', async () => {
  const f = workbenchFixture();
  const { lead, worker } = await leadAndWorker(f, [task('a')]);
  await roundTrips(f, lead, worker, 2);
  const ctx = contextOf(f),
    turn = f.turns(worker.id).at(-1)!;
  expect(chainDepth(ctx, turn, current(f, worker.id).task)).toBe(2);
  gateChecked(f, worker.id, 'first', 0);
  expect(chainDepth(ctx, turn, current(f, worker.id).task)).toBe(0);

  writePlan(f, lead, [task('a', { acceptance: ['pnpm test:unit'] })]);
  expect(verifiedProgress(ctx, current(f, worker.id).task!)).toBeUndefined();
  expect(chainDepth(ctx, turn, current(f, worker.id).task)).toBe(2);
});

it('wakes the lead one deeper than the turn a note came from, not the newest turn of its session', async () => {
  const f = workbenchFixture();
  const { lead, worker } = await leadAndWorker(f, [task('a')]);
  await roundTrips(f, lead, worker, 8);
  expect(f.turns(worker.id).at(-1)!.causal_depth).toBe(8);
  report(f, worker, 'risk', 'A value may contain the delimiter');

  const sent = f.call<SessionTurn>(
    'session.send',
    { session_id: worker.id, input: 'Run the tests as well' },
    current(f, worker.id).revision,
  );
  deepen(f, sent.id, 2);
  await settle(f, worker);
  report(f, worker, 'requirement', 'Which quote character?');
  await settle(f, lead);
  expect(f.turns(lead.id).at(-1)!.causal_depth).toBe(9);
});

it('opens a task that waited for a place one deeper than the lead turn that asked for it', async () => {
  const f = workbenchFixture();
  const { lead } = await leadAndWorker(f, [task('a'), task('b'), task('c'), task('d')]);
  const others = ['b', 'c'].map((id) =>
    f.call<Session>('session.create', {
      project_id: f.project.id,
      runtime: f.adapter.name,
      input: 'Build it',
      task_id: `${lead.id}:${id}`,
    }),
  );
  for (const other of others) await settle(f, other);
  deepen(f, f.turns(lead.id).at(-1)!.id, 8);
  f.call(
    'task.start',
    { project_id: f.project.id, task_ids: ['d'] },
    null,
    sessionOf(f, lead.id, 'lead'),
  );
  await f.control.tick();
  const opened = () =>
    f.store
      .list<Session>('sessions')
      .filter((session) => session.task?.lead_session_id === lead.id && session.task.id === 'd');
  expect(opened()).toEqual([]);

  const sent = f.call<SessionTurn>(
    'session.send',
    { session_id: lead.id, input: 'How is the export going?' },
    current(f, lead.id).revision,
  );
  deepen(f, sent.id, 1);
  await settle(f, lead);
  const freed = current(f, others[0]!.id);
  f.store.update<Session>(
    'sessions',
    { ...freed, state: 'closed', outcome: 'discarded' },
    freed.revision,
  );
  await f.control.tick();
  expect(opened()).toHaveLength(1);
  expect(f.turns(opened()[0]!.id)[0]!.causal_depth).toBe(9);
});
