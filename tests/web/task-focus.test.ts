import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { Review } from '@pantheon/domain';
import type { BoardModel } from '@pantheon/protocol';
import { ReadStatus } from '@/components/ReadStatus';
import { ReviewCoverage } from '@/components/ReviewCoverage';
import { TaskFocus } from '@/screens/board/TaskFocus';
import { taskFocus } from '@/screens/board/task-focus';
import { find, nodes, text } from './web-hook-host.js';
import { zh } from './i18n-setup.js';

type Task = BoardModel['tasks'][number];
const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: id,
  goal: '',
  scope: [],
  status: 'todo',
  lane_id: null,
  milestone_id: null,
  blockers: [],
  segments: [],
  checks: 'none',
  additions: null,
  deletions: null,
  started_at: null,
  ended_at: null,
  blocked_since: null,
  last_progress_at: null,
  turn_running: false,
  ...extra,
});
const board = (tasks: Task[], extra: Partial<BoardModel> = {}) =>
  ({
    tasks,
    edges: [],
    merges: [],
    needs: [],
    ...extra,
  }) as unknown as BoardModel;
const review: Pick<Review, 'id' | 'state' | 'executions' | 'range'> = {
  id: 'review-1',
  state: 'completed',
  executions: [
    { runtime: 'claude', state: 'completed' },
    { runtime: 'codex', state: 'failed', error: 'Reviewer unavailable' },
  ],
  range: { source: '/work', from_sha: '1111111111', to_sha: '2222222222' },
};

it('prioritizes actionable needs and preserves an explicitly selected task', () => {
  const model = board([task('failed', { status: 'failed' }), task('ask', { status: 'waiting' })], {
    needs: [
      {
        task_id: 'ask',
        reason: 'permission_requested',
        source: { table: 'approvals', id: 'a', revision: 1 },
        next_step: '回答具体请求',
      } as any,
    ],
  });
  expect(taskFocus(model, null)).toMatchObject({
    task: { id: 'ask' },
    next: expect.stringContaining('lead 自己的权限请求'),
  });
  expect(taskFocus(model, 'failed')?.task.id).toBe('failed');
});

it('links a blocked task to its unmet upstream and uses its recorded dispatch reason', () => {
  const model = board([task('up'), task('down', { blockers: ['并发容量已满'] })], {
    edges: [{ from: 'up', to: 'down', state: 'pending' }],
  });
  const select = vi.fn();
  const tree = TaskFocus({ model, selected: 'down', onSelect: select, onOpenSession() {} });
  expect(text(tree)).toContain('并发容量已满');
  find(
    tree,
    (node) => node.type === 'button' && text(node) === zh('board.task.focus.openUpstream'),
  ).props.onClick();
  expect(select).toHaveBeenCalledWith('up');
});

it('focuses the latest delivery evidence once all tasks end and keeps manual selection authoritative', () => {
  const model = board([
    task('earlier', { status: 'done', ended_at: 100 }),
    task('latest', {
      status: 'done',
      ended_at: 200,
      evidence: { session_id: 'latest-worker', review },
    }),
  ]);
  expect(taskFocus(model, null)).toMatchObject({
    task: { id: 'latest' },
    sessionId: 'latest-worker',
  });
  expect(taskFocus(model, 'earlier')?.task.id).toBe('earlier');
  expect(taskFocus(board([]), null)).toBeNull();
});

it('keeps evidence on the newest attempt and opens the exact evidence tab', () => {
  const model = board([
    task('work', {
      status: 'ready',
      evidence: {
        session_id: 'retry-session',
        gate: { state: 'stale', passed: 0, failed: 0, running: 0 },
        review,
      },
    }),
  ]);
  const open = vi.fn();
  const tree = TaskFocus({
    model,
    selected: 'work',
    onSelect() {},
    onOpenSession() {},
    onOpenEvidence: open,
  });
  expect(text(tree)).toContain(zh('board.task.focus.gateStale'));
  find(
    tree,
    (node) => node.type === 'button' && text(node) === zh('board.task.focus.viewReview'),
  ).props.onClick();
  expect(open).toHaveBeenCalledWith('retry-session', 'review');
  const html = renderToStaticMarkup(
    createElement(TaskFocus, { model, selected: 'work', onSelect() {}, onOpenSession() {} }),
  );
  expect(html).toContain(zh('components.reviewCoverage.partlyFailed'));
  expect(html).toContain('1 / 2 位完成');
  expect(html).not.toContain('已验收');
});

it('reports absent evidence explicitly and does not offer a start while dispatch is queued', () => {
  const tree = TaskFocus({
    model: board([
      task('queued', { activity: { phase: 'queued', health: 'fresh', since: 0, attempt: 1 } }),
    ]),
    selected: null,
    onSelect() {},
    onOpenSession() {},
    onStartTask() {},
  });
  expect(text(tree)).toContain(zh('board.task.focus.noGate'));
  expect(text(tree)).toContain(zh('board.task.focus.noReview'));
  expect(() =>
    find(tree, (node) => node.type === 'button' && text(node) === zh('board.task.focus.nextStart')),
  ).toThrow();
});

const LINKS = ['viewGates', 'viewReview', 'viewStory'].map((id) => zh(`board.task.focus.${id}`));
it.each<[string, Partial<Task>, string[]]>([
  [
    'offers no evidence link before there is any evidence',
    { status: 'running', evidence: { session_id: 'worker' } },
    [],
  ],
  [
    'links the gates once checks ran',
    { status: 'running', checks: 'pass', evidence: { session_id: 'worker' } },
    [LINKS[0]!],
  ],
  [
    'links the review and the change evidence once a review and a diff exist',
    { status: 'ready', additions: 3, deletions: 1, evidence: { session_id: 'worker', review } },
    [LINKS[1]!, LINKS[2]!],
  ],
])('%s', (_, extra, links) => {
  const tree = TaskFocus({
    model: board([task('work', extra)]),
    selected: 'work',
    onSelect() {},
    onOpenSession() {},
  });
  expect(
    nodes(tree)
      .filter((node) => node.type === 'button' && LINKS.includes(text(node)))
      .map(text),
  ).toEqual(links);
});

const times = (said: string, phrase: string) => said.split(phrase).length - 1;
it.each<[string, Task[], string, number]>([
  [
    'drops the next step that the open-session button already says',
    [task('ask', { status: 'waiting', evidence: { session_id: 'worker' } })],
    zh('board.task.focus.nextWaiting'),
    0,
  ],
  [
    'says starting the task once, on its button',
    [task('new')],
    zh('board.task.focus.nextStart'),
    1,
  ],
  [
    'keeps the next step that names the dependency the button does not',
    [task('up'), task('down')],
    zh('board.task.focus.nextUpstream').replace('{title}', 'up'),
    1,
  ],
])('%s', (_, tasks, phrase, count) => {
  const tree = TaskFocus({
    model: board(tasks, { edges: [{ from: 'up', to: 'down', state: 'pending' }] }),
    selected: tasks.at(-1)!.id,
    onSelect() {},
    onOpenSession() {},
    onStartTask() {},
  });
  expect(times(text(tree), phrase)).toBe(count);
});

it('renders partial reviewer failure, cancellation, missing coverage and frozen range truthfully', () => {
  const html = renderToStaticMarkup(createElement(ReviewCoverage, { review }));
  expect(html).toContain(zh('components.reviewCoverage.partlyFailed'));
  expect(html).toContain('Reviewer unavailable');
  expect(html).toContain('11111111…22222222');
  expect(html).toContain(zh('components.reviewCoverage.unfinishedNote'));
  const unknown = renderToStaticMarkup(
    createElement(ReviewCoverage, {
      review: {
        ...review,
        executions: [{ runtime: 'codex', state: 'unknown' }],
      },
    }),
  );
  expect(unknown).toContain(zh('components.reviewCoverage.incomplete'));
  const cancelled = renderToStaticMarkup(
    createElement(ReviewCoverage, {
      review: {
        ...review,
        state: 'failed',
        executions: [{ runtime: 'codex', state: 'cancelled' }],
      },
    }),
  );
  expect(cancelled).toContain(zh('components.reviewCoverage.cancelled'));
});

it('shows read failure, retained timestamp and retry without presenting it as loading', () => {
  const reload = vi.fn();
  const tree = ReadStatus({
    label: 'Trace',
    stale: true,
    error: 'transport unavailable',
    readAt: 123456,
    reload,
  });
  expect(text(tree)).toContain('Trace读取失败');
  expect(text(tree)).toContain(zh('components.readStatus.stale'));
  expect(find(tree, (node) => node.type === 'time').props.dateTime).toBe(
    new Date(123456).toISOString(),
  );
  find(tree, (node) => node.type === 'button').props.onClick();
  expect(reload).toHaveBeenCalledOnce();
});
