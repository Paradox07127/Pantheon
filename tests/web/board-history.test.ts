import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardHistory } from '@pantheon/protocol';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HookHost, find, named, nodes, text } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useBoard } from '@/data/board';
import { useCurrentProject } from '@/data/current-project';
import {
  dayNumber,
  historyLayout,
  historySummary,
  LABEL_W,
  sparkPath,
  TOP,
} from '@/screens/board/history-model';
import { HistoryRangeControl, HistoryView } from '@/screens/board/HistoryView';
import { durationText } from '@/screens/board/panels-model';
import { TASK_TYPE } from '@/screens/board/status';
import { useShell } from '@/store';
import { t } from '@/i18n';

type Task = BoardHistory['tasks'][number];
const DAY = 86_400_000;
const START = new Date(2026, 8, 2).getTime();
const NOW = START + 90 * DAY;
/** The Chinese text of a whole-history message. */
const hz = (key: string) => zh(`board.history.${key}`);
const say = (key: string, values: Record<string, number>) =>
  t({ id: `board.history.${key}`, defaultMessage: '' }, values);
const OPEN_SESSION = hz('openSession');
const REPLAY = hz('replay');
const PROGRESS = hz('progressSection');
const BANDS = hz('bands');

const task = (id: string, lane: string | null, over: Partial<Task> = {}): Task => ({
  id: `lead:${id}`,
  owner_session_id: 'lead',
  session_id: null,
  title: `task ${id}`,
  depends_on: [],
  lane_id: lane ?? 'lead:unknown',
  milestone_id: null,
  state: 'merged',
  created_at: START,
  started_at: START,
  merged_at: START + DAY,
  commit: null,
  additions: null,
  deletions: null,
  attempts: 1,
  handbacks: 0,
  ...over,
});

const history = (over: Partial<BoardHistory> = {}): BoardHistory => ({
  started_at: START,
  truncated: false,
  tasks: [],
  days: [],
  decisions: [],
  milestones: [],
  idle: [],
  ...over,
});

const LANES = [
  { id: 'lead:api', title: 'API' },
  { id: 'lead:docs', title: 'Docs' },
];

const layout = (h: BoardHistory, over: Partial<Parameters<typeof historyLayout>[0]> = {}) =>
  historyLayout({
    history: h,
    lanes: LANES,
    width: 1200,
    now: NOW,
    range: 'all',
    expanded: new Set(),
    due: new Map(),
    bands: 'lanes',
    critical: false,
    titleWidth: 0,
    ...over,
  });

/** The local calendar day `days` days after now. */
const dayAfterNow = (days: number) => {
  const d = new Date(NOW + days * DAY);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
/** The project's days up to today, as many as `count`, without activity. */
const quietDays = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    date: dayAfterNow(i - count + 1),
    merged: 0,
    handbacks: 0,
    decisions: 0,
    failed: 0,
    waited: 0,
  }));

describe('history rows', () => {
  it('gives each work line a row in plan order and puts tasks without one in a last row', () => {
    const h = history({
      tasks: [
        task('a', 'lead:docs'),
        task('b', 'lead:api', { state: 'running', merged_at: null }),
        task('c', 'lead:api'),
        task('d', null),
        task('e', 'lead:gone'),
        task('f', 'lead:api', { state: 'removed', merged_at: null }),
      ],
    });
    const rows = layout(h).rows;
    expect(rows.map((r) => [r.laneId, r.merged, r.total])).toEqual([
      ['lead:api', 1, 2],
      ['lead:docs', 1, 1],
      [null, 2, 2],
    ]);
  });

  it('spaces the work lines 112px apart', () => {
    const rows = layout(history({ tasks: [task('a', 'lead:api'), task('b', 'lead:docs')] })).rows;
    expect(rows[1]!.y - rows[0]!.y).toBe(112);
  });

  it('places a merged task at its merge time and an open one right of the now line', () => {
    const h = history({
      tasks: [
        task('early', 'lead:api', { merged_at: START + 10 * DAY }),
        task('late', 'lead:api', { merged_at: START + 60 * DAY, handbacks: 2 }),
        task('open', 'lead:api', { state: 'failed', merged_at: null }),
      ],
    });
    const l = layout(h);
    const [row] = l.rows;
    expect(row!.dots.map((d) => d.task.title)).toEqual(['task early', 'task late']);
    expect(row!.dots[0]!.x).toBeLessThan(row!.dots[1]!.x);
    expect(row!.dots.map((d) => d.reworked)).toEqual([false, true]);
    expect(row!.pills.map((p) => p.task.title)).toEqual(['task open']);
    expect(l.now).toBeLessThan(l.width);
    expect(row!.dots[1]!.x).toBeLessThan(l.now);
  });

  it('widens the open column to the longest open title, up to a third of the width past the row titles', () => {
    const h = history({ tasks: [task('open', 'lead:api', { state: 'running', merged_at: null })] });
    expect(layout(h).openW).toBe(180);
    const wide = layout(h, { titleWidth: 240 });
    expect(wide.openW).toBe(312);
    expect(wide.now).toBe(1200 - 312);
    expect(layout(h, { titleWidth: 900 }).openW).toBe((1200 - LABEL_W) / 3);
  });
});

describe('history fold', () => {
  const merged = (n: number, from: number) =>
    Array.from({ length: n }, (_, i) =>
      task(`m${from + i}`, 'lead:api', { merged_at: START + (from + i) * DAY }),
    );

  it('folds the early merges of a row with more than 12 merged tasks', () => {
    // 14 merges in the first ten days, 2 near now.
    const h = history({ tasks: [...merged(14, 1), ...merged(2, 80)] });
    const [row] = layout(h).rows;
    expect(row!.fold).toMatchObject({ count: 14, open: false });
    expect(row!.dots).toHaveLength(2);
    const [open] = layout(h, { expanded: new Set([row!.key]) }).rows;
    expect(open!.fold).toMatchObject({ count: 14, open: true });
    expect(open!.dots).toHaveLength(16);
  });

  it('keeps every merge of a row with 12 merged tasks or fewer', () => {
    const [row] = layout(history({ tasks: merged(12, 1) })).rows;
    expect(row!.fold).toBeNull();
    expect(row!.dots).toHaveLength(12);
  });

  it('folds only on the whole history', () => {
    const h = history({ tasks: [...merged(14, 70), ...merged(1, 85)] });
    const [row] = layout(h, { range: 'month' }).rows;
    expect(row!.fold).toBeNull();
    expect(row!.dots).toHaveLength(15);
  });
});

describe('history idle stretches', () => {
  it('cuts a long idle stretch to a break mark and names its days', () => {
    const idle = { from: START + 20 * DAY, to: START + 50 * DAY };
    const h = history({ idle: [idle], tasks: [task('after', 'lead:api', { merged_at: idle.to })] });
    const cut = layout(h);
    expect(cut.breaks).toHaveLength(1);
    expect(cut.breaks[0]!.days).toBe(30);
    const plain = layout({ ...h, idle: [] });
    expect(plain.breaks).toEqual([]);
    expect(cut.rows[0]!.dots[0]!.x).toBeLessThan(plain.rows[0]!.dots[0]!.x);
  });
});

describe('history milestones', () => {
  it('draws a line where a reached milestone was reached and none for the others', () => {
    const h = history({
      milestones: [
        { id: 'v1', title: 'v1', state: 'completed', reached_at: START + 30 * DAY },
        { id: 'v2', title: 'v2', state: 'active', reached_at: null },
        { id: 'old', title: 'old', state: 'removed', reached_at: START + 10 * DAY },
      ],
    });
    const l = layout(h);
    expect(l.milestones.map((m) => m.id)).toEqual(['v1']);
    expect(l.milestones[0]!.x).toBeGreaterThan(LABEL_W);
    expect(l.milestones[0]!.x).toBeLessThan(l.now);
    expect(historySummary(h, new Map(), NOW).milestones.map((m) => [m.id, m.day])).toEqual([
      ['v1', 31],
      ['v2', null],
    ]);
  });

  it('draws a milestone not reached yet at its due day, right of the now line when that is still ahead, and counts the days left', () => {
    const h = history({
      milestones: [
        { id: 'v1', title: 'v1', state: 'completed', reached_at: START + 30 * DAY },
        { id: 'v2', title: 'v2', state: 'active', reached_at: null },
        { id: 'v3', title: 'v3', state: 'active', reached_at: null },
        { id: 'v4', title: 'v4', state: 'active', reached_at: null },
      ],
    });
    const due = new Map([
      ['v1', dayAfterNow(-70)],
      ['v2', dayAfterNow(2)],
      ['v3', dayAfterNow(-3)],
    ]);
    const l = layout(h, { due });
    expect(l.milestones.map((m) => [m.id, m.due])).toEqual([
      ['v1', false],
      ['v2', true],
      ['v3', true],
    ]);
    const [, ahead, late] = l.milestones;
    expect(ahead!.x).toBeGreaterThan(l.now);
    expect(ahead!.x).toBeLessThanOrEqual(l.width);
    expect(late!.x).toBeLessThan(l.now);
    expect(historySummary(h, due, NOW).milestones.map((m) => [m.id, m.left])).toEqual([
      ['v1', null],
      ['v2', 2],
      ['v3', -3],
      ['v4', null],
    ]);
  });
});

describe('history progress', () => {
  it('counts the tasks by state, a removed task that merged as merged and other removed ones not at all', () => {
    const h = history({
      tasks: [
        task('a', 'lead:api', { state: 'failed', merged_at: null }),
        task('b', 'lead:api'),
        task('c', 'lead:api', { state: 'running', merged_at: null }),
        task('d', 'lead:api', { state: 'removed' }),
        task('e', 'lead:api', { state: 'removed', merged_at: null }),
        task('f', 'lead:api', { state: 'todo', merged_at: null }),
      ],
    });
    expect(historySummary(h, new Map(), NOW).states).toEqual([
      { state: 'merged', count: 2 },
      { state: 'running', count: 1 },
      { state: 'failed', count: 1 },
      { state: 'todo', count: 1 },
    ]);
  });
});

describe('history view', () => {
  const hosts: HookHost<any>[] = [];
  /** Names of the stand-in elements focused, in order. */
  const focused: string[] = [];
  const fakes = new Map<
    string,
    { dataset: { task?: string }; focus: () => void; scrollWidth: number }
  >();
  /** One stand-in element per name, so a test can pass it back as an event target. */
  const fake = (name: string, task?: string) => {
    if (!fakes.has(name))
      fakes.set(name, { dataset: {}, focus: () => focused.push(name), scrollWidth: 0 });
    const el = fakes.get(name)!;
    el.dataset.task ??= task;
    return el;
  };
  afterEach(() => {
    hosts.splice(0).forEach((h) => h.unmount());
    vi.unstubAllGlobals();
    useBoard.setState({ board: null });
    useCurrentProject.setState({ projectId: null });
    focused.length = 0;
    fakes.clear();
  });

  const mount = (
    h: BoardHistory,
    opened: string[] = [],
    over: Partial<Parameters<typeof HistoryView>[0]> = {},
  ) => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    // Stand-ins for the plot's dots, folds and pills, and for the card's buttons, in tree order.
    const stops = (tree: unknown) =>
      nodes(tree as never)
        .filter((n) => ['bd-hs-dot', 'bd-hs-fold', 'bd-hs-pill'].includes(n.props.className))
        .map((n) => fake(n.props['data-task'] ?? n.props['aria-label'], n.props['data-task']));
    const buttons = (tree: unknown) =>
      nodes(tree as never)
        .filter((n) => n.type === 'button')
        .map((n) => fake(text(n)));
    let latest: unknown;
    const host = new HookHost(
      () =>
        HistoryView({
          history: h,
          lanes: LANES,
          now: NOW,
          milestones: [],
          onOpenSession: (id) => opened.push(id),
          onOpenTask: () => {},
          ...over,
        }),
      (tree) => {
        latest = tree;
        find(tree, (n) => n.props.className === 'bd-hs-plot').props.ref.current ??= {
          clientWidth: 1200,
          querySelectorAll: () => stops(latest),
        };
        const box = nodes(tree).find((n) => n.props.className === 'bd-hs-card');
        if (box?.props.ref)
          box.props.ref.current = {
            querySelector: () => buttons(box)[0] ?? null,
            querySelectorAll: () => buttons(box),
          };
      },
    );
    hosts.push(host);
    host.render();
    return host;
  };
  const view = (h: BoardHistory) => mount(h).value;
  const dot = (tree: unknown, title: string) =>
    find(
      tree as never,
      (n) => n.props.className === 'bd-hs-dot' && n.props['aria-label'].startsWith(`${title}，`),
    );
  const card = (host: HookHost<any>, title: string) => {
    dot(host.value, title).props.onMouseEnter();
    host.render();
    return find(host.value, (n) => n.props.className === 'bd-hs-card');
  };

  it("shows a merged task's commit, changed lines and time taken on its card, and no such line without them", () => {
    const h = mount(
      history({
        tasks: [
          task('a', 'lead:api', {
            commit: '4c81e07d9a2b',
            additions: 212,
            deletions: 37,
            started_at: START,
            merged_at: START + 72 * 60_000,
          }),
          task('b', 'lead:api', { started_at: null, merged_at: START + 2 * DAY }),
        ],
      }),
    );
    const facts = find(card(h, 'task a'), (n) => n.props.className === 'bd-hs-cm');
    expect(text(facts)).toContain('4c81e07');
    expect(text(facts)).not.toContain('4c81e07d');
    expect(text(facts)).toContain('+212');
    expect(text(facts)).toContain('−37');
    expect(text(facts)).toContain(durationText(72 * 60_000));
    expect(nodes(card(h, 'task b')).some((n) => n.props.className === 'bd-hs-cm')).toBe(false);
  });

  it("opens the task's own session from its card, and the lead's when it has none", () => {
    const opened: string[] = [];
    const h = mount(
      history({
        tasks: [
          task('a', 'lead:api', { session_id: 'worker-a' }),
          task('b', 'lead:api', { merged_at: START + 2 * DAY }),
        ],
      }),
      opened,
    );
    const open = (tree: unknown) =>
      find(tree as never, (n) => n.type === 'button' && text(n) === OPEN_SESSION).props.onClick();
    open(card(h, 'task a'));
    open(card(h, 'task b'));
    expect(opened).toEqual(['worker-a', 'lead']);
  });

  const shownCard = (h: HookHost<any>) =>
    nodes(h.value).find((n) => n.props.className === 'bd-hs-card');
  const key = (key: string, target?: unknown, shiftKey = false) => {
    const e = {
      key,
      target,
      shiftKey,
      prevented: false,
      preventDefault: () => (e.prevented = true),
    };
    return e;
  };
  const plotKey = (h: HookHost<any>, e: ReturnType<typeof key>) => {
    find(h.value, (n) => n.props.className === 'bd-hs-plot').props.onKeyDown(e);
    h.render();
    return e;
  };

  it("pins a dot's card on Enter or Space and moves focus to its first button, opening nothing", () => {
    const opened: string[] = [];
    const h = mount(
      history({ tasks: [task('a', 'lead:api', { session_id: 'worker-a' })] }),
      opened,
    );
    for (const k of ['Enter', ' ']) {
      const e = key(k);
      dot(h.value, 'task a').props.onKeyDown(e);
      h.render();
      expect(e.prevented).toBe(true);
      expect(shownCard(h)?.props['aria-label']).toBe('task a');
      dot(h.value, 'task a').props.onBlur();
      h.render();
      expect(shownCard(h)?.props['aria-label']).toBe('task a');
      expect(focused.at(-1)).toBe(REPLAY);
      plotKey(h, key('Escape'));
    }
    expect(opened).toEqual([]);
  });

  it('closes the pinned card on Escape and puts focus back on its dot', () => {
    const h = mount(history({ tasks: [task('a', 'lead:api')] }));
    dot(h.value, 'task a').props.onClick();
    h.render();
    expect(shownCard(h)).toBeDefined();
    plotKey(h, key('Escape', fake(OPEN_SESSION)));
    expect(shownCard(h)).toBeUndefined();
    expect(focused.at(-1)).toBe('lead:a');
  });

  it('puts the pinned card right after its dot in the tab order', () => {
    const h = mount(
      history({
        tasks: [
          task('a', 'lead:api', { session_id: 'worker-a' }),
          task('b', 'lead:api', { merged_at: START + 2 * DAY }),
        ],
      }),
    );
    dot(h.value, 'task a').props.onClick();
    h.render();
    focused.length = 0;
    expect(plotKey(h, key('Tab', fake('lead:a'))).prevented).toBe(true);
    expect(plotKey(h, key('Tab', fake(REPLAY), true)).prevented).toBe(true);
    expect(plotKey(h, key('Tab', fake(OPEN_SESSION))).prevented).toBe(true);
    expect(focused).toEqual([REPLAY, 'lead:a', 'lead:b']);
    expect(plotKey(h, key('Tab', fake(REPLAY))).prevented).toBe(false);
  });

  it('draws a diamond above the work lines on each day you made decisions', () => {
    const h = history({
      tasks: [task('a', 'lead:api', { merged_at: START + 10 * DAY })],
      decisions: [
        { at: START + 3 * DAY, lane_id: null, kind: 'plan', title: 'Ship refunds' },
        { at: START + 3 * DAY + 60_000, lane_id: null, kind: 'start' },
      ],
    });
    const marks = nodes(view(h)).filter(
      (n) => n.props.className === 'bd-hs-dec' && n.props.role === 'img',
    );
    expect(marks).toHaveLength(1);
    expect(marks[0]!.props['aria-label']).toContain('9月5日');
    expect(text(marks[0])).toContain('2');
    const l = layout(h);
    expect(l.decisions.map((d) => d.count)).toEqual([2]);
    expect(l.decisions[0]!.x).toBeGreaterThan(LABEL_W);
    expect(l.decisions[0]!.x).toBeLessThan(l.rows[0]!.dots[0]!.x);
  });

  it('keys the chart in the progress section with merged, reworked, in progress, your decisions and milestones', () => {
    const progress = find(view(history()), (n) => n.props['aria-label'] === PROGRESS);
    const legend = find(progress, (n) => n.props['aria-label'] === hz('legend'));
    expect(
      nodes(legend)
        .filter((n) => n.type === 'li')
        .map((n) => text(n)),
    ).toEqual(
      ['merged', 'reworked', 'running', 'decisions', 'milestones'].map((k) => hz(`legend.${k}`)),
    );
  });

  it("shows the project's name, the merged count and a bar split by task state in the progress section", () => {
    useBoard.setState({
      board: {
        cursor: 1,
        projects: [{ id: 'alpha', revision: 1, name: 'Alpha app', roots: ['/work/alpha'] }],
        sessions: [],
      },
    } as never);
    useCurrentProject.setState({ projectId: 'alpha' });
    const h = history({
      tasks: [
        task('a', 'lead:api'),
        task('b', 'lead:api'),
        task('c', 'lead:api', { state: 'running', merged_at: null }),
        task('d', 'lead:api', { state: 'waiting_approval', merged_at: null }),
      ],
      milestones: [{ id: 'v1', title: 'v1', state: 'active', reached_at: null }],
    });
    const progress = find(view(h), (n) => n.props['aria-label'] === PROGRESS);
    expect(text(progress)).toContain('Alpha app');
    expect(text(progress)).toContain('2 / 4');
    expect(text(progress)).toContain(say('milestones', { reached: 0, total: 1 }));
    const bar = find(progress, (n) => n.props.className === 'bd-hs-bar');
    expect(bar.props.role).toBe('img');
    expect(bar.props['aria-label']).toBe('4 个任务：2 已合并，1 运行中，1 等待审批');
    expect(nodes(bar).filter((n) => n.type === 'i')).toHaveLength(3);
  });

  it('leaves the name out of the progress section when no project is chosen', () => {
    const progress = find(
      view(history({ tasks: [task('a', null)] })),
      (n) => n.props['aria-label'] === PROGRESS,
    );
    expect(nodes(progress).some((n) => n.props.className === 'bd-hs-name')).toBe(false);
  });

  it('marks a reached milestone on the chart with the done state icon', () => {
    const h = history({
      milestones: [{ id: 'v1', title: 'v1', state: 'completed', reached_at: START + 30 * DAY }],
    });
    const mark = find(view(h), (n) => n.props.className === 'bd-hs-mk');
    expect(text(mark)).toBe('v1');
    expect(named(mark, 'StatusIcon').props.status).toBe('done');
  });

  it('words the now chip like the milestone marks, leaving the running colour to the now line', () => {
    const css = readFileSync(
      fileURLToPath(new URL('../../apps/web/src/screens/board/history.css', import.meta.url)),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    const declared = (selector: string) =>
      [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
        .filter((m) =>
          m[1]!
            .split(',')
            .map((s) => s.trim())
            .includes(selector),
        )
        .flatMap((m) => m[2]!.split(';').map((d) => d.trim()))
        .filter(Boolean);
    expect(declared('.bd-hs-now')).toEqual(declared('.bd-hs-mk'));
  });

  it("counts a task's rework and retries on its card and leaves out the ones that are zero", () => {
    const h = mount(
      history({
        tasks: [
          task('a', 'lead:api', { handbacks: 2, attempts: 3 }),
          task('b', 'lead:api', { merged_at: START + 2 * DAY }),
        ],
      }),
    );
    expect(text(card(h, 'task a'))).toContain(say('rework', { count: 2 }));
    expect(text(card(h, 'task a'))).toContain(say('retried', { count: 2 }));
    expect(text(card(h, 'task b'))).not.toContain(say('rework', { count: 0 }));
    expect(text(card(h, 'task b'))).not.toContain(say('retried', { count: 0 }));
  });

  it("opens the changes of the task's own session from its card, and offers none without one", () => {
    const opened: [string, string | undefined][] = [];
    const openSession = useShell.getState().openSession;
    useShell.setState({ openSession: (id, tab) => opened.push([id, tab]) });
    try {
      const h = mount(
        history({
          tasks: [
            task('a', 'lead:api', { session_id: 'worker-a' }),
            task('b', 'lead:api', { merged_at: START + 2 * DAY }),
          ],
        }),
      );
      const changes = (tree: unknown) =>
        nodes(tree as never).filter((n) => n.type === 'button' && text(n) === hz('openChanges'));
      changes(card(h, 'task a'))[0]!.props.onClick();
      expect(opened).toEqual([['worker-a', 'changes']]);
      expect(changes(card(h, 'task b'))).toEqual([]);
    } finally {
      useShell.setState({ openSession });
    }
  });

  it('says only the first 2000 tasks show when the history was cut', () => {
    const top = (h: BoardHistory) => text(find(view(h), (n) => n.props.className === 'bd-hs-top'));
    expect(top(history({ truncated: true, tasks: [task('a', null)] }))).toContain(hz('truncated'));
    expect(top(history({ tasks: [task('a', null)] }))).not.toContain('2000');
  });

  it("names the project's first day and how many days it has run", () => {
    const top = find(view(history()), (n) => n.props.className === 'bd-hs-top');
    expect(text(top)).toContain(`9月2日至今，${dayNumber(START, NOW)} 天`);
  });

  it('offers the range as its own control in the board bar, current milestone only while there is one', () => {
    const bar = { nodeType: 1 } as unknown as HTMLElement;
    const shown = mount(history(), [], { bar }).value;
    const portals: { containerInfo: unknown; children: unknown }[] = [];
    const walk = (tree: any): void => {
      if (Array.isArray(tree)) return tree.forEach(walk);
      if (!tree || typeof tree !== 'object') return;
      if ('containerInfo' in tree) portals.push(tree);
      else if ('props' in tree) walk(tree.props.children);
    };
    walk(shown);
    expect(portals.map((p) => p.containerInfo)).toEqual([bar]);
    expect(named(portals[0]!.children as never, 'HistoryRangeControl').props.hasMilestone).toBe(
      false,
    );
    const top = find(shown, (n) => n.props.className === 'bd-hs-top');
    expect(() => named(top, 'HistoryRangeControl')).toThrow();
    const picked: string[] = [];
    const control = (hasMilestone: boolean) =>
      HistoryRangeControl({ value: 'all', onValueChange: (r) => picked.push(r), hasMilestone });
    const radios = (tree: unknown) =>
      nodes(tree as never).filter((n) => n.props.value !== undefined && n.type !== 'div');
    const group = control(false);
    expect(group.props['aria-label']).toBe(hz('range'));
    expect(
      radios(group.props.children).map((n) => [n.props.value, text(n), !!n.props.disabled]),
    ).toEqual([
      ['all', hz('range.all'), false],
      ['month', hz('range.month'), false],
      ['milestone', hz('range.milestone'), true],
    ]);
    expect(radios(control(true).props.children).some((n) => n.props.disabled)).toBe(false);
    group.props.onValueChange('month');
    expect(picked).toEqual(['month']);
  });

  it('marks a milestone not reached yet with a flag at its due day and says how many days are left', () => {
    const h = mount(
      history({ milestones: [{ id: 'v2', title: 'v2', state: 'active', reached_at: null }] }),
      [],
      { milestones: [{ id: 'v2', due_on: dayAfterNow(2) }] },
    ).value;
    const mark = find(h, (n) => n.props.className === 'bd-hs-mk' && text(n) === 'v2');
    expect(nodes(mark).map((n) => (n.type as { displayName?: string }).displayName)).toContain(
      'Flag',
    );
    expect(nodes(h).some((n) => n.props.className === 'bd-hs-due')).toBe(true);
    const sum = find(h, (n) => n.props.className === 'bd-hs-sum');
    expect(text(sum)).toContain(say('daysLeft', { count: 2 }));
    expect(named(sum, 'StatusIcon').props.status).toBe('running');
  });

  it("pins an in-progress pill's card on click and takes its task to the now view from there", () => {
    const picked: string[] = [];
    const h = mount(
      history({ tasks: [task('a', 'lead:api', { state: 'running', merged_at: null })] }),
      [],
      { onOpenTask: (id) => picked.push(id) },
    );
    find(h.value, (n) => n.props.className === 'bd-hs-pill').props.onClick();
    h.render();
    expect(picked).toEqual([]);
    expect(focused.at(-1)).toBe(OPEN_SESSION);
    find(shownCard(h), (n) => n.type === 'button' && text(n) === hz('showNow')).props.onClick();
    expect(picked).toEqual(['lead:a']);
  });

  it("gives the card's buttons the small size and opens the session from a ghost one", () => {
    const h = mount(history({ tasks: [task('a', 'lead:api', { session_id: 'worker-a' })] }));
    const buttons = nodes(card(h, 'task a')).filter((n) => n.type === 'button');
    expect(buttons.map((n) => [text(n), n.props.className])).toEqual([
      [REPLAY, 'btn sm'],
      [hz('openChanges'), 'btn sm'],
      [OPEN_SESSION, 'btn sm ghost'],
    ]);
  });

  it("opens the past runs of the task's own session from its card", () => {
    const shown: (string | null)[] = [];
    const { showRuns, runsView } = useShell.getState();
    useShell.setState({ showRuns: (id) => shown.push(id), runsView: 'now' });
    try {
      const h = mount(history({ tasks: [task('a', 'lead:api', { session_id: 'worker-a' })] }));
      find(card(h, 'task a'), (n) => n.type === 'button' && text(n) === REPLAY).props.onClick();
      expect(shown).toEqual(['worker-a']);
      expect(useShell.getState().runsView).toBe('history');
    } finally {
      useShell.setState({ showRuns, runsView });
    }
  });

  it('counts the weeks the weekly merges cover', () => {
    const days = Array.from({ length: 70 }, (_, i) => ({
      date: dayAfterNow(i - 69),
      merged: 1,
      handbacks: 0,
      decisions: 0,
      failed: 0,
      waited: 0,
    }));
    const sum = find(view(history({ days })), (n) => n.props.className === 'bd-hs-sum');
    expect(text(sum)).toContain('10 周');
  });

  /** The controls the view puts in the board bar. */
  const barControls = (host: HookHost<any>) => {
    const found: unknown[] = [];
    const walk = (tree: any): void => {
      if (Array.isArray(tree)) return tree.forEach(walk);
      if (!tree || typeof tree !== 'object') return;
      if ('containerInfo' in tree) found.push(tree.children);
      else if ('props' in tree) walk(tree.props.children);
    };
    walk(host.value);
    return found[0] as never;
  };
  const withBar = (h: BoardHistory) => mount(h, [], { bar: { nodeType: 1 } as never });

  it('bands the rows by work line, type or model from a control in the board bar', () => {
    const host = withBar(
      history({
        tasks: [
          task('a', 'lead:api', { task_type: 'fix', runtime: 'codex', model: 'gpt-5' }),
          task('b', 'lead:docs', { task_type: 'feature', runtime: 'claude' }),
          task('c', 'lead:api'),
        ],
      }),
    );
    const group = find(barControls(host), (n) => n.props['aria-label'] === BANDS);
    expect(group.props.value).toBe('lanes');
    expect(
      nodes(group.props.children)
        .filter((n) => n.props.value !== undefined)
        .map((n) => [n.props.value, text(n)]),
    ).toEqual([
      ['lanes', hz('bands.lanes')],
      ['type', hz('bands.type')],
      ['model', hz('bands.model')],
    ]);
    const rows = () =>
      nodes(host.value).filter((n) => n.props.className === 'bd-hs-lane' && n.key !== null);
    expect(rows().map((n) => text(find(n, (x) => x.props.className === 'bd-hs-lt')))).toEqual([
      'API',
      'Docs',
    ]);
    group.props.onValueChange('type');
    host.render();
    const types = rows();
    expect(types.map((n) => text(find(n, (x) => x.props.className === 'bd-hs-lt')))).toEqual([
      TASK_TYPE.feature.label,
      TASK_TYPE.fix.label,
      hz('noType'),
    ]);
    expect(nodes(types[0]).some((n) => n.type === TASK_TYPE.feature.icon)).toBe(true);
    find(barControls(host), (n) => n.props['aria-label'] === BANDS).props.onValueChange('model');
    host.render();
    const models = rows();
    expect(models.map((n) => text(find(n, (x) => x.props.className === 'bd-hs-lt')))).toEqual([
      'gpt-5',
      'claude',
      hz('noModel'),
    ]);
    expect(named(models[0], 'RuntimeGlyph').props.runtime).toBe('codex');
  });

  it('dims the tasks off the critical path while its switch is pressed', () => {
    const host = withBar(
      history({
        tasks: [
          task('a', 'lead:api', { merged_at: START + DAY }),
          task('b', 'lead:docs', { merged_at: START + 2 * DAY, depends_on: ['a'] }),
          task('c', 'lead:docs', { merged_at: START + 3 * DAY }),
        ],
      }),
    );
    const toggle = () =>
      find(
        barControls(host),
        (n) => n.type === 'button' && n.props['aria-label'] === hz('critical'),
      );
    expect(toggle().props['aria-pressed']).toBe(false);
    expect(dot(host.value, 'task c').props['data-off']).toBeUndefined();
    toggle().props.onClick();
    host.render();
    expect(toggle().props['aria-pressed']).toBe(true);
    expect(dot(host.value, 'task c').props['data-off']).toBe(true);
    expect(dot(host.value, 'task a').props['data-off']).toBeUndefined();
    const dep = find(host.value, (n) => n.props.className === 'bd-hs-dep');
    expect(dep.props['data-crit']).toBe(true);
  });

  it('draws the dependency curves hidden from assistive technology', () => {
    const tree = view(
      history({
        tasks: [
          task('a', 'lead:api', { merged_at: START + DAY }),
          task('b', 'lead:docs', { merged_at: START + 2 * DAY, depends_on: ['a'] }),
        ],
      }),
    );
    const deps = nodes(tree).filter((n) => n.props.className === 'bd-hs-dep');
    expect(deps).toHaveLength(1);
    expect(
      nodes(tree).some((n) => n.props['aria-hidden'] === 'true' && nodes(n).includes(deps[0]!)),
    ).toBe(true);
  });

  it('words each decision by its kind and merges the ones of a day on one row', () => {
    const tree = view(
      history({
        tasks: [task('a', 'lead:api', { merged_at: START + 10 * DAY })],
        decisions: [
          { at: START + 3 * DAY, lane_id: 'lead:api', kind: 'start', title: 'task a' },
          { at: START + 3 * DAY + 60_000, lane_id: 'lead:api', kind: 'accept', title: 'task a' },
          { at: START + 3 * DAY, lane_id: null, kind: 'plan', title: 'Ship refunds' },
          { at: START + 4 * DAY, lane_id: null, kind: 'start' },
          { at: START + 5 * DAY, lane_id: 'lead:api', kind: 'stop', title: 'task a' },
        ],
      }),
    );
    const marks = nodes(tree).filter(
      (n) => n.props.className === 'bd-hs-dec' && n.props.role === 'img',
    );
    expect(marks.map((n) => n.props['aria-label'])).toEqual([
      '9月5日：开始 task a，验收 task a',
      '9月5日：Ship refunds',
      '9月6日：开始多个任务',
      '9月7日：停止 task a',
    ]);
    expect(text(marks[0])).toContain('2');
    expect(text(marks[1])).not.toContain('1');
  });

  it('marks the days with failed attempts and requests waiting on you, each with its count', () => {
    const tree = view(
      history({
        days: [
          { date: '2026-09-05', merged: 0, handbacks: 0, decisions: 0, failed: 2, waited: 0 },
          { date: '2026-09-06', merged: 0, handbacks: 0, decisions: 0, failed: 0, waited: 3 },
          { date: '2026-09-07', merged: 0, handbacks: 2, decisions: 0, failed: 0, waited: 0 },
        ],
      }),
    );
    const dots = (className: string) =>
      nodes(tree)
        .filter((n) => n.props.className === className)
        .map((n) => [n.props.role, n.props['aria-label']]);
    expect(dots('bd-hs-bad')).toEqual([['img', '9月5日：2 次尝试失败']]);
    expect(dots('bd-hs-wait')).toEqual([['img', '9月6日：3 个请求等你']]);
  });

  it("puts the task's runtime and model on its card's second line, and no such line without them", () => {
    const h = mount(
      history({
        tasks: [
          task('a', 'lead:api', { runtime: 'codex', model: 'gpt-5' }),
          task('b', 'lead:api', { merged_at: START + 2 * DAY }),
        ],
      }),
    );
    const a = card(h, 'task a');
    const lines = a.props.children.filter((n: unknown) => n);
    expect(lines[1].props.className).toBe('bd-hs-rt');
    expect(text(lines[1])).toContain('Codex');
    expect(text(lines[1])).toContain('gpt-5');
    expect(named(lines[1], 'RuntimeGlyph').props.runtime).toBe('codex');
    expect(nodes(card(h, 'task b')).some((n) => n.props.className === 'bd-hs-rt')).toBe(false);
  });

  it("names the rework's reasons on the card, leaving out the ones that are zero", () => {
    const h = mount(
      history({
        tasks: [
          task('a', 'lead:api', {
            handbacks: 3,
            handback_reasons: { gate: 2, review: 1, other: 0 },
          }),
          task('b', 'lead:api', { merged_at: START + 2 * DAY, handbacks: 2 }),
        ],
      }),
    );
    expect(text(card(h, 'task a'))).toContain('返工 3 次：门禁 2 次，审阅退回 1 次');
    expect(text(card(h, 'task a'))).not.toContain(say('reason.other', { count: 0 }));
    expect(text(card(h, 'task b'))).toContain(say('rework', { count: 2 }));
    expect(text(card(h, 'task b'))).not.toContain('：');
  });

  it('shows the first-run gate pass rate with its 10 week line, and no such cell without gate runs', () => {
    const sum = (h: BoardHistory) => find(view(h), (n) => n.props.className === 'bd-hs-sum');
    const shown = sum(
      history({
        tasks: [
          task('a', 'lead:api', { gate_passed_on_attempt: 1, merged_at: NOW - DAY }),
          task('b', 'lead:api', { gate_passed_on_attempt: 2, merged_at: NOW - DAY }),
        ],
        days: quietDays(91),
      }),
    );
    expect(text(shown)).toContain(hz('gate'));
    expect(text(shown)).toContain('50%');
    const line = find(shown, (n) => n.type === 'svg');
    expect(line.props.role).toBe('img');
    expect(line.props['aria-label']).toContain('10 周');
    expect(text(sum(history({ tasks: [task('a', 'lead:api')] })))).not.toContain(hz('gate'));
  });
});

describe('history bands', () => {
  const tasks = [
    task('a', 'lead:api', { task_type: 'fix', runtime: 'codex', model: 'gpt-5' }),
    task('b', 'lead:docs', { task_type: 'feature', runtime: 'claude' }),
    task('c', 'lead:api', { task_type: 'fix', runtime: 'codex', model: 'gpt-5' }),
    task('d', 'lead:api'),
  ];

  it.each([
    [
      'gives each task type a row in the type order and puts tasks without one last',
      'type',
      'laneId',
      [
        ['feature', null, 1],
        ['fix', null, 2],
        ['', null, 1],
      ],
    ],
    [
      'gives each model a row, the runtime standing in for a task without one, and puts tasks with neither last',
      'model',
      'runtime',
      [
        ['gpt-5', 'codex', 2],
        ['claude', 'claude', 1],
        ['', null, 1],
      ],
    ],
  ] as const)('%s', (_, bands, field, expected) => {
    const rows = layout(history({ tasks }), { bands }).rows;
    expect(rows.map((r) => [r.key, r[field], r.total])).toEqual(expected);
  });
});

describe('history dependencies', () => {
  const h = history({
    tasks: [
      task('a', 'lead:api', { merged_at: START + DAY }),
      task('b', 'lead:docs', { merged_at: START + 2 * DAY, depends_on: ['a'] }),
      task('c', 'lead:api', { merged_at: START + 3 * DAY, depends_on: ['b'] }),
      task('d', 'lead:docs', { merged_at: START + 4 * DAY, depends_on: ['a'] }),
      task('e', 'lead:docs', { merged_at: START + 5 * DAY, depends_on: ['d'] }),
      task('f', 'lead:docs', { merged_at: START + 85 * DAY, depends_on: ['a'] }),
    ],
  });

  it('draws a curve between rows, none within a row and none to a task the range leaves out', () => {
    const all = layout(h);
    expect(all.edges.map((e) => e.key)).toEqual([
      'lead:a->lead:b',
      'lead:b->lead:c',
      'lead:a->lead:d',
      'lead:a->lead:f',
    ]);
    const [api, docs] = all.rows;
    expect(all.edges[0]).toMatchObject({ y1: api!.y, y2: docs!.y, critical: false });
    expect(layout(h, { range: 'month' }).edges).toEqual([]);
  });

  it('marks the longest dependency chain only while the switch is on', () => {
    expect(layout(h).critical).toBeNull();
    const on = layout(h, { critical: true });
    expect([...on.critical!]).toEqual(['lead:a', 'lead:b', 'lead:c']);
    expect(on.edges.filter((e) => e.critical).map((e) => e.key)).toEqual([
      'lead:a->lead:b',
      'lead:b->lead:c',
    ]);
  });
});

describe('history decisions', () => {
  const h = history({
    tasks: [task('a', 'lead:api', { merged_at: START + 10 * DAY }), task('b', 'lead:docs')],
    decisions: [
      { at: START + 3 * DAY, lane_id: 'lead:api', kind: 'start', title: 'task a' },
      { at: START + 3 * DAY + 60_000, lane_id: 'lead:api', kind: 'accept', title: 'task a' },
      { at: START + 3 * DAY, lane_id: null, kind: 'plan', title: 'Ship refunds' },
      { at: START + 5 * DAY, lane_id: 'lead:docs', kind: 'stop', title: 'task b' },
    ],
  });

  it("puts a decision over its work line's row, one without a task on the top row, and counts a day's on one row", () => {
    const l = layout(h);
    const [api, docs] = l.rows;
    expect(l.decisions.map((d) => [d.y, d.count])).toEqual([
      [api!.y - 16, 2],
      [TOP + 8, 1],
      [docs!.y - 16, 1],
    ]);
  });

  it('puts every decision on the top row when the rows are not work lines', () => {
    expect(layout(h, { bands: 'type' }).decisions.map((d) => [d.y, d.count])).toEqual([
      [TOP + 8, 3],
      [TOP + 8, 1],
    ]);
  });
});

describe('history failed and waiting days', () => {
  it('marks failed attempts and requests waiting on you by day, and nothing for a day without them', () => {
    const l = layout(
      history({
        days: [
          { date: '2026-09-05', merged: 0, handbacks: 0, decisions: 0, failed: 2, waited: 1 },
          { date: '2026-09-06', merged: 0, handbacks: 3, decisions: 0, failed: 0, waited: 0 },
        ],
      }),
    );
    expect(l.marks.map((m) => [m.kind, m.count])).toEqual([
      ['failed', 2],
      ['waited', 1],
    ]);
    expect(l.marks[0]!.x).toBeLessThan(l.marks[1]!.x);
  });
});

describe('history gate first pass', () => {
  it('shares the tasks whose first gate run passed, overall and by week of their merge', () => {
    const s = historySummary(
      history({
        tasks: [
          task('a', 'lead:api', { gate_passed_on_attempt: 1, merged_at: NOW - DAY }),
          task('b', 'lead:api', { gate_passed_on_attempt: 2, merged_at: NOW - DAY }),
          task('c', 'lead:api', { gate_passed_on_attempt: 1, merged_at: NOW - 17 * DAY }),
          task('d', 'lead:api', { merged_at: NOW - DAY }),
          task('e', 'lead:api', { gate_passed_on_attempt: 1, merged_at: NOW - 200 * DAY }),
        ],
        days: quietDays(91),
      }),
      new Map(),
      NOW,
    );
    expect(s.gate!.share).toBe(0.75);
    expect(s.gate!.weeks).toEqual([null, null, null, null, null, null, null, 1, null, 0.5]);
  });

  it('covers as many weeks as the weekly merges in a project younger than 10 weeks', () => {
    const s = historySummary(
      history({
        tasks: [task('a', 'lead:api', { gate_passed_on_attempt: 1, merged_at: NOW - DAY })],
        days: quietDays(9),
      }),
      new Map(),
      NOW,
    );
    expect(s.weeks).toHaveLength(2);
    expect(s.gate!.weeks).toEqual([null, 1]);
  });

  it('leaves the rate out when no task ran a gate that passed', () => {
    expect(historySummary(history({ tasks: [task('a', null)] }), new Map(), NOW).gate).toBeNull();
  });

  it('breaks the line at a week without data and marks a lone week', () => {
    expect(sparkPath([0, 0.5, null, 1], 30, 28)).toBe('M0 26 L10 14 M30 2 h0');
  });
});
