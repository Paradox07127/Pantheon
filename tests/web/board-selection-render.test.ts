import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { BoardModel } from '@pantheon/protocol';

// Each stub counts its renders and keeps the props it was last given.
const { seen, stub } = vi.hoisted(() => {
  const seen = { renders: {} as Record<string, number>, props: {} as Record<string, any> };
  const stub = (name: string) => (props: object) => {
    seen.renders[name] = (seen.renders[name] ?? 0) + 1;
    seen.props[name] = props;
    return null;
  };
  return { seen, stub };
});
vi.mock('@/components/TopBar', () => ({ TopBar: () => null }));
vi.mock('@/components/ReadStatus', () => ({ ReadStatus: () => null }));
vi.mock('@/screens/board/BriefCard', async (actual) => ({
  ...(await actual<object>()),
  BriefCard: () => null,
}));
vi.mock('@/screens/board/ProgressCharts', async (actual) => ({
  ...(await actual<object>()),
  TaskProgressStrip: () => null,
}));
vi.mock('@/screens/board/GoalsSection', async (actual) => ({
  ...(await actual<object>()),
  GoalsHead: () => null,
  GoalsSection: stub('GoalsSection'),
}));
vi.mock('@/screens/board/TaskList', async (actual) => ({
  ...(await actual<object>()),
  TaskList: stub('TaskList'),
}));
vi.mock('@/screens/board/TaskDrawer', async (actual) => ({
  ...(await actual<object>()),
  TaskDrawer: stub('TaskDrawer'),
}));

import { act, createElement } from 'react';
import { pickTaskView } from '@/data/board-page';
import { BoardView } from '@/screens/board/BoardScreen';
import { FakeDocument } from './web-fake-dom.js';

const NOW = Date.UTC(2026, 10, 3, 12);
const noop = () => {};

const task = (id: string): BoardModel['tasks'][number] => ({
  id,
  title: `task ${id}`,
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
});

const model: BoardModel = {
  since: NOW - 7 * 86_400_000,
  now: NOW,
  headline: null,
  counts: {
    running: 3,
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
  tasks: [task('a'), task('b'), task('c')],
  edges: [],
  milestones: [],
  burnup: [],
  goals: [],
  task_progress: {
    totals: {
      done: 0,
      running: 3,
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

const doc = new FakeDocument();
const win = {
  document: doc,
  HTMLIFrameElement: class {},
  innerWidth: 1440,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  addEventListener() {},
  removeEventListener() {},
};
doc.defaultView = win;
let root: { render: (node: ReactNode) => void; unmount: () => void };

beforeAll(async () => {
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const { createRoot } = await import('react-dom/client');
  root = createRoot(container as never);
});

afterAll(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

const show = (projectId: string, page: 'overview' | 'tasks') =>
  act(() =>
    root.render(
      createElement(BoardView, {
        model,
        loading: false,
        error: null,
        onRetry: noop,
        page,
        onPage: noop,
        projectId,
        onOpenSession: noop,
        onOpenStory: noop,
        onOpenTrace: noop,
      }),
    ),
  );

describe('picking a task re-renders only what shows the pick', () => {
  it.each([
    { page: 'overview' as const, panel: 'GoalsSection' },
    { page: 'tasks' as const, panel: 'TaskList' },
  ])(
    'leaves the $panel of the $page page alone while the drawer opens, switches and closes',
    async ({ page, panel }) => {
      const projectId = `selection-${page}`;
      pickTaskView(projectId, 'list');
      await show(projectId, page);
      const before = seen.renders[panel]!;
      expect(before).toBeGreaterThan(0);
      const steps: [string | null, () => void][] = [
        ['a', () => seen.props[panel].onOpenTask('a')],
        ['b', () => seen.props[panel].onOpenTask('b')],
        [null, () => seen.props.TaskDrawer.onSelect(null)],
      ];
      for (const [shown, pick] of steps) {
        await act(pick);
        expect(seen.props.TaskDrawer.taskId).toBe(shown);
        expect(seen.renders[panel]).toBe(before);
      }
    },
  );
});
