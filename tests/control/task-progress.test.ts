import { expect, it } from 'vitest';
import {
  id,
  type BoardPlan,
  type Principal,
  type Session,
  type SessionTurn,
} from '@pantheon/domain';
import { awaitWorkspaceReady, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const MINUTE = 60 * 1000,
  HOUR = 60 * MINUTE,
  DAY = 24 * HOUR;

const dayKey = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** The same local time `days` calendar days earlier. */
const daysBack = (at: number, days: number) => {
  const d = new Date(at);
  d.setDate(d.getDate() - days);
  return d.getTime();
};

const leadOf = (f: Fixture, leadId: string): Principal => ({
  id: `session:${leadId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: leadId,
  expires_at: f.store.now() + 60000,
});

function writePlan(f: Fixture, leadId: string, tasks: { id: string; depends_on?: string[] }[]) {
  // A plan task must quote a message the lead received.
  f.store.insert<SessionTurn>('session_turns', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    session_id: leadId,
    input: 'Ship the work',
    kind: 'send',
    delivery: 'delivered',
    state: 'completed',
  });
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: f.store.get<BoardPlan>('board_plans', leadId)?.plan_version ?? 0,
      headline: 'Ship the work',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: tasks.map((task) => ({
        id: task.id,
        title: `Task ${task.id}`,
        goal: `Finish ${task.id}`,
        lane: 'core',
        depends_on: task.depends_on ?? [],
        source: ['Ship the work'],
        scope: [`src/${task.id}`],
        acceptance: ['pnpm test'],
      })),
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    leadOf(f, leadId),
  );
  return f.store.db
    .prepare("SELECT max(sequence) AS sequence FROM events WHERE kind='board.plan_updated'")
    .get() as { sequence: number };
}

const planAt = (f: Fixture, sequence: number, at: number) =>
  f.store.db.prepare('UPDATE events SET created_at=? WHERE sequence=?').run(at, sequence);

async function openTask(f: Fixture, leadId: string, taskId: string, openedAt: number) {
  const session = await f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: `Work on ${taskId}`,
    task_id: `${leadId}:${taskId}`,
  });
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  f.store.db
    .prepare('UPDATE events SET created_at=? WHERE aggregate_id=?')
    .run(openedAt, session.id);
  return session;
}

function end(f: Fixture, sessionId: string, outcome: 'merged' | 'discarded', at: number) {
  const session = f.store.must<Session>('sessions', sessionId);
  f.store.update<Session>('sessions', { ...session, state: 'closed', outcome }, session.revision);
  if (outcome !== 'merged') return;
  const event = f.store.event('session.merged', session, f.project.id, {
    to_sha: '0'.repeat(40),
    additions: 1,
    deletions: 0,
  });
  f.store.db.prepare('UPDATE events SET created_at=? WHERE sequence=?').run(at, event.sequence);
}

it('counts a task once however many sessions it has and leaves out tasks removed from the plan', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the work');
  const now = Date.now(),
    yesterday = daysBack(now, 1),
    midnight = new Date(now).setHours(0, 0, 0, 0),
    // A time of today before now, as a share of the day so far.
    today = (share: number) => midnight + Math.round((now - midnight) * share);
  const first = writePlan(f, lead.id, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  planAt(f, first.sequence, yesterday);

  const firstTry = await openTask(f, lead.id, 'a', today(0.1));
  end(f, firstTry.id, 'merged', today(0.4));
  await openTask(f, lead.id, 'a', today(0.5));
  const removed = await openTask(f, lead.id, 'b', today(0.1));
  end(f, removed.id, 'merged', today(0.3));
  writePlan(f, lead.id, [{ id: 'a' }, { id: 'c' }]);

  const { task_progress: progress } = f.control.boardView(user, f.project.id, 7);
  // The retry opened after the first merge keeps the task open, as its row shows: running while
  // the retry's fixture turn lasts, idle once it ends.
  const { running, idle, ...settled } = progress.totals;
  expect(running + idle).toBe(1);
  expect(settled).toEqual({
    done: 0,
    waiting: 0,
    ready: 0,
    failed: 0,
    discarded: 0,
    not_started: 1,
  });
  expect(progress.daily).toHaveLength(7);
  expect(progress.daily.slice(0, 5)).toEqual(
    progress.daily
      .slice(0, 5)
      .map((point) => ({ day: point.day, scope: 0, done: 0, added: 0, removed: 0 })),
  );
  expect(progress.daily.slice(5)).toEqual([
    { day: dayKey(yesterday), scope: 3, done: 0, added: 3, removed: 0 },
    // The open retry keeps the first task from counting as done, as on its row.
    { day: dayKey(now), scope: 2, done: 0, added: 0, removed: 1 },
  ]);
  // The retry of the first task does not restart its cycle; the removed task is not a sample.
  expect(progress.cycle).toMatchObject({
    median_ms: today(0.4) - today(0.1),
    p90_ms: today(0.4) - today(0.1),
    sample_count: 1,
  });
});

it('takes cycle quantiles by nearest rank and counts done tasks outside the range in totals', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the work');
  writePlan(f, lead.id, [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'old' }, { id: 'open' }]);
  const now = Date.now(),
    mergedAt = now - HOUR;
  for (const [taskId, minutes] of [
    ['a', 10],
    ['b', 20],
    ['c', 30],
  ] as const) {
    const session = await openTask(f, lead.id, taskId, mergedAt - minutes * MINUTE);
    end(f, session.id, 'merged', mergedAt);
  }
  const old = await openTask(f, lead.id, 'old', daysBack(now, 11));
  end(f, old.id, 'merged', daysBack(now, 10));
  const open = await openTask(f, lead.id, 'open', now - HOUR);
  end(f, open.id, 'discarded', now);

  const { task_progress: progress } = f.control.boardView(user, f.project.id, 7);
  expect(progress.totals).toMatchObject({ done: 4, discarded: 1, not_started: 0 });
  expect(progress.cycle).toEqual({
    median_ms: 20 * MINUTE,
    p90_ms: 30 * MINUTE,
    sample_count: 3,
    buckets: [
      { upper_ms: 15 * MINUTE, count: 1 },
      { upper_ms: 30 * MINUTE, count: 2 },
      { upper_ms: HOUR, count: 0 },
      { upper_ms: 2 * HOUR, count: 0 },
      { upper_ms: 4 * HOUR, count: 0 },
      { upper_ms: 8 * HOUR, count: 0 },
      { upper_ms: DAY, count: 0 },
      { upper_ms: null, count: 0 },
    ],
  });
});

it('leaves scope unknown on days before the plan history that is kept', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the work');
  const now = Date.now();
  const first = writePlan(f, lead.id, [{ id: 'a' }]);
  planAt(f, first.sequence, daysBack(now, 3));
  const second = writePlan(f, lead.id, [{ id: 'a' }, { id: 'b' }]);
  planAt(f, second.sequence, daysBack(now, 1));
  f.store.pruneEvents(second.sequence);

  const { task_progress: progress } = f.control.boardView(user, f.project.id, 4);
  expect(progress.daily).toEqual([
    { day: dayKey(daysBack(now, 3)), scope: null, done: 0, added: null, removed: null },
    { day: dayKey(daysBack(now, 2)), scope: null, done: 0, added: null, removed: null },
    { day: dayKey(daysBack(now, 1)), scope: 2, done: 0, added: null, removed: null },
    { day: dayKey(now), scope: 2, done: 0, added: 0, removed: 0 },
  ]);
});

it('marks a task blocked while an upstream task is not done and reports its newest progress', async () => {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the work');
  const plan = writePlan(f, lead.id, [{ id: 'a' }, { id: 'b', depends_on: ['a'] }]);
  const planned = (
    f.store.db.prepare('SELECT created_at FROM events WHERE sequence=?').get(plan.sequence) as {
      created_at: number;
    }
  ).created_at;
  const task = (taskId: string) =>
    f.control
      .boardView(user, f.project.id, 1)
      .tasks.find((candidate) => candidate.id === `${lead.id}:${taskId}`)!;
  expect(task('a')).toMatchObject({
    blocked_since: null,
    last_progress_at: null,
    turn_running: false,
  });
  expect(task('b')).toMatchObject({ blocked_since: planned, last_progress_at: null });

  const upstream = await openTask(f, lead.id, 'a', Date.now());
  const gated = f.store.event('session.gate_checked', upstream, f.project.id, { results: [] }),
    checkedAt = Date.now() + HOUR;
  f.store.db
    .prepare('UPDATE events SET created_at=? WHERE sequence=?')
    .run(checkedAt, gated.sequence);
  expect(task('a').last_progress_at).toBe(checkedAt);
  expect(task('b').blocked_since).toBe(planned);

  end(f, upstream.id, 'merged', Date.now());
  expect(task('b').blocked_since).toBeNull();
});
