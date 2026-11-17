import './socket-tos.js';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, type Dirent } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  WebContentsView,
  protocol,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  Notification,
  powerMonitor,
  powerSaveBlocker,
  screen,
  nativeImage,
  session,
  shell,
  systemPreferences,
  Tray,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type Rectangle,
  type Size,
  type WebContents,
} from 'electron';
import {
  BROWSER_TEXT_LIMIT,
  ZOOM_FACTORS,
  type AppInfo,
  type AttachmentMeta,
  type BoardSnapshot,
  type BridgeResult,
  type BrowserBounds,
  type Command,
  type EventFrame,
  type FileRef,
  type MenuAction,
  type NotificationTarget,
  type PopupMenuItem,
  type RendererCrash,
  type RepoWorktree,
  type StaleWorkspaces,
  type WaitingSession,
} from '@pantheon/protocol';
import {
  attachmentLimit,
  attachmentMime,
  DaemonBridge,
  dataDirectory,
  packagedLaunch,
  userDataDirectory,
  type BridgeOptions,
} from './daemon.js';
import {
  applicationRoots,
  chooseEditor,
  commandEditors,
  listEditors,
  openWithEditor,
  pathLookup,
  scanEditors,
  selectedEditor,
  whereLookup,
  type Editor,
  type Lookup,
} from './editors.js';
import {
  LOCALE_CHOICES,
  menuText,
  resolveLocale,
  setMenuLocale,
  type LocaleChoice,
} from './locales.js';
import {
  editorCommand,
  editorLaunch,
  resolveFile,
  resolveWslFile,
  webLink,
  type Launch,
} from './open-target.js';
import {
  readLocale,
  readSettings,
  readShellPrefs,
  readShellPrefsPatch,
  replaceFile,
  saveChoice,
  saveShellPrefs,
} from './settings.js';
import { browserRoots, scanBrowsers } from './browsers.js';
import { visualHosts, VisualPages } from './visual.js';
import { AppPages } from './mcp-app.js';
import { shellPath } from './shell-env.js';
import { readVoiceLocale, VoiceRecognizer, type VoiceEvent } from './voice.js';
import {
  chooseTerminal,
  commandRuntimeLogin,
  commandTerminals,
  listTerminals,
  openWithTerminal,
  runtimeLogin,
  scanTerminals,
  selectedTerminal,
  terminalCommand,
  terminalRoots,
  terminalUnavailable,
  type Terminal,
} from './terminals.js';
import {
  accentHex,
  appMenuTemplate,
  crashRecovery,
  debounced,
  DEFAULT_WINDOW,
  jumpListTasks,
  launchAction,
  MINI_WINDOW,
  nextZoom,
  placeMiniWindow,
  placeWindow,
  quitsWhenAllWindowsClosed,
  readMenuShortcuts,
  readLink,
  readMiniPlace,
  readThemeSource,
  readWindowColours,
  readWindowPlace,
  readWindowRequest,
  readWindowState,
  readZoom,
  sleepGuard,
  THEME_SOURCES,
  titleBarOverlay,
  trayMenuTemplate,
  trayTitle,
  WINDOW_BACKGROUND,
  windowChrome,
  writeThemeSource,
  writeWindowState,
  writeZoom,
  type PantheonLink,
  type ThemeSource,
  type WindowColours,
  type WindowContext,
  type WindowRequest,
  type ZoomStep,
} from './window.js';
import {
  checkDistro,
  listDistros,
  runWsl,
  windowsPathFromWsl,
  wslPathFromWindows,
  wslUnavailable,
} from './wsl.js';

// Port 0 lets Chromium pick a free port and write it to DevToolsActivePort in userData; it must be set before ready.
// A port given on the command line (the acceptance runs) is kept.
if (!app.isPackaged && !app.commandLine.hasSwitch('remote-debugging-port'))
  app.commandLine.appendSwitch('remote-debugging-port', '0');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'pantheon-visual',
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  { scheme: 'pantheon-app', privileges: { standard: true, secure: true } },
]);

// Electron would otherwise use ~/Library/Application Support/Pantheon, the daemon's data directory.
app.setPath('userData', userDataDirectory(app.getPath('appData')));
// The lock follows userData, which a dev app shares, so only a packaged app takes it.
const primary = !app.isPackaged || app.requestSingleInstanceLock();
if (!primary) app.quit();
/** What links and folders opened before the main window was there ask for; run once it is. */
let started = false;
const startQueue: (() => void)[] = [];
const afterStart = (act: () => void): void => {
  if (started) act();
  else startQueue.push(act);
};
// Registered before ready: the link or folder that launches the app arrives before it.
app.on('open-url', (event, url) => {
  event.preventDefault();
  const link = readLink(url);
  if (link) afterStart(() => followLink(link));
});
app.on('open-file', (event, folder) => {
  event.preventDefault();
  afterStart(() => void openFolder(folder));
});
const settingsFile = path.join(app.getPath('userData'), 'settings.json');
const windowFile = path.join(app.getPath('userData'), 'window.json');
const zoomFile = path.join(app.getPath('userData'), 'zoom.json');
const themeFile = path.join(app.getPath('userData'), 'theme.json');

// Only Electron sets resourcesPath; a packaged app started from Finder lacks the login shell PATH.
const resources = app.isPackaged && primary ? process.resourcesPath : undefined;
/** The saved WSL distro, else the default WSL2 distro, else the first one. */
const wslDistro = async (): Promise<string | undefined> => {
  const { wslDistro: saved } = readSettings(settingsFile);
  if (typeof saved === 'string' && saved) return saved;
  const distros = await listDistros(runWsl).catch(() => []);
  return (distros.find((distro) => distro.isDefault) ?? distros[0])?.name;
};
// A Windows app runs the daemon in WSL; with no distro, the daemon reports itself unavailable.
const windowsResources = process.platform === 'win32' ? resources : undefined;
let distro = windowsResources ? await wslDistro() : undefined;
/** Why the daemon cannot run in the distro found, and how the bridge runs it there. */
const wslSetup = async (
  folder: string,
  found: string | undefined,
): Promise<Pick<BridgeOptions, 'unavailable' | 'wsl'>> => ({
  // A check that cannot run gives no reason; starting the daemon then reports what went wrong.
  unavailable: wslUnavailable(
    found,
    found === undefined
      ? []
      : await checkDistro(found, runWsl).then(
          (prerequisites) => prerequisites.missing,
          () => [],
        ),
  ),
  wsl:
    found === undefined
      ? undefined
      : {
          distro: found,
          runtimeArchive: path.join(folder, 'linux-runtime.tar.gz'),
          // The archive's time, so a new build of the same version unpacks again.
          runtimeVersion: `${app.getVersion()}+${Math.trunc((await stat(path.join(folder, 'linux-runtime.tar.gz'))).mtimeMs)}`,
          desktopDataDir: app.getPath('userData'),
        },
});
const wsl = windowsResources ? await wslSetup(windowsResources, distro) : undefined;
const logFile = path.join(app.getPath('userData'), 'logs/daemon.log');
const repoRoot = path.resolve(app.getAppPath(), '../..');
const bridge = new DaemonBridge({
  directory: dataDirectory(),
  packaged: app.isPackaged,
  repo: repoRoot,
  logFile,
  launch:
    resources && process.platform !== 'win32'
      ? packagedLaunch(
          resources,
          await shellPath(path.join(app.getPath('userData'), 'shell-env.json')),
        )
      : undefined,
  ...wsl,
  ...(app.isPackaged && { version: app.getVersion() }),
  // A distro installed or repaired after the start is found on the next connection.
  recheck: windowsResources
    ? async () => {
        distro = await wslDistro();
        desktop = distro !== undefined ? 'win32' : 'darwin';
        return wslSetup(windowsResources, distro);
      }
    : undefined,
});
/** Whose editors, terminals and paths to use; a Windows app with no distro keeps the macOS ones. */
let desktop: 'darwin' | 'linux' | 'win32' =
  process.platform === 'linux' ? 'linux' : distro !== undefined ? 'win32' : 'darwin';
const whereFound = whereLookup((file, args) =>
  execFileSync(file, args, { encoding: 'utf8', windowsHide: true }),
);
const lookup: Lookup = (command) =>
  (desktop === 'win32' ? whereFound : pathLookup(process.env.PATH))(command);
const editorRoots = (): string[] => (desktop === 'darwin' ? applicationRoots() : []);
const editorScan = (roots: string[]): Editor[] =>
  desktop === 'darwin' ? scanEditors(roots) : commandEditors(desktop, lookup);
const terminalScan = (roots: string[]): Terminal[] =>
  desktop === 'darwin' ? scanTerminals(roots) : commandTerminals(desktop, lookup);
/** The daemon's Linux path as one this process can open: through the distro's share on Windows. */
const local = (linuxPath: string): string =>
  distro === undefined ? linuxPath : windowsPathFromWsl(linuxPath, distro);
const stopWatchingBuilds = bridge.watchBuilds();
app.on('will-quit', stopWatchingBuilds);
/** Every open window and what it shows; there is at most one main window. */
const windows = new Map<BrowserWindow, WindowContext>();
const browsers = new Map<BrowserWindow, { id: string; view: WebContentsView }>();
const visuals = new VisualPages(path.join(import.meta.dirname, '../visual'));
const appPages = new AppPages();
const crashes = new WeakMap<BrowserWindow, RendererCrash>();
/** The crash of each window reloaded to draw only the crash page, until its page reads it. */
const crashPages = new WeakMap<BrowserWindow, RendererCrash>();
const mainWindow = (): BrowserWindow | undefined =>
  [...windows].find(([, context]) => context.kind === 'main')?.[0];
/** The focused Pantheon window other than the tray popover and the mini window. */
const focusedWindow = (): BrowserWindow | undefined => {
  const focused = BrowserWindow.getFocusedWindow();
  const kind = focused && windows.get(focused)?.kind;
  return kind && kind !== 'popover' && kind !== 'mini' ? focused! : undefined;
};
let quitting = false;
/** Quits when the page leaves a quit request unanswered, as a page drawing its crash screen does. */
let quitFallback: ReturnType<typeof setTimeout> | undefined;
/** The open quit confirmation, which answers every quit request made while it shows. */
let quitQuestion: Promise<void> | undefined;
app.on('before-quit', (event) => {
  const main = mainWindow();
  if (
    quitting ||
    !main ||
    main.webContents.isDestroyed() ||
    main.webContents.getOSProcessId() === 0
  ) {
    quitting = true;
    return;
  }
  event.preventDefault();
  if (quitQuestion) return;
  sendLoaded(main, 'pantheon:quit-request', null);
  clearTimeout(quitFallback);
  quitFallback = setTimeout(() => {
    quitting = true;
    app.quit();
  }, 2000);
});
let prefs = readShellPrefs(settingsFile);
let backgroundNoticeShown = readSettings(settingsFile).background_notice_shown === true;
let runningCount = 0;
/** Live subscriptions of each page by the page's own ids; frames of removed ids are dropped. */
const subscriptions = new Map<WebContents, Map<number, () => void>>();
const endSubscriptions = (contents: WebContents): void => {
  const own = subscriptions.get(contents);
  if (!own) return;
  subscriptions.delete(contents);
  const ends = [...own.values()];
  own.clear();
  for (const end of ends) end();
};
const voice = new VoiceRecognizer();
/** The page whose recognition is starting, running or can be retried. */
let voicePage: WebContents | undefined;
/** Counts starts and cancels, so a start that waited for the microphone prompt knows it was overtaken. */
let voiceRun = 0;
const cancelVoice = (): void => {
  voiceRun++;
  voicePage = undefined;
  voice.cancel();
};

/** Sends to the window's page; a page still loading has no listener yet, so it waits for the load. */
const sendLoaded = (target: BrowserWindow, channel: string, value: unknown): void => {
  const contents = target.webContents;
  if (contents.isLoading()) contents.once('did-finish-load', () => contents.send(channel, value));
  else contents.send(channel, value);
};

/** The open window whose page sent the call; none for another sender or a frame in the page. */
const senderWindow = (event: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow | undefined =>
  [...windows.keys()].find(
    (window) =>
      event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame,
  );
const trusted = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
  senderWindow(event) !== undefined;
const forbidden: BridgeResult<never> = {
  ok: false,
  error: { code: 'forbidden_sender', message: 'Only a Pantheon window may use this channel' },
};
/** Like handle, with the window that sent the call as the handler's first argument. */
const handleFrom = (
  channel: string,
  handler: (from: BrowserWindow, ...args: any[]) => Promise<BridgeResult<unknown>>,
): void => {
  ipcMain.handle(channel, (event, ...args) => {
    const from = senderWindow(event);
    return from ? handler(from, ...args) : forbidden;
  });
};
const handle = (
  channel: string,
  handler: (...args: any[]) => Promise<BridgeResult<unknown>>,
): void => handleFrom(channel, (_from, ...args) => handler(...args));
/** application is an app name or the full path of a .app bundle. */
const launcher =
  (application: string) =>
  (directory: string): Promise<BridgeResult<null>> =>
    execute({ command: 'open', args: ['-a', application, directory] });

const execute = ({ command, args }: { command: string; args: string[] }) =>
  new Promise<BridgeResult<null>>((resolve) =>
    execFile(command, args, (error, _stdout, stderr) =>
      resolve(
        error
          ? { ok: false, error: { code: 'open_failed', message: stderr.trim() || String(error) } }
          : { ok: true, value: null },
      ),
    ),
  );
/** Starts an editor or terminal that outlives Pantheon; a launch that throws fails the call. */
const detach = (launchOf: () => Launch) =>
  new Promise<BridgeResult<null>>((resolve) => {
    let launch: Launch;
    try {
      launch = launchOf();
    } catch (error) {
      resolve({ ok: false, error: { code: 'open_failed', message: String(error) } });
      return;
    }
    const { command, args, verbatim } = launch;
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      // Hides only the console of the cmd.exe wrapper; a hidden start would also hide wt.exe's window.
      windowsHide: path.win32.basename(command).toLowerCase() === 'cmd.exe',
      windowsVerbatimArguments: verbatim,
    });
    child.once('error', (error) =>
      resolve({ ok: false, error: { code: 'open_failed', message: String(error) } }),
    );
    child.once('spawn', () => {
      child.unref();
      resolve({ ok: true, value: null });
    });
  });
/** The renderer's file, resolved inside the folders of the daemon's projects and workspaces. */
const fileOf = async (ref: FileRef): Promise<BridgeResult<string>> => {
  const roots = await bridge.roots();
  if (!roots.ok) return roots;
  const file =
    distro === undefined ? resolveFile(ref, roots.value) : resolveWslFile(ref, roots.value, distro);
  return file === null
    ? {
        ok: false,
        error: {
          code: 'file_not_found',
          message: `${ref.path} is not a file in the project's folders`,
        },
      }
    : { ok: true, value: file };
};
const openIn = (editor: Editor, file: string, ref: FileRef) =>
  desktop === 'darwin'
    ? execute(editorLaunch(editor, file, ref.line, ref.column))
    : detach(() => editorCommand(desktop, editor, file, ref.line, ref.column, distro));

handle('pantheon:appInfo', async () => ({
  ok: true,
  value: {
    version: app.getVersion(),
    electron: process.versions.electron,
    os:
      process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
    os_version: os.release(),
    arch: process.arch,
  } satisfies AppInfo,
}));
handle('pantheon:logsDir', async () => ({ ok: true, value: path.dirname(logFile) }));
handle('pantheon:debugTarget', async () => ({
  ok: true,
  value: app.isPackaged ? null : { repo_root: repoRoot },
}));
handleFrom('pantheon:lastCrash', async (from) => {
  const crash = crashes.get(from) ?? null;
  crashes.delete(from);
  return { ok: true, value: crash };
});
// The preload asks once as the page loads, so a later reload draws the whole app again.
ipcMain.on('pantheon:crashPage', (event) => {
  const from = senderWindow(event);
  event.returnValue = (from && crashPages.get(from)) ?? null;
  if (from) crashPages.delete(from);
});
handleFrom('pantheon:exportDiagnostics', async (from) => {
  const result = await dialog.showSaveDialog(from, {
    defaultPath: path.join(app.getPath('downloads'), 'pantheon-diagnostics.log'),
    filters: [{ name: 'Log', extensions: ['log'] }],
  });
  if (result.canceled || !result.filePath) return { ok: true, value: null };
  const directory = path.dirname(logFile);
  try {
    let text = '';
    for (const name of (await readdir(directory)).sort()) {
      if (!(await stat(path.join(directory, name))).isFile()) continue;
      const body = await readFile(path.join(directory, name), 'utf8');
      text += `==> ${name} <==\n${body}`;
      if (body && !body.endsWith('\n')) text += '\n';
    }
    await writeFile(result.filePath, text);
  } catch (error) {
    return { ok: false, error: { code: 'export_failed', message: String(error) } };
  }
  return { ok: true, value: result.filePath };
});
handle('pantheon:daemonStarting', async () => ({ ok: true, value: bridge.starting }));
handle('pantheon:daemon', () => bridge.daemon());
handle('pantheon:command', (command: Command) => bridge.command(command));
handle('pantheon:query', (method: string, params?: Record<string, string | string[]>) =>
  bridge.query(method, params),
);
handleFrom('pantheon:chooseDirectories', async (from) => {
  const shown = distro;
  const result = await dialog.showOpenDialog(from, {
    properties: ['openDirectory', 'createDirectory', 'multiSelections'],
    ...(shown === undefined ? {} : { defaultPath: `\\\\wsl.localhost\\${shown}\\` }),
  });
  const chosen = result.canceled ? [] : result.filePaths;
  return {
    ok: true,
    value: shown === undefined ? chosen : chosen.flatMap((p) => wslPathFromWindows(p, shown) ?? []),
  };
});
handle('pantheon:browseDirectory', async (input: unknown) => {
  if (typeof input !== 'string')
    return { ok: false, error: { code: 'invalid_input', message: 'Expected a path' } };
  const shown = distro;
  // With a distro, paths are the distro's Linux paths, read through its share.
  const posix = shown === undefined ? path : path.posix;
  let home = os.homedir();
  if (shown !== undefined && /^~(\/|$)/.test(input))
    home = (await runWsl('wsl.exe', ['-d', shown, '--exec', 'printenv', 'HOME']).catch(() => ''))
      .toString()
      .trim();
  const folder = posix.resolve(input.replace(/^~(?=\/|$)/, home));
  const readable = shown === undefined ? folder : windowsPathFromWsl(folder, shown);
  let found: Dirent[];
  try {
    if (!home) throw new Error('No home folder');
    found = await readdir(readable, { withFileTypes: true });
  } catch {
    return {
      ok: false,
      error: { code: 'not_a_directory', message: `${input} is not an existing directory` },
    };
  }
  const entries: { name: string; path: string; hidden: boolean }[] = [];
  for (const entry of found) {
    const directory =
      entry.isDirectory() ||
      (entry.isSymbolicLink() &&
        (await stat(path.join(readable, entry.name)).then(
          (target) => target.isDirectory(),
          () => false,
        )));
    if (directory)
      entries.push({
        name: entry.name,
        path: posix.join(folder, entry.name),
        hidden: entry.name.startsWith('.'),
      });
  }
  entries.sort((a, b) => Number(a.hidden) - Number(b.hidden) || a.name.localeCompare(b.name));
  const parent = posix.dirname(folder);
  return {
    ok: true,
    value: {
      path: folder,
      parent: parent === folder ? null : parent,
      entries: entries.slice(0, 2000),
    },
  };
});
handleFrom('pantheon:chooseFiles', async (from, project_id: string) => {
  const result = await dialog.showOpenDialog(from, {
    properties: ['openFile', 'multiSelections'],
  });
  if (result.canceled) return { ok: true, value: [] };
  const fitting: string[] = [];
  let tooLarge: string | undefined;
  for (const file of result.filePaths) {
    try {
      if ((await stat(file)).size > attachmentLimit) tooLarge ??= file;
      else fitting.push(file);
    } catch (error) {
      return { ok: false, error: { code: 'read_failed', message: String(error) } };
    }
  }
  const attached: AttachmentMeta[] = [];
  for (const file of fitting) {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(file);
    } catch (error) {
      return { ok: false, error: { code: 'read_failed', message: String(error) } };
    }
    const meta = await bridge.attach(project_id, path.basename(file), attachmentMime(file), bytes);
    if (!meta.ok) return meta;
    attached.push(meta.value);
  }
  if (tooLarge !== undefined)
    return {
      ok: false,
      error: {
        code: 'attachment_too_large',
        message: `${path.basename(tooLarge)} is larger than 20 MiB`,
        details: { attached },
      },
    };
  return { ok: true, value: attached };
});
/** The capturer's window sources without Pantheon's own windows. */
const otherWindows = async (thumbnailSize: Size) => {
  const own = new Set(BrowserWindow.getAllWindows().map((window) => window.getMediaSourceId()));
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize });
  return sources.filter((source) => !own.has(source.id));
};
/** The windows the picker last listed; only these can be captured. */
let listedWindows = new Set<string>();
handle('pantheon:listWindowSnapshots', async () => {
  const shown = (await otherWindows({ width: 320, height: 200 })).filter(
    (source) => !source.thumbnail.isEmpty(),
  );
  listedWindows = new Set(shown.map((source) => source.id));
  // Without screen recording access macOS hands over no window of another app, or only empty ones.
  if (
    shown.length === 0 &&
    process.platform === 'darwin' &&
    systemPreferences.getMediaAccessStatus('screen') !== 'granted'
  )
    return { ok: true, value: { permission: 'denied', windows: [] } };
  return {
    ok: true,
    value: {
      permission: 'granted',
      windows: shown.map((source) => ({
        id: source.id,
        name: source.name,
        thumbnail: source.thumbnail.toDataURL(),
      })),
    },
  };
});
handle('pantheon:snapshotWindow', async (project_id: string, id: string) => {
  // A thumbnail shrinks to fit its size, so the largest display's pixels keep a window at full size.
  const displays = screen.getAllDisplays();
  const full = {
    width: Math.max(...displays.map((d) => Math.round(d.size.width * d.scaleFactor))),
    height: Math.max(...displays.map((d) => Math.round(d.size.height * d.scaleFactor))),
  };
  const source = listedWindows.has(id)
    ? (await otherWindows(full)).find((s) => s.id === id)
    : undefined;
  if (!source || source.thumbnail.isEmpty())
    return {
      ok: false,
      error: { code: 'window_unavailable', message: 'The window is closed or cannot be captured' },
    };
  const name = source.name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'window';
  return bridge.attach(project_id, `${name}.png`, 'image/png', source.thumbnail.toPNG());
});
handle(
  'pantheon:attachFile',
  async (project_id: string, name: string, mime: string, bytes: unknown) => {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > attachmentLimit)
      return {
        ok: false,
        error: { code: 'invalid_input', message: 'bytes must be a Uint8Array of at most 20 MiB' },
      };
    return bridge.attach(project_id, name, mime, bytes);
  },
);
handle('pantheon:openInTerminal', (id: string) =>
  desktop === 'darwin'
    ? openWithTerminal(terminalRoots(), settingsFile, (bundle) =>
        bridge.openWorkspace(id, launcher(bundle)),
      )
    : bridge.openWorkspace(
        id,
        (directory) => {
          const terminal = selectedTerminal(terminalScan([]), settingsFile);
          const shown = desktop === 'linux' ? 'linux' : 'win32';
          const launch = () => terminalCommand(shown, terminal, directory, distro);
          // Only Linux lacks a terminal, and only Windows throws.
          return shown === 'linux' && launch() === null
            ? Promise.resolve({ ok: false, error: terminalUnavailable })
            : detach(() => launch()!);
        },
        local,
      ),
);
handle('pantheon:runtimeLogin', (runtime: unknown) =>
  desktop === 'darwin'
    ? runtimeLogin(
        runtime,
        path.join(app.getPath('userData'), 'tmp'),
        terminalRoots(),
        settingsFile,
        launcher,
      )
    : commandRuntimeLogin(runtime, desktop, terminalScan([]), settingsFile, distro, (launch) =>
        detach(() => launch),
      ),
);
handle('pantheon:openInEditor', (id: string) =>
  openWithEditor(
    editorRoots(),
    settingsFile,
    (bundle, editor) =>
      bridge.openWorkspace(
        id,
        desktop === 'darwin'
          ? launcher(bundle)
          : (directory) =>
              detach(() => editorCommand(desktop, editor, directory, undefined, undefined, distro)),
        local,
      ),
    editorScan,
  ),
);
handle('pantheon:editors', async () => listEditors(editorRoots(), settingsFile, editorScan));
handle('pantheon:chooseEditor', async (id: string) =>
  chooseEditor(id, editorRoots(), settingsFile, editorScan),
);
handle('pantheon:terminals', async () =>
  listTerminals(terminalRoots(), settingsFile, terminalScan),
);
handle('pantheon:chooseTerminal', async (id: string) =>
  chooseTerminal(id, terminalRoots(), settingsFile, terminalScan),
);
const invalidBrowserInput: BridgeResult<never> = {
  ok: false,
  error: { code: 'invalid_input', message: 'Invalid browser request' },
};
const browserUrl = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
};
const browserBounds = (value: unknown): value is BrowserBounds => {
  if (typeof value !== 'object' || value === null) return false;
  const bounds = value as BrowserBounds;
  return (
    [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isInteger) &&
    bounds.width >= 0 &&
    bounds.height >= 0
  );
};
const closeBrowser = (window: BrowserWindow): void => {
  const browser = browsers.get(window);
  if (!browser) return;
  browsers.delete(window);
  window.contentView.removeChildView(browser.view);
  browser.view.webContents.close();
};
// A screenshot shrinks until its base64 fits well inside the daemon's 1 MiB command limit.
const CAPTURE_BASE64_MAX = 700_000;
for (const action of [
  'Open',
  'Navigate',
  'Back',
  'Forward',
  'Reload',
  'SetBounds',
  'Close',
  'Read',
  'Capture',
]) {
  handleFrom(`pantheon:browser${action}`, async (from, input: unknown) => {
    if (typeof input !== 'object' || input === null) return invalidBrowserInput;
    const request = input as { id?: unknown; url?: unknown; bounds?: unknown };
    const url = action === 'Open' || action === 'Navigate' ? browserUrl(request.url) : null;
    if ((action === 'Open' || action === 'Navigate') && url === null) return invalidBrowserInput;
    if ((action === 'Open' || action === 'SetBounds') && !browserBounds(request.bounds))
      return invalidBrowserInput;
    let browser = browsers.get(from);
    if (action !== 'Open' && (typeof request.id !== 'string' || browser?.id !== request.id))
      return invalidBrowserInput;
    if (action === 'Open' && !browser) {
      // Electron grants any permission a session has no handler for.
      const browserSession = session.fromPartition('persist:pantheon-browser');
      browserSession.setPermissionRequestHandler((_contents, _permission, answer) => answer(false));
      browserSession.setPermissionCheckHandler(() => false);
      const view = new WebContentsView({
        webPreferences: {
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          partition: 'persist:pantheon-browser',
        },
      });
      browser = { id: randomUUID(), view };
      browsers.set(from, browser);
      from.contentView.addChildView(view);
      const contents = view.webContents;
      const id = browser.id;
      const sendState = (): void => {
        if (browsers.get(from)?.id !== id || from.webContents.isDestroyed()) return;
        from.webContents.send('pantheon:browser-state', {
          id,
          url: contents.getURL(),
          title: contents.getTitle(),
          can_go_back: contents.navigationHistory.canGoBack(),
          can_go_forward: contents.navigationHistory.canGoForward(),
          loading: contents.isLoading(),
        });
      };
      contents
        .on('did-start-loading', sendState)
        .on('did-stop-loading', sendState)
        .on('did-navigate', sendState)
        .on('did-navigate-in-page', sendState)
        .on('page-title-updated', sendState);
      // Navigation and redirects are separate network entry points from renderer IPC.
      const stayOnWeb = (event: { url: string; preventDefault: () => void }): void => {
        if (browserUrl(event.url) === null) event.preventDefault();
      };
      contents
        .on('will-navigate', stayOnWeb)
        .on('will-redirect', stayOnWeb)
        .on('will-frame-navigate', stayOnWeb);
      contents.setWindowOpenHandler(({ url }) => {
        const link = browserUrl(url);
        if (link !== null) void openWebLink(link);
        return { action: 'deny' };
      });
    }
    const { id, view } = browser!;
    const contents = view.webContents;
    if (action === 'Open' || action === 'SetBounds') {
      // The page measures in CSS pixels, which its zoom scales.
      const zoom = from.webContents.getZoomFactor();
      const { x, y, width, height } = request.bounds as BrowserBounds;
      view.setBounds({
        x: Math.round(x * zoom),
        y: Math.round(y * zoom),
        width: Math.round(width * zoom),
        height: Math.round(height * zoom),
      });
    }
    if (action === 'Open' || action === 'Navigate') {
      try {
        await contents.loadURL(url!);
      } catch (error) {
        return { ok: false, error: { code: 'browser_load_failed', message: String(error) } };
      }
    } else if (action === 'Back' && contents.navigationHistory.canGoBack())
      contents.navigationHistory.goBack();
    else if (action === 'Forward' && contents.navigationHistory.canGoForward())
      contents.navigationHistory.goForward();
    else if (action === 'Reload') contents.reload();
    else if (action === 'Close') closeBrowser(from);
    else if (action === 'Read') {
      const text = String(
        await contents.executeJavaScript('document.body ? document.body.innerText : ""'),
      );
      return {
        ok: true,
        value: {
          url: contents.getURL(),
          title: contents.getTitle(),
          text: text.slice(0, BROWSER_TEXT_LIMIT),
          truncated: text.length > BROWSER_TEXT_LIMIT,
        },
      };
    } else if (action === 'Capture') {
      const image = await contents.capturePage();
      if (image.isEmpty())
        return {
          ok: false,
          error: { code: 'browser_capture_failed', message: 'The page has not painted anything' },
        };
      let width = Math.min(image.getSize().width, 1280),
        png = image.resize({ width }).toPNG().toString('base64');
      while (png.length > CAPTURE_BASE64_MAX && width > 320) {
        width = Math.round(width * 0.75);
        png = image.resize({ width }).toPNG().toString('base64');
      }
      if (png.length > CAPTURE_BASE64_MAX)
        return {
          ok: false,
          error: {
            code: 'browser_capture_failed',
            message: 'The screenshot is too large even at its narrowest width',
          },
        };
      return { ok: true, value: { url: contents.getURL(), title: contents.getTitle(), png } };
    }
    return { ok: true, value: action === 'Open' ? { id } : null };
  });
}
handleFrom('pantheon:captureRegion', async (from, rect: unknown) => {
  const { x, y, width, height } = (rect ?? {}) as Record<string, number>;
  // Number.isFinite is false for anything but a finite number.
  if (![x, y, width, height].every(Number.isFinite) || width! <= 0 || height! <= 0)
    return {
      ok: false,
      error: { code: 'invalid_input', message: 'rect needs finite x, y and a positive size' },
    };
  const [contentWidth, contentHeight] = from.getContentSize();
  const left = Math.max(0, Math.floor(x!));
  const top = Math.max(0, Math.floor(y!));
  const right = Math.min(contentWidth!, Math.ceil(x! + width!));
  const bottom = Math.min(contentHeight!, Math.ceil(y! + height!));
  const image =
    right > left && bottom > top
      ? await from.webContents.capturePage({
          x: left,
          y: top,
          width: right - left,
          height: bottom - top,
        })
      : null;
  if (!image || image.isEmpty())
    return {
      ok: false,
      error: { code: 'capture_failed', message: 'The area is outside the window or not painted' },
    };
  let shrunk = Math.min(image.getSize().width, 1280),
    url = image.resize({ width: shrunk }).toDataURL();
  while (url.length > CAPTURE_BASE64_MAX && shrunk > 320) {
    shrunk = Math.round(shrunk * 0.75);
    url = image.resize({ width: shrunk }).toDataURL();
  }
  if (url.length > CAPTURE_BASE64_MAX)
    return {
      ok: false,
      error: {
        code: 'capture_failed',
        message: 'The capture is too large even at its narrowest width',
      },
    };
  return { ok: true, value: url };
});
handleFrom('pantheon:visualServe', async (from, input: unknown) => {
  if (
    typeof input !== 'object' ||
    input === null ||
    typeof (input as { html?: unknown }).html !== 'string'
  )
    return { ok: false, error: { code: 'invalid_input', message: 'Expected HTML text' } };
  const hosts = (input as { hosts?: unknown }).hosts ?? [];
  if (!visualHosts(hosts))
    return {
      ok: false,
      error: {
        code: 'invalid_input',
        message: 'Expected https origins such as https://example.com',
      },
    };
  return { ok: true, value: visuals.serve(from, (input as { html: string }).html, hosts) };
});
const APP_CSP_KEYS = ['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains'];
handleFrom('pantheon:appServe', async (from, input: unknown) => {
  const { html, csp } = (typeof input === 'object' && input !== null ? input : {}) as {
    html?: unknown;
    csp?: unknown;
  };
  if (typeof html !== 'string' || Buffer.byteLength(html) > 2 * 1024 * 1024)
    return { ok: false, error: { code: 'invalid_input', message: 'Expected HTML up to 2 MB' } };
  if (
    csp !== undefined &&
    (typeof csp !== 'object' ||
      csp === null ||
      !APP_CSP_KEYS.every((key) => {
        const domains = (csp as Record<string, unknown>)[key];
        return (
          domains === undefined ||
          (Array.isArray(domains) && domains.every((domain) => typeof domain === 'string'))
        );
      }))
  )
    return {
      ok: false,
      error: { code: 'invalid_input', message: 'Expected csp domain lists of strings' },
    };
  const policy =
    csp === undefined
      ? undefined
      : Object.fromEntries(
          APP_CSP_KEYS.map((key) => [key, (csp as Record<string, string[]>)[key]]),
        );
  return { ok: true, value: appPages.serve(from, { html, csp: policy }) };
});
handleFrom('pantheon:appRelease', async (from, url: unknown) => {
  if (typeof url !== 'string' || !URL.canParse(url))
    return { ok: false, error: { code: 'invalid_input', message: 'Expected a page URL' } };
  appPages.release(from, url);
  return { ok: true, value: null };
});
handleFrom('pantheon:chosenBrowser', async () => {
  const saved = readSettings(settingsFile).browser;
  return { ok: true, value: typeof saved === 'string' ? saved : null };
});
handleFrom('pantheon:listBrowsers', async () => ({
  ok: true,
  value: process.platform === 'darwin' ? scanBrowsers(browserRoots()) : [],
}));
handleFrom('pantheon:chooseBrowser', async (_from, id: unknown) => {
  if (id !== null && typeof id !== 'string') return invalidBrowserInput;
  if (
    id !== null &&
    (process.platform !== 'darwin' ||
      !scanBrowsers(browserRoots()).some((browser) => browser.id === id))
  )
    return {
      ok: false,
      error: {
        code: 'browser_unavailable',
        message: `${JSON.stringify(id)} is not an installed browser`,
      },
    };
  saveChoice(settingsFile, 'browser', id ?? undefined);
  return { ok: true, value: null };
});
/** Opens the link in the browser chosen in Pantheon on macOS, else in the system's. */
const openWebLink = (link: string): Promise<BridgeResult<null>> => {
  if (process.platform === 'darwin') {
    const saved = readSettings(settingsFile).browser;
    const browser = scanBrowsers(browserRoots()).find((browser) => browser.id === saved);
    if (browser) return launcher(browser.path)(link);
  }
  return shell.openExternal(link).then(
    () => ({ ok: true, value: null }),
    (error: unknown) => ({ ok: false, error: { code: 'open_failed', message: String(error) } }),
  );
};
handle('pantheon:openLink', async (url: unknown) => {
  const link = typeof url === 'string' ? webLink(url) : null;
  if (link === null)
    return {
      ok: false,
      error: { code: 'link_refused', message: `${url} is not an http, https or mailto link` },
    };
  return openWebLink(link);
});
handle('pantheon:openFile', async (ref: FileRef, editorId?: string) => {
  const file = await fileOf(ref);
  if (!file.ok) return file;
  const installed = editorScan(editorRoots());
  const editor =
    editorId === undefined
      ? selectedEditor(installed, settingsFile)
      : installed.find((e) => e.id === editorId);
  if (!editor)
    return {
      ok: false,
      error: {
        code: 'editor_unavailable',
        message:
          editorId === undefined
            ? 'No known editor is installed'
            : `${JSON.stringify(editorId)} is not an installed editor`,
      },
    };
  return openIn(editor, file.value, ref);
});
handleFrom('pantheon:fileMenu', async (from, ref: FileRef) => {
  const file = await fileOf(ref);
  if (!file.ok) return file;
  Menu.buildFromTemplate([
    ...editorScan(editorRoots()).map((editor) => ({
      label: menuText().openWith(editor.name),
      click: () => void openIn(editor, file.value, ref),
    })),
    { type: 'separator' },
    {
      label: menuText().reveal(process.platform),
      click: () => shell.showItemInFolder(local(file.value)),
    },
  ]).popup({ window: from });
  return { ok: true, value: null };
});
/**
 * Whether the page may reveal `target`: the daemon's data folder, a project root, a workspace or the
 * root it came from, the managed worktree folder, or a git worktree of a project.
 */
const revealable = async (target: string): Promise<boolean> => {
  const daemon = await bridge.daemon();
  if (daemon.ok && daemon.value.data_dir === target) return true;
  const board = await bridge.query('board');
  if (!board.ok) return false;
  const { projects, workspaces } = board.value as BoardSnapshot;
  if (
    projects.some((p) => p.roots.includes(target)) ||
    workspaces.some((w) => w.path === target || w.source === target)
  )
    return true;
  for (const [index, { id }] of projects.entries()) {
    // Every project reports the same managed worktree folder.
    const stale = index === 0 ? await bridge.query('workspace.stale', { project_id: id }) : null;
    if (stale?.ok && (stale.value as StaleWorkspaces).worktree_root === target) return true;
    const worktrees = await bridge.query('repo.worktrees', { project_id: id });
    if (worktrees.ok && (worktrees.value as RepoWorktree[]).some((w) => w.path === target))
      return true;
  }
  return false;
};
handle('pantheon:revealPath', async (target: unknown) => {
  if (typeof target !== 'string')
    return { ok: false, error: { code: 'invalid_input', message: 'path must be a string' } };
  if (target !== path.dirname(logFile) && !(await revealable(target)))
    return {
      ok: false,
      error: { code: 'path_refused', message: `${target} is not a folder Pantheon shows` },
    };
  shell.showItemInFolder(target === path.dirname(logFile) ? target : local(target));
  return { ok: true, value: null };
});
let tray: Tray | undefined;
let popover: BrowserWindow | undefined;
let mini: BrowserWindow | undefined;
let badgeCount = 0;
/** The tray tooltip and the taskbar badge's name: the app's name, with the count once there is one. */
const countLabel = (count: number): string =>
  count > 0 ? menuText().trayCount(app.name, count) : app.name;
/** The figures of the taskbar badge, three dots wide; each row's bits, top row first. */
const FIGURES: Record<string, readonly number[]> = {
  '0': [7, 5, 5, 5, 7],
  '1': [2, 6, 2, 2, 7],
  '2': [7, 1, 7, 4, 7],
  '3': [7, 1, 7, 1, 7],
  '4': [5, 5, 7, 1, 1],
  '5': [7, 4, 7, 1, 7],
  '6': [7, 4, 7, 5, 7],
  '7': [7, 1, 1, 1, 1],
  '8': [7, 5, 7, 5, 7],
  '9': [7, 5, 7, 1, 7],
  '+': [0, 2, 7, 2, 0],
};
/** A 32 px premultiplied BGRA red disc with the count in white, 99+ past 99. */
const countBitmap = (count: number): Buffer => {
  const text = count > 99 ? '99+' : String(count);
  const dot = text.length > 2 ? 2 : 3;
  const left = Math.round((32 - (text.length * 4 - 1) * dot) / 2);
  const top = Math.round((32 - 5 * dot) / 2);
  const bitmap = Buffer.alloc(32 * 32 * 4);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      // Sixteen samples a pixel smooth the disc's edge.
      let inside = 0;
      for (let i = 0; i < 16; i++)
        if (Math.hypot(x + (i % 4) / 4 + 0.125 - 16, y + Math.floor(i / 4) / 4 + 0.125 - 16) < 16)
          inside++;
      const alpha = (inside / 16) * 255;
      const column = Math.floor((x - left) / dot);
      const row = Math.floor((y - top) / dot);
      const figure = FIGURES[text[Math.floor(column / 4)] ?? ''];
      const lit = column % 4 < 3 && ((figure?.[row] ?? 0) >> (2 - (column % 4))) & 1;
      const colour = lit ? [255, 255, 255] : [0x1c, 0x2b, 0xc4];
      bitmap.set(
        [...colour.map((value) => Math.round((value * alpha) / 255)), Math.round(alpha)],
        (y * 32 + x) * 4,
      );
    }
  return bitmap;
};
/** Brings forward the window showing the target's session, else the main window with the target. */
const showTarget = (target: NotificationTarget | undefined): void => {
  const open =
    target &&
    [...windows].find(
      ([, context]) => context.kind === 'session' && context.session_id === target.session_id,
    )?.[0];
  if (open) {
    // A window still waiting for its first content shows itself then.
    if (!firstContent.has(open)) {
      open.show();
      open.focus();
    }
    return;
  }
  const main = reveal();
  if (target) sendLoaded(main, 'pantheon:notification-click', target);
};
// A collected notification loses its click handler, so each one is kept until clicked or closed.
const notifications = new Set<Notification>();
handle('pantheon:notify', async (input: unknown) => {
  const { title, body, target, silent } = (input ?? {}) as Record<string, unknown>;
  const targetRead = target as Partial<NotificationTarget> | undefined;
  if (
    typeof title !== 'string' ||
    typeof body !== 'string' ||
    (silent !== undefined && typeof silent !== 'boolean') ||
    (target !== undefined &&
      (typeof targetRead?.project_id !== 'string' || typeof targetRead.session_id !== 'string'))
  )
    return {
      ok: false,
      error: {
        code: 'invalid_input',
        message:
          'title and body must be strings, silent a boolean and target a project and session id',
      },
    };
  const notification = new Notification({
    title,
    body,
    silent,
  });
  notifications.add(notification);
  notification.on('click', () => {
    notifications.delete(notification);
    showTarget(targetRead as NotificationTarget | undefined);
  });
  notification.on('close', () => notifications.delete(notification));
  notification.show();
  return { ok: true, value: null };
});
/** The sessions the main window's page last reported as waiting for the user. */
let waitingSessions: WaitingSession[] = [];
/** The reported waiting sessions; null unless at most 5, each with non-empty ids and a title. */
const readWaitingSessions = (value: unknown): WaitingSession[] | null => {
  if (!Array.isArray(value) || value.length > 5) return null;
  const read: WaitingSession[] = [];
  for (const one of value) {
    const { project_id, session_id, title } = (one ?? {}) as Record<string, unknown>;
    if (
      typeof project_id !== 'string' ||
      !project_id ||
      typeof session_id !== 'string' ||
      !session_id ||
      typeof title !== 'string'
    )
      return null;
    read.push({ project_id, session_id, title });
  }
  return read;
};
/** The macOS Dock menu: the waiting sessions, then New Session and Open Project. */
const applyDockMenu = (): void => {
  if (!app.dock) return;
  const text = menuText();
  app.dock.setMenu(
    Menu.buildFromTemplate([
      ...waitingSessions.map(({ project_id, session_id, title }) => ({
        label: title,
        click: () => showTarget({ project_id, session_id }),
      })),
      ...(waitingSessions.length > 0 ? [{ type: 'separator' } as const] : []),
      { label: text.newSession, click: () => revealWith('new-session') },
      { label: text.openProject, click: () => revealWith('open-project') },
    ]),
  );
};
handleFrom('pantheon:badge', async (from, count: number, waiting: unknown = []) => {
  if (!(Number.isInteger(count) && count >= 0))
    return {
      ok: false,
      error: { code: 'invalid_input', message: 'count must be a non-negative integer' },
    };
  const waitingRead = readWaitingSessions(waiting);
  if (!waitingRead)
    return {
      ok: false,
      error: {
        code: 'invalid_input',
        message: 'waiting must list at most 5 sessions, each with project_id, session_id and title',
      },
    };
  // Every window's page reports the same project-wide count; only the main window's is kept.
  if (windows.get(from)!.kind !== 'main') return { ok: true, value: null };
  if (count > badgeCount && focusedWindow() === undefined) {
    if (process.platform === 'darwin') app.dock?.bounce('informational');
    else from.flashFrame(true);
  }
  badgeCount = count;
  if (JSON.stringify(waitingRead) !== JSON.stringify(waitingSessions)) {
    waitingSessions = waitingRead;
    applyDockMenu();
  }
  app.dock?.setBadge(count > 0 ? String(count) : '');
  if (process.platform === 'linux') app.setBadgeCount(count);
  if (process.platform === 'win32')
    from.setOverlayIcon(
      count > 0
        ? nativeImage.createFromBitmap(countBitmap(count), {
            width: 32,
            height: 32,
            scaleFactor: 2,
          })
        : null,
      count > 0 ? countLabel(count) : '',
    );
  tray?.setTitle(trayTitle(count));
  tray?.setToolTip(countLabel(count));
  return { ok: true, value: null };
});
// Read on use: the electron stand-in of the window tests has no powerSaveBlocker.
const keepAwake = sleepGuard({
  start: (type) => powerSaveBlocker.start(type),
  stop: (id) => powerSaveBlocker.stop(id),
});
handle(
  'pantheon:keepAwake',
  async ({ enabled, running }: { enabled: unknown; running: unknown }) => {
    if (typeof enabled !== 'boolean' || !(Number.isInteger(running) && (running as number) >= 0))
      return {
        ok: false,
        error: {
          code: 'invalid_input',
          message: 'enabled must be a boolean and running a non-negative integer',
        },
      };
    runningCount = running as number;
    keepAwake({ enabled, running: runningCount });
    return { ok: true, value: null };
  },
);
handleFrom('pantheon:zoomFactor', async (from, factor?: unknown) => {
  const contents = from.webContents;
  if (factor !== undefined) {
    if (typeof factor !== 'number' || !ZOOM_FACTORS.includes(factor))
      return {
        ok: false,
        error: {
          code: 'invalid_input',
          message: `factor must be one of ${ZOOM_FACTORS.join(', ')}`,
        },
      };
    for (const window of windows.keys()) window.webContents.setZoomFactor(factor);
    writeZoom(zoomFile, factor);
  }
  return { ok: true, value: contents.getZoomFactor() };
});
let themeSource = readThemeSource(themeFile);
nativeTheme.themeSource = themeSource;
/** The colours the page last reported; until then the fixed ones of each scheme stand in. */
let pageColours: WindowColours | undefined;
const windowBackground = (): string => {
  const dark = themeSource === 'system' ? nativeTheme.shouldUseDarkColors : themeSource === 'dark';
  // Reported colours of the other scheme are stale once the system flips.
  return pageColours?.dark === dark
    ? pageColours.background
    : WINDOW_BACKGROUND[dark ? 'dark' : 'light'];
};
// The page follows the flip and reports its colours; the window shows the new scheme until it does.
nativeTheme.on('updated', () => {
  if (themeSource !== 'system') return;
  for (const window of windows.keys()) window.setBackgroundColor(windowBackground());
});
ipcMain.on('pantheon:setThemeSource', (event, source: unknown) => {
  if (!trusted(event) || !THEME_SOURCES.includes(source as ThemeSource)) return;
  themeSource = source as ThemeSource;
  nativeTheme.themeSource = themeSource;
  writeThemeSource(themeFile, themeSource);
  // A reload of an open window paints this before the page does.
  for (const window of windows.keys()) window.setBackgroundColor(windowBackground());
});
/** What a hidden window does once its page has drawn its first content; absent once it has. */
const firstContent = new Map<BrowserWindow, () => void>();
const contentDrawn = (window: BrowserWindow): void => {
  const then = firstContent.get(window);
  firstContent.delete(window);
  then?.();
};
ipcMain.on('pantheon:ready', (event) => {
  const from = senderWindow(event);
  if (from) contentDrawn(from);
});
// The page picks its theme; until it reports one, the system's stands in.
let titleBar = titleBarOverlay(nativeTheme.shouldUseDarkColors);
handle('pantheon:setTitleBarTheme', async (colours: unknown) => {
  const read = readWindowColours(colours);
  if (!read)
    return {
      ok: false,
      error: {
        code: 'invalid_input',
        message: 'dark must be a boolean and color, symbolColor and background #rrggbb',
      },
    };
  pageColours = read;
  titleBar = { color: read.color, symbolColor: read.symbolColor, height: 44 };
  for (const [window, context] of windows) {
    if (process.platform !== 'darwin' && context.kind !== 'popover' && context.kind !== 'mini')
      window.setTitleBarOverlay(titleBar);
    window.setBackgroundColor(windowBackground());
  }
  return { ok: true, value: null };
});
ipcMain.on(
  'pantheon:subscribe',
  (event, id: number, options: { cursor?: number; project_id?: string; browser?: boolean }) => {
    if (!trusted(event)) {
      event.reply('pantheon:event', id, {
        type: 'closed',
        code: 1008,
        reason: 'forbidden_sender',
      } satisfies EventFrame);
      return;
    }
    const sender = event.sender;
    const own = subscriptions.get(sender) ?? new Map<number, () => void>();
    subscriptions.set(sender, own);
    const end = bridge.subscribe(options, (frame) => {
      if (own.get(id) !== end || sender.isDestroyed()) return;
      if (frame.type === 'closed') own.delete(id);
      sender.send('pantheon:event', id, frame);
    });
    own.set(id, end);
  },
);
ipcMain.on('pantheon:unsubscribe', (event, id: number) => {
  if (trusted(event)) subscriptions.get(event.sender)?.get(id)?.();
});
// Terminal streams share the page's subscription ids, so a reload ends them too.
ipcMain.on('pantheon:terminalSubscribe', (event, id: number, terminal_id: unknown) => {
  if (!trusted(event) || typeof terminal_id !== 'string') return;
  const sender = event.sender;
  const own = subscriptions.get(sender) ?? new Map<number, () => void>();
  subscriptions.set(sender, own);
  const end = bridge.terminalSubscribe(terminal_id, (frame) => {
    if (own.get(id) !== end || sender.isDestroyed()) return;
    if (!('data' in frame)) own.delete(id);
    sender.send('pantheon:terminal', id, frame);
  });
  own.set(id, end);
});
ipcMain.on('pantheon:terminalUnsubscribe', (event, id: number) => {
  if (!trusted(event)) return;
  const own = subscriptions.get(event.sender);
  own?.get(id)?.();
  own?.delete(id);
});

/** Opens a window for context; only the main window keeps its bounds and hides on close. */
function createWindow(context: WindowContext): BrowserWindow {
  const main = context.kind === 'main';
  const session = context.kind === 'session';
  const isPopover = context.kind === 'popover';
  const isMini = context.kind === 'mini';
  const saved = main
    ? readWindowState(windowFile)
    : isPopover
      ? { width: 320, height: 240, maximized: false }
      : session
        ? { width: 760, height: 620, maximized: false }
        : { ...DEFAULT_WINDOW };
  const workAreas = screen.getAllDisplays().map((display) => display.workArea);
  const primaryArea = screen.getPrimaryDisplay().workArea;
  const window = new BrowserWindow({
    ...(isMini
      ? placeMiniWindow(
          readMiniPlace(readSettings(settingsFile).mini_window_position),
          workAreas,
          primaryArea,
        )
      : placeWindow(saved, workAreas, primaryArea)),
    minWidth: isMini ? MINI_WINDOW.width : isPopover ? 320 : session ? 480 : 1100,
    minHeight: isMini ? MINI_WINDOW.height : isPopover ? 120 : session ? 360 : 700,
    ...(isPopover || isMini
      ? { frame: false, resizable: false, skipTaskbar: true, alwaysOnTop: true }
      : windowChrome(process.platform, titleBar)),
    // Kept out of Mission Control and the dock's and Window menu's window lists.
    ...(isMini
      ? {
          hiddenInMissionControl: true,
          excludedFromShownWindowsMenu: true,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
        }
      : {}),
    // Only the main window shows before its page has drawn; the page background stands in until then.
    show: main,
    backgroundColor: windowBackground(),
    // macOS shows the app icon only in the Dock.
    ...(process.platform === 'darwin' ? {} : { icon: iconImage('window', prefs.app_icon) }),
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      zoomFactor: readZoom(zoomFile),
    },
  });
  windows.set(window, context);
  if (isMini) {
    window.setAlwaysOnTop(true, 'floating');
    window.setVisibleOnAllWorkspaces(true);
  }
  // A shutdown another app cancels raises query-session-end but not session-end.
  window.on('session-end', () => {
    quitting = true;
  });
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  const pageUrl =
    rendererUrl ?? pathToFileURL(path.join(import.meta.dirname, '../renderer/index.html')).href;
  const page = (url: string): string => {
    const parsed = new URL(url);
    return parsed.protocol + '//' + parsed.host + parsed.pathname;
  };
  const contents = window.webContents;
  let lastRecovery: Parameters<typeof crashRecovery>[0];
  contents.on('render-process-gone', (_event, { reason, exitCode }) => {
    // A reload during a quit keeps the window open, which cancels the quit.
    if (reason === 'clean-exit' || quitting) return;
    const now = Date.now();
    const recovery = crashRecovery(lastRecovery, now);
    if (recovery === 'give-up') {
      console.error(
        `Renderer crashed again within 10 seconds of drawing the crash page; not reloading: ${reason} (${exitCode})`,
      );
      return;
    }
    if (recovery === 'reload') crashes.set(window, { reason, exit_code: exitCode });
    else {
      crashes.delete(window);
      crashPages.set(window, { reason, exit_code: exitCode });
    }
    lastRecovery = { at: now, recovery };
    contents.reload();
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => {
    if (page(event.url) !== page(pageUrl)) event.preventDefault();
  });
  // Visual frames stay on local pages; a navigation must not reach the network.
  contents.on('will-frame-navigate', (event) => {
    const parent = event.frame?.parent?.url;
    if (
      !event.isMainFrame &&
      !event.url.startsWith('about:') &&
      !visuals.owns(window, event.url) &&
      !appPages.owns(window, event.url) &&
      !(parent && appPages.owns(window, parent) && appPages.frames(parent, event.url))
    )
      event.preventDefault();
  });
  // Subscription ids restart with each page, so a reload ends the old page's subscriptions.
  contents.on('did-start-navigation', (event) => {
    if (!event.isMainFrame || event.isSameDocument) return;
    endSubscriptions(contents);
    if (voicePage === contents) cancelVoice();
    // The new page knows nothing of the old page's browser view.
    closeBrowser(window);
  });
  // A page that cancels its contextmenu event, as its own menus do, raises no context-menu here.
  contents.on('context-menu', (_event, params) => {
    const text = menuText();
    const { editFlags, dictionarySuggestions } = params;
    const items: MenuItemConstructorOptions[] = params.isEditable
      ? [
          ...dictionarySuggestions.map((word) => ({
            label: word,
            click: () => contents.replaceMisspelling(word),
          })),
          ...(dictionarySuggestions.length > 0 ? [{ type: 'separator' } as const] : []),
          { role: 'cut', label: text.cut, enabled: editFlags.canCut },
          { role: 'copy', label: text.copy, enabled: editFlags.canCopy },
          { role: 'paste', label: text.paste, enabled: editFlags.canPaste },
          { type: 'separator' },
          { role: 'selectAll', label: text.selectAll, enabled: editFlags.canSelectAll },
        ]
      : params.selectionText
        ? [{ role: 'copy', label: text.copy }]
        : [];
    if (params.linkURL)
      items.push(...(items.length > 0 ? [{ type: 'separator' } as const] : []), {
        label: text.copyLink,
        click: () => clipboard.writeText(params.linkURL),
      });
    if (items.length > 0) Menu.buildFromTemplate(items).popup({ window });
  });
  if (main && saved.maximized) window.maximize();
  if (!main) {
    // maximize() would show the window before its page has drawn, so it waits for the show.
    firstContent.set(
      window,
      isPopover
        ? () => {}
        : isMini
          ? () => window.showInactive()
          : () => {
              if (saved.maximized) window.maximize();
              window.show();
            },
    );
    // A window that opens later than 250 ms after the request reads as a missed click, so past that it
    // shows in the page background and the page fills it. A popover asked for before its page has
    // drawn waits up to 5 s; a page that failed never reports.
    setTimeout(() => contentDrawn(window), isPopover ? 5_000 : 250);
  }
  if (main) {
    const save = debounced(
      () =>
        writeWindowState(windowFile, {
          ...window.getNormalBounds(),
          maximized: window.isMaximized(),
        }),
      500,
    );
    window.on('resize', save.schedule);
    window.on('move', save.schedule);
    window.on('maximize', save.schedule);
    window.on('unmaximize', save.schedule);
    if (process.platform !== 'darwin') window.on('focus', () => window.flashFrame(false));
    window.on('close', (event) => {
      save.flush();
      // The hidden page keeps sending notifications and setting the badge.
      if (quitting || !prefs.keep_running_on_close) return;
      event.preventDefault();
      // The hidden page keeps its composer, which an empty final takes out of voice input.
      if (voicePage === contents) {
        cancelVoice();
        contents.send('pantheon:voice', { type: 'final', text: '' } satisfies VoiceEvent);
      }
      if (runningCount > 0 && !backgroundNoticeShown) {
        const text = menuText();
        const notification = new Notification({
          title: text.backgroundTitle,
          body: text.backgroundBody(runningCount),
        });
        notifications.add(notification);
        notification.on('click', () => notifications.delete(notification));
        notification.on('close', () => notifications.delete(notification));
        notification.show();
        backgroundNoticeShown = true;
        replaceFile(
          settingsFile,
          JSON.stringify({ ...readSettings(settingsFile), background_notice_shown: true }) + '\n',
        );
      }
      if (!window.isFullScreen()) window.hide();
      else {
        // Hiding a full-screen window leaves a black screen behind.
        window.once('leave-full-screen', () => window.hide());
        window.setFullScreen(false);
      }
    });
  }
  if (isPopover) window.on('blur', () => window.hide());
  if (isMini) {
    let moved = false;
    const savePlace = debounced(() => {
      if (!moved) return;
      moved = false;
      const [x, y] = window.getPosition();
      replaceFile(
        settingsFile,
        JSON.stringify({ ...readSettings(settingsFile), mini_window_position: { x, y } }) + '\n',
      );
    }, 500);
    window.on('move', () => {
      moved = true;
      savePlace.schedule();
    });
    window.on('close', savePlace.flush);
  }
  window.on('closed', () => {
    const browser = browsers.get(window);
    browsers.delete(window);
    browser?.view.webContents.close();
    windows.delete(window);
    firstContent.delete(window);
    if (isPopover) popover = undefined;
    if (isMini && mini === window) {
      mini = undefined;
      // Closed some other way than its switch, as by Close Window, it stays off.
      if (!quitting && prefs.mini_window) setMiniWindow(false);
    }
    endSubscriptions(contents);
    if (voicePage === contents) cancelVoice();
    // Only a main window that does not keep running closes outside a quit.
    if (main && !quitting) app.quit();
  });
  // A secondary window's page reads what it shows from its query.
  const query: Record<string, string> = {};
  if (!main) {
    query.kind = context.kind;
    if (context.project_id) query.project_id = context.project_id;
    if (context.session_id) query.session_id = context.session_id;
  }
  if (rendererUrl) {
    const url = new URL(rendererUrl);
    url.search = new URLSearchParams(query).toString();
    void window.loadURL(url.href);
  } else {
    void window.loadFile(path.join(import.meta.dirname, '../renderer/index.html'), { query });
  }
  return window;
}

/** Focuses the window already showing the session or project, else opens one. */
const openWindow = (request: WindowRequest): BrowserWindow => {
  const open = [...windows].find(([, context]) =>
    request.kind === 'session'
      ? context.kind === 'session' && context.session_id === request.session_id
      : context.kind === 'project' && context.project_id === request.project_id,
  )?.[0];
  if (!open) return createWindow({ ...request });
  // A window still waiting for its first content shows itself then.
  if (firstContent.has(open)) return open;
  open.show();
  open.focus();
  return open;
};

/** Shows and focuses the main window, opening one when there is none. */
const reveal = (): BrowserWindow => {
  const main = mainWindow() ?? createWindow({ kind: 'main' });
  main.show();
  main.focus();
  return main;
};

/** Shows the main window and hands it action, for the Dock menu and the jump list. */
const revealWith = (action: MenuAction): void => sendLoaded(reveal(), 'pantheon:menu', action);

/** Shows what a link names: a session as a notification click does, a project in the main window, or a new session. */
const followLink = (link: PantheonLink): void => {
  if (link.kind === 'session')
    showTarget({ project_id: link.project_id, session_id: link.session_id });
  else if (link.kind === 'project')
    sendLoaded(reveal(), 'pantheon:show-in-main', { project_id: link.project_id });
  else revealWith('new-session');
};

/** Acts on the link, else the jump list flag, a launch's arguments carry; false when they carry neither. */
const followLaunch = (argv: readonly string[]): boolean => {
  const link = argv.map(readLink).find((read) => read !== null);
  if (link) {
    followLink(link);
    return true;
  }
  const action = launchAction(argv);
  if (action) revealWith(action);
  return action !== null;
};

/** Opens the project whose root the folder is, else starts Open Project. */
const openFolder = async (folder: string): Promise<void> => {
  const board = await bridge.query('board');
  const projects = board.ok
    ? (board.value as { projects: { id: string; roots: string[] }[] }).projects
    : [];
  const known = projects.find((project) =>
    project.roots.some((root) => path.resolve(root) === path.resolve(folder)),
  );
  if (known) sendLoaded(reveal(), 'pantheon:show-in-main', { project_id: known.id });
  else revealWith('open-project');
};

const sendMenuAction = (action: MenuAction): void => {
  const focused = focusedWindow();
  const context = focused && windows.get(focused);
  // A session window has no settings, sidebar or projects screen of its own.
  const mainOnly = action === 'new-session' || action === 'open-project' || action === 'settings';
  if (action === 'about' || (context?.kind === 'session' && mainOnly)) {
    const main = reveal();
    if (action === 'new-session' && context?.project_id)
      sendLoaded(main, 'pantheon:show-in-main', { project_id: context.project_id });
    sendLoaded(main, 'pantheon:menu', action);
    return;
  }
  const target = focused ?? mainWindow() ?? createWindow({ kind: 'main' });
  target.show();
  sendLoaded(target, 'pantheon:menu', action);
};

/** Opens the current project in a project window; a project window's New Window goes back to the main window. */
const newWindow = (): void => {
  const focused = focusedWindow();
  const context = focused && windows.get(focused);
  if (context?.kind === 'project') reveal();
  else if (context?.kind === 'session')
    openWindow({ kind: 'project', project_id: context.project_id! });
  // Only the main window's page knows which project it shows.
  else sendLoaded(reveal(), 'pantheon:new-window', null);
};

/** Moves the focused page one zoom factor and gives it to every window, as the appearance settings do. */
const zoomFromMenu = (step: ZoomStep): void => {
  const from = focusedWindow() ?? mainWindow();
  if (!from) return;
  const factor = nextZoom(from.webContents.getZoomFactor(), step);
  for (const window of windows.keys()) window.webContents.setZoomFactor(factor);
  writeZoom(zoomFile, factor);
};

handle('pantheon:openWindow', async (request: unknown) => {
  const read = readWindowRequest(request);
  if (!read)
    return {
      ok: false,
      error: {
        code: 'invalid_input',
        message: 'request must name a session with its project, or a project',
      },
    };
  openWindow(read);
  return { ok: true, value: null };
});
handle('pantheon:showInMainWindow', async (place: unknown) => {
  const read = readWindowPlace(place);
  if (!read)
    return {
      ok: false,
      error: { code: 'invalid_input', message: 'place must name a project, and maybe a session' },
    };
  sendLoaded(reveal(), 'pantheon:show-in-main', read);
  return { ok: true, value: null };
});
handleFrom('pantheon:confirmQuit', async (from) => {
  if (windows.get(from)!.kind !== 'main') return forbidden;
  clearTimeout(quitFallback);
  quitting = true;
  app.quit();
  return { ok: true, value: null };
});
handleFrom('pantheon:askQuit', async (from, question: unknown) => {
  if (windows.get(from)!.kind !== 'main') return forbidden;
  clearTimeout(quitFallback);
  const { message, detail, quit, cancel } = (question ?? {}) as Record<string, unknown>;
  if (
    typeof message !== 'string' ||
    typeof detail !== 'string' ||
    typeof quit !== 'string' ||
    typeof cancel !== 'string'
  )
    return {
      ok: false,
      error: { code: 'invalid_input', message: 'message, detail, quit and cancel must be strings' },
    };
  // The main window may be hidden while the app keeps running; macOS attaches the box to it as a sheet.
  quitQuestion ??= dialog
    .showMessageBox(reveal(), {
      type: 'warning',
      message,
      detail,
      buttons: [quit, cancel],
      defaultId: 0,
      cancelId: 1,
    })
    .then(({ response }) => {
      if (response === 0) {
        quitting = true;
        app.quit();
      }
    })
    .finally(() => (quitQuestion = undefined));
  await quitQuestion;
  return { ok: true, value: null };
});
handleFrom('pantheon:setPopoverHeight', async (from, px: unknown) => {
  if (windows.get(from)!.kind !== 'popover') return forbidden;
  if (typeof px !== 'number' || !Number.isFinite(px))
    return { ok: false, error: { code: 'invalid_input', message: 'px must be a finite number' } };
  // The page measures in CSS pixels, which its zoom scales.
  from.setSize(
    320,
    Math.round(Math.min(480, Math.max(120, px)) * from.webContents.getZoomFactor()),
  );
  if (tray) placePopover(from, tray.getBounds());
  return { ok: true, value: null };
});
handle('pantheon:revealMain', async (action: unknown) => {
  if (
    action !== undefined &&
    action !== 'new-session' &&
    action !== 'open-project' &&
    action !== 'settings' &&
    action !== 'about' &&
    action !== 'copy-diagnostics'
  )
    return { ok: false, error: { code: 'invalid_input', message: 'action must be a menu action' } };
  const main = reveal();
  if (action !== undefined) sendLoaded(main, 'pantheon:menu', action);
  popover?.hide();
  return { ok: true, value: null };
});
handle('pantheon:appFocused', async () => ({ ok: true, value: focusedWindow() !== undefined }));
handleFrom('pantheon:setAlwaysOnTop', async (from, on: unknown) => {
  if (typeof on !== 'boolean')
    return { ok: false, error: { code: 'invalid_input', message: 'on must be a boolean' } };
  from.setAlwaysOnTop(on);
  return { ok: true, value: null };
});

const miniItem = () => ({
  shown: prefs.mini_window,
  toggle: () => setMiniWindow(!prefs.mini_window),
});
const trayMenu = () =>
  Menu.buildFromTemplate(
    trayMenuTemplate({
      name: app.name,
      reveal,
      send: sendMenuAction,
      quit: () => app.quit(),
      mini: miniItem(),
    }),
  );
/** Puts the popover under the tray icon, else above it, inside the work area of the icon's display. */
const placePopover = (shown: BrowserWindow, icon: Rectangle): void => {
  const area = screen.getDisplayNearestPoint({
    x: Math.round(icon.x + icon.width / 2),
    y: Math.round(icon.y + icon.height / 2),
  }).workArea;
  const height = shown.getSize()[1]!;
  const below = icon.y + icon.height;
  const top = below + height <= area.y + area.height ? below : icon.y - height;
  const left = Math.round(icon.x + icon.width / 2 - 160);
  shown.setPosition(
    Math.min(Math.max(left, area.x), area.x + area.width - 320),
    Math.min(Math.max(top, area.y), area.y + area.height - height),
  );
};
/** Creates the tray icon while the setting is on and destroys it once off. */
const applyTray = (): void => {
  if (!prefs.show_tray_icon) {
    popover?.destroy();
    tray?.destroy();
    tray = undefined;
    return;
  }
  if (tray) return;
  // Built hidden now so its page has drawn, at its measured height, by the first click.
  popover ??= createWindow({ kind: 'popover' });
  const created = new Tray(trayImage());
  created.setTitle(trayTitle(badgeCount));
  created.setToolTip(countLabel(badgeCount));
  created.on('click', () => {
    if (popover?.isVisible()) {
      popover.hide();
      return;
    }
    const shown = (popover ??= createWindow({ kind: 'popover' }));
    placePopover(shown, created.getBounds());
    const show = (): void => {
      // A menu bar click leaves another app active; the popover blurs, and so hides, only once ours is.
      if (process.platform === 'darwin') app.focus({ steal: true });
      shown.show();
      shown.focus();
    };
    if (firstContent.has(shown)) firstContent.set(shown, show);
    else show();
  });
  // A Linux tray opens only a menu set on it; elsewhere a set menu would also open on a left click.
  if (process.platform === 'linux') created.setContextMenu(trayMenu());
  else created.on('right-click', () => created.popUpContextMenu(trayMenu()));
  tray = created;
};
/** The PNG of one icon, copied beside the main bundle at build time. */
function iconImage(kind: 'dock' | 'window' | 'tray', name: string, scaleFactor = 1) {
  const buffer = readFileSync(path.join(import.meta.dirname, 'app-icons', kind, `${name}.png`));
  return nativeImage.createFromBuffer(buffer, { scaleFactor });
}
/** The chosen menu bar icon, drawn for its point size at scale 2. */
function trayImage() {
  const image = iconImage('tray', prefs.tray_icon, 2);
  // A template image takes the menu bar's own colour on macOS.
  image.setTemplateImage(true);
  return image;
}
/** Shows the chosen app icon in the Dock on macOS and on each window elsewhere. */
function applyAppIcon(): void {
  if (process.platform === 'darwin') app.dock?.setIcon(iconImage('dock', prefs.app_icon));
  else for (const window of windows.keys()) window.setIcon(iconImage('window', prefs.app_icon));
}
/** The native About panel's name, version and copyright, and the chosen app icon, which only Windows and Linux draw from iconPath. */
function applyAboutPanel(): void {
  app.setAboutPanelOptions({
    applicationName: app.name,
    applicationVersion: app.getVersion(),
    copyright: `Copyright © ${app.name}`,
    iconPath: path.join(import.meta.dirname, 'app-icons', 'dock', `${prefs.app_icon}.png`),
  });
}
/** Saves the switch, opens or closes the one mini window and checks its menu items. */
function setMiniWindow(shown: boolean): void {
  const next = { ...prefs, mini_window: shown };
  saveShellPrefs(settingsFile, next);
  prefs = next;
  if (shown) mini ??= createWindow({ kind: 'mini' });
  else {
    mini?.close();
    mini = undefined;
  }
  applyMenu();
}
handle('pantheon:setMiniWindow', async (shown: unknown) => {
  if (typeof shown !== 'boolean')
    return { ok: false, error: { code: 'invalid_input', message: 'shown must be a boolean' } };
  setMiniWindow(shown);
  return { ok: true, value: null };
});
handle('pantheon:miniWindowShown', async () => ({ ok: true, value: prefs.mini_window }));
handle('pantheon:shellPrefs', async () => ({ ok: true, value: prefs }));
handle('pantheon:setShellPrefs', async (patch: unknown) => {
  const read = readShellPrefsPatch(patch);
  if (!read)
    return {
      ok: false,
      error: {
        code: 'invalid_input',
        message:
          'patch must set keep_running_on_close, show_tray_icon or voice_input to a boolean, app_icon to a shape-colour pair it has such as monad-dusk, tray_icon to pantheon, monad or sigma, or voice_engine to null',
      },
    };
  const next = { ...prefs, ...read };
  saveShellPrefs(settingsFile, next);
  prefs = next;
  if (read.voice_input === false && voicePage) {
    voicePage.send('pantheon:voice', { type: 'final', text: '' } satisfies VoiceEvent);
    cancelVoice();
  }
  if (read.tray_icon) tray?.setImage(trayImage());
  applyTray();
  if (read.app_icon) {
    applyAppIcon();
    applyAboutPanel();
  }
  return { ok: true, value: prefs };
});
handle('pantheon:addRecentProject', async (root: unknown) => {
  if (typeof root !== 'string' || !path.isAbsolute(root))
    return {
      ok: false,
      error: { code: 'invalid_input', message: 'root must be an absolute path' },
    };
  const board = await bridge.query('board');
  if (!board.ok || !(board.value as BoardSnapshot).projects.some((p) => p.roots.includes(root)))
    return {
      ok: false,
      error: { code: 'path_refused', message: `${root} is not a project root` },
    };
  // Only macOS and Windows keep recent items.
  if (process.platform !== 'linux') app.addRecentDocument(local(root));
  return { ok: true, value: null };
});
handle('pantheon:openAtLogin', async () => ({
  ok: true,
  value: process.platform === 'linux' ? null : app.getLoginItemSettings().openAtLogin,
}));
handle('pantheon:setOpenAtLogin', async (on: unknown) => {
  if (typeof on !== 'boolean')
    return { ok: false, error: { code: 'invalid_input', message: 'on must be a boolean' } };
  if (process.platform === 'linux')
    return {
      ok: false,
      error: { code: 'unsupported', message: 'Linux keeps no login items for the app' },
    };
  app.setLoginItemSettings({ openAtLogin: on });
  return { ok: true, value: app.getLoginItemSettings().openAtLogin };
});
const systemAccent = (): string | null => accentHex(systemPreferences.getAccentColor());
handle('pantheon:systemAccent', async () => ({ ok: true, value: systemAccent() }));
const sendSystemAccent = (accent: string | null): void => {
  for (const window of windows.keys()) window.webContents.send('pantheon:system-accent', accent);
};

const builtInVoice = resources
  ? path.join(resources, 'voice/pantheon-voice')
  : path.join(import.meta.dirname, '../../stage/voice/pantheon-voice');
/** The engine set, else the built-in one where the system has its speech model; undefined with neither. */
const voiceEngine = (): string | undefined =>
  prefs.voice_engine ??
  (process.platform === 'darwin' &&
  existsSync(builtInVoice) &&
  Number(process.getSystemVersion().split('.')[0]) >= 26
    ? builtInVoice
    : undefined);
ipcMain.handle(
  'pantheon:voiceAvailable',
  (event) => trusted(event) && prefs.voice_input && voiceEngine() !== undefined,
);
ipcMain.on('pantheon:voiceStart', async (event, locale: unknown) => {
  const from = senderWindow(event);
  if (!from) return;
  const contents = from.webContents;
  if (voicePage && voicePage !== contents)
    voicePage.send('pantheon:voice', { type: 'final', text: '' } satisfies VoiceEvent);
  cancelVoice();
  const send = (voiceEvent: VoiceEvent): void => {
    if (!contents.isDestroyed()) contents.send('pantheon:voice', voiceEvent);
  };
  const engineLocale = readVoiceLocale(locale);
  const engine = voiceEngine();
  if (!prefs.voice_input || engine === undefined || engineLocale === null) {
    send({ type: 'error', code: 'unavailable', message: 'Voice input is off or has no engine' });
    return;
  }
  // Owned from here, so a cancel, navigation or close during the prompt ends the start.
  voicePage = contents;
  const run = voiceRun;
  if (engine === builtInVoice) {
    const status = systemPreferences.getMediaAccessStatus('microphone');
    const allowed =
      status === 'not-determined'
        ? await systemPreferences.askForMediaAccess('microphone')
        : status !== 'denied';
    if (run !== voiceRun) return;
    if (!allowed) {
      voicePage = undefined;
      send({
        type: 'error',
        code: 'microphone_denied',
        message: 'Pantheon is not allowed to use the microphone',
      });
      return;
    }
  }
  voice.start(engine, engineLocale, send);
});
/** Runs act when the sending page owns the recognition. */
const onVoice = (channel: string, act: () => void): void => {
  ipcMain.on(channel, (event) => {
    if (voicePage !== undefined && senderWindow(event)?.webContents === voicePage) act();
  });
};
onVoice('pantheon:voiceStop', () => voice.stop());
onVoice('pantheon:voiceCancel', cancelVoice);
onVoice('pantheon:voiceRetry', () => voice.retry());
const PRIVACY_PANES: Record<string, string> = {
  microphone: 'Privacy_Microphone',
  speech: 'Privacy_SpeechRecognition',
  screen: 'Privacy_ScreenCapture',
};
handle('pantheon:openPrivacySettings', async (pane: unknown) => {
  if (process.platform !== 'darwin')
    return {
      ok: false,
      error: { code: 'unsupported', message: 'Only macOS has these privacy settings' },
    };
  if (typeof pane !== 'string' || !Object.hasOwn(PRIVACY_PANES, pane))
    return {
      ok: false,
      error: { code: 'invalid_input', message: 'pane must be microphone, speech or screen' },
    };
  return shell
    .openExternal(`x-apple.systempreferences:com.apple.preference.security?${PRIVACY_PANES[pane]}`)
    .then(
      () => ({ ok: true, value: null }),
      (error: unknown) => ({ ok: false, error: { code: 'open_failed', message: String(error) } }),
    );
});
handleFrom('pantheon:chooseVoiceEngine', async (from) => {
  const result = await dialog.showOpenDialog(from, { properties: ['openFile'] });
  if (result.canceled) return { ok: true, value: null };
  const next = { ...prefs, voice_engine: result.filePaths[0]! };
  saveShellPrefs(settingsFile, next);
  prefs = next;
  return { ok: true, value: prefs.voice_engine };
});

/** The saved language choice and the language it shows. */
const localeState = () => {
  const choice = readLocale(settingsFile);
  return { choice, resolved: resolveLocale(choice, app.getPreferredSystemLanguages()) };
};
// The preload reads the language once, before the page runs.
ipcMain.on('pantheon:locale', (event) => {
  event.returnValue = localeState();
});

// The renderer sends the keys the user gave the menu's items each time it loads.
let menuAccelerators: Partial<Record<MenuAction, string>> = {};
/** Builds the application menu in the saved language. */
const applyMenu = (): void => {
  setMenuLocale(localeState().resolved);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      appMenuTemplate({
        platform: process.platform,
        name: app.name,
        dev: !app.isPackaged,
        send: sendMenuAction,
        zoom: zoomFromMenu,
        newWindow,
        openLogs: () => shell.showItemInFolder(path.dirname(logFile)),
        about: () => app.showAboutPanel(),
        mini: miniItem(),
        accelerators: menuAccelerators,
      }),
    ),
  );
  if (process.platform === 'linux') tray?.setContextMenu(trayMenu());
  applyDockMenu();
  const tasks = jumpListTasks(process.platform, app.isPackaged, process.execPath);
  if (tasks.length > 0) app.setUserTasks(tasks);
};
handle('pantheon:setMenuShortcuts', async (keys: unknown) => {
  const accelerators = readMenuShortcuts(keys);
  if (!accelerators)
    return {
      ok: false,
      error: {
        code: 'invalid_input',
        message: 'keys must map menu actions to one key with Meta, Control or Alt',
      },
    };
  menuAccelerators = accelerators;
  applyMenu();
  return { ok: true, value: null };
});
handleFrom('pantheon:popupAppMenu', async (from, x: unknown, y: unknown) => {
  if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y))
    return {
      ok: false,
      error: { code: 'invalid_input', message: 'x and y must be finite numbers' },
    };
  // The page measures in CSS pixels, which its zoom scales.
  const zoom = from.webContents.getZoomFactor();
  Menu.getApplicationMenu()?.popup({
    window: from,
    x: Math.round(x * zoom),
    y: Math.round(y * zoom),
  });
  return { ok: true, value: null };
});
/** The entries a page asked popupMenu for; null unless each is a separator or an item with an id, a label and enabled. */
const readPopupItems = (value: unknown, depth = 0): PopupMenuItem[] | null => {
  if (!Array.isArray(value) || depth > 2) return null;
  const read: PopupMenuItem[] = [];
  for (const one of value) {
    const { separator, id, label, enabled, checked, danger, items } = (one ?? {}) as Record<
      string,
      unknown
    >;
    if (separator === true) {
      read.push({ separator: true });
      continue;
    }
    const submenu = items === undefined ? undefined : readPopupItems(items, depth + 1);
    if (
      typeof id !== 'string' ||
      typeof label !== 'string' ||
      typeof enabled !== 'boolean' ||
      (checked !== undefined && typeof checked !== 'boolean') ||
      (danger !== undefined && typeof danger !== 'boolean') ||
      submenu === null
    )
      return null;
    read.push({
      id,
      label,
      enabled,
      ...(checked === undefined ? {} : { checked }),
      ...(danger === undefined ? {} : { danger }),
      ...(submenu ? { items: submenu } : {}),
    });
  }
  return read;
};
const popupTemplate = (
  items: PopupMenuItem[],
  pick: (id: string) => void,
): MenuItemConstructorOptions[] =>
  items.map((item) =>
    'separator' in item
      ? { type: 'separator' }
      : {
          label: item.label,
          enabled: item.enabled,
          ...(item.items
            ? { submenu: popupTemplate(item.items, pick) }
            : {
                ...(item.checked === undefined ? {} : { type: 'checkbox', checked: item.checked }),
                click: () => pick(item.id),
              }),
        },
  );
handleFrom('pantheon:popupMenu', async (from, items: unknown) => {
  const read = readPopupItems(items);
  if (!read)
    return {
      ok: false,
      error: {
        code: 'invalid_input',
        message: 'items must be separators or items with an id, a label and enabled',
      },
    };
  return new Promise<BridgeResult<string | null>>((resolve) => {
    const menu = Menu.buildFromTemplate(
      popupTemplate(read, (id) => resolve({ ok: true, value: id })),
    );
    // The click of the item picked may come after the menu closes.
    menu.once('menu-will-close', () => setTimeout(() => resolve({ ok: true, value: null })));
    menu.popup({ window: from });
  });
});
handle('pantheon:setLocale', async (choice: LocaleChoice) => {
  if (!LOCALE_CHOICES.includes(choice))
    return {
      ok: false,
      error: { code: 'invalid_input', message: `${JSON.stringify(choice)} is not a language` },
    };
  saveChoice(settingsFile, 'locale', choice);
  applyMenu();
  for (const window of windows.keys()) window.webContents.reload();
  return { ok: true, value: null };
});

void app.whenReady().then(() => {
  if (!primary) return;
  // A signal (kill, pnpm relaunch, a test run) has no one to answer the quit confirmation.
  // Registered after ready: Electron's own handler, installed during startup, would replace an earlier one.
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const)
    process.on(signal, () => {
      quitting = true;
      app.quit();
    });
  // The windows and their frames share the default session; the page itself only writes the clipboard.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, answer) =>
    answer(permission === 'clipboard-sanitized-write'),
  );
  session.defaultSession.setPermissionCheckHandler(
    (_contents, permission) => permission === 'clipboard-sanitized-write',
  );
  protocol.handle('pantheon-visual', (request) => visuals.respond(request));
  protocol.handle('pantheon-app', (request) => appPages.respond(request));
  powerMonitor.on('shutdown', () => {
    quitting = true;
  });
  // A dev build would register the bare Electron binary as the handler.
  if (app.isPackaged) app.setAsDefaultProtocolClient('pantheon');
  applyMenu();
  // Linux shows no About panel until its values are set.
  applyAboutPanel();
  // Windows shows a dev build's notifications only with an app id; this one is the installer's appId.
  if (process.platform === 'win32') app.setAppUserModelId('dev.pantheon.desktop');
  createWindow({ kind: 'main' });
  // A packaged app on the default icon keeps its bundle's own, which macOS draws in the system style.
  if (prefs.app_icon !== 'pantheon-travertine' || !app.isPackaged) applyAppIcon();
  applyTray();
  if (prefs.mini_window) mini = createWindow({ kind: 'mini' });
  void bridge.daemon();
  // IPC handlers are registered once above, so a new window reuses them.
  app.on('activate', reveal);
  app.on('second-instance', (_event, argv) => {
    if (!followLaunch(argv)) reveal();
  });
  // macOS raises no event when the accent changes.
  if (process.platform === 'darwin')
    app.on('browser-window-focus', () => sendSystemAccent(systemAccent()));
  else
    systemPreferences.on('accent-color-changed', (_event, colour) =>
      sendSystemAccent(accentHex(colour)),
    );
  started = true;
  for (const act of startQueue.splice(0)) act();
  followLaunch(process.argv);
});

app.on('window-all-closed', () => {
  if (quitsWhenAllWindowsClosed(process.platform)) app.quit();
});
