import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { RepoWorkingDiff } from '@pantheon/protocol';
import { AlertDialog } from '../../apps/web/node_modules/@base-ui/react/alert-dialog';
import { deferred, find, mount, nodes, text, unmountAll, type HookHost } from './web-hook-host.js';

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
// The working diff read, landed with what the test sets.
const local = vi.hoisted(() => ({
  state: null as unknown,
  useRepoWorkingDiff: vi.fn(),
}));
vi.mock('@/data/repo-local', async (actual) => ({
  ...(await actual<object>()),
  useRepoWorkingDiff: local.useRepoWorkingDiff,
}));
vi.mock('@/data/commands', () => ({ runCommand: vi.fn() }));
vi.mock('@/components/Toast', async (actual) => ({
  ...(await actual<object>()),
  toast: vi.fn(() => 'undo-toast'),
  holdToastAction: vi.fn(),
}));
import { Failure } from '@/components/PanelBoundary';
import { holdToastAction, toast } from '@/components/Toast';
import { runCommand } from '@/data/commands';
import { parsePatch } from '@/data/patch';
import { ChangesScreen } from '@/screens/changes/ChangesScreen';
import { Tabs } from '../../apps/web/node_modules/@base-ui/react/tabs';
import { LocalChanges } from '@/screens/changes/LocalChanges';
import { discardPatch, fileHeaders, lineKey } from '@/screens/changes/line-patch';
import { zh, zhf } from './i18n-setup.js';

const HEADER = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
];
const PATCH = [
  ...HEADER,
  '@@ -1,3 +1,3 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  'diff --git a/notes.md b/notes.md',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/notes.md',
  '@@ -0,0 +1 @@',
  '+note',
  '',
].join('\n');

const working = (over: Partial<RepoWorkingDiff> = {}): RepoWorkingDiff => ({
  head_sha: 'a'.repeat(40),
  branch: 'main',
  upstream: { name: 'origin/main', ahead: 2, behind: 1 },
  files: [
    { path: 'src/app.ts', status: 'modified', additions: 1, deletions: 1 },
    { path: 'notes.md', status: 'untracked', additions: 1, deletions: 0 },
  ],
  patch: PATCH,
  truncated: false,
  ...over,
});
const landed = (read: RepoWorkingDiff | null, error: string | null = null) => ({
  read,
  error,
  loading: false,
  stale: false,
  unavailable: false,
  reload: vi.fn(),
});

beforeEach(() => {
  local.state = landed(working());
  local.useRepoWorkingDiff.mockReset();
  local.useRepoWorkingDiff.mockImplementation(() => local.state);
  vi.mocked(runCommand).mockReset();
  vi.mocked(runCommand).mockResolvedValue({ ok: true, value: {} });
  vi.mocked(toast).mockClear();
  vi.mocked(holdToastAction).mockClear();
  mock.board = { board: null, reads: {}, events: [], status: { state: 'live' }, resync: 0 };
  mock.shell = { openSession: vi.fn(), lastDiscard: {} };
});
afterEach(() => unmountAll());

type Host = HookHost<any>;
const screen = () => mount(() => LocalChanges({ projectId: 'alpha' }));
const all = (h: Host) => nodes(h.value as ReactNode);
const labelled = (h: Host, label: string) =>
  find(h.value as ReactNode, (n) => n.props['aria-label'] === label);
const button = (h: Host, name: string) =>
  find(h.value as ReactNode, (n) => n.type === 'button' && text(n.props.children) === name);
const barText = (h: Host) =>
  text(find(h.value as ReactNode, (n) => n.props.className === 'chl-bar'));
const pushButton = (h: Host) => button(h, zh('changes.local.push'));
const commitButton = (h: Host) => button(h, zh('changes.local.commit'));
const includeBox = (h: Host, path: string) => labelled(h, zhf('changes.local.include', { path }));
const discardButton = (h: Host, path: string) =>
  labelled(h, zhf('changes.local.discard', { path }));
const dialog = (h: Host) => find(h.value as ReactNode, (n) => n.type === AlertDialog.Root);
const confirmButton = (h: Host) => button(h, zh('changes.local.confirmDiscard'));
const typeMessage = (h: Host, value: string) => {
  labelled(h, zh('changes.local.message')).props.onChange({ target: { value } });
  h.render();
};
const lineTexts = (h: Host) =>
  all(h)
    .filter((n) => n.props.className === 'chl-code')
    .map((n) => text(n.props.children));
const lineBoxes = (h: Host) => all(h).filter((n) => n.props.className === 'chl-lk');
const lastToast = () => vi.mocked(toast).mock.calls.at(-1)![0];

describe('the local changes tab', () => {
  it('shows the branch, its upstream and how far ahead and behind it is', () => {
    const h = screen();
    expect(barText(h)).toContain('main');
    expect(barText(h)).toContain('origin/main');
    expect(barText(h)).toContain(zhf('changes.local.ahead', { count: 2 }));
    expect(barText(h)).toContain(zhf('changes.local.behind', { count: 1 }));
    expect(pushButton(h).props.disabled).toBe(false);
  });

  it('offers the push only when the branch is ahead or has no upstream', () => {
    local.state = landed(working({ upstream: { name: 'origin/main', ahead: 0, behind: 0 } }));
    const even = screen();
    expect(barText(even)).not.toContain(zh('changes.local.noUpstream'));
    expect(pushButton(even).props.disabled).toBe(true);
    local.state = landed(working({ upstream: null }));
    const none = screen();
    expect(barText(none)).toContain(zh('changes.local.noUpstream'));
    expect(pushButton(none).props.disabled).toBe(false);
  });

  it('names a detached HEAD', () => {
    local.state = landed(working({ branch: null, upstream: null }));
    expect(barText(screen())).toContain(zh('changes.local.detached'));
  });

  it('pushes and reads the working diff again', async () => {
    const h = screen();
    pushButton(h).props.onClick();
    await h.flush();
    expect(runCommand).toHaveBeenCalledWith('repo.push', { project_id: 'alpha' }, null);
    expect((local.state as ReturnType<typeof landed>).reload).toHaveBeenCalled();
  });

  it('shows an empty state when nothing is uncommitted', () => {
    local.state = landed(working({ files: [], patch: '' }));
    expect(text(screen().value as ReactNode)).toContain(zh('changes.local.clean'));
  });

  it('commits exactly the ticked files with the message, then clears both', async () => {
    vi.mocked(runCommand).mockResolvedValue({ ok: true, value: { sha: 'abcdef1234567890' } });
    const h = screen();
    expect(commitButton(h).props.disabled).toBe(true);
    includeBox(h, 'src/app.ts').props.onClick();
    h.render();
    expect(includeBox(h, 'src/app.ts').props['aria-checked']).toBe(true);
    expect(includeBox(h, 'notes.md').props['aria-checked']).toBe(false);
    typeMessage(h, 'Fix the title');
    commitButton(h).props.onClick();
    await h.flush();
    expect(runCommand).toHaveBeenCalledWith(
      'repo.commit',
      { project_id: 'alpha', paths: ['src/app.ts'], message: 'Fix the title' },
      null,
    );
    expect(lastToast().title).toBe(zhf('changes.local.committed', { sha: 'abcdef1' }));
    expect(labelled(h, zh('changes.local.message')).props.value).toBe('');
    expect(includeBox(h, 'src/app.ts').props['aria-checked']).toBe(false);
  });

  it('shows the commit failure as git wrote it', async () => {
    vi.mocked(runCommand).mockResolvedValue({
      ok: false,
      error: { code: 'commit_failed', message: 'pre-commit hook: lint failed' },
    });
    const h = screen();
    includeBox(h, 'notes.md').props.onClick();
    typeMessage(h, 'Add notes');
    commitButton(h).props.onClick();
    await h.flush();
    expect(lastToast()).toEqual({ title: 'pre-commit hook: lint failed', kind: 'failure' });
  });

  it('discards a whole file only after the confirmation, and its toast undoes it', async () => {
    vi.mocked(runCommand).mockResolvedValue({ ok: true, value: { undo_id: 'undo-1' } });
    const h = screen();
    expect(dialog(h).props.open).toBe(false);
    discardButton(h, 'notes.md').props.onClick();
    h.render();
    expect(runCommand).not.toHaveBeenCalled();
    expect(dialog(h).props.open).toBe(true);
    expect(text(dialog(h))).toContain(zhf('changes.local.confirmFile', { path: 'notes.md' }));
    confirmButton(h).props.onClick();
    await h.flush();
    expect(runCommand).toHaveBeenCalledWith(
      'repo.discard',
      { project_id: 'alpha', paths: ['notes.md'] },
      null,
    );
    const shown = lastToast();
    expect(shown.title).toBe(zhf('changes.local.discarded', { path: 'notes.md' }));
    expect(shown.action?.label).toBe(zh('changes.local.undo'));
    vi.mocked(runCommand).mockResolvedValue({ ok: true, value: {} });
    shown.action!.run();
    await h.flush();
    expect(runCommand).toHaveBeenLastCalledWith(
      'repo.discard_undo',
      { project_id: 'alpha', undo_id: 'undo-1' },
      null,
    );
  });

  it('says the undo has expired after 10 minutes', async () => {
    vi.mocked(runCommand).mockResolvedValue({ ok: true, value: { undo_id: 'undo-2' } });
    const h = screen();
    discardButton(h, 'src/app.ts').props.onClick();
    h.render();
    confirmButton(h).props.onClick();
    await h.flush();
    const undo = lastToast().action!;
    vi.mocked(runCommand).mockResolvedValue({
      ok: false,
      error: { code: 'undo_expired', message: 'The discard can no longer be undone' },
    });
    undo.run();
    await h.flush();
    expect(lastToast()).toEqual({ title: zh('changes.local.undoExpired'), kind: 'failure' });
  });

  it('discards the picked lines of a modified file as a reverse patch', async () => {
    vi.mocked(runCommand).mockResolvedValue({ ok: true, value: { undo_id: 'undo-3' } });
    const h = screen();
    labelled(h, zhf('changes.local.pickAdded', { line: 2 })).props.onClick();
    h.render();
    button(h, zh('changes.local.discardLines')).props.onClick();
    h.render();
    expect(text(dialog(h))).toContain(zhf('changes.local.confirmLines', { count: 1 }));
    confirmButton(h).props.onClick();
    await h.flush();
    expect(runCommand).toHaveBeenCalledWith(
      'repo.discard_patch',
      {
        project_id: 'alpha',
        patch: `${[...HEADER, '@@ -1,2 +1,3 @@', ' one', '+TWO', ' three'].join('\n')}\n`,
      },
      null,
    );
  });

  it('picks no lines in an untracked file or when the diff is truncated', () => {
    const h = screen();
    labelled(h, zhf('changes.local.showFile', { path: 'notes.md' })).props.onClick();
    h.render();
    expect(lineTexts(h)).toEqual(['note']);
    expect(lineBoxes(h)).toEqual([]);
    local.state = landed(working({ patch: null, truncated: true }));
    const big = screen();
    expect(text(big.value as ReactNode)).toContain(zh('changes.local.truncated'));
    expect(lineTexts(big)).toEqual([]);
    expect(lineBoxes(big)).toEqual([]);
    expect(includeBox(big, 'notes.md')).toBeTruthy();
  });

  it('keeps every other write off while one runs', async () => {
    const pending = deferred<{ ok: true; value: unknown }>();
    vi.mocked(runCommand).mockReturnValue(pending.promise as never);
    const h = screen();
    includeBox(h, 'src/app.ts').props.onClick();
    typeMessage(h, 'Fix');
    commitButton(h).props.onClick();
    h.render();
    expect(pushButton(h).props.disabled).toBe(true);
    expect(commitButton(h).props.disabled).toBe(true);
    expect(discardButton(h, 'notes.md').props.disabled).toBe(true);
    pending.resolve({ ok: true, value: { sha: 'b'.repeat(40) } });
    await h.flush();
    expect(pushButton(h).props.disabled).toBe(false);
    expect(discardButton(h, 'notes.md').props.disabled).toBe(false);
  });

  it('shows a failed read with a retry, also over the last read', () => {
    local.state = landed(working(), 'daemon went away');
    const h = screen();
    const failure = find(h.value as ReactNode, (n) => n.type === Failure);
    expect(failure.props.error).toBe('daemon went away');
    failure.props.onRetry();
    expect((local.state as ReturnType<typeof landed>).reload).toHaveBeenCalled();
    expect(includeBox(h, 'src/app.ts')).toBeTruthy();
    local.state = landed(null, 'daemon went away');
    expect(
      find(screen().value as ReactNode, (n: ReactElement<any>) => n.type === Failure).props.error,
    ).toBe('daemon went away');
  });

  it('starts over with nothing ticked or typed when the screen moves to another project', () => {
    vi.stubGlobal('window', {
      addEventListener() {},
      removeEventListener() {},
      pantheon: { query: vi.fn(async () => ({ ok: true, value: { changes: [] } })) },
    });
    let projectId = 'alpha';
    const h = mount(() => ChangesScreen({ projectId, sessions: [] }));
    find(h.value as ReactNode, (n) => n.type === Tabs.Root).props.onValueChange('local');
    h.render();
    const tab = () => find(h.value as ReactNode, (n) => n.type === LocalChanges);
    expect(tab().key).toBe('alpha');
    projectId = 'beta';
    h.render();
    expect(tab().props.projectId).toBe('beta');
    expect(tab().key).toBe('beta');
    vi.unstubAllGlobals();
  });

  describe('a staged rename whose old path holds a new untracked file', () => {
    const renamed = () =>
      landed(
        working({
          files: [
            {
              path: 'src/main.ts',
              old_path: 'src/app.ts',
              status: 'renamed',
              additions: 0,
              deletions: 0,
            },
            { path: 'src/app.ts', status: 'untracked', additions: 1, deletions: 0 },
          ],
          patch: '',
        }),
      );

    it('ticks the rename and the file at its old path together and commits both', async () => {
      local.state = renamed();
      vi.mocked(runCommand).mockResolvedValue({ ok: true, value: { sha: 'c'.repeat(40) } });
      const h = screen();
      includeBox(h, 'src/main.ts').props.onClick();
      h.render();
      expect(includeBox(h, 'src/app.ts').props['aria-checked']).toBe(true);
      typeMessage(h, 'Rename the app');
      commitButton(h).props.onClick();
      await h.flush();
      expect(runCommand).toHaveBeenCalledWith(
        'repo.commit',
        { project_id: 'alpha', paths: ['src/main.ts', 'src/app.ts'], message: 'Rename the app' },
        null,
      );
      includeBox(h, 'src/app.ts').props.onClick();
      h.render();
      expect(includeBox(h, 'src/main.ts').props['aria-checked']).toBe(true);
    });

    it('names both paths before it discards the rename and the file at its old path', async () => {
      local.state = renamed();
      vi.mocked(runCommand).mockResolvedValue({ ok: true, value: { undo_id: 'undo-r' } });
      const h = screen();
      discardButton(h, 'src/main.ts').props.onClick();
      h.render();
      expect(text(dialog(h))).toContain(
        zhf('changes.local.confirmLinked', { path: 'src/main.ts', other: 'src/app.ts' }),
      );
      confirmButton(h).props.onClick();
      await h.flush();
      expect(runCommand).toHaveBeenCalledWith(
        'repo.discard',
        { project_id: 'alpha', paths: ['src/main.ts', 'src/app.ts'] },
        null,
      );
    });
  });

  it('keeps a file ticked while the commit ran ticked after it lands', async () => {
    const pending = deferred<{ ok: true; value: unknown }>();
    vi.mocked(runCommand).mockReturnValue(pending.promise as never);
    const h = screen();
    includeBox(h, 'src/app.ts').props.onClick();
    typeMessage(h, 'Fix');
    commitButton(h).props.onClick();
    h.render();
    includeBox(h, 'notes.md').props.onClick();
    h.render();
    pending.resolve({ ok: true, value: { sha: 'b'.repeat(40) } });
    await h.flush();
    expect(includeBox(h, 'src/app.ts').props['aria-checked']).toBe(false);
    expect(includeBox(h, 'notes.md').props['aria-checked']).toBe(true);
  });

  it('closes the discard confirmation without discarding when the read changes under it', async () => {
    const h = screen();
    discardButton(h, 'notes.md').props.onClick();
    h.render();
    expect(dialog(h).props.open).toBe(true);
    local.state = landed(
      working({
        files: [
          { path: 'src/app.ts', status: 'modified', additions: 1, deletions: 1 },
          { path: 'notes.md', status: 'modified', additions: 1, deletions: 0 },
        ],
      }),
    );
    h.render();
    expect(dialog(h).props.open).toBe(false);
    confirmButton(h).props.onClick();
    await h.flush();
    expect(runCommand).not.toHaveBeenCalled();
  });

  describe('the undo of the last discard in the panel', () => {
    const undoRow = (h: Host) =>
      nodes(h.value as ReactNode).find(
        (n) =>
          n.props.role === 'group' && n.props['aria-label'] === zh('changes.local.lastDiscard'),
      );
    const undoInRow = (h: Host) =>
      find(
        undoRow(h),
        (n) => n.type === 'button' && text(n.props.children) === zh('changes.local.undo'),
      );
    async function discardNotes(h: Host, undoId: string) {
      vi.mocked(runCommand).mockResolvedValue({ ok: true, value: { undo_id: undoId } });
      discardButton(h, 'notes.md').props.onClick();
      h.render();
      confirmButton(h).props.onClick();
      await h.flush();
      // The last discard lives in the shell store, which this mock does not subscribe to.
      h.render();
    }

    it('stays after the toast, is retried after a failure and goes once undone', async () => {
      const h = screen();
      expect(undoRow(h)).toBeUndefined();
      await discardNotes(h, 'undo-4');
      expect(text(undoRow(h))).toContain(zhf('changes.local.discarded', { path: 'notes.md' }));
      vi.mocked(runCommand).mockResolvedValue({
        ok: false,
        error: { code: 'invalid_state', message: 'notes.md changed after the discard' },
      });
      undoInRow(h).props.onClick();
      await h.flush();
      h.render();
      expect(undoInRow(h).props.disabled).toBe(false);
      vi.mocked(runCommand).mockResolvedValue({ ok: true, value: {} });
      undoInRow(h).props.onClick();
      await h.flush();
      h.render();
      expect(runCommand).toHaveBeenLastCalledWith(
        'repo.discard_undo',
        { project_id: 'alpha', undo_id: 'undo-4' },
        null,
      );
      expect(undoRow(h)).toBeUndefined();
    });

    it('keeps the undo when the tab is left and opened again', async () => {
      await discardNotes(screen(), 'undo-7');
      unmountAll();
      expect(text(undoRow(screen()))).toContain(
        zhf('changes.local.discarded', { path: 'notes.md' }),
      );
    });

    it('hides the undo once the 10 minutes it lasts have passed', async () => {
      const h = screen();
      await discardNotes(h, 'undo-8');
      expect(undoRow(h)).toBeDefined();
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60_000);
      h.render();
      expect(undoRow(h)).toBeUndefined();
      vi.mocked(Date.now).mockRestore();
    });

    it('goes when the undo has expired, and the next discard takes its place', async () => {
      const h = screen();
      await discardNotes(h, 'undo-5');
      await discardNotes(h, 'undo-6');
      vi.mocked(runCommand).mockResolvedValue({
        ok: false,
        error: { code: 'undo_expired', message: 'The discard can no longer be undone' },
      });
      undoInRow(h).props.onClick();
      await h.flush();
      h.render();
      expect(runCommand).toHaveBeenLastCalledWith(
        'repo.discard_undo',
        { project_id: 'alpha', undo_id: 'undo-6' },
        null,
      );
      expect(undoRow(h)).toBeUndefined();
    });
  });
});

describe('the reverse patch of picked lines', () => {
  it('keeps an unpicked added line as context and drops an unpicked removed line', () => {
    const hunks = parsePatch(PATCH)[0]!.hunks;
    const header = fileHeaders(PATCH)[0]!;
    expect(discardPatch(header, hunks, new Set([lineKey(0, 2)]))).toBe(
      `${[...HEADER, '@@ -1,2 +1,3 @@', ' one', '+TWO', ' three'].join('\n')}\n`,
    );
    expect(discardPatch(header, hunks, new Set([lineKey(0, 1)]))).toBe(
      `${[...HEADER, '@@ -1,4 +1,3 @@', ' one', '-two', ' TWO', ' three'].join('\n')}\n`,
    );
  });

  it('starts a later hunk where the file stands once the earlier hunks are left alone', () => {
    const patch = [
      ...HEADER,
      '@@ -1,2 +1,3 @@',
      ' a',
      '+b',
      ' c',
      '@@ -10,2 +11,3 @@',
      ' x',
      '+y',
      ' z',
      '',
    ].join('\n');
    const hunks = parsePatch(patch)[0]!.hunks;
    expect(discardPatch(fileHeaders(patch)[0]!, hunks, new Set([lineKey(1, 1)]))).toBe(
      `${[...HEADER, '@@ -11,2 +11,3 @@', ' x', '+y', ' z'].join('\n')}\n`,
    );
  });
});
