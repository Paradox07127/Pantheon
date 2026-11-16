import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexAdapter } from '../../packages/adapters/src/codex.js';
import { JsonRpcProcess } from '../../packages/adapters/src/process.js';
import { NATIVE_ENV_ALLOWLIST, type AgentEvent, type SessionSpec } from '@pantheon/domain';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const spec: SessionSpec = {
  platform_session_id: 'title-session',
  project_id: 'title-project',
  runtime: 'codex',
  device_id: 'local',
  role: 'writer',
  cwd: process.cwd(),
  model: 'gpt-main',
  auto_title: true,
  env_allowlist: NATIVE_ENV_ALLOWLIST,
  skills: [],
  mcp_servers: [],
  budget: { max_turns: 1, wall_time_ms: 10000 },
};

const INSTRUCTIONS =
  "Generate a concise, single-line task title of at most 36 characters and under five words where possible. Start with an imperative verb. Capitalize only the first word unless the user's language, proper nouns, acronyms, or code terms require otherwise. Preserve ticket references exactly. Write in the user's language. Do not use quotes, markdown, or trailing punctuation. Do not answer the request.";

type Request = { id: number; method: string; params: Record<string, unknown> };

/** A fake app-server whose session thread ends each turn at once and whose hidden thread answers with `answer`. */
function fakeAppServer(
  options: {
    models?: string[];
    answer?: string;
    status?: string;
    name?: string | null;
    provider?: string;
  } = {},
) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  const requests: Request[] = [];
  const write = (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n');
  let turns = 0;
  child.stdin.on('data', (data) => {
    for (const line of String(data).split('\n').filter(Boolean)) {
      const request = JSON.parse(line) as Request;
      requests.push(request);
      const reply = (result: unknown) => write({ id: request.id, result });
      const hidden = request.params.threadId === 'title-thread';
      switch (request.method) {
        case 'initialize':
          return reply({});
        case 'account/read':
          return reply({ account: { type: 'chatgpt', planType: 'plus' } });
        case 'config/read':
          return reply({
            config: { model_provider: options.provider ?? 'openai', mcp_servers: { docs: {} } },
          });
        case 'model/list':
          return reply({
            data: (options.models ?? []).map((model) => ({ model })),
            nextCursor: null,
          });
        case 'thread/start':
          if (!request.params.ephemeral) return reply({ thread: { id: 'main-thread' } });
          write({
            method: 'thread/started',
            params: {
              thread: { id: 'title-thread', ephemeral: true, threadSource: 'thread_title' },
            },
          });
          return reply({ thread: { id: 'title-thread' }, sandbox: { type: 'readOnly' } });
        case 'turn/start': {
          const thread = String(request.params.threadId),
            id = hidden ? 'title-turn' : `main-turn-${++turns}`;
          reply({ turn: { id } });
          if (hidden) {
            write({ method: 'turn/started', params: { threadId: thread, turn: { id } } });
            write({
              method: 'item/completed',
              params: {
                threadId: thread,
                turnId: id,
                item: { type: 'agentMessage', id: 'answer', text: options.answer ?? '' },
              },
            });
          }
          return write({
            method: 'turn/completed',
            params: {
              threadId: thread,
              turn: { id, status: hidden ? (options.status ?? 'completed') : 'completed' },
            },
          });
        }
        case 'thread/read':
          return reply({ thread: { id: 'main-thread', name: options.name ?? null } });
        case 'thread/name/set':
        case 'thread/unsubscribe':
          return reply({});
      }
    }
  });
  const originalClose = JsonRpcProcess.prototype.close;
  vi.spyOn(JsonRpcProcess.prototype, 'close').mockImplementation(function (
    this: JsonRpcProcess,
    deadline?: number,
  ) {
    child.emit('close', 0, null);
    return originalClose.call(this, deadline);
  });
  const sent = (method: string) => requests.filter((request) => request.method === method);
  return { requests, sent };
}

async function run(sessionSpec: SessionSpec, inputs: string[]) {
  const adapter = new CodexAdapter('fake-codex');
  const events: AgentEvent[] = [];
  const handle = await adapter.start(sessionSpec, (event) => events.push(event));
  for (const [index, input] of inputs.entries()) {
    await adapter.send(handle, { turn_id: `turn-${index}`, input });
    await vi.waitFor(() =>
      expect(events.filter((event) => event.kind === 'turn.completed')).toHaveLength(index + 1),
    );
  }
  return { events, close: () => adapter.close(handle, Date.now() + 1000) };
}

describe('Codex thread titles', () => {
  it('names a new thread from a hidden structured turn, as the Codex TUI does', async () => {
    const server = fakeAppServer({
      models: ['gpt-main', 'gpt-5.6-luna'],
      answer: JSON.stringify({ title: '"Fix importer rows."' }),
    });
    const { events, close } = await run(spec, ['  Fix the importer, it drops rows  ']);
    try {
      await vi.waitFor(() =>
        expect(events.filter((event) => event.kind === 'title.generated')).toMatchObject([
          { title: 'Fix importer rows' },
        ]),
      );
      const methods = server.requests.map((request) => request.method);
      expect(methods.indexOf('thread/name/set')).toBeGreaterThan(methods.indexOf('thread/read'));
      expect(server.sent('thread/name/set').map((request) => request.params)).toEqual([
        { threadId: 'main-thread', name: 'Fix importer rows' },
      ]);
      expect(server.sent('model/list')[0]!.params).toEqual({ includeHidden: true });
      expect(server.sent('thread/start')[1]!.params).toMatchObject({
        model: 'gpt-5.6-luna',
        modelProvider: 'openai',
        cwd: spec.cwd,
        sandbox: 'read-only',
        ephemeral: true,
        threadSource: 'thread_title',
        environments: [],
        dynamicTools: [],
        config: {
          'features.shell_tool': false,
          'features.plugins': false,
          web_search: 'disabled',
          default_permissions: ':read-only',
          mcp_servers: { docs: { enabled: false } },
        },
      });
      expect(server.sent('turn/start')[1]!.params).toEqual({
        threadId: 'title-thread',
        input: [
          {
            type: 'text',
            text: `${INSTRUCTIONS}\n\nUser prompt:\nFix the importer, it drops rows`,
            text_elements: [],
          },
        ],
        outputSchema: {
          type: 'object',
          properties: { title: { type: 'string', minLength: 1, maxLength: 36 } },
          required: ['title'],
          additionalProperties: false,
        },
        effort: 'low',
      });
      expect(server.sent('thread/read')[0]!.params).toMatchObject({ threadId: 'main-thread' });
      expect(server.sent('thread/unsubscribe')[0]!.params).toEqual({ threadId: 'title-thread' });
      expect(JSON.stringify(events)).not.toContain('title-thread');
      expect(JSON.stringify(events)).not.toContain('title-turn');
    } finally {
      await close();
    }
  });

  it('uses the session model on an account without the title model and cuts the prompt at 960 bytes', async () => {
    const server = fakeAppServer({
      answer: JSON.stringify({ title: 'Keep every row while importing CSV data files!' }),
    });
    const { events, close } = await run(spec, ['字'.repeat(400), 'Add a test']);
    try {
      await vi.waitFor(() =>
        expect(events.filter((event) => event.kind === 'title.generated')).toMatchObject([
          { title: 'Keep every row while importing CSV d' },
        ]),
      );
      const hidden = server.sent('turn/start').find((r) => r.params.threadId === 'title-thread')!;
      expect(hidden.params).not.toHaveProperty('effort');
      expect(server.sent('thread/start')[1]!.params).toMatchObject({ model: 'gpt-main' });
      const text = (hidden.params.input as { text: string }[])[0]!.text;
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(960);
      expect(Buffer.byteLength(text)).toBeGreaterThan(957);
      expect(text.endsWith('字')).toBe(true);
      expect(server.sent('thread/start').filter((r) => r.params.ephemeral)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('runs the title turn of a backend session on the backend provider', async () => {
    const server = fakeAppServer({
      answer: JSON.stringify({ title: 'Fix importer rows' }),
      provider: 'pantheon-relay',
    });
    const backend = {
      id: 'relay',
      protocol: 'openai-responses',
      base_url: 'https://relay.example.invalid/v1',
      api_key: 'sk-relay-key',
    };
    const { events, close } = await run({ ...spec, backend }, ['Fix the importer']);
    try {
      await vi.waitFor(() =>
        expect(events.filter((event) => event.kind === 'title.generated')).toHaveLength(1),
      );
      expect(server.sent('thread/start').map((request) => request.params.modelProvider)).toEqual([
        'pantheon-relay',
        'pantheon-relay',
      ]);
    } finally {
      await close();
    }
  });

  it('leaves a thread that already has a name alone', async () => {
    const server = fakeAppServer({
      answer: JSON.stringify({ title: 'Fix importer rows' }),
      name: 'Named elsewhere',
    });
    const { events, close } = await run(spec, ['Fix the importer']);
    try {
      await vi.waitFor(() => expect(server.sent('thread/read')).toHaveLength(1));
      await delay(50);
      expect(server.sent('thread/name/set')).toEqual([]);
      expect(events.some((event) => event.kind === 'title.generated')).toBe(false);
    } finally {
      await close();
    }
  });

  it('logs a failed title turn and sends no title', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = fakeAppServer({ answer: 'not json', status: 'failed' });
    const { events, close } = await run(spec, ['Fix the importer']);
    try {
      await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
      expect(server.sent('thread/read')).toEqual([]);
      expect(server.sent('thread/name/set')).toEqual([]);
      expect(events.some((event) => event.kind === 'title.generated')).toBe(false);
    } finally {
      await close();
    }
  });
});
