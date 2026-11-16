import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexAdapter } from '@pantheon/adapters';
import { NATIVE_ENV_ALLOWLIST, type SessionSpec } from '@pantheon/domain';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

const spec: SessionSpec = {
  platform_session_id: 'steer-session',
  project_id: 'steer-project',
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

/** Starts a session on a fake app-server whose turns stay open until the test ends. */
async function startCodex(steerError?: { code: number; message: string }) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  const requests: Request[] = [];
  const reply = (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n');
  child.stdin.on('data', (data) => {
    for (const line of String(data).split('\n').filter(Boolean)) {
      const request = JSON.parse(line) as Request;
      requests.push(request);
      if (request.method === 'initialize') reply({ id: request.id, result: {} });
      if (request.method === 'account/read')
        reply({ id: request.id, result: { account: { type: 'chatgpt', planType: 'plus' } } });
      if (request.method === 'config/read')
        reply({ id: request.id, result: { config: { model_provider: 'openai' } } });
      if (request.method === 'thread/name/set') reply({ id: request.id, result: {} });
      if (request.method === 'thread/start')
        reply({ id: request.id, result: { thread: { id: 'steer-thread' } } });
      if (request.method === 'turn/start')
        reply({ id: request.id, result: { turn: { id: 'native-turn' } } });
      if (request.method === 'turn/steer')
        reply(
          steerError
            ? { id: request.id, error: steerError }
            : { id: request.id, result: { turnId: 'native-turn' } },
        );
      if (request.method === 'turn/interrupt') reply({ id: request.id, result: {} });
    }
  });
  const adapter = new CodexAdapter('fake-codex');
  const handle = await adapter.start(spec, () => {});
  const stop = async () => {
    child.emit('close', 0, null);
    await adapter.close(handle, Date.now() + 1000);
  };
  const steers = () => requests.filter((request) => request.method === 'turn/steer');
  return { adapter, handle, stop, steers };
}

const correction = { turn_id: 'steer-turn', input: 'Use the other file' };

describe('Codex steering', () => {
  it('sends one turn/steer to the running native turn', async () => {
    const { adapter, handle, stop, steers } = await startCodex();
    try {
      await adapter.send(handle, { turn_id: 'work-turn', input: 'Work' });
      const receipt = await adapter.steer!(handle, correction);
      expect(receipt).toEqual({ turn_id: 'steer-turn', status: 'delivered' });
      expect(steers().map((request) => request.params)).toEqual([
        {
          threadId: 'steer-thread',
          expectedTurnId: 'native-turn',
          input: [{ type: 'text', text: 'Use the other file' }],
        },
      ]);
    } finally {
      await stop();
    }
  });

  it('throws only the error code when Codex rejects the steer', async () => {
    const { adapter, handle, stop } = await startCodex({
      code: -32600,
      message: 'expected turn id does not match the active turn',
    });
    try {
      await adapter.send(handle, { turn_id: 'work-turn', input: 'Work' });
      await expect(adapter.steer!(handle, correction)).rejects.toThrow(
        'Codex rejected turn/steer (-32600)',
      );
    } finally {
      await stop();
    }
  });

  it('queues the input without a request when no turn is running', async () => {
    const { adapter, handle, stop, steers } = await startCodex();
    try {
      const receipt = await adapter.steer!(handle, correction);
      expect(receipt).toEqual({
        turn_id: 'steer-turn',
        status: 'queued',
        reason: expect.any(String),
      });
      expect(steers()).toEqual([]);
    } finally {
      await stop();
    }
  });
});
