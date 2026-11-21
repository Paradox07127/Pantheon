import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BridgeResult } from '@pantheon/protocol';
import { HookHost, deferred } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { useMemoryQuery } from '@/data/memory';
import { useNeedsYou } from '@/data/needs-you';
import { useProjectQuery } from '@/data/project-read';
import { useQuery, useSessionList } from '@/data/workbench-sessions';

type Read = ReturnType<typeof deferred<BridgeResult<unknown>>> & {
  method: string;
  params: unknown;
};
const hosts: HookHost<any>[] = [];
let reads: Read[] = [];
beforeEach(() => {
  mock.board = {
    status: { state: 'live' },
    resync: 0,
    events: [],
    board: { cursor: 1, sessions: [], session_turns: [] },
  };
  reads = [];
  const query = vi.fn((method: string, params: unknown) => {
    const read = Object.assign(deferred<BridgeResult<unknown>>(), { method, params });
    reads.push(read);
    return read.promise;
  });
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {}, pantheon: { query } });
});
afterEach(() => {
  hosts.splice(0).forEach((h) => h.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Mounts the hook and records the value of every render pass, the first frame included. */
function mount<T>(body: () => T) {
  const frames: T[] = [];
  const h = new HookHost(body, (value) => frames.push(value));
  hosts.push(h);
  h.render();
  return { h, frames };
}

/** What `<Activity>` does to a hidden page shown again: state kept, every effect run anew. */
function showAgain(h: HookHost<any>) {
  for (const slot of h.slots as any[])
    if (slot && typeof slot === 'object' && 'deps' in slot && !('value' in slot)) {
      slot.cleanup?.();
      delete slot.cleanup;
      slot.deps = [Symbol('shown again')];
    }
  h.render();
}

const ok = (value: unknown): BridgeResult<unknown> => ({ ok: true, value });
const failed: BridgeResult<unknown> = {
  ok: false,
  error: { code: 'ipc_failed', message: 'read failed' },
};
const params = (key: string) => ({ project_id: key });
const accept = (value: unknown) => (Array.isArray(value) ? (value as string[]) : null);

it('keeps the data and does not turn loading on when a page shown again reads its query anew', async () => {
  const { h, frames } = mount(() => useQuery('kept.list', 'project-a', params, accept, 0));
  reads[0]!.resolve(ok(['row']));
  await h.flush();
  frames.length = 0;

  showAgain(h);
  expect(reads).toHaveLength(2);
  expect(frames.every((f) => f.data?.[0] === 'row' && !f.loading)).toBe(true);
  expect(h.value).toMatchObject({ data: ['row'], loading: false, refreshing: true });
  reads[1]!.resolve(ok(['row', 'new row']));
  await h.flush();
  expect(h.value).toMatchObject({ data: ['row', 'new row'], loading: false, refreshing: false });
});

it('draws the cached answer on the first frame of a second mount, not as loading', async () => {
  const first = mount(() => useQuery('cached.first', 'project-a', params, accept, 0));
  reads[0]!.resolve(ok(['row']));
  await first.h.flush();
  first.h.unmount();

  const second = mount(() => useQuery('cached.first', 'project-a', params, accept, 0));
  expect(second.frames[0]).toMatchObject({ data: ['row'], loading: false, refreshing: true });
});

it('reads nothing and shows no loading without a key', () => {
  const { frames } = mount(() => useQuery('keyless.list', null, params, accept, 0));
  expect(reads).toHaveLength(0);
  expect(frames[0]).toMatchObject({ data: null, loading: false, refreshing: false });
});

it('draws a query with nothing cached as loading, not refreshing, on its first frame', () => {
  const { frames } = mount(() => useQuery('uncached.first', 'project-a', params, accept, 0));
  expect(frames[0]).toMatchObject({ data: null, loading: true, refreshing: false });
});

it('keeps the memory answer during a reread and says it is rereading instead', async () => {
  const { h, frames } = mount(() =>
    useMemoryQuery<{ records: string[] }>('memory.read', 'memory-project', { limit: 1 }),
  );
  reads[0]!.resolve(ok({ records: ['old'] }));
  await h.flush();
  frames.length = 0;

  h.value.reload();
  h.render();
  expect(frames.every((f) => f.data?.records[0] === 'old' && !f.loading)).toBe(true);
  expect(h.value.refreshing).toBe(true);
  reads[1]!.resolve(ok({ records: ['new'] }));
  await h.flush();
  expect(h.value).toMatchObject({ data: { records: ['new'] }, refreshing: false });
});

it("draws a project read seen before on the first frame and marks it stale until it's read again", async () => {
  let project = 'seen-a';
  const valid = Array.isArray;
  const { h, frames } = mount(() => useProjectQuery<string[]>('facts.list', project, valid));
  reads[0]!.resolve(ok(['fact of a']));
  await h.flush();
  project = 'seen-b';
  h.render();
  reads[1]!.resolve(ok(['fact of b']));
  await h.flush();
  frames.length = 0;

  project = 'seen-a';
  h.render();
  expect(frames[0]).toMatchObject({ read: ['fact of a'], loading: false, stale: true });
  expect(frames.every((f) => f.read?.[0] === 'fact of a' && !f.loading)).toBe(true);
  reads[2]!.resolve(ok(['fact of a', 'new fact']));
  await h.flush();
  expect(h.value).toMatchObject({ read: ['fact of a', 'new fact'], stale: false });

  frames.length = 0;
  showAgain(h);
  expect(frames.every((f) => f.read?.length === 2 && !f.loading)).toBe(true);
});

it('keeps the session list beside the error when a read of it fails', async () => {
  const { h } = mount(() => useSessionList('failing-list'));
  reads[0]!.resolve(ok([{ id: 'one' }]));
  await h.flush();

  h.value.reload();
  h.render();
  reads[1]!.resolve(failed);
  await h.flush();
  expect(h.value.data).toEqual([{ id: 'one' }]);
  expect(h.value.error).toContain('read failed');
});

it('keeps the needs-you items through a reread and beside the error when it fails', async () => {
  const { h, frames } = mount(() => useNeedsYou('needs-project'));
  reads[0]!.resolve(ok({ items: [{ id: 'item' }] }));
  await h.flush();
  frames.length = 0;

  h.value.reload();
  h.render();
  expect(frames.every((f) => f.items?.length === 1 && !f.loading)).toBe(true);
  reads[1]!.resolve(failed);
  await h.flush();
  expect(h.value.items).toEqual([{ id: 'item' }]);
  expect(h.value.error).toContain('read failed');
});

const slow: BridgeResult<unknown> = {
  ok: false,
  error: { code: 'query_timeout', message: 'read timed out' },
};

it('keeps the session list without an error while a slow reread of it is retried', async () => {
  vi.useFakeTimers();
  const { h } = mount(() => useSessionList('slow-list'));
  reads[0]!.resolve(ok([{ id: 'one' }]));
  await h.flush();

  h.value.reload();
  h.render();
  reads[1]!.resolve(slow);
  await h.flush();
  expect(h.value).toMatchObject({ data: [{ id: 'one' }], error: null, refreshing: true });
  await vi.advanceTimersByTimeAsync(2000);
  await h.flush();
  expect(reads).toHaveLength(3);
  reads[2]!.resolve(ok([{ id: 'one' }, { id: 'two' }]));
  await h.flush();
  expect(h.value).toMatchObject({ data: [{ id: 'one' }, { id: 'two' }], error: null });
});

it('stays loading when the first read is slow and reads once more after 2 s', async () => {
  vi.useFakeTimers();
  const { h } = mount(() => useQuery('slow.first', 'project-a', params, accept, 0));
  reads[0]!.resolve(slow);
  await h.flush();
  expect(h.value).toMatchObject({ data: null, loading: true, error: null });
  await vi.advanceTimersByTimeAsync(1999);
  expect(reads).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  await h.flush();
  expect(reads).toHaveLength(2);
  // A second slow answer with nothing to show is a failure.
  reads[1]!.resolve(slow);
  await h.flush();
  expect(h.value).toMatchObject({ data: null, loading: false });
  expect(h.value.error).toContain('read timed out');
  await vi.advanceTimersByTimeAsync(2000);
  expect(reads).toHaveLength(2);
});

it('keeps a project read without an error while a busy daemon is asked again', async () => {
  vi.useFakeTimers();
  const { h } = mount(() => useProjectQuery<string[]>('facts.busy', 'busy-project', Array.isArray));
  reads[0]!.resolve(ok(['fact']));
  await h.flush();

  h.value.reload();
  h.render();
  reads[1]!.resolve({ ok: false, error: { code: 'daemon_busy', message: 'busy' } });
  await h.flush();
  expect(h.value).toMatchObject({ read: ['fact'], error: null, loading: false });
  await vi.advanceTimersByTimeAsync(2000);
  await h.flush();
  expect(reads).toHaveLength(3);
});

it('keeps a project read with nothing to show loading when its first read is slow', async () => {
  vi.useFakeTimers();
  const { h } = mount(() => useProjectQuery<string[]>('facts.slow', 'slow-project', Array.isArray));
  reads[0]!.resolve(slow);
  await h.flush();
  expect(h.value).toMatchObject({ read: null, error: null, loading: true });
  await vi.advanceTimersByTimeAsync(2000);
  await h.flush();
  expect(reads).toHaveLength(2);
});
