import { expect, it, vi } from 'vitest';
import { id, type Session } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { notifySession } from '../../packages/control/dist/session-wake.js';
import { settle } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const ctxOf = (f: Fixture) => (f.control as unknown as { ctx: ControlContext }).ctx;
const planRows = (f: Fixture) =>
  (f.store.db.prepare('SELECT COUNT(*) AS n FROM board_plans').get() as { n: number }).n;
const sessionOf = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);

it('starts a turn of its own on an idle session without a plan', async () => {
  const f = await workbenchFixture();
  const session = await f.create('Rename the answer file');
  await settle(f, session);
  const before = f.turns(session.id).length;

  const turn = notifySession(ctxOf(f), session.id, 'The review found two issues.', 'cause-1')!;

  expect(turn).toMatchObject({ origin: 'tracker', input: 'The review found two issues.' });
  expect(f.turns(session.id)).toHaveLength(before + 1);
  expect(sessionOf(f, session.id).state).toBe('running');
  const jobs = f.store.db.prepare("SELECT payload FROM outbox WHERE kind='session.turn'").all() as {
    payload: string;
  }[];
  expect(jobs.some((job) => JSON.parse(job.payload).turn_id === turn.id)).toBe(true);
  expect(planRows(f)).toBe(0);
});

it('folds a second text into the queued turn of a running session', async () => {
  const f = await workbenchFixture({ delay: 3000 });
  const session = await f.create('Rename the answer file');
  expect(sessionOf(f, session.id).state).toBe('running');
  const before = f.turns(session.id).length;

  const first = notifySession(ctxOf(f), session.id, 'The review found two issues.', 'cause-1')!;
  const second = notifySession(ctxOf(f), session.id, 'The worker finished its turn.', 'cause-2')!;

  expect(first).toMatchObject({ origin: 'tracker', state: 'queued', delivery: 'pending' });
  expect(second.id).toBe(first.id);
  const turns = f.turns(session.id);
  expect(turns).toHaveLength(before + 1);
  expect(turns.find((turn) => turn.id === first.id)!.input).toBe(
    'The review found two issues.\n\nThe worker finished its turn.',
  );
  expect(planRows(f)).toBe(0);
});

it('takes no turn for a closed session, an unknown id, or a project over its budget', async () => {
  const f = await workbenchFixture();
  const closed = await f.create('Rename the answer file');
  await settle(f, closed);
  const row = sessionOf(f, closed.id);
  f.store.update<Session>('sessions', { ...row, state: 'closed' }, row.revision);
  const closedTurns = f.turns(closed.id).length;
  expect(notifySession(ctxOf(f), closed.id, 'Hello', 'cause-1')).toBeUndefined();
  expect(f.turns(closed.id)).toHaveLength(closedTurns);

  expect(notifySession(ctxOf(f), 'no-such-session', 'Hello', 'cause-2')).toBeUndefined();

  const idle = await f.create('Explain the answer file');
  await settle(f, idle);
  let now = f.store.now();
  vi.spyOn(f.store, 'now').mockImplementation(() => now);
  f.call('workflow.policy.set', {
    project_id: f.project.id,
    project_budget: { input_tokens: 100 },
  });
  now += 1000;
  const spent = f.store.insert('session_turns', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    session_id: idle.id,
    input: 'A message',
    kind: 'send',
    delivery: 'delivered',
    state: 'completed',
    usage: { input_tokens: 150, output_tokens: 0 },
  });
  f.store.event('turn.completed', spent, f.project.id, {});
  now += 1000;
  const idleTurns = f.turns(idle.id).length;
  expect(notifySession(ctxOf(f), idle.id, 'Hello', 'cause-3')).toBeUndefined();
  expect(f.turns(idle.id)).toHaveLength(idleTurns);
  expect(planRows(f)).toBe(0);
});
