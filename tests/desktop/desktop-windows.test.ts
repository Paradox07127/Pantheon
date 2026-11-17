import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { MenuItemConstructorOptions } from 'electron';
import { startDaemon } from '@pantheon/daemon';
import { FixtureAdapter } from '@pantheon/adapters';
import {
  command,
  type DesktopBridge,
  type EventFrame,
  type ShellPrefs,
  type VoiceEvent,
  type WindowContext,
  type WindowPlace,
  type WindowRequest,
} from '@pantheon/protocol';
import type { AppInfo, RendererCrash } from '../../packages/protocol/src/bridge.js';
import { setMenuLocale } from '../../apps/desktop/src/main/locales.js';
import {
  accentHex,
  jumpListTasks,
  launchAction,
  readLink,
  titleBarOverlay,
  trayMenuTemplate,
  trayTitle,
  WINDOW_BACKGROUND,
  windowChrome,
} from '../../apps/desktop/src/main/window.js';
import { eventually, user } from '../helpers.js';

const ELECTRON = '../../apps/desktop/node_modules/electron/index.js';
type Handler = (...args: any[]) => unknown;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-windows-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Records listeners by name and calls them on emit. */
class Emitter {
  listeners = new Map<string, Handler[]>();
  on(name: string, fn: Handler) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
    return this;
  }
  once(name: string, fn: Handler) {
    const wrapped = (...args: unknown[]) => {
      this.listeners.set(
        name,
        (this.listeners.get(name) ?? []).filter((l) => l !== wrapped),
      );
      fn(...args);
    };
    return this.on(name, wrapped);
  }
  emit(name: string, ...args: unknown[]) {
    for (const fn of this.listeners.get(name) ?? []) fn(...args);
  }
}

function fakeElectron(root: string) {
  const handlers = new Map<string, Handler>();
  const ipcListeners = new Map<string, Handler>();
  const windows: FakeWindow[] = [];
  const trays: FakeTray[] = [];
  const notices: { title: string; body: string }[] = [];
  const notifications: Emitter[] = [];
  const appMenus: MenuItemConstructorOptions[][] = [];
  const popups: { template: MenuItemConstructorOptions[]; options: unknown }[] = [];
  const builtMenus: (Emitter & { template: MenuItemConstructorOptions[] })[] = [];
  let appMenu: unknown = null;
  let focusedWindow: FakeWindow | null = null;
  class FakeContents extends Emitter {
    mainFrame = {};
    destroyed = false;
    crashed = false;
    sent: unknown[][] = [];
    send(...args: unknown[]) {
      this.sent.push(args);
    }
    isLoading() {
      return false;
    }
    isDestroyed() {
      return this.destroyed;
    }
    getOSProcessId() {
      return this.crashed ? 0 : 1;
    }
    zoom = 1;
    getZoomFactor() {
      return this.zoom;
    }
    reload = vi.fn();
    replaceMisspelling = vi.fn();
    setWindowOpenHandler() {}
  }
  class FakeWindow extends Emitter {
    static getFocusedWindow() {
      return focusedWindow;
    }
    webContents = new FakeContents();
    shown = 0;
    focused = 0;
    hidden = 0;
    onTop = false;
    onTopLevel: string | undefined;
    allWorkspaces = false;
    overlays: unknown[] = [];
    overlayIcons: unknown[][] = [];
    background = '';
    visible = false;
    size: number[] = [];
    position: number[] = [];
    loaded: unknown[][] = [];
    contentView = { addChildView() {}, removeChildView() {} };
    constructor(public options: Record<string, unknown>) {
      super();
      windows.push(this);
    }
    show() {
      this.shown++;
      this.visible = true;
    }
    hide() {
      this.hidden++;
      this.visible = false;
    }
    focus() {
      this.focused++;
    }
    isVisible() {
      return this.visible;
    }
    setBackgroundColor(colour: string) {
      this.background = colour;
    }
    setSize(width: number, height: number) {
      this.size = [width, height];
    }
    getSize() {
      return this.size.length > 0
        ? this.size
        : [this.options.width as number, this.options.height as number];
    }
    setPosition(x: number, y: number) {
      this.position = [x, y];
    }
    destroy() {
      this.webContents.destroyed = true;
      this.emit('closed');
    }
    isFullScreen() {
      return false;
    }
    maximize() {}
    setTitleBarOverlay(overlay: unknown) {
      this.overlays.push(overlay);
    }
    setOverlayIcon(...args: unknown[]) {
      this.overlayIcons.push(args);
    }
    setIcon() {}
    flashes: boolean[] = [];
    flashFrame(on: boolean) {
      this.flashes.push(on);
    }
    setAlwaysOnTop(on: boolean, level?: string) {
      this.onTop = on;
      this.onTopLevel = level;
    }
    setVisibleOnAllWorkspaces(on: boolean) {
      this.allWorkspaces = on;
    }
    showInactive() {
      this.shown++;
      this.visible = true;
    }
    getPosition() {
      return this.position;
    }
    loadURL(...args: unknown[]) {
      this.loaded.push(args);
      return Promise.resolve();
    }
    loadFile(...args: unknown[]) {
      this.loaded.push(args);
      return Promise.resolve();
    }
    getNormalBounds() {
      return { x: 0, y: 0, width: 1200, height: 800 };
    }
    isMaximized() {
      return false;
    }
    /** As Electron does: closed follows unless a close listener prevents it. */
    close() {
      const event = { prevented: false, preventDefault: () => (event.prevented = true) };
      this.emit('close', event);
      if (!event.prevented) this.emit('closed');
      return !event.prevented;
    }
  }
  class FakeTray extends Emitter {
    title: string | undefined;
    tooltip: string | undefined;
    destroyed = false;
    menus: MenuItemConstructorOptions[][] = [];
    constructor(readonly image: { bytes: number; scaleFactor: number; template: boolean }) {
      super();
      trays.push(this);
    }
    getBounds() {
      return { x: 900, y: 0, width: 24, height: 24 };
    }
    setTitle(title: string) {
      this.title = title;
    }
    setToolTip(tooltip: string) {
      this.tooltip = tooltip;
    }
    setContextMenu(menu: { template: MenuItemConstructorOptions[] }) {
      this.menus.push(menu.template);
    }
    popUpContextMenu(menu: { template: MenuItemConstructorOptions[] }) {
      this.menus.push(menu.template);
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const app = Object.assign(new Emitter(), {
    isPackaged: true,
    name: 'Pantheon',
    setPath() {},
    getPath: (name: string) => path.join(root, name),
    getAppPath: () => path.join(root, 'app'),
    getVersion: () => '1.2.3',
    commandLine: { appendSwitch: vi.fn(), hasSwitch: vi.fn(() => false) },
    aboutPanels: [] as Record<string, unknown>[],
    setAboutPanelOptions(options: Record<string, unknown>) {
      app.aboutPanels.push(options);
    },
    showAboutPanel: vi.fn(),
    getPreferredSystemLanguages: () => ['zh-Hans-CN'],
    whenReady: () => Promise.resolve(),
    requestSingleInstanceLock: () => true,
    /** Each app id set, with the number of windows open at the time. */
    appIds: [] as [string, number][],
    setAppUserModelId(id: string) {
      app.appIds.push([id, windows.length]);
    },
    focusCalls: [] as unknown[],
    focus(options?: unknown) {
      app.focusCalls.push(options);
    },
    badgeCounts: [] as number[],
    setBadgeCount(count: number) {
      app.badgeCounts.push(count);
      return true;
    },
    userTasks: [] as unknown[],
    setUserTasks(tasks: unknown) {
      app.userTasks.push(tasks);
      return true;
    },
    // Only macOS has a Dock.
    dock:
      process.platform === 'darwin'
        ? {
            menus: [] as MenuItemConstructorOptions[][],
            bounces: [] as string[],
            setMenu(menu: { template: MenuItemConstructorOptions[] }) {
              this.menus.push(menu.template);
            },
            bounce(type: string) {
              this.bounces.push(type);
              return this.bounces.length;
            },
            setBadge() {},
            setIcon() {},
          }
        : undefined,
    protocolClients: [] as string[],
    setAsDefaultProtocolClient(scheme: string) {
      app.protocolClients.push(scheme);
      return true;
    },
    recentDocuments: [] as string[],
    addRecentDocument(file: string) {
      app.recentDocuments.push(file);
    },
    loginItem: { openAtLogin: false },
    loginItemSets: [] as unknown[],
    getLoginItemSettings: () => ({ ...app.loginItem }),
    setLoginItemSettings(settings: { openAtLogin: boolean }) {
      app.loginItemSets.push(settings);
      app.loginItem = { ...app.loginItem, ...settings };
    },
    quits: 0,
    quit() {
      const event = { prevented: false, preventDefault: () => (event.prevented = true) };
      app.emit('before-quit', event);
      if (!event.prevented) app.quits++;
    },
  });
  const views: FakeView[] = [];
  class FakeView {
    webContents = Object.assign(new FakeContents(), {
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      getURL: () => 'https://example.com/',
      getTitle: () => 'Example',
      loadURL: async () => {},
      close() {},
      capturePage: vi.fn(async (): Promise<unknown> => ({ isEmpty: () => true })),
    });
    setBounds() {}
    constructor(readonly options: unknown) {
      views.push(this);
    }
  }
  /** Records the permission handlers main installs on a session. */
  const permissionSession = () => ({
    requestHandler: undefined as Handler | undefined,
    checkHandler: undefined as Handler | undefined,
    setPermissionRequestHandler(handler: Handler) {
      this.requestHandler = handler;
    },
    setPermissionCheckHandler(handler: Handler) {
      this.checkHandler = handler;
    },
  });
  const workArea = { x: 0, y: 0, width: 1600, height: 1000 };
  type Area = typeof workArea;
  let displays: { bounds: Area; workArea: Area }[] = [{ bounds: workArea, workArea }];
  const inside = (point: { x: number; y: number }, area: Area) =>
    point.x >= area.x &&
    point.x < area.x + area.width &&
    point.y >= area.y &&
    point.y < area.y + area.height;
  const module = {
    app,
    BrowserWindow: FakeWindow,
    WebContentsView: FakeView,
    session: { defaultSession: permissionSession(), fromPartition: () => permissionSession() },
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    Notification: class extends Emitter {
      constructor(readonly options: { title: string; body: string }) {
        super();
        notifications.push(this);
      }
      show() {
        notices.push(this.options);
      }
    },
    dialog: {
      showMessageBox: vi.fn(async (_window: unknown, _options: unknown) => ({
        response: 1,
        checkboxChecked: false,
      })),
      showOpenDialog: vi.fn(async (_window: unknown, _options: unknown) => ({
        canceled: true,
        filePaths: [] as string[],
      })),
    },
    powerMonitor: new Emitter(),
    powerSaveBlocker: { start: () => 1, stop() {} },
    nativeTheme: Object.assign(new Emitter(), { shouldUseDarkColors: false }) as Emitter & {
      shouldUseDarkColors: boolean;
      themeSource?: string;
    },
    shell: { showItemInFolder: vi.fn() },
    clipboard: { writeText: vi.fn() },
    /** accent is what getAccentColor answers, RRGGBBAA. */
    systemPreferences: Object.assign(new Emitter(), {
      accent: '0a84ffff',
      getAccentColor(): string {
        return this.accent;
      },
    }),
    ipcMain: {
      handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
      on: (channel: string, fn: Handler) => ipcListeners.set(channel, fn),
    },
    Menu: {
      buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
        const menu = Object.assign(new Emitter(), {
          template,
          popup: (options: unknown) => popups.push({ template, options }),
        });
        builtMenus.push(menu);
        return menu;
      },
      setApplicationMenu: (menu: { template: MenuItemConstructorOptions[] }) => {
        appMenu = menu;
        appMenus.push(menu.template);
      },
      getApplicationMenu: () => appMenu,
    },
    screen: {
      getAllDisplays: () => displays,
      getPrimaryDisplay: () => displays[0]!,
      getDisplayNearestPoint: (point: { x: number; y: number }) =>
        displays.find((display) => inside(point, display.bounds)) ?? displays[0]!,
    },
    Tray: FakeTray,
    nativeImage: {
      createFromBuffer: (buffer: Buffer, options?: { scaleFactor: number }) => ({
        bytes: buffer.length,
        scaleFactor: options?.scaleFactor,
        template: false,
        setTemplateImage(on: boolean) {
          this.template = on;
        },
      }),
      createFromBitmap: (
        bitmap: Buffer,
        options: { width: number; height: number; scaleFactor: number },
      ) => ({ bitmap, ...options }),
    },
  };
  const focus = (window: FakeWindow | null) => (focusedWindow = window);
  const setDisplays = (next: typeof displays) => (displays = next);
  return {
    module,
    setDisplays,
    handlers,
    ipcListeners,
    windows,
    trays,
    notices,
    notifications,
    appMenus,
    popups,
    builtMenus,
    views,
    focus,
  };
}
type FakeElectron = ReturnType<typeof fakeElectron>;
type FakeWindow = FakeElectron['windows'][number];

/** prepare changes the fake before the main process loads. */
async function startMain(
  platform: NodeJS.Platform,
  root = tempRoot(),
  prepare?: (electron: FakeElectron) => void,
) {
  vi.stubEnv('PANTHEON_DATA_DIR', path.join(root, 'state'));
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...real, value: platform });
  cleanups.push(() => {
    Object.defineProperty(process, 'platform', real);
    vi.unstubAllEnvs();
    vi.doUnmock(ELECTRON);
    vi.resetModules();
  });
  const electron = fakeElectron(root);
  prepare?.(electron);
  vi.doMock(ELECTRON, () => ({ ...electron.module, default: electron.module }));
  vi.resetModules();
  await import('../../apps/desktop/src/main/index.js');
  await eventually(() => electron.windows.length > 0);
  // The tray builds its popover with the main window; tests reach it by name rather than by index.
  const popoverAt = electron.windows.findIndex((window) => window.options.frame === false);
  const [popover] = popoverAt < 0 ? [] : electron.windows.splice(popoverAt, 1);
  const call = (from: FakeWindow, channel: string, ...args: unknown[]) =>
    electron.handlers.get(channel)!(
      { sender: from.webContents, senderFrame: from.webContents.mainFrame },
      ...args,
    );
  const send = (from: FakeWindow, channel: string, ...args: unknown[]) =>
    electron.ipcListeners.get(channel)!(
      { sender: from.webContents, senderFrame: from.webContents.mainFrame },
      ...args,
    );
  const click = (label: string) => {
    const item = electron.appMenus
      .at(-1)!
      .flatMap((menu) => menu.submenu as MenuItemConstructorOptions[])
      .find((entry) => entry.label === label)!;
    (item.click as () => void)();
  };
  return { ...electron, main: electron.windows[0]!, popover: popover!, call, send, click };
}

const sessionRequest = { kind: 'session', project_id: 'alpha', session_id: 'alpha-login' };
/** What a page in a dark theme reports of its top bar and background. */
const darkColours = { dark: true, color: '#20201e', symbolColor: '#f0f0ea', background: '#121211' };
const projectRequest = { kind: 'project', project_id: 'alpha' };

describe('app diagnostics', () => {
  it.each([
    ['darwin', 'macos'],
    ['win32', 'windows'],
    ['linux', 'linux'],
  ] as const)('reports the app and runtime versions on %s', async (platform, osName) => {
    const version = Object.getOwnPropertyDescriptor(process.versions, 'electron');
    Object.defineProperty(process.versions, 'electron', { configurable: true, value: '45.0.0' });
    cleanups.push(() => {
      if (version) Object.defineProperty(process.versions, 'electron', version);
      else Reflect.deleteProperty(process.versions, 'electron');
    });
    const { main, call } = await startMain(platform);
    expect(await call(main, 'pantheon:appInfo')).toStrictEqual({
      ok: true,
      value: {
        version: '1.2.3',
        electron: '45.0.0',
        os: osName,
        os_version: os.release(),
        arch: process.arch,
      },
    });
  });

  it.each(['darwin', 'win32'] as const)(
    'returns and reveals the folder holding the daemon log on %s',
    async (platform) => {
      const root = tempRoot();
      if (platform === 'win32') {
        const resources = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
        Object.defineProperty(process, 'resourcesPath', { configurable: true, value: root });
        writeFileSync(path.join(root, 'linux-runtime.tar.gz'), '');
        vi.doMock('../../apps/desktop/src/main/wsl.js', async (original) => ({
          ...(await original<typeof import('../../apps/desktop/src/main/wsl.js')>()),
          listDistros: async () => [{ name: 'Ubuntu', isDefault: true }],
          checkDistro: async () => ({ missing: [] }),
        }));
        cleanups.push(() => {
          if (resources) Object.defineProperty(process, 'resourcesPath', resources);
          else Reflect.deleteProperty(process, 'resourcesPath');
          vi.doUnmock('../../apps/desktop/src/main/wsl.js');
        });
      }
      const logFiles: string[] = [];
      vi.doMock('../../apps/desktop/src/main/daemon.js', async (original) => {
        const actual = await original<typeof import('../../apps/desktop/src/main/daemon.js')>();
        return {
          ...actual,
          DaemonBridge: class extends actual.DaemonBridge {
            constructor(options: ConstructorParameters<typeof actual.DaemonBridge>[0]) {
              super(options);
              logFiles.push(options.logFile);
            }
            async daemon() {
              return {
                ok: false as const,
                error: { code: 'daemon_unavailable', message: 'No daemon in this test' },
              };
            }
          },
        };
      });
      cleanups.push(() => vi.doUnmock('../../apps/desktop/src/main/daemon.js'));
      const { main, call, module } = await startMain(platform, root);
      const { value: directory } = (await call(main, 'pantheon:logsDir')) as { value: string };
      expect(logFiles).toHaveLength(1);
      expect(directory).toBe(path.dirname(logFiles[0]!));
      expect(path.isAbsolute(directory)).toBe(true);
      expect(await call(main, 'pantheon:revealPath', directory)).toEqual({ ok: true, value: null });
      expect(module.shell.showItemInFolder).toHaveBeenCalledWith(directory);
    },
  );

  it.each(['missing-package', 'no-distro'] as const)(
    'checks WSL again on the next call once it has been repaired (%s)',
    async (broken) => {
      const root = tempRoot();
      const resources = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
      Object.defineProperty(process, 'resourcesPath', { configurable: true, value: root });
      writeFileSync(path.join(root, 'linux-runtime.tar.gz'), '');
      const wsl = { repaired: false, checks: 0 };
      vi.doMock('../../apps/desktop/src/main/wsl.js', async (original) => ({
        ...(await original<typeof import('../../apps/desktop/src/main/wsl.js')>()),
        listDistros: async () =>
          broken === 'no-distro' && !wsl.repaired ? [] : [{ name: 'Ubuntu', isDefault: true }],
        checkDistro: async () => {
          wsl.checks++;
          return { missing: broken === 'missing-package' && !wsl.repaired ? ['socat'] : [] };
        },
        // Nothing in this test reaches a real wsl.exe.
        runWsl: async () => {
          throw new Error('no WSL in this test');
        },
      }));
      vi.doMock('../../apps/desktop/src/main/daemon.js', async (original) => {
        const actual = await original<typeof import('../../apps/desktop/src/main/daemon.js')>();
        return {
          ...actual,
          DaemonBridge: class extends actual.DaemonBridge {
            async query(method: string) {
              return method === 'board'
                ? {
                    ok: true as const,
                    value: {
                      projects: [{ id: 'notes', roots: ['/home/ada/notes'] }],
                      workspaces: [],
                    },
                  }
                : super.query(method);
            }
          },
        };
      });
      cleanups.push(() => {
        if (resources) Object.defineProperty(process, 'resourcesPath', resources);
        else Reflect.deleteProperty(process, 'resourcesPath');
        vi.doUnmock('../../apps/desktop/src/main/wsl.js');
        vi.doUnmock('../../apps/desktop/src/main/daemon.js');
      });
      const { main, call, module } = await startMain('win32', root);
      const before = (await call(main, 'pantheon:daemon')) as { error: { message: string } };
      expect(before.error.message).toContain(
        broken === 'missing-package' ? 'sudo apt install socat' : 'wsl --install',
      );
      wsl.repaired = true;
      const checks = wsl.checks;
      const after = (await call(main, 'pantheon:daemon')) as { error: { message: string } };
      expect(wsl.checks).toBeGreaterThan(checks);
      expect(after.error.message).toContain('Installing the runtime in WSL failed');
      // Paths from the daemon open through the distro found.
      await call(main, 'pantheon:revealPath', '/home/ada/notes');
      expect(module.shell.showItemInFolder).toHaveBeenLastCalledWith(
        '\\\\wsl.localhost\\Ubuntu\\home\\ada\\notes',
      );
    },
  );

  it.each([
    ['a packaged build', true, null, null, false],
    ['a dev build without a port file', false, null, {}, false],
    // The daemon reads the port file for each turn, so the target carries no port.
    ['a dev build with a port file', false, '41235\n/devtools/browser/abc\n', {}, false],
    [
      'a dev build started with a debugging port',
      false,
      '41236\n/devtools/browser/abc\n',
      {},
      true,
    ],
  ] as const)('gives the debug target of %s', async (_name, packaged, portFile, target, given) => {
    const root = tempRoot();
    const { main, call, module } = await startMain('darwin', root, ({ module }) => {
      module.app.isPackaged = packaged;
      module.app.commandLine.hasSwitch.mockReturnValue(given);
      if (!packaged) fakeDaemon();
      if (portFile !== null) {
        mkdirSync(module.app.getPath('userData'), { recursive: true });
        writeFileSync(path.join(module.app.getPath('userData'), 'DevToolsActivePort'), portFile);
      }
    });
    expect(await call(main, 'pantheon:debugTarget')).toEqual({
      ok: true,
      value: target && { ...target, repo_root: path.resolve(root, 'app', '../..') },
    });
    expect(module.app.commandLine.appendSwitch.mock.calls).toEqual(
      packaged || given ? [] : [['remote-debugging-port', '0']],
    );
  });

  it('reveals only the folders the daemon reports and refuses any other path', async () => {
    vi.doMock('../../apps/desktop/src/main/daemon.js', async (original) => {
      const actual = await original<typeof import('../../apps/desktop/src/main/daemon.js')>();
      const answers: Record<string, unknown> = {
        board: {
          projects: [{ id: 'alpha', roots: ['/work/alpha', '/work/alpha-docs'] }],
          workspaces: [
            { id: 'login', path: '/worktrees/alpha-login', source: '/work/alpha' },
            { id: 'inline', path: '/work/alpha-inline', source: '/work/alpha-source' },
          ],
        },
        'workspace.stale': { count: 0, worktree_root: '/worktrees' },
        'repo.worktrees': [
          { path: '/private/work/alpha', kind: 'checkout' },
          { path: '/elsewhere/alpha-feature', kind: 'external' },
        ],
      };
      return {
        ...actual,
        DaemonBridge: class extends actual.DaemonBridge {
          watchBuilds() {
            return () => {};
          }
          async daemon() {
            return {
              ok: true as const,
              value: {
                url: 'http://127.0.0.1:1',
                version: '1.2.3',
                protocol_version: 1,
                started_here: false,
                data_dir: '/data/pantheon',
              },
            };
          }
          async query(method: string, params: Record<string, string | string[]> = {}) {
            if (method !== 'board' && params.project_id !== 'alpha')
              return { ok: false as const, error: { code: 'not_found', message: method } };
            return method in answers
              ? { ok: true as const, value: answers[method] }
              : { ok: false as const, error: { code: 'unknown_route', message: method } };
          }
        },
      };
    });
    cleanups.push(() => vi.doUnmock('../../apps/desktop/src/main/daemon.js'));
    const { main, call, module } = await startMain('darwin');
    const { value: logs } = (await call(main, 'pantheon:logsDir')) as { value: string };
    const shown = [
      logs,
      '/data/pantheon',
      '/work/alpha',
      '/work/alpha-docs',
      '/worktrees/alpha-login',
      '/work/alpha-source',
      '/worktrees',
      '/private/work/alpha',
      '/elsewhere/alpha-feature',
    ];
    for (const target of shown)
      expect(await call(main, 'pantheon:revealPath', target)).toEqual({ ok: true, value: null });
    for (const target of ['/etc', '/work/alpha/src', '/data', '/Applications/Calculator.app'])
      expect(await call(main, 'pantheon:revealPath', target)).toMatchObject({
        ok: false,
        error: { code: 'path_refused' },
      });
    expect(module.shell.showItemInFolder.mock.calls).toEqual(shown.map((target) => [target]));
  });

  it('refuses diagnostics from strangers and subframes without consuming a crash', async () => {
    const { main, handlers, call } = await startMain('darwin');
    main.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 9 });
    for (const channel of [
      'pantheon:appInfo',
      'pantheon:logsDir',
      'pantheon:lastCrash',
      'pantheon:exportDiagnostics',
      'pantheon:daemonStarting',
    ]) {
      for (const sender of [
        { sender: {}, senderFrame: {} },
        { sender: main.webContents, senderFrame: {} },
      ])
        expect(await handlers.get(channel)!(sender)).toMatchObject({
          ok: false,
          error: { code: 'forbidden_sender' },
        });
    }
    expect(await call(main, 'pantheon:lastCrash')).toEqual({
      ok: true,
      value: { reason: 'crashed', exit_code: 9 },
    });
  });

  it('saves the log folder as one text file where the user picks, each file under its name', async () => {
    const root = tempRoot();
    const { main, call, module } = await startMain('darwin', root);
    const { value: directory } = (await call(main, 'pantheon:logsDir')) as { value: string };
    mkdirSync(path.join(directory, 'older'), { recursive: true });
    writeFileSync(path.join(directory, 'daemon.log'), 'daemon started\n');
    writeFileSync(path.join(directory, 'app.log'), 'window opened');
    const showSaveDialog = vi.fn();
    Object.assign(module.dialog, { showSaveDialog });
    const saved = path.join(root, 'diagnostics.log');
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: saved });
    expect(await call(main, 'pantheon:exportDiagnostics')).toEqual({ ok: true, value: saved });
    expect(showSaveDialog.mock.calls[0]![0]).toBe(main);
    expect(showSaveDialog.mock.calls[0]![1].defaultPath).toMatch(/\.log$/);
    expect(readFileSync(saved, 'utf8')).toBe(
      '==> app.log <==\nwindow opened\n==> daemon.log <==\ndaemon started\n',
    );

    showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: '' });
    expect(await call(main, 'pantheon:exportDiagnostics')).toEqual({ ok: true, value: null });
    showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: path.join(root, 'missing', 'diagnostics.log'),
    });
    expect(await call(main, 'pantheon:exportDiagnostics')).toMatchObject({
      ok: false,
      error: { code: 'export_failed' },
    });
  });

  it('tells whether the app is starting the daemon', async () => {
    const bridges: { starting: boolean }[] = [];
    vi.doMock('../../apps/desktop/src/main/daemon.js', async (original) => {
      const actual = await original<typeof import('../../apps/desktop/src/main/daemon.js')>();
      return {
        ...actual,
        DaemonBridge: class extends actual.DaemonBridge {
          constructor(options: ConstructorParameters<typeof actual.DaemonBridge>[0]) {
            super(options);
            bridges.push(this);
          }
        },
      };
    });
    cleanups.push(() => vi.doUnmock('../../apps/desktop/src/main/daemon.js'));
    const { main, call } = await startMain('darwin');
    expect(bridges).toHaveLength(1);
    bridges[0]!.starting = true;
    expect(await call(main, 'pantheon:daemonStarting')).toEqual({ ok: true, value: true });
    bridges[0]!.starting = false;
    expect(await call(main, 'pantheon:daemonStarting')).toEqual({ ok: true, value: false });
  });
});

describe('renderer crash recovery', () => {
  it.each(['crashed', 'killed', 'oom', 'abnormal-exit', 'launch-failed', 'integrity-failure'])(
    'reloads after %s and returns its details once only to that window',
    async (reason) => {
      const { main, call, windows } = await startMain('darwin');
      await call(main, 'pantheon:openWindow', sessionRequest);
      const session = windows[1]!;
      expect(await call(session, 'pantheon:lastCrash')).toEqual({ ok: true, value: null });
      session.webContents.emit('render-process-gone', {}, { reason, exitCode: 9 });
      expect(session.webContents.reload).toHaveBeenCalledTimes(1);
      expect(main.webContents.reload).not.toHaveBeenCalled();
      expect(await call(main, 'pantheon:lastCrash')).toEqual({ ok: true, value: null });
      expect(await call(session, 'pantheon:lastCrash')).toEqual({
        ok: true,
        value: { reason, exit_code: 9 },
      });
      expect(await call(session, 'pantheon:lastCrash')).toEqual({ ok: true, value: null });
    },
  );

  it('ignores a clean exit', async () => {
    const { main, call } = await startMain('darwin');
    main.webContents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
    expect(main.webContents.reload).not.toHaveBeenCalled();
    expect(await call(main, 'pantheon:lastCrash')).toEqual({ ok: true, value: null });
  });

  it('reloads into the crash page after a second crash within ten seconds, gives up on a third and lets another window recover', async () => {
    const { main, call, windows, ipcListeners } = await startMain('darwin');
    await call(main, 'pantheon:openWindow', projectRequest);
    const project = windows[1]!;
    const crashPage = (from: FakeWindow, senderFrame: unknown = from.webContents.mainFrame) => {
      const event: { sender: unknown; senderFrame: unknown; returnValue?: unknown } = {
        sender: from.webContents,
        senderFrame,
      };
      ipcListeners.get('pantheon:crashPage')!(event);
      return event.returnValue;
    };
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    cleanups.push(() => {
      now.mockRestore();
      log.mockRestore();
    });
    main.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    expect(crashPage(main)).toBeNull();
    expect(await call(main, 'pantheon:lastCrash')).toEqual({
      ok: true,
      value: { reason: 'crashed', exit_code: 1 },
    });
    now.mockReturnValue(109_999);
    main.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 2 });
    expect(main.webContents.reload).toHaveBeenCalledTimes(2);
    expect(await call(main, 'pantheon:lastCrash')).toEqual({ ok: true, value: null });
    expect(crashPage(main, {})).toBeNull();
    expect(crashPage(project)).toBeNull();
    expect(crashPage(main)).toEqual({ reason: 'oom', exit_code: 2 });
    expect(crashPage(main)).toBeNull();
    now.mockReturnValue(119_998);
    main.webContents.emit('render-process-gone', {}, { reason: 'killed', exitCode: 5 });
    expect(main.webContents.reload).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]!.join(' ')).toMatch(/killed/);
    expect(crashPage(main)).toBeNull();
    project.webContents.emit('render-process-gone', {}, { reason: 'killed', exitCode: 3 });
    expect(project.webContents.reload).toHaveBeenCalledTimes(1);
    expect(crashPage(project)).toBeNull();
    now.mockReturnValue(119_999);
    main.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 4 });
    expect(main.webContents.reload).toHaveBeenCalledTimes(3);
    expect(crashPage(main)).toBeNull();
  });
});

describe('window registry', () => {
  it('trusts the page of every open window and stops trusting a closed one', async () => {
    const electron = await startMain('darwin');
    const { main, call } = electron;
    expect(await call(main, 'pantheon:openWindow', sessionRequest)).toEqual({
      ok: true,
      value: null,
    });
    const session = electron.windows[1]!;
    expect(await call(session, 'pantheon:setAlwaysOnTop', true)).toEqual({ ok: true, value: null });
    expect([main.onTop, session.onTop]).toEqual([false, true]);
    expect(await call(main, 'pantheon:setAlwaysOnTop', 'yes')).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    const stranger = { sender: {}, senderFrame: {} };
    expect(await electron.handlers.get('pantheon:setAlwaysOnTop')!(stranger, true)).toMatchObject({
      ok: false,
      error: { code: 'forbidden_sender' },
    });
    expect(session.close()).toBe(true);
    expect(await call(session, 'pantheon:setAlwaysOnTop', false)).toMatchObject({
      ok: false,
      error: { code: 'forbidden_sender' },
    });
    expect(await call(main, 'pantheon:setAlwaysOnTop', true)).toEqual({ ok: true, value: null });
  });

  it("keeps the other window's subscription, with the same id, when one window closes", async () => {
    const root = tempRoot();
    mkdirSync(path.join(root, 'project'));
    const daemon = await startDaemon({
      directory: path.join(root, 'state'),
      adapters: [new FixtureAdapter()],
    });
    cleanups.push(() => daemon.close());
    const electron = await startMain('darwin', root);
    const { main, call } = electron;
    await call(main, 'pantheon:openWindow', projectRequest);
    const project = electron.windows[1]!;
    const subscribe = (window: FakeWindow) =>
      electron.ipcListeners.get('pantheon:subscribe')!(
        {
          sender: window.webContents,
          senderFrame: window.webContents.mainFrame,
          reply: (...args: unknown[]) => window.webContents.send(...args),
        },
        1,
        {},
      );
    const frames = (window: FakeWindow) =>
      window.webContents.sent.flatMap(([channel, , frame]) =>
        channel === 'pantheon:event' ? [frame as EventFrame] : [],
      );
    subscribe(main);
    subscribe(project);
    await eventually(() =>
      [main, project].every((window) => frames(window).some((f) => f.type === 'subscribed')),
    );
    project.close();
    daemon.control.execute(
      user,
      command(user.id, 'project.open', { name: 'desktop', roots: [path.join(root, 'project')] }),
    );
    await eventually(() => frames(main).some((f) => f.type === 'event'));
    await sleep(100);
    expect(frames(project).map((f) => f.type)).toEqual(['subscribed']);
    expect(frames(main).some((f) => f.type === 'closed')).toBe(false);
  });
});

describe('session and project windows', () => {
  it('focuses the window already showing the session when its notification is clicked', async () => {
    const electron = await startMain('darwin');
    const { main, call } = electron;
    await call(main, 'pantheon:openWindow', sessionRequest);
    const session = electron.windows[1]!;
    electron.send(session, 'pantheon:ready');
    const before = [main.shown, main.focused];
    const target = { project_id: 'alpha', session_id: 'alpha-login' };
    await call(main, 'pantheon:notify', { title: 'Alpha app', body: 'Turn ended', target });
    electron.notifications.at(-1)!.emit('click');
    expect([session.shown, session.focused]).toEqual([2, 1]);
    expect([main.shown, main.focused]).toEqual(before);
    expect(main.webContents.sent).toEqual([]);

    const other = { project_id: 'alpha', session_id: 'alpha-other' };
    await call(main, 'pantheon:notify', { title: 'Alpha app', body: 'Turn ended', target: other });
    electron.notifications.at(-1)!.emit('click');
    expect(main.focused).toBe(before[1]! + 1);
    expect(main.webContents.sent).toEqual([['pantheon:notification-click', other]]);
  });

  it('opens one window per session and per project and focuses it when asked again', async () => {
    const electron = await startMain('darwin');
    const { main, call } = electron;
    await call(main, 'pantheon:openWindow', sessionRequest);
    expect(electron.windows).toHaveLength(2);
    const session = electron.windows[1]!;
    expect(session.options).toMatchObject({
      width: 760,
      height: 620,
      minWidth: 480,
      minHeight: 360,
      ...windowChrome('darwin', titleBarOverlay(false)),
    });
    expect(session.loaded[0]![1]).toEqual({ query: sessionRequest });
    expect(session.focused).toBe(0);

    await call(main, 'pantheon:openWindow', sessionRequest);
    expect([session.shown, session.focused]).toEqual([0, 0]);
    electron.send(session, 'pantheon:ready');
    expect(await call(main, 'pantheon:openWindow', sessionRequest)).toEqual({
      ok: true,
      value: null,
    });
    expect(electron.windows).toHaveLength(2);
    expect([session.shown, session.focused]).toEqual([2, 1]);

    await call(session, 'pantheon:openWindow', projectRequest);
    const project = electron.windows[2]!;
    electron.send(project, 'pantheon:ready');
    await call(main, 'pantheon:openWindow', projectRequest);
    expect(electron.windows).toHaveLength(3);
    expect(project.options).toMatchObject({ width: 1280, height: 800, minWidth: 1100 });
    expect(project.loaded[0]![1]).toEqual({ query: projectRequest });
    expect(project.focused).toBe(1);

    await call(main, 'pantheon:openWindow', { ...sessionRequest, session_id: 'alpha-billing' });
    expect(electron.windows).toHaveLength(4);
    session.close();
    await call(main, 'pantheon:openWindow', sessionRequest);
    expect(electron.windows).toHaveLength(5);

    for (const request of [
      { kind: 'session', project_id: 'alpha' },
      { kind: 'project', project_id: '' },
      { kind: 'main' },
      null,
    ])
      expect(await call(main, 'pantheon:openWindow', request)).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' },
      });
    expect(electron.windows).toHaveLength(5);
  });

  it('brings the main window forward with the place a session window asks it to show', async () => {
    const electron = await startMain('darwin');
    const { main, call } = electron;
    await call(main, 'pantheon:openWindow', sessionRequest);
    const session = electron.windows[1]!;
    main.close();
    const place = { project_id: 'alpha', session_id: 'alpha-login' };
    expect(await call(session, 'pantheon:showInMainWindow', place)).toEqual({
      ok: true,
      value: null,
    });
    expect([main.shown, main.focused]).toEqual([1, 1]);
    expect(main.webContents.sent).toEqual([['pantheon:show-in-main', place]]);
    expect(session.webContents.sent).toEqual([]);
    const composer = { project_id: 'beta', session_id: '' };
    expect(await call(session, 'pantheon:showInMainWindow', composer)).toEqual({
      ok: true,
      value: null,
    });
    expect(main.webContents.sent.at(-1)).toEqual(['pantheon:show-in-main', composer]);
    expect(await call(session, 'pantheon:showInMainWindow', { session_id: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
  });

  it('shows a session or project window only once its own page reports its first content', async () => {
    const electron = await startMain('darwin');
    const { main, call, send } = electron;
    await call(main, 'pantheon:openWindow', sessionRequest);
    await call(main, 'pantheon:openWindow', projectRequest);
    const [, session, project] = electron.windows as [FakeWindow, FakeWindow, FakeWindow];
    expect([session.options.show, project.options.show]).toEqual([false, false]);
    send(main, 'pantheon:ready');
    electron.ipcListeners.get('pantheon:ready')!({ sender: project.webContents, senderFrame: {} });
    expect([session.shown, project.shown]).toEqual([0, 0]);
    send(project, 'pantheon:ready');
    expect([session.shown, project.shown]).toEqual([0, 1]);
    send(project, 'pantheon:ready');
    send(session, 'pantheon:ready');
    expect([session.shown, project.shown]).toEqual([1, 1]);
  });

  it('shows a window whose page has not reported its first content after a quarter second', async () => {
    const electron = await startMain('darwin');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    cleanups.push(() => {
      vi.useRealTimers();
    });
    await electron.call(electron.main, 'pantheon:openWindow', sessionRequest);
    const session = electron.windows[1]!;
    vi.advanceTimersByTime(249);
    expect(session.shown).toBe(0);
    vi.advanceTimersByTime(1);
    expect(session.shown).toBe(1);
  });
});

describe('window background and theme source', () => {
  it("shows the main window at once in the page background of the system's theme", async () => {
    const electron = await startMain('darwin');
    const { main, call, module } = electron;
    expect(main.options).toMatchObject({ show: true, backgroundColor: WINDOW_BACKGROUND.light });
    module.nativeTheme.shouldUseDarkColors = true;
    await call(main, 'pantheon:openWindow', sessionRequest);
    expect(electron.windows[1]!.options.backgroundColor).toBe(WINDOW_BACKGROUND.dark);
  });

  it('applies, saves and restores the theme source the page picks', async () => {
    const root = tempRoot();
    const electron = await startMain('darwin', root);
    const { main, call, send, module } = electron;
    send(main, 'pantheon:setThemeSource', 'dark');
    expect(module.nativeTheme.themeSource).toBe('dark');
    expect(main.background).toBe(WINDOW_BACKGROUND.dark);
    for (const source of ['dim', null]) send(main, 'pantheon:setThemeSource', source);
    electron.ipcListeners.get('pantheon:setThemeSource')!({ sender: {}, senderFrame: {} }, 'light');
    expect(module.nativeTheme.themeSource).toBe('dark');
    await call(main, 'pantheon:openWindow', projectRequest);
    expect(electron.windows[1]!.options.backgroundColor).toBe(WINDOW_BACKGROUND.dark);

    const restarted = await startMain('darwin', root);
    expect(restarted.module.nativeTheme.themeSource).toBe('dark');
    expect(restarted.main.options.backgroundColor).toBe(WINDOW_BACKGROUND.dark);
    restarted.module.nativeTheme.shouldUseDarkColors = true;
    restarted.send(restarted.main, 'pantheon:setThemeSource', 'light');
    await restarted.call(restarted.main, 'pantheon:openWindow', sessionRequest);
    expect(restarted.windows[1]!.options.backgroundColor).toBe(WINDOW_BACKGROUND.light);
    restarted.send(restarted.main, 'pantheon:setThemeSource', 'system');
    expect(restarted.module.nativeTheme.themeSource).toBe('system');
    await restarted.call(restarted.main, 'pantheon:openWindow', projectRequest);
    expect(restarted.windows[2]!.options.backgroundColor).toBe(WINDOW_BACKGROUND.dark);
  });

  it('fills open and new windows with the page background the page reports', async () => {
    const electron = await startMain('darwin');
    const { main, popover, call } = electron;
    expect(
      await call(main, 'pantheon:setTitleBarTheme', {
        ...darkColours,
        dark: false,
        background: '#fbfaf7',
      }),
    ).toEqual({ ok: true, value: null });
    expect([main.background, popover.background]).toEqual(['#fbfaf7', '#fbfaf7']);
    // macOS draws its own window buttons.
    expect(main.overlays).toEqual([]);
    await call(main, 'pantheon:openWindow', sessionRequest);
    expect(electron.windows[1]!.options.backgroundColor).toBe('#fbfaf7');
  });

  it('repaints every window when the system flips light and dark while the page follows it', async () => {
    const electron = await startMain('darwin');
    const { main, popover, call, module } = electron;
    await call(main, 'pantheon:setTitleBarTheme', {
      ...darkColours,
      dark: false,
      background: '#fbfaf7',
    });
    module.nativeTheme.shouldUseDarkColors = true;
    module.nativeTheme.emit('updated');
    expect([main.background, popover.background]).toEqual([
      WINDOW_BACKGROUND.dark,
      WINDOW_BACKGROUND.dark,
    ]);
    await call(main, 'pantheon:setTitleBarTheme', darkColours);
    expect(main.background).toBe(darkColours.background);
    module.nativeTheme.shouldUseDarkColors = false;
    module.nativeTheme.emit('updated');
    expect(main.background).toBe(WINDOW_BACKGROUND.light);
  });

  it('leaves the windows alone when the system flips while the page holds one scheme', async () => {
    const electron = await startMain('darwin');
    const { main, call, send, module } = electron;
    send(main, 'pantheon:setThemeSource', 'light');
    await call(main, 'pantheon:setTitleBarTheme', {
      ...darkColours,
      dark: false,
      background: '#fbfaf7',
    });
    const paint = vi.spyOn(main, 'setBackgroundColor');
    module.nativeTheme.shouldUseDarkColors = true;
    module.nativeTheme.emit('updated');
    expect(paint).not.toHaveBeenCalled();
    expect(main.background).toBe('#fbfaf7');
  });
});

describe('window buttons on Windows and Linux', () => {
  it.each(['win32', 'linux'] as const)(
    'paints the buttons of every normal window in the colours the page reports, and opens new windows in them, on %s',
    async (platform) => {
      const electron = await startMain(platform);
      const { main, call } = electron;
      await call(main, 'pantheon:openWindow', sessionRequest);
      const session = electron.windows[1]!;
      expect(await call(session, 'pantheon:setTitleBarTheme', darkColours)).toEqual({
        ok: true,
        value: null,
      });
      const overlay = {
        color: darkColours.color,
        symbolColor: darkColours.symbolColor,
        height: 44,
      };
      expect([main.overlays, session.overlays]).toEqual([[overlay], [overlay]]);
      await call(main, 'pantheon:openWindow', projectRequest);
      expect(electron.windows[2]!.options.titleBarOverlay).toEqual(overlay);
    },
  );

  it.each([
    ['a colour name', { ...darkColours, color: 'black' }],
    ['three hex digits', { ...darkColours, symbolColor: '#fff' }],
    ['a colour function', { ...darkColours, background: 'rgb(18, 18, 17)' }],
    ['a dark flag that is not a boolean', { ...darkColours, dark: 'yes' }],
    ['only the dark flag', true],
  ])('rejects a report with %s and changes nothing', async (_name, report) => {
    const electron = await startMain('win32');
    const { main, call } = electron;
    expect(await call(main, 'pantheon:setTitleBarTheme', report)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect([main.overlays, main.background]).toEqual([[], '']);
    await call(main, 'pantheon:openWindow', sessionRequest);
    expect(electron.windows[1]!.options.backgroundColor).toBe(WINDOW_BACKGROUND.light);
  });
});

describe('Windows app id', () => {
  it.each([
    ['win32', [['dev.pantheon.desktop', 0]]],
    ['darwin', []],
    ['linux', []],
  ] as const)('is set before the first window only on %s', async (platform, ids) => {
    const { module } = await startMain(platform);
    expect(module.app.appIds).toEqual(ids);
  });
});

describe('context menu', () => {
  const params = (set: Record<string, unknown>) => ({
    isEditable: false,
    selectionText: '',
    linkURL: '',
    misspelledWord: '',
    dictionarySuggestions: [],
    editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: false },
    ...set,
  });
  const items = (template: MenuItemConstructorOptions[]) =>
    template.map((item) => [item.label ?? item.type, item.role, item.enabled]);

  it('offers spelling suggestions and the edit actions the field allows', async () => {
    const { main, popups } = await startMain('darwin');
    main.webContents.emit(
      'context-menu',
      {},
      params({
        isEditable: true,
        misspelledWord: 'teh',
        dictionarySuggestions: ['the', 'tech'],
        editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true },
      }),
    );
    const { template, options } = popups.at(-1)!;
    expect(items(template)).toEqual([
      ['the', undefined, undefined],
      ['tech', undefined, undefined],
      ['separator', undefined, undefined],
      ['剪切', 'cut', false],
      ['拷贝', 'copy', false],
      ['粘贴', 'paste', true],
      ['separator', undefined, undefined],
      ['全选', 'selectAll', true],
    ]);
    expect(options).toEqual({ window: main });
    (template[1]!.click as () => void)();
    expect(main.webContents.replaceMisspelling).toHaveBeenCalledWith('tech');
  });

  it('offers copy for selected text, copy link for a link and nothing elsewhere', async () => {
    const electron = await startMain('darwin');
    const { main, popups, module } = electron;
    main.webContents.emit('context-menu', {}, params({}));
    expect(popups).toEqual([]);
    main.webContents.emit('context-menu', {}, params({ selectionText: 'plan' }));
    expect(items(popups.at(-1)!.template)).toEqual([['拷贝', 'copy', undefined]]);
    const link = 'https://example.com/plan';
    main.webContents.emit('context-menu', {}, params({ selectionText: 'plan', linkURL: link }));
    const { template } = popups.at(-1)!;
    expect(items(template)).toEqual([
      ['拷贝', 'copy', undefined],
      ['separator', undefined, undefined],
      ['拷贝链接', undefined, undefined],
    ]);
    (template[2]!.click as () => void)();
    expect(module.clipboard.writeText).toHaveBeenCalledWith(link);
    main.webContents.emit('context-menu', {}, params({ linkURL: link }));
    expect(items(popups.at(-1)!.template)).toEqual([['拷贝链接', undefined, undefined]]);
    expect(popups).toHaveLength(3);
  });
});

describe('closing the main window', () => {
  it.each(['darwin', 'linux', 'win32'] as const)(
    'hides it on %s by default and quits once keep running is off',
    async (platform) => {
      const electron = await startMain(platform);
      const { main, call } = electron;
      expect(await call(main, 'pantheon:shellPrefs')).toEqual({
        ok: true,
        value: {
          keep_running_on_close: true,
          show_tray_icon: true,
          tray_icon: 'pantheon',
          app_icon: 'pantheon-travertine',
          voice_input: true,
          voice_engine: null,
          mini_window: false,
        },
      });
      await call(main, 'pantheon:openWindow', sessionRequest);
      expect(electron.windows[1]!.close()).toBe(true);
      expect(main.close()).toBe(false);
      expect(main.hidden).toBe(1);
      expect(electron.module.app.quits).toBe(0);
      electron.module.app.emit('activate');
      expect([main.shown, main.focused]).toEqual([1, 1]);

      expect(await call(main, 'pantheon:setShellPrefs', { keep_running_on_close: false })).toEqual({
        ok: true,
        value: {
          keep_running_on_close: false,
          show_tray_icon: true,
          tray_icon: 'pantheon',
          app_icon: 'pantheon-travertine',
          voice_input: true,
          voice_engine: null,
          mini_window: false,
        },
      });
      expect(
        JSON.parse(
          readFileSync(path.join(electron.module.app.getPath('userData'), 'settings.json'), 'utf8'),
        ),
      ).toMatchObject({ keep_running_on_close: false });
      expect(main.close()).toBe(true);
      expect(electron.module.app.quits).toBeGreaterThan(0);
    },
  );

  it('refuses a setting it does not know or a value that is not a boolean', async () => {
    const { main, call } = await startMain('darwin');
    for (const patch of [{ keep_running_on_close: 'no' }, { launch_at_login: true }, null])
      expect(await call(main, 'pantheon:setShellPrefs', patch)).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' },
      });
  });
});

describe('window menu', () => {
  it('hands a session window’s File and app menu actions to the main window and New Window to the right one', async () => {
    const electron = await startMain('darwin');
    const { main, call, click, focus } = electron;
    await call(main, 'pantheon:openWindow', sessionRequest);
    const session = electron.windows[1]!;
    focus(session);
    click('设置…');
    click('新会话');
    click('打开项目…');
    expect(session.webContents.sent).toEqual([]);
    click('查找…');
    click('后退');
    expect(session.webContents.sent).toEqual([
      ['pantheon:menu', 'search'],
      ['pantheon:menu', 'back'],
    ]);
    session.webContents.sent.length = 0;
    expect([main.shown, main.focused]).toEqual([3, 3]);
    expect(main.webContents.sent).toEqual([
      ['pantheon:menu', 'settings'],
      ['pantheon:show-in-main', { project_id: 'alpha' }],
      ['pantheon:menu', 'new-session'],
      ['pantheon:menu', 'open-project'],
    ]);

    click('新窗口');
    expect(electron.windows).toHaveLength(3);
    const project = electron.windows[2]!;
    expect(project.loaded[0]![1]).toEqual({ query: projectRequest });

    focus(project);
    click('新会话');
    expect(project.webContents.sent).toEqual([['pantheon:menu', 'new-session']]);
    click('新窗口');
    expect(electron.windows).toHaveLength(3);
    expect([main.shown, main.focused]).toEqual([4, 4]);

    focus(main);
    click('新窗口');
    expect(main.webContents.sent.at(-1)).toEqual(['pantheon:new-window', null]);
  });
});

describe('Help and About menus', () => {
  it.each(['darwin', 'win32', 'linux'] as const)(
    'reveals logs, sends diagnostics to the focused window and shows the About panel on %s',
    async (platform) => {
      const { main, call, windows, focus, click, appMenus, module } = await startMain(platform);
      await call(main, 'pantheon:openWindow', sessionRequest);
      const session = windows[1]!;
      focus(session);
      const menu = appMenus.at(-1)!;
      const help = menu.find((item) => item.label === '帮助')!;
      const items = help.submenu as MenuItemConstructorOptions[];
      expect(items.flatMap((item) => item.label ?? [])).toEqual([
        '键盘快捷键',
        '打开日志文件夹',
        '复制诊断信息',
        '调试视图…',
        '关闭用户样式',
        ...(platform === 'darwin' ? [] : ['关于 Pantheon']),
      ]);
      const appItems = menu[0]!.submenu as MenuItemConstructorOptions[];
      expect(appItems.some((item) => item.role === 'about')).toBe(platform === 'darwin');
      click('打开日志文件夹');
      expect(module.shell.showItemInFolder).toHaveBeenCalledWith(
        ((await call(main, 'pantheon:logsDir')) as { value: string }).value,
      );
      click('复制诊断信息');
      expect(session.webContents.sent).toEqual([['pantheon:menu', 'copy-diagnostics']]);
      if (platform !== 'darwin') {
        click('关于 Pantheon');
        expect(module.app.showAboutPanel).toHaveBeenCalledTimes(1);
      }
      expect(main.webContents.sent).toEqual([]);
    },
  );

  it('turns user styles off in the focused window and opens the debug view in the main one', async () => {
    const { main, call, windows, focus, click } = await startMain('darwin');
    await call(main, 'pantheon:openWindow', sessionRequest);
    const session = windows[1]!;
    focus(session);
    click('关闭用户样式');
    click('调试视图…');
    expect(session.webContents.sent).toEqual([['pantheon:menu', 'disable-user-style']]);
    expect(main.webContents.sent).toEqual([['pantheon:menu', 'debug-view']]);
  });

  it.each(['darwin', 'win32', 'linux'] as const)(
    'gives the About panel the app name, version and chosen icon on %s',
    async (platform) => {
      const { main, call, module } = await startMain(platform);
      expect(module.app.aboutPanels.at(-1)).toMatchObject({
        applicationName: 'Pantheon',
        applicationVersion: '1.2.3',
        copyright: expect.stringContaining('Pantheon'),
      });
      expect(module.app.aboutPanels.at(-1)!.iconPath).toMatch(
        /app-icons[/\\]dock[/\\]pantheon-travertine\.png$/,
      );
      await call(main, 'pantheon:setShellPrefs', { app_icon: 'monad-dusk' });
      expect(module.app.aboutPanels.at(-1)!.iconPath).toMatch(
        /app-icons[/\\]dock[/\\]monad-dusk\.png$/,
      );
    },
  );
});

describe('app menu button', () => {
  it.each([[['8', 36]], [[8]], [[Number.NaN, 36]], [[8, Number.POSITIVE_INFINITY]], [[null, 36]]])(
    'refuses the point %j',
    async (args) => {
      const { main, call, popups } = await startMain('win32');
      expect(await call(main, 'pantheon:popupAppMenu', ...args)).toEqual({
        ok: false,
        error: { code: 'invalid_input', message: 'x and y must be finite numbers' },
      });
      expect(popups).toEqual([]);
    },
  );

  it('pops the application menu at the point in the window that asked, at its page zoom', async () => {
    const { main, call, popups, appMenus, windows } = await startMain('linux');
    await call(main, 'pantheon:openWindow', projectRequest);
    const project = windows[1]!;
    project.webContents.zoom = 1.25;
    expect(await call(project, 'pantheon:popupAppMenu', 8.4, 36.6)).toEqual({
      ok: true,
      value: null,
    });
    expect(popups).toEqual([
      { template: appMenus.at(-1), options: { window: project, x: 11, y: 46 } },
    ]);
  });
});

describe('native popup menu', () => {
  it.each([
    [null],
    [[{ label: 'Open', enabled: true }]],
    [[{ id: 'open', label: 3, enabled: true }]],
    [[{ id: 'open', label: 'Open' }]],
    [[{ id: 'open', label: 'Open', enabled: true, checked: 'yes' }]],
    [[{ id: 'open', label: 'Open', enabled: true, danger: 1 }]],
    [[{ separator: false }]],
    [[{ id: 'copy', label: 'Copy', enabled: true, items: 'all' }]],
    [[{ id: 'copy', label: 'Copy', enabled: true, items: [{ id: 'id', label: 7 }] }]],
  ])('refuses the items %j', async (items) => {
    const { main, call, popups } = await startMain('darwin');
    expect(await call(main, 'pantheon:popupMenu', items)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(popups).toEqual([]);
  });

  it('pops the items up in the window that asked and resolves with the id of the one clicked', async () => {
    const { main, call, popups, builtMenus, windows } = await startMain('darwin');
    await call(main, 'pantheon:openWindow', projectRequest);
    const project = windows[1]!;
    const picked = call(project, 'pantheon:popupMenu', [
      { id: 'open', label: 'Open', enabled: true },
      { separator: true },
      {
        id: 'copy',
        label: 'Copy',
        enabled: true,
        items: [{ id: 'copy-id', label: 'Session ID', enabled: true }],
      },
      { id: 'pin', label: 'Pinned', enabled: true, checked: true },
      { id: 'delete', label: 'Delete…', enabled: false, danger: true },
    ]) as Promise<unknown>;
    const { template, options } = popups.at(-1)!;
    expect(options).toEqual({ window: project });
    const shape = (items: MenuItemConstructorOptions[]): unknown[] =>
      items.map((item) => [
        item.label ?? item.type,
        item.enabled,
        item.type === 'checkbox' ? item.checked : undefined,
        item.submenu ? shape(item.submenu as MenuItemConstructorOptions[]) : undefined,
      ]);
    expect(shape(template)).toEqual([
      ['Open', true, undefined, undefined],
      ['separator', undefined, undefined, undefined],
      ['Copy', true, undefined, [['Session ID', true, undefined, undefined]]],
      ['Pinned', true, true, undefined],
      ['Delete…', false, undefined, undefined],
    ]);
    const copy = template[2]!.submenu as MenuItemConstructorOptions[];
    (copy[0]!.click as () => void)();
    builtMenus.at(-1)!.emit('menu-will-close');
    expect(await picked).toEqual({ ok: true, value: 'copy-id' });
  });

  it('resolves null when the menu closes without a click', async () => {
    const { main, call, builtMenus } = await startMain('win32');
    const picked = call(main, 'pantheon:popupMenu', [
      { id: 'open', label: 'Open', enabled: true },
    ]) as Promise<unknown>;
    builtMenus.at(-1)!.emit('menu-will-close');
    expect(await picked).toEqual({ ok: true, value: null });
  });
});

describe('Dock menu', () => {
  const waiting = [
    { project_id: 'alpha', session_id: 'alpha-login', title: 'Fix login' },
    { project_id: 'beta', session_id: 'beta-docs', title: 'Write docs' },
  ];
  const labels = (menu: MenuItemConstructorOptions[]) =>
    menu.map((item) => item.label ?? item.type);

  it('offers New Session and Open Project, under the sessions that wait for the user', async () => {
    const { main, call, module } = await startMain('darwin');
    const dock = module.app.dock!;
    expect(labels(dock.menus.at(-1)!)).toEqual(['新会话', '打开项目…']);
    expect(await call(main, 'pantheon:badge', 2, waiting)).toEqual({ ok: true, value: null });
    expect(labels(dock.menus.at(-1)!)).toEqual([
      'Fix login',
      'Write docs',
      'separator',
      '新会话',
      '打开项目…',
    ]);
    const built = dock.menus.length;
    await call(main, 'pantheon:badge', 3, waiting);
    expect(dock.menus).toHaveLength(built);
    await call(main, 'pantheon:badge', 0, []);
    expect(labels(dock.menus.at(-1)!)).toEqual(['新会话', '打开项目…']);
  });

  it('routes a waiting session like a click on its notification, and New Session to the main window', async () => {
    const electron = await startMain('darwin');
    const { main, call, module } = electron;
    await call(main, 'pantheon:openWindow', { kind: 'session', ...waiting[0] });
    const session = electron.windows[1]!;
    electron.send(session, 'pantheon:ready');
    await call(main, 'pantheon:badge', 2, waiting);
    const click = (label: string) =>
      (module.app.dock!.menus.at(-1)!.find((item) => item.label === label)!.click as () => void)();
    const before = [main.shown, main.focused];
    click('Fix login');
    expect([session.shown, session.focused]).toEqual([2, 1]);
    expect([main.shown, main.focused]).toEqual(before);
    expect(main.webContents.sent).toEqual([]);
    click('Write docs');
    expect(main.focused).toBe(before[1]! + 1);
    expect(main.webContents.sent).toEqual([
      ['pantheon:notification-click', { project_id: 'beta', session_id: 'beta-docs' }],
    ]);
    main.webContents.sent.length = 0;
    click('新会话');
    click('打开项目…');
    expect(main.webContents.sent).toEqual([
      ['pantheon:menu', 'new-session'],
      ['pantheon:menu', 'open-project'],
    ]);
  });

  it.each([
    [[{ project_id: '', session_id: 'alpha-login', title: 'Fix login' }]],
    [[{ project_id: 'alpha', session_id: 'alpha-login', title: 7 }]],
    [{ project_id: 'alpha', session_id: 'alpha-login', title: 'Fix login' }],
    [Array.from({ length: 6 }, (_, i) => ({ ...waiting[0], session_id: `alpha-${i}` }))],
  ])('refuses the waiting sessions %j', async (list) => {
    const { main, call, module, trays } = await startMain('darwin');
    expect(await call(main, 'pantheon:badge', 2, list)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(labels(module.app.dock!.menus.at(-1)!)).toEqual(['新会话', '打开项目…']);
    expect(trays[0]!.title).toBe('');
  });
});

describe('attention', () => {
  it('bounces the Dock icon once when the count rises while no Pantheon window has focus', async () => {
    const { main, call, module, focus } = await startMain('darwin');
    await call(main, 'pantheon:badge', 1);
    await call(main, 'pantheon:badge', 1);
    await call(main, 'pantheon:badge', 3);
    await call(main, 'pantheon:badge', 2);
    focus(main);
    await call(main, 'pantheon:badge', 5);
    expect(module.app.dock!.bounces).toEqual(['informational', 'informational']);
    expect(main.flashes).toEqual([]);
  });

  it.each(['win32', 'linux'] as const)(
    'flashes the main window on a rise while unfocused on %s and stops once it has focus',
    async (platform) => {
      const { main, call, focus } = await startMain(platform);
      await call(main, 'pantheon:badge', 2);
      await call(main, 'pantheon:badge', 1);
      expect(main.flashes).toEqual([true]);
      main.emit('focus');
      expect(main.flashes).toEqual([true, false]);
      focus(main);
      await call(main, 'pantheon:badge', 4);
      expect(main.flashes).toEqual([true, false]);
    },
  );
});

describe('Windows jump list', () => {
  it.each([
    [['C:\\Pantheon\\Pantheon.exe', '--new-session'], 'new-session'],
    [['C:\\Pantheon\\Pantheon.exe', '--open-project'], 'open-project'],
    [['C:\\Pantheon\\Pantheon.exe', '--settings'], null],
    [['C:\\Pantheon\\Pantheon.exe'], null],
  ])('reads %j as %s', (argv, action) => {
    expect(launchAction(argv)).toBe(action);
  });

  it.each([
    ['win32', true, ['--new-session', '--open-project']],
    ['win32', false, []],
    ['darwin', true, []],
    ['linux', true, []],
  ] as const)('has tasks on %s, packaged %s: %j', (platform, packaged, flags) => {
    setMenuLocale('en');
    const exe = 'C:\\Pantheon\\Pantheon.exe';
    const tasks = jumpListTasks(platform, packaged, exe);
    expect(tasks.map((task) => task.arguments)).toEqual(flags);
    for (const task of tasks) expect([task.program, task.iconPath]).toEqual([exe, exe]);
    expect(tasks.map((task) => task.title)).toEqual(
      flags.length > 0 ? ['New Session', 'Open Project…'] : [],
    );
  });

  it.each([
    ['win32', 1],
    ['darwin', 0],
    ['linux', 0],
  ] as const)('sets the tasks in the menu language on %s %i times', async (platform, times) => {
    const { module } = await startMain(platform);
    expect(module.app.userTasks).toHaveLength(times);
    if (times === 0) return;
    expect(module.app.userTasks[0]).toMatchObject([
      { program: process.execPath, arguments: '--new-session', title: '新会话' },
      { program: process.execPath, arguments: '--open-project', title: '打开项目…' },
    ]);
  });

  it('reveals the main window with the action a second launch asks for, and only reveals it otherwise', async () => {
    const { main, module } = await startMain('win32');
    main.close();
    const exe = 'C:\\Pantheon\\Pantheon.exe';
    module.app.emit('second-instance', {}, [exe, '--open-project'], 'C:\\');
    expect([main.shown, main.focused]).toEqual([1, 1]);
    expect(main.webContents.sent).toEqual([['pantheon:menu', 'open-project']]);
    module.app.emit('second-instance', {}, [exe, '--unknown'], 'C:\\');
    expect([main.shown, main.focused]).toEqual([2, 2]);
    expect(main.webContents.sent).toHaveLength(1);
  });
});

/** Stands in for the daemon: its board lists projects, and a dev build watches no files. */
function fakeDaemon(projects: { id: string; roots: string[] }[] = []) {
  vi.doMock('../../apps/desktop/src/main/daemon.js', async (original) => {
    const actual = await original<typeof import('../../apps/desktop/src/main/daemon.js')>();
    return {
      ...actual,
      DaemonBridge: class extends actual.DaemonBridge {
        watchBuilds() {
          return () => {};
        }
        async daemon() {
          return {
            ok: false as const,
            error: { code: 'daemon_unavailable', message: 'No daemon in this test' },
          };
        }
        async query(method: string) {
          return method === 'board'
            ? {
                ok: true as const,
                value: { cursor: 1, projects, sessions: [], session_turns: [], workspaces: [] },
              }
            : { ok: false as const, error: { code: 'unknown_route', message: method } };
        }
      },
    };
  });
  cleanups.push(() => vi.doUnmock('../../apps/desktop/src/main/daemon.js'));
}

describe('pantheon links', () => {
  it.each([
    [
      'pantheon://session/alpha/alpha-login',
      { kind: 'session', project_id: 'alpha', session_id: 'alpha-login' },
    ],
    ['pantheon://project/alpha', { kind: 'project', project_id: 'alpha' }],
    ['pantheon://project/alpha/', { kind: 'project', project_id: 'alpha' }],
    ['pantheon://project/al%20pha', { kind: 'project', project_id: 'al pha' }],
    ['pantheon://new-session', { kind: 'new-session' }],
    ['pantheon://session/alpha', null],
    ['pantheon://session//alpha-login', null],
    ['pantheon://session/alpha/alpha-login/extra', null],
    ['pantheon://project', null],
    ['pantheon://project/', null],
    ['pantheon://project/%E0', null],
    ['pantheon://new-session/alpha', null],
    ['pantheon://settings/alpha', null],
    ['https://session/alpha/alpha-login', null],
    ['pantheon-visual://project/alpha', null],
    ['--new-session', null],
    ['', null],
  ])('reads %j as %j', (url, link) => {
    expect(readLink(url)).toEqual(link);
  });

  it('routes a macOS link to the session window, the project and a new session', async () => {
    const electron = await startMain('darwin');
    const { main, call, module } = electron;
    await call(main, 'pantheon:openWindow', sessionRequest);
    const session = electron.windows[1]!;
    electron.send(session, 'pantheon:ready');
    const open = (url: string) => {
      const event = { prevented: false, preventDefault: () => (event.prevented = true) };
      module.app.emit('open-url', event, url);
      return event.prevented;
    };
    expect(open('pantheon://session/alpha/alpha-login')).toBe(true);
    expect([session.shown, session.focused]).toEqual([2, 1]);
    expect(main.webContents.sent).toEqual([]);
    expect(open('pantheon://session/beta/beta-docs')).toBe(true);
    expect(open('pantheon://project/alpha')).toBe(true);
    expect(open('pantheon://new-session')).toBe(true);
    expect(open('pantheon://settings')).toBe(true);
    expect(main.webContents.sent).toEqual([
      ['pantheon:notification-click', { project_id: 'beta', session_id: 'beta-docs' }],
      ['pantheon:show-in-main', { project_id: 'alpha' }],
      ['pantheon:menu', 'new-session'],
    ]);
  });

  it('holds a link that arrives before the app is ready until its main window is there', async () => {
    const electron = await startMain('darwin', tempRoot(), ({ module }) => {
      const on = module.app.on.bind(module.app);
      module.app.on = (name: string, fn: Handler) => {
        on(name, fn);
        if (name === 'open-url') fn({ preventDefault() {} }, 'pantheon://project/alpha');
        return module.app;
      };
    });
    const mains = electron.windows.filter((window) => window.options.minWidth === 1100);
    expect(mains).toEqual([electron.main]);
    expect(electron.main.webContents.sent).toEqual([
      ['pantheon:show-in-main', { project_id: 'alpha' }],
    ]);
  });

  it('follows the link a second launch on Windows or Linux carries, before any jump list flag', async () => {
    const { main, module } = await startMain('win32');
    const exe = 'C:\\Pantheon\\Pantheon.exe';
    module.app.emit(
      'second-instance',
      {},
      [exe, '--open-project', 'pantheon://session/alpha/alpha-login'],
      'C:\\',
    );
    module.app.emit('second-instance', {}, [exe, 'pantheon://new-session'], 'C:\\');
    expect(main.webContents.sent).toEqual([
      ['pantheon:notification-click', { project_id: 'alpha', session_id: 'alpha-login' }],
      ['pantheon:menu', 'new-session'],
    ]);
  });

  it.each([
    ['pantheon://project/alpha', ['pantheon:show-in-main', { project_id: 'alpha' }]],
    ['--new-session', ['pantheon:menu', 'new-session']],
  ])('acts on %s in the arguments of the first launch', async (arg, sent) => {
    const { main } = await startMain('linux', tempRoot(), () => {
      process.argv.push(arg);
      cleanups.push(() => void process.argv.splice(process.argv.indexOf(arg), 1));
    });
    expect(main.webContents.sent).toEqual([sent]);
  });

  it('registers the pantheon scheme only in a packaged app', async () => {
    const packaged = await startMain('darwin');
    expect(packaged.module.app.protocolClients).toEqual(['pantheon']);
    const dev = await startMain('darwin', tempRoot(), ({ module }) => {
      module.app.isPackaged = false;
      fakeDaemon();
    });
    expect(dev.module.app.protocolClients).toEqual([]);
  });
});

describe('recent projects', () => {
  it.each([
    ['darwin', ['/work/alpha']],
    ['win32', ['/work/alpha']],
    ['linux', []],
  ] as const)(
    'adds the root a page reports to the recent items on %s',
    async (platform, recent) => {
      const { main, call, module } = await startMain(platform, tempRoot(), () =>
        fakeDaemon([{ id: 'alpha', roots: ['/work/alpha'] }]),
      );
      expect(await call(main, 'pantheon:addRecentProject', '/work/alpha')).toEqual({
        ok: true,
        value: null,
      });
      for (const root of ['work/alpha', 7, undefined])
        expect(await call(main, 'pantheon:addRecentProject', root)).toMatchObject({
          ok: false,
          error: { code: 'invalid_input' },
        });
      for (const root of ['/work/beta', '/work/alpha/src', '/Applications/Calculator.app'])
        expect(await call(main, 'pantheon:addRecentProject', root)).toMatchObject({
          ok: false,
          error: { code: 'path_refused' },
        });
      expect(module.app.recentDocuments).toEqual(recent);
    },
  );

  it('opens the project whose root a recent folder is, and Open Project for another folder', async () => {
    const { main, module } = await startMain('darwin', tempRoot(), () =>
      fakeDaemon([{ id: 'alpha', roots: ['/work/alpha', '/work/alpha-docs'] }]),
    );
    const open = (folder: string) => {
      const event = { prevented: false, preventDefault: () => (event.prevented = true) };
      module.app.emit('open-file', event, folder);
      return event.prevented;
    };
    expect(open('/work/alpha-docs')).toBe(true);
    await eventually(() => main.webContents.sent.length === 1);
    expect(open('/work/alpha/')).toBe(true);
    await eventually(() => main.webContents.sent.length === 2);
    expect(open('/work/beta')).toBe(true);
    await eventually(() => main.webContents.sent.length === 3);
    expect(main.webContents.sent).toEqual([
      ['pantheon:show-in-main', { project_id: 'alpha' }],
      ['pantheon:show-in-main', { project_id: 'alpha' }],
      ['pantheon:menu', 'open-project'],
    ]);
  });
});

describe('open at login', () => {
  it.each(['darwin', 'win32'] as const)(
    'reads and sets the login item of the app on %s',
    async (platform) => {
      const { main, call, module } = await startMain(platform);
      expect(await call(main, 'pantheon:openAtLogin')).toEqual({ ok: true, value: false });
      expect(await call(main, 'pantheon:setOpenAtLogin', true)).toEqual({ ok: true, value: true });
      expect(await call(main, 'pantheon:openAtLogin')).toEqual({ ok: true, value: true });
      expect(await call(main, 'pantheon:setOpenAtLogin', 'yes')).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' },
      });
      expect(module.app.loginItemSets).toEqual([{ openAtLogin: true }]);
    },
  );

  it('has no login item on Linux', async () => {
    const { main, call, module } = await startMain('linux');
    expect(await call(main, 'pantheon:openAtLogin')).toEqual({ ok: true, value: null });
    expect(await call(main, 'pantheon:setOpenAtLogin', true)).toMatchObject({
      ok: false,
      error: { code: 'unsupported' },
    });
    expect(module.app.loginItemSets).toEqual([]);
  });
});

describe('system accent colour', () => {
  it.each([
    ['0a84ffff', '#0a84ff'],
    ['FF375F80', '#ff375f'],
    ['0a84ff', null],
    ['#0a84ffff', null],
    ['zzzzzzzz', null],
    ['', null],
    [undefined, null],
  ])('reads the system colour %j as %j', (rgba, hex) => {
    expect(accentHex(rgba)).toBe(hex);
  });

  it('answers the colour the system has, and null when it has none', async () => {
    const { main, call, module } = await startMain('darwin');
    expect(await call(main, 'pantheon:systemAccent')).toEqual({ ok: true, value: '#0a84ff' });
    module.systemPreferences.accent = '';
    expect(await call(main, 'pantheon:systemAccent')).toEqual({ ok: true, value: null });
  });

  it.each(['win32', 'linux'] as const)(
    'sends every window the new colour when the system changes it on %s',
    async (platform) => {
      const electron = await startMain(platform);
      const { main, call, module } = electron;
      await call(main, 'pantheon:openWindow', projectRequest);
      module.systemPreferences.emit('accent-color-changed', {}, 'ff375fff');
      for (const window of electron.windows)
        expect(window.webContents.sent).toContainEqual(['pantheon:system-accent', '#ff375f']);
    },
  );

  it('sends every window the colour again when a window gains focus on macOS', async () => {
    const electron = await startMain('darwin');
    const { main, call, module } = electron;
    await call(main, 'pantheon:openWindow', projectRequest);
    module.systemPreferences.accent = 'ff9f0aff';
    module.app.emit('browser-window-focus', {}, main);
    for (const window of electron.windows)
      expect(window.webContents.sent).toEqual([['pantheon:system-accent', '#ff9f0a']]);
  });
});

describe('tray icon', () => {
  it('shows the waiting count from the badge, blank at 0, and goes when turned off', async () => {
    const electron = await startMain('darwin');
    const { main, call } = electron;
    expect(electron.trays).toHaveLength(1);
    const tray = electron.trays[0]!;
    expect(tray.title).toBe('');
    await call(main, 'pantheon:badge', 3);
    expect(tray.title).toBe('3');
    await call(main, 'pantheon:badge', 0);
    expect(tray.title).toBe('');
    await call(main, 'pantheon:badge', 2);

    await call(main, 'pantheon:setShellPrefs', { show_tray_icon: false });
    expect(tray.destroyed).toBe(true);
    await call(main, 'pantheon:setShellPrefs', { show_tray_icon: true });
    expect(electron.trays).toHaveLength(2);
    expect(electron.trays[1]!.title).toBe('2');
  });

  it('draws the count over the taskbar button on Windows and writes it in the tray tooltip', async () => {
    const electron = await startMain('win32');
    const { main, call } = electron;
    const tray = electron.trays[0]!;
    expect(tray.tooltip).toBe('Pantheon');
    await call(main, 'pantheon:badge', 3);
    expect(tray.tooltip).toBe('Pantheon:3 项等你回复');
    const [three, said] = main.overlayIcons.at(-1)! as [
      { bitmap: Buffer; width: number; height: number; scaleFactor: number },
      string,
    ];
    expect(said).toBe('Pantheon:3 项等你回复');
    expect(three).toMatchObject({ width: 32, height: 32, scaleFactor: 2 });
    expect(three.bitmap).toHaveLength(32 * 32 * 4);
    const pixel = (image: typeof three, x: number, y: number) => [
      ...image.bitmap.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4),
    ];
    // A round badge: clear corners, a filled edge, white figures in the middle.
    expect(pixel(three, 0, 0)[3]).toBe(0);
    expect(pixel(three, 16, 1)[3]).toBe(255);
    const white = (image: typeof three) =>
      Array.from({ length: 32 * 32 }, (_, i) => pixel(image, i % 32, Math.floor(i / 32))).filter(
        (p) => p.every((value) => value === 255),
      ).length;
    expect(white(three)).toBeGreaterThan(0);
    await call(main, 'pantheon:badge', 120);
    const many = main.overlayIcons.at(-1)![0] as typeof three;
    expect(white(many)).toBeGreaterThan(white(three));
    await call(main, 'pantheon:badge', 0);
    expect(main.overlayIcons.at(-1)).toEqual([null, '']);
    expect(tray.tooltip).toBe('Pantheon');
  });

  it('sets the launcher count on Linux and writes it in the tray tooltip', async () => {
    const electron = await startMain('linux');
    const { main, call } = electron;
    await call(main, 'pantheon:badge', 4);
    expect(electron.trays[0]!.tooltip).toBe('Pantheon:4 项等你回复');
    await call(main, 'pantheon:badge', 0);
    expect(electron.module.app.badgeCounts).toEqual([4, 0]);
    expect(electron.trays[0]!.tooltip).toBe('Pantheon');
    expect(main.overlayIcons).toEqual([]);
  });

  it("keeps the main window's count when another window reports its own", async () => {
    const electron = await startMain('darwin');
    const { main, call } = electron;
    await call(main, 'pantheon:badge', 3);
    await call(main, 'pantheon:openWindow', sessionRequest);
    await call(electron.windows[1]!, 'pantheon:badge', 0);
    expect(electron.trays[0]!.title).toBe('3');
  });

  it('draws a template image at twice the point size', async () => {
    const electron = await startMain('darwin');
    const { image } = electron.trays[0]!;
    expect(image.bytes).toBeGreaterThan(0);
    expect(image.scaleFactor).toBe(2);
    expect(image.template).toBe(true);
  });

  it('offers the menu on a right click and requests quit from its last item', async () => {
    const electron = await startMain('darwin');
    const { main } = electron;
    const tray = electron.trays[0]!;
    main.close();
    tray.emit('right-click');
    const menu = tray.menus[0]!;
    expect(menu.map((item) => item.label ?? item.type)).toEqual([
      '打开 Pantheon',
      '新会话',
      '设置…',
      'separator',
      '迷你窗',
      'separator',
      '退出 Pantheon',
    ]);
    (menu.find((item) => item.label === '新会话')!.click as () => void)();
    expect(main.webContents.sent).toEqual([['pantheon:menu', 'new-session']]);
    (menu.at(-1)!.click as () => void)();
    expect(electron.module.app.quits).toBe(0);
    expect(main.webContents.sent.at(-1)).toEqual(['pantheon:quit-request', null]);
  });

  it('shows tray shortcuts without registering accelerators', () => {
    const menu = trayMenuTemplate({
      name: 'Pantheon',
      reveal: vi.fn(),
      send: vi.fn(),
      quit: vi.fn(),
      mini: { shown: false, toggle: vi.fn() },
    });
    expect(
      [menu[1], menu[2], menu[6]].map((item) => [item!.accelerator, item!.registerAccelerator]),
    ).toEqual([
      ['CmdOrCtrl+N', false],
      ['CmdOrCtrl+,', false],
      ['CmdOrCtrl+Q', false],
    ]);
  });

  it('writes the count only when there is one', () => {
    expect([trayTitle(0), trayTitle(1), trayTitle(12)]).toEqual(['', '1', '12']);
  });

  it('builds its menu in English', () => {
    setMenuLocale('en');
    try {
      const labels = trayMenuTemplate({
        name: 'Pantheon',
        reveal: vi.fn(),
        send: vi.fn(),
        quit: vi.fn(),
        mini: { shown: false, toggle: vi.fn() },
      }).map((item) => item.label ?? item.type);
      expect(labels).toEqual([
        'Open Pantheon',
        'New Session',
        'Settings…',
        'separator',
        'Mini Window',
        'separator',
        'Quit Pantheon',
      ]);
    } finally {
      setMenuLocale('zh-CN');
    }
  });
});

describe('quit requests', () => {
  it('keeps a live main window open until its page confirms quit', async () => {
    const { module, main, call } = await startMain('darwin');
    module.app.quit();
    expect(module.app.quits).toBe(0);
    expect(main.webContents.sent).toEqual([['pantheon:quit-request', null]]);
    expect(main.close()).toBe(false);
    expect(await call(main, 'pantheon:confirmQuit')).toEqual({ ok: true, value: null });
    expect(module.app.quits).toBe(1);
    expect(main.close()).toBe(true);
  });

  it.each(['darwin', 'win32'] as const)(
    'allows OS shutdown on %s without confirmation',
    async (platform) => {
      const { module, main } = await startMain(platform);
      if (platform === 'darwin') module.powerMonitor.emit('shutdown');
      else main.emit('session-end');
      module.app.quit();
      expect(module.app.quits).toBe(1);
      expect(main.webContents.sent).toEqual([]);
      expect(main.close()).toBe(true);
    },
  );

  it('keeps the main window in the background when a Windows shutdown is only asked about', async () => {
    const { module, main } = await startMain('win32');
    main.emit('query-session-end');
    expect(main.close()).toBe(false);
    module.app.quit();
    expect(module.app.quits).toBe(0);
    expect(main.webContents.sent).toEqual([['pantheon:quit-request', null]]);
    main.emit('session-end');
    expect(main.close()).toBe(true);
  });

  it('quits on its own when the page leaves the quit request unanswered for two seconds', async () => {
    const { module, main } = await startMain('darwin');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    cleanups.push(() => {
      vi.useRealTimers();
    });
    module.app.quit();
    vi.advanceTimersByTime(1999);
    expect(module.app.quits).toBe(0);
    vi.advanceTimersByTime(1);
    expect(module.app.quits).toBe(1);
    expect(main.close()).toBe(true);
  });

  const question = {
    message: 'Quit Pantheon? 2 sessions keep running in the background',
    detail:
      '2 sessions are running and finish after you quit\nNotifications stop until you open Pantheon again',
    quit: 'Quit',
    cancel: 'Cancel',
  };

  it('leaves the quit to the page once it asks within two seconds', async () => {
    const { module, main, call } = await startMain('darwin');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    cleanups.push(() => {
      vi.useRealTimers();
    });
    module.app.quit();
    vi.advanceTimersByTime(1000);
    expect(await call(main, 'pantheon:askQuit', question)).toEqual({ ok: true, value: null });
    vi.advanceTimersByTime(5000);
    expect(module.app.quits).toBe(0);
    expect(main.close()).toBe(false);
  });

  it.each([
    [0, 1],
    [1, 0],
  ])(
    'asks in a warning sheet on the shown main window and, on answer %i, quits %i times',
    async (answer, quits) => {
      const { module, main, call } = await startMain('darwin');
      main.hide();
      module.app.quit();
      let shownWhenAsked: boolean | undefined;
      module.dialog.showMessageBox.mockImplementationOnce(async () => {
        shownWhenAsked = main.visible;
        return { response: answer, checkboxChecked: false };
      });
      expect(await call(main, 'pantheon:askQuit', question)).toEqual({ ok: true, value: null });
      expect(shownWhenAsked).toBe(true);
      expect(main.focused).toBe(1);
      expect(module.dialog.showMessageBox).toHaveBeenCalledWith(main, {
        type: 'warning',
        message: question.message,
        detail: question.detail,
        buttons: ['Quit', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
      });
      expect(module.app.quits).toBe(quits);
      expect(main.close()).toBe(quits === 1);
    },
  );

  it('keeps one confirmation open when quit is asked again while it shows', async () => {
    const { module, main, call } = await startMain('darwin');
    let answer!: (response: number) => void;
    module.dialog.showMessageBox.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = (response) => resolve({ response, checkboxChecked: false });
        }),
    );
    module.app.quit();
    const first = call(main, 'pantheon:askQuit', question);
    await sleep(10);
    module.app.quit();
    const second = call(main, 'pantheon:askQuit', question);
    await sleep(10);
    expect(main.webContents.sent).toEqual([['pantheon:quit-request', null]]);
    expect(module.dialog.showMessageBox).toHaveBeenCalledOnce();
    answer(1);
    expect(await first).toEqual({ ok: true, value: null });
    expect(await second).toEqual({ ok: true, value: null });
    expect(module.app.quits).toBe(0);
    module.app.quit();
    expect(main.webContents.sent).toHaveLength(2);
  });

  it('asks only from the main window and only with all four texts', async () => {
    const { module, main, call, windows } = await startMain('darwin');
    await call(main, 'pantheon:openWindow', sessionRequest);
    expect(await call(windows[1]!, 'pantheon:askQuit', question)).toMatchObject({
      ok: false,
      error: { code: 'forbidden_sender' },
    });
    for (const input of [{ ...question, cancel: undefined }, { ...question, detail: 2 }, null])
      expect(await call(main, 'pantheon:askQuit', input)).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' },
      });
    expect(module.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(module.app.quits).toBe(0);
  });

  it('does not let another window confirm quit', async () => {
    const { module, main, call, windows } = await startMain('darwin');
    await call(main, 'pantheon:openWindow', sessionRequest);
    expect(await call(windows[1]!, 'pantheon:confirmQuit')).toMatchObject({
      ok: false,
      error: { code: 'forbidden_sender' },
    });
    expect(module.app.quits).toBe(0);
  });

  it('quits at once without a main window', async () => {
    const { module, main } = await startMain('darwin');
    main.emit('closed');
    const before = module.app.quits;
    module.app.quit();
    expect(module.app.quits).toBe(before + 1);
    expect(main.webContents.sent).toEqual([]);
  });

  it.each(['destroyed', 'crashed'] as const)('quits at once with a %s renderer', async (state) => {
    const { module, main } = await startMain('darwin');
    main.webContents[state] = true;
    module.app.quit();
    expect(module.app.quits).toBe(1);
    expect(main.webContents.sent).toEqual([]);
  });
});

describe('tray popover', () => {
  it('is built hidden with the tray, shows under the icon once its page has drawn at its height, toggles and hides on blur', async () => {
    const { module, trays, windows, popover, main, call, send } = await startMain('darwin');
    expect(popover.options).toMatchObject({
      width: 320,
      frame: false,
      show: false,
      backgroundColor: WINDOW_BACKGROUND.light,
    });
    expect(popover.loaded[0]![1]).toEqual({ query: { kind: 'popover' } });
    const tray = trays[0]!;
    tray.emit('click');
    expect(popover.position).toEqual([752, 24]);
    expect(popover.shown).toBe(0);
    await call(popover, 'pantheon:setPopoverHeight', 300);
    send(popover, 'pantheon:ready');
    expect(popover.size).toEqual([320, 300]);
    expect([popover.shown, popover.focused, main.shown]).toEqual([1, 1, 0]);
    // A click on a menu bar icon leaves another app active, and only the active app's window blurs.
    expect(module.app.focusCalls).toEqual([{ steal: true }]);
    tray.emit('click');
    expect(popover.hidden).toBe(1);
    tray.emit('click');
    expect(windows).toHaveLength(1);
    expect([popover.shown, popover.focused]).toEqual([2, 2]);
    popover.emit('blur');
    expect(popover.hidden).toBe(2);
  });

  it('does not show the popover on its own once its page has drawn', async () => {
    const { popover, send } = await startMain('darwin');
    send(popover, 'pantheon:ready');
    expect(popover.shown).toBe(0);
  });

  it('keeps the popover inside the display when the icon is near its right edge', async () => {
    const { trays, popover } = await startMain('darwin');
    const tray = trays[0]!;
    tray.getBounds = () => ({ x: 1570, y: 0, width: 24, height: 24 });
    tray.emit('click');
    expect(popover.position).toEqual([1280, 24]);
  });

  it('opens the popover above an icon in a bottom taskbar and keeps its bottom edge as it resizes', async () => {
    const { trays, popover, call, setDisplays } = await startMain('win32');
    setDisplays([
      {
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1032 },
      },
    ]);
    const tray = trays[0]!;
    tray.getBounds = () => ({ x: 1700, y: 1036, width: 32, height: 40 });
    tray.emit('click');
    expect(popover.position).toEqual([1556, 792]);
    await call(popover, 'pantheon:setPopoverHeight', 300);
    expect(popover.position).toEqual([1556, 732]);
  });

  it('places the popover in the work area of the stacked display that holds the icon', async () => {
    const { trays, popover, setDisplays } = await startMain('win32');
    setDisplays([
      {
        bounds: { x: 0, y: 0, width: 2560, height: 1440 },
        workArea: { x: 0, y: 0, width: 2560, height: 1392 },
      },
      {
        bounds: { x: 0, y: 1440, width: 1920, height: 1080 },
        workArea: { x: 0, y: 1440, width: 1920, height: 1040 },
      },
    ]);
    const tray = trays[0]!;
    tray.getBounds = () => ({ x: 1880, y: 2484, width: 32, height: 36 });
    tray.emit('click');
    expect(popover.position).toEqual([1600, 2240]);
  });

  it('sizes the popover in window coordinates at its page zoom', async () => {
    const { popover, call } = await startMain('darwin');
    popover.webContents.zoom = 1.25;
    await call(popover, 'pantheon:setPopoverHeight', 300);
    expect(popover.size).toEqual([320, 375]);
  });

  it('leaves the frameless popover out of title-bar updates', async () => {
    const { popover, main, call } = await startMain('win32');
    await call(main, 'pantheon:setTitleBarTheme', darkColours);
    expect(main.overlays).toHaveLength(1);
    expect(popover.overlays).toEqual([]);
  });

  it('clamps height and permits only the popover to resize it', async () => {
    const { popover, main, call, handlers } = await startMain('darwin');
    for (const [input, height] of [
      [10, 120],
      [900, 480],
      [250, 250],
    ]) {
      expect(await call(popover, 'pantheon:setPopoverHeight', input)).toEqual({
        ok: true,
        value: null,
      });
      expect(popover.size).toEqual([320, height]);
    }
    expect(await call(main, 'pantheon:setPopoverHeight', 200)).toMatchObject({
      ok: false,
      error: { code: 'forbidden_sender' },
    });
    expect(
      await handlers.get('pantheon:setPopoverHeight')!(
        { sender: popover.webContents, senderFrame: {} },
        200,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'forbidden_sender' },
    });
    expect(await call(popover, 'pantheon:setPopoverHeight', '200')).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(popover.size).toEqual([320, 250]);
  });

  it('destroys the popover when the tray is disabled and creates none while disabled', async () => {
    const { popover, main, call } = await startMain('darwin');
    await call(main, 'pantheon:setShellPrefs', { show_tray_icon: false });
    expect(popover.webContents.destroyed).toBe(true);
    expect(await call(popover, 'pantheon:appFocused')).toMatchObject({ ok: false });
    const root = tempRoot();
    mkdirSync(path.join(root, 'userData'));
    writeFileSync(
      path.join(root, 'userData/settings.json'),
      JSON.stringify({ show_tray_icon: false }),
    );
    const disabled = await startMain('darwin', root);
    expect(disabled.trays).toHaveLength(0);
    expect(disabled.windows).toHaveLength(1);
  });

  it('reveals the main window with an optional action and hides the popover', async () => {
    const { popover, main, call, focus, click } = await startMain('darwin');
    focus(popover);
    expect(await call(popover, 'pantheon:revealMain', 'new-session')).toEqual({
      ok: true,
      value: null,
    });
    expect([main.shown, main.focused, popover.hidden]).toEqual([1, 1, 1]);
    expect(main.webContents.sent).toEqual([['pantheon:menu', 'new-session']]);
    expect(popover.webContents.sent).toEqual([]);
    await call(popover, 'pantheon:revealMain');
    expect([main.shown, main.focused]).toEqual([2, 2]);
    expect(main.webContents.sent).toHaveLength(1);
    expect(await call(popover, 'pantheon:revealMain', 'quit')).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    click('设置…');
    expect(main.webContents.sent.at(-1)).toEqual(['pantheon:menu', 'settings']);
    expect(popover.webContents.sent).toEqual([]);
  });

  it('reports focus for main, session and project windows but ignores the popover', async () => {
    const { popover, windows, main, call, focus } = await startMain('darwin');
    focus(popover);
    expect(await call(main, 'pantheon:appFocused')).toEqual({ ok: true, value: false });
    focus(main);
    expect(await call(popover, 'pantheon:appFocused')).toEqual({ ok: true, value: true });
    for (const request of [sessionRequest, projectRequest]) {
      await call(main, 'pantheon:openWindow', request);
      focus(windows.at(-1)!);
      expect(await call(main, 'pantheon:appFocused')).toEqual({ ok: true, value: true });
    }
    focus(null);
    expect(await call(main, 'pantheon:appFocused')).toEqual({ ok: true, value: false });
  });
});

describe('mini window', () => {
  const isMini = (window: FakeWindow) =>
    (window.loaded[0]?.[1] as { query?: { kind?: string } } | undefined)?.query?.kind === 'mini';
  const settings = (electron: FakeElectron) =>
    JSON.parse(
      readFileSync(path.join(electron.module.app.getPath('userData'), 'settings.json'), 'utf8'),
    );
  const windowItem = (electron: FakeElectron) =>
    (
      electron.appMenus.at(-1)!.find((menu) => menu.label === '窗口')!
        .submenu as MenuItemConstructorOptions[]
    ).find((item) => item.label === '迷你窗')!;
  const trayItem = (electron: FakeElectron) => {
    electron.trays.at(-1)!.emit('right-click');
    return electron.trays
      .at(-1)!
      .menus.at(-1)!
      .find((item) => item.label === '迷你窗')!;
  };

  it('opens one frameless bar above other windows at the bottom right, shows it without focus and records the switch', async () => {
    const electron = await startMain('darwin');
    const { main, call, send, handlers } = electron;
    expect(await call(main, 'pantheon:miniWindowShown')).toEqual({ ok: true, value: false });
    expect(electron.windows.some(isMini)).toBe(false);
    expect(await call(main, 'pantheon:setMiniWindow', true)).toEqual({ ok: true, value: null });
    const minis = electron.windows.filter(isMini);
    expect(minis).toHaveLength(1);
    const mini = minis[0]!;
    expect(mini.options).toMatchObject({
      x: 1600 - 360 - 16,
      y: 1000 - 40 - 16,
      width: 360,
      height: 40,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      show: false,
    });
    expect([mini.onTop, mini.onTopLevel, mini.allWorkspaces]).toEqual([true, 'floating', true]);
    send(mini, 'pantheon:ready');
    expect([mini.shown, mini.focused]).toEqual([1, 0]);
    mini.emit('blur');
    expect(mini.hidden).toBe(0);
    expect(await call(main, 'pantheon:setMiniWindow', true)).toEqual({ ok: true, value: null });
    expect(electron.windows.filter(isMini)).toHaveLength(1);
    expect(await call(mini, 'pantheon:miniWindowShown')).toEqual({ ok: true, value: true });
    expect(settings(electron)).toMatchObject({ mini_window: true });
    expect(((await call(main, 'pantheon:shellPrefs')) as any).value.mini_window).toBe(true);

    expect(await call(main, 'pantheon:setMiniWindow', 'yes')).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(
      await handlers.get('pantheon:setMiniWindow')!({ sender: {}, senderFrame: {} }, false),
    ).toMatchObject({ ok: false, error: { code: 'forbidden_sender' } });
    expect(await call(main, 'pantheon:setShellPrefs', { mini_window: false })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(await call(main, 'pantheon:setMiniWindow', false)).toEqual({ ok: true, value: null });
    expect(await call(mini, 'pantheon:miniWindowShown')).toMatchObject({ ok: false });
    expect(await call(main, 'pantheon:miniWindowShown')).toEqual({ ok: true, value: false });
    expect(settings(electron)).toMatchObject({ mini_window: false });
  });

  it('comes back on restart where it was dragged, and at the default place once that is off every screen', async () => {
    const root = tempRoot();
    const electron = await startMain('darwin', root);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    cleanups.push(() => {
      vi.useRealTimers();
    });
    await electron.call(electron.main, 'pantheon:setMiniWindow', true);
    const mini = electron.windows.find(isMini)!;
    mini.setPosition(100, 200);
    mini.emit('move');
    vi.advanceTimersByTime(500);
    expect(settings(electron)).toMatchObject({ mini_window_position: { x: 100, y: 200 } });
    vi.useRealTimers();

    const restarted = await startMain('darwin', root);
    expect(restarted.windows.filter(isMini).map((w) => [w.options.x, w.options.y])).toEqual([
      [100, 200],
    ]);
    expect(windowItem(restarted).checked).toBe(true);

    writeFileSync(
      path.join(root, 'userData/settings.json'),
      JSON.stringify({ ...settings(restarted), mini_window_position: { x: 1500, y: 980 } }),
    );
    const moved = await startMain('darwin', root);
    expect(moved.windows.filter(isMini).map((w) => [w.options.x, w.options.y])).toEqual([
      [1224, 944],
    ]);
  });

  it('is checked in the Window menu and the tray menu as it shows, and either one switches it', async () => {
    const electron = await startMain('darwin');
    expect(windowItem(electron)).toMatchObject({ type: 'checkbox', checked: false });
    expect(trayItem(electron)).toMatchObject({ type: 'checkbox', checked: false });
    (windowItem(electron).click as () => void)();
    const mini = electron.windows.find(isMini)!;
    expect(mini).toBeDefined();
    expect([windowItem(electron).checked, trayItem(electron).checked]).toEqual([true, true]);
    (trayItem(electron).click as () => void)();
    expect(await electron.call(mini, 'pantheon:appFocused')).toMatchObject({ ok: false });
    expect([windowItem(electron).checked, trayItem(electron).checked]).toEqual([false, false]);
    expect(await electron.call(electron.main, 'pantheon:miniWindowShown')).toEqual({
      ok: true,
      value: false,
    });
  });

  it('turns off when its window is closed outside a quit, and stays on across a quit', async () => {
    const root = tempRoot();
    const electron = await startMain('darwin', root);
    await electron.call(electron.main, 'pantheon:setMiniWindow', true);
    expect(electron.windows.find(isMini)!.close()).toBe(true);
    expect(windowItem(electron).checked).toBe(false);
    expect(settings(electron)).toMatchObject({ mini_window: false });

    await electron.call(electron.main, 'pantheon:setMiniWindow', true);
    await electron.call(electron.main, 'pantheon:confirmQuit');
    electron.windows.filter(isMini).at(-1)!.close();
    expect(settings(electron)).toMatchObject({ mini_window: true });
  });

  it('opens the main window at the place its expand button asks for and stays open', async () => {
    const electron = await startMain('darwin');
    await electron.call(electron.main, 'pantheon:setMiniWindow', true);
    const mini = electron.windows.find(isMini)!;
    electron.main.hide();
    const place = { project_id: 'alpha', session_id: 'alpha-login' };
    expect(await electron.call(mini, 'pantheon:showInMainWindow', place)).toEqual({
      ok: true,
      value: null,
    });
    expect(electron.main.webContents.sent).toEqual([['pantheon:show-in-main', place]]);
    expect([electron.main.shown, mini.hidden, mini.webContents.destroyed]).toEqual([1, 0, false]);
  });

  it('is left out of focus checks and title-bar updates', async () => {
    const electron = await startMain('win32');
    await electron.call(electron.main, 'pantheon:setMiniWindow', true);
    const mini = electron.windows.find(isMini)!;
    electron.focus(mini);
    expect(await electron.call(mini, 'pantheon:appFocused')).toEqual({ ok: true, value: false });
    await electron.call(electron.main, 'pantheon:setTitleBarTheme', darkColours);
    expect(mini.overlays).toEqual([]);
  });
});

describe('background notice', () => {
  it.each(['en', 'zh-CN'])(
    'notifies once across launches with running sessions in %s',
    async (locale) => {
      const root = tempRoot();
      mkdirSync(path.join(root, 'userData'));
      const file = path.join(root, 'userData/settings.json');
      writeFileSync(file, JSON.stringify({ locale, editor: 'cursor' }));
      const { main, call, notices } = await startMain('darwin', root);
      await call(main, 'pantheon:keepAwake', { enabled: false, running: 3 });
      await call(main, 'pantheon:keepAwake', { enabled: false, running: 0 });
      main.close();
      expect(notices).toEqual([]);
      await call(main, 'pantheon:keepAwake', { enabled: false, running: 2 });
      main.close();
      expect(notices).toEqual([
        locale === 'en'
          ? {
              title: 'Pantheon is still running in the background',
              body: '2 sessions keep running. Open it from the menu bar icon.',
            }
          : {
              title: 'Pantheon 还在后台运行',
              body: '2 个会话继续跑。从菜单栏图标打开。',
            },
      ]);
      main.close();
      expect(notices).toHaveLength(1);
      await call(main, 'pantheon:setShellPrefs', { show_tray_icon: false });
      expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
        editor: 'cursor',
        background_notice_shown: true,
      });
      expect(((await call(main, 'pantheon:shellPrefs')) as any).value).not.toHaveProperty(
        'background_notice_shown',
      );
      const restarted = await startMain('darwin', root);
      await restarted.call(restarted.main, 'pantheon:keepAwake', { enabled: true, running: 1 });
      restarted.main.close();
      expect(restarted.notices).toEqual([]);
    },
  );

  it('does not notify when close quits or quit is confirmed', async () => {
    const { main, call, notices } = await startMain('darwin');
    await call(main, 'pantheon:keepAwake', { enabled: true, running: 2 });
    await call(main, 'pantheon:setShellPrefs', { keep_running_on_close: false });
    main.close();
    expect(notices).toEqual([]);
    const confirmed = await startMain('darwin');
    await confirmed.call(confirmed.main, 'pantheon:keepAwake', { enabled: false, running: 2 });
    await confirmed.call(confirmed.main, 'pantheon:confirmQuit');
    confirmed.main.close();
    expect(confirmed.notices).toEqual([]);
  });
});

describe('preload', () => {
  it('exposes diagnostics calls and synchronously resolves a dropped file or folder without IPC', async () => {
    const invoke = vi.fn(async (_channel: string): Promise<unknown> => null);
    const getPathForFile = vi.fn();
    let exposed!: DesktopBridge;
    const module = {
      contextBridge: { exposeInMainWorld: (_name: string, api: DesktopBridge) => (exposed = api) },
      ipcRenderer: {
        invoke,
        on() {},
        sendSync: () => ({ choice: 'system', resolved: 'en' }),
      },
      webUtils: { getPathForFile },
    };
    cleanups.push(() => {
      vi.doUnmock(ELECTRON);
      vi.resetModules();
    });
    vi.doMock(ELECTRON, () => ({ ...module, default: module }));
    vi.resetModules();
    await import('../../apps/desktop/src/preload/index.js');
    for (const name of ['project-folder', 'notes.txt']) {
      const file = new File([], name);
      getPathForFile.mockReturnValue(`/dropped/${name}`);
      expect(exposed.pathForFile(file)).toBe(`/dropped/${name}`);
      expect(getPathForFile).toHaveBeenLastCalledWith(file);
    }
    expect(invoke).not.toHaveBeenCalled();
    const info: AppInfo = {
      version: '1.2.3',
      electron: '45.0.0',
      os: 'linux',
      os_version: '6.1',
      arch: 'x64',
    };
    const crash: RendererCrash = { reason: 'crashed', exit_code: 9 };
    for (const [method, value] of [
      ['appInfo', info],
      ['logsDir', '/desktop/logs'],
      ['debugTarget', { repo_root: '/work/pantheon' }],
      ['debugTarget', null],
      ['lastCrash', crash],
      ['lastCrash', null],
    ] as const) {
      invoke.mockResolvedValueOnce({ ok: true, value });
      expect(await exposed[method]()).toEqual(value);
      expect(invoke).toHaveBeenLastCalledWith(`pantheon:${method}`);
    }
    invoke.mockResolvedValueOnce({
      ok: false,
      error: { code: 'forbidden_sender', message: 'Only a Pantheon window may use this channel' },
    });
    await expect(exposed.appInfo()).rejects.toThrow('Only a Pantheon window');
  });

  it('reads the crash page before the page runs and relays the export and daemon start calls', async () => {
    const crash: RendererCrash = { reason: 'oom', exit_code: 2 };
    const invoke = vi.fn(async (_channel: string): Promise<unknown> => null);
    const sendSync = vi.fn((channel: string) =>
      channel === 'pantheon:crashPage' ? crash : { choice: 'system', resolved: 'en' },
    );
    let exposed!: DesktopBridge;
    const module = {
      contextBridge: { exposeInMainWorld: (_name: string, api: DesktopBridge) => (exposed = api) },
      ipcRenderer: { invoke, on() {}, sendSync },
      webUtils: { getPathForFile() {} },
    };
    cleanups.push(() => {
      vi.doUnmock(ELECTRON);
      vi.resetModules();
    });
    vi.doMock(ELECTRON, () => ({ ...module, default: module }));
    vi.resetModules();
    await import('../../apps/desktop/src/preload/index.js');
    expect(exposed.crashPage).toEqual(crash);
    expect(sendSync).toHaveBeenCalledWith('pantheon:crashPage');
    invoke.mockResolvedValueOnce({ ok: true, value: '/saved/diagnostics.log' });
    expect(await exposed.exportDiagnostics()).toEqual({
      ok: true,
      value: '/saved/diagnostics.log',
    });
    expect(invoke).toHaveBeenLastCalledWith('pantheon:exportDiagnostics');
    invoke.mockResolvedValueOnce({ ok: true, value: true });
    expect(await exposed.daemonStarting()).toBe(true);
    expect(invoke).toHaveBeenLastCalledWith('pantheon:daemonStarting');
  });

  it('reads the window context from the query and relays the window calls', async () => {
    const ipc = new Emitter();
    const invoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({
      ok: true,
      value: null,
    }));
    let exposed: any;
    cleanups.push(() => {
      vi.unstubAllGlobals();
      vi.doUnmock(ELECTRON);
      vi.resetModules();
    });
    const module = {
      contextBridge: { exposeInMainWorld: (_name: string, api: unknown) => (exposed = api) },
      ipcRenderer: Object.assign(ipc, {
        invoke,
        send() {},
        sendSync: () => ({ choice: 'system', resolved: 'zh-CN' }),
        removeListener(name: string, fn: Handler) {
          ipc.listeners.set(
            name,
            (ipc.listeners.get(name) ?? []).filter((l) => l !== fn),
          );
        },
      }),
    };
    vi.doMock(ELECTRON, () => ({ ...module, default: module }));
    vi.resetModules();
    await import('../../apps/desktop/src/preload/index.js');
    vi.stubGlobal('location', { search: '?kind=session&project_id=alpha&session_id=alpha-login' });
    expect(exposed.windowContext()).toEqual(sessionRequest);
    vi.stubGlobal('location', { search: '?kind=project&project_id=alpha' });
    expect(exposed.windowContext()).toEqual(projectRequest);
    vi.stubGlobal('location', { search: '?kind=popover' });
    expect(exposed.windowContext()).toEqual({ kind: 'popover' });
    vi.stubGlobal('location', { search: '?kind=mini' });
    expect(exposed.windowContext()).toEqual({ kind: 'mini' });
    vi.stubGlobal('location', { search: '' });
    expect(exposed.windowContext()).toEqual({ kind: 'main' });

    const quit = vi.fn();
    const stopQuit = exposed.onQuitRequest(quit);
    ipc.emit('pantheon:quit-request', {}, null);
    stopQuit();
    ipc.emit('pantheon:quit-request', {}, null);
    expect(quit).toHaveBeenCalledTimes(1);
    for (const [method, args] of [
      ['confirmQuit', []],
      [
        'askQuit',
        [{ message: 'Quit?', detail: 'Sessions run on', quit: 'Quit', cancel: 'Cancel' }],
      ],
      ['setPopoverHeight', [200]],
      ['revealMain', ['settings']],
    ] as const) {
      expect(await exposed[method](...args)).toBeUndefined();
      expect(invoke).toHaveBeenLastCalledWith(`pantheon:${method}`, ...args);
    }
    invoke.mockResolvedValueOnce({ ok: true, value: true });
    expect(await exposed.appFocused()).toBe(true);
    expect(invoke).toHaveBeenLastCalledWith('pantheon:appFocused');
    invoke.mockResolvedValueOnce({
      ok: false,
      error: { code: 'forbidden_sender', message: 'Only the popover may resize' },
    });
    await expect(exposed.setPopoverHeight(200)).rejects.toThrow('Only the popover may resize');

    await exposed.openWindow(sessionRequest);
    expect(invoke).toHaveBeenLastCalledWith('pantheon:openWindow', sessionRequest);
    await exposed.popupAppMenu(8, 36);
    expect(invoke).toHaveBeenLastCalledWith('pantheon:popupAppMenu', 8, 36);
    const rowItems = [{ id: 'open', label: 'Open', enabled: true }];
    invoke.mockResolvedValueOnce({ ok: true, value: 'open' });
    expect(await exposed.popupMenu(rowItems)).toBe('open');
    expect(invoke).toHaveBeenLastCalledWith('pantheon:popupMenu', rowItems);
    invoke.mockResolvedValueOnce({
      ok: false,
      error: { code: 'invalid_input', message: 'items must be menu items' },
    });
    await expect(exposed.popupMenu([])).rejects.toThrow('items must be menu items');
    const waiting = [{ project_id: 'alpha', session_id: 'alpha-login', title: 'Fix login' }];
    await exposed.setBadge(1, waiting);
    expect(invoke).toHaveBeenLastCalledWith('pantheon:badge', 1, waiting);
    await exposed.setShellPrefs({ show_tray_icon: false });
    expect(invoke).toHaveBeenLastCalledWith('pantheon:setShellPrefs', { show_tray_icon: false });
    await exposed.setMiniWindow(true);
    expect(invoke).toHaveBeenLastCalledWith('pantheon:setMiniWindow', true);
    invoke.mockResolvedValueOnce({ ok: true, value: true });
    expect(await exposed.miniWindowShown()).toEqual({ ok: true, value: true });
    expect(invoke).toHaveBeenLastCalledWith('pantheon:miniWindowShown');

    const places: unknown[] = [];
    // A place sent before the page listens waits for the first listener.
    ipc.emit('pantheon:show-in-main', {}, { project_id: 'early' });
    const stop = exposed.onShowInMainWindow((place: unknown) => places.push(place));
    expect(places).toEqual([{ project_id: 'early' }]);
    places.length = 0;
    ipc.emit('pantheon:show-in-main', {}, { project_id: 'alpha' });
    stop();
    ipc.emit('pantheon:show-in-main', {}, { project_id: 'beta' });
    expect(places).toEqual([{ project_id: 'alpha' }]);
    const asked = vi.fn();
    exposed.onNewWindowRequest(asked);
    ipc.emit('pantheon:new-window', {}, null);
    expect(asked).toHaveBeenCalledTimes(1);

    await exposed.addRecentProject('/work/alpha');
    expect(invoke).toHaveBeenLastCalledWith('pantheon:addRecentProject', '/work/alpha');
    await exposed.openAtLogin();
    expect(invoke).toHaveBeenLastCalledWith('pantheon:openAtLogin');
    await exposed.setOpenAtLogin(true);
    expect(invoke).toHaveBeenLastCalledWith('pantheon:setOpenAtLogin', true);
    invoke.mockResolvedValueOnce({ ok: true, value: '#0a84ff' });
    expect(await exposed.systemAccent()).toBe('#0a84ff');
    expect(invoke).toHaveBeenLastCalledWith('pantheon:systemAccent');
    const accents: unknown[] = [];
    const stopAccent = exposed.onSystemAccent((accent: unknown) => accents.push(accent));
    ipc.emit('pantheon:system-accent', {}, '#ff375f');
    stopAccent();
    ipc.emit('pantheon:system-accent', {}, null);
    expect(accents).toEqual(['#ff375f']);
  });
});

describe('page permissions', () => {
  it('lets the windows write the clipboard and denies them every other permission', async () => {
    const { module } = await startMain('darwin');
    const { requestHandler, checkHandler } = module.session.defaultSession;
    expect(requestHandler).toBeDefined();
    const answer = vi.fn();
    requestHandler!({}, 'media', answer, {});
    requestHandler!({}, 'clipboard-sanitized-write', answer, {});
    expect(answer.mock.calls).toEqual([[false], [true]]);
    expect(checkHandler!({}, 'media', 'pantheon-app://page', {})).toBe(false);
    expect(checkHandler!({}, 'clipboard-sanitized-write', 'file://', {})).toBe(true);
  });
});

describe('MCP App frames', () => {
  it('lets an app page frame the https origins its policy names and keeps every other frame navigation blocked', async () => {
    const { main, call, windows } = await startMain('darwin');
    const page = (
      (await call(main, 'pantheon:appServe', {
        html: 'app',
        csp: { frameDomains: ['https://player.example.com'] },
      })) as { value: string }
    ).value;
    const plain = ((await call(main, 'pantheon:appServe', { html: 'plain' })) as { value: string })
      .value;
    await call(main, 'pantheon:openWindow', sessionRequest);
    const stopped = (window: FakeWindow, url: string, parent: string | null) => {
      const event = {
        url,
        isMainFrame: false,
        frame: { parent: parent === null ? null : { url: parent } },
        preventDefault: vi.fn(),
      };
      window.webContents.emit('will-frame-navigate', event);
      return event.preventDefault.mock.calls.length > 0;
    };
    expect(stopped(main, 'https://player.example.com/embed/1', page)).toBe(false);
    expect(stopped(main, 'https://other.example.com/', page)).toBe(true);
    expect(stopped(main, 'http://player.example.com/', page)).toBe(true);
    expect(stopped(main, 'https://player.example.com/', plain)).toBe(true);
    expect(stopped(main, 'https://player.example.com/', 'file:///renderer/index.html')).toBe(true);
    expect(stopped(main, 'https://player.example.com/', null)).toBe(true);
    expect(stopped(windows[1]!, 'https://player.example.com/', page)).toBe(true);
  });
});

describe('saving shell switches', () => {
  it('keeps the old switches when they cannot be saved', async () => {
    const root = tempRoot();
    const { main, call, module } = await startMain('darwin', root);
    // A file where the settings folder should be makes every read and write of settings.json fail.
    rmSync(path.join(root, 'userData'), { recursive: true, force: true });
    writeFileSync(path.join(root, 'userData'), '');
    await expect(call(main, 'pantheon:setMiniWindow', true)).rejects.toThrow();
    expect(await call(main, 'pantheon:miniWindowShown')).toEqual({ ok: true, value: false });
    await expect(
      call(main, 'pantheon:setShellPrefs', { keep_running_on_close: false }),
    ).rejects.toThrow();
    module.dialog.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/engines/whisper'],
    });
    await expect(call(main, 'pantheon:chooseVoiceEngine')).rejects.toThrow();
    expect(await call(main, 'pantheon:shellPrefs')).toMatchObject({
      value: { mini_window: false, keep_running_on_close: true, voice_engine: null },
    });
  });
});

describe('chosen files', () => {
  it('uploads the chosen files within the limit and lists them beside the too-large error', async () => {
    const root = tempRoot();
    const small = path.join(root, 'small.txt');
    const large = path.join(root, 'large.bin');
    const later = path.join(root, 'later.txt');
    writeFileSync(small, '');
    truncateSync(small, 10 * 1024 * 1024);
    writeFileSync(large, '');
    truncateSync(large, 20 * 1024 * 1024 + 1);
    writeFileSync(later, 'hello');
    const uploaded: string[] = [];
    const { main, call, module } = await startMain('darwin', root, () => {
      vi.doMock('../../apps/desktop/src/main/daemon.js', async (original) => {
        const actual = await original<typeof import('../../apps/desktop/src/main/daemon.js')>();
        return {
          ...actual,
          DaemonBridge: class extends actual.DaemonBridge {
            async attach(_project_id: string, name: string) {
              uploaded.push(name);
              return { ok: true as const, value: { name } as never };
            }
          },
        };
      });
      cleanups.push(() => vi.doUnmock('../../apps/desktop/src/main/daemon.js'));
    });
    module.dialog.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [small, large, later],
    });
    expect(await call(main, 'pantheon:chooseFiles', 'alpha')).toEqual({
      ok: false,
      error: {
        code: 'attachment_too_large',
        message: 'large.bin is larger than 20 MiB',
        details: { attached: [{ name: 'small.txt' }, { name: 'later.txt' }] },
      },
    });
    expect(uploaded).toEqual(['small.txt', 'later.txt']);
  });
});

describe('browser screenshots', () => {
  it('fails a capture whose PNG is still too large at the narrowest width', async () => {
    const { main, call, views } = await startMain('darwin');
    const opened = (await call(main, 'pantheon:browserOpen', {
      url: 'https://example.com/',
      bounds: { x: 0, y: 0, width: 400, height: 1200 },
    })) as { value: { id: string } };
    const widths: number[] = [];
    views[0]!.webContents.capturePage.mockResolvedValueOnce({
      isEmpty: () => false,
      getSize: () => ({ width: 400, height: 1200 }),
      resize: ({ width }: { width: number }) => {
        widths.push(width);
        return { toPNG: () => Buffer.alloc(800_000) };
      },
    });
    expect(await call(main, 'pantheon:browserCapture', { id: opened.value.id })).toMatchObject({
      ok: false,
      error: { code: 'browser_capture_failed' },
    });
    expect(widths).toEqual([400, 300]);
  });
});

it('exports the desktop window, preference and voice types from the protocol entry point', () => {
  expectTypeOf<WindowContext>().toEqualTypeOf<ReturnType<DesktopBridge['windowContext']>>();
  expectTypeOf<WindowRequest>().toEqualTypeOf<Parameters<DesktopBridge['openWindow']>[0]>();
  expectTypeOf<WindowPlace>().toEqualTypeOf<Parameters<DesktopBridge['showInMainWindow']>[0]>();
  expectTypeOf<ShellPrefs>().toEqualTypeOf<
    Required<Parameters<DesktopBridge['setShellPrefs']>[0]>
  >();
  expectTypeOf<VoiceEvent>().toEqualTypeOf<
    Parameters<Parameters<DesktopBridge['voiceStart']>[1]>[0]
  >();
});

it('exports app info and renderer crash types from the bridge module', () => {
  expectTypeOf<AppInfo>().toEqualTypeOf<Awaited<ReturnType<DesktopBridge['appInfo']>>>();
  expectTypeOf<RendererCrash | null>().toEqualTypeOf<
    Awaited<ReturnType<DesktopBridge['lastCrash']>>
  >();
  expectTypeOf<DesktopBridge['logsDir']>().toEqualTypeOf<() => Promise<string>>();
  expectTypeOf<DesktopBridge['pathForFile']>().toEqualTypeOf<(file: File) => string>();
});
