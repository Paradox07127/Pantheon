import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BoardSnapshot, BridgeResult, EventFrame } from '@pantheon/protocol';
import { startSync, type DaemonEvent, type SyncView } from '@/data/sync';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const board = (cursor: number): BoardSnapshot => ({
  cursor,
  projects: [],
  sessions: [],
  session_turns: [],
  workspaces: [],
});
const event = (sequence: number): DaemonEvent => ({
  sequence,
  event_id: `e${sequence}`,
  kind: 'session.renamed',
  aggregate_id: 'a',
  aggregate_revision: 1,
  project_id: 'p',
  causation_id: '',
  created_at: 0,
  payload: null,
});

function setup() {
  const queries: ((result: BridgeResult<unknown>) => void)[] = [];
  const subs: {
    options: { cursor?: number; project_id?: string };
    push: (frame: EventFrame) => void;
    ended: boolean;
  }[] = [];
  const bridge = {
    query: () => new Promise<BridgeResult<unknown>>((resolve) => queries.push(resolve)),
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
  };
  const views: SyncView[] = [];
  const sync = startSync(bridge, {}, (view) => views.push(view));
  const view = () => views.at(-1)!;
  const live = async (cursor: number) => {
    queries.at(-1)!({ ok: true, value: board(cursor) });
    await vi.advanceTimersByTimeAsync(0);
    subs.at(-1)!.push({ type: 'subscribed', cursor });
  };
  return { queries, subs, view, sync, live };
}

it('resubscribes from its cursor when no frame arrives within the liveness window', async () => {
  const t = setup();
  await t.live(0);
  t.subs[0]!.push({ type: 'event', event: event(1) });
  await vi.advanceTimersByTimeAsync(44_999);
  expect(t.view().status).toEqual({ state: 'live' });
  await vi.advanceTimersByTimeAsync(1);
  expect(t.view().status.state).toBe('offline');
  expect(t.subs[0]!.ended).toBe(true);
  expect(t.subs).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(500);
  expect(t.subs).toHaveLength(2);
  expect(t.subs[1]!.options.cursor).toBe(1);
  t.subs[1]!.push({ type: 'subscribed', cursor: 1 });
  await vi.advanceTimersByTimeAsync(0);
  expect(t.view().status).toEqual({ state: 'live' });
  t.sync.stop();
});

it('goes offline and subscribes again when a subscription never sends its first frame', async () => {
  const t = setup();
  t.queries[0]!({ ok: true, value: board(5) });
  await vi.advanceTimersByTimeAsync(44_999);
  expect(t.view().status).toEqual({ state: 'connecting' });
  await vi.advanceTimersByTimeAsync(1);
  expect(t.view().status).toEqual({ state: 'offline', reason: 'No frame from the daemon' });
  expect(t.subs[0]!.ended).toBe(true);
  await vi.advanceTimersByTimeAsync(500);
  expect(t.subs.map((s) => s.options.cursor)).toEqual([5, 5]);
  t.sync.stop();
});

it('keeps the subscription while heartbeat frames arrive', async () => {
  const t = setup();
  await t.live(3);
  for (let i = 0; i < 6; i++) {
    await vi.advanceTimersByTimeAsync(15_000);
    t.subs[0]!.push({ type: 'heartbeat', cursor: 3 });
  }
  await vi.advanceTimersByTimeAsync(44_999);
  expect(t.subs).toHaveLength(1);
  expect(t.subs[0]!.ended).toBe(false);
  expect(t.view().status).toEqual({ state: 'live' });
  expect(t.view().cursor).toBe(3);
  t.sync.stop();
});

it('drops frames of the subscription it gave up on', async () => {
  const t = setup();
  await t.live(0);
  await vi.advanceTimersByTimeAsync(45_000);
  const offline = t.view();
  expect(offline.status.state).toBe('offline');
  t.subs[0]!.push({ type: 'event', event: event(1) });
  t.subs[0]!.push({ type: 'heartbeat', cursor: 1 });
  t.subs[0]!.push({ type: 'closed', code: 1013, reason: 'Replay from last cursor' });
  expect(t.view()).toBe(offline);
  expect(t.subs).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(500);
  expect(t.subs).toHaveLength(2);
  expect(t.subs[1]!.options.cursor).toBe(0);
  t.sync.stop();
});

it('backs off between 1013 resubscriptions that keep closing', async () => {
  const t = setup();
  await t.live(0);
  const closed: EventFrame = { type: 'closed', code: 1013, reason: 'Replay from last cursor' };
  t.subs[0]!.push(closed);
  expect(t.subs).toHaveLength(2);
  for (const wait of [500, 1000, 2000]) {
    const count = t.subs.length;
    t.subs.at(-1)!.push({ type: 'subscribed', cursor: 0 });
    t.subs.at(-1)!.push(closed);
    await vi.advanceTimersByTimeAsync(wait - 1);
    expect(t.subs).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.subs).toHaveLength(count + 1);
  }
  // An event between closes ends the run; the next 1013 resubscribes at once again.
  t.subs.at(-1)!.push({ type: 'subscribed', cursor: 0 });
  t.subs.at(-1)!.push({ type: 'event', event: event(1) });
  const count = t.subs.length;
  t.subs.at(-1)!.push(closed);
  expect(t.subs).toHaveLength(count + 1);
  expect(t.subs.at(-1)!.options.cursor).toBe(1);
  t.sync.stop();
});
