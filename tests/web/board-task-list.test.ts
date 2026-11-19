import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { HookHost, find, nodes, text } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('react-dom', async (actual) => ({
  ...(await actual<object>()),
  createPortal: (node: ReactNode) => node,
}));
import { TaskList } from '@/screens/board/TaskList';
import { durationText } from '@/lib/time-text';
import { zh, zhf } from './i18n-setup.js';

type Task = BoardModel['tasks'][number];
const MIN = 60_000;
const NOW = new Date(2026, 10, 3, 12).getTime();

const task = (id: string, extra: Partial<Task> = {}): Task =>
  ({
    id,
    title: id,
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
    ...extra,
  }) as Task;

const tasks = [
  task('asked', { state: 'running', started_at: NOW - 18 * MIN }),
  task('failing', {
    state: 'failed',
    status: 'failed',
    started_at: NOW - 41 * MIN,
    gate_steps: [
      { name: 'lint', state: 'passed' },
      { name: 'test', state: 'failed' },
      { name: 'build', state: 'passed' },
    ],
    additions: 212,
    deletions: 40,
  }),
  task('working', { state: 'running', started_at: NOW - 12 * MIN }),
  task('blocked', { state: 'todo', status: 'todo', blocked_since: NOW - 30 * MIN }),
  task('done-1', { state: 'merged', status: 'done', started_at: NOW - 60 * MIN, ended_at: NOW }),
  task('done-2', { state: 'merged', status: 'done' }),
  task('loose-session', { status: 'idle' }),
];
const needs = [{ task_id: 'asked' }] as unknown as BoardModel['needs'];

let opened: (string | null)[] = [];
const host = (list: Task[] = tasks) =>
  new HookHost(() =>
    TaskList({
      model: { tasks: list, needs, now: NOW },
      onOpenTask: (id) => opened.push(id),
      bar: {} as HTMLElement,
    }),
  );
const rows = (tree: ReactNode) =>
  nodes(tree).filter((n) => n.props.role === 'row' && n.props['aria-label']);
const rowIds = (tree: ReactNode) => rows(tree).map((n) => n.key);
const labelled = (tree: ReactNode, label: string) =>
  find(tree, (n) => n.props['aria-label'] === label);
const groupOf = (tree: ReactNode, label: string): ReactElement<any> =>
  find(tree, (n) => n.props.role === 'rowgroup' && n.props['aria-label'] === label);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  opened = [];
});
afterEach(() => vi.useRealTimers());

describe('task list', () => {
  it('names the count of each group in the share bar', () => {
    const tree = host().render();
    const bar = find(tree, (n) => n.props.className === 'btk-share');
    expect(bar.props.role).toBe('img');
    expect(bar.props['aria-label']).toBe(
      zhf('board.tasks.list.share', {
        count: 7,
        parts: [
          `${zh('board.task.group.you')} 1`,
          `${zh('board.task.group.blocked')} 1`,
          `${zh('board.task.group.running')} 1`,
          `${zh('board.task.group.todo')} 1`,
          `${zh('board.task.group.merged')} 2`,
          `${zh('board.tasks.list.sessions')} 1`,
        ].join('，'),
      }),
    );
  });

  it('groups the rows by what they wait for, the merged group folded', () => {
    const h = host();
    const tree = h.render();
    const groups = nodes(tree).filter((n) => n.props.role === 'rowgroup');
    expect(groups.map((g) => g.props['aria-label'])).toEqual([
      zh('board.task.group.you'),
      zh('board.task.group.blocked'),
      zh('board.task.group.running'),
      zh('board.task.group.todo'),
      zh('board.task.group.merged'),
      zh('board.tasks.list.sessions'),
    ]);
    expect(groups.map((g) => rows(g).length)).toEqual([1, 1, 1, 1, 0, 1]);
    expect(rowIds(tree)).toEqual(['asked', 'failing', 'working', 'blocked', 'loose-session']);
    const merged = labelled(
      groupOf(tree, zh('board.task.group.merged')),
      zhf('board.tasks.list.expand', { group: zh('board.task.group.merged') }),
    );
    expect(merged.props['aria-expanded']).toBe(false);
    merged.props.onClick();
    expect(rows(groupOf(h.render(), zh('board.task.group.merged'))).map((n) => n.key)).toEqual([
      'done-1',
      'done-2',
    ]);
  });

  it('names a row by its title and state, and opens the task from it', () => {
    const tree = host().render();
    const row = rows(tree).find((n) => n.key === 'failing')!;
    expect(row.props['aria-label']).toBe(
      zhf('board.tasks.list.rowLabel', { task: 'failing', status: zh('board.task.state.failed') }),
    );
    row.props.onClick();
    const event = { key: 'Enter', preventDefault: vi.fn() };
    rows(tree)
      .find((n) => n.key === 'working')!
      .props.onKeyDown(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(opened).toEqual(['failing', 'working']);
  });

  it('keeps only the stuck tasks while the stuck filter is on', () => {
    const h = host();
    const filter = () =>
      find(h.render(), (n) => n.type === 'button' && n.props.className === 'btn btk-flt');
    expect(filter().props['aria-label']).toBe(zhf('board.tasks.list.stuckFilter', { count: 1 }));
    expect(filter().props['aria-pressed']).toBe(false);
    const chips = nodes(h.value).filter((n) => n.props.className === 'chip btk-stk');
    expect(chips).toHaveLength(1);
    filter().props.onClick();
    expect(filter().props['aria-pressed']).toBe(true);
    expect(rowIds(h.value)).toEqual(['blocked']);
  });

  it('lists every task by duration without groups once sorted by time', () => {
    const h = host();
    labelled(
      h.render(),
      zhf('board.tasks.list.sortBy', { column: zh('board.tasks.list.columns.time') }),
    ).props.onClick();
    const tree = h.render();
    expect(nodes(tree).some((n) => n.props.className === 'btk-gh')).toBe(false);
    expect(rowIds(tree)).toEqual([
      'loose-session',
      'blocked',
      'done-2',
      'working',
      'asked',
      'failing',
      'done-1',
    ]);
    const sorted = nodes(tree).filter(
      (n) => n.props.role === 'columnheader' && n.props['aria-sort'] === 'ascending',
    );
    expect(sorted).toHaveLength(1);
    expect(text(sorted[0])).toContain(zh('board.tasks.list.columns.time'));
  });

  it('draws every duration on one scale, the longest full', () => {
    const tree = host().render();
    const meters = nodes(tree).filter((n) => n.props.className === 'meter btk-age');
    const scale = durationText(60 * MIN);
    expect(meters.map((m) => m.props['aria-label'])).toEqual([
      zhf('board.tasks.list.time', { duration: durationText(18 * MIN), scale }),
      zhf('board.tasks.list.time', { duration: durationText(41 * MIN), scale }),
      zhf('board.tasks.list.time', { duration: durationText(12 * MIN), scale }),
    ]);
    expect(meters[1]!.props.style['--v']).toBe(`${(41 / 60) * 100}%`);
    const header = find(tree, (n) => n.props.role === 'columnheader' && text(n).includes(scale));
    expect(text(header)).toContain(zh('board.tasks.list.columns.time'));
  });

  it('writes not run for a task whose checks have not run, and the passed share otherwise', () => {
    const tree = host().render();
    // Checks has no hooks; drawn here so its marks and words can be read.
    const checks = (id: string) => {
      const el = find(
        rows(tree).find((n) => n.key === id)!,
        (n) => typeof n.type === 'function' && n.type.name === 'Checks',
      );
      return (el.type as (props: unknown) => ReactNode)(el.props);
    };
    expect(text(checks('working'))).toBe(zh('board.tasks.list.notRun'));
    expect(text(checks('failing'))).toBe('2 / 3');
    const marks = labelled(
      checks('failing'),
      zhf('board.tasks.list.checks', { count: 3, failed: 1, passed: 2 }),
    );
    expect(marks.props.children.map((i: ReactElement<any>) => i.props['data-state'])).toEqual([
      'failed',
      'passed',
      'passed',
    ]);
  });
});
