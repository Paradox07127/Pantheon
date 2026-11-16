import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { mount, nodes, text, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
import { DiffFiles, type CommentedLine, type DiffRead } from '@/components/DiffReview';
import { DEFAULT_DIFF_PREFS, getDiffPrefs, setDiffPrefs } from '@/data/diff-prefs';
import { zh } from './i18n-setup.js';

const file = (path: string, lines: string[]) => [
  `diff --git a/${path} b/${path}`,
  `--- a/${path}`,
  `+++ b/${path}`,
  '@@ -1,3 +1,3 @@',
  ...lines,
];
const read = (files: Record<string, string[]>): DiffRead => ({
  data: {
    files: Object.keys(files).map((path) => ({ path, additions: 1, deletions: 1 })),
    patch: `${Object.entries(files)
      .flatMap(([path, lines]) => file(path, lines))
      .join('\n')}\n`,
    truncated: false,
  },
  error: null,
  reload() {},
});
const changed = [' keep', '-old one', '-old two', '+new one', ' tail'];

const props = (tree: ReactNode, test: (p: any) => boolean) =>
  nodes(tree)
    .map((n) => n.props)
    .filter(test);
const labelled = (tree: ReactNode, label: string) => props(tree, (p) => p['aria-label'] === label);
const has = (p: any, name: string) =>
  typeof p.className === 'string' && p.className.split(' ').includes(name);

beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
});
afterEach(() => {
  unmountAll();
  setDiffPrefs(DEFAULT_DIFF_PREFS);
  vi.unstubAllGlobals();
});

it('counts the files marked viewed from the list or from the file header', () => {
  const h = mount(() => DiffFiles({ diff: read({ 'a.ts': changed, 'b.ts': changed }) }));
  const progress = () => text(props(h.value, (p) => has(p, 'df-seen'))[0].children);
  expect(progress()).toBe('已看 0 / 2');
  const boxes = labelled(h.value, '标为已看 a.ts');
  expect(boxes).toHaveLength(2);
  expect(boxes.every((p) => p.type === 'checkbox' && p.checked === false)).toBe(true);
  boxes[0].onChange({ target: { checked: true } });
  h.render();
  expect(progress()).toBe('已看 1 / 2');
  expect(labelled(h.value, '标为已看 a.ts').map((p) => p.checked)).toEqual([true, true]);
  labelled(h.value, '标为已看 b.ts')[1].onChange({ target: { checked: true } });
  h.render();
  expect(progress()).toBe('已看 2 / 2');
  labelled(h.value, '标为已看 a.ts')[1].onChange({ target: { checked: false } });
  h.render();
  expect(progress()).toBe('已看 1 / 2');
});

it('drops the viewed mark of a file whose changes differ from the ones marked, and keeps it for the same ones', () => {
  let diff = read({ 'x.ts': changed, 'y.ts': changed });
  const h = mount(() => DiffFiles({ diff }));
  const progress = () => text(props(h.value, (p) => has(p, 'df-seen'))[0].children);
  const row = () => props(h.value, (p) => has(p, 'df-tf'))[0];
  labelled(h.value, '标为已看 x.ts')[0].onChange({ target: { checked: true } });
  h.render();
  expect(progress()).toBe('已看 1 / 2');
  diff = read({ 'x.ts': [' keep', '-old one', '+other one', ' tail'], 'y.ts': changed });
  h.render();
  expect(progress()).toBe('已看 0 / 2');
  expect(labelled(h.value, '标为已看 x.ts').map((p) => p.checked)).toEqual([false, false]);
  expect(row()['data-viewed']).toBeUndefined();
  diff = read({ 'x.ts': changed, 'y.ts': changed });
  h.render();
  expect(progress()).toBe('已看 1 / 2');
  expect(row()['data-viewed']).toBe(true);
});

it('switches between the unified and the split view and stores the choice', () => {
  const h = mount(() => DiffFiles({ diff: read({ 'a.ts': changed }) }));
  const view = () => labelled(h.value, zh('components.diff.view'))[0];
  expect(view().value).toBe('unified');
  expect(props(h.value, (p) => has(p, 'df-sr'))).toHaveLength(0);
  view().onValueChange('split');
  h.render();
  expect(getDiffPrefs().view).toBe('split');
  expect(view().value).toBe('split');
  const rows = props(h.value, (p) => has(p, 'df-sr')).map((row) =>
    nodes(row.children)
      .filter((n) => has(n.props, 'df-half'))
      .map((half) => text(half.props.children)),
  );
  // Removed lines sit beside the added lines that replace them; context fills both sides.
  expect(rows).toEqual([
    ['1keep', '1keep'],
    ['2−old one', '2+new one'],
    ['3−old two', ''],
    ['4tail', '3tail'],
  ]);
});

it('opens a comment from either side of the split view', () => {
  setDiffPrefs({ view: 'split' });
  const sent: CommentedLine[] = [];
  const h = mount(() =>
    DiffFiles({
      diff: read({ 'a.ts': changed }),
      onComment: async (at) => {
        sent.push(at);
        return true;
      },
    }),
  );
  expect(labelled(h.value, '评论 a.ts 第 1 行')).toHaveLength(2);
  labelled(h.value, '评论 a.ts 第 2 行')[0].onClick();
  h.render();
  expect(labelled(h.value, zh('components.diff.commentLabel'))).toHaveLength(1);
  expect(labelled(h.value, zh('components.diff.commentLabel'))[0].value).toBe('');
});

it('groups the file list by directory and names each file there by its own name', () => {
  const h = mount(() =>
    DiffFiles({
      diff: read({
        'web/refunds/filters.ts': changed,
        'README.md': changed,
        'web/refunds/List.tsx': changed,
        'web/api.ts': changed,
      }),
    }),
  );
  const groups = props(h.value, (p) => has(p, 'df-dir')).map((g) => ({
    dir: text(props(g.children, (p) => has(p, 'df-dirn'))[0].children),
    files: props(g.children, (p) => has(p, 'ss-file')).map((p) => text(p.children)),
  }));
  expect(groups).toEqual([
    { dir: 'web/refunds', files: ['Mfilters.ts+1 −1', 'MList.tsx+1 −1'] },
    { dir: 'web', files: ['Mapi.ts+1 −1'] },
  ]);
  // A file at the root stays unindented, in the order the diff lists it.
  const top = props(h.value, (p) => has(p, 'ss-files'))[0];
  expect(
    [top.children]
      .flat(2)
      .map((li: any) =>
        has(li.props, 'df-dir')
          ? text(props(li.props.children, (p) => has(p, 'df-dirn'))[0].children)
          : text(props(li.props.children, (p) => has(p, 'ss-file'))[0].children),
      ),
  ).toEqual(['web/refunds', 'MREADME.md+1 −1', 'web']);
});

it('draws the five-cell bar of added and removed lines before the counts of each file row', () => {
  const h = mount(() => DiffFiles({ diff: read({ 'a.ts': changed, 'b.ts': changed }) }));
  const rows = props(h.value, (p) => has(p, 'ss-file'));
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    const cells = [row.children].flat(2) as any[];
    const bar = cells.findIndex((n) => n?.type?.name === 'DiffStat');
    expect(cells[bar]?.props).toEqual({ additions: 1, deletions: 1 });
    expect(has(cells[bar + 1].props, 'df-n')).toBe(true);
  }
});
