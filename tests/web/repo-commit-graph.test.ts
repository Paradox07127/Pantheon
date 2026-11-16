import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoCommit, RepoLog } from '@pantheon/protocol';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any }));
// Each page of the log by the skip it was read with; a page keeps its object until the log changes.
const reads = vi.hoisted(() => {
  const landed = <T>(data: T) => ({
    data,
    read: data,
    loading: false,
    refreshing: false,
    stale: false,
    unavailable: false,
    error: null,
    reload() {},
  });
  return { landed, idle: landed(null), logs: new Map<string, unknown>() };
});
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'graph-id' }),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector?: any) => (selector ? selector(mock.shell) : mock.shell), {
    getState: () => mock.shell,
  }),
}));
vi.mock('@/data/repo', async (actual) => ({
  ...(await actual<object>()),
  useRepoLog: (projectId: string | null, _limit: number, skip = 0) =>
    projectId === null ? reads.idle : (reads.logs.get(String(skip)) ?? reads.idle),
  useRepoCommitDiff: () => reads.idle,
}));
vi.mock('@/data/workbench-sessions', async (actual) => ({
  ...(await actual<object>()),
  useSessionList: () => reads.landed([]),
}));
vi.mock('@/data/change-story', async (actual) => ({
  ...(await actual<object>()),
  useChangeStories: () => reads.landed([]),
}));
import { CommitGraph, LOG_PAGE } from '@/screens/repo/history/CommitGraph';
import { layoutCommitGraph, MAX_COLUMNS } from '@/screens/repo/history/commit-graph';
import { zh } from './i18n-setup.js';

const commit = (sha: string, ...parents: string[]): RepoCommit => ({
  sha,
  parents,
  refs: [],
  author: 'Ada',
  author_email: 'ada@example.invalid',
  committed_at: 0,
  subject: sha,
  body: '',
});

// An edge as child row, parent row, and its from, lane and to columns.
type Edge = [number, number | null, number, number, number];

const octopus = Array.from({ length: 10 }, (_, i) => `p${i + 1}`);

const cases: {
  name: string;
  commits: RepoCommit[];
  columns: number[];
  edges: Edge[];
  width: number;
}[] = [
  {
    name: 'straight history, its oldest parent not read yet',
    commits: [commit('c', 'b'), commit('b', 'a'), commit('a', 'root')],
    columns: [0, 0, 0],
    edges: [
      [0, 1, 0, 0, 0],
      [1, 2, 0, 0, 0],
      [2, null, 0, 0, 0],
    ],
    width: 1,
  },
  {
    name: 'one branch merged back',
    commits: [commit('m', 'b', 'f'), commit('f', 'a'), commit('b', 'a'), commit('a')],
    columns: [0, 1, 0, 0],
    edges: [
      [0, 2, 0, 0, 0],
      [0, 1, 0, 1, 1],
      [1, 3, 1, 1, 0],
      [2, 3, 0, 0, 0],
    ],
    width: 2,
  },
  {
    name: 'two branches side by side, the freed column taken again',
    commits: [commit('x', 'a'), commit('y', 'a'), commit('a', 'r'), commit('z', 'r'), commit('r')],
    columns: [0, 1, 0, 1, 0],
    edges: [
      [0, 2, 0, 0, 0],
      [1, 2, 1, 1, 0],
      [2, 4, 0, 0, 0],
      [3, 4, 1, 1, 0],
    ],
    width: 2,
  },
  {
    name: 'more parents than columns',
    commits: [commit('o', ...octopus), ...octopus.map((sha) => commit(sha))],
    columns: [0, 0, 1, 2, 3, 4, 5, 6, 7, 7, 7],
    edges: octopus.map((_, i): Edge => {
      const column = Math.min(i, MAX_COLUMNS - 1);
      return [0, i + 1, 0, column, column];
    }),
    width: MAX_COLUMNS,
  },
];

describe('commit graph layout', () => {
  it.each(cases)('$name', ({ commits, columns, edges, width }) => {
    const layout = layoutCommitGraph(commits);
    expect(layout.columns).toEqual(columns);
    expect(layout.edges.map((e) => [e.child, e.parent, e.from, e.lane, e.to])).toEqual(edges);
    expect(layout.width).toBe(width);
  });
});

const NOW = Date.UTC(2026, 10, 3, 12);
const linear = (n: number): RepoCommit => ({
  ...commit(n.toString(16).padStart(40, '0'), (n - 1).toString(16).padStart(40, '0')),
  committed_at: NOW - (1000 - n) * 60_000,
});
/** The log newest first, served as pages of LOG_PAGE commits. */
function serve(log: RepoCommit[]) {
  reads.logs.clear();
  for (let skip = 0; skip < log.length; skip += LOG_PAGE)
    reads.logs.set(
      String(skip),
      reads.landed<RepoLog>({
        commits: log.slice(skip, skip + LOG_PAGE),
        has_more: skip + LOG_PAGE < log.length,
      }),
    );
}

beforeEach(() => {
  mock.board = { board: null, status: { state: 'live' } };
  mock.shell = { openSession: vi.fn() };
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('commit graph pages', () => {
  it('keeps every loaded commit when a new commit lands on HEAD', () => {
    const log = Array.from({ length: 2 * LOG_PAGE + 50 }, (_, i) => linear(900 - i));
    serve(log);
    const host = mount(() => CommitGraph({ projectId: 'graph-pages', onOpenSession() {} }));
    const loadMore = () =>
      find(
        host.value,
        (n) => n.type === 'button' && text(n.props.children) === zh('repo.history.loadMore'),
      ).props.onClick();
    const shown = () =>
      nodes(host.value as never)
        .filter((n) => n.props.role === 'option')
        .map((n) => n.key);
    loadMore();
    host.render();
    loadMore();
    host.render();
    expect(shown()).toHaveLength(log.length);

    const pushedOff = log[LOG_PAGE - 1]!.sha;
    serve([linear(901), ...log]);
    host.render();
    expect(shown()).toContain(pushedOff);
    expect(shown()).toHaveLength(log.length + 1);
  });
});
