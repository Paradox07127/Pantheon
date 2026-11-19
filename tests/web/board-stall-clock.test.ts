import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { HookHost, nodes } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
import { TaskList } from '@/screens/board/TaskList';

const MIN = 60_000;

/** Whether the row of the task wears the stuck chip. */
const stuck = (tree: ReactNode, key: string) =>
  nodes(nodes(tree).find((n) => n.props.role === 'row' && n.key === key)).some(
    (n) => n.props.className === 'chip btk-stk',
  );

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('marks a running task as stuck once time passes, without a new board read', () => {
  const now = Date.now();
  const model = {
    now,
    needs: [],
    tasks: [
      {
        id: 'slow',
        title: 'slow task',
        state: 'running',
        status: 'running',
        blocked_since: null,
        turn_running: true,
        last_progress_at: now - 9 * MIN,
        started_at: null,
        ended_at: null,
        additions: null,
        deletions: null,
        checks: 'none',
      },
    ],
  } as unknown as BoardModel;
  const host = new HookHost(() => TaskList({ model, onOpenTask() {}, bar: null }));
  expect(stuck(host.render(), 'slow')).toBe(false);
  vi.advanceTimersByTime(2 * MIN);
  expect(stuck(host.render(), 'slow')).toBe(true);
});
