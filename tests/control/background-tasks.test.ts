import { expect, it, vi } from 'vitest';
import type { BackgroundTask, HarnessAdapter, Session } from '@pantheon/domain';
import { eventually, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const MINUTE = 60_000;

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);

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

/** Records the stops the runtime is asked for. */
function stopsOf(f: Fixture) {
  const stops: string[] = [];
  (f.adapter as HarnessAdapter).stopBackground = vi.fn(async (_handle, taskId: string) => {
    stops.push(taskId);
  });
  return stops;
}

it('lists a long background task of a user session in needs-you and stops it through the runtime', async () => {
  const f = await workbenchFixture({ delay: 60000 });
  const advance = skewedClock(f);
  const stops = stopsOf(f);
  const session = await f.create('Start the dev server');
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

it('does not call a turn stalled while background tasks keep it open', async () => {
  const f = await workbenchFixture({ delay: 60000 });
  const advance = skewedClock(f);
  const session = await f.create('Start the dev server');
  await eventually(
    () => f.turns(session.id)[0]?.state === 'running',
    () => f.control.tick(),
  );
  reportBackground(f, session.id, [devServer(f)]);
  const stalled = () =>
    f.control
      .needsYou(user, f.project.id)
      .items.filter((item) => item.reason === 'session_turn_stalled');

  advance(11 * MINUTE);
  expect(stalled()).toEqual([]);
  reportBackground(f, session.id, []);
  advance(11 * MINUTE);
  expect(stalled()).toMatchObject([{ source: { table: 'sessions', id: session.id } }]);
});
