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
  platform_session_id: 'loop-session',
  project_id: 'loop-project',
  runtime: 'codex',
  device_id: 'local',
  role: 'writer',
  cwd,
  env_allowlist: NATIVE_ENV_ALLOWLIST,
  skills: [],
  mcp_servers: [],
  sandbox: { writable_roots: [cwd], protected_entries: [] },
  budget: { max_turns: 2, wall_time_ms: 10000 },
};

/** A Codex app server that answers the session's requests and lets the test send notifications. */
function fakeServer() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  const send = (frame: Frame) => child.stdout.write(JSON.stringify(frame) + '\n');
  child.stdin.on('data', (data) => {
    const frame = JSON.parse(String(data)) as Frame;
    if (!frame.method || frame.id === undefined) return;
    const config = frame.params?.config as Record<string, unknown> | undefined;
    const results: Record<string, unknown> = {
      initialize: {},
      'turn/interrupt': {},
      'account/read': { account: { type: 'chatgpt' } },
      'config/read': { config: {} },
      'plugin/installed': { marketplaces: [] },
      'mcpServerStatus/list': { data: [], nextCursor: null },
      'skills/list': { data: [] },
      'thread/name/set': {},
      'thread/start': {
        thread: { id: 'loop-thread' },
        approvalsReviewer: frame.params?.approvalsReviewer ?? 'auto_review',
        activePermissionProfile: config?.default_permissions
          ? { id: config.default_permissions, extends: null }
          : null,
      },
      'turn/start': { turn: { id: 'native-turn' } },
    };
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
  return send;
}

async function runningTurn() {
  const send = fakeServer();
  const adapter = new CodexAdapter('fake-codex');
  const events: AgentEvent[] = [];
  const handle = await adapter.start(spec, (event) => events.push(event));
  cleanup.push(() => adapter.close(handle, Date.now() + 1000));
  await adapter.send(handle, { turn_id: 'loop-turn', input: 'run the tests' });
  const tools = () => events.filter((event) => event.kind.startsWith('tool.'));
  const notify = (method: string, params: Record<string, unknown>) =>
    send({ method, params: { threadId: 'loop-thread', turnId: 'native-turn', ...params } });
  const complete = () =>
    send({
      method: 'turn/completed',
      params: { threadId: 'loop-thread', turn: { id: 'native-turn', status: 'completed' } },
    });
  return { events, tools, notify, complete };
}

it('emits each failed command execution of a running Codex turn before the turn ends', async () => {
  const f = await runningTurn();
  for (const id of ['first-test', 'second-test']) {
    const item = { id, type: 'commandExecution', command: 'pnpm test', cwd };
    f.notify('item/started', { item: { ...item, status: 'inProgress' } });
    f.notify('item/completed', {
      item: { ...item, status: 'failed', exitCode: 1, aggregatedOutput: 'exit 1' },
    });
  }

  expect(f.tools()).toEqual(
    ['first-test', 'second-test'].flatMap((id) => [
      expect.objectContaining({
        kind: 'tool.started',
        tool_call_id: id,
        name: 'commandExecution',
        input: { command: 'pnpm test', cwd },
        turn_id: 'loop-turn',
      }),
      expect.objectContaining({ kind: 'tool.completed', tool_call_id: id, ok: false }),
    ]),
  );
  expect(f.events.some((event) => event.kind === 'turn.completed')).toBe(false);
});

it('holds a raw-only tool call until the turn ends', async () => {
  const f = await runningTurn();
  f.notify('rawResponseItem/completed', {
    item: {
      type: 'function_call',
      id: 'response-item',
      call_id: 'raw-test',
      name: 'exec_command',
      arguments: JSON.stringify({ cmd: 'pnpm test' }),
    },
  });
  f.notify('rawResponseItem/completed', {
    item: {
      type: 'function_call_output',
      call_id: 'raw-test',
      output: 'Process exited with code 1',
    },
  });
  expect(f.tools()).toEqual([]);

  f.complete();
  expect(f.tools()).toEqual([
    expect.objectContaining({
      kind: 'tool.started',
      tool_call_id: 'raw-test',
      turn_id: 'loop-turn',
    }),
    expect.objectContaining({ kind: 'tool.completed', tool_call_id: 'raw-test', ok: false }),
  ]);
  expect(f.events.at(-1)?.kind).toBe('turn.completed');
});
