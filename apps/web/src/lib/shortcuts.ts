import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { MenuAction } from '@pantheon/protocol';
import { getLook } from '../data/layout';
import { t } from '../i18n';

export type ShortcutScope = 'app' | 'projects' | 'list' | 'trace' | 'composer' | 'dialog';

export interface Shortcut {
  id: string;
  /** In aria-keyshortcuts notation; Meta is ⌘ on macOS and Ctrl elsewhere. '' is no keys. */
  keys: string;
  label: string;
  scope: ShortcutScope;
}

export const SCOPE_LABELS: Record<ShortcutScope, string> = {
  get app() {
    return t({ id: 'lib.shortcuts.scope.app', defaultMessage: 'Global' });
  },
  get projects() {
    return t({ id: 'lib.shortcuts.scope.projects', defaultMessage: 'Projects page' });
  },
  get list() {
    return t({ id: 'lib.shortcuts.scope.list', defaultMessage: 'Session list' });
  },
  get trace() {
    return t({ id: 'lib.shortcuts.scope.trace', defaultMessage: 'Trace page' });
  },
  get composer() {
    return t({ id: 'lib.shortcuts.scope.composer', defaultMessage: 'Composer' });
  },
  get dialog() {
    return t({ id: 'lib.shortcuts.scope.dialog', defaultMessage: 'Dialog' });
  },
};

/** Every key the app answers, with its default keys; list, dialog and the composer's sending keys are read by their components. */
export const SHORTCUTS = [
  {
    id: 'palette',
    keys: 'Meta+K',
    get label() {
      return t({ id: 'lib.shortcuts.label.palette', defaultMessage: 'Search' });
    },
    scope: 'app',
  },
  {
    id: 'new',
    keys: 'Meta+N',
    get label() {
      return t({ id: 'lib.shortcuts.label.new', defaultMessage: 'New session / new project' });
    },
    scope: 'app',
  },
  {
    id: 'sidebar',
    keys: 'Meta+B',
    get label() {
      return t({ id: 'lib.shortcuts.label.sidebar', defaultMessage: 'Collapse sidebar' });
    },
    scope: 'app',
  },
  {
    id: 'shortcuts',
    keys: '?',
    get label() {
      return t({ id: 'lib.shortcuts.label.shortcuts', defaultMessage: 'Shortcuts' });
    },
    scope: 'app',
  },
  {
    id: 'back',
    keys: 'Meta+[',
    get label() {
      return t({ id: 'lib.shortcuts.label.back', defaultMessage: 'Back' });
    },
    scope: 'app',
  },
  {
    id: 'forward',
    keys: 'Meta+]',
    get label() {
      return t({ id: 'lib.shortcuts.label.forward', defaultMessage: 'Forward' });
    },
    scope: 'app',
  },
  {
    id: 'details',
    keys: 'Meta+Alt+B',
    get label() {
      return t({ id: 'lib.shortcuts.label.details', defaultMessage: 'Show details' });
    },
    scope: 'app',
  },
  {
    id: 'session-split',
    keys: 'Meta+\\',
    get label() {
      return t({
        id: 'lib.shortcuts.label.sessionSplit',
        defaultMessage: 'Open a session beside / close it',
      });
    },
    scope: 'app',
  },
  {
    id: 'overview',
    keys: 'Meta+I',
    get label() {
      return t({ id: 'lib.shortcuts.label.overview', defaultMessage: 'Show / hide overview' });
    },
    scope: 'app',
  },
  {
    id: 'settings',
    keys: 'Meta+,',
    get label() {
      return t({ id: 'lib.shortcuts.label.settings', defaultMessage: 'Settings' });
    },
    scope: 'app',
  },
  {
    id: 'stop-turn',
    keys: 'Meta+.',
    get label() {
      return t({ id: 'lib.shortcuts.label.stopTurn', defaultMessage: 'Interrupt the turn' });
    },
    scope: 'app',
  },
  {
    id: 'session-pin',
    keys: '',
    get label() {
      return t({ id: 'lib.shortcuts.label.sessionPin', defaultMessage: 'Pin / unpin' });
    },
    scope: 'app',
  },
  {
    id: 'session-unread',
    keys: '',
    get label() {
      return t({
        id: 'lib.shortcuts.label.sessionUnread',
        defaultMessage: 'Mark as unread / read',
      });
    },
    scope: 'app',
  },
  {
    id: 'session-rename',
    keys: 'F2',
    get label() {
      return t({ id: 'lib.shortcuts.label.sessionRename', defaultMessage: 'Rename' });
    },
    scope: 'app',
  },
  {
    id: 'session-number',
    keys: 'Meta+1–9',
    get label() {
      return t({ id: 'lib.shortcuts.label.sessionNumber', defaultMessage: 'Sessions 1–9' });
    },
    scope: 'app',
  },
  {
    id: 'recent-next',
    keys: 'Control+Tab',
    get label() {
      return t({
        id: 'lib.shortcuts.label.recentNext',
        defaultMessage: 'Cycle through recent sessions',
      });
    },
    scope: 'app',
  },
  {
    id: 'recent-back',
    keys: 'Control+Shift+Tab',
    get label() {
      return t({
        id: 'lib.shortcuts.label.recentBack',
        defaultMessage: 'Cycle back through recent sessions',
      });
    },
    scope: 'app',
  },
  {
    id: 'next-attention',
    keys: '',
    get label() {
      return t({
        id: 'lib.shortcuts.label.nextAttention',
        defaultMessage: 'Next session that needs you',
      });
    },
    scope: 'app',
  },
  {
    id: 'transcript',
    keys: '',
    get label() {
      return t({
        id: 'lib.shortcuts.label.transcript',
        defaultMessage: 'Fold / expand transcript',
      });
    },
    scope: 'app',
  },
  {
    id: 'app-dock',
    keys: '',
    get label() {
      return t({ id: 'lib.shortcuts.label.appDock', defaultMessage: 'Dock the latest app' });
    },
    scope: 'app',
  },
  {
    id: 'app-fullscreen',
    keys: '',
    get label() {
      return t({
        id: 'lib.shortcuts.label.appFullscreen',
        defaultMessage: 'Show the latest app full screen',
      });
    },
    scope: 'app',
  },
  {
    id: 'app-reload',
    keys: '',
    get label() {
      return t({ id: 'lib.shortcuts.label.appReload', defaultMessage: 'Reload the latest app' });
    },
    scope: 'app',
  },
  {
    id: 'thread-find',
    keys: 'Meta+F',
    get label() {
      return t({ id: 'lib.shortcuts.label.threadFind', defaultMessage: 'Search in the session' });
    },
    scope: 'app',
  },
  {
    id: 'open-project',
    keys: 'Meta+O',
    get label() {
      return t({ id: 'lib.shortcuts.label.openProject', defaultMessage: 'New project' });
    },
    scope: 'app',
  },
  {
    id: 'list-up',
    keys: 'ArrowUp',
    get label() {
      return t({ id: 'lib.shortcuts.label.listUp', defaultMessage: 'Previous row' });
    },
    scope: 'list',
  },
  {
    id: 'list-down',
    keys: 'ArrowDown',
    get label() {
      return t({ id: 'lib.shortcuts.label.listDown', defaultMessage: 'Next row' });
    },
    scope: 'list',
  },
  {
    id: 'list-next',
    keys: 'J',
    get label() {
      return t({ id: 'lib.shortcuts.label.listDown', defaultMessage: 'Next row' });
    },
    scope: 'list',
  },
  {
    id: 'list-previous',
    keys: 'K',
    get label() {
      return t({ id: 'lib.shortcuts.label.listUp', defaultMessage: 'Previous row' });
    },
    scope: 'list',
  },
  {
    id: 'list-first',
    keys: 'Home',
    get label() {
      return t({ id: 'lib.shortcuts.label.listFirst', defaultMessage: 'First row' });
    },
    scope: 'list',
  },
  {
    id: 'list-last',
    keys: 'End',
    get label() {
      return t({ id: 'lib.shortcuts.label.listLast', defaultMessage: 'Last row' });
    },
    scope: 'list',
  },
  {
    id: 'list-open',
    keys: 'Enter',
    get label() {
      return t({ id: 'lib.shortcuts.label.listOpen', defaultMessage: 'Open session' });
    },
    scope: 'list',
  },
  {
    id: 'list-fold',
    keys: 'ArrowLeft',
    get label() {
      return t({ id: 'lib.shortcuts.label.listFold', defaultMessage: 'Collapse group' });
    },
    scope: 'list',
  },
  {
    id: 'list-unfold',
    keys: 'ArrowRight',
    get label() {
      return t({ id: 'lib.shortcuts.label.listUnfold', defaultMessage: 'Expand group' });
    },
    scope: 'list',
  },
  {
    id: 'list-menu',
    keys: 'Shift+F10',
    get label() {
      return t({ id: 'lib.shortcuts.label.listMenu', defaultMessage: 'Session menu' });
    },
    scope: 'list',
  },
  {
    id: 'list-delete',
    keys: 'Meta+Backspace',
    get label() {
      return t({ id: 'lib.shortcuts.label.listDelete', defaultMessage: 'Delete session…' });
    },
    scope: 'list',
  },
  {
    id: 'session-archive',
    keys: 'E',
    get label() {
      return t({ id: 'lib.shortcuts.label.sessionArchive', defaultMessage: 'Archive session' });
    },
    scope: 'list',
  },
  {
    id: 'list-select',
    keys: 'X',
    get label() {
      return t({ id: 'lib.shortcuts.label.listSelect', defaultMessage: 'Select / deselect' });
    },
    scope: 'list',
  },
  {
    id: 'list-snooze',
    keys: 'H',
    get label() {
      return t({ id: 'lib.shortcuts.label.listSnooze', defaultMessage: 'Snooze / unsnooze' });
    },
    scope: 'list',
  },
  {
    id: 'list-unread',
    keys: 'U',
    get label() {
      return t({
        id: 'lib.shortcuts.label.sessionUnread',
        defaultMessage: 'Mark as unread / read',
      });
    },
    scope: 'list',
  },
  {
    id: 'trace-view',
    keys: 'V',
    get label() {
      return t({ id: 'lib.shortcuts.label.traceView', defaultMessage: 'Switch view' });
    },
    scope: 'trace',
  },
  {
    id: 'trace-all',
    keys: 'A',
    get label() {
      return t({ id: 'lib.shortcuts.label.traceAll', defaultMessage: 'All time' });
    },
    scope: 'trace',
  },
  {
    id: 'trace-next',
    keys: 'J',
    get label() {
      return t({ id: 'lib.shortcuts.label.traceNext', defaultMessage: 'Next row' });
    },
    scope: 'trace',
  },
  {
    id: 'trace-previous',
    keys: 'K',
    get label() {
      return t({ id: 'lib.shortcuts.label.tracePrevious', defaultMessage: 'Previous row' });
    },
    scope: 'trace',
  },
  {
    id: 'replay-back',
    keys: 'ArrowLeft',
    get label() {
      return t({ id: 'lib.shortcuts.label.replayBack', defaultMessage: 'Replay: previous step' });
    },
    scope: 'trace',
  },
  {
    id: 'replay-forward',
    keys: 'ArrowRight',
    get label() {
      return t({ id: 'lib.shortcuts.label.replayForward', defaultMessage: 'Replay: next step' });
    },
    scope: 'trace',
  },
  {
    id: 'replay-play',
    keys: 'Space',
    get label() {
      return t({ id: 'lib.shortcuts.label.replayPlay', defaultMessage: 'Play / pause replay' });
    },
    scope: 'trace',
  },
  {
    id: 'send',
    get keys() {
      return getLook().send_key === 'meta-enter' ? 'Meta+Enter' : 'Enter';
    },
    get label() {
      return t({
        id: 'lib.shortcuts.label.send',
        defaultMessage: 'Send; queue while a turn runs',
      });
    },
    scope: 'composer',
  },
  {
    id: 'newline',
    keys: 'Shift+Enter',
    get label() {
      return t({ id: 'lib.shortcuts.label.newline', defaultMessage: 'New line' });
    },
    scope: 'composer',
  },
  {
    id: 'steer',
    // With ⌘↵ sending, no key steers a running turn.
    get keys() {
      return getLook().send_key === 'meta-enter' ? '' : 'Meta+Enter';
    },
    get label() {
      return t({ id: 'lib.shortcuts.label.steer', defaultMessage: 'Steer while a turn runs' });
    },
    scope: 'composer',
  },
  {
    id: 'steer-now',
    keys: '',
    get label() {
      return t({
        id: 'lib.shortcuts.label.queueSteerNow',
        defaultMessage: 'Steer: Steer now on a queued message',
      });
    },
    scope: 'composer',
  },
  {
    id: 'interrupt',
    keys: 'Escape',
    get label() {
      return t({ id: 'lib.shortcuts.label.interrupt', defaultMessage: 'Interrupt (press twice)' });
    },
    scope: 'composer',
  },
  {
    id: 'permission-mode',
    keys: '',
    get label() {
      return t({
        id: 'lib.shortcuts.label.permissionMode',
        defaultMessage: 'Switch permission mode',
      });
    },
    scope: 'composer',
  },
  {
    id: 'attach',
    keys: 'Meta+U',
    get label() {
      return t({ id: 'lib.shortcuts.label.attach', defaultMessage: 'Attach files' });
    },
    scope: 'composer',
  },
  {
    id: 'model-menu',
    keys: 'Meta+Shift+M',
    get label() {
      return t({ id: 'lib.shortcuts.label.modelMenu', defaultMessage: 'Choose model' });
    },
    scope: 'composer',
  },
  {
    id: 'dialog-next',
    keys: 'Meta+Enter',
    get label() {
      return t({ id: 'lib.shortcuts.label.dialogNext', defaultMessage: 'Next' });
    },
    scope: 'dialog',
  },
] as const satisfies readonly Shortcut[];

export type ShortcutId = (typeof SHORTCUTS)[number]['id'];

const SYMBOLS: Record<string, string> = {
  Control: '⌃',
  Alt: '⌥',
  Shift: '⇧',
  Meta: '⌘',
  Enter: '↵',
  Escape: 'Esc',
  Tab: '⇥',
  Backspace: '⌫',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Home: 'Home',
  End: 'End',
  get Space() {
    return t({ id: 'lib.shortcuts.key.space', defaultMessage: 'Space' });
  },
};
const MODIFIERS = ['Control', 'Alt', 'Shift', 'Meta'];
// Meta is pressed as Ctrl off macOS.
const MODIFIER_WORDS: [string, string][] = [
  ['Control', 'Ctrl'],
  ['Meta', 'Ctrl'],
  ['Alt', 'Alt'],
  ['Shift', 'Shift'],
];

/** The keys as the mac menus write them, modifiers in ⌃⌥⇧⌘ order; elsewhere as Ctrl+Alt+Shift+key. */
export function keyText(keys: string): string {
  const parts = keys.split('+');
  const key = parts.pop()!;
  const name = (part: string) => SYMBOLS[part] ?? part.toUpperCase();
  if (!onMac()) {
    const words = MODIFIER_WORDS.filter(([m]) => parts.includes(m)).map(([, word]) => word);
    return [...words, name(key)].join('+');
  }
  const mods = MODIFIERS.filter((m) => parts.includes(m));
  return [...mods, key].map(name).join('');
}

type KeyEvent = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'> & {
  code?: string;
};

// The one key that stands for any of 1 to 9.
const DIGITS = '1–9';

/** The keys with `digit` in place of the key that stands for any of 1 to 9. */
export const digitKeys = (keys: string, digit: number): string =>
  keys.replace(DIGITS, String(digit));

function keyMatches(key: string, e: KeyEvent): boolean {
  if (key === DIGITS) return /^[1-9]$/.test(e.key) || /^Digit[1-9]$/.test(e.code ?? '');
  if (key === 'Space') return e.key === ' ';
  // Alt changes the typed letter on macOS, so its letter keys are read from the key's place.
  return (
    e.key.toLowerCase() === key.toLowerCase() || (e.altKey && e.code === `Key${key.toUpperCase()}`)
  );
}

export const onMac = () => /Mac|iPhone|iPad/.test(globalThis.navigator?.userAgent ?? '');

// A symbol's character already says whether Shift was down (? is ⇧/), so its keys leave Shift out.
const symbol = (key: string) => key.length === 1 && !/[\p{L}\p{N} ]/u.test(key);

function matches(keys: string, e: KeyEvent): boolean {
  if (keys === '') return false;
  const parts = keys.split('+');
  const key = parts.pop()!;
  const meta = parts.includes('Meta');
  const control = parts.includes('Control');
  return (
    (onMac()
      ? e.metaKey === meta && e.ctrlKey === control
      : !e.metaKey && e.ctrlKey === (meta || control)) &&
    (e.shiftKey === parts.includes('Shift') || symbol(key)) &&
    e.altKey === parts.includes('Alt') &&
    keyMatches(key, e)
  );
}

/** The keys an event presses in aria-keyshortcuts notation; null while only modifiers are down. */
export function pressedKeys(e: KeyEvent): string | null {
  if (MODIFIERS.includes(e.key)) return null;
  const mac = onMac();
  const code = e.code ?? '';
  const key =
    e.altKey && /^Key[A-Z]$/.test(code)
      ? code.slice(3)
      : e.key === ' '
        ? 'Space'
        : e.key.length === 1 && e.key.toUpperCase().length === 1
          ? e.key.toUpperCase()
          : e.key;
  const mods = [
    mac && e.ctrlKey && 'Control',
    (mac ? e.metaKey : e.ctrlKey) && 'Meta',
    e.altKey && 'Alt',
    e.shiftKey && !symbol(key) && 'Shift',
  ].filter((m) => m !== false);
  return [...mods, key].join('+');
}

const keysOf = (keys: string) => {
  const parts = keys.split('+');
  const key = parts.pop()!.toUpperCase();
  // Off macOS, Meta and Control are both Ctrl.
  const held = (onMac() ? parts : parts.map((part) => (part === 'Control' ? 'Meta' : part))).filter(
    (part) => part !== 'Shift' || !symbol(key),
  );
  return { mods: MODIFIERS.filter((m) => held.includes(m)).join('+'), key };
};

/** Whether two keys in aria-keyshortcuts notation are the same press; 1–9 covers each digit, no keys none. */
export function sameKeys(a: string, b: string): boolean {
  if (a === '' || b === '') return false;
  const x = keysOf(a);
  const y = keysOf(b);
  const digit = (range: string, key: string) => range === DIGITS && /^[1-9]$/.test(key);
  return x.mods === y.mods && (x.key === y.key || digit(x.key, y.key) || digit(y.key, x.key));
}

export const SHORTCUTS_KEY = 'pantheon.shortcuts.v1';

export type ShortcutOverrides = Partial<Record<ShortcutId, string>>;

// The composer and dialogs read these keys themselves, and 1–9 stands for nine keys.
const FIXED: readonly ShortcutId[] = [
  'session-number',
  'send',
  'newline',
  'steer',
  'interrupt',
  'dialog-next',
];

/** Whether the user may record other keys for the entry. */
export const rebindable = (id: ShortcutId): boolean => !FIXED.includes(id);

const KEYS_NOTATION = /^(?:(?:Control|Meta|Alt|Shift)\+)*[^+]+$/;

// The keys the desktop menu's accelerators can name.
const ACCELERATOR_KEY =
  /^(?:Arrow(?:Up|Down|Left|Right)|Enter|Escape|Tab|Backspace|Delete|Home|End|PageUp|PageDown|F(?:[1-9]|1[0-9]|2[0-4])|[!-~])$/;

/** The stored overrides; unknown ids, fixed entries and keys not in aria notation are dropped. */
export function readShortcutOverrides(raw: string | null): ShortcutOverrides {
  let value: unknown;
  try {
    value = JSON.parse(raw ?? 'null');
  } catch {
    return {};
  }
  const overrides: ShortcutOverrides = {};
  if (!value || typeof value !== 'object') return overrides;
  for (const { id } of SHORTCUTS) {
    const keys = (value as Record<string, unknown>)[id];
    if (rebindable(id) && typeof keys === 'string' && KEYS_NOTATION.test(keys))
      overrides[id] = keys;
  }
  return overrides;
}

function loadOverrides(): ShortcutOverrides {
  try {
    return readShortcutOverrides(localStorage.getItem(SHORTCUTS_KEY));
  } catch {
    return {};
  }
}

let overrides = loadOverrides();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
export const getOverrides = () => overrides;

/** The keys the user recorded, by entry; an entry without one keeps its default. */
export function useShortcutOverrides(): ShortcutOverrides {
  return useSyncExternalStore(subscribe, getOverrides, getOverrides);
}

const entry = (id: ShortcutId) => SHORTCUTS.find((s) => s.id === id)!;

/** The entry's keys in aria-keyshortcuts notation: the user's, else the default. */
export const shortcutKeys = (id: ShortcutId): string => overrides[id] ?? entry(id).keys;

/** Whether the event presses the entry's keys; for the entries a component answers itself. */
export const shortcutMatches = (id: ShortcutId, e: KeyEvent): boolean =>
  matches(shortcutKeys(id), e);

/**
 * The desktop app's menu owns these keys and sends them as menu actions instead.
 * The shortcut sheet's ? has no modifier, so no menu accelerator can hold it and the page keeps it.
 */
export const MENU_SHORTCUTS: readonly ShortcutId[] = [
  'new',
  'open-project',
  'settings',
  'palette',
  'sidebar',
  'details',
  'overview',
  'back',
  'forward',
];

const MENU_ACTIONS: Partial<Record<ShortcutId, MenuAction>> = {
  new: 'new-session',
  'open-project': 'open-project',
  settings: 'settings',
  palette: 'search',
  sidebar: 'toggle-sidebar',
  details: 'toggle-details',
  overview: 'toggle-overview',
  back: 'back',
  forward: 'forward',
};

/** Whether the entry can keep the keys: stored keys write no + key, and a menu item needs ⌘, ⌃ or ⌥ and a key it names. */
export function recordable(id: ShortcutId, keys: string): boolean {
  if (!KEYS_NOTATION.test(keys)) return false;
  if (!MENU_SHORTCUTS.includes(id)) return true;
  const parts = keys.split('+');
  return ACCELERATOR_KEY.test(parts.pop()!) && parts.some((part) => part !== 'Shift');
}

// Whether the desktop menu took the keys last sent; while it refuses them the page answers them.
let menuHolds = true;
const getMenuHolds = () => menuHolds;

async function sendMenuShortcuts() {
  const keys = Object.fromEntries(MENU_SHORTCUTS.map((id) => [MENU_ACTIONS[id], shortcutKeys(id)]));
  const sent = await globalThis.window?.pantheon?.setMenuShortcuts(keys);
  if (!sent || sent.ok === menuHolds) return;
  menuHolds = sent.ok;
  listeners.forEach((listener) => listener());
}

// The desktop menu starts with the default keys.
void sendMenuShortcuts();

function saveOverrides(next: ShortcutOverrides) {
  const menu = MENU_SHORTCUTS.some((id) => next[id] !== overrides[id]);
  overrides = next;
  listeners.forEach((listener) => listener());
  try {
    if (Object.keys(next).length > 0) localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(next));
    else localStorage.removeItem(SHORTCUTS_KEY);
  } catch {
    // The keys still apply for this session.
  }
  if (menu) void sendMenuShortcuts();
}

// Another window recorded keys: this one follows them.
if (typeof window !== 'undefined')
  window.addEventListener('storage', (e) => {
    if (e.key !== SHORTCUTS_KEY) return;
    overrides = readShortcutOverrides(e.newValue);
    listeners.forEach((listener) => listener());
  });

// Global entries answer in every other scope too.
const inReach = (a: ShortcutScope, b: ShortcutScope) => a === b || a === 'app' || b === 'app';

/** The other entry that answers keys wherever id answers them, if any. */
export function shortcutConflict(id: ShortcutId, keys: string): ShortcutId | null {
  const scope = entry(id).scope;
  const holder = SHORTCUTS.find(
    (s) => s.id !== id && inReach(s.scope, scope) && sameKeys(shortcutKeys(s.id), keys),
  );
  return holder?.id ?? null;
}

/** Gives id the keys unless another entry in reach answers them; returns that entry. */
export function setShortcut(id: ShortcutId, keys: string): ShortcutId | null {
  const holder = shortcutConflict(id, keys);
  if (holder) return holder;
  const next = { ...overrides, [id]: keys };
  if (keys === entry(id).keys) delete next[id];
  saveOverrides(next);
  return null;
}

export const resetShortcuts = () => saveOverrides({});

/** Replaces every recorded key at once, as an import does. */
export const setShortcutOverrides = (next: ShortcutOverrides) => saveOverrides(next);

// The transcript's keys also apply inside a text field, over the field's own use of them.
const TAKEN_FROM_TEXT_FIELDS: readonly ShortcutId[] = ['transcript'];

const inTextField = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
};

// The longest wait between two keys of one sequence.
const SEQUENCE_MS = 1000;

const bound = new Map<ShortcutId, Set<{ current: (e?: KeyboardEvent) => void }>>();
// The presses a shortcut answered; a press another control prevented is that control's.
const answered = new WeakSet<KeyboardEvent>();

/** Runs the handlers bound to id as its keys would; false when none is bound. */
export function runShortcut(id: ShortcutId): boolean {
  const runs = [...(bound.get(id) ?? [])];
  for (const run of runs) run.current();
  return runs.length > 0;
}

/** Runs `run` on the entry's keys anywhere in the window while `enabled`. */
export function useShortcut(id: ShortcutId, run: (e?: KeyboardEvent) => void, enabled = true) {
  const latest = useRef(run);
  latest.current = run;
  const read = () => shortcutKeys(id);
  const keys = useSyncExternalStore(subscribe, read, read);
  const menuHeld = useSyncExternalStore(subscribe, getMenuHolds, getMenuHolds);
  useEffect(() => {
    if (!enabled) return;
    const handlers = bound.get(id) ?? new Set();
    bound.set(id, handlers);
    handlers.add(latest);
    // Keys without Meta are text editing keys in a text field.
    const yields = !keys.split('+').includes('Meta') && !TAKEN_FROM_TEXT_FIELDS.includes(id);
    // Keys with a space between them, such as G B, are pressed one after the other.
    const steps = keys.split(' ');
    let step = 0;
    let pressedAt = 0;
    const onKey = (e: KeyboardEvent) => {
      if (yields && inTextField(e.target)) return;
      if (e.defaultPrevented && !answered.has(e)) return;
      if (Date.now() - pressedAt > SEQUENCE_MS) step = 0;
      pressedAt = Date.now();
      step = matches(steps[step]!, e) ? step + 1 : matches(steps[0]!, e) ? 1 : 0;
      if (step < steps.length) return;
      step = 0;
      e.preventDefault();
      answered.add(e);
      latest.current(e);
    };
    const listens = keys !== '' && !(window.pantheon && menuHeld && MENU_SHORTCUTS.includes(id));
    if (listens) window.addEventListener('keydown', onKey);
    return () => {
      handlers.delete(latest);
      if (listens) window.removeEventListener('keydown', onKey);
    };
  }, [id, enabled, keys, menuHeld]);
}
