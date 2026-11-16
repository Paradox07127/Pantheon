import type {
  Event,
  Project,
  ProjectBrief,
  Milestone,
  Session,
  SessionTurn,
  Workspace,
} from '@pantheon/domain';
import type { AttachmentMeta, BrowserPage, Command } from './index.js';

/**
 * IPC results carry the daemon's error code, because a rejected ipcRenderer.invoke keeps only the message.
 * protocol_mismatch: the web and the daemon speak different protocol versions.
 */
export type BridgeResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: { code: string; message: string; status?: number; details?: Record<string, unknown> };
    };
export interface DaemonInfo {
  url: string;
  version: string;
  protocol_version: number;
  /** This app started the daemon process. */
  started_here: boolean;
  /** The daemon's data directory, which holds control.sqlite and the native session transcripts. */
  data_dir: string;
}
export interface AppInfo {
  version: string;
  electron: string;
  os: 'macos' | 'windows' | 'linux';
  os_version: string;
  arch: string;
}
export interface RendererCrash {
  reason: string;
  exit_code: number;
}
/** GET /v1/board; with project_id every table holds only that project's rows. */
export interface BoardSnapshot {
  cursor: number;
  projects: Project[];
  project_briefs?: ProjectBrief[];
  milestones?: Milestone[];
  sessions: Session[];
  session_turns: SessionTurn[];
  workspaces: Workspace[];
}
/** A session's browser tool call, which the desktop window answers with browser.result. */
export interface BrowserRequest {
  request_id: string;
  session_id: string;
  action: 'open' | 'read' | 'screenshot';
  /** The page to open; only for open. */
  url?: string;
}
/** The frames of /v1/events/ws as the daemon sends them, plus 'closed' when the socket ends. */
export type EventFrame =
  | { type: 'subscribed'; cursor: number }
  | { type: 'event'; event: Event }
  | { type: 'snapshot_required'; cursor: number }
  | { type: 'trace.changed'; revision: number }
  /** Sent only to the last subscription that asked to answer browser requests. */
  | { type: 'browser.request'; request: BrowserRequest }
  | { type: 'heartbeat'; cursor: number }
  | { type: 'closed'; code: number; reason: string };
/**
 * A terminal's output bytes, replay first, then one last frame: the exit code of its process,
 * or closed when the stream ended without one.
 */
export type TerminalFrame = { data: Uint8Array } | { exit: number } | { closed: true };
/** A file a model named; a relative path is looked up from base, then from the project's folders. */
export interface FileRef {
  path: string;
  line?: number;
  column?: number;
  base?: string;
}
/** An application menu item the renderer carries out. */
export type MenuAction =
  | 'new-session'
  | 'open-project'
  | 'settings'
  | 'about'
  | 'copy-diagnostics'
  | 'search'
  | 'toggle-sidebar'
  | 'toggle-details'
  | 'toggle-overview'
  | 'back'
  | 'forward'
  | 'shortcuts';
/** The session a notification is about. */
export interface NotificationTarget {
  project_id: string;
  session_id: string;
}
/** A session that waits for the user's answer, with its title as the sidebar shows it. */
export interface WaitingSession extends NotificationTarget {
  title: string;
}
/** An entry of a native menu a page pops up; picking an item hands back its id. */
export type PopupMenuItem =
  | { separator: true }
  | {
      id: string;
      label: string;
      enabled: boolean;
      checked?: boolean;
      danger?: boolean;
      /** Makes the item a submenu of these entries. */
      items?: PopupMenuItem[];
    };
/** What a window shows: the whole app, one project, one session, the tray popover, or the mini window. */
export interface WindowContext {
  kind: 'main' | 'session' | 'project' | 'popover' | 'mini';
  project_id?: string;
  session_id?: string;
}
/** The session or project to show in a window of its own. */
export type WindowRequest =
  | { kind: 'session'; project_id: string; session_id: string }
  | { kind: 'project'; project_id: string };
/** The project, and the session in it, the main window is asked to show. */
export interface WindowPlace {
  project_id: string;
  session_id?: string;
}
/** The drawings an app or menu bar icon may show. */
export type AppIconShape = 'pantheon' | 'monad' | 'sigma';
/** The colours an app icon may come in; the temple has only travertine, black and white. */
export type AppIconColour = 'travertine' | 'black' | 'white' | 'dusk' | 'terracotta' | 'lapis';
/** This machine's settings of the desktop shell. */
export interface ShellPrefs {
  /** Closing the main window only hides it, so the app and its sessions keep running. */
  keep_running_on_close: boolean;
  /** Shows an icon in the menu bar or system tray. */
  show_tray_icon: boolean;
  /** The drawing of the menu bar or system tray icon. */
  tray_icon: AppIconShape;
  /** The shape and colour of the icon the running app shows in the Dock or taskbar; the installed package's own icon is always pantheon-travertine. */
  app_icon: `${AppIconShape}-${AppIconColour}`;
  /** Offers voice input in the composer. */
  voice_input: boolean;
  /**
   * The absolute path of a voice engine executable to use; null is the built-in engine.
   * Only chooseVoiceEngine sets a path: the shell runs this file, so a page may only clear it to null.
   */
  voice_engine: string | null;
  /** Shows the mini window, a bar kept above other apps' windows; only setMiniWindow sets it. */
  mini_window: boolean;
}
/** One line a voice engine writes; final and error end the recognition. */
export type VoiceEvent =
  | { type: 'preparing'; progress?: number }
  | { type: 'ready' }
  | { type: 'level'; value: number }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | {
      type: 'error';
      code: 'microphone_denied' | 'speech_denied' | 'unavailable' | 'failed';
      message: string;
    };
/** The page zooms the appearance settings offer. */
export const ZOOM_FACTORS: readonly number[] = [0.9, 1, 1.1, 1.25];

/** The interface languages; 'system' follows the preferred languages of the system or browser. */
export type UiLocale = 'en' | 'zh-CN';
export type UiLocaleChoice = 'system' | UiLocale;
export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface BrowserState {
  id: string;
  url: string;
  title: string;
  can_go_back: boolean;
  can_go_forward: boolean;
  loading: boolean;
}
/** A window of another app that a snapshot can capture. */
export interface WindowSnapshotSource {
  id: string;
  /** The window's title, or its app's name when it has none. */
  name: string;
  /** A small PNG of the window as a data URL. */
  thumbnail: string;
}
export interface DesktopBridge {
  /** The saved language choice and the language it resolves to, read before the page renders. */
  locale: { choice: UiLocaleChoice; resolved: UiLocale };
  /** Saves the choice, rebuilds the menus and reloads the window. */
  setLocale(choice: UiLocaleChoice): Promise<unknown>;
  appInfo(): Promise<AppInfo>;
  /** The absolute path of the folder holding the daemon log. */
  logsDir(): Promise<string>;
  /** This window's last renderer crash, consumed by the first call after it. */
  lastCrash(): Promise<RendererCrash | null>;
  /** The crash after which the app loaded this page to draw only the crash page, read before the page renders. */
  crashPage: RendererCrash | null;
  /** Asks where to save in a system dialog and writes the log folder's files there as one text file; null when the user cancels. */
  exportDiagnostics(): Promise<BridgeResult<string | null>>;
  /** Whether the app is starting the daemon process and waiting for it to come up. */
  daemonStarting(): Promise<boolean>;
  /** The absolute path of a dropped file or folder, obtained without IPC. */
  pathForFile(file: File): string;
  daemon(): Promise<BridgeResult<DaemonInfo>>;
  command(command: Command): Promise<BridgeResult<unknown>>;
  /** GET /v1/<method>; method matches /^[a-z][a-z.]*$/. A list repeats its parameter. */
  query(method: string, params?: Record<string, string | string[]>): Promise<BridgeResult<unknown>>;
  /** Returns the function that ends the subscription; browser asks for the browser.request frames. */
  subscribe(
    options: { cursor?: number; project_id?: string; browser?: boolean },
    listener: (frame: EventFrame) => void,
  ): () => void;
  /** Streams a terminal opened with terminal.open; the returned function ends it and leaves the terminal running. */
  terminalSubscribe(terminal_id: string, listener: (frame: TerminalFrame) => void): () => void;
  /** Every folder picked; empty when the user cancels the dialog. */
  chooseDirectories(): Promise<BridgeResult<string[]>>;
  /**
   * The folders in a folder (`~` is home), visible ones first, each sorted by name, at most 2000;
   * fails with not_a_directory when the path is no existing folder.
   */
  browseDirectory(path: string): Promise<
    BridgeResult<{
      path: string;
      parent: string | null;
      entries: { name: string; path: string; hidden: boolean }[];
    }>
  >;
  /** Uploads the files the user picks as attachments of the project; empty when the user cancels. */
  chooseFiles(project_id: string): Promise<BridgeResult<AttachmentMeta[]>>;
  /** Uploads bytes the renderer holds, such as a pasted image, as an attachment of the project. */
  attachFile(
    project_id: string,
    name: string,
    mime: string,
    bytes: Uint8Array,
  ): Promise<BridgeResult<AttachmentMeta>>;
  /**
   * The windows of other apps, each with a thumbnail; permission is denied, with no windows, while
   * macOS withholds screen recording from the app.
   */
  listWindowSnapshots(): Promise<
    BridgeResult<{ permission: 'granted' | 'denied'; windows: WindowSnapshotSource[] }>
  >;
  /** Captures the window at full size and uploads it as a PNG attachment of the project. */
  snapshotWindow(project_id: string, id: string): Promise<BridgeResult<AttachmentMeta>>;
  openInTerminal(workspace_id: string): Promise<BridgeResult<null>>;
  openInEditor(workspace_id: string): Promise<BridgeResult<null>>;
  /** Installed editors; selected is null when none is installed. */
  editors(): Promise<
    BridgeResult<{ editors: { id: string; name: string }[]; selected: string | null }>
  >;
  /** Fails with editor_unavailable when id is not installed. */
  chooseEditor(id: string): Promise<BridgeResult<null>>;
  /** Installed terminals; selected is null when none is installed. */
  terminals(): Promise<
    BridgeResult<{ terminals: { id: string; name: string }[]; selected: string | null }>
  >;
  /** Fails with terminal_unavailable when id is not installed. */
  chooseTerminal(id: string): Promise<BridgeResult<null>>;
  listBrowsers(): Promise<BridgeResult<{ id: string; name: string; path: string }[]>>;
  /** Saves an installed browser id; null restores the system default. */
  chooseBrowser(id: string | null): Promise<BridgeResult<null>>;
  /** The saved browser id; null is the system default. */
  chosenBrowser(): Promise<BridgeResult<string | null>>;
  browserOpen(input: { url: string; bounds: BrowserBounds }): Promise<BridgeResult<{ id: string }>>;
  browserNavigate(input: { id: string; url: string }): Promise<BridgeResult<null>>;
  browserBack(input: { id: string }): Promise<BridgeResult<null>>;
  browserForward(input: { id: string }): Promise<BridgeResult<null>>;
  browserReload(input: { id: string }): Promise<BridgeResult<null>>;
  browserSetBounds(input: { id: string; bounds: BrowserBounds }): Promise<BridgeResult<null>>;
  browserClose(input: { id: string }): Promise<BridgeResult<null>>;
  /** The page's url, title and visible text, at most BROWSER_TEXT_LIMIT characters of it. */
  browserRead(input: { id: string }): Promise<BridgeResult<BrowserPage>>;
  /** The page's url, title and a PNG of it, scaled down to fit a command. */
  browserCapture(input: { id: string }): Promise<BridgeResult<BrowserPage>>;
  onBrowserState(listener: (state: BrowserState) => void): () => void;
  /** Serves the page offline; each https origin in hosts may then supply any kind of request. */
  visualServe(input: { html: string; hosts?: string[] }): Promise<BridgeResult<{ url: string }>>;
  /** Serves an MCP App page on its own pantheon-app origin with the policy built from csp; resolves to its URL. */
  appServe(input: {
    html: string;
    csp?: {
      connectDomains?: string[];
      resourceDomains?: string[];
      frameDomains?: string[];
      baseUriDomains?: string[];
    };
  }): Promise<BridgeResult<string>>;
  /** Drops an MCP App page this window served. */
  appRelease(url: string): Promise<BridgeResult<null>>;
  /** Opens an http, https or mailto link in the selected browser; else fails with link_refused. */
  openLink(url: string): Promise<BridgeResult<null>>;
  /** Opens a file inside the project's folders with editorId, or the selected editor. */
  openFile(ref: FileRef, editorId?: string): Promise<BridgeResult<null>>;
  /** Pops up the native menu of installed editors and Reveal in Finder for the file. */
  fileMenu(ref: FileRef): Promise<BridgeResult<null>>;
  /** Shows the file or folder at path selected in Finder. */
  revealPath(path: string): Promise<BridgeResult<null>>;
  /** Shows a system notification, without its sound when silent; clicking it brings the Pantheon window forward and hands target to onNotificationClick. */
  notify(input: {
    title: string;
    body: string;
    target?: NotificationTarget;
    silent?: boolean;
  }): Promise<void>;
  /**
   * Shows count on the dock icon and beside the tray icon, 0 clears it; the main window's page also
   * gives up to 5 sessions waiting for the user, which the macOS Dock menu lists.
   */
  setBadge(count: number, waiting?: WaitingSession[]): Promise<void>;
  /** Keeps the app from being suspended while enabled and running sessions are more than 0. */
  keepAwake(input: { enabled: boolean; running: number }): Promise<void>;
  /** Sets the page zoom to factor (0.9, 1, 1.1 or 1.25) and keeps it for this machine; returns the zoom now. */
  zoomFactor(factor?: number): Promise<BridgeResult<number>>;
  /** Rebuilds the application menu with these keys in aria-keyshortcuts notation; an action left out keeps its default. */
  setMenuShortcuts(keys: Partial<Record<MenuAction, string>>): Promise<BridgeResult<null>>;
  /**
   * Reports the page's scheme and its colours, each #rrggbb: color and symbolColor paint the window buttons
   * that Windows and Linux draw over the top bar, background fills every window before its page draws.
   */
  setTitleBarTheme(colours: {
    dark: boolean;
    color: string;
    symbolColor: string;
    background: string;
  }): Promise<BridgeResult<null>>;
  /** Tells the app which colours the page follows, for the window background and the native menus and dialogs. */
  setThemeSource(source: 'system' | 'light' | 'dark'): void;
  /** Tells the app that this window's first content has painted; a window the app kept hidden shows now. */
  ready(): void;
  /** Pops up the application menu in this window at x, y in the page's CSS pixels. */
  popupAppMenu(x: number, y: number): Promise<BridgeResult<null>>;
  /** Pops up a native menu of items at the pointer in this window; the id picked, or null when it closes without one. */
  popupMenu(items: PopupMenuItem[]): Promise<string | null>;
  /** Calls listener for each application menu item picked; returns the function that stops it. */
  onMenuAction(listener: (action: MenuAction) => void): () => void;
  /** Calls listener with the target of each notification clicked; returns the function that stops it. */
  onNotificationClick(listener: (target: NotificationTarget) => void): () => void;
  /** Runs the runtime's own login. */
  runtimeLogin(runtime: 'claude' | 'codex'): Promise<BridgeResult<void>>;
  /** Opens the session or project in a window of its own, or focuses the one already showing it. */
  openWindow(request: WindowRequest): Promise<BridgeResult<null>>;
  /** What this window shows, read from its page's query. */
  windowContext(): WindowContext;
  /** Shows and focuses the main window and hands place to its onShowInMainWindow. */
  showInMainWindow(place: WindowPlace): Promise<BridgeResult<null>>;
  /** Calls listener in the main window with each place showInMainWindow asks for; returns the function that stops it. */
  onShowInMainWindow(listener: (place: WindowPlace) => void): () => void;
  /** Calls listener in the main window when the menu's New Window asks it to open its current project in a project window; returns the function that stops it. */
  onNewWindowRequest(listener: () => void): () => void;
  /** Calls listener in the main window when the user requests quit; doing nothing cancels it. */
  onQuitRequest(listener: () => void): () => void;
  /** Quits after the main window confirms the request. */
  confirmQuit(): Promise<void>;
  /** Shows the main window and asks in a system message box whether to quit; quits when the user picks quit. */
  askQuit(question: {
    message: string;
    detail: string;
    quit: string;
    cancel: string;
  }): Promise<void>;
  /** Resizes the tray popover to 120–480 px; only the popover may call it. */
  setPopoverHeight(px: number): Promise<void>;
  /** Shows and focuses the main window, delivers an optional menu action, and hides the popover. */
  revealMain(action?: MenuAction): Promise<void>;
  /** Whether a Pantheon window other than the popover has focus. */
  appFocused(): Promise<boolean>;
  /** Keeps this window above other apps' windows, or stops. */
  setAlwaysOnTop(on: boolean): Promise<BridgeResult<null>>;
  /** Shows or closes the mini window and keeps the choice for this machine. */
  setMiniWindow(shown: boolean): Promise<BridgeResult<null>>;
  /** Whether the mini window is shown. */
  miniWindowShown(): Promise<BridgeResult<boolean>>;
  shellPrefs(): Promise<BridgeResult<ShellPrefs>>;
  /** Saves the settings given and applies them at once; returns all of them. */
  setShellPrefs(patch: Partial<ShellPrefs>): Promise<BridgeResult<ShellPrefs>>;
  /** Voice input is on and an engine is there: the one set, or the built-in one on macOS 26 and later. */
  voiceAvailable(): Promise<boolean>;
  /** Starts recognizing speech in locale, cancelling any recognition before it; listener gets its events. */
  voiceStart(locale: UiLocale, listener: (event: VoiceEvent) => void): void;
  /** Ends the recording; a final or an error event follows. */
  voiceStop(): void;
  /** Ends the recognition with no result. */
  voiceCancel(): void;
  /** Recognizes the last recording again after it ended in an error. */
  voiceRetry(): void;
  /** Opens the system settings page that allows the microphone, speech recognition or screen recording; macOS only. */
  openPrivacySettings(pane: 'microphone' | 'speech' | 'screen'): Promise<BridgeResult<null>>;
  /** The user picks an executable in a system dialog and it becomes the voice engine; null when the user cancels. */
  chooseVoiceEngine(): Promise<BridgeResult<string | null>>;
  /** Adds a project's root folder to the system's recent items: Open Recent on macOS, the jump list on Windows. */
  addRecentProject(root: string): Promise<BridgeResult<null>>;
  /** Whether the system opens the app when the user logs in; null where it keeps no login items for the app (Linux). */
  openAtLogin(): Promise<BridgeResult<boolean | null>>;
  /** Has the system open the app at login, or stop; returns whether it now does. */
  setOpenAtLogin(on: boolean): Promise<BridgeResult<boolean>>;
  /** The system accent colour as #rrggbb; null where the system has none. */
  systemAccent(): Promise<string | null>;
  /** Calls listener with the system accent colour whenever it may have changed; returns the function that stops it. */
  onSystemAccent(listener: (accent: string | null) => void): () => void;
}
