import { expect, it, vi } from 'vitest';
import type { AgentEvent, Session, Timer } from '@pantheon/domain';
import { settle, user } from '../helpers.js';
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

/** Ends the next delivered turn as failed, the way an adapter reports it. */
function failNextTurn(
  f: Fixture,
  fields: Partial<Extract<AgentEvent, { kind: 'turn.completed' }>>,
) {
  // start opens through resume, so its calls hold the sink of every native session.
  const resume = vi.spyOn(f.adapter, 'resume');
  vi.spyOn(f.adapter, 'send').mockImplementationOnce(async (handle, turn) => {
    const [, , emit] = resume.mock.calls.findLast(
      ([spec]) => spec.platform_session_id === handle.platform_session_id,
    )!;
    setTimeout(() =>
      emit({
        key: `failed:${turn.turn_id}`,
        provider_sequence: 1000,
        turn_id: turn.turn_id,
        kind: 'turn.completed',
        status: 'failed',
        error: 'Turn failed',
        ...fields,
      }),
    );
    return { turn_id: turn.turn_id, status: 'delivered' };
  });
}

const usageLimit = (resets_at?: number) => ({
  error: 'Usage limit reached',
  error_code: 'usage_limit',
  ...(resets_at === undefined ? {} : { resets_at }),
});

it('leaves a session a person drives failed after a usage-limit failure', async () => {
  const f = await workbenchFixture();
  const advance = skewedClock(f);
  failNextTurn(f, usageLimit(f.store.now() + MINUTE));
  const session = await f.create();
  await settle(f, session);
  expect(f.store.list<Timer>('timers')).toEqual([]);
  advance(10 * MINUTE);
  await f.control.tick();
  expect(f.turns(session.id)).toMatchObject([{ state: 'failed' }]);
  expect(current(f, session.id).state).toBe('open');
});

it('lists a session a person drives that hit its usage limit in needs-you until a new turn runs', async () => {
  const f = await workbenchFixture();
  skewedClock(f);
  const resetsAt = f.store.now() + 2 * 60 * MINUTE;
  failNextTurn(f, usageLimit(resetsAt));
  const session = await f.create();
  await settle(f, session);
  const reached = () =>
    f.control
      .needsYou(user, f.project.id)
      .items.filter((item) => item.reason === 'usage_limit_reached');

  expect(reached()).toMatchObject([
    {
      source: { table: 'sessions', id: session.id },
      kind: 'session.failed',
      decision: 'other',
      resets_at: resetsAt,
      primary: 'session.send',
      actions: [{ command: 'session.send', allowed: true }],
      next_step: 'Continue the session after the limit resets, or fork it to another runtime.',
    },
  ]);
  f.call(
    'session.send',
    { session_id: session.id, input: 'Try again' },
    current(f, session.id).revision,
  );
  await settle(f, session);
  expect(f.turns(session.id)).toMatchObject([{ state: 'failed' }, { state: 'completed' }]);
  expect(reached()).toEqual([]);
});
