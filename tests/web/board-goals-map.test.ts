import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';
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
import { useBoardPage, type BoardPage } from '@/data/board-page';
import { BoardView } from '@/screens/board/BoardScreen';
import { EvidenceMark } from '@/screens/board/EvidenceMark';
import { GoalsPage } from '@/screens/board/GoalsPage';
import { MilestoneCard } from '@/screens/board/MilestoneCard';
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

const pageProps = (model: BoardModel, over: Partial<Parameters<typeof GoalsPage>[0]> = {}) => ({
  model,
  projectId: 'refunds',
  bar: BAR,
  onOpenNeeds: noop,
  onOpenNow: noop,
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
  it("shows a goal's words, its milestone progress and what waits on the user for it", () => {
    const onOpenNeeds = vi.fn();
    const h = mount(() => GoalsPage(pageProps(refunds(), { onOpenNeeds })));
    const first = goalItem(h.value, 'Customers refund any payment themselves');
    const progress = find(first, (n) => n.props.role === 'progressbar');
    expect([progress.props['aria-valuenow'], progress.props['aria-valuemax']]).toEqual([1, 3]);
    expect(text(first)).toContain('1 / 3');
    const needs = labelled(first, zhf('board.goals.needs.label', { count: 3 }));
    expect(text(needs)).toBe(zhf('board.goals.needs', { count: 3 }));
    needs.props.onClick();
    expect(onOpenNeeds).toHaveBeenCalledOnce();
    const second = goalItem(h.value, 'A refund never pays out twice');
    expect(text(second)).not.toContain(zhf('board.goals.needs', { count: 0 }));
    expect(text(second)).toContain(zh('board.goals.noMilestones'));
  });

  it("lists a goal's milestones with their state and evidence, and opens one in the now view", () => {
    const onOpenNow = vi.fn();
    const h = mount(() => GoalsPage(pageProps(refunds(), { onOpenNow })));
    const rows = milestoneRows(goalItem(h.value, 'Customers refund any payment themselves'));
    expect(rows.map((r) => text(r))).toEqual([
      expect.stringContaining('milestone ms-api'),
      expect.stringContaining('milestone ms-ui'),
      expect.stringContaining('milestone ms-roll'),
    ]);
    const levels = rows.map(
      (r) => all(r, (n) => n.type === EvidenceMark)[0]?.props.level as string | undefined,
    );
    expect(levels).toEqual(['accepted', 'gate', undefined]);
    expect(labelled(rows[0], zh('board.goals.milestone.done'))).toBeTruthy();
    expect(labelled(rows[1], zh('board.goals.milestone.ready'))).toBeTruthy();
    expect(labelled(rows[2], zh('board.goals.milestone.active'))).toBeTruthy();
    rows[1]!.props.onClick();
    expect(onOpenNow).toHaveBeenCalledWith('ms-ui');
  });

  it('groups the milestones of no goal last under No goal', () => {
    const h = mount(() => GoalsPage(pageProps(refunds())));
    const group = find(h.value, (n) => n.props.role === 'group');
    expect(text(group)).toContain(zh('board.goals.noGoal'));
    expect(milestoneRows(group).map((r) => text(r))).toEqual([
      expect.stringContaining('milestone ms-docs'),
    ]);
    const list = labelled(h.value, zh('board.goals.list'));
    expect(nodes(h.value).indexOf(group)).toBeGreaterThan(nodes(h.value).indexOf(list));
  });

  it('offers one sentence and one button without a goal, and keeps the milestones under No goal', () => {
    const model = board({ milestones: [ms('ms-docs')] });
    const h = mount(() => GoalsPage(pageProps(model)));
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
    const six = mount(() => GoalsPage(pageProps(goals(6))));
    expect(buttonText(six.value, zh('board.goals.add')).props.disabled).toBeFalsy();
    const seven = mount(() => GoalsPage(pageProps(goals(7))));
    const add = find(seven.value, (n) => n.type === 'button' && text(n) === zh('board.goals.add'));
    expect(add.props['aria-disabled']).toBe(true);
    expect(add.props.onClick).toBeUndefined();
    expect(text(seven.value)).toContain(zh('board.goals.full'));
  });

  it('adds a goal from the row Add goal opens, and Esc puts the row away', async () => {
    const h = mount(() => GoalsPage(pageProps(refunds())));
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
    const h = mount(() => GoalsPage(pageProps(refunds())));
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
    const h = mount(() => GoalsPage(pageProps(refunds())));
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
    const h = mount(() => GoalsPage(pageProps(refunds())));
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
    const h = mount(() => GoalsPage(pageProps(refunds())));
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
    const h = mount(() => GoalsPage(pageProps(model)));
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

  it('shows six milestones of a goal and the rest behind a switch', () => {
    const ids = Array.from({ length: 9 }, (_, i) => `ms-${i}`);
    const model = board({
      milestones: ids.map((id) => ms(id, { goal_id: 'g-a' })),
      goals: [goal('g-a', { milestone_ids: ids, milestones: { done: 0, ready: 0, total: 9 } })],
    });
    const h = mount(() => GoalsPage(pageProps(model)));
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
    range: 7 as const,
    onRange: noop,
    page,
    onPage,
    projectId: 'refunds',
    onOpenSession: noop,
    onOpenStory: noop,
    onOpenTrace: noop,
  });

  it('draws no view before the board read decides which one the project opens on', () => {
    const h = mount(() => BoardView({ ...view('goals', noop), page: null }));
    expect(find(h.value, (n) => n.props['aria-label'] === zh('board.view.label')).props.value).toBe(
      null,
    );
    expect(nodes(h.value).some((n) => n.type === GoalsPage || n.type === MilestoneCard)).toBe(
      false,
    );
    expect(find(h.value, (n) => n.props['aria-busy'] === 'true')).toBeTruthy();
  });

  it('opens the now view from what waits on the user for a goal', () => {
    const onPage = vi.fn();
    const h = mount(() => BoardView(view('goals', onPage)));
    find(h.value, (n) => n.type === GoalsPage).props.onOpenNeeds();
    expect(onPage).toHaveBeenCalledWith('now');
  });

  it('opens the now view on the milestone picked in the goals map', () => {
    let page: BoardPage = 'goals';
    const h = mount(() => BoardView(view(page, (next) => (page = next))));
    find(h.value, (n) => n.type === GoalsPage).props.onOpenNow('ms-api');
    h.render();
    expect(page).toBe('now');
    expect(find(h.value, (n) => n.type === MilestoneCard).props.milestone.id).toBe('ms-api');
  });
});

describe('the view a project opens on', () => {
  it.each<[string, string, string | null, boolean, BoardPage]>([
    ['the now view for a project without goals', 'p-none', null, false, 'now'],
    ['the goals view for a project with goals', 'p-goals', null, true, 'goals'],
    ['the stored view over the default', 'p-stored', 'history', true, 'history'],
    ['a stored goals view on a project without goals', 'p-stored-goals', 'goals', false, 'goals'],
    ['the default for a stored view that no longer exists', 'p-former', 'progress', true, 'goals'],
  ])('opens %s', (_name, projectId, stored, hasGoals, page) => {
    if (stored) localStorage.setItem(`pantheon.board-page.${projectId}`, stored);
    expect(mount(() => useBoardPage(projectId, hasGoals)).value).toBe(page);
  });

  it('waits for the board read, then keeps the view it landed on', () => {
    let hasGoals: boolean | null = null;
    const h = mount(() => useBoardPage('p-wait', hasGoals));
    expect(h.value).toBeNull();
    hasGoals = true;
    h.render();
    expect(h.value).toBe('goals');
    hasGoals = false;
    h.render();
    expect(h.value).toBe('goals');
  });
});
