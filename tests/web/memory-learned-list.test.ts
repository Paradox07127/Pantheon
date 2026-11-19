import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LearnedItem } from '@pantheon/protocol';
import { find, HookHost, nodes, text } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
import { LearnedList, type LearnedListProps } from '@/screens/memory/LearnedList';
import { zh } from './i18n-setup.js';

const NOW = new Date(2026, 10, 13, 15, 0).getTime();
const at = (day: number, hour: number, minute: number) =>
  new Date(2026, 10, day, hour, minute).getTime();

const item = (over: Partial<LearnedItem> & { id: string }): LearnedItem => ({
  kind: 'experience',
  grade: 'trial',
  status: 'candidate',
  group: 'needs_you',
  diff: { from: '', to: `rule ${over.id}` },
  evidence: [],
  actions: [],
  at: at(13, 14, 33),
  ...over,
});

const items: LearnedItem[] = [
  item({
    id: 'c1',
    diff: { from: '', to: 'Run `pnpm test webhook` first.\nNot for docs.' },
  }),
  item({ id: 'a1', status: 'active', group: 'in_force', at: at(6, 9, 0) }),
  item({
    id: 't1',
    kind: 'policy_change',
    title: 'max_parallel',
    status: 'trial',
    group: 'on_trial',
    diff: { from: '3', to: '4' },
    n: 2,
    tasks_required: 5,
    at: at(11, 9, 0),
  }),
  item({
    id: 'a2',
    kind: 'policy_change',
    title: 'path',
    status: 'active',
    group: 'in_force',
    diff: { from: 'dispatch', to: 'direct' },
    verdict: 'better',
    n: 8,
    at: at(2, 9, 0),
  }),
  item({
    id: 'x1',
    status: 'reverted',
    group: 'reverted',
    verdict: 'not_enough_evidence',
    n: 2,
    at: at(10, 9, 0),
  }),
  item({ id: 'c2' }),
  item({ id: 'x2', status: 'rejected', group: 'reverted', at: at(9, 9, 0) }),
];

const props = (over: Partial<LearnedListProps> = {}): LearnedListProps => ({
  items,
  selected: null,
  onSelect: vi.fn(),
  ...over,
});

const mount = (p: LearnedListProps) => {
  const host = new HookHost(() => LearnedList(p) as ReactElement<any>);
  host.render();
  return host;
};
const listboxes = (tree: ReactElement<any>) =>
  nodes(tree).filter((n) => n.props.role === 'listbox');
const rows = (tree: ReactElement<any>) => nodes(tree).filter((n) => n.props.role === 'option');
const fold = (tree: ReactElement<any>) => find(tree, (n) => 'aria-expanded' in n.props);
const part = (row: ReactElement<any>, name: string) => find(row, (n) => n.props.className === name);
const shape = (row: ReactElement<any>) =>
  renderToStaticMarkup(part(row, 'lr-st')).match(/data-shape="([^"]+)"/)?.[1];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('learned list', () => {
  it('groups the rows needing you, on trial and in force, each under its name and count', () => {
    const tree = mount(props()).value;
    expect(find(tree, (n) => n.type === 'section').props['aria-label']).toBe(
      zh('memory.learned.label'),
    );
    expect(listboxes(tree).map((n) => n.props['aria-label'])).toEqual([
      zh('memory.learned.group.candidate'),
      zh('memory.learned.group.trial'),
      zh('memory.learned.group.active'),
    ]);
    expect(listboxes(tree).map((n) => rows(n).map((r) => r.key))).toEqual([
      ['c1', 'c2'],
      ['t1'],
      ['a1', 'a2'],
    ]);
    expect(
      nodes(tree)
        .filter((n) => n.props.className === 'lr-gh')
        .map((n) => text(n)),
    ).toEqual([
      `${zh('memory.learned.group.candidate')}2`,
      `${zh('memory.learned.group.trial')}1`,
      `${zh('memory.learned.group.active')}2`,
    ]);
  });

  it('leaves out a group with no rows', () => {
    const tree = mount(props({ items: items.filter((i) => i.group !== 'on_trial') })).value;
    expect(listboxes(tree).map((n) => n.props['aria-label'])).toEqual([
      zh('memory.learned.group.candidate'),
      zh('memory.learned.group.active'),
    ]);
    expect(text(tree)).not.toContain(zh('memory.learned.group.trial'));
  });

  it('draws a row with its state glyph, title, kind, trial and age', () => {
    const tree = mount(props()).value;
    const [first, , trial, , set] = rows(tree);
    expect(first!.props.className).toBe('lr-row');
    expect(first!.props['aria-selected']).toBe(false);
    expect(part(first!, 'lr-st').props['aria-hidden']).toBe('true');
    expect(text(part(first!, 'lr-tt'))).toBe('Run `pnpm test webhook` first.');
    expect(text(part(first!, 'lr-kind'))).toBe(zh('memory.learned.kind.experience'));
    expect(text(part(first!, 'lr-tr'))).toBe('');
    expect(text(part(first!, 'lr-tm'))).toBe('27 分钟');
    expect(rows(tree).map(shape)).toEqual([
      'clipboard',
      'clipboard',
      'hollow-diamond',
      'circle-check',
      'circle-check',
    ]);
    expect(
      nodes(part(trial!, 'lr-tt'))
        .filter((n) => n.props.className)
        .map((n) => [n.props.className, text(n)]),
    ).toEqual([
      ['lr-tt', '并发上限34'],
      ['lr-what', '并发上限'],
      ['lr-from', '3'],
      ['lr-to', '4'],
    ]);
    expect(text(part(trial!, 'lr-tr'))).toBe(
      `${zh('memory.learned.verdict.notEnoughEvidence')}2 / 5 个任务`,
    );
    expect(text(part(trial!, 'lr-tm'))).toBe('2 天');
    expect(text(part(set!, 'lr-tr'))).toBe(`${zh('memory.learned.verdict.better')}8 个任务`);
  });

  it('marks the selected row and selects the row that is clicked', () => {
    const p = props({ selected: 't1' });
    const tree = mount(p).value;
    expect(rows(tree).map((r) => r.props['aria-selected'])).toEqual([
      false,
      false,
      true,
      false,
      false,
    ]);
    rows(tree)[3]!.props.onClick();
    expect(p.onSelect).toHaveBeenCalledWith('a1');
  });

  it('folds the reverted rows under a button that opens them', () => {
    const host = mount(props());
    expect(fold(host.value).props['aria-expanded']).toBe(false);
    expect(text(fold(host.value))).toBe(`${zh('memory.learned.group.closed')}2`);
    expect(listboxes(host.value)).toHaveLength(3);
    fold(host.value).props.onClick();
    host.render();
    expect(fold(host.value).props['aria-expanded']).toBe(true);
    const old = listboxes(host.value)[3]!;
    expect(old.props['aria-label']).toBe(zh('memory.learned.group.closed'));
    expect(old.props.className).toBe('lr-old');
    expect(rows(old).map((r) => r.key)).toEqual(['x1', 'x2']);
    expect(text(part(rows(old)[0]!, 'lr-tr'))).toBe(
      `${zh('memory.learned.verdict.notEnoughEvidence')}2 个任务`,
    );
    expect(rows(old).map(shape)).toEqual(['hollow-circle', 'hollow-circle']);
    fold(host.value).props.onClick();
    host.render();
    expect(listboxes(host.value)).toHaveLength(3);
  });

  it('shows no fold when nothing was reverted', () => {
    const tree = mount(props({ items: items.filter((i) => i.id[0] !== 'x') })).value;
    expect(nodes(tree).some((n) => 'aria-expanded' in n.props)).toBe(false);
  });

  it('staggers the rows in, holding the delay after the sixth', () => {
    const tree = mount(props()).value;
    expect(rows(tree).map((r) => r.props.style['--lr-k'])).toEqual([0, 1, 2, 3, 4]);
    const many = Array.from({ length: 9 }, (_, i) => item({ id: `c${i}` }));
    expect(rows(mount(props({ items: many })).value).map((r) => r.props.style['--lr-k'])).toEqual([
      0, 1, 2, 3, 4, 5, 6, 6, 6,
    ]);
  });
});

describe('learned list columns', () => {
  const css = readFileSync(
    path.resolve(import.meta.dirname, '../../apps/web/src/screens/memory/memory-learned.css'),
    'utf8',
  );
  const columns = (selector: string) =>
    new RegExp(`\\${selector} \\{[^}]*grid-template-columns: ([^;]+);`).exec(css)![1]!;

  /** The track widths a grid with these columns and 8px gaps gives in `width` pixels. */
  function trackWidths(template: string, width: number): number[] {
    const tracks = [...template.matchAll(/minmax\(([^,]+), ([^)]+)\)|(\d+)px/g)].map((m) =>
      m[3]
        ? { min: Number(m[3]), max: Number(m[3]), fr: false }
        : {
            min: parseFloat(m[1]!),
            max: m[2]!.endsWith('fr') ? Infinity : parseFloat(m[2]!),
            fr: m[2]!.endsWith('fr'),
          },
    );
    const sizes = tracks.map((t) => t.min);
    let free = width - 8 * (tracks.length - 1) - sizes.reduce((a, b) => a + b, 0);
    for (let growing = tracks.filter((t) => !t.fr); free > 0.01;) {
      growing = growing.filter((t) => sizes[tracks.indexOf(t)]! < t.max);
      if (!growing.length) break;
      const share = free / growing.length;
      for (const t of growing) {
        const i = tracks.indexOf(t);
        const step = Math.min(share, t.max - sizes[i]!);
        sizes[i] = sizes[i]! + step;
        free -= step;
      }
    }
    tracks.forEach((t, i) => {
      if (t.fr && free > 0) sizes[i] = sizes[i]! + free;
    });
    return sizes;
  }

  it('keeps the title readable beside the details at the narrowest window', () => {
    // 1100px window, 248px sidebar, 8px inset, 400px details, then the list and row paddings.
    const width = 1100 - 248 - 8 - 400 - 32 - 16;
    expect(trackWidths(columns('.lr-row'), width)[1]).toBeGreaterThanOrEqual(160);
  });

  it('gives the title the room the other columns leave in a wide list', () => {
    const [, title, kind, trial, age] = trackWidths(columns('.lr-row'), 900);
    expect([kind, trial, age]).toEqual([128, 176, 48]);
    expect(title).toBe(900 - 32 - 16 - 128 - 176 - 48);
  });
});
