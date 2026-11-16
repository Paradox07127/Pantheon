import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  events: [] as { sequence: number; kind: string }[],
  ticks: new Map<string, number>(),
}));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => {
  const state = () => ({ events: mock.events });
  return { useBoard: Object.assign((selector: any) => selector(state()), { getState: state }) };
});
vi.mock('@/data/workbench-sessions', async (actual) => ({
  ...(await actual<object>()),
  useQuery: (method: string, _key: string, _params: unknown, _accept: unknown, tick: number) => {
    mock.ticks.set(method, tick);
    return { data: null, loading: true, error: null, reload() {} };
  },
}));
vi.mock('@/store', () => ({ useShell: (selector: any) => selector({ openSession() {} }) }));
import { GateHistoryPanel, ReviewMatrixPanel } from '@/screens/board/QualityCharts';
import { RoleUsagePanel } from '@/screens/board/UsageCharts';

beforeEach(() => {
  vi.useFakeTimers();
  mock.events = [];
  mock.ticks.clear();
});
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
});

const panels = [
  ['gate history', GateHistoryPanel, 'project.gates.history', 'session.gate_checked'],
  ['review matrix', ReviewMatrixPanel, 'project.review.metrics', 'review.finding_resolved'],
  ['role usage', RoleUsagePanel, 'project.usage.read', 'turn.completed'],
] as const;

describe('board panels that read their own queries', () => {
  for (const [name, Panel, method, kind] of panels)
    it(`reads the ${name} again after a ${kind} event, not after an unrelated one`, () => {
      const h = mount(() => Panel({ projectId: 'project-a', since: 0 }));
      const before = mock.ticks.get(method);

      mock.events = [{ sequence: 4, kind: 'agent.message.delta' }];
      h.render();
      vi.advanceTimersByTime(5000);
      h.render();
      expect(mock.ticks.get(method)).toBe(before);

      mock.events = [...mock.events, { sequence: 5, kind }];
      h.render();
      vi.advanceTimersByTime(5000);
      h.render();
      expect(mock.ticks.get(method)).not.toBe(before);
    });
});
