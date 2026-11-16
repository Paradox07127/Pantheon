import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BridgeResult } from '@pantheon/protocol';
import { deferred, mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { useProjectQuery } from '@/data/project-read';

let reads: ReturnType<typeof deferred<BridgeResult<unknown>>>[] = [];
beforeEach(() => {
  mock.board = { status: { state: 'live' }, resync: 0, events: [], board: { cursor: 1 } };
  reads = [];
  const query = vi.fn(() => {
    const read = deferred<BridgeResult<unknown>>();
    reads.push(read);
    return read.promise;
  });
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {}, pantheon: { query } });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const slow: BridgeResult<unknown> = {
  ok: false,
  error: { code: 'query_timeout', message: 'read timed out' },
};

it('marks a project read stale once its slow reread was retried and timed out again', async () => {
  vi.useFakeTimers();
  const h = mount(() => useProjectQuery<string[]>('facts.stale', 'stale-project', Array.isArray));
  reads[0]!.resolve({ ok: true, value: ['fact'] });
  await h.flush();
  expect(h.value).toMatchObject({ read: ['fact'], stale: false });

  h.value.reload();
  h.render();
  reads[1]!.resolve(slow);
  await h.flush();
  expect(h.value).toMatchObject({ read: ['fact'], error: null, stale: false });
  await vi.advanceTimersByTimeAsync(2000);
  await h.flush();
  expect(reads).toHaveLength(3);
  reads[2]!.resolve(slow);
  await h.flush();
  expect(h.value).toMatchObject({ read: ['fact'], error: null, loading: false, stale: true });

  h.value.reload();
  h.render();
  reads[3]!.resolve({ ok: true, value: ['fact', 'new fact'] });
  await h.flush();
  expect(h.value).toMatchObject({ read: ['fact', 'new fact'], stale: false });
});
