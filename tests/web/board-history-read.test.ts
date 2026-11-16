import { describe, expect, it, vi } from 'vitest';
import type { BoardHistory } from '@pantheon/protocol';
import { find, nodes } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ read: null as unknown }));
vi.mock('@/data/board-history', () => ({ useBoardHistory: () => mock.read }));
import { Failure, HistoryTab } from '@/screens/board/BoardScreen';
import { HistoryView } from '@/screens/board/HistoryView';

const noop = () => {};
const history: BoardHistory = {
  started_at: 0,
  truncated: false,
  tasks: [],
  days: [],
  decisions: [],
  milestones: [{ id: 'm1', title: 'first', reached_at: null } as never],
  idle: [],
};
const tab = () =>
  HistoryTab({
    projectId: 'project-a',
    empty: null,
    lanes: [],
    now: 0,
    milestones: [],
    onOpenSession: noop,
    onOpenTask: noop,
    bar: null,
  });

describe('whole history read', () => {
  it('keeps the history it read under a failure line with Retry when a later read fails', () => {
    const reload = vi.fn();
    mock.read = { data: history, error: 'socket closed', loading: false, reload, readAt: 1 };
    const tree = tab();
    expect(nodes(tree).some((n) => n.type === HistoryView)).toBe(true);
    const line = find(tree, (n) => n.type === Failure);
    expect(line.props.error).toBe('socket closed');
    line.props.onRetry();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('shows no failure line while the history read holds', () => {
    mock.read = { data: history, error: null, loading: false, reload: noop, readAt: 1 };
    expect(nodes(tab()).some((n) => n.type === Failure)).toBe(false);
  });
});
