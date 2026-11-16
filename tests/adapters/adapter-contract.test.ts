import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { query } from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import { FixtureAdapter, CodexAdapter, ClaudeAdapter } from '@pantheon/adapters';
import {
  NATIVE_ENV_ALLOWLIST,
  SessionStartError,
  type AgentEvent,
  type SessionHandle,
  type SessionSpec,
  type SessionTurn,
  type UserTurn,
} from '@pantheon/domain';
import { eventually } from '../helpers.js';
import { workbenchFixture } from '../control/workbench-fixture.js';

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

type Completed = Extract<AgentEvent, { kind: 'turn.completed' }>;

const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-contract-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'commonjs' }));

const spec = (overrides: Partial<SessionSpec> = {}): SessionSpec => ({
  platform_session_id: 'session-1',
  project_id: 'project-1',
  runtime: 'fixture',
  device_id: 'local',
  role: 'writer',
  cwd: root,
  env_allowlist: NATIVE_ENV_ALLOWLIST,
  skills: [],
  mcp_servers: [],
  budget: { max_turns: 1, wall_time_ms: 10000 },
  ...overrides,
});
const turn = (turn_id: string, input = 'contract'): UserTurn => ({
  turn_id,
  input,
});
function recorder() {
  const events: AgentEvent[] = [];
  return {
    events,
    sink: (event: AgentEvent) => void events.push(event),
    completed: () => events.filter((e): e is Completed => e.kind === 'turn.completed'),
    text: () => events.map((e) => (e.kind === 'message.delta' ? e.text : '')).join(''),
  };
}

describe('fixture adapter contract', () => {
  it('ends a delivered turn with one completed event after its text and usage', async () => {
    const adapter = new FixtureAdapter(40),
      r = recorder();
    const handle = await adapter.start(spec(), r.sink);
    expect(await adapter.send(handle, turn('turn-1'))).toMatchObject({
      turn_id: 'turn-1',
      status: 'delivered',
    });
    await eventually(() => r.completed().length === 1);
    expect(r.events[0]?.kind).toBe('session.started');
    expect(r.events.filter((e) => e.kind === 'session.started')).toHaveLength(1);
    expect(r.events.at(-1)).toMatchObject({
      kind: 'turn.completed',
      turn_id: 'turn-1',
      status: 'completed',
    });
    expect(r.text()).toBe('fixture completed\n');
    expect(r.events.filter((e) => e.kind === 'usage.updated')).toEqual([
      expect.objectContaining({ cost_source: 'unknown' }),
    ]);
    expect(r.events.map((e) => e.provider_sequence)).toEqual(r.events.map((_, i) => i + 1));
    expect(new Set(r.events.map((e) => e.key)).size).toBe(r.events.length);
    expect(handle.native_session_id).not.toBe('');
    expect(r.events[0]).toMatchObject({ native_session_id: handle.native_session_id });
    expect(await adapter.close(handle, Date.now() + 10000)).toMatchObject({ stopped: true });
  });

  it('runs sequential turns on one handle with one session start', async () => {
    const adapter = new FixtureAdapter(20),
      r = recorder();
    const handle = await adapter.start(spec(), r.sink);
    await adapter.send(handle, turn('turn-1'));
    await eventually(() => r.completed().length === 1);
    await adapter.send(handle, turn('turn-2'));
    await eventually(() => r.completed().length === 2);
    expect(r.completed().map((e) => [e.turn_id, e.status])).toEqual([
      ['turn-1', 'completed'],
      ['turn-2', 'completed'],
    ]);
    expect(r.events.filter((e) => e.kind === 'session.started')).toHaveLength(1);
    await adapter.close(handle, Date.now() + 10000);
  });

  it('does not deliver a second turn while one is in flight', async () => {
    const adapter = new FixtureAdapter(300),
      r = recorder();
    const handle = await adapter.start(spec(), r.sink);
    await adapter.send(handle, turn('turn-1'));
    expect(await adapter.send(handle, turn('turn-2'))).toMatchObject({
      turn_id: 'turn-2',
      status: 'unsupported',
    });
    await eventually(() => r.completed().length === 1);
    expect(r.completed()).toEqual([
      expect.objectContaining({ turn_id: 'turn-1', status: 'completed' }),
    ]);
    await adapter.close(handle, Date.now() + 10000);
  });

  it('fails a turn that exceeds its wall-clock budget', async () => {
    const adapter = new FixtureAdapter(5000),
      r = recorder();
    const handle = await adapter.start(
      spec({ budget: { max_turns: 1, wall_time_ms: 50 } }),
      r.sink,
    );
    await adapter.send(handle, turn('turn-1'));
    await eventually(() => r.completed().length === 1);
    expect(r.completed()[0]).toMatchObject({ turn_id: 'turn-1', status: 'failed' });
    expect(r.completed()[0]?.error).toBeTruthy();
    await adapter.close(handle, Date.now() + 10000);
  });

  it('confirms a cancelled turn stopped with process evidence and ends it as interrupted', async () => {
    const adapter = new FixtureAdapter(5000),
      r = recorder();
    const handle = await adapter.start(spec(), r.sink);
    await adapter.send(handle, turn('turn-1'));
    await eventually(() => handle.process_identity !== undefined);
    const pid = handle.process_identity!.pid;
    expect((await adapter.inspect(handle)).state).toBe('running');
    const receipt = await adapter.cancel(handle, Date.now() + 10000);
    expect(receipt).toMatchObject({
      stopped: true,
      evidence: { method: 'process_group', live_count: 0 },
    });
    expect(receipt.evidence.members.map((m) => m.pid)).toContain(pid);
    expect(r.completed()).toEqual([
      expect.objectContaining({ turn_id: 'turn-1', status: 'interrupted' }),
    ]);
    const child = vi.mocked(spawn).mock.results.find((result) => result.value?.pid === pid)?.value;
    expect(child).toBeDefined();
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect((await adapter.inspect(handle)).state).not.toBe('running');
    await adapter.close(handle, Date.now() + 10000);
  });

  it.each<[string, Partial<SessionSpec>]>([
    ['skills', { skills: ['review'] }],
    ['MCP servers', { mcp_servers: [{ name: 'tools', command: 'node', args: [], env: {} }] }],
    ['an account reference', { account_ref: 'other-account' }],
    ['a remote device', { device_id: 'remote-1' }],
    ['a locked version it does not run', { locked_version: '0' }],
  ])('refuses to start a session with %s it cannot honor', async (_, overrides) => {
    await expect(new FixtureAdapter().start(spec(overrides), () => {})).rejects.toMatchObject({
      code: 'unsupported_capability',
    });
  });

  it('answers from no state for a handle it did not return', async () => {
    const adapter = new FixtureAdapter(),
      foreign: SessionHandle = {
        platform_session_id: 'other-session',
        native_session_id: 'native-other',
        adapter_version: '1',
        device_id: 'local',
      };
    expect((await adapter.inspect(foreign)).state).toBe('unknown');
    expect(await adapter.send(foreign, turn('turn-1'))).toMatchObject({ status: 'unsupported' });
    expect(await adapter.cancel(foreign, Date.now() + 1000)).toMatchObject({
      stopped: false,
      evidence: { method: 'none' },
    });
    expect(await adapter.close(foreign, Date.now() + 10000)).toMatchObject({ stopped: false });
  });

  it('resumes the native session id it is given', async () => {
    const adapter = new FixtureAdapter(20),
      r = recorder();
    const handle = await adapter.resume!(spec(), 'native-earlier', r.sink);
    await adapter.send(handle, turn('turn-1'));
    await eventually(() => r.completed().length === 1);
    expect(handle.native_session_id).toBe('native-earlier');
    expect(r.events.find((e) => e.kind === 'session.started')).toMatchObject({
      native_session_id: 'native-earlier',
    });
    await adapter.close(handle, Date.now() + 10000);
  });
});

// Answers the app-server requests the Codex adapter sends; the turn input selects the outcome.
const FAKE_APP_SERVER = String.raw`
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (m, done) => process.stdout.write(JSON.stringify(m) + '\n', done);
let turns = 0;
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const threadId = m.params && m.params.threadId;
  if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fake' } });
  else if (m.method === 'account/read') send({ id: m.id, result: { account: { type: 'chatgpt', planType: 'plus' } } });
  else if (m.method === 'config/read') send({ id: m.id, result: { config: { model_provider: 'openai' } } });
  else if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 'thread-new' } } });
  else if (m.method === 'thread/resume') send({ id: m.id, result: { thread: { id: threadId } } });
  else if (m.method === 'thread/name/set') send({ id: m.id, result: {} });
  else if (m.method === 'turn/start') {
    const id = 'native-turn-' + ++turns, input = m.params.input[0].text;
    if (input === 'exit') return send({ id: m.id, result: { turn: { id } } }, () => process.exit(3));
    send({ id: m.id, result: { turn: { id } } });
    if (input === 'hang') return;
    send({ method: 'item/agentMessage/delta', params: { threadId, delta: 'hello ' } });
    send({ method: 'item/agentMessage/delta', params: { threadId, delta: 'world' } });
    const status = input === 'fail' ? 'failed' : 'completed';
    send({ method: 'turn/completed', params: { threadId, turn: { id, status } } });
  } else if (m.method === 'turn/interrupt') {
    send({ id: m.id, result: {} });
    const turn = { id: m.params.turnId, status: 'interrupted' };
    send({ method: 'turn/completed', params: { threadId, turn } });
  } else send({ id: m.id, error: { code: -32601, message: 'not in the fake' } });
});
`;
const fakeCodex = path.join(root, 'fake-codex');
writeFileSync(fakeCodex, `#!${process.execPath}\n${FAKE_APP_SERVER}`);
chmodSync(fakeCodex, 0o755);

describe('codex adapter against a fake app-server', () => {
  it('maps text deltas, usage and the native completion of a turn', async () => {
    const adapter = new CodexAdapter(fakeCodex),
      r = recorder();
    const handle = await adapter.start(spec({ runtime: 'codex' }), r.sink);
    try {
      expect(handle.native_session_id).toBe('thread-new');
      expect(await adapter.send(handle, turn('turn-1', 'hi'))).toMatchObject({
        status: 'delivered',
      });
      await eventually(() => r.completed().length === 1);
      expect(r.events[0]).toMatchObject({
        kind: 'auth.checked',
        channel: 'subscription',
        method: 'chatgpt',
      });
      expect(r.events[1]).toMatchObject({
        kind: 'session.started',
        native_session_id: 'thread-new',
      });
      expect(r.text()).toBe('hello world');
      expect(r.events.filter((e) => e.kind === 'message.delta').map((e) => e.native_type)).toEqual([
        'item/agentMessage/delta',
        'item/agentMessage/delta',
      ]);
      expect(r.events.filter((e) => e.kind === 'usage.updated')).toHaveLength(1);
      expect(r.completed()).toEqual([
        expect.objectContaining({ turn_id: 'turn-1', status: 'completed' }),
      ]);
    } finally {
      await adapter.close(handle, Date.now() + 10000);
    }
  });

  it.each(['fail', 'exit'])(
    'reports the turn as failed when the app-server is told to %s',
    async (input) => {
      const adapter = new CodexAdapter(fakeCodex),
        r = recorder();
      const handle = await adapter.start(spec({ runtime: 'codex' }), r.sink);
      try {
        await adapter.send(handle, turn('turn-1', input));
        await eventually(() => r.completed().length === 1);
        expect(r.completed()[0]).toMatchObject({ turn_id: 'turn-1', status: 'failed' });
      } finally {
        await adapter.close(handle, Date.now() + 10000);
      }
    },
  );

  it('interrupts a running turn and confirms the app-server stopped', async () => {
    const adapter = new CodexAdapter(fakeCodex),
      r = recorder();
    const handle = await adapter.start(spec({ runtime: 'codex' }), r.sink);
    await adapter.send(handle, turn('turn-1', 'hang'));
    const receipt = await adapter.cancel(handle, Date.now() + 10000);
    expect(receipt).toMatchObject({
      stopped: true,
      evidence: { method: 'process_group', live_count: 0 },
    });
    expect(r.completed()).toEqual([
      expect.objectContaining({ turn_id: 'turn-1', status: 'interrupted' }),
    ]);
    await adapter.close(handle, Date.now() + 10000);
  });

  it('resumes the native thread it is given', async () => {
    const adapter = new CodexAdapter(fakeCodex),
      r = recorder();
    const handle = await adapter.resume!(spec({ runtime: 'codex' }), 'thread-earlier', r.sink);
    try {
      expect(handle.native_session_id).toBe('thread-earlier');
      expect(r.events[0]).toMatchObject({
        kind: 'auth.checked',
        channel: 'subscription',
        method: 'chatgpt',
      });
      expect(r.events[1]).toMatchObject({
        kind: 'session.started',
        native_session_id: 'thread-earlier',
      });
    } finally {
      await adapter.close(handle, Date.now() + 10000);
    }
  });
});

it('records agent events under the unified kinds', async () => {
  const f = workbenchFixture();
  const session = f.create();
  await eventually(
    () => f.turns(session.id).every((t: SessionTurn) => t.state === 'completed'),
    () => f.control.tick(),
  );
  const kinds = new Set(
    f.store
      .events()
      .map((e) => e.kind)
      .filter((k) => k.startsWith('agent.')),
  );
  expect([...kinds].sort()).toEqual([
    'agent.message.delta',
    'agent.session.started',
    'agent.turn.completed',
    'agent.usage.updated',
  ]);
});

describe('stop evidence and terminal event ordering', () => {
  it('completes a fixture turn before cancel returns even with an expired deadline', async () => {
    const adapter = new FixtureAdapter(5000),
      r = recorder();
    const handle = await adapter.start(spec(), r.sink);
    try {
      await adapter.send(handle, turn('expired-cancel'));
      await adapter.cancel(handle, Date.now() - 1);
      expect(r.completed(), 'cancel must emit completion before returning').toEqual([
        expect.objectContaining({ status: 'interrupted', turn_id: 'expired-cancel' }),
      ]);
      const count = r.events.length;
      await adapter.close(handle, Date.now() + 10000);
      expect(r.events).toHaveLength(count);
    } finally {
      await adapter.cancel(handle, Date.now() + 10000);
    }
  });

  it.each(['deadline', 'process error'])(
    'ends a fixture turn on %s without waiting for close',
    async (trigger) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
      });
      vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
      vi.useFakeTimers();
      const adapter = new FixtureAdapter(),
        r = recorder();
      const handle = await adapter.start(
        spec({ budget: { max_turns: 1, wall_time_ms: 20 } }),
        r.sink,
      );
      try {
        await adapter.send(handle, turn('terminal'));
        if (trigger === 'deadline') await vi.advanceTimersByTimeAsync(20);
        else child.emit('error', new Error('fixture process error'));
        expect(r.completed(), 'terminal event must not depend on child close').toHaveLength(1);
        expect(r.completed()[0]).toMatchObject({ status: 'failed', error: expect.any(String) });
        const count = r.events.length;
        child.stdout.emit('data', 'late text');
        child.emit('close', 1, null);
        expect(r.events).toHaveLength(count);
      } finally {
        child.emit('close', 1, null);
        vi.useRealTimers();
        await adapter.close(handle, Date.now() + 10000);
      }
    },
  );

  it.each([new FixtureAdapter(), new CodexAdapter(), new ClaudeAdapter()])(
    '$name does not trust a foreign process identity and returns an unconfirmed close',
    async (adapter) => {
      const foreign: SessionHandle = {
        platform_session_id: 'foreign',
        native_session_id: 'foreign-native',
        adapter_version: 'unknown',
        device_id: 'local',
        process_identity: { pid: 12345 },
      };
      expect(await adapter.inspect(foreign)).toMatchObject({ state: 'unknown' });
      expect(
        (await adapter.inspect(foreign)).process_identity,
        'foreign identity is not observed evidence',
      ).toBeUndefined();
      const deadline = Date.now();
      expect(await adapter.close(foreign, deadline)).toMatchObject({
        stopped: false,
        deadline,
        evidence: { method: 'none' },
      });
    },
  );

  it.each(['start', 'resume'] as const)(
    'wraps a spawned Codex %s failure with its stop receipt',
    async (method) => {
      const binary = path.join(root, `failed-${method}`);
      writeFileSync(
        binary,
        `#!${process.execPath}\n` +
          FAKE_APP_SERVER.replace("{ id: 'thread-new' }", '{}').replace('{ id: threadId }', '{}'),
      );
      chmodSync(binary, 0o755);
      const adapter = new CodexAdapter(binary);
      const failure = await (
        method === 'start'
          ? adapter.start(spec({ runtime: 'codex' }), () => {})
          : adapter.resume(spec({ runtime: 'codex' }), 'old-thread', () => {})
      ).catch((error: unknown) => error);
      expect(failure, 'post-spawn failures must carry stop evidence').toBeInstanceOf(
        SessionStartError,
      );
      expect((failure as SessionStartError).stop).toMatchObject({
        stopped: true,
        evidence: { method: 'process_group', live_count: 0 },
      });
    },
  );

  it('preserves Codex notifications received before the thread id is known', async () => {
    const binary = path.join(root, 'early-notification');
    writeFileSync(
      binary,
      `#!${process.execPath}\n` +
        FAKE_APP_SERVER.replace(
          "else if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 'thread-new' } } });",
          "else if (m.method === 'thread/start') { send({ method: 'thread/started', params: { threadId: 'thread-new', marker: 'early' } }); send({ id: m.id, result: { thread: { id: 'thread-new' } } }); }",
        ),
    );
    chmodSync(binary, 0o755);
    const adapter = new CodexAdapter(binary),
      r = recorder();
    const handle = await adapter.start(spec({ runtime: 'codex' }), r.sink);
    try {
      expect(
        r.events.filter((e) => e.native_type === 'thread/started'),
        'startup notification was lost',
      ).toHaveLength(1);
    } finally {
      await adapter.close(handle, Date.now() + 10000);
    }
  });

  it('ignores a late Codex turn start response and its buffered notifications after cancel', async () => {
    const binary = path.join(root, 'late-turn-response');
    writeFileSync(
      binary,
      `#!${process.execPath}\nprocess.on('SIGTERM', () => {});\n` +
        FAKE_APP_SERVER.replace(
          "send({ id: m.id, result: { turn: { id } } });\n    if (input === 'hang') return;",
          "send({ method: 'item/agentMessage/delta', params: { threadId, turnId: id, delta: 'buffered' } }); setTimeout(() => send({ id: m.id, result: { turn: { id } } }), 150); return;",
        ),
    );
    chmodSync(binary, 0o755);
    const adapter = new CodexAdapter(binary),
      r = recorder();
    const handle = await adapter.start(spec({ runtime: 'codex' }), r.sink);
    try {
      const sending = adapter.send(handle, turn('late-turn'));
      await new Promise((resolve) => setTimeout(resolve, 50));
      await adapter.cancel(handle, Date.now() - 1);
      expect(r.completed()).toHaveLength(1);
      await sending;
      expect(r.events.at(-1)?.kind, 'late start replayed events after completion').toBe(
        'turn.completed',
      );
      expect(r.text()).toBe('');
    } finally {
      await adapter.cancel(handle, Date.now() + 10000);
    }
  });

  it('reports no stop evidence from Claude close after starting a turn', async () => {
    vi.mocked(query).mockReturnValue({
      async initializationResult() {
        return { account: { subscriptionType: 'max', apiProvider: 'firstParty' } };
      },
      close() {},
      async *[Symbol.asyncIterator]() {
        await new Promise(() => {});
      },
    } as ReturnType<typeof query>);
    const adapter = new ClaudeAdapter(),
      r = recorder();
    const handle = await adapter.start(spec({ runtime: 'claude' }), r.sink);
    await adapter.send(handle, turn('sdk-turn'));
    const deadline = Date.now();
    expect(await adapter.close(handle, deadline)).toMatchObject({
      stopped: false,
      deadline,
      evidence: { method: 'none' },
      reason: expect.any(String),
    });
    expect(r.completed()).toEqual([expect.objectContaining({ status: 'interrupted' })]);
    expect((await adapter.inspect(handle)).state).toBe('unknown');
  });

  it('keeps a Claude deadline abort unknown and never confirms its stop', async () => {
    vi.mocked(query).mockReturnValue({
      async initializationResult() {
        return { account: { subscriptionType: 'max', apiProvider: 'firstParty' } };
      },
      close() {},
      async *[Symbol.asyncIterator]() {
        await new Promise(() => {});
      },
    } as ReturnType<typeof query>);
    vi.useFakeTimers();
    const adapter = new ClaudeAdapter(),
      r = recorder();
    const handle = await adapter.start(
      spec({ runtime: 'claude', budget: { max_turns: 1, wall_time_ms: 20 } }),
      r.sink,
    );
    try {
      await adapter.send(handle, turn('sdk-deadline'));
      await vi.advanceTimersByTimeAsync(20);
      expect(r.completed()).toEqual([expect.objectContaining({ status: 'failed' })]);
      expect((await adapter.inspect(handle)).state, 'an SDK abort is not a confirmed stop').toBe(
        'unknown',
      );
      expect(await adapter.cancel(handle, Date.now())).toMatchObject({
        stopped: false,
        evidence: { method: 'none' },
      });
    } finally {
      await adapter.close(handle, Date.now());
      vi.useRealTimers();
    }
  });
});
