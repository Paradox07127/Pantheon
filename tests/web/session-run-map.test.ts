import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { Session } from '@pantheon/domain';
import type { ChangeRow, WorkbenchSession } from '@pantheon/protocol';

const mock = vi.hoisted(() => ({ board: {} as any, changes: [] as unknown[], asked: 0 }));
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
vi.mock('@/data/project-read', async (actual) => ({
  ...(await actual<object>()),
  useProjectQuery: (method: string) => {
    if (method === 'project.changes') mock.asked++;
    return {
      read: method === 'project.changes' ? { changes: mock.changes } : null,
      error: null,
      unavailable: false,
      loading: false,
      stale: false,
      reload() {},
    };
  },
}));
// The thread and its composer stand in as one marker.
vi.mock('@/screens/sessions/Thread', async (actual) => {
  const { createElement } = await import('react');
  return {
    ...(await actual<object>()),
    Thread: () => createElement('div', { 'data-thread': '' }),
  };
});

import { act, createElement } from 'react';
import { SessionsScreen } from '@/screens/sessions/SessionsScreen';
import { useShell } from '@/store';
import { FakeDocument, FakeElement, type FakeNode } from './web-fake-dom.js';
import { zh, zhf } from './i18n-setup.js';

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

function all(node: FakeNode, test: (n: FakeNode) => boolean): FakeElement[] {
  return [
    ...(test(node) ? [node as FakeElement] : []),
    ...node.childNodes.flatMap((c) => all(c, test)),
  ];
}
const runMap = () =>
  all(
    container,
    (n) =>
      n instanceof FakeElement &&
      n.nodeName === 'SECTION' &&
      n.getAttribute('aria-label') === zh('sessions.runMap.title'),
  )[0];
const buttons = (node: FakeNode) => all(node, (n) => n.nodeName === 'BUTTON');

const listedOf = (id: string, title: string, extra: Partial<WorkbenchSession> = {}) =>
  ({
    id,
    created_at: '2026-11-03T00:00:00.000Z',
    title,
    runtime: 'claude',
    model: 'claude-opus-4',
    effort: null,
    permission_mode: 'ask',
    workspace_id: `workspace-${id}`,
    workspace_kind: 'linked_worktree',
    state: 'idle',
    waiting: 0,
    reconciling: false,
    stopping: false,
    last_activity_at: '2026-11-03T00:00:00.000Z',
    changes: null,
    merge: null,
    ...extra,
  }) as WorkbenchSession;
const sessionOf = (id: string, extra: Partial<Session> = {}): Session => ({
  id,
  revision: 1,
  project_id: 'project-a',
  runtime: 'claude',
  state: 'open',
  turn_count: 1,
  workspace_id: `workspace-${id}`,
  ...extra,
});

const lead = listedOf('lead', 'Refund rework', { conductor: true, state: 'running' });
const solo = listedOf('solo', 'Lone lead', { conductor: true });
const plain = listedOf('plain', 'Plain work', { branch: 'pt/plain' });
const idempotency = listedOf('kid-a', 'Idempotent refunds', {
  spawned_by: { session_id: 'lead' },
  state: 'running',
  branch: 'pt/refund-idempotency',
  ahead: 3,
});
const signature = listedOf('kid-b', 'Webhook signature', {
  spawned_by: { session_id: 'lead' },
  state: 'waiting',
  waiting: 1,
  branch: 'pt/webhook-signature',
  ahead: 5,
});
// Spawned by another main agent, so not in the lead's map.
const elsewhere = listedOf('kid-c', 'Other lead work', {
  spawned_by: { session_id: 'solo-x' },
  branch: 'pt/elsewhere',
});
const listed = [lead, solo, plain, idempotency, signature, elsewhere];

const change = (id: string, extra: Partial<ChangeRow>): ChangeRow => ({
  id: `session:${id}`,
  kind: 'session',
  title: id,
  status: 'running',
  gate: { state: 'none' },
  updated_at: '2026-11-03T00:00:00.000Z',
  ...extra,
});

async function show(sessionId: string) {
  await act(() => {
    useShell.setState({ sessionId });
    root.render(
      createElement(SessionsScreen, {
        projectId: 'project-a',
        needs: { items: [], loading: false, error: null, reload() {} } as any,
        list: { data: listed, loading: false, error: null, reload() {} } as any,
      }),
    );
  });
}

beforeAll(async () => {
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) =>
      key.startsWith('pantheon.inspector.') ? JSON.stringify({ overview: false }) : null,
    setItem() {},
    removeItem() {},
  });
  mock.board = {
    board: {
      projects: [{ id: 'project-a', name: 'a', roots: [] }],
      sessions: [
        sessionOf('lead', { conductor: true }),
        sessionOf('solo', { conductor: true }),
        sessionOf('plain'),
        sessionOf('kid-a', {
          turn_count: 4,
          usage: { input_tokens: 300_000, output_tokens: 12_000 } as Session['usage'],
        }),
        sessionOf('kid-b', {
          turn_count: 2,
          usage: { input_tokens: 200_000, output_tokens: 8_000 } as Session['usage'],
        }),
        sessionOf('kid-c', { turn_count: 9 }),
      ],
      session_turns: [],
      workspaces: [],
    },
    events: [],
  };
  mock.changes = [
    change('kid-a', { gate: { state: 'passed' } }),
    change('kid-b', {
      gate: { state: 'failed', failed: ['unit'] },
      review: {
        id: 'review-b',
        state: 'completed',
        verdicts: [{ runtime: 'codex', verdict: 'fail' }],
        blocking_open: 1,
      },
    }),
  ];
  const { createRoot } = await import('react-dom/client');
  root = createRoot(container as never);
});

beforeEach(() => {
  mock.asked = 0;
});

afterAll(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('lists the sessions a main agent spawned with their branch, gate, review and the counts', async () => {
  await show('lead');
  const map = runMap()!;
  expect(map).toBeDefined();
  const rows = buttons(map);
  expect(rows.map((row) => row.textContent)).toEqual([
    expect.stringContaining('Idempotent refunds'),
    expect.stringContaining('Webhook signature'),
  ]);
  const [first, second] = rows.map((row) => row.textContent);
  expect(first).toContain('pt/refund-idempotency');
  expect(first).toContain(zhf('sessions.runMap.ahead', { count: 3 }));
  expect(first).toContain(zh('sessions.runMap.gatePassed'));
  expect(first).toContain('312k');
  expect(second).toContain('pt/webhook-signature');
  expect(second).toContain(zh('sessions.runMap.gateFailed'));
  expect(second).toContain(zhf('sessions.runMap.reviewBlocking', { count: 1 }));
  const head = map.textContent;
  expect(head).toContain(zhf('sessions.runMap.sessions', { count: 2 }));
  expect(head).toContain(`${zh('sessions.runMap.running')}1`);
  expect(head).toContain(`${zh('sessions.runMap.waiting')}1`);
  expect(head).toContain('520k');
  expect(head).toContain(zhf('sessions.runMap.turns', { count: 6 }));
  expect(head).not.toContain('Other lead work');
});

it('opens the spawned session a row is clicked on', async () => {
  await show('lead');
  const row = buttons(runMap()!).find((b) => b.textContent.includes('Webhook signature'))!;
  const key = Object.keys(row).find((k) => k.startsWith('__reactProps'))!;
  await act(() => (row as any)[key].onClick());
  expect(useShell.getState().sessionId).toBe('kid-b');
});

it('shows no run map and reads no changes for a session that is not a main agent', async () => {
  await show('plain');
  expect(
    all(container, (n) => n instanceof FakeElement && n.hasAttribute('data-thread')),
  ).toHaveLength(1);
  expect(runMap()).toBeUndefined();
  expect(mock.asked).toBe(0);
});

it('shows no run map for a main agent that spawned nothing', async () => {
  await show('solo');
  expect(
    all(container, (n) => n instanceof FakeElement && n.hasAttribute('data-thread')),
  ).toHaveLength(1);
  expect(runMap()).toBeUndefined();
  expect(mock.asked).toBe(0);
});
