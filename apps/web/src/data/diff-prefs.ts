import { useSyncExternalStore } from 'react';

export const DIFF_PREFS_KEY = 'pantheon.diff.v1';

/** How a diff shows its lines and files. */
export interface DiffPrefs {
  wrap: boolean;
  ignore_whitespace: boolean;
  /** Every file opens folded to its header. */
  collapse: boolean;
  view: DiffView;
  /** The width of a tab character, in spaces. */
  tab_size: TabSize;
  /** Where a changed file opens: the app's own diff or the chosen editor. */
  changes_viewer: ChangesViewer;
}

/** The on-off choices, which the diff toolbar changes too. */
export type DiffSwitch = 'wrap' | 'ignore_whitespace' | 'collapse';
export type DiffView = 'unified' | 'split';
export type TabSize = 2 | 4 | 8;
export type ChangesViewer = 'app' | 'editor';
export const TAB_SIZES: readonly TabSize[] = [2, 4, 8];

export const DEFAULT_DIFF_PREFS: DiffPrefs = {
  wrap: true,
  ignore_whitespace: false,
  collapse: false,
  view: 'unified',
  tab_size: 4,
  changes_viewer: 'app',
};

const parse = (raw: string | null): unknown => {
  try {
    return JSON.parse(raw ?? 'null');
  } catch {
    return null;
  }
};

export function readDiffPrefs(raw: string | null): DiffPrefs {
  const value = parse(raw) as {
    wrap?: unknown;
    ignore_whitespace?: unknown;
    collapse?: unknown;
    view?: unknown;
    tab_size?: unknown;
    changes_viewer?: unknown;
  } | null;
  return {
    wrap: value?.wrap !== false,
    ignore_whitespace: value?.ignore_whitespace === true,
    collapse: value?.collapse === true,
    view: value?.view === 'split' ? 'split' : 'unified',
    tab_size: TAB_SIZES.find((size) => size === value?.tab_size) ?? 4,
    changes_viewer: value?.changes_viewer === 'editor' ? 'editor' : 'app',
  };
}

function loadDiffPrefs(): DiffPrefs {
  try {
    return readDiffPrefs(localStorage.getItem(DIFF_PREFS_KEY));
  } catch {
    return DEFAULT_DIFF_PREFS;
  }
}

let prefs = loadDiffPrefs();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
export const getDiffPrefs = () => prefs;

export function setDiffPrefs(patch: Partial<DiffPrefs>) {
  prefs = { ...prefs, ...patch };
  listeners.forEach((listener) => listener());
  try {
    localStorage.setItem(DIFF_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // The choice still applies for this session.
  }
}

export function useDiffPrefs(): DiffPrefs {
  return useSyncExternalStore(subscribe, getDiffPrefs, getDiffPrefs);
}

// Another window stored a change: this one follows it.
if (typeof window !== 'undefined')
  window.addEventListener('storage', (e) => {
    if (e.key !== DIFF_PREFS_KEY) return;
    prefs = readDiffPrefs(e.newValue);
    listeners.forEach((listener) => listener());
  });
