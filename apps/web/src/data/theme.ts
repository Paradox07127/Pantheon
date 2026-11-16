import { useSyncExternalStore } from 'react';
import type { BridgeResult, ThemeAppliedPayload, ThemeList, ThemeRead } from '@pantheon/protocol';
import { ipcFailure } from '../screens/settings/editors';
import { useBoard } from './board';
import { runCommand } from './commands';
import type { DaemonEvent } from './sync';

export type SavedTheme = ThemeList['themes'][number];
export type Swatches = SavedTheme['swatches'];

export interface UserThemes {
  /** null until the first read lands. */
  list: ThemeList | null;
  /** The applied saved theme; null for the default theme. */
  active: ThemeRead | null;
}

let themes: UserThemes = { list: null, active: null };
const themeListeners = new Set<() => void>();
const subscribeThemes = (listener: () => void) => {
  themeListeners.add(listener);
  return () => void themeListeners.delete(listener);
};
export const getUserThemes = () => themes;

export function setUserThemes(next: UserThemes) {
  themes = next;
  themeListeners.forEach((listener) => listener());
}

export function useUserThemes(): UserThemes {
  return useSyncExternalStore(subscribeThemes, getUserThemes, getUserThemes);
}

// The style element holding the applied theme's tokens; null while the default theme shows.
let style: HTMLStyleElement | null = null;

// Only the newest read is kept, so an older answer landing late changes nothing.
let reads = 0;

/** Reads the saved themes and the applied one into `useUserThemes`. */
export async function loadThemes(): Promise<void> {
  const bridge = window.pantheon;
  if (!bridge) return;
  const read = ++reads;
  const listed = await bridge.query('theme.list').catch(ipcFailure);
  if (read !== reads || !listed.ok) return;
  const list = listed.value as ThemeList;
  let active: ThemeRead | null = null;
  if (list.active_theme_id !== null) {
    const got = await readUserTheme(list.active_theme_id);
    // Without the theme itself, what is applied now (the first frame's copy too) stays.
    if (read !== reads || !got.ok) return;
    active = got.value;
  }
  setUserThemes({ list, active });
}

export async function readUserTheme(id: string): Promise<BridgeResult<ThemeRead>> {
  const bridge = window.pantheon;
  if (!bridge)
    return {
      ok: false,
      error: { code: 'bridge_unavailable', message: 'Desktop bridge unavailable' },
    };
  const result = await bridge.query('theme.get', { theme_id: id }).catch(ipcFailure);
  return result.ok ? { ok: true, value: result.value as ThemeRead } : result;
}

/** Applies a saved theme, or the default theme for null. */
export async function applyTheme(id: string | null): Promise<BridgeResult<unknown>> {
  const result = await runCommand('theme.apply', { theme_id: id }, null);
  if (result.ok) await loadThemes();
  return result;
}

export async function deleteTheme(id: string): Promise<BridgeResult<unknown>> {
  const result = await runCommand('theme.delete', { theme_id: id }, null);
  if (result.ok) await loadThemes();
  return result;
}

/** Read by the first-frame script in index.html; keep the two in step. */
export const FIRST_FRAME_KEY = 'pantheon.userTheme.v1';

/** The one scheme a theme that gives only light or only dark holds the window in; null otherwise. */
export function forcedScheme(theme: ThemeRead | null): 'light' | 'dark' | null {
  return theme?.modes.length === 1 ? theme.modes[0]! : null;
}

/** Whether the window is dark: the scheme the applied theme forces, else the user's resolved choice. */
export function windowDark(chosen: 'light' | 'dark', forced: 'light' | 'dark' | null): boolean {
  return (forced ?? chosen) === 'dark';
}

/** The root's --sf and --tx, which the top bar shows, and its --bg, each as #rrggbb. */
export function windowColours(doc: Document = document): {
  color: string;
  symbolColor: string;
  background: string;
} {
  const style = getComputedStyle(doc.documentElement);
  // One canvas pixel turns any colour notation a theme writes into sRGB bytes.
  const context = doc.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
  const hex = (token: string): string => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = style.getPropertyValue(token).trim();
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return '#' + [r!, g!, b!].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  };
  return { color: hex('--sf'), symbolColor: hex('--tx'), background: hex('--bg') };
}

/** Puts the theme's stylesheet on the page and names it on the root; null takes both away. */
export function applyUserTheme(theme: ThemeRead | null, doc: Document = document): void {
  // index.html paints the first frame from this copy, before the daemon answers.
  try {
    if (theme)
      localStorage.setItem(
        FIRST_FRAME_KEY,
        JSON.stringify({ id: theme.id, css: theme.css, forced: forcedScheme(theme) }),
      );
    else localStorage.removeItem(FIRST_FRAME_KEY);
  } catch {}
  style ??= doc.getElementById('pt-user-theme') as HTMLStyleElement | null;
  if (!theme) {
    if (!style) return;
    style.remove();
    style = null;
    delete doc.documentElement.dataset.userTheme;
    return;
  }
  if (!style) {
    style = doc.createElement('style');
    style.id = 'pt-user-theme';
    doc.head.append(style);
  }
  style.textContent = theme.css;
  doc.documentElement.dataset.userTheme = theme.id;
}

/**
 * The default theme's canvas, surface and ink in a scheme, read from the app's token block,
 * which a saved theme's tokens on the root would hide; null when no sheet holds it.
 */
export function defaultSwatches(
  dark: boolean,
  sheets: Iterable<CSSStyleSheet> = document.styleSheets,
): Swatches | null {
  const selector = dark ? '.dark' : ':root';
  for (const sheet of sheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      // A sheet from another origin keeps its rules to itself.
      continue;
    }
    for (const rule of rules) {
      if ((rule as CSSStyleRule).selectorText !== selector) continue;
      const style = (rule as CSSStyleRule).style;
      const value = (token: string) => style.getPropertyValue(token).trim();
      if (value('--bg'))
        return { surface0: value('--bg'), surface1: value('--sf'), accent: value('--ink') };
    }
  }
  return null;
}

/** An SVG as an image source; an `<img>` runs none of its scripts and loads nothing it names. */
export function backdropSrc(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const newest = (events: readonly DaemonEvent[]) => events.at(-1)?.sequence ?? 0;

/** Calls `applied` for each theme.applied event that arrives from now on; returns the stop. */
export function watchThemeApplied(applied: (payload: ThemeAppliedPayload) => void): () => void {
  let last = newest(useBoard.getState().events);
  return useBoard.subscribe((state, before) => {
    // A read that failed while the daemon was away is made again once the stream is back.
    if (state.status.state === 'live' && before.status.state !== 'live') void loadThemes();
    if (state.events === before.events) return;
    // Replaced history starts the count again; the themes are read again in case one was missed.
    if (state.resync !== before.resync) {
      last = newest(state.events);
      void loadThemes();
      return;
    }
    const fresh: DaemonEvent[] = [];
    for (let i = state.events.length - 1; i >= 0 && state.events[i]!.sequence > last; i--)
      fresh.unshift(state.events[i]!);
    last = Math.max(last, newest(state.events));
    for (const event of fresh)
      if (event.kind === 'theme.applied') applied(event.payload as ThemeAppliedPayload);
  });
}

const BACKDROP_KEY = 'pantheon.backdrop.v1';

function loadBackdropOn(): boolean {
  try {
    return localStorage.getItem(BACKDROP_KEY) !== 'false';
  } catch {
    return true;
  }
}

let backdropOn = loadBackdropOn();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
export const getBackdropOn = () => backdropOn;

/** Whether a theme's backdrop is drawn; on unless the user turned it off. */
export function useBackdropOn(): boolean {
  return useSyncExternalStore(subscribe, getBackdropOn, getBackdropOn);
}

export function setBackdropOn(on: boolean) {
  backdropOn = on;
  changed();
  try {
    localStorage.setItem(BACKDROP_KEY, JSON.stringify(on));
  } catch {
    // The choice still applies for this session.
  }
}

const REDUCED = '(prefers-reduced-motion: reduce)';
const reducedNow = () => window.matchMedia(REDUCED).matches;
const subscribeReduced = (listener: () => void) => {
  const query = window.matchMedia(REDUCED);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
};

/** Whether the system asks for reduced motion, following a change. */
export function useSystemReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduced, reducedNow, () => false);
}

// Another window stored a change: this one follows it.
if (typeof window !== 'undefined')
  window.addEventListener('storage', (e) => {
    if (e.key !== BACKDROP_KEY) return;
    backdropOn = e.newValue !== 'false';
    changed();
  });
