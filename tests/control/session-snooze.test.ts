import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { Approval, Principal, Session, SessionTurn, Workspace } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const script = (...steps: object[]) => `fixture-script\n${JSON.stringify(steps)}`;
const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const planner = (f: Fixture): Principal => ({
  id: 'planner',
  role: 'planner',
  project_id: f.project.id,
});
const snooze = (f: Fixture, sessionId: string, snoozed = true, principal: Principal = user) =>
  f.call<Session>(
    'session.snooze',
    { session_id: sessionId, snoozed },
    current(f, sessionId).revision,
    principal,
  );
const unsnoozed = (f: Fixture, sessionId: string) =>
  f.store
    .events(0, undefined, 100000)
    .filter((event) => event.aggregate_id === sessionId && event.kind === 'session.unsnoozed')
    .map((event) => event.payload);

async function idleSession(f: Fixture, input?: string) {
  const session = await f.create(input);
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.turns(session.id).every((turn) => turn.state === 'completed') &&
      current(f, session.id).state === 'open',
    () => f.control.tick(),
  );
  return current(f, session.id);
}

it('snoozes and unsnoozes a session for the user only', async () => {
  const f = await workbenchFixture();
  const session = await idleSession(f);
  expect(() => snooze(f, session.id, true, planner(f))).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
  const snoozed = snooze(f, session.id);
  expect(snoozed.snoozed_at).toBe(new Date(Date.parse(snoozed.snoozed_at!)).toISOString());
  expect(f.list()[0]).toMatchObject({ id: session.id, snoozed_at: snoozed.snoozed_at });
  expect(snooze(f, session.id, false)).not.toHaveProperty('snoozed_at');
  expect(f.list()[0]).not.toHaveProperty('snoozed_at');
  expect(
    f.store
      .events(0, undefined, 100000)
      .filter((event) => event.aggregate_id === session.id)
      .map((event) => event.kind),
  ).toEqual(expect.arrayContaining(['session.snoozed', 'session.unsnoozed']));
});

it('refuses to snooze an archived session', async () => {
  const f = await workbenchFixture();
  const session = await f.create();
  const ended = f.store.update<Session>(
    'sessions',
    { ...current(f, session.id), state: 'closed', outcome: 'discarded' },
    current(f, session.id).revision,
  );
  f.call('session.archive', { session_id: session.id }, ended.revision);
  expect(() => snooze(f, session.id)).toThrow(expect.objectContaining({ code: 'invalid_state' }));
  expect(current(f, session.id)).not.toHaveProperty('snoozed_at');
});

it('clears the snooze when the user archives the session', async () => {
  const f = await workbenchFixture();
  const session = await idleSession(f);
  snooze(f, session.id);
  const archived = f.call<Session>(
    'session.archive',
    { session_id: session.id },
    current(f, session.id).revision,
  );
  expect(archived).not.toHaveProperty('snoozed_at');
  expect(typeof archived.archived_at).toBe('string');
  expect(unsnoozed(f, session.id)).toEqual([{ reason: 'archived' }]);
});

it('brings a snoozed session back when its turn ends', async () => {
  const f = await workbenchFixture();
  const session = await f.create(script({ wait: 500 }, { say: 'Done' }));
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.turns(session.id)[0]?.state === 'running',
    () => f.control.tick(),
  );
  snooze(f, session.id);
  await eventually(
    () => f.turns(session.id)[0]?.state === 'completed',
    () => f.control.tick(),
  );
  expect(current(f, session.id)).not.toHaveProperty('snoozed_at');
  expect(unsnoozed(f, session.id)).toEqual([{ reason: 'turn_ended' }]);
});

it('brings a snoozed session back when it asks the user for permission', async () => {
  const f = await workbenchFixture();
  const session = await f.create(
    script({ wait: 300 }, { ask: { tool: 'Bash', input: { command: 'pnpm test' } } }),
  );
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.turns(session.id)[0]?.state === 'running',
    () => f.control.tick(),
  );
  snooze(f, session.id);
  await eventually(
    () =>
      f.store
        .list<Approval>('approvals')
        .some((approval) => approval.session_id === session.id && approval.state === 'pending'),
    () => f.control.tick(),
  );
  expect(f.turns(session.id)[0]?.state).toBe('running');
  expect(current(f, session.id)).not.toHaveProperty('snoozed_at');
  expect(unsnoozed(f, session.id)).toEqual([{ reason: 'needs_you' }]);
});

it('brings a snoozed session back when its merge is blocked', async () => {
  const f = await workbenchFixture();
  git(f.source, 'config', 'user.name', 'Source User');
  git(f.source, 'config', 'user.email', 'source@example.invalid');
  const session = await idleSession(f);
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
  for (const [repository, text] of [
    [workspace.path, 'session\n'],
    [f.source, 'source\n'],
  ] as const) {
    writeFileSync(path.join(repository, 'answer.txt'), text);
    git(repository, 'add', '--', 'answer.txt');
    git(repository, 'commit', '--quiet', '-m', 'Update answer.txt');
  }
  snooze(f, session.id);
  f.call('session.merge', { session_id: session.id }, current(f, session.id).revision);
  await eventually(
    () => current(f, session.id).merge?.state === 'blocked',
    () => f.control.tick(),
  );
  expect(current(f, session.id)).not.toHaveProperty('snoozed_at');
  expect(unsnoozed(f, session.id)).toEqual([{ reason: 'merge_blocked' }]);
});

it('brings a snoozed session back when it ends', async () => {
  const f = await workbenchFixture();
  const session = await idleSession(f);
  snooze(f, session.id);
  f.call('session.discard', { session_id: session.id }, current(f, session.id).revision);
  await eventually(
    () => current(f, session.id).outcome === 'discarded',
    () => f.control.tick(),
  );
  expect(current(f, session.id)).not.toHaveProperty('snoozed_at');
  expect(unsnoozed(f, session.id)).toEqual([{ reason: 'session_ended' }]);
});

it('brings a snoozed session back when a daemon restart fails its held input of unknown delivery', async () => {
  const f = await workbenchFixture();
  const session = await idleSession(f);
  const first = f.call<SessionTurn>(
    'session.send',
    { session_id: session.id, input: 'Continue the export' },
    current(f, session.id).revision,
  );
  snooze(f, session.id);
  const snoozed = current(f, session.id);
  f.store.update(
    'sessions',
    {
      ...snoozed,
      queued_handoff: { first_turn_id: first.id },
      process_identity: { pid: 2_000_000_000 },
    },
    snoozed.revision,
  );
  f.store.update('session_turns', { ...first, state: 'running' }, first.revision);
  f.control.handles.clear();
  await f.restart(() => undefined, { abandon: true });
  expect(f.store.must<SessionTurn>('session_turns', first.id).state).toBe('failed');
  expect(current(f, session.id)).not.toHaveProperty('snoozed_at');
  expect(unsnoozed(f, session.id)).toEqual([{ reason: 'turn_ended' }]);
});

it('brings a snoozed session back when a daemon restart fails the turn ahead of its held input', async () => {
  const f = await workbenchFixture();
  const session = await idleSession(f);
  const running = f.call<SessionTurn>(
    'session.send',
    { session_id: session.id, input: 'Continue the export' },
    current(f, session.id).revision,
  );
  const held = f.store.insert<SessionTurn>('session_turns', {
    ...running,
    id: 'held-turn',
    revision: 1,
    input: 'Then check its header',
  });
  snooze(f, session.id);
  const snoozed = current(f, session.id);
  f.store.update(
    'sessions',
    {
      ...snoozed,
      queued_handoff: { first_turn_id: held.id },
      process_identity: { pid: 2_000_000_000 },
    },
    snoozed.revision,
  );
  const sent = f.store.must<SessionTurn>('session_turns', running.id);
  f.store.update(
    'session_turns',
    { ...sent, state: 'running', delivery: 'delivered' },
    sent.revision,
  );
  f.control.handles.clear();
  await f.restart(() => undefined, { abandon: true });
  expect(f.store.must<SessionTurn>('session_turns', running.id).state).toBe('failed');
  expect(current(f, session.id)).not.toHaveProperty('snoozed_at');
  expect(unsnoozed(f, session.id)).toEqual([{ reason: 'turn_ended' }]);
});

it('brings a snoozed session back when a daemon restart fails its turn and nothing continues it', async () => {
  const f = await workbenchFixture();
  const session = await idleSession(f);
  const running = f.call<SessionTurn>(
    'session.send',
    { session_id: session.id, input: 'Continue the export' },
    current(f, session.id).revision,
  );
  snooze(f, session.id);
  const snoozed = current(f, session.id);
  f.store.update(
    'sessions',
    { ...snoozed, process_identity: { pid: 2_000_000_000 } },
    snoozed.revision,
  );
  const sent = f.store.must<SessionTurn>('session_turns', running.id);
  f.store.update(
    'session_turns',
    { ...sent, state: 'running', delivery: 'delivered' },
    sent.revision,
  );
  const before = f.turns(session.id).map((turn) => turn.id);
  f.control.handles.clear();
  await f.restart(() => undefined, { abandon: true });
  expect(f.store.must<SessionTurn>('session_turns', running.id).state).toBe('failed');
  expect(f.turns(session.id).map((turn) => turn.id)).toEqual(before);
  expect(current(f, session.id)).not.toHaveProperty('snoozed_at');
  expect(unsnoozed(f, session.id)).toEqual([{ reason: 'turn_ended' }]);
});

it('brings a snoozed session back when the user sends it a message', async () => {
  const f = await workbenchFixture();
  const session = await idleSession(f);
  snooze(f, session.id);
  f.call(
    'session.send',
    { session_id: session.id, input: 'Continue the work' },
    current(f, session.id).revision,
  );
  expect(current(f, session.id)).not.toHaveProperty('snoozed_at');
  expect(unsnoozed(f, session.id)).toEqual([{ reason: 'user_message' }]);
});
