import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ReactElement } from 'react';
import type { RepoWorktree } from '@pantheon/protocol';
import { deferred, find, mount, nodes, text, unmountAll } from './web-hook-host.js';
import { zh, zhf } from './i18n-setup.js';
const mock = vi.hoisted(() => ({
  board: {} as any,
  shell: {} as any,
  working: null as any,
  workingError: null as string | null,
  workingStale: false,
  reload: null as unknown as Mock<() => void>,
  worktrees: [] as unknown[],
  run: null as unknown as Mock<(...args: any[]) => Promise<unknown>>,
  toast: null as unknown as Mock<(...args: any[]) => unknown>,
  hold: null as unknown as Mock<(...args: any[]) => void>,
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
  unavailable: false,
  error: null,
  reload() {},
}));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'local-id' }),
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
vi.mock('@/data/project-read', async (actual) => ({
  ...(await actual<object>()),
  useProjectQuery: (method: string) =>
    method === 'repo.working_diff'
      ? {
          ...landed(mock.working),
          error: mock.workingError,
          stale: mock.workingStale,
          reload: mock.reload,
        }
      : landed(
          method === 'project.head'
            ? { sha: '0123456789abcdef', subject: 'Raise the cap', branch: 'main' }
            : method === 'repo.worktrees'
              ? mock.worktrees
              : null,
        ),
}));
vi.mock('@/data/commands', async (actual) => ({
  ...(await actual<object>()),
  runCommand: (...args: unknown[]) => mock.run(...args),
}));
vi.mock('@/components/Toast', async (actual) => ({
  ...(await actual<object>()),
  toast: (...args: unknown[]) => mock.toast(...args),
  holdToastAction: (...args: unknown[]) => mock.hold(...args),
}));
vi.mock('@/data/patch', async (actual) => {
  const real = await actual<typeof import('@/data/patch')>();
  return { ...real, parsePatch: vi.fn(real.parsePatch) };
});
vi.mock('@/components/DiffReview', async (actual) => {
  const real = await actual<typeof import('@/components/DiffReview')>();
  return { ...real, numbered: vi.fn(real.numbered) };
});
vi.mock('@/data/workbench-sessions', async (actual) => ({
  ...(await actual<object>()),
  useSessionList: () => landed([]),
}));
vi.mock('@/data/worktree-setup', async (actual) => ({
  ...(await actual<object>()),
  useStaleWorkspaces: () => landed({ count: 0 }),
}));
import { numbered } from '@/components/DiffReview';
import { parsePatch } from '@/data/patch';
import type { RepoWorkingDiff } from '@/data/repo-local';
import { ChangesTab } from '@/screens/repo/ChangesTab';
import { LocalChanges } from '@/screens/repo/changes/LocalChanges';
import { discardPatch, fileHeaders, lineKey } from '@/screens/repo/changes/line-patch';

const CONFIG = [
  'diff --git a/src/config.ts b/src/config.ts',
  'index 1111111..2222222 100644',
  '--- a/src/config.ts',
  '+++ b/src/config.ts',
  '@@ -8,5 +8,6 @@ export const refundConfig = {',
  "   currency: 'CNY',",
  '-  maxPartialRatio: 0.9,',
  '+  maxPartialRatio: 1,',
  '+  retryLimit: 5,',
  '   webhookTimeoutMs: 8000,',
  '-  debugLog: false,',
  '+  debugLog: true,',
  ' };',
];
const DOCS = [
  'diff --git a/docs/reconcile.md b/docs/reconcile.md',
  'index 3333333..4444444 100644',
  '--- a/docs/reconcile.md',
  '+++ b/docs/reconcile.md',
  '@@ -1,1 +1,1 @@',
  '-# Reconcile',
  '+# Reconciliation',
];
const SEED = [
  'diff --git a/scripts/seed.mjs b/scripts/seed.mjs',
  'new file mode 100644',
  'index 0000000..5555555',
  '--- /dev/null',
  '+++ b/scripts/seed.mjs',
  '@@ -0,0 +1,2 @@',
  "+import { seed } from './seed-lib.mjs';",
  '+await seed();',
];
const PATCH = [...CONFIG, ...DOCS, ...SEED, ''].join('\n');
const WORKING: RepoWorkingDiff = {
  head_sha: '0123456789abcdef',
  branch: 'main',
  upstream: null,
  files: [
    { path: 'src/config.ts', status: 'modified', additions: 3, deletions: 2 },
    { path: 'docs/reconcile.md', status: 'modified', additions: 1, deletions: 1 },
    { path: 'scripts/seed.mjs', status: 'untracked', additions: 2, deletions: 0 },
  ],
  patch: PATCH,
  truncated: false,
};
const HOOK = 'lint-staged failed\nsrc/config.ts:9 unexpected any';

beforeEach(() => {
  mock.board = {
    board: { cursor: 1, projects: [], sessions: [], session_turns: [], workspaces: [] },
    events: [],
    status: { state: 'live' },
    resync: 0,
  };
  mock.shell = { openSession: vi.fn() };
  mock.working = WORKING;
  mock.workingError = null;
  mock.workingStale = false;
  mock.reload = vi.fn();
  mock.worktrees = [];
  mock.run = vi.fn(async (type: string) => ({
    ok: true,
    value: type === 'repo.commit' ? { sha: 'abcdef0123456789' } : { undo_id: 'undo-7' },
  }));
  mock.toast = vi.fn(() => 'toast-1');
  mock.hold = vi.fn();
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const local = () => mount(() => LocalChanges({ projectId: 'payments' }));
const labelled = (tree: unknown, label: string) =>
  find(tree as never, (n) => n.props['aria-label'] === label);
const commitText = (count: number) => zhf('repo.changes.local.commit', { count, branch: 'main' });
const button = (tree: unknown, label: string) =>
  find(tree as never, (n) => n.type === 'button' && text(n.props.children) === label);
const write = (h: { value: unknown; render: () => unknown }, value: string) => {
  labelled(h.value, zh('repo.changes.local.summary')).props.onChange({ target: { value } });
  h.render();
};
const pick = (h: { value: unknown; render: () => unknown }, path: string) => {
  find(
    h.value as never,
    (n) => n.props['aria-pressed'] !== undefined && text(n.props.children).includes(path),
  ).props.onClick();
  h.render();
};
const diffPane = (tree: unknown) => labelled(tree, zh('repo.changes.local.diff'));
const sent = (type: string) => mock.run.mock.calls.filter(([t]) => t === type);
const confirmation = (tree: unknown) =>
  find(tree as never, (n) => n.props.open !== undefined && n.props.onOpenChange);
const confirm = (h: { value: unknown; render: () => unknown }) => {
  h.render();
  button(confirmation(h.value), zh('repo.changes.local.confirmDiscard')).props.onClick();
};

describe('local checkout changes', () => {
  it('shows the local checkout through its own changes view', () => {
    mock.worktrees = [
      {
        path: '/src/payments',
        branch: 'main',
        head_sha: '0123456789abcdef',
        kind: 'checkout',
        ahead: 0,
        behind: 0,
        uncommitted: 3,
        additions: 0,
        deletions: 0,
      } satisfies RepoWorktree,
    ];
    const tree = mount(() => ChangesTab({ projectId: 'payments', onOpenSession: () => {} })).value;
    expect(nodes(tree).some((n) => n.type === LocalChanges)).toBe(true);
  });

  it('checks every file at first and offers to commit all of them to the branch', () => {
    const tree = local().value;
    for (const { path } of WORKING.files)
      expect(
        labelled(tree, zhf('repo.changes.local.include', { path })).props['aria-checked'],
      ).toBe(true);
    expect(commitText(3)).toBe('提交 3 个文件到 main');
    expect(button(tree, commitText(3))).toBeTruthy();
  });

  it('keeps the commit button off while the message is empty', () => {
    const h = local();
    expect(button(h.value, commitText(3)).props.disabled).toBe(true);
    write(h, 'Raise the partial refund cap');
    expect(button(h.value, commitText(3)).props.disabled).toBe(false);
    write(h, '   ');
    expect(button(h.value, commitText(3)).props.disabled).toBe(true);
  });

  it('commits only the files still checked', async () => {
    const h = local();
    labelled(
      h.value,
      zhf('repo.changes.local.include', { path: 'docs/reconcile.md' }),
    ).props.onClick();
    h.render();
    write(h, 'Raise the partial refund cap');
    button(h.value, commitText(2)).props.onClick();
    await h.flush();
    expect(sent('repo.commit')).toEqual([
      [
        'repo.commit',
        {
          project_id: 'payments',
          paths: ['src/config.ts', 'scripts/seed.mjs'],
          message: 'Raise the partial refund cap',
        },
        null,
      ],
    ]);
    expect(mock.toast).toHaveBeenCalledWith({
      title: zhf('repo.changes.local.committed', { sha: 'abcdef01' }),
    });
    expect(labelled(h.value, zh('repo.changes.local.summary')).props.value).toBe('');
  });

  it('shows a failed hook’s output under the commit box', async () => {
    mock.run = vi.fn(async () => ({ ok: false, error: { code: 'commit_failed', message: HOOK } }));
    const h = local();
    write(h, 'Raise the partial refund cap');
    const go = () => button(h.value, commitText(3));
    go().props.onClick();
    await h.flush();
    const box = find(h.value as never, (n) =>
      ([n.props.children].flat(Infinity) as unknown[]).includes(go()),
    );
    const parts = [box.props.children].flat(Infinity) as ReactElement<any>[];
    const alert = parts.find((n) => n?.props?.role === 'alert');
    expect(text(alert!.props.children)).toBe(HOOK);
    expect(parts.indexOf(alert!)).toBeGreaterThan(parts.indexOf(go()));
    expect(mock.toast).not.toHaveBeenCalled();
  });

  it('asks before discarding a file and sends nothing until confirmed', async () => {
    const h = local();
    labelled(
      h.value,
      zhf('repo.changes.local.discard', { path: 'scripts/seed.mjs' }),
    ).props.onClick();
    await h.flush();
    expect(sent('repo.discard')).toEqual([]);
    expect(confirmation(h.value).props.open).toBe(true);
    expect(text(confirmation(h.value))).toContain(zh('repo.changes.local.confirmUntracked'));
    confirmation(h.value).props.onOpenChange(false);
    await h.flush();
    expect(confirmation(h.value).props.open).toBe(false);
    expect(sent('repo.discard')).toEqual([]);
    labelled(
      h.value,
      zhf('repo.changes.local.discard', { path: 'scripts/seed.mjs' }),
    ).props.onClick();
    confirm(h);
    await h.flush();
    expect(sent('repo.discard')).toEqual([
      ['repo.discard', { project_id: 'payments', paths: ['scripts/seed.mjs'] }, null],
    ]);
    expect(confirmation(h.value).props.open).toBe(false);
  });

  it('asks before discarding the selected lines', async () => {
    const h = local();
    labelled(h.value, zhf('repo.changes.local.pickAdded', { line: 10 })).props.onClick();
    h.render();
    button(diffPane(h.value), zh('repo.changes.local.discardLines')).props.onClick();
    await h.flush();
    expect(sent('repo.discard_patch')).toEqual([]);
    expect(text(confirmation(h.value))).toContain(
      zhf('repo.changes.local.confirmLines', { count: 1 }),
    );
    confirm(h);
    await h.flush();
    expect(sent('repo.discard_patch')).toHaveLength(1);
  });

  it('discards a whole file at once and undoes it from the toast', async () => {
    const h = local();
    labelled(
      h.value,
      zhf('repo.changes.local.discard', { path: 'docs/reconcile.md' }),
    ).props.onClick();
    confirm(h);
    await h.flush();
    expect(sent('repo.discard')).toEqual([
      ['repo.discard', { project_id: 'payments', paths: ['docs/reconcile.md'] }, null],
    ]);
    const [{ action }] = mock.toast.mock.calls[0]!;
    expect(action.label).toBe(zh('repo.changes.local.undo'));
    action.run();
    await h.flush();
    expect(sent('repo.discard_undo')).toEqual([
      ['repo.discard_undo', { project_id: 'payments', undo_id: 'undo-7' }, null],
    ]);
  });

  it('discards the selected lines with the patch built from them', async () => {
    const h = local();
    labelled(h.value, zhf('repo.changes.local.pickRemoved', { line: 9 })).props.onClick();
    h.render();
    labelled(h.value, zhf('repo.changes.local.pickAdded', { line: 10 })).props.onClick();
    h.render();
    button(diffPane(h.value), zh('repo.changes.local.discardLines')).props.onClick();
    confirm(h);
    await h.flush();
    expect(sent('repo.discard_patch')).toEqual([
      [
        'repo.discard_patch',
        {
          project_id: 'payments',
          patch: discardPatch(
            fileHeaders(PATCH)[0]!,
            parsePatch(PATCH)[0]!.hunks,
            new Set([lineKey(0, 1), lineKey(0, 3)]),
          ),
        },
        null,
      ],
    ]);
  });

  it('shows a refusal over staged changes beside the line selection', async () => {
    mock.run = vi.fn(async () => ({
      ok: false,
      error: { code: 'staged_changes', message: 'src/config.ts has staged changes' },
    }));
    const h = local();
    labelled(h.value, zhf('repo.changes.local.pickAdded', { line: 10 })).props.onClick();
    h.render();
    button(diffPane(h.value), zh('repo.changes.local.discardLines')).props.onClick();
    confirm(h);
    await h.flush();
    const alert = find(diffPane(h.value), (n) => n.props.role === 'alert');
    expect(text(alert.props.children)).toBe(zh('repo.changes.local.staged'));
    expect(mock.toast).not.toHaveBeenCalled();
  });

  it('commits and discards a renamed file by its new and its old path', async () => {
    mock.working = {
      ...WORKING,
      files: [
        {
          path: 'docs/reconcile.md',
          old_path: 'docs/reconcile-old.md',
          status: 'renamed',
          additions: 1,
          deletions: 1,
        },
      ],
    };
    const h = local();
    write(h, 'Rename the reconcile notes');
    button(h.value, commitText(1)).props.onClick();
    await h.flush();
    expect(sent('repo.commit')[0]![1].paths).toEqual([
      'docs/reconcile.md',
      'docs/reconcile-old.md',
    ]);
    labelled(
      h.value,
      zhf('repo.changes.local.discard', { path: 'docs/reconcile.md' }),
    ).props.onClick();
    confirm(h);
    await h.flush();
    expect(sent('repo.discard')[0]![1].paths).toEqual([
      'docs/reconcile.md',
      'docs/reconcile-old.md',
    ]);
  });

  it('keeps a message typed while the commit was running', async () => {
    const run = deferred<unknown>();
    mock.run = vi.fn(() => run.promise);
    const h = local();
    write(h, 'Raise the partial refund cap');
    button(h.value, commitText(3)).props.onClick();
    h.render();
    write(h, 'Log the retry limit');
    run.resolve({ ok: true, value: { sha: 'abcdef0123456789' } });
    await h.flush();
    expect(labelled(h.value, zh('repo.changes.local.summary')).props.value).toBe(
      'Log the retry limit',
    );
  });

  it('runs one write at a time: a commit, a discard or an undo keeps the others off', async () => {
    const discardOff = (tree: unknown) => [
      ...WORKING.files.map(
        ({ path }) =>
          labelled(tree, zhf('repo.changes.local.discard', { path })).props.disabled as boolean,
      ),
      button(diffPane(tree), zh('repo.changes.local.discardLines')).props.disabled as boolean,
    ];
    const commit = deferred<unknown>();
    mock.run = vi.fn(() => commit.promise);
    const h = local();
    write(h, 'Raise the partial refund cap');
    labelled(h.value, zhf('repo.changes.local.pickAdded', { line: 10 })).props.onClick();
    h.render();
    button(h.value, commitText(3)).props.onClick();
    h.render();
    expect(button(h.value, commitText(3)).props['aria-busy']).toBe(true);
    expect(discardOff(h.value)).toEqual([true, true, true, true]);
    commit.resolve({ ok: true, value: { sha: 'abcdef0123456789' } });
    await h.flush();

    const discard = deferred<unknown>();
    mock.run = vi.fn(() => discard.promise);
    write(h, 'Log the retry limit');
    labelled(
      h.value,
      zhf('repo.changes.local.discard', { path: 'docs/reconcile.md' }),
    ).props.onClick();
    confirm(h);
    h.render();
    expect(button(h.value, commitText(3)).props.disabled).toBe(true);
    expect(button(h.value, commitText(3)).props['aria-busy']).toBeUndefined();
    discard.resolve({ ok: true, value: { undo_id: 'undo-7' } });
    await h.flush();
    expect(button(h.value, commitText(3)).props.disabled).toBe(false);

    const undo = deferred<unknown>();
    mock.run = vi.fn(() => undo.promise);
    mock.toast.mock.calls.at(-1)![0].action.run();
    h.render();
    labelled(h.value, zhf('repo.changes.local.pickAdded', { line: 10 })).props.onClick();
    h.render();
    expect(button(h.value, commitText(3)).props.disabled).toBe(true);
    expect(discardOff(h.value)).toEqual([true, true, true, true]);
    undo.resolve({ ok: true, value: {} });
    await h.flush();
    expect(button(h.value, commitText(3)).props.disabled).toBe(false);
  });

  it('holds the undo in the discard toast off while a commit runs', async () => {
    const h = local();
    labelled(
      h.value,
      zhf('repo.changes.local.discard', { path: 'docs/reconcile.md' }),
    ).props.onClick();
    confirm(h);
    await h.flush();
    expect(mock.toast).toHaveBeenCalledOnce();
    const commit = deferred<unknown>();
    mock.run = vi.fn(() => commit.promise);
    write(h, 'Raise the partial refund cap');
    button(h.value, commitText(3)).props.onClick();
    h.render();
    expect(mock.hold).toHaveBeenLastCalledWith('toast-1', true);
    commit.resolve({ ok: true, value: { sha: 'abcdef0123456789' } });
    await h.flush();
    expect(mock.hold).toHaveBeenLastCalledWith('toast-1', false);
  });

  it('shows a failed read again above the changes it still lists', () => {
    mock.workingError = 'The daemon did not answer';
    const tree = local().value;
    const failure = find(tree as never, (n) => n.props.error === 'The daemon did not answer');
    failure.props.onRetry();
    expect(mock.reload).toHaveBeenCalledTimes(1);
    expect(text(tree)).toContain('docs/reconcile.md');
  });

  it('keeps discarding and committing off while the listed changes are a failed or stale read', () => {
    for (const outdated of [
      () => (mock.workingError = 'The daemon did not answer'),
      () => (mock.workingStale = true),
    ]) {
      mock.workingError = null;
      mock.workingStale = false;
      const h = local();
      labelled(
        h.value,
        zhf('repo.changes.local.discard', { path: 'docs/reconcile.md' }),
      ).props.onClick();
      h.render();
      outdated();
      write(h, 'Raise the partial refund cap');
      labelled(h.value, zhf('repo.changes.local.pickAdded', { line: 10 })).props.onClick();
      h.render();
      expect(button(h.value, commitText(3)).props.disabled).toBe(true);
      for (const { path } of WORKING.files)
        expect(labelled(h.value, zhf('repo.changes.local.discard', { path })).props.disabled).toBe(
          true,
        );
      expect(button(diffPane(h.value), zh('repo.changes.local.discardLines')).props.disabled).toBe(
        true,
      );
      expect(
        button(confirmation(h.value), zh('repo.changes.local.confirmDiscard')).props.disabled,
      ).toBe(true);
    }
  });

  it('renders the shown file’s lines once while the commit message is typed', () => {
    vi.mocked(numbered).mockClear();
    const h = local();
    expect(numbered).toHaveBeenCalled();
    vi.mocked(numbered).mockClear();
    write(h, 'Raise');
    write(h, 'Raise the cap');
    expect(numbered).not.toHaveBeenCalled();
  });

  it('parses the patch once while the commit message is typed', () => {
    const h = local();
    vi.mocked(parsePatch).mockClear();
    write(h, 'Raise');
    write(h, 'Raise the cap');
    expect(parsePatch).not.toHaveBeenCalled();
  });

  it('shows both sides of a path whose type changed and offers no line selection', () => {
    mock.working = {
      ...WORKING,
      files: [{ path: 'link', status: 'modified', additions: 2, deletions: 1 }],
      patch: [
        'diff --git a/link b/link',
        'deleted file mode 120000',
        'index 1111111..0000000',
        '--- a/link',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-target.txt',
        '\\ No newline at end of file',
        'diff --git a/link b/link',
        'new file mode 100644',
        'index 0000000..2222222',
        '--- /dev/null',
        '+++ b/link',
        '@@ -0,0 +1,2 @@',
        '+hello',
        '+world',
        '',
      ].join('\n'),
    };
    const pane = diffPane(local().value);
    expect(text(pane)).toContain('target.txt');
    expect(text(pane)).toContain('hello');
    expect(nodes(pane).filter((n) => n.props.role === 'checkbox')).toEqual([]);
  });

  // Only a modified file's lines can go back through git apply -R without undoing more.
  it.each(['untracked', 'added', 'renamed', 'deleted'] as const)(
    'offers no line selection in a file that is %s',
    (status) => {
      mock.working = {
        ...mock.working,
        files: mock.working.files.map((f: { path: string }) =>
          f.path === 'scripts/seed.mjs' ? { ...f, status } : f,
        ),
      };
      const h = local();
      pick(h, 'scripts/seed.mjs');
      const pane = diffPane(h.value);
      expect(text(pane)).toContain('await seed();');
      expect(nodes(pane).filter((n) => n.props.role === 'checkbox')).toEqual([]);
    },
  );
  const pushText = (count: number) => zhf('repo.changes.local.push', { count });
  const tracking = (ahead: number, behind = 0) => {
    mock.working = { ...WORKING, upstream: { name: 'origin/main', ahead, behind } };
  };

  it('shows the branch and how far it is ahead of and behind its upstream', () => {
    expect(text(local().value)).toContain('main');
    tracking(2, 1);
    const shown = text(local().value);
    expect(shown).toContain('origin/main');
    expect(shown).toContain(zhf('repo.changes.ahead', { count: 2 }));
    expect(shown).toContain(zhf('repo.changes.behind', { count: 1 }));
  });

  it('commits with Command or Control and Enter in the message, as the button says', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
    const h = local();
    expect(button(h.value, commitText(3)).props.title).toBe('⌘↵');
    write(h, 'Raise the partial refund cap');
    const key = (field: string, e: object) =>
      labelled(h.value, zh(field)).props.onKeyDown({
        key: 'Enter',
        metaKey: false,
        ctrlKey: false,
        preventDefault: vi.fn(),
        ...e,
      });
    key('repo.changes.local.summary', {});
    await h.flush();
    expect(sent('repo.commit')).toEqual([]);
    key('repo.changes.local.details', { ctrlKey: true });
    await h.flush();
    expect(sent('repo.commit')).toHaveLength(1);
    expect(sent('repo.commit')[0]![1].message).toBe('Raise the partial refund cap');
  });

  it('offers no push while the branch has nothing its upstream lacks', () => {
    tracking(0);
    expect(nodes(local().value).some((n) => text(n.props.children).startsWith('推送'))).toBe(false);
  });

  it('pushes the commits at once beside the commit button and shows it busy', async () => {
    tracking(2);
    const run = deferred<unknown>();
    mock.run = vi.fn(() => run.promise);
    const h = local();
    const box = find(h.value as never, (n) => n.props.className === 'rpl-commit');
    const parts = [box.props.children].flat(Infinity) as ReactElement<any>[];
    expect(parts.indexOf(button(h.value, pushText(2)))).toBe(
      parts.indexOf(button(h.value, commitText(3))) + 1,
    );
    button(h.value, pushText(2)).props.onClick();
    h.render();
    expect(sent('repo.push')).toEqual([['repo.push', { project_id: 'payments' }, null]]);
    expect(button(h.value, pushText(2)).props['aria-busy']).toBe(true);
    expect(button(h.value, pushText(2)).props.disabled).toBe(true);
    run.resolve({ ok: true, value: {} });
    await h.flush();
    expect(mock.reload).toHaveBeenCalled();
    expect(nodes(h.value).some((n) => text(n.props.children) === pushText(2))).toBe(false);
  });

  it('shows why a push failed under the push button', async () => {
    tracking(1);
    const rejected = ' ! [rejected]        main -> main (fetch first)';
    mock.run = vi.fn(async () => ({
      ok: false,
      error: { code: 'push_rejected', message: rejected },
    }));
    const h = local();
    button(h.value, pushText(1)).props.onClick();
    await h.flush();
    const box = find(h.value as never, (n) => n.props.className === 'rpl-commit');
    const parts = [box.props.children].flat(Infinity) as ReactElement<any>[];
    const alert = parts.find((n) => n?.props?.role === 'alert');
    expect(text(alert!.props.children)).toBe(rejected);
    expect(parts.indexOf(alert!)).toBeGreaterThan(parts.indexOf(button(h.value, pushText(1))));
    mock.run = vi.fn(async () => ({
      ok: false,
      error: { code: 'no_remote', message: 'main has no upstream' },
    }));
    button(h.value, pushText(1)).props.onClick();
    await h.flush();
    expect(text(find(h.value as never, (n) => n.props.role === 'alert'))).toBe(
      zh('repo.local.noRemote'),
    );
  });

  it('offers to push a new commit before the changes are read again', async () => {
    tracking(0);
    const h = local();
    write(h, 'Raise the partial refund cap');
    button(h.value, commitText(3)).props.onClick();
    await h.flush();
    expect(button(h.value, pushText(1))).toBeTruthy();
    mock.working = { ...mock.working, files: [] };
    h.render();
    button(h.value, pushText(1)).props.onClick();
    await h.flush();
    expect(sent('repo.push')).toHaveLength(1);
  });
});
