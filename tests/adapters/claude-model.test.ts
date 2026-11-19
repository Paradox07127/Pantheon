import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ModelInfo,
  Options,
  SDKMessage,
} from '../../packages/adapters/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts';
import { ClaudeAdapter } from '../../packages/adapters/src/claude.js';
import { NATIVE_ENV_ALLOWLIST, type AgentEvent, type SessionSpec } from '@pantheon/domain';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

function modelSpec(): SessionSpec {
  return {
    platform_session_id: 'model-session',
    project_id: 'model-project',
    runtime: 'claude',
    device_id: 'local',
    role: 'writer',
    cwd: process.cwd(),
    model: 'sonnet',
    effort: 'high',
    env_allowlist: NATIVE_ENV_ALLOWLIST,
    skills: [],
    mcp_servers: [],
    extensions: { mode: 'none' },
    budget: { max_turns: 1, wall_time_ms: 10000 },
  };
}

/** A fake SDK whose every query is a fresh stream that ends when the test ends it. */
function fakeQuery(
  models: ModelInfo[] = [],
  account: Record<string, unknown> = { apiProvider: 'firstParty', subscriptionType: 'max' },
  adapterOptions: { artifacts?: boolean } = {},
  applied: { model: string | null; effort: string | null } = { model: null, effort: null },
) {
  const options: Options[] = [];
  const streams: {
    setModel: ReturnType<typeof vi.fn>;
    applyFlagSettings: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    end: () => void;
  }[] = [];
  const query = vi.fn((args: { options?: Options }) => {
    options.push(args.options!);
    const ended = Promise.withResolvers<void>();
    const stream = {
      initializationResult: async () => ({ account }),
      supportedModels: vi.fn(async () => models),
      getSettings: vi.fn(async () => ({ applied })),
      setModel: vi.fn(async () => {}),
      applyFlagSettings: vi.fn(async () => {}),
      close: vi.fn(() => ended.resolve()),
      end: ended.resolve,
      async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
        await ended.promise;
      },
    };
    streams.push(stream);
    return stream;
  });
  return {
    adapter: new ClaudeAdapter('fake-claude', 'test', query as never, adapterOptions),
    query,
    options,
    streams,
  };
}

/** What the CLI reports when ANTHROPIC_AUTH_TOKEN carries the backend key. */
const backendAccount = { tokenSource: 'ANTHROPIC_AUTH_TOKEN', apiProvider: 'firstParty' };
const backend = {
  id: 'relay',
  protocol: 'anthropic',
  base_url: 'https://relay.example.invalid/anthropic',
  api_key: 'sk-relay-key',
} as const;

async function started(
  spec = modelSpec(),
  account?: Record<string, unknown>,
  adapterOptions?: { artifacts?: boolean },
) {
  const f = fakeQuery([], account, adapterOptions);
  const events: AgentEvent[] = [];
  const handle = await f.adapter.start(spec, (event) => events.push(event));
  cleanup.push(() => f.adapter.close(handle, Date.now() + 1000));
  return { ...f, handle, events };
}

describe('Claude model and effort', () => {
  it('starts fast mode and changes its flag on the live query', async () => {
    const f = await started({ ...modelSpec(), fast: true });
    expect(f.options[0]?.settings).toMatchObject({ fastMode: true });
    expect(await f.adapter.setFastMode!(f.handle, false)).toEqual({ ok: true });
    expect(f.streams[0]!.applyFlagSettings).toHaveBeenCalledWith({ fastMode: false });
    expect(await f.adapter.setFastMode!(f.handle, true)).toEqual({ ok: true });
    expect(f.streams[0]!.applyFlagSettings).toHaveBeenCalledWith({ fastMode: true });
  });

  it('starts ultracode and changes its flag on the live query', async () => {
    const f = await started({ ...modelSpec(), ultracode: true });
    expect(f.options[0]?.settings).toMatchObject({ ultracode: true });
    expect(f.options[0]?.settings).not.toHaveProperty('disableWorkflows');
    expect(await f.adapter.setUltracode!(f.handle, false)).toEqual({ ok: true });
    expect(f.streams[0]!.applyFlagSettings).toHaveBeenCalledWith({ ultracode: false });
    expect(await f.adapter.setUltracode!(f.handle, true)).toEqual({ ok: true });
    expect(f.streams[0]!.applyFlagSettings).toHaveBeenCalledWith({ ultracode: true });
  });

  it('keeps ultracode on when the model and effort change', async () => {
    const f = await started({ ...modelSpec(), ultracode: true });
    expect(await f.adapter.setModel!(f.handle, 'opus', 'max')).toEqual({ ok: true });
    expect(f.streams[0]!.applyFlagSettings).toHaveBeenCalledWith({
      effortLevel: 'max',
      ultracode: true,
    });
  });

  it('starts the query with the requested model and effort', async () => {
    const f = await started();
    expect(f.options[0]).toMatchObject({ model: 'sonnet', effort: 'high' });
    expect(f.handle).toMatchObject({ requested_model: 'sonnet', requested_effort: 'high' });
  });

  it('switches the live query and builds the next query with the new model', async () => {
    const f = await started();
    f.handle.reported_model = 'claude-sonnet-reported';
    await f.adapter.send(f.handle, { turn_id: 'first-turn', input: 'hello' });
    expect(await f.adapter.setModel!(f.handle, 'opus', 'max')).toEqual({ ok: true });
    expect(f.streams[0]!.setModel).toHaveBeenCalledWith('opus');
    expect(f.streams[0]!.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'max' });
    expect(f.handle.requested_model).toBe('opus');
    expect(f.handle.requested_effort).toBe('max');
    expect(f.handle).not.toHaveProperty('reported_model');
    f.streams[0]!.end();
    await vi.waitFor(() =>
      expect(f.events.filter((event) => event.kind === 'turn.completed')).toHaveLength(1),
    );
    await f.adapter.send(f.handle, { turn_id: 'second-turn', input: 'again' });
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledTimes(2));
    expect(f.options[1]).toMatchObject({ model: 'opus', effort: 'max' });
  });

  it('clears the effort of the live query when none is given', async () => {
    const f = await started();
    expect(await f.adapter.setModel!(f.handle, 'haiku', undefined)).toEqual({ ok: true });
    expect(f.streams[0]!.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: null });
  });

  it('refuses an effort Claude does not have without touching the SDK', async () => {
    const f = await started();
    expect(await f.adapter.setModel!(f.handle, 'opus', 'minimal')).toEqual({
      ok: false,
      reason: expect.any(String),
    });
    expect(f.streams[0]!.setModel).not.toHaveBeenCalled();
    expect(f.streams[0]!.applyFlagSettings).not.toHaveBeenCalled();
    expect(f.handle).toMatchObject({ requested_model: 'sonnet', requested_effort: 'high' });
  });

  it('keeps the model and effort of the session when the live query refuses a switch', async () => {
    const f = await started();
    f.handle.reported_model = 'claude-sonnet-reported';
    await f.adapter.send(f.handle, { turn_id: 'first-turn', input: 'hello' });
    f.streams[0]!.setModel.mockRejectedValueOnce(new Error('Model refused'));
    expect(await f.adapter.setModel!(f.handle, 'opus', 'max')).toEqual({
      ok: false,
      reason: 'Model refused',
    });
    expect(f.handle).toMatchObject({
      requested_model: 'sonnet',
      requested_effort: 'high',
      reported_model: 'claude-sonnet-reported',
    });
    f.streams[0]!.end();
    await vi.waitFor(() =>
      expect(f.events.filter((event) => event.kind === 'turn.completed')).toHaveLength(1),
    );
    await f.adapter.send(f.handle, { turn_id: 'second-turn', input: 'again' });
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledTimes(2));
    expect(f.options[1]).toMatchObject({ model: 'sonnet', effort: 'high' });
  });

  it('restores the live model and effort when the effort switch fails', async () => {
    const f = await started();
    f.handle.reported_model = 'claude-sonnet-reported';
    f.streams[0]!.applyFlagSettings.mockRejectedValueOnce(new Error('Effort refused'));
    expect(await f.adapter.setModel!(f.handle, 'opus', 'max')).toEqual({
      ok: false,
      reason: 'Effort refused',
    });
    expect(f.streams[0]!.setModel.mock.calls).toEqual([['opus'], ['sonnet']]);
    expect(f.streams[0]!.applyFlagSettings.mock.calls).toEqual([
      [{ effortLevel: 'max' }],
      [{ effortLevel: 'high' }],
    ]);
    expect(f.streams[0]!.close).not.toHaveBeenCalled();
    expect(f.handle).toMatchObject({
      requested_model: 'sonnet',
      requested_effort: 'high',
      reported_model: 'claude-sonnet-reported',
    });
  });

  it('closes a query whose failed model switch cannot be restored', async () => {
    const f = await started();
    await f.adapter.send(f.handle, { turn_id: 'switching-turn', input: 'hello' });
    f.streams[0]!.applyFlagSettings.mockRejectedValueOnce(new Error('Effort refused'));
    f.streams[0]!.setModel.mockResolvedValueOnce(undefined);
    f.streams[0]!.setModel.mockRejectedValueOnce(new Error('Restore refused'));
    expect(await f.adapter.setModel!(f.handle, 'opus', 'max')).toMatchObject({ ok: false });
    expect(f.streams[0]!.close).toHaveBeenCalled();
    expect(f.events).toContainEqual(
      expect.objectContaining({
        kind: 'turn.completed',
        turn_id: 'switching-turn',
        status: 'failed',
      }),
    );
    await f.adapter.send(f.handle, { turn_id: 'restored-turn', input: 'again' });
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledTimes(2));
    expect(f.options[1]).toMatchObject({ model: 'sonnet', effort: 'high' });
    expect(f.handle).toMatchObject({ requested_model: 'sonnet', requested_effort: 'high' });
  });

  it('keeps a replacement query running when an old query cannot restore its model', async () => {
    const f = await started();
    await f.adapter.send(f.handle, { turn_id: 'old-query-turn', input: 'hello' });
    const switching = Promise.withResolvers<void>();
    f.streams[0]!.setModel.mockImplementationOnce(() => switching.promise);
    f.streams[0]!.setModel.mockRejectedValueOnce(new Error('Restore refused'));
    f.streams[0]!.applyFlagSettings.mockRejectedValueOnce(new Error('Effort refused'));
    const changed = f.adapter.setModel!(f.handle, 'opus', 'max');
    f.streams[0]!.end();
    await vi.waitFor(() =>
      expect(f.events.filter((event) => event.kind === 'turn.completed')).toHaveLength(1),
    );
    await f.adapter.send(f.handle, { turn_id: 'replacement-query-turn', input: 'again' });
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledTimes(2));
    switching.resolve();
    expect(await changed).toMatchObject({ ok: false });
    expect(f.events.filter((event) => event.kind === 'turn.completed')).toHaveLength(1);
    expect(f.streams[1]!.close).not.toHaveBeenCalled();
    expect((await f.adapter.inspect(f.handle)).state).toBe('running');
  });

  it('refuses to start with an effort Claude does not have', async () => {
    const f = fakeQuery();
    await expect(
      f.adapter.start({ ...modelSpec(), effort: 'minimal' }, () => {}),
    ).rejects.toMatchObject({ code: 'unsupported_effort' });
    expect(f.query).not.toHaveBeenCalled();
  });

  it('points the query at the backend only when the spec names one', async () => {
    const relayed = await started({ ...modelSpec(), backend }, backendAccount);
    expect(relayed.options[0]!.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://relay.example.invalid/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'sk-relay-key',
    });
    expect(relayed.events.filter((event) => event.kind === 'auth.checked')).toEqual([]);
    const own = await started();
    expect(own.options[0]!.env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    expect(own.options[0]!.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
  });

  it.each([
    ['a subscription session', {}, undefined, '1'],
    ['a session with publishing turned off', {}, { artifacts: false }, undefined],
    ['a backend session', { backend }, undefined, undefined],
  ] as const)(
    'gives %s the Artifact tool only while publishing is on and no backend key is used',
    async (_name, extra, adapterOptions, expected) => {
      const f = await started(
        { ...modelSpec(), ...extra },
        'backend' in extra ? backendAccount : undefined,
        adapterOptions,
      );
      expect(f.options[0]!.env?.CLAUDE_CODE_ARTIFACT).toBe(expected);
    },
  );

  it('refuses a backend session whose account does not use the backend key', async () => {
    for (const account of [
      { apiProvider: 'firstParty', subscriptionType: 'max' },
      { ...backendAccount, apiKeySource: 'ANTHROPIC_API_KEY' },
      { ...backendAccount, apiProvider: 'bedrock' },
    ])
      await expect(started({ ...modelSpec(), backend }, account)).rejects.toMatchObject({
        code: 'billing_channel_mismatch',
      });
  });

  it('still requires a claude.ai subscription without a backend', async () => {
    await expect(started(modelSpec(), backendAccount)).rejects.toMatchObject({
      code: 'billing_channel_mismatch',
    });
  });

  it('lists the supported models and closes the discovery query', async () => {
    const f = fakeQuery([
      {
        value: 'default',
        displayName: 'Default (recommended)',
        description: 'Uses the recommended model',
        supportsFastMode: true,
        supportsAutoMode: true,
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high'],
      },
      { value: 'haiku', displayName: 'Haiku', description: '' },
    ]);
    expect(await f.adapter.models(process.cwd())).toEqual([
      {
        id: 'default',
        label: 'Default (recommended)',
        description: 'Uses the recommended model',
        permission_modes: ['plan', 'ask', 'auto_edit', 'auto', 'full_access'],
        fast: true,
        efforts: ['low', 'medium', 'high'],
        default_effort: null,
        default: true,
      },
      {
        id: 'haiku',
        label: 'Haiku',
        permission_modes: ['plan', 'ask', 'auto_edit', 'full_access'],
        efforts: [],
        default_effort: null,
        default: false,
      },
    ]);
    expect(f.query).toHaveBeenCalledOnce();
    expect(f.streams[0]!.close).toHaveBeenCalledOnce();
  });

  it('lists the full model id an alias resolves to', async () => {
    const f = fakeQuery([
      {
        value: 'opus',
        displayName: 'Opus',
        description: 'Most capable model',
        resolvedModel: 'claude-opus-5-5',
      },
    ]);
    expect(await f.adapter.models(process.cwd())).toEqual([
      {
        id: 'opus',
        label: 'Opus',
        description: 'Most capable model',
        permission_modes: ['plan', 'ask', 'auto_edit', 'full_access'],
        efforts: [],
        default_effort: null,
        default: false,
        resolved: 'claude-opus-5-5',
      },
    ]);
  });

  it("gives the settings effort as the default effort of the rows of the session's model", async () => {
    const f = fakeQuery(
      [
        {
          value: 'default',
          displayName: 'Default',
          description: '',
          resolvedModel: 'claude-opus-5-5',
        },
        { value: 'opus', displayName: 'Opus', description: '', resolvedModel: 'claude-opus-5-5' },
        {
          value: 'sonnet',
          displayName: 'Sonnet',
          description: '',
          resolvedModel: 'claude-sonnet-5-5',
        },
      ],
      undefined,
      {},
      { model: 'claude-opus-5-5', effort: 'high' },
    );
    expect((await f.adapter.models(process.cwd())).map((m) => [m.id, m.default_effort])).toEqual([
      ['default', 'high'],
      ['opus', 'high'],
      ['sonnet', null],
    ]);
  });
});
