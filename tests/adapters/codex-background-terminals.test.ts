import { describe, expect, it, vi } from 'vitest';
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
  platform_session_id: 'background-session',
  project_id: 'background-project',
  runtime: 'codex',
  device_id: 'local',
  role: 'writer',
  cwd: process.cwd(),
  env_allowlist: NATIVE_ENV_ALLOWLIST,
  skills: [],
  mcp_servers: [],
  budget: { max_turns: 1, wall_time_ms: 10000 },
};

type Request = { id: number; method: string; params: Record<string, unknown> };

/** Starts a session on a fake app-server whose turns end when the test says so. */
async function startCodex() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  const requests: Request[] = [];
  const write = (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n');
  let started = 0;
  child.stdin.on('data', (data) => {
    for (const line of String(data).split('\n').filter(Boolean)) {
      const request = JSON.parse(line) as Request;
      requests.push(request);
      if (request.method === 'initialize') write({ id: request.id, result: {} });
      if (request.method === 'account/read')
        write({ id: request.id, result: { account: { type: 'chatgpt', planType: 'plus' } } });
      if (request.method === 'config/read')
        write({ id: request.id, result: { config: { model_provider: 'openai' } } });
      if (request.method === 'thread/name/set') write({ id: request.id, result: {} });
      if (request.method === 'thread/start')
        write({ id: request.id, result: { thread: { id: 'background-thread' } } });
      if (request.method === 'turn/start')
        write({ id: request.id, result: { turn: { id: `native-turn-${++started}` } } });
      if (request.method === 'thread/backgroundTerminals/terminate')
        write({ id: request.id, result: { terminated: true } });
    }
  });
  const events: AgentEvent[] = [];
  const adapter = new CodexAdapter('fake-codex');
  const handle = await adapter.start(spec, (event) => events.push(event));
  const item = (method: string, turnId: string, itemId: string, processId: string) =>
    write({
      method,
      params: {
        threadId: 'background-thread',
        turnId,
        item: {
          type: 'commandExecution',
          id: itemId,
          processId,
          command: 'pnpm dev',
          cwd: spec.cwd,
          status: method === 'item/started' ? 'inProgress' : 'completed',
        },
      },
    });
  const endTurn = (turnId: string) =>
    write({
      method: 'turn/completed',
      params: { threadId: 'background-thread', turn: { id: turnId, status: 'completed' } },
    });
  const changes = () =>
    events.flatMap((event) => (event.kind === 'background.changed' ? [event.tasks] : []));
  const stop = async () => {
    child.emit('close', 0, null);
    await adapter.close(handle, Date.now() + 1000);
  };
  return { adapter, handle, events, requests, item, endTurn, changes, stop };
}

describe('Codex background terminals', () => {
  it('reports a command that outlives its turn until the command ends', async () => {
    const codex = await startCodex();
    try {
      await codex.adapter.send(codex.handle, { turn_id: 'server-turn', input: 'Start the server' });
      codex.item('item/started', 'native-turn-1', 'server-item', '1000');
      codex.item('item/started', 'native-turn-1', 'build-item', '1001');
      codex.item('item/completed', 'native-turn-1', 'build-item', '1001');
      codex.endTurn('native-turn-1');
      await vi.waitFor(() => expect(codex.changes()).toHaveLength(1));
      expect(codex.changes()[0]).toEqual([
        { id: '1000', kind: 'shell', description: 'pnpm dev', started_at: expect.any(Number) },
      ]);
      // The exit arrives with the turn that started the command, after that turn ended.
      codex.item('item/completed', 'native-turn-1', 'server-item', '1000');
      await vi.waitFor(() => expect(codex.changes()).toHaveLength(2));
      expect(codex.changes()[1]).toEqual([]);
    } finally {
      await codex.stop();
    }
  });

  it('stops a background terminal by its process id', async () => {
    const codex = await startCodex();
    try {
      await codex.adapter.send(codex.handle, { turn_id: 'server-turn', input: 'Start the server' });
      codex.item('item/started', 'native-turn-1', 'server-item', '1000');
      codex.endTurn('native-turn-1');
      await vi.waitFor(() => expect(codex.changes()).toHaveLength(1));
      await codex.adapter.stopBackground!(codex.handle, '1000');
      expect(
        codex.requests
          .filter((request) => request.method === 'thread/backgroundTerminals/terminate')
          .map((request) => request.params),
      ).toEqual([{ threadId: 'background-thread', processId: '1000' }]);
    } finally {
      await codex.stop();
    }
  });
});
