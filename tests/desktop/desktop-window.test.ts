import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MenuItemConstructorOptions } from 'electron';
import {
  appMenuTemplate,
  crashRecovery,
  debounced,
  DEFAULT_WINDOW,
  nextZoom,
  placeMiniWindow,
  placeWindow,
  quitsWhenAllWindowsClosed,
  readMiniPlace,
  readWindowState,
  readZoom,
  writeWindowState,
  writeZoom,
} from '../../apps/desktop/src/main/window.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.useRealTimers();
});
function tempFile(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-window-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'nested/window.json');
}

describe('window state file', () => {
  it('reads back what it wrote', () => {
    const file = tempFile();
    const state = { x: 120, y: 64, width: 1400, height: 900, maximized: true };
    writeWindowState(file, state);
    expect(readWindowState(file)).toEqual(state);
  });

  it('gives the defaults for a missing, broken or ill-typed file', () => {
    const file = tempFile();
    expect(readWindowState(file)).toEqual(DEFAULT_WINDOW);
    writeWindowState(file, DEFAULT_WINDOW);
    for (const text of [
      '{not json',
      'null',
      '[]',
      JSON.stringify({ width: '1400', height: 900, maximized: false }),
      JSON.stringify({ width: 1400, height: -1, maximized: false }),
      JSON.stringify({ width: 1400, height: 900, x: 10, maximized: false }),
      JSON.stringify({ width: 1400, height: 900, maximized: 'yes' }),
    ]) {
      writeFileSync(file, text);
      expect(readWindowState(file), text).toEqual(DEFAULT_WINDOW);
    }
  });
});

describe('zoom file', () => {
  it('reads back a saved factor and 1 for a missing, broken or unknown one', () => {
    const file = tempFile();
    expect(readZoom(file)).toBe(1);
    writeZoom(file, 1.25);
    expect(readZoom(file)).toBe(1.25);
    for (const text of ['{not json', 'null', JSON.stringify({ factor: 3 })]) {
      writeFileSync(file, text);
      expect(readZoom(file), text).toBe(1);
    }
  });
});

describe('window placement', () => {
  const primary = { x: 0, y: 25, width: 1440, height: 875 };
  const left = { x: -1920, y: 0, width: 1920, height: 1080 };

  it('keeps a saved position that lies on a display', () => {
    const state = { x: -1500, y: 100, width: 1200, height: 775, maximized: false };
    expect(placeWindow(state, [primary, left], primary)).toEqual({
      x: -1500,
      y: 100,
      width: 1200,
      height: 775,
    });
  });

  it('centres on the primary display when the saved position is off every display', () => {
    const state = { x: 5000, y: 100, width: 1200, height: 775, maximized: false };
    expect(placeWindow(state, [primary, left], primary)).toEqual({
      x: 120,
      y: 75,
      width: 1200,
      height: 775,
    });
  });

  it('centres on the primary display when no position was saved', () => {
    expect(placeWindow({ width: 1200, height: 775, maximized: false }, [primary], primary)).toEqual(
      { x: 120, y: 75, width: 1200, height: 775 },
    );
  });

  it('centres a window whose title bar is off every display even when its body overlaps one', () => {
    const area = { x: 0, y: 0, width: 1440, height: 900 };
    const state = { x: 100, y: -799, width: 1280, height: 800, maximized: false };
    expect(placeWindow(state, [area], area)).toEqual({ x: 80, y: 50, width: 1280, height: 800 });
  });

  it('shrinks a saved window larger than the work area to fit inside it', () => {
    const area = { x: 0, y: 0, width: 1440, height: 900 };
    const state = { x: 0, y: 0, width: 2560, height: 1400, maximized: false };
    expect(placeWindow(state, [area], area)).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
  });

  it('moves a window up so a body taller than the space below its title bar stays inside', () => {
    const area = { x: 0, y: 0, width: 1440, height: 900 };
    const state = { x: 100, y: 600, width: 1200, height: 800, maximized: false };
    expect(placeWindow(state, [area], area)).toEqual({ x: 100, y: 100, width: 1200, height: 800 });
  });

  it('keeps a window that lies wholly inside a work area', () => {
    const state = { x: 100, y: 100, width: 1200, height: 700, maximized: false };
    expect(placeWindow(state, [primary, left], primary)).toEqual({
      x: 100,
      y: 100,
      width: 1200,
      height: 700,
    });
  });
});

describe('mini window placement', () => {
  const primary = { x: 0, y: 25, width: 1440, height: 875 };
  const left = { x: -1920, y: 0, width: 1920, height: 1080 };

  it('starts 16 px in from the bottom right corner of the primary work area', () => {
    expect(placeMiniWindow(null, [primary, left], primary)).toEqual({
      x: 1440 - 360 - 16,
      y: 25 + 875 - 40 - 16,
      width: 360,
      height: 40,
    });
  });

  it('keeps a saved place that lies in any work area and drops one that does not', () => {
    expect(placeMiniWindow({ x: -400, y: 1000 }, [primary, left], primary)).toEqual({
      x: -400,
      y: 1000,
      width: 360,
      height: 40,
    });
    for (const saved of [
      { x: 1200, y: 100 },
      { x: 3000, y: 3000 },
    ])
      expect(placeMiniWindow(saved, [primary, left], primary)).toMatchObject({ x: 1064, y: 844 });
  });

  it('reads a saved place only with integer x and y', () => {
    expect(readMiniPlace({ x: 10, y: -20 })).toEqual({ x: 10, y: -20 });
    for (const value of [null, 'x', { x: 1 }, { x: 1.5, y: 2 }, { x: '1', y: 2 }])
      expect(readMiniPlace(value)).toBeNull();
  });
});

describe('saving on window changes', () => {
  it('runs once after the changes stop, and at once on flush', () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const saver = debounced(save, 500);
    saver.schedule();
    vi.advanceTimersByTime(300);
    saver.schedule();
    vi.advanceTimersByTime(499);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledTimes(1);
    saver.schedule();
    saver.flush();
    expect(save).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1000);
    expect(save).toHaveBeenCalledTimes(2);
  });
});

describe('closing the last window', () => {
  it('quits everywhere except macOS', () => {
    expect(quitsWhenAllWindowsClosed('darwin')).toBe(false);
    expect(quitsWhenAllWindowsClosed('linux')).toBe(true);
    expect(quitsWhenAllWindowsClosed('win32')).toBe(true);
  });
});

describe('renderer crash recovery', () => {
  it('reloads, then draws only the crash page within ten seconds, then gives up within ten more', () => {
    expect(crashRecovery(undefined, 5_000)).toBe('reload');
    expect(crashRecovery({ at: 100_000, recovery: 'reload' }, 109_999)).toBe('crash-page');
    expect(crashRecovery({ at: 100_000, recovery: 'reload' }, 110_000)).toBe('reload');
    expect(crashRecovery({ at: 100_000, recovery: 'crash-page' }, 109_999)).toBe('give-up');
    expect(crashRecovery({ at: 100_000, recovery: 'crash-page' }, 110_000)).toBe('reload');
  });
});

describe('application menu', () => {
  const items = (template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
    template.flatMap((menu) => [
      menu,
      ...items((menu.submenu ?? []) as MenuItemConstructorOptions[]),
    ]);
  const menu = (platform: NodeJS.Platform = 'darwin', dev = false) => {
    const send = vi.fn();
    const about = vi.fn();
    return {
      send,
      about,
      template: appMenuTemplate({
        platform,
        name: 'Pantheon',
        dev,
        send,
        zoom: vi.fn(),
        newWindow: vi.fn(),
        openLogs: vi.fn(),
        about,
        mini: { shown: false, toggle: vi.fn() },
      }),
    };
  };
  const submenu = (template: MenuItemConstructorOptions[], label: string) =>
    template.find((m) => m.label === label)!.submenu as MenuItemConstructorOptions[];
  const roles = (template: MenuItemConstructorOptions[], label: string) =>
    submenu(template, label)
      .map((i) => i.role)
      .filter(Boolean);

  it.each(['darwin', 'win32', 'linux'] as const)(
    'has the app, file, edit, view, window and Help menus on %s',
    (platform) => {
      expect(menu(platform).template.map((m) => m.label)).toEqual([
        ...(platform === 'darwin' ? ['Pantheon'] : []),
        '文件',
        '编辑',
        '视图',
        '窗口',
        '帮助',
      ]);
    },
  );

  it.each([
    ['新会话', 'CmdOrCtrl+N', 'new-session'],
    ['打开项目…', 'CmdOrCtrl+O', 'open-project'],
    ['设置…', 'CmdOrCtrl+,', 'settings'],
    ['查找…', 'CmdOrCtrl+K', 'search'],
    ['显示/隐藏侧栏', 'CmdOrCtrl+B', 'toggle-sidebar'],
    ['显示详情', 'CmdOrCtrl+Alt+B', 'toggle-details'],
    ['显示概览', 'CmdOrCtrl+I', 'toggle-overview'],
    ['后退', 'CmdOrCtrl+[', 'back'],
    ['前进', 'CmdOrCtrl+]', 'forward'],
    ['键盘快捷键', undefined, 'shortcuts'],
    ['调试视图…', undefined, 'debug-view'],
    ['关闭用户样式', undefined, 'disable-user-style'],
  ])('sends %s on %s as the %s action', (label, accelerator, action) => {
    for (const platform of ['darwin', 'win32'] as const) {
      const { send, template } = menu(platform);
      const item = items(template).find((i) => i.label === label)!;
      expect(item.accelerator).toBe(accelerator);
      (item.click as () => void)();
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(action);
    }
  });

  it('lays out the macOS menus in the order of the Apple guidelines', () => {
    const { template } = menu('darwin');
    expect(roles(template, 'Pantheon')).toEqual([
      'about',
      'services',
      'hide',
      'hideOthers',
      'unhide',
      'quit',
    ]);
    expect(submenu(template, 'Pantheon').map((i) => i.label ?? i.type)).toEqual([
      '关于 Pantheon',
      'separator',
      '设置…',
      'separator',
      '服务',
      'separator',
      '隐藏 Pantheon',
      '隐藏其他',
      '全部显示',
      'separator',
      '退出 Pantheon',
    ]);
    expect(submenu(template, '文件').map((i) => i.label ?? i.type)).toEqual([
      '新会话',
      '打开项目…',
      '打开最近使用',
      '新窗口',
      'separator',
      '关闭窗口',
    ]);
    expect(roles(template, '文件')).toEqual(['recentDocuments', 'close']);
    expect(
      (submenu(template, '文件')[2]!.submenu as MenuItemConstructorOptions[]).map((i) => [
        i.role,
        i.label,
      ]),
    ).toEqual([['clearRecentDocuments', '清除菜单']]);
    expect(roles(template, '编辑')).toEqual([
      'undo',
      'redo',
      'cut',
      'copy',
      'paste',
      'pasteAndMatchStyle',
      'delete',
      'selectAll',
    ]);
    expect(
      (submenu(template, '编辑').at(-1)!.submenu as MenuItemConstructorOptions[]).map(
        (i) => i.role,
      ),
    ).toEqual(['startSpeaking', 'stopSpeaking']);
    expect(roles(template, '视图')).toEqual(['togglefullscreen']);
    expect(template.find((m) => m.label === '窗口')!.role).toBe('window');
    expect(roles(template, '窗口')).toEqual(['minimize', 'zoom', 'front']);
    expect(template.find((m) => m.label === '帮助')!.role).toBe('help');
    expect(submenu(template, '帮助').map((i) => i.label ?? i.type)).toEqual([
      '键盘快捷键',
      'separator',
      '打开日志文件夹',
      '复制诊断信息',
      '调试视图…',
      'separator',
      '关闭用户样式',
    ]);
  });

  it.each(['darwin', 'win32', 'linux'] as const)(
    'adds reload and the developer tools only in development on %s',
    (platform) => {
      expect(roles(menu(platform, false).template, '视图')).toEqual(['togglefullscreen']);
      expect(roles(menu(platform, true).template, '视图')).toEqual([
        'togglefullscreen',
        'reload',
        'toggleDevTools',
      ]);
    },
  );

  it.each(['win32', 'linux'] as const)(
    'leaves the macOS-only roles out on %s, ends File with Exit and Help with About',
    (platform) => {
      const { template, about, send } = menu(platform, true);
      const used = items(template).map((i) => i.role);
      for (const role of [
        'hide',
        'hideOthers',
        'unhide',
        'zoom',
        'front',
        'services',
        'about',
        'recentDocuments',
      ])
        expect(used).not.toContain(role);
      expect(submenu(template, '文件').at(-1)).toMatchObject({ role: 'quit', label: '退出' });
      expect(roles(template, '窗口')).toEqual(['minimize']);
      const last = submenu(template, '帮助').at(-1)!;
      expect(last.label).toBe('关于 Pantheon');
      (last.click as () => void)();
      expect(about).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['实际大小', 'CmdOrCtrl+0', 'reset'],
    ['放大', 'CmdOrCtrl+Plus', 'in'],
    ['缩小', 'CmdOrCtrl+-', 'out'],
  ])('zooms the page on %s with %s as the %s step', (label, accelerator, step) => {
    const zoom = vi.fn();
    const template = appMenuTemplate({
      platform: 'darwin',
      name: 'Pantheon',
      dev: false,
      send: vi.fn(),
      zoom,
      newWindow: vi.fn(),
      openLogs: vi.fn(),
      about: vi.fn(),
      mini: { shown: false, toggle: vi.fn() },
    });
    const item = items(template).find((i) => i.label === label)!;
    expect(item.role).toBeUndefined();
    expect(item.accelerator).toBe(accelerator);
    (item.click as () => void)();
    expect(zoom).toHaveBeenCalledTimes(1);
    expect(zoom).toHaveBeenCalledWith(step);
  });
});

describe('zoom steps', () => {
  it.each([
    [0.9, 'in', 1],
    [1, 'in', 1.1],
    [1.1, 'in', 1.25],
    [1.25, 'in', 1.25],
    [1.25, 'out', 1.1],
    [1.1, 'out', 1],
    [1, 'out', 0.9],
    [0.9, 'out', 0.9],
    [0.9, 'reset', 1],
    [1.25, 'reset', 1],
  ] as const)('moves %s %s to %s', (current, step, next) => {
    expect(nextZoom(current, step)).toBe(next);
  });
});
