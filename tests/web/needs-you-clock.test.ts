import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { useNeedsYou } from '@/data/needs-you';

const answers: Record<string, unknown> = {
  'needs_you.list': { items: [] },
};
let reads: string[];
const count = (method: string) => reads.filter((read) => read === method).length;

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(2026, 10, 13, 10, 0, 0) });
  reads = [];
  mock.board = {
    board: { sessions: [], session_turns: [] },
    events: [],
    status: { state: 'live' },
    cursor: 0,
    resync: 0,
  };
  vi.stubGlobal('window', {
    pantheon: {
      query: vi.fn(async (method: string) => {
        reads.push(method);
        return { ok: true, value: answers[method] };
      }),
    },
    addEventListener() {},
    removeEventListener() {},
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('reads the needs-you list again on a clock, so items that come due with time show without an event', async () => {
  const h = mount(() => useNeedsYou(null));
  await h.flush();
  expect(count('needs_you.list')).toBe(1);
  await vi.advanceTimersByTimeAsync(60_000);
  await h.flush();
  expect(count('needs_you.list')).toBe(2);
});

it('reads no needs-you list on the clock while the event stream is down', async () => {
  mock.board = { ...mock.board, status: { state: 'offline', reason: 'gone' } };
  const h = mount(() => useNeedsYou('project-a'));
  await h.flush();
  await vi.advanceTimersByTimeAsync(180_000);
  await h.flush();
  expect(count('needs_you.list')).toBe(1);
});
