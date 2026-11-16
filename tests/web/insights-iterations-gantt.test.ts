import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { zh } from './i18n-setup.js';
import { type HookHost, find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useBoard } from '@/data/board';
import { IterationsTab } from '@/screens/insights/IterationsTab';
import { ganttLayout } from '@/screens/insights/iterations-gantt-model';

type Task = BoardModel['tasks'][number];
type Iteration = NonNullable<BoardModel['iterations']>[number];

const HOUR = 3_600_000;
const DAY = 86_400_000;
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
    order: 0,
    depends_on: [],
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

type StepRun = NonNullable<Task['step_runs']>[number];
let runAt = 0;
const stepRun = (step_id: string, state: StepRun['state'], session_id = 's-1'): StepRun => ({
  id: `run-${++runAt}`,
  slot: 'before_merge',
  step_id,
  workflow_id: 'project',
  title: step_id,
  kind: 'command',
  state,
  session_id,
  created_at: NOW - 4 * HOUR + runAt,
});

const iteration = (id: string, extra: Partial<Iteration> = {}): Iteration => ({
  id: `lead-1:${id}`,
  title: `Sprint ${id}`,
  starts_on: '2026-11-09',
  ends_on: '2026-11-15',
  planned: 0,
  done: 0,
  days: [],
  ...extra,
});

const ONE = iteration('one');
const TWO = iteration('two', { starts_on: '2026-11-16', ends_on: '2026-11-22' });

const board = (extra: Partial<BoardModel> = {}): BoardModel =>
  ({
    since: NOW - 7 * DAY,
    now: NOW,
    lanes: [],
    edges: [],
    merges: [],
    tasks: [
      task('parser', {
        iteration_id: 'lead-1:one',
        state: 'running',
        status: 'running',
        started_at: NOW - 5 * HOUR,
      }),
      task('lexer', {
        iteration_id: 'lead-1:one',
        state: 'running',
        status: 'running',
        started_at: NOW - 3 * HOUR,
      }),
      task('docs', { iteration_id: 'lead-1:two', estimate: 2, order: 1 }),
      task('guide', { iteration_id: 'lead-1:two', estimate: 3, order: 2, depends_on: ['docs'] }),
      task('cleanup', { estimate: 8 }),
    ],
    iterations: [ONE, TWO],
    slots: { limit: 3, used: 2, queued: 0 },
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

let stored: Map<string, string>;
beforeEach(() => {
  stored = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  });
});

const run = vi.fn(async (..._args: unknown[]) => null as string | null);
const itr = (key: string) => zh(`insights.iterations.${key}`);
const view = (model: BoardModel = board(), projectId = 'project-a') =>
  mount(() => IterationsTab({ model, projectId, edit: { projectId, run }, onOpenTask() {} }));
afterEach(() => {
  unmountAll();
  run.mockClear();
  vi.unstubAllGlobals();
});

const modes = (tree: unknown) =>
  find(tree as never, (n) => n.props['aria-label'] === itr('view') && !!n.props.onValueChange);
const gantt = (h: HookHost<any>) => {
  const element = named(h.value, 'IterationsGantt');
  return (element.type as (p: object) => ReactNode)(element.props);
};
const bar = (tree: unknown, id: string) =>
  find(tree as never, (n) => n.props['data-task-bar'] === `lead-1:${id}`);
const zone = (tree: unknown, id: string | null) =>
  find(tree as never, (n) => n.props['data-iteration'] === (id ?? 'none'));
const labelled = (tree: unknown, label: string) =>
  find(tree as never, (n) => n.props['aria-label'] === label);
const dragEvent = () => ({
  dataTransfer: { setData() {}, effectAllowed: '', dropEffect: '' },
  preventDefault() {},
});
const shown = (h: HookHost<any>) =>
  nodes(h.value).some((n) => typeof n.type === 'function' && n.type.name === 'IterationsGantt');

describe('iterations view mode', () => {
  it('opens on the gantt chart and remembers a switch to columns per project', () => {
    const h = view();
    expect(modes(h.value).props.value).toBe('gantt');
    expect(shown(h)).toBe(true);
    modes(h.value).props.onValueChange('columns');
    h.render();
    expect(shown(h)).toBe(false);
    expect(stored.get('pantheon.insights.iterations.project-a')).toBe('columns');
    expect(shown(view())).toBe(false);
    expect(shown(view(board(), 'project-b'))).toBe(true);
  });

  it('falls back to the gantt chart when the stored choice cannot be read', () => {
    stored.set('pantheon.insights.iterations.project-a', 'timeline');
    expect(modes(view().value).props.value).toBe('gantt');
    vi.stubGlobal('localStorage', {
      getItem() {
        throw new Error('blocked');
      },
    });
    expect(modes(view().value).props.value).toBe('gantt');
  });
});

describe('gantt layout', () => {
  it("spans the shown iteration's days", () => {
    const layout = ganttLayout(board(), TWO);
    expect(layout.days.map((d) => d.date)).toEqual([
      '2026-11-16',
      '2026-11-17',
      '2026-11-18',
      '2026-11-19',
      '2026-11-20',
      '2026-11-21',
      '2026-11-22',
    ]);
    expect(layout.today).toBeNull();
    expect(ganttLayout(board(), ONE).today).toBeGreaterThan(0);
  });

  it('puts started tasks that overlap in time in different slots', () => {
    const layout = ganttLayout(board(), ONE);
    const slot = (id: string) => layout.bars.find((b) => b.task.id === `lead-1:${id}`)!.slot;
    expect(slot('parser')).not.toBe(slot('lexer'));
    expect(layout.rows).toBe(3);
  });

  it('reuses a slot once its task has merged, starting each bar at its start', () => {
    const layout = ganttLayout(
      board({
        tasks: [
          task('early', {
            state: 'merged',
            status: 'done',
            started_at: NOW - 3 * DAY,
            ended_at: NOW - 2 * DAY,
          }),
          task('late', { state: 'running', status: 'running', started_at: NOW - HOUR }),
        ],
      }),
      ONE,
    );
    const [early, late] = layout.bars;
    expect([early!.slot, late!.slot]).toEqual([0, 0]);
    expect(early!.x2).toBeLessThanOrEqual(late!.x1);
  });

  it('draws a started bar as long as the task has run, however short', () => {
    const layout = ganttLayout(
      board({
        tasks: [task('quick', { state: 'running', status: 'running', started_at: NOW - HOUR })],
      }),
      ONE,
    );
    const [quick] = layout.bars;
    expect(quick!.x2 - quick!.x1).toBeCloseTo(HOUR / (7 * DAY), 6);
  });

  it("moves a bar to another row when it would start under the previous bar's title", () => {
    const layout = ganttLayout(
      board({
        tasks: [
          task('first', {
            state: 'merged',
            status: 'done',
            started_at: NOW - 3 * HOUR,
            ended_at: NOW - 2 * HOUR,
          }),
          task('second', { state: 'running', status: 'running', started_at: NOW - HOUR }),
        ],
      }),
      ONE,
    );
    const [first, second] = layout.bars;
    expect(first!.x2).toBeLessThan(second!.x1);
    expect(first!.slot).not.toBe(second!.slot);
  });

  it("keeps a bar's row for the width of its estimate", () => {
    const short = (id: string, start: number, estimate: number) =>
      task(id, {
        title: id,
        estimate,
        state: 'merged',
        status: 'done',
        started_at: start,
        ended_at: start + HOUR,
      });
    const slots = (estimate: number) =>
      ganttLayout(
        board({
          tasks: [short('a', NOW - 3 * DAY, estimate), short('b', NOW - 2 * DAY, 1)],
        }),
        ONE,
      ).bars.map((b) => b.slot);
    expect(slots(1)).toEqual([0, 0]);
    expect(slots(13)).toEqual([0, 1]);
  });

  it('places tasks not started inside their iteration, after the ones they depend on', () => {
    const layout = ganttLayout(board(), TWO);
    const of = (id: string) => layout.bars.find((b) => b.task.id === `lead-1:${id}`)!;
    for (const id of ['docs', 'guide']) {
      expect(of(id).planned).toBe(true);
      expect(of(id).x1).toBeGreaterThanOrEqual(0);
      expect(of(id).x2).toBeLessThanOrEqual(1 + 1e-9);
    }
    expect(of('guide').x1).toBeGreaterThanOrEqual(of('docs').x2 - 1e-9);
    expect(layout.unscheduled.map((t) => t.id)).toEqual(['lead-1:cleanup']);
  });

  it('links each bar to the bars of the tasks it depends on', () => {
    const layout = ganttLayout(board(), TWO);
    expect(layout.links.map(({ from, to }) => [from.task.id, to.task.id])).toEqual([
      ['lead-1:docs', 'lead-1:guide'],
    ]);
  });

  it('keeps today in the first days without iterations, with a week after it', () => {
    const layout = ganttLayout(board({ iterations: [], slots: undefined }), null);
    expect(layout.days[0]!.date).toBe('2026-11-10');
    expect(layout.days.at(-1)!.date).toBe('2026-11-19');
    expect(layout.days).toHaveLength(10);
    expect(layout.rows).toBe(3);
    // A 1280px window shows seven days of the chart; today stays inside with two days after it.
    expect(layout.today).toBeGreaterThan(0);
    expect(layout.today! * layout.days.length).toBeLessThan(7 - 2);
  });
});

describe('gantt chart', () => {
  it('names every row, the ones past the slot limit too', () => {
    const h = view(board({ slots: { limit: 1, used: 2, queued: 0 } }));
    const rows = find(gantt(h), (n) => n.props['aria-label'] === itr('slots'));
    const items = rows.props.children as ReactElement<any>[];
    expect(items.map((row) => text(row.props.children[0]))).toEqual(['槽位 1', '槽位 2']);
  });

  it('shows the runtime and the stage progress inside a bar', () => {
    const h = view(
      board({
        tasks: [
          task('parser', {
            iteration_id: 'lead-1:one',
            state: 'running',
            status: 'running',
            started_at: NOW - 5 * HOUR,
            claim: { session_id: 's-1', runtime: 'codex', model: null },
            step_runs: [stepRun('plan', 'passed'), stepRun('tests', 'running')],
          }),
        ],
      }),
    );
    const parser = bar(gantt(h), 'parser');
    expect(labelled(parser, 'Codex').props.role).toBe('img');
    expect(labelled(parser, '阶段进度：完成 1 / 2').props.role).toBe('img');
  });

  it("counts the workflow's steps as stages, not the task's sessions", () => {
    const h = view(
      board({
        tasks: [
          task('parser', {
            iteration_id: 'lead-1:one',
            state: 'merged',
            status: 'done',
            started_at: NOW - 5 * HOUR,
            ended_at: NOW - HOUR,
            segments: [
              { id: 'first', session_id: 's-1', status: 'failed' },
              { id: 'second', session_id: 's-2', status: 'done' },
            ] as Task['segments'],
            step_runs: [
              stepRun('tests', 'failed', 's-1'),
              stepRun('tests', 'passed', 's-2'),
              stepRun('review', 'passed', 's-2'),
            ],
          }),
        ],
      }),
    );
    expect(labelled(bar(gantt(h), 'parser'), '阶段进度：完成 2 / 2').props.role).toBe('img');
  });

  it('draws the dependency lines as a labelled graphic', () => {
    const h = view();
    labelled(h.value, itr('next')).props.onClick();
    h.render();
    expect(labelled(gantt(h), 'task guide 等 task docs').props.role).toBe('img');
  });

  it("centres each day's label across its own column, so the today line reads inside its day", () => {
    const h = view();
    const axis = find(gantt(h), (n) => n.props.className === 'itg-axis');
    const labels = axis.props.children as ReactElement<any>[];
    const share = (value: string) => Number(/^([\d.e-]+)%$/.exec(value)![1]) / 100;
    const spans = labels.map(({ props }): [number, number] => [
      share(props.style.left),
      share(props.style.left) + share(props.style.width),
    ]);
    expect(spans[0]![0]).toBe(0);
    expect(spans.at(-1)![1]).toBeCloseTo(1, 9);
    for (let i = 1; i < spans.length; i++) expect(spans[i]![0]).toBeCloseTo(spans[i - 1]![1], 9);
    const css = readFileSync(
      new URL('../../apps/web/src/screens/insights/iterations.css', import.meta.url),
      'utf8',
    );
    const rule = /\n\.itg-axis span \{([^}]*)\}/.exec(css)![1]!;
    expect(rule).toMatch(/\btext-align: center;/);
    expect(rule).not.toMatch(/padding-left/);
  });

  it('colours a bar by the state of its task', () => {
    const h = view();
    expect(bar(gantt(h), 'parser').props['data-state']).toBe('running');
  });

  it("draws a bar's box without side padding, so a short task stays short", () => {
    const css = readFileSync(
      new URL('../../apps/web/src/screens/insights/iterations.css', import.meta.url),
      'utf8',
    );
    const rule = /\n\.itg-bar \{([^}]*)\}/.exec(css)![1]!;
    const padding = /\bpadding: ([^;]+);/.exec(rule)?.[1] ?? '0';
    expect(padding.split(' ')[1] ?? padding).toBe('0');
    expect(rule).not.toMatch(/padding-(left|right|inline)/);
  });

  it('asks the lead of the shown iteration to reschedule it from the schedule head', () => {
    const lead = { id: 'lead-1', state: 'idle', revision: 4 };
    useBoard.setState({ board: { sessions: [lead] } } as never);
    try {
      const h = view();
      const ask = named(gantt(h), 'TellLead');
      expect(ask.props.lead).toBe(lead);
      expect(ask.props.text).toBe(itr('reschedule'));
      expect(ask.props.label).toBe('Sprint one');
      expect(ask.props.draft).toContain('(one)');
      expect(ask.props.run).toBe(run);
    } finally {
      useBoard.setState({ board: null } as never);
    }
  });

  it('puts the summary under the schedule, beside the unscheduled tasks', () => {
    const h = view();
    const main = find(gantt(h), (n) => n.props.className === 'itg-main');
    expect(nodes(main).some((n) => n.props.className === 'panel itr-foot')).toBe(true);
  });

  it('lists the unscheduled tasks beside the schedule with their count', () => {
    const h = view();
    const aside = zone(gantt(h), null);
    expect(aside.type).toBe('aside');
    expect(text(aside)).toContain(itr('unscheduled'));
    expect(labelled(aside, '1 个任务')).toBeTruthy();
    expect(nodes(aside).some((n) => n.props['data-task-card'] === 'lead-1:cleanup')).toBe(true);
  });
});

describe('moving bars between iterations', () => {
  it('sends a null iteration when a bar of the shown iteration is dropped on unscheduled', async () => {
    const h = view();
    labelled(h.value, itr('next')).props.onClick();
    h.render();
    bar(gantt(h), 'docs').props.onDragStart(dragEvent());
    h.render();
    zone(gantt(h), null).props.onDragOver(dragEvent());
    h.render();
    zone(gantt(h), null).props.onDrop(dragEvent());
    await h.flush();
    expect(run.mock.calls).toEqual([
      [
        'board.plan.edit',
        {
          project_id: 'project-a',
          lead_session_id: 'lead-1',
          base_version: 7,
          ops: [{ type: 'set_task', task_id: 'docs', patch: { iteration: null } }],
        },
        null,
      ],
    ]);
  });

  it('takes an unscheduled task into the shown iteration', async () => {
    const h = view();
    find(gantt(h), (n) => n.props['data-task-card'] === 'lead-1:cleanup').props.onDragStart(
      dragEvent(),
    );
    h.render();
    zone(gantt(h), 'lead-1:one').props.onDrop(dragEvent());
    await h.flush();
    expect(run.mock.calls.map(([, input]) => (input as { ops: unknown }).ops)).toEqual([
      [{ type: 'set_task', task_id: 'cleanup', patch: { iteration: 'one' } }],
    ]);
  });
});
