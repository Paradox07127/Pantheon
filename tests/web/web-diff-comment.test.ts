import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { type HookHost, deferred, mount, nodes, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
import { DiffFiles, type CommentedLine, type DiffRead } from '@/components/DiffReview';
import { t } from '@/i18n';
import { zh } from './i18n-setup.js';

const read = (lines: string[]): DiffRead => ({
  data: {
    files: [{ path: 'a.ts', additions: lines.length - 1, deletions: 0 }],
    patch: `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,${lines.length} @@\n${lines.join('\n')}\n`,
    truncated: false,
  },
  error: null,
  reload() {},
});
const props = (tree: ReactNode, test: (p: any) => boolean) =>
  nodes(tree)
    .map((n) => n.props)
    .filter(test);
const lineButton = (tree: ReactNode, line: number) =>
  props(
    tree,
    (p) =>
      p['aria-label'] ===
      t({ id: 'components.diff.commentLine', defaultMessage: '' }, { path: 'a.ts', line }),
  )[0];
const editors = (tree: ReactNode) =>
  props(tree, (p) => p['aria-label'] === zh('components.diff.commentLabel'));
const editor = (tree: ReactNode) => editors(tree)[0];
const sendButton = (tree: ReactNode) =>
  props(tree, (p) => p.children === zh('components.diff.comment') && 'disabled' in p)[0];

function open<T extends ReactNode>(h: HookHost<T>, line: number, text: string) {
  lineButton(h.value, line).onClick();
  h.render();
  editors(h.value)
    .find((p) => p.value === '')
    .onChange({ target: { value: text } });
  h.render();
}

afterEach(() => {
  unmountAll();
});

it("sends a draft for the line's current number after the diff shifts that line", async () => {
  const sent: CommentedLine[] = [];
  let diff = read([' keep', '+target line']);
  const h = mount(() =>
    DiffFiles({
      diff,
      onComment: async (at) => {
        sent.push(at);
        return true;
      },
    }),
  );
  open(h, 2, 'rename this');
  diff = read([' keep', '+inserted by agent', '+target line']);
  h.render();
  expect(sendButton(h.value).disabled).toBe(false);
  sendButton(h.value).onClick();
  await h.flush();
  expect(sent).toEqual([{ path: 'a.ts', line: 3, kind: 'add', text: 'target line' }]);
});

it('keeps an unsent draft when another line is opened', () => {
  const h = mount(() =>
    DiffFiles({ diff: read([' keep', '+one', '+two']), onComment: async () => true }),
  );
  open(h, 2, 'about one');
  open(h, 3, 'about two');
  expect(editors(h.value).map((p) => p.value)).toEqual(['about one', 'about two']);
});

it.each([
  [
    'disables sending when the drafted line has a twin and the diff changes',
    [' keep', '+same', '+same'],
    3,
    'second copy',
    [' keep', '+same'],
  ],
  [
    'disables sending once the line a draft was opened on is gone from the diff',
    [' keep', '+target line'],
    2,
    'rename this',
    [' keep', '+replaced by agent'],
  ],
])('%s', (_, before, line, draft, after) => {
  let diff = read(before);
  const h = mount(() => DiffFiles({ diff, onComment: async () => true }));
  open(h, line, draft);
  diff = read(after);
  h.render();
  expect(editor(h.value).value).toBe(draft);
  expect(sendButton(h.value).disabled).toBe(true);
});

it('keeps a draft whose file left the diff editable and cancellable', () => {
  let diff = read([' keep', '+target line']);
  const h = mount(() => DiffFiles({ diff, onComment: async () => true }));
  open(h, 2, 'rename this');
  diff = {
    ...diff,
    data: { files: [{ path: 'b.ts', additions: 0, deletions: 0 }], patch: '', truncated: false },
  };
  h.render();
  expect(editor(h.value).value).toBe('rename this');
  expect(sendButton(h.value).disabled).toBe(true);
  props(h.value, (p) => p.children === zh('components.diff.cancel'))[0].onClick();
  h.render();
  expect(editor(h.value)).toBeUndefined();
});

it('lists files above the diffs only when there is more than one', () => {
  const lists = (files: string[]) =>
    props(
      DiffFiles({
        diff: {
          data: {
            files: files.map((path) => ({ path, additions: 1, deletions: 0 })),
            patch: null,
            truncated: false,
          },
          error: null,
          reload() {},
        },
      }),
      (p) => p.className === 'ss-files',
    ).length;
  expect(mount(() => lists(['a.ts'])).value).toBe(0);
  expect(mount(() => lists(['a.ts', 'b.ts'])).value).toBe(1);
});

it('marks a line git says has no newline at the end of the file', () => {
  const marks = (lines: string[]) =>
    props(DiffFiles({ diff: read(lines) }), (p) => p.children === '\\ No newline at end of file')
      .length;
  expect(mount(() => marks([' keep', '+last', '\\ No newline at end of file'])).value).toBe(1);
  expect(mount(() => marks([' keep', '+last'])).value).toBe(0);
});

it('keeps a newer draft typed while an earlier comment was still sending', async () => {
  const done = deferred<boolean>();
  const h = mount(() =>
    DiffFiles({ diff: read([' keep', '+one', '+two']), onComment: () => done.promise }),
  );
  open(h, 2, 'first');
  sendButton(h.value).onClick();
  h.render();
  open(h, 3, 'second unsent');
  done.resolve(true);
  await h.flush();
  expect(editor(h.value)?.value).toBe('second unsent');
});

it('closes the editor once the comment it sent succeeds', async () => {
  const h = mount(() => DiffFiles({ diff: read([' keep', '+one']), onComment: async () => true }));
  open(h, 2, 'first');
  sendButton(h.value).onClick();
  await h.flush();
  expect(editor(h.value)).toBeUndefined();
});

it('says in the box why a comment failed and keeps the draft', async () => {
  const h = mount(() =>
    DiffFiles({
      diff: read([' keep', '+one']),
      onComment: async () => {
        throw new Error('text too long');
      },
    }),
  );
  open(h, 2, 'first');
  sendButton(h.value).onClick();
  await h.flush();
  expect(editor(h.value).value).toBe('first');
  const alert = props(h.value, (p) => p.role === 'alert')[0];
  expect(alert.children).toBe('text too long');
  expect(sendButton(h.value).disabled).toBe(false);
});

const statuses = (files: string[], patch: string) =>
  props(
    DiffFiles({
      diff: {
        data: {
          files: files.map((path) => ({ path, additions: 0, deletions: 0 })),
          patch,
          truncated: false,
        },
        error: null,
        reload() {},
      },
    }),
    (p) => typeof p.className === 'string' && p.className.startsWith('ss-fs '),
  ).map((p) => p.children);

it.each([
  [
    'marks an existing file M when a hunk leaves one side empty',
    ['emptied.txt', 'filled.txt'],
    [
      'diff --git a/emptied.txt b/emptied.txt',
      'index 1111111..e69de29 100644',
      '--- a/emptied.txt',
      '+++ b/emptied.txt',
      '@@ -1,2 +0,0 @@',
      '-one',
      '-two',
      'diff --git a/filled.txt b/filled.txt',
      'index e69de29..2222222 100644',
      '--- a/filled.txt',
      '+++ b/filled.txt',
      '@@ -0,0 +1 @@',
      '+one',
    ],
    ['M', 'M'],
  ],
  [
    'marks a new empty file A',
    ['empty.txt'],
    ['diff --git a/empty.txt b/empty.txt', 'new file mode 100644', 'index 0000000..e69de29'],
    ['A'],
  ],
])('%s', (_, files, patch, expected) => {
  expect(mount(() => statuses(files, [...patch, ''].join('\n'))).value).toEqual(expected);
});
