import { afterEach, expect, it, vi } from 'vitest';
import { unmountAll, mount } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  board: { status: { state: 'live' }, resync: 0, events: [] as any[] },
}));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((select: any) => select(mock.board), { getState: () => mock.board }),
}));
import { useMemoryContext } from '@/data/memory-context';
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

it('reads what agents get with the memory.context command and keeps the error code', async () => {
  const command = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, value: { epoch: 3, bytes: 10, items: [] } })
    .mockResolvedValueOnce({
      ok: false,
      error: { code: 'memory_budget_exceeded', message: 'Confirmed decisions exceed' },
    });
  vi.stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    pantheon: { command },
  });
  const host = mount(() => useMemoryContext('context-project'));
  await host.flush();
  expect(command).toHaveBeenCalledTimes(1);
  expect(command.mock.calls[0]![0]).toMatchObject({
    type: 'memory.context',
    input: { project_id: 'context-project' },
  });
  expect(host.value.data).toEqual({ epoch: 3, bytes: 10, items: [] });
  expect(host.value.error).toBeNull();
  host.value.reload();
  host.render();
  await host.flush();
  expect(command).toHaveBeenCalledTimes(2);
  expect(host.value.data).toBeNull();
  expect(host.value.error).toEqual({
    code: 'memory_budget_exceeded',
    message: 'Confirmed decisions exceed',
  });
});

it('reads again when the stream comes back, not when it drops', async () => {
  const command = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, error: { code: 'ipc_failed', message: 'daemon down' } })
    .mockResolvedValueOnce({ ok: true, value: { epoch: 4, bytes: 0, items: [] } });
  vi.stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    pantheon: { command },
  });
  const host = mount(() => useMemoryContext('reconnect-project'));
  await host.flush();
  expect(host.value.error?.code).toBe('ipc_failed');
  mock.board = { ...mock.board, status: { state: 'offline' } };
  host.render();
  await host.flush();
  expect(command).toHaveBeenCalledTimes(1);
  mock.board = { ...mock.board, status: { state: 'live' } };
  host.render();
  await host.flush();
  expect(command).toHaveBeenCalledTimes(2);
  expect(host.value.error).toBeNull();
  expect(host.value.data).toEqual({ epoch: 4, bytes: 0, items: [] });
});
