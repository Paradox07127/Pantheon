import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { WorkbenchSession } from '@pantheon/protocol';
import { find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
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
vi.mock('@/components/Toast', () => ({ toast: vi.fn(() => 'toast') }));
import { toast } from '@/components/Toast';
import { eventSummary } from '@/data/logs';
import { groupWorkbenchSessions, sessionMenu, sidebarGroups } from '@/screens/sessions/model';
import { SessionListRow } from '@/screens/sessions/SessionsScreen';

const menu = (key: string) => zh(`sessions.model.menu.${key}`);
const group = (key: string) => zh(`sessions.model.group.${key}`);

const session = (
  id: string,
  state: WorkbenchSession['state'],
  extra: Partial<WorkbenchSession> = {},
): WorkbenchSession => ({
  id,
  created_at: '2026-01-01T00:00:00.000Z',
  title: `title of ${id}`,
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
  last_activity_at: '2026-01-01T00:00:00.000Z',
  changes: null,
  merge: null,
  ...extra,
});

describe('pinned and archived groups', () => {
  it('puts pinned sessions first in their group by activity and archived ones only in a folded group last', () => {
    const groups = groupWorkbenchSessions([
      session('running', 'running'),
      session('late', 'idle', {
        pinned_at: '2026-01-02T00:00:00.000Z',
        last_activity_at: '2026-01-02T00:00:00.000Z',
      }),
      session('early', 'merged', {
        pinned_at: '2026-01-01T00:00:00.000Z',
        last_activity_at: '2026-01-03T00:00:00.000Z',
      }),
      session('old', 'discarded', { archived_at: '2026-01-03T00:00:00.000Z' }),
      session('both', 'failed', {
        pinned_at: '2026-01-01T00:00:00.000Z',
        archived_at: '2026-01-03T00:00:00.000Z',
      }),
      session('ended', 'done'),
    ]);
    expect(groups.map((g) => [g.key, g.label, g.folded, g.sessions.map((s) => s.id)])).toEqual([
      ['working', group('working'), false, ['running']],
      ['merged', group('merged'), true, ['early']],
      ['ended', group('ended'), true, ['late', 'ended']],
      ['archived', group('archived'), true, ['both', 'old']],
    ]);
  });

  it('lists the pinned sessions that are not archived in a group of their own at the top, and the archived only when shown', () => {
    const list = [
      session('running', 'running'),
      session('pinned-ended', 'merged', {
        pinned_at: '2026-01-01T00:00:00.000Z',
        last_activity_at: '2026-01-02T00:00:00.000Z',
      }),
      session('pinned-waiting', 'waiting', {
        pinned_at: '2026-01-02T00:00:00.000Z',
        last_activity_at: '2026-01-03T00:00:00.000Z',
      }),
      session('pinned-archived', 'failed', {
        pinned_at: '2026-01-01T00:00:00.000Z',
        archived_at: '2026-01-03T00:00:00.000Z',
      }),
    ];
    const shown = (archived: boolean) =>
      sidebarGroups(list, { grouping: 'state', sort: 'activity', archived }).map((g) => [
        g.key,
        g.label,
        g.folded,
        g.rows.map((r) => r.session.id),
      ]);
    expect(shown(true)).toEqual([
      ['pinned', group('pinned'), false, ['pinned-waiting', 'pinned-ended']],
      ['working', group('working'), false, ['running']],
      ['archived', group('archived'), true, ['pinned-archived']],
    ]);
    expect(shown(false).map(([key]) => key)).toEqual(['pinned', 'working']);
  });

  it('lists a pinned or archived forked session in its state group instead of under its source', () => {
    const list = [
      session('lead', 'idle'),
      session('pinned', 'running', {
        forked_from: { session_id: 'lead' },
        pinned_at: '2026-01-01T00:00:00.000Z',
      }),
      session('archived', 'discarded', {
        forked_from: { session_id: 'lead' },
        archived_at: '2026-01-01T00:00:00.000Z',
      }),
      session('nested', 'running', { forked_from: { session_id: 'lead' } }),
    ];
    expect(
      sidebarGroups(list, { grouping: 'state', sort: 'activity', archived: true }).map((g) => [
        g.key,
        g.rows.map((r) => [r.session.id, r.children]),
      ]),
    ).toEqual([
      ['pinned', [['pinned', []]]],
      ['working', [['nested', []]]],
      ['ended', [['lead', []]]],
      ['archived', [['archived', []]]],
    ]);
  });
});

describe('session menu', () => {
  const items = (s: WorkbenchSession) =>
    sessionMenu(s)
      .flat()
      .flatMap((entry) => ('items' in entry ? [] : [entry]));
  const labels = (s: WorkbenchSession) =>
    items(s)
      .map((item) => item.label)
      .filter((label) =>
        ['pin', 'unpin', 'archive', 'unarchive', 'delete'].map(menu).includes(label),
      );

  it('offers archive for an ended, idle or ready session and restore for an archived one', () => {
    expect(labels(session('a', 'running'))).toEqual(['pin', 'delete'].map(menu));
    for (const state of ['merged', 'discarded', 'failed', 'done', 'idle', 'ready'] as const)
      expect(labels(session('a', state))).toEqual(['pin', 'archive', 'delete'].map(menu));
    expect(labels(session('a', 'discarded', { archived_at: '2026-01-01T00:00:00.000Z' }))).toEqual(
      ['pin', 'unarchive', 'delete'].map(menu),
    );
    expect(labels(session('a', 'idle', { pinned_at: '2026-01-01T00:00:00.000Z' }))).toEqual(
      ['unpin', 'archive', 'delete'].map(menu),
    );
  });

  it('sends the pin, snooze, archive and restore commands for the session', () => {
    const sent = (s: WorkbenchSession) =>
      items(s)
        .filter((item) => item.command !== 'copy' && !item.command.startsWith('open.'))
        .map(({ command, input }) => [command, input]);
    expect(sent(session('a', 'done'))).toEqual([
      ['session.open', { session_id: 'a' }],
      ['session.rename', { session_id: 'a' }],
      ['session.pin', { session_id: 'a', pinned: true }],
      ['session.snooze', { session_id: 'a', snoozed: true }],
      ['session.mark_unread', { session_id: 'a' }],
      ['session.archive', { session_id: 'a' }],
      ['session.delete', { session_id: 'a' }],
    ]);
    const archived = session('a', 'done', {
      pinned_at: '2026-01-01T00:00:00.000Z',
      archived_at: '2026-01-01T00:00:00.000Z',
    });
    expect(sent(archived)).toEqual([
      ['session.open', { session_id: 'a' }],
      ['session.rename', { session_id: 'a' }],
      ['session.pin', { session_id: 'a', pinned: false }],
      ['session.mark_unread', { session_id: 'a' }],
      ['session.unarchive', { session_id: 'a' }],
      ['session.delete', { session_id: 'a' }],
    ]);
  });

  it('turns delete off for a merged session and says why', () => {
    expect(items(session('a', 'merged')).at(-1)).toMatchObject({
      label: menu('delete'),
      danger: true,
      reason: menu('mergedArchiveOnly'),
    });
    expect(items(session('a', 'discarded')).at(-1)).not.toHaveProperty('reason');
  });
});

describe('session management events', () => {
  const event = (kind: string, payload: unknown = {}) => ({
    sequence: 1,
    event_id: 'event-1',
    kind,
    aggregate_id: 'a',
    aggregate_revision: 1,
    project_id: 'project-a',
    causation_id: '',
    created_at: 1,
    payload,
  });

  it('names pin, archive and delete, with the deleted session title', () => {
    expect(
      ['session.pinned', 'session.unpinned', 'session.archived', 'session.unarchived'].map((kind) =>
        eventSummary(event(kind)),
      ),
    ).toEqual([
      zh('data.logs.pinned'),
      zh('data.logs.unpinned'),
      zh('data.logs.archived'),
      zh('data.logs.unarchived'),
    ]);
    expect(eventSummary(event('session.deleted', { title: 'Fix the parser' }))).toBe(
      '删除会话 Fix the parser',
    );
  });
});

describe('session row actions', () => {
  let commands: { type: string; input: unknown; expected_revision: number | null }[];
  const item = (tree: unknown, label: string) =>
    find(tree as any, (n) => n.props.onClick && text(n) === label && n.type !== 'button');

  beforeEach(() => {
    commands = [];
    mock.board = {
      board: {
        sessions: [{ id: 'a', revision: 5 }],
        session_turns: [],
        projects: [],
        workspaces: [],
        cursor: 1,
      },
      events: [],
      status: { state: 'live' },
      cursor: 1,
      resync: 0,
      refresh() {},
    };
    mock.shell = { sessionId: 'a', followFirstSession: vi.fn() };
    vi.stubGlobal('window', {
      pantheon: {
        command: vi.fn(async (command: any) => {
          commands.push(command);
          return { ok: true, value: {} };
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

  const row = (listed: WorkbenchSession, on = true) =>
    mount(() => SessionListRow({ session: listed, on, now: 0, onSelect() {} }));

  it('opens the same menu from the row and from its menu button in the browser', () => {
    // The desktop app opens the row's context menu natively; the browser draws both menus.
    vi.stubGlobal('window', { ...window, pantheon: undefined });
    const h = row(session('a', 'discarded'));
    expect(
      find(h.value, (n) => n.props['aria-label'] === zh('sessions.screen.sessionActions')).props
        .className,
    ).toContain('ib');
    expect(
      nodes(h.value).filter((n) => text(n) === menu('archive') && n.props.onClick),
    ).toHaveLength(2);
  });

  it('pins the session at its board revision', async () => {
    const h = row(session('a', 'running'));
    item(h.value, menu('pin')).props.onClick();
    await h.flush();
    expect(commands).toMatchObject([
      { type: 'session.pin', input: { session_id: 'a', pinned: true }, expected_revision: 5 },
    ]);
  });

  it('confirms delete in a dialog and then shows the next session', async () => {
    const h = row(session('a', 'discarded'));
    item(h.value, menu('delete')).props.onClick();
    await h.flush();
    const dialog = named(h.value, 'DeleteDialog');
    expect(dialog.props.open).toBe(true);
    const confirm = mount(() => (dialog.type as (props: unknown) => ReactNode)(dialog.props));
    expect(text(find(confirm.value, (n) => n.props.className === 'pj-dt'))).toBe(
      '删除「title of a」？',
    );
    expect(text(confirm.value)).toContain(zh('sessions.screen.deleteBody'));
    expect(commands).toEqual([]);
    find(
      confirm.value,
      (n) => n.type === 'button' && text(n) === zh('sessions.screen.delete'),
    ).props.onClick();
    await confirm.flush();
    await h.flush();
    expect(commands).toMatchObject([
      { type: 'session.delete', input: { session_id: 'a' }, expected_revision: 5 },
    ]);
    expect(mock.shell.followFirstSession).toHaveBeenCalledOnce();
    expect(named(h.value, 'DeleteDialog').props.open).toBe(false);
  });

  it('archives the shown session, then shows the next one, and undo opens it again', async () => {
    mock.shell.openSession = vi.fn();
    // The archive answers with the archived session, whose revision the undo restores at.
    vi.mocked(window.pantheon!.command).mockImplementation(async (command: any) => {
      commands.push(command);
      return { ok: true, value: { id: 'a', revision: 6 } };
    });
    const h = row(session('a', 'discarded'));
    item(h.value, menu('archive')).props.onClick();
    await h.flush();
    expect(commands).toMatchObject([{ type: 'session.archive', input: { session_id: 'a' } }]);
    expect(mock.shell.followFirstSession).toHaveBeenCalledOnce();
    vi.mocked(toast).mock.calls.at(-1)![0].action!.run();
    await h.flush();
    expect(commands.at(-1)).toMatchObject({
      type: 'session.unarchive',
      input: { session_id: 'a' },
      expected_revision: 6,
    });
    expect(mock.shell.openSession).toHaveBeenCalledWith('a');
  });

  it('keeps the shown session when another one is archived, and undo leaves it shown', async () => {
    mock.shell.openSession = vi.fn();
    mock.shell.sessionId = 'b';
    const h = row(session('a', 'discarded'), false);
    item(h.value, menu('archive')).props.onClick();
    await h.flush();
    expect(mock.shell.followFirstSession).not.toHaveBeenCalled();
    vi.mocked(toast).mock.calls.at(-1)![0].action!.run();
    await h.flush();
    expect(mock.shell.openSession).not.toHaveBeenCalled();
  });

  it('keeps the shown session when another one is deleted', async () => {
    const h = row(session('a', 'discarded'), false);
    mock.shell.sessionId = 'b';
    item(h.value, menu('delete')).props.onClick();
    await h.flush();
    const dialog = named(h.value, 'DeleteDialog');
    const confirm = mount(() => (dialog.type as (props: unknown) => ReactNode)(dialog.props));
    find(
      confirm.value,
      (n) => n.type === 'button' && text(n) === zh('sessions.screen.delete'),
    ).props.onClick();
    await confirm.flush();
    expect(commands).toHaveLength(1);
    expect(mock.shell.followFirstSession).not.toHaveBeenCalled();
  });

  it('turns delete off for a merged session with the reason as its tip', () => {
    const h = row(session('a', 'merged'));
    const tip = find(
      h.value,
      (n) => typeof n.type === 'function' && n.type.name === 'Tip' && text(n) === menu('delete'),
    );
    expect(tip.props.content).toBe(menu('mergedArchiveOnly'));
    expect(tip.props.children.props.disabled).toBe(true);
  });
});
