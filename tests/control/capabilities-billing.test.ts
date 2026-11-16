import { afterAll, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ClaudeAdapter, CodexAdapter, JsonRpcProcess, report } from '@pantheon/adapters';
import {
  DomainError,
  NATIVE_ENV_ALLOWLIST,
  SessionStartError,
  type AgentEvent,
  type SessionHandle,
  type SessionSpec,
} from '@pantheon/domain';
import type { SDKUserMessage } from '../../packages/adapters/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts';
import { runtime } from '../../packages/control/dist/admission.js';
import type { ControlContext } from '../../packages/control/src/context.js';

const versions = [
  ['codex', 'codex-cli 0.165.0', '2026-10-28'],
  ['claude', '2.1.312 (Claude Code)', '2026-10-27'],
] as const;

const cache = path.join(process.cwd(), 'node_modules/.cache');
mkdirSync(cache, { recursive: true });
const root = mkdtempSync(path.join(cache, 'billing-tests-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const spec = (name: string): SessionSpec => ({
  platform_session_id: 'billing-session',
  project_id: 'billing-project',
  runtime: name,
  device_id: 'local',
  role: 'writer',
  cwd: root,
  env_allowlist: NATIVE_ENV_ALLOWLIST,
  skills: [],
  mcp_servers: [],
  budget: { max_turns: 2, wall_time_ms: 10000 },
});

describe('verified capabilities', () => {
  it('reports fixture read isolation with fixture evidence', () => {
    expect(report('fixture', '1', true).capabilities.read_isolation).toEqual({
      status: 'supported',
      evidence: 'Deterministic fixture only; no model or arbitrary command execution',
    });
  });

  it.each(versions)(
    'unlocks only the observed capabilities for %s',
    (name, version, verifiedOn) => {
      // The evidence was observed on macOS, the only platform it applies to.
      const matched = report(name, version, false, {}, 'darwin');
      for (const capability of ['text_execution', 'resume', 'write_isolation', 'read_isolation']) {
        expect(matched.capabilities[capability]).toMatchObject({ status: 'supported' });
        expect(matched.capabilities[capability]?.evidence).toContain(version);
        expect(matched.capabilities[capability]?.evidence).toContain(verifiedOn);
        const other = report(name, `${version}-different`, false, {}, 'darwin').capabilities[
          capability
        ];
        expect(other).toEqual(matched.capabilities[capability]);
      }
      for (const [name, capability] of Object.entries(matched.capabilities))
        if (
          ![
            'text_execution',
            'resume',
            'write_isolation',
            'read_isolation',
            'reattach',
            'manual_compaction',
            'conversation_rollback',
            'fork_within_turn',
            'turn_model_change',
          ].includes(name)
        )
          expect(capability.status).toBe('unknown');
      expect(matched.capabilities.reattach?.status).toBe('unsupported');
      expect(matched.capabilities.manual_compaction?.status).toBe('unsupported');
      expect(matched.capabilities.conversation_rollback?.status).toBe('unsupported');
      expect(matched.capabilities.fork_within_turn?.status).toBe('unsupported');
      expect(matched.capabilities.turn_model_change?.status).toBe('unsupported');
    },
  );

  it.each(versions)(
    'admits text, writers and reviewers for %s whatever version is installed',
    (name, version) => {
      const Adapter = name === 'codex' ? CodexAdapter : ClaudeAdapter;
      const adapter = new Adapter('unused-binary', version);
      const ctx = { adapters: new Map([[name, adapter]]) } as unknown as ControlContext;
      // The evidence was observed on macOS, the only platform it applies to.
      if (process.platform !== 'darwin')
        adapter.report = report(name, version, false, {}, 'darwin');
      for (const role of ['text', 'writer', 'reviewer'] as const)
        expect(runtime(ctx, name, role)).toBe(adapter);
      adapter.report = report(name, `${version}-different`, false, {}, 'darwin');
      for (const role of ['text', 'writer', 'reviewer'] as const)
        expect(runtime(ctx, name, role)).toBe(adapter);
    },
  );
});

// These are synthetic account fields. Only channel/plan may survive projection into events.
const privateFields = {
  email: 'synthetic@example.invalid',
  organization: 'synthetic-organization',
  accountId: 'synthetic-account',
};
function expectRedacted(events: AgentEvent[], method: 'chatgpt' | 'claude.ai', plan: string) {
  expect(events.filter((event) => event.kind === 'auth.checked')).toEqual([
    {
      key: expect.any(String),
      provider_sequence: expect.any(Number),
      kind: 'auth.checked',
      channel: 'subscription',
      method,
      plan,
    },
  ]);
  const serialized = JSON.stringify(events);
  for (const value of Object.values(privateFields)) expect(serialized).not.toContain(value);
  expect(serialized).not.toMatch(/email|organization|accountId/);
  expect(events.map((event) => event.provider_sequence)).toEqual(
    events.map((_, index) => index + 1),
  );
}
function fakeCodex(account: unknown, config: unknown) {
  const directory = mkdtempSync(path.join(root, 'codex-'));
  const requests = path.join(directory, 'methods.jsonl');
  writeFileSync(requests, '');
  const binary = path.join(directory, 'app-server.cjs');
  writeFileSync(
    binary,
    `#!${process.execPath}\n` +
      `const fs = require('node:fs');
const readline = require('node:readline');
const responses = ${JSON.stringify({
        initialize: {},
        'account/read': { account },
        'config/read': { config },
        'thread/start': { thread: { id: 'new-thread' } },
        'thread/resume': { thread: { id: 'previous-thread' } },
      })};
readline.createInterface({input: process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify({method: request.method, modelProvider: request.params?.modelProvider}) + '\\n');
  if (request.id !== undefined)
    process.stdout.write(JSON.stringify({id: request.id, result: responses[request.method] || {}}) + '\\n');
});`,
  );
  chmodSync(binary, 0o755);
  return {
    adapter: new CodexAdapter(binary, versions[0][1]),
    requests: () =>
      readFileSync(requests, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    methods: () =>
      readFileSync(requests, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line).method),
  };
}
const codexAccount = { type: 'chatgpt', planType: 'plus', ...privateFields };

for (const method of ['start', 'resume'] as const) {
  describe(`Codex billing gate on ${method}`, () => {
    it.each([
      ['API key account', { type: 'apiKey', ...privateFields }, {}, 'API key account'],
      ['forced API key', codexAccount, { forced_login_method: 'api' }, 'API key login'],
      [
        'custom provider',
        codexAccount,
        { model_provider: 'custom', model_providers: { custom: { env_key: 'CUSTOM_API_KEY' } } },
        'Custom model provider',
      ],
      [
        'overridden OpenAI provider',
        codexAccount,
        { model_provider: 'openai', model_providers: { openai: { env_key: 'CUSTOM_API_KEY' } } },
        'Custom model provider',
      ],
      ['missing login', null, {}, 'Unverified account channel'],
    ])('refuses %s before creating or resuming a thread', async (_, account, config, message) => {
      const f = fakeCodex(account, config);
      const events: AgentEvent[] = [];
      let handle: SessionHandle | undefined;
      try {
        const failure = await (
          method === 'start'
            ? f.adapter.start(spec('codex'), (event) => events.push(event))
            : f.adapter.resume(spec('codex'), 'previous-thread', (event) => events.push(event))
        ).then(
          (value) => {
            handle = value;
          },
          (error: unknown) => error,
        );
        expect(f.methods()).not.toContain('thread/start');
        expect(f.methods()).not.toContain('thread/resume');
        expect(failure).toBeInstanceOf(DomainError);
        expect(failure).toBeInstanceOf(SessionStartError);
        expect(failure).toMatchObject({
          code: 'billing_channel_mismatch',
          message,
          stop: { stopped: true, evidence: { method: 'process_group', live_count: 0 } },
        });
        expect(events).toEqual([]);
      } finally {
        if (handle) await f.adapter.close(handle, Date.now() + 10000);
      }
    });

    it('checks the account and effective config and emits only the subscription summary', async () => {
      const f = fakeCodex(codexAccount, {
        model_provider: 'openai',
        forced_login_method: 'chatgpt',
      });
      const events: AgentEvent[] = [];
      const handle =
        method === 'start'
          ? await f.adapter.start(spec('codex'), (event) => events.push(event))
          : await f.adapter.resume(spec('codex'), 'previous-thread', (event) => events.push(event));
      try {
        expect(handle.process_identity).toMatchObject({
          pid: expect.any(Number),
          start_time_us: expect.any(Number),
        });
        expect(f.methods().indexOf('account/read')).toBeGreaterThan(-1);
        expect(f.methods().indexOf('config/read')).toBeGreaterThan(-1);
        expect(f.methods().indexOf('account/read')).toBeLessThan(
          f.methods().indexOf(`thread/${method}`),
        );
        expect(f.methods().indexOf('config/read')).toBeLessThan(
          f.methods().indexOf(`thread/${method}`),
        );
        expect(f.requests().find((request) => request.method === `thread/${method}`)).toEqual({
          method: `thread/${method}`,
          modelProvider: 'openai',
        });
        expectRedacted(events, 'chatgpt', 'plus');
      } finally {
        await f.adapter.close(handle, Date.now() + 10000);
      }
    });
  });
}

// A claude.ai subscription login reports subscriptionType and no tokenSource (CLI 2.1.311).
const claudeAccount = {
  apiProvider: 'firstParty',
  subscriptionType: 'max',
  ...privateFields,
};
function fakeClaude(account: unknown) {
  const produced: SDKUserMessage[] = [];
  const reads: Promise<IteratorResult<SDKUserMessage>>[] = [];
  const streams: { close: ReturnType<typeof vi.fn> }[] = [];
  let resolveAccount!: (value: { account: unknown }) => void;
  const initialized = new Promise<{ account: unknown }>((resolve) => {
    resolveAccount = resolve;
  });
  const query = vi.fn(({ prompt }: { prompt: string | AsyncIterable<SDKUserMessage> }) => {
    const input =
      typeof prompt === 'string'
        ? Promise.resolve({
            done: false,
            value: {
              type: 'user',
              message: { role: 'user', content: prompt },
              parent_tool_use_id: null,
            },
          } as IteratorResult<SDKUserMessage>)
        : prompt[Symbol.asyncIterator]().next();
    reads.push(
      input.then((result) => {
        if (!result.done) produced.push(result.value);
        return result;
      }),
    );
    const stream = {
      close: vi.fn(),
      initializationResult: vi.fn(() => initialized),
      async *[Symbol.asyncIterator]() {
        const result = await input;
        if (result.done) return;
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'native-session',
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
    streams.push(stream);
    return stream;
  });
  return {
    adapter: new ClaudeAdapter('unused-binary', versions[1][1], query as never),
    produced,
    reads,
    streams,
    query,
    initialize: () => resolveAccount({ account }),
  };
}

for (const method of ['start', 'resume'] as const) {
  describe(`Claude billing gate on ${method}`, () => {
    it.each([
      ['API key source', { ...claudeAccount, apiKeySource: 'environment' }, 'API key channel'],
      [
        'external provider',
        { ...claudeAccount, apiProvider: 'bedrock' },
        'Non-first-party provider',
      ],
      [
        'an OAuth token from the environment',
        { ...claudeAccount, tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' },
        'Non-claude.ai token source',
      ],
      [
        'a login without a subscription',
        { apiProvider: 'firstParty', ...privateFields },
        'No claude.ai subscription',
      ],
      ['missing account', undefined, 'Unverified account channel'],
    ])('refuses %s without yielding a user turn', async (_, account, message) => {
      const f = fakeClaude(account);
      const events: AgentEvent[] = [];
      let handle: SessionHandle | undefined;
      try {
        const starting =
          method === 'start'
            ? f.adapter.start(spec('claude'), (event) => events.push(event))
            : f.adapter.resume(spec('claude'), 'previous-session', (event) => events.push(event));
        f.initialize();
        const failure = await starting.then(
          (value) => {
            handle = value;
          },
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(DomainError);
        expect(failure).toMatchObject({ code: 'billing_channel_mismatch', message });
        expect(f.query).toHaveBeenCalledOnce();
        expect(await Promise.all(f.reads)).toEqual([{ done: true, value: undefined }]);
        expect(f.produced).toEqual([]);
        expect(f.streams[0]?.close).toHaveBeenCalledOnce();
        expect(events).toEqual([]);
      } finally {
        if (handle) await f.adapter.close(handle, Date.now() + 1000);
      }
    });

    it('holds input until the account is checked and emits a redacted summary once across turns', async () => {
      const f = fakeClaude(claudeAccount);
      const events: AgentEvent[] = [];
      const starting =
        method === 'start'
          ? f.adapter.start(spec('claude'), (event) => events.push(event))
          : f.adapter.resume(spec('claude'), 'previous-session', (event) => events.push(event));
      await Promise.resolve();
      expect(f.query).toHaveBeenCalledOnce();
      expect(f.produced).toEqual([]);
      expect(events).toEqual([]);
      f.initialize();
      const handle = await starting;
      try {
        expect(f.produced).toEqual([]);
        for (const turn_id of ['first-turn', 'second-turn']) {
          await f.adapter.send(handle, { turn_id, input: 'hello' });
          await vi.waitFor(() =>
            expect(events).toContainEqual(
              expect.objectContaining({ kind: 'turn.completed', status: 'completed', turn_id }),
            ),
          );
        }
        expect(f.produced.map((message) => message.message.content)).toEqual(['hello', 'hello']);
        expectRedacted(events, 'claude.ai', 'max');
        for (const stream of f.streams) expect(stream.close).toHaveBeenCalledOnce();
      } finally {
        await f.adapter.close(handle, Date.now() + 1000);
      }
    });
  });
}

it.each(['constructor', 'toString', '__proto__'])(
  'treats inherited capability key %s as an unknown runtime',
  (name) => {
    expect(report(name, 'unverified').capabilities.text_execution?.status).toBe('unknown');
  },
);

it('preserves a Claude account timeout instead of reporting a billing mismatch', async () => {
  vi.useFakeTimers();
  const f = fakeClaude(claudeAccount);
  try {
    const failure = f.adapter
      .start({ ...spec('claude'), budget: { max_turns: 1, wall_time_ms: 20 } }, () => {})
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(20);
    expect(await failure).toMatchObject({
      code: 'account_check_timeout',
      message: 'Account check timed out',
    });
  } finally {
    vi.useRealTimers();
  }
});

it('stops the Claude account check at its own limit when the session may run for hours', async () => {
  vi.useFakeTimers();
  const f = fakeClaude(claudeAccount);
  try {
    let settled = false;
    const failure = f.adapter
      .start(
        { ...spec('claude'), budget: { max_turns: 1, wall_time_ms: 6 * 60 * 60_000 } },
        () => {},
      )
      .catch((error) => error)
      .finally(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await failure).toMatchObject({
      code: 'account_check_timeout',
      message: 'Account check timed out',
    });
  } finally {
    vi.useRealTimers();
  }
});

it.each(['start', 'later turn'])('preserves Claude account errors on %s', async (phase) => {
  let calls = 0;
  const query = vi.fn(() => ({
    initializationResult: async () => {
      if (phase === 'start' || calls++ > 0)
        throw new DomainError('account_unavailable', 'Account service unavailable');
      return { account: claudeAccount };
    },
    close() {},
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        usage: { input_tokens: 0, output_tokens: 0 },
        total_cost_usd: 0,
      };
    },
  }));
  const adapter = new ClaudeAdapter('unused-binary', 'test', query as never);
  const events: AgentEvent[] = [];
  if (phase === 'start') {
    await expect(adapter.start(spec('claude'), () => {})).rejects.toMatchObject({
      code: 'account_unavailable',
      message: 'Account service unavailable',
    });
    return;
  }
  const handle = await adapter.start(spec('claude'), (event) => events.push(event));
  try {
    for (const turn_id of ['first', 'second']) {
      await adapter.send(handle, { turn_id, input: 'hello' });
      await vi.waitFor(() =>
        expect(
          events.some((event) => event.kind === 'turn.completed' && event.turn_id === turn_id),
        ).toBe(true),
      );
    }
    expect(events.at(-1)).toMatchObject({
      kind: 'turn.completed',
      status: 'failed',
      error: 'Account service unavailable',
      error_code: 'account_unavailable',
    });
  } finally {
    await adapter.close(handle, Date.now() + 1000);
  }
});

it.each(['domain', 'transport'])(
  'preserves Codex %s account RPC failures and their codes',
  async (kind) => {
    const f = fakeCodex(codexAccount, {});
    const request = JsonRpcProcess.prototype.request;
    const mock = vi.spyOn(JsonRpcProcess.prototype, 'request').mockImplementation(function (
      this: JsonRpcProcess,
      method,
      params,
      timeout,
    ) {
      if (method === 'account/read')
        return Promise.reject(
          kind === 'domain'
            ? new DomainError('rpc_timeout', 'RPC timeout: account/read')
            : Object.assign(new Error('RPC timeout: account/read'), { code: 'rpc_timeout' }),
        );
      return request.call(this, method, params, timeout);
    });
    try {
      await expect(f.adapter.start(spec('codex'), () => {})).rejects.toMatchObject({
        code: 'rpc_timeout',
        message: 'RPC timeout: account/read',
        stop: { stopped: true },
      });
    } finally {
      mock.mockRestore();
    }
  },
);

it('preserves a Claude abort code and message', async () => {
  const error = Object.assign(new Error('Query aborted'), {
    name: 'AbortError',
    code: 'ABORT_ERR',
  });
  const adapter = new ClaudeAdapter('unused-binary', 'test', (() => ({
    initializationResult: async () => {
      throw error;
    },
    close() {},
  })) as never);
  await expect(adapter.start(spec('claude'), () => {})).rejects.toMatchObject({
    code: 'ABORT_ERR',
    message: 'Query aborted',
  });
});

it('preserves a Codex inventory error after the billing check succeeds', async () => {
  const f = fakeCodex(codexAccount, {});
  const request = JsonRpcProcess.prototype.request;
  const mock = vi.spyOn(JsonRpcProcess.prototype, 'request').mockImplementation(function (
    this: JsonRpcProcess,
    method,
    params,
    timeout,
  ) {
    if (method === 'skills/list')
      return Promise.reject(
        Object.assign(new Error('Inventory unavailable'), { code: 'inventory_unavailable' }),
      );
    return request.call(this, method, params, timeout);
  });
  try {
    const input = {
      ...spec('codex'),
      extensions: {
        mode: 'inherit',
        overrides: {
          disabled_mcp_servers: [],
          disabled_plugins: [],
          disabled_skills: [],
          disable_apps: false,
          disable_hooks: false,
        },
      },
    } as SessionSpec;
    await expect(f.adapter.start(input, () => {})).rejects.toMatchObject({
      code: 'inventory_unavailable',
      message: 'Inventory unavailable',
      stop: { stopped: true },
    });
  } finally {
    mock.mockRestore();
  }
});
