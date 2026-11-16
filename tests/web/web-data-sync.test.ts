import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BoardSnapshot, BridgeResult, EventFrame } from '@pantheon/protocol';
import { MAX_EVENTS, startSync, type DaemonEvent, type SyncView } from '@/data/sync';
import { shortId } from '@/data/format';
import { useBoard } from '@/data/board';

const SNAPSHOT_KEY = 'pantheon.boardSnapshot.v1';
let stored: Map<string, string>;
beforeEach(() => {
  vi.useFakeTimers();
  stored = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const board = (cursor: number): BoardSnapshot => ({
  cursor,
  projects: [],
  sessions: [],
  session_turns: [],
  workspaces: [],
});
const event = (sequence: number, event_id = `e${sequence}`): DaemonEvent => ({
  sequence,
  event_id,
  kind: 'session.renamed',
  aggregate_id: 'a',
  aggregate_revision: 1,
  project_id: 'p',
  causation_id: '',
  created_at: 0,
  payload: null,
});

// Lets the promise callbacks of answered queries run.
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function setup(options: { project_id?: string } = {}) {
  const queries: {
    method: string;
    params: Record<string, string> | undefined;
    answer: (result: BridgeResult<unknown>) => Promise<void>;
    reject: (error: Error) => Promise<void>;
  }[] = [];
  const subs: {
    options: { cursor?: number; project_id?: string };
    push: (frame: EventFrame) => void;
    ended: boolean;
  }[] = [];
  const bridge = {
    query: (method: string, params?: Record<string, string>) =>
      new Promise<BridgeResult<unknown>>((resolve, reject) => {
        queries.push({
          method,
          params,
          answer: async (result) => {
            resolve(result);
            await flush();
          },
          reject: async (error) => {
            reject(error);
            await flush();
          },
        });
      }),
    subscribe: (
      options: { cursor?: number; project_id?: string },
      listener: (frame: EventFrame) => void,
    ) => {
      const sub = { options, push: listener, ended: false };
      subs.push(sub);
      return () => {
        sub.ended = true;
      };
    },
    command: vi.fn(),
  };
  const views: SyncView[] = [];
  const sync = startSync(bridge, options, (view) => views.push(view));
  const view = () => views.at(-1)!;
  const sequences = () => view().events.map((e) => e.sequence);
  // Answers the startup query with the given cursor and acknowledges the subscription.
  const live = async (cursor: number) => {
    await queries.at(-1)!.answer({ ok: true, value: board(cursor) });
    subs.at(-1)!.push({ type: 'subscribed', cursor });
  };
  return { bridge, queries, subs, views, view, sequences, sync, live };
}

it('starts connecting, reads the board, then subscribes from its cursor and goes live', async () => {
  const t = setup({ project_id: 'p1' });
  expect(t.view().status).toEqual({ state: 'connecting' });
  expect(t.queries.map((q) => [q.method, q.params])).toEqual([['board', { project_id: 'p1' }]]);
  expect(t.subs).toHaveLength(0);
  await t.queries[0]!.answer({ ok: true, value: board(5) });
  expect(t.view().board?.cursor).toBe(5);
  expect(t.view().cursor).toBe(5);
  expect(t.subs.map((s) => s.options)).toEqual([{ cursor: 5, project_id: 'p1' }]);
  t.subs[0]!.push({ type: 'subscribed', cursor: 5 });
  await flush();
  expect(t.view().status).toEqual({ state: 'live' });
});

it('queries the board without params when no project is given', () => {
  const t = setup();
  expect(t.queries[0]!.params).toBeUndefined();
});

it('goes offline when the board read fails and retries the whole startup after a backoff', async () => {
  const t = setup();
  await t.queries[0]!.answer({ ok: false, error: { code: 'unavailable', message: 'no daemon' } });
  expect(t.view().status).toEqual({ state: 'offline', reason: 'no daemon' });
  await vi.advanceTimersByTimeAsync(499);
  expect(t.queries).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(t.queries).toHaveLength(2);
  expect(t.view().status).toEqual({ state: 'connecting' });
  await t.queries[1]!.answer({ ok: false, error: { code: 'unavailable', message: 'no daemon' } });
  await vi.advanceTimersByTimeAsync(999);
  expect(t.queries).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(t.queries).toHaveLength(3);
  await t.live(0);
  expect(t.subs).toHaveLength(1);
});

it('keeps connecting through slow board reads and retries them after the backoff', async () => {
  const t = setup();
  await t.queries[0]!.answer({
    ok: false,
    error: { code: 'query_timeout', message: 'board read timed out' },
  });
  expect(t.view().status).toEqual({ state: 'connecting' });
  await vi.advanceTimersByTimeAsync(500);
  expect(t.queries).toHaveLength(2);
  await t.queries[1]!.answer({ ok: false, error: { code: 'daemon_busy', message: 'busy' } });
  expect(t.view().status).toEqual({ state: 'connecting' });
  await vi.advanceTimersByTimeAsync(1000);
  expect(t.queries).toHaveLength(3);
  await t.live(0);
  expect(t.views.some((v) => v.status.state === 'offline')).toBe(false);
  expect(t.view().status).toEqual({ state: 'live' });
});

it('goes offline when the daemon cannot be reached at all', async () => {
  const t = setup();
  await t.queries[0]!.answer({
    ok: false,
    error: { code: 'daemon_unavailable', message: 'connect ECONNREFUSED' },
  });
  expect(t.view().status).toEqual({ state: 'offline', reason: 'connect ECONNREFUSED' });
});

it('shows the board an earlier window stored at once, marked stale, until its own read lands', async () => {
  const first = setup();
  await first.live(7);
  expect(stored.has(SNAPSHOT_KEY)).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  first.sync.stop();

  const second = setup();
  expect(second.view()).toMatchObject({
    board: { cursor: 7 },
    stale: true,
    status: { state: 'connecting' },
  });
  // The stored board's cursor is no place to subscribe from.
  expect(second.subs).toHaveLength(0);
  await second.queries[0]!.answer({ ok: true, value: board(8) });
  expect(second.view()).toMatchObject({ board: { cursor: 8 }, stale: false });
  expect(second.subs.map((s) => s.options.cursor)).toEqual([8]);
});

it("does not show the stored board of every project in one project's window", async () => {
  const first = setup();
  await first.live(7);
  await vi.advanceTimersByTimeAsync(1000);
  first.sync.stop();
  expect(setup({ project_id: 'p1' }).view()).toMatchObject({ board: null, stale: false });
});

it('drops a stored board it cannot parse', () => {
  stored.set(SNAPSHOT_KEY, '{"broken');
  expect(setup().view()).toMatchObject({ board: null, stale: false });
  expect(stored.has(SNAPSHOT_KEY)).toBe(false);
});

it('does not store a board larger than 2 MB', async () => {
  const t = setup();
  const big = { ...board(3), projects: [{ name: 'x'.repeat(2 * 1024 * 1024) }] };
  await t.queries[0]!.answer({ ok: true, value: big });
  await vi.advanceTimersByTimeAsync(1000);
  expect(stored.has(SNAPSHOT_KEY)).toBe(false);
});

it('marks a protocol mismatch apart from going offline and retries it at the longest backoff', async () => {
  const t = setup();
  const mismatch = { code: 'protocol_mismatch', message: 'daemon protocol 2, app 1' };
  const status = { state: 'offline', reason: 'daemon protocol 2, app 1', protocol_mismatch: true };
  await t.queries[0]!.answer({ ok: false, error: mismatch });
  expect(t.view().status).toEqual(status);
  await vi.advanceTimersByTimeAsync(9_999);
  expect(t.queries).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(t.queries).toHaveLength(2);
  // The retry read keeps the mismatch on screen instead of flashing a reconnect.
  expect(t.view().status).toEqual(status);
  await t.queries[1]!.answer({ ok: false, error: mismatch });
  await vi.advanceTimersByTimeAsync(9_999);
  expect(t.queries).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  await t.live(0);
  expect(t.view().status).toEqual({ state: 'live' });
});

it('leaves no duplicate entries after reconnecting from the cursor', async () => {
  const t = setup();
  await t.live(0);
  for (const seq of [1, 2, 3]) t.subs[0]!.push({ type: 'event', event: event(seq) });
  t.subs[0]!.push({ type: 'closed', code: 1013, reason: 'Replay from last cursor' });
  await flush();
  expect(t.view().status).toEqual({ state: 'offline', reason: '1013 Replay from last cursor' });
  expect(t.subs).toHaveLength(2);
  expect(t.subs[1]!.options.cursor).toBe(3);
  t.subs[1]!.push({ type: 'subscribed', cursor: 3 });
  for (const seq of [2, 3, 4]) t.subs[1]!.push({ type: 'event', event: event(seq) });
  await flush();
  expect(t.sequences()).toEqual([1, 2, 3, 4]);
  expect(t.view().events.map((e) => e.event_id)).toEqual(['e1', 'e2', 'e3', 'e4']);
  expect(t.view().cursor).toBe(4);
});

it.each([
  [
    'keeps one entry when the same event arrives twice on one subscription',
    0,
    [event(1), event(1)],
    [1],
  ],
  ['drops events at or below the snapshot cursor', 5, [event(5, 'x5'), event(6)], [6]],
])('%s', async (_, cursor, events, expected) => {
  const t = setup();
  await t.live(cursor);
  for (const e of events) t.subs[0]!.push({ type: 'event', event: e });
  await flush();
  expect(t.sequences()).toEqual(expected);
});

it('keeps only the newest MAX_EVENTS events', async () => {
  const t = setup();
  await t.live(0);
  for (let seq = 1; seq <= MAX_EVENTS + 1; seq++)
    t.subs[0]!.push({ type: 'event', event: event(seq) });
  await flush();
  expect(t.view().events).toHaveLength(MAX_EVENTS);
  expect(t.sequences()[0]).toBe(2);
});

it('resubscribes after a doubling backoff on other close codes and resets it once subscribed', async () => {
  const t = setup();
  await t.live(0);
  t.subs[0]!.push({ type: 'event', event: event(1) });
  t.subs[0]!.push({ type: 'closed', code: 1006, reason: 'gone' });
  await flush();
  expect(t.view().status).toEqual({ state: 'offline', reason: '1006 gone' });
  await vi.advanceTimersByTimeAsync(499);
  expect(t.subs).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(t.subs).toHaveLength(2);
  expect(t.subs[1]!.options.cursor).toBe(1);
  t.subs[1]!.push({ type: 'closed', code: 1006, reason: 'gone' });
  await vi.advanceTimersByTimeAsync(999);
  expect(t.subs).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(t.subs).toHaveLength(3);
  t.subs[2]!.push({ type: 'subscribed', cursor: 1 });
  await flush();
  expect(t.view().status).toEqual({ state: 'live' });
  t.subs[2]!.push({ type: 'closed', code: 1006, reason: 'gone' });
  await vi.advanceTimersByTimeAsync(500);
  expect(t.subs).toHaveLength(4);
});

it('caps the reconnect backoff at 10 s', async () => {
  const t = setup();
  await t.live(0);
  for (const wait of [500, 1000, 2000, 4000, 8000, 10_000, 10_000]) {
    const count = t.subs.length;
    t.subs.at(-1)!.push({ type: 'closed', code: 1006, reason: 'gone' });
    await vi.advanceTimersByTimeAsync(wait - 1);
    expect(t.subs).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.subs).toHaveLength(count + 1);
  }
});

it('rereads the board on snapshot_required and resubscribes once from its cursor', async () => {
  const t = setup();
  await t.live(10);
  t.subs[0]!.push({ type: 'event', event: event(11) });
  t.subs[0]!.push({ type: 'event', event: event(12) });
  t.subs[0]!.push({ type: 'snapshot_required', cursor: 3 });
  expect(t.view().events).toEqual([]);
  expect(t.queries).toHaveLength(2);
  await t.queries[1]!.answer({ ok: true, value: board(3) });
  expect(t.view().board?.cursor).toBe(3);
  expect(t.view().cursor).toBe(3);
  expect(t.subs).toHaveLength(2);
  expect(t.subs[1]!.options.cursor).toBe(3);
  t.subs[0]!.push({ type: 'closed', code: 1000, reason: '' });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(t.subs).toHaveLength(2);
  // An event replayed from before the reset is new again.
  t.subs[1]!.push({ type: 'event', event: event(11) });
  await flush();
  expect(t.sequences()).toEqual([11]);
});

it('ends the previous subscription before it subscribes again', async () => {
  const t = setup();
  await t.live(10);
  t.subs[0]!.push({ type: 'snapshot_required', cursor: 3 });
  await t.queries[1]!.answer({ ok: true, value: board(3) });
  expect(t.subs).toHaveLength(2);
  expect(t.subs[0]!.ended).toBe(true);
  t.subs[1]!.push({ type: 'subscribed', cursor: 3 });
  t.subs[1]!.push({ type: 'closed', code: 1013, reason: 'try again' });
  expect(t.subs).toHaveLength(3);
  expect(t.subs.map((s) => s.ended)).toEqual([true, true, false]);
});

it('records the revision of a trace.changed frame', async () => {
  const t = setup();
  await t.live(4);
  expect(t.view().trace_revision).toBe(0);
  t.subs[0]!.push({ type: 'trace.changed', revision: 7 });
  await flush();
  expect(t.view().trace_revision).toBe(7);
  expect(t.view().cursor).toBe(4);
});

it('discards a snapshot that arrives after a newer one', async () => {
  const t = setup();
  t.sync.refresh();
  await vi.advanceTimersByTimeAsync(100);
  expect(t.queries).toHaveLength(2);
  await t.queries[0]!.answer({ ok: true, value: board(8) });
  await t.queries[1]!.answer({ ok: true, value: board(6) });
  expect(t.view().board?.cursor).toBe(8);
});

it('subscribes from a newer refresh when the startup snapshot answers last', async () => {
  const t = setup();
  t.sync.refresh();
  await vi.advanceTimersByTimeAsync(100);
  await t.queries[1]!.answer({ ok: true, value: board(8) });
  await t.queries[0]!.answer({ ok: true, value: board(6) });
  expect(t.view().board?.cursor).toBe(8);
  expect(t.view().cursor).toBe(8);
  expect(t.subs[0]!.options.cursor).toBe(8);
});

it('keeps a newer refresh of replaced history when the replacement snapshot answers last', async () => {
  const t = setup();
  await t.live(10);
  t.subs[0]!.push({ type: 'snapshot_required', cursor: 3 });
  t.sync.refresh();
  await vi.advanceTimersByTimeAsync(100);
  await t.queries[2]!.answer({ ok: true, value: board(5) });
  await t.queries[1]!.answer({ ok: true, value: board(3) });
  expect(t.view().board?.cursor).toBe(5);
  expect(t.view().cursor).toBe(5);
  expect(t.subs[1]!.options.cursor).toBe(5);
});

it('does not catch up to the old history cursor while the replacement startup read waits', async () => {
  const t = setup();
  await t.live(10);
  t.subs[0]!.push({ type: 'event', event: event(11) });
  t.subs[0]!.push({ type: 'snapshot_required', cursor: 3 });
  t.sync.refresh();
  await vi.advanceTimersByTimeAsync(100);
  await t.queries[2]!.answer({ ok: true, value: board(3) });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(t.queries).toHaveLength(3);
  expect(t.view().board?.cursor).toBe(3);
});

it('cancels pending reads of the old history when a replacement snapshot is required', async () => {
  const t = setup();
  await t.live(10);
  t.subs[0]!.push({ type: 'event', event: { ...event(11), kind: 'agent.message.delta' } });
  t.subs[0]!.push({ type: 'event', event: event(12) });
  t.subs[0]!.push({ type: 'snapshot_required', cursor: 3 });
  await t.queries[1]!.answer({ ok: true, value: board(3) });
  await vi.advanceTimersByTimeAsync(2_500);
  expect(t.queries).toHaveLength(2);
});

it('refreshes again when the applied snapshot is behind the event cursor', async () => {
  const t = setup();
  await t.live(5);
  t.subs[0]!.push({ type: 'event', event: event(6) });
  t.subs[0]!.push({ type: 'event', event: event(7) });
  await vi.advanceTimersByTimeAsync(100);
  expect(t.queries).toHaveLength(2);
  await t.queries[1]!.answer({ ok: true, value: board(6) });
  expect(t.view().board?.cursor).toBe(6);
  // Readers of the board move only as far as the applied board reaches.
  expect(t.view().changed).toBe(6);
  await vi.advanceTimersByTimeAsync(100);
  expect(t.queries).toHaveLength(3);
  await t.queries[2]!.answer({ ok: true, value: board(7) });
  expect(t.view().changed).toBe(7);
  await vi.advanceTimersByTimeAsync(1000);
  expect(t.queries).toHaveLength(3);
});

it('keeps the board another window stored for its project when it stores its own', async () => {
  let onStorage!: (e: { key: string | null; newValue: string | null }) => void;
  vi.stubGlobal('addEventListener', (type: string, listener: typeof onStorage) => {
    if (type === 'storage') onStorage = listener;
  });
  vi.stubGlobal('removeEventListener', () => {});
  const t = setup({ project_id: 'p1' });
  const other = JSON.stringify({ p2: board(3) });
  stored.set(SNAPSHOT_KEY, other);
  onStorage({ key: SNAPSHOT_KEY, newValue: other });
  await t.live(5);
  await vi.advanceTimersByTimeAsync(1000);
  expect(Object.keys(JSON.parse(stored.get(SNAPSHOT_KEY)!)).sort()).toEqual(['p1', 'p2']);
  t.sync.stop();
});

it('reads the board at most once per 2 s while only streamed events arrive', async () => {
  const t = setup();
  await t.live(0);
  t.subs[0]!.push({ type: 'event', event: { ...event(1), kind: 'agent.message.delta' } });
  await vi.advanceTimersByTimeAsync(1000);
  t.subs[0]!.push({ type: 'event', event: { ...event(2), kind: 'agent.native' } });
  await vi.advanceTimersByTimeAsync(999);
  expect(t.sequences()).toEqual([1, 2]);
  expect(t.queries).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(t.queries).toHaveLength(2);
  await t.queries[1]!.answer({ ok: true, value: board(2) });
  t.subs[0]!.push({ type: 'event', event: { ...event(3), kind: 'agent.message.delta' } });
  await vi.advanceTimersByTimeAsync(1999);
  expect(t.queries).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(t.queries).toHaveLength(3);
});

it('does not read the board again when it is behind only streamed events', async () => {
  const t = setup();
  await t.live(5);
  t.subs[0]!.push({ type: 'event', event: event(6) });
  t.subs[0]!.push({ type: 'event', event: { ...event(7), kind: 'agent.message.delta' } });
  await vi.advanceTimersByTimeAsync(100);
  expect(t.queries).toHaveLength(2);
  await t.queries[1]!.answer({ ok: true, value: board(6) });
  await vi.advanceTimersByTimeAsync(1000);
  expect(t.queries).toHaveLength(2);
});

it('drops a board read that started before snapshot_required', async () => {
  const t = setup();
  await t.live(10);
  t.subs[0]!.push({ type: 'event', event: event(11) });
  await vi.advanceTimersByTimeAsync(100);
  expect(t.queries).toHaveLength(2);
  t.subs[0]!.push({ type: 'snapshot_required', cursor: 3 });
  expect(t.queries).toHaveLength(3);
  await t.queries[2]!.answer({ ok: true, value: board(3) });
  await t.queries[1]!.answer({ ok: true, value: board(11) });
  expect(t.view().board?.cursor).toBe(3);
  expect(t.view().cursor).toBe(3);
});

it('treats a rejected startup read as a failed read and retries', async () => {
  const t = setup();
  await t.queries[0]!.reject(new Error('ipc gone'));
  expect(t.view().status).toEqual({ state: 'offline', reason: 'ipc gone' });
  expect(t.view().error).toBe('ipc gone');
  await vi.advanceTimersByTimeAsync(500);
  expect(t.queries).toHaveLength(2);
});

it('keeps refreshing after a refresh read rejects', async () => {
  const t = setup();
  await t.live(0);
  t.subs[0]!.push({ type: 'event', event: event(1) });
  await vi.advanceTimersByTimeAsync(100);
  expect(t.queries).toHaveLength(2);
  await t.queries[1]!.reject(new Error('ipc gone'));
  t.subs[0]!.push({ type: 'event', event: event(2) });
  await vi.advanceTimersByTimeAsync(100);
  expect(t.queries).toHaveLength(3);
});

it('shows the last failed board read until a board is applied', async () => {
  const t = setup();
  await t.live(0);
  expect(t.view().error).toBeNull();
  t.subs[0]!.push({ type: 'event', event: event(1) });
  await vi.advanceTimersByTimeAsync(100);
  await t.queries[1]!.answer({
    ok: false,
    error: { code: 'daemon_unavailable', message: 'disk full' },
  });
  expect(t.view().error).toBe('disk full');
  t.sync.refresh();
  await vi.advanceTimersByTimeAsync(100);
  await t.queries[2]!.answer({ ok: true, value: board(1) });
  expect(t.view().error).toBeNull();
});

it('retries a failed refresh read after a doubling backoff and resets it once a board is applied', async () => {
  const t = setup();
  await t.live(0);
  const busy = { ok: false, error: { code: 'daemon_unavailable', message: 'busy' } } as const;
  t.subs[0]!.push({ type: 'event', event: event(1) });
  await vi.advanceTimersByTimeAsync(100);
  await t.queries[1]!.answer(busy);
  await vi.advanceTimersByTimeAsync(499);
  expect(t.queries).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(t.queries).toHaveLength(3);
  await t.queries[2]!.answer(busy);
  await vi.advanceTimersByTimeAsync(999);
  expect(t.queries).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(t.queries).toHaveLength(4);
  await t.queries[3]!.answer({ ok: true, value: board(1) });
  expect(t.view().board?.cursor).toBe(1);
  expect(t.view().error).toBeNull();
  t.subs[0]!.push({ type: 'event', event: event(2) });
  await vi.advanceTimersByTimeAsync(100);
  await t.queries[4]!.answer(busy);
  await vi.advanceTimersByTimeAsync(500);
  expect(t.queries).toHaveLength(6);
});

it('sends one board query for five events within 100 ms and queues one more while in flight', async () => {
  const t = setup();
  await t.live(0);
  for (const seq of [1, 2, 3, 4, 5]) {
    t.subs[0]!.push({ type: 'event', event: event(seq) });
    await vi.advanceTimersByTimeAsync(19);
  }
  await vi.advanceTimersByTimeAsync(4);
  expect(t.queries).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(t.queries).toHaveLength(2);
  t.subs[0]!.push({ type: 'event', event: event(6) });
  await vi.advanceTimersByTimeAsync(100);
  expect(t.queries).toHaveLength(2);
  await t.queries[1]!.answer({ ok: true, value: board(5) });
  expect(t.queries).toHaveLength(3);
});

it('reads the board during a long burst of events that arrive faster than the refresh delay', async () => {
  const t = setup();
  await t.live(0);
  for (let seq = 1; seq <= 10; seq++) {
    t.subs[0]!.push({ type: 'event', event: event(seq) });
    await vi.advanceTimersByTimeAsync(50);
  }
  expect(t.queries).toHaveLength(2);
});

it('ignores frames and results after stop and never sends commands', async () => {
  const t = setup();
  await t.live(0);
  t.subs[0]!.push({ type: 'event', event: event(1) });
  await vi.advanceTimersByTimeAsync(100);
  expect(t.queries).toHaveLength(2);
  t.sync.stop();
  expect(t.subs[0]!.ended).toBe(true);
  const seen = t.views.length;
  t.subs[0]!.push({ type: 'event', event: event(2) });
  t.subs[0]!.push({ type: 'snapshot_required', cursor: 0 });
  t.subs[0]!.push({ type: 'closed', code: 1006, reason: 'gone' });
  await t.queries[1]!.answer({ ok: true, value: board(1) });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(t.views).toHaveLength(seen);
  expect(t.subs).toHaveLength(1);
  expect(t.queries).toHaveLength(2);
  expect(t.bridge.command).not.toHaveBeenCalled();
});

it('clears a pending reconnect on stop', async () => {
  const t = setup();
  await t.live(0);
  t.subs[0]!.push({ type: 'closed', code: 1006, reason: 'gone' });
  t.sync.stop();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(t.subs).toHaveLength(1);
});

it("drops the previous project's board and events when the board starts on another project", () => {
  vi.stubGlobal('window', {
    pantheon: {
      query: () => new Promise<BridgeResult<unknown>>(() => {}),
      subscribe: () => () => {},
      command: vi.fn(),
    },
  });
  try {
    useBoard.setState({
      board: board(9),
      events: [event(9)],
      cursor: 9,
      status: { state: 'live' },
      error: 'old failure',
      resync: 2,
      trace_revision: 4,
    });
    useBoard.getState().start('project-b');
    expect(useBoard.getState()).toMatchObject({
      board: null,
      events: [],
      cursor: 0,
      status: { state: 'connecting' },
      error: null,
      resync: 0,
      trace_revision: 0,
    });
  } finally {
    useBoard.getState().stop();
    vi.unstubAllGlobals();
  }
});

it('resumes from the last delivered event when it reconnects after the daemon moved on', async () => {
  const t = setup();
  await t.live(5);
  t.subs[0]!.push({ type: 'closed', code: 1006, reason: 'gone' });
  t.sync.reconnect();
  await t.queries[1]!.answer({ ok: true, value: board(8) });
  expect(t.subs.map((s) => s.options.cursor)).toEqual([5, 5]);
  t.subs[1]!.push({ type: 'subscribed', cursor: 5 });
  for (const seq of [6, 7, 8]) t.subs[1]!.push({ type: 'event', event: event(seq) });
  await flush();
  expect(t.sequences()).toEqual([6, 7, 8]);
  expect(t.view().resync).toBe(0);
});

it('sends one board read for two reconnects during a protocol mismatch and none after stop', async () => {
  const t = setup();
  const mismatch = {
    ok: false,
    error: { code: 'protocol_mismatch', message: 'daemon protocol 2, app 1' },
  } as const;
  await t.queries[0]!.answer(mismatch);
  t.sync.reconnect();
  t.sync.reconnect();
  expect(t.queries).toHaveLength(2);
  await t.queries[1]!.answer(mismatch);
  t.sync.stop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(t.queries).toHaveLength(2);
});

it('counts a resync when events are trimmed before a notice carried them', async () => {
  const t = setup();
  await t.live(0);
  t.subs[0]!.push({ type: 'event', event: { ...event(1), kind: 'theme.applied' } });
  for (let seq = 2; seq <= MAX_EVENTS + 1; seq++)
    t.subs[0]!.push({ type: 'event', event: event(seq) });
  await flush();
  expect(t.view().events[0]!.kind).toBe('session.renamed');
  expect(t.view().resync).toBe(1);
  // Trimming events a notice already carried misses nothing.
  t.subs[0]!.push({ type: 'event', event: event(MAX_EVENTS + 2) });
  await flush();
  expect(t.sequences()[0]).toBe(3);
  expect(t.view().resync).toBe(1);
});

it('shortId keeps the first 8 characters', () => {
  expect(shortId('0f8c2a4e-1b2c-4d5e-8f90-123456789abc')).toBe('0f8c2a4e');
});
