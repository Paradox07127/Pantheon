import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { resolveLocale as resolvePageLocale } from '@/i18n';
import { menuText, resolveLocale, setMenuLocale } from '../../apps/desktop/src/main/locales.js';
import { readLocale } from '../../apps/desktop/src/main/settings.js';
import { appMenuTemplate } from '../../apps/desktop/src/main/window.js';

afterEach(() => setMenuLocale('zh-CN'));

const labels = (platform: NodeJS.Platform) =>
  appMenuTemplate({
    platform,
    name: 'Pantheon',
    dev: true,
    send: vi.fn(),
    zoom: vi.fn(),
    newWindow: vi.fn(),
    openLogs: vi.fn(),
    about: vi.fn(),
    mini: { shown: false, toggle: vi.fn() },
  }).flatMap((menu) => [
    menu.label,
    ...((menu.submenu ?? []) as MenuItemConstructorOptions[]).flatMap((i) => i.label ?? []),
  ]);

describe('menu language', () => {
  it('builds the macOS application menu in English, in title case', () => {
    setMenuLocale('en');
    expect(labels('darwin')).toEqual([
      'Pantheon',
      'About Pantheon',
      'Settings…',
      'Services',
      'Hide Pantheon',
      'Hide Others',
      'Show All',
      'Quit Pantheon',
      'File',
      'New Session',
      'Open Project…',
      'Open Recent',
      'New Window',
      'Close Window',
      'Edit',
      'Undo',
      'Redo',
      'Cut',
      'Copy',
      'Paste',
      'Paste and Match Style',
      'Delete',
      'Select All',
      'Find…',
      'Speech',
      'View',
      'Show/Hide Sidebar',
      'Show Details',
      'Show Overview',
      'Back',
      'Forward',
      'Actual Size',
      'Zoom In',
      'Zoom Out',
      'Enter Full Screen',
      'Reload',
      'Toggle Developer Tools',
      'Window',
      'Minimize',
      'Zoom',
      'Mini Window',
      'Bring All to Front',
      'Help',
      'Keyboard Shortcuts',
      'Open Logs Folder',
      'Copy Diagnostics',
      'Debug View…',
      'Turn Off User Styles',
    ]);
  });

  it('builds the Windows and Linux application menu in English', () => {
    setMenuLocale('en');
    expect(labels('win32')).toEqual([
      'File',
      'New Session',
      'Open Project…',
      'New Window',
      'Settings…',
      'Close Window',
      'Exit',
      'Edit',
      'Undo',
      'Redo',
      'Cut',
      'Copy',
      'Paste',
      'Delete',
      'Select All',
      'Find…',
      'View',
      'Show/Hide Sidebar',
      'Show Details',
      'Show Overview',
      'Back',
      'Forward',
      'Actual Size',
      'Zoom In',
      'Zoom Out',
      'Toggle Full Screen',
      'Reload',
      'Toggle Developer Tools',
      'Window',
      'Minimize',
      'Mini Window',
      'Help',
      'Keyboard Shortcuts',
      'Open Logs Folder',
      'Copy Diagnostics',
      'Debug View…',
      'Turn Off User Styles',
      'About Pantheon',
    ]);
    expect(labels('linux')).toEqual(labels('win32'));
  });

  it('builds the application menu in Simplified Chinese', () => {
    setMenuLocale('zh-CN');
    expect(labels('darwin')).toEqual([
      'Pantheon',
      '关于 Pantheon',
      '设置…',
      '服务',
      '隐藏 Pantheon',
      '隐藏其他',
      '全部显示',
      '退出 Pantheon',
      '文件',
      '新会话',
      '打开项目…',
      '打开最近使用',
      '新窗口',
      '关闭窗口',
      '编辑',
      '撤销',
      '重做',
      '剪切',
      '拷贝',
      '粘贴',
      '粘贴并匹配样式',
      '删除',
      '全选',
      '查找…',
      '语音',
      '视图',
      '显示/隐藏侧栏',
      '显示详情',
      '显示概览',
      '后退',
      '前进',
      '实际大小',
      '放大',
      '缩小',
      '进入全屏幕',
      '重新载入',
      '切换开发者工具',
      '窗口',
      '最小化',
      '缩放',
      '迷你窗',
      '前置全部窗口',
      '帮助',
      '键盘快捷键',
      '打开日志文件夹',
      '复制诊断信息',
      '调试视图…',
      '关闭用户样式',
    ]);
    expect(labels('win32')).toContain('退出');
    expect(labels('win32').at(-1)).toBe('关于 Pantheon');
  });

  it.each([
    [['en-US']],
    [['zh-Hans-CN']],
    [['zh']],
    [['zh-Hant-TW', 'fr-FR']],
    [['fr-FR', 'zh-CN', 'en-GB']],
    [[]],
  ])('resolves the system choice for %j as the page does', (preferred) => {
    expect(resolveLocale('system', preferred)).toBe(resolvePageLocale('system', preferred));
  });

  it('names the file manager of each platform', () => {
    setMenuLocale('en');
    expect(menuText().reveal('darwin')).toBe('Reveal in Finder');
    expect(menuText().reveal('win32')).toBe('Show in File Explorer');
    expect(menuText().reveal('linux')).toBe('Show in file manager');
    setMenuLocale('zh-CN');
    expect(menuText().reveal('win32')).toBe('在文件资源管理器中显示');
    setMenuLocale('en');
  });

  it('names the tray icon with the count waiting for an answer in each language', () => {
    setMenuLocale('en');
    expect(menuText().trayCount('Pantheon', 3)).toBe('Pantheon: 3 waiting for you');
    setMenuLocale('zh-CN');
    expect(menuText().trayCount('Pantheon', 3)).toBe('Pantheon:3 项等你回复');
  });

  it('resolves the system choice by the preferred languages', () => {
    expect(resolveLocale('system', ['zh-Hans-CN', 'en-US'])).toBe('zh-CN');
    expect(resolveLocale('system', ['fr-FR'])).toBe('en');
    expect(resolveLocale('en', ['zh-Hans-CN'])).toBe('en');
  });

  it('reads a saved language choice, else the system choice', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-locale-'));
    try {
      const file = path.join(root, 'settings.json');
      expect(readLocale(file)).toBe('system');
      writeFileSync(file, JSON.stringify({ editor: 'cursor', locale: 'zh-CN' }));
      expect(readLocale(file)).toBe('zh-CN');
      writeFileSync(file, JSON.stringify({ locale: 'fr' }));
      expect(readLocale(file)).toBe('system');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
