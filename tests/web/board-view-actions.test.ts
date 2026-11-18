import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardModel } from '@pantheon/protocol';
import { deferred, find, named, nodes, mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any, contexts: new Map<unknown, unknown>() }));
vi.mock('@/data/project-defaults', async (actual) => ({
  ...(await actual<object>()),
  useProjectDefaults: () => ({ data: null, loading: false, error: null, reload() {} }),
  useLastProjectDefaults: () => null,
}));
vi.mock('react', async (actual) => {
  const { hooks } = await import('./web-hook-host.js');
  // A context reads what the test last took from its provider.
  return {
    ...(await actual<object>()),
    ...hooks,
    useContext: (c: unknown) => mock.contexts.get(c),
  };
});
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
import { BoardScreen, BoardView, PanelBoundary } from '@/screens/board/BoardScreen';
import { FindingRow } from '@/screens/board/Lists';
import { DEFAULT_LAYOUT, saveLayout, setHidden } from '@/screens/board/panel-layout';
import { TaskDrawer } from '@/screens/board/TaskDrawer';
import { zh } from './i18n-setup.js';

const NOW = Date.UTC(2026, 10, 3, 12);
const noop = () => {};
// The board screen's view under its top bar.
const boardView = (props: Parameters<typeof BoardScreen>[0]) =>
  find(BoardScreen(props), (n) => n.type === BoardView);

const board = (): BoardModel => ({
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
  tasks: [
    {
      id: 'lead-1:t1',
      title: 'task t1',
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
    },
  ],
  edges: [],
  milestones: [],
  burnup: [],
  goals: [],
  task_progress: {
    totals: {
      done: 0,
      running: 1,
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

let baselineReply: ReturnType<typeof deferred<unknown>>;
beforeEach(() => {
  baselineReply = deferred();
  mock.board = {
    board: { cursor: 1, projects: [], sessions: [], session_turns: [], workspaces: [] },
    events: [],
    status: { state: 'live' },
    resync: 0,
    refresh() {},
  };
  vi.stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    pantheon: {
      query: vi.fn((method: string) =>
        method === 'project.baseline.read'
          ? baselineReply.promise
          : Promise.resolve({ ok: true, value: { tasks: [] } }),
      ),
      command: vi.fn(async () => ({ ok: true, value: null })),
    },
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('board actions wait for the reads they depend on', () => {
  const actions = { milestones: [], sessions: [], run: async () => null };
  const hasRequirementBox = (tree: unknown) =>
    nodes(tree as any).some((n) => typeof n.type === 'function' && n.type.name === 'PublishBar');

  it('keeps the requirement box with its draft but sends nothing while the board read has no model', () => {
    let model: BoardModel | null = board();
    const h = mount(() =>
      BoardView(viewProps({ model, loading: !model, projectId: 'project-a', actions })),
    );
    expect(named(h.value, 'PublishBar').props.disabled).toBe(false);
    model = null;
    h.render();
    expect(hasRequirementBox(h.value)).toBe(true);
    expect(named(h.value, 'PublishBar').props.disabled).toBe(true);
  });

  it('offers no board actions before the snapshot arrives', async () => {
    mock.board = { ...mock.board, board: null };
    const h = mount(() => boardView({ projectId: 'project-a', onOpenSession: noop }));
    await h.flush();
    expect(h.value.props.actions).toBeUndefined();
  });

  it('offers no baseline start while the baseline read is pending or failed', async () => {
    const h = mount(() => boardView({ projectId: 'project-a', onOpenSession: noop }));
    await h.flush();
    expect(h.value.props.baseline).toMatchObject({ link: null, start: null });

    baselineReply.resolve({ ok: false, error: { code: 'ipc_failed', message: 'gone' } });
    await h.flush();
    expect(h.value.props.baseline).toMatchObject({ link: null, start: null });
  });

  it('offers the first baseline once the read confirms there is none', async () => {
    const h = mount(() => boardView({ projectId: 'project-a', onOpenSession: noop }));
    await h.flush();
    baselineReply.resolve({ ok: true, value: null });
    await h.flush();
    expect(h.value.props.baseline).toMatchObject({ link: null, start: zh('board.baseline.start') });
  });
});

describe('board task drawer', () => {
  it('opens the task a progress table or stall row of the canvas view picks', () => {
    saveLayout('drawer-hidden-main', setHidden(DEFAULT_LAYOUT, 'main', true));
    const h = mount(() =>
      BoardView(viewProps({ projectId: 'drawer-hidden-main', page: 'canvas' })),
    );
    const laid = () => named(h.value, 'CanvasView').props.panels.map((p: any) => p.node);
    named(laid(), 'ProgressTable').props.onOpenTask('lead-1:t1');
    h.render();
    expect(find(h.value, (n) => n.type === TaskDrawer).props.taskId).toBe('lead-1:t1');

    named(laid(), 'StallPanel').props.onOpenTask(null);
    h.render();
    expect(find(h.value, (n) => n.type === TaskDrawer).props.taskId).toBeNull();
  });

  it('opens the task the main view picks in the drawer beside the now view', () => {
    const h = mount(() => BoardView(viewProps({ projectId: 'drawer-main-shown' })));
    named(h.value, 'MainView').props.onSelect('lead-1:t1');
    h.render();
    expect(find(h.value, (n) => n.type === TaskDrawer).props.taskId).toBe('lead-1:t1');
    expect(named(h.value, 'MainView').props.selected).toBe('lead-1:t1');
  });

  it('keeps the picked task in its drawer when the main view fails to render', () => {
    const h = mount(() => BoardView(viewProps({ projectId: 'drawer-main-failed' })));
    named(h.value, 'MainView').props.onSelect('lead-1:t1');
    h.render();
    const main = find(
      h.value,
      (n) => n.type === PanelBoundary && n.props.title === zh('board.panels.main'),
    );
    expect(nodes(main).some((n) => n.type === TaskDrawer)).toBe(false);
    expect(main.props.withFailure).toBeUndefined();
    expect(find(h.value, (n) => n.type === TaskDrawer).props.taskId).toBe('lead-1:t1');
  });

  it('does not reopen the task of a project the user left and came back to', () => {
    let projectId = 'drawer-project-a';
    const h = mount(() => BoardView(viewProps({ projectId })));
    named(h.value, 'MainView').props.onSelect('lead-1:t1');
    h.render();
    expect(named(h.value, 'MainView').props.selected).toBe('lead-1:t1');
    projectId = 'drawer-project-b';
    h.render();
    projectId = 'drawer-project-a';
    h.render();
    expect(named(h.value, 'MainView').props.selected).toBeNull();
  });
});

describe('main view drawer', () => {
  it('opens a selected session task in the drawer beside the main view', () => {
    const model = board();
    model.tasks.push({ ...model.tasks[0]!, id: 'session-task', title: 'session task' });
    const h = mount(() => BoardView(viewProps({ projectId: 'main-with-session-task', model })));
    named(h.value, 'MainView').props.onSelect('session-task');
    h.render();
    expect(find(h.value, (n) => n.type === TaskDrawer).props.taskId).toBe('session-task');
  });
});

describe('board finding actions', () => {
  const finding = (review_revision: number) => ({
    id: 'one',
    review_id: 'r1',
    review_revision,
    severity: 'major' as const,
    text: 'finding one',
    path: null,
    line: null,
    reviewer: 'codex',
    session_id: 's1',
    state: 'open' as const,
  });

  it('keeps adopt and dismiss off after an accepted resolve until the review revision moves', async () => {
    let current = finding(2);
    const onResolve = vi.fn(async () => null);
    const h = mount(() => FindingRow({ finding: current, onOpenSession: noop, onResolve }));
    const adopt = (tree: unknown) =>
      find(tree as any, (n) => n.props['aria-label'] === '采纳 finding one');
    adopt(h.value).props.onClick();
    await h.flush();
    expect(onResolve).toHaveBeenCalledOnce();
    expect(adopt(h.value).props.disabled).toBe(true);

    current = finding(3);
    h.render();
    expect(adopt(h.value).props.disabled).toBe(false);
  });

  it('lets the user try again after a refused resolve', async () => {
    const h = mount(() =>
      FindingRow({ finding: finding(2), onOpenSession: noop, onResolve: async () => 'refused' }),
    );
    const adopt = (tree: unknown) =>
      find(tree as any, (n) => n.props['aria-label'] === '采纳 finding one');
    adopt(h.value).props.onClick();
    await h.flush();
    expect(adopt(h.value).props.disabled).toBe(false);
  });
});
