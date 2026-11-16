import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  Options,
  SDKUserMessage,
} from '../../packages/adapters/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts';
import { ClaudeAdapter } from '../../packages/adapters/src/claude.js';
import { NATIVE_ENV_ALLOWLIST, type AgentEvent, type SessionSpec } from '@pantheon/domain';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
});

const spec = (overrides: Partial<SessionSpec> = {}): SessionSpec => ({
  platform_session_id: 'title-session',
  project_id: 'title-project',
  runtime: 'claude',
  device_id: 'local',
  role: 'writer',
  cwd: process.cwd(),
  env_allowlist: NATIVE_ENV_ALLOWLIST,
  skills: [],
  mcp_servers: [],
  extensions: { mode: 'none' },
  budget: { max_turns: 1, wall_time_ms: 10000 },
  ...overrides,
});

const init = {
  type: 'system',
  subtype: 'init',
  session_id: 'native-title',
  model: 'claude-model',
  tools: [],
  mcp_servers: [],
  skills: [],
};
const result = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  total_cost_usd: 0,
  usage: { input_tokens: 1, output_tokens: 1 },
};

/** A fake SDK whose query answers every user message with one result and names the session on request. */
function fakeClaude(generate: (description: string) => Promise<string | null>) {
  const options: Options[] = [];
  const titles: { description: string; options: unknown }[] = [];
  const queryFn = vi.fn(
    ({ prompt, options: given }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      options.push(given);
      const output: unknown[] = [];
      let wake: (() => void) | undefined;
      let closed = false;
      const push = (message: unknown) => {
        output.push(message);
        wake?.();
      };
      void (async () => {
        for await (const message of prompt) {
          push({ ...init });
          push({ ...result, user_message_uuid: message.uuid });
        }
      })();
      return {
        initializationResult: async () => ({
          account: { apiProvider: 'firstParty', subscriptionType: 'max' },
        }),
        generateSessionTitle: vi.fn(async (description: string, options: unknown) => {
          titles.push({ description, options });
          return generate(description);
        }),
        close() {
          closed = true;
          wake?.();
        },
        async *[Symbol.asyncIterator]() {
          for (;;) {
            if (output.length) {
              yield output.shift();
              continue;
            }
            if (closed) return;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = undefined;
          }
        },
      };
    },
  );
  return { adapter: new ClaudeAdapter('fake-claude', 'test', queryFn as never), options, titles };
}

async function run(f: ReturnType<typeof fakeClaude>, sessionSpec: SessionSpec, inputs: string[]) {
  const events: AgentEvent[] = [];
  const handle = await f.adapter.start(sessionSpec, (event) => events.push(event));
  cleanup.push(() => f.adapter.close(handle, Date.now() + 1000));
  for (const [index, input] of inputs.entries()) {
    await f.adapter.send(handle, { turn_id: `turn-${index}`, input });
    await vi.waitFor(() =>
      expect(events.filter((event) => event.kind === 'turn.completed')).toHaveLength(index + 1),
    );
  }
  return events;
}

describe('Claude session titles', () => {
  it('lets Claude Code name a new session and reads the title once after the first turn', async () => {
    const f = fakeClaude(async () => 'Importer row loss');
    const events = await run(f, spec({ auto_title: true }), [
      'Fix the importer, it drops the last row',
      'Add a test',
    ]);
    expect(f.options[0]).not.toHaveProperty('title');
    await vi.waitFor(() =>
      expect(events.filter((event) => event.kind === 'title.generated')).toMatchObject([
        { title: 'Importer row loss' },
      ]),
    );
    expect(f.titles).toEqual([
      { description: 'Fix the importer, it drops the last row', options: { persist: true } },
    ]);
  });

  it('keeps giving a session it does not let Claude Code name its native title', async () => {
    const f = fakeClaude(async () => 'Unused');
    const events = await run(f, spec({ native_title: 'Project · Review' }), ['Review this']);
    expect(f.options[0]).toMatchObject({ title: 'Project · Review' });
    expect(f.titles).toEqual([]);
    expect(events.some((event) => event.kind === 'title.generated')).toBe(false);
  });

  it('logs a title request the CLI refuses and sends no title', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fakeClaude(async () => {
      throw new Error('unsupported control request: generate_session_title');
    });
    const events = await run(f, spec({ auto_title: true }), ['Fix the importer', 'Again']);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(f.titles).toHaveLength(1);
    expect(events.some((event) => event.kind === 'title.generated')).toBe(false);
  });
});
