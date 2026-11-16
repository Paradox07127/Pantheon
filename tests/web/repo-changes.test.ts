import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { ChangeStory } from '@pantheon/domain';
import type {
  LandingDiff,
  RepoStatus,
  RepoWorktree,
  SessionDiff,
  SessionGates,
  SessionPreflight,
  StaleWorkspaces,
  WorkbenchSession,
} from '@pantheon/protocol';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';
import { listText } from '@/lib/list-text';
import { zh, zhf } from './i18n-setup.js';
const mock = vi.hoisted(() => ({
  board: {} as any,
  shell: {} as any,
  worktrees: [] as unknown[],
  status: null as unknown,
  sessions: [] as unknown[],
  diffs: {} as Record<string, unknown>,
  stale: null as unknown,
  gates: null as unknown,
  preflight: null as unknown,
  stories: [] as unknown[],
  storyDiff: null as unknown,
  prune: null as unknown as (projectId: string) => Promise<unknown>,
}));
const store = vi.hoisted(
  () => (state: () => any) =>
    Object.assign((selector?: any) => (selector ? selector(state()) : state()), {
      getState: state,
      setState: (patch: object) => Object.assign(state(), patch),
    }),
);
const landed = vi.hoisted(() => (data: unknown) => ({
  data,
  read: data,
  loading: false,
  refreshing: false,
  stale: false,
  error: null,
  reload() {},
}));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'changes-id' }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
    subscribe: () => () => {},
  }),
}));
vi.mock('@/store', () => ({ useShell: store(() => mock.shell) }));
vi.mock('@/data/repo', async (actual) => ({
  ...(await actual<object>()),
  useRepoWorktrees: () => landed(mock.worktrees),
  useRepoStatus: () => landed(mock.status),
}));
vi.mock('@/data/workbench-sessions', async (actual) => ({
  ...(await actual<object>()),
  useSessionList: () => landed(mock.sessions),
  useSessionDiff: (sessionId: string | null) =>
    landed(sessionId === null ? null : (mock.diffs[sessionId] ?? null)),
}));
vi.mock('@/data/worktree-setup', async (actual) => ({
  ...(await actual<object>()),
  useStaleWorkspaces: () => landed(mock.stale),
  pruneStale: (projectId: string) => mock.prune(projectId),
}));
vi.mock('@/data/session-panel', async (actual) => ({
  ...(await actual<object>()),
  useSessionGates: () => landed(mock.gates),
  useSessionReviews: () => landed([]),
  useSessionPreflight: () => landed(mock.preflight),
}));
vi.mock('@/data/change-story', async (actual) => ({
  ...(await actual<object>()),
  useChangeStories: () => landed(mock.stories),
  useChangeStoryDiff: () => landed(mock.storyDiff),
}));
vi.mock('@/data/facts-read', async (actual) => ({
  ...(await actual<object>()),
  useFactsRead: () => landed(null),
}));
import { DiffFiles } from '@/components/DiffReview';
import { Menu, MenuItem } from '@/components/Menu';
import { ChangesTab } from '@/screens/repo/ChangesTab';

const worktree = (extra: Partial<RepoWorktree>): RepoWorktree => ({
  path: '/src/payments',
  branch: 'main',
  head_sha: '0123456789abcdef',
  kind: 'checkout',
  ahead: 0,
  behind: 0,
  uncommitted: 0,
  additions: 0,
  deletions: 0,
  ...extra,
});
const CHECKOUT = worktree({ uncommitted: 3 });
const LIST = worktree({
  path: '/work/refund-list',
  branch: 'pt/refund-list',
  kind: 'session',
  session_id: 'session-list',
  ahead: 3,
});
const SIGNATURE = worktree({
  path: '/work/webhook-signature',
  branch: 'pt/webhook-signature',
  kind: 'session',
  session_id: 'session-signature',
  ahead: 1,
  behind: 2,
});
const HOTFIX = worktree({
  path: '/src/payments-hotfix',
  branch: 'hotfix/1.8.2',
  kind: 'external',
  ahead: 1,
});

const listed = (id: string, title: string): WorkbenchSession => ({
  id,
  created_at: '2026-11-03T08:00:00.000Z',
  title,
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: `workspace-${id}`,
  workspace_kind: 'linked_worktree',
  state: 'idle',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-11-03T08:00:00.000Z',
  changes: null,
  merge: null,
});

const patchOf = (path: string) =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,1 +1,1 @@',
    '-old',
    '+new',
  ].join('\n');
const diffOf = (sessionId: string, paths: string[]): SessionDiff => ({
  session_id: sessionId,
  base_sha: 'base',
  head_sha: 'head',
  files: paths.map((path) => ({ path, additions: 1, deletions: 1, untracked: false })),
  patch: paths.map(patchOf).join('\n'),
  truncated: false,
});

const PREFLIGHT: SessionPreflight = {
  target_branch: 'main',
  source_root: '/src/payments',
  commit_count: 3,
  files_changed: 1,
  worktree_clean: true,
  source_clean: true,
  conflicts: { state: 'none' },
  gate: { configured_total: 5, last: 'passed' },
  can_merge: true,
};
const ran = (name: string, state?: 'skipped') => ({
  name,
  exit_code: state ? 1 : 0,
  timed_out: false,
  output_tail: '',
  ...(state ? { state } : {}),
});
const GATES: SessionGates = {
  configured: true,
  running: false,
  last: {
    commit: 'head',
    checked_at: 1,
    results: [
      ran('Lint'),
      ran('Types'),
      ran('Unit tests'),
      ran('Build'),
      ran('End to end', 'skipped'),
    ],
  },
};

const STORY_DIFF: LandingDiff = {
  source: '/src/payments',
  from_sha: 'base',
  to_sha: 'head',
  files: [],
  hunks: ['H1', 'H2', 'H3'].map((id, i) => ({
    id,
    file: i === 2 ? 'web/refunds/filters.ts' : 'web/refunds/RefundList.tsx',
    header: `@@ -${i + 1},1 +${i + 1},1 @@`,
    old_start: i + 1,
    old_lines: 1,
    new_start: i + 1,
    new_lines: 1,
    text: `-old ${id}\n+new ${id}`,
  })),
  truncated: false,
};
const card = (title: string, extra: object = {}) => ({
  title,
  kind: 'added' as const,
  surface: 'ui' as const,
  acceptance: [] as number[],
  before: `${title} before`,
  after: `${title} after`,
  how: [] as { text: string; hunks: string[] }[],
  hunks: ['H1'],
  tests: [] as string[],
  out_of_scope: false,
  evidence: [],
  shared_with: [] as number[],
  ...extra,
});
const STORY: ChangeStory = {
  id: 'story-list',
  revision: 1,
  project_id: 'payments',
  workbench_session_id: 'session-list',
  source: '/src/payments',
  from_sha: 'base',
  to_sha: 'head',
  state: 'ready',
  runtime: 'codex',
  created_at: Date.now() - 3 * 60_000,
  context: {
    goal: 'Refund list',
    acceptance: ['Refunds can be filtered by state'],
    contract_available: true,
    checks: { state: 'none', spec_hash: 'spec', commands: [], results: [] },
  },
  result: {
    overall: { before: ['Every refund is listed'], after: ['Refunds filter by state'] },
    cards: [
      card('Filter by state', {
        acceptance: [0],
        how: [{ text: 'The list keeps the filter', hunks: ['H1'] }],
        evidence: [{ source: 'gate', id: 'Unit tests', label: 'Unit tests', status: 'passed' }],
      }),
      card('Total row', { hunks: ['H2'], shared_with: [0], out_of_scope: true }),
    ],
    noise: [],
    uninterpreted: ['H3'],
    hunk_total: 3,
    unmatched_acceptance: [],
  },
};

const STATUS: RepoStatus = {
  path: '/src/payments',
  branch: 'main',
  head_sha: '0123456789abcdef',
  files: [
    { path: 'src/ledger.ts', index: 'M', worktree: null, untracked: false, conflicted: false },
    { path: 'src/refund.ts', index: 'U', worktree: 'U', untracked: false, conflicted: true },
    { path: 'notes.txt', index: null, worktree: null, untracked: true, conflicted: false },
  ],
};

beforeEach(() => {
  mock.board = {
    board: { cursor: 1, projects: [], sessions: [], session_turns: [], workspaces: [] },
    events: [],
    status: { state: 'live' },
    resync: 0,
  };
  mock.shell = { openSession: vi.fn() };
  mock.worktrees = [CHECKOUT, LIST, SIGNATURE, HOTFIX];
  mock.status = STATUS;
  mock.sessions = [
    listed('session-list', 'Refund list'),
    listed('session-signature', 'Webhook signature'),
  ];
  mock.diffs = {
    'session-list': diffOf('session-list', ['web/refunds/filters.ts']),
    'session-signature': diffOf('session-signature', [
      'src/webhook/verify.ts',
      'src/webhook/keys.ts',
    ]),
  };
  mock.stale = { count: 0 } satisfies StaleWorkspaces;
  mock.gates = null;
  mock.preflight = null;
  mock.stories = [];
  mock.storyDiff = null;
  mock.prune = vi.fn(async () => ({ ok: true, value: { removed: 2 } }));
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const tab = () => mount(() => ChangesTab({ projectId: 'payments', onOpenSession: () => {} }));
/** Renders a function component found in the tree, one level down. */
const expand = (node: ReactElement<any>) =>
  mount(() => (node.type as (props: object) => any)(node.props));
const child = (tree: unknown, name: string) =>
  find(tree as never, (n) => typeof n.type === 'function' && n.type.name === name);
const worktreeList = (tree: unknown) => expand(child(tree, 'WorktreeList')).value;
/** Each worktree row's pick button, as rendered. */
const rows = (tree: unknown) =>
  nodes(worktreeList(tree))
    .filter((n) => typeof n.type === 'function' && n.type.name === 'Row')
    .map((n) => find(expand(n).value, (b) => b.props['aria-pressed'] !== undefined));
const pruneText = zh('repo.changes.prune');
const sessionChanges = (tree: unknown) => expand(child(tree, 'SessionChanges'));

describe('repository changes worktrees', () => {
  it('lists the local checkout, the session worktrees and the outside ones in that order', () => {
    const list = worktreeList(tab().value);
    const headings = nodes(list)
      .filter((n) => n.type === 'h3')
      .map((n) => text(n.props.children));
    expect(headings).toEqual([
      zh('repo.changes.group.checkout'),
      `${zh('repo.changes.group.session')}2`,
      `${zh('repo.changes.group.external')}1`,
    ]);
    const shown = rows(tab().value).map((b) => text(b.props.children));
    expect(shown[0]).toContain('main');
    expect(shown[0]).toContain(zhf('repo.changes.uncommitted', { count: 3 }));
    expect(shown[1]).toContain('pt/refund-list');
    expect(shown[1]).toContain(zhf('repo.changes.ahead', { count: 3 }));
    expect(shown[2]).toContain('pt/webhook-signature');
    expect(shown[2]).toContain(zhf('repo.changes.ahead', { count: 1 }));
    expect(shown[2]).toContain(zhf('repo.changes.behind', { count: 2 }));
    expect(shown[3]).toContain('hotfix/1.8.2');
    expect(shown[3]).toContain(zhf('repo.changes.ahead', { count: 1 }));
  });

  it('picks the first session worktree first and lists a picked session worktree’s diff files', () => {
    const h = tab();
    expect(rows(h.value).map((b) => b.props['aria-pressed'])).toEqual([false, true, false, false]);
    rows(h.value)[2]!.props.onClick();
    h.render();
    expect(rows(h.value).map((b) => b.props['aria-pressed'])).toEqual([false, false, true, false]);
    const changes = expand(child(h.value, 'SessionChanges'));
    find(
      changes.value,
      (n) => n.props['aria-label'] === zh('repo.changes.view'),
    ).props.onValueChange('files');
    changes.render();
    const files = text(expand(find(changes.value, (n) => n.type === DiffFiles)).value);
    expect(files).toContain('verify.ts');
    expect(files).toContain('keys.ts');
    expect(files).not.toContain('filters.ts');
  });

  it('lists an outside worktree’s status files with their conflict, and no story', () => {
    mock.worktrees = [HOTFIX];
    const tree = tab().value;
    expect(rows(tree).map((b) => b.props['aria-pressed'])).toEqual([true]);
    expect(nodes(tree).some((n) => n.props['aria-label'] === zh('repo.changes.view'))).toBe(false);
    const files = expand(child(tree, 'StatusFiles')).value;
    const list = find(files, (n) => n.props['aria-label'] === zh('repo.changes.uncommittedFiles'));
    const items = nodes(list)
      .filter((n) => n.type === 'li')
      .map((n) => text(n.props.children));
    expect(items).toEqual([
      'Msrc/ledger.ts',
      `Usrc/refund.ts${zh('repo.changes.conflicted')}`,
      '?notes.txt',
    ]);
  });

  it('offers the cleanup only while there are stale worktrees', () => {
    const buttons = () =>
      nodes(worktreeList(tab().value))
        .filter((n) => n.type === 'button')
        .map((n) => text(n.props.children));
    expect(buttons()).toEqual([]);
    mock.stale = { count: 2 } satisfies StaleWorkspaces;
    expect(buttons()).toEqual([pruneText, zh('sessions.screen.delete')]);
    expect(text(worktreeList(tab().value))).toContain(zhf('repo.changes.stale', { count: 2 }));
  });

  it('shows a session worktree’s diff size, and that it will conflict in place of its counts', () => {
    mock.worktrees = [
      CHECKOUT,
      { ...LIST, additions: 184, deletions: 22 },
      { ...SIGNATURE, additions: 96, deletions: 8, conflicts: 2 },
    ];
    const shown = rows(tab().value).map((b) => text(b.props.children));
    expect(shown[1]).toContain('+184');
    expect(shown[1]).toContain('−22');
    expect(shown[1]).toContain(zhf('repo.changes.ahead', { count: 3 }));
    expect(shown[1]).not.toContain(zh('repo.changes.willConflict'));
    expect(shown[2]).toContain(zh('repo.changes.willConflict'));
    expect(shown[2]).not.toContain(zhf('repo.changes.behind', { count: 2 }));
    expect(shown[2]).not.toContain('+96');
    expect(shown[0]).not.toContain('+');
  });

  it('offers each worktree’s editor, file manager and copy actions the desktop app has', async () => {
    const openInEditor = vi.fn(async () => ({
      ok: false,
      error: { code: 'editor_unavailable', message: 'No known editor is installed' },
    }));
    const revealPath = vi.fn(async () => ({ ok: true, value: null }));
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { userAgent: 'Macintosh', clipboard: { writeText } });
    mock.worktrees = [CHECKOUT, LIST, { ...HOTFIX, branch: null }];
    const menus = () =>
      nodes(worktreeList(tab().value))
        .filter((n) => typeof n.type === 'function' && n.type.name === 'Row')
        .map((n) => {
          const row = expand(n);
          const menu = find(row.value, (m) => m.type === Menu);
          const items = nodes(menu).filter((m) => m.type === MenuItem);
          const item = (name: string) => items.find((m) => text(m.props.children) === name)!;
          return { row, menu, names: items.map((m) => text(m.props.children)), item };
        });
    const reveal = zh('lib.reveal.finder');
    const copyPath = zh('repo.changes.copyPath');
    const copyBranch = zh('repo.changes.copyBranch');
    const editor = zh('repo.changes.openInEditor');
    expect(menus().map((m) => m.names)).toEqual([
      [copyPath, copyBranch],
      [copyPath, copyBranch],
      [copyPath],
    ]);

    vi.stubGlobal('window', {
      addEventListener() {},
      removeEventListener() {},
      pantheon: { openInEditor, revealPath },
    });
    const [checkout, session, outside] = menus();
    expect(checkout!.names).toEqual([reveal, copyPath, copyBranch]);
    expect(session!.names).toEqual([editor, reveal, copyPath, copyBranch]);
    expect(outside!.names).toEqual([reveal, copyPath]);
    expect(session!.menu.props.trigger.props['aria-label']).toBe(
      zhf('repo.changes.actionsOf', { name: 'Refund list' }),
    );
    session!.item(reveal).props.onClick();
    expect(revealPath).toHaveBeenCalledWith('/work/refund-list');
    session!.item(copyPath).props.onClick();
    expect(writeText).toHaveBeenLastCalledWith('/work/refund-list');
    session!.item(copyBranch).props.onClick();
    expect(writeText).toHaveBeenLastCalledWith('pt/refund-list');
    session!.item(editor).props.onClick();
    expect(openInEditor).toHaveBeenCalledWith('workspace-session-list');
    await session!.row.flush();
    expect(text(find(session!.row.value, (n) => n.props.role === 'alert'))).toContain(
      'No known editor is installed',
    );
  });

  it('deletes stale worktrees only after the cleanup is confirmed', async () => {
    mock.stale = { count: 2 } satisfies StaleWorkspaces;
    const h = tab();
    const list = expand(child(h.value, 'WorktreeList'));
    const dialog = () =>
      find(list.value, (n) => n.props.open !== undefined && n.props.onOpenChange);
    expect(dialog().props.open).toBe(false);
    find(
      list.value,
      (n) => n.type === 'button' && text(n.props.children) === pruneText,
    ).props.onClick();
    list.render();
    expect(mock.prune).not.toHaveBeenCalled();
    expect(dialog().props.open).toBe(true);
    await find(
      dialog(),
      (n) => n.type === 'button' && text(n.props.children) === zh('sessions.screen.delete'),
    ).props.onClick();
    expect(mock.prune).toHaveBeenCalledWith('payments');
  });
});

describe('repository changes tab of a session worktree', () => {
  const inProject = (projectId: string) => {
    mock.board.board.sessions = [{ id: 'session-list', project_id: projectId, revision: 1 }];
  };
  const view = (changes: { value: unknown }) =>
    find(changes.value as never, (n) => n.props['aria-label'] === zh('repo.changes.view'));

  it('opens on the files without a ready story, on the story with one, and keeps the tab picked in a project', () => {
    inProject('tabs-plain');
    expect(view(sessionChanges(tab().value)).props.value).toBe('files');
    mock.stories = [STORY];
    mock.storyDiff = STORY_DIFF;
    inProject('tabs-story');
    const changes = sessionChanges(tab().value);
    expect(view(changes).props.value).toBe('story');
    view(changes).props.onValueChange('files');
    changes.render();
    expect(view(changes).props.value).toBe('files');
    expect(view(sessionChanges(tab().value)).props.value).toBe('files');
    inProject('tabs-other');
    expect(view(sessionChanges(tab().value)).props.value).toBe('story');
  });
});

describe('repository changes of a session worktree', () => {
  const mergeRow = (onOpenSession = () => {}) => {
    const h = mount(() => ChangesTab({ projectId: 'payments', onOpenSession }));
    return expand(child(sessionChanges(h.value).value, 'MergeRow')).value;
  };

  it('counts skipped gates apart from passed ones in the merge row', () => {
    mock.gates = GATES;
    mock.preflight = PREFLIGHT;
    const row = mergeRow();
    const counts = listText(
      zhf('sessions.mergeBar.passed', { count: 4 }),
      zhf('sessions.mergeBar.skipped', { count: 1 }),
    );
    expect(text(row)).toContain('pt/refund-list');
    expect(text(row)).toContain(zhf('repo.changes.ahead', { count: 3 }));
    expect(text(row)).toContain(zhf('repo.changes.behind', { count: 0 }));
    expect(text(row)).toContain(counts);
    expect(text(row)).not.toContain(zhf('sessions.mergeBar.passed', { count: 5 }));
    expect(
      find(row, (n) => n.props.role === 'img' && n.props['aria-label']?.includes(counts)).props[
        'aria-label'
      ],
    ).toBe(zhf('repo.changes.gateBar', { total: 5, counts }));
  });

  it('opens the session, and keeps merge off with its reason while the preflight blocks it', () => {
    mock.gates = GATES;
    mock.preflight = { ...PREFLIGHT, can_merge: false, blocked_reason: 'invalid_state' };
    const open = vi.fn();
    const row = mergeRow(open);
    const buttons = nodes(row).filter((n) => n.type === 'button');
    const named = (label: string) => buttons.find((b) => text(b.props.children) === label)!;
    named(zh('repo.changes.openSession')).props.onClick();
    expect(open).toHaveBeenCalledWith('session-list');
    expect(named(zh('sessions.mergeBar.rerun')).props.disabled).toBe(false);
    const merge = named(zhf('sessions.panel.merge.mergeInto', { target: 'main' }));
    expect(merge.props['aria-disabled']).toBe(true);
    expect(merge.props.onClick).toBeUndefined();
    expect(
      find(row, (n) => n.props.content === zh('sessions.panel.blocked.notReady')).props.children,
    ).toBe(merge);
  });

  it('keeps the merge confirmation open when the preflight read fails', () => {
    mock.gates = GATES;
    mock.preflight = PREFLIGHT;
    const row = child(sessionChanges(tab().value).value, 'MergeRow');
    let preflight: unknown = PREFLIGHT;
    const h = mount(() => (row.type as (props: object) => any)({ ...row.props, preflight }));
    const dialog = () => child(h.value, 'MergeDialog');
    find(
      h.value,
      (n) =>
        n.type === 'button' &&
        text(n.props.children) === zhf('sessions.panel.merge.mergeInto', { target: 'main' }),
    ).props.onClick();
    h.render();
    expect(dialog().props.open).toBe(true);
    preflight = null;
    h.render();
    expect(dialog().props.open).toBe(true);
  });

  it('lists the story’s cards and shows the picked card alone at the right', () => {
    mock.stories = [STORY];
    mock.storyDiff = STORY_DIFF;
    const h = tab();
    const changes = sessionChanges(h.value);
    const list = expand(child(changes.value, 'StoryList')).value;
    expect(text(list)).toContain('Every refund is listed');
    expect(text(list)).toContain('Refunds filter by state');
    expect(text(list)).toContain(zh('repo.changes.reinterpret'));
    const cards = find(list, (n) => n.props['aria-label'] === zh('repo.changes.cards'));
    const picks = nodes(cards).filter((n) => n.type === 'button');
    expect(picks.map((b) => b.props['aria-pressed'])).toEqual([true, false]);
    expect(text(picks[0])).toContain(zh('sessions.panel.story.kind.added'));
    expect(text(picks[0])).toContain('Filter by state');
    expect(text(picks[0])).toContain(zhf('repo.changes.hunks', { count: 1 }));
    expect(
      nodes(picks[0]).some((n) => n.props['aria-label'] === zh('repo.changes.evidencePassed')),
    ).toBe(true);
    const view = () => child(changes.value, 'StoryView');
    expect(view().props.selected).toBe(0);
    picks[1]!.props.onClick();
    changes.render();
    expect(view().props.selected).toBe(1);
  });

  it('shows one card alone and open, with its acceptance, steps and hunks', () => {
    mock.stories = [STORY];
    mock.storyDiff = STORY_DIFF;
    const changes = sessionChanges(tab().value);
    const story = expand(child(changes.value, 'StoryView'));
    const shown = expand(child(story.value, 'Card')).value;
    const all = text(shown);
    expect(nodes(shown).find((n) => n.type === 'h2')?.props.children).toBe('Filter by state');
    expect(all).toContain('Filter by state before');
    expect(all).toContain('Filter by state after');
    expect(all).toContain('Refunds can be filtered by state');
    expect(all).toContain('The list keeps the filter');
    expect(all).not.toContain('Total row');
    const hunk = expand(
      find(shown, (n) => typeof n.type === 'function' && n.props.id === 'H1'),
    ).value;
    const toggle = find(hunk, (n) => n.type === 'button');
    expect(toggle.props['aria-label']).toBe(zhf('sessions.panel.story.collapse', { id: 'H1' }));
    expect(toggle.props['aria-expanded']).toBe(true);
  });

  it('picks the card a shown card shares a hunk with', () => {
    mock.stories = [STORY];
    mock.storyDiff = STORY_DIFF;
    const h = tab();
    const changes = sessionChanges(h.value);
    find(
      expand(child(changes.value, 'StoryList')).value,
      (n) => n.type === 'button' && text(n.props.children).includes('Total row'),
    ).props.onClick();
    changes.render();
    const shown = expand(child(expand(child(changes.value, 'StoryView')).value, 'Card')).value;
    find(
      shown,
      (n) => n.props['aria-label'] === zhf('sessions.panel.story.showCard', { n: 1 }),
    ).props.onClick();
    changes.render();
    expect(child(changes.value, 'StoryView').props.selected).toBe(0);
  });

  it('lists the uninterpreted files under their own tab', () => {
    mock.stories = [STORY];
    mock.storyDiff = STORY_DIFF;
    const changes = sessionChanges(tab().value);
    find(
      changes.value,
      (n) => n.props['aria-label'] === zh('repo.changes.view'),
    ).props.onValueChange('uninterpreted');
    changes.render();
    const list = find(
      changes.value,
      (n) => n.props['aria-label'] === zh('repo.changes.uninterpretedFiles'),
    );
    expect(
      nodes(list)
        .filter((n) => n.type === 'li')
        .map((n) => text(n.props.children)),
    ).toEqual([`web/refunds/filters.ts${zhf('repo.changes.hunks', { count: 1 })}`]);
  });
});
