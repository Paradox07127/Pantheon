import { afterEach, expect, it, vi } from 'vitest';
import { deferred, mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  board: { status: { state: 'live' }, resync: 500, events: [] as any[] },
}));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({ useBoard: (select: any) => select(mock.board) }));
import { useMemoryQuery } from '@/data/memory';
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

it('does not request hidden bodies and drops the previous selection before an asynchronous read', async () => {
  const pending = deferred<any>();
  const query = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, value: { text: 'first body' } })
    .mockReturnValueOnce(pending.promise);
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {}, pantheon: { query } });
  let selected: string | null = null;
  const host = mount(() =>
    useMemoryQuery('memory.item', 'lazy-project', selected ? { memory_id: selected } : null),
  );
  await host.flush();
  expect(query).not.toHaveBeenCalled();
  selected = 'first';
  host.render();
  await host.flush();
  expect(host.value.data).toEqual({ text: 'first body' });
  selected = 'second';
  host.render();
  expect(host.value.data).toBeNull();
  expect(query).toHaveBeenLastCalledWith('memory.item', {
    project_id: 'lazy-project',
    memory_id: 'second',
  });
  pending.resolve({ ok: false, error: { code: 'not_found', message: 'Archived' } });
  await host.flush();
  expect(host.value.data).toBeNull();
  expect(host.value.error).toContain('Archived');
  selected = null;
  host.render();
  expect(host.value.data).toBeNull();
  expect(query).toHaveBeenCalledTimes(2);
});

it('keeps the data during a refresh, marked as rereading, and keeps structured filters in the query identity', async () => {
  const pending = deferred<any>();
  const query = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, value: { records: ['old current'] } })
    .mockReturnValueOnce(pending.promise);
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {}, pantheon: { query } });
  const host = mount(() =>
    useMemoryQuery<{ records: string[] }>('memory.read', 'refresh-project', {
      state: 'active',
      tag: '数据库',
      limit: 20,
      cursor: undefined,
    }),
  );
  await host.flush();
  expect(host.value.data?.records).toEqual(['old current']);
  expect(query).toHaveBeenLastCalledWith('memory.read', {
    project_id: 'refresh-project',
    state: 'active',
    tag: '数据库',
    limit: '20',
  });
  host.value.reload();
  host.render();
  expect(host.value).toMatchObject({
    data: { records: ['old current'] },
    loading: false,
    refreshing: true,
  });
  pending.resolve({ ok: true, value: { records: [] } });
  await host.flush();
  expect(host.value.data?.records).toEqual([]);
});
