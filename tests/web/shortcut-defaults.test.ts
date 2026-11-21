import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
import {
  keyText,
  pressedKeys,
  sameKeys,
  shortcutMatches,
  SHORTCUTS,
  useShortcut,
} from '@/lib/shortcuts';

// Only frequent actions and the keys the design names get default keys; any other entry starts with none.
const DEFAULTED = [
  'palette',
  'new',
  'sidebar',
  'shortcuts',
  'back',
  'forward',
  'details',
  'session-split',
  'overview',
  'settings',
  'stop-turn',
  'session-rename',
  'session-number',
  'recent-next',
  'recent-back',
  'thread-find',
  'open-project',
  'list-up',
  'list-down',
  'list-next',
  'list-previous',
  'list-first',
  'list-last',
  'list-open',
  'list-fold',
  'list-unfold',
  'list-menu',
  'list-delete',
  'session-archive',
  'list-select',
  'list-snooze',
  'list-unread',
  'trace-view',
  'trace-all',
  'trace-next',
  'trace-previous',
  'replay-back',
  'replay-forward',
  'replay-play',
  'send',
  'newline',
  'steer',
  'interrupt',
  'attach',
  'model-menu',
  'dialog-next',
];

it('gives default keys only to the frequent actions', () => {
  expect(SHORTCUTS.filter((s) => s.keys !== '').map((s) => s.id)).toEqual(DEFAULTED);
});

type Listener = (e: KeyboardEvent) => void;
let listeners: Listener[] = [];
beforeEach(() => {
  listeners = [];
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: Listener) => type === 'keydown' && listeners.push(fn),
    removeEventListener: (type: string, fn: Listener) => {
      if (type === 'keydown') listeners = listeners.filter((l) => l !== fn);
    },
  });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const press = (key: string, mods: Partial<KeyboardEvent> = {}) => {
  const e = {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target: { tagName: 'BODY', isContentEditable: false },
    preventDefault: vi.fn(),
    ...mods,
  } as unknown as KeyboardEvent;
  for (const listener of [...listeners]) listener(e);
};

it('opens the shortcut table on ?, written without Shift, and leaves ? to typing in a field', () => {
  const run = vi.fn();
  mount(() => useShortcut('shortcuts', run));
  expect(keyText(SHORTCUTS.find((s) => s.id === 'shortcuts')!.keys)).toBe('?');
  for (const tagName of ['INPUT', 'TEXTAREA'])
    press('?', { shiftKey: true, target: { tagName, isContentEditable: false } as any });
  press('?', { shiftKey: true, target: { tagName: 'DIV', isContentEditable: true } as any });
  press('/', { metaKey: true });
  expect(run).not.toHaveBeenCalled();
  press('?', { shiftKey: true });
  expect(run).toHaveBeenCalledTimes(1);
});

it('records a symbol as the character typed, without the Shift that typed it', () => {
  const e = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: true };
  expect(pressedKeys({ ...e, key: '?' })).toBe('?');
  expect(pressedKeys({ ...e, key: 'A' })).toBe('Shift+A');
  expect(sameKeys('Shift+?', '?')).toBe(true);
  expect(sameKeys('Shift+A', 'A')).toBe(false);
});

it('steps the replay on the arrows and plays it on Space, written and recorded as Space', () => {
  const keysOf = (id: string) => SHORTCUTS.find((s) => s.id === id)!.keys;
  expect(['replay-back', 'replay-forward', 'replay-play'].map(keysOf)).toEqual([
    'ArrowLeft',
    'ArrowRight',
    'Space',
  ]);
  expect(keyText('Space')).toBe('空格');
  const e = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: ' ' };
  expect(pressedKeys(e)).toBe('Space');
  expect(shortcutMatches('replay-play', e)).toBe(true);
  expect(shortcutMatches('replay-play', { ...e, key: 's' })).toBe(false);
});
