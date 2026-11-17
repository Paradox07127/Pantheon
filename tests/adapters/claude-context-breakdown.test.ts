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
});

function sessionSpec(): SessionSpec {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pantheon-context-')));
  roots.push(root);
  return {
    platform_session_id: 'context-session',
    project_id: 'context-project',
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

function fakeClaude() {
  const inputs: SDKUserMessage[] = [];
  const output: unknown[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  const getContextUsage = vi.fn();
  const queryFn = vi.fn(
    ({ prompt }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      void (async () => {
        for await (const message of prompt) inputs.push(message);
      })();
      return {
        initializationResult: async () => ({
          account: { apiProvider: 'firstParty', subscriptionType: 'max' },
        }),
        getContextUsage,
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
    getContextUsage,
    push(message: unknown) {
      output.push(message);
      wake?.();
    },
  };
}

const result = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0 },
  modelUsage: {},
};
const categories = [
  { id: 'system_prompt', tokens: 120, kind: 'used' },
  { id: 'system_tools', tokens: 200, kind: 'used' },
  { id: 'mcp_tools', tokens: 30, kind: 'used' },
  { id: 'custom_agents', tokens: 40, kind: 'used' },
  { id: 'memory_files', tokens: 50, kind: 'used' },
  { id: 'skills', tokens: 60, kind: 'used' },
  { id: 'messages', tokens: 700, kind: 'used' },
  { id: 'autocompact_buffer', tokens: 33000, kind: 'buffer' },
  { id: 'free_space', tokens: 165800, kind: 'free' },
  { id: 'mcp_tools_deferred', tokens: 90, kind: 'deferred' },
  { id: 'system_tools_deferred', tokens: 80, kind: 'deferred' },
];
const contextUsage = {
  categories: [
    ...categories.map((row) => ({ ...row, name: 'Display name', color: 'blue' })),
    { name: 'Legacy row', tokens: 10, color: 'red', kind: 'used' },
  ],
  memoryFiles: [{ path: '../private/CLAUDE.md', type: 'project', tokens: 50, content: 'private' }],
  mcpTools: [
    { name: 'search', serverName: 'knowledge', tokens: 30, isLoaded: true, description: 'private' },
    { name: 'fetch', serverName: 'knowledge', tokens: 90, isLoaded: false },
  ],
  agents: [{ agentType: 'reviewer', source: 'project', tokens: 40, description: 'private' }],
  totalTokens: 1200,
  maxTokens: 200000,
  rawMaxTokens: 200000,
  percentage: 0.6,
  gridRows: [],
  model: 'claude-model',
  isAutoCompactEnabled: true,
  autoCompactThreshold: 167000,
  errors: ['private'],
};

it('reads only final turn usage and maps ordered context rows without SDK display or private data', async () => {
  const f = fakeClaude();
  const events: AgentEvent[] = [];
  f.getContextUsage.mockResolvedValue(contextUsage);
  const handle = await f.adapter.start(sessionSpec(), (event) => events.push(event));
  cleanup.push(() => f.adapter.close(handle, Date.now() + 1000));
  await f.adapter.send(handle, { turn_id: 'context-turn', input: 'Work' });
  await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
  expect(f.getContextUsage).not.toHaveBeenCalled();
  f.push({ ...result, queued_turn_count: 1 });
  await f.adapter.steer(handle, { turn_id: 'context-turn', input: 'Continue' });
  await vi.waitFor(() => expect(f.inputs).toHaveLength(2));
  expect(f.getContextUsage).not.toHaveBeenCalled();
  f.push(result);
  await vi.waitFor(() =>
    expect(events.filter((event) => event.kind === 'turn.completed')).toHaveLength(1),
  );
  const usage = events.find((event) => event.kind === 'usage.updated');
  expect(usage?.turn_id).toBe('context-turn');
  expect(usage).toHaveProperty('auto_compact_at_tokens', 167000);
  expect(usage?.context_breakdown).toEqual({
    categories,
    memory_files: [{ path: '../private/CLAUDE.md', tokens: 50 }],
    mcp_tools: [
      { name: 'search', server: 'knowledge', tokens: 30, loaded: true },
      { name: 'fetch', server: 'knowledge', tokens: 90, loaded: false },
    ],
    agents: [{ type: 'reviewer', source: 'project', tokens: 40 }],
  });
  expect(f.getContextUsage).toHaveBeenCalledExactlyOnceWith({ detail: 'summary' });

  f.getContextUsage.mockResolvedValue({
    ...contextUsage,
    categories: [],
    isAutoCompactEnabled: false,
  });
  await f.adapter.send(handle, { turn_id: 'next-context-turn', input: 'More work' });
  await vi.waitFor(() => expect(f.inputs).toHaveLength(3));
  f.push(result);
  await vi.waitFor(() =>
    expect(events.filter((event) => event.kind === 'turn.completed')).toHaveLength(2),
  );
  expect(
    events.find((event) => event.kind === 'usage.updated' && event.turn_id === 'next-context-turn'),
  ).toMatchObject({ context_breakdown: { categories: [] } });
  expect(
    events.find((event) => event.kind === 'usage.updated' && event.turn_id === 'next-context-turn'),
  ).not.toHaveProperty('auto_compact_at_tokens');
  expect(f.getContextUsage).toHaveBeenCalledTimes(2);
});

const opusUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  webSearchRequests: 0,
  costUSD: 0,
  contextWindow: 1000000,
  maxOutputTokens: 64000,
};

it("reports the window Claude Code applies, not the model's own, once the live read answers", async () => {
  const f = fakeClaude();
  const events: AgentEvent[] = [];
  f.getContextUsage.mockResolvedValue({ ...contextUsage, maxTokens: 500000, rawMaxTokens: 500000 });
  const handle = await f.adapter.start(sessionSpec(), (event) => events.push(event));
  cleanup.push(() => f.adapter.close(handle, Date.now() + 1000));
  await f.adapter.send(handle, { turn_id: 'window-turn', input: 'Work' });
  await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
  f.push({ ...result, modelUsage: { 'claude-opus': opusUsage } });
  await vi.waitFor(() =>
    expect(events.filter((event) => event.kind === 'turn.completed')).toHaveLength(1),
  );
  expect(events.find((event) => event.kind === 'usage.updated')).toHaveProperty(
    'context_window',
    500000,
  );

  f.getContextUsage.mockRejectedValue(new Error('read failed'));
  await f.adapter.send(handle, { turn_id: 'unread-window-turn', input: 'More work' });
  await vi.waitFor(() => expect(f.inputs).toHaveLength(2));
  f.push({ ...result, modelUsage: { 'claude-opus': opusUsage } });
  await vi.waitFor(() =>
    expect(events.filter((event) => event.kind === 'turn.completed')).toHaveLength(2),
  );
  expect(
    events.find(
      (event) => event.kind === 'usage.updated' && event.turn_id === 'unread-window-turn',
    ),
  ).toHaveProperty('context_window', 1000000);
});

const assistant = (id: string, input: number, cacheRead: number, cacheWrite: number) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: {
    id,
    content: [{ type: 'text', text: id }],
    usage: {
      input_tokens: input,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheWrite,
      output_tokens: 7,
    },
  },
});

it('reports the context of each assistant message while the turn runs, the turn totals at its end', async () => {
  const f = fakeClaude();
  const events: AgentEvent[] = [];
  f.getContextUsage.mockResolvedValue(contextUsage);
  const handle = await f.adapter.start(sessionSpec(), (event) => events.push(event));
  cleanup.push(() => f.adapter.close(handle, Date.now() + 1000));
  const usageOf = (turn_id: string) =>
    events.filter((event) => event.kind === 'usage.updated' && event.turn_id === turn_id);
  await f.adapter.send(handle, { turn_id: 'live-context-turn', input: 'Work' });
  await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
  f.push(assistant('first-message', 10, 100, 5));
  await vi.waitFor(() => expect(usageOf('live-context-turn')).toHaveLength(1));
  // The SDK repeats a message once per content block; its context is reported once.
  f.push(assistant('first-message', 10, 100, 5));
  f.push(assistant('second-message', 20, 180, 30));
  await vi.waitFor(() => expect(usageOf('live-context-turn')).toHaveLength(2));
  expect(events.filter((event) => event.kind === 'turn.completed')).toEqual([]);
  // The session's first turn reads the window once before it reports.
  expect(usageOf('live-context-turn').map(({ key, provider_sequence, ...event }) => event)).toEqual(
    [
      {
        turn_id: 'live-context-turn',
        kind: 'usage.updated',
        auto_compact_at_tokens: 167000,
        context_tokens: 115,
        context_window: 200000,
        cost_source: 'unknown',
        native_type: 'assistant',
      },
      {
        turn_id: 'live-context-turn',
        kind: 'usage.updated',
        auto_compact_at_tokens: 167000,
        context_tokens: 230,
        context_window: 200000,
        cost_source: 'unknown',
        native_type: 'assistant',
      },
    ],
  );
  f.push({
    ...result,
    total_cost_usd: 0.4,
    modelUsage: {
      'claude-opus': {
        ...opusUsage,
        inputTokens: 30,
        outputTokens: 14,
        cacheReadInputTokens: 280,
        cacheCreationInputTokens: 35,
      },
    },
  });
  await vi.waitFor(() =>
    expect(events.filter((event) => event.kind === 'turn.completed')).toHaveLength(1),
  );
  expect(usageOf('live-context-turn')).toHaveLength(3);
  expect(usageOf('live-context-turn')[2]).toMatchObject({
    input_tokens: 345,
    cached_input_tokens: 280,
    cache_write_input_tokens: 35,
    output_tokens: 14,
    cost_usd: 0.4,
    cost_source: 'estimated',
    context_tokens: 230,
    context_window: 200000,
    auto_compact_at_tokens: 167000,
    native_type: 'result',
  });

  await f.adapter.send(handle, { turn_id: 'known-window-turn', input: 'More work' });
  await vi.waitFor(() => expect(f.inputs).toHaveLength(2));
  f.push(assistant('third-message', 5, 250, 10));
  await vi.waitFor(() => expect(usageOf('known-window-turn')).toHaveLength(1));
  expect(usageOf('known-window-turn')[0]).toEqual({
    key: expect.any(String),
    provider_sequence: expect.any(Number),
    turn_id: 'known-window-turn',
    kind: 'usage.updated',
    context_tokens: 265,
    context_window: 200000,
    auto_compact_at_tokens: 167000,
    cost_source: 'unknown',
    native_type: 'assistant',
  });
});

it('reports usage and completes the turn when the live context read fails without retrying', async () => {
  const f = fakeClaude();
  const events: AgentEvent[] = [];
  f.getContextUsage.mockRejectedValue(new Error('private SDK failure'));
  const handle = await f.adapter.start(sessionSpec(), (event) => events.push(event));
  cleanup.push(() => f.adapter.close(handle, Date.now() + 1000));
  await f.adapter.send(handle, { turn_id: 'unavailable-context-turn', input: 'Work' });
  await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
  f.push(result);
  await vi.waitFor(() =>
    expect(events.filter((event) => event.kind === 'turn.completed')).toHaveLength(1),
  );
  expect(f.getContextUsage).toHaveBeenCalledExactlyOnceWith({ detail: 'summary' });
  expect(events.find((event) => event.kind === 'usage.updated')).not.toHaveProperty(
    'context_breakdown',
  );
  expect(events.at(-1)).toMatchObject({ kind: 'turn.completed', status: 'completed' });
  expect(JSON.stringify(events)).not.toContain('private SDK failure');
});
