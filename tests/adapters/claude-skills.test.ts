import { afterEach, expect, it, vi } from 'vitest';
import type {
  SDKMessage,
  SDKUserMessage,
} from '../../packages/adapters/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts';
import { ClaudeAdapter } from '../../packages/adapters/src/claude.js';
import { NATIVE_ENV_ALLOWLIST, type SessionSpec } from '@pantheon/domain';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

function skillSpec(): SessionSpec {
  return {
    platform_session_id: 'skill-session',
    project_id: 'skill-project',
    runtime: 'claude',
    device_id: 'local',
    role: 'writer',
    cwd: process.cwd(),
    env_allowlist: NATIVE_ENV_ALLOWLIST,
    skills: [],
    mcp_servers: [],
    extensions: { mode: 'none' },
    budget: { max_turns: 1, wall_time_ms: 10000 },
  };
}

/** A fake SDK that records every user message it reads and stays open until the test closes it. */
async function started() {
  const messages: SDKUserMessage[] = [];
  const query = vi.fn((args: { prompt: AsyncIterable<SDKUserMessage> }) => {
    const ended = Promise.withResolvers<void>();
    void (async () => {
      for await (const message of args.prompt) messages.push(message);
    })();
    return {
      initializationResult: async () => ({
        account: { apiProvider: 'firstParty', subscriptionType: 'max' },
      }),
      close: vi.fn(() => ended.resolve()),
      async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
        await ended.promise;
      },
    };
  });
  const adapter = new ClaudeAdapter('fake-claude', 'test', query as never);
  const handle = await adapter.start(skillSpec(), () => {});
  cleanup.push(() => adapter.close(handle, Date.now() + 1000));
  return { adapter, handle, messages };
}

it('invokes the turn skill as a slash command ahead of the turn text', async () => {
  const f = await started();
  await f.adapter.send(f.handle, {
    turn_id: 'skill-turn',
    input: 'tidy the export module',
    skills: [{ name: 'simplify', path: '/skills/simplify/SKILL.md' }],
  });
  await vi.waitFor(() => expect(f.messages).toHaveLength(1));
  expect(f.messages[0]!.message.content).toBe('/simplify tidy the export module');
});

it('sends the text unchanged when the turn names no skill', async () => {
  const f = await started();
  await f.adapter.send(f.handle, { turn_id: 'plain-turn', input: 'tidy the export module' });
  await vi.waitFor(() => expect(f.messages).toHaveLength(1));
  expect(f.messages[0]!.message.content).toBe('tidy the export module');
});
