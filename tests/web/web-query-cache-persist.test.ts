import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const KEY = 'pantheon.queryCache.v1';
let items: Map<string, string>;

beforeEach(() => {
  items = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  });
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The cache module as a window that just opened loads it. */
async function fresh() {
  vi.resetModules();
  return import('@/data/query-cache');
}

it('reads the stored summaries and session lists back in a new window with their read times', async () => {
  const first = await fresh();
  first.storeQuery('projects.summary', 'all', [{ project_id: 'alpha' }], 1000);
  first.storeQuery('session.list', 'alpha', [{ id: 'alpha-1' }], 2000);
  first.storeQuery('memory.context', 'alpha', { notes: [] }, 3000);
  expect(items.has(KEY)).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(items.has(KEY)).toBe(true);

  const second = await fresh();
  expect(second.cachedQuery('projects.summary', 'all')).toEqual({
    data: [{ project_id: 'alpha' }],
    readAt: 1000,
  });
  expect(second.cachedQuery('session.list', 'alpha')).toEqual({
    data: [{ id: 'alpha-1' }],
    readAt: 2000,
  });
  expect(second.cachedQuery('memory.context', 'alpha')).toBeUndefined();
});

it('drops a stored cache it cannot parse', async () => {
  items.set(KEY, '{"broken');
  const cache = await fresh();
  expect(cache.cachedQuery('projects.summary', 'all')).toBeUndefined();
  expect(items.has(KEY)).toBe(false);
});

it('drops the oldest stored answers once the stored cache passes 1 MB', async () => {
  const first = await fresh();
  const big = 'x'.repeat(400_000);
  for (const project of ['alpha', 'beta', 'gamma'])
    first.storeQuery('session.list', project, [big], 1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(items.get(KEY)!.length).toBeLessThanOrEqual(1024 * 1024);

  const second = await fresh();
  expect(second.cachedQuery('session.list', 'alpha')).toBeUndefined();
  expect(second.cachedQuery('session.list', 'beta')?.data).toEqual([big]);
  expect(second.cachedQuery('session.list', 'gamma')?.data).toEqual([big]);
});
