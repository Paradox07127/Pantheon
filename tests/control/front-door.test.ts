import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { id, type Principal, type Project, type Session } from '@pantheon/domain';
import { eventually } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
type Routed = { session_id: string; turn_id: string };

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);

const request = (f: Fixture, input: Record<string, unknown>) =>
  f.call<Routed>('request.send', { project_id: f.project.id, ...input });

const personal: Principal = { id: 'personal:k1', role: 'personal' };

const assistants = (f: Fixture) =>
  f.store.list<Session>('sessions').filter((session) => session.resident?.kind === 'assistant');

/** Waits until the session takes input again with no turn left to run. */
const idle = (f: Fixture, sessionId: string) =>
  eventually(
    () =>
      current(f, sessionId).state === 'open' &&
      f.turns(sessionId).every((turn) => !['queued', 'running'].includes(turn.state)),
    () => f.control.tick(),
  );

it.each([
  ['no target', {}],
  ['the assistant as target', { target: { kind: 'assistant' } }],
])('refuses a request with %s and opens no assistant', async (_case, target) => {
  const f = await workbenchFixture();

  expect(() => request(f, { input: 'Plan the release', ...target })).toThrow(
    expect.objectContaining({ code: 'invalid_request' }),
  );
  expect(assistants(f)).toEqual([]);
});

it('sends a request with a session target to that direct session', async () => {
  const f = await workbenchFixture();
  const direct = await f.create('Explain the answer file');
  await idle(f, direct.id);

  const routed = request(f, {
    input: 'Now rename it',
    target: { kind: 'session', session_id: direct.id },
  });

  expect(routed.session_id).toBe(direct.id);
  expect(f.turns(direct.id).find((turn) => turn.id === routed.turn_id)?.input).toBe(
    'Now rename it',
  );
  expect(assistants(f)).toEqual([]);
});

it('refuses an archived session and a session of another project', async () => {
  const f = await workbenchFixture();
  const direct = await f.create('Explain the answer file');
  await idle(f, direct.id);
  const done = current(f, direct.id);
  f.store.update<Session>(
    'sessions',
    { ...done, archived_at: new Date(f.store.now()).toISOString() },
    done.revision,
  );

  expect(() =>
    request(f, { input: 'Once more', target: { kind: 'session', session_id: direct.id } }),
  ).toThrow(expect.objectContaining({ code: 'invalid_state' }));
  expect(current(f, direct.id).archived_at).toBeDefined();

  const otherRoot = path.join(f.root, 'other');
  mkdirSync(otherRoot);
  const other = await f.call<Promise<Project>>('project.open', {
    name: 'Other',
    roots: [otherRoot],
  });
  const foreign = f.store.insert<Session>('sessions', {
    id: id(),
    revision: 1,
    project_id: other.id,
    runtime: f.adapter.name,
    state: 'open',
    turn_count: 0,
  });

  expect(() =>
    request(f, { input: 'Over there', target: { kind: 'session', session_id: foreign.id } }),
  ).toThrow(expect.objectContaining({ code: 'permission_denied' }));
  expect(f.turns(foreign.id)).toEqual([]);
});

it.each<[string, (f: Fixture, sessionId: string) => () => unknown]>([
  [
    'a request to a session',
    (f, sessionId) => () =>
      f.call(
        'request.send',
        {
          project_id: f.project.id,
          input: 'Now rename it',
          target: { kind: 'session', session_id: sessionId },
        },
        null,
        personal,
      ),
  ],
  [
    'a reroute of its request',
    (f) => {
      const assistant = f.call<Session>('resident.open', {
        project_id: f.project.id,
        kind: 'assistant',
      });
      const routed = request(f, {
        input: 'Plan the release',
        target: { kind: 'session', session_id: assistant.id },
      });
      return () =>
        f.call('request.reroute', { turn_id: routed.turn_id, to: 'new_plan' }, null, personal);
    },
  ],
])('refuses a personal agent %s', async (_case, attempt) => {
  const f = await workbenchFixture();
  const direct = await f.create('Explain the answer file');
  await idle(f, direct.id);
  const send = attempt(f, direct.id),
    before = f.store.list<Session>('sessions').map((session) => f.turns(session.id).length);

  expect(send).toThrow(expect.objectContaining({ code: 'permission_denied' }));
  expect(f.store.list<Session>('sessions').map((session) => f.turns(session.id).length)).toEqual(
    before,
  );
});
