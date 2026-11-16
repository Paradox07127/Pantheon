import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  Options,
  SDKUserMessage,
} from '../../packages/adapters/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts';
import { ClaudeAdapter } from '../../packages/adapters/src/claude.js';
import {
  NATIVE_ENV_ALLOWLIST,
  type AgentEvent,
  type SessionHandle,
  type SessionSpec,
} from '@pantheon/domain';

const roots: string[] = [];
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sessionSpec(): SessionSpec {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pantheon-mcp-app-')));
  roots.push(root);
  return {
    platform_session_id: 'app-session',
    project_id: 'app-project',
    runtime: 'claude',
    device_id: 'local',
    role: 'writer',
    cwd: root,
    env_allowlist: NATIVE_ENV_ALLOWLIST,
    skills: [],
    mcp_servers: [],
    budget: { max_turns: 1, wall_time_ms: 10000 },
  };
}

function channel<T>() {
  const items: T[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  return {
    push(item: T) {
      items.push(item);
      wake?.();
    },
    end() {
      done = true;
      wake?.();
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
      for (;;) {
        if (items.length) {
          yield items.shift()!;
          continue;
        }
        if (done) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    },
  };
}

const servers = [
  {
    name: 'charts',
    status: 'connected',
    tools: [
      { name: 'plot', _meta: { ui: { resourceUri: 'ui://charts/plot', visibility: ['app'] } } },
      { name: 'legacy', _meta: { 'ui/resourceUri': 'ui://charts/legacy' } },
      {
        name: 'both',
        _meta: { ui: { resourceUri: 'ui://charts/new' }, 'ui/resourceUri': 'ui://x' },
      },
      { name: 'web', _meta: { ui: { resourceUri: 'https://charts.example/plot' } } },
      { name: 'plain' },
    ],
  },
];

function fakeClaude() {
  const outputs: ReturnType<typeof channel<unknown>>[] = [];
  const inputs: SDKUserMessage[] = [];
  const mcpServerStatus = vi.fn(async () => servers);
  const closes = vi.fn();
  const readMcpResource = vi.fn(async (_server: string, uri: string) => ({
    contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: '<p>chart</p>' }],
  }));
  const queryFn = vi.fn(
    ({ prompt }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      const output = channel<unknown>();
      outputs.push(output);
      void (async () => {
        for await (const message of prompt) inputs.push(message);
      })();
      return {
        initializationResult: async () => ({
          account: { apiProvider: 'firstParty', subscriptionType: 'max' },
        }),
        close() {
          closes();
          output.end();
        },
        mcpServerStatus,
        readMcpResource,
        [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
      };
    },
  );
  return {
    adapter: new ClaudeAdapter('fake-claude', 'test', queryFn as never),
    outputs,
    inputs,
    mcpServerStatus,
    readMcpResource,
    queryFn,
    closes,
  };
}

const init = (capabilities?: string[]) => ({
  type: 'system',
  subtype: 'init',
  session_id: 'native-app',
  model: 'claude-model',
  tools: [],
  mcp_servers: [],
  skills: [],
  ...(capabilities ? { capabilities } : {}),
});
const result = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0 },
  modelUsage: {},
};
const toolUse = (id: string, name: string) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { id: `message-${id}`, content: [{ type: 'tool_use', id, name, input: {} }] },
});
const toolResult = (
  id: string,
  content: unknown,
  extra: { is_error?: boolean; tool_use_result?: unknown } = {},
) => ({
  type: 'user',
  parent_tool_use_id: null,
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: id,
        content,
        ...(extra.is_error !== undefined ? { is_error: extra.is_error } : {}),
      },
    ],
  },
  ...(extra.tool_use_result !== undefined ? { tool_use_result: extra.tool_use_result } : {}),
});

async function runTurn(f: ReturnType<typeof fakeClaude>, messages: unknown[]) {
  const events: AgentEvent[] = [];
  const handle: SessionHandle = await f.adapter.start(sessionSpec(), (event) => events.push(event));
  cleanup.push(() => f.adapter.close(handle, Date.now() + 1000));
  await f.adapter.send(handle, { turn_id: 'app-turn', input: 'Plot it' });
  await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
  for (const message of messages) f.outputs.at(-1)!.push(message);
  await vi.waitFor(() =>
    expect(events.some((event) => event.kind === 'turn.completed')).toBe(true),
  );
  return { handle, events };
}

const started = (events: AgentEvent[]) =>
  Object.fromEntries(
    events.flatMap((event) =>
      event.kind === 'tool.started' ? [[event.tool_call_id, event.app]] : [],
    ),
  );
const completed = (events: AgentEvent[], id: string) =>
  events.find(
    (event): event is Extract<AgentEvent, { kind: 'tool.completed' }> =>
      event.kind === 'tool.completed' && event.tool_call_id === id,
  )!;

it('marks the tools with a ui:// interface when the CLI reports their UI metadata', async () => {
  const f = fakeClaude();
  const { events } = await runTurn(f, [
    init(['mcp_tool_ui_meta_v1']),
    toolUse('plot-call', 'mcp__charts__plot'),
    toolUse('legacy-call', 'mcp__charts__legacy'),
    toolUse('both-call', 'mcp__charts__both'),
    toolUse('web-call', 'mcp__charts__web'),
    toolUse('plain-call', 'mcp__charts__plain'),
    result,
  ]);
  expect(f.mcpServerStatus).toHaveBeenCalledOnce();
  expect(started(events)).toEqual({
    'plot-call': { server: 'charts', resource_uri: 'ui://charts/plot' },
    'legacy-call': { server: 'charts', resource_uri: 'ui://charts/legacy' },
    'both-call': { server: 'charts', resource_uri: 'ui://charts/new' },
    'web-call': undefined,
    'plain-call': undefined,
  });
});

it('keeps the turn going when the MCP status read fails', async () => {
  const f = fakeClaude();
  f.mcpServerStatus.mockRejectedValueOnce(new Error('status unavailable'));
  const { events } = await runTurn(f, [
    init(['mcp_tool_ui_meta_v1']),
    toolUse('plot-call', 'mcp__charts__plot'),
    toolResult('plot-call', 'plotted'),
    result,
  ]);
  expect(started(events)).toEqual({ 'plot-call': undefined });
  expect(completed(events, 'plot-call').ok).toBe(true);
});

it('reads no tool UI metadata from a CLI without the capability', async () => {
  const f = fakeClaude();
  const { events } = await runTurn(f, [
    init(['interrupt_receipt_v1']),
    toolUse('plot-call', 'mcp__charts__plot'),
    toolResult('plot-call', 'plotted', { tool_use_result: { structuredContent: { x: 1 } } }),
    result,
  ]);
  expect(f.mcpServerStatus).not.toHaveBeenCalled();
  expect(started(events)).toEqual({ 'plot-call': undefined });
  expect(completed(events, 'plot-call').app_result).toBeUndefined();
});

it('gives an interface tool its full result, from tool_use_result first', async () => {
  const f = fakeClaude();
  const content = [{ type: 'text', text: 'three points' }];
  const { events } = await runTurn(f, [
    init(['mcp_tool_ui_meta_v1']),
    toolUse('plot-call', 'mcp__charts__plot'),
    toolResult('plot-call', 'three points', {
      tool_use_result: { content, structuredContent: { points: [1, 2, 3] } },
    }),
    toolUse('legacy-call', 'mcp__charts__legacy'),
    toolResult('legacy-call', 'legacy failed', { is_error: true }),
    toolUse('both-call', 'mcp__charts__both'),
    toolResult('both-call', [{ type: 'text', text: 'blocks' }], { tool_use_result: 'text only' }),
    toolUse('plain-call', 'mcp__charts__plain'),
    toolResult('plain-call', 'plain', { tool_use_result: { content } }),
    result,
  ]);
  expect(completed(events, 'plot-call').app_result).toEqual({
    content,
    structuredContent: { points: [1, 2, 3] },
  });
  expect(completed(events, 'legacy-call').app_result).toEqual({
    content: [{ type: 'text', text: 'legacy failed' }],
    isError: true,
  });
  expect(completed(events, 'both-call').app_result).toEqual({
    content: [{ type: 'text', text: 'blocks' }],
  });
  expect(completed(events, 'plain-call').app_result).toBeUndefined();
});

it('drops structuredContent and then the whole result when it is too large', async () => {
  const f = fakeClaude();
  const large = 'x'.repeat(1_048_576);
  const { events } = await runTurn(f, [
    init(['mcp_tool_ui_meta_v1']),
    toolUse('plot-call', 'mcp__charts__plot'),
    toolResult('plot-call', 'small', {
      tool_use_result: { content: [{ type: 'text', text: 'small' }], structuredContent: large },
    }),
    toolUse('legacy-call', 'mcp__charts__legacy'),
    toolResult('legacy-call', large),
    result,
  ]);
  expect(completed(events, 'plot-call').app_result).toEqual({
    content: [{ type: 'text', text: 'small' }],
  });
  expect(completed(events, 'legacy-call')).toBeDefined();
  expect(completed(events, 'legacy-call').app_result).toBeUndefined();
});

it('carries the result _meta to the interface, and drops it when the result is too large', async () => {
  const f = fakeClaude();
  const content = [{ type: 'text', text: 'three points' }];
  const { events } = await runTurn(f, [
    init(['mcp_tool_ui_meta_v1']),
    toolUse('plot-call', 'mcp__charts__plot'),
    toolResult('plot-call', 'three points', {
      tool_use_result: { content, structuredContent: { points: [1] }, _meta: { view: 'line' } },
    }),
    toolUse('legacy-call', 'mcp__charts__legacy'),
    toolResult('legacy-call', 'small', {
      tool_use_result: { content, _meta: { blob: 'x'.repeat(1_048_576) } },
    }),
    result,
  ]);
  expect(completed(events, 'plot-call').app_result).toEqual({
    content,
    structuredContent: { points: [1] },
    _meta: { view: 'line' },
  });
  expect(completed(events, 'legacy-call').app_result).toEqual({ content });
});

it('lists the servers the session last reported once its query has closed, without a probe', async () => {
  const f = fakeClaude();
  const { handle } = await runTurn(f, [
    {
      ...init(),
      mcp_servers: [
        { name: 'notes', status: 'connected' },
        { name: 'mail', status: 'needs-auth' },
      ],
    },
    result,
  ]);
  f.outputs.at(-1)!.end();
  await vi.waitFor(() => expect(f.closes).toHaveBeenCalled());
  expect(await f.adapter.mcpStatus(process.cwd(), handle)).toEqual([
    { name: 'notes', state: 'connected' },
    { name: 'mail', state: 'needs_sign_in' },
  ]);
  expect(f.queryFn).toHaveBeenCalledOnce();
});

it('carries the page an Artifact call published, and nothing for its other actions or other tools', async () => {
  const f = fakeClaude();
  const page = {
    url: 'https://claude.ai/artifact/page-a',
    path: '/work/tree/design.html',
    artifact_id: 'page-a',
    title: 'Landing design',
    version: '3',
    warnings: [],
  };
  const { events } = await runTurn(f, [
    init(),
    toolUse('publish-call', 'Artifact'),
    toolResult('publish-call', 'Published', { tool_use_result: page }),
    toolUse('untitled-call', 'Artifact'),
    toolResult('untitled-call', 'Published', {
      tool_use_result: { url: 'https://claude.ai/artifact/page-b', path: '/work/tree/b.html' },
    }),
    toolUse('list-call', 'Artifact'),
    toolResult('list-call', 'Listed', {
      tool_use_result: { artifacts: [{ title: 'Landing design', url: page.url }] },
    }),
    toolUse('other-call', 'mcp__charts__plain'),
    toolResult('other-call', 'plain', { tool_use_result: page }),
    result,
  ]);
  expect(completed(events, 'publish-call').artifact).toEqual({
    url: 'https://claude.ai/artifact/page-a',
    path: '/work/tree/design.html',
    title: 'Landing design',
    version: '3',
  });
  expect(completed(events, 'untitled-call').artifact).toEqual({
    url: 'https://claude.ai/artifact/page-b',
    path: '/work/tree/b.html',
  });
  expect(completed(events, 'list-call').artifact).toBeUndefined();
  expect(completed(events, 'other-call').artifact).toBeUndefined();
});

it('reads an interface resource through the live session', async () => {
  const f = fakeClaude();
  const { handle } = await runTurn(f, [init(['mcp_tool_ui_meta_v1']), result]);
  expect(await f.adapter.readMcpResource(handle, 'charts', 'ui://charts/plot')).toEqual({
    contents: [
      { uri: 'ui://charts/plot', mimeType: 'text/html;profile=mcp-app', text: '<p>chart</p>' },
    ],
  });
  expect(f.readMcpResource).toHaveBeenCalledWith('charts', 'ui://charts/plot');
});
