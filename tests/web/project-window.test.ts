import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { DesktopBridge } from '@pantheon/protocol';
import { zh } from './i18n-setup.js';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';

type WindowContext = ReturnType<DesktopBridge['windowContext']>;

// The window and its storage exist before the modules load, as in the app, so the modules'
// storage listeners are in place.
const mock = vi.hoisted(() => {
  const state = {
    board: {} as any,
    bridge: undefined as Record<string, any> | undefined,
    items: new Map<string, string>(),
    listeners: new Map<string, Set<(event: any) => void>>(),
  };
  Object.assign(globalThis, {
    window: {
      get pantheon() {
        return state.bridge;
      },
      innerWidth: 1280,
      addEventListener: (type: string, listener: (event: any) => void) => {
        if (!state.listeners.has(type)) state.listeners.set(type, new Set());
        state.listeners.get(type)!.add(listener);
      },
      removeEventListener: (type: string, listener: (event: any) => void) =>
        void state.listeners.get(type)?.delete(listener),
    },
    localStorage: {
      get length() {
        return state.items.size;
      },
      key: (i: number) => [...state.items.keys()][i] ?? null,
      getItem: (key: string) => state.items.get(key) ?? null,
      setItem: (key: string, value: string) => void state.items.set(key, value),
      removeItem: (key: string) => void state.items.delete(key),
    },
  });
  return state;
});
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { Sidebar } from '@/components/Sidebar';
import { DIFF_PREFS_KEY, getDiffPrefs } from '@/data/diff-prefs';
import {
  APPEARANCE_KEY,
  DEFAULT_LAYOUT,
  getAppearance,
  getLayout,
  getLook,
  LAYOUT_KEY,
  LOOK_KEY,
} from '@/data/layout';
import { seenRecords } from '@/data/unread';
import { useShell } from '@/store';

const CURRENT_KEY = 'pantheon.currentProject';
const PLACES_KEY = 'pantheon.projectPlaces';

/** This page runs in a window of the kind given. */
function inWindow(context: WindowContext) {
  mock.bridge = {
    windowContext: () => context,
    openWindow: vi.fn(async () => ({ ok: true, value: null })),
    showInMainWindow: vi.fn(async () => ({ ok: true, value: null })),
    setMenuShortcuts: vi.fn(async () => ({ ok: true, value: null })),
  };
}

/** A new window of the kind given opens: its modules load afresh. */
async function openWindow(context: WindowContext) {
  inWindow(context);
  vi.resetModules();
  const { useCurrentProject } = await import('@/data/current-project');
  const store = await import('@/store');
  return { useCurrentProject, useShell: store.useShell };
}

/** Another window stores the value: the storage changes and this window hears of it. */
function otherWindowWrites(key: string, value: string | null) {
  if (value === null) mock.items.delete(key);
  else mock.items.set(key, value);
  for (const listener of mock.listeners.get('storage') ?? []) listener({ key, newValue: value });
}

const PROJECTS = [
  { id: 'alpha', name: 'Alpha' },
  { id: 'beta', name: 'Beta' },
];

beforeEach(() => {
  mock.items.clear();
  mock.board = { board: null, events: [], status: { state: 'live' } };
  inWindow({ kind: 'main' });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
  useShell.setState({ screen: 'sessions', sessionId: null, sessionGroup: null });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

function mountSidebar(options: { collapsed?: boolean } = {}) {
  return mount(() =>
    Sidebar({
      layout: {
        collapsed: options.collapsed ?? false,
        width: 248,
        resize: () => {},
        commit: () => {},
        reset: () => {},
        toggle: () => {},
      },
      projects: PROJECTS,
      currentProjectId: 'alpha',
      onChooseProject: () => {},
      list: { data: [], loading: false, error: null, reload() {} } as any,
      allNeeds: { items: [], error: null } as any,
    }),
  );
}

const isFn = (n: ReactElement<any>, name: string) =>
  typeof n.type === 'function' && n.type.name === name;

/** Renders a function component found in the tree, one level down. */
function expand(node: ReactElement<any>) {
  return mount(() => (node.type as (props: object) => any)(node.props)).value;
}

describe('current project of a project window', () => {
  it('stays on the window project whatever the other windows chose', async () => {
    mock.items.set(CURRENT_KEY, 'beta');
    const { useCurrentProject, useShell } = await openWindow({
      kind: 'project',
      project_id: 'alpha',
    });
    expect(useCurrentProject.getState().projectId).toBe('alpha');
    expect(useShell.getState().screen).toBe('sessions');

    otherWindowWrites(CURRENT_KEY, 'gamma');
    useShell.getState().openProject('alpha');
    useShell.getState().openSession('alpha-1');
    expect(useCurrentProject.getState().projectId).toBe('alpha');
    expect(mock.items.get(CURRENT_KEY)).toBe('gamma');
    expect(mock.items.has(PLACES_KEY)).toBe(false);
  });

  it('opens a session of another project in the main window', async () => {
    const { useCurrentProject, useShell } = await openWindow({
      kind: 'project',
      project_id: 'alpha',
    });
    useShell.getState().openProjectSession('beta', 'beta-1');
    expect(mock.bridge!.showInMainWindow).toHaveBeenCalledWith({
      project_id: 'beta',
      session_id: 'beta-1',
    });
    expect(useCurrentProject.getState().projectId).toBe('alpha');
    expect(useShell.getState().screen).toBe('sessions');
  });

  it('opens the new-session composer of another project in the main window', async () => {
    await openWindow({ kind: 'project', project_id: 'alpha' }).then(({ useShell }) =>
      useShell.getState().openProjectSession('beta', ''),
    );
    expect(mock.bridge!.showInMainWindow).toHaveBeenCalledWith({
      project_id: 'beta',
      session_id: '',
    });
  });

  it('still follows and stores the choice in the main window', async () => {
    mock.items.set(CURRENT_KEY, 'beta');
    const { useCurrentProject } = await openWindow({ kind: 'main' });
    expect(useCurrentProject.getState().projectId).toBe('beta');
    useCurrentProject.getState().choose('alpha');
    expect(mock.items.get(CURRENT_KEY)).toBe('alpha');
  });
});

describe('sidebar of a project window', () => {
  it('heads the sidebar with the project and offers no way to switch it', () => {
    inWindow({ kind: 'project', project_id: 'alpha' });
    const tree = mountSidebar().value;
    expect(nodes(tree).some((n) => isFn(n, 'ProjectMenu'))).toBe(false);
    const head = find(tree, (n) => /\bsb-fixed\b/.test(n.props.className ?? ''));
    expect(text(head)).toBe('Alpha');
    const labels = nodes(tree)
      .filter((n) => n.type === 'button')
      .map((n) => text(n.props.children));
    expect(labels).toContain(zh('app.screenName.settings'));
  });

  it('keeps no all projects button on the folded rail', () => {
    inWindow({ kind: 'project', project_id: 'alpha' });
    const labels = nodes(mountSidebar({ collapsed: true }).value)
      .filter((n) => n.type === 'button' && n.props.className === 'ib')
      .map((n) => n.props['aria-label']);
    expect(labels).not.toContain(zh('app.screenName.projects'));
    expect(labels).toContain(zh('app.screenName.settings'));
  });

  it('opens the current project in a window of its own from the main window menu', () => {
    const menu = expand(find(mountSidebar().value, (n) => isFn(n, 'ProjectMenu')));
    find(menu, (n) => text(n.props.children) === zh('shell.projectWindow.open')).props.onClick();
    expect(mock.bridge!.openWindow).toHaveBeenCalledWith({ kind: 'project', project_id: 'alpha' });
  });
});

describe('preferences another window changes', () => {
  it('follows the layout, appearance and look stored by another window', () => {
    otherWindowWrites(
      LAYOUT_KEY,
      JSON.stringify({ sidebar: { collapsed: true, width: 300 }, inspector: 500, drawer: 480 }),
    );
    expect(getLayout().sidebar).toEqual({ collapsed: true, width: 300 });
    expect(getLayout().inspector).toBe(500);
    otherWindowWrites(APPEARANCE_KEY, JSON.stringify({ density: 'compact' }));
    expect(getAppearance().density).toBe('compact');
    otherWindowWrites(LOOK_KEY, JSON.stringify({ send_key: 'meta-enter' }));
    expect(getLook().send_key).toBe('meta-enter');
    otherWindowWrites(LAYOUT_KEY, null);
    expect(getLayout()).toEqual(DEFAULT_LAYOUT);
  });

  it('follows the diff preferences stored by another window', () => {
    otherWindowWrites(DIFF_PREFS_KEY, JSON.stringify({ view: 'split', wrap: false }));
    expect(getDiffPrefs()).toMatchObject({ view: 'split', wrap: false });
  });

  it('follows the session list grouping stored by another window', () => {
    const h = mountSidebar();
    otherWindowWrites(
      'pantheon.sessionView.alpha',
      JSON.stringify({ grouping: 'time', sort: 'title', archived: false }),
    );
    h.render();
    expect(find(h.value, (n) => isFn(n, 'ViewMenu')).props.view).toEqual({
      grouping: 'time',
      sort: 'title',
      archived: false,
    });
  });

  it('follows the unread marks stored by another window', () => {
    expect(seenRecords('alpha')).toEqual({});
    const record = { seen_at: '2026-01-01T00:00:00.000Z', manual_unread: true };
    otherWindowWrites('pantheon.unread.alpha', JSON.stringify({ 'session-a': record }));
    expect(seenRecords('alpha')).toEqual({ 'session-a': record });
  });
});
