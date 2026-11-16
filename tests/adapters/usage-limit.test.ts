import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  Options,
  SDKUserMessage,
} from '../../packages/adapters/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts';
import { CodexAdapter } from '@pantheon/adapters';
import { ClaudeAdapter } from '../../packages/adapters/src/claude.js';
import { NATIVE_ENV_ALLOWLIST, type AgentEvent, type SessionSpec } from '@pantheon/domain';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

const roots: string[] = [];
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sessionSpec(runtime: 'claude' | 'codex'): SessionSpec {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pantheon-usage-limit-')));
  roots.push(root);
  return {
    platform_session_id: 'usage-limit-session',
    project_id: 'usage-limit-project',
    runtime,
    device_id: 'local',
    role: 'writer',
    cwd: root,
    env_allowlist: NATIVE_ENV_ALLOWLIST,
    skills: [],
    mcp_servers: [],
    budget: { max_turns: 1, wall_time_ms: 10000 },
  };
}

const completion = (events: AgentEvent[]) =>
  events.find((event) => event.kind === 'turn.completed');

/** Runs one Claude turn on a fake query that replays the given messages. */
async function claudeTurn(messages: unknown[]): Promise<AgentEvent | undefined> {
  const inputs: SDKUserMessage[] = [];
  let output: (message: unknown) => void = () => {};
  const queryFn = vi.fn(
    ({ prompt }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      const items: unknown[] = [];
      let wake: (() => void) | undefined;
      let done = false;
      output = (message) => {
        items.push(message);
        wake?.();
      };
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
        async *[Symbol.asyncIterator]() {
          for (;;) {
            if (items.length) {
              yield items.shift();
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
  const adapter = new ClaudeAdapter('fake-claude', 'test', queryFn as never);
  const events: AgentEvent[] = [];
  const handle = await adapter.start(sessionSpec('claude'), (event) => events.push(event));
  cleanup.push(() => adapter.close(handle, Date.now() + 1000));
  await adapter.send(handle, { turn_id: 'limited-turn', input: 'work' });
  await vi.waitFor(() => expect(inputs).toHaveLength(1));
  for (const message of messages) output(message);
  await vi.waitFor(() => expect(completion(events)).toBeDefined());
  return completion(events);
}

const init = {
  type: 'system',
  subtype: 'init',
  session_id: 'native-usage-limit',
  model: 'claude-model',
  tools: [],
  mcp_servers: [],
  skills: [],
};
const failedResult = {
  type: 'result',
  subtype: 'success',
  is_error: true,
  total_cost_usd: 0,
  usage: { input_tokens: 1, output_tokens: 0 },
};
const claudeResetSeconds = 1793599736;

/** Runs one Codex turn on a fake app-server that sends the given notifications after turn/start. */
async function codexTurn(notifications: unknown[]): Promise<AgentEvent | undefined> {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  const write = (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n');
  child.stdin.on('data', (data) => {
    for (const line of String(data).split('\n').filter(Boolean)) {
      const request = JSON.parse(line) as { id: number; method: string };
      if (request.method === 'initialize') write({ id: request.id, result: {} });
      if (request.method === 'account/read')
        write({ id: request.id, result: { account: { type: 'chatgpt', planType: 'plus' } } });
      if (request.method === 'config/read')
        write({ id: request.id, result: { config: { model_provider: 'openai' } } });
      if (request.method === 'thread/name/set') write({ id: request.id, result: {} });
      if (request.method === 'thread/start')
        write({ id: request.id, result: { thread: { id: 'usage-thread' } } });
      if (request.method === 'turn/start') {
        write({ id: request.id, result: { turn: { id: 'native-turn' } } });
        for (const notification of notifications) write(notification);
      }
    }
  });
  const adapter = new CodexAdapter('fake-codex');
  const events: AgentEvent[] = [];
  const handle = await adapter.start(sessionSpec('codex'), (event) => events.push(event));
  cleanup.push(async () => {
    child.emit('close', 0, null);
    await adapter.close(handle, Date.now() + 1000);
  });
  await adapter.send(handle, { turn_id: 'limited-turn', input: 'work' });
  await vi.waitFor(() => expect(completion(events)).toBeDefined());
  return completion(events);
}

const rateLimits = (
  primary: { usedPercent: number; resetsAt: number },
  secondary: { usedPercent: number; resetsAt: number },
) => ({
  method: 'account/rateLimits/updated',
  params: {
    rateLimits: {
      limitId: 'codex',
      primary: { ...primary, windowDurationMins: 300 },
      secondary: { ...secondary, windowDurationMins: 10080 },
    },
  },
});
const failedTurn = (codexErrorInfo: string) => ({
  method: 'turn/completed',
  params: {
    threadId: 'usage-thread',
    turn: {
      id: 'native-turn',
      status: 'failed',
      error: { message: 'limit reached', codexErrorInfo },
    },
  },
});

describe('usage limit on a failed turn', () => {
  it('reports a Claude turn rejected by the usage limit with its reset time in milliseconds', async () => {
    const completed = await claudeTurn([
      init,
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          resetsAt: claudeResetSeconds,
          rateLimitType: 'five_hour',
        },
        uuid: 'rate-limit-event',
        session_id: 'native-usage-limit',
      },
      failedResult,
    ]);
    expect(completed).toMatchObject({
      status: 'failed',
      error_code: 'usage_limit',
      resets_at: claudeResetSeconds * 1000,
    });
  });

  it('reports a Claude turn whose assistant message carries the rate limit error as a usage limit', async () => {
    const completed = await claudeTurn([
      init,
      {
        type: 'assistant',
        parent_tool_use_id: null,
        error: 'rate_limit',
        message: { id: 'limit-message', content: [{ type: 'text', text: 'limit reached' }] },
      },
      failedResult,
    ]);
    expect(completed).toMatchObject({ status: 'failed', error_code: 'usage_limit' });
    expect(completed).not.toHaveProperty('resets_at', expect.any(Number));
  });

  it('keeps a Claude failure without a rate limit signal a plain failure', async () => {
    const completed = await claudeTurn([init, failedResult]);
    expect(completed).toMatchObject({ status: 'failed', error: 'Claude result: success' });
    expect(completed).not.toHaveProperty('error_code', 'usage_limit');
  });

  it('reports a Codex turn over the usage limit with the full window reset in milliseconds', async () => {
    const completed = await codexTurn([
      rateLimits(
        { usedPercent: 100, resetsAt: 1793500000 },
        { usedPercent: 40, resetsAt: 1793900000 },
      ),
      failedTurn('usageLimitExceeded'),
    ]);
    expect(completed).toMatchObject({
      status: 'failed',
      error_code: 'usage_limit',
      resets_at: 1793500000 * 1000,
    });
  });

  it('takes the later reset when both Codex windows are used up', async () => {
    const completed = await codexTurn([
      rateLimits(
        { usedPercent: 100, resetsAt: 1793500000 },
        { usedPercent: 100, resetsAt: 1793900000 },
      ),
      failedTurn('usageLimitExceeded'),
    ]);
    expect(completed).toMatchObject({ error_code: 'usage_limit', resets_at: 1793900000 * 1000 });
  });

  it('reads the Codex usage limit from an error notification of the turn', async () => {
    const completed = await codexTurn([
      rateLimits(
        { usedPercent: 100, resetsAt: 1793500000 },
        { usedPercent: 40, resetsAt: 1793900000 },
      ),
      {
        method: 'error',
        params: {
          threadId: 'usage-thread',
          turnId: 'native-turn',
          willRetry: false,
          error: { message: 'limit reached', codexErrorInfo: 'usageLimitExceeded' },
        },
      },
      {
        method: 'turn/completed',
        params: {
          threadId: 'usage-thread',
          turn: { id: 'native-turn', status: 'failed', error: { message: 'limit reached' } },
        },
      },
    ]);
    expect(completed).toMatchObject({ error_code: 'usage_limit', resets_at: 1793500000 * 1000 });
  });

  it('keeps a Codex short-term rate limit a plain failure', async () => {
    const completed = await codexTurn([
      rateLimits(
        { usedPercent: 100, resetsAt: 1793500000 },
        { usedPercent: 40, resetsAt: 1793900000 },
      ),
      failedTurn('rateLimitExceeded'),
    ]);
    expect(completed).toMatchObject({ status: 'failed', error: expect.stringContaining('failed') });
    expect(completed).not.toHaveProperty('error_code', 'usage_limit');
    expect(completed).not.toHaveProperty('resets_at', expect.any(Number));
  });
});
