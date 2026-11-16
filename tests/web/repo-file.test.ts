import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { LandingDiff, RepoBlame, RepoCommit, RepoFileHistory } from '@pantheon/protocol';
import { find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any }));
const store = vi.hoisted(
  () => (state: () => any) =>
    Object.assign((selector?: any) => (selector ? selector(state()) : state()), {
      getState: state,
      setState: (patch: object) => Object.assign(state(), patch),
    }),
);
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'file-id' }),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({ useShell: store(() => mock.shell) }));
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
  return {
    landed,
    idle: landed(null),
    blame: landed(null) as unknown,
    history: landed(null) as unknown,
    file: landed(null) as unknown,
    log: landed(null) as unknown,
    diff: landed(null) as unknown,
    sessions: landed([] as unknown[]),
    openRepoView: vi.fn(),
  };
});
vi.mock('@/data/project-read', async (actual) => ({
  ...(await actual<object>()),
  useProjectQuery: (method: string) => (method === 'files.read' ? reads.file : reads.idle),
}));
vi.mock('@/data/repo', async (actual) => ({
  ...(await actual<object>()),
  useRepoBlame: () => reads.blame,
  useRepoFileHistory: () => reads.history,
  useRepoLog: () => reads.log,
  useRepoCommitDiff: () => reads.diff,
}));
vi.mock('@/data/runtime-models', async (actual) => ({
  ...(await actual<object>()),
  useProjectHead: () => reads.landed({ branch: 'main', sha: 'f'.repeat(40), subject: 'Head' }),
}));
vi.mock('@/data/workbench-sessions', async (actual) => ({
  ...(await actual<object>()),
  useSessionList: () => reads.sessions,
}));
vi.mock('@/data/change-story', async (actual) => ({
  ...(await actual<object>()),
  useChangeStories: () => reads.landed([]),
}));
vi.mock('@/screens/repo/route', async (actual) => ({
  ...(await actual<object>()),
  openRepoView: reads.openRepoView,
}));
import { FileHistory } from '@/screens/repo/file/FileHistory';
import { CommitDetail } from '@/screens/repo/history/CommitDetail';
import { zh, zhf } from './i18n-setup.js';

const NOW = Date.UTC(2026, 10, 3, 12);
const PATH = 'src/refunds/service.ts';
const session = (id: string, title: string, runtime: string) => ({
  id,
  title,
  runtime,
  state: 'running',
  waiting: 0,
});
const blame = (chunks: RepoBlame['chunks'], pending: RepoBlame['pending'] = []): RepoBlame => ({
  path: PATH,
  sha: 'a'.repeat(40),
  text: 'one\ntwo\nthree\nfour\n',
  truncated: false,
  chunks,
  pending,
});
const chunk = (start: number, count: number, session_id?: string) => ({
  start,
  count,
  sha: `${start}`.repeat(40),
  author: 'Ada',
  at: NOW - start * 86_400_000,
  ...(session_id ? { session_id } : {}),
});
const commit = (n: number): RepoCommit => ({
  sha: `${n}`.repeat(40),
  parents: [],
  refs: [],
  author: 'Ada',
  author_email: 'ada@example.invalid',
  committed_at: NOW - n * 60_000,
  subject: `Commit number ${n}`,
  body: '',
});
const fileHistory: RepoFileHistory = {
  changes: [commit(1), commit(2)],
  weekly: Array.from({ length: 26 }, (_, i) => ({
    start: NOW - (26 - i) * 604_800_000,
    count: i % 3,
  })),
  cochange: [
    { path: 'src/refunds/idempotency.ts', together: 14 },
    { path: 'locales/zh-CN/refund.json', together: 9 },
  ],
  scanned: 120,
};

beforeEach(() => {
  reads.openRepoView.mockClear();
  reads.sessions = reads.landed([session('refund-cap', 'Refund cap', 'claude')]);
  reads.file = reads.landed({
    path: PATH,
    text: 'one\ntwo\nthree\nfour\n',
    size: 19,
    truncated: false,
  });
  reads.blame = reads.landed(blame([chunk(1, 2, 'refund-cap'), chunk(3, 2)]));
  reads.history = reads.landed(fileHistory);
  mock.board = { board: null, status: { state: 'live' } };
  mock.shell = { openSession: vi.fn() };
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const page = () =>
  mount(() => FileHistory({ projectId: 'file-history', path: PATH, onOpenSession() {} })).value;
/** Renders a function component found in the tree, one level down. */
const expand = (node: ReactElement<any>) =>
  mount(() => (node.type as (props: object) => any)(node.props)).value;
const part = (name: string) => expand(named(page(), name));
const buttons = (tree: unknown) => nodes(tree as never).filter((n) => n.type === 'button');

describe('repository file history', () => {
  it('names the source on the first line of each run, and the user for a run without a session', () => {
    const rows = nodes(part('LineOrigins')).filter((n) => n.props.role === 'row');
    expect(rows.map((r) => text(r.props.children[3]))).toEqual(['one', 'two', 'three', 'four']);
    const who = rows.map((r) => text(r.props.children[0]));
    expect(who[0]).toContain('Refund cap');
    expect(who[1]).toBe('');
    expect(who[2]).toContain(zh('repo.file.you'));
    expect(who[3]).toBe('');
  });

  it('draws the text of the blamed commit, not the worktree text', () => {
    reads.file = reads.landed({
      path: PATH,
      text: 'one\nadded\ntwo\nthree\nfour\n',
      size: 25,
      truncated: false,
    });
    const rows = nodes(part('LineOrigins')).filter((n) => n.props.role === 'row');
    expect(rows.map((r) => text(r.props.children[3]))).toEqual(['one', 'two', 'three', 'four']);
  });

  it('marks running branches whose ranges overlap as conflicting', () => {
    reads.sessions = reads.landed([
      session('refund-cap', 'Refund cap', 'claude'),
      session('idempotent', 'Idempotent refunds', 'codex'),
    ]);
    reads.blame = reads.landed(
      blame(
        [chunk(1, 4)],
        [
          { session_id: 'refund-cap', ranges: [{ start: 2, count: 2 }] },
          { session_id: 'idempotent', ranges: [{ start: 3, count: 1 }] },
        ],
      ),
    );
    expect(text(page())).toContain(zhf('repo.file.editing', { count: 2 }));
    const running = buttons(part('Running'));
    expect(running).toHaveLength(2);
    for (const row of running) expect(text(row.props.children)).toContain(zh('repo.file.conflict'));
    expect(text(running[0]!.props.children)).toContain('2–3');
    const marks = nodes(part('LineOrigins'))
      .filter((n) => n.props.role === 'img')
      .map((n) => n.props['aria-label']);
    expect(marks).toContain(zhf('repo.file.changesLineConflict', { name: 'Idempotent refunds' }));
    running[1]!.props.onClick();
    expect(reads.openRepoView).toHaveBeenCalledWith('file-history', {
      kind: 'session',
      sessionId: 'idempotent',
    });
  });

  it('does not mark running branches whose ranges stay apart', () => {
    reads.sessions = reads.landed([
      session('refund-cap', 'Refund cap', 'claude'),
      session('idempotent', 'Idempotent refunds', 'codex'),
    ]);
    reads.blame = reads.landed(
      blame(
        [chunk(1, 4)],
        [
          { session_id: 'refund-cap', ranges: [{ start: 1, count: 1 }] },
          { session_id: 'idempotent', ranges: [{ start: 3, count: 0 }] },
        ],
      ),
    );
    const running = buttons(part('Running'));
    expect(running).toHaveLength(2);
    for (const row of running)
      expect(text(row.props.children)).not.toContain(zh('repo.file.conflict'));
    const marks = nodes(part('LineOrigins'))
      .filter((n) => n.props.role === 'img')
      .map((n) => n.props['aria-label']);
    expect(marks).toEqual([
      zhf('repo.file.changesLine', { name: 'Refund cap' }),
      zhf('repo.file.changesLine', { name: 'Idempotent refunds' }),
    ]);
  });

  it('joins writers past the fifth kind into other in the ownership bar', () => {
    const runtimes = ['claude', 'codex', 'agy', 'grok', 'gemini'];
    const build = (kinds: string[]) => {
      reads.sessions = reads.landed(kinds.map((r) => session(`s-${r}`, r, r)));
      reads.blame = reads.landed(
        blame([...kinds.map((r, i) => chunk(i + 1, 1, `s-${r}`)), chunk(kinds.length + 1, 1)]),
      );
      return find(part('Owners'), (n) => n.props.role === 'img').props['aria-label'] as string;
    };
    const five = build(runtimes.slice(0, 4));
    expect(five).toContain(zh('repo.file.you'));
    expect(five).not.toContain(zh('repo.file.other'));
    const six = build(runtimes);
    expect(six).toContain(zh('repo.file.other'));
  });

  it('opens the history of a file changed together with this one', () => {
    const rows = buttons(part('Cochange'));
    expect(rows).toHaveLength(2);
    const row = rows.find((n) => text(n.props.children).includes('src/refunds/idempotency.ts'))!;
    expect(text(row.props.children)).toContain(zhf('repo.file.together', { count: 14 }));
    row.props.onClick();
    expect(reads.openRepoView).toHaveBeenCalledWith('file-history', {
      kind: 'file',
      path: 'src/refunds/idempotency.ts',
    });
  });

  it('draws the weekly changes as a labelled chart with the total beside it', () => {
    const chart = find(part('Frequency'), (n) => n.props.role === 'img');
    expect(chart.props['aria-label']).toContain('26');
    const total = fileHistory.weekly.reduce((n, w) => n + w.count, 0);
    expect(text(expand(named(part('Frequency'), 'SideHead')))).toContain(
      zhf('repo.file.frequencyTotal', { weeks: 26, count: total }),
    );
  });
});

describe('commit detail file history', () => {
  it('opens the history of a file from the commit diff', () => {
    const shown = commit(3);
    reads.log = reads.landed({ commits: [shown], has_more: false });
    reads.diff = reads.landed<LandingDiff>({
      source: 'main',
      from_sha: '2'.repeat(40),
      to_sha: shown.sha,
      truncated: false,
      files: [
        { path: PATH, status: 'modified', additions: 1, deletions: 0 },
        { path: 'docs/refunds.md', status: 'added', additions: 1, deletions: 0 },
      ],
      hunks: [
        {
          id: 'H1',
          file: PATH,
          header: '@@ -1 +1,2 @@',
          old_start: 1,
          old_lines: 1,
          new_start: 1,
          new_lines: 2,
          text: ' one\n+two',
        },
      ],
    });
    const tree = mount(() =>
      CommitDetail({ projectId: 'file-history', sha: shown.sha, onOpenSession() {} }),
    ).value;
    find(
      tree,
      (n) => n.type === 'button' && text(n.props.children) === zh('repo.commit.fileHistory'),
    ).props.onClick();
    expect(reads.openRepoView).toHaveBeenCalledWith('file-history', { kind: 'file', path: PATH });
  });
});
