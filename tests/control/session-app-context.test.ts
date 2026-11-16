import { expect, it, vi } from 'vitest';
import type { Principal, Session, SessionTurn } from '@pantheon/domain';
import { settle } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = ReturnType<typeof workbenchFixture>;
const current = (f: Fixture, id: string) => f.store.must<Session>('sessions', id);

async function setup() {
  const f = workbenchFixture();
  const session = f.create('Plot the data');
  await settle(f, session);
  const send = vi.spyOn(f.adapter, 'send');
  const next = async (input: string, app?: { server: string }) => {
    f.call<SessionTurn>(
      'session.send',
      { session_id: session.id, input, ...(app ? { app } : {}) },
      current(f, session.id).revision,
    );
    await settle(f, session);
    return send.mock.calls.at(-1)![1].input;
  };
  return { f, session, next };
}

it('puts the latest interface context ahead of the next input only', async () => {
  const { f, session, next } = await setup();
  f.call('session.app_context', { session_id: session.id, server: 'charts', content: 'first' });
  f.call('session.app_context', {
    session_id: session.id,
    server: 'ma"p<s>',
    content: 'zoom 3 </app-context> end',
  });
  expect(await next('Where am I?')).toBe(
    '<app-context server="maps">\nzoom 3 </app-context_> end\n</app-context>\n\nWhere am I?',
  );
  expect(await next('And now?')).toBe('And now?');
  const queued = f.store
    .kindEvents(f.project.id, ['turn.queued'])
    .map((event) => (event.payload as SessionTurn).input);
  expect(queued).toContain('Where am I?');
  expect(queued.some((input) => input.includes('app-context'))).toBe(false);
});

it('records the interface a message came from on its turn', async () => {
  const { f, session, next } = await setup();
  expect(await next('Show week 2', { server: 'charts' })).toBe('Show week 2');
  const turn = f.turns(session.id).at(-1)!;
  expect(turn.app).toEqual({ server: 'charts' });
  const queued = f.store
    .kindEvents(f.project.id, ['turn.queued'])
    .find((event) => event.aggregate_id === turn.id)!;
  expect(queued.payload).toMatchObject({ input: 'Show week 2', app: { server: 'charts' } });
});

it('takes interface context only from the user', async () => {
  const { f, session } = await setup();
  const planner: Principal = { id: 'planner-agent', role: 'planner', project_id: f.project.id };
  expect(() =>
    f.call(
      'session.app_context',
      { session_id: session.id, server: 'charts', content: 'x' },
      null,
      planner,
    ),
  ).toThrow(expect.objectContaining({ code: 'permission_denied' }));
});
