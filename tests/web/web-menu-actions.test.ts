import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  board: {} as any,
  shell: {} as any,
  projects: {} as any,
}));
const store = vi.hoisted(
  () => (state: () => any) =>
    Object.assign((selector?: any) => (selector ? selector(state()) : state()), {
      getState: state,
    }),
);
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
    subscribe: () => () => {},
  }),
}));
vi.mock('@/store', () => ({ useShell: store(() => mock.shell) }));
vi.mock('@/screens/projects/view', () => ({ useProjectsView: store(() => mock.projects) }));
import { Sidebar } from '@/components/Sidebar';
import { MenuActions } from '@/lib/menu-actions';
import { ProjectsScreen } from '@/screens/projects/ProjectsScreen';
import type { MenuAction } from '@pantheon/protocol';

type Listener = (e: KeyboardEvent) => void;

let listeners: Listener[] = [];
let menuListeners: ((action: MenuAction) => void)[] = [];

const desktop = {
  query: () => new Promise(() => {}),
  onMenuAction: (listener: (action: MenuAction) => void) => {
    menuListeners.push(listener);
    return () => (menuListeners = menuListeners.filter((l) => l !== listener));
  },
};

function stubWindow(pantheon?: object) {
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: Listener) => type === 'keydown' && listeners.push(fn),
    removeEventListener: (type: string, fn: Listener) => {
      if (type === 'keydown') listeners = listeners.filter((l) => l !== fn);
    },
    matchMedia: () => ({ matches: true }),
    pantheon,
  });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
}

beforeEach(() => {
  mock.board = {
    board: {
      cursor: 0,
      projects: [{ id: 'alpha', name: 'Alpha app' }],
      sessions: [],
      session_turns: [],
      workspaces: [],
    },
    events: [],
    status: { state: 'live' },
  };
  mock.projects = {
    query: '',
    opening: false,
    setQuery: vi.fn(),
    setOpening: vi.fn((opening: boolean) => (mock.projects.opening = opening)),
  };
  listeners = [];
  menuListeners = [];
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const press = (key: string, mods: Partial<KeyboardEvent> = {}) => {
  const e = {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    ...mods,
  } as unknown as KeyboardEvent;
  for (const listener of [...listeners]) listener(e);
  return e.preventDefault as ReturnType<typeof vi.fn>;
};
const menu = (action: MenuAction) => {
  for (const listener of [...menuListeners]) listener(action);
};

function mountShell(screen: 'projects' | 'board') {
  mock.shell = {
    screen,
    sessionId: null,
    theme: 'system',
    sessionGroup: null,
    setScreen: vi.fn((next: string) => (mock.shell.screen = next)),
    startNewSession: vi.fn(),
    openSettings: vi.fn(),
  };
  mount(() => {
    Sidebar({
      layout: {
        collapsed: false,
        width: 264,
        resize: () => {},
        commit: () => {},
        reset: () => {},
        toggle: () => {},
      },
      projects: [{ id: 'alpha', name: 'Alpha app' }],
      currentProjectId: 'alpha',
      onChooseProject: () => {},
      list: { data: [] } as any,
      allNeeds: { items: [] } as any,
    });
    MenuActions();
    return screen === 'projects'
      ? ProjectsScreen({ onOpenSettings: () => {}, onOpenProject: () => {} })
      : null;
  });
}

describe('menu actions in the desktop app', () => {
  beforeEach(() => stubWindow(desktop));

  it('runs the new-session handler once for ⌘N, which the menu owns', () => {
    mountShell('board');
    expect(press('n', { metaKey: true })).not.toHaveBeenCalled();
    menu('new-session');
    expect(mock.shell.startNewSession).toHaveBeenCalledTimes(1);
  });

  it('opens the open-project dialog on the projects screen without leaving it', () => {
    mountShell('projects');
    expect(press('o', { metaKey: true })).not.toHaveBeenCalled();
    menu('open-project');
    expect(mock.projects.setOpening).toHaveBeenCalledTimes(1);
    expect(mock.projects.opening).toBe(true);
    expect(mock.shell.setScreen).not.toHaveBeenCalled();
  });

  it('opens the dialog over another screen without leaving it', () => {
    mountShell('board');
    menu('open-project');
    expect(mock.shell.setScreen).not.toHaveBeenCalled();
    expect(mock.projects.opening).toBe(true);
  });

  it('opens the current project settings once for ⌘,', () => {
    mountShell('board');
    expect(press(',', { metaKey: true })).not.toHaveBeenCalled();
    menu('settings');
    expect(mock.shell.openSettings).toHaveBeenCalledTimes(1);
    expect(mock.shell.openSettings).toHaveBeenCalledWith('alpha');
  });

  it('opens the app settings from the menu without a project', () => {
    mock.board.board.projects = [];
    mountShell('projects');
    menu('settings');
    expect(mock.shell.openSettings).toHaveBeenCalledWith(null);
  });

  it('stops listening once unmounted', () => {
    mountShell('board');
    unmountAll();
    expect(menuListeners).toEqual([]);
  });
});

describe('the same keys in a browser', () => {
  beforeEach(() => stubWindow());

  it('handles ⌘N and ⌘, on keydown', () => {
    mountShell('board');
    expect(press('n', { metaKey: true })).toHaveBeenCalledTimes(1);
    expect(mock.shell.startNewSession).toHaveBeenCalledTimes(1);
    expect(press(',', { metaKey: true })).toHaveBeenCalledTimes(1);
    expect(mock.shell.openSettings).toHaveBeenCalledWith('alpha');
  });
});
