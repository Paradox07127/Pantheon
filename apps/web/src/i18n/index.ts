import { createIntl, createIntlCache, IntlErrorCode, type IntlShape } from '@formatjs/intl';
import type { UiLocale, UiLocaleChoice } from '@pantheon/protocol';

export type Locale = UiLocale;
export type LocaleChoice = UiLocaleChoice;
export const LOCALES: readonly Locale[] = ['en', 'zh-CN'];
/** Each language's name in that language, the same in every catalog. */
export const LOCALE_NAMES: Record<Locale, string> = { en: 'English', 'zh-CN': '简体中文' };

/** A message as written at its call site; defaultMessage is the English text. */
export interface Message {
  id: string;
  defaultMessage: string;
  description?: string;
}

type Values = Record<string, string | number | boolean | Date | null | undefined>;

const cache = createIntlCache();
const make = (locale: Locale, messages: Record<string, string>): IntlShape =>
  createIntl(
    {
      locale,
      defaultLocale: 'en',
      messages,
      // A key missing from the catalog shows its English text.
      onError: (error) => {
        if (error.code !== IntlErrorCode.MISSING_TRANSLATION) console.error(error);
      },
    },
    cache,
  );
// Shared by every copy of this module, so a copy evaluated again keeps the loaded language.
const shared = globalThis as { pantheonIntl?: IntlShape };
let intl = shared.pantheonIntl ?? make('en', {});

export function t(message: Message, values?: Values): string {
  return intl.formatMessage(message, values);
}

export const currentLocale = (): Locale => intl.locale as Locale;

const matchLocale = (tag: string): Locale | null => {
  const lower = tag.toLowerCase();
  if (lower === 'zh' || lower.startsWith('zh-hans') || lower.startsWith('zh-cn')) return 'zh-CN';
  if (lower === 'en' || lower.startsWith('en-')) return 'en';
  return null;
};

/** The language a choice shows; 'system' takes the first preferred language there is a catalog for. */
export function resolveLocale(choice: LocaleChoice, preferred: readonly string[]): Locale {
  if (choice !== 'system') return choice;
  for (const tag of preferred) {
    const locale = matchLocale(tag);
    if (locale) return locale;
  }
  return 'en';
}

export function setLocaleSync(locale: Locale, messages: Record<string, string>): void {
  intl = shared.pantheonIntl = make(locale, messages);
}

const catalogs = import.meta.glob<Record<string, string>>('./locales/*/*.json', {
  import: 'default',
});

/** Loads every catalog file of the locale; English has none. */
export async function loadLocale(locale: Locale): Promise<void> {
  const files = Object.entries(catalogs).filter(([file]) =>
    file.startsWith(`./locales/${locale}/`),
  );
  const parts = await Promise.all(files.map(([, load]) => load()));
  setLocaleSync(locale, Object.assign({}, ...parts));
  document.documentElement.lang = locale;
}

// Without the desktop app the choice lives in this browser.
const LOCALE_KEY = 'pantheon.locale';
let choice: LocaleChoice = 'system';

/** The choice the page started with; changing it reloads the page. */
export const localeChoice = (): LocaleChoice => choice;

/** Loads the language of the desktop app's choice, else of this browser's. */
export async function startLocale(): Promise<void> {
  const bridge = window.pantheon;
  if (bridge) {
    choice = bridge.locale.choice;
    return loadLocale(bridge.locale.resolved);
  }
  const stored = localStorage.getItem(LOCALE_KEY);
  choice = stored === 'en' || stored === 'zh-CN' ? stored : 'system';
  return loadLocale(resolveLocale(choice, navigator.languages));
}

/** Saves the choice and reloads the page in its language; answers the desktop app's result. */
export function chooseLocale(choice: LocaleChoice): Promise<unknown> | undefined {
  if (window.pantheon) return window.pantheon.setLocale(choice);
  localStorage.setItem(LOCALE_KEY, choice);
  location.reload();
}
