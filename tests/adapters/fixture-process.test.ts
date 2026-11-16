import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { FixtureAdapter, terminate } from '@pantheon/adapters';
import { NATIVE_ENV_ALLOWLIST, type AgentEvent, type SessionSpec } from '@pantheon/domain';
import { eventually } from '../helpers.js';

vi.mock('../../packages/adapters/dist/process.js', async (original) => {
  const actual = await original<typeof import('../../packages/adapters/dist/process.js')>();
  return { ...actual, terminate: vi.fn(actual.terminate) };
});

const realTerminate = vi.mocked(terminate).getMockImplementation()!;
afterEach(() => vi.mocked(terminate).mockReset().mockImplementation(realTerminate));
const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-fixture-process-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const fakeServer = fileURLToPath(new URL('./fake-mcp-server.mjs', import.meta.url));
const spec = (cwd: string, overrides: Partial<SessionSpec> = {}): SessionSpec => ({
  platform_session_id: 'process-session',
  project_id: 'process-project',
  runtime: 'fixture',
  device_id: 'local',
  role: 'writer',
  cwd,
  env_allowlist: NATIVE_ENV_ALLOWLIST,
  skills: [],
  mcp_servers: [],
  budget: { max_turns: 1, wall_time_ms: 30000 },
  ...overrides,
});
const script = (...steps: unknown[]) => `fixture-script\n${JSON.stringify(steps)}`;
const running = (pid: number): boolean => {
  try {
    return !/^\s*Z/.test(
      execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }),
    );
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
};

it('stops an MCP launcher group after its leader closes stdio', async () => {
  const cwd = mkdtempSync(path.join(root, 'launcher-')),
    adapter = new FixtureAdapter(),
    events: AgentEvent[] = [];
  const handle = await adapter.start(
    spec(cwd, {
      pantheon_mcp: {
        command: '/bin/sh',
        args: [
          '-c',
          'sleep 30 </dev/null >/dev/null 2>&1 & printf "%s %s" "$$" "$!" > processes; exit 0',
        ],
        env: {},
      },
    }),
    (event) => events.push(event),
  );
  let descendant: number | undefined;
  try {
    await adapter.send(handle, {
      turn_id: 'launcher',
      input: script({ tool: { name: 'report', arguments: {} } }),
    });
    await eventually(() => existsSync(path.join(cwd, 'processes')));
    const [, child] = readFileSync(path.join(cwd, 'processes'), 'utf8').split(' ').map(Number);
    descendant = child!;
    await eventually(() => events.some((event) => event.kind === 'tool.completed'));
    await adapter.close(handle, Date.now() + 500);
    expect(running(descendant)).toBe(false);
  } finally {
    if (descendant !== undefined && running(descendant)) process.kill(descendant, 'SIGKILL');
    await adapter.close(handle, Date.now() + 500);
  }
});

it.each(['completion', 'interrupt', 'cancel'] as const)(
  'retains an unconfirmed script stop after %s and repeated close',
  async (ending) => {
    const cwd = mkdtempSync(path.join(root, `${ending}-`)),
      adapter = new FixtureAdapter(),
      events: AgentEvent[] = [];
    const handle = await adapter.start(
      spec(cwd, {
        pantheon_mcp: { command: process.execPath, args: [fakeServer, 'ok'], env: {} },
      }),
      (event) => events.push(event),
    );
    const reason = 'Process group is empty but its transport is still open';
    vi.mocked(terminate).mockImplementation(async (...args) => ({
      ...(await realTerminate(...args)),
      stopped: false,
      reason,
    }));
    try {
      await adapter.send(handle, {
        turn_id: ending,
        input: script(
          { tool: { name: 'report', arguments: {} } },
          ...(ending === 'completion' ? [] : [{ hang: true }]),
        ),
      });
      await eventually(() => events.some((event) => event.kind === 'tool.completed'));
      if (ending === 'completion') {
        await eventually(() =>
          vi.mocked(terminate).mock.results.some((result) => result.type === 'return'),
        );
        await vi.mocked(terminate).mock.results.at(-1)!.value;
        await sleep(0);
      } else if (ending === 'interrupt') {
        expect(await adapter.interrupt(handle)).toMatchObject({ ok: false, reason });
      } else {
        expect(await adapter.cancel(handle, Date.now() + 1000)).toMatchObject({
          stopped: false,
          reason,
        });
      }
      expect((await adapter.inspect(handle)).state).toBe('unknown');
      expect(
        events.filter((event) => event.kind === 'turn.completed' && event.status === 'completed'),
      ).toEqual([]);
      for (let attempt = 0; attempt < 2; attempt++)
        expect(await adapter.close(handle, Date.now() + 1000)).toMatchObject({
          stopped: false,
          reason,
        });
      vi.mocked(terminate).mockImplementation(realTerminate);
      expect((await adapter.close(handle, Date.now() + 1000)).stopped).toBe(true);
    } finally {
      vi.mocked(terminate).mockImplementation(realTerminate);
      await adapter.close(handle, Date.now() + 1000);
    }
  },
);

it('clears the dead process identity after a plain fixture turn completes', async () => {
  const cwd = mkdtempSync(path.join(root, 'identity-')),
    adapter = new FixtureAdapter(20),
    events: AgentEvent[] = [];
  const handle = await adapter.start(spec(cwd), (event) => events.push(event));
  try {
    await adapter.send(handle, { turn_id: 'identity', input: 'plain fixture turn' });
    const pid = handle.process_identity!.pid;
    await eventually(() => events.some((event) => event.kind === 'turn.completed'));
    expect(running(pid)).toBe(false);
    expect(await adapter.inspect(handle)).toMatchObject({
      state: 'idle',
      process_identity: undefined,
    });
    vi.mocked(terminate).mockClear();
    expect(await adapter.close(handle, Date.now() + 1000)).toMatchObject({
      stopped: true,
      evidence: { method: 'none', members: [] },
    });
    expect(terminate).not.toHaveBeenCalled();
  } finally {
    await adapter.close(handle, Date.now() + 1000);
  }
});
