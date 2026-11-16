import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { WorkbenchSession } from '@pantheon/protocol';
import { HookHost, named, nodes, mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  board: {} as any,
  shell: {} as any,
  history: [] as any[],
  listed: null as any,
  needs: null as any,
}));
vi.mock('@/data/project-defaults', async (actual) => ({
  ...(await actual<object>()),
  useProjectDefaults: () => ({ data: null, loading: false, error: null, reload() {} }),
  useLastProjectDefaults: () => null,
}));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
    subscribe: () => () => {},
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector?: any) => (selector ? selector(mock.shell) : mock.shell), {
    getState: () => mock.shell,
  }),
}));
vi.mock('@/data/feedback', async (actual) => ({
  ...(await actual<object>()),
  useFeedback: (selector: any) => selector({ items: {} }),
}));
// The real hook filters its held events into a new array on every render.
vi.mock('@/data/logs', async (actual) => ({
  ...(await actual<object>()),
  useEventHistory: () => ({ events: mock.history.slice(), error: null, reload() {} }),
}));
vi.mock('@/data/transcript', async (actual) => {
  const real = await actual<typeof import('@/data/transcript')>();
  return { ...real, buildTranscript: vi.fn(real.buildTranscript) };
});
import { buildTranscript } from '@/data/transcript';
import { SessionsScreen, ThreadTurn } from '@/screens/sessions/SessionsScreen';

const listed: WorkbenchSession = {
  id: 'session-a',
  created_at: '2026-11-03T08:00:00.000Z',
  title: 'title of session-a',
  runtime: 'fixture',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-a',
  workspace_kind: 'linked_worktree',
  state: 'running',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-11-03T08:00:00.000Z',
  changes: null,
  merge: null,
};
const turn = (id: string) => ({
  id,
  revision: 1,
  project_id: 'project-a',
  session_id: 'session-a',
  input: `input of ${id}`,
  kind: 'send',
  delivery: 'delivered',
  state: 'running',
});
const delta = (sequence: number, turnId: string, text: string) => ({
  sequence,
  event_id: `event-${sequence}`,
  kind: 'agent.message.delta',
  aggregate_id: 'session-a',
  aggregate_revision: sequence,
  project_id: 'project-a',
  causation_id: 'cause',
  created_at: 1_000 + sequence,
  payload: { turn_id: turnId, text },
});

const needs = { items: [], loading: false, error: null, reload() {} };
const list = { data: [listed], loading: false, error: null, reload() {} };
function thread() {
  const screen = mount(() => SessionsScreen({ projectId: 'project-a', needs, list }));
  const node: any = named(screen.value, 'Thread');
  return mount(() =>
    node.type({ ...node.props, board: mock.board.board, listed: mock.listed, needs: mock.needs }),
  );
}
const rows = (h: HookHost<any>) => nodes(h.value).filter((n) => n.props.view?.turn);
/** The turns whose row renders again from `before` to `after`, as the row's memo decides. */
const redrawn = (before: ReactElement<any>[], after: ReactElement<any>[]) =>
  after
    .filter((row, i) => !(row.type as any).compare(before[i]!.props, row.props))
    .map((row) => row.props.view.turn.id);
const snapshot = (change: (board: any) => object) => {
  mock.board = { ...mock.board, board: { ...mock.board.board, ...change(mock.board.board) } };
};
const builds = () => vi.mocked(buildTranscript).mock.calls.length;

beforeEach(() => {
  mock.board = {
    board: {
      sessions: [
        {
          id: 'session-a',
          revision: 1,
          project_id: 'project-a',
          runtime: 'fixture',
          state: 'open',
          turn_count: 2,
          workspace_id: 'workspace-a',
        },
      ],
      session_turns: [turn('turn-1'), turn('turn-2')],
      projects: [{ id: 'project-a', roots: ['/repo'] }],
      workspaces: [{ id: 'workspace-a', path: '/repo/.worktrees/a' }],
    },
    events: [],
    status: { state: 'live' },
    cursor: 0,
    resync: 0,
  };
  mock.shell = {
    sessionId: 'session-a',
    sessionGroup: null,
    sessionTab: null,
    sessionOpened: 1,
    openSettings() {},
    openSession() {},
    followFirstSession() {},
    follow() {},
  };
  mock.history = [delta(1, 'turn-1', 'First answer.'), delta(2, 'turn-2', 'Second')];
  mock.listed = listed;
  mock.needs = needs;
  vi.stubGlobal('window', {
    innerWidth: 1400,
    pantheon: { query: vi.fn(async () => ({ ok: true, value: [] })) },
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('session thread renders', () => {
  it('builds the transcript once while no event arrives', () => {
    const h = thread();
    const before = builds();
    const first = rows(h);
    h.render();
    expect(builds()).toBe(before);
    const second = rows(h);
    expect(second.map((n) => n.props.view)).toEqual(first.map((n) => n.props.view));
    second.forEach((row, i) => {
      const { status, ...rest } = row.props;
      const { status: was, ...earlier } = first[i]!.props;
      expect(status).toEqual(was);
      for (const key of Object.keys(rest)) expect(rest[key]).toBe(earlier[key]);
    });
  });

  it("leaves the running turn's status line to the composer while the session runs", () => {
    expect(rows(thread()).map((n) => n.props.statusInCompose)).toEqual([false, false]);
    snapshot((board) => ({
      sessions: board.sessions.map((s: any) => ({ ...s, state: 'running' })),
    }));
    expect(rows(thread()).map((n) => n.props.statusInCompose)).toEqual([false, true]);
  });

  it('skips turn rows whose props did not change', () => {
    const [row] = rows(thread());
    expect((row!.type as any).$$typeof).toBe(Symbol.for('react.memo'));
  });

  it('shows a streamed event and keeps the turns it did not touch', () => {
    const h = thread();
    const [first] = rows(h);
    const before = builds();
    mock.board = { ...mock.board, events: [delta(3, 'turn-2', ' answer.')] };
    h.render();
    expect(builds()).toBe(before + 1);
    const [kept, grown] = rows(h);
    expect(kept!.props.view).toBe(first!.props.view);
    expect(grown!.props.view.text).toBe('Second answer.');
  });

  it('renders no turn again for a new board snapshot that keeps the session folders', () => {
    const h = thread();
    const before = rows(h);
    snapshot(() => ({
      projects: [{ id: 'project-a', roots: ['/repo'] }],
      workspaces: [{ id: 'workspace-a', path: '/repo/.worktrees/a' }],
    }));
    h.render();
    expect(redrawn(before, rows(h))).toEqual([]);
    snapshot(() => ({ projects: [{ id: 'project-a', roots: ['/repo', '/docs'] }] }));
    h.render();
    expect(redrawn(before, rows(h))).toEqual(['turn-1', 'turn-2']);
  });

  it('renders no turn again when only the session revision moves', () => {
    const h = thread();
    const before = rows(h);
    snapshot((board) => ({
      sessions: board.sessions.map((s: any) => ({ ...s, revision: s.revision + 1 })),
    }));
    h.render();
    expect(redrawn(before, rows(h))).toEqual([]);
  });

  it('renders the turns again for a list row change they show, and only for that', () => {
    const h = thread();
    const before = rows(h);
    mock.listed = { ...listed, last_activity_at: '2026-11-03T09:00:00.000Z', waiting: 1 };
    h.render();
    expect(redrawn(before, rows(h))).toEqual([]);
    mock.listed = { ...listed, state: 'idle' };
    h.render();
    expect(redrawn(before, rows(h))).toEqual(['turn-1', 'turn-2']);
  });

  it('renders only the streamed turn again when an event arrives', () => {
    const h = thread();
    const before = rows(h);
    mock.board = { ...mock.board, events: [delta(3, 'turn-2', ' answer.')] };
    h.render();
    expect(redrawn(before, rows(h))).toEqual(['turn-2']);
  });

  it('renders only the turn that changed when a board snapshot brings new turn objects', () => {
    const h = thread();
    const before = rows(h);
    snapshot((board) => ({ session_turns: board.session_turns.map((t: any) => ({ ...t })) }));
    h.render();
    expect(redrawn(before, rows(h))).toEqual([]);
    snapshot((board) => ({
      session_turns: board.session_turns.map((t: any) =>
        t.id === 'turn-2' ? { ...t, state: 'completed' } : { ...t },
      ),
    }));
    h.render();
    expect(redrawn(before, rows(h))).toEqual(['turn-2']);
  });

  it('renders no turn again for a needs-you reread that keeps the approvals', () => {
    const h = thread();
    const before = rows(h);
    const gate = { kind: 'session.gate_failed', source: { table: 'sessions', id: 'session-b' } };
    mock.needs = { ...needs, loading: true, items: [gate] };
    h.render();
    expect(redrawn(before, rows(h))).toEqual([]);
    const approval = {
      kind: 'approval.pending',
      source: { table: 'approvals', id: 'approval-1', revision: 1 },
      actions: [],
    };
    mock.needs = { ...needs, items: [gate, approval] };
    h.render();
    expect(redrawn(before, rows(h))).toEqual(['turn-1', 'turn-2']);
  });

  it('renders only the turn that gets a new item', () => {
    const h = thread();
    const before = rows(h);
    mock.board = {
      ...mock.board,
      events: [
        {
          ...delta(3, 'turn-2', ''),
          kind: 'agent.tool.started',
          payload: { turn_id: 'turn-2', tool_call_id: 'call-1', name: 'Read', input: {} },
        },
      ],
    };
    h.render();
    const after = rows(h);
    expect(after[1]!.props.view.items).toHaveLength(2);
    expect(redrawn(before, after)).toEqual(['turn-2']);
  });

  it('follows the bottom when drawn turns change the thread height, until the user scrolls up', () => {
    let resized = () => {};
    const seen: unknown[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(run: () => void) {
          resized = run;
        }
        observe(el: unknown) {
          seen.push(el);
        }
        disconnect() {
          seen.push('disconnected');
        }
      },
    );
    const scroller = nodes(thread().value).find((n) => n.props.className === 'ss-scroll')!;
    const content = {};
    const el = { firstElementChild: content, scrollHeight: 900, scrollTop: 0, clientHeight: 400 };
    const detach = scroller.props.ref(el);
    expect(seen).toEqual([content]);
    resized();
    expect(el.scrollTop).toBe(900);
    el.scrollTop = 200;
    scroller.props.onScroll({ currentTarget: el });
    el.scrollHeight = 1200;
    resized();
    expect(el.scrollTop).toBe(200);
    detach();
    expect(seen).toEqual([content, 'disconnected']);
  });

  it('stops following the bottom on the first scroll up while the output grows, and follows again at the bottom', () => {
    let resized = () => {};
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(run: () => void) {
          resized = run;
        }
        observe() {}
        disconnect() {}
      },
    );
    const h = thread();
    const scroller = () => nodes(h.value).find((n) => n.props.className === 'ss-scroll')!;
    let top = 0;
    const el = {
      firstElementChild: {},
      scrollHeight: 900,
      clientHeight: 400,
      get scrollTop() {
        return top;
      },
      set scrollTop(to: number) {
        top = Math.max(0, Math.min(to, el.scrollHeight - el.clientHeight));
      },
    };
    scroller().props.ref(el);
    resized();
    scroller().props.onScroll({ currentTarget: el });
    expect(el.scrollTop).toBe(500);
    scroller().props.onWheel?.({ deltaY: -15, currentTarget: el });
    el.scrollTop = 485;
    scroller().props.onScroll({ currentTarget: el });
    el.scrollHeight = 1200;
    resized();
    h.render();
    expect(el.scrollTop).toBe(485);
    el.scrollTop = 800;
    scroller().props.onScroll({ currentTarget: el });
    el.scrollHeight = 1500;
    resized();
    expect(el.scrollTop).toBe(1100);
    scroller().props.onKeyDown?.({
      key: 'PageUp',
      defaultPrevented: false,
      currentTarget: el,
      target: { closest: () => null },
    });
    el.scrollHeight = 1800;
    resized();
    h.render();
    expect(el.scrollTop).toBe(1100);
  });

  it('enters the items of a running turn once: the finished turn folds them without the entrance', () => {
    const event = (sequence: number, kind: string, payload: object) => ({
      ...delta(sequence, 'turn-2', ''),
      kind,
      payload: { turn_id: 'turn-2', ...payload },
    });
    const lists = (h: HookHost<any>) => {
      const row = rows(h)[1]!;
      const turn = mount(() => ThreadTurn(row.props));
      return nodes(turn.value).filter((n) => n.props.owner === 'turn-2');
    };
    const h = thread();
    mock.board = {
      ...mock.board,
      events: [
        event(3, 'agent.tool.started', { tool_call_id: 'call-1', name: 'Read', input: {} }),
        event(4, 'agent.tool.completed', { tool_call_id: 'call-1', output: 'ok', ok: true }),
        delta(5, 'turn-2', 'Done.'),
      ],
    };
    h.render();
    const running = lists(h);
    expect(running).toHaveLength(1);
    expect([...running[0]!.props.fresh]).not.toEqual([]);
    mock.board = {
      ...mock.board,
      events: [...mock.board.events, event(6, 'agent.turn.completed', { status: 'completed' })],
    };
    snapshot((board) => ({
      session_turns: board.session_turns.map((t: any) =>
        t.id === 'turn-2' ? { ...t, state: 'completed' } : t,
      ),
    }));
    h.render();
    const folded = lists(h);
    expect(folded.length).toBeGreaterThan(1);
    expect(folded.map((n) => n.props.fresh)).toEqual(folded.map(() => undefined));
  });

  it('renders the timeline again only when the turns or the waits change', () => {
    const index = (h: HookHost<any>) => nodes(h.value).find((n) => n.props.scroller)!;
    const h = thread();
    const before = index(h);
    mock.board = { ...mock.board, events: [delta(3, 'turn-2', ' answer.')] };
    h.render();
    expect((before.type as any).compare(before.props, index(h).props)).toBe(true);
    snapshot((board) => ({ session_turns: [...board.session_turns, turn('turn-3')] }));
    h.render();
    expect((before.type as any).compare(before.props, index(h).props)).toBe(false);
  });
});
