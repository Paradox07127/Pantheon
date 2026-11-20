import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from './i18n-setup.js';
import { mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  reads: [] as { method: string; params: Record<string, string> }[],
  model: null as unknown,
  read: {
    error: null as string | null,
    stale: false,
    readAt: null as number | null,
  } as { error: string | null; stale: boolean; readAt: number | null; refreshing?: boolean },
  reload() {},
}));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => {
  const state = () => ({ events: [], resync: 0, status: { state: 'live' }, board: null });
  return { useBoard: Object.assign((selector: any) => selector(state()), { getState: state }) };
});
vi.mock('@/store', () => ({
  useShell: (selector: any) => selector({ openSession() {}, openTaskSession() {} }),
}));
vi.mock('@/data/workbench-sessions', async (actual) => ({
  ...(await actual<object>()),
  useQuery: (
    method: string,
    key: string | null,
    params: (key: string) => Record<string, string>,
  ) => {
    if (key) mock.reads.push({ method, params: params(key) });
    const data = method === 'board.view' && key ? mock.model : null;
    const { error, stale, readAt, refreshing } = mock.read;
    return {
      data,
      loading: data === null && !error,
      refreshing,
      error,
      stale,
      readAt,
      reload: mock.reload,
    };
  },
}));
vi.mock('@/data/project-defaults', async (actual) => ({
  ...(await actual<object>()),
  useProjectDefaults: () => ({ data: null, loading: false, error: null, reload() {} }),
  useLastProjectDefaults: () => null,
}));
import { RANGES } from '@/screens/board/BoardScreen';
import { InsightsScreen } from '@/screens/insights/InsightsScreen';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 11, 15));
  mock.reads = [];
});
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const boardReads = () => mock.reads.filter((r) => r.method === 'board.view').map((r) => r.params);

describe('engineering board range', () => {
  it('offers today, 7 days, 30 days and all, and reads the board of the picked one', () => {
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
    expect(RANGES.map((r) => [r.days, r.label])).toEqual([
      [1, zh('board.ranges.today')],
      [7, '7 天'],
      [30, '30 天'],
      ['all', zh('board.ranges.all')],
    ]);
    const h = mount(() => InsightsScreen({ projectId: 'range-project', onOpenSession() {} }));
    expect(boardReads().at(-1)).toEqual({ project_id: 'range-project', days: '7' });
    h.value.props.onDays('all');
    h.render();
    expect(boardReads().at(-1)).toEqual({ project_id: 'range-project', days: 'all' });
    h.value.props.onDays(30);
    h.render();
    expect(boardReads().at(-1)).toEqual({ project_id: 'range-project', days: '30' });
  });
});
