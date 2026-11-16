import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  BridgeResult,
  DesktopBridge,
  EventFrame,
  MenuAction,
  NotificationTarget,
  TerminalFrame,
} from '@pantheon/protocol';

type WindowContext = ReturnType<DesktopBridge['windowContext']>;
type WindowPlace = Parameters<DesktopBridge['showInMainWindow']>[0];

/** What the main process put in the window's query; no query is the main window. */
function windowContext(): WindowContext {
  const query = new URLSearchParams(location.search);
  const kind = query.get('kind');
  const project_id = query.get('project_id') ?? '';
  if (kind === 'session') return { kind, project_id, session_id: query.get('session_id') ?? '' };
  if (kind === 'project') return { kind, project_id };
  if (kind === 'popover') return { kind };
  if (kind === 'mini') return { kind };
  return { kind: 'main' };
}

let nextId = 0;
const listeners = new Map<number, (frame: EventFrame) => void>();
ipcRenderer.on('pantheon:event', (_event, id: number, frame: EventFrame) => {
  listeners.get(id)?.(frame);
  if (frame.type === 'closed') listeners.delete(id);
});
const terminalListeners = new Map<number, (frame: TerminalFrame) => void>();
ipcRenderer.on('pantheon:terminal', (_event, id: number, frame: TerminalFrame) =>
  terminalListeners.get(id)?.(frame),
);

// A notification clicked while no window was open arrives before the page listens; it waits here.
let clickListener: ((target: NotificationTarget) => void) | undefined;
let unclaimedClick: NotificationTarget | undefined;
ipcRenderer.on('pantheon:notification-click', (_event, target: NotificationTarget) => {
  if (clickListener) clickListener(target);
  else unclaimedClick = target;
});

// A place sent to a main window that just opened arrives before the page listens; it waits here.
const placeListeners = new Set<(place: WindowPlace) => void>();
let unclaimedPlace: WindowPlace | undefined;
ipcRenderer.on('pantheon:show-in-main', (_event, place: WindowPlace) => {
  if (placeListeners.size === 0) unclaimedPlace = place;
  else for (const listener of placeListeners) listener(place);
});

// Only the last recognition started from this page has a listener.
type VoiceListener = Parameters<DesktopBridge['voiceStart']>[1];
let voiceListener: VoiceListener | undefined;
ipcRenderer.on('pantheon:voice', (_event, voiceEvent: Parameters<VoiceListener>[0]) =>
  voiceListener?.(voiceEvent),
);

async function invokeShell(channel: string, ...args: unknown[]): Promise<void> {
  const result: BridgeResult<null> = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error.message);
}

async function invokeValue<T>(channel: string): Promise<T> {
  const result: BridgeResult<T> = await ipcRenderer.invoke(channel);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const bridge: DesktopBridge = {
  appInfo: () => invokeValue('pantheon:appInfo'),
  logsDir: () => invokeValue('pantheon:logsDir'),
  lastCrash: () => invokeValue('pantheon:lastCrash'),
  // The page chooses the crash page before it first renders.
  crashPage: ipcRenderer.sendSync('pantheon:crashPage'),
  exportDiagnostics: () => ipcRenderer.invoke('pantheon:exportDiagnostics'),
  daemonStarting: () => invokeValue('pantheon:daemonStarting'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  daemon: () => ipcRenderer.invoke('pantheon:daemon'),
  command: (command) => ipcRenderer.invoke('pantheon:command', command),
  query: (method, params) => ipcRenderer.invoke('pantheon:query', method, params),
  subscribe(options, listener) {
    const id = ++nextId;
    listeners.set(id, listener);
    ipcRenderer.send('pantheon:subscribe', id, options);
    return () => ipcRenderer.send('pantheon:unsubscribe', id);
  },
  terminalSubscribe(terminal_id, listener) {
    const id = ++nextId;
    terminalListeners.set(id, listener);
    ipcRenderer.send('pantheon:terminalSubscribe', id, terminal_id);
    return () => {
      terminalListeners.delete(id);
      ipcRenderer.send('pantheon:terminalUnsubscribe', id);
    };
  },
  chooseDirectories: () => ipcRenderer.invoke('pantheon:chooseDirectories'),
  browseDirectory: (path) => ipcRenderer.invoke('pantheon:browseDirectory', path),
  chooseFiles: (project_id) => ipcRenderer.invoke('pantheon:chooseFiles', project_id),
  attachFile: (project_id, name, mime, bytes) =>
    ipcRenderer.invoke('pantheon:attachFile', project_id, name, mime, bytes),
  listWindowSnapshots: () => ipcRenderer.invoke('pantheon:listWindowSnapshots'),
  snapshotWindow: (project_id, id) => ipcRenderer.invoke('pantheon:snapshotWindow', project_id, id),
  openInTerminal: (workspace_id) => ipcRenderer.invoke('pantheon:openInTerminal', workspace_id),
  openInEditor: (workspace_id) => ipcRenderer.invoke('pantheon:openInEditor', workspace_id),
  editors: () => ipcRenderer.invoke('pantheon:editors'),
  chooseEditor: (id) => ipcRenderer.invoke('pantheon:chooseEditor', id),
  terminals: () => ipcRenderer.invoke('pantheon:terminals'),
  chooseTerminal: (id) => ipcRenderer.invoke('pantheon:chooseTerminal', id),
  listBrowsers: () => ipcRenderer.invoke('pantheon:listBrowsers'),
  chooseBrowser: (id) => ipcRenderer.invoke('pantheon:chooseBrowser', id),
  chosenBrowser: () => ipcRenderer.invoke('pantheon:chosenBrowser'),
  browserOpen: (input) => ipcRenderer.invoke('pantheon:browserOpen', input),
  browserNavigate: (input) => ipcRenderer.invoke('pantheon:browserNavigate', input),
  browserBack: (input) => ipcRenderer.invoke('pantheon:browserBack', input),
  browserForward: (input) => ipcRenderer.invoke('pantheon:browserForward', input),
  browserReload: (input) => ipcRenderer.invoke('pantheon:browserReload', input),
  browserSetBounds: (input) => ipcRenderer.invoke('pantheon:browserSetBounds', input),
  browserClose: (input) => ipcRenderer.invoke('pantheon:browserClose', input),
  browserRead: (input) => ipcRenderer.invoke('pantheon:browserRead', input),
  browserCapture: (input) => ipcRenderer.invoke('pantheon:browserCapture', input),
  onBrowserState(listener) {
    const relay = (_event: unknown, state: Parameters<typeof listener>[0]) => listener(state);
    ipcRenderer.on('pantheon:browser-state', relay);
    return () => ipcRenderer.removeListener('pantheon:browser-state', relay);
  },
  visualServe: (input) => ipcRenderer.invoke('pantheon:visualServe', input),
  appServe: (input) => ipcRenderer.invoke('pantheon:appServe', input),
  appRelease: (url) => ipcRenderer.invoke('pantheon:appRelease', url),
  openLink: (url) => ipcRenderer.invoke('pantheon:openLink', url),
  openFile: (ref, editorId) => ipcRenderer.invoke('pantheon:openFile', ref, editorId),
  fileMenu: (ref) => ipcRenderer.invoke('pantheon:fileMenu', ref),
  revealPath: (path) => ipcRenderer.invoke('pantheon:revealPath', path),
  notify: (input) => ipcRenderer.invoke('pantheon:notify', input),
  setBadge: (count, waiting) => ipcRenderer.invoke('pantheon:badge', count, waiting),
  keepAwake: (input) => ipcRenderer.invoke('pantheon:keepAwake', input),
  zoomFactor: (factor) => ipcRenderer.invoke('pantheon:zoomFactor', factor),
  setMenuShortcuts: (keys) => ipcRenderer.invoke('pantheon:setMenuShortcuts', keys),
  popupAppMenu: (x, y) => ipcRenderer.invoke('pantheon:popupAppMenu', x, y),
  async popupMenu(items) {
    const result: BridgeResult<string | null> = await ipcRenderer.invoke(
      'pantheon:popupMenu',
      items,
    );
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  },
  setTitleBarTheme: (colours) => ipcRenderer.invoke('pantheon:setTitleBarTheme', colours),
  setThemeSource: (source) => ipcRenderer.send('pantheon:setThemeSource', source),
  ready: () => ipcRenderer.send('pantheon:ready'),
  onMenuAction(listener) {
    const relay = (_event: unknown, action: MenuAction) => listener(action);
    ipcRenderer.on('pantheon:menu', relay);
    return () => ipcRenderer.removeListener('pantheon:menu', relay);
  },
  onNotificationClick(listener) {
    clickListener = listener;
    const target = unclaimedClick;
    unclaimedClick = undefined;
    if (target) listener(target);
    return () => {
      if (clickListener === listener) clickListener = undefined;
    };
  },
  runtimeLogin: (runtime) => ipcRenderer.invoke('pantheon:runtimeLogin', runtime),
  // The page picks its language before it first renders.
  locale: ipcRenderer.sendSync('pantheon:locale'),
  setLocale: (choice) => ipcRenderer.invoke('pantheon:setLocale', choice),
  openWindow: (request) => ipcRenderer.invoke('pantheon:openWindow', request),
  windowContext,
  showInMainWindow: (place) => ipcRenderer.invoke('pantheon:showInMainWindow', place),
  onShowInMainWindow(listener) {
    placeListeners.add(listener);
    const place = unclaimedPlace;
    unclaimedPlace = undefined;
    if (place) listener(place);
    return () => placeListeners.delete(listener);
  },
  onNewWindowRequest(listener) {
    const relay = () => listener();
    ipcRenderer.on('pantheon:new-window', relay);
    return () => ipcRenderer.removeListener('pantheon:new-window', relay);
  },
  onQuitRequest(listener) {
    const relay = () => listener();
    ipcRenderer.on('pantheon:quit-request', relay);
    return () => ipcRenderer.removeListener('pantheon:quit-request', relay);
  },
  confirmQuit: () => invokeShell('pantheon:confirmQuit'),
  askQuit: (question) => invokeShell('pantheon:askQuit', question),
  setPopoverHeight: (px) => invokeShell('pantheon:setPopoverHeight', px),
  revealMain: (action) => invokeShell('pantheon:revealMain', action),
  appFocused: () => invokeValue('pantheon:appFocused'),
  setAlwaysOnTop: (on) => ipcRenderer.invoke('pantheon:setAlwaysOnTop', on),
  setMiniWindow: (shown) => ipcRenderer.invoke('pantheon:setMiniWindow', shown),
  miniWindowShown: () => ipcRenderer.invoke('pantheon:miniWindowShown'),
  shellPrefs: () => ipcRenderer.invoke('pantheon:shellPrefs'),
  setShellPrefs: (patch) => ipcRenderer.invoke('pantheon:setShellPrefs', patch),
  voiceAvailable: () => ipcRenderer.invoke('pantheon:voiceAvailable'),
  voiceStart(locale, listener) {
    voiceListener = listener;
    ipcRenderer.send('pantheon:voiceStart', locale);
  },
  voiceStop: () => ipcRenderer.send('pantheon:voiceStop'),
  voiceCancel: () => ipcRenderer.send('pantheon:voiceCancel'),
  voiceRetry: () => ipcRenderer.send('pantheon:voiceRetry'),
  openPrivacySettings: (pane) => ipcRenderer.invoke('pantheon:openPrivacySettings', pane),
  chooseVoiceEngine: () => ipcRenderer.invoke('pantheon:chooseVoiceEngine'),
  addRecentProject: (root) => ipcRenderer.invoke('pantheon:addRecentProject', root),
  openAtLogin: () => ipcRenderer.invoke('pantheon:openAtLogin'),
  setOpenAtLogin: (on) => ipcRenderer.invoke('pantheon:setOpenAtLogin', on),
  systemAccent: () => invokeValue('pantheon:systemAccent'),
  onSystemAccent(listener) {
    const relay = (_event: unknown, accent: string | null) => listener(accent);
    ipcRenderer.on('pantheon:system-accent', relay);
    return () => ipcRenderer.removeListener('pantheon:system-accent', relay);
  },
};
contextBridge.exposeInMainWorld('pantheon', bridge);
