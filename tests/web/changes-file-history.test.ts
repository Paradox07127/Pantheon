import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type {
  LandingDiff,
  ProjectBranch,
  RepoBlame,
  RepoCommit,
  RepoCompare,
  RepoFileHistory,
  WorkbenchSession,
} from '@pantheon/protocol';
import { RadioGroup } from '../../apps/web/node_modules/@base-ui/react/radio-group';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';

const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector: any) => selector(mock.shell), {
    getState: () => mock.shell,
    setState: (patch: object) => Object.assign(mock.shell, patch),
  }),
  resolveTheme: () => 'light',
}));
// The repository reads, each landed with what the test sets.
const reads = vi.hoisted(() => {
  const landed = <T>(data: T, error: string | null = null) => ({
    read: data,
    loading: false,
    stale: false,
    unavailable: false,
    error,
    reload: vi.fn(),
  });
  return {
    landed,
    log: landed(null) as unknown,
    diff: landed(null) as unknown,
    after: landed(null) as unknown,
    blame: landed(null) as unknown,
    history: landed(null) as unknown,
    compare: landed(null) as unknown,
    branches: landed(null) as unknown,
    useRepoLog: vi.fn(),
    useRepoCommitDiff: vi.fn(),
    useRepoCommitAfter: vi.fn(),
    useRepoBlame: vi.fn(),
    useRepoFileHistory: vi.fn(),
    useRepoCompare: vi.fn(),
    useRepoBranches: vi.fn(),
  };
});
vi.mock('@/data/repo', async (actual) => ({
  ...(await actual<object>()),
  useRepoLog: reads.useRepoLog,
  useRepoCommitDiff: reads.useRepoCommitDiff,
  useRepoCommitAfter: reads.useRepoCommitAfter,
  useRepoBlame: reads.useRepoBlame,
  useRepoFileHistory: reads.useRepoFileHistory,
  useRepoCompare: reads.useRepoCompare,
  useRepoBranches: reads.useRepoBranches,
}));
import { Failure } from '@/components/PanelBoundary';
import { Select } from '@/components/Select';
import { BranchCompare } from '@/screens/changes/BranchCompare';
import { CommitAttribution, CommitDetail } from '@/screens/changes/CommitDetail';
import { CommitHistory } from '@/screens/changes/CommitHistory';
import { FileHistory } from '@/screens/changes/FileHistory';
import { HunkLines } from '@/screens/sessions/story/parts';
import { zh, zhf } from './i18n-setup.js';

const readHooks = await vi.importActual<typeof import('@/data/repo')>('@/data/repo');

const NOW = Date.UTC(2026, 10, 3, 12);
const sha = (n: number) => n.toString(16).padStart(40, '0');
const commit = (id: string, over: Partial<RepoCommit> = {}): RepoCommit => ({
  sha: id,
  parents: [],
  refs: [],
  author: 'Mei',
  author_email: 'mei@example.com',
  committed_at: NOW - 3_600_000,
  subject: `subject of ${id}`,
  body: '',
  ...over,
});
const sessions = [
  { id: 'refund-list', title: 'Refund front-end list', state: 'idle', waiting: 0 },
] as unknown as WorkbenchSession[];

beforeEach(() => {
  for (const key of ['log', 'diff', 'after', 'blame', 'history', 'compare', 'branches'] as const)
    reads[key] = reads.landed(null);
  const hooks = {
    useRepoLog: 'log',
    useRepoCommitDiff: 'diff',
    useRepoCommitAfter: 'after',
    useRepoBlame: 'blame',
    useRepoFileHistory: 'history',
    useRepoCompare: 'compare',
    useRepoBranches: 'branches',
  } as const;
  for (const [hook, key] of Object.entries(hooks)) {
    reads[hook as keyof typeof hooks].mockReset();
    reads[hook as keyof typeof hooks].mockImplementation((projectId: string | null) =>
      projectId === null ? reads.landed(null) : reads[key],
    );
  }
  mock.board = {
    board: { cursor: 1, projects: [], sessions: [], workspaces: [], session_turns: [] },
    reads: {},
    events: [],
    status: { state: 'live' },
    resync: 0,
  };
  mock.shell = { openSession: vi.fn() };
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const classed = (tree: unknown, className: string) =>
  nodes(tree as ReactNode).filter((n) => n.props.className === className);
const buttonNamed = (tree: unknown, name: string) =>
  nodes(tree as ReactNode).find((n) => n.type === 'button' && n.props['aria-label'] === name);

const fileHistory = (over: Partial<Parameters<typeof FileHistory>[0]> = {}) => {
  const props = {
    projectId: 'alpha',
    path: 'src/refunds.ts',
    at: sha(1),
    sessions,
    onOpenCommit: vi.fn(),
    onOpenFile: vi.fn(),
    onBack: vi.fn(),
    ...over,
  };
  return { props, host: mount(() => FileHistory(props)) };
};

describe('file blame', () => {
  const blame: RepoBlame = {
    path: 'src/refunds.ts',
    sha: sha(1),
    text: 'one\ntwo\nthree\nfour\n',
    truncated: false,
    chunks: [
      { start: 1, count: 2, sha: sha(3), author: 'Mei', at: NOW - 86_400_000 },
      {
        start: 3,
        count: 2,
        sha: sha(1),
        author: 'Ana',
        at: NOW - 3_600_000,
        session_id: 'refund-list',
      },
    ],
    pending: [{ session_id: 'refund-list', ranges: [{ start: 4, count: 1 }] }],
  };

  it('reads repo.blame of the file at the commit it was opened from, and repo.file_history of the file', () => {
    fileHistory();
    expect(reads.useRepoBlame).toHaveBeenCalledWith('alpha', 'src/refunds.ts', sha(1));
    expect(reads.useRepoFileHistory).toHaveBeenCalledWith('alpha', 'src/refunds.ts');
  });

  it('shows each run of lines with its commit, author and attribution, and picks a commit from its SHA', () => {
    reads.blame = reads.landed(blame);
    const { props, host } = fileHistory();
    const chunks = classed(host.value, 'chf-chunk');
    expect(chunks).toHaveLength(2);
    expect(classed(chunks[0], 'chf-code').map((n) => text(n))).toEqual(['one', 'two']);
    expect(classed(chunks[1], 'chf-code').map((n) => text(n))).toEqual(['three', 'four']);
    const [older, newer] = chunks.map((c) => find(c, (n) => n.props.className === 'chf-who'));
    expect(text(older)).toContain('Mei');
    expect(text(newer)).toContain('Ana');
    const shaButton = find(older, (n) => n.type === 'button');
    expect(text(shaButton)).toBe(sha(3).slice(0, 7));
    shaButton.props.onClick();
    expect(props.onOpenCommit).toHaveBeenCalledWith(sha(3));
    const attributed = (c: ReactElement) =>
      find(c, (n) => n.type === CommitAttribution).props.commit;
    expect(attributed(older!).session_id).toBeUndefined();
    expect(attributed(newer!).session_id).toBe('refund-list');
  });

  it("marks the lines a session's worktree changes and has not merged", () => {
    reads.blame = reads.landed(blame);
    const lines = classed(fileHistory().host.value, 'chf-ln');
    expect(lines.map((n) => n.props['data-pending'])).toEqual([
      undefined,
      undefined,
      undefined,
      true,
    ]);
    const mark = find(lines[3], (n) => n.props.role === 'img');
    expect(mark.props['aria-label']).toBe(
      zhf('changes.commits.file.pending', { name: 'Refund front-end list' }),
    );
  });

  it('says a binary file shows no content', () => {
    reads.blame = reads.landed<RepoBlame>({ ...blame, text: undefined });
    const tree = fileHistory().host.value;
    expect(text(tree)).toContain(zh('changes.commits.file.binary'));
    expect(classed(tree, 'chf-ln')).toHaveLength(0);
  });

  it('says only the first part shows when the read was cut', () => {
    reads.blame = reads.landed<RepoBlame>({ ...blame, truncated: true });
    const tree = fileHistory().host.value;
    expect(text(tree)).toContain(zhf('changes.commits.file.partial', { count: 4 }));
    reads.blame = reads.landed(blame);
    expect(text(fileHistory().host.value)).not.toContain(
      zhf('changes.commits.file.partial', { count: 4 }),
    );
  });

  it('shows a failed blame with a retry', () => {
    const failed = reads.landed(null, 'git failed');
    reads.blame = failed;
    const failure = find(fileHistory().host.value, (n) => n.type === Failure);
    expect(failure.props.error).toBe('git failed');
    failure.props.onRetry();
    expect(failed.reload).toHaveBeenCalled();
  });

  it('marks an insertion at the top of the file on its first line', () => {
    reads.blame = reads.landed<RepoBlame>({
      ...blame,
      pending: [{ session_id: 'refund-list', ranges: [{ start: 0, count: 0 }] }],
    });
    const lines = classed(fileHistory().host.value, 'chf-ln');
    expect(lines.map((n) => n.props['data-pending'])).toEqual([
      true,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('marks only the shown lines of a pending range far longer than the file', () => {
    reads.blame = reads.landed<RepoBlame>({
      ...blame,
      pending: [{ session_id: 'refund-list', ranges: [{ start: 2, count: 50_000_000 }] }],
    });
    const set = Map.prototype.set;
    let sets = 0;
    const spy = vi.spyOn(Map.prototype, 'set').mockImplementation(function (
      this: Map<any, any>,
      ...args
    ) {
      if (++sets > 100_000) throw new Error('marked lines beyond the shown ones');
      return set.apply(this, args);
    });
    try {
      const lines = classed(fileHistory().host.value, 'chf-ln');
      expect(lines.map((n) => n.props['data-pending'])).toEqual([undefined, true, true, true]);
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps the blame shown and still offers a retry when a reload fails', () => {
    const failed = reads.landed(blame, 'git failed');
    reads.blame = failed;
    const tree = fileHistory().host.value;
    expect(classed(tree, 'chf-chunk')).toHaveLength(2);
    const failure = find(tree, (n) => n.type === Failure);
    expect(failure.props.error).toBe('git failed');
    failure.props.onRetry();
    expect(failed.reload).toHaveBeenCalled();
  });
});

describe('file history', () => {
  const weekly = Array.from({ length: 26 }, (_, i) => ({
    start: NOW - (26 - i) * 7 * 86_400_000,
    count: i % 3,
  }));
  const history: RepoFileHistory = {
    changes: [commit(sha(5)), commit(sha(6), { session_id: 'refund-list' })],
    weekly,
    cochange: [
      { path: 'src/list.ts', together: 3 },
      { path: 'src/api.ts', together: 1 },
    ],
    scanned: 40,
  };

  it('draws the 26 weeks as 26 bars', () => {
    reads.history = reads.landed(history);
    const weeks = find(fileHistory().host.value, (n) => n.props.className === 'chf-weeks');
    expect(weeks.props.role).toBe('img');
    expect(nodes(weeks.props.children).filter((n) => n.type === 'i')).toHaveLength(26);
  });

  it('picks a commit from its change row', () => {
    reads.history = reads.landed(history);
    const { props, host } = fileHistory();
    const rows = classed(host.value, 'chf-row');
    expect(rows.map((r) => text(r))).toEqual([
      expect.stringContaining('subject of ' + sha(5)),
      expect.stringContaining('subject of ' + sha(6)),
    ]);
    rows[1]!.props.onClick();
    expect(props.onOpenCommit).toHaveBeenCalledWith(sha(6));
  });

  it('opens the history of a file often changed with it', () => {
    reads.history = reads.landed(history);
    const { props, host } = fileHistory();
    const files = classed(host.value, 'chf-co');
    expect(files.map((f) => f.props.title)).toEqual(['src/list.ts', 'src/api.ts']);
    files[0]!.props.onClick();
    expect(props.onOpenFile).toHaveBeenCalledWith('src/list.ts');
  });

  it('goes back to the commit with its back button', () => {
    const { props, host } = fileHistory();
    buttonNamed(host.value, zh('changes.commits.file.back'))!.props.onClick();
    expect(props.onBack).toHaveBeenCalled();
  });

  it('shows a failed history read with a retry', () => {
    const failed = reads.landed(null, 'log failed');
    reads.history = failed;
    const failure = find(fileHistory().host.value, (n) => n.type === Failure);
    expect(failure.props.error).toBe('log failed');
    failure.props.onRetry();
    expect(failed.reload).toHaveBeenCalled();
  });

  it('keeps the history shown and still offers a retry when a reload fails', () => {
    const failed = reads.landed(history, 'log failed');
    reads.history = failed;
    const tree = fileHistory().host.value;
    expect(classed(tree, 'chf-row')).toHaveLength(2);
    const failure = find(tree, (n) => n.type === Failure);
    expect(failure.props.error).toBe('log failed');
    failure.props.onRetry();
    expect(failed.reload).toHaveBeenCalled();
  });
});

describe('file history from a commit', () => {
  const diff: LandingDiff = {
    source: '/repo',
    from_sha: sha(2),
    to_sha: sha(1),
    files: [{ path: 'src/refunds.ts', status: 'modified', additions: 3, deletions: 1 }],
    hunks: [],
    truncated: false,
  };

  it.each([
    ['a file the commit changed', 'src/refunds.ts', sha(1)],
    ['a file the commit deleted', 'src/old.ts', `${sha(1)}^`],
    ['a file reached from its co-changes', 'src/other.ts', undefined],
  ])('reads the lines of %s at the right revision', (_, path, at) => {
    reads.diff = reads.landed<LandingDiff>({
      ...diff,
      files: [...diff.files, { path: 'src/old.ts', status: 'deleted', additions: 0, deletions: 4 }],
    });
    const host = mount(() =>
      CommitDetail({
        projectId: 'alpha',
        sha: sha(1),
        commit: commit(sha(1)),
        sessions,
        onOpen() {},
        onClose() {},
      }),
    );
    const first = path === 'src/other.ts' ? 'src/refunds.ts' : path;
    buttonNamed(host.value, zhf('changes.commits.file.open', { path: first }))!.props.onClick();
    host.render();
    if (path !== first) {
      find(host.value, (n) => n.type === FileHistory).props.onOpenFile(path);
      host.render();
    }
    expect(find(host.value, (n) => n.type === FileHistory).props.at).toBe(at);
  });

  it("opens a changed file's history in the detail and comes back to the commit", () => {
    reads.diff = reads.landed(diff);
    const onOpen = vi.fn();
    const host = mount(() =>
      CommitDetail({
        projectId: 'alpha',
        sha: sha(1),
        commit: commit(sha(1)),
        sessions,
        onOpen,
        onClose() {},
      }),
    );
    const open = buttonNamed(
      host.value,
      zhf('changes.commits.file.open', { path: 'src/refunds.ts' }),
    );
    open!.props.onClick();
    host.render();
    const shown = find(host.value, (n) => n.type === FileHistory);
    expect(shown.props.path).toBe('src/refunds.ts');
    expect(shown.props.at).toBe(sha(1));
    shown.props.onOpenFile('src/list.ts');
    host.render();
    expect(find(host.value, (n) => n.type === FileHistory).props.path).toBe('src/list.ts');
    find(host.value, (n) => n.type === FileHistory).props.onOpenCommit(sha(7));
    expect(onOpen).toHaveBeenCalledWith(sha(7));
    find(host.value, (n) => n.type === FileHistory).props.onBack();
    host.render();
    expect(nodes(host.value).some((n) => n.type === FileHistory)).toBe(false);
    expect(host.value.props['aria-label']).toBe(
      zhf('changes.commits.detail', { sha: sha(1).slice(0, 7) }),
    );
  });
});

describe('branch compare', () => {
  const branch = (name: string, commit_time: number, checked_out = false): ProjectBranch => ({
    name,
    sha: sha(commit_time),
    commit_time,
    checked_out,
  });
  // Newest commit first, as project.branches lists them.
  const branches = [
    branch('pantheon/refund-list', 30),
    branch('main', 20, true),
    branch('docs', 10),
  ];
  const compared: RepoCompare = {
    source: '/repo',
    from_sha: sha(20),
    to_sha: sha(30),
    files: [
      { path: 'src/refunds.ts', status: 'modified', additions: 3, deletions: 1 },
      { path: 'src/list.ts', status: 'added', additions: 9, deletions: 0 },
      { path: 'src/api.ts', status: 'modified', additions: 1, deletions: 1 },
    ],
    hunks: [
      {
        id: 'H1',
        file: 'src/refunds.ts',
        header: '@@ -1,2 +1,4 @@',
        old_start: 1,
        old_lines: 2,
        new_start: 1,
        new_lines: 4,
        text: '+a\n-b',
      },
      {
        id: 'H2',
        file: 'src/list.ts',
        header: '@@ -0,0 +1,9 @@',
        old_start: 0,
        old_lines: 0,
        new_start: 1,
        new_lines: 9,
        text: '+c',
      },
    ],
    truncated: false,
    merge_base: sha(20),
    ahead: 4,
    behind: 2,
    conflicts: [{ path: 'src/api.ts', line: 12, base_lines: ['a'], head_lines: ['b'] }],
    previewed_at: NOW,
    single_owner_files: 1,
  };
  const compare = () => mount(() => BranchCompare({ projectId: 'alpha' }));
  const fact = (tree: unknown, name: string) =>
    text(find(tree as ReactNode, (n) => n.props['data-fact'] === name));

  it('compares the most recently committed other branch against the current one by default', () => {
    reads.branches = reads.landed(branches);
    const tree = compare().value;
    expect(reads.useRepoCompare).toHaveBeenLastCalledWith(
      'alpha',
      'refs/heads/main',
      'refs/heads/pantheon/refund-list',
    );
    const selects = nodes(tree).filter((n) => n.type === Select);
    expect(selects.map((s) => s.props.value)).toEqual(['main', 'pantheon/refund-list']);
  });

  it('compares the branches picked instead', () => {
    reads.branches = reads.landed(branches);
    const host = compare();
    const head = () =>
      find(
        host.value,
        (n) => n.type === Select && n.props['aria-label'] === zh('changes.commits.compare.head'),
      );
    head().props.onChange('docs');
    host.render();
    expect(reads.useRepoCompare).toHaveBeenLastCalledWith(
      'alpha',
      'refs/heads/main',
      'refs/heads/docs',
    );
    expect(head().props.value).toBe('docs');
  });

  it('shows ahead, behind, conflicts and the files only this branch changes as repo.compare gives them', () => {
    reads.branches = reads.landed(branches);
    reads.compare = reads.landed(compared);
    const tree = compare().value;
    expect(fact(tree, 'ahead')).toContain('4');
    expect(fact(tree, 'behind')).toContain('2');
    expect(fact(tree, 'conflicts')).toContain('1');
    expect(fact(tree, 'single')).toContain('1');
    expect(fact(tree, 'shared')).toContain('2');
    const conflicts = classed(tree, 'chb-conflict');
    expect(conflicts.map((c) => text(c))).toEqual([expect.stringContaining('src/api.ts')]);
    expect(text(conflicts[0])).toContain(zhf('changes.commits.compare.line', { line: 12 }));
    expect(text(tree)).not.toContain(zh('changes.commits.compare.noConflicts'));
  });

  it('says there are no conflicts when the merge preview found none', () => {
    reads.branches = reads.landed(branches);
    reads.compare = reads.landed<RepoCompare>({ ...compared, conflicts: [] });
    const tree = compare().value;
    expect(text(tree)).toContain(zh('changes.commits.compare.noConflicts'));
    expect(classed(tree, 'chb-conflict')).toHaveLength(0);
  });

  it('lists the changed files and shows the diff of the picked one', () => {
    reads.branches = reads.landed(branches);
    reads.compare = reads.landed(compared);
    const host = compare();
    const fileButtons = () =>
      nodes(host.value).filter((n) => n.type === 'button' && n.props.className === 'chg-dfl-h');
    expect(fileButtons().map((b) => b.props['aria-label'])).toEqual(
      compared.files.map((f) => zhf('changes.commits.showFile', { path: f.path })),
    );
    const hunks = () =>
      nodes(host.value)
        .filter((n) => n.type === HunkLines)
        .map((n) => n.props.hunk.id);
    expect(hunks()).toEqual(['H1']);
    fileButtons()[1]!.props.onClick();
    host.render();
    expect(hunks()).toEqual(['H2']);
  });

  it('shows a failed compare and a failed branch read, each with a retry', () => {
    const failedBranches = reads.landed(null, 'branches failed');
    reads.branches = failedBranches;
    let failure = find(compare().value, (n) => n.type === Failure);
    expect(failure.props.error).toBe('branches failed');
    failure.props.onRetry();
    expect(failedBranches.reload).toHaveBeenCalled();

    const failedCompare = reads.landed(null, 'compare failed');
    reads.branches = reads.landed(branches);
    reads.compare = failedCompare;
    failure = find(compare().value, (n) => n.type === Failure);
    expect(failure.props.error).toBe('compare failed');
    failure.props.onRetry();
    expect(failedCompare.reload).toHaveBeenCalled();
  });

  it('keeps the compare and the branches shown and still offers a retry when a reload fails', () => {
    const failedCompare = reads.landed(compared, 'compare failed');
    reads.branches = reads.landed(branches);
    reads.compare = failedCompare;
    let tree = compare().value;
    expect(fact(tree, 'ahead')).toContain('4');
    let failure = find(tree, (n) => n.type === Failure);
    expect(failure.props.error).toBe('compare failed');
    failure.props.onRetry();
    expect(failedCompare.reload).toHaveBeenCalled();

    const failedBranches = reads.landed(branches, 'branches failed');
    reads.branches = failedBranches;
    reads.compare = reads.landed(compared);
    tree = compare().value;
    expect(nodes(tree).filter((n) => n.type === Select)).toHaveLength(2);
    failure = find(tree, (n) => n.type === Failure);
    expect(failure.props.error).toBe('branches failed');
    failure.props.onRetry();
    expect(failedBranches.reload).toHaveBeenCalled();
  });

  it('says 20 or more conflicting files when the merge preview hits its bound', () => {
    reads.branches = reads.landed(branches);
    const conflicts = Array.from({ length: 20 }, (_, i) => ({
      path: `src/file-${i}.ts`,
      line: 1,
      base_lines: [],
      head_lines: [],
    }));
    reads.compare = reads.landed<RepoCompare>({ ...compared, conflicts });
    expect(fact(compare().value, 'conflicts')).toContain(
      zhf('changes.commits.compare.conflictsBound', { count: 20 }),
    );
    reads.compare = reads.landed<RepoCompare>({ ...compared, conflicts: conflicts.slice(1) });
    expect(fact(compare().value, 'conflicts')).not.toContain(
      zhf('changes.commits.compare.conflictsBound', { count: 20 }),
    );
  });

  it('swaps the two sides when one picks the branch the other side holds', () => {
    reads.branches = reads.landed(branches);
    const host = compare();
    const select = (name: string) =>
      find(
        host.value,
        (n) => n.type === Select && n.props['aria-label'] === zh(`changes.commits.compare.${name}`),
      );
    const names = (name: string) =>
      select(name).props.options.map((o: { value: string }) => o.value);
    expect(names('base')).toEqual(['pantheon/refund-list', 'main', 'docs']);
    expect(names('head')).toEqual(['pantheon/refund-list', 'main', 'docs']);
    select('base').props.onChange('pantheon/refund-list');
    host.render();
    expect(select('base').props.value).toBe('pantheon/refund-list');
    expect(select('head').props.value).toBe('main');
    expect(reads.useRepoCompare).toHaveBeenLastCalledWith(
      'alpha',
      'refs/heads/pantheon/refund-list',
      'refs/heads/main',
    );
    select('head').props.onChange('pantheon/refund-list');
    host.render();
    expect(select('base').props.value).toBe('main');
    expect(select('head').props.value).toBe('pantheon/refund-list');
  });

  it('switches the commits tab between the graph and the compare', () => {
    const host = mount(() => CommitHistory({ projectId: 'alpha', sessions }));
    const view = () =>
      find(
        host.value,
        (n) => n.type === RadioGroup && n.props['aria-label'] === zh('changes.commits.view'),
      );
    expect(view().props.value).toBe('graph');
    expect(nodes(host.value).some((n) => n.type === BranchCompare)).toBe(false);
    view().props.onValueChange('compare');
    host.render();
    expect(find(host.value, (n) => n.type === BranchCompare).props.projectId).toBe('alpha');
  });
});

describe('file and compare reads', () => {
  it('asks repo.blame at a commit with that commit as ref', async () => {
    const query = vi.fn(async () => ({
      ok: true,
      value: { path: 'a.ts', sha: sha(1), truncated: false, chunks: [], pending: [] },
    }));
    vi.stubGlobal('window', {
      addEventListener() {},
      removeEventListener() {},
      pantheon: { query },
    });
    await mount(() => readHooks.useRepoBlame('alpha', 'a.ts', sha(1))).flush();
    expect(query).toHaveBeenCalledWith('repo.blame', {
      project_id: 'alpha',
      path: 'a.ts',
      ref: sha(1),
    });
  });

  it('asks repo.blame, repo.file_history, repo.compare and project.branches with their input', async () => {
    const values: Record<string, unknown> = {
      'repo.blame': { path: 'a.ts', sha: sha(1), truncated: false, chunks: [], pending: [] },
      'repo.file_history': { changes: [], weekly: [], cochange: [], scanned: 0 },
      'repo.compare': { files: [], hunks: [], ahead: 0, behind: 0, single_owner_files: 0 },
      'project.branches': [],
    };
    const query = vi.fn(async (method: string) => ({ ok: true, value: values[method] }));
    vi.stubGlobal('window', {
      addEventListener() {},
      removeEventListener() {},
      pantheon: { query },
    });
    const hosts = [
      mount(() => readHooks.useRepoBlame('alpha', 'a.ts')),
      mount(() => readHooks.useRepoFileHistory('alpha', 'a.ts')),
      mount(() => readHooks.useRepoCompare('alpha', 'main', 'feature')),
      mount(() => readHooks.useRepoBranches('alpha')),
    ];
    for (const host of hosts) await host.flush();
    expect(query).toHaveBeenCalledWith('repo.blame', { project_id: 'alpha', path: 'a.ts' });
    expect(query).toHaveBeenCalledWith('repo.file_history', { project_id: 'alpha', path: 'a.ts' });
    expect(query).toHaveBeenCalledWith('repo.compare', {
      project_id: 'alpha',
      base: 'main',
      head: 'feature',
    });
    expect(query).toHaveBeenCalledWith('project.branches', { project_id: 'alpha' });
    expect(hosts.map((h) => h.value.read)).toEqual(Object.values(values));
  });
});
