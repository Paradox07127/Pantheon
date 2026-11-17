import { expect, it, vi } from 'vitest';
import type { Session, SessionTurn } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, settle, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
const current = (f: Fixture, id: string) => f.store.must<Session>('sessions', id);
const row = (f: Fixture, turn: SessionTurn) => f.store.must<SessionTurn>('session_turns', turn.id);
const compact = (f: Fixture, id: string, instructions?: string) =>
  f.call<SessionTurn>('session.compact', { session_id: id, instructions }, current(f, id).revision);

it('records manual compaction as a maintenance turn, counts it once and retains a timed trace turn', async () => {
  const f = await workbenchFixture();
  const session = await f.create('Initial work');
  await settle(f, session);
  const send = vi.spyOn(f.adapter, 'send');
  const turn = compact(f, session.id, 'Keep the plan');
  expect(turn).toMatchObject({ origin: 'compaction', input: 'Keep the plan' });
  expect(current(f, session.id).state).toBe('running');
  await settle(f, session);
  expect(send).toHaveBeenCalledWith(expect.anything(), {
    turn_id: turn.id,
    input: 'Keep the plan',
    compact: true,
  });
  expect(row(f, turn).state).toBe('completed');
  expect(f.list().find((s) => s.id === session.id)?.compaction_count).toBe(1);
  expect(
    f.store.kindEvents(f.project.id, ['agent.context.compacted']).map((event) => event.payload),
  ).toEqual([expect.objectContaining({ trigger: 'manual' })]);
  const userInputs = f
    .turns(session.id)
    .filter((t) => !t.origin)
    .map((t) => t.input);
  expect(userInputs).toEqual(['Initial work']);
  const trace = await f.control.sessionTrace(user, f.project.id, session.id, turn.id);
  expect(trace.spans).toContainEqual(
    expect.objectContaining({
      id: turn.id,
      kind: 'turn',
      status: 'ok',
      start: expect.any(Number),
      end: expect.any(Number),
    }),
  );
});

it('refuses compaction for queued and running turns and follows the existing message rules while compacting', async () => {
  const f = await workbenchFixture({ delay: 200 });
  const session = await f.create();
  expect(() => compact(f, session.id)).toThrow(expect.objectContaining({ code: 'resource_busy' }));
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.turns(session.id)[0]?.state === 'running',
    () => f.control.tick(),
  );
  expect(() => compact(f, session.id)).toThrow(expect.objectContaining({ code: 'resource_busy' }));
  await settle(f, session);
  const turn = compact(f, session.id);
  expect(() => compact(f, session.id)).toThrow(expect.objectContaining({ code: 'resource_busy' }));
  expect(() =>
    f.call(
      'session.send',
      { session_id: session.id, input: 'Next' },
      current(f, session.id).revision,
    ),
  ).toThrow(expect.objectContaining({ code: 'resource_busy' }));
  await eventually(
    () => row(f, turn).delivery === 'delivered',
    () => f.control.tick(),
  );
  const queued = f.call<SessionTurn>(
    'session.steer',
    { session_id: session.id, input: 'After' },
    current(f, session.id).revision,
  );
  await settle(f, session);
  expect(row(f, queued).state).toBe('completed');
  expect(f.list().find((s) => s.id === session.id)?.compaction_count).toBe(1);
});

it.each([
  { state: 'closed' as const },
  { outcome: 'merged' as const },
  { outcome: 'discarded' as const },
  { stop_requested: { reason: 'Discard', at: 1, by: 'user' as const } },
  { merge: { state: 'running' as const } },
])('refuses compaction when the session cannot accept a maintenance turn: %j', async (change) => {
  const f = await workbenchFixture();
  const session = await f.create();
  await settle(f, session);
  const before = current(f, session.id);
  f.store.update('sessions', { ...before, ...change }, before.revision);
  expect(() => compact(f, session.id)).toThrow();
  expect(f.turns(session.id)).toHaveLength(1);
});

it('refuses non-user callers and runtimes without manual compaction', async () => {
  const f = await workbenchFixture();
  const session = await f.create();
  await settle(f, session);
  expect(() =>
    f.call('session.compact', { session_id: session.id }, current(f, session.id).revision, {
      id: 'lead',
      role: 'lead',
    }),
  ).toThrow(expect.objectContaining({ code: 'permission_denied' }));
  f.adapter.report.capabilities.manual_compaction = {
    status: 'unsupported',
    evidence: 'Fixture refusal',
  };
  expect(() => compact(f, session.id)).toThrow(
    expect.objectContaining({ code: 'unsupported_capability' }),
  );
  expect(f.turns(session.id)).toHaveLength(1);
});

it('refuses instructions for a runtime that takes none, before creating a compaction turn', async () => {
  const f = await workbenchFixture();
  const session = await f.create();
  await settle(f, session);
  f.adapter.report.capabilities.compaction_instructions = {
    status: 'unsupported',
    evidence: 'Fixture refusal',
  };
  expect(() => compact(f, session.id, 'Keep the plan')).toThrow(
    expect.objectContaining({ code: 'unsupported_capability' }),
  );
  expect(f.turns(session.id)).toHaveLength(1);
  expect(current(f, session.id).state).toBe('open');
});

it('records a failed compaction as a failed turn and accepts a later message', async () => {
  const f = await workbenchFixture();
  const session = await f.create();
  await settle(f, session);
  const send = f.adapter.send.bind(f.adapter);
  vi.spyOn(f.adapter, 'send').mockImplementationOnce((handle, turn) =>
    send(handle, {
      ...turn,
      compact: undefined,
      input: 'fixture-script\n[{"fail":"Compaction refused"}]',
    }),
  );
  const turn = compact(f, session.id);
  await settle(f, session);
  expect(row(f, turn)).toMatchObject({ state: 'failed', delivery: 'delivered' });
  expect(f.store.kindEvents(f.project.id, ['turn.failed'])).toContainEqual(
    expect.objectContaining({
      aggregate_id: turn.id,
      payload: expect.objectContaining({ error: 'Compaction refused' }),
    }),
  );
  f.call(
    'session.send',
    { session_id: session.id, input: 'Continue' },
    current(f, session.id).revision,
  );
  await settle(f, session);
  expect(f.turns(session.id).at(-1)?.state).toBe('completed');
});

it('refuses compaction while a turn waits for permission', async () => {
  const f = await workbenchFixture();
  const session = await f.create(
    'fixture-script\n[{"ask":{"tool":"Bash","input":{"command":"pwd"}}}]',
  );
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.list().find((s) => s.id === session.id)?.state === 'waiting',
    () => f.control.tick(),
  );
  expect(() => compact(f, session.id)).toThrow(expect.objectContaining({ code: 'resource_busy' }));
  expect(f.turns(session.id)).toHaveLength(1);
});

it('refuses a stale session revision', async () => {
  const f = await workbenchFixture();
  const session = await f.create();
  await settle(f, session);
  expect(() =>
    f.call('session.compact', { session_id: session.id }, current(f, session.id).revision - 1),
  ).toThrow(expect.objectContaining({ code: 'revision_conflict' }));
  expect(f.turns(session.id)).toHaveLength(1);
});

it('refuses compaction while an open session holds a queued turn', async () => {
  const f = await workbenchFixture();
  const session = await f.create();
  await settle(f, session);
  const [first] = f.turns(session.id);
  f.store.insert<SessionTurn>('session_turns', {
    ...first!,
    id: 'held-turn',
    revision: 1,
    state: 'queued',
  });
  expect(() => compact(f, session.id)).toThrow(expect.objectContaining({ code: 'resource_busy' }));
  expect(f.turns(session.id).map((turn) => turn.origin)).toEqual([undefined, undefined]);
});

it('fails the compaction turn when the runtime refuses it and accepts a later one', async () => {
  const f = await workbenchFixture();
  const session = await f.create();
  await settle(f, session);
  vi.spyOn(f.adapter, 'send').mockImplementationOnce(async (_, turn) => ({
    turn_id: turn.turn_id,
    status: 'unsupported',
    reason: 'Session is not idle',
  }));
  const refused = compact(f, session.id);
  await settle(f, session);
  expect(row(f, refused)).toMatchObject({
    state: 'failed',
    delivery: 'failed',
    delivery_reason: 'Session is not idle',
  });
  const next = compact(f, session.id);
  await settle(f, session);
  expect(row(f, next).state).toBe('completed');
});
