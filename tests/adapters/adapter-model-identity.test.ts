import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAdapter } from '../../packages/adapters/src/claude.js';
import { CodexAdapter } from '../../packages/adapters/src/codex.js';
import { JsonRpcProcess } from '../../packages/adapters/src/process.js';
import { NATIVE_ENV_ALLOWLIST, type AgentEvent, type SessionSpec } from '@pantheon/domain';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

function spec(runtime: string, model?: string): SessionSpec {
  return {
    platform_session_id: 'model-session',
    project_id: 'model-project',
    runtime,
    model,
    device_id: 'local',
    role: 'writer',
    cwd: process.cwd(),
    env_allowlist: NATIVE_ENV_ALLOWLIST,
    skills: [],
    mcp_servers: [],
    budget: { max_turns: 1, wall_time_ms: 1000 },
  };
}

function fakeCodex(reportedModel: unknown) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  child.stdin.on('data', (data) => {
    const frame = JSON.parse(String(data));
    requests.push(frame);
    if (frame.id === undefined) return;
    const result =
      frame.method === 'account/read'
        ? { account: { type: 'chatgpt' } }
        : frame.method === 'config/read'
          ? { config: {} }
          : frame.method.startsWith('thread/')
            ? { thread: { id: 'native-thread' }, model: reportedModel }
            : {};
    child.stdout.write(JSON.stringify({ id: frame.id, result }) + '\n');
  });
  vi.spyOn(JsonRpcProcess.prototype, 'close').mockImplementation(async function (
    this: JsonRpcProcess,
    deadline = Date.now(),
  ) {
    this.child.emit('close', 0, null);
    return {
      stopped: true,
      deadline,
      finished_at: new Date().toISOString(),
      evidence: { method: 'none', members: [] },
    };
  });
  return requests;
}

function fakeClaude(models: unknown[]) {
  let queryIndex = 0;
  const closed = vi.fn();
  const query = vi.fn(() => {
    const model = models[queryIndex++];
    return {
      initializationResult: async () => ({
        account: { apiProvider: 'firstParty', subscriptionType: 'max' },
      }),
      close: closed,
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'native-thread',
          model,
          tools: [],
          mcp_servers: [],
          skills: [],
        };
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          usage: { input_tokens: 1, output_tokens: 1 },
          total_cost_usd: 0,
        };
      },
    };
  });
  return { adapter: new ClaudeAdapter('unused-binary', 'test', query as never), query, closed };
}

describe.each(['start', 'resume'] as const)('adapter model identity on %s', (method) => {
  it.each([
    ['requested-alias', 'server-model', 'server-model'],
    [undefined, 'server-default', 'server-default'],
    ['requested-alias', undefined, undefined],
    ['requested-alias', '', undefined],
    ['requested-alias', '   ', undefined],
    ['requested-alias', null, undefined],
  ])('records Codex request %s and report %s separately', async (requested, reported, expected) => {
    const requests = fakeCodex(reported);
    const adapter = new CodexAdapter('unused-binary', 'test');
    const events: AgentEvent[] = [];
    const sessionSpec = spec('codex', requested);
    sessionSpec.native_title = 'Pantheon · model identity probe';
    const handle =
      method === 'start'
        ? await adapter.start(sessionSpec, (event) => events.push(event))
        : await adapter.resume(sessionSpec, 'native-thread', (event) => events.push(event));
    try {
      expect(handle.requested_model).toBe(requested);
      expect(handle.reported_model).toBe(expected);
      expect(requests.find((request) => request.method === 'thread/name/set')?.params).toEqual({
        threadId: 'native-thread',
        name: sessionSpec.native_title,
      });
      const started = events.find((event) => event.kind === 'session.started');
      expect(started).toMatchObject({ reported_model: expected });
      expect(started).not.toHaveProperty('requested_model');
      const params = requests.find((request) => request.method === `thread/${method}`)!.params;
      expect(params.model).toBe(requested);
      expect(params.modelProvider).toBe('openai');
      if (method === 'resume') expect(params.threadId).toBe('native-thread');
    } finally {
      await adapter.close(handle, Date.now() + 1000);
    }
  });

  it.each([
    ['requested-alias', 'server-model', 'server-model'],
    [undefined, 'server-default', 'server-default'],
    ['requested-alias', undefined, undefined],
    ['requested-alias', '', undefined],
    ['requested-alias', '   ', undefined],
    ['requested-alias', null, undefined],
  ])(
    'records Claude request %s only after the init reports %s',
    async (requested, reported, expected) => {
      const { adapter, query } = fakeClaude([reported]);
      const events: AgentEvent[] = [];
      const done = Promise.withResolvers<void>();
      const sink = (event: AgentEvent) => {
        events.push(event);
        if (event.kind === 'turn.completed') done.resolve();
      };
      const sessionSpec = spec('claude', requested);
      const handle =
        method === 'start'
          ? await adapter.start(sessionSpec, sink)
          : await adapter.resume(sessionSpec, 'native-thread', sink);
      try {
        expect(handle.requested_model).toBe(requested);
        expect(handle.reported_model).toBeUndefined();
        expect(events.some((event) => event.kind === 'session.started')).toBe(false);
        await adapter.send(handle, {
          turn_id: 'first-turn',
          input: 'hello',
        });
        await done.promise;
        expect(handle.reported_model).toBe(expected);
        expect(events.find((event) => event.kind === 'session.started')).toMatchObject({
          requested_model: requested,
          reported_model: expected,
        });
        expect(handle.native_title).toBe(
          method === 'start' ? 'Pantheon · writer · model-se' : undefined,
        );
        expect(query.mock.calls[0]).toEqual([
          expect.objectContaining({
            options: expect.objectContaining({
              model: requested,
              resume: method === 'resume' ? 'native-thread' : undefined,
              ...(method === 'start' ? { title: 'Pantheon · writer · model-se' } : {}),
              persistSession: true,
            }),
          }),
        ]);
      } finally {
        await adapter.close(handle, Date.now());
      }
    },
  );
});

it('refreshes the Claude report on later native queries while preserving the requested model', async () => {
  const { adapter, query, closed } = fakeClaude(['first-model', 'second-model', undefined]);
  const events: AgentEvent[] = [];
  let done = Promise.withResolvers<void>();
  const handle = await adapter.start(spec('claude', 'requested-alias'), (event) => {
    events.push(event);
    if (event.kind === 'turn.completed') done.resolve();
  });
  try {
    for (const [index, reported] of ['first-model', 'second-model', undefined].entries()) {
      done = Promise.withResolvers<void>();
      await adapter.send(handle, {
        turn_id: `turn-${index}`,
        input: 'hello',
      });
      await done.promise;
      expect(handle.reported_model).toBe(reported);
      // Each fake query ends after one result; the next send resumes in a new query.
      await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(index + 1));
    }
    expect(
      events
        .filter((event) => event.kind === 'session.started')
        .map((event) => event.reported_model),
    ).toEqual(['first-model', 'second-model', undefined]);
    for (const call of query.mock.calls)
      expect(call).toEqual([
        expect.objectContaining({ options: expect.objectContaining({ model: 'requested-alias' }) }),
      ]);
    expect(query.mock.calls[1]).toEqual([
      expect.objectContaining({ options: expect.objectContaining({ resume: 'native-thread' }) }),
    ]);
  } finally {
    await adapter.close(handle, Date.now());
  }
});
