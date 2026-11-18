import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const { seen, list, needs } = vi.hoisted(() => ({
  seen: { titleBar: [] as { needs: readonly { project_id: string }[] }[] },
  list: { data: [], loading: false, error: null, reload() {} },
  needs: {
    items: [
      { project_id: 'alpha', source: { id: 'a-1' } },
      { project_id: 'home', source: { id: 'h-1' } },
      { project_id: 'beta', source: { id: 'b-1' } },
    ],
    loading: false,
    error: null,
    reload() {},
  },
}));
vi.mock('@/screens/sessions/SessionsScreen', () => ({ SessionsScreen: () => null }));
vi.mock('@/screens/board/BoardScreen', async (actual) => ({
  ...(await actual<object>()),
  BoardScreen: () => null,
}));
vi.mock('@/screens/projects/ProjectsScreen', () => ({ ProjectsScreen: () => null }));
vi.mock('@/components/Sidebar', () => ({
  Sidebar: () => null,
  useSidebarLayout: () => ({ collapsed: false, toggle() {} }),
}));
vi.mock('@/components/TitleBarEnd', () => ({
  TitleBarEnd: (props: (typeof seen.titleBar)[number]) => {
    seen.titleBar.push(props);
    return null;
  },
}));
vi.mock('@/components/TopBar', () => ({ TopBar: () => null }));
vi.mock('@/components/Shortcuts', () => ({ ShortcutSheet: () => null }));
vi.mock('@/components/Toast', () => ({ Toasts: () => null }));
vi.mock('@/components/WindowControls', () => ({ WindowControls: () => null }));
vi.mock('@/components/CommandPalette', () => ({ CommandPalette: () => null }));
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
import { useShell } from '@/store';
import { FakeDocument } from './web-fake-dom.js';

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

beforeAll(async () => {
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  for (const name of ['ResizeObserver', 'MutationObserver'])
    vi.stubGlobal(
      name,
      class {
        observe() {}
        disconnect() {}
      },
    );
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  useBoard.setState({
    start() {},
    stop() {},
    board: {
      projects: [
        { id: 'alpha', name: 'alpha', roots: [] },
        { id: 'beta', name: 'beta', roots: [] },
        { id: 'home', name: 'Personal', roots: [], kind: 'personal' },
      ],
    } as never,
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

it('counts in the title bar only what waits in the visible projects, the same list on every render', async () => {
  const first = seen.titleBar.at(-1)!.needs;
  expect(first.map((item) => item.project_id)).toEqual(['alpha', 'beta']);
  await act(() => useShell.getState().setScreen('projects'));
  expect(seen.titleBar.length).toBeGreaterThan(1);
  expect(seen.titleBar.at(-1)!.needs).toBe(first);
});
