import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { Session } from '@pantheon/domain';
import type { WorkbenchSession } from '@pantheon/protocol';

const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('@/data/project-defaults', async (actual) => ({
  ...(await actual<object>()),
  useProjectDefaults: () => ({ data: null, loading: false, error: null, reload() {} }),
  useLastProjectDefaults: () => null,
}));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
    subscribe: () => () => {},
  }),
}));
vi.mock('@/data/workbench-sessions', async (actual) => ({
  ...(await actual<object>()),
  useSessionDiff: () => ({ data: null, error: null, reload: () => {} }),
  useTurnDiff: () => ({ data: null, error: null, reload: () => {} }),
}));
vi.mock('@/data/session-panel', async (actual) => ({
  ...(await actual<object>()),
  useSessionGates: () => ({ data: null, error: null, reload: () => {} }),
  useSessionGatesHistory: () => ({ data: null, error: null, reload: () => {} }),
  useSessionPreflight: () => ({ data: null, error: null, reload: () => {} }),
  useSessionReviews: () => ({ data: [], error: null, reload: () => {} }),
}));
vi.mock('@/data/session-comments', async (actual) => ({
  ...(await actual<object>()),
  useSessionComments: () => ({ data: [], error: null, loading: false, reload: () => {} }),
}));
vi.mock('@/data/facts-read', async (actual) => ({
  ...(await actual<object>()),
  useFactsRead: () => ({ read: null, error: null, loading: false, reload: () => {} }),
}));
// The thread and its composer stand in as one marker.
vi.mock('@/screens/sessions/Thread', async (actual) => {
  const { createElement } = await import('react');
  return {
    ...(await actual<object>()),
    Thread: () => createElement('div', { 'data-thread': '' }, createElement('textarea')),
  };
});
vi.mock('@/screens/sessions/panel', async (actual) => ({
  ...(await actual<object>()),
  PlanTab: () => {
    throw new Error('bad plan step');
  },
}));

import { act, createElement } from 'react';
import { SessionsScreen } from '@/screens/sessions/SessionsScreen';
import { useShell } from '@/store';
import { FakeDocument, FakeElement, type FakeNode } from './web-fake-dom.js';
import { zh } from './i18n-setup.js';

class WideElement extends FakeElement {
  clientWidth = 1440;
}

const doc = new FakeDocument(WideElement);
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

function find(node: FakeNode, test: (n: FakeNode) => boolean): FakeElement | undefined {
  if (test(node)) return node as FakeElement;
  for (const c of node.childNodes) {
    const hit = find(c, test);
    if (hit) return hit;
  }
}
const column = (label: string) =>
  find(
    container,
    (n) =>
      n instanceof FakeElement &&
      n.nodeName === 'SECTION' &&
      n.getAttribute('aria-label') === label,
  );

const listed: WorkbenchSession = {
  id: 'a',
  created_at: '2026-11-03T00:00:00.000Z',
  title: 'Release notes',
  runtime: 'claude',
  model: 'claude-opus-4',
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-a',
  workspace_kind: 'linked_worktree',
  state: 'ready',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-11-03T00:00:00.000Z',
  changes: { files: 1, additions: 2, deletions: 1 },
  merge: null,
};
const session: Session = {
  id: 'a',
  revision: 2,
  project_id: 'project-a',
  runtime: 'claude',
  state: 'open',
  turn_count: 1,
  workspace_id: 'workspace-a',
};

beforeAll(async () => {
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) =>
      key === 'pantheon.inspector.a' ? JSON.stringify({ panels: ['checks', 'plan'] }) : null,
    setItem() {},
    removeItem() {},
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mock.board = {
    board: {
      projects: [{ id: 'project-a', name: 'a', roots: [] }],
      sessions: [session],
      session_turns: [],
      workspaces: [],
    },
  };
  useShell.setState({ sessionId: 'a' });
  const { createRoot } = await import('react-dom/client');
  root = createRoot(container as never);
  await act(() =>
    root.render(
      createElement(SessionsScreen, {
        projectId: 'project-a',
        needs: { items: [], loading: false, error: null, reload() {} } as any,
        list: { data: [listed], loading: false, error: null, reload() {} } as any,
      }),
    ),
  );
});

afterAll(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('keeps the thread, its composer and the other panels when one panel throws', () => {
  expect(
    find(container, (n) => n instanceof FakeElement && n.hasAttribute('data-thread')),
  ).toBeDefined();
  expect(find(container, (n) => n.nodeName === 'TEXTAREA')).toBeDefined();
  expect(column(zh('sessions.screen.tabChecks'))).toBeDefined();
  const plan = column(zh('sessions.panel.dock.plan'))!;
  const alert = find(plan, (n) => n instanceof FakeElement && n.getAttribute('role') === 'alert');
  expect(alert?.textContent).toContain('bad plan step');
  expect(alert?.textContent).toContain(zh('board.query.retry'));
});
