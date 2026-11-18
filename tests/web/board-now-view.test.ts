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
import { readBoardPage } from '@/data/board-page';
import { BoardView } from '@/screens/board/BoardScreen';
import { LeadPanel } from '@/screens/board/LeadPanel';
import { MilestoneCard } from '@/screens/board/MilestoneCard';
import { readCanvasOrder, saveCanvasOrder } from '@/screens/board/panel-layout';
import type { BoardMilestone, SnapshotMilestone } from '@/screens/board/panels-model';
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
  range: 7 as const,
  onRange: noop,
  page: 'now' as const,
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
  it('reads a stored view back and opens the now view for anything else', () => {
    for (const key of ['goals', 'now', 'history', 'canvas']) expect(readBoardPage(key)).toBe(key);
    for (const raw of [null, '', 'progress', 'milestones', 'quality', 'intro', 'memory'])
      expect(readBoardPage(raw)).toBe('now');
  });

  it('switches between goals, now, whole history and canvas from one segmented control', () => {
    const onPage = vi.fn();
    const h = mount(() => BoardView(viewProps({ projectId: 'project-a', onPage })));
    const views = labelled(h.value, zh('board.view.label'));
    expect(
      nodes(views.props.children)
        .filter((n) => n.props.value !== undefined)
        .map(text),
    ).toEqual([
      zh('board.view.goals'),
      zh('board.history.span.now'),
      zh('board.history.span.history'),
      zh('board.view.canvas'),
    ]);
    views.props.onValueChange('canvas');
    expect(onPage).toHaveBeenCalledWith('canvas');
  });

  const PANELS = ['ProgressTable', 'TrendPanel', 'CyclePanel', 'StallPanel', 'Milestones'];

  it('fills the now view with the flow chart and leaves the panel grid out', () => {
    const h = mount(() => BoardView(viewProps({ projectId: 'project-a', page: 'now' })));
    expect(names(h.value)).toContain('MainView');
    for (const panel of [...PANELS, 'RisksPanel']) expect(names(h.value)).not.toContain(panel);
  });

  it('hands the other panels to the canvas view, which lays them out with the pinned visuals', () => {
    const h = mount(() => BoardView(viewProps({ projectId: 'project-a', page: 'canvas' })));
    const canvas = named(h.value, 'CanvasView');
    const shown = canvas.props.panels.flatMap((p: { node: ReactNode }) => names(p.node));
    for (const panel of [...PANELS, 'RisksPanel']) expect(shown).toContain(panel);
    expect(names(h.value)).not.toContain('MainView');
    expect(names(h.value)).not.toContain('PanelMenu');
  });

  it('shows the whole history in the history view', () => {
    const h = mount(() => BoardView(viewProps({ projectId: 'project-a', page: 'history' })));
    expect(names(h.value)).toContain('HistoryTab');
    expect(names(h.value)).not.toContain('MainView');
  });

  it('decides from the history read whether a board with nothing in its range has a history', async () => {
    const counts = { ...board().counts, running: 0 };
    const model = board({ tasks: [], counts });
    const setup = setupRead('none');
    const h = mount(() =>
      BoardView(viewProps({ model, projectId: 'project-a', page: 'history', setup })),
    );
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
  it('names the plan version of the lead that changed its plan last', () => {
    const model = board({
      leads: [
        lead('lead-1', { updated_at: NOW - HOUR, plan_version: 3 }),
        lead('lead-2', { updated_at: NOW, plan_version: 15 }),
      ],
    });
    const h = mount(() => BoardView(viewProps({ model, projectId: 'project-a' })));
    expect(text(h.value)).toContain('计划 v15');
    expect(text(h.value)).not.toContain('计划 v3');
  });

  it('offers in progress and the last 3 and 7 days, in progress leaving the ended tasks out', () => {
    const onRange = vi.fn();
    const model = board({
      tasks: [
        task('lead-1:merged', { state: 'merged', status: 'done' }),
        task('lead-1:failed', { state: 'failed', status: 'failed' }),
        task('lead-1:running', { state: 'running' }),
        task('session-done', { status: 'done' }),
        task('session-discarded', { status: 'discarded' }),
        task('session-idle', { status: 'idle' }),
      ],
    });
    let range: 'active' | 7 = 7;
    const h = mount(() => BoardView(viewProps({ model, range, onRange, projectId: 'project-a' })));
    const ranges = labelled(h.value, zh('board.headline.range'));
    expect(nodes(ranges.props.children).map(text)).toEqual([
      zh('board.ranges.active'),
      zhf('board.ranges.last', { days: 3 }),
      zhf('board.ranges.last', { days: 7 }),
    ]);
    ranges.props.onValueChange('active');
    expect(onRange).toHaveBeenCalledWith('active');
    expect(named(h.value, 'MainView').props.model.tasks).toHaveLength(6);

    range = 'active';
    h.render();
    expect(named(h.value, 'MainView').props.model.tasks.map((t: Task) => t.id)).toEqual([
      'lead-1:failed',
      'lead-1:running',
      'session-idle',
    ]);
  });

  it('keeps the ended tasks in the milestone, the drawer and the milestones panel under in progress', () => {
    const model = board({
      milestones: [milestone],
      tasks: [
        task('lead-1:merged', { state: 'merged', status: 'done', milestone_id: 'ms-cur' }),
        task('lead-1:running', { state: 'running', milestone_id: 'ms-cur' }),
      ],
    });
    const ids = (el: ReactElement<any>) => el.props.model.tasks.map((t: Task) => t.id);
    const view = (page: 'now' | 'canvas') =>
      mount(() => BoardView(viewProps({ model, range: 'active', page, projectId: 'project-a' })));
    const now = view('now');
    expect(ids(named(now.value, 'MainView'))).toEqual(['lead-1:running']);
    expect(ids(named(now.value, 'MilestoneCard'))).toEqual(['lead-1:merged', 'lead-1:running']);
    expect(ids(named(now.value, 'TaskDrawer'))).toEqual(['lead-1:merged', 'lead-1:running']);
    const canvas = named(view('canvas').value, 'CanvasView');
    const panels = canvas.props.panels.map((p: { node: ReactNode }) => p.node);
    expect(ids(named(panels, 'Milestones'))).toEqual(['lead-1:merged', 'lead-1:running']);
  });

  it('offers the layout reset after a canvas reorder alone, and the reset puts the order back', () => {
    saveCanvasOrder('reordered', ['trend', 'table', 'cycle', 'stall', 'milestones', 'risks']);
    const h = mount(() => BoardView(viewProps({ page: 'canvas', projectId: 'reordered' })));
    const menu = named(h.value, 'HiddenMenu');
    const reset = (menu.type as (props: unknown) => ReactElement<any>)(menu.props);
    expect(text(reset)).toBe(zh('board.layout.reset'));
    reset.props.onClick();
    expect(readCanvasOrder('reordered')).toEqual([]);
    h.render();
    expect(names(h.value)).not.toContain('HiddenMenu');
  });

  it('keeps new task in the bar and puts update, baseline and trace in the more menu', () => {
    const onSync = vi.fn();
    const onStart = vi.fn();
    const onOpenTrace = vi.fn();
    const onOpenSession = vi.fn();
    const h = mount(() =>
      BoardView(
        viewProps({
          projectId: 'project-a',
          actions: { milestones: [], sessions: [], run: async () => null },
          sync: { busy: false, error: null, onSync },
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
    expect(items.map(text)).toEqual([
      zh('board.headline.sync'),
      '摸底 11-03 12:00',
      '重新摸底',
      zh('board.headline.trace'),
    ]);
    items.forEach((item) => item.props.onClick());
    expect(onSync).toHaveBeenCalledOnce();
    expect(onOpenSession).toHaveBeenCalledWith('baseline-1');
    // The start item opens the model popover first.
    expect(onStart).not.toHaveBeenCalled();
    expect(onOpenTrace).toHaveBeenCalledOnce();
    // Only the menu holds them now.
    const outside = nodes(h.value).filter(
      (n) =>
        n.type === 'button' &&
        [zh('board.headline.sync'), '重新摸底', '摸底 11-03 12:00'].includes(text(n)),
    );
    expect(outside).toHaveLength(0);
    expect(names(h.value)).toContain('NewTask');
    expect(names(more.props.children)).not.toContain('NewTask');
  });

  it('puts the since-you-left card above the strip of the milestone and the leads, in the now view only', () => {
    const model = board({ milestones: [milestone], leads: [lead('lead-1')] });
    const view = (page: 'now' | 'canvas') =>
      mount(() => BoardView(viewProps({ model, page, projectId: 'project-a' }))).value;
    const strip = (tree: ReactNode) =>
      nodes(tree).find((n) => n.props['aria-label'] === zh('board.strip.label'));
    const now = view('now');
    expect(names(strip(now))).toEqual(expect.arrayContaining(['MilestoneCard', 'LeadPanel']));
    expect(names(strip(now))).not.toContain('BriefCard');
    const parts = names(now);
    expect(parts).toContain('BriefCard');
    expect(parts.indexOf('BriefCard')).toBeLessThan(parts.indexOf('MilestoneCard'));
    const canvas = view('canvas');
    expect(strip(canvas)).toBeUndefined();
    expect(names(canvas)).not.toContain('BriefCard');
  });

  it('lets the flow chart take the height of the strips above and give it back, collapsed again on another project', () => {
    let projectId = 'project-a';
    const model = board({ milestones: [milestone], leads: [lead('lead-1')] });
    const h = mount(() => BoardView(viewProps({ model, projectId })));
    const expand = () => named(h.value, 'MainView').props.expand;
    // The element that holds the since-you-left card and the strip of the milestone and the leads.
    const strips = () =>
      find(
        h.value,
        (n) =>
          typeof n.type === 'string' &&
          [n.props.children].flat().some((c) => c?.type?.name === 'BriefCard') &&
          [n.props.children]
            .flat()
            .some((c) => c?.props?.['aria-label'] === zh('board.strip.label')),
      ).props.hidden;
    expect(expand().on).toBe(false);
    expect(strips()).toBe(false);
    expand().onToggle();
    h.render();
    expect(expand().on).toBe(true);
    expect(strips()).toBe(true);
    expect(names(h.value)).toContain('NowSummary');
    expand().onToggle();
    h.render();
    expect(expand().on).toBe(false);
    expect(strips()).toBe(false);
    expand().onToggle();
    h.render();
    projectId = 'project-b';
    h.render();
    expect(expand().on).toBe(false);
    expect(strips()).toBe(false);
  });

  it('tells the needs-you strip the expanded chart hides it, and collapses the chart when the strip asks', () => {
    const actions = { milestones: [], sessions: [], run: async () => null };
    const asking = {
      source: { table: 'sessions', id: 'lead-1', revision: 1 },
      kind: 'lead.question',
      request_id: 'question-1',
      project_id: 'project-a',
      session_id: 'lead-1',
      status: 'pending',
      created_at: NOW - 60_000,
      reason: 'question',
      actions: [],
      unblocks: 0,
    } as unknown as NonNullable<BoardModel['needs']>[number];
    const model = board({ needs: [asking] });
    const h = mount(() => BoardView(viewProps({ model, projectId: 'project-a', actions })));
    const expand = () => named(h.value, 'MainView').props.expand;
    const strip = () => named(h.value, 'ProjectNeeds').props;
    expect(strip().hidden).toBe(false);
    expand().onToggle();
    h.render();
    expect(strip().hidden).toBe(true);
    strip().onShow();
    h.render();
    expect(expand().on).toBe(false);
    expect(strip().hidden).toBe(false);
  });

  it('lists what needs the user under the requirement bar and the since-you-left card, and nothing when nothing does', () => {
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
    const view = (needs: NonNullable<BoardModel['needs']>) =>
      mount(() =>
        BoardView(viewProps({ model: board({ needs }), projectId: 'project-a', actions })),
      ).value;
    const listed = view([waiting]);
    const parts = names(listed);
    expect(parts.indexOf('PublishBar')).toBeGreaterThanOrEqual(0);
    expect(parts.indexOf('PublishBar')).toBeLessThan(parts.indexOf('BriefCard'));
    expect(parts.indexOf('BriefCard')).toBeLessThan(parts.indexOf('ProjectNeeds'));
    const strip = named(listed, 'ProjectNeeds');
    expect(strip.props.model.needs).toEqual([waiting]);
    expect(strip.props.run).toBe(actions.run);
    expect(names(view([]))).not.toContain('ProjectNeeds');
  });
});

describe('milestone line', () => {
  it.each(
    [
      {
        name: 'draws one bar part per state of the tasks of the milestone alone, its counts in the bar name',
        // Two of its three merged tasks ended before the board's window; the plan has more tasks.
        tasks: { done: 3, total: 6 },
        states: [
          ['lead-1:merged', 'done'],
          ['lead-1:run-a', 'running'],
          ['lead-1:run-b', 'running'],
          ['lead-1:next', 'todo'],
          ['lead-1:other', 'waiting', 'ms-later'],
          ['lead-1:loose', 'failed', null],
        ],
        label: '6 个任务：3 已合并，2 运行，1 排队',
        parts: [
          ['merged', 3],
          ['running', 2],
          ['queued', 1],
        ],
      },
      {
        name: 'gives the discarded tasks of the milestone their own bar part, counted in the bar name',
        tasks: { done: 1, total: 4 },
        states: [
          ['lead-1:merged', 'done'],
          ['lead-1:next', 'todo'],
          ['lead-1:drop-a', 'discarded'],
          ['lead-1:drop-b', 'discarded'],
        ],
        label: '4 个任务：1 已合并，1 排队，2 已丢弃',
        parts: [
          ['merged', 1],
          ['queued', 1],
          ['discarded', 2],
        ],
      },
    ].map((row) => [row.name, row] as const),
  )('%s', (_name, { tasks, states, label, parts }) => {
    const own = { ...milestone, tasks };
    const model = board({
      milestones: [own],
      tasks: states.map(([id, status, ms = 'ms-cur']) =>
        task(id!, { milestone_id: ms, status: status as Task['status'] }),
      ),
    });
    const out = new HookHost(() =>
      MilestoneCard({ model, milestone: own, onOpenTask: noop }),
    ).render();
    const bar = find(out, (n) => n.props.className === 'bms-bar');
    expect(bar.props.role).toBe('img');
    expect(bar.props['aria-label']).toBe(label);
    expect(
      nodes(bar.props.children).map((n) => [n.props['data-part'], n.props.style.flexGrow]),
    ).toEqual(parts);
  });
  it('keeps the acceptance, criteria, due date and task cells behind the button that ends the line', () => {
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
    const details = find(out, (n) =>
      nodes(n.props.children).some(
        (c) => c.props['aria-label'] === zh('board.plan.milestone.details'),
      ),
    );
    const inside = (predicate: (n: ReactElement<any>) => boolean) =>
      nodes(details.props.children).some(predicate);
    expect(inside((n) => n.props['aria-label'] === '验收 refunds rollout')).toBe(true);
    expect(inside((n) => n.props['aria-label'] === zh('board.plan.milestone.criteria'))).toBe(true);
    expect(
      inside(
        (n) => n.type === 'input' && n.props['aria-label'] === zh('board.plan.milestone.dueOn'),
      ),
    ).toBe(true);
    expect(inside((n) => n.props.className === 'bms-cell')).toBe(true);
  });
});

describe('lead line', () => {
  it('shows the runtime, a state glyph, what the lead does and a button opening it', () => {
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
    expect(text(open)).toBe(zh('board.lead.line.open'));
    open.props.onClick();
    expect(onOpenSession).toHaveBeenCalledWith('lead-a');
    expect(text(out)).not.toContain('plan lead');
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
