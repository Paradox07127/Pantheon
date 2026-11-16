import { expect, it, vi } from 'vitest';
import type {
  BackgroundTask,
  BoardPlan,
  HarnessAdapter,
  LeadNote,
  Principal,
  Session,
} from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, settle, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = ReturnType<typeof workbenchFixture>;
type PlanTask = BoardPlan['tasks'][number];

const MINUTE = 60_000;

const sessionOf = (f: Fixture, sessionId: string, role: 'lead' | 'worker'): Principal => ({
  id: `session:${sessionId}`,
  role,
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60 * MINUTE,
});

const task = (id: string): PlanTask => ({
  id,
  title: `Task ${id}`,
  goal: `Finish task ${id}`,
  lane: 'core',
  depends_on: [],
  source: ['Plan the export feature'],
  scope: [`src/${id}`],
  acceptance: ['pnpm test'],
});

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);

const notes = (f: Fixture, leadId: string, kind: LeadNote['kind']) =>
  f.store
    .kindEvents(f.project.id, ['lead.note_added'])
    .filter((event) => event.aggregate_id === leadId)
    .map((event) => event.payload as LeadNote)
    .filter((note) => note.kind === kind);

/** Runs the store clock ahead of the wall clock; returns how to move it further. */
function skewedClock(f: Fixture) {
  let skew = 0;
  vi.spyOn(f.store, 'now').mockImplementation(() => Date.now() + skew);
  return (ms: number) => {
    skew += ms;
  };
}

/** Records the background list the runtime of the session reports. */
function reportBackground(f: Fixture, sessionId: string, tasks: BackgroundTask[]) {
  f.store.event('agent.background.changed', current(f, sessionId), f.project.id, {
    kind: 'background.changed',
    tasks,
  });
}

const devServer = (f: Fixture): BackgroundTask => ({
  id: 'dev-server',
  kind: 'shell',
  description: 'pnpm dev',
  started_at: f.store.now(),
});

async function leadWithPlan(f: Fixture, tasks: PlanTask[]) {
  const lead = f.create('Plan the export feature');
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

/** A task session whose first turn runs for longer than the test. */
async function runningWorker(f: Fixture, leadId: string) {
  (f.adapter as { delay: number }).delay = 60000;
  const worker = f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Build it',
    task_id: `${leadId}:a`,
  });
  await awaitWorkspaceReady(f.control, worker.workspace_id!);
  await eventually(
    () => f.turns(worker.id)[0]?.state === 'running',
    () => f.control.tick(),
  );
  return worker;
}

/** Records the stops the runtime is asked for. */
function stopsOf(f: Fixture) {
  const stops: string[] = [];
  (f.adapter as HarnessAdapter).stopBackground = vi.fn(async (_handle, taskId: string) => {
    stops.push(taskId);
  });
  return stops;
}

it('tells the lead once when a background task of a task session runs for thirty minutes', async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const advance = skewedClock(f);
  const worker = await runningWorker(f, lead.id);
  reportBackground(f, worker.id, [devServer(f)]);

  advance(29 * MINUTE);
  await f.control.tick();
  expect(notes(f, lead.id, 'background_long')).toEqual([]);
  advance(2 * MINUTE);
  await f.control.tick();
  await f.control.tick();
  const told = notes(f, lead.id, 'background_long');
  expect(told).toEqual([expect.objectContaining({ session_id: worker.id, task_id: 'a' })]);
  expect(told[0]!.text).toBe(
    'The background command "pnpm dev" (background_id dev-server) of the session has run for 31 minutes. Stop it with stop_background, or wait for it.',
  );
});

it('lists a long background task of a user session in needs-you and stops it through the runtime', async () => {
  const f = workbenchFixture({ delay: 60000 });
  const advance = skewedClock(f);
  const stops = stopsOf(f);
  const session = f.create('Start the dev server');
  await eventually(
    () => f.turns(session.id)[0]?.state === 'running',
    () => f.control.tick(),
  );
  reportBackground(f, session.id, [devServer(f)]);
  const items = () =>
    f.control
      .needsYou(user, f.project.id)
      .items.filter((item) => item.reason === 'background_task_long');

  advance(29 * MINUTE);
  expect(items()).toEqual([]);
  advance(2 * MINUTE);
  expect(items()).toEqual([
    expect.objectContaining({
      source: expect.objectContaining({ table: 'sessions', id: session.id }),
      background: expect.objectContaining({ id: 'dev-server', description: 'pnpm dev' }),
      actions: [{ command: 'session.background.stop', allowed: true }],
      next_step: expect.any(String),
    }),
  ]);
  f.call('session.background.stop', { session_id: session.id, background_id: 'dev-server' });
  await eventually(() => stops.length > 0);
  expect(stops).toEqual(['dev-server']);
});

it('stops a background task of a task in the calling lead plan and refuses one of another lead', async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const other = await leadWithPlan(f, [task('a')]);
  const stops = stopsOf(f);
  const worker = await runningWorker(f, lead.id);
  reportBackground(f, worker.id, [devServer(f)]);
  const stop = (leadId: string) =>
    f.call(
      'task.background.stop',
      { project_id: f.project.id, task_id: 'a', background_id: 'dev-server' },
      null,
      sessionOf(f, leadId, 'lead'),
    );

  expect(() => stop(other.id)).toThrow('Task a has no background task dev-server');
  expect(stop(lead.id)).toMatchObject({ task_id: 'a', session_id: worker.id });
  await eventually(() => stops.length > 0);
  expect(stops).toEqual(['dev-server']);
});

it('does not call a turn stalled while background tasks keep it open', async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const advance = skewedClock(f);
  const worker = await runningWorker(f, lead.id);
  reportBackground(f, worker.id, [devServer(f)]);

  advance(11 * MINUTE);
  await f.control.tick();
  expect(notes(f, lead.id, 'stalled')).toEqual([]);
  reportBackground(f, worker.id, []);
  advance(11 * MINUTE);
  await f.control.tick();
  expect(notes(f, lead.id, 'stalled')).toHaveLength(1);
});
