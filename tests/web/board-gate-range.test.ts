import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@/i18n';
import { mount, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  reads: [] as { method: string; key: string; params: Record<string, string> }[],
  data: new Map<string, unknown>(),
}));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => {
  const state = () => ({ events: [] });
  return { useBoard: Object.assign((selector: any) => selector(state()), { getState: state }) };
});
vi.mock('@/store', () => ({ useShell: (selector: any) => selector({ openSession() {} }) }));
vi.mock('@/data/workbench-sessions', async (actual) => ({
  ...(await actual<object>()),
  useQuery: (method: string, key: string, params: (key: string) => Record<string, string>) => {
    mock.reads.push({ method, key, params: params(key) });
    const data = mock.data.get(key) ?? null;
    return { data, loading: data === null, error: null, reload() {} };
  },
}));
import { GateFailuresPanel, GateHistoryPanel } from '@/screens/board/QualityCharts';

beforeEach(() => {
  mock.reads = [];
  mock.data = new Map();
});
afterEach(() => {
  unmountAll();
});
// The failed steps panel's heading count, drawn from the element the read returns.
const heading = (element: any) => text(element.type(element.props).props.num);
const rangeRuns = (range: string, count: number) =>
  t({ id: 'insights.gateFailures.rangeRuns', defaultMessage: '' }, { range, count });

const failed = (id: string) => ({
  run_id: id,
  commit: `${id}0123456789`,
  started_at: '2026-11-03T10:00:00.000Z',
  finished_at: '2026-11-03T10:01:00.000Z',
  results: [{ name: 'test', command: ['pnpm', 'test'], exit_code: 1 }],
  session_id: `session-${id}`,
});

describe('gate runs of the range', () => {
  it('reads the gate runs started since the start of the range, up to 500 of them', () => {
    const since = new Date(2026, 10, 3).getTime();
    mount(() => GateHistoryPanel({ projectId: 'project-a', since }));
    mount(() => GateFailuresPanel({ projectId: 'project-a', since, range: '30 天' }));
    expect(mock.reads.map((r) => [r.method, r.params])).toEqual([
      ['project.gates.history', { project_id: 'project-a', since: String(since), limit: '500' }],
      ['project.gates.history', { project_id: 'project-a', since: String(since), limit: '500' }],
    ]);
    expect(new Set(mock.reads.map((r) => r.key)).size).toBe(1);
  });

  it('names the range and counts every run read in the failed steps heading', () => {
    mock.data.set('project-a:0', [failed('a'), failed('b'), failed('c')]);
    const h = mount(() => GateFailuresPanel({ projectId: 'project-a', since: 0, range: '30 天' }));
    expect(heading(h.value)).toBe(rangeRuns('30 天', 3));
  });

  it("keeps the last range's runs on screen while another range of the same project is read", () => {
    mock.data.set('project-a:0', [failed('a'), failed('b')]);
    let since = 0;
    const h = mount(() => GateFailuresPanel({ projectId: 'project-a', since, range: '7 天' }));
    since = 100;
    h.render();
    expect(mock.reads.at(-1)!.params.since).toBe('100');
    expect(heading(h.value)).toBe(rangeRuns('7 天', 2));
  });

  it("names the last range beside its held runs until the new range's runs are read", () => {
    mock.data.set('project-a:0', [failed('a'), failed('b')]);
    let props = { projectId: 'project-a', since: 0, range: '7 天' };
    const h = mount(() => GateFailuresPanel(props));
    props = { ...props, since: 100, range: '30 天' };
    h.render();
    expect(heading(h.value)).toBe(rangeRuns('7 天', 2));
    mock.data.set('project-a:100', [failed('c')]);
    h.render();
    expect(heading(h.value)).toBe(rangeRuns('30 天', 1));
  });
});
