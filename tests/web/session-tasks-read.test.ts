import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { type HookHost, mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { useSessionTasks } from '@/data/session-tasks';
import type { DaemonEvent } from '@/data/sync';

const event = (sequence: number, kind: string, aggregate_id: string): DaemonEvent => ({
  sequence,
  event_id: `event-${sequence}`,
  kind,
  aggregate_id,
  aggregate_revision: 1,
  project_id: 'project-a',
  causation_id: '',
  created_at: 1_000 + sequence,
  payload: { task_id: 'task-a' },
});

let reads: unknown[];

async function deliver(h: HookHost<any>, ...events: DaemonEvent[]) {
  mock.board = { ...mock.board, events: [...mock.board.events, ...events] };
  h.render();
  await vi.advanceTimersByTimeAsync(2_500);
  await h.flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  reads = [];
  mock.board = { board: null, events: [], status: { state: 'live' }, resync: 0 };
  vi.stubGlobal('window', {
    pantheon: {
      query: vi.fn(async (method: string, params: unknown) => {
        reads.push([method, params]);
        return { ok: true, value: { cursor: 0, tasks: [] } };
      }),
    },
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("reads the session's tasks again after its task event and not after another session's", async () => {
  const h = mount(() => useSessionTasks('session-a'));
  await h.flush();
  const read = ['session.tasks', { session_id: 'session-a' }];
  expect(reads).toEqual([read]);
  await deliver(h, event(1, 'agent.task.started', 'session-b'));
  expect(reads).toEqual([read]);
  await deliver(h, event(2, 'agent.task.progress', 'session-a'));
  expect(reads).toEqual([read, read]);
  expect(h.value.data).toEqual({ cursor: 0, tasks: [] });
});
