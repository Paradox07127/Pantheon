import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { Session } from '@pantheon/domain';
import type { ChangeRow, WorkbenchSession } from '@pantheon/protocol';

const mock = vi.hoisted(() => ({
  board: {} as any,
  changes: [] as unknown[],
  asked: 0,
  loading: false,
  error: null as string | null,
  stale: false,
  places: {} as Record<string, unknown>,
}));
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
    const changes = method === 'project.changes';
    return {
      read: changes && !mock.loading ? { changes: mock.changes } : null,
      error: changes ? mock.error : null,
      unavailable: false,
      loading: changes && mock.loading,
      stale: changes && mock.stale,
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

// The docked app stands in as one marker.
vi.mock('@/screens/sessions/AppPanels', async (actual) => {
  const { createElement } = await import('react');
  return {
    ...(await actual<object>()),
    AppDock: () => createElement('div', { 'data-app-dock': '' }),
  };
});

import { act, createElement } from 'react';
import { SessionsScreen } from '@/screens/sessions/SessionsScreen';
import { useShell } from '@/store';
import { appDisplay } from '@/screens/sessions/app-display';
import { FakeDocument, FakeElement, type FakeNode } from './web-fake-dom.js';
import { zh, zhf } from './i18n-setup.js';

class WideElement extends FakeElement {
  clientWidth = 1440;
  focus() {
    doc.activeElement = this as never;
  }
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
  gate: { state: 'passed', passed: 2, failed: 0, running: 0 },
});
const signature = listedOf('kid-b', 'Webhook signature', {
  spawned_by: { session_id: 'lead' },
  state: 'waiting',
  waiting: 1,
  branch: 'pt/webhook-signature',
  ahead: 5,
  gate: { state: 'failed', passed: 1, failed: 1, running: 0 },
});
// Spawned by another main agent, so not in the lead's map.
const elsewhere = listedOf('kid-c', 'Other lead work', {
  spawned_by: { session_id: 'solo-x' },
  branch: 'pt/elsewhere',
});
const ledger = listedOf('ledger', 'Ledger cleanup', { conductor: true });
const archived = listedOf('kid-d', 'Archived spike', {
  spawned_by: { session_id: 'ledger' },
  archived_at: '2026-11-03T01:00:00.000Z',
});
const starting = listedOf('kid-e', 'Starting probe', {
  spawned_by: { session_id: 'ledger' },
  state: 'starting',
});
const quiet = listedOf('kid-f', 'Quiet runtime', { spawned_by: { session_id: 'ledger' } });
const fresh = listedOf('kid-g', 'Fresh review', {
  spawned_by: { session_id: 'ledger' },
  gate: { state: 'passed', passed: 2, failed: 0, running: 0 },
});
const listed = [
  lead,
  solo,
  plain,
  idempotency,
  signature,
  elsewhere,
  ledger,
  archived,
  starting,
  quiet,
  fresh,
];

const change = (id: string, extra: Partial<ChangeRow>): ChangeRow => ({
  id: `session:${id}`,
  kind: 'session',
  title: id,
  status: 'running',
  gate: { state: 'none' },
  updated_at: '2026-11-03T00:00:00.000Z',
  ...extra,
});

// The main area is the window's width; a new width mounts the screen again to measure it.
async function show(sessionId: string, width = 1440) {
  win.innerWidth = width;
  await act(() => {
    useShell.setState({ sessionId });
    root.render(
      createElement(SessionsScreen, {
        key: width,
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
      key.startsWith('pantheon.inspector.')
        ? JSON.stringify(
            mock.places[key.slice('pantheon.inspector.'.length)] ?? { overview: false },
          )
        : null,
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
        sessionOf('ledger', { conductor: true }),
        sessionOf('kid-d', {
          usage: { input_tokens: 90_000, output_tokens: 0 } as Session['usage'],
        }),
        sessionOf('kid-e'),
        sessionOf('kid-f', {
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            tokens_unreported: true,
          } as Session['usage'],
        }),
        sessionOf('kid-g', {
          usage: { input_tokens: 38_000, output_tokens: 2_000 } as Session['usage'],
        }),
      ],
      session_turns: [],
      workspaces: [],
    },
    events: [],
    status: { state: 'offline' },
    resync: 0,
    changed: 0,
    reads: {},
  };
  mock.changes = [
    change('kid-a', {}),
    change('kid-b', {
      review: {
        id: 'review-b',
        state: 'completed',
        verdicts: [{ runtime: 'codex', verdict: 'fail' }],
        blocking_open: 1,
      },
    }),
    change('kid-g', {
      review: { id: 'review-g', state: 'completed', verdicts: [], blocking_open: 0 },
    }),
  ];
  const { createRoot } = await import('react-dom/client');
  root = createRoot(container as never);
});

beforeEach(() => {
  mock.asked = 0;
  mock.loading = false;
  mock.error = null;
  mock.stale = false;
  mock.places = {};
  doc.activeElement = null;
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

const labelled = (label: string) =>
  all(container, (n) => n instanceof FakeElement && n.getAttribute('aria-label') === label);
const rowOf = (title: string) => buttons(runMap()!).find((b) => b.textContent.includes(title))!;

it('keeps the panel the user opened beside the run map in a 1280 px window', async () => {
  mock.places = { lead: { overview: false, panels: ['plan'] } };
  // A 1280 px window leaves the session screen 1024 px beside the sidebar.
  await show('lead', 1024);
  expect(labelled(zh('sessions.panel.dock.plan'))).toHaveLength(1);
  expect(runMap()).toBeDefined();
});

it('hides the run map, not the opened panel, when both leave the conversation too narrow', async () => {
  mock.places = { lead: { overview: false, panels: ['plan'] } };
  await show('lead', 900);
  expect(labelled(zh('sessions.panel.dock.plan'))).toHaveLength(1);
  expect(runMap()).toBeUndefined();
});

it('hides the run map beside the overview when both leave the conversation too narrow', async () => {
  mock.places = { lead: {} };
  await show('lead', 900);
  expect(labelled(zh('sessions.overview.title'))).toHaveLength(1);
  expect(runMap()).toBeUndefined();
});

it('shows no passed review for a review without verdicts, and passed once all pass', async () => {
  await show('ledger');
  expect(rowOf('Fresh review').textContent).toContain(zh('sessions.runMap.gatePassed'));
  expect(rowOf('Fresh review').textContent).not.toContain(zh('sessions.runMap.reviewPassed'));
  const before = mock.changes;
  mock.changes = [
    change('kid-g', {
      review: {
        id: 'review-g',
        state: 'completed',
        verdicts: [{ runtime: 'codex', verdict: 'pass' }],
        blocking_open: 0,
      },
    }),
  ];
  await show('ledger');
  mock.changes = before;
  expect(rowOf('Fresh review').textContent).toContain(zh('sessions.runMap.reviewPassed'));
});

it('shows a review a reviewer left without a full result as incomplete, not passed', async () => {
  const before = mock.changes;
  mock.changes = [
    change('kid-g', {
      review: {
        id: 'review-g',
        state: 'completed',
        incomplete: true,
        verdicts: [{ runtime: 'codex', verdict: 'pass' }],
        blocking_open: 0,
      },
    }),
  ];
  await show('ledger');
  mock.changes = before;
  expect(rowOf('Fresh review').textContent).toContain(zh('sessions.runMap.reviewIncomplete'));
  expect(rowOf('Fresh review').textContent).not.toContain(zh('sessions.runMap.reviewPassed'));
});

it('shows a gate that is running as running', async () => {
  const before = fresh.gate;
  fresh.gate = { state: 'running', passed: 0, failed: 0, running: 1 };
  await show('ledger');
  fresh.gate = before;
  expect(rowOf('Fresh review').textContent).toContain(zh('sessions.runMap.gateRunning'));
});

it("shows the session's own gate, cancelled included, when the changes list has no row for it", async () => {
  const before = { gate: quiet.gate, changes: mock.changes };
  quiet.gate = { state: 'running', passed: 0, failed: 0, running: 1 };
  fresh.gate = { state: 'cancelled', passed: 0, failed: 0, running: 0 };
  mock.changes = [change('kid-g', { gate: { state: 'none' } })];
  await show('ledger');
  quiet.gate = before.gate;
  fresh.gate = { state: 'passed', passed: 2, failed: 0, running: 0 };
  mock.changes = before.changes;
  expect(rowOf('Quiet runtime').textContent).toContain(zh('sessions.runMap.gateRunning'));
  expect(rowOf('Fresh review').textContent).toContain(zh('sessions.runMap.gateCancelled'));
});

it('shows a gate not run for a session with changes and no gate of its own', async () => {
  const before = fresh.gate;
  delete fresh.gate;
  await show('ledger');
  fresh.gate = before;
  expect(rowOf('Fresh review').textContent).toContain(zh('sessions.runMap.gateNone'));
  expect(rowOf('Quiet runtime').textContent).not.toContain(zh('sessions.runMap.gateNone'));
});

it('shows a review from a stale changes read as possibly out of date, not in its failed tone', async () => {
  mock.stale = true;
  await show('lead');
  const status = zhf('sessions.runMap.reviewBlocking', { count: 1 });
  const chips = labelled(zhf('sessions.runMap.maybeStale', { status }));
  expect(chips).toHaveLength(1);
  expect(chips[0]!.getAttribute('data-tone')).not.toBe('bad');
});

it('shows no token count for a runtime that reports none and marks the total as partial', async () => {
  await show('ledger');
  expect(rowOf('Quiet runtime').textContent).not.toMatch(/\d/);
  expect(runMap()!.textContent).toContain(zhf('sessions.runMap.tokensPartial', { tokens: '40k' }));
});

const boardSession = (id: string) =>
  (mock.board.board.sessions as Session[]).find((s) => s.id === id)!;

it('shows no token count for a session with turns and no usage, and marks the total as partial', async () => {
  const quietRuntime = boardSession('kid-f');
  const before = quietRuntime.usage;
  quietRuntime.usage = { input_tokens: 0, output_tokens: 0 } as Session['usage'];
  await show('ledger');
  quietRuntime.usage = before;
  expect(rowOf('Starting probe').textContent).not.toMatch(/\d/);
  expect(runMap()!.textContent).toContain(zhf('sessions.runMap.tokensPartial', { tokens: '40k' }));
});

it('shows a gate that is being cancelled as still running', async () => {
  const before = fresh.gate;
  fresh.gate = { state: 'cancelling', passed: 0, failed: 0, running: 1 };
  await show('ledger');
  fresh.gate = before;
  expect(rowOf('Fresh review').textContent).toContain(zh('sessions.runMap.gateRunning'));
});

it('counts a spawned session the board has not listed yet as unreported, not as zero', async () => {
  const sessions = mock.board.board.sessions as Session[];
  const before = [...sessions];
  sessions.splice(
    sessions.findIndex((s) => s.id === 'kid-b'),
    1,
  );
  await show('lead');
  sessions.splice(0, sessions.length, ...before);
  expect(rowOf('Webhook signature').textContent).not.toMatch(/\d$/);
});

it('rounds a partial token total down, and a row count to the nearest', async () => {
  const freshReview = boardSession('kid-g');
  const before = freshReview.usage;
  freshReview.usage = { input_tokens: 1_000, output_tokens: 600 } as Session['usage'];
  await show('ledger');
  freshReview.usage = before;
  expect(runMap()!.textContent).toContain(zhf('sessions.runMap.tokensPartial', { tokens: '1k' }));
  expect(rowOf('Fresh review').textContent).toContain('2k');
});

it('leaves archived spawned sessions out of the rows and the counts', async () => {
  await show('ledger');
  const map = runMap()!;
  expect(buttons(map).map((row) => row.textContent)).not.toContainEqual(
    expect.stringContaining('Archived spike'),
  );
  expect(map.textContent).toContain(zhf('sessions.runMap.sessions', { count: 3 }));
});

it('counts a starting session as running', async () => {
  await show('ledger');
  expect(runMap()!.textContent).toContain(`${zh('sessions.runMap.running')}1`);
});

it('keeps the gate chips in place under aria-busy while the changes load', async () => {
  mock.loading = true;
  await show('lead');
  const list = all(runMap()!, (n) => n.nodeName === 'UL')[0]!;
  expect(String(list.getAttribute('aria-busy'))).toBe('true');
  expect(buttons(list)).toHaveLength(2);
  expect(list.textContent).not.toContain(zhf('sessions.runMap.reviewBlocking', { count: 1 }));
  expect(rowOf('Idempotent refunds').textContent).toContain(zh('sessions.runMap.gatePassed'));
  expect(rowOf('Webhook signature').textContent).toContain(zh('sessions.runMap.gateFailed'));
});

it('shows a failed changes read in the run map', async () => {
  mock.error = 'changes read failed';
  await show('lead');
  const alert = all(
    runMap()!,
    (n) => n instanceof FakeElement && n.getAttribute('role') === 'alert',
  );
  expect(alert.map((a) => a.textContent)).toEqual([expect.stringContaining('changes read failed')]);
});

it('moves focus to the opened session once a row opens it', async () => {
  await show('lead');
  const row = rowOf('Webhook signature');
  const key = Object.keys(row).find((k) => k.startsWith('__reactProps'))!;
  await act(() => (row as any)[key].onClick());
  expect((doc.activeElement as FakeElement | null)?.getAttribute('aria-label')).toBe(
    'Webhook signature',
  );
});

const dockApp = () =>
  appDisplay.setState({
    places: { plain: { call: 'call-a', mode: 'pip' } },
    calls: {
      plain: [{ item: { id: 'call-a', kind: 'tool', app: {} } as any, state: 'done' as any }],
    },
  });
const undock = () => act(() => appDisplay.setState({ places: {}, calls: {} }));

it('leaves the overview out beside the app dock when the conversation would get too narrow', async () => {
  mock.places = { plain: {} };
  dockApp();
  await show('plain', 1000);
  expect(
    all(container, (n) => n instanceof FakeElement && n.hasAttribute('data-app-dock')),
  ).toHaveLength(1);
  expect(labelled(zh('sessions.overview.title'))).toHaveLength(0);
  expect(
    all(container, (n) => n instanceof FakeElement && n.hasAttribute('data-thread')),
  ).toHaveLength(1);
  await undock();
});

it('shows the overview beside the app dock when the main area has room for both', async () => {
  mock.places = { plain: {} };
  dockApp();
  await show('plain', 1100);
  expect(
    all(container, (n) => n instanceof FakeElement && n.hasAttribute('data-app-dock')),
  ).toHaveLength(1);
  expect(labelled(zh('sessions.overview.title'))).toHaveLength(1);
  await undock();
});
