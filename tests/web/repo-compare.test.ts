import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { RepoCompare, RepoWorktree, StaleWorkspaces } from '@pantheon/protocol';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any, sessions: [] as unknown[] }));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'panel-id' }),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/data/workbench-sessions', async (actual) => ({
  ...(await actual<object>()),
  useSessionList: () => ({
    data: mock.sessions,
    loading: false,
    refreshing: false,
    error: null,
    reload() {},
  }),
}));
import { DiffFiles } from '@/components/DiffReview';
import { Select } from '@/components/Select';
import { CompareTab } from '@/screens/repo/CompareTab';
import { WorktreeList } from '@/screens/repo/changes/WorktreeList';
import { CompareFacts, ConflictBlock, OverlapMatrix } from '@/screens/repo/compare/CompareParts';
import { zh, zhf } from './i18n-setup.js';

const HOUR = 3_600_000;
const CHECKOUT_SHA = 'a1'.repeat(20);
const ONE_SHA = 'b2'.repeat(20);
const TWO_SHA = 'c3'.repeat(20);
const worktree = (
  w: Partial<RepoWorktree> & Pick<RepoWorktree, 'path' | 'kind'>,
): RepoWorktree => ({
  branch: null,
  head_sha: '',
  ahead: 0,
  behind: 0,
  uncommitted: 0,
  additions: 0,
  deletions: 0,
  ...w,
});
const WORKTREES: RepoWorktree[] = [
  worktree({ path: '/src/app', kind: 'checkout', branch: 'main', head_sha: CHECKOUT_SHA }),
  worktree({
    path: '/wt/refund',
    kind: 'session',
    branch: 'pt/refund',
    head_sha: ONE_SHA,
    session_id: 'refund-session',
  }),
  worktree({
    path: '/wt/detached',
    kind: 'session',
    head_sha: TWO_SHA,
    session_id: 'report-session',
  }),
];
const COMPARE: RepoCompare = {
  source: 'compare',
  from_sha: CHECKOUT_SHA,
  to_sha: ONE_SHA,
  merge_base: 'd4'.repeat(20),
  ahead: 2,
  behind: 1,
  files: [
    { path: 'src/alone.ts', status: 'modified', additions: 3, deletions: 1 },
    { path: 'src/shared.ts', status: 'modified', additions: 5, deletions: 0 },
  ],
  hunks: [
    {
      id: 'H1',
      file: 'src/shared.ts',
      header: '@@ -1,1 +1,2 @@',
      old_start: 1,
      old_lines: 1,
      new_start: 1,
      new_lines: 2,
      text: ' kept\n+added',
    },
  ],
  truncated: false,
  conflicts: [
    {
      path: 'src/shared.ts',
      line: 42,
      base_lines: ['  const body = JSON.parse(req.body)'],
      head_lines: ['  const key = hashRequest(req.body)', '  if (await seen(key)) return ok()'],
    },
  ],
  single_owner_files: 1,
};
// The base side read from the same merge base.
const REVERSE: RepoCompare = {
  ...COMPARE,
  from_sha: ONE_SHA,
  to_sha: CHECKOUT_SHA,
  files: [
    { path: 'src/shared.ts', status: 'modified', additions: 1, deletions: 1 },
    { path: 'src/main-only.ts', status: 'modified', additions: 1, deletions: 0 },
    { path: 'src/main-too.ts', status: 'added', additions: 4, deletions: 0 },
  ],
  hunks: [],
};
const STALE: StaleWorkspaces = {
  count: 0,
  size_bytes: 0,
  shared_files: {
    files: [
      { path: 'src/shared.ts', session_ids: ['refund-session', 'other-session'] },
      { path: 'src/elsewhere.ts', session_ids: ['report-session', 'other-session'] },
    ],
    total: 2,
  },
};

let query: ReturnType<typeof vi.fn>;
let command: ReturnType<typeof vi.fn>;
let openFile: ReturnType<typeof vi.fn>;
let previewedAt: number;
let mergeBaseAt: number;
beforeEach(() => {
  mock.board = {
    board: { cursor: 1, sessions: [{ id: 'refund-session', state: 'idle', revision: 7 }] },
    status: { state: 'live' },
    resync: 0,
    refresh() {},
  };
  mock.sessions = [
    { id: 'refund-session', title: 'Refund idempotency', runtime: 'codex', state: 'idle' },
    { id: 'report-session', title: 'Reconcile report', runtime: 'claude', state: 'idle' },
  ];
  previewedAt = Date.now() - 2 * 60_000 - 1000;
  mergeBaseAt = Date.now() - 2 * HOUR - 1000;
  const answer = (method: string, params: Record<string, string>) => {
    if (method === 'repo.worktrees') return WORKTREES;
    if (method === 'workspace.stale') return STALE;
    if (method === 'repo.log')
      return {
        commits: [
          {
            sha: params.ref,
            parents: [],
            refs: [],
            author: 'a',
            committed_at: mergeBaseAt,
            subject: 's',
          },
        ],
        has_more: false,
      };
    if (method === 'repo.compare')
      return params.head === CHECKOUT_SHA
        ? REVERSE
        : { ...COMPARE, previewed_at: previewedAt, from_sha: params.base, to_sha: params.head };
    return undefined;
  };
  query = vi.fn(async (method: string, params: Record<string, string>) => ({
    ok: true,
    value: answer(method, params),
  }));
  command = vi.fn(async () => ({ ok: true, value: {} }));
  openFile = vi.fn(async () => ({ ok: true, value: null }));
  vi.stubGlobal('window', {
    pantheon: { query, command, openFile },
    addEventListener() {},
    removeEventListener() {},
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

// Each test reads its own project, so no earlier test's cached read shows.
async function open(projectId: string) {
  const host = mount(() => CompareTab({ projectId, onOpenSession() {} }));
  await host.flush();
  await host.flush();
  await host.flush();
  return host;
}
const compareCalls = () =>
  query.mock.calls.filter(([method]) => method === 'repo.compare').map(([, params]) => params);
/** Mounts a function component found in the tree, one level down. */
const expandHost = (tree: unknown, type: unknown) => {
  const node = find(tree as never, (n) => n.type === type);
  return mount(() => (node.type as (props: object) => any)(node.props));
};
const expand = (tree: unknown, type: unknown) => expandHost(tree, type).value;
const side = (tree: unknown, id: string) =>
  find(tree as never, (n) => n.type === Select && n.props['aria-label'] === zh(id));
const hasSelect = (tree: unknown) => nodes(tree as never).some((n) => n.type === Select);
const modeSwitch = (tree: unknown) =>
  find(tree as never, (n) => n.props['aria-label'] === zh('repo.compare.mode'));
const list = (tree: unknown) => find(tree as never, (n) => n.type === WorktreeList);
const button = (tree: unknown, name: string) =>
  find(tree as never, (n) => n.type === 'button' && text(n) === name);

describe('repository compare', () => {
  it('compares the first session worktree with the first folder by default', async () => {
    const tree = (await open('compare-default')).value;
    expect(list(tree).props.picked).toBe('/wt/refund');
    expect(hasSelect(tree)).toBe(false);
    expect(text(modeSwitch(tree))).toContain(zhf('repo.compare.withMain', { branch: 'main' }));
    expect(compareCalls()).toEqual([
      { project_id: 'compare-default', base: CHECKOUT_SHA, head: ONE_SHA },
      { project_id: 'compare-default', base: ONE_SHA, head: CHECKOUT_SHA },
    ]);
    expect(text(tree)).toContain(
      zhf('repo.compare.previewed', { age: zhf('data.age.minutes', { count: 2 }) }),
    );
  });

  it('shows the merge base and its age, the files both sides change, the conflicts and the merge order', async () => {
    const tree = (await open('compare-facts')).value;
    const facts = text(expand(tree, CompareFacts));
    expect(facts).toContain('d4d4d4d');
    expect(facts).toContain(zhf('data.age.hours', { count: 2 }));
    expect(facts).toContain(zh('repo.compare.both'));
    expect(facts).toContain(zhf('repo.compare.bothSides', { base: 3, head: 2 }));
    expect(facts).toContain(zh('repo.compare.conflict'));
    expect(facts).toContain(zhf('repo.compare.line', { line: 42 }));
    expect(facts).toContain(zhf('repo.compare.mergeFirst', { branch: 'main' }));
    expect(facts).toContain(zhf('repo.compare.resolves', { count: 1, branch: 'pt/refund' }));
  });

  it('compares the worktree picked in the list', async () => {
    const host = await open('compare-pick');
    list(host.value).props.onPick('/wt/detached');
    host.render();
    await host.flush();
    expect(list(host.value).props.picked).toBe('/wt/detached');
    expect(compareCalls()).toContainEqual({
      project_id: 'compare-pick',
      base: CHECKOUT_SHA,
      head: TWO_SHA,
    });
  });

  it('compares two worktrees, the list picking the second side', async () => {
    const host = await open('compare-pair');
    modeSwitch(host.value).props.onValueChange('pair');
    host.render();
    await host.flush();
    expect(side(host.value, 'repo.compare.base').props.value).toBe('/wt/detached');
    expect(side(host.value, 'repo.compare.head').props.value).toBe('/wt/refund');
    expect(side(host.value, 'repo.compare.head').props.options.map((o: any) => o.label)).toEqual([
      'main',
      'pt/refund',
      TWO_SHA.slice(0, 7),
    ]);
    expect(compareCalls()).toContainEqual({
      project_id: 'compare-pair',
      base: TWO_SHA,
      head: ONE_SHA,
    });
    list(host.value).props.onPick('/src/app');
    host.render();
    await host.flush();
    expect(side(host.value, 'repo.compare.base').props.value).toBe('/wt/detached');
    expect(side(host.value, 'repo.compare.head').props.value).toBe('/src/app');
    expect(compareCalls()).toContainEqual({
      project_id: 'compare-pair',
      base: TWO_SHA,
      head: CHECKOUT_SHA,
    });
  });

  it('lists the shared files of the compared sessions, marks conflicts and puts them first in the diff', async () => {
    const tree = (await open('compare-overlap')).value;
    const matrix = find(
      expand(tree, OverlapMatrix),
      (n) => n.type === 'table' && n.props['aria-label'] === zh('repo.compare.overlap.title'),
    );
    const cells = nodes(matrix);
    expect(
      cells.filter((n) => n.type === 'th' && n.props.scope === 'row').map((n) => text(n)),
    ).toEqual(['src/shared.ts']);
    expect(
      cells
        .filter((n) => n.type === 'th' && n.props.scope === 'col')
        .map((n) => n.props['aria-label'] ?? text(n)),
    ).toEqual([
      zh('repo.compare.overlap.file'),
      'Refund idempotency',
      zh('repo.compare.overlap.all'),
    ]);
    expect(cells.filter((n) => n.props.role === 'img').map((n) => n.props['aria-label'])).toEqual([
      zh('repo.compare.conflict'),
    ]);

    const diff = find(tree, (n) => n.type === DiffFiles);
    expect(diff.props.diff.data.files.map((f: { path: string }) => f.path)).toEqual([
      'src/shared.ts',
      'src/alone.ts',
    ]);
    const mark = diff.props.mark('src/shared.ts') as ReactElement<any>;
    expect(mark.props['aria-label']).toBe(zh('repo.compare.overlap.mark'));
    expect(diff.props.mark('src/alone.ts')).toBeFalsy();
  });

  it('counts the files only one session changes and lists them on expand', async () => {
    const tree = (await open('compare-singles')).value;
    const matrix = expandHost(tree, OverlapMatrix);
    expect(text(matrix.value)).toContain(zhf('repo.compare.singles', { count: 1 }));
    const expandButton = button(matrix.value, zh('repo.compare.singles.show'));
    expect(expandButton.props['aria-expanded']).toBe(false);
    expect(nodes(matrix.value).some((n) => n.type === 'li')).toBe(false);
    expandButton.props.onClick();
    matrix.render();
    expect(button(matrix.value, zh('repo.compare.singles.hide')).props['aria-expanded']).toBe(true);
    expect(
      nodes(matrix.value)
        .filter((n) => n.type === 'li')
        .map((n) => text(n)),
    ).toEqual(['src/alone.ts']);
  });

  it('shows each conflict with both sides and asks the head session to rebase and resolve', async () => {
    const tree = (await open('compare-conflict')).value;
    const block = expandHost(tree, ConflictBlock);
    const article = find(block.value, (n) => n.type === 'article');
    expect(article.props['aria-label']).toBe('src/shared.ts');
    expect(text(article)).toContain(zhf('repo.compare.line', { line: 42 }));
    const group = (name: string) =>
      text(find(article, (n) => n.props.role === 'group' && n.props['aria-label'] === name));
    expect(group('main')).toContain('const body = JSON.parse(req.body)');
    expect(group('pt/refund')).toContain('const key = hashRequest(req.body)');
    expect(group('pt/refund')).toContain('if (await seen(key)) return ok()');

    button(
      block.value,
      zhf('repo.compare.askRebase', { session: 'Refund idempotency' }),
    ).props.onClick();
    await block.flush();
    const [sent] = command.mock.calls.at(-1)!;
    expect(sent.type).toBe('session.send');
    expect(sent.input.session_id).toBe('refund-session');
    expect(sent.input.input).toContain('src/shared.ts');
    expect(sent.input.input).toContain('main');

    button(block.value, zh('repo.compare.openInEditor')).props.onClick();
    expect(openFile).toHaveBeenCalledWith({ path: 'src/shared.ts', base: '/wt/refund', line: 42 });
  });

  it('shows why the rebase request failed beside the button', async () => {
    command.mockResolvedValueOnce({ ok: false, error: { code: 'boom', message: 'it broke' } });
    const tree = (await open('compare-conflict-fail')).value;
    const block = expandHost(tree, ConflictBlock);
    button(
      block.value,
      zhf('repo.compare.askRebase', { session: 'Refund idempotency' }),
    ).props.onClick();
    await block.flush();
    expect(text(find(block.value, (n) => n.props.role === 'alert'))).toContain('it broke');
  });

  it('says the picked worktree has no changes against its base in place of the facts and matrix', async () => {
    const answered = query.getMockImplementation() as (
      method: string,
      params: Record<string, string>,
    ) => Promise<unknown>;
    query.mockImplementation(async (method: string, params: Record<string, string>) =>
      method === 'repo.compare' && params.head === ONE_SHA
        ? {
            ok: true,
            value: {
              ...COMPARE,
              ahead: 0,
              files: [],
              hunks: [],
              conflicts: [],
              single_owner_files: 0,
            },
          }
        : answered(method, params),
    );
    const tree = (await open('compare-nothing')).value;
    expect(
      nodes(tree).some(
        (n) => n.props.text === zhf('repo.compare.noChanges', { head: 'pt/refund', base: 'main' }),
      ),
    ).toBe(true);
    expect(nodes(tree).some((n) => n.type === CompareFacts)).toBe(false);
    expect(nodes(tree).some((n) => n.type === OverlapMatrix)).toBe(false);
    expect(nodes(tree).some((n) => n.type === DiffFiles)).toBe(false);
  });

  it('sends no compare when both sides are the same worktree', async () => {
    const host = await open('compare-same');
    const before = compareCalls().length;
    list(host.value).props.onPick('/src/app');
    host.render();
    await host.flush();
    expect(compareCalls()).toHaveLength(before);
    expect(nodes(host.value).some((n) => n.props.text === zh('repo.compare.same'))).toBe(true);
    expect(nodes(host.value).some((n) => n.type === DiffFiles)).toBe(false);
  });
});
