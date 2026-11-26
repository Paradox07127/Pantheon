import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAdapter, JsonRpcProcess } from '@pantheon/adapters';
import {
  NATIVE_ENV_ALLOWLIST,
  type AgentEvent,
  type Role,
  type SessionSpec,
} from '@pantheon/domain';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
});

type Frame = { id?: string | number; method?: string; params?: Record<string, unknown> };

function temporary() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'codex-planning-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function spec(role: Role, nativeState = true): SessionSpec {
  const cwd = path.join(process.cwd(), 'clone');
  const home = temporary();
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  return {
    platform_session_id: 'planning-session',
    project_id: 'planning-project',
    runtime: 'codex',
    device_id: 'local',
    role,
    cwd,
    ...(nativeState ? { native_state_dir: path.join(temporary(), 'native') } : {}),
    env_allowlist: NATIVE_ENV_ALLOWLIST,
    skills: [],
    mcp_servers: [],
    extensions: { mode: 'none' },
    sandbox: { writable_roots: role === 'writer' ? [cwd] : [], protected_entries: [] },
    budget: { max_turns: 2, wall_time_ms: 10000 },
  };
}

/** `unanswered` names the requests the server reads and never answers; `answers` replaces results by method. */
function fakeServer(
  mcpServers: { name: string; tools: Record<string, unknown> | null; toolsError?: string }[] = [],
  unanswered: string[] = [],
  answers: Record<string, unknown> = {},
) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  const frames: Frame[] = [];
  const send = (frame: Frame) => child.stdout.write(JSON.stringify(frame) + '\n');
  child.stdin.on('data', (data) => {
    const frame = JSON.parse(String(data)) as Frame;
    frames.push(frame);
    if (!frame.method || frame.id === undefined || unanswered.includes(frame.method)) return;
    const config = frame.params?.config as Record<string, unknown> | undefined;
    const results: Record<string, unknown> = {
      initialize: {},
      'turn/interrupt': {},
      'account/read': { account: { type: 'chatgpt' } },
      'config/read': { config: {} },
      'plugin/installed': { marketplaces: [] },
      'mcpServerStatus/list': { data: mcpServers, nextCursor: null },
      'skills/list': { data: [] },
      'thread/name/set': {},
      'thread/start': {
        thread: { id: 'planning-thread' },
        approvalsReviewer: frame.params?.approvalsReviewer,
        activePermissionProfile: { id: config?.default_permissions },
      },
      'turn/start': { turn: { id: 'native-turn' } },
    };
    results['thread/resume'] = results['thread/start'];
    Object.assign(results, answers);
    if (!(frame.method in results)) throw new Error(`Unexpected client request: ${frame.method}`);
    send({ id: frame.id, result: results[frame.method] } as Frame);
  });
  vi.spyOn(JsonRpcProcess.prototype, 'close').mockImplementation(async function (
    this: JsonRpcProcess,
    deadline = Date.now() + 1000,
  ) {
    this.child.emit('close', 0, null);
    return {
      stopped: true,
      deadline,
      finished_at: new Date().toISOString(),
      evidence: { method: 'none', members: [] },
    };
  });
  return { frames, send, child };
}

it('checks a fresh Codex connection without starting a thread or turn', async () => {
  const f = fakeServer();
  await new CodexAdapter('fake-codex').reconnect();
  expect(f.frames.map((frame) => frame.method).sort()).toEqual([
    'account/read',
    'config/read',
    'initialize',
    'initialized',
  ]);
});

it.each(['account/read', 'config/read'])(
  'fails a Codex reconnect whose %s of the start check times out after initialize answers',
  async (method) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    cleanup.push(() => void vi.useRealTimers());
    const f = fakeServer([], [method]);
    const reconnected = new CodexAdapter('fake-codex').reconnect().then(
      () => 'reconnected',
      (error: Error) => error.message,
    );
    await vi.waitFor(() => expect(f.frames.map((frame) => frame.method)).toContain(method));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await reconnected).toBe(`RPC timeout: ${method}`);
  },
);

it.each([
  ['an API key account', { 'account/read': { account: { type: 'apiKey' } } }],
  ['a custom provider', { 'config/read': { config: { model_provider: 'custom' } } }],
])('reconnects a Codex server that answers the start check with %s', async (_, answers) => {
  fakeServer([], [], answers);
  await expect(new CodexAdapter('fake-codex').reconnect()).resolves.toBeUndefined();
});

it('reports Codex MCP catalog success and its reported failure reason', async () => {
  fakeServer([
    { name: 'files', tools: {} },
    { name: 'search', tools: null, toolsError: 'connection refused' },
  ]);
  expect(await new CodexAdapter('fake-codex').mcpStatus(process.cwd())).toEqual([
    { name: 'files', state: 'connected' },
    { name: 'search', state: 'failed', reason: 'connection refused' },
  ]);
});

it('reports a lost Codex process and fails the running turn with the runtime name', async () => {
  const f = await opened(spec('planner'));
  await f.adapter.send(f.handle, { turn_id: 'lost-runtime-turn', input: 'Work' });
  f.child.emit('close', 3, null);
  await vi.waitFor(() =>
    expect(f.events).toContainEqual(
      expect.objectContaining({
        kind: 'runtime.disconnected',
        reason: expect.stringContaining('Codex'),
      }),
    ),
  );
  expect(f.events.filter((event) => event.kind === 'turn.completed')).toEqual([
    expect.objectContaining({
      status: 'failed',
      turn_id: 'lost-runtime-turn',
      error: expect.stringContaining('Codex'),
    }),
  ]);
});

async function opened(sessionSpec: SessionSpec, method: 'start' | 'resume' = 'start') {
  const server = fakeServer();
  const adapter = new CodexAdapter('fake-codex');
  const events: AgentEvent[] = [];
  const handle =
    method === 'start'
      ? await adapter.start(sessionSpec, (event) => events.push(event))
      : await adapter.resume(sessionSpec, 'planning-thread', (event) => events.push(event));
  cleanup.push(() => adapter.close(handle, Date.now() + 1000));
  const params = server.frames.find((frame) => frame.method?.startsWith('thread/'))!.params!;
  const args = vi.mocked(spawn).mock.lastCall![1] as string[];
  return { ...server, adapter, handle, events, params, args };
}

const planningFeatures = {
  image_generation: false,
  goals: false,
  multi_agent: false,
  collaboration_modes: false,
};

describe('Codex non-writing sessions', () => {
  for (const role of ['planner', 'reviewer'] as const)
    it.each(['start', 'resume'] as const)(
      `strips built-in tools and the coding persona from a ${role} on %s`,
      async (method) => {
        const s = spec(role);
        const f = await opened(s, method);
        const file = path.join(s.native_state_dir!, 'pantheon-planner.md');
        expect(f.params.config).toMatchObject({
          web_search: 'disabled',
          include_environment_context: false,
          model_instructions_file: file,
          features: { apps: false, hooks: false, ...planningFeatures },
        });
        const persona = readFileSync(file);
        expect(persona.length).toBeGreaterThan(0);
        expect(persona.length).toBeLessThanOrEqual(800);
        expect(String(persona)).not.toContain(s.platform_session_id);
        expect(String(persona)).not.toContain(s.project_id);
        const plugins = f.args.indexOf('features.plugins=false');
        expect(f.args[plugins - 1]).toBe('-c');
        expect(plugins).toBeLessThan(f.args.indexOf('app-server'));
      },
    );

  it('writes the same persona bytes for every session', async () => {
    const first = spec('planner');
    await opened(first);
    const second = spec('reviewer');
    await opened(second);
    expect(readFileSync(path.join(second.native_state_dir!, 'pantheon-planner.md'))).toEqual(
      readFileSync(path.join(first.native_state_dir!, 'pantheon-planner.md')),
    );
  });

  it('omits the persona file without a native state directory', async () => {
    const f = await opened(spec('planner', false));
    expect(f.params.config).toMatchObject({ web_search: 'disabled', features: planningFeatures });
    expect(f.params.config).not.toHaveProperty('model_instructions_file');
  });

  it.each(['start', 'resume'] as const)('leaves a writer unchanged on %s', async (method) => {
    const s = spec('writer');
    const f = await opened(s, method);
    const config = f.params.config as Record<string, unknown>;
    expect(config).not.toHaveProperty('web_search');
    expect(config).not.toHaveProperty('include_environment_context');
    expect(config).not.toHaveProperty('model_instructions_file');
    expect(config.features).toEqual({
      apps: false,
      hooks: false,
      default_mode_request_user_input: true,
    });
    expect(f.args).not.toContain('features.plugins=false');
    expect(existsSync(path.join(s.native_state_dir!, 'pantheon-planner.md'))).toBe(false);
  });
});

describe('Codex event log', () => {
  const frame = (method: string, params: Record<string, unknown> = {}): Frame => ({
    method,
    params: { threadId: 'planning-thread', turnId: 'native-turn', ...params },
  });
  async function running() {
    const f = await opened(spec('writer'));
    await f.adapter.send(f.handle, { turn_id: 'turn', input: 'go' });
    return f;
  }

  it('keeps only the text of a message delta', async () => {
    const f = await running();
    f.send(frame('item/agentMessage/delta', { delta: 'hello' }));
    const delta = f.events.find((event) => event.kind === 'message.delta');
    expect(delta).toMatchObject({ text: 'hello', native_type: 'item/agentMessage/delta' });
    expect(delta).not.toHaveProperty('native');
  });

  it.each([
    'rawResponseItem/completed',
    'rawResponse/completed',
    'account/rateLimits/updated',
    'turn/moderationMetadata',
    'thread/readState/changed',
    'remoteControl/status/changed',
    'thread/name/updated',
    'account/updated',
    'thread/status/changed',
  ])('records only the type of %s', async (method) => {
    const f = await running();
    f.send(frame(method, { item: { type: 'message', content: 'large' } }));
    const event = f.events.find((e) => e.native_type === method);
    expect(event).toMatchObject({ kind: 'native', native_type: method });
    expect(event).not.toHaveProperty('native');
  });

  it('keeps the body of frames the trace reads', async () => {
    const f = await running();
    f.send(frame('mcpServer/startupStatus/updated', { name: 'files', status: 'ready' }));
    f.send(frame('turn/plan/updated', { plan: [] }));
    for (const method of ['mcpServer/startupStatus/updated', 'turn/plan/updated'])
      expect(f.events.find((e) => e.native_type === method)).toHaveProperty(
        'native.method',
        method,
      );
  });
});
