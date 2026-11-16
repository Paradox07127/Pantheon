import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { LandingDiff, RepoCommit, RepoCommitAfter, RepoLog } from '@pantheon/protocol';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  board: {} as any,
  shell: {} as any,
  run: null as unknown as (...args: any[]) => Promise<unknown>,
}));
const store = vi.hoisted(
  () => (state: () => any) =>
    Object.assign((selector?: any) => (selector ? selector(state()) : state()), {
      getState: state,
      setState: (patch: object) => Object.assign(state(), patch),
    }),
);
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'graph-id' }),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({ useShell: store(() => mock.shell) }));
vi.mock('@/data/commands', async (actual) => ({
  ...(await actual<object>()),
  runCommand: (...args: unknown[]) => mock.run(...args),
}));
// Reads by the page they skip to, or by the ref a commit's own read names; each landed and kept.
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
  const idle = landed(null);
  const logs = new Map<string, unknown>();
  return {
    landed,
    logs,
    diff: idle as unknown,
    after: idle as unknown,
    stories: landed([] as unknown[]),
    sessions: landed([] as unknown[]),
    useRepoLog: vi.fn((projectId: string | null, _limit: number, skip = 0, ref?: string) =>
      projectId === null ? idle : (logs.get(ref ?? String(skip)) ?? idle),
    ),
  };
});
vi.mock('@/data/repo', async (actual) => ({
  ...(await actual<object>()),
  useRepoLog: reads.useRepoLog,
  useRepoCommitDiff: () => reads.diff,
  useRepoCommitAfter: () => reads.after,
}));
vi.mock('@/data/runtime-models', async (actual) => ({
  ...(await actual<object>()),
  useProjectHead: () => reads.landed({ branch: 'main', sha: '4'.repeat(40), subject: 'Head' }),
}));
vi.mock('@/data/workbench-sessions', async (actual) => ({
  ...(await actual<object>()),
  useSessionList: () => reads.sessions,
}));
vi.mock('@/data/change-story', async (actual) => ({
  ...(await actual<object>()),
  useChangeStories: () => reads.stories,
}));
import { IdText } from '@/components/IdText';
import { durationText } from '@/screens/board/panels-model';
import { CommitDetail } from '@/screens/repo/history/CommitDetail';
import { CommitGraph } from '@/screens/repo/history/CommitGraph';
import { RepoScreen } from '@/screens/repo/RepoScreen';
import { useRepoView } from '@/screens/repo/route';
import { TimelineControls, TimelineTab } from '@/screens/repo/TimelineTab';
import { zh, zhf } from './i18n-setup.js';

const NOW = Date.UTC(2026, 10, 3, 12);
const commit = (n: number, parent?: number): RepoCommit => ({
  sha: `${n}`.repeat(40),
  parents: parent === undefined ? [] : [`${parent}`.repeat(40)],
  refs: n === 4 ? ['main'] : [],
  author: 'Ada',
  author_email: 'ada@example.invalid',
  committed_at: NOW - n * 60_000,
  subject: `Commit number ${n}`,
  body: '',
});
const firstPage: RepoLog = { commits: [commit(4, 3), commit(3, 2), commit(2, 1)], has_more: true };
const secondPage: RepoLog = { commits: [commit(1)], has_more: false };

let stored: Map<string, string>;
beforeEach(() => {
  stored = new Map();
  reads.logs.clear();
  reads.logs.set('0', reads.landed(firstPage));
  reads.logs.set('200', reads.landed(secondPage));
  reads.useRepoLog.mockClear();
  reads.sessions = reads.landed([]);
  reads.diff = reads.landed(null);
  reads.after = reads.landed(null);
  reads.stories = reads.landed([]);
  mock.board = { board: null, status: { state: 'live' } };
  mock.shell = { openSession: vi.fn() };
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

const graph = (projectId: string) => mount(() => CommitGraph({ projectId, onOpenSession() {} }));
const options = (tree: unknown) => nodes(tree as never).filter((n) => n.props.role === 'option');
const loadMore = (tree: unknown) =>
  nodes(tree as never).find(
    (n) => n.type === 'button' && text(n.props.children) === zh('repo.history.loadMore'),
  );
/** Renders a function component found in the tree, one level down. */
const expand = (node: ReactElement<any>) =>
  mount(() => (node.type as (props: object) => any)(node.props)).value;
const press = (key: string) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  preventDefault: vi.fn(),
});

describe('repository commit graph', () => {
  it('lists the commits once the timeline shows the commit graph, and keeps that view per project', () => {
    const tab = mount(() => TimelineTab({ projectId: 'history-graph', onOpenSession() {} }));
    const controls = mount(() => TimelineControls({ projectId: 'history-graph' }));
    const views = () =>
      find(controls.value, (n) => n.props['aria-label'] === zh('repo.history.views'));
    expect(views().props.value).toBe('lanes');
    expect(nodes(tab.value).some((n) => n.type === CommitGraph)).toBe(false);
    views().props.onValueChange('graph');
    tab.render();
    controls.render();
    expect(views().props.value).toBe('graph');
    expect(stored.get('pantheon.repo.timeline.history-graph')).toBe('graph');

    const shown = find(tab.value, (n) => n.type === CommitGraph) as ReactElement<any>;
    const tree = mount(() => CommitGraph(shown.props)).value;
    const rows = options(tree);
    expect(rows).toHaveLength(3);
    firstPage.commits.forEach((c, i) => {
      expect(text(rows[i]!.props.children)).toContain(c.subject);
      expect(text(rows[i]!.props.children)).toContain(c.sha.slice(0, 7));
    });
    expect(text(rows[0]!.props.children)).toContain('main');
    const drawn = find(tree, (n) => typeof n.type === 'function' && n.type.name === 'GraphLines');
    const lines = find(expand(drawn), (n) => n.props.role === 'img');
    expect(lines.props['aria-label']).toBe(zhf('repo.history.graphLabel', { count: 3, lines: 1 }));
  });

  it('reads the next page with skip when more is loaded', () => {
    const host = graph('history-more');
    expect(reads.useRepoLog).toHaveBeenCalledWith('history-more', 200, 0);
    expect(reads.useRepoLog).not.toHaveBeenCalledWith('history-more', 200, 200);
    loadMore(host.value)!.props.onClick();
    host.render();
    expect(reads.useRepoLog).toHaveBeenCalledWith('history-more', 200, 200);
    expect(options(host.value).map((n) => n.props.id)).toEqual(
      [...firstPage.commits, ...secondPage.commits].map((c) => `graph-id-${c.sha}`),
    );
    expect(loadMore(host.value)).toBeUndefined();
  });

  it('moves the highlight with J and K and opens the highlighted commit with Enter', () => {
    const host = graph('history-open');
    const list = () =>
      find(host.value, (n) => n.props['aria-label'] === zh('repo.history.commits'));
    const selected = () => options(host.value).findIndex((n) => n.props['aria-selected']);
    expect(list().props.role).toBe('listbox');
    expect(selected()).toBe(0);
    list().props.onKeyDown(press('j'));
    host.render();
    list().props.onKeyDown(press('j'));
    host.render();
    list().props.onKeyDown(press('k'));
    host.render();
    expect(selected()).toBe(1);
    expect(list().props['aria-activedescendant']).toBe(`graph-id-${firstPage.commits[1]!.sha}`);
    const enter = press('Enter');
    list().props.onKeyDown(enter);
    expect(enter.preventDefault).toHaveBeenCalled();

    const screen = mount(() => RepoScreen({ projectId: 'history-open', onOpenSession() {} }));
    const detail = find(screen.value, (n) => n.type === CommitDetail);
    expect(detail.props.sha).toBe(firstPage.commits[1]!.sha);
  });

  it('copies a row’s whole sha and titles its subject and author with their full text', () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { userAgent: 'Macintosh', clipboard: { writeText } });
    const rows = options(graph('history-copy').value);
    const copy = (i: number) =>
      find(
        rows[i],
        (n) =>
          n.type === 'button' &&
          n.props['aria-label'] === zhf('repo.history.copySha', { sha: firstPage.commits[i]!.sha }),
      );
    copy(1).props.onClick();
    expect(writeText).toHaveBeenCalledWith(firstPage.commits[1]!.sha);
    expect(copy(0).props.tabIndex).toBe(0);
    expect(copy(1).props.tabIndex).toBe(-1);
    const titled = nodes(rows[1]).map((n) => n.props.title);
    expect(titled).toContain('Commit number 3');
    expect(titled).toContain('Ada');
  });
});

const SHOWN = { ...commit(3, 2), session_id: 'refund-cap' };
const DIFF: LandingDiff = {
  source: 'main',
  from_sha: '2'.repeat(40),
  to_sha: SHOWN.sha,
  truncated: false,
  files: [
    { path: 'src/refunds/cap.ts', status: 'modified', additions: 2, deletions: 1 },
    { path: 'docs/refunds.md', status: 'added', additions: 1, deletions: 0 },
  ],
  hunks: [
    {
      id: 'H1',
      file: 'src/refunds/cap.ts',
      header: '@@ -1,2 +1,3 @@',
      old_start: 1,
      old_lines: 2,
      new_start: 1,
      new_lines: 3,
      text: ' const limit = order.amount\n-if (amount > limit * 0.9) fail()\n+if (amount > limit) fail()\n+return ok',
    },
    {
      id: 'H2',
      file: 'docs/refunds.md',
      header: '@@ -0,0 +1 @@',
      old_start: 0,
      old_lines: 0,
      new_start: 1,
      new_lines: 1,
      text: '+Refunds stop at the order amount.',
    },
  ],
};
const AFTER: RepoCommitAfter = {
  gate: { passed: 5, failed: 1, skipped: 2, sha: '5f3c118'.padEnd(40, '0'), duration_ms: 43_000 },
  previous_gate_ms: 41_000,
  dependencies: 0,
  later: [],
  upstream: { name: 'origin/main', ahead: 2 },
  session_merge: null,
};

let onOpenSession = vi.fn();
function detail(projectId: string, after: RepoCommitAfter | null = null) {
  reads.logs.set(SHOWN.sha, reads.landed({ commits: [SHOWN], has_more: true }));
  reads.sessions = reads.landed([
    { id: 'refund-cap', title: 'Refund cap', state: 'merged', waiting: 0 },
  ]);
  reads.diff = reads.landed(DIFF);
  reads.after = reads.landed(after);
  return mount(() => CommitDetail({ projectId, sha: SHOWN.sha, onOpenSession }));
}
const view = (projectId: string) => mount(() => useRepoView(projectId)).value;
const buttonNamed = (tree: unknown, name: string) =>
  find(tree as never, (n) => n.type === 'button' && text(n.props.children) === name);

describe('repository commit detail', () => {
  beforeEach(() => {
    onOpenSession = vi.fn();
    mock.run = vi.fn(async () => ({ ok: true, value: {} }));
  });

  it('shows the commit with its files by folder and the picked file before and after', () => {
    const host = detail('history-detail');
    expect(reads.useRepoLog).toHaveBeenCalledWith('history-detail', 1, 0, SHOWN.sha);
    expect(text(find(host.value, (n) => n.type === 'h2'))).toBe(SHOWN.subject);
    find(
      host.value,
      (n) => n.type === 'button' && text(n.props.children).includes('Refund cap'),
    ).props.onClick();
    expect(onOpenSession).toHaveBeenCalledWith('refund-cap');

    const files = () => find(host.value, (n) => n.props['aria-label'] === zh('repo.commit.files'));
    const listed = text(files());
    expect(listed).toContain(zhf('repo.history.files', { count: 2 }));
    expect(listed).toContain('+3');
    expect(listed).toContain('−1');
    expect(listed).toContain('src/refunds');
    expect(listed).toContain('docs');
    const picks = () => nodes(files()).filter((n) => n.type === 'button');
    expect(picks().map((n) => n.props['aria-label'])).toEqual([
      'src/refunds/cap.ts',
      'docs/refunds.md',
    ]);
    expect(picks()[0]!.props['aria-current']).toBe(true);

    const shown = (path: string) =>
      find(host.value, (n) => n.props['aria-label'] === zhf('repo.commit.fileDiff', { path }));
    const cap = text(shown('src/refunds/cap.ts'));
    expect(cap).toContain('if (amount > limit * 0.9) fail()');
    expect(cap).toContain('if (amount > limit) fail()');
    expect(cap).toContain('2222222');
    expect(cap).toContain('3333333');

    picks()[1]!.props.onClick();
    host.render();
    expect(picks()[1]!.props['aria-current']).toBe(true);
    expect(text(shown('docs/refunds.md'))).toContain('Refunds stop at the order amount.');
    buttonNamed(host.value, zh('repo.commit.fileHistory')).props.onClick();
    expect(view('history-detail')).toEqual({ kind: 'file', path: 'docs/refunds.md' });
  });

  it('steps to the earlier and the later commit', () => {
    const host = detail('history-step');
    buttonNamed(host.value, zh('repo.commit.earlier')).props.onClick();
    expect(view('history-step')).toEqual({ kind: 'commit', sha: '2'.repeat(40) });
    buttonNamed(host.value, zh('repo.commit.later')).props.onClick();
    expect(view('history-step')).toEqual({ kind: 'commit', sha: '4'.repeat(40) });
  });

  it('shows the gate, the dependencies and what followed the commit', () => {
    const host = detail('history-after', AFTER);
    const shown = text(host.value);
    expect(shown).toContain(zh('repo.commit.gateTime'));
    expect(shown).toContain(durationText(41_000));
    expect(shown).toContain(durationText(43_000));
    expect(shown).toContain(zhf('repo.commit.slower', { duration: durationText(2_000) }));
    expect(shown).toContain(zh('repo.commit.dependencies'));
    expect(shown).toContain(zh('repo.commit.unchanged'));
    expect(shown).toContain(zhf('repo.commit.gatePassed', { count: 5, sha: '5f3c118' }));
    expect(shown).toContain(zhf('repo.commit.gateFailed', { count: 1 }));
    expect(shown).toContain(zhf('repo.commit.gateSkipped', { count: 2 }));
    expect(shown).toContain(zh('repo.commit.noLater'));
    expect(shown).toContain(
      zhf('repo.commit.ahead', { branch: 'main', upstream: 'origin/main', count: 2 }),
    );
    buttonNamed(host.value, zh('repo.commit.gateDetails')).props.onClick();
    expect(mock.shell.openSession).toHaveBeenCalledWith('refund-cap', 'checks');
  });

  it('lists the later commits that change its lines and leaves out what has no data', () => {
    const host = detail('history-later', {
      gate: null,
      previous_gate_ms: null,
      dependencies: 3,
      later: [{ sha: '4'.repeat(40), at: NOW, subject: 'Commit number 4' }],
      upstream: { name: 'origin/main', ahead: 0 },
      session_merge: null,
    });
    const shown = text(host.value);
    expect(shown).not.toContain(zh('repo.commit.gateTime'));
    expect(shown).not.toContain(zh('repo.commit.gateDetails'));
    expect(shown).toContain(zhf('repo.commit.depsChanged', { count: 3 }));
    expect(shown).toContain(zhf('repo.commit.laterCount', { count: 1 }));
    expect(shown).not.toContain(zh('repo.commit.noLater'));
    expect(shown).not.toContain('origin/main');
    find(
      host.value,
      (n) => n.type === 'button' && text(n.props.children).includes('Commit number 4'),
    ).props.onClick();
    expect(view('history-later')).toEqual({ kind: 'commit', sha: '4'.repeat(40) });
  });

  it('draws the change story flows with the file and line of each step', () => {
    const anchor = (quote: string) => ({ file: 'src/refunds/cap.ts', quote });
    reads.stories = reads.landed([
      {
        id: 'story-1',
        project_id: 'history-story',
        workbench_session_id: 'refund-cap',
        source: 'main',
        from_sha: '2'.repeat(40),
        to_sha: SHOWN.sha,
        state: 'ready',
        created_at: 1,
        result: {
          overall: { before: ['Refunds stop at 90%'], after: ['Refunds stop at the amount'] },
          cards: [
            {
              title: 'Refund cap',
              kind: 'behavior',
              surface: 'api',
              acceptance: [],
              before: 'Capped at 90%',
              after: 'Capped at the amount',
              how: [],
              hunks: ['H1'],
              tests: [],
              out_of_scope: false,
              evidence: [],
              shared_with: [],
              diagram: {
                spec: {
                  type: 'flow',
                  title: 'Refund',
                  lanes: ['api'],
                  nodes: [
                    {
                      id: 'a',
                      label: 'Read the limit',
                      lane: 'api',
                      side: 'both',
                      anchor: anchor('const limit'),
                    },
                    {
                      id: 'b',
                      label: 'Cap at 90%',
                      lane: 'api',
                      side: 'before',
                      anchor: anchor('limit * 0.9'),
                    },
                    {
                      id: 'c',
                      label: 'Cap at the amount',
                      lane: 'api',
                      side: 'after',
                      anchor: anchor('amount > limit)'),
                    },
                    { id: 'd', label: 'Return ok', lane: 'api', side: 'after' },
                  ],
                  edges: [
                    { from: 'a', to: 'b', side: 'before' },
                    { from: 'a', to: 'c', side: 'after' },
                    { from: 'c', to: 'd', side: 'after' },
                  ],
                },
                inferred: [],
                hunks: {},
              },
            },
          ],
          noise: [],
          uninterpreted: [],
          hunk_total: 1,
          unmatched_acceptance: [],
        },
      },
    ]);
    const host = detail('history-story');
    expect(text(host.value)).toContain(zh('repo.commit.behavior'));
    const [before, after] = nodes(host.value).filter((n) => n.type === 'ol');
    const label = (list: ReactElement<any>) =>
      text(find(host.value, (n) => n.props.id === list.props['aria-labelledby']));
    expect(label(before!)).toBe(zh('repo.history.before'));
    expect(label(after!)).toBe(zh('repo.history.after'));
    const steps = (list: ReactElement<any>) =>
      nodes(list)
        .filter((n) => n.type === 'li')
        .map((n) => text(n.props.children));
    expect(steps(before!)).toEqual(['Read the limitcap.ts:1', 'Cap at 90%cap.ts:2']);
    expect(steps(after!)).toEqual([
      'Read the limitcap.ts:1',
      'Cap at the amountcap.ts:2',
      'Return ok',
    ]);
    expect(text(find(before!, (n) => n.type === 'del'))).toBe('Cap at 90%');
    expect(text(find(after!, (n) => n.type === 'ins'))).toBe('Cap at the amount');
  });
  const sent = () => (mock.run as ReturnType<typeof vi.fn>).mock.calls;
  const dialog = (tree: unknown) =>
    find(tree as never, (n) => n.props.open !== undefined && n.props.onOpenChange);

  it('shows the author, the whole message, the parents and a way to copy the sha', () => {
    const body = ['Line one', 'Line two', 'Line three', 'Line four'].join('\n');
    reads.logs.set(SHOWN.sha, reads.landed({ commits: [{ ...SHOWN, body }], has_more: true }));
    const host = mount(() =>
      CommitDetail({ projectId: 'history-head', sha: SHOWN.sha, onOpenSession }),
    );
    const shown = text(host.value);
    expect(shown).toContain('Ada');
    expect(shown).toContain('ada@example.invalid');
    const message = () => find(host.value, (n) => n.type === 'p' && text(n) === body);
    expect(message().props['data-clamp']).toBe(true);
    const more = buttonNamed(host.value, zh('repo.commit.showMore'));
    expect(more.props['aria-expanded']).toBe(false);
    more.props.onClick();
    host.render();
    expect(message().props['data-clamp']).toBeUndefined();
    expect(buttonNamed(host.value, zh('repo.commit.showLess')).props['aria-expanded']).toBe(true);
    expect(nodes(host.value).some((n) => n.type === IdText && n.props.id === SHOWN.sha)).toBe(true);
    expect(shown).toContain(zhf('repo.commit.parents', { count: 1 }));
    buttonNamed(host.value, '2222222').props.onClick();
    expect(view('history-head')).toEqual({ kind: 'commit', sha: '2'.repeat(40) });
  });

  it('keeps a short message open with nothing to expand', () => {
    reads.logs.set(
      SHOWN.sha,
      reads.landed({ commits: [{ ...SHOWN, body: 'One line' }], has_more: true }),
    );
    const host = mount(() =>
      CommitDetail({ projectId: 'history-short', sha: SHOWN.sha, onOpenSession }),
    );
    expect(
      find(host.value, (n) => n.type === 'p' && text(n) === 'One line').props['data-clamp'],
    ).toBeUndefined();
    expect(
      nodes(host.value).some((n) => text(n.props.children) === zh('repo.commit.showMore')),
    ).toBe(false);
  });

  it('pushes the branch after a confirmation that names the branch, the remote and the count', async () => {
    const host = detail('history-push', AFTER);
    expect(dialog(host.value).props.open).toBe(false);
    buttonNamed(host.value, zhf('repo.commit.push', { branch: 'main' })).props.onClick();
    host.render();
    expect(dialog(host.value).props.open).toBe(true);
    expect(text(dialog(host.value))).toContain(
      zhf('repo.commit.pushTitle', { count: 2, branch: 'main', upstream: 'origin/main' }),
    );
    expect(sent()).toEqual([]);
    buttonNamed(dialog(host.value), zh('repo.commit.pushConfirm')).props.onClick();
    await host.flush();
    expect(sent()).toEqual([['repo.push', { project_id: 'history-push' }, null]]);
    expect(dialog(host.value).props.open).toBe(false);
  });

  it('shows git’s output in the dialog when the push fails', async () => {
    const rejected = ' ! [rejected]        main -> main (fetch first)';
    mock.run = vi.fn(async () => ({
      ok: false,
      error: { code: 'push_rejected', message: rejected },
    }));
    const host = detail('history-push-failed', AFTER);
    buttonNamed(host.value, zhf('repo.commit.push', { branch: 'main' })).props.onClick();
    host.render();
    buttonNamed(dialog(host.value), zh('repo.commit.pushConfirm')).props.onClick();
    await host.flush();
    expect(dialog(host.value).props.open).toBe(true);
    expect(text(find(dialog(host.value), (n) => n.props.role === 'alert'))).toBe(rejected);
  });

  it('reverts the commit in a new commit on the branch and opens that commit', async () => {
    mock.run = vi.fn(async () => ({ ok: true, value: { sha: '9'.repeat(40) } }));
    const host = detail('history-revert', { ...AFTER, upstream: null });
    buttonNamed(host.value, zh('repo.commit.revert')).props.onClick();
    host.render();
    expect(text(dialog(host.value))).toContain(zhf('repo.commit.revertOne', { branch: 'main' }));
    buttonNamed(dialog(host.value), zh('repo.commit.revertConfirm')).props.onClick();
    await host.flush();
    expect(sent()).toEqual([
      ['repo.revert', { project_id: 'history-revert', sha: SHOWN.sha }, null],
    ]);
    expect(view('history-revert')).toEqual({ kind: 'commit', sha: '9'.repeat(40) });
  });

  it('says a revert of a session merge takes back all its commits, and shows a conflict in place', async () => {
    mock.run = vi.fn(async () => ({
      ok: false,
      error: { code: 'revert_conflict', message: 'Reverting conflicts in src/refunds/cap.ts' },
    }));
    const host = detail('history-revert-merge', {
      ...AFTER,
      session_merge: { from_sha: '1'.repeat(40), commits: 2 },
    });
    const rows = () => nodes(host.value).filter((n) => n.props.className === 'rh-ar');
    expect(
      nodes(rows().at(-1)!).some((n) => text(n.props.children) === zh('repo.commit.revert')),
    ).toBe(true);
    buttonNamed(host.value, zh('repo.commit.revert')).props.onClick();
    host.render();
    expect(text(dialog(host.value))).toContain(
      zhf('repo.commit.revertMerge', { branch: 'main', count: 2 }),
    );
    buttonNamed(dialog(host.value), zh('repo.commit.revertConfirm')).props.onClick();
    await host.flush();
    expect(text(find(dialog(host.value), (n) => n.props.role === 'alert'))).toBe(
      'Reverting conflicts in src/refunds/cap.ts',
    );
    expect(view('history-revert-merge')).toEqual({ kind: 'tabs' });
  });
});
