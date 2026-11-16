import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeResult } from '@pantheon/protocol';
import { mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { useBackends } from '@/data/backends';
import {
  useInventories,
  useMcpReconnectable,
  useMcpStatus,
  useSessionMcpServers,
} from '@/data/extensions';

let answer: (method: string, params: Record<string, string>) => BridgeResult<unknown>;
const query = vi.fn(async (method: string, params: Record<string, string>) =>
  answer(method, params),
);
const down: BridgeResult<unknown> = {
  ok: false,
  error: { code: 'daemon_unreachable', message: 'daemon is restarting' },
};

beforeEach(() => {
  mock.board = { status: { state: 'live' }, events: [], board: null };
  answer = () => down;
  query.mockClear();
  vi.stubGlobal('window', { pantheon: { query } });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

/** Takes the stream down and back up, rendering the host at each step. */
async function reconnect(h: { render: () => unknown; flush: () => Promise<unknown> }) {
  mock.board = { ...mock.board, status: { state: 'offline', reason: 'restart' } };
  h.render();
  await h.flush();
  mock.board = { ...mock.board, status: { state: 'live' } };
  h.render();
  await h.flush();
}

const calls = (method: string) => query.mock.calls.filter(([m]) => m === method).length;

describe('settings reads after the daemon comes back', () => {
  it('reads the backends again once the stream is live again', async () => {
    const h = mount(() => useBackends());
    await h.flush();
    expect(calls('backend.list')).toBe(1);
    answer = () => ({ ok: true, value: [{ id: 'local', runtimes: ['claude'], models: [] }] });
    await reconnect(h);
    expect(calls('backend.list')).toBe(2);
    expect(h.value.map((b) => b.id)).toEqual(['local']);
  });

  it('reads the inventories again once the stream is live again', async () => {
    const h = mount(() => useInventories('alpha'));
    await h.flush();
    const first = calls('extensions.inventory');
    expect(Object.values(h.value.states).every((s) => s.state === 'error')).toBe(true);
    await reconnect(h);
    expect(calls('extensions.inventory')).toBe(2 * first);
  });

  it('keeps the inventories shown while they are read again after a reconnect', async () => {
    const h = mount(() => useInventories('alpha'));
    await h.flush();
    query.mockImplementation(() => new Promise<never>(() => {}));
    await reconnect(h);
    query.mockImplementation(async (method, params) => answer(method, params));
    expect(Object.values(h.value.states).every((s) => s.state === 'error')).toBe(true);
  });

  it('reads the MCP states of the project and of a session again once the stream is live again', async () => {
    const status = mount(() => useMcpStatus('alpha', 'claude'));
    const session = mount(() => useSessionMcpServers('live'));
    await status.flush();
    await session.flush();
    answer = (method) =>
      method === 'mcp.status'
        ? {
            ok: true,
            value: {
              runtime: 'claude',
              reconnect_available: false,
              servers: [{ name: 'tracker', state: 'connected' }],
            },
          }
        : { ok: true, value: [{ name: 'tracker', state: 'connected' }] };
    await reconnect(status);
    await reconnect(session);
    expect(calls('mcp.status')).toBe(2);
    expect(calls('session.mcp_servers')).toBe(2);
    expect([...status.value.keys()]).toEqual(['tracker']);
    expect(session.value).toEqual([{ name: 'tracker', state: 'connected' }]);
  });
});

describe('MCP reconnect availability', () => {
  it("follows the session's own mcp.status", async () => {
    answer = () => ({ ok: true, value: { runtime: 'claude', reconnect_available: false } });
    const off = mount(() => useMcpReconnectable('live'));
    await off.flush();
    expect(query).toHaveBeenCalledWith('mcp.status', { session_id: 'live' });
    expect(off.value).toBe(false);
    answer = () => ({ ok: true, value: { runtime: 'claude', reconnect_available: true } });
    const on = mount(() => useMcpReconnectable('live'));
    await on.flush();
    expect(on.value).toBe(true);
  });

  it('reads nothing and offers none without a session', async () => {
    const h = mount(() => useMcpReconnectable(undefined));
    await h.flush();
    expect(query).not.toHaveBeenCalled();
    expect(h.value).toBe(false);
  });
});
