import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { Session, SessionTurn } from '@pantheon/domain';
import type { WorkbenchSession } from '@pantheon/protocol';
import { mount, named, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
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
import { buildTranscript } from '@/data/transcript';
import { sessionMenu, type SessionMenuEntry } from '@/screens/sessions/model';
import {
  SessionCard,
  SessionHeader,
  SessionInspector,
  SessionListRow,
  SessionRowButton,
  ThreadTurn,
} from '@/screens/sessions/SessionsScreen';
import { SessionPreview } from '@/screens/sessions/SessionRow';

const listed = (
  state: WorkbenchSession['state'],
  extra: Partial<WorkbenchSession> = {},
): WorkbenchSession => ({
  id: 'session-a',
  created_at: '2026-11-03T00:00:00.000Z',
  title: 'Release notes',
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-a',
  workspace_kind: 'in_place',
  state,
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-11-03T00:00:00.000Z',
  changes: null,
  merge: null,
  ...extra,
});
const workspace = { id: 'workspace-a', path: '/work/a', base_sha: 'abc1234' };
const menu = (key: string) => zh(`sessions.model.menu.${key}`);
const rowMenu = (key: string) => zh(`sessions.rowMenu.${key}`);
const sub = (label: string, items: string[]) => `${label} ▸ ${items.join(', ')}`;
const openIn = sub(rowMenu('openIn'), ['editor', 'terminal', 'fileManager'].map(rowMenu));
const copy = (path: string) =>
  sub(menu('copy'), [
    menu(path),
    menu('copySessionId'),
    menu('copyBaseCommit'),
    zh('sessions.export.copyMarkdown'),
    zh('sessions.export.exportMarkdown'),
  ]);
const busy = zh('data.reason.nativeSessionBusy');
const inPlace = zh('sessions.screen.inPlace');
const shape = (groups: SessionMenuEntry[][]) =>
  groups.map((group) =>
    group.map((entry) =>
      'items' in entry
        ? `${entry.label} ▸ ${entry.items.map((i) => i.label).join(', ')}`
        : entry.label,
    ),
  );
const boardSession = {
  id: 'session-a',
  revision: 5,
  project_id: 'project-a',
  runtime: 'claude',
  state: 'open',
  turn_count: 1,
  workspace_id: 'workspace-a',
} as Session;
const failed = (error_code: string, extra: Partial<WorkbenchSession> = {}) =>
  listed('idle', {
    last_turn: { id: 'turn-a', state: 'failed', error: 'raw failure', error_code },
    ...extra,
  });

describe('menu of a session in its own folder', () => {
  it('leaves out checks, merge and discard, and copies the folder', () => {
    expect(shape(sessionMenu(listed('ready'), { workspace }))).toEqual([
      [rowMenu('open')],
      ['rename', 'pin', 'snooze', 'markUnread'].map(menu),
      [openIn, copy('copyFolder')],
      ['archive', 'delete'].map(menu),
    ]);
  });

  it('keeps checks, merge and the worktree path for a linked worktree session', () => {
    const linked = listed('ready', { workspace_kind: 'linked_worktree' });
    expect(shape(sessionMenu(linked, { workspace, discardable: true }))).toEqual([
      [rowMenu('open')],
      ['rename', 'pin', 'snooze', 'markUnread'].map(menu),
      ['runChecks', 'merge'].map(menu),
      [openIn, copy('copyWorktreePath')],
      ['archive', 'discard', 'delete'].map(menu),
    ]);
  });
});

describe('a session in its own folder on screen', () => {
  let logins: unknown[];
  beforeEach(() => {
    logins = [];
    mock.board = {
      board: {
        sessions: [boardSession],
        session_turns: [],
        projects: [],
        workspaces: [workspace],
        cursor: 1,
      },
      events: [],
      status: { state: 'live' },
      resync: 0,
      refresh() {},
    };
    mock.shell = { sessionId: 'session-a', followFirstSession: vi.fn(), openSession: vi.fn() };
    vi.stubGlobal('window', {
      pantheon: {
        command: vi.fn(async () => ({ ok: true, value: {} })),
        query: vi.fn(async () => ({ ok: true, value: {} })),
        runtimeLogin: vi.fn(async (runtime: unknown) => {
          logins.push(runtime);
          return { ok: true, value: undefined };
        }),
      },
      addEventListener() {},
      removeEventListener() {},
    });
  });
  afterEach(() => {
    unmountAll();
    vi.unstubAllGlobals();
  });

  const header = (s: WorkbenchSession) =>
    mount(() =>
      SessionHeader({
        session: boardSession,
        listed: s,
        title: 'Release notes',
        panels: ['changes'],
        onPanel() {},
        overview: true,
      }),
    );

  it('offers no discard in the row menu', () => {
    const h = mount(() =>
      SessionListRow({ session: listed('ready'), on: true, now: 0, onSelect() {} }),
    );
    const labels = nodes(h.value)
      .filter((n) => typeof n.type !== 'string' && typeof n.props.onClick === 'function')
      .map(text);
    expect(labels).toContain(menu('copyFolder'));
    expect(labels).not.toContain(menu('discard'));
    expect(labels).not.toContain(menu('runChecks'));
  });

  it('names its own folder in the row and the preview only for a session in its own folder', () => {
    const marked = (s: WorkbenchSession) =>
      nodes(SessionPreview({ session: s, now: 0 }))
        .filter((n) => n.type === 'dd')
        .map(text)
        .filter((value) => value === inPlace);
    const name = (s: WorkbenchSession) =>
      SessionRowButton({ session: s, on: false, now: 0, onSelect() {} }).props['aria-label'];
    expect(marked(listed('idle'))).toEqual([inPlace]);
    expect(name(listed('idle'))).toContain(inPlace);
    expect(marked(listed('idle', { workspace_kind: 'linked_worktree' }))).toEqual([]);
    expect(name(listed('idle', { workspace_kind: 'linked_worktree' }))).not.toContain(inPlace);
  });

  it('offers no rollback on its turns', () => {
    const turn = {
      id: 'turn-a',
      project_id: 'project-a',
      session_id: 'session-a',
      revision: 1,
      created_at: 1,
      updated_at: 1,
      input: 'Tighten the release notes',
      state: 'completed',
    } as unknown as SessionTurn;
    const thread = (s: WorkbenchSession) =>
      mount(() =>
        ThreadTurn({
          view: buildTranscript([turn], []).turns[0]!,
          folders: [],
          status: { kind: 'ended', tool: null, since: null },
          fresh: new Set(),
          request: () => null,
          listed: s,
        }),
      ).value;
    const rollable = (tree: unknown) =>
      nodes(tree as any).find((n) => typeof n.type === 'function' && n.type.name === 'TurnActions')!
        .props.rollable;
    expect(rollable(thread(listed('idle')))).toBe(false);
    expect(rollable(thread(listed('idle', { workspace_kind: 'linked_worktree' })))).toBe(true);
  });

  it('names a failed turn by its error code in the row preview and the header', () => {
    const s = failed('native_session_busy');
    const preview = SessionPreview({ session: s, now: 0 });
    expect(text(preview)).toContain(busy);
    const pill = named(header(s).value, 'LastTurn');
    const body = mount(() => (pill.type as (props: unknown) => ReactElement<any>)(pill.props));
    expect(body.value.props.content).toBe(busy);
  });

  it('keeps the raw error of a failed turn without a code', () => {
    const s = listed('idle', {
      last_turn: { id: 'turn-a', state: 'failed', error: 'raw failure' },
    });
    const pill = named(header(s).value, 'LastTurn');
    const body = mount(() => (pill.type as (props: unknown) => ReactElement<any>)(pill.props));
    expect(body.value.props.content).toBe('raw failure');
  });

  it('turns its checks toggle off with the reason and leaves the other panels on', () => {
    const h = header(listed('idle'));
    const toolbar = nodes(h.value).find((n) => n.props.role === 'toolbar')!;
    const toggles = nodes(toolbar).filter((n) => n.type === 'button');
    const checks = zh('sessions.screen.tabChecks');
    expect(
      toggles.filter((n) => n.props['aria-disabled'] === 'true').map((n) => n.props['aria-label']),
    ).toEqual([checks]);
    const tip = nodes(toolbar).find(
      (n) =>
        typeof n.type === 'function' &&
        n.type.name === 'Tip' &&
        n.props.children.props['aria-label'] === checks,
    )!;
    expect(tip.props.content).toBe(zh('sessions.header.ungated'));
    expect(toggles.map((n) => n.props['aria-label'])).toEqual([
      zh('sessions.screen.tabChanges'),
      checks,
      zh('sessions.panel.dock.plan'),
      zh('sessions.panel.dock.files'),
      zh('sessions.panel.dock.trace'),
      zh('sessions.panel.dock.monitor'),
    ]);
  });

  const loginButton = (tree: unknown) =>
    nodes(tree as any).find((n) => n.type === 'button' && text(n) === zh('sessions.screen.logIn'));

  it('offers the runtime login beside a turn that failed on the login', async () => {
    for (const [code, runtime] of [
      ['billing_channel_mismatch', 'claude'],
      ['account_check_timeout', 'codex'],
    ] as const) {
      const h = header(failed(code, { runtime }));
      loginButton(h.value)!.props.onClick();
      await h.flush();
    }
    expect(logins).toEqual(['claude', 'codex']);
  });

  it('offers no login for other failures', () => {
    expect(loginButton(header(failed('native_session_busy')).value)).toBeUndefined();
    expect(
      loginButton(header(listed('idle', { workspace_kind: 'linked_worktree' })).value),
    ).toBeUndefined();
  });

  const inspector = (s: WorkbenchSession) =>
    mount(() =>
      SessionInspector({
        sessionId: 'session-a',
        listed: s,
        session: boardSession,
        panels: ['changes', 'checks', 'plan'],
        onOpen() {},
        onClose() {},
        onView: () => {},
      }),
    );
  const queried = () =>
    (window.pantheon!.query as ReturnType<typeof vi.fn>).mock.calls.map(([method]) => method);
  const tab = {
    changes: zh('sessions.screen.tabChanges'),
    checks: zh('sessions.screen.tabChecks'),
    plan: zh('sessions.panel.dock.plan'),
  };
  const tabLabels = (tree: unknown) =>
    nodes(tree as any)
      .filter((n) => n.type === 'section')
      .map((n) => n.props['aria-label']);

  it('reads its diff but neither gates nor the merge preflight, and shows no checks or merge bar', async () => {
    const h = inspector(listed('idle'));
    await h.flush();
    expect(queried()).toContain('session.diff');
    expect(queried()).not.toContain('session.gates');
    expect(queried()).not.toContain('session.gates.history');
    expect(queried()).not.toContain('session.preflight');
    expect(tabLabels(h.value)).toEqual([tab.changes, tab.plan]);
    expect(
      nodes(h.value).some((n) => typeof n.type === 'function' && n.type.name === 'MergeBar'),
    ).toBe(false);
    const card = mount(() =>
      SessionCard({
        sessionId: 'session-a',
        listed: listed('idle'),
        session: boardSession,
        onTab() {},
      }),
    );
    await card.flush();
    expect(queried()).not.toContain('session.preflight');
    expect(
      nodes(card.value).some((n) => typeof n.type === 'function' && n.type.name === 'MergeBar'),
    ).toBe(false);
  });

  it('keeps gates and the merge preflight for a linked worktree session', async () => {
    const h = inspector(listed('idle', { workspace_kind: 'linked_worktree' }));
    await h.flush();
    expect(queried()).toEqual(
      expect.arrayContaining(['session.diff', 'session.gates', 'session.preflight']),
    );
    expect(tabLabels(h.value)).toEqual([tab.changes, tab.checks, tab.plan]);
  });

  it('reads no gates for a session the list does not hold yet, which may have no worktree', async () => {
    const card = mount(() =>
      SessionCard({ sessionId: 'session-a', listed: null, session: boardSession, onTab() {} }),
    );
    await card.flush();
    const h = mount(() =>
      SessionInspector({
        sessionId: 'session-a',
        listed: null,
        session: boardSession,
        panels: ['changes', 'checks', 'plan'],
        onOpen() {},
        onClose() {},
        onView: () => {},
      }),
    );
    await h.flush();
    expect(queried()).not.toContain('session.gates');
    expect(queried()).not.toContain('session.gates.history');
  });

  it('offers only its uncommitted changes, not each turn', () => {
    mock.board.board.session_turns = [
      { id: 'turn-a', session_id: 'session-a', kind: 'send', state: 'completed' },
    ];
    const scope = (s: WorkbenchSession) =>
      nodes(inspector(s).value).find(
        (n) => n.props['aria-label'] === zh('sessions.screen.changeScope'),
      );
    expect(scope(listed('idle'))).toBeUndefined();
    expect(scope(listed('idle', { workspace_kind: 'linked_worktree' }))).toBeDefined();
  });
});
