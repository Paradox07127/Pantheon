import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { HookHost, find, mount, nodes, text, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
import { ShortcutList, ShortcutSettings, ShortcutSheet } from '@/components/Shortcuts';
import {
  keyText,
  readShortcutOverrides,
  resetShortcuts,
  setShortcut,
  shortcutKeys,
  SHORTCUTS,
  SHORTCUTS_KEY,
  useShortcut,
} from '@/lib/shortcuts';

type Listener = (e: KeyboardEvent) => void;

let stored: Map<string, string>;
let listeners: Listener[];
let setMenuShortcuts: ReturnType<typeof vi.fn>;

beforeEach(() => {
  stored = new Map();
  listeners = [];
  setMenuShortcuts = vi.fn(async () => ({ ok: true, value: null }));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: Listener) => type === 'keydown' && listeners.push(fn),
    removeEventListener: (type: string, fn: Listener) => {
      if (type === 'keydown') listeners = listeners.filter((l) => l !== fn);
    },
    pantheon: { setMenuShortcuts },
  });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
});
afterEach(() => {
  page = null;
  // Leaving the page ends a recording and clears the search.
  unmountAll();
  resetShortcuts();
  vi.unstubAllGlobals();
});

const keyEvent = (key: string, mods: Partial<KeyboardEvent> = {}) =>
  ({
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...mods,
  }) as unknown as KeyboardEvent;

const press = (key: string, mods: Partial<KeyboardEvent> = {}) => {
  const e = keyEvent(key, mods);
  for (const listener of [...listeners]) listener(e);
  return e.preventDefault as ReturnType<typeof vi.fn>;
};

/** The default keys of the desktop menu's items, by menu action. */
const MENU_KEYS = {
  'new-session': 'Meta+N',
  'open-project': 'Meta+O',
  settings: 'Meta+,',
  search: 'Meta+K',
  'toggle-sidebar': 'Meta+B',
  'toggle-details': 'Meta+Alt+B',
  'toggle-overview': 'Meta+I',
  back: 'Meta+[',
  forward: 'Meta+]',
};

const label = (id: string) => SHORTCUTS.find((s) => s.id === id)!.label;
let page: HookHost<ReactNode> | null = null;
const editor = () => {
  page ??= mount(() => ShortcutSettings() as ReactNode);
  return page.render();
};
const rows = (tree: ReactNode) => nodes(tree).filter((n) => n.props.className === 'kset-row');
const sheetRows = (tree: ReactNode) => nodes(tree).filter((n) => n.type === 'tr');
const rowOf = (tree: ReactNode, id: string) =>
  [...rows(tree), ...sheetRows(tree)].find((r) => text(r).includes(label(id)))!;
const kbd = (row: ReactElement) => text(find(row, (n) => n.props.className === 'kbd'));
const recordButton = (row: ReactElement) => find(row, (n) => n.props['aria-pressed'] !== undefined);

describe('rebinding shortcuts', () => {
  it('moves the command palette from ⌘K to ⌘P without a restart and keeps it', () => {
    // In the desktop app the menu answers the palette's keys; a browser page answers them itself.
    (window as { pantheon?: unknown }).pantheon = undefined;
    const run = vi.fn();
    const h = mount(() => useShortcut('palette', run));
    expect(setShortcut('palette', 'Meta+P')).toBeNull();
    h.render();
    expect(press('k', { metaKey: true })).not.toHaveBeenCalled();
    expect(press('p', { metaKey: true })).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(shortcutKeys('palette')).toBe('Meta+P');
    expect(readShortcutOverrides(stored.get(SHORTCUTS_KEY)!)).toEqual({ palette: 'Meta+P' });
  });

  it('refuses keys another entry in reach answers, and names that entry on the row', () => {
    expect(setShortcut('palette', 'Meta+B')).toBe('sidebar');
    expect(setShortcut('list-up', 'Meta+B')).toBe('sidebar');
    expect(shortcutKeys('palette')).toBe('Meta+K');
    expect(stored.has(SHORTCUTS_KEY)).toBe(false);
    // The list and a dialog are never in reach at once.
    expect(setShortcut('list-open', 'Meta+Enter')).toBeNull();

    recordButton(rowOf(editor(), 'palette')).props.onClick();
    recordButton(rowOf(editor(), 'palette')).props.onKeyDown(keyEvent('b', { metaKey: true }));
    const row = rowOf(editor(), 'palette');
    expect(kbd(row)).toBe(keyText('Meta+K'));
    expect(text(find(row, (n) => n.props.role === 'alert'))).toContain(label('sidebar'));
    expect(text(find(row, (n) => n.props.role === 'alert'))).toContain(keyText('Meta+B'));
  });

  it('records the keys pressed on the row, and Esc cancels the recording', () => {
    recordButton(rowOf(editor(), 'palette')).props.onClick();
    expect(recordButton(rowOf(editor(), 'palette')).props['aria-pressed']).toBe(true);
    recordButton(rowOf(editor(), 'palette')).props.onKeyDown(keyEvent('Escape'));
    expect(recordButton(rowOf(editor(), 'palette')).props['aria-pressed']).toBe(false);
    expect(shortcutKeys('palette')).toBe('Meta+K');

    recordButton(rowOf(editor(), 'palette')).props.onClick();
    recordButton(rowOf(editor(), 'palette')).props.onKeyDown(keyEvent('Meta', { metaKey: true }));
    // A global entry takes no keys without ⌘, ⌃ or ⌥.
    recordButton(rowOf(editor(), 'palette')).props.onKeyDown(keyEvent('p'));
    expect(shortcutKeys('palette')).toBe('Meta+K');
    const e = keyEvent('p', { metaKey: true });
    recordButton(rowOf(editor(), 'palette')).props.onKeyDown(e);
    expect(e.stopPropagation).toHaveBeenCalled();
    expect(shortcutKeys('palette')).toBe('Meta+P');
    expect(kbd(rowOf(editor(), 'palette'))).toBe(keyText('Meta+P'));
  });

  it('finds entries by name or by the keys pressed', () => {
    const input = () => find(editor(), (n) => n.type === 'input');
    input().props.onChange({ target: { value: label('sidebar') } });
    expect(rows(editor()).map(text)).toEqual([label('sidebar') + keyText('Meta+B')]);

    find(editor(), (n) => n.props['aria-pressed'] === false && n.type === 'button').props.onClick();
    input().props.onKeyDown(keyEvent('k', { metaKey: true }));
    expect(rows(editor()).map(text)).toEqual([label('palette') + keyText('Meta+K')]);
  });

  it('shows the keys in use in the shortcut sheet', () => {
    setShortcut('palette', 'Meta+P');
    const sheet = ShortcutSheet({ open: true, onOpenChange: () => {} });
    const list = find(sheet, (n) => n.type === ShortcutList);
    const shown = (list.type as (props: unknown) => ReactNode)(list.props);
    expect(text(rowOf(shown, 'palette'))).toBe(keyText('Meta+P') + label('palette'));
  });

  it('tells the desktop menu the keys of the entries it owns', () => {
    expect(setShortcut('new', 'Meta+Shift+N')).toBeNull();
    expect(setMenuShortcuts).toHaveBeenLastCalledWith({
      ...MENU_KEYS,
      'new-session': 'Meta+Shift+N',
    });
    expect(setShortcut('palette', 'Meta+P')).toBeNull();
    expect(setMenuShortcuts).toHaveBeenLastCalledWith({
      ...MENU_KEYS,
      'new-session': 'Meta+Shift+N',
      search: 'Meta+P',
    });
    setShortcut('session-split', 'Meta+Shift+\\');
    expect(setMenuShortcuts).toHaveBeenCalledTimes(2);
  });

  it('leaves the keys the desktop menu owns to the menu', () => {
    const run = vi.fn();
    mount(() => useShortcut('back', run));
    expect(press('[', { metaKey: true })).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('reads back only known, rebindable entries with keys in aria notation', () => {
    expect(readShortcutOverrides('{bad')).toEqual({});
    expect(
      readShortcutOverrides(
        JSON.stringify({
          palette: 'Meta+P',
          nothing: 'Meta+Q',
          send: 'Meta+Enter',
          sidebar: 42,
          back: 'Meta+',
        }),
      ),
    ).toEqual({ palette: 'Meta+P' });
  });
});

describe('keys a recording cannot keep', () => {
  const recordOn = (id: string, e: KeyboardEvent) => {
    recordButton(rowOf(editor(), id)).props.onClick();
    recordButton(rowOf(editor(), id)).props.onKeyDown(e);
  };

  it('takes no keys for a menu entry that the desktop menu cannot hold', () => {
    recordOn('palette', keyEvent(' ', { metaKey: true }));
    expect(shortcutKeys('palette')).toBe('Meta+K');
    expect(recordButton(rowOf(editor(), 'palette')).props['aria-pressed']).toBe(true);
    expect(setMenuShortcuts).not.toHaveBeenCalled();
  });

  it('takes no letter outside ASCII for a menu entry, which no accelerator can name', () => {
    recordOn('palette', keyEvent('ö', { metaKey: true }));
    expect(shortcutKeys('palette')).toBe('Meta+K');
    expect(setMenuShortcuts).not.toHaveBeenCalled();
  });

  it('answers the menu entries on keydown while the desktop menu refuses their keys', async () => {
    setMenuShortcuts.mockResolvedValue({
      ok: false,
      error: { code: 'invalid_input', message: '' },
    });
    const run = vi.fn();
    const h = mount(() => useShortcut('palette', run));
    expect(setShortcut('palette', 'Meta+P')).toBeNull();
    await h.flush();
    h.render();
    expect(press('p', { metaKey: true })).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);

    setMenuShortcuts.mockResolvedValue({ ok: true, value: null });
    resetShortcuts();
    await h.flush();
    h.render();
    expect(press('k', { metaKey: true })).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('takes no plus key, which the stored keys cannot write', () => {
    recordOn('list-select', keyEvent('+', { shiftKey: true }));
    expect(shortcutKeys('list-select')).toBe('X');
    expect(stored.has(SHORTCUTS_KEY)).toBe(false);
  });

  it('keeps a letter whose capital is two letters, and answers it', () => {
    recordOn('list-select', keyEvent('ß'));
    expect(shortcutKeys('list-select')).toBe('ß');
    const run = vi.fn();
    mount(() => useShortcut('list-select', run));
    press('ß');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('leaves a key that a control already took', () => {
    const run = vi.fn();
    mount(() => useShortcut('trace-next', run));
    press('j', { defaultPrevented: true });
    expect(run).not.toHaveBeenCalled();
    press('j');
    expect(run).toHaveBeenCalledTimes(1);
  });
});

it('sends the saved menu keys once when the page loads', async () => {
  stored.set(SHORTCUTS_KEY, JSON.stringify({ settings: 'Meta+;' }));
  vi.resetModules();
  await import('@/lib/shortcuts');
  expect(setMenuShortcuts).toHaveBeenCalledTimes(1);
  expect(setMenuShortcuts).toHaveBeenCalledWith({ ...MENU_KEYS, settings: 'Meta+;' });
});
