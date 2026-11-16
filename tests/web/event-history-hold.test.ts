import { afterEach, expect, it, vi } from 'vitest';
import { HookHost } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  board: { events: [] as unknown[], status: { state: 'live' }, resync: 0 },
  listeners: new Set<() => void>(),
}));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
    subscribe: (fn: () => void) => {
      mock.listeners.add(fn);
      return () => mock.listeners.delete(fn);
    },
  }),
}));
import type { DaemonEvent } from '@/data/sync';
import { useEventHistory } from '@/data/logs';

const event = (sequence: number): DaemonEvent => ({
  sequence,
  event_id: `held-${sequence}`,
  kind: 'agent.message.delta',
  aggregate_id: 'session-held',
  aggregate_revision: sequence,
  project_id: 'project-held',
  causation_id: 'cause',
  created_at: 1_000 + sequence,
  payload: {},
});
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => event(from + i));
const stream = (events: DaemonEvent[]) => {
  mock.board = { ...mock.board, events };
  for (const fn of [...mock.listeners]) fn();
};

afterEach(() => {
  vi.unstubAllGlobals();
  mock.board = { events: [], status: { state: 'live' }, resync: 0 };
  mock.listeners.clear();
});

it('keeps the live events the board buffer dropped while the first read was out', async () => {
  let answer!: (value: unknown) => void;
  vi.stubGlobal('window', {
    pantheon: { query: () => new Promise((resolve) => (answer = resolve)) },
  });
  const h = new HookHost(() =>
    useEventHistory({ key: 'held-thread', project_id: 'project-held', after: 0 }),
  );
  h.render();
  await h.flush();
  stream(range(4, 10));
  h.render();
  // The buffer keeps its newest events only.
  stream(range(8, 14));
  h.render();
  answer({ ok: true, value: { events: range(1, 3), cursor: 3 } });
  await h.flush();
  h.unmount();
  expect(h.value.events?.map((e) => e.sequence)).toEqual(range(1, 14).map((e) => e.sequence));
});

it('reads a project history once for the callers that mount while it is out', async () => {
  const afters: string[] = [];
  vi.stubGlobal('window', {
    pantheon: {
      query: async (_method: string, params?: Record<string, string>) => {
        afters.push(params?.after ?? '');
        return { ok: true, value: { events: range(1, 2), cursor: 2 } };
      },
    },
  });
  const options = { project_id: 'project-shared-read', after: 0 };
  const first = new HookHost(() => useEventHistory({ ...options, key: 'pane-a' }));
  const second = new HookHost(() => useEventHistory({ ...options, key: 'pane-b' }));
  first.render();
  second.render();
  await first.flush();
  await second.flush();
  first.unmount();
  second.unmount();
  expect(afters).toEqual(['0']);
  expect(first.value.events?.map((e) => e.sequence)).toEqual([1, 2]);
  expect(second.value.events?.map((e) => e.sequence)).toEqual([1, 2]);
});
