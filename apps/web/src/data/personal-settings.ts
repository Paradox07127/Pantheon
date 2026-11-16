import { useSyncExternalStore } from 'react';
import { chooseLocale, localeChoice, LOCALES, type LocaleChoice } from '../i18n';
import {
  getOverrides,
  readShortcutOverrides,
  setShortcutOverrides,
  SHORTCUTS,
  type ShortcutOverrides,
} from '../lib/shortcuts';
import { ipcFailure } from '../screens/settings/editors';
import { useShell, type Theme } from '../store';
import { getDiffPrefs, readDiffPrefs, setDiffPrefs, type DiffPrefs } from './diff-prefs';
import {
  ACCENTS,
  getAccent,
  getAppearance,
  getLayout,
  getLook,
  readAppearance,
  readLayout,
  readLook,
  saveLayout,
  setAccent,
  setAppearance,
  setLayout,
  setLook,
  type Accent,
  type Appearance,
  type Layout,
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
import { applyTheme, getBackdropOn, getUserThemes, setBackdropOn } from './theme';

/** The settings that belong to the user rather than a project, as one export file holds them. */
export interface PersonalSettings {
  version: 1;
  appearance: Appearance;
  look: Look;
  notifications: NotificationPrefs;
  shortcuts: ShortcutOverrides;
  diff: DiffPrefs;
  session_display: SessionDisplay;
  // Files exported before these fields leave them out; importing one keeps their current values.
  accent?: Accent;
  theme?: Theme;
  /** The applied saved theme's id; null for the default theme. */
  user_theme?: string | null;
  backdrop?: boolean;
  layout?: Layout;
  locale?: LocaleChoice;
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
    accent: getAccent(),
    theme: useShell.getState().theme,
    user_theme: activeTheme(),
    backdrop: getBackdropOn(),
    layout: getLayout(),
    locale: localeChoice(),
  };
}

const activeTheme = () => getUserThemes().list?.active_theme_id ?? null;
const THEMES: readonly Theme[] = ['light', 'dark', 'system'];
const LOCALE_CHOICES: readonly LocaleChoice[] = ['system', ...LOCALES];

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

/** A field of one of the given values: absent is undefined, any other value null. */
function oneOf<T>(
  file: Record<string, unknown>,
  key: string,
  known: readonly T[],
): T | undefined | null {
  if (!(key in file)) return undefined;
  return known.includes(file[key] as T) ? (file[key] as T) : null;
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
  const accent = oneOf(file, 'accent', ACCENTS);
  const theme = oneOf(file, 'theme', THEMES);
  const backdrop = oneOf(file, 'backdrop', [true, false]);
  const locale = oneOf(file, 'locale', LOCALE_CHOICES);
  const userTheme = file.user_theme;
  const layout = 'layout' in file ? section(file.layout, readLayout) : undefined;
  if (accent === null || theme === null || backdrop === null || locale === null || layout === null)
    return null;
  if (userTheme !== undefined && userTheme !== null && typeof userTheme !== 'string') return null;
  return {
    version: 1,
    appearance,
    look,
    notifications,
    shortcuts,
    diff,
    session_display: display,
    accent,
    theme,
    user_theme: userTheme,
    backdrop,
    layout,
    locale,
  };
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
  if (settings.accent !== undefined && settings.accent !== getAccent()) setAccent(settings.accent);
  if (settings.theme !== undefined) useShell.getState().setTheme(settings.theme);
  if (settings.backdrop !== undefined) setBackdropOn(settings.backdrop);
  if (settings.layout !== undefined) {
    setLayout(settings.layout);
    saveLayout();
  }
  const { user_theme: userTheme, locale } = settings;
  // A new language reloads the page, so it waits for the saved theme to apply.
  void (
    userTheme !== undefined && userTheme !== activeTheme()
      ? applyTheme(userTheme)
      : Promise.resolve()
  ).then(() => {
    if (locale !== undefined && locale !== localeChoice())
      void chooseLocale(locale)?.catch(ipcFailure);
  });
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
