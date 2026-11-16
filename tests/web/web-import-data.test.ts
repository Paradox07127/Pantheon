import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { useImportCandidates } from '@/data/import';

beforeEach(() => {
  vi.useFakeTimers();
  mock.board = { status: { state: 'live' }, resync: 0 };
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('import candidates read', () => {
  it('reads again every two seconds while indexing, and stops once it is done', async () => {
    const answers = [
      { indexing: { done_files: 1, total_files: 4 }, candidates: [] },
      { indexing: { done_files: 3, total_files: 4 }, candidates: [] },
      { indexing: null, candidates: [] },
    ];
    const query = vi.fn(async () => ({ ok: true as const, value: answers.shift() ?? null }));
    vi.stubGlobal('window', { pantheon: { query } });
    const h = mount(() => useImportCandidates());
    await h.flush();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenLastCalledWith('import.candidates', {});
    expect(h.value.data?.indexing).toEqual({ done_files: 1, total_files: 4 });

    vi.advanceTimersByTime(2_000);
    await h.flush();
    expect(query).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2_000);
    await h.flush();
    expect(query).toHaveBeenCalledTimes(3);
    expect(h.value.data?.indexing).toBeNull();

    vi.advanceTimersByTime(10_000);
    await h.flush();
    expect(query).toHaveBeenCalledTimes(3);
  });
});
