import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { mount, nodes, text, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
import { DiffFiles, type DiffRead } from '@/components/DiffReview';
import {
  DEFAULT_DIFF_PREFS,
  DIFF_PREFS_KEY,
  getDiffPrefs,
  readDiffPrefs,
  setDiffPrefs,
} from '@/data/diff-prefs';
import { t } from '@/i18n';
import { zh } from './i18n-setup.js';

const file = (path: string, hunks: string[][]) =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    ...hunks.flatMap((lines, i) => [`@@ -${i * 10 + 1},2 +${i * 10 + 1},2 @@`, ...lines]),
  ].join('\n');
const read = (files: Record<string, string[][]>): DiffRead => ({
  data: {
    files: Object.keys(files).map((path) => ({ path, additions: 1, deletions: 1 })),
    patch: `${Object.entries(files)
      .map(([path, hunks]) => file(path, hunks))
      .join('\n')}\n`,
    truncated: false,
  },
  error: null,
  reload() {},
});
const reindented = [' keep', '-  spaced(x)', '+spaced( x )'];
const renamed = [' keep', '-old name', '+new name'];

const show = (diff: DiffRead) => mount(() => DiffFiles({ diff }));
const props = (tree: ReactNode, test: (p: any) => boolean) =>
  nodes(tree)
    .map((n) => n.props)
    .filter(test);
const option = (tree: ReactNode, label: string | undefined) =>
  props(tree, (p) => p['aria-label'] === label)[0];
const fold = (tree: ReactNode, path: string) =>
  props(
    tree,
    (p) =>
      p['aria-label'] === t({ id: 'components.diff.fileChanges', defaultMessage: '' }, { path }),
  )[0];
const hunkHeaders = (tree: ReactNode) =>
  props(tree, (p) => p.className === 'ss-ln hh').map((p) => p.children);
const lists = (tree: ReactNode) => props(tree, (p) => p.className === 'ss-dl mono');

let stored: Map<string, string>;
beforeEach(() => {
  stored = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
});
afterEach(() => {
  unmountAll();
  setDiffPrefs(DEFAULT_DIFF_PREFS);
  vi.unstubAllGlobals();
});

it('wraps long lines until the wrap option is turned off', () => {
  const h = show(read({ 'a.ts': [renamed] }));
  const wrap = () => option(h.value, zh('components.diff.wrap'));
  expect(wrap()['aria-pressed']).toBe(true);
  expect(lists(h.value)[0]['data-nowrap']).toBeUndefined();
  wrap().onClick();
  h.render();
  expect(wrap()['aria-pressed']).toBe(false);
  expect(lists(h.value)[0]['data-nowrap']).toBe(true);
});

it('hides hunks that only change whitespace when ignoring whitespace', () => {
  const h = show(read({ 'a.ts': [reindented, renamed] }));
  expect(hunkHeaders(h.value)).toEqual(['@@ -1,2 +1,2 @@', '@@ -11,2 +11,2 @@']);
  option(h.value, zh('components.diff.ignoreWhitespace')).onClick();
  h.render();
  expect(option(h.value, zh('components.diff.ignoreWhitespace'))['aria-pressed']).toBe(true);
  expect(hunkHeaders(h.value)).toEqual(['@@ -11,2 +11,2 @@']);
});

it('marks and folds a file whose only changes are whitespace when ignoring whitespace', () => {
  setDiffPrefs({ ignore_whitespace: true });
  const h = show(read({ 'spaces.ts': [reindented], 'a.ts': [renamed] }));
  const header = (path: string) =>
    props(h.value, (p) => p.className === 'ss-fdh mono').find((p) =>
      text(p.children).includes(path),
    );
  expect(text(header('spaces.ts').children)).toContain(zh('components.diff.whitespaceOnly'));
  expect(text(header('a.ts').children)).not.toContain(zh('components.diff.whitespaceOnly'));
  expect(fold(h.value, 'spaces.ts')['aria-expanded']).toBe(false);
  expect(fold(h.value, 'a.ts')['aria-expanded']).toBe(true);
  expect(hunkHeaders(h.value)).toEqual(['@@ -1,2 +1,2 @@']);
});

it('opens every file folded to its header when collapsing by default, and unfolds one on click', () => {
  setDiffPrefs({ collapse: true });
  const h = show(read({ 'a.ts': [renamed], 'b.ts': [renamed] }));
  expect(option(h.value, zh('components.diff.collapse'))['aria-pressed']).toBe(true);
  expect(lists(h.value)).toHaveLength(0);
  expect(fold(h.value, 'a.ts')['aria-expanded']).toBe(false);
  fold(h.value, 'a.ts').onClick();
  h.render();
  expect(fold(h.value, 'a.ts')['aria-expanded']).toBe(true);
  expect(fold(h.value, 'b.ts')['aria-expanded']).toBe(false);
  expect(lists(h.value)).toHaveLength(1);
});

it('marks the file it was opened at as the current row of the list', () => {
  const h = mount(() =>
    DiffFiles({ diff: read({ 'a.ts': [renamed], 'b.ts': [renamed] }), path: 'b.ts' }),
  );
  const row = (path: string) =>
    nodes(h.value).find((n) => n.props.content === path)!.props.children.props;
  expect(row('b.ts')['aria-current']).toBe(true);
  expect(row('a.ts')['aria-current']).toBeUndefined();
});

it('keeps the chosen options after the preferences are read again', async () => {
  const h = show(read({ 'a.ts': [renamed] }));
  option(h.value, zh('components.diff.wrap')).onClick();
  option(h.value, zh('components.diff.collapse')).onClick();
  expect(readDiffPrefs(stored.get(DIFF_PREFS_KEY) ?? null)).toEqual({
    wrap: false,
    ignore_whitespace: false,
    collapse: true,
    view: 'unified',
    tab_size: 4,
    changes_viewer: 'app',
  });
  vi.resetModules();
  const again = await import('@/data/diff-prefs');
  expect(again.getDiffPrefs()).toEqual({
    wrap: false,
    ignore_whitespace: false,
    collapse: true,
    view: 'unified',
    tab_size: 4,
    changes_viewer: 'app',
  });
  expect(getDiffPrefs()).toEqual(again.getDiffPrefs());
});

it('reads a missing or unreadable preference as the current behaviour', () => {
  expect(readDiffPrefs(null)).toEqual(DEFAULT_DIFF_PREFS);
  expect(readDiffPrefs('{bad')).toEqual(DEFAULT_DIFF_PREFS);
  expect(DEFAULT_DIFF_PREFS).toEqual({
    wrap: true,
    ignore_whitespace: false,
    collapse: false,
    view: 'unified',
    tab_size: 4,
    changes_viewer: 'app',
  });
});
