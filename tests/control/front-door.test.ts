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

const leadOf = (f: Fixture, sessionId: string): Principal => ({
  id: `session:${sessionId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});

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

it('sends a request without a target to the assistant even when the triage plan is newest', async () => {
  const f = await workbenchFixture();
  const assistant = f.call<Session>('resident.open', {
    project_id: f.project.id,
    kind: 'assistant',
  });
  const triage = f.call<Session>('resident.open', { project_id: f.project.id, kind: 'triage' });
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Triage the inbox',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    leadOf(f, triage.id),
  );

  const routed = request(f, { input: 'Add an export button' });

  expect(routed.session_id).toBe(assistant.id);
  const turn = f.turns(assistant.id).find((each) => each.id === routed.turn_id);
  expect(turn).toMatchObject({ input: 'Add an export button', kind: 'send' });
  expect(f.turns(triage.id)).toEqual([]);
});

it('opens the assistant session when the project has none open', async () => {
  const f = await workbenchFixture();
  expect(assistants(f)).toEqual([]);

  const routed = request(f, { input: 'Plan the release', target: { kind: 'assistant' } });

  expect(assistants(f).map((session) => session.id)).toEqual([routed.session_id]);
  expect(f.turns(routed.session_id).map((turn) => turn.id)).toEqual([routed.turn_id]);
});

it('steers the assistant while its turn runs', async () => {
  const f = await workbenchFixture();
  const first = request(f, { input: 'Plan the release' });
  expect(current(f, first.session_id).state).toBe('running');

  const second = request(f, { input: 'Keep it small' });

  expect(second.session_id).toBe(first.session_id);
  expect(f.turns(first.session_id).find((turn) => turn.id === second.turn_id)?.kind).toBe('steer');
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

it("sends a personal agent's request to the assistant as the user's request, marked with its key", async () => {
  const f = await workbenchFixture();
  const routed = f.call<Routed>(
    'request.send',
    { project_id: f.project.id, input: 'Plan the release' },
    null,
    personal,
  );

  expect(assistants(f).map((session) => session.id)).toEqual([routed.session_id]);
  const turn = f.turns(routed.session_id).find((each) => each.id === routed.turn_id);
  expect(turn).toMatchObject({
    input: 'Plan the release',
    kind: 'send',
    via: { kind: 'personal', key_id: 'k1' },
  });
  expect(turn?.origin).toBeUndefined();
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
      const routed = f.call<Routed>(
        'request.send',
        { project_id: f.project.id, input: 'Plan the release' },
        null,
        personal,
      );
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
