import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { find, mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  events: [] as { sequence: number; kind: string }[],
  ticks: [] as number[],
}));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => {
  const state = () => ({ events: mock.events });
  return { useBoard: Object.assign((selector: any) => selector(state()), { getState: state }) };
});
vi.mock('@/data/workbench-sessions', async (actual) => ({
  ...(await actual<object>()),
  useQuery: (_method: string, _key: string, _params: unknown, _accept: unknown, tick: number) => {
    mock.ticks.push(tick);
    return { data: null, loading: true, error: null, reload() {} };
  },
}));
import { GateHistoryPanel, ReviewMatrixPanel } from '@/screens/board/QualityCharts';
import { QueryBody } from '@/screens/board/Tables';

beforeEach(() => {
  mock.events = [];
  mock.ticks = [];
});
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
});

describe('quality panels refresh', () => {
  it.each([
    ['review matrix', () => ReviewMatrixPanel({ projectId: 'project-a' })],
    ['gate history', () => GateHistoryPanel({ projectId: 'project-a', since: 0 })],
  ])('reads the %s again after a session is deleted', (_name, panel) => {
    vi.useFakeTimers();
    const h = mount(panel);
    const before = mock.ticks.at(-1);
    mock.events = [{ sequence: 5, kind: 'session.deleted' }];
    h.render();
    vi.advanceTimersByTime(5000);
    h.render();
    expect(mock.ticks.at(-1)).not.toBe(before);
  });
});

describe('query body', () => {
  it('shows data that is falsy but present instead of the skeleton', () => {
    const body = QueryBody<number>({
      query: { data: 0, loading: false, error: null, reload() {} },
      children: (n) => `count ${n}`,
    });
    expect(body).toBe('count 0');
  });

  it('shows the skeleton while there is no data', () => {
    const body = QueryBody<number>({
      query: { data: null, loading: true, error: null, reload() {} },
      children: (n) => `count ${n}`,
    });
    find(body as never, (n) => n.props['aria-busy'] === 'true');
  });
});
