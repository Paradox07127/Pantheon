import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { Menu } from '../../apps/web/node_modules/@base-ui/react/menu/index.mjs';
import type { BoardModel } from '@pantheon/protocol';
import { HookHost, find, named, nodes, text, mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'now-id' }),
);
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
import { pickTaskScope, pickTaskView, useTaskView, type BoardPage } from '@/data/board-page';
import { RunningFor } from '@/components/RunningFor';
import { dayText } from '@/lib/time-text';
import { BoardView } from '@/screens/board/BoardScreen';
import { GoalsHead } from '@/screens/board/GoalsSection';
import { LeadPanel } from '@/screens/board/LeadPanel';
import { MilestoneCard } from '@/screens/board/MilestoneCard';
import type { BoardMilestone, SnapshotMilestone } from '@/screens/board/panels-model';
import { STATUS } from '@/screens/board/status';
import { zh, zhf } from './i18n-setup.js';
import { setupRead } from './setup-fixture.js';

const NOW = Date.UTC(2026, 10, 3, 12);
const HOUR = 3_600_000;
const noop = () => {};

type Task = BoardModel['tasks'][number];
const task = (id: string, extra: Partial<Task> = {}): Task => ({
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
});

type Lead = NonNullable<BoardModel['leads']>[number];
const lead = (session_id: string, extra: Partial<Lead> = {}): Lead => ({
  session_id,
  title: '',
  state: 'running',
  inbox: 0,
  updated_at: NOW,
  ...extra,
});

const milestone: BoardMilestone = {
  id: 'ms-cur',
  title: 'refunds rollout',
  session_ids: [],
  merged: 0,
  status: 'active',
  criteria: [{ text: 'Refunds retry', accepted: false }],
  owner_session_id: 'lead-1',
  tasks: { done: 7, total: 12 },
};

const board = (extra: Partial<BoardModel> = {}): BoardModel => ({
  since: NOW - 7 * 86_400_000,
  now: NOW,
  headline: null,
  counts: {
    running: 1,
    waiting: 0,
    ready: 0,
    failed: 0,
    merged: 0,
    reverted: 0,
    median_ms: null,
    tokens: 0,
    tokens_by_runtime: {},
    previous: { tokens: 0, cost_usd: null, merged: 0, median_ms: null },
    cost_usd: null,
  },
  lanes: [],
  tasks: [task('lead-1:t1', { owner_session_id: 'lead-1', state: 'running' })],
  edges: [],
  milestones: [],
  burnup: [],
  goals: [],
  task_progress: {
    totals: {
      done: 7,
      running: 1,
      waiting: 1,
      idle: 1,
      ready: 1,
      failed: 1,
      discarded: 2,
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

const viewProps = (over: Partial<Parameters<typeof BoardView>[0]>) => ({
  model: board(),
  loading: false,
  error: null,
  onRetry: noop,
  page: 'tasks' as BoardPage,
  onPage: noop,
  onOpenSession: noop,
  onOpenStory: noop,
  onOpenTrace: noop,
  ...over,
});

const names = (tree: ReactNode) =>
  nodes(tree)
    .filter((n) => typeof n.type === 'function')
    .map((n) => (n.type as { name: string }).name);
const labelled = (tree: ReactNode, label: string) =>
  find(tree, (n) => n.props['aria-label'] === label);

let stored: Map<string, string>;
beforeEach(() => {
  mock.board = {
    board: { cursor: 1, projects: [], sessions: [], session_turns: [], workspaces: [] },
    events: [],
    status: { state: 'live' },
    resync: 0,
    refresh() {},
  };
  stored = new Map();
  pickTaskView('project-a', 'flow');
  pickTaskScope('project-a', 'milestone');
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  vi.stubGlobal('window', {
    pantheon: {
      query: vi.fn(() => new Promise(() => {})),
      command: vi.fn(async () => ({ ok: true, value: null })),
    },
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('project board views', () => {
  it('switches between overview and tasks from one segmented control', () => {
    const onPage = vi.fn();
    const h = mount(() => BoardView(viewProps({ projectId: 'project-a', onPage })));
    const views = labelled(h.value, zh('board.view.label'));
    expect(
      nodes(views.props.children)
        .filter((n) => n.props.value !== undefined)
        .map(text),
    ).toEqual([zh('board.view.overview'), zh('board.view.tasks')]);
    views.props.onValueChange('overview');
    expect(onPage).toHaveBeenCalledWith('overview');
  });

  const PANELS = ['TaskList', 'TrendPanel', 'CyclePanel', 'Milestones'];

  it('fills the flow view with the flow chart and leaves the panels out', () => {
    const h = mount(() => BoardView(viewProps({ projectId: 'project-a' })));
    expect(names(h.value)).toContain('MainView');
    for (const panel of PANELS) expect(names(h.value)).not.toContain(panel);
  });

  it('offers the flow chart, the list and the timeline, and draws the one picked', () => {
    const h = mount(() => BoardView(viewProps({ projectId: 'project-a' })));
    const switcher = () => labelled(h.value, zh('board.tasks.view.label'));
    expect(nodes(switcher().props.children).map(text)).toEqual([
      zh('board.tasks.view.flow'),
      zh('board.tasks.view.list'),
      zh('board.tasks.view.timeline'),
    ]);
    expect(switcher().props.value).toBe('flow');

    switcher().props.onValueChange('list');
    h.render();
    expect(switcher().props.value).toBe('list');
    expect(names(h.value)).toContain('TaskList');
    for (const panel of ['MainView', 'HistoryTab', 'TrendPanel', 'CyclePanel', 'Milestones'])
      expect(names(h.value)).not.toContain(panel);

    switcher().props.onValueChange('timeline');
    h.render();
    expect(names(h.value)).toContain('HistoryTab');
    for (const panel of ['MainView', 'TaskList', 'TaskDrawer'])
      expect(names(h.value)).not.toContain(panel);
  });

  it('keeps the view switch and the scope off the overview', () => {
    const h = mount(() => BoardView(viewProps({ projectId: 'project-a', page: 'overview' })));
    for (const label of [zh('board.tasks.view.label'), zh('board.tasks.scope.label')])
      expect(nodes(h.value).some((n) => n.props['aria-label'] === label)).toBe(false);
    for (const part of ['MainView', 'PublishBar', 'NewTask', 'EditButton'])
      expect(names(h.value)).not.toContain(part);
  });

  it('decides from the history read whether a board with nothing in its range has a history', async () => {
    pickTaskView('project-a', 'timeline');
    const counts = { ...board().counts, running: 0 };
    const model = board({ tasks: [], counts });
    const setup = setupRead('none');
    const h = mount(() => BoardView(viewProps({ model, projectId: 'project-a', setup })));
    const tab = named(h.value, 'HistoryTab');
    const history = (tasks: unknown[]) => ({
      started_at: NOW,
      truncated: false,
      tasks,
      days: [],
      decisions: [],
      milestones: [],
      idle: [],
    });
    const shownWith = async (value: unknown) => {
      vi.stubGlobal('window', {
        pantheon: { query: vi.fn(async () => ({ ok: true, value })), command: vi.fn() },
      });
      const out = mount(() => (tab.type as (props: unknown) => ReactNode)(tab.props));
      await out.flush();
      return out.value;
    };
    expect(names(await shownWith(history([{ id: 'removed-task', state: 'removed' }])))).toContain(
      'HistoryView',
    );
    expect(names(await shownWith(history([])))).toContain('ProjectSetup');
  });
});

describe('project board bar', () => {
  it.each(['overview', 'tasks'] as const)(
    'names the plan version of the lead that changed its plan last, in the bar of %s',
    (page) => {
      const model = board({
        leads: [
          lead('lead-1', { updated_at: NOW - HOUR, plan_version: 3 }),
          lead('lead-2', { updated_at: NOW, plan_version: 15 }),
        ],
      });
      const h = mount(() =>
        BoardView(
          viewProps({
            model,
            projectId: 'project-a',
            page,
            sync: { busy: false, error: null, onSync: noop, since: null },
          }),
        ),
      );
      const bar = find(h.value, (n) => n.props.className === 'tb-end');
      expect(text(bar)).toContain('计划 v15');
      expect(text(bar)).not.toContain('计划 v3');
      expect(labelled(bar, zh('board.bar.sync')).type).toBe('button');
      expect(text(bar)).toContain(
        zhf('board.bar.planAt', { version: 15, time: dayText(NOW, NOW, { time: true }) }),
      );
      if (page === 'overview')
        expect(text(GoalsHead(named(h.value, 'GoalsHead').props))).not.toContain('计划');
    },
  );

  it('shows how long the sync has run in place of the plan version while it runs', () => {
    const model = board({ leads: [lead('lead-1', { plan_version: 15 })] });
    const h = mount(() =>
      BoardView(
        viewProps({
          model,
          projectId: 'project-a',
          sync: { busy: true, error: null, onSync: noop, since: NOW - 64_000 },
        }),
      ),
    );
    const bar = find(h.value, (n) => n.props.className === 'tb-end');
    expect(text(bar)).not.toContain('计划 v15');
    expect(find(bar, (n) => n.type === RunningFor).props).toEqual({
      label: zh('components.running.writing'),
      since: NOW - 64_000,
    });
    expect(labelled(bar, zh('board.bar.sync')).props.disabled).toBe(true);
  });

  it('offers the current milestone and all, the current milestone listing its own tasks only', () => {
    const model = board({
      milestones: [milestone],
      tasks: [
        task('lead-1:merged', { state: 'merged', status: 'done', milestone_id: 'ms-cur' }),
        task('lead-1:running', { state: 'running', milestone_id: 'ms-cur' }),
        task('lead-1:later', { state: 'running', milestone_id: 'ms-later' }),
        task('session-loose', { status: 'idle' }),
      ],
    });
    const h = mount(() => BoardView(viewProps({ model, projectId: 'project-a' })));
    const scope = () => labelled(h.value, zh('board.tasks.scope.label'));
    const ids = () => named(h.value, 'MainView').props.model.tasks.map((t: Task) => t.id);
    expect(nodes(scope().props.children).map(text)).toEqual([
      zh('board.tasks.scope.milestone'),
      zh('board.tasks.scope.all'),
    ]);
    expect(scope().props.value).toBe('milestone');
    expect(ids()).toEqual(['lead-1:merged', 'lead-1:running']);

    scope().props.onValueChange('all');
    h.render();
    expect(scope().props.value).toBe('all');
    expect(ids()).toEqual(['lead-1:merged', 'lead-1:running', 'lead-1:later', 'session-loose']);

    pickTaskView('project-a', 'list');
    h.render();
    expect(named(h.value, 'TaskList').props.model.tasks).toHaveLength(4);
    scope().props.onValueChange('milestone');
    h.render();
    expect(named(h.value, 'TaskList').props.model.tasks).toHaveLength(2);
  });

  it("lays out only the current milestone's tasks on the timeline, and the whole history for all", () => {
    pickTaskView('project-a', 'timeline');
    pickTaskScope('project-a', 'milestone');
    const model = board({
      milestones: [milestone],
      tasks: [
        task('lead-1:merged', { state: 'merged', status: 'done', milestone_id: 'ms-cur' }),
        task('lead-1:later', { state: 'running', milestone_id: 'ms-later' }),
      ],
    });
    const h = mount(() => BoardView(viewProps({ model, projectId: 'project-a' })));
    const scope = () => labelled(h.value, zh('board.tasks.scope.label'));
    expect(named(h.value, 'TaskTimelineView').props.model.tasks.map((t: Task) => t.id)).toEqual([
      'lead-1:merged',
    ]);
    expect(names(h.value)).not.toContain('HistoryTab');
    scope().props.onValueChange('all');
    h.render();
    expect(names(h.value)).toContain('HistoryTab');
    expect(names(h.value)).not.toContain('TaskTimelineView');
    expect(text(h.value).split(zh('board.tasks.scope.milestone'))).toHaveLength(2);
  });

  it('lists every task under the current milestone scope while the board has no current milestone', () => {
    const model = board({
      tasks: [task('lead-1:a', { state: 'running' }), task('lead-1:b', { state: 'merged' })],
    });
    const h = mount(() => BoardView(viewProps({ model, projectId: 'project-a' })));
    expect(labelled(h.value, zh('board.tasks.scope.label')).props.value).toBe('milestone');
    expect(named(h.value, 'MainView').props.model.tasks).toHaveLength(2);
  });

  it('keeps every task in the goals and the drawer whatever the scope', () => {
    const model = board({
      milestones: [milestone],
      tasks: [
        task('lead-1:merged', { state: 'merged', status: 'done', milestone_id: 'ms-cur' }),
        task('lead-1:loose', { state: 'running' }),
      ],
    });
    const ids = (el: ReactElement<any>) => el.props.model.tasks.map((t: Task) => t.id);
    const view = (page: BoardPage) =>
      mount(() => BoardView(viewProps({ model, page, projectId: 'project-a' }))).value;
    const tasks = view('tasks');
    expect(ids(named(tasks, 'MainView'))).toEqual(['lead-1:merged']);
    expect(ids(named(tasks, 'TaskDrawer'))).toEqual(['lead-1:merged', 'lead-1:loose']);
    const overview = view('overview');
    expect(ids(named(overview, 'GoalsSection'))).toEqual(['lead-1:merged', 'lead-1:loose']);
    expect(ids(named(overview, 'TaskDrawer'))).toEqual(['lead-1:merged', 'lead-1:loose']);
  });

  it("keeps new task and the lead's sync in the bar and puts baseline and trace in the more menu", () => {
    const onSync = vi.fn();
    const onStart = vi.fn();
    const onOpenTrace = vi.fn();
    const onOpenSession = vi.fn();
    const h = mount(() =>
      BoardView(
        viewProps({
          projectId: 'project-a',
          actions: { milestones: [], sessions: [], run: async () => null },
          sync: { busy: false, error: null, onSync, since: null },
          baseline: {
            link: { label: '摸底 11-03 12:00', session_id: 'baseline-1' },
            start: '重新摸底',
            busy: false,
            error: null,
            onStart,
          },
          onOpenTrace,
          onOpenSession,
        }),
      ),
    );
    const more = find(
      h.value,
      (n) =>
        n.type === Menu.Root &&
        nodes(n.props.children).some((c) => c.props['aria-label'] === zh('board.bar.more')),
    );
    const items = nodes(more.props.children).filter((n) => n.type === Menu.Item);
    expect(items.map(text)).toEqual(['摸底 11-03 12:00', '重新摸底', zh('board.headline.trace')]);
    items.forEach((item) => item.props.onClick());
    expect(onSync).not.toHaveBeenCalled();
    labelled(h.value, zh('board.bar.sync')).props.onClick();
    expect(onSync).toHaveBeenCalledOnce();
    expect(onOpenSession).toHaveBeenCalledWith('baseline-1');
    // The start item opens the model popover first.
    expect(onStart).not.toHaveBeenCalled();
    expect(onOpenTrace).toHaveBeenCalledOnce();
    // Only the menu holds them now.
    const outside = nodes(h.value).filter(
      (n) => n.type === 'button' && ['重新摸底', '摸底 11-03 12:00'].includes(text(n)),
    );
    expect(outside).toHaveLength(0);
    expect(names(h.value)).toContain('NewTask');
    expect(names(more.props.children)).not.toContain('NewTask');
  });

  it('opens the flow chart from new task in the list view', () => {
    const onPage = vi.fn();
    const h = mount(() =>
      BoardView(
        viewProps({
          projectId: 'project-a',
          page: 'tasks',
          onPage,
          actions: { milestones: [], sessions: [], run: async () => null },
        }),
      ),
    );
    pickTaskView('project-a', 'list');
    h.render();
    named(h.value, 'NewTask').props.onNew();
    expect(onPage).not.toHaveBeenCalled();
    expect(mount(() => useTaskView('project-a')).value).toBe('flow');
  });

  it('lays out the overview as since you left, the agents and the goals, each section named', () => {
    const model = board({ milestones: [milestone], leads: [lead('lead-1')] });
    const view = (page: BoardPage) =>
      mount(() => BoardView(viewProps({ model, page, projectId: 'project-a' }))).value;
    const overview = view('overview');
    const parts = names(overview);
    const order = ['BriefCard', 'LeadPanel', 'GoalsSection'];
    for (const part of order) expect(parts).toContain(part);
    expect(order.map((part) => parts.indexOf(part))).toEqual(
      order.map((part) => parts.indexOf(part)).sort((a, b) => a - b),
    );
    const headings = nodes(overview)
      .filter((n) => n.type === 'h2')
      .map(text);
    expect(headings).toEqual(
      expect.arrayContaining([zh('board.overview.agents'), zh('board.overview.goals')]),
    );
    const tasks = names(view('tasks'));
    for (const part of order) expect(tasks).not.toContain(part);
  });

  it('leaves the agents out of an overview with no lead', () => {
    const h = mount(() => BoardView(viewProps({ projectId: 'project-a', page: 'overview' })));
    expect(names(h.value)).not.toContain('LeadPanel');
    expect(text(h.value)).not.toContain(zh('board.overview.agents'));
  });

  it('lets the flow chart take the height of the requirement bar and give it back, collapsed again on another project', () => {
    let projectId = 'project-a';
    const model = board({ leads: [lead('lead-1')] });
    const actions = { milestones: [], sessions: [], run: async () => null };
    const h = mount(() => BoardView(viewProps({ model, projectId, actions })));
    const expand = () => named(h.value, 'MainView').props.expand;
    const bar = () => names(h.value).includes('PublishBar');
    expect(expand().on).toBe(false);
    expect(bar()).toBe(true);
    expand().onToggle();
    h.render();
    expect(expand().on).toBe(true);
    expect(bar()).toBe(false);
    expand().onToggle();
    h.render();
    expect(expand().on).toBe(false);
    expect(bar()).toBe(true);
    expand().onToggle();
    h.render();
    projectId = 'project-b';
    h.render();
    expect(expand().on).toBe(false);
    expect(bar()).toBe(true);
  });

  it('puts the requirement bar under the flow chart, whose replay bar it follows', () => {
    const model = board({ leads: [lead('lead-1')] });
    const actions = { milestones: [], sessions: [], run: async () => null };
    const parts = names(
      mount(() => BoardView(viewProps({ model, projectId: 'project-a', actions }))).value,
    );
    expect(parts.indexOf('MainView')).toBeGreaterThanOrEqual(0);
    expect(parts.indexOf('PublishBar')).toBeGreaterThan(parts.indexOf('MainView'));
  });

  it('takes a jump to a needs-you row from the flow chart and the drawer to the overview', () => {
    const onPage = vi.fn();
    const actions = { milestones: [], sessions: [], run: async () => null };
    const h = mount(() => BoardView(viewProps({ projectId: 'project-a', actions, onPage })));
    named(h.value, 'MainView').props.onAskNeed('approval-1');
    expect(onPage).toHaveBeenCalledWith('overview');
    named(h.value, 'TaskDrawer').props.onAskNeed('approval-1');
    expect(onPage).toHaveBeenCalledTimes(2);
  });

  it('lists what needs the user under the since-you-left card on the overview, and nothing when nothing does', () => {
    const actions = { milestones: [], sessions: [], run: async () => null };
    const waiting = {
      source: { table: 'approvals', id: 'approval-1', revision: 1 },
      kind: 'permission',
      project_id: 'project-a',
      session_id: 'worker-1',
      status: 'pending',
      created_at: NOW - 60_000,
      reason: 'permission_requested',
      actions: [{ command: 'approval.respond', allowed: true }],
      unblocks: 0,
    } as unknown as NonNullable<BoardModel['needs']>[number];
    const view = (needs: NonNullable<BoardModel['needs']>, page: BoardPage = 'overview') =>
      mount(() =>
        BoardView(viewProps({ model: board({ needs }), page, projectId: 'project-a', actions })),
      ).value;
    const listed = view([waiting]);
    const parts = names(listed);
    expect(parts).not.toContain('PublishBar');
    expect(parts.indexOf('BriefCard')).toBeGreaterThanOrEqual(0);
    expect(parts.indexOf('BriefCard')).toBeLessThan(parts.indexOf('ProjectNeeds'));
    const strip = named(listed, 'ProjectNeeds');
    expect(strip.props.model.needs).toEqual([waiting]);
    expect(strip.props.run).toBe(actions.run);
    expect(names(view([]))).not.toContain('ProjectNeeds');
    expect(names(view([waiting], 'tasks'))).not.toContain('ProjectNeeds');
  });
});

describe('milestone line', () => {
  it('draws a cell per task of the milestone alone, the grid naming each state with its count', () => {
    const own = { ...milestone, tasks: { done: 3, total: 6 } };
    const states = [
      ['lead-1:merged', 'done'],
      ['lead-1:run-a', 'running'],
      ['lead-1:run-b', 'running'],
      ['lead-1:next', 'todo'],
      ['lead-1:other', 'waiting', 'ms-later'],
      ['lead-1:loose', 'failed', null],
    ];
    const model = board({
      milestones: [own],
      tasks: states.map(([id, status, ms = 'ms-cur']) =>
        task(id!, { milestone_id: ms, status: status as Task['status'] }),
      ),
    });
    const out = new HookHost(() =>
      MilestoneCard({ model, milestone: own, onOpenTask: noop }),
    ).render();
    const grid = find(out, (n) => n.props.className === 'bms-tg');
    const label = (status: Task['status']) => STATUS[status].label;
    expect(grid.props['aria-label']).toBe(
      zhf('board.plan.milestone.bar', {
        count: 4,
        parts: [
          zhf('board.overview.statePart', { state: label('done'), count: 1 }),
          zhf('board.overview.statePart', { state: label('running'), count: 2 }),
          zhf('board.overview.statePart', { state: label('todo'), count: 1 }),
        ].join('，'),
      }),
    );
    expect(
      nodes(grid)
        .filter((n) => n.props.className === 'bms-tk')
        .map((n) => n.key),
    ).toEqual(['lead-1:merged', 'lead-1:run-a', 'lead-1:run-b', 'lead-1:next']);
  });
  it('keeps the acceptance, criteria and due date behind the button that ends the line, the task cells under it', () => {
    const stored = {
      id: 'ms-cur',
      revision: 2,
      project_id: 'project-a',
      title: 'refunds rollout',
      required_sessions: [],
      criteria: ['Refunds retry'],
      created_at: NOW,
      updated_by: 'user',
      owner_session_id: 'lead-1',
      key: 'refunds',
    } as SnapshotMilestone;
    const model = board({
      milestones: [milestone],
      tasks: [task('lead-1:t1', { milestone_id: 'ms-cur', state: 'running' })],
    });
    const out = new HookHost(() =>
      MilestoneCard({
        model,
        milestone,
        actions: {
          projectId: 'project-a',
          milestones: [stored],
          sessions: [],
          run: async () => null,
        },
        onOpenTask: noop,
      }),
    ).render();
    expect(nodes(find(out, (n) => n.type === 'h2').props.children)).toHaveLength(0);
    const details = find(out, (n) => n.props.className === 'pop bms-pop');
    const inside = (predicate: (n: ReactElement<any>) => boolean) =>
      nodes(details.props.children).some(predicate);
    expect(inside((n) => n.props['aria-label'] === '验收 refunds rollout')).toBe(true);
    expect(inside((n) => n.props['aria-label'] === zh('board.plan.milestone.criteria'))).toBe(true);
    expect(
      inside(
        (n) => n.type === 'input' && n.props['aria-label'] === zh('board.plan.milestone.dueOn'),
      ),
    ).toBe(true);
    expect(inside((n) => n.props.className === 'bms-tk')).toBe(false);
    expect(nodes(out).filter((n) => n.props.className === 'bms-tk')).toHaveLength(1);
  });
});

describe('lead line', () => {
  it('shows the runtime, its name opening it, a state glyph and what the lead does', () => {
    const onOpenSession = vi.fn();
    const out = new HookHost(() =>
      LeadPanel({
        model: board({
          leads: [
            lead('lead-a', {
              title: 'plan lead',
              activity: {
                phase: 'tool',
                since: NOW - 5 * 60_000,
                tool: { name: 'Bash', target: 'pnpm test' },
                health: 'fresh',
                attempt: 1,
              },
            }),
          ],
        }),
        sessions: [{ id: 'lead-a', runtime: 'claude' } as never],
        onOpenSession,
        onOpenTask() {},
      }),
    ).render();
    expect(named(out, 'RuntimeGlyph').props.runtime).toBe('claude');
    expect(named(out, 'StateGlyph').props.name).toBe('running');
    expect(text(find(out, (n) => n.props.className === 'bld-do'))).toBe(
      zhf('board.task.activity.toolTarget', {
        tool: zh('runs.table.verb.run'),
        target: 'pnpm test',
      }),
    );
    const open = find(out, (n) => n.type === 'button');
    expect(text(open)).toBe('plan lead');
    open.props.onClick();
    expect(onOpenSession).toHaveBeenCalledWith('lead-a');
  });

  it('shows a lead whose question waits for the user as awaiting an answer, with the question', () => {
    const asked = {
      source: { table: 'board_plans', id: 'lead-a', revision: 3 },
      kind: 'lead.question',
      project_id: 'project-a',
      session_id: 'lead-a',
      request_id: 'question-1',
      status: 'pending',
      created_at: NOW - HOUR,
      reason: 'lead_question',
      question: {
        id: 'question-1',
        at: NOW - HOUR,
        question: 'Where do sessions live?',
        options: ['SQLite', 'Files'],
        recommended: 'Files',
        assumption: 'sessions stay in SQLite',
        blocks: [],
      },
      actions: [],
      unblocks: 0,
    } as unknown as NonNullable<BoardModel['needs']>[number];
    const out = new HookHost(() =>
      LeadPanel({
        model: board({
          leads: [
            lead('lead-a', {
              state: 'idle',
              activity: { phase: 'idle', since: NOW - HOUR, health: 'fresh', attempt: 1 },
            }),
          ],
          needs: [asked],
        }),
        sessions: [],
        onOpenSession() {},
        onOpenTask() {},
      }),
    ).render();
    expect(named(out, 'StateGlyph').props.name).toBe('question');
    expect(text(find(out, (n) => n.props.className === 'bld-do'))).toBe('Where do sessions live?');
    expect(find(out, (n) => n.type === 'button').props['aria-label']).toBe(
      zhf('board.frame.lead.label', {
        name: zh('board.lead.untitled'),
        state: zh('board.leadStates.waiting'),
      }),
    );
  });

  it('shows each lead its plan title when the board has several', () => {
    const out = new HookHost(() =>
      LeadPanel({
        model: board({
          leads: [
            lead('lead-a', { title: 'refunds plan', state: 'idle' }),
            lead('lead-b', { title: 'billing plan', state: 'idle' }),
          ],
        }),
        sessions: [],
        onOpenSession() {},
        onOpenTask() {},
      }),
    ).render();
    const rows = nodes(out).filter((n) => n.props.className === 'bld-i');
    expect(rows.map((row) => text(find(row, (n) => n.props.className === 'bld-t')))).toEqual([
      'refunds plan',
      'billing plan',
    ]);
  });
});
