import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { useSessionActivity } from '@/data/session-activity';

let reads: string[];

beforeEach(() => {
  vi.useFakeTimers();
  reads = [];
  mock.board = { board: null, events: [], status: { state: 'live' }, resync: 0 };
  vi.stubGlobal('window', {
    pantheon: {
      query: vi.fn(async (method: string) => {
        reads.push(method);
        return { ok: true, value: { from: '2026-11-03T00:00:00.000Z', tools_completed: [] } };
      }),
    },
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("reads the session's last hour again every five minutes without events", async () => {
  const h = mount(() => useSessionActivity('session-a'));
  await h.flush();
  expect(reads).toEqual(['session.activity']);
  await vi.advanceTimersByTimeAsync(4 * 60_000);
  await h.flush();
  expect(reads).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(60_000);
  await h.flush();
  expect(reads).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  await h.flush();
  expect(reads).toHaveLength(3);
  h.unmount();
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(reads).toHaveLength(3);
});
