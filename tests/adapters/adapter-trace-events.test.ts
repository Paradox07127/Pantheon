import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAdapter, CodexAdapter, FixtureAdapter } from '@pantheon/adapters';
import { NATIVE_ENV_ALLOWLIST, type AgentEvent, type SessionSpec } from '@pantheon/domain';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

const spec = (runtime: string): SessionSpec => ({
  platform_session_id: 'trace-session',
  project_id: 'trace-project',
  runtime,
  device_id: 'local',
  role: 'writer',
  cwd: process.cwd(),
  env_allowlist: NATIVE_ENV_ALLOWLIST,
  skills: [],
  mcp_servers: [],
  budget: { max_turns: 4, wall_time_ms: 10000 },
});
const turn = (turn_id = 'trace-turn', input = '') => ({
  turn_id,
  input,
});
function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  return child;
}
type Frame = { method: string; params?: Record<string, unknown> };
function itemFrames(item: Record<string, unknown>): Frame[] {
  return [
    { method: 'item/started', params: { item: { ...item, status: 'inProgress' } } },
    { method: 'item/completed', params: { item } },
  ];
}
async function codexTurns(turns: Frame[][]): Promise<AgentEvent[]> {
  const child = fakeChild(),
    events: AgentEvent[] = [];
  const send = (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n');
  let index = 0;
  child.stdin.on('data', (data) => {
    const request = JSON.parse(String(data));
    if (request.method === 'initialize') send({ id: request.id, result: {} });
    if (request.method === 'account/read')
      send({ id: request.id, result: { account: { type: 'chatgpt', planType: 'plus' } } });
    if (request.method === 'config/read')
      send({ id: request.id, result: { config: { model_provider: 'openai' } } });
    if (request.method === 'thread/name/set') send({ id: request.id, result: {} });
    if (request.method === 'thread/start')
      send({ id: request.id, result: { thread: { id: 'trace-thread' } } });
    if (request.method === 'turn/start') {
      const id = `native-turn-${index}`;
      // Notifications may arrive before the turn/start response.
      for (const frame of turns[index++]!)
        send({
          ...frame,
          params: { threadId: 'trace-thread', turnId: id, ...frame.params },
        });
      send({ id: request.id, result: { turn: { id } } });
      const completed = {
        method: 'turn/completed',
        params: { threadId: 'trace-thread', turn: { id, status: 'completed' } },
      };
      send(completed);
      send(completed);
    }
  });
  const adapter = new CodexAdapter('fake-codex');
  const handle = await adapter.start(spec('codex'), (event) => events.push(event));
  try {
    for (let i = 0; i < turns.length; i++) {
      await adapter.send(handle, turn(`trace-turn-${i}`));
      expect(events.at(-1)).toMatchObject({ kind: 'turn.completed', status: 'completed' });
    }
    expect(events.map((event) => event.provider_sequence)).toEqual(events.map((_, i) => i + 1));
    expect(new Set(events.map((event) => event.key)).size).toBe(events.length);
    return events;
  } finally {
    child.emit('close', 0, null);
    await adapter.close(handle, Date.now() + 1000);
  }
}
/** last: the latest model request; total: the whole thread so far, as Codex reports them. */
const tokenFrame = (
  last: [input: number, output: number],
  total: [input: number, output: number],
  cached: [last: number, total: number] = [8, 800],
): Frame => ({
  method: 'thread/tokenUsage/updated',
  params: {
    tokenUsage: {
      last: {
        inputTokens: last[0],
        outputTokens: last[1],
        cachedInputTokens: cached[0],
        reasoningOutputTokens: 2,
      },
      total: { inputTokens: total[0], outputTokens: total[1], cachedInputTokens: cached[1] },
    },
  },
});

describe('Codex trace events', () => {
  it('sums every request of a turn once, without leaking counts across turns', async () => {
    const foreign = tokenFrame([700, 800], [9700, 9800]);
    const events = await codexTurns([
      [
        tokenFrame([10, 2], [1010, 102]),
        tokenFrame([120, 30], [1130, 132]),
        { ...foreign, params: { ...foreign.params, threadId: 'another-thread' } },
        { ...foreign, params: { ...foreign.params, turnId: 'unknown-turn' } },
      ],
      [{ ...foreign, params: { ...foreign.params, turnId: 'native-turn-0' } }],
      [tokenFrame([0, 0], [1130, 132])],
    ]);
    const usage = events.filter((event) => event.kind === 'usage.updated');
    expect(usage).toHaveLength(3);
    expect(usage[0]).toMatchObject({
      turn_id: 'trace-turn-0',
      input_tokens: 130,
      output_tokens: 32,
      cost_source: 'unknown',
    });
    expect(usage[1]?.input_tokens).toBeUndefined();
    expect(usage[1]?.output_tokens).toBeUndefined();
    expect(usage[2]).toMatchObject({ input_tokens: 0, output_tokens: 0 });
    for (const event of usage) expect(event.cost_usd).toBeUndefined();
    expect(
      events.some(
        (event) => event.kind === 'native' && event.native_type === 'thread/tokenUsage/updated',
      ),
    ).toBe(true);
  });

  it('reports the cached input of each turn as the difference of thread totals', async () => {
    const events = await codexTurns([
      [tokenFrame([10, 2], [1010, 102], [6, 600]), tokenFrame([120, 30], [1130, 132], [100, 700])],
      [tokenFrame([5, 1], [1135, 133], [4, 704])],
    ]);
    const usage = events.filter((event) => event.kind === 'usage.updated');
    expect(usage[0]).toMatchObject({ input_tokens: 130, cached_input_tokens: 106 });
    expect(usage[1]).toMatchObject({ input_tokens: 5, cached_input_tokens: 4 });
  });

  it('reports the latest request as context occupancy against the model window', async () => {
    const withContext = (frame: Frame, totalTokens: number, window: number | null): Frame => {
      const tokenUsage = frame.params!.tokenUsage as { last: object; total: object };
      return {
        ...frame,
        params: {
          tokenUsage: {
            ...tokenUsage,
            last: { ...tokenUsage.last, totalTokens },
            modelContextWindow: window,
          },
        },
      };
    };
    const events = await codexTurns([
      [
        withContext(tokenFrame([10, 2], [1010, 102]), 12, 258000),
        withContext(tokenFrame([120, 30], [1130, 132]), 150, 258000),
      ],
      [withContext(tokenFrame([5, 1], [1135, 133]), 6, null)],
    ]);
    const usage = events.filter((event) => event.kind === 'usage.updated');
    expect(usage[0]).toMatchObject({ context_tokens: 150, context_window: 258000 });
    expect(usage[1]).toMatchObject({ context_tokens: 6 });
    expect(usage[1]?.context_window).toBeUndefined();
  });

  it.each(['completed', 'failed', 'declined', 'inProgress'])(
    'maps command lifecycle events with status %s and preserves non-tool items',
    async (status) => {
      const nonTools = [
        'agentMessage',
        'userMessage',
        'reasoning',
        'plan',
        'subAgentActivity',
        'functionCallOutput',
      ];
      const events = await codexTurns([
        [
          ...itemFrames({
            id: 'command-call',
            type: 'commandExecution',
            command: 'cat example.txt',
            cwd: '/workspace',
            status,
            exitCode: status === 'completed' ? 0 : 1,
            aggregatedOutput: 'command result',
          }),
          ...nonTools.flatMap((type) => itemFrames({ id: type, type, text: 'message' })),
        ],
      ]);
      expect(events.filter((event) => event.kind === 'tool.started')).toEqual([
        expect.objectContaining({
          tool_call_id: 'command-call',
          name: 'commandExecution',
          input: { command: 'cat example.txt', cwd: '/workspace' },
          turn_id: 'trace-turn-0',
          native_type: 'item/started',
        }),
      ]);
      expect(events.filter((event) => event.kind === 'tool.completed')).toEqual([
        expect.objectContaining({
          tool_call_id: 'command-call',
          ok: status === 'completed',
          output: expect.objectContaining({ text: 'command result' }),
          turn_id: 'trace-turn-0',
          native_type: 'item/completed',
        }),
      ]);
      expect(events.filter((event) => event.kind === 'native')).toHaveLength(nonTools.length * 2);
    },
  );

  it('names MCP calls and bounds nested input and output strings without mutating messages', async () => {
    const long = 'x'.repeat(4097),
      exact = 'y'.repeat(4096);
    const call = {
      id: 'mcp-call',
      type: 'mcpToolCall',
      server: 'files',
      tool: 'read',
      arguments: { paths: [long], exact },
      status: 'completed',
      result: { content: [{ type: 'text', text: long }] },
    };
    const events = await codexTurns([itemFrames(call)]);
    expect(events.find((event) => event.kind === 'tool.started')).toMatchObject({
      name: 'files.read',
      tool_call_id: 'mcp-call',
      input: {
        server: 'files',
        tool: 'read',
        arguments: { paths: [long.slice(0, 4096)], exact },
        truncated: true,
      },
    });
    expect(events.find((event) => event.kind === 'tool.completed')).toMatchObject({
      ok: true,
      output: { result: { content: [{ text: long.slice(0, 4096) }] }, truncated: true },
    });
    expect(call.result.content[0]?.text).toBe(long);
  });

  it('caps command text and maps the remaining tool types conservatively', async () => {
    const long = 'z'.repeat(5000);
    const cases = [
      {
        type: 'commandExecution',
        command: long,
        aggregatedOutput: long,
        status: 'completed',
        exitCode: 1,
      },
      {
        type: 'fileChange',
        changes: [{ path: 'file.txt', kind: { type: 'update' }, diff: long }],
        status: 'completed',
      },
      {
        type: 'mcpToolCall',
        server: 'files',
        tool: 'read',
        arguments: {},
        status: 'failed',
        error: { message: long },
      },
      {
        type: 'dynamicToolCall',
        tool: 'lookup',
        arguments: { query: 'example' },
        contentItems: [{ type: 'inputText', text: 'found' }],
        status: 'completed',
        success: true,
      },
      {
        type: 'dynamicToolCall',
        tool: 'lookup',
        arguments: {},
        status: 'completed',
        success: false,
      },
      {
        type: 'collabAgentToolCall',
        tool: 'spawnAgent',
        prompt: 'inspect',
        receiverThreadIds: ['child-thread'],
        status: 'completed',
        agentsStates: {},
      },
      { type: 'webSearch', query: 'example', results: [{ title: 'Example' }] },
      { type: 'imageView', path: 'image.png' },
      { type: 'sleep', durationMs: 20 },
      {
        type: 'imageGeneration',
        revisedPrompt: 'a tree',
        status: 'completed',
        savedPath: 'tree.png',
      },
      { type: 'imageGeneration', status: 'failed', failure: { message: 'unavailable' } },
    ];
    const events = await codexTurns([
      cases.flatMap((item, i) => itemFrames({ ...item, id: `tool-${i}` })),
    ]);
    const started = events.filter((event) => event.kind === 'tool.started');
    const completed = events.filter((event) => event.kind === 'tool.completed');
    expect(started.map((event) => event.name)).toEqual(
      cases.map((item) => (item.type === 'mcpToolCall' ? 'files.read' : item.type)),
    );
    expect(completed.map((event) => event.ok)).toEqual([
      false,
      true,
      false,
      true,
      false,
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(started[0]?.input).toMatchObject({ command: long.slice(0, 4096), truncated: true });
    expect(completed[0]?.output).toMatchObject({ text: long.slice(0, 4096), truncated: true });
    expect(started[1]?.input).toMatchObject({
      changes: [{ path: 'file.txt', diff: long.slice(0, 4096) }],
      truncated: true,
    });
    expect(started[3]?.input).toMatchObject({ tool: 'lookup', arguments: { query: 'example' } });
    expect(started[6]?.input).toMatchObject({ query: 'example' });
    expect(started[7]?.input).toMatchObject({ path: 'image.png' });
    expect(started[8]?.input).toMatchObject({ durationMs: 20 });
    expect(completed[9]?.output).toMatchObject({ savedPath: 'tree.png' });
    expect(events.some((event) => event.kind === 'native')).toBe(false);
  });

  it('carries a generated image whole beside its traced output, and leaves one past the limit out', async () => {
    const image = 'iVBORw0KGgo' + 'A'.repeat(6000);
    const events = await codexTurns([
      [
        ...itemFrames({ id: 'drawn', type: 'imageGeneration', status: 'completed', result: image }),
        ...itemFrames({
          id: 'huge',
          type: 'imageGeneration',
          status: 'completed',
          result: 'A'.repeat(4 * 1024 * 1024 + 1),
        }),
      ],
    ]);
    const completed = events.filter((event) => event.kind === 'tool.completed');
    expect(completed[0]).toMatchObject({ images: [{ mime: 'image/png', data: image }] });
    expect(completed[0]?.output).toMatchObject({ truncated: true });
    expect(completed[1]).not.toHaveProperty('images');
  });
});

async function claudeMessages(messages: unknown[]): Promise<AgentEvent[]> {
  vi.mocked(query).mockImplementation(
    ({ prompt }) =>
      ({
        async initializationResult() {
          return { account: { subscriptionType: 'max', apiProvider: 'firstParty' } };
        },
        close() {},
        async *[Symbol.asyncIterator]() {
          if (typeof prompt !== 'string') {
            const input = await prompt[Symbol.asyncIterator]().next();
            expect(input.done).toBe(false);
          }
          yield* messages;
        },
      }) as ReturnType<typeof query>,
  );
  const events: AgentEvent[] = [];
  let completed!: () => void;
  const done = new Promise<void>((resolve) => {
    completed = resolve;
  });
  const adapter = new ClaudeAdapter('fake-claude');
  const handle = await adapter.start(spec('claude'), (event) => {
    events.push(event);
    if (event.kind === 'turn.completed') completed();
  });
  try {
    await adapter.send(handle, turn());
    await done;
    expect(events.map((event) => event.provider_sequence)).toEqual(events.map((_, i) => i + 1));
    return events;
  } finally {
    await adapter.close(handle, Date.now() + 1000);
  }
}
const result = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  total_cost_usd: 0.12,
  usage: {
    input_tokens: 10,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 30,
    output_tokens: 7,
  },
  // Token totals come from modelUsage, which also counts subagents and compaction.
  modelUsage: {
    'claude-model': {
      inputTokens: 10,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 30,
      outputTokens: 7,
      contextWindow: 200000,
      costUSD: 0.12,
    },
  },
};
describe('Claude trace events', () => {
  it('maps all tool blocks, errors and nested payloads while preserving text', async () => {
    const long = 'x'.repeat(5000),
      exact = 'y'.repeat(4096);
    const messages = [
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'read-call',
              name: 'Read',
              input: { path: 'file.txt', nested: { values: [long] } },
            },
            { type: 'text', text: 'reading' },
            { type: 'tool_use', id: 'failed-call', name: 'Read', input: { path: exact } },
          ],
        },
      },
      { type: 'user', message: { content: 'ordinary user text' } },
      {
        type: 'user',
        message: {
          content: [
            { type: 'text', text: 'context' },
            {
              type: 'tool_result',
              tool_use_id: 'read-call',
              content: [{ type: 'text', text: long }],
            },
            { type: 'tool_result', tool_use_id: 'failed-call', is_error: true, content: long },
          ],
        },
      },
      result,
    ];
    const events = await claudeMessages(messages);
    const started = events.filter((event) => event.kind === 'tool.started');
    expect(started).toHaveLength(2);
    expect(started[0]).toMatchObject({
      tool_call_id: 'read-call',
      name: 'Read',
      input: { path: 'file.txt', nested: { values: [long.slice(0, 4096)] }, truncated: true },
      turn_id: 'trace-turn',
      native_type: 'assistant',
    });
    expect(started[1]?.input).toEqual({ path: exact });
    expect(events.filter((event) => event.kind === 'tool.completed')).toEqual([
      expect.objectContaining({
        tool_call_id: 'read-call',
        ok: true,
        output: { content: [{ type: 'text', text: long.slice(0, 4096) }], truncated: true },
        native_type: 'user',
        turn_id: 'trace-turn',
      }),
      expect.objectContaining({
        tool_call_id: 'failed-call',
        ok: false,
        output: { content: long.slice(0, 4096), truncated: true },
      }),
    ]);
    expect(events.filter((event) => event.kind === 'message.delta')).toEqual([
      expect.objectContaining({ text: 'reading' }),
    ]);
    expect(JSON.stringify(messages)).toContain(long);
  });

  it.each(['success', 'error_during_execution'])(
    'reports result token totals and existing cost for %s',
    async (subtype) => {
      const events = await claudeMessages([{ ...result, subtype }]);
      expect(events.filter((event) => event.kind === 'usage.updated')).toEqual([
        expect.objectContaining({
          input_tokens: 60,
          output_tokens: 7,
          cost_usd: 0.12,
          cost_source: 'estimated',
        }),
      ]);
      expect(events.at(-1)).toMatchObject({
        kind: 'turn.completed',
        status: subtype === 'success' ? 'completed' : 'failed',
      });
    },
  );

  it('carries the images a tool result returned beside its traced output', async () => {
    const image = '/9j/' + 'A'.repeat(6000);
    const block = (data: string) => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data },
    });
    const events = await claudeMessages([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'shot', name: 'mcp__browser__screenshot', input: {} },
            { type: 'tool_use', id: 'plain', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'shot',
              content: [
                { type: 'text', text: 'taken' },
                block(image),
                block('A'.repeat(4 * 1024 * 1024 + 1)),
              ],
            },
            { type: 'tool_result', tool_use_id: 'plain', content: 'a.txt' },
          ],
        },
      },
      result,
    ]);
    const completed = events.filter((event) => event.kind === 'tool.completed');
    expect(completed[0]).toMatchObject({ images: [{ mime: 'image/jpeg', data: image }] });
    expect((completed[0] as unknown as { images: unknown[] }).images).toHaveLength(1);
    expect(completed[1]).not.toHaveProperty('images');
  });

  it('treats absent cache counts as zero', async () => {
    const events = await claudeMessages([
      {
        ...result,
        usage: { input_tokens: 0, output_tokens: 0 },
        modelUsage: {
          'claude-model': {
            inputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            outputTokens: 0,
            contextWindow: 200000,
            costUSD: 0.12,
          },
        },
      },
    ]);
    const usage = events.find((event) => event.kind === 'usage.updated');
    expect(usage).toMatchObject({
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
    });
  });

  it('reports cache reads as the cached part of the input, not cache writes', async () => {
    const events = await claudeMessages([result]);
    expect(events.find((event) => event.kind === 'usage.updated')).toMatchObject({
      input_tokens: 60,
      cached_input_tokens: 20,
    });
  });

  it('reports the last assistant request as context and a single model window', async () => {
    const assistant = (usage: Record<string, number>) => ({
      type: 'assistant',
      message: { content: [], usage: { output_tokens: 1, ...usage } },
    });
    const messages = (modelUsage: Record<string, { contextWindow: number }>) => [
      assistant({ input_tokens: 900, cache_read_input_tokens: 5 }),
      assistant({
        input_tokens: 4,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 50,
      }),
      { ...result, modelUsage },
    ];
    const single = await claudeMessages(messages({ 'model-a': { contextWindow: 200000 } }));
    expect(single.find((event) => event.kind === 'usage.updated')).toMatchObject({
      context_tokens: 1054,
      context_window: 200000,
    });
    const several = await claudeMessages(
      messages({ 'model-a': { contextWindow: 200000 }, 'model-b': { contextWindow: 1000000 } }),
    );
    const usage = several.find((event) => event.kind === 'usage.updated');
    expect(usage).toMatchObject({ context_tokens: 1054 });
    expect(usage).not.toHaveProperty('context_window');
  });
});

it('adds fixture tracing only when enabled, with a distinct tool pair for each turn', async () => {
  for (const enabled of [undefined, false, true]) {
    const adapter = new FixtureAdapter(0, false, enabled),
      events: AgentEvent[] = [];
    const handle = await adapter.start(spec('fixture'), (event) => events.push(event));
    try {
      for (const turnId of ['first-turn', 'second-turn']) {
        const child = fakeChild();
        await adapter.send(handle, turn(turnId));
        child.stdout.write('fixture completed\n');
        child.emit('close', 0, null);
        const turnEvents = events.filter((event) => event.turn_id === turnId);
        expect(turnEvents.map((event) => event.kind)).toEqual([
          ...(enabled ? ['tool.started', 'tool.completed'] : []),
          'message.delta',
          'usage.updated',
          'turn.completed',
        ]);
        const usage = turnEvents.find((event) => event.kind === 'usage.updated');
        if (enabled) {
          const started = turnEvents.find((event) => event.kind === 'tool.started');
          expect(started).toMatchObject({ name: 'fixture.read', input: { path: 'fixture.txt' } });
          expect(turnEvents[1]).toMatchObject({
            tool_call_id: started?.tool_call_id,
            ok: true,
            output: { text: 'fixture contents' },
          });
          expect(usage).toMatchObject({ input_tokens: 10, output_tokens: 5 });
        } else {
          expect(usage?.input_tokens).toBeUndefined();
          expect(usage?.output_tokens).toBeUndefined();
        }
      }
      expect(events.map((event) => event.provider_sequence)).toEqual(events.map((_, i) => i + 1));
      const ids = events
        .filter((event) => event.kind === 'tool.started')
        .map((event) => event.tool_call_id);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      await adapter.close(handle, Date.now() + 1000);
    }
  }
});

it('preserves review finding fields used as evidence instead of truncating them as trace text', async () => {
  const input = {
    location: 'artifact',
    quote: 'q'.repeat(5000),
    evidence: 'e'.repeat(5000),
    impact: 'incorrect result',
  };
  const events = await claudeMessages([
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'finding', name: 'review.finding', input }] },
    },
    result,
  ]);
  expect(events.find((event) => event.kind === 'tool.started')).toMatchObject({ input });
});

it('retains the parent tool identity on subagent tool calls and results', async () => {
  const events = await claudeMessages([
    {
      type: 'assistant',
      parent_tool_use_id: 'parent-call',
      message: { content: [{ type: 'tool_use', id: 'child-call', name: 'Read', input: {} }] },
    },
    {
      type: 'user',
      parent_tool_use_id: 'parent-call',
      message: { content: [{ type: 'tool_result', tool_use_id: 'child-call', content: 'read' }] },
    },
    result,
  ]);
  expect(events.filter((event) => event.kind.startsWith('tool.'))).toEqual([
    expect.objectContaining({ kind: 'tool.started', parent_tool_use_id: 'parent-call' }),
    expect.objectContaining({ kind: 'tool.completed', parent_tool_use_id: 'parent-call' }),
  ]);
});

it('includes hook lifecycle events and enables hook streaming', async () => {
  const messages = ['hook_started', 'hook_progress', 'hook_response'].map((subtype) => ({
    type: 'system',
    subtype,
    hook_id: 'hook',
    hook_name: 'check',
    hook_event: 'PreToolUse',
    stdout: 'out',
    stderr: '',
    output: 'out',
    outcome: 'success',
    exit_code: 0,
  }));
  const events = await claudeMessages([...messages, result]);
  expect(vi.mocked(query).mock.calls.at(-1)?.[0].options).toMatchObject({
    includeHookEvents: true,
  });
  expect(events.filter((event) => event.kind === 'native')).toEqual(
    messages.map((message) =>
      expect.objectContaining({ native_type: message.subtype, native: message }),
    ),
  );
});

it.each(['claude', 'codex'])(
  'bounds total trace size, collections and nesting for %s',
  async (runtime) => {
    let deep: unknown = 'leaf';
    for (let depth = 0; depth < 100; depth++) deep = { nested: deep };
    const input = {
      deep,
      wide: Array.from({ length: 500 }, () => 'x'.repeat(4000)),
      keys: { ['k'.repeat(100000)]: 'value' },
    };
    const events =
      runtime === 'claude'
        ? await claudeMessages([
            {
              type: 'assistant',
              message: { content: [{ type: 'tool_use', id: 'large', name: 'Read', input }] },
            },
            result,
          ])
        : await codexTurns([
            itemFrames({
              type: 'mcpToolCall',
              id: 'large',
              server: 'files',
              tool: 'read',
              arguments: input,
              status: 'completed',
            }),
          ]);
    const event = events.find((event) => event.kind === 'tool.started');
    expect(JSON.stringify(event!.input).length).toBeLessThan(40000);
    expect(event!.input).toMatchObject({ truncated: true });
    const fields = (
      runtime === 'claude' ? event!.input : (event!.input as { arguments: unknown }).arguments
    ) as typeof input;
    expect(fields.wide.length).toBeLessThanOrEqual(64);
    expect(JSON.stringify(fields.deep).length).toBeLessThan(300);
    expect(input.wide).toHaveLength(500);
  },
);
