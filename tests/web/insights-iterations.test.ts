import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { zh } from './i18n-setup.js';
import { HookHost, find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
import { Clip } from '@/components/Clip';
import { pickBoardPage, pickTaskView, useBoardPage, useTaskView } from '@/data/board-page';
import { boardEditing, setBoardEditing } from '@/screens/board/EditMode';
import { useShell } from '@/store';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import {
  IterationsBarControls,
  IterationsTab,
  iterationColumns,
  leadIterations,
} from '@/screens/insights/IterationsTab';

type Task = BoardModel['tasks'][number];
type Iteration = NonNullable<BoardModel['iterations']>[number];

const NOW = new Date(2026, 10, 12, 10).getTime();

const task = (id: string, extra: Partial<Task> = {}): Task =>
  ({
    id: `lead-1:${id}`,
    owner_session_id: 'lead-1',
    title: `task ${id}`,
    goal: '',
    scope: [],
    lane_id: null,
    milestone_id: null,
    iteration_id: null,
    estimate: 1,
    status: 'todo',
    state: 'todo',
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

const iteration = (id: string, extra: Partial<Iteration> = {}): Iteration => ({
  id: `lead-1:${id}`,
  title: `Sprint ${id}`,
  starts_on: '2026-11-09',
  ends_on: '2026-11-20',
  planned: 0,
  done: 0,
  days: [],
  ...extra,
});

const board = (extra: Partial<BoardModel> = {}): BoardModel =>
  ({
    since: NOW - 7 * 86_400_000,
    now: NOW,
    lanes: [],
    edges: [],
    merges: [],
    tasks: [
      task('parser', { iteration_id: 'lead-1:one', estimate: 3, state: 'merged', status: 'done' }),
      task('lexer', { iteration_id: 'lead-1:one', estimate: 5 }),
      task('docs', { iteration_id: 'lead-1:two', estimate: 2 }),
      task('cleanup', { estimate: 8 }),
      task('stray', { iteration_id: 'lead-1:gone' }),
      { ...task('loose'), id: 'session-9', owner_session_id: undefined },
    ],
    iterations: [
      iteration('one', {
        planned: 8,
        done: 3,
        days: [
          { date: '2026-11-09', scope: 8, done: 0 },
          { date: '2026-11-10', scope: 8, done: 3 },
        ],
      }),
      iteration('two', { title: 'Sprint two', planned: 2 }),
    ],
    leads: [
      {
        session_id: 'lead-1',
        title: 'lead',
        state: 'idle',
        inbox: 0,
        updated_at: 0,
        plan_version: 7,
      },
    ],
    ...extra,
  }) as BoardModel;

const run = vi.fn(async (..._args: unknown[]) => null as string | null);
const itr = (key: string) => zh(`insights.iterations.${key}`);
function view(model: BoardModel = board(), editable = true) {
  const h = mount(() =>
    IterationsTab({
      model,
      edit: editable ? { projectId: 'project-a', run } : undefined,
      onOpenTask() {},
    }),
  );
  nodes(h.value)
    .find((n) => n.props['aria-label'] === itr('view') && n.props.onValueChange)
    ?.props.onValueChange('columns');
  h.render();
  return h;
}
afterEach(() => {
  unmountAll();
  run.mockClear();
});

const sent = () =>
  run.mock.calls.map(([type, input, expected]) => ({
    type,
    ...(input as object),
    expected,
  }));
const editOf = (ops: unknown[]) => ({
  type: 'board.plan.edit',
  project_id: 'project-a',
  lead_session_id: 'lead-1',
  base_version: 7,
  ops,
  expected: null,
});
const dragEvent = () => ({
  dataTransfer: { setData() {}, effectAllowed: '', dropEffect: '' },
  preventDefault() {},
});
const card = (tree: unknown, id: string) =>
  find(tree as never, (n) => n.props['data-task-card'] === `lead-1:${id}`);
const column = (tree: unknown, id: string | null) =>
  find(tree as never, (n) => n.props['data-iteration'] === (id ?? 'none'));
const item = (tree: unknown, label: string) =>
  find(tree as never, (n) => typeof n.props.onClick === 'function' && text(n) === label);
const labelled = (tree: unknown, label: string) =>
  find(tree as never, (n) => n.props['aria-label'] === label);
const heading = (tree: unknown) => text(find(tree as never, (n) => n.type === 'h3'));
const atRisk = (n: ReactElement<any>) => n.type === 'h3' && text(n) === itr('atRisk');
// The at risk list, found through the heading that names it.
const risks = (tree: unknown) => {
  const { id } = find(tree as never, atRisk).props;
  return find(tree as never, (n) => n.type === 'ul' && n.props['aria-labelledby'] === id);
};

describe('iteration columns', () => {
  it('puts each plan task under its iteration and the rest under unscheduled, adding up points', () => {
    const columns = iterationColumns(board());
    expect(columns.map((c) => [c.id, c.tasks.map((t) => t.id), c.points])).toEqual([
      [null, ['lead-1:cleanup', 'lead-1:stray'], 9],
      ['lead-1:one', ['lead-1:parser', 'lead-1:lexer'], 8],
      ['lead-1:two', ['lead-1:docs'], 2],
    ]);
  });

  it("lists a lead's iterations under their plan ids", () => {
    expect(leadIterations(board(), 'lead-1')).toEqual([
      { id: 'one', title: 'Sprint one', starts_on: '2026-11-09', ends_on: '2026-11-20' },
      { id: 'two', title: 'Sprint two', starts_on: '2026-11-09', ends_on: '2026-11-20' },
    ]);
  });

  it('heads a column with its points done of planned and a burndown no taller than 48px', () => {
    const h = view();
    const head = column(h.value, 'lead-1:one');
    expect(text(head)).toContain('3/8');
    const chart = find(head, (n) => n.type === 'svg');
    expect(Number(chart.props.height)).toBeLessThanOrEqual(48);
  });

  it('shows the empty state without a lead plan', () => {
    const h = view(board({ leads: [], iterations: [] }));
    expect(named(h.value, 'Empty').props.text).toBe(zh('board.newTask.noPlan'));
    expect(nodes(h.value).some((n) => n.props['data-iteration'])).toBe(false);
  });
});

describe('iteration header', () => {
  const header = (h: HookHost<any>) => labelled(h.value, itr('progress'));

  it('opens on the iteration that holds today and steps to the ones before and after', () => {
    const h = view(
      board({
        iterations: [
          iteration('next', { starts_on: '2026-11-16', ends_on: '2026-11-22' }),
          iteration('now', { starts_on: '2026-11-09', ends_on: '2026-11-15' }),
          iteration('past', { starts_on: '2026-11-02', ends_on: '2026-11-06' }),
        ],
      }),
    );
    expect(heading(header(h))).toBe('Sprint now');
    labelled(h.value, itr('previous')).props.onClick();
    h.render();
    expect(heading(header(h))).toBe('Sprint past');
    expect(labelled(h.value, itr('previous')).props.disabled).toBe(true);
    labelled(h.value, itr('next')).props.onClick();
    h.render();
    labelled(h.value, itr('next')).props.onClick();
    h.render();
    expect(heading(header(h))).toBe('Sprint next');
    expect(labelled(h.value, itr('next')).props.disabled).toBe(true);
  });

  it('heads the iteration with its day, its merged tasks and a bar of their states', () => {
    const base = board();
    const h = view(
      board({
        tasks: [
          ...base.tasks,
          task('run', { iteration_id: 'lead-1:one', state: 'running', status: 'running' }),
          task('ask', {
            iteration_id: 'lead-1:one',
            state: 'waiting_approval',
            status: 'waiting',
          }),
        ],
      }),
    );
    expect(text(header(h))).toContain('第 4 天');
    expect(text(labelled(header(h), '已合并 1 / 共 4 个任务'))).toBe('1 / 4');
    expect(labelled(header(h), '4 个任务：已合并 1，运行中 1，等你 1，未开始 1').props.role).toBe(
      'img',
    );
  });

  it('shows the slot limit and how the scope moved over the days', () => {
    const h = view(
      board({
        slots: { limit: 3, used: 1, queued: 0 },
        iterations: [
          iteration('one', {
            planned: 9,
            days: [
              { date: '2026-11-09', scope: 8, done: 0 },
              { date: '2026-11-10', scope: 10, done: 1 },
              { date: '2026-11-11', scope: 9, done: 3 },
            ],
          }),
        ],
      }),
    );
    expect(text(header(h))).toContain('并发 3');
    expect(text(header(h))).toContain('范围 +2 −1');
  });

  it('leaves out the scope change while the scope has not moved', () => {
    const h = view();
    expect(text(header(h))).not.toContain('范围');
  });

  it('says when the iteration should be done and how many more tasks fit, when the board says', () => {
    const forecast = new Date(2026, 10, 13, 16).getTime();
    const h = view(
      board({ iterations: [iteration('one', { forecast_done_at: forecast, capacity: 3 })] }),
    );
    expect(text(header(h))).toContain('预计 11月13日 16:00 做完');
    expect(text(header(h))).toContain('还能排 3 个任务');
    const full = view(board({ iterations: [iteration('one', { capacity: 0 })] }));
    expect(text(header(full))).toContain('还能排 0 个任务');
    const bare = view();
    expect(text(header(bare))).not.toContain('预计');
    expect(text(header(bare))).not.toContain('还能排');
  });
});

describe('iteration summary', () => {
  it('draws the done points against a dashed plan line', () => {
    const h = view();
    const chart = labelled(h.value, '完成量：已完成 3 / 共 8 点');
    expect(chart.props.role).toBe('img');
    expect(nodes(chart).some((n) => n.type === 'polyline')).toBe(true);
  });

  it('counts the tasks of the iteration per runtime, claimed before planned', () => {
    const base = board();
    const h = view(
      board({
        tasks: [
          ...base.tasks.map((t) =>
            t.id === 'lead-1:parser'
              ? { ...t, claim: { session_id: 's-1', runtime: 'codex', model: null } }
              : t.id === 'lead-1:lexer'
                ? { ...t, planned: { runtime: 'claude' } }
                : t,
          ),
          task('route', {
            iteration_id: 'lead-1:one',
            planned: { runtime: 'claude' },
            claim: { session_id: 's-2', runtime: 'codex', model: null },
          }),
        ],
      }),
    );
    const list = labelled(h.value, itr('byRuntime'));
    const rows = (list.props.children as ReactElement<any>[]).map((row) => [
      find(row, (n) => n.props.role === 'img').props['aria-label'],
      text(row),
    ]);
    expect(rows).toEqual([
      ['Claude', '1 个任务'],
      ['Codex', '2 个任务'],
    ]);
  });
});

describe('iterations page frame', () => {
  it('lays the page out without a card or a page heading', () => {
    const h = view();
    expect(h.value.props.className).toBe('itr');
    expect(nodes(h.value).some((n) => n.type === 'h2')).toBe(false);
  });

  it('puts the iteration stepper, the view switch and new task into the bar controls', () => {
    const h = view();
    const bar = named(h.value, 'BarSlot');
    expect(labelled(bar, itr('shown'))).toBeTruthy();
    expect(labelled(bar, itr('view'))).toBeTruthy();
    pickBoardPage('project-a', 'overview');
    pickTaskView('project-a', 'list');
    named(bar, 'NewTask').props.onNew();
    // The new task form is in the board's edit mode, on its tasks page's flow chart.
    expect(useShell.getState().screen).toBe('board');
    expect(new HookHost(() => useBoardPage('project-a')).render()).toBe('tasks');
    expect(new HookHost(() => useTaskView('project-a')).render()).toBe('flow');
    expect(boardEditing('project-a')).toBe(true);
    setBoardEditing('project-a', false);
    const readOnly = view(board(), false);
    expect(
      nodes(readOnly.value).some((n) => (n.type as { name?: string }).name === 'NewTask'),
    ).toBe(false);
  });

  it('names the stepper buttons and turns off the one with no iteration behind it', () => {
    const onNext = vi.fn();
    const tree = IterationsBarControls({
      title: 'Sprint seven',
      onPrevious: null,
      onNext,
      mode: 'gantt',
      onMode() {},
    });
    const previous = labelled(tree, itr('previous'));
    expect([text(previous), previous.props.disabled]).toEqual([itr('previousShort'), true]);
    const next = labelled(tree, itr('next'));
    expect([text(next), next.props.disabled]).toEqual([itr('nextShort'), false]);
    next.props.onClick();
    expect(onNext).toHaveBeenCalledOnce();
    expect(text(find(labelled(tree, itr('shown')), (n) => n.type === Clip))).toBe('Sprint seven');
  });
});

describe('task rows', () => {
  it("marks a task's kind and a high priority", () => {
    const base = board();
    const h = view(
      board({
        tasks: base.tasks.map((t) =>
          t.id === 'lead-1:cleanup'
            ? { ...t, kind: { domain: 'backend-logic', tier: 't2' }, priority: 'high' }
            : t,
        ),
      }),
    );
    expect(
      labelled(card(h.value, 'cleanup'), zh('data.workflowPolicy.domain.backendLogic')).props.role,
    ).toBe('img');
    expect(labelled(card(h.value, 'cleanup'), itr('highPriority')).props.role).toBe('img');
    expect(
      nodes(card(h.value, 'stray')).some((n) => n.props['aria-label'] === itr('highPriority')),
    ).toBe(false);
  });

  it('draws the estimate as one square per point', () => {
    const h = view();
    const points = labelled(card(h.value, 'docs'), 'task docs 的点数：2');
    const squares = find(points, (n) => n.props['aria-hidden'] === 'true');
    expect(nodes(squares.props.children).filter((n) => n.type === 'i')).toHaveLength(2);
    expect(text(points)).toBe('');
  });

  it('draws a large estimate as three squares and the points past them', () => {
    const base = board();
    const h = view(
      board({
        tasks: base.tasks.map((t) => (t.id === 'lead-1:lexer' ? { ...t, estimate: 13 } : t)),
      }),
    );
    const points = labelled(card(h.value, 'lexer'), 'task lexer 的点数：13');
    const squares = find(points, (n) => n.props['aria-hidden'] === 'true');
    expect(nodes(squares.props.children).filter((n) => n.type === 'i')).toHaveLength(3);
    expect(text(points)).toBe('+10');
  });
});

describe('tasks at risk', () => {
  it('lists the failed tasks and the ones waiting for you with why', () => {
    const base = board();
    const h = view(
      board({
        tasks: [
          ...base.tasks,
          task('broken', {
            iteration_id: 'lead-1:one',
            state: 'failed',
            status: 'failed',
            activity: { phase: 'idle', since: NOW, health: 'fresh', attempt: 2 },
            segments: [
              { id: 'b-1', status: 'failed' },
              { id: 'b-2', status: 'failed' },
            ] as Task['segments'],
          }),
          task('asking', {
            iteration_id: 'lead-1:one',
            state: 'waiting_approval',
            status: 'waiting',
            activity: {
              phase: 'waiting_approval',
              since: NOW - 40 * 60_000,
              health: 'fresh',
              attempt: 1,
              waiting: {
                kind: 'approval',
                summary: 'rm -rf build',
                approval_id: 'a-1',
                since: NOW - 40 * 60_000,
              },
            },
          }),
        ],
      }),
    );
    const rows = (risks(h.value).props.children as ReactElement<any>[]).map((row) => text(row));
    expect(rows).toEqual(['task broken失败 2 次', 'task asking等你 40 分钟']);
  });

  it('counts only the sessions that failed, not every attempt', () => {
    const failed = (id: string, statuses: Task['segments'][number]['status'][]) =>
      task(id, {
        iteration_id: 'lead-1:one',
        state: 'failed',
        status: 'failed',
        activity: { phase: 'idle', since: NOW, health: 'fresh', attempt: statuses.length },
        segments: statuses.map((status, i) => ({ id: `${id}-${i}`, status })) as Task['segments'],
      });
    const h = view(
      board({
        tasks: [
          failed('retried', ['discarded', 'failed']),
          failed('parallel', ['done', 'failed', 'idle']),
        ],
      }),
    );
    const rows = (risks(h.value).props.children as ReactElement<any>[]).map((row) => text(row));
    expect(rows).toEqual(['task retried失败 1 次', 'task parallel失败 1 次']);
  });

  it('opens a task at risk from its title, which shows the whole title on hover', () => {
    const opened: string[] = [];
    const title = 'Remove the old export script and the cron entry that still calls it';
    const h = mount(() =>
      IterationsTab({
        model: board({
          tasks: [task('broken', { title, iteration_id: 'lead-1:one', state: 'failed' })],
        }),
        onOpenTask: (id) => void opened.push(id),
      }),
    );
    nodes(h.value)
      .find((n) => n.props['aria-label'] === itr('view') && n.props.onValueChange)
      ?.props.onValueChange('columns');
    h.render();
    const open = find(risks(h.value), (n) => n.type === 'button' && text(n) === title);
    expect(open.props.title).toBe(title);
    open.props.onClick();
    expect(opened).toEqual(['lead-1:broken']);
  });

  it('leaves the cell out while nothing is at risk', () => {
    const h = view();
    expect(nodes(h.value).some(atRisk)).toBe(false);
  });
});

describe('moving tasks between iterations', () => {
  it.each([
    [
      'sends set_task with the new iteration when a card is dropped on another column',
      'cleanup',
      ['lead-1:two'],
      'two',
    ],
    [
      'sends a null iteration when a card is dropped on unscheduled, and nothing on its own column',
      'docs',
      ['lead-1:two', null],
      null,
    ],
  ] as const)('%s', async (_name, id, targets, iteration) => {
    const h = view();
    for (const target of targets) {
      card(h.value, id).props.onDragStart(dragEvent());
      h.render();
      column(h.value, target).props.onDragOver(dragEvent());
      h.render();
      column(h.value, target).props.onDrop(dragEvent());
      h.render();
    }
    await h.flush();
    expect(sent()).toEqual([editOf([{ type: 'set_task', task_id: id, patch: { iteration } }])]);
  });

  it('moves a card from its menu without dragging', async () => {
    const h = view();
    item(card(h.value, 'lexer'), '移到 Sprint two').props.onClick();
    await h.flush();
    expect(sent()).toEqual([
      editOf([{ type: 'set_task', task_id: 'lexer', patch: { iteration: 'two' } }]),
    ]);
  });

  it('changes the estimate from the points on the card', async () => {
    const h = view();
    const points = find(card(h.value, 'lexer'), (n) => n.props.value === '13');
    points.props.onClick();
    await h.flush();
    expect(sent()).toEqual([
      editOf([{ type: 'set_task', task_id: 'lexer', patch: { estimate: 13 } }]),
    ]);
  });

  it('offers no moves on a board it cannot edit', () => {
    const h = view(board(), false);
    expect(card(h.value, 'lexer').props.draggable).toBeFalsy();
  });
});

describe('editing iterations', () => {
  const dialog = (h: HookHost<any>) => {
    const element = named(h.value, 'IterationDialog');
    return mount(() => (element.type as (p: object) => ReactNode)(element.props));
  };
  const field = (tree: unknown, label: string) =>
    find(tree as never, (n) => n.props['aria-label'] === label);

  it('adds a new iteration after the existing ones', async () => {
    const h = view();
    find(h.value, (n) => n.type === 'button' && text(n) === itr('new')).props.onClick();
    h.render();
    const d = dialog(h);
    expect(field(d.value, itr('start')).props.value).toBe('2026-11-12');
    expect(field(d.value, itr('end')).props.value).toBe('2026-11-25');
    field(d.value, itr('title')).props.onChange({
      target: { value: 'Sprint three' },
    });
    d.render();
    find(d.value, (n) => n.type === 'button' && text(n) === itr('save')).props.onClick();
    await d.flush();
    expect(sent()).toEqual([
      editOf([
        {
          type: 'set_iterations',
          iterations: [
            ...leadIterations(board(), 'lead-1'),
            {
              id: 'iteration-3',
              title: 'Sprint three',
              starts_on: '2026-11-12',
              ends_on: '2026-11-25',
            },
          ],
        },
      ]),
    ]);
  });

  it('renames and redates an iteration from its column menu', async () => {
    const h = view();
    item(column(h.value, 'lead-1:two'), itr('rename')).props.onClick();
    h.render();
    let d = dialog(h);
    field(d.value, itr('title')).props.onChange({
      target: { value: 'Second sprint' },
    });
    d.render();
    find(d.value, (n) => n.type === 'button' && text(n) === itr('save')).props.onClick();
    await d.flush();
    item(column(h.value, 'lead-1:one'), itr('redate')).props.onClick();
    h.render();
    d = dialog(h);
    field(d.value, itr('end')).props.onChange({
      target: { value: '2026-11-27' },
    });
    d.render();
    find(d.value, (n) => n.type === 'button' && text(n) === itr('save')).props.onClick();
    await d.flush();
    const [one, two] = leadIterations(board(), 'lead-1');
    expect(sent()).toEqual([
      editOf([{ type: 'set_iterations', iterations: [one, { ...two, title: 'Second sprint' }] }]),
      editOf([{ type: 'set_iterations', iterations: [{ ...one, ends_on: '2026-11-27' }, two] }]),
    ]);
  });

  it('refuses an end date before the start date', () => {
    const h = view();
    item(column(h.value, 'lead-1:one'), itr('redate')).props.onClick();
    h.render();
    const d = dialog(h);
    field(d.value, itr('end')).props.onChange({
      target: { value: '2026-11-01' },
    });
    d.render();
    expect(
      find(d.value, (n) => n.type === 'button' && text(n) === itr('save')).props.disabled,
    ).toBe(true);
  });

  it('deletes an iteration from its column menu', async () => {
    const h = view();
    item(column(h.value, 'lead-1:one'), itr('delete')).props.onClick();
    await h.flush();
    const [, two] = leadIterations(board(), 'lead-1');
    expect(sent()).toEqual([editOf([{ type: 'set_iterations', iterations: [two] }])]);
  });

  it("shows the daemon's refusal", async () => {
    run.mockResolvedValueOnce('The plan is at version 8');
    const h = view();
    item(column(h.value, 'lead-1:one'), itr('delete')).props.onClick();
    await h.flush();
    expect(text(find(h.value, (n) => n.props.role === 'alert'))).toBe('The plan is at version 8');
  });
});
