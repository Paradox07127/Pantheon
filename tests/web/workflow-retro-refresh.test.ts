import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  events: [] as { sequence: number; kind: string; project_id: string; payload: unknown }[],
  ticks: [] as number[],
}));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => {
  const state = () => ({ events: mock.events, changed: 0 });
  return { useBoard: Object.assign((selector: any) => selector(state()), { getState: state }) };
});
vi.mock('@/data/workbench-sessions', async (actual) => ({
  ...(await actual<object>()),
  useQuery: (_method: string, _key: string, _params: unknown, _accept: unknown, tick: number) => {
    mock.ticks.push(tick);
    return { data: null, loading: true, error: null, reload() {} };
  },
}));
import { useTaskRetrospectives } from '@/data/workflow-policy';

beforeEach(() => {
  mock.events = [];
  mock.ticks = [];
});
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
});

const recorded = (sequence: number, project_id: string, task_id: string) => ({
  sequence,
  kind: 'retrospective.recorded',
  project_id,
  payload: { retrospective_id: 'retro-a', project_id, task_id },
});

describe('task retrospectives refresh', () => {
  it("reads the task's retrospectives again after one of them is recorded again", () => {
    vi.useFakeTimers();
    const h = mount(() => useTaskRetrospectives({ project_id: 'project-a', task_id: 'task-a' }));
    const before = mock.ticks.at(-1);
    mock.events = [recorded(7, 'project-a', 'task-a')];
    h.render();
    vi.advanceTimersByTime(5000);
    h.render();
    expect(mock.ticks.at(-1)).not.toBe(before);
  });

  it("does not read again for another task's or another project's retrospective", () => {
    vi.useFakeTimers();
    const h = mount(() => useTaskRetrospectives({ project_id: 'project-a', task_id: 'task-a' }));
    const before = mock.ticks.at(-1);
    mock.events = [recorded(7, 'project-a', 'task-b'), recorded(8, 'project-b', 'task-a')];
    h.render();
    vi.advanceTimersByTime(5000);
    h.render();
    expect(mock.ticks.at(-1)).toBe(before);
  });
});
