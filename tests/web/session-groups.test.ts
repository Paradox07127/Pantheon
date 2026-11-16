import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchSession } from '@pantheon/protocol';
import { find, mount, text, unmountAll } from './web-hook-host.js';
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
import { groupWorkbenchSessions, sessionMenu } from '@/screens/sessions/model';
import { SessionListRow, shownSessionId } from '@/screens/sessions/SessionsScreen';

const AT = '2026-01-01T00:00:00.000Z';
const snooze = zh('sessions.model.menu.snooze');
const unsnooze = zh('sessions.model.menu.unsnooze');
const session = (
  id: string,
  state: WorkbenchSession['state'],
  extra: Partial<WorkbenchSession> = {},
): WorkbenchSession => ({
  id,
  created_at: AT,
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
  last_activity_at: AT,
  changes: null,
  merge: null,
  ...extra,
});

const groupOf = (s: WorkbenchSession) => groupWorkbenchSessions([s])[0]!.key;

describe('session list groups', () => {
  it.each([
    [
      'an archived session, even snoozed and waiting',
      session('a', 'waiting', { archived_at: AT, snoozed_at: AT }),
      'archived',
    ],
    ['a snoozed session, even waiting', session('a', 'waiting', { snoozed_at: AT }), 'snoozed'],
    ['a session that needs attention', session('a', 'failed'), 'waiting'],
    ['a session ready to merge', session('a', 'ready'), 'review'],
    ['a starting session', session('a', 'starting'), 'working'],
    ['a running session', session('a', 'running'), 'working'],
    ['a merging session', session('a', 'merging'), 'working'],
    ['a stopping session', session('a', 'idle', { stopping: true }), 'working'],
    ['an idle session', session('a', 'idle'), 'ended'],
    ['a merged session', session('a', 'merged'), 'merged'],
    ['an ended session', session('a', 'done'), 'ended'],
  ])('puts %s in its group', (_name, listed, group) => {
    expect(groupOf(listed)).toBe(group);
  });

  it('orders the groups needs you, working, to review, snoozed, merged, ended, archived and folds the last three', () => {
    const groups = groupWorkbenchSessions([
      session('archived', 'idle', { archived_at: AT }),
      session('ended', 'idle'),
      session('merged', 'merged'),
      session('snoozed', 'idle', { snoozed_at: AT }),
      session('review', 'ready'),
      session('working', 'running'),
      session('waiting', 'waiting'),
    ]);
    expect(groups.map((g) => [g.key, g.label, g.folded])).toEqual(
      (
        [
          ['waiting', false],
          ['working', false],
          ['review', false],
          ['snoozed', false],
          ['merged', true],
          ['ended', true],
          ['archived', true],
        ] as const
      ).map(([key, folded]) => [key, zh(`sessions.model.group.${key}`), folded]),
    );
  });

  it('keeps showing the followed session after it settles, and leaves it once it is archived', () => {
    const working = session('working', 'running');
    expect(shownSessionId(null, 'done', [working, session('done', 'idle')])).toBe('done');
    expect(
      shownSessionId(null, 'done', [working, session('done', 'idle', { archived_at: AT })]),
    ).toBe('working');
    expect(shownSessionId(null, 'gone', [working])).toBe('working');
  });

  it('shows the composer when every session is settled and none is followed', () => {
    expect(shownSessionId(null, null, [session('done', 'idle')])).toBe('');
    expect(shownSessionId(null, null, null)).toBeNull();
    expect(shownSessionId('chosen', 'done', [session('done', 'idle')])).toBe('chosen');
  });

  it.each([
    ['an unread idle session', session('a', 'idle'), true, 'review'],
    ['a read idle session', session('a', 'idle'), false, 'ended'],
    ['an unread ended session', session('a', 'done'), true, 'ended'],
    ['an unread running session', session('a', 'running'), true, 'working'],
    ['an unread snoozed idle session', session('a', 'idle', { snoozed_at: AT }), true, 'snoozed'],
    [
      'an unread archived idle session',
      session('a', 'idle', { archived_at: AT }),
      true,
      'archived',
    ],
  ])('puts %s in its group', (_name, listed, unread, group) => {
    expect(groupWorkbenchSessions([listed], 'activity', () => unread)[0]!.key).toBe(group);
  });

  it('puts pinned sessions first inside their own group', () => {
    const groups = groupWorkbenchSessions([
      session('new', 'running', { last_activity_at: '2026-01-03T00:00:00.000Z' }),
      session('pinned', 'running', { pinned_at: AT }),
      session('other', 'idle', { pinned_at: AT }),
    ]);
    expect(groups.map((g) => [g.key, g.sessions.map((s) => s.id)])).toEqual([
      ['working', ['pinned', 'new']],
      ['ended', ['other']],
    ]);
  });
});

describe('snooze menu item', () => {
  let commands: { type: string; input: unknown; expected_revision: number | null }[];
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
  const choose = async (listed: WorkbenchSession, label: string) => {
    const h = mount(() => SessionListRow({ session: listed, on: true, now: 0, onSelect() {} }));
    find(
      h.value,
      (n) => n.props.onClick && text(n) === label && n.type !== 'button',
    ).props.onClick();
    await h.flush();
  };

  it.each([
    [
      'snoozes the session at its board revision',
      {},
      snooze,
      { type: 'session.snooze', input: { session_id: 'a', snoozed: true }, expected_revision: 5 },
    ],
    [
      'wakes a snoozed session',
      { snoozed_at: AT },
      unsnooze,
      { type: 'session.snooze', input: { session_id: 'a', snoozed: false } },
    ],
  ])('%s', async (_name, extra, label, command) => {
    await choose(session('a', 'idle', extra), label);
    expect(commands).toMatchObject([command]);
  });

  it('offers no snooze for an archived session', () => {
    const labels = sessionMenu(session('a', 'done', { archived_at: AT }))
      .flat()
      .map((entry) => entry.label);
    expect(labels).not.toContain(snooze);
    expect(labels).not.toContain(unsnooze);
  });
});
