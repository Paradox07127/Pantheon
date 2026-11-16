import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { DesktopBridge } from '@pantheon/protocol';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';

type WindowContext = ReturnType<DesktopBridge['windowContext']>;

const mock = vi.hoisted(() => {
  const state = {
    board: {} as any,
    bridge: undefined as Record<string, any> | undefined,
    items: new Map<string, string>(),
    list: {
      data: [] as unknown[] | null,
      loading: false,
      error: null as string | null,
      reload() {},
    },
    needs: { items: [] as unknown[] | null, error: null as string | null, reload() {} },
    history: { events: [] as unknown[] | null, error: null as string | null, reload() {} },
    historyKeys: [] as (string | null)[],
    toasts: [] as unknown[],
  };
  Object.assign(globalThis, {
    window: {
      get pantheon() {
        return state.bridge;
      },
      innerWidth: 1280,
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      addEventListener() {},
      removeEventListener() {},
    },
    document: { body: { dataset: {} }, hasFocus: () => true },
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
vi.mock('react', async (actual) => {
  const { hooks } = await import('./web-hook-host.js');
  // The page look effects write to the document, which these tests leave out.
  return { ...(await actual<object>()), ...hooks, useLayoutEffect: () => {} };
});
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
    subscribe: () => () => {},
  }),
}));
vi.mock('@/data/workbench-sessions', async (actual) => ({
  ...(await actual<object>()),
  useSessionList: () => mock.list,
}));
vi.mock('@/data/needs-you', async (actual) => ({
  ...(await actual<object>()),
  useNeedsYou: () => mock.needs,
}));
vi.mock('@/data/logs', async (actual) => ({
  ...(await actual<object>()),
  useEventHistory: (options: { key: string | null }) => {
    mock.historyKeys.push(options.key);
    return mock.history;
  },
}));
vi.mock('@/components/Toast', async (actual) => ({
  ...(await actual<object>()),
  toast: (options: unknown) => void mock.toasts.push(options),
}));
vi.mock('@/components/Sidebar', async (actual) => ({
  ...(await actual<object>()),
  useSidebarLayout: () => ({ collapsed: false, toggle() {} }),
}));
import { App } from '@/App';
import { useCurrentProject } from '@/data/current-project';
import { failureText } from '@/data/needs-you';
import { runMenuAction } from '@/lib/menu-actions';
import { SessionWindow } from '@/shell/SessionWindow';
import { useShell } from '@/store';
import { zh } from './i18n-setup.js';

const ok = async () => ({ ok: true, value: null });

/** This page runs in a window of the kind given; the desktop shell's listeners are kept. */
function inWindow(context: WindowContext) {
  const listeners = { show: [] as ((place: any) => void)[], newWindow: [] as (() => void)[] };
  mock.bridge = {
    windowContext: () => context,
    openWindow: vi.fn(ok),
    showInMainWindow: vi.fn(ok),
    setAlwaysOnTop: vi.fn(ok),
    setMenuShortcuts: vi.fn(ok),
    setBadge: vi.fn(async () => {}),
    ready: vi.fn(),
    query: async () => ({ ok: false, error: { code: 'not_found', message: '' } }),
    onShowInMainWindow: (listener: (place: any) => void) => {
      listeners.show.push(listener);
      return () => listeners.show.splice(listeners.show.indexOf(listener), 1);
    },
    onNewWindowRequest: (listener: () => void) => {
      listeners.newWindow.push(listener);
      return () => listeners.newWindow.splice(listeners.newWindow.indexOf(listener), 1);
    },
  };
  return listeners;
}

const listed = {
  id: 'refund-1',
  project_id: 'alpha',
  title: 'Refund idempotency',
  state: 'running',
  runtime: 'codex',
  created_at: '2026-11-01T00:00:00.000Z',
  last_activity_at: '2026-11-01T00:00:00.000Z',
};

const frames: (() => void)[] = [];
beforeEach(() => {
  mock.items.clear();
  frames.length = 0;
  vi.stubGlobal('requestAnimationFrame', (run: () => void) => frames.push(run));
  vi.stubGlobal('cancelAnimationFrame', () => {});
  mock.board = {
    board: {
      projects: [
        { id: 'alpha', name: 'Alpha', roots: [] },
        { id: 'beta', name: 'Beta', roots: [] },
      ],
      sessions: [{ id: 'refund-1', project_id: 'alpha', title: 'Refund idempotency' }],
      session_turns: [],
      workspaces: [],
    },
    status: { state: 'live' },
    events: [],
    start() {},
    stop() {},
  };
  mock.list.data = [listed];
  mock.list.error = null;
  mock.needs.items = [];
  mock.needs.error = null;
  mock.history.events = [];
  mock.history.error = null;
  mock.historyKeys.length = 0;
  mock.toasts.length = 0;
  mock.bridge = undefined;
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
  useCurrentProject.setState({ projectId: 'alpha' });
  useShell.setState({ screen: 'board', sessionId: null });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const isFn = (n: ReactElement<any>, name: string) =>
  typeof n.type === 'function' && n.type.name === name;
const has = (tree: ReactElement, name: string) => nodes(tree).some((n) => isFn(n, name));

/** The app's tree, with the window it picked rendered one level down. */
function app(): ReactElement<any> {
  const top = mount(() => App()).value as ReactElement<any>;
  if (typeof top.type !== 'function') return top;
  return mount(() => (top.type as (props: object) => any)(top.props)).value;
}

describe('a session window', () => {
  it('shows the one session with no sidebar or background work, and still shows failure messages', () => {
    inWindow({ kind: 'session', project_id: 'alpha', session_id: 'refund-1' });
    const top = mount(() => App()).value as ReactElement<any>;
    expect(top.props).toMatchObject({ project_id: 'alpha', session_id: 'refund-1' });
    const shell = app();
    const shown = find(shell, (n) => isFn(n, 'SessionWindow'));
    expect(shown.props).toMatchObject({ project_id: 'alpha', session_id: 'refund-1' });
    const tree = mount(() => SessionWindow(shown.props)).value;
    for (const name of ['Sidebar', 'BackgroundHooks', 'SessionsScreen'])
      expect(has(tree, name)).toBe(false);
    expect(has(tree, 'Toasts')).toBe(true);
    const thread = find(tree, (n) => isFn(n, 'Thread'));
    expect(thread.props).toMatchObject({ sessionId: 'refund-1', listed, ownBar: true });
  });

  it('offers the project sessions that are open for a message to refer to', () => {
    inWindow({ kind: 'session', project_id: 'alpha', session_id: 'refund-1' });
    const other = { ...listed, id: 'export-2', title: 'Export data', state: 'idle' };
    mock.list.data = [
      listed,
      other,
      { ...listed, id: 'old-3', state: 'merged' },
      { ...listed, id: 'kept-4', state: 'idle', archived_at: '2026-11-02T00:00:00.000Z' },
    ];
    const tree = mount(() => SessionWindow({ project_id: 'alpha', session_id: 'refund-1' })).value;
    const thread = find(tree, (n) => isFn(n, 'Thread'));
    expect(thread.props.sessions).toEqual([listed, other]);
  });

  it('heads the conversation with the project, the session title and its state', () => {
    inWindow({ kind: 'session', project_id: 'alpha', session_id: 'refund-1' });
    const tree = mount(() => SessionWindow({ project_id: 'alpha', session_id: 'refund-1' })).value;
    const bar = find(tree, (n) => n.type === 'header');
    expect(text(find(bar, (n) => /\bchip\b/.test(n.props.className ?? '')))).toBe('Alpha');
    expect(text(find(bar, (n) => n.type === 'h1'))).toBe('Refund idempotency');
    expect(has(bar, 'SessionStateIcon')).toBe(true);
    expect(text(find(bar, (n) => n.props.className === 'sw-state'))).toBe(
      zh('components.sessionState.running'),
    );
  });

  it('draws nothing of the session until its board, list, requests and history are in, then all of it', async () => {
    inWindow({ kind: 'session', project_id: 'alpha', session_id: 'refund-1' });
    const board = mock.board.board;
    mock.board.board = null;
    mock.list.data = null;
    mock.needs.items = null;
    mock.history.events = null;
    const h = mount(() => SessionWindow({ project_id: 'alpha', session_id: 'refund-1' }));
    const drawn = () =>
      nodes(h.value).filter(
        (n) => n.type === 'header' || n.type === 'main' || isFn(n, 'Thread') || isFn(n, 'Toasts'),
      ).length;
    const arrive = [
      () => (mock.board.board = board),
      () => (mock.list.data = [listed]),
      () => (mock.needs.items = []),
      () => (mock.history.events = []),
    ];
    for (const next of arrive) {
      expect(drawn()).toBe(0);
      next();
      h.render();
    }
    expect(drawn()).toBe(4);
    expect(text(find(h.value, (n) => n.type === 'h1'))).toBe('Refund idempotency');
    expect(mock.historyKeys).toContain('refund-1');
    // The thread reads its own history from here on.
    expect(mock.historyKeys.at(-1)).toBeNull();

    expect(mock.bridge!.ready).not.toHaveBeenCalled();
    frames.splice(0).forEach((run) => run());
    await new Promise((done) => setTimeout(done));
    expect(mock.bridge!.ready).toHaveBeenCalledTimes(1);
    mock.list.data = null;
    h.render();
    frames.splice(0).forEach((run) => run());
    await new Promise((done) => setTimeout(done));
    expect(drawn()).toBe(4);
    expect(mock.bridge!.ready).toHaveBeenCalledTimes(1);
  });

  it('draws the session once its reads have failed too', () => {
    inWindow({ kind: 'session', project_id: 'alpha', session_id: 'refund-1' });
    mock.list.data = null;
    mock.list.error = 'list failed';
    mock.needs.items = null;
    mock.needs.error = 'requests failed';
    mock.history.events = null;
    mock.history.error = 'history failed';
    const tree = mount(() => SessionWindow({ project_id: 'alpha', session_id: 'refund-1' })).value;
    expect(has(tree, 'Thread')).toBe(true);
  });

  it('keeps the window on top while its pin is pressed', async () => {
    inWindow({ kind: 'session', project_id: 'alpha', session_id: 'refund-1' });
    const h = mount(() => SessionWindow({ project_id: 'alpha', session_id: 'refund-1' }));
    const pin = () =>
      find(h.value, (n) => n.props['aria-label'] === zh('shell.sessionWindow.keepOnTop'));
    expect(pin().props['aria-pressed']).toBe(false);
    pin().props.onClick();
    await h.flush();
    expect(mock.bridge!.setAlwaysOnTop).toHaveBeenLastCalledWith(true);
    expect(pin().props['aria-pressed']).toBe(true);
    pin().props.onClick();
    await h.flush();
    expect(mock.bridge!.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
    expect(pin().props['aria-pressed']).toBe(false);
  });

  it('asks the main window to show this session', () => {
    inWindow({ kind: 'session', project_id: 'alpha', session_id: 'refund-1' });
    const tree = mount(() => SessionWindow({ project_id: 'alpha', session_id: 'refund-1' })).value;
    find(
      tree,
      (n) => n.type === 'button' && text(n.props.children) === zh('shell.sessionWindow.showInMain'),
    ).props.onClick();
    expect(mock.bridge!.showInMainWindow).toHaveBeenCalledWith({
      project_id: 'alpha',
      session_id: 'refund-1',
    });
  });

  it('opens the shortcut sheet from the menu', () => {
    inWindow({ kind: 'session', project_id: 'alpha', session_id: 'refund-1' });
    const top = mount(() => App()).value as ReactElement<any>;
    const h = mount(() => (top.type as (props: object) => any)(top.props));
    const sheet = () => find(h.value, (n) => isFn(n, 'ShortcutSheet'));
    expect(sheet().props.open).toBe(false);
    runMenuAction('shortcuts');
    h.render();
    expect(sheet().props.open).toBe(true);
  });

  it('opens the parent and sub-agent sessions in this window, and goes back and forward between them', () => {
    inWindow({ kind: 'session', project_id: 'alpha', session_id: 'refund-1' });
    const lead = { ...listed, id: 'lead-0', title: 'Payments plan', state: 'idle' };
    const agent = { ...listed, id: 'agent-2', title: 'Write the tests', lead: 'refund-1' };
    mock.list.data = [lead, { ...listed, lead: 'lead-0' }, agent];
    // The place the window starts on.
    useShell.setState({
      history: [
        { projectId: 'alpha', screen: 'sessions', sessionId: 'refund-1', sessionTask: null },
      ],
      historyIndex: 0,
    });
    const top = mount(() => App()).value as ReactElement<any>;
    mount(() => (top.type as (props: object) => any)(top.props));
    const h = mount(() => SessionWindow({ project_id: 'alpha', session_id: 'refund-1' }));
    const shown = () => {
      h.render();
      return find(h.value, (n) => isFn(n, 'Thread')).props.sessionId;
    };
    expect(shown()).toBe('refund-1');
    find(h.value, (n) => n.type === 'button' && n.props.className === 'sh-lead').props.onClick();
    expect(shown()).toBe('lead-0');
    expect(text(find(h.value, (n) => n.type === 'h1'))).toBe('Payments plan');
    useShell.getState().openSession('agent-2');
    expect(shown()).toBe('agent-2');
    // A page of the main window is no step here.
    useShell.getState().setScreen('memory');
    expect(shown()).toBe('agent-2');
    runMenuAction('back');
    expect(shown()).toBe('lead-0');
    runMenuAction('back');
    expect(shown()).toBe('refund-1');
    runMenuAction('back');
    expect(shown()).toBe('refund-1');
    runMenuAction('forward');
    expect(shown()).toBe('lead-0');
    runMenuAction('forward');
    expect(shown()).toBe('agent-2');
    expect(text(find(h.value, (n) => n.type === 'h1'))).toBe('Write the tests');
  });

  it('opens the command palette from the menu with only what this window carries out', async () => {
    inWindow({ kind: 'session', project_id: 'alpha', session_id: 'refund-1' });
    mock.bridge!.miniWindowShown = vi.fn(async () => ({ ok: true, value: false }));
    const top = mount(() => App()).value as ReactElement<any>;
    const h = mount(() => (top.type as (props: object) => any)(top.props));
    const palette = () => find(h.value, (n) => isFn(n, 'CommandPalette'));
    expect(palette().props.open).toBe(false);
    runMenuAction('search');
    await h.flush();
    h.render();
    const { open, items, fileSearch, onNewSession, navigable } = palette().props;
    expect(open).toBe(true);
    expect(fileSearch).toEqual({ projectId: 'alpha', root: undefined });
    expect(onNewSession).toBeUndefined();
    expect(navigable).toBe(false);
    const ids: string[] = items.map((i: { id: string }) => i.id);
    expect(ids).toEqual(
      expect.arrayContaining(['mini-window', 'theme-dark', 'density-compact', 'transcript']),
    );
    // The settings, other screens, sessions and the sidebar are only in the main window.
    expect(items.every((i: { group: string }) => i.group === 'action')).toBe(true);
    for (const id of ['next-attention', 'new-session', 'toggle-sidebar', 'reset-layout'])
      expect(ids).not.toContain(id);
  });
});

describe('the main window', () => {
  it('keeps the sidebar, notifications and badge, with or without the desktop app', () => {
    for (const setUp of [() => inWindow({ kind: 'main' }), () => (mock.bridge = undefined)]) {
      setUp();
      const tree = app();
      for (const name of ['Sidebar', 'Toasts', 'BackgroundHooks'])
        expect(has(tree, name)).toBe(true);
    }
  });

  it('leaves the background work out of a project window and still shows failure messages', () => {
    inWindow({ kind: 'project', project_id: 'alpha' });
    const tree = app();
    expect(has(tree, 'Sidebar')).toBe(true);
    expect(has(tree, 'Toasts')).toBe(true);
    expect(has(tree, 'BackgroundHooks')).toBe(false);
  });

  it('shows the place another window asks for', () => {
    const listeners = inWindow({ kind: 'main' });
    app();
    expect(listeners.show).toHaveLength(1);
    listeners.show[0]!({ project_id: 'beta', session_id: 'beta-1' });
    expect(useCurrentProject.getState().projectId).toBe('beta');
    expect(useShell.getState()).toMatchObject({ screen: 'sessions', sessionId: 'beta-1' });
    listeners.show[0]!({ project_id: 'alpha' });
    expect(useCurrentProject.getState().projectId).toBe('alpha');
  });

  it('opens the new-session composer of the project another window asks for with an empty session', () => {
    const listeners = inWindow({ kind: 'main' });
    app();
    listeners.show[0]!({ project_id: 'beta', session_id: '' });
    expect(useCurrentProject.getState().projectId).toBe('beta');
    expect(useShell.getState()).toMatchObject({ screen: 'sessions', sessionId: '' });
  });

  it('opens the current project in a window of its own from the menu', () => {
    const listeners = inWindow({ kind: 'main' });
    app();
    expect(listeners.newWindow).toHaveLength(1);
    listeners.newWindow[0]!();
    expect(mock.bridge!.openWindow).toHaveBeenCalledWith({ kind: 'project', project_id: 'alpha' });
  });

  it('says why the project window did not open', async () => {
    const listeners = inWindow({ kind: 'main' });
    const error = { code: 'internal', message: 'no display' };
    mock.bridge!.openWindow.mockResolvedValue({ ok: false, error });
    app();
    listeners.newWindow[0]!();
    await vi.waitFor(() => expect(mock.toasts).toHaveLength(1));
    expect(mock.toasts[0]).toEqual({ title: failureText(error), kind: 'failure' });
  });
});
