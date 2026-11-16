import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { HookHost } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
import { StallPanel } from '@/screens/board/ProgressCharts';

const MIN = 60_000;

/** Whether the element tree holds an element whose `key` names the task. */
const holdsRow = (node: unknown, key: string): boolean => {
  if (Array.isArray(node)) return node.some((child) => holdsRow(child, key));
  if (!node || typeof node !== 'object') return false;
  const element = node as ReactElement<{ children?: unknown }>;
  return element.key === key || holdsRow(element.props?.children, key);
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('lists a running task as stalled once time passes, without a new board read', () => {
  const now = Date.now();
  const model = {
    now,
    tasks: [
      {
        id: 'slow',
        title: 'slow task',
        status: 'running',
        blocked_since: null,
        turn_running: true,
        last_progress_at: now - 9 * MIN,
      },
    ],
  } as unknown as BoardModel;
  const host = new HookHost(() => StallPanel({ model, onOpenTask() {} }));
  expect(holdsRow(host.render(), 'slow')).toBe(false);
  vi.advanceTimersByTime(2 * MIN);
  expect(holdsRow(host.render(), 'slow')).toBe(true);
});
