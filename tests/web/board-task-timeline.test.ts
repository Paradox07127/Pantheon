import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { BoardModel, ProjectTimeline } from '@pantheon/protocol';
import { HookHost, find, nodes, text } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ timeline: null as ProjectTimeline | null }));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('@/data/trace', () => ({ useProjectTimeline: () => ({ data: mock.timeline }) }));
vi.mock('@/data/board-history', () => ({ useBoardHistory: () => ({ data: null }) }));
import { TaskTimelineView } from '@/screens/board/TaskTimelineView';
import { durationText } from '@/lib/time-text';
import { dayText } from '@/lib/time-text';
import { zh, zhf } from './i18n-setup.js';

type Task = BoardModel['tasks'][number];
const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = new Date(2026, 10, 18, 15, 20).getTime();

const task = (id: string, spans: [number, number | null, string?][], extra: Partial<Task> = {}) =>
  ({
    id,
    title: id,
    state: 'merged',
    status: 'done',
    segments: spans.map(([started_at, ended_at, session], i) => ({
      id: `${id}-${i}`,
      session_id: session ?? `${id}-session-${i}`,
      title: id,
      runtime: 'claude',
      model: null,
      status: 'done',
      started_at,
      ended_at,
      tokens: 1000,
    })),
    ...extra,
  }) as Task;

const draw = (tasks: Task[]) =>
  new HookHost(() => TaskTimelineView({ model: { tasks, now: NOW }, projectId: 'project-a' }));
const lanes = (tree: ReactNode) => nodes(tree).filter((n) => n.props.className === 'btt-lane');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mock.timeline = null;
});
afterEach(() => vi.useRealTimers());

describe('task timeline', () => {
  it('draws one lane per started task it is given', () => {
    const tree = draw([
      task('early', [[NOW - 3 * HOUR, NOW - 2 * HOUR]]),
      task('late', [[NOW - HOUR, null]], { state: 'running', status: 'running' }),
      task('unstarted', [], { state: 'todo', status: 'todo' }),
    ]).render();
    expect(lanes(tree).map((n) => n.key ?? n.props['aria-label'].split('，')[0])).toEqual([
      'early',
      'late',
    ]);
    expect(lanes(tree).every((n) => n.props.role === 'img')).toBe(true);
  });

  it('cuts a stretch in which no task worked to a break that writes its real length', () => {
    const gapFrom = NOW - 20 * HOUR;
    const gapTo = NOW - 2 * HOUR;
    const tree = draw([
      task('evening', [[NOW - 21 * HOUR, gapFrom]]),
      task('morning', [[gapTo, NOW - HOUR]]),
    ]).render();
    const gaps = nodes(tree).filter((n) => n.props['data-gap'] !== undefined);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.props['data-gap']).toBe(gapTo - gapFrom);
    expect(text(gaps[0]!)).toBe(durationText(18 * HOUR));
    const group = find(tree, (n) => n.props.role === 'group');
    expect(group.props['aria-label']).toContain(
      zhf('board.history.lanes.cut', {
        from: dayText(gapFrom, NOW, { time: true }),
        to: dayText(gapTo, NOW, { time: true }),
        duration: durationText(18 * HOUR),
      }),
    );
    // Cut, the stretch keeps a small share of the axis, so the morning starts left of the middle.
    const morning = lanes(tree)[1]!;
    expect(parseFloat(morning.props.children[0].props.style.left)).toBeLessThan(50);
  });

  it('hatches the stretches a session waited in, and names the wait', () => {
    const start = NOW - HOUR;
    mock.timeline = {
      from: new Date(start).toISOString(),
      to: new Date(NOW).toISOString(),
      sessions: [
        {
          session_id: 'review-session',
          title: 'review',
          runtime: 'claude',
          intervals: [
            {
              state: 'running',
              from: new Date(start).toISOString(),
              to: new Date(NOW - 30 * MIN).toISOString(),
            },
            { state: 'ready', from: new Date(NOW - 30 * MIN).toISOString(), to: null },
          ],
        },
      ],
    };
    const tree = draw([
      task('review', [[start, null, 'review-session']], {
        state: 'awaiting_acceptance',
        status: 'waiting',
      }),
    ]).render();
    const lane = lanes(tree)[0]!;
    expect(
      lane.props.children.map((p: { props: Record<string, unknown> }) => p.props['data-part']),
    ).toEqual(['work', 'wait']);
    expect(lane.props['aria-label']).toContain(
      zhf('board.history.lanes.waited', { duration: durationText(30 * MIN) }),
    );
    expect(text(tree)).toContain(zh('board.history.lanes.waiting'));
  });

  it('draws a lane solid when the session states are not read', () => {
    const tree = draw([task('solo', [[NOW - HOUR, null]])]).render();
    expect(
      lanes(tree)[0]!.props.children.map(
        (p: { props: Record<string, unknown> }) => p.props['data-part'],
      ),
    ).toEqual(['work']);
  });
});
