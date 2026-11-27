import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { LandingDiff, RepoCommit, RepoLog, WorkbenchSession } from '@pantheon/protocol';
import { Tabs } from '../../apps/web/node_modules/@base-ui/react/tabs';
import { find, mount, nodes, text, unmountAll, type HookHost } from './web-hook-host.js';

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
    log: (_projectId: string | null, _limit: number, _skip: number, _ref?: string): unknown =>
      landed(null),
    diff: landed(null) as unknown,
    after: landed(null) as unknown,
    useRepoLog: vi.fn(),
    useRepoCommitDiff: vi.fn(),
    useRepoCommitAfter: vi.fn(),
  };
});
vi.mock('@/data/repo', async (actual) => ({
  ...(await actual<object>()),
  useRepoLog: reads.useRepoLog,
  useRepoCommitDiff: reads.useRepoCommitDiff,
  useRepoCommitAfter: reads.useRepoCommitAfter,
}));
import { EmptyState } from '@/components/EmptyState';
import { Failure } from '@/components/PanelBoundary';
import { ChangesScreen } from '@/screens/changes/ChangesScreen';
import { CommitAttribution, CommitDetail } from '@/screens/changes/CommitDetail';
import { CommitHistory } from '@/screens/changes/CommitHistory';
import { layoutCommitGraph } from '@/screens/changes/commit-graph';
import { HunkLines } from '@/screens/sessions/story/parts';
import { zh, zhf } from './i18n-setup.js';

const readHooks = await vi.importActual<typeof import('@/data/repo')>('@/data/repo');

const NOW = Date.UTC(2026, 10, 3, 12);
const commit = (sha: string, over: Partial<RepoCommit> = {}): RepoCommit => ({
  sha,
  parents: [],
  refs: [],
  author: 'Mei',
  author_email: 'mei@example.com',
  committed_at: NOW - 3_600_000,
  subject: `subject of ${sha}`,
  body: '',
  ...over,
});
const sha = (n: number) => n.toString(16).padStart(40, '0');
const page = (from: number, count: number, has_more: boolean): RepoLog => ({
  commits: Array.from({ length: count }, (_, i) =>
    commit(sha(from + i), { parents: [sha(from + i + 1)] }),
  ),
  has_more,
});

const sessions = [
  { id: 'refund-list', title: 'Refund front-end list', state: 'idle', waiting: 0 },
] as unknown as WorkbenchSession[];

beforeEach(() => {
  reads.log = () => reads.landed(null);
  reads.diff = reads.landed(null);
  reads.after = reads.landed(null);
  reads.useRepoLog.mockReset();
  reads.useRepoLog.mockImplementation((projectId, limit, skip, ref) =>
    projectId === null ? reads.landed(null) : reads.log(projectId, limit, skip, ref),
  );
  reads.useRepoCommitDiff.mockReset();
  reads.useRepoCommitDiff.mockImplementation(() => reads.diff);
  reads.useRepoCommitAfter.mockReset();
  reads.useRepoCommitAfter.mockImplementation(() => reads.after);
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

const history = () => mount(() => CommitHistory({ projectId: 'alpha', sessions }));
const options = (tree: unknown) =>
  nodes(tree as ReactNode).filter((n) => n.props.role === 'option');
const listbox = (tree: unknown) =>
  find(tree as ReactNode, (n) => n.props.role === 'listbox' && n.props.tabIndex === 0);
const moreButton = (tree: unknown) =>
  nodes(tree as ReactNode).find(
    (n) => n.type === 'button' && text(n.props.children) === zh('changes.commits.loadMore'),
  );
const detailOf = (tree: unknown) =>
  nodes(tree as ReactNode).find((n) => n.type === CommitDetail) as ReactElement<any> | undefined;
/** What a row's attribution draws; it has no hooks of its own. */
const attribution = (row: ReactElement<any>) => {
  const el = find(row.props.children, (n) => n.type === CommitAttribution);
  return CommitAttribution(el.props) as ReactNode;
};
/** Calls the handlers from the innermost out, as a click bubbles, until one stops it. */
function bubble(...handlers: ((event: unknown) => void)[]) {
  let stopped = false;
  const event = { stopPropagation: () => (stopped = true) };
  for (const handler of handlers) if (!stopped) handler(event);
}
function press(h: HookHost<any>, key: string) {
  listbox(h.value).props.onKeyDown({
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
  });
  h.render();
}

describe('commit graph lanes', () => {
  it('keeps a linear history in one lane', () => {
    const layout = layoutCommitGraph([
      { sha: 'c', parents: ['b'] },
      { sha: 'b', parents: ['a'] },
      { sha: 'a', parents: [] },
    ]);
    expect(layout.columns).toEqual([0, 0, 0]);
    expect(layout.width).toBe(1);
    expect(layout.edges.map((e) => [e.child, e.parent, e.from, e.to])).toEqual([
      [0, 1, 0, 0],
      [1, 2, 0, 0],
    ]);
  });

  it('opens a second lane for the merged side of a merge and joins it at the base', () => {
    const layout = layoutCommitGraph([
      { sha: 'merge', parents: ['base', 'side'] },
      { sha: 'side', parents: ['base'] },
      { sha: 'base', parents: [] },
    ]);
    expect(layout.columns).toEqual([0, 1, 0]);
    expect(layout.width).toBe(2);
    const toSide = layout.edges.find((e) => e.child === 0 && e.parent === 1)!;
    expect(toSide).toMatchObject({ from: 0, lane: 1, to: 1 });
    const sideToBase = layout.edges.find((e) => e.child === 1)!;
    expect(sideToBase).toMatchObject({ from: 1, lane: 1, to: 0 });
  });

  it('puts two branches off one base in two lanes', () => {
    const layout = layoutCommitGraph([
      { sha: 'left', parents: ['base'] },
      { sha: 'right', parents: ['base'] },
      { sha: 'base', parents: [] },
    ]);
    expect(layout.columns).toEqual([0, 1, 0]);
    expect(layout.width).toBe(2);
  });
});

describe('commits tab', () => {
  it('sits before Pull requests in the tab bar and shows the commit graph', async () => {
    vi.stubGlobal('window', {
      addEventListener() {},
      removeEventListener() {},
      pantheon: { query: vi.fn(async () => ({ ok: true, value: { changes: [] } })) },
    });
    const host = mount(() => ChangesScreen({ projectId: 'alpha', sessions }));
    await host.flush();
    const tabs = nodes(host.value).filter((n) => n.type === Tabs.Tab);
    expect(tabs.slice(-2).map((n) => n.props.value)).toEqual(['commits', 'pulls']);
    expect(text(tabs.at(-2)!)).toBe(zh('changes.commits.tab'));
    expect(nodes(host.value).some((n) => n.type === CommitHistory)).toBe(false);
    find(host.value, (n) => n.type === Tabs.Root).props.onValueChange('commits');
    host.render();
    expect(find(host.value, (n) => n.type === Tabs.Root).props.value).toBe('commits');
    expect(find(host.value, (n) => n.type === CommitHistory).props).toMatchObject({
      projectId: 'alpha',
      sessions,
    });
  });

  it('marks a commit a session brought in with the session, which it opens', () => {
    reads.log = () =>
      reads.landed<RepoLog>({
        commits: [
          commit(sha(1), { parents: [sha(2)], session_id: 'refund-list' }),
          commit(sha(2), { parents: [sha(3)], landing_id: 'landing-docs' }),
          commit(sha(3)),
        ],
        has_more: false,
      });
    const [bySession, byLanding, plain] = options(history().value);
    const session = attribution(bySession!);
    const open = find(session, (n) => n.type === 'button');
    expect(text(open.props.children)).toContain('Refund front-end list');
    open.props.onClick({ stopPropagation() {} });
    expect(mock.shell.openSession).toHaveBeenCalledWith('refund-list');
    expect(text(session)).not.toContain(zh('changes.commits.branchLanding'));

    const landing = attribution(byLanding!);
    expect(text(landing)).toBe(zh('changes.commits.branchLanding'));
    expect(nodes(landing).some((n) => n.type === 'button')).toBe(false);

    expect(text(attribution(plain!))).toBe('');
    expect(nodes(attribution(plain!)).some((n) => n.type === 'button' || n.type === 'span')).toBe(
      false,
    );
  });

  it('marks a commit of a session no longer listed as from a deleted session, which opens nothing', () => {
    reads.log = () =>
      reads.landed<RepoLog>({
        commits: [commit(sha(1), { session_id: 'removed-session' })],
        has_more: false,
      });
    const mark = attribution(options(history().value)[0]!);
    expect(text(mark)).toBe(zh('changes.commits.deletedSession'));
    expect(nodes(mark).some((n) => n.type === 'button')).toBe(false);
  });

  it('opens the session from its mark on a row without picking the row', () => {
    reads.log = () =>
      reads.landed<RepoLog>({
        commits: [commit(sha(1), { session_id: 'refund-list' })],
        has_more: false,
      });
    const host = history();
    const row = options(host.value)[0]!;
    const open = find(attribution(row), (n) => n.type === 'button');
    bubble(open.props.onClick, row.props.onClick);
    host.render();
    expect(mock.shell.openSession).toHaveBeenCalledWith('refund-list');
    expect(detailOf(host.value)).toBeUndefined();
  });

  it('leaves a key pressed on a button in the list to that button', () => {
    reads.log = () => reads.landed(page(1, 3, false));
    const host = history();
    const preventDefault = vi.fn();
    listbox(host.value).props.onKeyDown({
      key: 'Enter',
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      target: { tagName: 'BUTTON' },
      currentTarget: { role: 'listbox' },
      preventDefault,
    });
    host.render();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(detailOf(host.value)).toBeUndefined();
  });

  it('lists each commit with its subject, author, time and short SHA', () => {
    reads.log = () =>
      reads.landed<RepoLog>({ commits: [commit('abcdef0123456789')], has_more: false });
    const row = options(history().value)[0]!;
    const line = text(row.props.children);
    for (const part of ['subject of abcdef0123456789', 'Mei', 'abcdef0'])
      expect(line).toContain(part);
    expect(find(row.props.children, (n) => n.type === 'time').props.dateTime).toBe(
      new Date(NOW - 3_600_000).toISOString(),
    );
  });

  it('reads the next 50 commits with More and drops the button once there are no more', () => {
    reads.log = (_p, _limit, skip) =>
      skip === 0 ? reads.landed(page(1, 50, true)) : reads.landed(page(51, 3, false));
    const host = history();
    expect(reads.useRepoLog).toHaveBeenCalledWith('alpha', 50, 0);
    expect(options(host.value)).toHaveLength(50);
    expect(reads.useRepoLog).not.toHaveBeenCalledWith('alpha', 50, 50, sha(1));
    moreButton(host.value)!.props.onClick();
    host.render();
    expect(reads.useRepoLog).toHaveBeenCalledWith('alpha', 50, 50, sha(1));
    expect(options(host.value)).toHaveLength(53);
    expect(moreButton(host.value)).toBeUndefined();
  });

  it('reads the later pages from the commit the first page starts at', () => {
    // Counted from where HEAD is now, the next page would start two commits further back.
    reads.log = (_p, _limit, skip, ref) =>
      skip === 0
        ? reads.landed(page(1, 50, true))
        : reads.landed(ref === sha(1) ? page(51, 3, false) : page(53, 1, false));
    const host = history();
    moreButton(host.value)!.props.onClick();
    host.render();
    expect(options(host.value).map((o) => o.props.id)).toEqual(
      Array.from({ length: 53 }, (_, i) => `chc-${sha(i + 1)}`),
    );
  });

  it('drops the pages read for another project whose HEAD is the same commit', () => {
    // Two clones of one repository: the same commits, landed by sessions of one project only.
    reads.log = (projectId, _limit, skip) => {
      const log = page(1 + skip, 50, true);
      if (projectId !== 'alpha' || skip === 0) return reads.landed(log);
      return reads.landed({
        ...log,
        commits: log.commits.map((c) => ({ ...c, session_id: 'refund-list' })),
      });
    };
    let projectId = 'alpha';
    const host = mount(() => CommitHistory({ projectId, sessions }));
    for (const _ of [1, 2]) {
      moreButton(host.value)!.props.onClick();
      host.render();
    }
    expect(options(host.value)).toHaveLength(150);
    projectId = 'beta';
    host.render();
    const landedBy = options(host.value).map(
      (o) => find(o.props.children, (n) => n.type === CommitAttribution).props.commit.session_id,
    );
    expect(landedBy.filter(Boolean)).toEqual([]);
  });

  it('shows no More button when the first page is all there is', () => {
    reads.log = () => reads.landed(page(1, 3, false));
    expect(moreButton(history().value)).toBeUndefined();
  });

  it('says there are no commits yet for an empty log', () => {
    reads.log = () => reads.landed<RepoLog>({ commits: [], has_more: false });
    const tree = history().value;
    expect(find(tree, (n) => n.type === EmptyState).props.title).toBe(zh('changes.commits.empty'));
    expect(options(tree)).toHaveLength(0);
  });

  it('shows a failed read with a retry', () => {
    const failed = reads.landed(null, 'git failed');
    reads.log = () => failed;
    const tree = history().value;
    const failure = find(tree, (n) => n.type === Failure);
    expect(failure.props.error).toBe('git failed');
    failure.props.onRetry();
    expect(failed.reload).toHaveBeenCalled();
    expect(nodes(tree).some((n) => n.type === EmptyState)).toBe(false);
  });

  it('moves with the list keys, opens with Enter and keeps the opened commit per project', () => {
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    });
    reads.log = () => reads.landed(page(1, 3, false));
    const host = history();
    expect(detailOf(host.value)).toBeUndefined();
    for (const key of ['j', 'j', 'k']) press(host, key);
    expect(listbox(host.value).props['aria-activedescendant']).toBe(`chc-${sha(2)}`);
    press(host, 'Enter');
    expect(detailOf(host.value)!.props.sha).toBe(sha(2));
    expect(options(host.value).map((o) => o.props['aria-selected'])).toEqual([false, true, false]);
    expect([...stored.values()]).toEqual([sha(2)]);
    const again = history();
    expect(detailOf(again.value)!.props.sha).toBe(sha(2));
    const other = mount(() => CommitHistory({ projectId: 'beta', sessions }));
    expect(detailOf(other.value)).toBeUndefined();
  });
});

describe('commit detail', () => {
  const diff: LandingDiff = {
    source: '/repo',
    from_sha: sha(2),
    to_sha: sha(1),
    files: [
      { path: 'src/refunds.ts', status: 'modified', additions: 3, deletions: 1 },
      { path: 'src/list.ts', status: 'added', additions: 9, deletions: 0 },
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
  };
  const BODY = 'Why:\n  - the list paged twice\n    when sorted\n\nDone.';
  const shown = (onOpen = vi.fn()) =>
    mount(() =>
      CommitDetail({
        projectId: 'alpha',
        sha: sha(1),
        commit: commit(sha(1), { parents: [sha(2)], body: BODY, session_id: 'refund-list' }),
        sessions,
        onOpen,
        onClose() {},
      }),
    );
  const nextButton = (tree: unknown) =>
    nodes(tree as ReactNode).find(
      (n) => n.type === 'button' && text(n.props.children) === zh('changes.commits.next'),
    );

  it('keeps the body as written, indentation and blank lines included', () => {
    const body = find(shown().value, (n) => n.type === 'pre');
    expect(body.props.children).toBe(BODY);
  });

  it('lists the files of repo.commit_diff and shows the diff of the picked one', () => {
    reads.diff = reads.landed(diff);
    const host = shown();
    expect(reads.useRepoCommitDiff).toHaveBeenCalledWith('alpha', sha(1));
    const fileButtons = () =>
      nodes(host.value).filter((n) => n.type === 'button' && n.props.className === 'chg-dfl-h');
    expect(fileButtons().map((b) => b.props['aria-label'])).toEqual(
      diff.files.map((f) => zhf('changes.commits.showFile', { path: f.path })),
    );
    const hunks = () =>
      nodes(host.value)
        .filter((n) => n.type === HunkLines)
        .map((n) => n.props.hunk.id);
    expect(hunks()).toEqual(['H1']);
    fileButtons()[1]!.props.onClick();
    host.render();
    expect(hunks()).toEqual(['H2']);
    expect(fileButtons().map((b) => b.props['aria-current'])).toEqual([undefined, true]);
  });

  it('shows the full SHA, the parent and the session that brought the commit in', () => {
    const tree = shown().value;
    const copy = find(tree, (n) => typeof n.type === 'function' && n.type.name === 'CopySha');
    expect(copy.props.sha).toBe(sha(1));
    const drawn = mount(() => (copy.type as (props: unknown) => ReactNode)(copy.props)).value;
    expect(text(drawn)).toContain(sha(1));
    expect(find(drawn, (n) => n.type === 'button').props['aria-label']).toBe(
      zhf('changes.commits.copySha', { sha: sha(1) }),
    );
    expect(nodes(tree).some((n) => n.type === 'button' && n.props.title === sha(2))).toBe(true);
    expect(find(tree, (n) => n.type === CommitAttribution).props.commit.session_id).toBe(
      'refund-list',
    );
  });

  it('opens the next commit that repo.commit_after names', () => {
    const next = commit(sha(9), { parents: [sha(1)] });
    reads.after = reads.landed({ next });
    const onOpen = vi.fn();
    const tree = shown(onOpen).value;
    expect(reads.useRepoCommitAfter).toHaveBeenCalledWith('alpha', sha(1));
    nextButton(tree)!.props.onClick();
    expect(onOpen).toHaveBeenCalledWith(sha(9));
  });

  it('shows a failed read of the next commit with a retry', () => {
    const failed = reads.landed(null, 'git failed');
    reads.after = failed;
    const failure = find(shown().value, (n) => n.type === Failure);
    expect(failure.props.error).toBe('git failed');
    failure.props.onRetry();
    expect(failed.reload).toHaveBeenCalled();
  });

  it('has no next commit button when repo.commit_after has none', () => {
    reads.after = reads.landed({ next: null });
    expect(nextButton(shown().value)).toBeUndefined();
  });
});

describe('repository reads', () => {
  it('asks repo.log for the page after the first fifty, and takes a commit_after without a next', async () => {
    const query = vi.fn(async (method: string) => ({
      ok: true,
      value: method === 'repo.log' ? page(51, 1, false) : { next: null },
    }));
    vi.stubGlobal('window', {
      addEventListener() {},
      removeEventListener() {},
      pantheon: { query },
    });
    const log = mount(() => readHooks.useRepoLog('alpha', 50, 50));
    const after = mount(() => readHooks.useRepoCommitAfter('alpha', sha(1)));
    await log.flush();
    await after.flush();
    expect(query).toHaveBeenCalledWith('repo.log', {
      project_id: 'alpha',
      limit: '50',
      skip: '50',
    });
    expect(log.value.read?.commits).toHaveLength(1);
    expect(after.value.read).toEqual({ next: null });
    expect(after.value.error).toBeNull();
  });
});
