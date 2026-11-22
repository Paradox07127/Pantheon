import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { Session } from '@pantheon/domain';
import type { WorkbenchSession } from '@pantheon/protocol';
import { type HookHost, find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
import { zh, zhf } from './i18n-setup.js';
const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any }));
vi.mock('@/data/project-defaults', async (actual) => ({
  ...(await actual<object>()),
  useProjectDefaults: () => ({ data: null, loading: false, error: null, reload() {} }),
  useLastProjectDefaults: () => null,
}));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
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
import { setAppearance } from '@/data/layout';
import { t } from '@/i18n';
import { runShortcut, SHORTCUTS } from '@/lib/shortcuts';
import { readSessionView } from '@/screens/sessions/model';
import { SessionHeader, SessionsScreen } from '@/screens/sessions/SessionsScreen';
import { useThreadFind } from '@/screens/sessions/ThreadFind';
import { showThreadTurns } from '@/screens/sessions/trace';

let commands: { type: string; input: unknown }[];
let stored: Map<string, string>;
const FORK = zh('sessions.header.fork');
const FIND = zh('sessions.thread.find');
const CHECKPOINT = zh('sessions.header.checkpoint');
const BUSY = zh('sessions.header.busy');

beforeEach(() => {
  commands = [];
  mock.board = {
    board: {
      sessions: [{ id: 'session-a', revision: 6, project_id: 'project-a' }],
      session_turns: [],
      projects: [],
      workspaces: [{ id: 'workspace-a', path: '/work/a', source: '/src/a' }],
      cursor: 1,
    },
    events: [],
    status: { state: 'live' },
    cursor: 1,
    resync: 0,
    refresh() {},
  };
  mock.shell = {
    sessionId: 'session-a',
    sessionGroup: null,
    sessionTab: null,
    sessionOpened: 1,
    followed: null,
    openSettings() {},
    openSession: vi.fn(),
    followFirstSession() {},
    follow() {},
  };
  stored = new Map();
  vi.stubGlobal('window', {
    innerWidth: 1400,
    pantheon: {
      command: vi.fn(async (command: any) => {
        commands.push(command);
        return { ok: true, value: {} };
      }),
      query: vi.fn(async () => ({ ok: true, value: null })),
    },
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh', clipboard: { writeText: vi.fn() } });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  });
  setAppearance({ inspector: 'auto', reading_width: 760 });
});
afterEach(() => {
  unmountAll();
  showThreadTurns(null);
  useThreadFind.getState().close();
  vi.unstubAllGlobals();
});

const listed = (id: string, extra: Partial<WorkbenchSession> = {}): WorkbenchSession => ({
  id,
  created_at: '2026-11-03T00:00:00.000Z',
  title: `title of ${id}`,
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-a',
  workspace_kind: 'linked_worktree',
  state: 'idle',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-11-03T00:00:00.000Z',
  changes: null,
  merge: null,
  ...extra,
});
const session = (id: string): Session => ({
  id,
  revision: 6,
  project_id: 'project-a',
  runtime: 'claude',
  state: 'open',
  turn_count: 1,
  workspace_id: 'workspace-a',
});
const turn = (id: string, extra: Record<string, unknown> = {}) => ({
  turn: { id, session_id: 'session-a', kind: 'send', state: 'completed', input: id, ...extra },
  at: 1,
  started_at: 1,
  ended_at: 2,
  text: '',
  usage: null,
  end: null,
  items: [],
});

type HeaderProps = Partial<Parameters<typeof SessionHeader>[0]>;
function header(props: HeaderProps = {}) {
  const row = props.listed ?? listed('session-a');
  return mount(() =>
    SessionHeader({
      session: session(row.id),
      listed: row,
      title: row.title,
      parent: null,
      plan: null,
      panels: [],
      onPanel: vi.fn(),
      overview: true,
      onOverview: vi.fn(),
      ...props,
    }),
  );
}
const part = (h: HookHost<any>, name: string) => {
  const element = named(h.value, name);
  return mount(() => (element.type as (props: unknown) => ReactNode)(element.props));
};
const items = (tree: unknown): ReactElement<any>[] =>
  nodes(tree as any).filter(
    (n) =>
      typeof n.type !== 'string' &&
      (typeof n.props.onClick === 'function' || n.props.disabled === true) &&
      n.props['aria-label'] === undefined,
  );
const item = (tree: unknown, label: string) => items(tree).find((n) => text(n) === label);
const menu = (row = listed('session-a')) => part(header({ listed: row }), 'MoreMenu');
const reasonOf = (h: HookHost<any>, label: string) =>
  text(find(h.value, (n) => n.props.id === item(h.value, label)!.props['aria-describedby']));

describe('session list default grouping', () => {
  it('groups by who opened or forked whom unless a grouping was stored', () => {
    expect(readSessionView(null).grouping).toBe('lead');
    expect(readSessionView('{"sort":"title"}').grouping).toBe('lead');
    expect(readSessionView('{"grouping":"state"}').grouping).toBe('state');
  });
});

describe('header shortcuts', () => {
  it('gives the overview ⌘I and the attach button ⌘U, and lists no key for plan mode', () => {
    const keys = (id: string) => SHORTCUTS.find((s) => s.id === id);
    expect(keys('overview')).toMatchObject({ keys: 'Meta+I', scope: 'app' });
    expect(keys('attach')).toMatchObject({ keys: 'Meta+U', scope: 'composer' });
    expect(keys('plan-mode')).toBeUndefined();
  });

  it('toggles the overview with ⌘I and shows its key cap on the button', () => {
    const onOverview = vi.fn();
    const h = header({ onOverview });
    runShortcut('overview');
    expect(onOverview).toHaveBeenCalledOnce();
    const button = find(h.value, (n) => n.props['aria-label'] === zh('sessions.header.overview'));
    expect(nodes(button).some((n) => n.props.id === 'overview')).toBe(true);
  });
});

describe('header clock', () => {
  it('counts the whole session while it waits on the user', () => {
    const created_at = new Date(Date.now() - 40_000).toISOString();
    const h = header({ listed: listed('session-a', { state: 'waiting', created_at }) });
    expect(text(part(h, 'RunClock').value)).toBe(zhf('data.elapsed.seconds', { seconds: 40 }));
  });

  it('counts a running session from when its running turn started, past a notice queued behind it', () => {
    const created_at = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const turn_started_at = new Date(Date.now() - 30_000).toISOString();
    const h = header({
      listed: listed('session-a', {
        state: 'running',
        created_at,
        turn_started_at,
        last_turn: { id: 'notice', state: 'queued' },
      }),
    });
    expect(text(part(h, 'RunClock').value)).toBe(zhf('data.elapsed.seconds', { seconds: 30 }));
  });

  it('leaves the clock out of an idle session', () => {
    const h = header({ listed: listed('session-a', { state: 'idle' }) });
    expect(nodes(h.value).some((n) => (n.type as any)?.name === 'RunClock')).toBe(false);
  });
});

describe('header source session', () => {
  it('names the session a fork came from and opens it', () => {
    const h = header({
      listed: listed('session-a', { forked_from: { session_id: 'session-source' } }),
      parent: listed('session-source', { title: 'Source run' }),
    });
    const link = find(
      h.value,
      (n) =>
        n.props['aria-label'] ===
        t({ id: 'sessions.header.forkedFrom', defaultMessage: '' }, { title: 'Source run' }),
    );
    expect(nodes(link).some((n) => (n.type as any)?.name === 'LeadCrown')).toBe(false);
    link.props.onClick();
    expect(mock.shell.openSession).toHaveBeenCalledWith('session-source');
  });

  it('passes the session a fork came from to the thread', () => {
    const list = {
      data: [
        listed('session-a', { forked_from: { session_id: 'session-source' } }),
        listed('session-source'),
      ],
      loading: false,
      error: null,
      reload() {},
    };
    const needs = { items: [], loading: false, error: null, reload() {} };
    const h = mount(() => SessionsScreen({ projectId: 'project-a', needs, list }));
    expect(named(h.value, 'Thread').props.parent.id).toBe('session-source');
  });
});

describe('header overview while a panel is open', () => {
  const list = { data: [listed('session-a')], loading: false, error: null, reload() {} };
  const needs = { items: [], loading: false, error: null, reload() {} };

  it('leaves the toggle unpressed, and showing the overview closes the panels', () => {
    stored.set('pantheon.inspector.session-a', JSON.stringify({ panels: ['changes'] }));
    const h = mount(() => SessionsScreen({ projectId: 'project-a', needs, list }));
    const thread = () => named(h.value, 'Thread');
    expect(thread().props.panels).toEqual(['changes']);
    expect(thread().props.overview).toBe(false);
    thread().props.onOverview();
    h.render();
    expect(thread().props.panels).toEqual([]);
    expect(thread().props.overview).toBe(true);
  });
});

describe('header more menu', () => {
  it('offers fork, search in the session and return to checkpoint first', () => {
    showThreadTurns({ sessionId: 'session-a', turns: [turn('turn-1')] as any });
    const labels = items(menu().value).map((n) => text(n));
    expect(labels.slice(0, 3)).toEqual([FORK, FIND, CHECKPOINT]);
    expect(item(menu().value, FIND)!.props.keys).toBe('Meta+F');
  });

  it('opens the search bar of the session', () => {
    const h = menu();
    item(h.value, FIND)!.props.onClick();
    expect(useThreadFind.getState().sessionId).toBe('session-a');
  });

  it('forks the session from its current files', () => {
    const h = menu();
    item(h.value, FORK)!.props.onClick();
    h.render();
    const dialog = named(h.value, 'ForkDialog');
    expect(dialog.props).toMatchObject({ open: true, sessionId: 'session-a', before: null });
  });

  it('returns the worktree to before the newest turn once confirmed', async () => {
    showThreadTurns({
      sessionId: 'session-a',
      turns: [
        turn('turn-1'),
        // A steer injected into a running turn: it never ran, so it has no checkpoint.
        { ...turn('turn-steer', { kind: 'steer' }), started_at: null },
        turn('turn-2'),
        turn('turn-3', { rolled_back: true }),
      ] as any,
    });
    const h = menu(listed('session-a', { checkpoint_turn_id: 'turn-2' }));
    item(h.value, CHECKPOINT)!.props.onClick();
    h.render();
    const dialog = part(h, 'RollbackDialog');
    expect(text(dialog.value)).toContain(
      t(
        { id: 'sessions.header.checkpointTitle', defaultMessage: '' },
        { title: 'title of session-a', turn: 2 },
      ),
    );
    expect(text(dialog.value)).toContain(
      t({ id: 'sessions.header.checkpointBody', defaultMessage: '' }, { turn: 2 }),
    );
    find(dialog.value, (n) => n.props.className === 'btn dng').props.onClick();
    await dialog.flush();
    expect(commands).toMatchObject([
      {
        type: 'session.rollback',
        input: { session_id: 'session-a', turn_id: 'turn-2' },
        expected_revision: 6,
      },
    ]);
  });

  it('returns to the newest turn that has a checkpoint, past a compaction', () => {
    showThreadTurns({
      sessionId: 'session-a',
      turns: [
        turn('turn-1'),
        turn('turn-2'),
        turn('turn-compact', { origin: 'compaction' }),
      ] as any,
    });
    const h = menu(listed('session-a', { checkpoint_turn_id: 'turn-2' }));
    item(h.value, CHECKPOINT)!.props.onClick();
    h.render();
    const dialog = named(h.value, 'RollbackDialog');
    expect(dialog.props.turnId).toBe('turn-2');
    expect(text(part(h, 'RollbackDialog').value)).toContain(
      t(
        { id: 'sessions.header.checkpointTitle', defaultMessage: '' },
        { title: 'title of session-a', turn: 2 },
      ),
    );
  });

  it('returns to the turn the session list names, not a newer one queued before a merge', () => {
    showThreadTurns({ sessionId: 'session-a', turns: [turn('turn-1'), turn('turn-2')] as any });
    const h = menu(listed('session-a', { checkpoint_turn_id: 'turn-1' }));
    item(h.value, CHECKPOINT)!.props.onClick();
    h.render();
    expect(named(h.value, 'RollbackDialog').props.turnId).toBe('turn-1');
  });

  it('returns to a steer that ran on its own when the session list names it', () => {
    showThreadTurns({
      sessionId: 'session-a',
      turns: [turn('turn-1'), turn('steer-1', { kind: 'steer' })] as any,
    });
    const h = menu(listed('session-a', { checkpoint_turn_id: 'steer-1' }));
    item(h.value, CHECKPOINT)!.props.onClick();
    h.render();
    expect(named(h.value, 'RollbackDialog').props.turnId).toBe('steer-1');
  });

  it('says why fork and return to checkpoint are off', () => {
    expect(reasonOf(menu(), CHECKPOINT)).toBe(zh('sessions.header.noCheckpointSinceMerge'));
    showThreadTurns({ sessionId: 'session-a', turns: [turn('turn-1')] as any });
    expect(item(menu().value, CHECKPOINT)!.props.disabled).toBe(true);
    expect(reasonOf(menu(), CHECKPOINT)).toBe(zh('sessions.header.noCheckpointSinceMerge'));
    const running = menu(listed('session-a', { state: 'running' }));
    expect(reasonOf(running, CHECKPOINT)).toBe(BUSY);
    expect(item(running.value, FORK)!.props.disabled).toBeFalsy();
    showThreadTurns({
      sessionId: 'session-a',
      turns: [turn('turn-1', { state: 'running' })] as any,
    });
    expect(reasonOf(menu(listed('session-a', { state: 'running' })), FORK)).toBe(BUSY);
    expect(reasonOf(menu(listed('session-a', { state: 'merging' })), FORK)).toBe(BUSY);
    const inPlace = menu(listed('session-a', { workspace_kind: 'in_place' }));
    expect(reasonOf(inPlace, FORK)).toBe(zh('sessions.header.noFork'));
    expect(reasonOf(inPlace, CHECKPOINT)).toBe(zh('sessions.header.noCheckpoints'));
  });
});
