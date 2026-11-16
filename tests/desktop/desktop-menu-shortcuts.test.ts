import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { appMenuTemplate, readMenuShortcuts } from '../../apps/desktop/src/main/window.js';

const ELECTRON = '../../apps/desktop/node_modules/electron/index.js';

const items = (template: MenuItemConstructorOptions[]) =>
  template.flatMap((menu) => (menu.submenu ?? []) as MenuItemConstructorOptions[]);

describe('menu keys the renderer sends', () => {
  it('turns aria notation into accelerators', () => {
    expect(
      readMenuShortcuts({
        'new-session': 'Meta+Shift+N',
        'open-project': 'Control+Alt+ArrowUp',
        settings: 'Meta+;',
      }),
    ).toEqual({
      'new-session': 'CmdOrCtrl+Shift+N',
      'open-project': 'Ctrl+Alt+Up',
      settings: 'CmdOrCtrl+;',
    });
    expect(readMenuShortcuts({})).toEqual({});
  });

  it('takes the keys of the search, sidebar, details, overview, back and forward items', () => {
    const accelerators = readMenuShortcuts({
      search: 'Meta+P',
      'toggle-sidebar': 'Meta+J',
      'toggle-details': 'Meta+Alt+D',
      'toggle-overview': 'Control+Shift+O',
      back: 'Meta+ArrowLeft',
      forward: 'Meta+ArrowRight',
    })!;
    expect(accelerators).toEqual({
      search: 'CmdOrCtrl+P',
      'toggle-sidebar': 'CmdOrCtrl+J',
      'toggle-details': 'CmdOrCtrl+Alt+D',
      'toggle-overview': 'Ctrl+Shift+O',
      back: 'CmdOrCtrl+Left',
      forward: 'CmdOrCtrl+Right',
    });
    const template = appMenuTemplate({
      platform: 'darwin',
      name: 'Pantheon',
      dev: false,
      send: vi.fn(),
      zoom: vi.fn(),
      newWindow: vi.fn(),
      openLogs: vi.fn(),
      about: vi.fn(),
      mini: { shown: false, toggle: vi.fn() },
      accelerators,
    });
    const accelerator = (label: string) =>
      items(template).find((i) => i.label === label)!.accelerator;
    expect(accelerator('查找…')).toBe('CmdOrCtrl+P');
    expect(accelerator('显示/隐藏侧栏')).toBe('CmdOrCtrl+J');
    expect(accelerator('后退')).toBe('CmdOrCtrl+Left');
  });

  it('takes Space, Insert and the other keys Electron names', () => {
    expect(
      readMenuShortcuts({
        settings: 'Meta+Space',
        search: 'Control+Alt+Space',
        'new-session': 'Meta+Insert',
        'open-project': 'Meta+AudioVolumeUp',
        'toggle-sidebar': 'Meta+MediaPlayPause',
        'toggle-details': 'Meta+PrintScreen',
      }),
    ).toEqual({
      settings: 'CmdOrCtrl+Space',
      search: 'Ctrl+Alt+Space',
      'new-session': 'CmdOrCtrl+Insert',
      'open-project': 'CmdOrCtrl+VolumeUp',
      'toggle-sidebar': 'CmdOrCtrl+MediaPlayPause',
      'toggle-details': 'CmdOrCtrl+PrintScreen',
    });
  });

  it.each([null, 'Meta+N'])('refuses %j', (value) => {
    expect(readMenuShortcuts(value)).toBeNull();
  });

  it.each([
    { quit: 'Meta+Q' },
    { settings: 42 },
    { settings: 'N' },
    { settings: 'Shift+N' },
    { settings: 'Meta+' },
    { settings: 'Hyper+N' },
    { settings: 'Meta+Meta+N' },
    { settings: 'Meta+1–9' },
    { settings: 'Meta+Ö' },
  ])('keeps the valid keys beside %j', (entry) => {
    expect(readMenuShortcuts({ search: 'Meta+J', ...entry, back: 'Meta+[' })).toEqual({
      search: 'CmdOrCtrl+J',
      back: 'CmdOrCtrl+[',
    });
  });

  it('builds the menu with the keys sent and the defaults for the rest', () => {
    const template = appMenuTemplate({
      platform: 'darwin',
      name: 'Pantheon',
      dev: false,
      send: vi.fn(),
      zoom: vi.fn(),
      newWindow: vi.fn(),
      openLogs: vi.fn(),
      about: vi.fn(),
      mini: { shown: false, toggle: vi.fn() },
      accelerators: readMenuShortcuts({ 'new-session': 'Meta+Shift+N' })!,
    });
    const accelerator = (label: string) =>
      items(template).find((i) => i.label === label)!.accelerator;
    expect(accelerator('新会话')).toBe('CmdOrCtrl+Shift+N');
    expect(accelerator('打开项目…')).toBe('CmdOrCtrl+O');
    expect(accelerator('设置…')).toBe('CmdOrCtrl+,');
  });
});

describe('preload', () => {
  afterEach(() => {
    vi.doUnmock(ELECTRON);
    vi.resetModules();
  });

  it('sends the menu keys over their own channel', async () => {
    const invoke = vi.fn(async () => ({ ok: true, value: null }));
    let exposed: any;
    const module = {
      contextBridge: { exposeInMainWorld: (_name: string, api: unknown) => (exposed = api) },
      ipcRenderer: {
        invoke,
        on() {},
        send() {},
        sendSync: () => ({ choice: 'system', resolved: 'zh-CN' }),
      },
    };
    vi.doMock(ELECTRON, () => ({ ...module, default: module }));
    vi.resetModules();
    await import('../../apps/desktop/src/preload/index.js');
    const keys = { 'new-session': 'Meta+Shift+N' };
    await exposed.setMenuShortcuts(keys);
    expect(invoke).toHaveBeenCalledWith('pantheon:setMenuShortcuts', keys);
  });
});
