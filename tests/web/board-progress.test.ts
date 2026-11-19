import { afterEach, expect, it, vi } from 'vitest';
import type { BoardModel } from '@pantheon/protocol';
import { named, nodes, mount, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector({}), { getState: () => ({}) }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector: any) => selector({}), { setState() {} }),
}));
import { pickTaskView, type TaskView } from '@/data/board-page';
import { BoardView } from '@/screens/board/BoardScreen';

const noop = () => {};
afterEach(() => unmountAll());

const model: BoardModel = {
  since: 0,
  now: 0,
  headline: null,
  counts: {
    running: 1,
    waiting: 0,
    ready: 0,
    failed: 0,
    merged: 0,
    reverted: 0,
    median_ms: null,
    tokens: 0,
    tokens_by_runtime: {},
    previous: { tokens: 0, cost_usd: null, merged: 0, median_ms: null },
    cost_usd: null,
  },
  lanes: [],
  tasks: [
    {
      id: 'importer',
      title: 'ship the importer',
      goal: '',
      scope: [],
      lane_id: null,
      milestone_id: null,
      status: 'running',
      blockers: [],
      segments: [],
      additions: null,
      deletions: null,
      checks: 'none',
      started_at: null,
      ended_at: null,
      last_progress_at: null,
      blocked_since: null,
      turn_running: false,
    },
  ],
  edges: [],
  milestones: [],
  burnup: [],
  goals: [],
  task_progress: {
    totals: {
      done: 0,
      running: 0,
      waiting: 0,
      idle: 0,
      ready: 0,
      failed: 0,
      discarded: 0,
      not_started: 0,
    },
    daily: [],
    cycle: { median_ms: null, p90_ms: null, sample_count: 0, buckets: [] },
  },
  usage: [],
  models: [],
  merges: [],
  findings: [],
  risks: [],
};

const board = (view: TaskView = 'list') => {
  pickTaskView('progress-board', view);
  return mount(() =>
    BoardView({
      model,
      loading: false,
      error: null,
      onRetry: noop,
      page: 'tasks',
      onPage: noop,
      projectId: 'progress-board',
      onOpenSession: noop,
      onOpenStory: noop,
      onOpenTrace: noop,
    }),
  );
};
const has = (tree: unknown, name: string) =>
  nodes(tree as any).some((n) => typeof n.type === 'function' && n.type.name === name);

it('shows the task list in the list view of the tasks page, and the flow chart in its flow view', () => {
  const tree = board().value;
  expect(has(tree, 'MainView')).toBe(false);
  expect(has(tree, 'TaskList')).toBe(true);
  expect(has(tree, 'TrendPanel')).toBe(false);
  const flow = board('flow').value;
  expect(has(flow, 'MainView')).toBe(true);
  expect(has(flow, 'TaskList')).toBe(false);
});

it('opens the task drawer of a task picked in the task list', () => {
  const h = board();
  expect(named(h.value, 'TaskDrawer').props.taskId).toBeNull();
  named(h.value, 'TaskList').props.onOpenTask('importer');
  h.render();
  expect(named(h.value, 'TaskDrawer').props.taskId).toBe('importer');
});
