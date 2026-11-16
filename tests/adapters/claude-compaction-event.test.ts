import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  Options,
  SDKUserMessage,
} from '../../packages/adapters/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts';
import { ClaudeAdapter } from '../../packages/adapters/src/claude.js';
import { NATIVE_ENV_ALLOWLIST, type AgentEvent, type SessionSpec } from '@pantheon/domain';

const roots: string[] = [];
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function sessionSpec(): SessionSpec {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pantheon-compaction-')));
  roots.push(root);
  return {
    platform_session_id: 'compaction-session',
    project_id: 'compaction-project',
    runtime: 'claude',
    device_id: 'local',
    role: 'writer',
    cwd: root,
    env_allowlist: NATIVE_ENV_ALLOWLIST,
    skills: [],
    mcp_servers: [],
    budget: { max_turns: 1, wall_time_ms: 10000 },
  };
}

/** A fake SDK query whose output messages the test pushes. */
function fakeClaude() {
  const inputs: SDKUserMessage[] = [];
  const output: unknown[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  const push = (message: unknown) => {
    output.push(message);
    wake?.();
  };
  const queryFn = vi.fn(
    ({ prompt }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      void (async () => {
        for await (const message of prompt) inputs.push(message);
      })();
      return {
        initializationResult: async () => ({
          account: { apiProvider: 'firstParty', subscriptionType: 'max' },
        }),
        close() {
          done = true;
          wake?.();
        },
        async interrupt() {},
        async *[Symbol.asyncIterator]() {
          for (;;) {
            if (output.length) {
              yield output.shift();
              continue;
            }
            if (done) return;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = undefined;
          }
        },
      };
    },
  );
  return {
    adapter: new ClaudeAdapter('fake-claude', 'test', queryFn as never),
    inputs,
    push,
    queryFn,
  };
}

it('records a compact_boundary system message as a context compaction event with its trigger and token count', async () => {
  const f = fakeClaude();
  const events: AgentEvent[] = [];
  const handle = await f.adapter.start(sessionSpec(), (event) => events.push(event));
  cleanup.push(() => f.adapter.close(handle, Date.now() + 1000));
  await f.adapter.send(handle, { turn_id: 'compacting-turn', input: 'Work' });
  await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
  for (const message of [
    {
      type: 'system',
      subtype: 'init',
      session_id: 'native-compaction',
      model: 'claude-model',
      tools: [],
      mcp_servers: [],
      skills: [],
    },
    {
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 180000 },
      uuid: 'compact-boundary',
      session_id: 'native-compaction',
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
    },
  ])
    f.push(message);
  await vi.waitFor(() =>
    expect(events.filter((event) => event.kind === 'turn.completed')).toHaveLength(1),
  );
  expect(events.filter((event) => event.kind === 'context.compacted')).toEqual([
    expect.objectContaining({
      turn_id: 'compacting-turn',
      kind: 'context.compacted',
      trigger: 'auto',
      pre_tokens: 180000,
    }),
  ]);
});

it('passes fast mode state and the runtime reason code through', async () => {
  const f = fakeClaude();
  const events: AgentEvent[] = [];
  const handle = await f.adapter.start(sessionSpec(), (event) => events.push(event));
  cleanup.push(() => f.adapter.close(handle, Date.now() + 1000));
  await f.adapter.send(handle, { turn_id: 'fast-turn', input: 'Work' });
  await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
  f.push({
    type: 'system',
    subtype: 'status',
    status: null,
    fast_mode_state: 'cooldown',
    fast_mode_disabled_reason: 'extra_usage_disabled',
  });
  await vi.waitFor(() =>
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'fast_mode.changed',
        state: 'cooldown',
        reason: 'extra_usage_disabled',
      }),
    ),
  );
  f.push({ type: 'system', subtype: 'status', status: null, fast_mode_state: 'on' });
  await vi.waitFor(() =>
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'fast_mode.changed', state: 'on' }),
    ),
  );
  // Every status and result message repeats the state; only a change is an event.
  f.push({ type: 'system', subtype: 'status', status: null, fast_mode_state: 'on' });
  f.push({ type: 'system', subtype: 'status', status: null, fast_mode_state: 'off' });
  await vi.waitFor(() =>
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'fast_mode.changed', state: 'off' }),
    ),
  );
  expect(
    events.filter((event) => event.kind === 'fast_mode.changed').map((event) => event.state),
  ).toEqual(['cooldown', 'on', 'off']);
});

it.each([undefined, 'Keep the plan'])(
  'sends a manual slash prompt on the resumed query with instructions %s',
  async (instructions) => {
    const f = fakeClaude();
    const events: AgentEvent[] = [];
    const handle = await f.adapter.resume(sessionSpec(), 'native-compaction', (event) =>
      events.push(event),
    );
    cleanup.push(() => f.adapter.close(handle, Date.now() + 1000));
    await f.adapter.send(handle, {
      turn_id: 'manual-turn',
      input: instructions ?? '',
      compact: true,
    });
    await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
    expect(f.inputs[0]!.message.content).toBe(
      instructions ? `/compact ${instructions}` : '/compact',
    );
    expect(f.queryFn.mock.calls[0]![0].options.resume).toBe('native-compaction');
    f.push({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'manual', pre_tokens: 180000 },
      uuid: 'manual-boundary',
      session_id: 'native-compaction',
    });
    f.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
    });
    await vi.waitFor(() =>
      expect(events.filter((event) => event.kind === 'turn.completed')).toHaveLength(1),
    );
    expect(events.filter((event) => event.kind === 'context.compacted')).toEqual([
      expect.objectContaining({ turn_id: 'manual-turn', trigger: 'manual' }),
    ]);
    expect((await f.adapter.inspect(handle)).state).toBe('idle');
  },
);

it('ends a failed manual compaction and accepts the next input on the session', async () => {
  const f = fakeClaude();
  const events: AgentEvent[] = [];
  const handle = await f.adapter.resume(sessionSpec(), 'native-compaction', (event) =>
    events.push(event),
  );
  cleanup.push(() => f.adapter.close(handle, Date.now() + 1000));
  await f.adapter.send(handle, { turn_id: 'failed-compact', input: '', compact: true });
  await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
  f.push({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: ['Compaction failed'],
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
  });
  await vi.waitFor(() =>
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'turn.completed',
        turn_id: 'failed-compact',
        status: 'failed',
      }),
    ),
  );
  expect(events.filter((event) => event.kind === 'context.compacted')).toHaveLength(0);
  expect(await f.adapter.send(handle, { turn_id: 'next-turn', input: 'Continue' })).toMatchObject({
    status: 'delivered',
  });
  await vi.waitFor(() => expect(f.inputs).toHaveLength(2));
  expect(f.inputs[1]!.message.content).toBe('Continue');
  f.push({
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
  });
  await vi.waitFor(() =>
    expect(events.filter((event) => event.kind === 'turn.completed')).toHaveLength(2),
  );
});

it.each([
  { error_status: 429, error: 'rate_limit', reason: 'rate_limit' },
  { error_status: 529, error: 'server_error', reason: 'overloaded' },
  { error_status: null, error: 'unknown', reason: 'network' },
])('reports an API retry with the runtime attempt and delay: $reason', async (fields) => {
  const f = fakeClaude();
  const events: AgentEvent[] = [];
  const handle = await f.adapter.start(sessionSpec(), (event) => events.push(event));
  cleanup.push(() => f.adapter.close(handle, Date.now() + 1000));
  await f.adapter.send(handle, { turn_id: 'retry-turn', input: 'Work' });
  await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  f.push({
    type: 'system',
    subtype: 'api_retry',
    attempt: 2,
    max_retries: 10,
    retry_delay_ms: 1500,
    error_status: fields.error_status,
    error: fields.error,
  });
  await vi.waitFor(() =>
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'turn.retrying',
        turn_id: 'retry-turn',
        attempt: 2,
        retry_at: now + 1500,
        reason: fields.reason,
      }),
    ),
  );
  vi.restoreAllMocks();
});

it.each([false, true])(
  'reports a compaction start only after the runtime status, manual: %s',
  async (manual) => {
    const f = fakeClaude();
    const events: AgentEvent[] = [];
    const handle = await f.adapter.start(sessionSpec(), (event) => events.push(event));
    cleanup.push(() => f.adapter.close(handle, Date.now() + 1000));
    await f.adapter.send(handle, {
      turn_id: 'starting-compaction',
      input: '',
      ...(manual ? { compact: true } : {}),
    });
    await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
    expect(events.some((event) => event.kind === 'context.compacting')).toBe(false);
    f.push({ type: 'system', subtype: 'status', status: 'compacting' });
    f.push({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: manual ? 'manual' : 'auto', pre_tokens: 180000 },
    });
    await vi.waitFor(() =>
      expect(
        events.filter((event) => event.kind.startsWith('context.')).map((event) => event.kind),
      ).toEqual(['context.compacting', 'context.compacted']),
    );
    expect(events.find((event) => event.kind === 'context.compacting')).toMatchObject({
      turn_id: 'starting-compaction',
      trigger: manual ? 'manual' : 'auto',
    });
  },
);

it('resumes a native fork at its exact message boundary and records the last main-thread message', async () => {
  const f = fakeClaude();
  const events: AgentEvent[] = [];
  const handle = await f.adapter.start(
    { ...sessionSpec(), native_fork: { session_id: 'source-native', after: 'kept-message' } },
    (event) => events.push(event),
  );
  cleanup.push(() => f.adapter.close(handle, Date.now() + 1000));
  expect(f.queryFn.mock.calls[0]![0].options).toMatchObject({
    resume: 'source-native',
    resumeSessionAt: 'kept-message',
    forkSession: true,
  });
  await f.adapter.send(handle, { turn_id: 'fork-turn', input: 'Continue' });
  await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
  f.push({
    type: 'assistant',
    uuid: 'tool-message',
    request_id: 'model-request',
    parent_tool_use_id: null,
    message: {
      id: 'model-message',
      content: [
        { type: 'tool_use', id: 'tool-call', name: 'Read', input: { file_path: 'answer.txt' } },
      ],
    },
  });
  f.push({
    type: 'assistant',
    uuid: 'last-message',
    parent_tool_use_id: null,
    message: { id: 'last-model-message', content: [{ type: 'text', text: 'Done' }] },
  });
  f.push({
    type: 'assistant',
    uuid: 'subagent-message',
    parent_tool_use_id: 'agent-call',
    message: { id: 'subagent-model-message', content: [] },
  });
  f.push({
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
  });
  await vi.waitFor(() =>
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'turn.completed', native_history_end: 'last-message' }),
    ),
  );
  expect(events.find((event) => event.kind === 'tool.started')).toMatchObject({
    native_history_before: f.inputs[0]!.uuid,
  });
});
