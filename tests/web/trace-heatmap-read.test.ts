import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ answer: null as unknown }));
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
import { useProjectHeatmap } from '@/data/trace';

const heatmap = { days: ['2026-11-14'], lanes: [], commits: [], merges: [] };
async function read(projectId: string) {
  const h = mount(() => useProjectHeatmap(projectId, '7'));
  await h.flush();
  return h.value;
}

beforeEach(() => {
  vi.stubGlobal('window', {
    pantheon: { query: async () => ({ ok: true, value: mock.answer }) },
    addEventListener() {},
    removeEventListener() {},
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

it('takes a heatmap read with its merges', async () => {
  mock.answer = heatmap;
  expect((await read('project-a')).data).toEqual(heatmap);
});

it('takes a heatmap read without merges as incomplete', async () => {
  const { merges: _, ...rest } = heatmap;
  mock.answer = rest;
  const state = await read('project-b');
  expect(state.data).toBeNull();
  expect(state.error).toContain('project.heatmap');
});
