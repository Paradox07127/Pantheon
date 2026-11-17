import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { ProjectBaseline } from '@pantheon/domain';
import type { BoardModel } from '@pantheon/protocol';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';
import { zh, zhf } from './i18n-setup.js';
import { setupRead } from './setup-fixture.js';
const mock = vi.hoisted(() => ({ board: {} as any, model: null as unknown }));
const landed = vi.hoisted(() => <T>(data: T) => ({
  data,
  read: data,
  loading: false,
  refreshing: false,
  stale: false,
  error: null,
  reload() {},
}));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => {
  const shell = { openSession() {}, openSessionGroup() {}, openTaskSession() {}, setScreen() {} };
  return {
    useShell: Object.assign((selector: any) => selector(shell), {
      getState: () => shell,
      setState() {},
    }),
  };
});
vi.mock('@/data/project-defaults', async (actual) => ({
  ...(await actual<object>()),
  useProjectDefaults: () => ({ data: null, loading: false, error: null, reload() {} }),
  useLastProjectDefaults: () => null,
}));
vi.mock('@/data/runtime-status', async (actual) => ({
  ...(await actual<object>()),
  useRuntimeStatus: () => ({
    read: { state: 'loading' },
    runtimes: ['claude'],
    unavailable: {},
    disconnected: [],
  }),
  offeredRuntimes: () => ['claude'],
}));
vi.mock('@/data/runtime-models', async (actual) => ({
  ...(await actual<object>()),
  useRuntimeModels: () => ({}),
  useProjectHead: () => landed(null),
}));
vi.mock('@/data/facts-read', async (actual) => ({
  ...(await actual<object>()),
  useFactsRead: () => landed({ facts: null, collected_at: null, empty: false, workstreams: [] }),
}));
vi.mock('@/data/board-view', async (actual) => ({
  ...(await actual<object>()),
  useBoardView: () => landed(mock.model),
}));
vi.mock('@/data/trace', async (actual) => ({
  ...(await actual<object>()),
  useProjectHeatmap: () => landed({ days: [], lanes: [], hours: [], commits: [], merges: [] }),
}));
vi.mock('@/data/worktree-setup', async (actual) => ({
  ...(await actual<object>()),
  useStaleWorkspaces: () => landed(null),
}));
vi.mock('@/data/workbench-sessions', async (actual) => ({
  ...(await actual<object>()),
  useSessionList: () => landed([]),
}));
import { BoardScreen, BoardView } from '@/screens/board/BoardScreen';
import { ProjectSetup, ScratchStart } from '@/screens/board/ProjectSetup';
import { PublishBar } from '@/screens/board/PublishBar';
import { BaselinePopover, ReviewBaseline } from '@/screens/projects/BaselineBlocks';
import { TaskGraph } from '@/screens/projects/TaskGraph';
import { InsightsScreen, InsightsView } from '@/screens/insights/InsightsScreen';
import { OverviewTab } from '@/screens/repo/OverviewTab';
import type { SnapshotSession } from '@/screens/board/panels-model';

const noop = () => {};
const NOW = Date.UTC(2026, 10, 16, 12);
const ROOTS = ['/work/LiveWallpaper', '/work/WallpaperKit'];

const baseline = (state: ProjectBaseline['state'], extra: object = {}) =>
  ({
    id: 'baseline-a',
    revision: 1,
    project_id: 'project-a',
    state,
    session_id: 'baseline-session',
    runtime: 'claude',
    facts_id: 'facts-a',
    dropped: 0,
    created_at: NOW - 252_000,
    ...extra,
  }) as ProjectBaseline;

const task = (id: string, title: string, depends_on: string[] = []) => ({
  id,
  title,
  workstream: 'renderer',
  depends_on,
  why: 'Battery drain',
  scope: ['Sources/Renderer'],
  acceptance: ['swift test'],
  sources: ['file:Sources/Renderer/Loop.swift'],
});

const plan = { id: 'lead-plan', runtime: 'claude', state: 'running' } as SnapshotSession;

const board = (extra: Partial<BoardModel> = {}): BoardModel =>
  ({
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
      previous: { tokens: 0, cost_usd: null, merged: 0, median_ms: null },
      cost_usd: null,
    },
    lanes: [],
    tasks: [],
    edges: [],
    milestones: [],
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
  }) as BoardModel;

const buttons = (tree: ReactNode) => nodes(tree).filter((n) => n.type === 'button');
const button = (tree: ReactNode, label: string) =>
  find(tree, (n) => n.type === 'button' && (text(n) === label || n.props['aria-label'] === label));
const typed = (tree: ReactNode, type: unknown) => nodes(tree).find((n) => n.type === type);

let commands: { type: string; input: any }[];
let onOpenSession: ReturnType<typeof vi.fn<(sessionId: string) => void>>;
beforeEach(() => {
  commands = [];
  onOpenSession = vi.fn<(sessionId: string) => void>();
  mock.model = board();
  mock.board = {
    board: {
      cursor: 1,
      projects: [{ id: 'project-a', revision: 1, name: 'LiveWallpaper', roots: ROOTS }],
      sessions: [],
      session_turns: [],
    },
    events: [],
    status: { state: 'live' },
    resync: 0,
    changed: 0,
    refresh() {},
  };
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  });
  vi.stubGlobal('window', {
    pantheon: {
      query: vi.fn(async (method: string) =>
        method === 'project.baseline.read'
          ? { ok: true, value: null }
          : method === 'project.intro.read'
            ? { ok: true, value: { intro: null, behind: null, writing_session_id: null } }
            : { ok: false, error: { code: 'not_found', message: method } },
      ),
      command: vi.fn(async (command: any) => {
        commands.push(command);
        return command.type === 'session.create'
          ? { ok: true, value: { id: 'setup-session' } }
          : { ok: true, value: baseline('running') };
      }),
    },
    addEventListener() {},
    removeEventListener() {},
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const setupOf = (state: Parameters<typeof setupRead>[0], extra = {}) =>
  setupRead(state, { roots: ROOTS, ...extra });

describe('project setup states', () => {
  const draw = (setup: ReturnType<typeof setupRead>) =>
    mount(() => ProjectSetup({ setup, onOpenSession })).value;

  it.each([
    [
      'offers to build the baseline of a git project with code, with a model choice and the palette',
      setupOf('none'),
      (tree: ReactNode) => {
        const group = find(tree, (n) => n.props.role === 'group');
        expect(group.props['aria-label']).toBe(zh('board.baseline.start'));
        expect(buttons(group).map((b) => text(b) || b.props['aria-label'])).toEqual([
          zh('board.baseline.start'),
          zh('board.setup.chooseModel'),
        ]);
        const hint = find(tree, (n) => n.props.role === 'img');
        expect(hint.props['aria-label']).toContain(zh('board.setup.palette').split('{')[0]);
      },
    ],
    [
      'offers to start an empty folder from scratch',
      setupOf('empty_folder'),
      (tree: ReactNode) => {
        expect(typed(tree, ScratchStart)!.props.projectId).toBe('project-a');
        expect(text(tree)).not.toContain(zh('board.baseline.start'));
      },
    ],
    [
      'lists the steps of a running baseline without a percentage and opens its conversation',
      setupOf('running', {
        baseline: baseline('running', { folders: [{ root: ROOTS[0] }] }),
        intro: true,
        charts: 1,
      }),
      (tree: ReactNode) => {
        const steps = find(tree, (n) => n.props['aria-label'] === zh('board.setup.steps'));
        expect(
          nodes(steps)
            .filter((n) => n.type === 'li')
            .map(text),
        ).toEqual([
          `${zh('board.setup.folders')}1 / 2`,
          'LiveWallpaper/',
          'WallpaperKit/',
          zh('board.setup.intro.step'),
          `${zh('board.setup.charts')}1`,
          zh('board.setup.summary'),
        ]);
        expect(text(tree)).toContain(zh('board.setup.running'));
        expect(text(tree)).not.toContain('%');
        expect(buttons(tree).map(text)).toEqual([zh('board.setup.viewConversation')]);
        button(tree, zh('board.setup.viewConversation')).props.onClick();
        expect(onOpenSession).toHaveBeenCalledWith('baseline-session');
      },
    ],
    [
      'says why a baseline failed and offers to rebuild it, not to retry',
      setupOf('failed', {
        baseline: baseline('failed', { reason: 'baseline_missing', folders: [] }),
      }),
      (tree: ReactNode) => {
        expect(text(find(tree, (n) => n.props.role === 'alert'))).toBe(
          zh('projects.baseline.failure.missing'),
        );
        expect(buttons(tree).map(text)).toEqual([
          zh('board.baseline.restart'),
          zh('board.setup.viewConversation'),
        ]);
        expect(text(tree)).not.toContain(zh('components.retry'));
      },
    ],
    [
      'puts the review of a handed-back baseline in the page',
      setupOf('submitted', { baseline: baseline('submitted') }),
      (tree: ReactNode) => {
        const review = typed(tree, ReviewBaseline)!;
        expect(review.props.baseline).toMatchObject({ id: 'baseline-a' });
        expect(review.props.onOpenSession).toBe(onOpenSession);
      },
    ],
    [
      'shows the draft task graph while the lead writes the plan, and opens the lead',
      setupOf('planning', {
        baseline: baseline('confirmed', {
          result: {
            tasks: [task('cap', 'Cap frame rate'), task('pause', 'Pause on fullscreen', ['cap'])],
            workstreams: [],
          },
        }),
        plan,
        planSince: NOW - 98_000,
      }),
      (tree: ReactNode) => {
        expect(text(tree)).toContain(zh('board.setup.leadWriting'));
        const draft = find(
          tree,
          (n) => n.props['aria-label'] === zhf('board.setup.draftGraph', { count: 2 }),
        );
        expect(text(draft)).toContain(zh('board.setup.draft'));
        expect(typed(draft, TaskGraph)!.props.tasks).toHaveLength(2);
        button(tree, zh('board.setup.viewLead')).props.onClick();
        expect(onOpenSession).toHaveBeenCalledWith('lead-plan');
      },
    ],
    [
      'draws nothing once the project is set up',
      setupOf('ready'),
      (tree: ReactNode) => {
        expect(tree).toBeNull();
      },
    ],
  ])('%s', (_name, setup, check) => check(draw(setup)));

  it('starts the baseline from the main button and opens the model choice from the other', () => {
    const start = vi.fn();
    const h = mount(() => ProjectSetup({ setup: setupOf('none', { start }), onOpenSession }));
    button(h.value, zh('board.baseline.start')).props.onClick();
    expect(start).toHaveBeenCalledWith();
    expect(typed(h.value, BaselinePopover)).toBeUndefined();
    button(h.value, zh('board.setup.chooseModel')).props.onClick();
    h.render();
    expect(typed(h.value, BaselinePopover)!.props.label).toBe(zh('board.baseline.start'));
  });

  it('starts a setup session for an empty folder and opens it', async () => {
    const h = mount(() => ScratchStart({ projectId: 'project-a', onOpenSession }));
    button(h.value, zh('board.setup.fromScratch')).props.onClick();
    await h.flush();
    expect(commands).toMatchObject([
      {
        type: 'session.create',
        input: {
          project_id: 'project-a',
          purpose: 'project_setup',
          input: zh('sessions.composer.fromScratch'),
        },
      },
    ]);
    expect(onOpenSession).toHaveBeenCalledWith('setup-session');
  });
});

describe('project setup on the pages', () => {
  const view = (setup: ReturnType<typeof setupRead>, model: BoardModel, extra = {}) =>
    mount(() =>
      BoardView({
        model,
        loading: false,
        error: null,
        onRetry: noop,
        range: 7,
        onRange: noop,
        page: 'now',
        onPage: noop,
        projectId: 'project-a',
        onOpenSession: noop,
        onOpenStory: noop,
        onOpenTrace: noop,
        setup,
        ...extra,
      }),
    ).value;
  const shown = (tree: ReactNode) =>
    nodes(tree).some((n) => typeof n.type === 'function' && n.type.name === 'ProjectSetup');

  it('puts the setup in place of an empty board, with no start-a-session button', () => {
    const tree = view(setupOf('none'), board());
    expect(shown(tree)).toBe(true);
    expect(text(tree)).not.toContain('开一个会话');
    expect(nodes(tree).some((n) => (n.type as { name?: string }).name === 'MainView')).toBe(false);
  });

  it.each([
    ['none', setupOf('none'), false],
    ['running', setupOf('running', { baseline: baseline('running') }), false],
    ['ready', setupOf('ready'), true],
  ])(
    'in the %s state, draws the lead input and the time range only on a set-up board',
    (_name, setup, drawn) => {
      const tree = view(setup, board(), {
        actions: { milestones: [], sessions: [], run: async () => null },
      });
      expect(!!typed(tree, PublishBar)).toBe(drawn);
      expect(nodes(tree).some((n) => n.props['aria-label'] === zh('board.headline.range'))).toBe(
        drawn,
      );
    },
  );

  it('keeps the setup over the planning lead until its plan lands on the board', () => {
    const planning = setupOf('planning', { plan });
    const leadTask = { id: 'lead-plan', title: 'Baseline plan' } as BoardModel['tasks'][number];
    const counts = { ...board().counts, running: 1 };
    expect(shown(view(planning, board({ tasks: [leadTask], counts })))).toBe(true);
    const planned = board({
      tasks: [leadTask],
      counts,
      leads: [{ session_id: 'lead-plan' }] as BoardModel['leads'],
    });
    expect(shown(view(planning, planned))).toBe(false);
  });

  it('shows a baseline started on the board as busy on the insights and repository pages', async () => {
    const boardPage = mount(() =>
      find(
        BoardScreen({ projectId: 'project-a', onOpenSession: noop }),
        (n) => n.type === BoardView,
      ),
    );
    const insights = mount(() =>
      find(
        InsightsScreen({ projectId: 'project-a', onOpenSession: noop }),
        (n) => n.type === InsightsView,
      ),
    );
    const overview = mount(() => OverviewTab({ projectId: 'project-a', onOpenSession: noop }));
    await boardPage.flush();
    await insights.flush();
    await overview.flush();
    const overviewSetup = () =>
      (find(overview.value, (n) => n.type === ProjectSetup) as ReactElement<any>).props.setup;
    expect(boardPage.value.props.setup).toMatchObject({ state: 'none', busy: false });
    expect(insights.value.props.setup).toMatchObject({ state: 'none', busy: false });
    expect(overviewSetup()).toMatchObject({ state: 'none', busy: false });

    const onBoard = mount(() =>
      ProjectSetup({ setup: boardPage.value.props.setup, onOpenSession: noop }),
    );
    button(onBoard.value, zh('board.baseline.start')).props.onClick();
    insights.render();
    overview.render();
    expect(insights.value.props.setup.busy).toBe(true);
    expect(overviewSetup().busy).toBe(true);
    const onInsights = mount(() =>
      ProjectSetup({ setup: insights.value.props.setup, onOpenSession: noop }),
    );
    expect(button(onInsights.value, zh('board.baseline.start')).props['aria-busy']).toBe(true);
    await insights.flush();
    expect(commands).toMatchObject([
      { type: 'project.baseline.start', input: { project_id: 'project-a' } },
    ]);
  });
});
