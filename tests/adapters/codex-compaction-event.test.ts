import { expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexAdapter } from '@pantheon/adapters';
import { NATIVE_ENV_ALLOWLIST, type AgentEvent, type SessionSpec } from '@pantheon/domain';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

const spec: SessionSpec = {
  platform_session_id: 'compaction-session',
  project_id: 'compaction-project',
  runtime: 'codex',
  device_id: 'local',
  role: 'writer',
  cwd: process.cwd(),
  env_allowlist: NATIVE_ENV_ALLOWLIST,
  skills: [],
  mcp_servers: [],
  budget: { max_turns: 1, wall_time_ms: 10000 },
};

it('records a compaction notification and its contextCompaction item as one compaction event', async () => {
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
        write({ id: request.id, result: { thread: { id: 'compaction-thread' } } });
      if (request.method === 'turn/start')
        write({ id: request.id, result: { turn: { id: 'native-compaction-turn' } } });
    }
  });
  const events: AgentEvent[] = [];
  const adapter = new CodexAdapter('fake-codex');
  const handle = await adapter.start(spec, (event) => events.push(event));
  try {
    await adapter.send(handle, { turn_id: 'compacting-turn', input: 'Work' });
    const item = { type: 'contextCompaction', id: 'compaction-item' };
    const ids = { threadId: 'compaction-thread', turnId: 'native-compaction-turn' };
    write({ method: 'item/started', params: { ...ids, item } });
    write({ method: 'thread/compacted', params: ids });
    write({ method: 'item/completed', params: { ...ids, item } });
    write({
      method: 'turn/completed',
      params: { threadId: 'compaction-thread', turn: { id: ids.turnId, status: 'completed' } },
    });
    await vi.waitFor(() =>
      expect(events.filter((event) => event.kind === 'turn.completed')).toHaveLength(1),
    );
    expect(
      events.filter((event) => event.kind.startsWith('context.')).map((event) => event.kind),
    ).toEqual(['context.compacting', 'context.compacted']);
    expect(events.find((event) => event.kind === 'context.compacting')).toMatchObject({
      trigger: 'auto',
    });
    expect(events.filter((event) => event.kind === 'context.compacted')).toEqual([
      expect.objectContaining({ turn_id: 'compacting-turn', kind: 'context.compacted' }),
    ]);
  } finally {
    child.emit('close', 0, null);
    await adapter.close(handle, Date.now() + 1000);
  }
});

function compactionServer() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  const requests: { id: number; method: string; params: Record<string, unknown> }[] = [];
  const write = (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n');
  child.stdin.on('data', (data) => {
    for (const line of String(data).split('\n').filter(Boolean)) {
      const request = JSON.parse(line) as (typeof requests)[number];
      requests.push(request);
      if (request.method === 'initialize' || request.method === 'thread/name/set')
        write({ id: request.id, result: {} });
      if (request.method === 'account/read')
        write({ id: request.id, result: { account: { type: 'chatgpt', planType: 'plus' } } });
      if (request.method === 'config/read')
        write({ id: request.id, result: { config: { model_provider: 'openai' } } });
      if (request.method === 'thread/start')
        write({ id: request.id, result: { thread: { id: 'manual-thread' } } });
      if (request.method === 'turn/start')
        write({ id: request.id, result: { turn: { id: 'ordinary-turn' } } });
    }
  });
  return { child, requests, write };
}

it.each([true, false])(
  'tracks a manual compaction when notifications precede its response: %s',
  async (beforeResponse) => {
    const f = compactionServer();
    const events: AgentEvent[] = [];
    const adapter = new CodexAdapter('fake-codex');
    const handle = await adapter.start(spec, (event) => events.push(event));
    try {
      const sending = adapter.send(handle, { turn_id: 'manual-turn', input: '', compact: true });
      await vi.waitFor(() =>
        expect(f.requests.some((request) => request.method === 'thread/compact/start')).toBe(true),
      );
      const request = f.requests.find((request) => request.method === 'thread/compact/start')!;
      expect(request.params).toEqual({ threadId: 'manual-thread' });
      expect(f.requests.some((request) => request.method === 'turn/start')).toBe(false);
      if (!beforeResponse) {
        f.write({ id: request.id, result: {} });
        await sending;
      }
      expect((await adapter.inspect(handle)).state).toBe('running');
      const ids = { threadId: 'manual-thread', turnId: 'native-manual-turn' };
      f.write({
        method: 'turn/started',
        params: { threadId: ids.threadId, turn: { id: ids.turnId, status: 'inProgress' } },
      });
      const item = { id: 'manual-item', type: 'contextCompaction' };
      f.write({ method: 'item/started', params: { ...ids, item } });
      f.write({ method: 'item/completed', params: { ...ids, item } });
      f.write({ method: 'thread/compacted', params: ids });
      f.write({
        method: 'turn/completed',
        params: { threadId: ids.threadId, turn: { id: ids.turnId, status: 'completed' } },
      });
      if (beforeResponse) f.write({ id: request.id, result: {} });
      expect(await sending).toMatchObject({ status: 'delivered' });
      await vi.waitFor(() =>
        expect(events.filter((event) => event.kind === 'turn.completed')).toHaveLength(1),
      );
      expect(
        events.filter((event) => event.kind.startsWith('context.')).map((event) => event.kind),
      ).toEqual(['context.compacting', 'context.compacted']);
      expect(events.find((event) => event.kind === 'context.compacting')).toMatchObject({
        trigger: 'manual',
      });
      expect(events.filter((event) => event.kind === 'context.compacted')).toEqual([
        expect.objectContaining({ turn_id: 'manual-turn', trigger: 'manual' }),
      ]);
      expect((await adapter.inspect(handle)).state).toBe('idle');
    } finally {
      f.child.emit('close', 0, null);
      await adapter.close(handle, Date.now() + 1000);
    }
  },
);

it.each(['request', 'turn'])(
  'records a manual compaction failure in the %s and accepts the next turn',
  async (failure) => {
    const f = compactionServer();
    const events: AgentEvent[] = [];
    const adapter = new CodexAdapter('fake-codex');
    const handle = await adapter.start(spec, (event) => events.push(event));
    try {
      const sending = adapter.send(handle, { turn_id: 'failed-compact', input: '', compact: true });
      await vi.waitFor(() =>
        expect(f.requests.some((request) => request.method === 'thread/compact/start')).toBe(true),
      );
      const request = f.requests.find((request) => request.method === 'thread/compact/start')!;
      if (failure === 'request')
        f.write({ id: request.id, error: { code: -32000, message: 'Compaction refused' } });
      else {
        f.write({ id: request.id, result: {} });
        f.write({
          method: 'turn/started',
          params: {
            threadId: 'manual-thread',
            turn: { id: 'failed-native-turn', status: 'inProgress' },
          },
        });
        f.write({
          method: 'turn/completed',
          params: {
            threadId: 'manual-thread',
            turn: {
              id: 'failed-native-turn',
              status: 'failed',
              error: { message: 'Compaction failed' },
            },
          },
        });
      }
      await sending;
      await vi.waitFor(() =>
        expect(events).toContainEqual(
          expect.objectContaining({
            kind: 'turn.completed',
            turn_id: 'failed-compact',
            status: 'failed',
          }),
        ),
      );
      expect(events.filter((event) => event.kind === 'context.compacted')).toHaveLength(0);
      expect((await adapter.inspect(handle)).state).toBe('idle');
      expect(await adapter.send(handle, { turn_id: 'next-turn', input: 'Continue' })).toMatchObject(
        { status: 'delivered' },
      );
      f.write({
        method: 'turn/completed',
        params: { threadId: 'manual-thread', turn: { id: 'ordinary-turn', status: 'completed' } },
      });
      await vi.waitFor(() =>
        expect(events.filter((event) => event.kind === 'turn.completed')).toHaveLength(2),
      );
    } finally {
      f.child.emit('close', 0, null);
      await adapter.close(handle, Date.now() + 1000);
    }
  },
);

it('forks native history through the kept turn and records the completed native turn id', async () => {
  const f = compactionServer();
  f.child.stdin.on('data', (data) => {
    const request = JSON.parse(String(data)) as { id: number; method: string };
    if (request.method === 'thread/fork')
      f.write({ id: request.id, result: { thread: { id: 'forked-native' } } });
  });
  const adapter = new CodexAdapter('fake-codex');
  const events: AgentEvent[] = [];
  const handle = await adapter.start(
    { ...spec, native_fork: { session_id: 'source-thread', after: 'kept-native-turn' } },
    (event) => events.push(event),
  );
  try {
    expect(f.requests.find((request) => request.method === 'thread/fork')?.params).toMatchObject({
      threadId: 'source-thread',
      lastTurnId: 'kept-native-turn',
    });
    expect(handle.native_session_id).toBe('forked-native');
    await adapter.send(handle, { turn_id: 'continued-turn', input: 'Continue' });
    f.write({
      method: 'error',
      params: {
        threadId: 'forked-native',
        turnId: 'ordinary-turn',
        willRetry: true,
        error: { codexErrorInfo: 'rateLimitExceeded', message: 'retrying' },
      },
    });
    f.write({
      method: 'turn/completed',
      params: { threadId: 'forked-native', turn: { id: 'ordinary-turn', status: 'completed' } },
    });
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'turn.completed', native_history_end: 'ordinary-turn' }),
      ),
    );
    expect(events.some((event) => event.kind === 'turn.retrying')).toBe(false);
    expect(adapter.report.capabilities.fork_within_turn?.status).toBe('unsupported');
  } finally {
    f.child.emit('close', 0, null);
    await adapter.close(handle, Date.now() + 1000);
  }
});
