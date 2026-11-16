import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ asked: [] as unknown[] }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => {
  const state = {
    board: null,
    events: [],
    status: { state: 'live' },
    resync: 0,
    trace_revision: 0,
  };
  return { useBoard: Object.assign((selector: any) => selector(state), { getState: () => state }) };
});
import { useTraceTime } from '@/data/trace';

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 10, 16, 12);

beforeEach(() => {
  mock.asked = [];
  vi.stubGlobal('window', {
    pantheon: {
      query: async (method: string, params: unknown) => {
        mock.asked.push([method, params]);
        return { ok: true, value: { wall: [], work: [] } };
      },
    },
    addEventListener() {},
    removeEventListener() {},
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

it('reads the project time breakdown of a window running up to now again each minute', async () => {
  let now = NOW;
  const h = mount(() =>
    useTraceTime('project-a', undefined, { from: NOW - 60 * MINUTE, to: null }, now),
  );
  await h.flush();
  expect(mock.asked).toHaveLength(1);
  now += MINUTE;
  h.render();
  await h.flush();
  expect(mock.asked).toHaveLength(2);
});

it('leaves a closed window as read', async () => {
  let now = NOW;
  const h = mount(() =>
    useTraceTime('project-b', undefined, { from: NOW - 60 * MINUTE, to: NOW - MINUTE }, now),
  );
  await h.flush();
  now += MINUTE;
  h.render();
  await h.flush();
  expect(mock.asked).toHaveLength(1);
});
