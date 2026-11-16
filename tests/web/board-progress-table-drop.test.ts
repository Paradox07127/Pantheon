import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardModel } from '@pantheon/protocol';
import { find, unmountAll, mount } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/screens/board/Charts', async (actual) => ({
  ...(await actual<object>()),
  useSize: () => [() => {}, { w: 850, h: 0 }],
}));
const { runCommand } = vi.hoisted(() => ({
  runCommand: vi.fn(async () => ({ ok: true, value: { applied: true } })),
}));
vi.mock('@/data/commands', () => ({ runCommand }));
import { ProgressTable } from '@/screens/board/ProgressTable';

const NOW = new Date(2026, 10, 3, 0, 48).getTime();

const planTask = (id: string, order: number, patch: object = {}) => ({
  id: `lead-1:${id}`,
  title: `task ${id}`,
  goal: '',
  scope: [],
  lane_id: null,
  milestone_id: null,
  status: 'ready',
  blockers: [],
  segments: [],
  additions: null,
  deletions: null,
  checks: 'none',
  started_at: null,
  ended_at: null,
  owner_session_id: 'lead-1',
  order,
  ...patch,
});
const model = {
  since: new Date(2026, 9, 28).getTime(),
  now: NOW,
  counts: { median_ms: null },
  lanes: [],
  tasks: [planTask('a', 0, { order_locked: true }), planTask('b', 1)],
} as unknown as BoardModel;

afterEach(() => unmountAll());

describe('progress table drops', () => {
  it('moves a task next to a locked row it is dropped on', async () => {
    const h = mount(() => ProgressTable({ model, onOpenTask() {}, projectId: 'project-a' }));
    const row = (title: string) =>
      find(h.value, (n) => n.props.role === 'row' && n.props['aria-label']?.startsWith(title));
    const event = () => ({
      preventDefault: vi.fn(),
      dataTransfer: { setData() {}, effectAllowed: '', dropEffect: '' },
    });
    row('task b').props.onDragStart(event());
    h.render();
    const over = event();
    row('task a').props.onDragOver?.(over);
    expect(over.preventDefault).toHaveBeenCalled();
    h.render();
    row('task a').props.onDrop(event());
    await h.flush();
    expect(runCommand).toHaveBeenCalledWith(
      'board.plan.edit',
      {
        project_id: 'project-a',
        lead_session_id: 'lead-1',
        base_version: 0,
        ops: [{ type: 'move_task', task_id: 'b', before: 'a' }],
      },
      null,
    );
    expect(row('task a').props.draggable).toBeUndefined();
  });
});
