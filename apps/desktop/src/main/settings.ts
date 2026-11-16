import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DesktopBridge } from '@pantheon/protocol';
import { LOCALE_CHOICES, type LocaleChoice } from './locales.js';

export function readSettings(settingsFile: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(settingsFile, 'utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT')
      return {};
    throw error;
  }
}

/** Writes text to file through a temporary file beside it, so a failed write leaves the old file whole. */
export function replaceFile(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, file);
}

/** The saved language choice; 'system' when none is saved. */
export function readLocale(settingsFile: string): LocaleChoice {
  const { locale } = readSettings(settingsFile);
  return LOCALE_CHOICES.find((choice) => choice === locale) ?? 'system';
}

export type ShellPrefs = Required<Parameters<DesktopBridge['setShellPrefs']>[0]>;
const SHELL_PREFS: readonly (keyof ShellPrefs)[] = [
  'keep_running_on_close',
  'show_tray_icon',
  'voice_input',
];
/** The app icons a user may choose, each a shape and a colour it comes in. */
export const APP_ICONS: readonly ShellPrefs['app_icon'][] = [
  'pantheon-travertine',
  'pantheon-black',
  'pantheon-white',
  'monad-travertine',
  'monad-black',
  'monad-white',
  'monad-dusk',
  'monad-terracotta',
  'monad-lapis',
  'sigma-travertine',
  'sigma-black',
  'sigma-white',
  'sigma-dusk',
  'sigma-terracotta',
  'sigma-lapis',
];
/** The menu bar icons a user may choose. */
export const TRAY_ICONS: readonly ShellPrefs['tray_icon'][] = ['pantheon', 'monad', 'sigma'];
const isEngine = (value: unknown): value is string | null =>
  value === null || (typeof value === 'string' && path.isAbsolute(value));

export function readShellPrefs(settingsFile: string): ShellPrefs {
  const settings = readSettings(settingsFile);
  return {
    keep_running_on_close: settings.keep_running_on_close !== false,
    show_tray_icon: settings.show_tray_icon !== false,
    tray_icon: TRAY_ICONS.find((icon) => icon === settings.tray_icon) ?? 'pantheon',
    app_icon: APP_ICONS.find((icon) => icon === settings.app_icon) ?? 'pantheon-travertine',
    voice_input: settings.voice_input !== false,
    voice_engine: isEngine(settings.voice_engine) ? settings.voice_engine : null,
    mini_window: settings.mini_window === true,
  };
}

/** The shell settings the renderer sent; null unless each switch is a boolean, app_icon is one of APP_ICONS, tray_icon one of TRAY_ICONS and voice_engine is null. */
export function readShellPrefsPatch(value: unknown): Partial<ShellPrefs> | null {
  if (typeof value !== 'object' || value === null) return null;
  const entries = Object.entries(value);
  return entries.every(([key, set]) =>
    key === 'voice_engine'
      ? set === null
      : key === 'app_icon'
        ? APP_ICONS.includes(set)
        : key === 'tray_icon'
          ? TRAY_ICONS.includes(set)
          : SHELL_PREFS.includes(key as keyof ShellPrefs) && typeof set === 'boolean',
  )
    ? Object.fromEntries(entries)
    : null;
}

export function saveShellPrefs(settingsFile: string, prefs: ShellPrefs): void {
  const settings = readSettings(settingsFile);
  replaceFile(settingsFile, JSON.stringify({ ...settings, ...prefs }) + '\n');
}

export function saveChoice(
  settingsFile: string,
  key: 'editor' | 'terminal' | 'browser' | 'locale',
  id: string | undefined,
): void {
  const settings = readSettings(settingsFile);
  replaceFile(settingsFile, JSON.stringify({ ...settings, [key]: id }) + '\n');
}
