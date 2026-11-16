import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, SessionTurn } from '@pantheon/domain';
import type { SessionDiff, SessionTurnDiff, WorkbenchSession } from '@pantheon/protocol';
import { named, nodes, mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector: any) => selector(mock.shell), {
    getState: () => mock.shell,
  }),
}));
vi.mock('@/data/feedback', async (actual) => ({
  ...(await actual<object>()),
  useFeedback: (selector: any) => selector({ items: {} }),
}));
vi.mock('@/data/session-panel', async (actual) => ({
  ...(await actual<object>()),
  useSessionGates: () => ({ data: null, error: null, reload: () => {} }),
  useSessionReviews: () => ({ data: [], error: null, reload: () => {} }),
  useSessionPreflight: () => ({ data: null, error: null, reload: () => {} }),
  useSessionGatesHistory: () => ({ data: null, error: null, reload: () => {} }),
}));
vi.mock('@/data/facts-read', async (actual) => ({
  ...(await actual<object>()),
  useFactsRead: () => ({
    read: null,
    error: null,
    loading: false,
    unavailable: false,
    reload() {},
  }),
}));
import { useTurnDiff } from '@/data/workbench-sessions';
import { SessionInspector, useTurnScope } from '@/screens/sessions/SessionsScreen';
import { zh } from './i18n-setup.js';

const listed = (id: string, state: WorkbenchSession['state'] = 'ready'): WorkbenchSession => ({
  id,
  created_at: '2026-11-03T00:00:00.000Z',
  title: 'Release notes',
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: `workspace-${id}`,
  workspace_kind: 'linked_worktree',
  state,
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-11-03T00:00:00.000Z',
  changes: null,
  merge: null,
});
const session = (id: string): Session =>
  ({
    id,
    revision: 2,
    project_id: 'project-a',
    runtime: 'claude',
    state: 'open',
    turn_count: 4,
    workspace_id: `workspace-${id}`,
  }) as Session;
const turn = (id: string, extra: Partial<SessionTurn> = {}): SessionTurn =>
  ({
    id,
    project_id: 'project-a',
    session_id: 'session-a',
    revision: 1,
    created_at: 1,
    updated_at: 1,
    input: `Input of ${id}`,
    kind: 'send',
    delivery: 'delivered',
    state: 'completed',
    ...extra,
  }) as SessionTurn;

const branchDiff: SessionDiff = {
  session_id: 'session-a',
  base_sha: 'base',
  head_sha: 'head',
  files: [{ path: 'branch.txt', additions: 1, deletions: 0, untracked: false }],
  patch: null,
  truncated: true,
};
const turnDiff = (turnId: string): SessionTurnDiff => ({
  session_id: 'session-a',
  turn_id: turnId,
  files: [{ path: `${turnId}.txt`, additions: 1, deletions: 0, untracked: false }],
  patch: null,
  truncated: true,
});

describe('changes of one turn', () => {
  let queries: { method: string; params: Record<string, string> }[];
  const inspector = (props: {
    sessionId: string;
    state?: WorkbenchSession['state'];
    view?: 'review' | 'story';
  }) =>
    SessionInspector({
      sessionId: props.sessionId,
      listed: listed(props.sessionId, props.state),
      session: session(props.sessionId),
      panels: ['changes'],
      ...(props.view ? { view: props.view } : {}),
      onOpen: () => {},
      onClose: () => {},
      onView: () => {},
    });
  const scope = (tree: unknown) => nodes(tree as any).find((n) => Array.isArray(n.props.items));

  beforeEach(() => {
    queries = [];
    useTurnScope.setState({ scopes: {} });
    mock.board = {
      board: {
        cursor: 1,
        sessions: [],
        session_turns: [
          turn('turn-1'),
          turn('turn-steer', { kind: 'steer' }),
          turn('turn-2', { rolled_back: true }),
          turn('turn-3', { state: 'failed' }),
          turn('turn-4', { state: 'running' }),
          turn('turn-other', { session_id: 'session-b' }),
        ],
        projects: [],
        workspaces: [],
      },
      events: [],
      status: { state: 'live' },
      resync: 0,
      refresh() {},
    };
    mock.shell = {};
    vi.stubGlobal('window', {
      pantheon: {
        command: vi.fn(async () => ({ ok: true, value: {} })),
        query: vi.fn(async (method: string, params: Record<string, string>) => {
          queries.push({ method, params });
          if (method === 'session.diff') return { ok: true, value: branchDiff };
          if (method === 'session.turn_diff') return { ok: true, value: turnDiff(params.turn_id!) };
          return { ok: false, error: { code: 'not_found', message: method } };
        }),
      },
      addEventListener() {},
      removeEventListener() {},
      innerWidth: 1440,
    });
  });
  afterEach(() => {
    unmountAll();
    vi.unstubAllGlobals();
  });

  it('reads the turn diff only once both the session and the turn are known', async () => {
    let ids: [string | null, string | null] = ['session-a', null];
    const h = mount(() => useTurnDiff(...ids));
    ids = [null, 'turn-1'];
    h.render();
    await h.flush();
    expect(queries.filter((q) => q.method === 'session.turn_diff')).toEqual([]);
    ids = ['session-a', 'turn-1'];
    h.render();
    await h.flush();
    expect(queries).toEqual([
      { method: 'session.turn_diff', params: { session_id: 'session-a', turn_id: 'turn-1' } },
    ]);
    expect(h.value.data).toEqual(turnDiff('turn-1'));
  });

  it('offers the whole branch and each ended sent turn that was not rolled back, numbered among sent turns', () => {
    const h = mount(() => inspector({ sessionId: 'session-a' }));
    const root = scope(h.value)!;
    expect(root.props.value).toBe('');
    expect(root.props.items).toEqual([
      { value: '', label: zh('sessions.screen.scopeBranch') },
      { value: 'turn-1', label: '第 1 回合' },
      { value: 'turn-3', label: '第 3 回合' },
    ]);
  });

  it('offers no scope for a compaction, which has no checkpoint, and leaves it out of the numbers', () => {
    mock.board.board.session_turns = [
      turn('turn-1'),
      turn('turn-compact', { origin: 'compaction' }),
      turn('turn-2'),
    ];
    const h = mount(() => inspector({ sessionId: 'session-a' }));
    expect(scope(h.value)!.props.items).toEqual([
      { value: '', label: zh('sessions.screen.scopeBranch') },
      { value: 'turn-1', label: '第 1 回合' },
      { value: 'turn-2', label: '第 2 回合' },
    ]);
  });

  it('shows the picked turn in the same file list and goes back to the branch on another session', async () => {
    let sessionId = 'session-a';
    const h = mount(() => inspector({ sessionId }));
    await h.flush();
    expect(named(h.value, 'DiffFiles').props.diff.data).toEqual(branchDiff);
    scope(h.value)!.props.onValueChange('turn-3');
    h.render();
    await h.flush();
    expect(scope(h.value)!.props.value).toBe('turn-3');
    expect(named(h.value, 'DiffFiles').props.diff.data).toEqual(turnDiff('turn-3'));
    sessionId = 'session-b';
    h.render();
    await h.flush();
    expect(scope(h.value)!.props.value).toBe('');
  });

  it('opens on the turn the turn menu asked for and clears the request', () => {
    useTurnScope.getState().set('session-a', 'turn-1');
    const h = mount(() => inspector({ sessionId: 'session-a' }));
    expect(scope(h.value)!.props.value).toBe('turn-1');
    expect(useTurnScope.getState().scopes).toEqual({});
  });

  it('counts and scopes the whole branch in the views that read the whole branch', async () => {
    for (const view of ['review', 'story'] as const) {
      queries = [];
      useTurnScope.getState().set('session-a', 'turn-3');
      const h = mount(() => inspector({ sessionId: 'session-a', view }));
      await h.flush();
      expect(scope(h.value)).toBeUndefined();
      expect(queries.filter((q) => q.method === 'session.turn_diff')).toEqual([]);
    }
  });

  it('offers no scope once the session is merged or discarded', () => {
    for (const state of ['merged', 'discarded'] as const) {
      const h = mount(() => inspector({ sessionId: 'session-a', state }));
      expect(scope(h.value)).toBeUndefined();
    }
  });
});
