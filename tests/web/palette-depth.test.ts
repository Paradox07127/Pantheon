import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { find, mount, named, nodes, text } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'palette' }),
);
import { settingsPaletteItems } from '@/App';
import { CommandPalette } from '@/components/CommandPalette';
import { paletteSections, type PaletteItem } from '@/components/palette';
import { DEFAULT_LOOK } from '@/data/layout';
import { SETTINGS_PAGES } from '@/screens/settings/view';

const item = (id: string, group: PaletteItem['group'], label = id): PaletteItem => ({
  id,
  group,
  label,
  run: () => {},
});
const ids = (items: PaletteItem[]) => items.map((i) => i.id);

afterEach(() => vi.unstubAllGlobals());

describe('palette ranking', () => {
  it('ranks a prefix over a word start over a substring over a subsequence', () => {
    const items = [
      item('subsequence', 'session', 'Grant a tea'),
      item('substring', 'session', 'Tailgate'),
      item('none', 'session', 'Other'),
      item('word', 'action', 'Open gate'),
      item('prefix', 'screen', 'Gate keeper'),
    ];
    expect(ids(paletteSections(items, 'gate').flatMap((s) => s.items))).toEqual([
      'prefix',
      'word',
      'substring',
      'subsequence',
    ]);
  });

  it('puts the recently opened sessions first on an empty query, newest first', () => {
    const items = [
      item('session-a', 'session'),
      item('screen-a', 'screen'),
      item('session-b', 'session'),
      item('action-a', 'action'),
      item('session-c', 'session'),
    ];
    expect(
      ids(
        paletteSections(items, '', ['session-c', 'session-a', 'session-gone']).flatMap(
          (s) => s.items,
        ),
      ),
    ).toEqual(['session-c', 'session-a', 'session-b', 'action-a', 'screen-a']);
  });
});

describe('palette settings items', () => {
  it('finds both density choices by 密度', () => {
    const found = ids(
      paletteSections(settingsPaletteItems(DEFAULT_LOOK), '密度').flatMap((s) => s.items),
    );
    expect(found).toContain('density-standard');
    expect(found).toContain('density-compact');
  });

  it("opens every settings page except the parts of a project's page", () => {
    const pages = ids(settingsPaletteItems(DEFAULT_LOOK)).filter((id) =>
      id.startsWith('settings-'),
    );
    expect(pages).toEqual(
      SETTINGS_PAGES.filter((p) => p.group !== 'project').map((p) => `settings-${p.key}`),
    );
  });

  it('holds each appearance switch', () => {
    const shown = ids(settingsPaletteItems(DEFAULT_LOOK));
    for (const id of [
      'theme-light',
      'theme-dark',
      'theme-system',
      'density-standard',
      'density-compact',
      'chat-font-small',
      'chat-font-standard',
      'chat-font-large',
      'transcript',
      'colorblind',
      'code-font-12',
      'code-font-13',
      'code-font-14',
      'motion',
    ])
      expect(shown).toContain(id);
  });
});

describe('palette rows', () => {
  it('shows an item’s shortcut keys on its right', () => {
    vi.stubGlobal('document', { getElementById: () => null });
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
    const items: PaletteItem[] = [{ ...item('transcript', 'action'), keys: 'Control+O' }];
    const h = mount(() => {
      const body = named(CommandPalette({ open: true, onOpenChange() {}, items }), 'PaletteBody');
      return (body.type as (props: unknown) => ReactNode)(body.props);
    });
    const row = find(h.value, (n) => n.props.role === 'option');
    expect(row.props['aria-keyshortcuts']).toBe('Control+O');
    expect(text(nodes(row).find((n) => n.props.className === 'kbd')!)).toBe('⌃O');
  });
});
