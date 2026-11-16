import { useSyncExternalStore } from 'react';

export const LAYOUT_KEY = 'pantheon.layout.v1';
export const APPEARANCE_KEY = 'pantheon.appearance.v1';

/** Widths in px; dragging below `fold` folds the pane. */
export const SIDEBAR = { min: 200, max: 420, initial: 248, fold: 140, rail: 48 } as const;
export const INSPECTOR = { min: 320, max: 640, initial: 400, fold: 240 } as const;
export const DRAWER = { min: 360, initial: 440 } as const;
/** The session panels' widths and the terminal's height, each under its own key. */
export const PANEL_WIDTHS_KEY = 'pantheon.panel-widths';
export const TERMINAL_HEIGHT_KEY = 'pantheon.terminal-height';
/** The thread keeps at least this much beside the inspector column, else the inspector is a sheet. */
export const THREAD_MIN = 360;

export interface SidebarLayout {
  collapsed: boolean;
  width: number;
}

export interface Layout {
  sidebar: SidebarLayout;
  inspector: number;
  drawer: number;
  /** The sidebar opens folded at every start of the app. */
  collapse_sidebar_at_start: boolean;
}

export const DEFAULT_LAYOUT: Layout = {
  sidebar: { collapsed: false, width: SIDEBAR.initial },
  inspector: INSPECTOR.initial,
  drawer: DRAWER.initial,
  collapse_sidebar_at_start: false,
};

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export function clampSidebarWidth(n: number): number {
  return Number.isFinite(n) ? clamp(n, SIDEBAR.min, SIDEBAR.max) : SIDEBAR.initial;
}

function sidebarOf(value: unknown): SidebarLayout {
  const v = value as { collapsed?: unknown; width?: unknown } | null | undefined;
  return {
    collapsed: v?.collapsed === true,
    width: typeof v?.width === 'number' ? clampSidebarWidth(v.width) : SIDEBAR.initial,
  };
}

const parse = (raw: string | null): unknown => {
  try {
    return JSON.parse(raw ?? 'null');
  } catch {
    return null;
  }
};

/** The stored layout; anything unreadable is the default. */
export function readLayout(raw: string | null): Layout {
  const value = parse(raw) as {
    sidebar?: unknown;
    inspector?: unknown;
    drawer?: unknown;
    collapse_sidebar_at_start?: unknown;
  } | null;
  if (!value || typeof value !== 'object') return DEFAULT_LAYOUT;
  return {
    sidebar: sidebarOf(value.sidebar),
    inspector:
      typeof value.inspector === 'number' && Number.isFinite(value.inspector)
        ? clamp(value.inspector, INSPECTOR.min, INSPECTOR.max)
        : INSPECTOR.initial,
    drawer:
      typeof value.drawer === 'number' && Number.isFinite(value.drawer)
        ? Math.max(DRAWER.min, value.drawer)
        : DRAWER.initial,
    collapse_sidebar_at_start: value.collapse_sidebar_at_start === true,
  };
}

/** The sidebar a drag asks for: below the fold it becomes the rail and keeps its last width. */
export function sidebarDrag(width: number, now: SidebarLayout): SidebarLayout {
  return width < SIDEBAR.fold
    ? { collapsed: true, width: now.width }
    : { collapsed: false, width: clampSidebarWidth(width) };
}

/** The widest the inspector gets beside a main area this wide; the thread keeps THREAD_MIN. */
export function inspectorMax(main: number): number {
  return Math.max(INSPECTOR.min, Math.min(INSPECTOR.max, Math.floor(main / 2), main - THREAD_MIN));
}

export function inspectorWidth(main: number, stored: number): number {
  return clamp(stored, INSPECTOR.min, inspectorMax(main));
}

/** The inspector slides in over the thread when a default-width column would leave the thread too little room. */
export function inspectorIsSheet(main: number): boolean {
  return main - INSPECTOR.initial < THREAD_MIN;
}

export function drawerMax(viewport: number): number {
  return Math.max(DRAWER.min, Math.floor(viewport / 2));
}

// Only the start folds the sidebar; another window's save keeps what it stored.
function loadLayout(): Layout {
  try {
    const stored = readLayout(localStorage.getItem(LAYOUT_KEY));
    return stored.collapse_sidebar_at_start
      ? { ...stored, sidebar: { ...stored.sidebar, collapsed: true } }
      : stored;
  } catch {
    return DEFAULT_LAYOUT;
  }
}

let layout = loadLayout();
// Counts "fold all side panes"; mounted panes close when it changes.
let folds = 0;
// Counts resets and other windows' changes of the sizes below; the sessions screen reads them again.
let sizeChanges = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const changed = () => listeners.forEach((listener) => listener());

export const getLayout = () => layout;

/** Changes the layout in memory; saveLayout stores it. */
export function setLayout(patch: Partial<Layout> | ((now: Layout) => Partial<Layout>)) {
  layout = { ...layout, ...(typeof patch === 'function' ? patch(layout) : patch) };
  changed();
}

export function saveLayout() {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // The layout still applies for this session.
  }
}

export function resetLayout() {
  layout = DEFAULT_LAYOUT;
  sizeChanges++;
  changed();
  try {
    localStorage.removeItem(LAYOUT_KEY);
    localStorage.removeItem(PANEL_WIDTHS_KEY);
    localStorage.removeItem(TERMINAL_HEIGHT_KEY);
  } catch {
    // The defaults still apply for this session.
  }
}

/** Folds the sidebar and closes the inspector and drawer that are open. */
export function foldAll() {
  layout = { ...layout, sidebar: { ...layout.sidebar, collapsed: true } };
  folds++;
  changed();
  saveLayout();
}

export function useLayout(): Layout {
  return useSyncExternalStore(subscribe, getLayout, getLayout);
}

export function useFolds(): number {
  const read = () => folds;
  return useSyncExternalStore(subscribe, read, read);
}

export function useSizeChanges(): number {
  const read = () => sizeChanges;
  return useSyncExternalStore(subscribe, read, read);
}

const viewport = () => window.innerWidth;
const subscribeViewport = (listener: () => void) => {
  window.addEventListener('resize', listener);
  return () => window.removeEventListener('resize', listener);
};

/** The window's width; server rendering assumes the default window. */
export function useViewportWidth(): number {
  return useSyncExternalStore(subscribeViewport, viewport, () => 1280);
}

export type Density = 'standard' | 'compact';
/** When a session's inspector opens by itself: with a wide window, always or never. */
export type InspectorOpening = 'auto' | 'always' | 'never';
/** The line height of interface text: tighter than the type scale, as it is, or looser. */
export type LineHeight = 'compact' | 'standard' | 'relaxed';
/** The widest a session's thread and composer get, in px. */
export type ReadingWidth = 680 | 760 | 960 | 'none';

/** The interface text size in px, which every step of the type scale follows. */
export const TEXT_SIZE = { min: 11, max: 20, initial: 13 } as const;
/** The named text sizes, in px. */
export const TEXT_PRESETS = { small: 12, standard: 13, large: 15 } as const;
export const LINE_HEIGHTS: readonly LineHeight[] = ['compact', 'standard', 'relaxed'];
export const READING_WIDTHS: readonly ReadingWidth[] = [680, 760, 960, 'none'];

const sizeIn = (value: unknown, range: { min: number; max: number }): value is number =>
  Number.isInteger(value) && (value as number) >= range.min && (value as number) <= range.max;

export interface Appearance {
  density: Density;
  inspector: InspectorOpening;
  /** The interface text size in px, under the name of the chat text size it took over. */
  chat_font: number;
  line_height: LineHeight;
  reading_width: ReadingWidth;
}

export const DEFAULT_APPEARANCE: Appearance = {
  density: 'standard',
  inspector: 'never',
  chat_font: TEXT_SIZE.initial,
  line_height: 'standard',
  reading_width: 760,
};

export function readAppearance(raw: string | null): Appearance {
  const value = parse(raw) as {
    density?: unknown;
    inspector?: unknown;
    chat_font?: unknown;
    line_height?: unknown;
    reading_width?: unknown;
  } | null;
  const size = value?.chat_font;
  return {
    density: value?.density === 'compact' ? 'compact' : 'standard',
    inspector:
      value?.inspector === 'always' || value?.inspector === 'auto' ? value.inspector : 'never',
    chat_font: sizeIn(size, TEXT_SIZE) ? size : TEXT_SIZE.initial,
    line_height: LINE_HEIGHTS.find((height) => height === value?.line_height) ?? 'standard',
    reading_width: READING_WIDTHS.find((width) => width === value?.reading_width) ?? 760,
  };
}

const LINE_GAPS: Record<LineHeight, string> = { compact: '-2px', standard: '0px', relaxed: '4px' };

/** Sets the text size and line height on the root element, where the type scale is worked out. */
export function applyText(
  appearance: Appearance,
  style: { setProperty(name: string, value: string): void },
) {
  style.setProperty('--fs-ui', `${appearance.chat_font}px`);
  style.setProperty('--lh-add', LINE_GAPS[appearance.line_height]);
}

function loadAppearance(): Appearance {
  try {
    return readAppearance(localStorage.getItem(APPEARANCE_KEY));
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

let appearance = loadAppearance();
export const getAppearance = () => appearance;

export function setAppearance(patch: Partial<Appearance>) {
  appearance = { ...appearance, ...patch };
  changed();
  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(appearance));
  } catch {
    // The choice still applies for this session.
  }
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, getAppearance, getAppearance);
}

export const LOOK_KEY = 'pantheon.look.v1';

/** The text size of tool output, terminal blocks and diffs, in px. */
export const CODE_SIZE = { min: 10, max: 24, initial: 12 } as const;
/** The font of code: the one the app bundles, the system's monospace font, or one named. */
export type CodeFamily = 'bundled' | 'system' | 'custom';
/** The font of interface text: the app's own, the code font, or one named. */
export type UiFamily = 'default' | 'mono' | 'custom';
/** Whether movement stops: as the system asks, always, or never. */
export type Motion = 'system' | 'reduced' | 'full';
/** Whether a turn's tool calls show folded, folded but for the failed ones, or opened. */
export type Transcript = 'folded' | 'open-failed' | 'expanded';
/** The key that sends the composer's message; with ⌘Enter, Enter starts a new line. */
export type SendKey = 'enter' | 'meta-enter';

/** The colours, code and interface fonts, motion and send key chosen in Appearance, and the tool call folding chosen in Session display. */
export interface Look {
  colorblind: boolean;
  code_font: number;
  code_family: CodeFamily;
  /** The font a custom code family names. */
  code_font_name: string;
  ui_family: UiFamily;
  /** The font a custom interface family names. */
  ui_font_name: string;
  motion: Motion;
  transcript: Transcript;
  send_key: SendKey;
}

export const DEFAULT_LOOK: Look = {
  colorblind: false,
  code_font: CODE_SIZE.initial,
  code_family: 'bundled',
  code_font_name: '',
  ui_family: 'default',
  ui_font_name: '',
  motion: 'system',
  transcript: 'folded',
  send_key: 'enter',
};

export function readLook(raw: string | null): Look {
  const value = parse(raw) as {
    colorblind?: unknown;
    code_font?: unknown;
    code_family?: unknown;
    code_font_name?: unknown;
    ui_family?: unknown;
    ui_font_name?: unknown;
    motion?: unknown;
    transcript?: unknown;
    send_key?: unknown;
  } | null;
  return {
    colorblind: value?.colorblind === true,
    code_font: sizeIn(value?.code_font, CODE_SIZE) ? value.code_font : CODE_SIZE.initial,
    code_family:
      value?.code_family === 'system' || value?.code_family === 'custom'
        ? value.code_family
        : 'bundled',
    code_font_name: typeof value?.code_font_name === 'string' ? value.code_font_name : '',
    ui_family:
      value?.ui_family === 'mono' || value?.ui_family === 'custom' ? value.ui_family : 'default',
    ui_font_name: typeof value?.ui_font_name === 'string' ? value.ui_font_name : '',
    motion: value?.motion === 'reduced' || value?.motion === 'full' ? value.motion : 'system',
    transcript:
      value?.transcript === 'expanded' || value?.transcript === 'open-failed'
        ? value.transcript
        : 'folded',
    send_key: value?.send_key === 'meta-enter' ? 'meta-enter' : 'enter',
  };
}

interface LookTarget {
  dataset: Record<string, string | undefined>;
  style: { setProperty(name: string, value: string): void; removeProperty(name: string): unknown };
}

/** A font stack that starts with the named font; null without a name. */
const namedFont = (name: string, generic: string) =>
  name.trim() === '' ? null : `"${name.trim().replace(/["\\]/g, '\\$&')}", ${generic}`;

/**
 * Sets the look on the body: its choices as data attributes, its code size and named fonts as properties.
 * Motion is set as reduced or full, the system's setting deciding while the choice follows it.
 */
export function applyLook(look: Look, { dataset, style }: LookTarget, systemReduced: boolean) {
  dataset.palette = look.colorblind ? 'colorblind' : 'standard';
  dataset.codeFamily = look.code_family;
  dataset.uiFamily = look.ui_family;
  dataset.motion = look.motion !== 'system' ? look.motion : systemReduced ? 'reduced' : 'full';
  const properties = {
    '--fs-code': `${look.code_font}px`,
    '--font-mono':
      look.code_family === 'custom' ? namedFont(look.code_font_name, 'monospace') : null,
    '--font-sans': look.ui_family === 'custom' ? namedFont(look.ui_font_name, 'sans-serif') : null,
  };
  for (const [name, value] of Object.entries(properties))
    if (value === null) style.removeProperty(name);
    else style.setProperty(name, value);
}

function loadLook(): Look {
  try {
    return readLook(localStorage.getItem(LOOK_KEY));
  } catch {
    return DEFAULT_LOOK;
  }
}

let look = loadLook();
export const getLook = () => look;

export function setLook(patch: Partial<Look>) {
  look = { ...look, ...patch };
  changed();
  try {
    localStorage.setItem(LOOK_KEY, JSON.stringify(look));
  } catch {
    // The choice still applies for this session.
  }
}

export function toggleTranscript() {
  setLook({ transcript: look.transcript === 'expanded' ? 'folded' : 'expanded' });
}

export function useLook(): Look {
  return useSyncExternalStore(subscribe, getLook, getLook);
}

/** Read by the first-frame script in index.html; keep the two in step. */
export const ACCENT_KEY = 'pantheon.accent.v1';

/** The colour of the ink role over any theme; 'default' keeps the theme's own ink, 'system' takes the system accent colour. */
export type Accent =
  'default' | 'system' | 'bronze' | 'lapis' | 'terracotta' | 'verdigris' | 'porphyry';
export const ACCENTS: readonly Accent[] = [
  'default',
  'system',
  'bronze',
  'lapis',
  'terracotta',
  'verdigris',
  'porphyry',
];

export function readAccent(raw: string | null): Accent {
  const value = parse(raw) as { accent?: unknown } | null;
  return ACCENTS.find((accent) => accent === value?.accent) ?? 'default';
}

/** The system accent colour as #rrggbb the desktop app reported; null without one. */
let systemAccent: string | null = null;
export const getSystemAccent = () => systemAccent;

/** The WCAG relative luminance of red, green and blue channels from 0 to 255. */
const luminance = (channels: number[]): number => {
  const [r, g, b] = channels.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
// The dark theme's --on-ink; hex colours stay in the theme blocks of index.css.
const DARK_TEXT = [20, 20, 19];

/** The text colour on a #rrggbb fill: white while it contrasts at least 3:1 with it, else near black. */
export function onInk(colour: string): string {
  const fill = luminance([1, 3, 5].map((at) => parseInt(colour.slice(at, at + 2), 16))) + 0.05;
  // macOS and Windows put white text on their accent buttons; 3:1 is WCAG's floor for UI components.
  return 1.05 / fill >= 3 ? 'rgb(255 255 255)' : `rgb(${DARK_TEXT.join(' ')})`;
}

/** The ink tokens an accent sets in both schemes; null for the default, and for the system one without a system colour. */
export function accentCss(accent: Accent, system: string | null = systemAccent): string | null {
  if (accent === 'default' || (accent === 'system' && system === null)) return null;
  const colour = accent === 'system' ? system! : `var(--accent-${accent})`;
  const text = accent === 'system' ? onInk(system!) : 'var(--on-accent)';
  // Four :root outrank a theme's `:root[data-user-theme=…]` blocks wherever either sheet stands.
  return `:root:root:root:root{--ink:${colour};--ac:${colour};--ac2:${colour};--focus-ring:${colour};--on-ink:${text};}`;
}

/** Puts the accent's tokens in one style element; the default takes it away. */
export function applyAccent(accent: Accent, doc: Document = document) {
  const css = accentCss(accent);
  let style = doc.getElementById('pt-accent');
  if (css === null) {
    style?.remove();
    return;
  }
  if (!style) {
    style = doc.createElement('style');
    style.id = 'pt-accent';
    doc.head.append(style);
  }
  style.textContent = css;
}

function loadAccent(): Accent {
  try {
    return readAccent(localStorage.getItem(ACCENT_KEY));
  } catch {
    return 'default';
  }
}

let accent = loadAccent();
export const getAccent = () => accent;

export function setAccent(next: Accent) {
  accent = next;
  changed();
  applyAccent(next);
  try {
    // index.html paints the first frame from the stored CSS.
    localStorage.setItem(ACCENT_KEY, JSON.stringify({ accent: next, css: accentCss(next) }));
  } catch {
    // The choice still applies for this session.
  }
}

export function useAccent(): Accent {
  return useSyncExternalStore(subscribe, getAccent, getAccent);
}

/** Keeps the system accent colour and repaints the accent while it follows the system. */
export function setSystemAccent(colour: string | null) {
  systemAccent = colour;
  changed();
  if (accent === 'system') setAccent('system');
}

/** Follows the system accent colour the desktop app reports; returns the function that stops. */
export function watchSystemAccent(): () => void {
  const bridge = window.pantheon;
  if (!bridge) return () => {};
  void bridge.systemAccent().then(setSystemAccent);
  return bridge.onSystemAccent(setSystemAccent);
}

export function useSystemAccent(): string | null {
  return useSyncExternalStore(subscribe, getSystemAccent, getSystemAccent);
}

// Another window stored a change: this one follows it.
if (typeof window !== 'undefined')
  window.addEventListener('storage', (e) => {
    if (e.key === LAYOUT_KEY) layout = readLayout(e.newValue);
    else if (e.key === APPEARANCE_KEY) appearance = readAppearance(e.newValue);
    else if (e.key === LOOK_KEY) look = readLook(e.newValue);
    else if (e.key === ACCENT_KEY) {
      accent = readAccent(e.newValue);
      applyAccent(accent);
    } else if (e.key === PANEL_WIDTHS_KEY || e.key === TERMINAL_HEIGHT_KEY) sizeChanges++;
    else return;
    changed();
  });
