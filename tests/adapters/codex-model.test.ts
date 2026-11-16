import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexAdapter } from '../../packages/adapters/src/codex.js';
import { JsonRpcProcess } from '../../packages/adapters/src/process.js';
import { NATIVE_ENV_ALLOWLIST, type SessionSpec } from '@pantheon/domain';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const spec: SessionSpec = {
  platform_session_id: 'model-session',
  project_id: 'model-project',
  runtime: 'codex',
  device_id: 'local',
  role: 'writer',
  cwd: process.cwd(),
  model: 'gpt-fast',
  effort: 'low',
  env_allowlist: NATIVE_ENV_ALLOWLIST,
  skills: [],
  mcp_servers: [],
  budget: { max_turns: 1, wall_time_ms: 10000 },
};

type Request = { id: number; method: string; params: Record<string, unknown> };

/** A fake app-server that ends each turn as soon as it starts and serves model/list pages. */
function fakeAppServer(
  pages: Record<string, unknown> = {},
  config: Record<string, unknown> = { model_provider: 'openai' },
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
  // While set, model/list answers wait until the test releases them.
  let held: (() => void)[] | undefined;
  child.stdin.on('data', (data) => {
    for (const line of String(data).split('\n').filter(Boolean)) {
      const request = JSON.parse(line) as Request;
      requests.push(request);
      if (request.method === 'initialize') write({ id: request.id, result: {} });
      if (request.method === 'account/read')
        write({ id: request.id, result: { account: { type: 'chatgpt', planType: 'plus' } } });
      if (request.method === 'config/read') write({ id: request.id, result: { config } });
      if (request.method === 'thread/name/set') write({ id: request.id, result: {} });
      if (request.method === 'thread/start' || request.method === 'thread/resume')
        write({ id: request.id, result: { thread: { id: 'model-thread' } } });
      if (request.method === 'turn/start') {
        const id = `native-turn-${++turns}`;
        write({ id: request.id, result: { turn: { id } } });
        write({
          method: 'turn/completed',
          params: { threadId: 'model-thread', turn: { id, status: 'completed' } },
        });
      }
      if (request.method === 'model/list') {
        const answer = () =>
          write({ id: request.id, result: pages[String(request.params.cursor ?? '')] });
        if (held) held.push(answer);
        else answer();
      }
    }
  });
  // The fake child has no pid, so the transport closing stands in for the process exit.
  const originalClose = JsonRpcProcess.prototype.close;
  const close = vi.spyOn(JsonRpcProcess.prototype, 'close').mockImplementation(function (
    this: JsonRpcProcess,
    deadline?: number,
  ) {
    child.emit('close', 0, null);
    return originalClose.call(this, deadline);
  });
  const turnStarts = () =>
    requests.filter((request) => request.method === 'turn/start').map((r) => r.params);
  const sent = (method: string) => requests.filter((request) => request.method === method);
  const holdModelList = () => {
    held = [];
    return {
      waiting: () => held?.length ?? 0,
      release: () => {
        const answers = held ?? [];
        held = undefined;
        for (const answer of answers) answer();
      },
    };
  };
  return { requests, turnStarts, sent, close, holdModelList };
}

describe('Codex model and effort', () => {
  it.each(['fast', 'priority'])('sends the %s tier and restores default speed', async (tier) => {
    const server = fakeAppServer({
      '': {
        data: [{ model: 'gpt-fast', isDefault: true, serviceTiers: [{ id: tier }] }],
        nextCursor: null,
      },
    });
    const adapter = new CodexAdapter('fake-codex');
    const completed: string[] = [];
    const handle = await adapter.start({ ...spec, fast: true }, (event) => {
      if (event.kind === 'turn.completed') completed.push(event.turn_id!);
    });
    try {
      expect(server.sent('thread/start')[0]!.params.serviceTier).toBe(tier);
      await adapter.send(handle, { turn_id: 'fast-turn', input: 'Work' });
      await vi.waitFor(() => expect(completed).toEqual(['fast-turn']));
      expect(server.turnStarts()[0]?.serviceTier).toBe(tier);
      expect(await adapter.setFastMode!(handle, false)).toEqual({ ok: true });
      await adapter.send(handle, { turn_id: 'standard-turn', input: 'Continue' });
      await vi.waitFor(() => expect(completed).toHaveLength(2));
      expect(server.turnStarts()[1]?.serviceTier).toBe('default');
    } finally {
      await adapter.close(handle, Date.now() + 1000);
    }
  });

  it('keeps a fast-mode change made while a model change waits for the model list', async () => {
    const server = fakeAppServer({
      '': {
        data: [
          { model: 'gpt-fast', isDefault: true, serviceTiers: [{ id: 'priority' }] },
          { model: 'gpt-deep', isDefault: false, serviceTiers: [{ id: 'priority' }] },
        ],
        nextCursor: null,
      },
    });
    const adapter = new CodexAdapter('fake-codex');
    const completed: string[] = [];
    const handle = await adapter.start({ ...spec, fast: true }, (event) => {
      if (event.kind === 'turn.completed') completed.push(event.turn_id!);
    });
    try {
      await adapter.send(handle, { turn_id: 'fast-turn', input: 'Work' });
      await vi.waitFor(() => expect(completed).toEqual(['fast-turn']));
      const list = server.holdModelList();
      const model = adapter.setModel!(handle, 'gpt-deep', 'xhigh');
      await vi.waitFor(() => expect(list.waiting()).toBe(1));
      const fast = adapter.setFastMode!(handle, false);
      await new Promise((resolve) => setImmediate(resolve));
      list.release();
      expect(await model).toEqual({ ok: true });
      expect(await fast).toEqual({ ok: true });
      await adapter.send(handle, { turn_id: 'standard-turn', input: 'Continue' });
      await vi.waitFor(() => expect(completed).toHaveLength(2));
      expect(server.turnStarts()[1]).toMatchObject({ model: 'gpt-deep', serviceTier: 'default' });
    } finally {
      await adapter.close(handle, Date.now() + 1000);
    }
  });

  it('starts a turn sent while a model change waits for the model list on the new model', async () => {
    const server = fakeAppServer({
      '': {
        data: [
          { model: 'gpt-fast', isDefault: true, serviceTiers: [{ id: 'priority' }] },
          { model: 'gpt-deep', isDefault: false, serviceTiers: [{ id: 'fast' }] },
        ],
        nextCursor: null,
      },
    });
    const adapter = new CodexAdapter('fake-codex');
    const completed: string[] = [];
    const handle = await adapter.start({ ...spec, fast: true }, (event) => {
      if (event.kind === 'turn.completed') completed.push(event.turn_id!);
    });
    try {
      const list = server.holdModelList();
      const model = adapter.setModel!(handle, 'gpt-deep', 'xhigh');
      await vi.waitFor(() => expect(list.waiting()).toBe(1));
      const sending = adapter.send(handle, { turn_id: 'deep-turn', input: 'Work' });
      await new Promise((resolve) => setImmediate(resolve));
      list.release();
      expect(await model).toEqual({ ok: true });
      await sending;
      await vi.waitFor(() => expect(completed).toEqual(['deep-turn']));
      expect(server.turnStarts()[0]).toMatchObject({ model: 'gpt-deep', serviceTier: 'fast' });
    } finally {
      await adapter.close(handle, Date.now() + 1000);
    }
  });

  it('starts no native turn for a turn cancelled while a model change waits for the model list', async () => {
    const server = fakeAppServer({
      '': {
        data: [
          { model: 'gpt-fast', isDefault: true, serviceTiers: [{ id: 'priority' }] },
          { model: 'gpt-deep', isDefault: false, serviceTiers: [{ id: 'fast' }] },
        ],
        nextCursor: null,
      },
    });
    const adapter = new CodexAdapter('fake-codex');
    const handle = await adapter.start({ ...spec, fast: true }, () => {});
    const list = server.holdModelList();
    const model = adapter.setModel!(handle, 'gpt-deep', 'xhigh');
    await vi.waitFor(() => expect(list.waiting()).toBe(1));
    const sending = adapter.send(handle, { turn_id: 'cancelled-turn', input: 'Work' });
    await new Promise((resolve) => setImmediate(resolve));
    // The cancel waits on turn/interrupt, so the model list answers while the transport is open.
    const cancelling = adapter.cancel(handle, Date.now() + 1000);
    list.release();
    expect(await model).toEqual({ ok: true });
    expect(await sending).toMatchObject({ turn_id: 'cancelled-turn', status: 'delivered' });
    await cancelling;
    expect(server.turnStarts()).toEqual([]);
  });

  it('sends the model and effort with each turn and switches them for the next turn', async () => {
    const server = fakeAppServer();
    const adapter = new CodexAdapter('fake-codex');
    const completed: string[] = [];
    const handle = await adapter.start(spec, (event) => {
      if (event.kind === 'turn.completed') completed.push(event.turn_id!);
    });
    try {
      expect(handle).toMatchObject({ requested_model: 'gpt-fast', requested_effort: 'low' });
      await adapter.send(handle, { turn_id: 'first-turn', input: 'Work' });
      await vi.waitFor(() => expect(completed).toEqual(['first-turn']));
      expect(server.turnStarts()[0]).toMatchObject({ model: 'gpt-fast', effort: 'low' });
      handle.reported_model = 'gpt-fast-reported';
      expect(await adapter.setModel!(handle, 'gpt-deep', 'xhigh')).toEqual({ ok: true });
      expect(handle.requested_model).toBe('gpt-deep');
      expect(handle.requested_effort).toBe('xhigh');
      expect(handle).not.toHaveProperty('reported_model');
      await adapter.send(handle, { turn_id: 'second-turn', input: 'More' });
      await vi.waitFor(() => expect(completed).toEqual(['first-turn', 'second-turn']));
      expect(server.turnStarts()[1]).toMatchObject({ model: 'gpt-deep', effort: 'xhigh' });
    } finally {
      await adapter.close(handle, Date.now() + 1000);
    }
  });

  it('keeps a model the user chose while the app-server was starting', async () => {
    fakeAppServer();
    const adapter = new CodexAdapter('fake-codex');
    // Stands in for the session row, which the control layer folds each event into.
    const row: { requested_model?: string } = { requested_model: spec.model };
    const handle = await adapter.start(spec, (event) => {
      if (event.kind === 'auth.checked') row.requested_model = 'gpt-deep';
      if (event.kind === 'session.started')
        row.requested_model = event.requested_model ?? row.requested_model;
    });
    try {
      expect(row.requested_model).toBe('gpt-deep');
    } finally {
      await adapter.close(handle, Date.now() + 1000);
    }
  });

  it('clears the effort on the next turn after switching to a model without one', async () => {
    const server = fakeAppServer();
    const adapter = new CodexAdapter('fake-codex');
    const completed: string[] = [];
    const handle = await adapter.start(spec, (event) => {
      if (event.kind === 'turn.completed') completed.push(event.turn_id!);
    });
    try {
      await adapter.send(handle, { turn_id: 'first-turn', input: 'Work' });
      await vi.waitFor(() => expect(completed).toEqual(['first-turn']));
      expect(await adapter.setModel!(handle, 'gpt-plain', undefined)).toEqual({ ok: true });
      await adapter.send(handle, { turn_id: 'second-turn', input: 'More' });
      await vi.waitFor(() => expect(server.turnStarts()).toHaveLength(2));
      expect(server.turnStarts()[1]).toMatchObject({ model: 'gpt-plain', effort: null });
    } finally {
      await adapter.close(handle, Date.now() + 1000);
    }
  });

  it('never sends an effort when the session has had none', async () => {
    const server = fakeAppServer();
    const adapter = new CodexAdapter('fake-codex');
    const { effort: _effort, ...plain } = spec;
    const completed: string[] = [];
    const handle = await adapter.start(plain, (event) => {
      if (event.kind === 'turn.completed') completed.push(event.turn_id!);
    });
    try {
      await adapter.send(handle, { turn_id: 'first-turn', input: 'Work' });
      await vi.waitFor(() => expect(completed).toEqual(['first-turn']));
      expect(await adapter.setModel!(handle, 'gpt-plain', undefined)).toEqual({ ok: true });
      await adapter.send(handle, { turn_id: 'second-turn', input: 'More' });
      await vi.waitFor(() => expect(server.turnStarts()).toHaveLength(2));
      expect(server.turnStarts()[0]).not.toHaveProperty('effort');
      expect(server.turnStarts()[1]).not.toHaveProperty('effort');
    } finally {
      await adapter.close(handle, Date.now() + 1000);
    }
  });

  it('leaves the model and effort out of turn/start when the spec has none', async () => {
    const server = fakeAppServer();
    const adapter = new CodexAdapter('fake-codex');
    const { model: _model, effort: _effort, ...bare } = spec;
    const handle = await adapter.start(bare, () => {});
    try {
      await adapter.send(handle, { turn_id: 'bare-turn', input: 'Work' });
      await vi.waitFor(() => expect(server.turnStarts()).toHaveLength(1));
      expect(server.turnStarts()[0]).not.toHaveProperty('model');
      expect(server.turnStarts()[0]).not.toHaveProperty('effort');
    } finally {
      await adapter.close(handle, Date.now() + 1000);
    }
  });

  it('sends the app-server to the backend only when the spec names one', async () => {
    const backend = {
      id: 'relay',
      protocol: 'openai-responses',
      base_url: 'https://relay.example.invalid/v1',
      api_key: 'sk-relay-key',
    };
    const launch = async (launched: SessionSpec) => {
      fakeAppServer(
        {},
        { model_provider: launched.backend ? `pantheon-${launched.backend.id}` : 'openai' },
      );
      const adapter = new CodexAdapter('fake-codex');
      const handle = await adapter.start(launched, () => {});
      await adapter.close(handle, Date.now() + 1000);
      // The next fake app-server spies on the original close again.
      vi.restoreAllMocks();
      const [, args, options] = vi.mocked(spawn).mock.calls.at(-1)!;
      return { args: args as string[], env: options!.env! };
    };
    const relayed = await launch({ ...spec, backend });
    const pairs = [
      'model_provider="pantheon-relay"',
      'model_providers.pantheon-relay.name="pantheon-relay"',
      'model_providers.pantheon-relay.base_url="https://relay.example.invalid/v1"',
      'model_providers.pantheon-relay.env_key="PANTHEON_BACKEND_KEY"',
      'model_providers.pantheon-relay.wire_api="responses"',
    ];
    for (const pair of pairs) expect(relayed.args[relayed.args.indexOf(pair) - 1]).toBe('-c');
    expect(relayed.args.at(-1)).toBe('app-server');
    expect(relayed.env.PANTHEON_BACKEND_KEY).toBe('sk-relay-key');
    const own = await launch(spec);
    expect(own.args.filter((arg) => arg.includes('model_provider'))).toEqual([]);
    expect(own.env).not.toHaveProperty('PANTHEON_BACKEND_KEY');
  });

  const relay = {
    id: 'relay',
    protocol: 'openai-responses',
    base_url: 'https://relay.example.invalid/v1',
    api_key: 'sk-relay-key',
  };

  it.each(['start', 'resume'] as const)(
    'runs a backend session on its provider without a subscription login on %s',
    async (method) => {
      const server = fakeAppServer({}, { model_provider: 'pantheon-relay' });
      const adapter = new CodexAdapter('fake-codex');
      const events: string[] = [];
      const launched = { ...spec, backend: relay };
      const handle =
        method === 'start'
          ? await adapter.start(launched, (event) => events.push(event.kind))
          : await adapter.resume(launched, 'model-thread', (event) => events.push(event.kind));
      try {
        expect(server.sent('account/read')).toEqual([]);
        expect(events).not.toContain('auth.checked');
        expect(server.sent(`thread/${method}`)[0]!.params).toMatchObject({
          modelProvider: 'pantheon-relay',
        });
      } finally {
        await adapter.close(handle, Date.now() + 1000);
      }
    },
  );

  it.each([
    ['the subscription provider', { model_provider: 'openai' }],
    ['another backend provider', { model_provider: 'pantheon-other' }],
    ['no provider', {}],
  ])('refuses a backend session whose effective provider is %s', async (_, config) => {
    const server = fakeAppServer({}, config);
    const adapter = new CodexAdapter('fake-codex');
    await expect(adapter.start({ ...spec, backend: relay }, () => {})).rejects.toMatchObject({
      code: 'billing_channel_mismatch',
    });
    expect(server.sent('thread/start')).toEqual([]);
  });

  it('keeps a session without a backend on the OpenAI provider', async () => {
    const server = fakeAppServer();
    const adapter = new CodexAdapter('fake-codex');
    const handle = await adapter.start(spec, () => {});
    try {
      expect(server.sent('thread/start')[0]!.params).toMatchObject({ modelProvider: 'openai' });
    } finally {
      await adapter.close(handle, Date.now() + 1000);
    }
  });

  it('lists every page of visible models with known efforts and closes the app-server', async () => {
    const option = (reasoningEffort: string) => ({ reasoningEffort, description: '' });
    const server = fakeAppServer({
      '': {
        data: [
          {
            model: 'gpt-deep',
            displayName: 'GPT Deep',
            description: 'Deep reasoning',
            serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Faster' }],
            hidden: false,
            supportedReasoningEfforts: [option('low'), option('xhigh'), option('ultra')],
            defaultReasoningEffort: 'xhigh',
            isDefault: true,
          },
          {
            model: 'gpt-hidden',
            displayName: 'Hidden',
            hidden: true,
            supportedReasoningEfforts: [option('low')],
            defaultReasoningEffort: 'low',
            isDefault: false,
          },
        ],
        nextCursor: 'second-page',
      },
      'second-page': {
        data: [
          {
            model: 'gpt-fast',
            displayName: 'GPT Fast',
            description: '',
            serviceTiers: [],
            hidden: false,
            supportedReasoningEfforts: [option('minimal'), option('ultra')],
            defaultReasoningEffort: 'ultra',
            isDefault: false,
          },
        ],
        nextCursor: null,
      },
    });
    const adapter = new CodexAdapter('fake-codex');
    expect(await adapter.models(process.cwd())).toEqual([
      {
        id: 'gpt-deep',
        label: 'GPT Deep',
        description: 'Deep reasoning',
        permission_modes: ['plan', 'auto_edit', 'full_access'],
        fast: true,
        efforts: ['low', 'xhigh', 'ultra'],
        default_effort: 'xhigh',
        default: true,
      },
      {
        id: 'gpt-fast',
        label: 'GPT Fast',
        permission_modes: ['plan', 'auto_edit', 'full_access'],
        efforts: ['minimal', 'ultra'],
        default_effort: 'ultra',
        default: false,
      },
    ]);
    expect(
      server.requests.filter((request) => request.method === 'model/list').map((r) => r.params),
    ).toEqual([{}, { cursor: 'second-page' }]);
    expect(server.close).toHaveBeenCalledOnce();
  });
});
