import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexAdapter, JsonRpcProcess } from '@pantheon/adapters';
import { NATIVE_ENV_ALLOWLIST, type AgentEvent, type SessionSpec } from '@pantheon/domain';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
});

type Frame = { id?: string | number; method?: string; params?: Record<string, unknown> };

const cwd = path.join(process.cwd(), 'clone');
const spec: SessionSpec = {
  platform_session_id: 'app-session',
  project_id: 'app-project',
  runtime: 'codex',
  device_id: 'local',
  role: 'writer',
  cwd,
  env_allowlist: NATIVE_ENV_ALLOWLIST,
  skills: [],
  mcp_servers: [],
  budget: { max_turns: 2, wall_time_ms: 10000 },
};

const charts = {
  name: 'charts',
  tools: {
    plot: { name: 'plot', inputSchema: {}, _meta: { ui: { resourceUri: 'ui://charts/plot' } } },
    legacy: { name: 'legacy', inputSchema: {}, _meta: { 'ui/resourceUri': 'ui://charts/legacy' } },
    refresh: {
      name: 'refresh',
      inputSchema: {},
      _meta: { ui: { resourceUri: 'ui://charts/plot', visibility: ['app'] } },
    },
    secret: { name: 'secret', inputSchema: {}, _meta: { ui: { visibility: ['model'] } } },
    web: { name: 'web', inputSchema: {}, _meta: { ui: { resourceUri: 'https://charts.example' } } },
    plain: { name: 'plain', inputSchema: {} },
  },
  toolsError: null,
};

/** A Codex app server that answers the session's MCP requests and lets the test send notifications. */
function fakeServer() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  const requests: Frame[] = [];
  const answers: Record<string, unknown> = {
    initialize: {},
    'account/read': { account: { type: 'chatgpt' } },
    'config/read': { config: {} },
    'plugin/installed': { marketplaces: [] },
    'skills/list': { data: [] },
    'thread/name/set': {},
    'thread/start': { thread: { id: 'app-thread' } },
    'turn/start': { turn: { id: 'native-turn' } },
    'mcpServerStatus/list': { data: [charts], nextCursor: null },
    'mcpServer/resource/read': {
      contents: [
        {
          uri: 'ui://charts/plot',
          mimeType: 'text/html;profile=mcp-app',
          text: '<p>chart</p>',
          _meta: { ui: { prefersBorder: false } },
        },
        { uri: 'ui://charts/plot', blob: 'AAAA' },
      ],
      originCallId: null,
    },
    'mcpServer/tool/call': {
      content: [{ type: 'text', text: 'refreshed' }],
      structuredContent: { points: [4, 5] },
      isError: false,
      _meta: { trace: 'x' },
    },
  };
  const send = (frame: Frame) => child.stdout.write(JSON.stringify(frame) + '\n');
  child.stdin.on('data', (data) => {
    for (const line of String(data).split('\n').filter(Boolean)) {
      const frame = JSON.parse(line) as Frame;
      if (!frame.method || frame.id === undefined) continue;
      requests.push(frame);
      if (!(frame.method in answers)) throw new Error(`Unexpected client request: ${frame.method}`);
      send({ id: frame.id, result: answers[frame.method] } as Frame);
    }
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
  return { send, requests };
}

async function runningTurn() {
  const server = fakeServer();
  const adapter = new CodexAdapter('fake-codex');
  const events: AgentEvent[] = [];
  const handle = await adapter.start(spec, (event) => events.push(event));
  cleanup.push(() => adapter.close(handle, Date.now() + 1000));
  await adapter.send(handle, { turn_id: 'app-turn', input: 'Plot it' });
  const notify = (method: string, params: Record<string, unknown>) =>
    server.send({ method, params: { threadId: 'app-thread', turnId: 'native-turn', ...params } });
  const call = (id: string, tool: string, extra: Record<string, unknown> = {}) => {
    const item = { id, type: 'mcpToolCall', server: 'charts', tool, arguments: {}, ...extra };
    notify('item/started', { item: { ...item, status: 'inProgress', result: null } });
    return (done: Record<string, unknown>) =>
      notify('item/completed', { item: { ...item, status: 'completed', ...done } });
  };
  const sent = (method: string) => server.requests.filter((frame) => frame.method === method);
  return { adapter, handle, events, call, sent };
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
  );

it('marks an MCP tool call whose item carries a ui:// interface', async () => {
  const f = await runningTurn();
  f.call('ui-call', 'plot', {
    mcpAppUi: { resourceUri: 'ui://charts/plot', preferredModelDisplayMode: 'inline' },
  });
  f.call('legacy-call', 'legacy', { mcpAppResourceUri: 'ui://charts/legacy' });
  f.call('web-call', 'web', { mcpAppUi: { resourceUri: 'https://charts.example' } });
  f.call('plain-call', 'plain');
  await vi.waitFor(() => expect(Object.keys(started(f.events))).toHaveLength(4));
  expect(started(f.events)).toEqual({
    'ui-call': { server: 'charts', resource_uri: 'ui://charts/plot' },
    'legacy-call': { server: 'charts', resource_uri: 'ui://charts/legacy' },
    'web-call': undefined,
    'plain-call': undefined,
  });
});

it('marks an MCP tool call from the tool list the live session reported', async () => {
  const f = await runningTurn();
  await f.adapter.mcpStatus(cwd, f.handle);
  f.call('plot-call', 'plot');
  f.call('legacy-call', 'legacy');
  f.call('web-call', 'web');
  await vi.waitFor(() => expect(Object.keys(started(f.events))).toHaveLength(3));
  expect(started(f.events)).toEqual({
    'plot-call': { server: 'charts', resource_uri: 'ui://charts/plot' },
    'legacy-call': { server: 'charts', resource_uri: 'ui://charts/legacy' },
    'web-call': undefined,
  });
});

it('asks for the MCP status of the live session on its thread', async () => {
  const f = await runningTurn();
  await f.adapter.mcpStatus(cwd, f.handle);
  expect(f.sent('mcpServerStatus/list').at(-1)?.params).toMatchObject({ threadId: 'app-thread' });
});

it('passes the result _meta to the interface within the same limit', async () => {
  const f = await runningTurn();
  const ui = { mcpAppUi: { resourceUri: 'ui://charts/plot' } };
  const content = [{ type: 'text', text: 'three points' }];
  f.call(
    'meta-call',
    'plot',
    ui,
  )({ result: { content, structuredContent: null, _meta: { trace: 'x' } } });
  f.call(
    'long-meta-call',
    'plot',
    ui,
  )({ result: { content, structuredContent: null, _meta: { trace: 'x'.repeat(1_048_576) } } });
  await vi.waitFor(() => expect(completed(f.events, 'long-meta-call')).toBeDefined());
  expect(completed(f.events, 'meta-call')?.app_result).toEqual({ content, _meta: { trace: 'x' } });
  expect(completed(f.events, 'long-meta-call')?.app_result).toEqual({ content });
});

it('gives an interface tool its full result and drops what is too large', async () => {
  const f = await runningTurn();
  const ui = { mcpAppUi: { resourceUri: 'ui://charts/plot' } };
  const content = [{ type: 'text', text: 'three points' }];
  const large = 'x'.repeat(1_048_576);
  f.call(
    'full-call',
    'plot',
    ui,
  )({
    result: { content, structuredContent: { points: [1, 2, 3] }, _meta: null },
  });
  f.call(
    'failed-call',
    'plot',
    ui,
  )({
    status: 'failed',
    result: null,
    error: { message: 'chart server down' },
  });
  f.call(
    'long-structure-call',
    'plot',
    ui,
  )({
    result: { content, structuredContent: large, _meta: null },
  });
  f.call(
    'long-content-call',
    'plot',
    ui,
  )({
    result: { content: [{ type: 'text', text: large }], structuredContent: null, _meta: null },
  });
  f.call('plain-call', 'plain')({ result: { content, structuredContent: null, _meta: null } });
  await vi.waitFor(() => expect(completed(f.events, 'plain-call')).toBeDefined());
  expect(completed(f.events, 'full-call')?.app_result).toEqual({
    content,
    structuredContent: { points: [1, 2, 3] },
  });
  expect(completed(f.events, 'failed-call')?.app_result).toEqual({
    content: [{ type: 'text', text: 'chart server down' }],
    isError: true,
  });
  expect(completed(f.events, 'long-structure-call')?.app_result).toEqual({ content });
  expect(completed(f.events, 'long-content-call')).toBeDefined();
  expect(completed(f.events, 'long-content-call')?.app_result).toBeUndefined();
  expect(completed(f.events, 'plain-call')?.app_result).toBeUndefined();
});

it('reads an interface resource through the thread, naming the call that showed it', async () => {
  const f = await runningTurn();
  expect(await f.adapter.readMcpResource(f.handle, 'charts', 'ui://charts/plot')).toEqual({
    contents: [
      {
        uri: 'ui://charts/plot',
        mimeType: 'text/html;profile=mcp-app',
        text: '<p>chart</p>',
        _meta: { ui: { prefersBorder: false } },
      },
      { uri: 'ui://charts/plot', blob: 'AAAA' },
    ],
  });
  f.call('ui-call', 'plot', { mcpAppUi: { resourceUri: 'ui://charts/plot' } });
  await vi.waitFor(() => expect(started(f.events)['ui-call']).toBeDefined());
  await f.adapter.readMcpResource(f.handle, 'charts', 'ui://charts/plot');
  expect(f.sent('mcpServer/resource/read').map((frame) => frame.params)).toEqual([
    { threadId: 'app-thread', server: 'charts', uri: 'ui://charts/plot' },
    { threadId: 'app-thread', server: 'charts', uri: 'ui://charts/plot', originCallId: 'ui-call' },
  ]);
});

it('calls an MCP tool of the thread without a model turn', async () => {
  const f = await runningTurn();
  expect(await f.adapter.callMcpTool(f.handle, 'charts', 'refresh', { week: 2 })).toEqual({
    content: [{ type: 'text', text: 'refreshed' }],
    structuredContent: { points: [4, 5] },
    isError: false,
    _meta: { trace: 'x' },
  });
  expect(f.sent('mcpServer/tool/call').map((frame) => frame.params)).toEqual([
    { threadId: 'app-thread', server: 'charts', tool: 'refresh', arguments: { week: 2 } },
  ]);
});

it('finds the visibility of a tool on the thread MCP connection', async () => {
  const f = await runningTurn();
  expect(await f.adapter.findMcpTool(f.handle, 'charts', 'refresh')).toEqual({
    visibility: ['app'],
  });
  expect(await f.adapter.findMcpTool(f.handle, 'charts', 'secret')).toEqual({
    visibility: ['model'],
  });
  expect(await f.adapter.findMcpTool(f.handle, 'charts', 'plain')).toEqual({});
  expect(await f.adapter.findMcpTool(f.handle, 'charts', 'missing')).toBeUndefined();
  expect(f.sent('mcpServerStatus/list').at(-1)?.params).toEqual({
    detail: 'toolsAndAuthOnly',
    threadId: 'app-thread',
    serverName: 'charts',
  });
});
