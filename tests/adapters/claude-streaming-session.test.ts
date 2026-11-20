import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  Options,
  SDKUserMessage,
} from '../../packages/adapters/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts';
import { ClaudeAdapter } from '../../packages/adapters/src/claude.js';
import {
  NATIVE_ENV_ALLOWLIST,
  type AgentEvent,
  type SessionHandle,
  type SessionSpec,
} from '@pantheon/domain';

const roots: string[] = [];
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sessionSpec(): SessionSpec {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pantheon-streaming-')));
  roots.push(root);
  return {
    platform_session_id: 'streaming-session',
    project_id: 'streaming-project',
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

function channel<T>() {
  const items: T[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  return {
    push(item: T) {
      items.push(item);
      wake?.();
    },
    end() {
      done = true;
      wake?.();
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
      for (;;) {
        if (items.length) {
          yield items.shift()!;
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
}

interface FakeQuery {
  options: Options;
  inputs: SDKUserMessage[];
  output: ReturnType<typeof channel<unknown>>;
  interrupts: unknown[];
  interruptReply?: () => Promise<unknown>;
  contextReply?: () => Promise<unknown>;
  contextReads: number;
  stops: string[];
}

function fakeClaude(spawnChild = false) {
  const queries: FakeQuery[] = [];
  const queryFn = vi.fn(
    ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      const output = channel<unknown>();
      const fake: FakeQuery = {
        options,
        inputs: [],
        output,
        interrupts: [],
        contextReads: 0,
        stops: [],
      };
      queries.push(fake);
      const child = spawnChild
        ? options.spawnClaudeCodeProcess!({
            command: process.execPath,
            args: ['-e', "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"],
            cwd: options.cwd,
            env: options.env!,
            signal: new AbortController().signal,
          })
        : undefined;
      void (async () => {
        for await (const message of prompt) fake.inputs.push(message);
      })();
      return {
        initializationResult: async () => ({
          account: { apiProvider: 'firstParty', subscriptionType: 'max' },
        }),
        close() {
          child?.stdin.end();
          output.end();
        },
        async interrupt(request?: unknown) {
          fake.interrupts.push(request);
          return fake.interruptReply?.();
        },
        async getContextUsage() {
          fake.contextReads++;
          if (!fake.contextReply) throw new Error('No context breakdown');
          return fake.contextReply();
        },
        async stopTask(taskId: string) {
          fake.stops.push(taskId);
        },
        [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
      };
    },
  );
  return { queries, adapter: new ClaudeAdapter('fake-claude', 'test', queryFn as never), queryFn };
}

async function opened(
  f: ReturnType<typeof fakeClaude>,
  native_session_id = '',
): Promise<{ handle: SessionHandle; events: AgentEvent[] }> {
  const events: AgentEvent[] = [];
  const handle = native_session_id
    ? await f.adapter.resume(sessionSpec(), native_session_id, (event) => events.push(event))
    : await f.adapter.start(sessionSpec(), (event) => events.push(event));
  cleanup.push(() => f.adapter.close(handle, Date.now() + 1000));
  return { handle, events };
}

const init = {
  type: 'system',
  subtype: 'init',
  session_id: 'native-streaming',
  model: 'claude-model',
  tools: [],
  mcp_servers: [],
  skills: [],
};
const modelUsage = (inputTokens: number, outputTokens: number, costUSD: number) => ({
  inputTokens,
  outputTokens,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  webSearchRequests: 0,
  costUSD,
  contextWindow: 200000,
  maxOutputTokens: 32000,
});
/** The SDK reports cost and modelUsage as running totals of the query. */
const result = (total_cost_usd: number, input_tokens = 0, output_tokens = 0) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  total_cost_usd,
  usage: { input_tokens: 0, output_tokens: 0 },
  modelUsage: { 'claude-model': modelUsage(input_tokens, output_tokens, total_cost_usd) },
});
const interruptedResult = (total_cost_usd: number, input_tokens = 0, output_tokens = 0) => ({
  ...result(total_cost_usd, input_tokens, output_tokens),
  subtype: 'error_during_execution',
  is_error: true,
});
const streamEvent = (event: unknown, parent_tool_use_id: string | null = null) => ({
  type: 'stream_event',
  parent_tool_use_id,
  event,
});
const textDelta = (text: string, parent: string | null = null) =>
  streamEvent(
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    parent,
  );

const completions = (events: AgentEvent[]) =>
  events.filter((event) => event.kind === 'turn.completed');

async function turn(
  f: ReturnType<typeof fakeClaude>,
  handle: SessionHandle,
  events: AgentEvent[],
  turn_id: string,
  messages: unknown[],
) {
  const before = completions(events).length;
  expect(
    await f.adapter.send(handle, {
      turn_id,
      input: `input ${turn_id}`,
    }),
  ).toEqual({ turn_id, status: 'delivered' });
  await vi.waitFor(() =>
    expect(f.queries.at(-1)?.inputs.at(-1)?.message.content).toBe(`input ${turn_id}`),
  );
  for (const message of messages) f.queries.at(-1)!.output.push(message);
  await vi.waitFor(() => expect(completions(events)).toHaveLength(before + 1));
  return events.filter((event) => event.turn_id === turn_id);
}

describe('Claude streaming session', () => {
  it('reports cumulative UTF-8 bytes of drawing arguments at most every 250 ms before the call completes', async () => {
    const f = fakeClaude();
    const { handle, events } = await opened(f);
    await f.adapter.send(handle, { turn_id: 'drawing-turn', input: 'Draw' });
    await vi.waitFor(() => expect(f.queries[0]!.inputs).toHaveLength(1));
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const push = (event: unknown, parent: string | null = null) =>
      f.queries[0]!.output.push(streamEvent(event, parent));
    push({ type: 'message_start', message: { id: 'drawing-message' } });
    push({
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'drawing-call',
        name: 'mcp__pantheon__draw',
        input: {},
      },
    });
    const delta = (partial_json: string, index = 0) => ({
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json },
    });
    push(delta('{"title":"图'));
    await vi.waitFor(() =>
      expect(events.filter((event) => event.kind === 'visual.drawing')).toHaveLength(1),
    );
    clock.mockReturnValue(1249);
    push(delta('表"'));
    push({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'barrier' } });
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'message.delta', text: 'barrier' }),
      ),
    );
    expect(events.filter((event) => event.kind === 'visual.drawing')).toHaveLength(1);
    clock.mockReturnValue(1250);
    push(delta('}'));
    await vi.waitFor(() =>
      expect(events.filter((event) => event.kind === 'visual.drawing')).toHaveLength(2),
    );
    expect(events.filter((event) => event.kind === 'visual.drawing')).toMatchObject([
      {
        tool_call_id: 'drawing-call',
        received_bytes: Buffer.byteLength('{"title":"图'),
        turn_id: 'drawing-turn',
      },
      {
        tool_call_id: 'drawing-call',
        received_bytes: Buffer.byteLength('{"title":"图表"}'),
        turn_id: 'drawing-turn',
      },
    ]);
    expect(events.some((event) => event.kind === 'tool.started')).toBe(false);
    push({ type: 'content_block_stop', index: 0 });
    push(delta('ignored'));
    push({
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'tool_use', id: 'other-call', name: 'mcp__other__draw', input: {} },
    });
    push(delta('ignored', 2));
    push(
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'child-call',
          name: 'mcp__pantheon__draw',
          input: {},
        },
      },
      'parent-call',
    );
    push(delta('ignored'), 'parent-call');
    f.queries[0]!.output.push(result(0));
    await vi.waitFor(() => expect(completions(events)).toHaveLength(1));
    expect(events.filter((event) => event.kind === 'visual.drawing')).toHaveLength(2);
    clock.mockRestore();
  });

  it('reports a lost stream and fails its running turn without replaying it', async () => {
    const f = fakeClaude();
    const { handle, events } = await opened(f);
    await f.adapter.send(handle, { turn_id: 'lost-stream-turn', input: 'Work' });
    await vi.waitFor(() => expect(f.queries[0]!.inputs).toHaveLength(1));
    f.queries[0]!.output.end();
    await vi.waitFor(() => expect(completions(events)).toHaveLength(1));
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'runtime.disconnected',
        reason: expect.stringContaining('Claude'),
      }),
    );
    expect(completions(events)[0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Claude'),
    });
    expect(f.queryFn).toHaveBeenCalledOnce();
  });

  it('reports a Claude process lost while its conversation is idle', async () => {
    const f = fakeClaude(true);
    const { handle, events } = await opened(f);
    await turn(f, handle, events, 'completed-before-loss', [init, result(0)]);
    process.kill(handle.process_identity!.pid, 'SIGKILL');
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: 'runtime.disconnected',
          reason: expect.stringContaining('Claude'),
        }),
      ),
    );
    expect((await f.adapter.inspect(handle)).state).toBe('exited');
    expect(completions(events)).toHaveLength(1);
  });

  it('reads Claude MCP states through its SDK without sending a turn', async () => {
    const close = vi.fn();
    const status = vi.fn(async () => [
      { name: 'files', status: 'connected' },
      { name: 'account', status: 'needs-auth' },
    ]);
    const queryFn = vi.fn(() => ({
      initializationResult: async () => ({}),
      mcpServerStatus: status,
      close,
    }));
    const adapter = new ClaudeAdapter('fake-claude', 'test', queryFn as never);
    expect(await adapter.mcpStatus(process.cwd())).toEqual([
      { name: 'files', state: 'connected' },
      { name: 'account', state: 'needs_sign_in' },
    ]);
    expect(status).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('runs every turn of a session in one native query', async () => {
    const f = fakeClaude();
    const { handle, events } = await opened(f);
    await turn(f, handle, events, 'first-turn', [init, result(0)]);
    await turn(f, handle, events, 'second-turn', [result(0)]);
    expect(f.queryFn).toHaveBeenCalledOnce();
    expect(f.queries[0]!.inputs.map((input) => input.message.content)).toEqual([
      'input first-turn',
      'input second-turn',
    ]);
    expect(completions(events)).toEqual([
      expect.objectContaining({ turn_id: 'first-turn', status: 'completed' }),
      expect.objectContaining({ turn_id: 'second-turn', status: 'completed' }),
    ]);
  });

  it('streams text deltas in order and does not repeat the final assistant text', async () => {
    const f = fakeClaude();
    const { handle, events } = await opened(f);
    expect(f.queries[0]!.options.includePartialMessages).toBe(true);
    const turnEvents = await turn(f, handle, events, 'streamed-turn', [
      init,
      streamEvent({ type: 'message_start', message: { id: 'main-message' } }),
      textDelta('Hel'),
      textDelta('lo'),
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          id: 'main-message',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'tool_use', id: 'read-call', name: 'Read', input: {} },
          ],
        },
      },
      result(0),
    ]);
    expect(
      turnEvents.filter((event) => event.kind === 'message.delta').map((event) => event.text),
    ).toEqual(['Hel', 'lo']);
    expect(turnEvents.filter((event) => event.kind === 'tool.started')).toEqual([
      expect.objectContaining({ tool_call_id: 'read-call' }),
    ]);
  });

  it('keeps subagent text out of the main conversation text', async () => {
    const f = fakeClaude();
    const { handle, events } = await opened(f);
    const turnEvents = await turn(f, handle, events, 'subagent-turn', [
      init,
      streamEvent({ type: 'message_start', message: { id: 'sub-message' } }, 'task-call'),
      textDelta('partial', 'task-call'),
      {
        type: 'assistant',
        parent_tool_use_id: 'task-call',
        message: { id: 'sub-message', content: [{ type: 'text', text: 'subagent text' }] },
      },
      {
        type: 'assistant',
        parent_tool_use_id: 'task-call',
        message: {
          id: 'unstreamed-sub-message',
          content: [{ type: 'text', text: 'subagent answer' }],
        },
      },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { id: 'main-message', content: [{ type: 'text', text: 'main answer' }] },
      },
      result(0),
    ]);
    expect(
      turnEvents.filter((event) => event.kind === 'message.delta').map((event) => event.text),
    ).toEqual(['main answer']);
  });

  it('delivers a steer into the running query', async () => {
    const f = fakeClaude();
    const { handle, events } = await opened(f);
    expect(
      await f.adapter.send(handle, {
        turn_id: 'steered-turn',
        input: 'start work',
      }),
    ).toEqual({ turn_id: 'steered-turn', status: 'delivered' });
    await vi.waitFor(() => expect(f.queries[0]!.inputs).toHaveLength(1));
    expect(
      await f.adapter.steer!(handle, {
        turn_id: 'steer-turn',
        input: 'also check the tests',
      }),
    ).toEqual({ turn_id: 'steer-turn', status: 'delivered' });
    await vi.waitFor(() =>
      expect(f.queries[0]!.inputs.map((input) => input.message.content)).toEqual([
        'start work',
        'also check the tests',
      ]),
    );
    f.queries[0]!.output.push(init);
    f.queries[0]!.output.push(result(0));
    await vi.waitFor(() => expect(completions(events)).toHaveLength(1));
    expect(f.queryFn).toHaveBeenCalledOnce();
  });

  it('keeps the turn open while a steered send runs as its own native turn', async () => {
    const f = fakeClaude();
    const { handle, events } = await opened(f);
    await f.adapter.send(handle, {
      turn_id: 'folded-turn',
      input: 'start work',
    });
    await vi.waitFor(() => expect(f.queries[0]!.inputs).toHaveLength(1));
    await f.adapter.steer!(handle, {
      turn_id: 'late-steer',
      input: 'also update the docs',
    });
    f.queries[0]!.output.push(init);
    f.queries[0]!.output.push({ ...result(0.1, 3, 2), queued_turn_count: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(completions(events)).toEqual([]);
    f.queries[0]!.output.push({ ...result(0.3, 6, 4), queued_turn_count: 0 });
    await vi.waitFor(() => expect(completions(events)).toHaveLength(1));
    const usage = events.filter((event) => event.kind === 'usage.updated');
    expect(usage).toEqual([
      expect.objectContaining({ turn_id: 'folded-turn', input_tokens: 6, output_tokens: 4 }),
    ]);
    expect(usage[0]?.cost_usd).toBeCloseTo(0.3);
  });

  it('keeps the turn open while a background task runs and records the turn its end starts', async () => {
    const f = fakeClaude();
    const { handle, events } = await opened(f);
    await f.adapter.send(handle, { turn_id: 'background-turn', input: 'run the tests' });
    await vi.waitFor(() => expect(f.queries[0]!.inputs).toHaveLength(1));
    const tasks = (live: { task_id: string; ambient?: boolean }[]) => ({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: live.map((task) => ({ task_type: 'local_bash', description: 'pnpm test', ...task })),
    });
    f.queries[0]!.output.push(init);
    f.queries[0]!.output.push(tasks([{ task_id: 'tests' }, { task_id: 'watcher', ambient: true }]));
    f.queries[0]!.output.push(result(0.1, 3, 2));
    await new Promise((resolve) => setImmediate(resolve));
    expect(completions(events)).toEqual([]);
    f.queries[0]!.output.push(tasks([{ task_id: 'watcher', ambient: true }]));
    f.queries[0]!.output.push({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { id: 'summary', content: [{ type: 'text', text: 'tests passed' }] },
    });
    f.queries[0]!.output.push(result(0.2, 5, 3));
    await vi.waitFor(() => expect(completions(events)).toHaveLength(1));
    expect(completions(events)[0]).toMatchObject({
      turn_id: 'background-turn',
      status: 'completed',
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'message.delta',
        turn_id: 'background-turn',
        text: 'tests passed',
      }),
    );
  });

  const backgroundTasks = (live: { task_id: string; task_type?: string; ambient?: boolean }[]) => ({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: live.map((task) => ({ task_type: 'local_bash', description: 'pnpm test', ...task })),
  });
  const backgroundChanges = (events: AgentEvent[]) =>
    events.flatMap((event) => (event.kind === 'background.changed' ? [event.tasks] : []));

  it('reports the background tasks without ambient ones, each with the time it was first seen', async () => {
    const f = fakeClaude();
    const { handle, events } = await opened(f);
    await f.adapter.send(handle, { turn_id: 'listed-turn', input: 'run the tests' });
    await vi.waitFor(() => expect(f.queries[0]!.inputs).toHaveLength(1));
    f.queries[0]!.output.push(init);
    f.queries[0]!.output.push(
      backgroundTasks([{ task_id: 'tests' }, { task_id: 'watcher', ambient: true }]),
    );
    await vi.waitFor(() => expect(backgroundChanges(events)).toHaveLength(1));
    const [first] = backgroundChanges(events);
    expect(first).toEqual([
      { id: 'tests', kind: 'shell', description: 'pnpm test', started_at: expect.any(Number) },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    f.queries[0]!.output.push(
      backgroundTasks([
        { task_id: 'tests' },
        { task_id: 'reviewer', task_type: 'local_agent' },
        { task_id: 'watcher', ambient: true },
      ]),
    );
    // A change of ambient tasks alone changes nothing Pantheon reports.
    f.queries[0]!.output.push(
      backgroundTasks([{ task_id: 'tests' }, { task_id: 'reviewer', task_type: 'local_agent' }]),
    );
    f.queries[0]!.output.push(result(0.1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(backgroundChanges(events)).toHaveLength(2);
    const second = backgroundChanges(events)[1]!;
    expect(second).toEqual([
      first![0],
      { id: 'reviewer', kind: 'agent', description: 'pnpm test', started_at: expect.any(Number) },
    ]);
    expect(second[1]!.started_at).toBeGreaterThan(first![0]!.started_at);
  });

  const usage = { total_tokens: 1200, tool_uses: 3, duration_ms: 4500 };
  it.each([
    {
      name: 'a started subagent with its parent and depth',
      message: {
        subtype: 'task_started',
        task_id: 'reviewer',
        tool_use_id: 'agent-call',
        parent_tool_use_id: 'outer-call',
        task_type: 'local_agent',
        description: 'review the diff',
        subagent_type: 'code-reviewer',
        is_backgrounded: true,
        spawn_depth: 2,
        parent_task_id: 'planner',
      },
      expected: [
        {
          kind: 'task.started',
          task: {
            id: 'reviewer',
            kind: 'agent',
            tool_call_id: 'agent-call',
            parent_task_id: 'planner',
            depth: 2,
            description: 'review the diff',
            agent_type: 'code-reviewer',
            background: true,
            started_at: expect.any(Number),
          },
        },
      ],
    },
    {
      name: 'a started task of an unknown type as other, in the foreground',
      message: {
        subtype: 'task_started',
        task_id: 'probe',
        task_type: 'monitor_mcp',
        description: 'watch',
      },
      expected: [
        {
          kind: 'task.started',
          task: {
            id: 'probe',
            kind: 'other',
            description: 'watch',
            background: false,
            started_at: expect.any(Number),
          },
        },
      ],
    },
    {
      name: 'no ambient started task',
      message: {
        subtype: 'task_started',
        task_id: 'watcher',
        task_type: 'local_bash',
        description: 'watch files',
        ambient: true,
      },
      expected: [],
    },
    {
      name: 'the progress of a task',
      message: {
        subtype: 'task_progress',
        task_id: 'reviewer',
        description: 'review the diff',
        usage,
        last_tool_name: 'Read',
        summary: 'reading the diff',
      },
      expected: [
        {
          kind: 'task.progress',
          task_id: 'reviewer',
          usage: { tokens: 1200, tool_uses: 3, duration_ms: 4500 },
          last_tool: 'Read',
          summary: 'reading the diff',
        },
      ],
    },
    {
      name: 'the end of a task',
      message: {
        subtype: 'task_notification',
        task_id: 'reviewer',
        status: 'failed',
        summary: 'review failed',
        output_file: '/tmp/reviewer.out',
        usage,
      },
      expected: [
        {
          kind: 'task.ended',
          task_id: 'reviewer',
          state: 'failed',
          summary: 'review failed',
          usage: { tokens: 1200, tool_uses: 3, duration_ms: 4500 },
          output_file: '/tmp/reviewer.out',
        },
      ],
    },
  ])('reports $name', async ({ message, expected }) => {
    const f = fakeClaude();
    const { handle, events } = await opened(f);
    await f.adapter.send(handle, { turn_id: 'task-turn', input: 'review the diff' });
    await vi.waitFor(() => expect(f.queries[0]!.inputs).toHaveLength(1));
    f.queries[0]!.output.push(init);
    f.queries[0]!.output.push({ type: 'system', ...message });
    f.queries[0]!.output.push(result(0.1));
    await vi.waitFor(() => expect(completions(events)).toHaveLength(1));
    expect(
      events
        .filter((event) => event.kind.startsWith('task.'))
        .map(({ key, provider_sequence, turn_id, ...event }) => event),
    ).toEqual(expected);
  });

  it('stops a background task through the SDK', async () => {
    const f = fakeClaude();
    const { handle } = await opened(f);
    await f.adapter.send(handle, { turn_id: 'stopping-turn', input: 'run the tests' });
    await vi.waitFor(() => expect(f.queries[0]!.inputs).toHaveLength(1));
    f.queries[0]!.output.push(init);
    f.queries[0]!.output.push(backgroundTasks([{ task_id: 'tests' }, { task_id: 'server' }]));
    await new Promise((resolve) => setImmediate(resolve));
    await f.adapter.stopBackground!(handle, 'server');
    expect(f.queries[0]!.stops).toEqual(['server']);
  });

  it('ends the turn a background task alone kept open once Pantheon stops that task', async () => {
    const f = fakeClaude();
    const { handle, events } = await opened(f);
    await f.adapter.send(handle, { turn_id: 'held-turn', input: 'run the tests' });
    await vi.waitFor(() => expect(f.queries[0]!.inputs).toHaveLength(1));
    f.queries[0]!.output.push(init);
    f.queries[0]!.output.push(backgroundTasks([{ task_id: 'tests' }, { task_id: 'server' }]));
    f.queries[0]!.output.push(result(0.1, 3, 2));
    await new Promise((resolve) => setImmediate(resolve));
    expect(completions(events)).toEqual([]);
    await f.adapter.stopBackground!(handle, 'server');
    f.queries[0]!.output.push(backgroundTasks([{ task_id: 'tests' }]));
    await new Promise((resolve) => setImmediate(resolve));
    expect(completions(events)).toEqual([]);
    // The CLI starts no native turn after a stop, so no result follows the last one.
    await f.adapter.stopBackground!(handle, 'tests');
    await vi.waitFor(() => expect(completions(events)).toHaveLength(1));
    expect(completions(events)[0]).toMatchObject({ turn_id: 'held-turn', status: 'completed' });
    expect(events.filter((event) => event.kind === 'usage.updated')).toEqual([
      expect.objectContaining({ turn_id: 'held-turn', input_tokens: 3, output_tokens: 2 }),
    ]);
  });

  it('keeps a held turn open for its steer when Pantheon stops the task that held it', async () => {
    const f = fakeClaude();
    const { handle, events } = await opened(f);
    await f.adapter.send(handle, { turn_id: 'held-steered-turn', input: 'run the server' });
    await vi.waitFor(() => expect(f.queries[0]!.inputs).toHaveLength(1));
    const first = f.queries[0]!.inputs[0]!.uuid;
    f.queries[0]!.output.push(init);
    f.queries[0]!.output.push(backgroundTasks([{ task_id: 'server' }]));
    f.queries[0]!.output.push({ ...result(0.1), user_message_uuids: [first] });
    await new Promise((resolve) => setImmediate(resolve));
    expect(completions(events)).toEqual([]);
    expect(
      await f.adapter.steer!(handle, { turn_id: 'held-steer', input: 'also check the logs' }),
    ).toEqual({ turn_id: 'held-steer', status: 'delivered' });
    await f.adapter.stopBackground!(handle, 'server');
    await new Promise((resolve) => setImmediate(resolve));
    expect(completions(events)).toEqual([]);
    await vi.waitFor(() => expect(f.queries[0]!.inputs).toHaveLength(2));
    const steer = f.queries[0]!.inputs[1]!.uuid;
    f.queries[0]!.output.push(backgroundTasks([]));
    f.queries[0]!.output.push({
      type: 'assistant',
      parent_tool_use_id: null,
      user_message_uuid: steer,
      user_message_uuids: [steer],
      message: { id: 'steer-reply', content: [{ type: 'text', text: 'logs are clean' }] },
    });
    f.queries[0]!.output.push({ ...result(0.2), user_message_uuids: [steer] });
    await vi.waitFor(() => expect(completions(events)).toHaveLength(1));
    expect(completions(events)[0]).toMatchObject({
      turn_id: 'held-steered-turn',
      status: 'completed',
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'message.delta',
        turn_id: 'held-steered-turn',
        text: 'logs are clean',
      }),
    );
  });

  it('keeps what an interrupted held turn still streams out of the next turn', async () => {
    const f = fakeClaude();
    const { handle, events } = await opened(f);
    await f.adapter.send(handle, { turn_id: 'answered-held-turn', input: 'start the server' });
    await vi.waitFor(() => expect(f.queries[0]!.inputs).toHaveLength(1));
    const first = f.queries[0]!.inputs[0]!.uuid;
    f.queries[0]!.output.push(init);
    f.queries[0]!.output.push(backgroundTasks([{ task_id: 'server' }]));
    f.queries[0]!.output.push({ ...result(0.1), user_message_uuids: [first] });
    // The CLI stamps the send a native turn answers only on its first stream event.
    f.queries[0]!.output.push({
      ...streamEvent({ type: 'message_start', message: { id: 'follow-up' } }),
      user_message_uuid: first,
      user_message_uuids: [first],
    });
    f.queries[0]!.output.push(textDelta('server started'));
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'message.delta', text: 'server started' }),
      ),
    );
    f.queries[0]!.interruptReply = async () => ({ cancelled: [] });
    expect(await f.adapter.interrupt!(handle)).toEqual({ ok: true });
    expect(completions(events)).toEqual([
      expect.objectContaining({ turn_id: 'answered-held-turn', status: 'interrupted' }),
    ]);
    await f.adapter.send(handle, { turn_id: 'next-turn', input: 'stop the server' });
    await vi.waitFor(() => expect(f.queries[0]!.inputs).toHaveLength(2));
    const second = f.queries[0]!.inputs[1]!.uuid;
    f.queries[0]!.output.push(textDelta(' and listening'));
    f.queries[0]!.output.push({ ...interruptedResult(0.15), user_message_uuids: [first] });
    f.queries[0]!.output.push(backgroundTasks([]));
    f.queries[0]!.output.push({
      ...streamEvent({ type: 'message_start', message: { id: 'next-reply' } }),
      user_message_uuid: second,
      user_message_uuids: [second],
    });
    f.queries[0]!.output.push(textDelta('server stopped'));
    f.queries[0]!.output.push({ ...result(0.2), user_message_uuids: [second] });
    await vi.waitFor(() => expect(completions(events)).toHaveLength(2));
    expect(completions(events)[1]).toMatchObject({ turn_id: 'next-turn', status: 'completed' });
    expect(
      events.flatMap((event) =>
        event.kind === 'message.delta' ? [[event.turn_id, event.text]] : [],
      ),
    ).toEqual([
      ['answered-held-turn', 'server started'],
      ['next-turn', 'server stopped'],
    ]);
  });

  it('keeps the turn open until a result answers the steer', async () => {
    const f = fakeClaude();
    const { handle, events } = await opened(f);
    await f.adapter.send(handle, {
      turn_id: 'raced-turn',
      input: 'start work',
    });
    await vi.waitFor(() => expect(f.queries[0]!.inputs).toHaveLength(1));
    await f.adapter.steer!(handle, {
      turn_id: 'raced-steer',
      input: 'also update the docs',
    });
    await vi.waitFor(() => expect(f.queries[0]!.inputs).toHaveLength(2));
    const [first, steer] = f.queries[0]!.inputs.map((input) => input.uuid);
    f.queries[0]!.output.push(init);
    // The CLI produced this result before the steer reached its command queue.
    f.queries[0]!.output.push({
      ...result(0.1),
      queued_turn_count: 0,
      user_message_uuid: first,
      user_message_uuids: [first],
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(completions(events)).toEqual([]);
    f.queries[0]!.output.push({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { id: 'steer-reply', content: [{ type: 'text', text: 'docs updated' }] },
    });
    f.queries[0]!.output.push({
      ...result(0.3),
      queued_turn_count: 0,
      user_message_uuid: steer,
      user_message_uuids: [steer],
    });
    await vi.waitFor(() => expect(completions(events)).toHaveLength(1));
    expect(
      events.filter((event) => event.kind === 'message.delta').map((event) => event.turn_id),
    ).toEqual(['raced-turn']);
  });

  it('answers a steer that arrives while the context of the result is read in the same turn', async () => {
    const f = fakeClaude();
    const { handle, events } = await opened(f);
    await f.adapter.send(handle, { turn_id: 'held-context-turn', input: 'start work' });
    await vi.waitFor(() => expect(f.queries[0]!.inputs).toHaveLength(1));
    const context = Promise.withResolvers<unknown>();
    f.queries[0]!.contextReply = () => context.promise;
    const [first] = f.queries[0]!.inputs.map((input) => input.uuid);
    f.queries[0]!.output.push(init);
    f.queries[0]!.output.push({
      ...result(0.1),
      queued_turn_count: 0,
      user_message_uuid: first,
      user_message_uuids: [first],
    });
    await vi.waitFor(() => expect(f.queries[0]!.contextReads).toBe(1));
    expect(
      await f.adapter.steer!(handle, { turn_id: 'context-steer', input: 'also update the docs' }),
    ).toEqual({ turn_id: 'context-steer', status: 'delivered' });
    context.reject(new Error('No context breakdown'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(completions(events)).toEqual([]);
    await vi.waitFor(() => expect(f.queries[0]!.inputs).toHaveLength(2));
    const steer = f.queries[0]!.inputs[1]!.uuid;
    f.queries[0]!.output.push({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { id: 'steer-reply', content: [{ type: 'text', text: 'docs updated' }] },
    });
    f.queries[0]!.output.push({
      ...result(0.3),
      queued_turn_count: 0,
      user_message_uuid: steer,
      user_message_uuids: [steer],
    });
    await vi.waitFor(() => expect(completions(events)).toHaveLength(1));
    expect(
      events.flatMap((event) =>
        event.kind === 'message.delta' ? [[event.turn_id, event.text]] : [],
      ),
    ).toEqual([['held-context-turn', 'docs updated']]);
  });

  it('accepts a background follow-up result with a synthetic prompt uuid', async () => {
    const f = fakeClaude();
    const { handle, events } = await opened(f);
    await f.adapter.send(handle, { turn_id: 'synthetic-follow-up', input: 'run tests' });
    await vi.waitFor(() => expect(f.queries[0]!.inputs).toHaveLength(1));
    f.queries[0]!.output.push(init);
    f.queries[0]!.output.push({
      ...result(0.1),
      user_message_uuid: f.queries[0]!.inputs[0]!.uuid,
      queued_turn_count: 1,
    });
    await new Promise((resolve) => setImmediate(resolve));
    f.queries[0]!.output.push({ ...result(0.2), user_message_uuid: 'synthetic-prompt' });
    await vi.waitFor(() => expect(completions(events)).toHaveLength(1));
    expect(completions(events)[0]).toMatchObject({
      turn_id: 'synthetic-follow-up',
      status: 'completed',
    });
  });

  it('leaves a steer queued while no turn is running', async () => {
    const f = fakeClaude();
    const { handle } = await opened(f);
    expect(
      await f.adapter.steer!(handle, {
        turn_id: 'idle-steer',
        input: 'hello',
      }),
    ).toEqual({ turn_id: 'idle-steer', status: 'queued', reason: expect.any(String) });
    expect(f.queries[0]!.inputs).toEqual([]);
  });

  it('reports each turn cost as the change of the query total', async () => {
    const f = fakeClaude();
    const { handle, events } = await opened(f);
    const usage = (turnEvents: AgentEvent[]) =>
      turnEvents.find((event) => event.kind === 'usage.updated');
    const first = usage(await turn(f, handle, events, 'first-cost', [init, result(0.1, 3, 2)]));
    const second = usage(await turn(f, handle, events, 'second-cost', [result(0.25, 6, 4)]));
    expect(first).toMatchObject({ cost_source: 'estimated', input_tokens: 3, output_tokens: 2 });
    expect(first?.cost_usd).toBeCloseTo(0.1);
    expect(second?.cost_usd).toBeCloseTo(0.15);
    f.queries[0]!.output.end();
    await new Promise((resolve) => setImmediate(resolve));
    const resumed = usage(
      await turn(f, handle, events, 'resumed-cost', [
        { ...init, session_id: 'native-streaming' },
        result(0.4, 9, 6),
      ]),
    );
    expect(f.queryFn).toHaveBeenCalledTimes(2);
    expect(f.queries[1]!.options.resume).toBe('native-streaming');
    expect(resumed).toMatchObject({ cost_source: 'estimated', input_tokens: 3, output_tokens: 2 });
    expect(resumed?.cost_usd).toBeCloseTo(0.15);
    const after = usage(await turn(f, handle, events, 'after-resume', [result(0.5, 12, 8)]));
    expect(after?.cost_usd).toBeCloseTo(0.1);
  });

  it('starts the cost baseline over when the query total drops after a clear', async () => {
    const f = fakeClaude();
    const { handle, events } = await opened(f);
    const usage = (turnEvents: AgentEvent[]) =>
      turnEvents.find((event) => event.kind === 'usage.updated');
    await turn(f, handle, events, 'before-clear', [init, result(0.3)]);
    const cleared = usage(await turn(f, handle, events, 'clear-turn', [result(0)]));
    const after = usage(await turn(f, handle, events, 'after-clear', [result(0.05)]));
    expect(cleared?.cost_usd).toBe(0);
    expect(after?.cost_usd).toBeCloseTo(0.05);
  });

  it('withholds the carried cost on the first result of a resumed session', async () => {
    const f = fakeClaude();
    const { handle, events } = await opened(f, 'native-earlier');
    const turnEvents = await turn(f, handle, events, 'resumed-turn', [init, result(2)]);
    const usage = turnEvents.find((event) => event.kind === 'usage.updated');
    expect(usage).toMatchObject({ cost_source: 'unknown' });
    expect(usage).not.toHaveProperty('cost_usd');
  });

  it('reports a resumed first turn against the saved total of the same native session', async () => {
    const f = fakeClaude();
    const first = sessionSpec();
    const native_state_dir = path.join(first.cwd, 'native');
    const events: AgentEvent[] = [];
    const handle = await f.adapter.start({ ...first, native_state_dir }, (event) =>
      events.push(event),
    );
    await turn(f, handle, events, 'saved-turn', [init, result(0.3, 3, 2)]);
    await f.adapter.close(handle, Date.now() + 1000);
    const resumedEvents: AgentEvent[] = [];
    const resumed = await f.adapter.resume(
      { ...sessionSpec(), native_state_dir },
      'native-streaming',
      (event) => resumedEvents.push(event),
    );
    cleanup.push(() => f.adapter.close(resumed, Date.now() + 1000));
    const usage = (
      await turn(f, resumed, resumedEvents, 'resumed-saved', [init, result(0.5, 10, 6)])
    ).find((event) => event.kind === 'usage.updated');
    expect(usage).toMatchObject({ cost_source: 'estimated', input_tokens: 7, output_tokens: 4 });
    expect(usage?.cost_usd).toBeCloseTo(0.2);
  });

  it('reports the first turn after a user session is released against the total before it', async () => {
    const f = fakeClaude();
    const spec = { ...sessionSpec(), user_session: true as const };
    const events: AgentEvent[] = [];
    const handle = await f.adapter.start(spec, (event) => events.push(event));
    await turn(f, handle, events, 'before-release', [init, result(0.3, 3, 2)]);
    await f.adapter.close(handle, Date.now() + 1000);
    const resumedEvents: AgentEvent[] = [];
    const resumed = await f.adapter.resume(spec, 'native-streaming', (event) =>
      resumedEvents.push(event),
    );
    cleanup.push(() => f.adapter.close(resumed, Date.now() + 1000));
    const usage = (
      await turn(f, resumed, resumedEvents, 'after-release', [init, result(0.5, 10, 6)])
    ).find((event) => event.kind === 'usage.updated');
    expect(usage).toMatchObject({ cost_source: 'estimated', input_tokens: 7, output_tokens: 4 });
    expect(usage?.cost_usd).toBeCloseTo(0.2);
  });

  async function resumedFromSavedCost(saved: string) {
    const f = fakeClaude();
    const first = sessionSpec();
    const native_state_dir = path.join(first.cwd, 'native');
    const started = await f.adapter.start({ ...first, native_state_dir }, () => {});
    await f.adapter.close(started, Date.now() + 1000);
    writeFileSync(
      path.join(native_state_dir, '.pantheon-claude-cost-native-streaming.json'),
      saved,
    );
    const events: AgentEvent[] = [];
    const handle = await f.adapter.resume(
      { ...sessionSpec(), native_state_dir },
      'native-streaming',
      (event) => events.push(event),
    );
    cleanup.push(() => f.adapter.close(handle, Date.now() + 1000));
    return (await turn(f, handle, events, 'resumed-saved', [init, result(0.5)])).find(
      (event) => event.kind === 'usage.updated',
    );
  }

  it('keeps the saved totals of native sessions that share one native folder apart', async () => {
    const f = fakeClaude();
    const native_state_dir = path.join(sessionSpec().cwd, 'native');
    for (const [native, total] of [
      ['native-streaming', 0.3],
      ['native-other', 0.7],
    ] as const) {
      const events: AgentEvent[] = [];
      const handle = await f.adapter.start({ ...sessionSpec(), native_state_dir }, (event) =>
        events.push(event),
      );
      await turn(f, handle, events, `saved-${native}`, [
        { ...init, session_id: native },
        result(total),
      ]);
      await f.adapter.close(handle, Date.now() + 1000);
    }
    const events: AgentEvent[] = [];
    const resumed = await f.adapter.resume(
      { ...sessionSpec(), native_state_dir },
      'native-streaming',
      (event) => events.push(event),
    );
    cleanup.push(() => f.adapter.close(resumed, Date.now() + 1000));
    const usage = (await turn(f, resumed, events, 'resumed-shared', [init, result(0.5)])).find(
      (event) => event.kind === 'usage.updated',
    );
    expect(usage).toMatchObject({ cost_source: 'estimated' });
    expect(usage?.cost_usd).toBeCloseTo(0.2);
  });

  it('resumes with an unknown cost when the saved total is unreadable', async () => {
    const usage = await resumedFromSavedCost('{not json');
    expect(usage).toMatchObject({ cost_source: 'unknown' });
    expect(usage).not.toHaveProperty('cost_usd');
    expect(usage).not.toHaveProperty('input_tokens');
  });

  it('completes the turn when its query total cannot be saved', async () => {
    const f = fakeClaude();
    const first = sessionSpec();
    const native_state_dir = path.join(first.cwd, 'native');
    const events: AgentEvent[] = [];
    const handle = await f.adapter.start({ ...first, native_state_dir }, (event) =>
      events.push(event),
    );
    cleanup.push(() => f.adapter.close(handle, Date.now() + 1000));
    // A folder where the saved total goes makes its write fail.
    mkdirSync(path.join(native_state_dir, '.pantheon-claude-cost-native-streaming.json'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await turn(f, handle, events, 'unsaved-turn', [init, result(0.3)]);
    expect(completions(events)).toEqual([expect.objectContaining({ status: 'completed' })]);
    expect(warn).toHaveBeenCalledWith('Claude query total was not saved:', expect.any(String));
  });

  it('counts subagent and compaction tokens from the per-model totals', async () => {
    const f = fakeClaude();
    const { handle, events } = await opened(f);
    const usage = (
      await turn(f, handle, events, 'subagent-usage', [
        init,
        {
          ...result(0.2),
          // The main loop alone.
          usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 10 },
          modelUsage: {
            'claude-model': {
              ...modelUsage(5, 7, 0.1),
              cacheReadInputTokens: 10,
              cacheCreationInputTokens: 1,
            },
            'claude-subagent-model': modelUsage(100, 50, 0.1),
          },
        },
      ])
    ).find((event) => event.kind === 'usage.updated');
    expect(usage).toMatchObject({
      input_tokens: 116,
      cached_input_tokens: 10,
      output_tokens: 57,
    });
  });

  it('reports cache writes from the per-model totals without changing the input tokens', async () => {
    const f = fakeClaude();
    const { handle, events } = await opened(f);
    const usage = (turnEvents: AgentEvent[]) =>
      turnEvents.find((event) => event.kind === 'usage.updated');
    const withCache = (input: number, read: number, write: number) => ({
      ...result(0),
      modelUsage: {
        'claude-model': {
          ...modelUsage(input, 0, 0),
          cacheReadInputTokens: read,
          cacheCreationInputTokens: write,
        },
      },
    });
    const first = usage(await turn(f, handle, events, 'cache-first', [init, withCache(5, 10, 4)]));
    const second = usage(await turn(f, handle, events, 'cache-second', [withCache(8, 30, 6)]));
    expect(first).toMatchObject({
      input_tokens: 19,
      cached_input_tokens: 10,
      cache_write_input_tokens: 4,
    });
    expect(second).toMatchObject({
      input_tokens: 25,
      cached_input_tokens: 20,
      cache_write_input_tokens: 2,
    });
  });

  it('reports the usage of a turn the interrupt ends before its last result', async () => {
    const f = fakeClaude();
    const { handle, events } = await opened(f);
    await f.adapter.send(handle, { turn_id: 'interrupted-usage', input: 'long work' });
    await vi.waitFor(() => expect(f.queries[0]!.inputs).toHaveLength(1));
    f.queries[0]!.output.push(init);
    f.queries[0]!.output.push({ ...result(0.1, 3, 2), queued_turn_count: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(completions(events)).toEqual([]);
    f.queries[0]!.interruptReply = async () => ({ cancelled: [] });
    expect(await f.adapter.interrupt!(handle)).toEqual({ ok: true });
    expect(completions(events)).toEqual([
      expect.objectContaining({ turn_id: 'interrupted-usage', status: 'interrupted' }),
    ]);
    await turn(f, handle, events, 'next-usage', [result(0.3, 8, 9)]);
    const usage = events.filter((event) => event.kind === 'usage.updated');
    expect(usage).toEqual([
      expect.objectContaining({ turn_id: 'interrupted-usage', input_tokens: 3, output_tokens: 2 }),
      expect.objectContaining({ turn_id: 'next-usage', input_tokens: 5, output_tokens: 7 }),
    ]);
    expect(usage[0]?.cost_usd).toBeCloseTo(0.1);
    expect(usage[1]?.cost_usd).toBeCloseTo(0.2);
  });

  it('counts a result that arrives after the interrupt ended its turn toward no turn', async () => {
    const f = fakeClaude();
    const { handle, events } = await opened(f);
    await f.adapter.send(handle, { turn_id: 'interrupted-early', input: 'long work' });
    await vi.waitFor(() => expect(f.queries[0]!.inputs).toHaveLength(1));
    f.queries[0]!.output.push(init);
    f.queries[0]!.output.push({ ...result(0.1, 3, 2), queued_turn_count: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    f.queries[0]!.interruptReply = async () => ({ cancelled: [] });
    expect(await f.adapter.interrupt!(handle)).toEqual({ ok: true });
    expect(completions(events)).toHaveLength(1);
    f.queries[0]!.output.push(interruptedResult(0.25, 6, 4));
    await new Promise((resolve) => setImmediate(resolve));
    await turn(f, handle, events, 'after-late-result', [result(0.3, 8, 9)]);
    const usage = events.filter((event) => event.kind === 'usage.updated');
    expect(usage).toEqual([
      expect.objectContaining({ turn_id: 'interrupted-early', input_tokens: 3, output_tokens: 2 }),
      expect.objectContaining({ turn_id: 'after-late-result', input_tokens: 2, output_tokens: 5 }),
    ]);
    expect(usage[1]?.cost_usd).toBeCloseTo(0.05);
  });

  it('keeps a late interrupted result from completing the next running turn', async () => {
    const f = fakeClaude();
    const { handle, events } = await opened(f);
    await f.adapter.send(handle, { turn_id: 'interrupted-old', input: 'long work' });
    await vi.waitFor(() => expect(f.queries[0]!.inputs).toHaveLength(1));
    const first = f.queries[0]!.inputs[0]!.uuid;
    f.queries[0]!.output.push(init);
    f.queries[0]!.output.push({
      ...result(0.1, 3, 2),
      user_message_uuids: [first],
      queued_turn_count: 1,
    });
    await new Promise((resolve) => setImmediate(resolve));
    f.queries[0]!.interruptReply = async () => ({ cancelled: [] });
    expect(await f.adapter.interrupt!(handle)).toEqual({ ok: true });
    await f.adapter.send(handle, { turn_id: 'running-new', input: 'new work' });
    await vi.waitFor(() => expect(f.queries[0]!.inputs).toHaveLength(2));
    const second = f.queries[0]!.inputs[1]!.uuid;
    f.queries[0]!.output.push({
      ...interruptedResult(0.25, 6, 4),
      user_message_uuids: [first],
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(completions(events)).toEqual([
      expect.objectContaining({ turn_id: 'interrupted-old', status: 'interrupted' }),
    ]);
    expect((await f.adapter.inspect(handle)).state).toBe('running');
    f.queries[0]!.output.push({ ...result(0.3, 8, 9), user_message_uuids: [second] });
    await vi.waitFor(() => expect(completions(events)).toHaveLength(2));
    expect(completions(events)[1]).toMatchObject({
      turn_id: 'running-new',
      status: 'completed',
    });
    const usage = events
      .filter((event) => event.kind === 'usage.updated')
      .find((event) => event.turn_id === 'running-new');
    expect(usage).toMatchObject({ input_tokens: 2, output_tokens: 5 });
    expect(usage?.cost_usd).toBeCloseTo(0.05);
  });

  it('interrupts the running turn with its queued inputs cancelled', async () => {
    const f = fakeClaude();
    const { handle, events } = await opened(f);
    await f.adapter.send(handle, {
      turn_id: 'interrupted-turn',
      input: 'long work',
    });
    await vi.waitFor(() => expect(f.queries[0]!.inputs).toHaveLength(1));
    f.queries[0]!.output.push(init);
    expect(await f.adapter.interrupt!(handle)).toEqual({ ok: true });
    expect(f.queries[0]!.interrupts).toEqual([{ cancelQueued: true }]);
    f.queries[0]!.output.push({ ...interruptedResult(0.1, 3, 2), queued_turn_count: 1 });
    await vi.waitFor(() => expect(completions(events)).toHaveLength(1));
    expect(completions(events)[0]).toMatchObject({
      turn_id: 'interrupted-turn',
      status: 'interrupted',
    });
    expect(completions(events)[0]).not.toHaveProperty('error', expect.any(String));
    expect(events.filter((event) => event.kind === 'usage.updated')).toEqual([
      expect.objectContaining({ turn_id: 'interrupted-turn', input_tokens: 3, output_tokens: 2 }),
    ]);
  });

  it('ends an interrupted turn whose steer was never answered', async () => {
    const f = fakeClaude();
    const { handle, events } = await opened(f);
    await f.adapter.send(handle, {
      turn_id: 'steered-interrupted-turn',
      input: 'start work',
    });
    await vi.waitFor(() => expect(f.queries[0]!.inputs).toHaveLength(1));
    await f.adapter.steer!(handle, {
      turn_id: 'unanswered-steer',
      input: 'also update the docs',
    });
    await vi.waitFor(() => expect(f.queries[0]!.inputs).toHaveLength(2));
    const [first] = f.queries[0]!.inputs.map((input) => input.uuid);
    f.queries[0]!.output.push(init);
    expect(await f.adapter.interrupt!(handle)).toEqual({ ok: true });
    expect(
      await f.adapter.steer!(handle, {
        turn_id: 'steer-after-interrupt',
        input: 'one more thing',
      }),
    ).toMatchObject({ turn_id: 'steer-after-interrupt', status: 'queued' });
    f.queries[0]!.output.push({
      ...interruptedResult(0.1),
      user_message_uuid: first,
      user_message_uuids: [first],
    });
    await vi.waitFor(() => expect(completions(events)).toHaveLength(1));
    expect(completions(events)[0]).toMatchObject({
      turn_id: 'steered-interrupted-turn',
      status: 'interrupted',
    });
    expect(f.queries[0]!.inputs).toHaveLength(2);
  });

  it('ends the turn at once when the interrupt cancels every send of it', async () => {
    const f = fakeClaude();
    const { handle, events } = await opened(f);
    await f.adapter.send(handle, {
      turn_id: 'cancelled-before-start',
      input: 'long work',
    });
    await vi.waitFor(() => expect(f.queries[0]!.inputs).toHaveLength(1));
    const [first] = f.queries[0]!.inputs.map((input) => input.uuid);
    f.queries[0]!.interruptReply = async () => ({ still_queued: [], cancelled: [first] });
    expect(await f.adapter.interrupt!(handle)).toEqual({ ok: true });
    await vi.waitFor(() => expect(completions(events)).toHaveLength(1));
    expect(completions(events)[0]).toMatchObject({
      turn_id: 'cancelled-before-start',
      status: 'interrupted',
    });
  });

  it('keeps the turn and lets later steers through when the interrupt is refused', async () => {
    const f = fakeClaude();
    const { handle, events } = await opened(f);
    await f.adapter.send(handle, {
      turn_id: 'refused-interrupt',
      input: 'long work',
    });
    await vi.waitFor(() => expect(f.queries[0]!.inputs).toHaveLength(1));
    f.queries[0]!.output.push(init);
    f.queries[0]!.interruptReply = async () => {
      throw new Error('interrupt refused');
    };
    expect(await f.adapter.interrupt!(handle)).toMatchObject({ ok: false });
    expect(
      await f.adapter.steer!(handle, {
        turn_id: 'steer-after-refusal',
        input: 'also update the docs',
      }),
    ).toMatchObject({ status: 'delivered' });
    await vi.waitFor(() => expect(f.queries[0]!.inputs).toHaveLength(2));
    const [first, steer] = f.queries[0]!.inputs.map((input) => input.uuid);
    f.queries[0]!.output.push({ ...result(0.1), user_message_uuids: [first] });
    await new Promise((resolve) => setImmediate(resolve));
    expect(completions(events)).toEqual([]);
    f.queries[0]!.output.push({ ...result(0.2), user_message_uuids: [steer] });
    await vi.waitFor(() => expect(completions(events)).toHaveLength(1));
    expect(completions(events)[0]).toMatchObject({
      turn_id: 'refused-interrupt',
      status: 'completed',
    });
  });

  it('runs the next send on the same query after an interrupt', async () => {
    const f = fakeClaude();
    const { handle, events } = await opened(f);
    expect(await f.adapter.interrupt!(handle)).toMatchObject({
      ok: false,
      reason: expect.any(String),
    });
    await f.adapter.send(handle, {
      turn_id: 'interrupted-first',
      input: 'long work',
    });
    await vi.waitFor(() => expect(f.queries[0]!.inputs).toHaveLength(1));
    f.queries[0]!.output.push(init);
    await f.adapter.interrupt!(handle);
    f.queries[0]!.output.push(interruptedResult(0.1));
    await vi.waitFor(() => expect(completions(events)).toHaveLength(1));
    await turn(f, handle, events, 'after-interrupt', [result(0.2)]);
    expect(f.queryFn).toHaveBeenCalledOnce();
    expect(completions(events).at(-1)).toMatchObject({
      turn_id: 'after-interrupt',
      status: 'completed',
    });
  });

  it('stops the one session process on cancel and interrupts the running turn', async () => {
    const f = fakeClaude(true);
    const { handle, events } = await opened(f);
    const identity = handle.process_identity!;
    await turn(f, handle, events, 'first-process-turn', [init, result(0)]);
    await turn(f, handle, events, 'second-process-turn', [result(0)]);
    await f.adapter.send(handle, {
      turn_id: 'cancelled-turn',
      input: 'keep going',
    });
    expect(await f.adapter.cancel(handle, Date.now() + 2000)).toMatchObject({
      stopped: true,
      evidence: {
        method: 'process_group',
        members: [identity],
        exits: [{ pid: identity.pid, code: 0, signal: null }],
      },
    });
    expect(completions(events).at(-1)).toMatchObject({
      turn_id: 'cancelled-turn',
      status: 'interrupted',
    });
    expect((await f.adapter.inspect(handle)).state).toBe('exited');
  });
});
