import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAdapter, CodexAdapter } from '@pantheon/adapters';
import { NATIVE_ENV_ALLOWLIST, type AgentEvent, type SessionSpec } from '@pantheon/domain';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

const spec = (runtime: string): SessionSpec => ({
  platform_session_id: 'reasoning-session',
  project_id: 'reasoning-project',
  runtime,
  device_id: 'local',
  role: 'writer',
  cwd: process.cwd(),
  env_allowlist: NATIVE_ENV_ALLOWLIST,
  skills: [],
  mcp_servers: [],
  budget: { max_turns: 4, wall_time_ms: 10000 },
});

type Frame = { method: string; params?: Record<string, unknown> };

async function codexTurn(frames: Frame[]): Promise<AgentEvent[]> {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  const events: AgentEvent[] = [];
  const send = (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n');
  child.stdin.on('data', (data) => {
    const request = JSON.parse(String(data));
    if (request.method === 'initialize') send({ id: request.id, result: {} });
    if (request.method === 'account/read')
      send({ id: request.id, result: { account: { type: 'chatgpt', planType: 'plus' } } });
    if (request.method === 'config/read')
      send({ id: request.id, result: { config: { model_provider: 'openai' } } });
    if (request.method === 'thread/name/set') send({ id: request.id, result: {} });
    if (request.method === 'thread/start')
      send({ id: request.id, result: { thread: { id: 'reasoning-thread' } } });
    if (request.method === 'turn/start') {
      const id = 'native-turn';
      for (const frame of frames)
        send({ ...frame, params: { threadId: 'reasoning-thread', turnId: id, ...frame.params } });
      send({ id: request.id, result: { turn: { id } } });
      send({
        method: 'turn/completed',
        params: { threadId: 'reasoning-thread', turn: { id, status: 'completed' } },
      });
    }
  });
  const adapter = new CodexAdapter('fake-codex');
  const handle = await adapter.start(spec('codex'), (event) => events.push(event));
  try {
    await adapter.send(handle, { turn_id: 'reasoning-turn', input: '' });
    expect(events.at(-1)).toMatchObject({ kind: 'turn.completed', status: 'completed' });
    return events;
  } finally {
    child.emit('close', 0, null);
    await adapter.close(handle, Date.now() + 1000);
  }
}

async function claudeTurn(messages: unknown[]): Promise<AgentEvent[]> {
  vi.mocked(query).mockImplementation(
    ({ prompt }) =>
      ({
        async initializationResult() {
          return { account: { subscriptionType: 'max', apiProvider: 'firstParty' } };
        },
        close() {},
        async *[Symbol.asyncIterator]() {
          if (typeof prompt !== 'string') await prompt[Symbol.asyncIterator]().next();
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
    await adapter.send(handle, { turn_id: 'reasoning-turn', input: '' });
    await done;
    return events;
  } finally {
    await adapter.close(handle, Date.now() + 1000);
  }
}

const result = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0 },
  modelUsage: {},
};

describe('reasoning events', () => {
  it('turns readable Claude thinking into reasoning and leaves signatures and redacted blocks out', async () => {
    const events = await claudeTurn([
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          id: 'message-1',
          content: [
            { type: 'thinking', thinking: 'Check the config first.', signature: 'sig-secret' },
            { type: 'redacted_thinking', data: 'encrypted-secret' },
            { type: 'thinking', thinking: '  ', signature: 'sig-empty' },
            { type: 'text', text: 'Looking.' },
          ],
        },
      },
      {
        type: 'assistant',
        parent_tool_use_id: 'agent-call',
        message: {
          id: 'message-2',
          content: [{ type: 'thinking', thinking: 'Subagent musing.', signature: 'sig-sub' }],
        },
      },
      result,
    ]);
    const reasoning = events.filter((event) => event.kind === 'reasoning');
    expect(reasoning).toEqual([
      expect.objectContaining({
        kind: 'reasoning',
        text: 'Check the config first.',
        turn_id: 'reasoning-turn',
        native_type: 'assistant',
      }),
    ]);
    expect(reasoning[0]).not.toHaveProperty('summary');
    expect(JSON.stringify(events)).not.toMatch(/sig-|encrypted-secret/);
    // The reasoning stays ahead of the text that followed it.
    expect(events.findIndex((event) => event.kind === 'reasoning')).toBeLessThan(
      events.findIndex((event) => event.kind === 'message.delta'),
    );
  });

  it('turns a completed Codex reasoning summary into reasoning and skips one without a summary', async () => {
    const events = await codexTurn([
      {
        method: 'item/started',
        params: { item: { id: 'reasoning-1', type: 'reasoning', summary: [], content: [] } },
      },
      {
        method: 'item/completed',
        params: {
          item: {
            id: 'reasoning-1',
            type: 'reasoning',
            summary: ['**Reading the tests**', 'Then the adapter.'],
            content: [],
          },
        },
      },
      {
        method: 'item/completed',
        params: { item: { id: 'reasoning-2', type: 'reasoning', summary: [], content: [] } },
      },
    ]);
    expect(events.filter((event) => event.kind === 'reasoning')).toEqual([
      expect.objectContaining({
        text: '**Reading the tests**\n\nThen the adapter.',
        summary: true,
        turn_id: 'reasoning-turn',
        native_type: 'item/completed',
      }),
    ]);
    expect(
      events.filter((event) => event.kind === 'native').map((event) => event.native_type),
    ).toEqual(['item/started', 'item/completed']);
  });
});
