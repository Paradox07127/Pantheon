import { useSyncExternalStore } from 'react';
import {
  getOverrides,
  readShortcutOverrides,
  setShortcutOverrides,
  SHORTCUTS,
  type ShortcutOverrides,
} from '../lib/shortcuts';
import { getDiffPrefs, readDiffPrefs, setDiffPrefs, type DiffPrefs } from './diff-prefs';
import {
  getAppearance,
  getLook,
  readAppearance,
  readLook,
  setAppearance,
  setLook,
  type Appearance,
  type Look,
} from './layout';
import {
  getNotificationPrefs,
  readNotificationPrefs,
  setNotificationPrefs,
  type NotificationPrefs,
} from './notifications';
import {
  getSessionDisplay,
  readSessionDisplay,
  setSessionDisplay,
  type SessionDisplay,
} from './session-display';

/** The settings that belong to the user rather than a project, as one export file holds them. */
export interface PersonalSettings {
  version: 1;
  appearance: Appearance;
  look: Look;
  notifications: NotificationPrefs;
  shortcuts: ShortcutOverrides;
  diff: DiffPrefs;
  session_display: SessionDisplay;
}

export function personalSettings(): PersonalSettings {
  return {
    version: 1,
    appearance: getAppearance(),
    look: getLook(),
    notifications: getNotificationPrefs(),
    shortcuts: getOverrides(),
    diff: getDiffPrefs(),
    session_display: getSessionDisplay(),
  };
}

export const exportPersonalSettings = (): string => JSON.stringify(personalSettings(), null, 2);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Every field the file gives must survive the store's reader; fields the reader does not know are dropped.
function kept(given: unknown, read: unknown): boolean {
  if (!isRecord(read)) return Object.is(given, read);
  if (!isRecord(given)) return false;
  return Object.entries(read).every(([key, value]) => !(key in given) || kept(given[key], value));
}

function section<T>(given: unknown, reader: (raw: string) => T): T | null {
  if (!isRecord(given)) return null;
  const read = reader(JSON.stringify(given));
  return kept(given, read) ? read : null;
}

function shortcutsSection(given: unknown): ShortcutOverrides | null {
  if (!isRecord(given)) return null;
  const read = readShortcutOverrides(JSON.stringify(given));
  const all = read as Record<string, string | undefined>;
  return SHORTCUTS.every(({ id }) => !(id in given) || all[id] === given[id]) ? read : null;
}

/** The settings an export file holds; null when it is unreadable or any store in it is invalid. */
export function readPersonalSettings(text: string): PersonalSettings | null {
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(file) || file.version !== 1) return null;
  const appearance = section(file.appearance, readAppearance);
  const look = section(file.look, readLook);
  const notifications = section(file.notifications, readNotificationPrefs);
  const shortcuts = shortcutsSection(file.shortcuts);
  const diff = section(file.diff, readDiffPrefs);
  const display = section(file.session_display, readSessionDisplay);
  if (!appearance || !look || !notifications || !shortcuts || !diff || !display) return null;
  return { version: 1, appearance, look, notifications, shortcuts, diff, session_display: display };
}

/** Writes every store of the file and applies it at once; writes none when any is invalid. */
export function importPersonalSettings(text: string): boolean {
  const settings = readPersonalSettings(text);
  if (!settings) return false;
  setAppearance(settings.appearance);
  setLook(settings.look);
  setNotificationPrefs(settings.notifications);
  setShortcutOverrides(settings.shortcuts);
  setDiffPrefs(settings.diff);
  setSessionDisplay(settings.session_display);
  return true;
}

export const SETUP_DONE_KEY = 'pantheon.setup-done.v1';

function loadSetupDone(): boolean {
  try {
    return localStorage.getItem(SETUP_DONE_KEY) === 'true';
  } catch {
    return false;
  }
}

let setupDone = loadSetupDone();
const setupListeners = new Set<() => void>();
const subscribeSetup = (listener: () => void) => {
  setupListeners.add(listener);
  return () => void setupListeners.delete(listener);
};
export const getSetupDone = () => setupDone;

/** Records that first-time setup is over; it does not show again. */
export function finishSetup() {
  if (setupDone) return;
  setupDone = true;
  setupListeners.forEach((listener) => listener());
  try {
    localStorage.setItem(SETUP_DONE_KEY, 'true');
  } catch {
    // It still holds for this session.
  }
}

export function useSetupDone(): boolean {
  return useSyncExternalStore(subscribeSetup, getSetupDone, getSetupDone);
}
