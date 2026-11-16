import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readShellPrefs, readShellPrefsPatch } from '../../apps/desktop/src/main/settings.js';
import { eventually } from '../helpers.js';

const ELECTRON = '../../apps/desktop/node_modules/electron/index.js';
const ICONS = fileURLToPath(new URL('../../apps/desktop/src/main/app-icons', import.meta.url));
/** The PNG of one icon file under the main process's icon folder, in base64. */
const iconFile = (kind: 'dock' | 'window' | 'tray', name: string) =>
  readFileSync(path.join(ICONS, kind, `${name}.png`)).toString('base64');
type Handler = (...args: any[]) => unknown;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-app-icon-'));
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
    return this.on(name, fn);
  }
  emit(name: string, ...args: unknown[]) {
    for (const fn of this.listeners.get(name) ?? []) fn(...args);
  }
}

/** An image that remembers the PNG it was made from, in base64, and how it is drawn. */
type FakeImage = {
  png: string;
  scaleFactor?: number;
  template: boolean;
  setTemplateImage(on: boolean): void;
};

function fakeElectron(root: string) {
  const handlers = new Map<string, Handler>();
  const windows: FakeWindow[] = [];
  class FakeContents extends Emitter {
    mainFrame = {};
    send() {}
    isLoading() {
      return false;
    }
    isDestroyed() {
      return false;
    }
    setWindowOpenHandler() {}
  }
  class FakeWindow extends Emitter {
    static getFocusedWindow() {
      return null;
    }
    webContents = new FakeContents();
    icons: FakeImage[] = [];
    constructor(public options: { frame?: boolean; icon?: FakeImage }) {
      super();
      windows.push(this);
    }
    setIcon(image: FakeImage) {
      this.icons.push(image);
    }
    show() {}
    focus() {}
    hide() {}
    maximize() {}
    isFullScreen() {
      return false;
    }
    isMaximized() {
      return false;
    }
    getNormalBounds() {
      return { x: 0, y: 0, width: 1200, height: 800 };
    }
    loadURL() {
      return Promise.resolve();
    }
    loadFile() {
      return Promise.resolve();
    }
    close() {
      this.emit('closed');
    }
  }
  const dockIcons: FakeImage[] = [];
  const trays: FakeTray[] = [];
  class FakeTray extends Emitter {
    images: FakeImage[];
    constructor(image: FakeImage) {
      super();
      this.images = [image];
      trays.push(this);
    }
    setImage(image: FakeImage) {
      this.images.push(image);
    }
    setTitle() {}
    setToolTip() {}
    setContextMenu() {}
    destroy() {}
  }
  const app = Object.assign(new Emitter(), {
    isPackaged: true,
    name: 'Pantheon',
    setPath() {},
    getPath: (name: string) => path.join(root, name),
    getAppPath: () => path.join(root, 'app'),
    getPreferredSystemLanguages: () => ['en-US'],
    whenReady: () => Promise.resolve(),
    getVersion: () => '1.2.3',
    setAboutPanelOptions() {},
    requestSingleInstanceLock: () => true,
    quit() {},
    setUserTasks() {},
    setAsDefaultProtocolClient() {},
    dock: {
      setBadge() {},
      setMenu() {},
      setIcon: (image: FakeImage) => dockIcons.push(image),
    },
  });
  const workArea = { x: 0, y: 0, width: 1600, height: 1000 };
  const module = {
    app,
    BrowserWindow: FakeWindow,
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    session: {
      defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
    },
    Notification: class extends Emitter {},
    dialog: {},
    powerMonitor: new Emitter(),
    systemPreferences: new Emitter(),
    nativeTheme: { shouldUseDarkColors: false, on() {} },
    shell: {},
    ipcMain: {
      handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
      on() {},
    },
    Menu: { buildFromTemplate: (template: unknown) => ({ template }), setApplicationMenu() {} },
    screen: { getAllDisplays: () => [{ workArea }], getPrimaryDisplay: () => ({ workArea }) },
    Tray: FakeTray,
    nativeImage: {
      createFromBuffer: (buffer: Buffer, options?: { scaleFactor: number }): FakeImage => ({
        png: buffer.toString('base64'),
        scaleFactor: options?.scaleFactor,
        template: false,
        setTemplateImage(on: boolean) {
          this.template = on;
        },
      }),
    },
  };
  return { module, handlers, windows, dockIcons, trays };
}
type FakeWindow = ReturnType<typeof fakeElectron>['windows'][number];

async function startMain(platform: NodeJS.Platform, root: string) {
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
  vi.doMock(ELECTRON, () => ({ ...electron.module, default: electron.module }));
  vi.resetModules();
  await import('../../apps/desktop/src/main/index.js');
  await eventually(() => electron.windows.length > 0);
  const main = electron.windows.find((window) => window.options.frame !== false)!;
  const call = (channel: string, ...args: unknown[]) =>
    electron.handlers.get(channel)!(
      { sender: main.webContents, senderFrame: main.webContents.mainFrame },
      ...args,
    );
  return { ...electron, main, call };
}

const savedIcon = (root: string) =>
  JSON.parse(readFileSync(path.join(root, 'userData', 'settings.json'), 'utf8')).app_icon;

describe('app icon setting', () => {
  it('reads only an icon shape and colour pair it has from a page', () => {
    for (const app_icon of ['pantheon-black', 'monad-dusk', 'sigma-lapis'])
      expect(readShellPrefsPatch({ app_icon })).toEqual({ app_icon });
    for (const app_icon of ['pantheon-dusk', 'black', 'default', 'monad', 1])
      expect(readShellPrefsPatch({ app_icon })).toBeNull();
    expect(readShellPrefsPatch({ tray_icon: 'sigma' })).toEqual({ tray_icon: 'sigma' });
    for (const tray_icon of ['star', 'monad-dusk', 1])
      expect(readShellPrefsPatch({ tray_icon })).toBeNull();
  });

  it('reads a saved icon it does not have as the travertine temple', () => {
    const root = tempRoot();
    const file = path.join(root, 'settings.json');
    writeFileSync(file, JSON.stringify({ app_icon: 'black', tray_icon: 'star' }));
    expect(readShellPrefs(file)).toMatchObject({
      app_icon: 'pantheon-travertine',
      tray_icon: 'pantheon',
    });
    writeFileSync(file, JSON.stringify({ app_icon: 'sigma-terracotta', tray_icon: 'monad' }));
    expect(readShellPrefs(file)).toMatchObject({
      app_icon: 'sigma-terracotta',
      tray_icon: 'monad',
    });
  });

  it('starts on the travertine temple and refuses an icon it does not have', async () => {
    const { call } = await startMain('darwin', tempRoot());
    expect(await call('pantheon:shellPrefs')).toMatchObject({
      ok: true,
      value: { app_icon: 'pantheon-travertine', tray_icon: 'pantheon' },
    });
    for (const patch of [{ app_icon: 'pantheon-dusk' }, { tray_icon: 'star' }])
      expect(await call('pantheon:setShellPrefs', patch)).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' },
      });
  });

  it('sets the Dock icon on macOS when chosen, and again at the next start', async () => {
    const root = tempRoot();
    const first = await startMain('darwin', root);
    // A packaged app on the default icon keeps the one in its bundle.
    expect(first.dockIcons).toEqual([]);
    expect(await first.call('pantheon:setShellPrefs', { app_icon: 'monad-dusk' })).toMatchObject({
      ok: true,
      value: { app_icon: 'monad-dusk' },
    });
    expect(first.dockIcons.map((image) => image.png)).toEqual([iconFile('dock', 'monad-dusk')]);
    expect(savedIcon(root)).toBe('monad-dusk');

    vi.resetModules();
    const restarted = await startMain('darwin', root);
    expect(restarted.dockIcons.map((image) => image.png)).toEqual([iconFile('dock', 'monad-dusk')]);
  });

  it('sets the icon of each open window on Linux, and opens new windows with it', async () => {
    const { windows, call } = await startMain('linux', tempRoot());
    const open = [...windows];
    expect(await call('pantheon:setShellPrefs', { app_icon: 'sigma-black' })).toMatchObject({
      ok: true,
    });
    for (const window of open)
      expect(window.icons.at(-1)?.png).toBe(iconFile('window', 'sigma-black'));
    await call('pantheon:openWindow', { kind: 'session', project_id: 'alpha', session_id: 'a1' });
    const opened = windows.at(-1)!;
    expect(open).not.toContain(opened);
    expect(opened.options.icon?.png).toBe(iconFile('window', 'sigma-black'));
  });
});

describe('menu bar icon setting', () => {
  it('draws the chosen shape as a template at twice the point size', async () => {
    const { trays } = await startMain('darwin', tempRoot());
    expect(trays).toHaveLength(1);
    const [image] = trays[0]!.images;
    expect(image).toMatchObject({
      png: iconFile('tray', 'pantheon'),
      scaleFactor: 2,
      template: true,
    });
  });

  it('swaps the image of the tray it has when the shape changes', async () => {
    const { trays, call } = await startMain('darwin', tempRoot());
    expect(await call('pantheon:setShellPrefs', { tray_icon: 'sigma' })).toMatchObject({
      ok: true,
      value: { tray_icon: 'sigma' },
    });
    expect(trays).toHaveLength(1);
    expect(trays[0]!.images.at(-1)).toMatchObject({
      png: iconFile('tray', 'sigma'),
      scaleFactor: 2,
      template: true,
    });
  });

  it('creates the tray with the shape chosen while it was off', async () => {
    const root = tempRoot();
    mkdirSync(path.join(root, 'userData'), { recursive: true });
    writeFileSync(
      path.join(root, 'userData', 'settings.json'),
      JSON.stringify({ show_tray_icon: false }),
    );
    const { trays, call } = await startMain('darwin', root);
    expect(trays).toEqual([]);
    await call('pantheon:setShellPrefs', { tray_icon: 'monad' });
    await call('pantheon:setShellPrefs', { show_tray_icon: true });
    expect(trays).toHaveLength(1);
    expect(trays[0]!.images.map((image) => image.png)).toEqual([iconFile('tray', 'monad')]);
  });
});
