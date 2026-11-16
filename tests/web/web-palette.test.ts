import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { HookHost, find, named, nodes } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'palette' }),
);
import { CommandPalette } from '@/components/CommandPalette';
import { paletteSections, type PaletteItem } from '@/components/palette';

const item = (id: string, group: PaletteItem['group'], label = id): PaletteItem => ({
  id,
  group,
  label,
  run: () => {},
});

const ids = (items: PaletteItem[]) => items.map((i) => i.id);

describe('palette search', () => {
  it.each([
    [
      'lists every item by session, action, screen order for an empty query',
      [
        item('s1', 'session'),
        item('p1', 'screen'),
        item('a1', 'action'),
        item('s2', 'session'),
        item('a2', 'action'),
      ],
      '',
      ['s1', 's2', 'a1', 'a2', 'p1'],
    ],
    [
      'matches labels without regard to case',
      [item('a', 'session', 'Fix Gate'), item('b', 'session', 'other')],
      'fix gATE',
      ['a'],
    ],
    [
      'puts labels that start with the query before other matches, keeping order within each',
      [
        item('mid1', 'action', 'a gate b'),
        item('start1', 'session', 'gate one'),
        item('mid2', 'screen', 'the gate'),
        item('start2', 'action', 'Gate two'),
      ],
      'gate',
      ['start1', 'start2', 'mid1', 'mid2'],
    ],
    ['returns nothing when no label matches', [item('a', 'action', '新会话')], 'zzz', []],
  ])('%s', (_name, items, query, expected) => {
    expect(ids(paletteSections(items, query).flatMap((s) => s.items))).toEqual(expected);
  });

  it('returns at most 50 items', () => {
    const items = Array.from({ length: 80 }, (_, n) => item(`s${n}`, 'session', `session ${n}`));
    expect(paletteSections(items, '').flatMap((s) => s.items)).toHaveLength(50);
    expect(ids(paletteSections(items, 'session').flatMap((s) => s.items))).toEqual(
      ids(items.slice(0, 50)),
    );
  });
});

describe('command palette', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('runs the selected item after the results reorder', () => {
    vi.stubGlobal('document', { getElementById: () => null });
    const ran = vi.fn();
    const session = (id: string): PaletteItem => ({
      id,
      group: 'session',
      label: `title of ${id}`,
      run: () => ran(id),
    });
    let items = [session('a'), session('b'), session('c')];
    const h = new HookHost(() => {
      const body = named(CommandPalette({ open: true, onOpenChange() {}, items }), 'PaletteBody');
      return (body.type as (props: unknown) => ReactNode)(body.props);
    });
    h.render();
    const key = (k: string) => ({
      key: k,
      nativeEvent: { isComposing: false },
      preventDefault() {},
    });
    const input = () => find(h.value, (n) => n.type === 'input');
    input().props.onKeyDown(key('ArrowDown'));
    h.render();
    items = [session('b'), session('a'), session('c')];
    h.render();
    expect(input().props['aria-activedescendant']).toBe('palette-0');
    input().props.onKeyDown(key('Enter'));
    expect(ran).toHaveBeenCalledWith('b');
  });

  const mountPalette = (items: PaletteItem[], open: () => boolean) => {
    vi.stubGlobal('document', { getElementById: () => null });
    const h = new HookHost(() => {
      const body = named(CommandPalette({ open: open(), onOpenChange() {}, items }), 'PaletteBody');
      return (body.type as (props: unknown) => ReactNode)(body.props);
    });
    h.render();
    return h;
  };

  it('keys each result row by its item, across groups', () => {
    const h = mountPalette(
      [item('s1', 'session'), item('a1', 'action'), item('s2', 'session')],
      () => true,
    );
    const list = find(h.value, (n) => n.props.role === 'listbox');
    const rows = nodes(list).filter((n) => n.props.role === 'option');
    expect(rows.map((row) => row.key)).toEqual(['s1', 's2', 'a1']);
  });

  it('starts an empty search when reopened before the closing dialog unmounts', () => {
    let open = true;
    const h = mountPalette(
      [item('a1', 'action', 'alpha'), item('a2', 'action', 'beta')],
      () => open,
    );
    const input = () => find(h.value, (n) => n.type === 'input');
    input().props.onChange({ target: { value: 'be' } });
    h.render();
    expect(input().props.value).toBe('be');
    open = false;
    h.render();
    open = true;
    h.render();
    expect(input().props.value).toBe('');
    expect(input().props['aria-activedescendant']).toBe('palette-0');
  });
});
