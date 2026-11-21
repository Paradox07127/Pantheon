import { readFileSync } from 'node:fs';
import type {
  BrowserWindowConstructorOptions,
  MenuItemConstructorOptions,
  PowerSaveBlocker,
  Rectangle,
  TitleBarOverlay,
  Task,
} from 'electron';
import { ZOOM_FACTORS, type DesktopBridge, type MenuAction } from '@pantheon/protocol';
import { menuText } from './locales.js';
import { replaceFile } from './settings.js';

export type WindowContext = ReturnType<DesktopBridge['windowContext']>;
export type WindowRequest = Parameters<DesktopBridge['openWindow']>[0];
export type WindowPlace = Parameters<DesktopBridge['showInMainWindow']>[0];

/** The window's size and place as last saved; x and y are absent until the window first moves. */
export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

export const DEFAULT_WINDOW: WindowState = { width: 1280, height: 800, maximized: false };

const isWindowState = (value: unknown): value is WindowState => {
  if (typeof value !== 'object' || value === null) return false;
  const { x, y, width, height, maximized } = value as Record<string, unknown>;
  const size = (n: unknown) => Number.isInteger(n) && (n as number) > 0;
  const placed = x === undefined && y === undefined;
  return (
    size(width) &&
    size(height) &&
    typeof maximized === 'boolean' &&
    (placed || (Number.isInteger(x) && Number.isInteger(y)))
  );
};

/** The saved state, or the defaults when the file is missing or unreadable. */
export function readWindowState(file: string): WindowState {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (isWindowState(value)) {
      const { x, y, width, height, maximized } = value;
      return x === undefined ? { width, height, maximized } : { x, y, width, height, maximized };
    }
  } catch {}
  return { ...DEFAULT_WINDOW };
}

export function writeWindowState(file: string, state: WindowState): void {
  replaceFile(file, JSON.stringify(state));
}

/** The saved page zoom; 1 when the file is missing, unreadable or names another factor. */
export function readZoom(file: string): number {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const factor = (value as { factor?: unknown } | null)?.factor;
    if (typeof factor === 'number' && ZOOM_FACTORS.includes(factor)) return factor;
  } catch {}
  return 1;
}

export function writeZoom(file: string, factor: number): void {
  replaceFile(file, JSON.stringify({ factor }));
}

export type ThemeSource = Parameters<DesktopBridge['setThemeSource']>[0];
export const THEME_SOURCES: readonly ThemeSource[] = ['system', 'light', 'dark'];

/** The saved theme source; 'system' when the file is missing, unreadable or names another. */
export function readThemeSource(file: string): ThemeSource {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const source = (value as { source?: unknown } | null)?.source;
    const known = THEME_SOURCES.find((choice) => choice === source);
    if (known) return known;
  } catch {}
  return 'system';
}

export function writeThemeSource(file: string, source: ThemeSource): void {
  replaceFile(file, JSON.stringify({ source }));
}

/** The page's --bg in the light and dark themes of apps/web/src/index.css. */
export const WINDOW_BACKGROUND = { light: '#F3F3F1', dark: '#0E0E0D' } as const;

export type ZoomStep = 'reset' | 'in' | 'out';

/** The factor a view-menu zoom moves to; the ends of ZOOM_FACTORS stay put. */
export function nextZoom(current: number, step: ZoomStep): number {
  if (step === 'reset') return 1;
  if (step === 'in') return ZOOM_FACTORS.find((factor) => factor > current) ?? current;
  return ZOOM_FACTORS.findLast((factor) => factor < current) ?? current;
}

/** The saved bounds when their title bar lies in a work area, else the saved size centred on the primary one; the size never exceeds the work area. */
export function placeWindow(
  state: WindowState,
  workAreas: Rectangle[],
  primary: Rectangle,
): Rectangle {
  const { x, y } = state;
  if (x !== undefined && y !== undefined) {
    for (const area of workAreas) {
      const width = Math.min(state.width, area.width);
      const height = Math.min(state.height, area.height);
      // The top 44 px band is the title bar the user drags the window by.
      const titleBarInside =
        x >= area.x &&
        y >= area.y &&
        x + width <= area.x + area.width &&
        y + 44 <= area.y + area.height;
      if (titleBarInside)
        return { x, y: Math.min(y, area.y + area.height - height), width, height };
    }
  }
  const width = Math.min(state.width, primary.width);
  const height = Math.min(state.height, primary.height);
  return {
    x: primary.x + Math.round((primary.width - width) / 2),
    y: primary.y + Math.round((primary.height - height) / 2),
    width,
    height,
  };
}

export const MINI_WINDOW = { width: 360, height: 40 } as const;

/** The mini window's place saved after the user dragged it; null unless x and y are integers. */
export function readMiniPlace(value: unknown): { x: number; y: number } | null {
  if (typeof value !== 'object' || value === null) return null;
  const { x, y } = value as Record<string, unknown>;
  return Number.isInteger(x) && Number.isInteger(y) ? { x: x as number, y: y as number } : null;
}

/** The saved place when the whole bar lies in a work area, else 16 px in from the primary one's bottom right corner. */
export function placeMiniWindow(
  saved: { x: number; y: number } | null,
  workAreas: Rectangle[],
  primary: Rectangle,
): Rectangle {
  const { width, height } = MINI_WINDOW;
  const inside = (area: Rectangle) =>
    saved !== null &&
    saved.x >= area.x &&
    saved.y >= area.y &&
    saved.x + width <= area.x + area.width &&
    saved.y + height <= area.y + area.height;
  if (saved !== null && workAreas.some(inside)) return { ...saved, width, height };
  return {
    x: primary.x + primary.width - width - 16,
    y: primary.y + primary.height - height - 16,
    width,
    height,
  };
}

/**
 * The top bar's --sf and --tx in the light and dark themes of apps/web/src/index.css, and its height;
 * they stand in until the page reports its own.
 */
export const titleBarOverlay = (dark: boolean): TitleBarOverlay => ({
  color: dark ? '#171716' : '#FFFFFF',
  symbolColor: dark ? '#EDEDE9' : '#1A1A18',
  height: 44,
});

export type WindowColours = Parameters<DesktopBridge['setTitleBarTheme']>[0];

const isHex = (value: unknown): value is string =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

/** The colours a page reports; null unless dark is a boolean and each colour is #rrggbb. */
export function readWindowColours(value: unknown): WindowColours | null {
  if (typeof value !== 'object' || value === null) return null;
  const { dark, color, symbolColor, background } = value as Record<string, unknown>;
  if (typeof dark !== 'boolean' || !isHex(color) || !isHex(symbolColor) || !isHex(background))
    return null;
  return { dark, color, symbolColor, background };
}

/**
 * The renderer's top bar is the title bar: macOS insets its buttons, elsewhere the system draws them at its right end
 * in the overlay's colours and the page's menu button stands in for the menu bar.
 */
export const windowChrome = (
  platform: NodeJS.Platform,
  overlay: TitleBarOverlay,
): Pick<
  BrowserWindowConstructorOptions,
  'titleBarStyle' | 'trafficLightPosition' | 'titleBarOverlay' | 'autoHideMenuBar'
> =>
  platform === 'darwin'
    ? // The title bar's height (52 px) centres these buttons.
      { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 20 } }
    : { titleBarStyle: 'hidden', titleBarOverlay: overlay, autoHideMenuBar: true };

/** run happens ms after the last schedule; flush runs a pending or fresh call at once. */
export function debounced(run: () => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    schedule(): void {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        run();
      }, ms);
    },
    flush(): void {
      clearTimeout(timer);
      timer = undefined;
      run();
    },
  };
}

/** Holds one blocker against app suspension while enabled and a session runs; releases it otherwise. */
export function sleepGuard(blocker: Pick<PowerSaveBlocker, 'start' | 'stop'>) {
  let id: number | undefined;
  return ({ enabled, running }: { enabled: boolean; running: number }): void => {
    const hold = enabled && running > 0;
    if (hold && id === undefined) id = blocker.start('prevent-app-suspension');
    if (!hold && id !== undefined) {
      blocker.stop(id);
      id = undefined;
    }
  };
}

/** A macOS app keeps running with no window until the user quits it. */
export const quitsWhenAllWindowsClosed = (platform: NodeJS.Platform): boolean =>
  platform !== 'darwin';

/** A crash within 10 s of a reload draws only the crash page; one within 10 s of that gives up. */
export const crashRecovery = (
  last: { at: number; recovery: 'reload' | 'crash-page' } | undefined,
  now: number,
): 'reload' | 'crash-page' | 'give-up' =>
  last === undefined || now - last.at >= 10_000
    ? 'reload'
    : last.recovery === 'reload'
      ? 'crash-page'
      : 'give-up';

/** The keys of the menu items the user may rebind, the renderer's defaults until it sends its own. */
const DEFAULT_ACCELERATORS: Partial<Record<MenuAction, string>> = {
  'new-session': 'CmdOrCtrl+N',
  'open-project': 'CmdOrCtrl+O',
  settings: 'CmdOrCtrl+,',
  search: 'CmdOrCtrl+K',
  'toggle-sidebar': 'CmdOrCtrl+B',
  'toggle-details': 'CmdOrCtrl+Alt+B',
  'toggle-overview': 'CmdOrCtrl+I',
  back: 'CmdOrCtrl+[',
  forward: 'CmdOrCtrl+]',
};
const MENU_ACTIONS = Object.keys(DEFAULT_ACCELERATORS) as MenuAction[];
const ACCELERATOR_MODIFIERS: Record<string, string> = {
  Control: 'Ctrl',
  Meta: 'CmdOrCtrl',
  Alt: 'Alt',
  Shift: 'Shift',
};
const ACCELERATOR_KEYS: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Enter: 'Enter',
  Escape: 'Escape',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Space: 'Space',
  Insert: 'Insert',
  CapsLock: 'Capslock',
  NumLock: 'Numlock',
  ScrollLock: 'Scrolllock',
  PrintScreen: 'PrintScreen',
  AudioVolumeUp: 'VolumeUp',
  AudioVolumeDown: 'VolumeDown',
  AudioVolumeMute: 'VolumeMute',
  MediaTrackNext: 'MediaNextTrack',
  MediaTrackPrevious: 'MediaPreviousTrack',
  MediaStop: 'MediaStop',
  MediaPlayPause: 'MediaPlayPause',
};

/** The accelerator for keys in aria-keyshortcuts notation; null unless they hold Meta, Control or Alt and one key. */
function accelerator(keys: string): string | null {
  const parts = keys.split('+');
  const key = parts.pop()!;
  const mods = parts.map((part) => ACCELERATOR_MODIFIERS[part]);
  if (mods.some((mod) => mod === undefined) || new Set(mods).size !== mods.length) return null;
  if (!parts.some((part) => part !== 'Shift')) return null;
  const name =
    ACCELERATOR_KEYS[key] ??
    (/^F([1-9]|1[0-9]|2[0-4])$/.test(key) ? key : /^[!-~]$/.test(key) ? key.toUpperCase() : null);
  return name === null ? null : [...mods, name].join('+');
}

/** The menu's accelerators for the keys the renderer sent, leaving out entries that are not a menu action and its keys; null unless value is an object. */
export function readMenuShortcuts(value: unknown): Partial<Record<MenuAction, string>> | null {
  if (typeof value !== 'object' || value === null) return null;
  const accelerators: Partial<Record<MenuAction, string>> = {};
  for (const [action, keys] of Object.entries(value)) {
    if (!MENU_ACTIONS.includes(action as MenuAction) || typeof keys !== 'string') continue;
    const made = accelerator(keys);
    if (made !== null) accelerators[action as MenuAction] = made;
  }
  return accelerators;
}

const isId = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** The session or project the renderer asked a window for; null unless its ids are non-empty strings. */
export function readWindowRequest(value: unknown): WindowRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const { kind, project_id, session_id } = value as Record<string, unknown>;
  if (kind === 'session' && isId(project_id) && isId(session_id))
    return { kind, project_id, session_id };
  if (kind === 'project' && isId(project_id)) return { kind, project_id };
  return null;
}

/** The place the renderer asked the main window for; null unless its ids are strings, the project's non-empty. A session id '' asks for the new-session composer. */
export function readWindowPlace(value: unknown): WindowPlace | null {
  if (typeof value !== 'object' || value === null) return null;
  const { project_id, session_id } = value as Record<string, unknown>;
  if (!isId(project_id)) return null;
  if (session_id === undefined) return { project_id };
  return isId(session_id) || session_id === '' ? { project_id, session_id } : null;
}

const LAUNCH_FLAGS = { '--new-session': 'new-session', '--open-project': 'open-project' } as const;

/** The menu action a jump list task's flag asks a second launch for; null without one. */
export function launchAction(argv: readonly string[]): MenuAction | null {
  const flag = argv.find((arg): arg is keyof typeof LAUNCH_FLAGS =>
    Object.hasOwn(LAUNCH_FLAGS, arg),
  );
  return flag ? LAUNCH_FLAGS[flag] : null;
}

/** What a pantheon:// link opens. */
export type PantheonLink =
  | { kind: 'session'; project_id: string; session_id: string }
  | { kind: 'project'; project_id: string }
  | { kind: 'new-session' };

/** The session, project or new session a pantheon:// link names; null for any other text. */
export function readLink(text: string): PantheonLink | null {
  try {
    const url = new URL(text);
    if (url.protocol !== 'pantheon:') return null;
    const path = url.pathname.replace(/\/$/, '');
    const ids = path === '' ? [] : path.slice(1).split('/').map(decodeURIComponent);
    if (ids.some((id) => id === '')) return null;
    const [project_id, session_id] = ids;
    if (url.host === 'session' && ids.length === 2)
      return { kind: 'session', project_id: project_id!, session_id: session_id! };
    if (url.host === 'project' && ids.length === 1)
      return { kind: 'project', project_id: project_id! };
    if (url.host === 'new-session' && ids.length === 0) return { kind: 'new-session' };
  } catch {
    // Not a URL, or an id that does not decode.
  }
  return null;
}

/** The system accent colour as #rrggbb from the RRGGBBAA the system gives; null for anything else. */
export const accentHex = (rgba: unknown): string | null =>
  typeof rgba === 'string' && /^[0-9a-f]{8}$/i.test(rgba)
    ? `#${rgba.slice(0, 6).toLowerCase()}`
    : null;

/** The Windows jump list tasks, each starting program with its flag; none outside a packaged Windows app. */
export function jumpListTasks(
  platform: NodeJS.Platform,
  packaged: boolean,
  program: string,
): Task[] {
  if (platform !== 'win32' || !packaged) return [];
  const text = menuText();
  return (Object.keys(LAUNCH_FLAGS) as (keyof typeof LAUNCH_FLAGS)[]).map((flag) => {
    const title = flag === '--new-session' ? text.newSession : text.openProject;
    return { program, arguments: flag, title, description: title, iconPath: program, iconIndex: 0 };
  });
}

/** The number beside the tray icon: the sessions waiting on the user, none at 0. */
export const trayTitle = (count: number): string => (count > 0 ? String(count) : '');

/** The mini window's menu item, checked while it is shown. */
export interface MiniWindowItem {
  shown: boolean;
  toggle: () => void;
}

const miniWindowItem = (mini: MiniWindowItem): MenuItemConstructorOptions => ({
  label: menuText().miniWindow,
  type: 'checkbox',
  checked: mini.shown,
  click: mini.toggle,
});

export function trayMenuTemplate(options: {
  name: string;
  reveal: () => void;
  send: (action: MenuAction) => void;
  quit: () => void;
  mini: MiniWindowItem;
}): MenuItemConstructorOptions[] {
  const { name, reveal, send, quit, mini } = options;
  const text = menuText();
  return [
    { label: text.openApp(name), click: reveal },
    {
      label: text.newSession,
      accelerator: 'CmdOrCtrl+N',
      registerAccelerator: false,
      click: () => send('new-session'),
    },
    {
      label: text.settings,
      accelerator: 'CmdOrCtrl+,',
      registerAccelerator: false,
      click: () => send('settings'),
    },
    { type: 'separator' },
    miniWindowItem(mini),
    { type: 'separator' },
    { label: text.quit(name), accelerator: 'CmdOrCtrl+Q', registerAccelerator: false, click: quit },
  ];
}

export interface AppMenuOptions {
  platform: NodeJS.Platform;
  name: string;
  dev: boolean;
  send: (action: MenuAction) => void;
  zoom: (step: ZoomStep) => void;
  newWindow: () => void;
  openLogs: () => void;
  /** Writes the `pantheon` launcher; a development build leaves it out of the menu. */
  installCli?: () => void;
  /** Shows the native About panel; the macOS menu reaches it through the about role. */
  about: () => void;
  mini: MiniWindowItem;
  /** The accelerators readMenuShortcuts made; an action left out keeps its default. */
  accelerators?: Partial<Record<MenuAction, string>>;
}

const separator: MenuItemConstructorOptions = { type: 'separator' };

/** The View menu; the full-screen item is the platform's own. */
function viewMenu(
  options: AppMenuOptions,
  action: (label: string, action: MenuAction) => MenuItemConstructorOptions,
  fullScreen: MenuItemConstructorOptions,
): MenuItemConstructorOptions {
  const { dev, zoom } = options;
  const text = menuText();
  return {
    label: text.view,
    submenu: [
      action(text.toggleSidebar, 'toggle-sidebar'),
      action(text.showDetails, 'toggle-details'),
      action(text.showOverview, 'toggle-overview'),
      separator,
      action(text.back, 'back'),
      action(text.forward, 'forward'),
      separator,
      { label: text.actualSize, accelerator: 'CmdOrCtrl+0', click: () => zoom('reset') },
      { label: text.zoomIn, accelerator: 'CmdOrCtrl+Plus', click: () => zoom('in') },
      { label: text.zoomOut, accelerator: 'CmdOrCtrl+-', click: () => zoom('out') },
      separator,
      fullScreen,
      ...(dev
        ? [
            separator,
            { role: 'reload', label: text.reload } as const,
            { role: 'toggleDevTools', label: text.toggleDevTools } as const,
          ]
        : []),
    ],
  };
}

/** The menu bar on macOS, in the order of Apple's guidelines; elsewhere the menu the title bar's menu button pops up. */
export function appMenuTemplate(options: AppMenuOptions): MenuItemConstructorOptions[] {
  const {
    platform,
    name,
    send,
    newWindow,
    openLogs,
    installCli,
    about,
    mini,
    accelerators = {},
  } = options;
  const text = menuText();
  const action = (label: string, action: MenuAction): MenuItemConstructorOptions => ({
    label,
    accelerator: accelerators[action] ?? DEFAULT_ACCELERATORS[action],
    click: () => send(action),
  });
  const newWindowItem = {
    label: text.newWindow,
    accelerator: 'CmdOrCtrl+Shift+N',
    click: newWindow,
  };
  const closeItem = { role: 'close', label: text.closeWindow, accelerator: 'CmdOrCtrl+W' } as const;
  const cliItems: MenuItemConstructorOptions[] = installCli
    ? [{ label: text.installCli, click: installCli }]
    : [];
  const helpItems: MenuItemConstructorOptions[] = [
    action(text.keyboardShortcuts, 'shortcuts'),
    separator,
    { label: text.openLogs, click: openLogs },
    { label: text.copyDiagnostics, click: () => send('copy-diagnostics') },
  ];
  if (platform === 'darwin')
    return [
      {
        label: name,
        submenu: [
          { role: 'about', label: text.about(name) },
          separator,
          action(text.settings, 'settings'),
          ...cliItems,
          separator,
          { role: 'services', label: text.services },
          separator,
          { role: 'hide', label: text.hide(name) },
          { role: 'hideOthers', label: text.hideOthers },
          { role: 'unhide', label: text.showAll },
          separator,
          { role: 'quit', label: text.quit(name) },
        ],
      },
      {
        label: text.file,
        submenu: [
          action(text.newSession, 'new-session'),
          action(text.openProject, 'open-project'),
          {
            role: 'recentDocuments',
            label: text.openRecent,
            submenu: [{ role: 'clearRecentDocuments', label: text.clearMenu }],
          },
          newWindowItem,
          separator,
          closeItem,
        ],
      },
      {
        label: text.edit,
        submenu: [
          { role: 'undo', label: text.undo },
          { role: 'redo', label: text.redo },
          separator,
          { role: 'cut', label: text.cut },
          { role: 'copy', label: text.copy },
          { role: 'paste', label: text.paste },
          { role: 'pasteAndMatchStyle', label: text.pasteAndMatchStyle },
          { role: 'delete', label: text.delete },
          { role: 'selectAll', label: text.selectAll },
          separator,
          action(text.find, 'search'),
          separator,
          {
            label: text.speech,
            submenu: [
              { role: 'startSpeaking', label: text.startSpeaking },
              { role: 'stopSpeaking', label: text.stopSpeaking },
            ],
          },
        ],
      },
      viewMenu(options, action, { role: 'togglefullscreen', label: text.enterFullScreen }),
      {
        role: 'window',
        label: text.window,
        submenu: [
          { role: 'minimize', label: text.minimize },
          { role: 'zoom', label: text.zoom },
          separator,
          miniWindowItem(mini),
          separator,
          { role: 'front', label: text.front },
        ],
      },
      { role: 'help', label: text.help, submenu: helpItems },
    ];
  return [
    {
      label: text.file,
      submenu: [
        action(text.newSession, 'new-session'),
        action(text.openProject, 'open-project'),
        newWindowItem,
        separator,
        action(text.settings, 'settings'),
        ...cliItems,
        separator,
        closeItem,
        { role: 'quit', label: text.exit },
      ],
    },
    {
      label: text.edit,
      submenu: [
        { role: 'undo', label: text.undo },
        { role: 'redo', label: text.redo },
        separator,
        { role: 'cut', label: text.cut },
        { role: 'copy', label: text.copy },
        { role: 'paste', label: text.paste },
        { role: 'delete', label: text.delete },
        separator,
        { role: 'selectAll', label: text.selectAll },
        separator,
        action(text.find, 'search'),
      ],
    },
    viewMenu(options, action, { role: 'togglefullscreen', label: text.fullScreen }),
    {
      label: text.window,
      submenu: [{ role: 'minimize', label: text.minimize }, separator, miniWindowItem(mini)],
    },
    {
      label: text.help,
      submenu: [...helpItems, separator, { label: text.about(name), click: about }],
    },
  ];
}
