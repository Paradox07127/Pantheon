import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { HookHost, find, mount, nodes, text, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
import { ShortcutSettings } from '@/components/Shortcuts';
import { setLook } from '@/data/layout';
import { keyText, resetShortcuts, setShortcut, shortcutKeys, SHORTCUTS } from '@/lib/shortcuts';
import { t } from '@/i18n';
import { zh } from './i18n-setup.js';

beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
  vi.stubGlobal('window', {
    addEventListener: () => {},
    removeEventListener: () => {},
    pantheon: { setMenuShortcuts: async () => ({ ok: true, value: null }) },
  });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
});
afterEach(() => {
  // Unmounting the page ends a recording and clears the search.
  unmountAll();
  resetShortcuts();
  setLook({ send_key: 'enter' });
  vi.unstubAllGlobals();
});

const page = () => mount(() => ShortcutSettings());

const label = (id: string) => SHORTCUTS.find((s) => s.id === id)!.label;
const rows = (h: HookHost<any>) => {
  h.render();
  return nodes(h.value).filter((n) => n.props.className === 'kset-row');
};
const rowOf = (h: HookHost<any>, id: string) =>
  rows(h).find((r) => text(r.props.children[0]) === label(id))!;
const keycap = (row: ReactElement<any>) => find(row, (n) => n.type === 'button');
const buttons = (row: ReactElement<any>) => nodes(row).filter((n) => n.type === 'button');
const alertOf = (row: ReactElement<any>) => nodes(row).find((n) => n.props.role === 'alert');

describe('the shortcuts settings page', () => {
  it('keeps the search field and the search by keys switch on a row of their own above the groups', () => {
    const h = page();
    const search = find(h.value, (n) => n.props.className === 'kset-srch');
    expect(nodes(search).some((n) => n.type === 'input')).toBe(true);
    expect(nodes(search).some((n) => n.props['aria-pressed'] === false)).toBe(true);
    expect(h.value.props['data-setting-id']).toBe('shortcuts.keys');

    find(search, (n) => n.type === 'input').props.onChange({ target: { value: label('sidebar') } });
    expect(rows(h).map((r) => text(r.props.children[0]))).toEqual([label('sidebar')]);
  });

  it('shows each scope as a caption over a group of rows: name, keycap', () => {
    const h = page();
    const groups = nodes(h.value).filter((n) => n.props.role === 'group');
    expect(groups).toHaveLength(new Set(SHORTCUTS.map((s) => s.scope)).size);
    expect(groups.every((g) => g.props.className === 'kset-grp')).toBe(true);
    expect(nodes(h.value).filter((n) => n.props.className === 'cap').length).toBe(groups.length);
    expect(rows(h)).toHaveLength(SHORTCUTS.length);
    const row = rowOf(h, 'palette');
    expect(row.props.children.filter(Boolean)).toHaveLength(2);
    expect(text(row.props.children[1])).toBe(keyText('Meta+K'));
  });

  it('records keys from a click on the keycap, which reads Press keys meanwhile', () => {
    const h = page();
    keycap(rowOf(h, 'palette')).props.onClick();
    const row = rowOf(h, 'palette');
    expect(row.props['data-recording']).toBe(true);
    expect(keycap(row).props['aria-pressed']).toBe(true);
    expect(text(keycap(row))).toBe(zh('components.shortcuts.pressKeys'));
    keycap(row).props.onKeyDown({
      key: 'p',
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault() {},
      stopPropagation() {},
    });
    expect(shortcutKeys('palette')).toBe('Meta+P');
    expect(text(keycap(rowOf(h, 'palette')))).toBe(keyText('Meta+P'));
    expect(rowOf(h, 'palette').props['data-recording']).toBeUndefined();
  });

  it('offers an empty keycap to record keys for an entry that has none', () => {
    const h = page();
    const cap = find(keycap(rowOf(h, 'session-pin')), (n) => n.props.className === 'kbd kset-none');
    expect(text(cap)).toBe(zh('components.shortcuts.record'));
  });

  it('offers no reset on an entry whose keys changed', () => {
    const h = page();
    setShortcut('thread-find', 'Meta+Shift+F');
    expect(buttons(rowOf(h, 'thread-find'))).toHaveLength(1);
  });

  it('names the entry holding refused keys on a line across the whole row', () => {
    const h = page();
    keycap(rowOf(h, 'details')).props.onClick();
    keycap(rowOf(h, 'details')).props.onKeyDown({
      key: 'b',
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault() {},
      stopPropagation() {},
    });
    const alert = alertOf(rowOf(h, 'details'))!;
    expect(alert.props.className).toBe('kset-err');
    expect(text(alert)).toBe(
      t(
        { id: 'components.shortcuts.taken', defaultMessage: '{keys} is taken by {name}' },
        { keys: keyText('Meta+B'), name: label('sidebar') },
      ),
    );
  });

  it('lists steering while a turn runs apart from steering a queued message', () => {
    const h = page();
    const steer = rowOf(h, 'steer');
    expect(text(steer.props.children[0])).toBe(zh('lib.shortcuts.label.steer'));
    expect(steer.props.children[1].type).toBe('span');
    expect(text(steer.props.children[1])).toBe(keyText('Meta+Enter'));
    expect(text(rowOf(h, 'steer-now').props.children[0])).toBe(
      zh('lib.shortcuts.label.queueSteerNow'),
    );
    // With ⌘↵ sending, no key steers a running turn.
    setLook({ send_key: 'meta-enter' });
    expect(shortcutKeys('steer')).toBe('');
  });
});
