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
  platform_session_id: 'interrupt-session',
  project_id: 'interrupt-project',
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
type Terminal = { itemId: string; processId: string; command: string; cwd: string };

/** Starts a session on a fake app-server that ends a turn only when it is interrupted; its background terminals list one per page. */
async function startCodex(
  holdTurnStart = false,
  refuseInterrupt = false,
  terminals: Terminal[] | 'error' = [],
) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  const requests: Request[] = [];
  const write = (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n');
  let started = 0;
  const held: (() => void)[] = [];
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
        write({ id: request.id, result: { thread: { id: 'interrupt-thread' } } });
      if (request.method === 'turn/start') {
        const reply = () =>
          write({ id: request.id, result: { turn: { id: `native-turn-${++started}` } } });
        if (holdTurnStart) held.push(reply);
        else reply();
      }
      if (request.method === 'turn/steer') write({ id: request.id, result: {} });
      if (request.method === 'thread/backgroundTerminals/list') {
        if (terminals === 'error')
          write({ id: request.id, error: { code: -32601, message: 'method not found' } });
        else {
          const index = Number(request.params.cursor ?? 0);
          write({
            id: request.id,
            result: {
              data: terminals.slice(index, index + 1),
              nextCursor: index + 1 < terminals.length ? String(index + 1) : null,
            },
          });
        }
      }
      if (request.method === 'thread/backgroundTerminals/terminate')
        write({ id: request.id, result: { terminated: true } });
      if (request.method === 'turn/interrupt' && refuseInterrupt)
        write({ id: request.id, error: { code: -32600, message: 'turn is not running' } });
      else if (request.method === 'turn/interrupt')
        // A real app-server answers over a pipe, after the adapter has handled what it read before.
        setImmediate(() => {
          write({ id: request.id, result: {} });
          write({
            method: 'turn/completed',
            params: {
              threadId: 'interrupt-thread',
              turn: { id: request.params.turnId, status: 'interrupted' },
            },
          });
        });
    }
  });
  const events: AgentEvent[] = [];
  const adapter = new CodexAdapter('fake-codex');
  const handle = await adapter.start(spec, (event) => events.push(event));
  const stop = async () => {
    child.emit('close', 0, null);
    await adapter.close(handle, Date.now() + 1000);
  };
  const interrupts = () => requests.filter((request) => request.method === 'turn/interrupt');
  const turnStarts = () => requests.filter((request) => request.method === 'turn/start');
  const completions = () => events.filter((event) => event.kind === 'turn.completed');
  const release = () => held.splice(0).forEach((reply) => reply());
  /** Announces a command item the given native turn started. */
  const startCommand = (turnId: string, itemId: string) =>
    write({
      method: 'item/started',
      params: {
        threadId: 'interrupt-thread',
        turnId,
        item: { type: 'commandExecution', id: itemId, command: 'tail -f log', cwd: spec.cwd },
      },
    });
  const terminalRequests = () =>
    requests
      .filter((request) => request.method.startsWith('thread/backgroundTerminals/'))
      .map((request) => ({ method: request.method, params: request.params }));
  return {
    adapter,
    handle,
    stop,
    interrupts,
    turnStarts,
    completions,
    release,
    child,
    write,
    events,
    requests,
    startCommand,
    terminalRequests,
  };
}

const terminal = (itemId: string, processId: string): Terminal => ({
  itemId,
  processId,
  command: 'tail -f log',
  cwd: spec.cwd,
});

describe('Codex interrupt', () => {
  it('interrupts the native turn and keeps the app-server for the next send', async () => {
    const codex = await startCodex();
    try {
      await codex.adapter.send(codex.handle, {
        turn_id: 'interrupted-turn',
        input: 'Work',
      });
      expect(await codex.adapter.interrupt!(codex.handle)).toEqual({ ok: true });
      expect(codex.interrupts().map((request) => request.params)).toEqual([
        { threadId: 'interrupt-thread', turnId: 'native-turn-1' },
      ]);
      await vi.waitFor(() => expect(codex.completions()).toHaveLength(1));
      expect(codex.completions()[0]).toMatchObject({
        turn_id: 'interrupted-turn',
        status: 'interrupted',
      });
      expect((await codex.adapter.inspect(codex.handle)).state).toBe('idle');
      expect(codex.child.stdin.writableEnded).toBe(false);
      expect(
        await codex.adapter.send(codex.handle, {
          turn_id: 'next-turn',
          input: 'Continue',
        }),
      ).toEqual({ turn_id: 'next-turn', status: 'delivered' });
      expect(codex.turnStarts()).toHaveLength(2);
      expect(spawn).toHaveBeenCalledOnce();
    } finally {
      await codex.stop();
    }
  });

  it('lets later steers through when Codex refuses the interrupt', async () => {
    const codex = await startCodex(false, true);
    try {
      await codex.adapter.send(codex.handle, {
        turn_id: 'refused-interrupt',
        input: 'Work',
      });
      expect(await codex.adapter.interrupt!(codex.handle)).toMatchObject({ ok: false });
      expect(
        await codex.adapter.steer!(codex.handle, {
          turn_id: 'steer-after-refusal',
          input: 'More',
        }),
      ).toMatchObject({ status: 'delivered' });
    } finally {
      await codex.stop();
    }
  });

  it('sends one interrupt once the turn id arrives', async () => {
    const codex = await startCodex(true);
    try {
      const sent = codex.adapter.send(codex.handle, {
        turn_id: 'early-interrupt',
        input: 'Work',
      });
      await vi.waitFor(() => expect(codex.turnStarts()).toHaveLength(1));
      const receipt = await codex.adapter.interrupt!(codex.handle);
      expect(receipt.ok).toBe(true);
      expect(codex.interrupts()).toEqual([]);
      codex.release();
      await sent;
      await vi.waitFor(() => expect(codex.completions()).toHaveLength(1));
      expect(codex.interrupts().map((request) => request.params)).toEqual([
        { threadId: 'interrupt-thread', turnId: 'native-turn-1' },
      ]);
      expect(codex.completions()[0]).toMatchObject({
        turn_id: 'early-interrupt',
        status: 'interrupted',
      });
    } finally {
      await codex.stop();
    }
  });

  it("stops the interrupted turn's commands and leaves an earlier turn's running", async () => {
    const codex = await startCodex(false, false, [
      terminal('call-earlier', '1001'),
      terminal('call-current', '1002'),
    ]);
    try {
      await codex.adapter.send(codex.handle, { turn_id: 'earlier-turn', input: 'Serve' });
      codex.startCommand('native-turn-1', 'call-earlier');
      codex.write({
        method: 'turn/completed',
        params: {
          threadId: 'interrupt-thread',
          turn: { id: 'native-turn-1', status: 'completed' },
        },
      });
      await vi.waitFor(() => expect(codex.completions()).toHaveLength(1));
      await codex.adapter.send(codex.handle, { turn_id: 'current-turn', input: 'Watch' });
      codex.startCommand('native-turn-2', 'call-current');
      await vi.waitFor(() =>
        expect(codex.events).toContainEqual(
          expect.objectContaining({ kind: 'tool.started', tool_call_id: 'call-current' }),
        ),
      );
      expect(await codex.adapter.interrupt!(codex.handle)).toEqual({ ok: true });
      const methods = codex.requests.map((request) => request.method);
      expect(methods.indexOf('turn/interrupt')).toBeLessThan(
        methods.indexOf('thread/backgroundTerminals/list'),
      );
      expect(codex.terminalRequests()).toEqual([
        { method: 'thread/backgroundTerminals/list', params: { threadId: 'interrupt-thread' } },
        {
          method: 'thread/backgroundTerminals/list',
          params: { threadId: 'interrupt-thread', cursor: '1' },
        },
        {
          method: 'thread/backgroundTerminals/terminate',
          params: { threadId: 'interrupt-thread', processId: '1002' },
        },
      ]);
    } finally {
      await codex.stop();
    }
  });

  it("stops the turn's commands when the interrupt waits for the turn id", async () => {
    const codex = await startCodex(true, false, [terminal('call-late', '2001')]);
    try {
      const sent = codex.adapter.send(codex.handle, { turn_id: 'late-turn', input: 'Watch' });
      await vi.waitFor(() => expect(codex.turnStarts()).toHaveLength(1));
      expect((await codex.adapter.interrupt!(codex.handle)).ok).toBe(true);
      codex.startCommand('native-turn-1', 'call-late');
      codex.release();
      await sent;
      await vi.waitFor(() =>
        expect(codex.terminalRequests()).toContainEqual({
          method: 'thread/backgroundTerminals/terminate',
          params: { threadId: 'interrupt-thread', processId: '2001' },
        }),
      );
    } finally {
      await codex.stop();
    }
  });

  it('still interrupts when Codex cannot list the background terminals', async () => {
    const codex = await startCodex(false, false, 'error');
    try {
      await codex.adapter.send(codex.handle, { turn_id: 'unlisted-turn', input: 'Watch' });
      codex.startCommand('native-turn-1', 'call-unlisted');
      await vi.waitFor(() =>
        expect(codex.events).toContainEqual(
          expect.objectContaining({ kind: 'tool.started', tool_call_id: 'call-unlisted' }),
        ),
      );
      const receipt = await codex.adapter.interrupt!(codex.handle);
      expect(receipt.ok).toBe(true);
      expect(receipt.reason).toMatch(/commands.*not stopped.*method not found/);
      expect(codex.terminalRequests().map((request) => request.method)).toEqual([
        'thread/backgroundTerminals/list',
      ]);
    } finally {
      await codex.stop();
    }
  });

  it('asks Codex for no background terminals when the turn started no command', async () => {
    const codex = await startCodex();
    try {
      await codex.adapter.send(codex.handle, { turn_id: 'quiet-turn', input: 'Think' });
      expect(await codex.adapter.interrupt!(codex.handle)).toEqual({ ok: true });
      expect(codex.terminalRequests()).toEqual([]);
    } finally {
      await codex.stop();
    }
  });

  it('reports the usage of a turn that ends without a Codex completion', async () => {
    const codex = await startCodex();
    try {
      await codex.adapter.send(codex.handle, { turn_id: 'cut-turn', input: 'Work' });
      const tokens = (inputTokens: number, outputTokens: number) => ({
        inputTokens,
        cachedInputTokens: 0,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      });
      codex.write({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'interrupt-thread',
          turnId: 'native-turn-1',
          tokenUsage: { last: tokens(30, 4), total: tokens(130, 14), modelContextWindow: 1000 },
        },
      });
      await vi.waitFor(() =>
        expect(codex.events.map((event) => event.native_type)).toContain(
          'thread/tokenUsage/updated',
        ),
      );
      codex.child.emit('close', 0, null);
      await vi.waitFor(() => expect(codex.completions()).toHaveLength(1));
      const usage = codex.events.filter((event) => event.kind === 'usage.updated');
      expect(usage).toEqual([
        expect.objectContaining({
          turn_id: 'cut-turn',
          input_tokens: 30,
          output_tokens: 4,
          context_tokens: 34,
          context_window: 1000,
        }),
      ]);
      expect(codex.events.indexOf(usage[0]!)).toBeLessThan(
        codex.events.indexOf(codex.completions()[0]!),
      );
    } finally {
      await codex.stop();
    }
  });

  it('reports cache writes and reasoning tokens without changing the input tokens', async () => {
    const codex = await startCodex();
    try {
      await codex.adapter.send(codex.handle, { turn_id: 'cache-turn', input: 'Work' });
      const tokens = (inputTokens: number, cacheWriteInputTokens: number, reasoning: number) => ({
        inputTokens,
        cachedInputTokens: 0,
        cacheWriteInputTokens,
        outputTokens: 10,
        reasoningOutputTokens: reasoning,
        totalTokens: inputTokens + 10,
      });
      codex.write({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'interrupt-thread',
          turnId: 'native-turn-1',
          tokenUsage: {
            last: tokens(30, 5, 3),
            total: tokens(130, 25, 13),
            modelContextWindow: 1000,
          },
        },
      });
      await vi.waitFor(() =>
        expect(codex.events.map((event) => event.native_type)).toContain(
          'thread/tokenUsage/updated',
        ),
      );
      codex.child.emit('close', 0, null);
      await vi.waitFor(() => expect(codex.completions()).toHaveLength(1));
      expect(codex.events.filter((event) => event.kind === 'usage.updated')).toEqual([
        expect.objectContaining({
          turn_id: 'cache-turn',
          input_tokens: 30,
          cache_write_input_tokens: 5,
          reasoning_output_tokens: 3,
        }),
      ]);
    } finally {
      await codex.stop();
    }
  });

  it('reports the usage of an interrupted turn once', async () => {
    const codex = await startCodex();
    try {
      await codex.adapter.send(codex.handle, { turn_id: 'interrupted-turn', input: 'Work' });
      await codex.adapter.interrupt!(codex.handle);
      await vi.waitFor(() => expect(codex.completions()).toHaveLength(1));
      expect(codex.events.filter((event) => event.kind === 'usage.updated')).toHaveLength(1);
    } finally {
      await codex.stop();
    }
  });
});
