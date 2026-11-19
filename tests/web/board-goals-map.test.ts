import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  board: {} as any,
  runCommand: (() => {}) as any,
  toast: (() => {}) as any,
}));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'goals-id' }),
);
// The bar's Add goal button is drawn into the bar through a portal; here it stays in the tree.
vi.mock('react-dom', async (actual) => ({
  ...(await actual<object>()),
  createPortal: (node: ReactNode) => node,
}));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign(
    (selector: any) => selector({ openSession() {}, openSessionGroup() {}, openTaskSession() {} }),
    { setState() {} },
  ),
}));
vi.mock('@/data/commands', () => ({
  runCommand: (...args: unknown[]) => mock.runCommand(...args),
}));
vi.mock('@/components/Toast', async (actual) => ({
  ...(await actual<object>()),
  toast: (...args: unknown[]) => mock.toast(...args),
}));
import {
  askMilestone,
  pickTaskScope,
  useAskedMilestone,
  useBoardPage,
  useTaskScope,
  useTaskView,
  type BoardPage,
} from '@/data/board-page';
import { BoardView } from '@/screens/board/BoardScreen';
import { GoalsHead, GoalsSection } from '@/screens/board/GoalsSection';
import { MilestoneAssumptions } from '@/screens/board/MilestoneAssumptions';
import { MilestoneCard } from '@/screens/board/MilestoneCard';
import { dayText } from '@/lib/time-text';
import { zh, zhf } from './i18n-setup.js';

const NOW = Date.UTC(2026, 10, 18, 12);
const noop = () => {};
const BAR = {} as HTMLElement;

type Goal = BoardModel['goals'][number];
type Milestone = BoardModel['milestones'][number];

const ms = (id: string, extra: Partial<Milestone> = {}): Milestone => ({
  id,
  title: `milestone ${id}`,
  session_ids: [],
  merged: 0,
  status: 'active',
  criteria: [],
  owner_session_id: 'lead-1',
  tasks: { done: 1, total: 4 },
  ...extra,
});

const goal = (id: string, extra: Partial<Goal> = {}): Goal => ({
  id,
  text: `goal ${id}`,
  order: 0,
  revision: 2,
  milestone_ids: [],
  milestones: { done: 0, ready: 0, total: 0 },
  tasks: { done: 0, total: 0 },
  needs: 0,
  ...extra,
});

const board = (extra: Partial<BoardModel> = {}): BoardModel => ({
  since: NOW - 7 * 86_400_000,
  now: NOW,
  headline: null,
  counts: {
    running: 0,
    waiting: 0,
    ready: 0,
    failed: 0,
    merged: 0,
    reverted: 0,
    median_ms: null,
    tokens: 0,
    tokens_by_runtime: {},
    cost_usd: null,
  },
  lanes: [],
  tasks: [],
  edges: [],
  milestones: [],
  goals: [],
  burnup: [],
  task_progress: {
    totals: {
      done: 0,
      running: 0,
      waiting: 0,
      idle: 0,
      ready: 0,
      failed: 0,
      discarded: 0,
      not_started: 0,
    },
    daily: [],
    cycle: { median_ms: null, p90_ms: null, sample_count: 0, buckets: [] },
  },
  usage: [],
  models: [],
  merges: [],
  findings: [],
  risks: [],
  ...extra,
});

// Two goals: the first with three milestones and three decisions waiting, the second with none waiting.
const refunds = () =>
  board({
    milestones: [
      ms('ms-api', { status: 'completed', evidence_level: 'accepted', goal_id: 'g-a' }),
      ms('ms-ui', { status: 'ready_for_acceptance', evidence_level: 'gate', goal_id: 'g-a' }),
      ms('ms-roll', { goal_id: 'g-a' }),
      ms('ms-docs', { status: 'completed', evidence_level: 'gate' }),
    ],
    goals: [
      goal('g-a', {
        text: 'Customers refund any payment themselves',
        milestone_ids: ['ms-api', 'ms-ui', 'ms-roll'],
        milestones: { done: 1, ready: 1, total: 3 },
        needs: 3,
      }),
      goal('g-b', { text: 'A refund never pays out twice', order: 1, revision: 5 }),
      goal('g-c', { text: 'Every webhook is signed', order: 2 }),
    ],
  });

const pageProps = (model: BoardModel, over: Partial<Parameters<typeof GoalsSection>[0]> = {}) => ({
  model,
  projectId: 'refunds',
  bar: BAR,
  onOpenNeeds: noop,
  onOpenTasks: noop,
  ...over,
});

const all = (tree: ReactNode, predicate: (n: ReactElement<any>) => boolean) =>
  nodes(tree).filter(predicate);
const labelled = (tree: ReactNode, label: string) =>
  find(tree, (n) => n.props['aria-label'] === label);
const field = (tree: ReactNode, label: string) =>
  find(tree, (n) => n.type === 'textarea' && n.props['aria-label'] === label);
const goalItem = (tree: ReactNode, goalText: string) =>
  find(tree, (n) => n.props.role === 'listitem' && text(n).includes(goalText));
const buttonText = (tree: ReactNode, label: string) =>
  find(
    tree,
    (n) => typeof n.props.onClick === 'function' && text(n) === label && n.type !== 'span',
  );
const milestoneRows = (tree: ReactNode) =>
  all(tree, (n) => n.type === 'button' && text(n).startsWith('milestone '));
const pathOf = (tree: ReactNode) => find(tree, (n) => n.props.className === 'gm-path');
const points = (tree: ReactNode) => all(pathOf(tree), (n) => n.props.className === 'gm-po');
const point = (at: number, title: string, state: string) =>
  zhf('board.goals.point', { at, title, state });
const key = (k: string) => ({
  key: k,
  shiftKey: false,
  preventDefault() {},
  nativeEvent: { isComposing: false },
});

beforeEach(() => {
  mock.board = {
    board: { cursor: 1, projects: [], sessions: [], session_turns: [], workspaces: [] },
    events: [],
    status: { state: 'live' },
    resync: 0,
    refresh() {},
  };
  mock.runCommand = vi.fn(async () => ({ ok: true, value: { revision: 3 } }));
  mock.toast = vi.fn(() => 'toast');
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => stored.set(k, v),
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('goals map', () => {
  it("shows a goal's words, its milestones done and what waits on the user for it", () => {
    const onOpenNeeds = vi.fn();
    const h = mount(() => GoalsSection(pageProps(refunds(), { onOpenNeeds })));
    const first = goalItem(h.value, 'Customers refund any payment themselves');
    expect(text(find(first, (n) => n.props.className === 'gm-n'))).toBe('1 / 3');
    const needs = labelled(first, zhf('board.goals.needs.label', { count: 3 }));
    expect(text(needs)).toBe(zhf('board.goals.needs', { count: 3 }));
    needs.props.onClick();
    expect(onOpenNeeds).toHaveBeenCalledOnce();
    const second = goalItem(h.value, 'A refund never pays out twice');
    expect(text(second)).not.toContain(zhf('board.goals.needs', { count: 0 }));
    expect(text(second)).toContain(zh('board.goals.noMilestones'));
  });

  it("draws a goal's milestones as a path, a point each named by its state, each opening its milestone in the tasks view", () => {
    const onOpenTasks = vi.fn();
    const model = refunds();
    const h = mount(() =>
      GoalsSection(pageProps(model, { onOpenTasks, current: model.milestones[2]! })),
    );
    const goal = goalItem(h.value, 'Customers refund any payment themselves');
    const path = pathOf(goal);
    expect(path.props.role).toBe('group');
    expect(path.props['aria-label']).toBe(
      zhf('board.goals.progress.label', {
        parts: [
          zhf('board.goals.progress.done', { count: 1 }),
          zhf('board.goals.progress.ready', { count: 1 }),
          zhf('board.goals.progress.current', { at: 3 }),
        ].join('，'),
      }),
    );
    const shown = points(goal);
    expect(shown).toHaveLength(3);
    expect(shown.map((p) => p.props['aria-label'])).toEqual([
      point(1, 'milestone ms-api', zh('board.goals.milestone.done')),
      point(2, 'milestone ms-ui', zh('board.goals.milestone.ready')),
      point(3, 'milestone ms-roll', zh('board.goals.milestone.current')),
    ]);
    expect(shown.map((p) => p.props['aria-current'])).toEqual([undefined, undefined, 'step']);
    shown[1]!.props.onClick();
    expect(onOpenTasks).toHaveBeenCalledWith('ms-ui');
  });

  it('calls the milestones after the current one not started, and the current one to accept as both', () => {
    const model = board({
      milestones: [ms('ms-a', { status: 'ready_for_acceptance' }), ms('ms-b'), ms('ms-c')],
      goals: [
        goal('g-a', {
          milestone_ids: ['ms-a', 'ms-b', 'ms-c'],
          milestones: { done: 0, ready: 1, total: 3 },
        }),
      ],
    });
    const h = mount(() => GoalsSection(pageProps(model, { current: model.milestones[0]! })));
    expect(pathOf(h.value).props['aria-label']).toBe(
      zhf('board.goals.progress.label', {
        parts: [
          zhf('board.goals.progress.current', { at: 1 }),
          zhf('board.goals.progress.todo', { count: 2 }),
        ].join('，'),
      }),
    );
    expect(points(h.value).map((p) => p.props['aria-label'])).toEqual([
      point(
        1,
        'milestone ms-a',
        `${zh('board.goals.milestone.current')}，${zh('board.goals.milestone.ready')}`,
      ),
      point(2, 'milestone ms-b', zh('board.goals.milestone.todo')),
      point(3, 'milestone ms-c', zh('board.goals.milestone.todo')),
    ]);
  });

  it('unfolds the current milestone under its goal alone, a cell per task opening it', () => {
    const onOpenTask = vi.fn();
    const tasks = ['a', 'b', 'c'].map((id) => ({
      id: `lead-1:${id}`,
      title: `task ${id}`,
      milestone_id: 'ms-roll',
      status: 'running',
      state: 'running',
      segments: [],
    }));
    const model = { ...refunds(), tasks } as unknown as BoardModel;
    const current = model.milestones[2]!;
    const h = mount(() => GoalsSection(pageProps(model, { current, onOpenTask })));
    const cards = all(h.value, (n) => n.type === MilestoneCard);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.props.milestone).toBe(current);
    expect(nodes(goalItem(h.value, 'Customers refund any payment themselves'))).toContain(cards[0]);
    const out = mount(() => MilestoneCard(cards[0]!.props)).value;
    const grid = find(out, (n) => n.props.className === 'bms-tg');
    expect(grid.props.role).toBe('group');
    const cells = all(grid, (n) => n.props.className === 'bms-tk');
    expect(cells).toHaveLength(3);
    cells[1]!.props.onClick();
    expect(onOpenTask).toHaveBeenCalledWith('lead-1:b');
  });

  it('unfolds a milestone another screen asked for besides the current one, and takes the ask once', () => {
    const model = refunds();
    const current = model.milestones[2]!;
    const unfoldedIds = (tree: ReactNode) =>
      all(tree, (n) => n.type === MilestoneCard).map((n) => n.props.milestone.id);
    askMilestone('refunds', 'ms-api');
    const asked = mount(() => GoalsSection(pageProps(model, { current })));
    expect(unfoldedIds(asked.value)).toEqual(['ms-roll', 'ms-api']);
    expect(mount(() => useAskedMilestone('refunds')).value).toBeNull();
    const again = mount(() => GoalsSection(pageProps(model, { current })));
    expect(unfoldedIds(again.value)).toEqual(['ms-roll']);
    askMilestone('refunds', 'ms-docs');
    const loose = mount(() => GoalsSection(pageProps(model)));
    const none = find(loose.value, (n) => n.props['aria-labelledby'] === 'goals-id-none');
    expect(unfoldedIds(none)).toEqual(['ms-docs']);
  });

  it('only opens the overview for an asked milestone the plan no longer has', () => {
    askMilestone('refunds', 'ms-gone');
    const h = mount(() => GoalsSection(pageProps(refunds())));
    expect(all(h.value, (n) => n.type === MilestoneCard)).toHaveLength(0);
    expect(mount(() => useAskedMilestone('refunds')).value).toBeNull();
  });

  it("puts a flag over the current milestone's point while an assumption of it is open, its popup the assumptions", () => {
    const open = { id: 'a-1', text: 'Refunds settle within a day', affects: [] };
    const settled = { ...open, id: 'a-2', refuted: { state: 'applied', instead: 'Two days' } };
    const flagOf = (assumptions: unknown[]) => {
      const model = refunds();
      const current = { ...model.milestones[2]!, assumptions } as Milestone;
      model.milestones[2] = current;
      const h = mount(() => GoalsSection(pageProps(model, { current })));
      return {
        flag: all(h.value, (n) => n.props.className === 'ib gm-flag')[0],
        block: all(h.value, (n) => n.type === MilestoneAssumptions)[0],
        current,
      };
    };
    const shown = flagOf([open, settled]);
    expect(shown.flag!.props['aria-label']).toBe(
      zhf('board.goals.assumptions', { count: 1, title: 'milestone ms-roll' }),
    );
    expect(shown.block!.props.milestone).toBe(shown.current);
    expect(flagOf([settled]).flag).toBeUndefined();
    expect(flagOf([]).block).toBeUndefined();
  });

  it('groups the milestones of no goal last under No goal', () => {
    const h = mount(() => GoalsSection(pageProps(refunds())));
    const group = find(h.value, (n) => n.props['aria-labelledby'] === 'goals-id-none');
    expect(group.props.role).toBe('group');
    expect(text(group)).toContain(zh('board.goals.noGoal'));
    expect(milestoneRows(group).map((r) => text(r))).toEqual([
      expect.stringContaining('milestone ms-docs'),
    ]);
    const list = labelled(h.value, zh('board.goals.list'));
    expect(nodes(h.value).indexOf(group)).toBeGreaterThan(nodes(h.value).indexOf(list));
  });

  it('offers one sentence and one button without a goal, and keeps the milestones under No goal', () => {
    const model = board({ milestones: [ms('ms-docs')] });
    const h = mount(() => GoalsSection(pageProps(model)));
    expect(text(h.value)).toContain(zh('board.goals.empty'));
    const add = buttonText(h.value, zh('board.goals.add'));
    expect(text(find(h.value, (n) => n.props.role === 'group'))).toContain(
      zh('board.goals.noGoal'),
    );
    add.props.onClick();
    h.render();
    expect(field(h.value, zh('board.goals.new')).props.value).toBe('');
  });

  it('turns Add goal off with the reason once the project has 7 goals', () => {
    const goals = (n: number) =>
      board({ goals: Array.from({ length: n }, (_, i) => goal(`g-${i}`, { order: i })) });
    const six = mount(() => GoalsSection(pageProps(goals(6))));
    expect(buttonText(six.value, zh('board.goals.add')).props.disabled).toBeFalsy();
    const seven = mount(() => GoalsSection(pageProps(goals(7))));
    const add = find(seven.value, (n) => n.type === 'button' && text(n) === zh('board.goals.add'));
    expect(add.props['aria-disabled']).toBe(true);
    expect(add.props.onClick).toBeUndefined();
    expect(text(seven.value)).toContain(zh('board.goals.full'));
  });

  it('adds a goal from the row Add goal opens, and Esc puts the row away', async () => {
    const h = mount(() => GoalsSection(pageProps(refunds())));
    buttonText(h.value, zh('board.goals.add')).props.onClick();
    h.render();
    let input = field(h.value, zh('board.goals.new'));
    input.props.onKeyDown(key('Escape'));
    h.render();
    expect(nodes(h.value).some((n) => n.type === 'textarea')).toBe(false);
    buttonText(h.value, zh('board.goals.add')).props.onClick();
    h.render();
    input = field(h.value, zh('board.goals.new'));
    input.props.onChange({ target: { value: 'Payouts reach merchants the next day' } });
    h.render();
    field(h.value, zh('board.goals.new')).props.onKeyDown(key('Enter'));
    await h.flush();
    expect(mock.runCommand).toHaveBeenCalledWith(
      'goal.set',
      { project_id: 'refunds', text: 'Payouts reach merchants the next day' },
      null,
    );
    expect(nodes(h.value).some((n) => n.type === 'textarea')).toBe(false);
  });

  it('rewrites a goal in place from its words, with its revision', async () => {
    const h = mount(() => GoalsSection(pageProps(refunds())));
    const second = goalItem(h.value, 'A refund never pays out twice');
    buttonText(second, 'A refund never pays out twice').props.onClick();
    h.render();
    const input = field(h.value, zh('board.goals.input'));
    expect(input.props.value).toBe('A refund never pays out twice');
    input.props.onChange({ target: { value: 'A refund never pays out twice, retries included' } });
    h.render();
    field(h.value, zh('board.goals.input')).props.onKeyDown(key('Enter'));
    await h.flush();
    expect(mock.runCommand).toHaveBeenCalledWith(
      'goal.set',
      {
        project_id: 'refunds',
        goal_id: 'g-b',
        text: 'A refund never pays out twice, retries included',
      },
      5,
    );
  });

  it('moves a goal up from its menu and never past the first', async () => {
    const h = mount(() => GoalsSection(pageProps(refunds())));
    const first = goalItem(h.value, 'Customers refund any payment themselves');
    expect(
      find(first, (n) => text(n) === zh('board.goals.moveUp') && 'disabled' in n.props).props
        .disabled,
    ).toBe(true);
    const second = goalItem(h.value, 'A refund never pays out twice');
    buttonText(second, zh('board.goals.moveUp')).props.onClick();
    await h.flush();
    expect(mock.runCommand).toHaveBeenCalledWith(
      'goal.reorder',
      { project_id: 'refunds', goal_ids: ['g-b', 'g-a', 'g-c'] },
      null,
    );
  });

  it('moves a goal to where it is dropped', async () => {
    const h = mount(() => GoalsSection(pageProps(refunds())));
    const grip = labelled(h.value, zhf('board.goals.reorder', { goal: 'Every webhook is signed' }));
    expect(grip.props.draggable).toBe(true);
    const drag = { preventDefault() {}, dataTransfer: { setData() {}, effectAllowed: '' } };
    grip.props.onDragStart(drag);
    h.render();
    const target = goalItem(h.value, 'Customers refund any payment themselves');
    target.props.onDragOver(drag);
    h.render();
    goalItem(h.value, 'Customers refund any payment themselves').props.onDrop(drag);
    await h.flush();
    expect(mock.runCommand).toHaveBeenCalledWith(
      'goal.reorder',
      { project_id: 'refunds', goal_ids: ['g-c', 'g-a', 'g-b'] },
      null,
    );
  });

  it('archives a goal at once and restores it from the notice Undo', async () => {
    const h = mount(() => GoalsSection(pageProps(refunds())));
    const second = goalItem(h.value, 'A refund never pays out twice');
    buttonText(second, zh('board.goals.archive')).props.onClick();
    await h.flush();
    expect(mock.runCommand).toHaveBeenCalledWith('goal.archive', { goal_id: 'g-b' }, 5);
    const notice = mock.toast.mock.calls[0][0];
    expect(notice.title).toBe(
      zhf('board.goals.archived', { goal: 'A refund never pays out twice' }),
    );
    expect(notice.action.label).toBe(zh('board.goals.undo'));
    notice.action.run();
    await h.flush();
    expect(mock.runCommand).toHaveBeenLastCalledWith('goal.restore', { goal_id: 'g-b' }, 3);
  });

  it('says on the row itself that another window changed the goal, from the newest board', async () => {
    let model = refunds();
    mock.runCommand = vi.fn(async () => ({
      ok: false,
      error: { code: 'revision_conflict', message: 'Supply the current aggregate revision' },
    }));
    const h = mount(() => GoalsSection(pageProps(model)));
    buttonText(
      goalItem(h.value, 'A refund never pays out twice'),
      'A refund never pays out twice',
    ).props.onClick();
    h.render();
    field(h.value, zh('board.goals.input')).props.onChange({
      target: { value: 'A refund never pays out twice, even on retries' },
    });
    h.render();
    field(h.value, zh('board.goals.input')).props.onKeyDown(key('Enter'));
    await h.flush();
    // The command refreshed the board; the other window's words arrive with it.
    model = {
      ...model,
      goals: model.goals.map((g) =>
        g.id === 'g-b' ? { ...g, text: 'No refund pays out twice', revision: 6 } : g,
      ),
    };
    h.render();
    const row = goalItem(h.value, 'No refund pays out twice');
    const alert = find(row, (n) => n.props.role === 'alert');
    expect(text(alert)).toContain(
      zhf('board.goals.conflict', { goal: 'No refund pays out twice' }),
    );
    expect(find(row, (n) => n.type === 'textarea').props['aria-invalid']).toBe(true);
    expect(mock.toast).not.toHaveBeenCalled();
    buttonText(row, zh('board.goals.saveMine')).props.onClick();
    await h.flush();
    expect(mock.runCommand).toHaveBeenLastCalledWith(
      'goal.set',
      {
        project_id: 'refunds',
        goal_id: 'g-b',
        text: 'A refund never pays out twice, even on retries',
      },
      6,
    );
  });

  it('shows six milestones of no goal and the rest behind a switch', () => {
    const ids = Array.from({ length: 9 }, (_, i) => `ms-${i}`);
    const model = board({ milestones: ids.map((id) => ms(id)) });
    const h = mount(() => GoalsSection(pageProps(model)));
    expect(milestoneRows(h.value)).toHaveLength(6);
    const more = buttonText(h.value, zhf('board.goals.more', { count: 3 }));
    expect(more.props['aria-expanded']).toBe(false);
    more.props.onClick();
    h.render();
    expect(milestoneRows(h.value)).toHaveLength(9);
  });
});

describe('goals map in the board', () => {
  const view = (page: BoardPage, onPage: (page: BoardPage) => void) => ({
    model: refunds(),
    loading: false,
    error: null,
    onRetry: noop,
    page,
    onPage,
    projectId: 'refunds',
    onOpenSession: noop,
    onOpenStory: noop,
    onOpenTrace: noop,
  });
  const actions = { milestones: [], sessions: [], run: async () => null };
  const asking = {
    source: { table: 'sessions', id: 'lead-1', revision: 1 },
    kind: 'lead.question',
    request_id: 'question-1',
    project_id: 'refunds',
    session_id: 'lead-1',
    status: 'pending',
    created_at: NOW - 60_000,
    reason: 'question',
    actions: [],
    unblocks: 0,
  } as unknown as NonNullable<BoardModel['needs']>[number];
  const task = (id: string, milestone_id: string | null) =>
    ({
      id,
      title: id,
      goal: '',
      scope: [],
      lane_id: null,
      milestone_id,
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
    }) as BoardModel['tasks'][number];

  it('puts the goals on the overview with the current milestone to unfold, and no card of it beside', () => {
    const h = mount(() => BoardView(view('overview', noop)));
    expect(find(h.value, (n) => n.type === GoalsSection).props.current.id).toBe('ms-ui');
    expect(nodes(h.value).some((n) => n.type === MilestoneCard)).toBe(false);
  });

  it("puts the plan's version and the lead's sync in the bar, the goals heading holding neither", () => {
    const onSync = vi.fn();
    const model = {
      ...refunds(),
      leads: [{ session_id: 'lead-1', plan_version: 12, updated_at: NOW }],
    };
    const h = mount(() =>
      BoardView({
        ...view('overview', noop),
        model: model as unknown as BoardModel,
        actions,
        sync: { busy: false, error: null, onSync, since: null },
      } as never),
    );
    const bar = find(h.value, (n) => n.props.className === 'tb-end');
    expect(text(bar)).toContain(
      zhf('board.bar.planAt', { version: 12, time: dayText(NOW, NOW, { time: true }) }),
    );
    find(
      bar,
      (n) => n.type === 'button' && n.props['aria-label'] === zh('board.bar.sync'),
    ).props.onClick();
    expect(onSync).toHaveBeenCalledOnce();
    const head = GoalsHead(find(h.value, (n) => n.type === GoalsHead).props);
    expect(nodes(head).some((n) => n.type === 'button')).toBe(false);
    expect(text(head)).not.toContain('v12');
  });

  it('stays on the overview and puts the needs-you strip in focus from what waits on the user for a goal', () => {
    const onPage = vi.fn();
    const model = { ...refunds(), needs: [asking] };
    const h = mount(() => BoardView({ ...view('overview', onPage), model, actions }));
    expect(named(h.value, 'ProjectNeeds').props.asked).toBe(false);
    find(h.value, (n) => n.type === GoalsSection).props.onOpenNeeds();
    h.render();
    expect(onPage).not.toHaveBeenCalled();
    expect(named(h.value, 'ProjectNeeds').props.asked).toBe(true);
  });

  it("opens the tasks view's flow chart on the tasks of the milestone picked in the goals map", () => {
    pickTaskScope('refunds', 'all');
    const model = {
      ...refunds(),
      tasks: [task('api-task', 'ms-api'), task('roll-task', 'ms-roll'), task('loose', null)],
    };
    let page: BoardPage = 'overview';
    const h = mount(() => BoardView({ ...view(page, (next) => (page = next)), model }));
    find(h.value, (n) => n.type === GoalsSection).props.onOpenTasks('ms-api');
    h.render();
    expect(page).toBe('tasks');
    expect(mount(() => useTaskView('refunds')).value).toBe('flow');
    expect(mount(() => useTaskScope('refunds')).value).toBe('milestone');
    const shown = named(h.value, 'MainView').props.model.tasks.map((t: { id: string }) => t.id);
    expect(shown).toEqual(['api-task']);
  });
});

describe('the view a project opens on', () => {
  it.each([
    ['without goals', 'p-none', board()],
    ['with goals', 'p-goals', refunds()],
  ])('opens the overview of a project %s when nothing is stored', (_name, projectId, model) => {
    const h = mount(() =>
      BoardView({
        model,
        loading: false,
        error: null,
        onRetry: noop,
        page: useBoardPage(projectId),
        onPage: noop,
        projectId,
        onOpenSession: noop,
        onOpenStory: noop,
        onOpenTrace: noop,
      }),
    );
    const tabs = find(h.value, (n) => n.props['aria-label'] === zh('board.view.label'));
    expect(tabs.props.value).toBe('overview');
    expect(nodes(h.value).some((n) => n.type === GoalsSection)).toBe(true);
  });

  it.each<[string, string, string, BoardPage, string]>([
    ['the stored tasks view', 'p-tasks', 'tasks', 'tasks', 'flow'],
    ['the tasks timeline for a stored whole history', 'p-history', 'history', 'tasks', 'timeline'],
    ['the overview for a stored goals view', 'p-goals-stored', 'goals', 'overview', 'flow'],
    ['the overview for a stored now view', 'p-now', 'now', 'overview', 'flow'],
    [
      'the overview for a stored view that no longer exists',
      'p-former',
      'progress',
      'overview',
      'flow',
    ],
  ])('opens %s', (_name, projectId, stored, page, taskView) => {
    localStorage.setItem(`pantheon.board-page.${projectId}`, stored);
    expect(mount(() => useBoardPage(projectId)).value).toBe(page);
    expect(mount(() => useTaskView(projectId)).value).toBe(taskView);
  });

  it('keeps a picked task view over the timeline a stored whole history asks for', () => {
    localStorage.setItem('pantheon.board-page.p-history-list', 'history');
    localStorage.setItem('pantheon.board-task-view.p-history-list', 'list');
    expect(mount(() => useTaskView('p-history-list')).value).toBe('list');
  });
});
