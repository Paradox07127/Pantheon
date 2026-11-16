import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const { seen, screen } = vi.hoisted(() => {
  const seen = {
    mounts: {} as Record<string, number>,
    /** The screen that throws while it renders. */
    broken: null as string | null,
    palette: [] as {
      open: boolean;
      items: { id: string }[];
      onOpenChange: (open: boolean) => void;
    }[],
    controls: null as { onSearch: () => void } | null,
  };
  // Each screen counts its mounts in a state initialiser, which runs once per mount.
  const screen = (name: string) => async () => {
    const { createElement, useState } = await import('react');
    return () => {
      if (seen.broken === name) throw new Error(`bad ${name} screen`);
      useState(() => (seen.mounts[name] = (seen.mounts[name] ?? 0) + 1));
      return createElement('div', { 'data-screen': name });
    };
  };
  return { seen, screen };
});
const { list, needs } = vi.hoisted(() => ({
  list: { data: [], loading: false, error: null, reload() {} },
  needs: { items: [], loading: false, error: null, reload() {} },
}));
vi.mock('@/screens/sessions/SessionsScreen', async () => ({
  SessionsScreen: await screen('sessions')(),
}));
vi.mock('@/screens/board/BoardScreen', async (actual) => ({
  ...(await actual<object>()),
  BoardScreen: await screen('board')(),
}));
vi.mock('@/screens/memory/MemoryScreen', async () => ({
  MemoryScreen: await screen('memory')(),
}));
vi.mock('@/screens/trace/TraceScreen', async () => ({ TraceScreen: await screen('trace')() }));
vi.mock('@/screens/projects/ProjectsScreen', async () => ({
  ProjectsScreen: await screen('projects')(),
}));
vi.mock('@/screens/settings/ProjectSettingsScreen', async () => ({
  ProjectSettingsScreen: await screen('settings')(),
  SettingsTools: () => null,
}));
vi.mock('@/components/Sidebar', async () => {
  const { createElement } = await import('react');
  return {
    Sidebar: () => createElement('nav', { 'data-sidebar': '' }),
    useSidebarLayout: () => ({ collapsed: false, toggle() {} }),
  };
});
vi.mock('@/components/TopBar', () => ({ TopBar: () => null }));
vi.mock('@/components/Shortcuts', () => ({ ShortcutSheet: () => null }));
vi.mock('@/components/Toast', () => ({ Toasts: () => null }));
vi.mock('@/components/WindowControls', () => ({
  WindowControls: (props: { onSearch: () => void }) => {
    seen.controls = props;
    return null;
  },
}));
vi.mock('@/components/CommandPalette', () => ({
  CommandPalette: (props: (typeof seen.palette)[number]) => {
    seen.palette.push(props);
    return null;
  },
}));
vi.mock('@/screens/sessions/model', async (actual) => {
  const real = await actual<typeof import('@/screens/sessions/model')>();
  return { ...real, groupWorkbenchSessions: vi.fn(real.groupWorkbenchSessions) };
});
vi.mock('@/data/workbench-sessions', async (actual) => ({
  ...(await actual<object>()),
  useSessionList: () => list,
}));
vi.mock('@/data/needs-you', async (actual) => ({
  ...(await actual<object>()),
  useNeedsYou: () => needs,
}));
vi.mock('@/data/notifications', async (actual) => ({
  ...(await actual<object>()),
  useNotices: () => {},
}));
vi.mock('@/screens/sessions/parts', () => ({ useQueueDispatch: () => {} }));
vi.mock('@/data/facts-read', () => ({ useFactsRefreshOnOpen: () => {} }));
vi.mock('@/components/NoticeFeed', () => ({ NoticeFeed: () => null }));

import { act, createElement } from 'react';
import { App } from '@/App';
import { useBoard } from '@/data/board';
import { useCurrentProject } from '@/data/current-project';
import { groupWorkbenchSessions } from '@/screens/sessions/model';
import { useShell } from '@/store';
import { FakeDocument, FakeElement, type FakeNode } from './web-fake-dom.js';
import { zh } from './i18n-setup.js';

const doc = new FakeDocument();
const win = {
  document: doc,
  HTMLIFrameElement: class {},
  innerWidth: 1440,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  addEventListener() {},
  removeEventListener() {},
};
doc.defaultView = win;
const container = doc.createElement('div');
doc.body.appendChild(container);
let root: { render: (node: ReactNode) => void; unmount: () => void };

const project = (id: string) => ({ id, name: id, roots: [] });
const shown = (name: string) =>
  find(container, (n) => n instanceof FakeElement && n.getAttribute('data-screen') === name);
function find(node: FakeNode, test: (n: FakeNode) => boolean): FakeElement | undefined {
  if (test(node)) return node as FakeElement;
  for (const c of node.childNodes) {
    const hit = find(c, test);
    if (hit) return hit;
  }
}
// Animation frame callbacks wait here until `frame()` runs the ones asked for so far.
let frames: (() => void)[] = [];
const frame = () => frames.splice(0).forEach((run) => run());
const go = (screen: Parameters<ReturnType<typeof useShell.getState>['setScreen']>[0]) =>
  act(() => useShell.getState().setScreen(screen));

beforeAll(async () => {
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('requestAnimationFrame', (run: () => void) => frames.push(run));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => delete frames[id - 1]);
  useBoard.setState({
    start() {},
    stop() {},
    board: { projects: [project('alpha'), project('beta')] } as never,
  });
  useCurrentProject.getState().choose('alpha');
  useShell.setState({ screen: 'board' });
  const { createRoot } = await import('react-dom/client');
  root = createRoot(container as never);
  await act(() => root.render(createElement(App)));
});

afterAll(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it('keeps a visited screen mounted and hidden while another screen shows', async () => {
  expect(shown('board')?.style.display).not.toBe('none');
  await go('trace');
  expect(shown('trace')?.style.display).not.toBe('none');
  // display:none takes the screen out of the accessibility tree.
  expect(shown('board')?.style.display).toBe('none');
  await go('board');
  expect(shown('board')?.style.display).toBe('');
  expect(shown('trace')?.style.display).toBe('none');
  expect(seen.mounts).toMatchObject({ board: 1, trace: 1 });
});

it('opens the palette from the search button beside the sidebar toggle, on every page', async () => {
  for (const page of ['board', 'sessions'] as const) {
    await go(page);
    await act(() => seen.controls!.onSearch());
    expect(seen.palette.at(-1)!.open).toBe(true);
    await act(() => seen.palette.at(-1)!.onOpenChange(false));
    expect(seen.palette.at(-1)!.open).toBe(false);
  }
  await go('board');
});

it('mounts the memory page once and keeps it while another screen shows', async () => {
  await go('memory');
  expect(shown('memory')?.style.display).not.toBe('none');
  await go('board');
  expect(shown('memory')?.style.display).toBe('none');
  await go('memory');
  expect(shown('memory')?.style.display).toBe('');
  expect(seen.mounts.memory).toBe(1);
  await go('board');
});

it('holds transitions for one frame after a screen switch, so entrances in a kept screen do not replay', async () => {
  const main = shown('board')!.parentNode as InstanceType<typeof FakeElement>;
  frame();
  frame();
  expect(main.hasAttribute('data-switching')).toBe(false);
  await go('trace');
  expect(main.hasAttribute('data-switching')).toBe(true);
  frame();
  expect(main.hasAttribute('data-switching')).toBe(true);
  frame();
  expect(main.hasAttribute('data-switching')).toBe(false);
  await go('board');
});

it('builds the palette items only while the palette is open', async () => {
  await go('projects');
  expect(groupWorkbenchSessions).not.toHaveBeenCalled();
  await act(() => seen.palette.at(-1)!.onOpenChange(true));
  expect(groupWorkbenchSessions).toHaveBeenCalled();
  const open = seen.palette.at(-1)!;
  expect(open.open).toBe(true);
  const ids = open.items.map((i) => i.id);
  expect(ids).toContain('screen-trace');
  expect(ids).toContain('screen-memory');
  expect(ids).not.toContain('screen-runtime');
  expect(ids).not.toContain('screen-flow');
  expect(ids.indexOf('screen-insights')).toBe(ids.indexOf('screen-board') + 1);
  expect(ids.indexOf('screen-repo')).toBe(ids.indexOf('screen-insights') + 1);
  expect(ids.indexOf('screen-retro')).toBe(ids.indexOf('screen-repo') + 1);
});

it('asks for a chart from the palette the way the empty canvas does, with a new session', async () => {
  const items = seen.palette.at(-1)!.items as { id: string; label: string; run: () => void }[];
  const draw = items.find((i) => i.id === 'draw-chart')!;
  expect(draw.label).toBe(zh('app.palette.drawChart'));
  const opened = useShell.getState().sessionOpened;
  await act(() => draw.run());
  expect(useShell.getState()).toMatchObject({
    screen: 'sessions',
    sessionId: '',
    sessionOpened: opened + 1,
  });
  await go('projects');
});

it('opens recent activity as the trace page on its activity tab', async () => {
  const items = seen.palette.at(-1)!.items as { id: string; run: () => void }[];
  await act(() => items.find((i) => i.id === 'recent-activity')!.run());
  expect(useShell.getState()).toMatchObject({ screen: 'trace', traceTab: 'activity' });
  useShell.setState({ traceTab: 'timeline' });
  await go('projects');
});

it('lists an unread idle session with those to review, after a working one and before a read one', async () => {
  const stored = new Map([
    [
      'pantheon.unread.alpha',
      JSON.stringify({
        quiet: { seen_at: '2026-11-01T00:00:00.000Z' },
        read: { seen_at: '2026-11-04T00:00:00.000Z' },
      }),
    ],
  ]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
  const session = (id: string, state: string, at: string) => ({
    id,
    state,
    title: id,
    runtime: 'claude',
    created_at: at,
    last_activity_at: at,
  });
  (list as { data: unknown[] }).data = [
    session('busy', 'running', '2026-11-01T00:00:00.000Z'),
    session('read', 'idle', '2026-11-03T00:00:00.000Z'),
    session('quiet', 'idle', '2026-11-02T00:00:00.000Z'),
  ];
  await act(() => seen.palette.at(-1)!.onOpenChange(false));
  await act(() => seen.palette.at(-1)!.onOpenChange(true));
  const ids = seen.palette.at(-1)!.items.map((i) => i.id);
  expect(ids.filter((id) => id.startsWith('session-'))).toEqual([
    'session-busy',
    'session-quiet',
    'session-read',
  ]);
});

it('drops the kept screens when the current project changes', async () => {
  expect(shown('trace')).toBeDefined();
  await act(() => useCurrentProject.getState().choose('beta'));
  expect(shown('trace')).toBeUndefined();
  expect(shown('board')).toBeUndefined();
  expect(shown('projects')?.style.display).not.toBe('none');
  await go('trace');
  expect(seen.mounts.trace).toBe(2);
});

const sidebar = () =>
  find(container, (n) => n instanceof FakeElement && n.hasAttribute('data-sidebar'));
const alert = () =>
  find(container, (n) => n instanceof FakeElement && n.getAttribute('role') === 'alert');
const press = (button: FakeElement) => {
  const key = Object.keys(button).find((k) => k.startsWith('__reactProps'))!;
  return act(() => (button as never as Record<string, { onClick: () => void }>)[key]!.onClick());
};

it('puts a failure line in place of a screen that throws, keeps the sidebar, and mounts the screen again on retry', async () => {
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
  seen.broken = 'memory';
  const mounts = seen.mounts.memory ?? 0;
  await go('memory');
  expect(shown('memory')).toBeUndefined();
  expect(sidebar()).toBeDefined();
  expect(alert()?.textContent).toContain('bad memory screen');
  seen.broken = null;
  await press(find(alert()!, (n) => n.nodeName === 'BUTTON')!);
  expect(alert()).toBeUndefined();
  expect(shown('memory')).toBeDefined();
  expect(seen.mounts.memory).toBe(mounts + 1);
  quiet.mockRestore();
});

it('mounts a screen that threw again when it shows again', async () => {
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
  seen.broken = 'board';
  await go('board');
  expect(shown('board')).toBeUndefined();
  expect(alert()?.textContent).toContain('bad board screen');
  await go('trace');
  seen.broken = null;
  await go('board');
  expect(shown('board')?.style.display).toBe('');
  expect(alert()).toBeUndefined();
  quiet.mockRestore();
});
