import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BridgeResult, EventFrame } from '@pantheon/protocol';
import { deferred, mount as host, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  board: { status: { state: 'live' }, resync: 0 },
}));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { useQuery } from '@/data/workbench-sessions';
import { startSync, type DaemonEvent, type SyncView } from '@/data/sync';

let reads: ReturnType<typeof deferred<BridgeResult<unknown>>>[] = [];
let query: ReturnType<typeof vi.fn>;
beforeEach(() => {
  mock.board = { status: { state: 'live' }, resync: 0 };
  reads = [];
  query = vi.fn(() => {
    const read = deferred<BridgeResult<unknown>>();
    reads.push(read);
    return read.promise;
  });
  vi.stubGlobal('window', { pantheon: { query } });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const params = (key: string) => ({ project_id: key });
const accept = (value: unknown) => (Array.isArray(value) ? (value as string[]) : null);
const mount = (method: string, key: string, retain = false) =>
  host(() => useQuery(method, key, params, accept, 0, {}, retain));

it('shows the cached answer on the first frame of a second mount and reads it once again', async () => {
  const first = mount('cached.list', 'project-a');
  reads[0]!.resolve({ ok: true, value: ['row'] });
  await first.flush();
  expect(first.value.data).toEqual(['row']);
  first.unmount();

  const second = mount('cached.list', 'project-a');
  expect(second.value).toMatchObject({ data: ['row'], loading: false, refreshing: true });
  expect(query).toHaveBeenCalledTimes(2);
  reads[1]!.resolve({ ok: true, value: ['row', 'new row'] });
  await second.flush();
  expect(second.value).toMatchObject({ data: ['row', 'new row'], loading: false });
  expect(query).toHaveBeenCalledTimes(2);
});

it('keeps a retained cached answer stale with its old read time until its own read lands', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const first = mount('cached.retained', 'project-a', true);
  reads[0]!.resolve({ ok: true, value: ['row'] });
  await first.flush();
  first.unmount();

  vi.setSystemTime(5000);
  const second = mount('cached.retained', 'project-a', true);
  expect(second.value).toMatchObject({
    data: ['row'],
    loading: false,
    refreshing: true,
    stale: true,
    readAt: 1000,
  });
  reads[1]!.resolve({ ok: true, value: ['row'] });
  await second.flush();
  expect(second.value).toMatchObject({ loading: false, stale: false, readAt: 5000 });
  vi.useRealTimers();
});

it('sends one read for two mounts of the same query at once', async () => {
  const a = mount('shared.view', 'project-a');
  const b = mount('shared.view', 'project-a');
  expect(query).toHaveBeenCalledTimes(1);
  reads[0]!.resolve({ ok: true, value: ['row'] });
  await a.flush();
  await b.flush();
  expect(a.value.data).toEqual(['row']);
  expect(b.value.data).toEqual(['row']);
});

it('drops the cached answers when the board resyncs', async () => {
  const first = mount('resync.list', 'project-a');
  reads[0]!.resolve({ ok: true, value: ['row'] });
  await first.flush();
  first.unmount();

  mock.board = { ...mock.board, resync: 1 };
  const second = mount('resync.list', 'project-a');
  expect(second.value).toMatchObject({ data: null, loading: true });
});

const event = (sequence: number): DaemonEvent => ({
  sequence,
  event_id: `e${sequence}`,
  kind: 'agent.message.delta',
  aggregate_id: 'a',
  aggregate_revision: 1,
  project_id: 'p',
  causation_id: '',
  created_at: 0,
  payload: null,
});

it('tells subscribers once about 50 events that arrive within one frame, in order', async () => {
  vi.useFakeTimers();
  const pushes: ((frame: EventFrame) => void)[] = [];
  const bridge = {
    query: async () => ({
      ok: true as const,
      value: { cursor: 0, projects: [], sessions: [], session_turns: [], workspaces: [] },
    }),
    subscribe: (_options: unknown, listener: (frame: EventFrame) => void) => {
      pushes.push(listener);
      return () => {};
    },
  };
  const views: SyncView[] = [];
  const sync = startSync(bridge, {}, (view) => views.push(view));
  await vi.advanceTimersByTimeAsync(0);
  pushes[0]!({ type: 'subscribed', cursor: 0 });
  await vi.advanceTimersByTimeAsync(0);
  const before = views.length;

  for (let seq = 1; seq <= 50; seq++) pushes[0]!({ type: 'event', event: event(seq) });
  await vi.advanceTimersByTimeAsync(0);
  expect(views.length - before).toBe(1);
  expect(views.at(-1)!.events.map((e) => e.sequence)).toEqual(
    Array.from({ length: 50 }, (_, i) => i + 1),
  );
  sync.stop();
  vi.useRealTimers();
});
