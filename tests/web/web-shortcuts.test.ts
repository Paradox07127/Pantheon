import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
const mock = vi.hoisted(() => ({
  board: {} as any,
  shell: {} as any,
  projects: {} as any,
  settings: {} as any,
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
  }),
}));
vi.mock('@/store', () => ({ useShell: store(() => mock.shell) }));
const runCommand = vi.hoisted(() => vi.fn(async () => ({ ok: true, value: null })));
vi.mock('@/data/commands', () => ({ runCommand }));
vi.mock('@/screens/projects/view', () => ({ useProjectsView: store(() => mock.projects) }));
vi.mock('@/screens/settings/view', async (actual) => ({
  ...(await actual<object>()),
  useSettingsView: store(() => mock.settings),
}));
import { ShortcutSheet } from '@/components/Shortcuts';
import { Sidebar } from '@/components/Sidebar';
import {
  keyText,
  resetShortcuts,
  setShortcut,
  shortcutConflict,
  SHORTCUTS,
  useShortcut,
} from '@/lib/shortcuts';
import { ProjectsScreen } from '@/screens/projects/ProjectsScreen';
import { sessionMenu } from '@/screens/sessions/model';
import { ProjectSettingsScreen } from '@/screens/settings/ProjectSettingsScreen';

type Listener = (e: KeyboardEvent) => void;

let listeners: Listener[] = [];

beforeEach(() => {
  mock.board = { board: null, events: [], status: { state: 'live' } };
  mock.projects = {
    query: '',
    opening: false,
    setQuery: vi.fn(),
    setOpening: vi.fn((opening: boolean) => (mock.projects.opening = opening)),
  };
  listeners = [];
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: Listener) => type === 'keydown' && listeners.push(fn),
    removeEventListener: (type: string, fn: Listener) => {
      if (type === 'keydown') listeners = listeners.filter((l) => l !== fn);
    },
    matchMedia: () => ({ matches: true }),
  });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
});
afterEach(() => {
  unmountAll();
  resetShortcuts();
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

function mountShell(currentProjectId: string | null, screen: 'projects' | 'board') {
  mock.shell = {
    screen,
    sessionId: null,
    theme: 'system',
    sessionGroup: null,
    setScreen: vi.fn((next: string) => (mock.shell.screen = next)),
    startNewSession: vi.fn(),
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
      currentProjectId,
      onChooseProject: () => {},
      list: { data: [] } as any,
      allNeeds: { items: [] } as any,
    });
    return screen === 'projects'
      ? ProjectsScreen({ onOpenSettings: () => {}, onOpenProject: () => {} })
      : null;
  });
}

describe('new item shortcut', () => {
  it.each([null, 'alpha'])(
    'opens only the open-project dialog on the projects screen (current %s)',
    (current) => {
      mountShell(current, 'projects');
      const handled = press('n', { metaKey: true });
      expect(handled).toHaveBeenCalledTimes(1);
      expect(mock.projects.opening).toBe(true);
      expect(mock.shell.startNewSession).not.toHaveBeenCalled();
      expect(mock.shell.screen).toBe('projects');
    },
  );

  it('opens the new-session composer on another screen with a current project', () => {
    mountShell('alpha', 'board');
    expect(press('n', { metaKey: true })).toHaveBeenCalledTimes(1);
    expect(mock.shell.startNewSession).toHaveBeenCalledTimes(1);
    expect(mock.projects.opening).toBe(false);
  });
});

describe('interrupt shortcut', () => {
  const listed = (state: string, extra: object = {}) => ({
    id: 's1',
    created_at: '2026-01-01T00:00:00.000Z',
    title: 'first',
    runtime: 'claude',
    model: null,
    effort: null,
    permission_mode: 'ask',
    workspace_id: 'workspace-s1',
    workspace_kind: 'linked_worktree',
    state,
    waiting: 0,
    reconciling: false,
    stopping: false,
    last_activity_at: '2026-01-01T00:00:00.000Z',
    changes: null,
    merge: null,
    ...extra,
  });
  const mountSidebar = (session: object) => {
    mock.board = { board: { sessions: [{ id: 's1', revision: 7 }] }, status: { state: 'live' } };
    mock.shell = { screen: 'sessions', sessionId: 's1', sessionGroup: null };
    mount(() =>
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
        list: { data: [session] } as any,
        allNeeds: { items: [] } as any,
      }),
    );
  };

  it('interrupts the turn of the shown session on ⌘.', () => {
    runCommand.mockClear();
    mountSidebar(listed('running'));
    expect(press('.', { metaKey: true })).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith('session.interrupt', { session_id: 's1' }, 7);
  });

  it('leaves a session that is not running or already stopping alone', () => {
    runCommand.mockClear();
    mountSidebar(listed('idle'));
    press('.', { metaKey: true });
    mountSidebar(listed('running', { stopping: true }));
    press('.', { metaKey: true });
    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe('shortcut registry', () => {
  it('gives no two app-wide default keys to the same press', () => {
    const keys = SHORTCUTS.filter((s) => s.scope === 'app' && s.keys !== '').map((s) => s.keys);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });

  it('gives every entry an id of its own', () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('writes keys with the mac symbols', () => {
    expect(keyText('Meta+K')).toBe('⌘K');
    expect(keyText('Meta+Shift+M')).toBe('⇧⌘M');
    expect(keyText('Meta+Enter')).toBe('⌘↵');
    expect(keyText('Alt+Enter')).toBe('⌥↵');
    expect(keyText('Escape')).toBe('Esc');
  });

  it('writes Meta as Ctrl on other platforms', () => {
    vi.stubGlobal('navigator', { userAgent: 'Windows NT 10.0' });
    expect(keyText('Meta+K')).toBe('Ctrl+K');
    expect(keyText('Meta+Shift+M')).toBe('Ctrl+Shift+M');
    expect(keyText('Meta+Alt+P')).toBe('Ctrl+Alt+P');
    expect(keyText('Control+Tab')).toBe('Ctrl+⇥');
    expect(keyText('Escape')).toBe('Esc');
  });

  it('runs a shortcut on its keys only, and not while disabled', () => {
    const run = vi.fn();
    const h = mount(() => useShortcut('sidebar', run));
    press('b', { metaKey: true, shiftKey: true });
    press('k', { metaKey: true });
    press('b');
    expect(run).not.toHaveBeenCalled();
    expect(press('b', { metaKey: true })).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    h.unmount();
    const off = mount(() => useShortcut('sidebar', run, false));
    press('b', { metaKey: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  const bind = (id: Parameters<typeof useShortcut>[0]) => {
    const run = vi.fn();
    const h = mount(() => useShortcut(id, run));
    return run;
  };

  it('answers Meta with ⌘ only on macOS, leaving ⌃K to text editing', () => {
    const run = bind('palette');
    expect(press('k', { ctrlKey: true })).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(press('k', { metaKey: true })).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('answers Meta with Ctrl only on other platforms', () => {
    vi.stubGlobal('navigator', { userAgent: 'Windows NT 10.0' });
    const run = bind('palette');
    expect(press('k', { metaKey: true })).not.toHaveBeenCalled();
    expect(press('k', { ctrlKey: true })).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('leaves keys without Meta to a text field, but not keys with Meta', () => {
    const recent = bind('recent-next');
    const palette = bind('palette');
    const field = { tagName: 'TEXTAREA', isContentEditable: false } as any;
    expect(press('Tab', { ctrlKey: true, target: field })).not.toHaveBeenCalled();
    expect(recent).not.toHaveBeenCalled();
    press('Tab', { ctrlKey: true, target: { tagName: 'DIV', isContentEditable: false } as any });
    expect(recent).toHaveBeenCalledTimes(1);
    press('k', { metaKey: true, target: field });
    expect(palette).toHaveBeenCalledTimes(1);
  });

  const unbound = [
    'session-pin',
    'session-unread',
    'next-attention',
    'transcript',
    'permission-mode',
    'app-dock',
    'app-fullscreen',
    'app-reload',
  ] as const;

  it('runs an entry with no default keys on no press, and lets another entry take any keys', () => {
    const runs = unbound.map(bind);
    expect(listeners).toEqual([]);
    press('π', { metaKey: true, altKey: true, code: 'KeyP' });
    press('u', { metaKey: true, shiftKey: true });
    press('o', { ctrlKey: true });
    press('m', { metaKey: true, shiftKey: true });
    press('');
    for (const run of runs) expect(run).not.toHaveBeenCalled();
    expect(shortcutConflict('palette', 'Meta+Alt+P')).toBeNull();
    expect(setShortcut('session-pin', 'Meta+Alt+P')).toBeNull();
    expect(setShortcut('session-unread', 'Meta+Shift+U')).toBeNull();
  });

  it('opens the model menu on ⇧⌘M', () => {
    const run = bind('model-menu');
    press('m', { metaKey: true });
    expect(run).not.toHaveBeenCalled();
    expect(press('M', { metaKey: true, shiftKey: true })).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs the transcript toggle on keys the user records, and on none once reset', () => {
    const run = vi.fn();
    const h = mount(() => useShortcut('transcript', run));
    expect(setShortcut('transcript', 'Control+O')).toBeNull();
    h.render();
    press('o', { ctrlKey: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(setShortcut('transcript', '')).toBeNull();
    h.render();
    press('o', { ctrlKey: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('puts no keys on the pin and unread entries of the session menu, and F2 on rename', () => {
    const menu = sessionMenu({
      id: 's1',
      created_at: '2026-01-01T00:00:00.000Z',
      title: 'first',
      runtime: 'claude',
      model: null,
      effort: null,
      permission_mode: 'ask',
      workspace_id: 'workspace-s1',
      workspace_kind: 'linked_worktree',
      state: 'running',
      waiting: 0,
      reconciling: false,
      stopping: false,
      last_activity_at: '2026-01-01T00:00:00.000Z',
      changes: null,
      merge: null,
    } as any).flat();
    const keys = ['session.pin', 'session.mark_unread', 'session.rename'].map((command) => {
      const entry = menu.find((one) => 'command' in one && one.command === command) as any;
      return entry && (entry.keys ?? null);
    });
    expect(keys).toEqual([null, null, 'F2']);
  });
});

const rows = (tree: any) => nodes(tree).filter((n) => n.type === 'tr');
const listIn = (tree: any) => {
  const list = named(tree, 'ShortcutList');
  return (list.type as (props: unknown) => ReactNode)(list.props);
};

describe('shortcut lists', () => {
  it('lists every registry entry on the settings page, grouped by scope', () => {
    mock.board = { board: null };
    mock.settings = { page: 'shortcuts', setPage: vi.fn() };
    const h = mount(() => ProjectSettingsScreen());
    const page = named(h.value, 'AppPage');
    const settings = (page.type as (props: unknown) => ReactNode)(page.props) as any;
    const shown = mount(() => settings.type(settings.props) as ReactNode).value;
    const keyRows = (tree: any) => nodes(tree).filter((n) => n.props.className === 'kset-row');
    expect(keyRows(shown)).toHaveLength(SHORTCUTS.length);
    const groups = nodes(shown)
      .filter((n) => n.props.role === 'group')
      .map((g) => keyRows(g).length);
    expect(groups.reduce((a, b) => a + b, 0)).toBe(SHORTCUTS.length);
    expect(groups.length).toBe(new Set(SHORTCUTS.map((s) => s.scope)).size);
    expect(text(keyRows(shown)[0])).toBe(SHORTCUTS[0]!.label + keyText(SHORTCUTS[0]!.keys));
  });

  it('lists the same entries in the shortcut sheet', () => {
    const sheet = ShortcutSheet({ open: true, onOpenChange: () => {} });
    expect(text(find(sheet, (n) => n.props.className === 'pj-dt'))).toBe(
      zh('components.shortcuts.title'),
    );
    expect(rows(listIn(sheet))).toHaveLength(SHORTCUTS.length);
  });
});
