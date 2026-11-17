import { afterEach, expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type { AgentEvent, Session, SessionTurn } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, fixture } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
});

const deliverOnly = (adapter: FixtureAdapter) =>
  vi.spyOn(adapter, 'send').mockImplementation(async (_handle, turn) => ({
    turn_id: turn.turn_id,
    status: 'delivered',
  }));

/** A conversation without a worktree whose first turn is running. */
async function conversation() {
  const adapter = new FixtureAdapter();
  const start = vi.spyOn(adapter, 'start');
  const send = deliverOnly(adapter);
  const f = await fixture({ adapter });
  cleanup.push(() => f.close());
  const session = f.store.insert<Session>('sessions', {
    id: 'usage-conversation',
    revision: 1,
    project_id: f.project.id,
    runtime: adapter.name,
    device_id: 'local',
    state: 'open',
    turn_count: 0,
  });
  f.call('session.send', { session_id: session.id, input: 'Discuss the work' }, session.revision);
  await f.control.tick();
  return { store: f.store, call: f.call, control: f.control, start, send };
}

/** A worktree session whose first turn is running. */
async function worktreeSession() {
  const f = await workbenchFixture();
  const send = deliverOnly(f.adapter);
  const session = await f.create('Do the work');
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => send.mock.calls.length === 1,
    () => f.control.tick(),
  );
  return { store: f.store, call: f.call, control: f.control, start: f.start, send };
}

it.each([
  { role: 'planner', cost: false },
  { role: 'planner', cost: true },
  { role: 'writer', cost: false },
  { role: 'writer', cost: true },
])('persists final usage across two $role turns with cost=$cost', async ({ role, cost }) => {
  const { store, call, control, start, send } =
    role === 'writer' ? await worktreeSession() : await conversation();
  const initial = store.list<SessionTurn>('session_turns')[0]!;
  const current = () => store.must<Session>('sessions', initial.session_id);
  const second = call<SessionTurn>(
    'session.steer',
    { session_id: current().id, input: 'Continue the work' },
    current().revision,
  );
  await control.tick();
  const sink = start.mock.calls[0]![1];
  let sequence = 1;
  const usage = (
    turn: SessionTurn,
    input_tokens: number,
    output_tokens: number,
    cost_usd: number,
    cached_input_tokens: number,
  ) => ({
    key: `usage-${++sequence}`,
    provider_sequence: sequence,
    kind: 'usage.updated' as const,
    turn_id: turn.id,
    input_tokens,
    output_tokens,
    cached_input_tokens,
    context_tokens: input_tokens * 10,
    context_window: 200000,
    cost_source: cost ? ('provider_reported' as const) : ('unknown' as const),
    ...(cost ? { cost_usd } : {}),
  });
  const complete = (turn: SessionTurn) =>
    sink({
      key: `completed-${++sequence}`,
      provider_sequence: sequence,
      kind: 'turn.completed',
      turn_id: turn.id,
      status: 'completed',
    });
  sink(usage(initial, 10, 2, 0.125, 4));
  const final = usage(initial, 30, 6, 0.25, 12);
  sink(final);
  const beforeDuplicate = current();
  sink(final);
  expect(current()).toEqual(beforeDuplicate);
  complete(initial);
  await eventually(() => send.mock.calls.length === 2);
  sink(usage(second, 20, 4, 0.125, 8));
  sink(usage(second, 50, 10, 0.5, 40));
  complete(second);
  await eventually(() => store.must<SessionTurn>('session_turns', second.id).state === 'completed');
  const expected = {
    input_tokens: 80,
    output_tokens: 16,
    cached_input_tokens: 52,
    context_tokens: 500,
    context_window: 200000,
    cost_source: cost ? 'provider_reported' : 'unknown',
    ...(cost ? { cost_usd: 0.75 } : {}),
  };
  expect(current().usage).toEqual(expected);
  expect(store.must<SessionTurn>('session_turns', initial.id).usage).toEqual({
    input_tokens: 30,
    output_tokens: 6,
    cached_input_tokens: 12,
    context_tokens: 300,
    context_window: 200000,
    cost_source: expected.cost_source,
    ...(cost ? { cost_usd: 0.25 } : {}),
  });
  if (!cost) expect(current().usage?.cost_usd).toBeUndefined();

  const late: AgentEvent = {
    key: `late-${++sequence}`,
    provider_sequence: sequence,
    kind: 'usage.updated',
    turn_id: initial.id,
    input_tokens: 35,
    cost_source: 'estimated',
  };
  sink(late);
  const updated = { ...expected, input_tokens: 85, cost_source: 'estimated' };
  expect(current().usage).toEqual(updated);
});

it('marks a turn whose usage reports came without token counts until the counts arrive', async () => {
  const { store, control, start } = await conversation();
  const turn = store.list<SessionTurn>('session_turns')[0]!;
  await control.tick();
  const sink = start.mock.calls[0]![1];
  const stored = () => store.must<SessionTurn>('session_turns', turn.id).usage;
  const session = () => store.must<Session>('sessions', turn.session_id).usage;
  // As an ACP runtime reports: context and cost, no token counts.
  sink({
    key: 'context-only',
    provider_sequence: 1,
    kind: 'usage.updated',
    turn_id: turn.id,
    context_tokens: 1200,
    context_window: 200000,
    cost_usd: 0.5,
    cost_source: 'provider_reported',
  });
  expect(stored()).toMatchObject({
    input_tokens: 0,
    output_tokens: 0,
    tokens_unreported: true,
    context_tokens: 1200,
    context_window: 200000,
    cost_usd: 0.5,
  });
  expect(session()).toMatchObject({ tokens_unreported: true, cost_usd: 0.5 });
  sink({
    key: 'counts-later',
    provider_sequence: 2,
    kind: 'usage.updated',
    turn_id: turn.id,
    output_tokens: 7,
    cost_source: 'provider_reported',
  });
  expect(stored()).toMatchObject({ input_tokens: 0, output_tokens: 7, context_tokens: 1200 });
  expect(stored()?.tokens_unreported).toBeUndefined();
  expect(session()?.tokens_unreported).toBeUndefined();
  sink({
    key: 'context-after-counts',
    provider_sequence: 3,
    kind: 'usage.updated',
    turn_id: turn.id,
    context_tokens: 1500,
    cost_source: 'provider_reported',
  });
  expect(stored()).toMatchObject({ output_tokens: 7, context_tokens: 1500 });
  expect(stored()?.tokens_unreported).toBeUndefined();
});

it('keeps the latest context breakdown on turn usage and in the stored usage event payload', async () => {
  const { store, control, start } = await conversation();
  const turn = store.list<SessionTurn>('session_turns')[0]!;
  await control.tick();
  const sink = start.mock.calls[0]![1];
  const context_breakdown = {
    categories: [{ id: 'messages', tokens: 1200, kind: 'used' as const }],
    memory_files: [{ path: 'CLAUDE.md', tokens: 100 }],
    mcp_tools: [{ name: 'search', server: 'knowledge', tokens: 50, loaded: false }],
    agents: [{ type: 'reviewer', source: 'project', tokens: 30 }],
  };
  const event = {
    key: 'context-breakdown',
    provider_sequence: 1,
    kind: 'usage.updated' as const,
    turn_id: turn.id,
    input_tokens: 100,
    output_tokens: 20,
    context_tokens: 1200,
    context_window: 200000,
    context_breakdown,
    cost_source: 'unknown' as const,
  };
  sink(event);
  expect(store.must<SessionTurn>('session_turns', turn.id).usage).toMatchObject({
    context_tokens: 1200,
    context_window: 200000,
    context_breakdown,
  });
  expect(store.kindEvents(turn.project_id, ['agent.usage.updated']).at(-1)?.payload).toMatchObject({
    turn_id: turn.id,
    context_tokens: 1200,
    context_window: 200000,
    context_breakdown,
  });
  const latest = { ...context_breakdown, categories: [] };
  sink({
    ...event,
    key: 'latest-context-breakdown',
    provider_sequence: 2,
    context_breakdown: latest,
  });
  expect(store.must<SessionTurn>('session_turns', turn.id).usage).toMatchObject({
    context_breakdown: latest,
  });
  sink({
    key: 'counts-after-breakdown',
    provider_sequence: 3,
    kind: 'usage.updated',
    turn_id: turn.id,
    output_tokens: 30,
    cost_source: 'unknown',
  });
  expect(store.must<SessionTurn>('session_turns', turn.id).usage).toMatchObject({
    output_tokens: 30,
    context_breakdown: latest,
  });
});
