// The rules match apps/web/src/i18n, which the main process cannot import.
import type { UiLocale, UiLocaleChoice } from '@pantheon/protocol';

export type Locale = UiLocale;
export type LocaleChoice = UiLocaleChoice;
export const LOCALE_CHOICES: readonly LocaleChoice[] = ['system', 'en', 'zh-CN'];

const matchLocale = (tag: string): Locale | null => {
  const lower = tag.toLowerCase();
  if (lower === 'zh' || lower.startsWith('zh-hans') || lower.startsWith('zh-cn')) return 'zh-CN';
  if (lower === 'en' || lower.startsWith('en-')) return 'en';
  return null;
};

/** The language a choice shows; 'system' takes the first preferred language there is a catalog for. */
export function resolveLocale(choice: LocaleChoice, preferred: readonly string[]): Locale {
  if (choice !== 'system') return choice;
  for (const tag of preferred) {
    const locale = matchLocale(tag);
    if (locale) return locale;
  }
  return 'en';
}

export interface MenuText {
  about: (name: string) => string;
  settings: string;
  installCli: string;
  cliInstalled: (file: string) => string;
  cliOccupied: (file: string) => string;
  cliAddToPath: string;
  cliFailed: string;
  services: string;
  hide: (name: string) => string;
  hideOthers: string;
  showAll: string;
  quit: (name: string) => string;
  exit: string;
  file: string;
  newSession: string;
  openProject: string;
  openRecent: string;
  clearMenu: string;
  edit: string;
  undo: string;
  redo: string;
  cut: string;
  copy: string;
  paste: string;
  pasteAndMatchStyle: string;
  delete: string;
  selectAll: string;
  find: string;
  speech: string;
  startSpeaking: string;
  stopSpeaking: string;
  copyLink: string;
  view: string;
  toggleSidebar: string;
  showDetails: string;
  showOverview: string;
  back: string;
  forward: string;
  reload: string;
  toggleDevTools: string;
  actualSize: string;
  zoomIn: string;
  zoomOut: string;
  /** macOS swaps it for Exit Full Screen while the window is in full screen. */
  enterFullScreen: string;
  fullScreen: string;
  window: string;
  newWindow: string;
  closeWindow: string;
  minimize: string;
  zoom: string;
  front: string;
  miniWindow: string;
  help: string;
  keyboardShortcuts: string;
  openLogs: string;
  copyDiagnostics: string;
  backgroundTitle: string;
  backgroundBody: (running: number) => string;
  openApp: (name: string) => string;
  trayCount: (name: string, count: number) => string;
  openWith: (editor: string) => string;
  reveal: (platform: NodeJS.Platform) => string;
}

export const MENU_TEXT: Record<Locale, MenuText> = {
  en: {
    about: (name) => `About ${name}`,
    settings: 'Settings…',
    installCli: 'Install Command Line Tool…',
    cliInstalled: (file) => `Installed the pantheon command at ${file}.`,
    cliOccupied: (file) =>
      `${file} already exists and was not made by Pantheon, so it was left as is.`,
    cliAddToPath:
      'Add this line to your shell profile, such as ~/.zshrc, then open a new terminal:',
    cliFailed: 'Could not install the command line tool.',
    services: 'Services',
    hide: (name) => `Hide ${name}`,
    hideOthers: 'Hide Others',
    showAll: 'Show All',
    quit: (name) => `Quit ${name}`,
    exit: 'Exit',
    file: 'File',
    newSession: 'New Session',
    openProject: 'Open Project…',
    openRecent: 'Open Recent',
    clearMenu: 'Clear Menu',
    edit: 'Edit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    pasteAndMatchStyle: 'Paste and Match Style',
    delete: 'Delete',
    selectAll: 'Select All',
    find: 'Find…',
    speech: 'Speech',
    startSpeaking: 'Start Speaking',
    stopSpeaking: 'Stop Speaking',
    copyLink: 'Copy Link',
    view: 'View',
    toggleSidebar: 'Show/Hide Sidebar',
    showDetails: 'Show Details',
    showOverview: 'Show Overview',
    back: 'Back',
    forward: 'Forward',
    reload: 'Reload',
    toggleDevTools: 'Toggle Developer Tools',
    actualSize: 'Actual Size',
    zoomIn: 'Zoom In',
    zoomOut: 'Zoom Out',
    enterFullScreen: 'Enter Full Screen',
    fullScreen: 'Toggle Full Screen',
    window: 'Window',
    newWindow: 'New Window',
    closeWindow: 'Close Window',
    minimize: 'Minimize',
    zoom: 'Zoom',
    front: 'Bring All to Front',
    miniWindow: 'Mini Window',
    help: 'Help',
    keyboardShortcuts: 'Keyboard Shortcuts',
    openLogs: 'Open Logs Folder',
    copyDiagnostics: 'Copy Diagnostics',
    backgroundTitle: 'Pantheon is still running in the background',
    backgroundBody: (running) =>
      `${running} sessions keep running. Open it from the menu bar icon.`,
    openApp: (name) => `Open ${name}`,
    trayCount: (name, count) => `${name}: ${count} waiting for you`,
    openWith: (editor) => `Open with ${editor}`,
    reveal: (platform) =>
      platform === 'darwin'
        ? 'Reveal in Finder'
        : platform === 'win32'
          ? 'Show in File Explorer'
          : 'Show in file manager',
  },
  'zh-CN': {
    about: (name) => `关于 ${name}`,
    settings: '设置…',
    installCli: '安装命令行工具…',
    cliInstalled: (file) => `pantheon 命令已装到 ${file}。`,
    cliOccupied: (file) => `${file} 已存在且不是 Pantheon 写的，没有覆盖。`,
    cliAddToPath: '把这一行加进 shell 配置(例如 ~/.zshrc),再开一个新终端:',
    cliFailed: '没能安装命令行工具。',
    services: '服务',
    hide: (name) => `隐藏 ${name}`,
    hideOthers: '隐藏其他',
    showAll: '全部显示',
    quit: (name) => `退出 ${name}`,
    exit: '退出',
    file: '文件',
    newSession: '新会话',
    openProject: '打开项目…',
    openRecent: '打开最近使用',
    clearMenu: '清除菜单',
    edit: '编辑',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '拷贝',
    paste: '粘贴',
    pasteAndMatchStyle: '粘贴并匹配样式',
    delete: '删除',
    selectAll: '全选',
    find: '查找…',
    speech: '语音',
    startSpeaking: '开始朗读',
    stopSpeaking: '停止朗读',
    copyLink: '拷贝链接',
    view: '视图',
    toggleSidebar: '显示/隐藏侧栏',
    showDetails: '显示详情',
    showOverview: '显示概览',
    back: '后退',
    forward: '前进',
    reload: '重新载入',
    toggleDevTools: '切换开发者工具',
    actualSize: '实际大小',
    zoomIn: '放大',
    zoomOut: '缩小',
    enterFullScreen: '进入全屏幕',
    fullScreen: '切换全屏',
    window: '窗口',
    newWindow: '新窗口',
    closeWindow: '关闭窗口',
    minimize: '最小化',
    zoom: '缩放',
    front: '前置全部窗口',
    miniWindow: '迷你窗',
    help: '帮助',
    keyboardShortcuts: '键盘快捷键',
    openLogs: '打开日志文件夹',
    copyDiagnostics: '复制诊断信息',
    backgroundTitle: 'Pantheon 还在后台运行',
    backgroundBody: (running) => `${running} 个会话继续跑。从菜单栏图标打开。`,
    openApp: (name) => `打开 ${name}`,
    trayCount: (name, count) => `${name}:${count} 项等你回复`,
    openWith: (editor) => `用 ${editor} 打开`,
    reveal: (platform) =>
      platform === 'darwin'
        ? '在 Finder 中显示'
        : platform === 'win32'
          ? '在文件资源管理器中显示'
          : '在文件管理器中显示',
  },
};

let current: Locale = 'en';

/** Sets the language the menus are built in. */
export function setMenuLocale(locale: Locale): void {
  current = locale;
}

export const menuText = (): MenuText => MENU_TEXT[current];
