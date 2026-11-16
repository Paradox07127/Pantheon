import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { BoardModel, ProjectHeatmap } from '@pantheon/protocol';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any }));
const store = vi.hoisted(
  () => (state: () => any) =>
    Object.assign((selector?: any) => (selector ? selector(state()) : state()), {
      getState: state,
      setState: (patch: object) => Object.assign(state(), patch),
    }),
);
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'panel-id' }),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({ useShell: store(() => mock.shell) }));
// The overview's reads, each landed.
const reads = vi.hoisted(() => {
  const landed = <T>(data: T) => ({
    data,
    read: data,
    loading: false,
    refreshing: false,
    stale: false,
    error: null,
    reload() {},
  });
  return {
    landed,
    model: null as unknown,
    facts: null as unknown,
    stale: null as unknown,
    heatDays: null as unknown,
    boardDays: null as unknown,
  };
});
vi.mock('@/data/trace', async (actual) => ({
  ...(await actual<object>()),
  useProjectHeatmap: (_projectId: string, days: string) => {
    reads.heatDays = days;
    return reads.landed<ProjectHeatmap>({
      days: [],
      lanes: [],
      hours: [],
      commits: [],
      merges: [],
    });
  },
}));
vi.mock('@/data/facts-read', async (actual) => ({
  ...(await actual<object>()),
  useFactsRead: () => reads.facts,
}));
vi.mock('@/data/worktree-setup', async (actual) => ({
  ...(await actual<object>()),
  useStaleWorkspaces: () => reads.stale,
}));
vi.mock('@/data/runtime-models', async (actual) => ({
  ...(await actual<object>()),
  useProjectHead: () => reads.landed(null),
}));
vi.mock('@/data/workbench-sessions', async (actual) => ({
  ...(await actual<object>()),
  useSessionList: () => reads.landed([]),
}));
vi.mock('@/data/board-view', async (actual) => ({
  ...(await actual<object>()),
  useBoardView: (_projectId: string, days: unknown) => {
    reads.boardDays = days;
    return reads.landed(reads.model);
  },
}));
vi.mock('@/screens/board/project-setup', async (actual) => ({
  ...(await actual<object>()),
  useProjectSetup: () => undefined,
}));
import { Sidebar } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { Failure } from '@/screens/board/BoardScreen';
import { MergesPanel } from '@/screens/board/Lists';
import { MergeHeat, RepoPanels } from '@/screens/board/RepoCharts';
import { CommitGraph } from '@/screens/repo/history/CommitGraph';
import { OverviewTab } from '@/screens/repo/OverviewTab';
import { RepoScreen } from '@/screens/repo/RepoScreen';
import { TimelineTab } from '@/screens/repo/TimelineTab';
import { zh } from './i18n-setup.js';

const NOW = Date.UTC(2026, 10, 3, 12);
const model = {
  since: NOW - 30 * 86_400_000,
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
} satisfies BoardModel;

let stored: Map<string, string>;
beforeEach(() => {
  reads.model = model;
  reads.facts = reads.landed({ facts: null, workstreams: [] });
  reads.stale = reads.landed(null);
  stored = new Map();
  mock.board = { board: null, status: { state: 'live' } };
  mock.shell = {
    screen: 'board',
    sessionId: null,
    sessionGroup: null,
    setScreen: vi.fn(),
    openSession: vi.fn(),
  };
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const repoName = () => zh('app.screenName.repo');

function sidebar(collapsed: boolean) {
  return mount(() =>
    Sidebar({
      layout: {
        collapsed,
        width: 264,
        resize: () => {},
        commit: () => {},
        reset: () => {},
        toggle: () => {},
      },
      projects: [{ id: 'alpha', name: 'Alpha' }],
      currentProjectId: 'alpha',
      onChooseProject: () => {},
      list: { data: [], loading: false, error: null, reload() {} } as any,
      allNeeds: { items: [], error: null } as any,
    }),
  );
}

const screen = (projectId: string) =>
  mount(() => RepoScreen({ projectId, onOpenSession: () => {} }));
// The tabs, holding the picked one and taking the next.
const tabsOf = (tree: unknown) =>
  find(tree as never, (n) => typeof n.props.onValueChange === 'function');
// The tab list goes by its accessible name; each tab in it by its value.
const tabNames = (tree: unknown) =>
  nodes(find(tree as never, (n) => n.props['aria-label'] === zh('repo.tabs.label')).props.children)
    .filter((n) => n.props.value !== undefined)
    .map((n) => text(n.props.children));

/** Renders a function component found in the tree, one level down. */
const expand = (node: ReactElement<any>) =>
  mount(() => (node.type as (props: object) => any)(node.props)).value;

describe('repository page in the sidebar', () => {
  it('lists the repository page between the engineering board and the trace, and opens it', () => {
    const pages = nodes(sidebar(false).value)
      .filter((n) => n.type === 'button' && n.props.className === 'sb-it')
      .map((n) => text(n.props.children));
    expect(pages.slice(0, 4)).toEqual(
      ['board', 'insights', 'repo', 'trace'].map((s) => zh(`app.screenName.${s}`)),
    );
    const entry = find(
      sidebar(false).value,
      (n) => n.type === 'button' && text(n.props.children) === repoName(),
    );
    entry.props.onClick();
    expect(mock.shell.setScreen).toHaveBeenCalledWith('repo');
  });

  it('marks the repository page current while it shows, open or folded', () => {
    mock.shell.screen = 'repo';
    const open = find(
      sidebar(false).value,
      (n) => n.type === 'button' && text(n.props.children) === repoName(),
    );
    expect(open.props['aria-current']).toBe('page');
    const rail = find(
      sidebar(true).value,
      (n) => n.type === 'button' && n.props['aria-label'] === repoName(),
    );
    expect(rail.props['aria-current']).toBe('page');
    rail.props.onClick();
    expect(mock.shell.setScreen).toHaveBeenCalledWith('repo');
  });
});

describe('repository page tabs', () => {
  it('names the page and its tabs timeline, changes, compare, overview and pull requests in order', () => {
    const tree = screen('repo-tabs').value;
    expect(find(tree, (n) => n.props.title !== undefined).props.title).toBe(repoName());
    expect(tabNames(tree)).toEqual(
      ['timeline', 'changes', 'compare', 'overview', 'pulls'].map((k) => zh(`repo.tabs.${k}`)),
    );
    expect(tabsOf(tree).props.value).toBe('timeline');
  });

  it('keeps the picked tab per project', () => {
    const alpha = screen('repo-alpha');
    tabsOf(alpha.value).props.onValueChange('overview');
    alpha.render();
    expect(tabsOf(alpha.value).props.value).toBe('overview');
    expect(stored.get('pantheon.repo.repo-alpha')).toBe('overview');
    expect(tabsOf(screen('repo-beta').value).props.value).toBe('timeline');
    expect(tabsOf(screen('repo-alpha').value).props.value).toBe('overview');
  });

  it('opens the stored tab, and the timeline for anything else', () => {
    stored.set('pantheon.repo.repo-stored', 'compare');
    expect(tabsOf(screen('repo-stored').value).props.value).toBe('compare');
    stored.set('pantheon.repo.repo-unknown', 'iterations');
    expect(tabsOf(screen('repo-unknown').value).props.value).toBe('timeline');
  });
});

describe('repository top bar controls', () => {
  // The timeline's view switch, wherever it is drawn in the tree.
  const viewSwitch = (tree: unknown) =>
    nodes(tree as never).find((n) => n.props['aria-label'] === zh('repo.history.views'));
  // Every component the top bar holds, each rendered one level down.
  const barContents = (tree: unknown) =>
    nodes(find(tree as never, (n) => n.type === TopBar).props.children)
      .filter((n) => typeof n.type === 'function')
      .map(expand);

  it('puts the timeline view switch in the top bar, and picking the graph shows it', () => {
    const page = screen('repo-bar-timeline');
    const control = barContents(page.value)
      .map(viewSwitch)
      .find((n) => n !== undefined);
    expect(control?.props.value).toBe('lanes');
    expect(nodes(control!.props.children).map((n) => text(n.props.children))).toEqual([
      zh('repo.history.lanes'),
      zh('repo.history.graph'),
    ]);
    control!.props.onValueChange('graph');
    expect(stored.get('pantheon.repo.timeline.repo-bar-timeline')).toBe('graph');
    const body = mount(() =>
      TimelineTab({ projectId: 'repo-bar-timeline', onOpenSession() {} }),
    ).value;
    expect(nodes(body).some((n) => n.type === CommitGraph)).toBe(true);
    expect(viewSwitch(body)).toBeUndefined();
  });

  it('leaves the timeline view switch out of the top bar on another tab', () => {
    stored.set('pantheon.repo.repo-bar-overview', 'overview');
    const page = screen('repo-bar-overview');
    expect(barContents(page.value).map(viewSwitch).filter(Boolean)).toEqual([]);
  });

  // The overview's range switch, wherever it is drawn in the tree.
  const rangeSwitch = (tree: unknown) =>
    nodes(tree as never).find((n) => n.props['aria-label'] === zh('repo.overview.range'));
  const overview = (projectId: string) =>
    mount(() => OverviewTab({ projectId, onOpenSession() {} })).value;
  const mergeHeat = (tree: unknown) => find(tree as never, (n) => n.type === MergeHeat).props;

  it('puts the overview range switch in the top bar, reading 30 days until another is picked', () => {
    stored.set('pantheon.repo.repo-bar-range', 'overview');
    const page = screen('repo-bar-range');
    const control = barContents(page.value)
      .map(rangeSwitch)
      .find((n) => n !== undefined);
    expect(control?.props.value).toBe('30d');
    expect(nodes(control!.props.children).map((n) => text(n.props.children))).toEqual([
      zh('repo.overview.range.week'),
      zh('repo.overview.range.month'),
      zh('repo.overview.range.quarter'),
    ]);
    expect(mergeHeat(overview('repo-bar-range')).span).toBe(zh('repo.overview.range.month'));
    expect([reads.heatDays, reads.boardDays]).toEqual(['30', 30]);
    control!.props.onValueChange('7d');
    expect(stored.get('pantheon.repo.overview.repo-bar-range')).toBe('7d');
    const body = overview('repo-bar-range');
    expect([reads.heatDays, reads.boardDays]).toEqual(['7', 7]);
    expect(mergeHeat(body)).toMatchObject({ days: 7, span: zh('repo.overview.range.week') });
    expect(rangeSwitch(body)).toBeUndefined();
  });

  it('reads twelve weeks of merges and the whole board for the stored twelve week range', () => {
    stored.set('pantheon.repo.overview.repo-quarter', '12w');
    const body = overview('repo-quarter');
    expect([reads.heatDays, reads.boardDays]).toEqual(['90', 'all']);
    expect(mergeHeat(body)).toMatchObject({ days: 84, span: zh('repo.overview.range.quarter') });
  });

  it('leaves the overview range switch out of the top bar on the timeline', () => {
    const page = screen('repo-bar-no-range');
    expect(barContents(page.value).map(rangeSwitch).filter(Boolean)).toEqual([]);
  });
});

describe('repository overview', () => {
  it('shows the local merge history under its own heading', () => {
    const tree = mount(() => OverviewTab({ projectId: 'repo-overview', onOpenSession() {} })).value;
    const merges = find(tree, (n) => n.type === MergesPanel);
    const panel = expand(find(expand(merges), (n) => n.props.title !== undefined));
    const heading = find(panel, (n) => n.type === 'h2');
    expect(text(heading)).toBe(zh('board.merges.title'));
    expect(panel.props['aria-labelledby']).toBe(heading.props.id);
  });

  it('keeps the last facts read with the failure and a retry once a later read fails', () => {
    reads.facts = { ...reads.landed({ facts: null, workstreams: [] }), error: 'facts gone' };
    const tree = mount(() =>
      OverviewTab({ projectId: 'repo-facts-failed', onOpenSession() {} }),
    ).value;
    expect(nodes(tree).some((n) => n.type === RepoPanels)).toBe(true);
    expect(find(tree, (n) => n.type === Failure).props.error).toBe('facts gone');
  });

  it('shows a failed worktree read with a retry', () => {
    const reload = vi.fn();
    reads.stale = { ...reads.landed(null), error: 'stale gone', unavailable: false, reload };
    const tree = mount(() =>
      OverviewTab({ projectId: 'repo-stale-failed', onOpenSession() {} }),
    ).value;
    const failure = find(tree, (n) => n.type === Failure);
    expect(failure.props.error).toBe('stale gone');
    failure.props.onRetry();
    expect(reload).toHaveBeenCalled();
  });
});
