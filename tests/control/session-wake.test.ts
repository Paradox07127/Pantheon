import { expect, it, vi } from 'vitest';
import {
  id,
  type Principal,
  type Session,
  type SessionTurn,
  type SettingProposal,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { notifySession } from '../../packages/control/dist/session-wake.js';
import { eventually, settle } from '../helpers.js';
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

  expect(turn).toMatchObject({ origin: 'notice', input: 'The review found two issues.' });
  expect(f.turns(session.id)).toHaveLength(before + 1);
  expect(sessionOf(f, session.id).state).toBe('running');
  const jobs = f.store.db.prepare("SELECT payload FROM outbox WHERE kind='session.turn'").all() as {
    payload: string;
  }[];
  expect(jobs.some((job) => JSON.parse(job.payload).turn_id === turn.id)).toBe(true);
  expect(planRows(f)).toBe(0);
});

it('keeps the blocked merge of an idle session its notice starts a turn on', async () => {
  const f = await workbenchFixture();
  const session = await f.create('Rename the answer file');
  await settle(f, session);
  const row = sessionOf(f, session.id);
  const merge = { state: 'blocked' as const, reason: 'gate_failed' };
  f.store.update<Session>('sessions', { ...row, merge }, row.revision);

  notifySession(ctxOf(f), session.id, 'Your work did not land: gate_failed.', 'cause-1');

  expect(sessionOf(f, session.id)).toMatchObject({ state: 'running', merge });
});

it('folds a second text into the queued turn of a running session', async () => {
  const f = await workbenchFixture({ delay: 3000 });
  const session = await f.create('Rename the answer file');
  expect(sessionOf(f, session.id).state).toBe('running');
  const before = f.turns(session.id).length;

  const first = notifySession(ctxOf(f), session.id, 'The review found two issues.', 'cause-1')!;
  const second = notifySession(ctxOf(f), session.id, 'The worker finished its turn.', 'cause-2')!;

  expect(first).toMatchObject({ origin: 'notice', state: 'queued', delivery: 'pending' });
  expect(second.id).toBe(first.id);
  const turns = f.turns(session.id);
  expect(turns).toHaveLength(before + 1);
  expect(turns.find((turn) => turn.id === first.id)!.input).toBe(
    'The review found two issues.\n\nThe worker finished its turn.',
  );
  expect(planRows(f)).toBe(0);
});

it('folds a text into a queued notice stored with the earlier tracker origin', async () => {
  const f = await workbenchFixture({ delay: 3000 });
  const session = await f.create('Rename the answer file');
  expect(sessionOf(f, session.id).state).toBe('running');
  const stored = f.store.insert<SessionTurn>('session_turns', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    session_id: session.id,
    input: 'The review found two issues.',
    kind: 'send',
    delivery: 'pending',
    state: 'queued',
    origin: 'tracker',
  });

  const turn = notifySession(ctxOf(f), session.id, 'The worker finished its turn.', 'cause-1')!;

  expect(turn.id).toBe(stored.id);
  expect(turn.input).toBe('The review found two issues.\n\nThe worker finished its turn.');
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

const conductorOf = (f: Fixture, sessionId: string): Principal => ({
  id: `session:${sessionId}`,
  role: 'conductor',
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});

/** A main agent whose turn runs without a fixture process, so it stays running until stopped. */
async function mainAgentMidTurn(f: Fixture, identity = true) {
  const conductor = await f.call<Promise<Session>>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Ship the export',
    purpose: 'conductor',
  });
  await settle(f, conductor);
  vi.spyOn(f.adapter, 'send').mockImplementationOnce(async (handle, turn) => {
    if (identity) handle.process_identity = { pid: 4000001, start_time_us: 1700000000123456 };
    else delete handle.process_identity;
    return { turn_id: turn.turn_id, status: 'delivered' };
  });
  const running = f.call<SessionTurn>(
    'session.send',
    { session_id: conductor.id, input: 'Plan the docs' },
    sessionOf(f, conductor.id).revision,
  );
  await eventually(
    () =>
      f.store.must<SessionTurn>('session_turns', running.id).state === 'running' &&
      (!identity || sessionOf(f, conductor.id).process_identity !== undefined),
    () => f.control.tick(),
  );
  return conductor;
}

/** How many times the adapter was sent the turn. */
const sendsOf = (f: Fixture, turnId: string) =>
  vi.mocked(f.adapter.send).mock.calls.filter(([, turn]) => turn.turn_id === turnId).length;

/** The main agent's notice turns that carry the text. */
const noticesWith = (f: Fixture, sessionId: string, text: string) =>
  f.turns(sessionId).filter((turn) => turn.origin === 'notice' && turn.input.includes(text));

/** News that a spawned session finished, queued behind the main agent's running turn. */
async function spawnedNewsQueued(f: Fixture, conductorId: string) {
  const { session_id } = await f.call<Promise<{ session_id: string }>>(
    'conductor.spawn',
    { runtime: f.adapter.name, input: 'Port the parser' },
    null,
    conductorOf(f, conductorId),
  );
  await settle(f, sessionOf(f, session_id));
  expect(noticesWith(f, conductorId, session_id)).toMatchObject([
    { state: 'queued', delivery: 'pending' },
  ]);
  return session_id;
}

/** Starts the daemon again and lets the main agent run what waits for it. */
async function afterRestart(f: Fixture, sessionId: string, clean: boolean) {
  if (clean) {
    await f.control.shutdown();
    await f.restart(() => undefined, { abandon: true });
  } else await f.restart(() => undefined);
  await settle(f, sessionOf(f, sessionId));
  for (let i = 0; i < 3; i++) await f.control.tick();
}

it.each([
  { how: 'stop and start', clean: true },
  { how: 'crash', clean: false },
])(
  'tells the main agent once after a daemon $how the news of a spawned session that waited behind its running turn',
  async ({ clean }) => {
    const f = await workbenchFixture();
    const conductor = await mainAgentMidTurn(f);
    const spawned = await spawnedNewsQueued(f, conductor.id);

    await afterRestart(f, conductor.id, clean);

    expect(noticesWith(f, conductor.id, spawned)).toMatchObject([
      { state: 'completed', delivery: 'delivered' },
    ]);
  },
);

it('tells the main agent once after a daemon stop and start a settings answer that waited behind its running turn', async () => {
  const f = await workbenchFixture();
  const conductor = await mainAgentMidTurn(f);
  const { proposal_id } = f.call<{ proposal_id: string }>(
    'conductor.propose_setting',
    {
      command: 'workflow.policy.set',
      input: { project_budget: { input_tokens: 9000000 } },
      reason: 'The release needs it',
    },
    null,
    conductorOf(f, conductor.id),
  );
  f.call(
    'setting.proposal.respond',
    { proposal_id, decision: 'reject' },
    f.store.must<SettingProposal>('setting_change_proposals', proposal_id).revision,
  );
  const answer = '[setting] [Pantheon] rejected: workflow.policy.set';
  expect(noticesWith(f, conductor.id, answer)).toMatchObject([
    { state: 'queued', delivery: 'pending' },
  ]);

  await afterRestart(f, conductor.id, true);

  expect(noticesWith(f, conductor.id, answer)).toMatchObject([
    { state: 'completed', delivery: 'delivered' },
  ]);
});

it('fails a message the user queued behind the running turn of the main agent when the daemon stops', async () => {
  const f = await workbenchFixture();
  const conductor = await mainAgentMidTurn(f);
  const queued = f.store.insert<SessionTurn>('session_turns', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    session_id: conductor.id,
    input: 'Then write the changelog',
    kind: 'send',
    delivery: 'pending',
    state: 'queued',
  });

  await afterRestart(f, conductor.id, true);

  expect(f.store.must<SessionTurn>('session_turns', queued.id)).toMatchObject({
    state: 'failed',
    delivery: 'failed',
    delivery_reason: 'daemon_shutdown',
  });
});

it('tells the main agent each of two notices that waited behind its running turn once after a daemon stop and start', async () => {
  const f = await workbenchFixture();
  const conductor = await mainAgentMidTurn(f);
  const spawned = await spawnedNewsQueued(f, conductor.id);
  const [news] = noticesWith(f, conductor.id, spawned);
  const stored = f.store.insert<SessionTurn>('session_turns', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    session_id: conductor.id,
    input: 'The review found two issues.',
    kind: 'send',
    delivery: 'pending',
    state: 'queued',
    origin: 'tracker',
  });

  await f.control.shutdown();
  await f.restart(() => undefined, { abandon: true });
  await eventually(
    () =>
      sessionOf(f, conductor.id).state === 'reconciling' ||
      (sessionOf(f, conductor.id).state === 'open' &&
        f.turns(conductor.id).every((turn) => !['queued', 'running'].includes(turn.state))),
    () => f.control.tick(),
  );

  expect(sessionOf(f, conductor.id).state).toBe('open');
  for (const notice of [news!, stored]) {
    expect(f.store.must<SessionTurn>('session_turns', notice.id)).toMatchObject({
      state: 'completed',
      delivery: 'delivered',
    });
    expect(sendsOf(f, notice.id)).toBe(1);
  }
});

it('ends a waiting notice of a main agent whose discard was asked when the daemon stops, and discards it', async () => {
  const f = await workbenchFixture();
  const conductor = await mainAgentMidTurn(f);
  const spawned = await spawnedNewsQueued(f, conductor.id);
  const [news] = noticesWith(f, conductor.id, spawned);
  const row = sessionOf(f, conductor.id);
  f.store.update<Session>(
    'sessions',
    { ...row, stop_requested: { reason: 'Closed by the user', by: 'user', at: f.store.now() } },
    row.revision,
  );

  await f.control.shutdown();

  expect(sessionOf(f, conductor.id).state).not.toBe('running');
  await f.restart(() => undefined, { abandon: true });
  for (let i = 0; i < 3; i++) await f.control.tick();
  expect(f.store.must<SessionTurn>('session_turns', news!.id)).toMatchObject({
    state: 'failed',
    delivery: 'failed',
    delivery_reason: 'daemon_shutdown',
  });
  expect(sessionOf(f, conductor.id).outcome).toBe('discarded');
  expect(sendsOf(f, news!.id)).toBe(0);
});

it('ends a waiting notice when the daemon stop of a main agent with no known process fails', async () => {
  const f = await workbenchFixture();
  const conductor = await mainAgentMidTurn(f, false);
  expect(sessionOf(f, conductor.id).process_identity).toBeUndefined();
  const spawned = await spawnedNewsQueued(f, conductor.id);
  const [news] = noticesWith(f, conductor.id, spawned);
  vi.spyOn(f.adapter, 'cancel').mockRejectedValue(new Error('The process did not answer'));

  await f.control.shutdown();
  await f.restart(() => undefined, { abandon: true });
  for (let i = 0; i < 3; i++) await f.control.tick();

  expect(sessionOf(f, conductor.id).state).not.toBe('running');
  expect(f.store.must<SessionTurn>('session_turns', news!.id)).toMatchObject({
    state: 'failed',
    delivery: 'failed',
    delivery_reason: 'daemon_shutdown',
  });
  expect(sendsOf(f, news!.id)).toBe(0);
});
