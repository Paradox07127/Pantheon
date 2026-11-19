import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BoardModel } from '@pantheon/protocol';
import { HookHost, find, nodes } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
import { TaskList } from '@/screens/board/TaskList';
import { zh, zhf } from './i18n-setup.js';

const MIN = 60_000;
const NOW = new Date(2026, 10, 3, 12).getTime();

const row = (id: string, status: string, started_at: number, ended_at: number | null) => ({
  id,
  title: id,
  goal: '',
  scope: [],
  lane_id: null,
  milestone_id: null,
  status,
  blockers: [],
  segments: [],
  additions: null,
  deletions: null,
  checks: 'none',
  started_at,
  ended_at,
  blocked_since: null,
  last_progress_at: null,
  turn_running: false,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('sorts the task list by duration on the local clock when the board was read earlier', () => {
  const model = {
    now: NOW,
    needs: [],
    tasks: [
      row('running-task', 'running', NOW - 30 * MIN, null),
      row('finished-task', 'done', NOW - 100 * MIN, NOW - 55 * MIN),
    ],
  } as unknown as BoardModel;
  vi.setSystemTime(NOW + 20 * MIN);
  const host = new HookHost(() => TaskList({ model, onOpenTask() {}, bar: null }));
  find(
    host.render(),
    (n) =>
      n.props['aria-label'] ===
      zhf('board.tasks.list.sortBy', { column: zh('board.tasks.list.columns.time') }),
  ).props.onClick();
  const order = nodes(host.render())
    .filter((n) => n.props.role === 'row' && n.props['aria-label'])
    .map((n) => n.key);
  expect(order).toEqual(['finished-task', 'running-task']);
});
