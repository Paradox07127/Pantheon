import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BoardSnapshot, BridgeResult } from '@pantheon/protocol';
import { deferred, mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { useProjectQuery } from '@/data/project-read';

const board = (cursor: number): BoardSnapshot => ({
  cursor,
  projects: [],
  sessions: [],
  session_turns: [],
  workspaces: [],
});
const isFacts = (value: unknown) => value !== undefined;
const facts = (project: string) => () => useProjectQuery('project.facts.read', project, isFacts);

let reads: ((result: BridgeResult<unknown>) => void)[];
beforeEach(() => {
  reads = [];
  vi.stubGlobal('window', {
    pantheon: {
      query: vi.fn(() => {
        const answer = deferred<BridgeResult<unknown>>();
        reads.push(answer.resolve);
        return answer.promise;
      }),
    },
  });
  mock.board = { board: board(1), changed: 1, status: { state: 'live' }, resync: 0 };
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

it('keeps the newer read in the cache when an older read of another mount answers last', async () => {
  const first = mount(facts('project-order'));
  await first.flush();
  mock.board = { ...mock.board, board: board(2), changed: 2 };
  const second = mount(facts('project-order'));
  await second.flush();
  expect(reads).toHaveLength(2);
  reads[1]!({ ok: true, value: { facts: ['newer'] } });
  await second.flush();
  reads[0]!({ ok: true, value: { facts: ['older'] } });
  await first.flush();

  const third = mount(facts('project-order'));
  expect(third.value.read).toEqual({ facts: ['newer'] });
});

it('keeps no answer of a read sent before the board resynced', async () => {
  const first = mount(facts('project-resync'));
  await first.flush();
  expect(reads).toHaveLength(1);
  mock.board = { ...mock.board, resync: 1 };
  first.render();
  await first.flush();
  reads[0]!({ ok: true, value: { facts: ['before'] } });
  await first.flush();

  const second = mount(facts('project-resync'));
  expect(second.value.read).toBeNull();
});
