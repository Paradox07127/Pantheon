import { expect, it, vi } from 'vitest';
import { id, type Approval, type Project, type Session, type SessionTurn } from '@pantheon/domain';
import { afterSpawnedRequest } from '../../packages/control/dist/conductor.js';
import { notifySession } from '../../packages/control/dist/session-wake.js';
import { user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';
type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

function session(f: Fixture, fields: Partial<Session> = {}) {
  return f.store.insert<Session>('sessions', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    state: 'open',
    turn_count: 0,
    conductor: true,
    ...fields,
  });
}

function mark(f: Fixture, main: Session) {
  f.call('project.resident.set', { project_id: f.project.id, session_id: main.id });
  return f.store.must<Project>('projects', f.project.id).resident;
}

const wakeEvents = (f: Fixture) =>
  f.store.kindEvents(f.project.id, ['resident.woken', 'resident.wake_skipped']);

it.each([
  ['a plain session', { conductor: undefined }],
  ['another project’s conductor', { project_id: id() }],
  ['a closed conductor', { state: 'closed' }],
  ['a discarded conductor', { state: 'closed', outcome: 'discarded' }],
  ['a merged and closed conductor', { state: 'closed', outcome: 'merged' }],
  ['a missing session', null],
] as const)('refuses to register %s', async (_name, fields) => {
  const f = await workbenchFixture();
  const session_id = fields ? session(f, fields).id : id();

  expect(() => f.call('project.resident.set', { project_id: f.project.id, session_id })).toThrow(
    expect.objectContaining({ code: 'invalid_input' }),
  );
});

it('requires a user to register a resident', async () => {
  const f = await workbenchFixture();
  const main = session(f);
  expect(() =>
    f.call('project.resident.set', { project_id: f.project.id, session_id: main.id }, null, {
      id: 'agent',
      role: 'conductor',
    }),
  ).toThrow(expect.objectContaining({ code: 'permission_denied' }));
});

it('registers an existing conductor, preserves its start on reselection, and clears it', async () => {
  const f = await workbenchFixture();
  const main = session(f);
  const set = (session_id: string | null) =>
    f.call('project.resident.set', { project_id: f.project.id, session_id });
  const stored = () => f.store.must<Project>('projects', f.project.id).resident;
  const since = f.store.now();
  const clock = vi.spyOn(f.store, 'now').mockReturnValue(since);

  const revision = () => f.store.must<Project>('projects', f.project.id).revision;
  const events = () => f.store.kindEvents(f.project.id, ['project.resident_set']);
  expect(set(main.id)).toEqual({});
  expect(stored()).toEqual({ session_id: main.id, since });
  clock.mockReturnValue(since + 1);
  const marked = revision();
  expect(set(main.id)).toEqual({});
  expect(stored()?.since).toBe(since);
  expect(revision()).toBe(marked);
  expect(set(null)).toEqual({});
  expect(stored()).toBeUndefined();
  const cleared = revision();
  expect(set(null)).toEqual({});
  expect(revision()).toBe(cleared);
  expect(events().map((e) => [e.payload, e.aggregate_revision])).toEqual([
    [{ session_id: main.id }, marked],
    [{ session_id: null }, cleared],
  ]);
});

it('records queued and merged wakes with their shared turn id only for the resident', async () => {
  const f = await workbenchFixture();
  const main = session(f);
  mark(f, main);
  const notify = (target: Session, cause: string) =>
    notifySession(f.control['ctx'], target.id, cause, cause)!;
  const first = notify(main, 'review finished');
  expect(notify(main, 'landing finished').id).toBe(first.id);
  notify(session(f), 'other review');

  expect(wakeEvents(f).map((e) => [e.kind, e.payload])).toEqual(
    ['review finished', 'landing finished'].map((cause) => [
      'resident.woken',
      { session_id: main.id, turn_id: first.id, cause },
    ]),
  );
});

it.each(['budget', 'not_accepting'] as const)('records a skipped wake for %s', async (reason) => {
  const f = await workbenchFixture();
  const main = session(f, { state: reason === 'not_accepting' ? 'reconciling' : 'open' });
  mark(f, main);
  if (reason === 'budget') {
    f.call('workflow.policy.set', {
      project_id: f.project.id,
      project_budget: { input_tokens: 2 },
    });
    vi.spyOn(f.store, 'now').mockReturnValue(f.store.now() + 1);
    const spent = f.store.insert<SessionTurn>('session_turns', {
      id: id(),
      revision: 1,
      project_id: f.project.id,
      session_id: main.id,
      input: 'Review the change',
      kind: 'send',
      state: 'completed',
      delivery: 'delivered',
      usage: { input_tokens: 3, output_tokens: 0 },
    });
    f.store.event('turn.completed', spent, f.project.id, {});
  }

  expect(notifySession(f.control['ctx'], main.id, 'Review finished', 'review')).toBeUndefined();
  expect(wakeEvents(f)).toMatchObject([
    { kind: 'resident.wake_skipped', payload: { session_id: main.id, reason, cause: 'review' } },
  ]);
  if (reason === 'budget')
    expect(f.control.projectResident(user, f.project.id).budget).toEqual({
      used_input_tokens: 3,
      input_tokens: 2,
      reached_at: expect.any(Number),
    });
});

it('counts turns by origin from the moment the resident was set, within one millisecond too', async () => {
  const f = await workbenchFixture();
  const main = session(f);
  const since = f.store.now();
  // The turn before the mark starts in the same millisecond; the order alone tells them apart.
  vi.spyOn(f.store, 'now').mockReturnValue(since);
  function start(target: Session, origin?: SessionTurn['origin']) {
    const turn = f.store.insert<SessionTurn>('session_turns', {
      id: id(),
      revision: 1,
      session_id: target.id,
      project_id: target.project_id,
      input: 'Inspect the changes',
      kind: 'send',
      state: 'running',
      delivery: 'delivered',
      origin,
    });
    f.store.event('turn.running', turn, target.project_id, {});
  }
  start(main);
  mark(f, main);
  start(main);
  start(main, 'compaction');
  start(main, 'notice');
  start(main, 'tracker');
  start(session(f));
  notifySession(f.control['ctx'], main.id, 'Still queued', 'review');

  expect(f.control.projectResident(user, f.project.id)).toMatchObject({
    session_id: main.id,
    since,
    turns: { pantheon: 2, user: 1 },
    budget: null,
  });
});

it.each(['unset', 'closed', 'missing'] as const)(
  'reads an empty profile when the resident is %s',
  async (state) => {
    const f = await workbenchFixture();
    const main = session(f);
    const stored = state === 'unset' ? undefined : mark(f, main);
    if (state === 'closed')
      f.store.update<Session>('sessions', { ...main, state: 'closed' }, main.revision);
    if (state === 'missing') f.store.remove('sessions', main.id, main.revision);
    f.call('workflow.policy.set', {
      project_id: f.project.id,
      project_budget: { input_tokens: 20 },
    });

    expect(f.control.projectResident(user, f.project.id)).toEqual({
      session_id: null,
      since: null,
      turns: { pantheon: 0, user: 0 },
      budget: { input_tokens: 20, used_input_tokens: 0 },
      wakes: [],
    });
    expect(f.store.must<Project>('projects', f.project.id).resident).toEqual(stored);
  },
);

it('reads the latest twenty wakes of the resident in reverse order with turn previews', async () => {
  const f = await workbenchFixture();
  const main = session(f);
  const other = session(f);
  mark(f, main);
  const input = 'Review the parser changes. '.repeat(10);
  const turn = notifySession(f.control['ctx'], main.id, input, 'review')!;
  const expected = [];
  for (let i = 0; i < 22; i++) {
    const cause = `review update ${i}`;
    if (i % 2 === 0) {
      const event = f.store.event('resident.woken', main, f.project.id, {
        session_id: main.id,
        turn_id: turn.id,
        cause,
      });
      expected.push({
        at: event.created_at,
        kind: 'woken',
        cause,
        turn_id: turn.id,
        preview: input.slice(0, 200),
      });
    } else {
      const event = f.store.event('resident.wake_skipped', main, f.project.id, {
        session_id: main.id,
        reason: 'not_accepting',
        cause,
      });
      expected.push({ at: event.created_at, kind: 'skipped', cause, reason: 'not_accepting' });
    }
  }
  f.store.event('resident.woken', other, f.project.id, {
    session_id: other.id,
    turn_id: id(),
    cause: 'other review',
  });
  expect(f.control.projectResident(user, f.project.id).wakes).toEqual(
    expected.reverse().slice(0, 20),
  );
});

it('records each spawned request even when its notice folds into a previous request', async () => {
  const f = await workbenchFixture();
  const main = session(f, { state: 'running' });
  const spawned = session(f, { conductor: undefined, spawned_by: { session_id: main.id } });
  mark(f, main);
  const causes = [id(), id()];
  for (const cause of causes) {
    const approval = f.store.insert<Approval>('approvals', {
      id: cause,
      revision: 1,
      project_id: main.project_id,
      session_id: spawned.id,
      kind: 'permission',
      input_hash: cause,
      decider: 'user',
      state: 'pending',
      created_at: f.store.now(),
    });
    afterSpawnedRequest(f.control['ctx'], spawned.id);
    f.store.update<Approval>('approvals', { ...approval, state: 'approved' }, approval.revision);
  }

  const [turn] = f.turns(main.id);
  expect(turn!.input).toContain('waits for the user on 2 requests');
  expect(wakeEvents(f).map((e) => e.payload)).toEqual(
    causes.map((cause) => ({ session_id: main.id, turn_id: turn!.id, cause })),
  );
});

it('records a skipped wake with its own request each time a spawned request reaches an idle resident that takes no input', async () => {
  const f = await workbenchFixture();
  const main = session(f);
  const spawned = session(f, { conductor: undefined, spawned_by: { session_id: main.id } });
  mark(f, main);
  f.store.update<Session>(
    'sessions',
    { ...f.store.must<Session>('sessions', main.id), state: 'reconciling' },
    f.store.must<Session>('sessions', main.id).revision,
  );
  const cause = id();
  f.store.insert<Approval>('approvals', {
    id: cause,
    revision: 1,
    project_id: main.project_id,
    session_id: spawned.id,
    kind: 'permission',
    input_hash: cause,
    decider: 'user',
    state: 'pending',
    created_at: f.store.now(),
  });
  afterSpawnedRequest(f.control['ctx'], spawned.id);
  const second = session(f, { conductor: undefined, spawned_by: { session_id: main.id } });
  const later = id();
  vi.spyOn(f.store, 'now').mockReturnValue(f.store.now() + 1);
  f.store.insert<Approval>('approvals', {
    id: later,
    revision: 1,
    project_id: main.project_id,
    session_id: second.id,
    kind: 'permission',
    input_hash: later,
    decider: 'user',
    state: 'pending',
    created_at: f.store.now(),
  });
  afterSpawnedRequest(f.control['ctx'], second.id);

  expect(wakeEvents(f).map((e) => [e.kind, e.payload])).toEqual(
    [cause, later].map((each) => [
      'resident.wake_skipped',
      { session_id: main.id, reason: 'not_accepting', cause: each },
    ]),
  );
});
