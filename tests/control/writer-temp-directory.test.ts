import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ClaudeAdapter } from '../../packages/adapters/src/claude.js';
import { CodexAdapter } from '../../packages/adapters/src/codex.js';
import { NATIVE_ENV_ALLOWLIST, type SessionSpec } from '@pantheon/domain';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

const inherited = process.env.TMPDIR;
beforeEach(() => {
  process.env.TMPDIR = '/inherited-temp';
});
afterEach(() => {
  if (inherited === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = inherited;
});

function writerSpec(runtime: string): SessionSpec {
  return {
    platform_session_id: 'temporary-session',
    project_id: 'temporary-project',
    runtime,
    device_id: 'local',
    role: 'writer',
    cwd: process.cwd(),
    env_allowlist: NATIVE_ENV_ALLOWLIST,
    env: { TMPDIR: '/writer-temp', PATH: '/project-only/bin' },
    skills: [],
    mcp_servers: [],
    budget: { max_turns: 1, wall_time_ms: 1000 },
  };
}

describe('writer temporary directory in the native environment', () => {
  it('gives the Claude process the session temporary directory over the inherited one', async () => {
    const seen: NodeJS.ProcessEnv[] = [];
    const query = ({ options }: { options: { env?: NodeJS.ProcessEnv } }) => {
      seen.push(options.env!);
      return {
        initializationResult: async () => ({
          account: { apiProvider: 'firstParty', subscriptionType: 'max' },
        }),
        close: () => {},
        async *[Symbol.asyncIterator]() {},
      };
    };
    const adapter = new ClaudeAdapter('claude', 'test', query as never);
    const handle = await adapter.start(writerSpec('claude'), () => {});
    await adapter.close(handle, Date.now() + 1000);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ TMPDIR: '/writer-temp', PATH: process.env.PATH });
  });

  it('gives the Codex process the session temporary directory over the inherited one', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const reply = (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n');
    child.stdin.on('data', (data) => {
      for (const line of String(data).split('\n').filter(Boolean)) {
        const request = JSON.parse(line) as { id: number; method: string };
        if (request.method === 'initialize') reply({ id: request.id, result: {} });
        if (request.method === 'account/read')
          reply({ id: request.id, result: { account: { type: 'chatgpt', planType: 'plus' } } });
        if (request.method === 'config/read')
          reply({ id: request.id, result: { config: { model_provider: 'openai' } } });
        if (request.method === 'thread/name/set') reply({ id: request.id, result: {} });
        if (request.method === 'thread/start')
          reply({ id: request.id, result: { thread: { id: 'temporary-thread' } } });
      }
    });
    const adapter = new CodexAdapter('fake-codex');
    const handle = await adapter.start(writerSpec('codex'), () => {});
    child.emit('close', 0, null);
    await adapter.close(handle, Date.now() + 1000);
    const options = vi.mocked(spawn).mock.calls[0]![2] as { env: NodeJS.ProcessEnv };
    expect(options.env).toMatchObject({ TMPDIR: '/writer-temp', PATH: process.env.PATH });
  });
});
