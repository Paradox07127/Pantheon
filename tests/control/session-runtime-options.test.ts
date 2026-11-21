import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { AgentEventSink, Session, SessionTurn, Workspace } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

async function settled() {
  const f = await workbenchFixture();
  const session = await f.create('First');
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  const current = () => f.store.must<Session>('sessions', session.id);
  const send = async (input: string) => {
    f.call('session.send', { session_id: session.id, input }, current().revision);
    await eventually(
      () => current().state === 'open',
      () => f.control.tick(),
    );
    return f.turns(session.id).at(-1)!;
  };
  return { f, session, current, send };
}

it('rolls back only files for the files scope and preserves the native conversation and turn visibility', async () => {
  const { f, session, current, send } = await settled();
  const work = f.store.must<Workspace>('workspaces', session.workspace_id!).path;
  writeFileSync(path.join(work, 'answer.txt'), 'before second');
  const second = await send('Second');
  const native = current().native_id;
  writeFileSync(path.join(work, 'answer.txt'), 'after second');
  await f.call(
    'session.rollback',
    { session_id: session.id, turn_id: second.id, scope: 'files' },
    current().revision,
  );
  expect(readFileSync(path.join(work, 'answer.txt'), 'utf8')).toBe('before second');
  expect(current().native_id).toBe(native);
  expect(f.turns(session.id).every((turn) => !turn.rolled_back)).toBe(true);
  await eventually(
    () =>
      f.store
        .kindEvents(f.project.id, ['session.process_closed'])
        .some((event) => event.aggregate_id === session.id),
    () => f.control.tick(),
  );
  expect((await send('Continue')).handoff).toBeUndefined();
});

it.each(['conversation', 'both'])(
  'forks the native history at the end of the turn before and marks that turn and later ones for %s rollback',
  async (scope) => {
    const { f, session, current, send } = await settled();
    f.adapter.report.capabilities.conversation_rollback = {
      status: 'supported',
      evidence: 'Recorded history fixture',
    };
    const first = f.turns(session.id)[0]!;
    f.store.update(
      'session_turns',
      { ...first, native_history_end: 'native-first' },
      first.revision,
    );
    const work = f.store.must<Workspace>('workspaces', session.workspace_id!).path;
    writeFileSync(path.join(work, 'answer.txt'), 'before second');
    const second = await send('Second');
    const third = await send('Third');
    writeFileSync(path.join(work, 'answer.txt'), 'keep conversation-only files');
    const native = current().native_id;
    await f.call(
      'session.rollback',
      { session_id: session.id, turn_id: second.id, scope },
      current().revision,
    );
    expect(current().native_fork).toEqual({ session_id: native, after: 'native-first' });
    expect(f.store.must<SessionTurn>('session_turns', first.id).rolled_back).toBeUndefined();
    expect(f.store.must<SessionTurn>('session_turns', second.id).rolled_back).toBe(true);
    expect(f.store.must<SessionTurn>('session_turns', third.id).rolled_back).toBe(true);
    expect(readFileSync(path.join(work, 'answer.txt'), 'utf8')).toBe(
      scope === 'conversation' ? 'keep conversation-only files' : 'before second',
    );
    await eventually(
      () =>
        f.store
          .kindEvents(f.project.id, ['session.process_closed'])
          .some((event) => event.aggregate_id === session.id),
      () => f.control.tick(),
    );
    const next = await send('Continue');
    expect(next.handoff).toBeUndefined();
    const launch = f.resume.mock.calls.at(-1) ?? f.start.mock.calls.at(-1);
    expect(launch![0].native_fork).toEqual({ session_id: native, after: 'native-first' });
    expect(current().native_fork).toBeUndefined();
  },
);

async function closed(
  f: Awaited<ReturnType<typeof workbenchFixture>>,
  sessionId: string,
  count: number,
) {
  await eventually(
    () =>
      f.store
        .kindEvents(f.project.id, ['session.process_closed'])
        .filter((event) => event.aggregate_id === sessionId).length === count,
    () => f.control.tick(),
  );
}

it('drops a pending native fork when a later rollback reaches the first turn', async () => {
  const { f, session, current, send } = await settled();
  f.adapter.report.capabilities.conversation_rollback = {
    status: 'supported',
    evidence: 'Recorded history fixture',
  };
  const first = f.turns(session.id)[0]!;
  const second = await send('Second');
  f.store.update(
    'session_turns',
    { ...second, native_history_end: 'native-second' },
    second.revision,
  );
  const third = await send('Third');
  f.call(
    'session.rollback',
    { session_id: session.id, turn_id: third.id, scope: 'conversation' },
    current().revision,
  );
  expect(current().native_fork).toMatchObject({ after: 'native-second' });
  await closed(f, session.id, 1);
  f.call(
    'session.rollback',
    { session_id: session.id, turn_id: first.id, scope: 'conversation' },
    current().revision,
  );
  expect(current().native_id).toBeUndefined();
  expect(current().native_fork).toBeUndefined();
  const next = await send('Continue');
  expect(next.handoff).toBeDefined();
  expect(f.start.mock.calls.at(-1)![0].native_fork).toBeUndefined();
});

it('starts a fresh conversation when the fork point belongs to an earlier native conversation', async () => {
  const { f, session, current, send } = await settled();
  f.adapter.report.capabilities.conversation_rollback = {
    status: 'supported',
    evidence: 'Recorded history fixture',
  };
  const first = f.turns(session.id)[0]!;
  f.store.update('session_turns', { ...first, native_history_end: 'native-first' }, first.revision);
  const second = await send('Second');
  const third = await send('Third');
  const old = current().native_id;
  // The second turn left no fork point, so this rollback starts a new native conversation.
  f.call(
    'session.rollback',
    { session_id: session.id, turn_id: third.id, scope: 'conversation' },
    current().revision,
  );
  await closed(f, session.id, 1);
  const fourth = await send('Fourth');
  expect(fourth.handoff).toBeDefined();
  expect(current().native_id).not.toBe(old);
  f.call(
    'session.rollback',
    { session_id: session.id, turn_id: second.id, scope: 'conversation' },
    current().revision,
  );
  expect(current().native_fork).toBeUndefined();
  expect(current()).toMatchObject({ handoff_before_turn_id: second.id });
});

it('starts a fresh conversation with the record before the turn where the adapter cannot fork, and refuses a span fork', async () => {
  const { f, session, current, send } = await settled();
  const second = await send('Second');
  f.call(
    'session.rollback',
    { session_id: session.id, turn_id: second.id, scope: 'conversation' },
    current().revision,
  );
  expect(current()).toMatchObject({ handoff_before_turn_id: second.id });
  expect(current().native_id).toBeUndefined();
  expect(current().native_fork).toBeUndefined();
  expect(f.store.must<SessionTurn>('session_turns', second.id).rolled_back).toBe(true);
  const before = current();
  expect(() =>
    f.call('session.fork', { session_id: session.id, before_span_id: 'tool', input: 'Continue' }),
  ).toThrow(expect.objectContaining({ code: 'unsupported_capability' }));
  expect(current()).toEqual(before);
});

it('stores connector overrides with session revision checks and applies them on the next native launch', async () => {
  const { f, session, current, send } = await settled();
  const before = current().revision;
  f.call('session.setConnectors', { session_id: session.id, enabled: ['calendar'] }, before);
  expect(current().enabled_user_connectors).toEqual(['calendar']);
  expect(f.list().find((row) => row.id === session.id)?.enabled_user_connectors).toEqual([
    'calendar',
  ]);
  expect(() =>
    f.call('session.setConnectors', { session_id: session.id, enabled: [] }, before),
  ).toThrow(expect.objectContaining({ code: 'revision_conflict' }));
  await eventually(
    () =>
      f.store
        .kindEvents(f.project.id, ['session.process_closed'])
        .filter((event) => event.aggregate_id === session.id).length === 1,
    () => f.control.tick(),
  );
  await send('Use calendar');
  const launch = f.resume.mock.calls.at(-1) ?? f.start.mock.calls.at(-1);
  expect(launch![0].extensions).toMatchObject({
    mode: 'inherit',
    overrides: { enabled_user_connectors: ['calendar'], disable_apps: false },
  });
  f.call('session.setConnectors', { session_id: session.id, enabled: [] }, current().revision);
  await eventually(
    () =>
      f.store
        .kindEvents(f.project.id, ['session.process_closed'])
        .filter((event) => event.aggregate_id === session.id).length === 2,
    () => f.control.tick(),
  );
  await send('No connectors');
  expect((f.resume.mock.calls.at(-1) ?? f.start.mock.calls.at(-1))![0].extensions).toMatchObject({
    mode: 'inherit',
    overrides: { enabled_user_connectors: [], disable_apps: true },
  });
  expect(() =>
    f.call('session.setConnectors', { session_id: session.id, enabled: [] }, current().revision, {
      id: 'writer',
      role: 'writer',
    }),
  ).toThrow(expect.objectContaining({ code: 'permission_denied' }));
});

it('persists retry and compaction start events on the running turn and projects the reported threshold', async () => {
  const f = await workbenchFixture();
  vi.spyOn(f.adapter, 'send').mockImplementation(async (_, turn) => ({
    turn_id: turn.turn_id,
    status: 'delivered',
  }));
  const session = await f.create();
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.turns(session.id)[0]!.delivery === 'delivered',
    () => f.control.tick(),
  );
  const sink = f.start.mock.calls[0]![1] as AgentEventSink;
  sink({
    key: 'retry',
    provider_sequence: 30,
    kind: 'turn.retrying',
    attempt: 2,
    reason: 'rate_limit',
    retry_at: 10000,
  });
  sink({ key: 'compacting', provider_sequence: 31, kind: 'context.compacting', trigger: 'auto' });
  sink({
    key: 'usage',
    provider_sequence: 32,
    kind: 'usage.updated',
    cost_source: 'unknown',
    auto_compact_at_tokens: 167000,
  });
  const events = f.store.kindEvents(f.project.id, [
    'agent.turn.retrying',
    'agent.context.compacting',
  ]);
  expect(events.map((event) => (event.payload as { turn_id?: string }).turn_id)).toEqual([
    f.turns(session.id)[0]!.id,
    f.turns(session.id)[0]!.id,
  ]);
  expect(f.list().find((row) => row.id === session.id)?.auto_compact_at_tokens).toBe(167000);
});

it('forks before a reported span using native history without a text handoff', async () => {
  const { f, session, current } = await settled();
  f.adapter.report.capabilities.fork_within_turn = {
    status: 'supported',
    evidence: 'Recorded message boundary',
  };
  // The idle sink refuses turn events; store the recorded adapter envelope.
  f.store.event('agent.tool.started', current(), f.project.id, {
    key: 'tool-boundary',
    provider_sequence: 50,
    kind: 'tool.started',
    turn_id: f.turns(session.id)[0]!.id,
    tool_call_id: 'tool-call',
    name: 'Read',
    native_history_before: 'previous-message',
  });
  const fork = await f.call<Session>('session.fork', {
    session_id: session.id,
    before_span_id: 'tool-call',
    input: 'Branch',
  });
  expect(fork.forked_from).toEqual({ session_id: session.id, before_span_id: 'tool-call' });
  expect(fork.native_fork).toEqual({ session_id: current().native_id, after: 'previous-message' });
  expect(f.turns(fork.id)[0]!.handoff).toBeUndefined();
  expect(() =>
    f.call('session.fork', { session_id: session.id, before_span_id: 'missing', input: 'Branch' }),
  ).toThrow(expect.objectContaining({ code: 'invalid_input' }));
});

it('queues a steer after connector changes and launches it with the new list after the current turn', async () => {
  const f = await workbenchFixture();
  vi.spyOn(f.adapter, 'send').mockImplementationOnce(async (_, turn) => ({
    turn_id: turn.turn_id,
    status: 'delivered',
  }));
  const session = await f.create();
  const current = () => f.store.must<Session>('sessions', session.id);
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.turns(session.id)[0]!.delivery === 'delivered',
    () => f.control.tick(),
  );
  f.call(
    'session.setConnectors',
    { session_id: session.id, enabled: ['calendar'] },
    current().revision,
  );
  const next = f.call<SessionTurn>(
    'session.steer',
    { session_id: session.id, input: 'Use calendar' },
    current().revision,
  );
  await eventually(
    () => f.store.must<SessionTurn>('session_turns', next.id).delivery === 'queued',
    () => f.control.tick(),
  );
  expect(f.adapter.send).toHaveBeenCalledTimes(1);
  const sink = f.start.mock.calls[0]![1] as AgentEventSink;
  sink({
    key: 'completed-first',
    provider_sequence: 40,
    kind: 'turn.completed',
    turn_id: f.turns(session.id)[0]!.id,
    status: 'completed',
  });
  await eventually(
    () => f.store.must<SessionTurn>('session_turns', next.id).state === 'completed',
    () => f.control.tick(),
  );
  expect(f.resume.mock.calls.at(-1)![0].extensions).toMatchObject({
    mode: 'inherit',
    overrides: { enabled_user_connectors: ['calendar'], disable_apps: false },
  });
});

it('drops a compaction threshold when the runtime reports a new model', async () => {
  const f = await workbenchFixture();
  vi.spyOn(f.adapter, 'send').mockImplementation(async (_, turn) => ({
    turn_id: turn.turn_id,
    status: 'delivered',
  }));
  const session = await f.create();
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.turns(session.id)[0]!.delivery === 'delivered',
    () => f.control.tick(),
  );
  const sink = f.start.mock.calls[0]![1] as AgentEventSink;
  sink({
    key: 'model-context',
    provider_sequence: 40,
    kind: 'usage.updated',
    cost_source: 'unknown',
    auto_compact_at_tokens: 167000,
  });
  expect(f.list().find((row) => row.id === session.id)?.auto_compact_at_tokens).toBe(167000);
  sink({
    key: 'changed-model',
    provider_sequence: 41,
    kind: 'session.started',
    native_session_id: f.store.must<Session>('sessions', session.id).native_id!,
    reported_model: 'new-model',
  });
  expect(f.list().find((row) => row.id === session.id)?.auto_compact_at_tokens).toBeUndefined();
});
