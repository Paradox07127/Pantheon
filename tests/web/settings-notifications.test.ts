import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { WorkbenchSession } from '@pantheon/protocol';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
    subscribe: () => () => {},
  }),
}));
import {
  DEFAULT_NOTIFICATIONS,
  getNotificationPrefs,
  readNotificationPrefs,
  setNotificationPrefs,
  useNotices,
  type NotificationPrefs,
} from '@/data/notifications';
import type { NeedsYouItem } from '@/data/needs-you';
import { TURN_END_HOLD_MS } from '@/data/notice-tiers';
import type { DaemonEvent } from '@/data/sync';
import { NotificationsPage } from '@/screens/settings/NotificationsPage';
import { hitGroups } from '@/screens/settings/settings-jump';
import { useSettingsView } from '@/screens/settings/view';
import { useShell } from '@/store';
import { t } from '@/i18n';
import { zh } from './i18n-setup.js';

const say = (id: string) => zh(`settings.notifications.${id}`);

const listed = (id: string): WorkbenchSession => ({
  id,
  created_at: '2026-01-01T00:00:00.000Z',
  title: `title of ${id}`,
  runtime: 'fixture',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: `workspace-${id}`,
  workspace_kind: 'linked_worktree',
  state: 'idle',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-01-01T00:00:00.000Z',
  changes: null,
  merge: null,
});

let sequence = 0;
const event = (
  kind: string,
  aggregate_id: string,
  payload: unknown = {},
  project_id = 'project-a',
): DaemonEvent => ({
  sequence: ++sequence,
  event_id: `event-${sequence}`,
  kind,
  aggregate_id,
  aggregate_revision: 1,
  project_id,
  causation_id: '',
  created_at: sequence,
  payload,
});
const reviewable = () => event('turn.completed', 'turn-a');
const failed = () => event('turn.failed', 'turn-a', { error: 'boom' });
const merged = () => event('session.merged', 'session-a', { files: 1, additions: 2, deletions: 0 });
const approval = (session_id = 'session-b', project_id = 'project-b'): NeedsYouItem => ({
  source: { table: 'approvals', id: `approval-of-${session_id}`, revision: 1 },
  kind: 'permission',
  project_id,
  session_id,
  status: 'pending',
  created_at: 0,
  reason: 'permission_requested',
  actions: [],
  binding: { action: 'Bash', input_summary: 'pnpm test' },
});
const asks = (session_id: string, project_id: string): NeedsYouItem => ({
  ...approval(session_id, project_id),
  source: { table: 'approvals', id: `question-of-${session_id}`, revision: 1 },
  binding: { action: 'AskUserQuestion' },
  questions: [{ question: 'Which package manager?', header: '', options: [], multiSelect: false }],
});
const question = () => asks('session-b', 'project-b');
const off = { system: false, sound: false };

let notify: ReturnType<typeof vi.fn>;
let focused: boolean;
let stored: Map<string, string>;
// Mounts the notices, then delivers the events after the first look, past the hold of a turn end.
function deliver(...events: DaemonEvent[]) {
  const h = mount(() => useNotices('project-a', [listed('session-a')]));
  mock.board = { ...mock.board, events };
  h.render();
  vi.advanceTimersByTime(TURN_END_HOLD_MS);
}
// Mounts the notices, then lists the needs-you items after the first read.
function list(...items: NeedsYouItem[]) {
  let all: NeedsYouItem[] = [];
  const h = mount(() => useNotices('project-a', [listed('session-a')], all));
  all = items;
  h.render();
}
const sentBodies = () => notify.mock.calls.map(([notice]) => notice.body as string);
const prefsWith = (events: Partial<NotificationPrefs['events']>) => ({
  events: { ...DEFAULT_NOTIFICATIONS.events, ...events },
});
const labelled = (tree: unknown, label: string) =>
  find(tree as never, (n) => n.props['aria-label'] === label);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  notify = vi.fn(async () => {});
  focused = false;
  stored = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
  vi.stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false }),
    pantheon: {
      notify,
      keepAwake: async () => {},
      onNotificationClick: () => () => {},
      query: async () => ({ ok: true, value: [] }),
    },
  });
  vi.stubGlobal('document', { hasFocus: () => focused });
  useShell.setState({ screen: 'board' });
  mock.board = {
    board: {
      cursor: 0,
      projects: [
        { id: 'project-a', name: 'Alpha' },
        { id: 'project-b', name: 'Beta' },
      ],
      sessions: [],
      session_turns: [{ id: 'turn-a', session_id: 'session-a', project_id: 'project-a' }],
    },
    events: [],
    resync: 0,
    status: { state: 'live' },
  };
});
afterEach(() => {
  unmountAll();
  setNotificationPrefs(DEFAULT_NOTIFICATIONS);
  useSettingsView.setState({ page: 'general', query: '' });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('notification preferences', () => {
  it('turn every system notification on and give sound to approvals, questions and failures', () => {
    const { events } = DEFAULT_NOTIFICATIONS;
    expect(Object.values(events).every((d) => d.system)).toBe(true);
    expect(
      Object.entries(events)
        .filter(([, d]) => d.sound)
        .map(([name]) => name),
    ).toEqual([
      'approval_requested',
      'question_asked',
      'turn_failed',
      'gate_failed',
      'merge_blocked',
    ]);
    expect(DEFAULT_NOTIFICATIONS).toMatchObject({
      quiet_hours: false,
      quiet_start: '22:00',
      quiet_end: '08:00',
      badge: true,
      keep_awake: true,
    });
  });

  it('read unreadable, invalid or old-shaped data as the defaults', () => {
    expect(readNotificationPrefs(null)).toEqual(DEFAULT_NOTIFICATIONS);
    expect(readNotificationPrefs('{not json')).toEqual(DEFAULT_NOTIFICATIONS);
    expect(
      readNotificationPrefs(
        JSON.stringify({
          events: { merged: { system: 'yes', sound: 1 } },
          quiet_hours: 'on',
          quiet_start: '25:00',
        }),
      ),
    ).toEqual(DEFAULT_NOTIFICATIONS);
    expect(
      readNotificationPrefs(
        JSON.stringify({
          modes: { needs_you: 'off', turn_end: 'off', failure: 'off', decision: 'off' },
          foreground: true,
        }),
      ),
    ).toEqual(DEFAULT_NOTIFICATIONS);
  });

  it('ignore what the earlier storage key holds', async () => {
    stored.set(
      'pantheon.notifications.v1',
      JSON.stringify({ modes: { needs_you: 'off' }, foreground: true, badge: false }),
    );
    (window.pantheon as any).setMenuShortcuts = () => {};
    vi.resetModules();
    const fresh = await import('@/data/notifications');
    expect(fresh.getNotificationPrefs()).toEqual(DEFAULT_NOTIFICATIONS);
  });
});

describe('notices by event and delivery', () => {
  it('sends nothing for an event whose system notification is off, and still sends the others', () => {
    setNotificationPrefs(prefsWith({ turn_completed: { system: false, sound: false } }));
    deliver(reviewable(), merged());
    expect(sentBodies()).toEqual(['已合并：1 个文件 +2 −0']);
  });

  it('sends a notice without sound for an event whose sound is off', () => {
    deliver(reviewable(), failed());
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[0]![0]).not.toHaveProperty('silent');
    expect(notify.mock.calls[1]![0]).toMatchObject({
      body: zh('data.notifications.turnEnded'),
      silent: true,
    });
  });

  it('sends nothing while the app is in front', () => {
    focused = true;
    deliver(reviewable(), failed(), merged());
    list(approval());
    expect(notify).not.toHaveBeenCalled();
  });

  it.each([
    [
      'counts a request that asks questions as a question, not as an approval',
      'question_asked',
      'pnpm test',
    ],
    ['still sends a question with approvals off', 'approval_requested', 'Which package manager?'],
  ] as const)('%s', (_name, quiet, body) => {
    setNotificationPrefs(prefsWith({ [quiet]: off }));
    list(question(), approval());
    expect(sentBodies()).toEqual([body]);
  });

  it('notifies a question of the current project by the question switch', () => {
    const asked = (prefs: Partial<NotificationPrefs>) => {
      notify.mockClear();
      setNotificationPrefs(prefs);
      list(asks('session-a', 'project-a'));
      return sentBodies();
    };
    expect(asked(prefsWith({ question_asked: off }))).toEqual([]);
    expect(asked(prefsWith({ approval_requested: off }))).toEqual(['Which package manager?']);
  });
});

describe('quiet hours', () => {
  const at = (hours: number, minutes: number) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date(2026, 0, 5, hours, minutes));
  };

  it.each([
    [23, 30, 0],
    [7, 59, 0],
    [8, 0, 1],
    [12, 0, 1],
  ])('from 22:00 to 08:00 at %i:%i sends %i notices', (hours, minutes, count) => {
    at(hours, minutes);
    setNotificationPrefs({ quiet_hours: true });
    deliver(failed());
    expect(notify).toHaveBeenCalledTimes(count);
  });

  it('send at any time while turned off', () => {
    for (const [hours, minutes] of [
      [23, 30],
      [7, 59],
    ] as const) {
      at(hours, minutes);
      notify.mockClear();
      deliver(failed());
      expect(notify).toHaveBeenCalledTimes(1);
    }
  });
});

describe('the notifications page', () => {
  const page = () => mount(() => NotificationsPage()).value as ReactNode;
  const EVENTS = [
    'approvalRequested',
    'questionAsked',
    'turnCompleted',
    'readyForReview',
    'merged',
    'turnFailed',
    'gateFailed',
    'mergeBlocked',
  ].map(say);
  const cellOf = (event: string, delivery: string) =>
    t(
      { id: 'settings.notifications.cell', defaultMessage: '{event}, {delivery}' },
      { event, delivery },
    );
  const cell = (event: string, delivery: string) => cellOf(say(event), say(delivery));

  it('lays the events and the ways they arrive out as a table of switches', () => {
    const tree = page();
    const table = find(tree, (n) => n.type === 'table');
    const headers = nodes(table).filter((n) => n.type === 'th');
    expect(headers.filter((n) => n.props.scope === 'col').map((n) => text(n))).toEqual(
      ['event', 'inApp', 'system', 'sound'].map(say),
    );
    const names = headers
      .filter((n) => n.props.scope === 'row')
      .map((n) => text(find(n, (c) => c.props.className === 'ps-row-nm').props.children[0]));
    expect(names).toEqual(EVENTS);
    const switches = nodes(table).filter((n) => n.type === 'input');
    expect(switches.map((n) => [n.props.type, n.props['aria-label']])).toEqual(
      EVENTS.flatMap((name) =>
        ['inApp', 'system', 'sound'].map((way) => ['checkbox', cellOf(name, say(way))]),
      ),
    );
  });

  it('says under an event what it stands for where the name alone does not', () => {
    const hints = nodes(find(page(), (n) => n.type === 'tbody'))
      .filter((n) => n.type === 'tr')
      .map((row) => {
        const hint = nodes(row).find((n) => n.props.className === 'ps-row-hint');
        return hint ? text(hint) : null;
      });
    expect(hints).toEqual([
      say('approvalRequestedHint'),
      null,
      null,
      say('readyForReviewHint'),
      null,
      null,
      say('gateFailedHint'),
      null,
    ]);
  });

  it('keeps an in-app choice per event apart from its system notification', () => {
    const approvalInApp = cell('approvalRequested', 'inApp');
    expect(labelled(page(), approvalInApp).props.checked).toBe(true);
    labelled(page(), approvalInApp).props.onChange({ target: { checked: false } });
    const prefs = getNotificationPrefs();
    expect(prefs.in_app).toEqual({ ...DEFAULT_NOTIFICATIONS.in_app, approval_requested: false });
    expect(prefs.events).toEqual(DEFAULT_NOTIFICATIONS.events);
    expect(labelled(page(), approvalInApp).props.checked).toBe(false);
    expect(readNotificationPrefs(JSON.stringify(prefs)).in_app.approval_requested).toBe(false);
    expect(Object.values(DEFAULT_NOTIFICATIONS.in_app).every(Boolean)).toBe(true);
    expect(readNotificationPrefs(JSON.stringify({ in_app: { merged: 'no' } })).in_app).toEqual(
      DEFAULT_NOTIFICATIONS.in_app,
    );
  });

  it('turns quiet hours on with a typed time and off with an emptied one, without a switch', () => {
    const host = mount(() => NotificationsPage());
    const [start, end] = [say('quietStart'), say('quietEnd')];
    const times = () =>
      nodes(host.value as ReactNode).filter(
        (n) => n.type === 'input' && [start, end].includes(n.props['aria-label']),
      );
    const type = (label: string, value: string) => {
      labelled(host.value, label).props.onChange({ target: { value } });
      host.render();
      labelled(host.value, label).props.onBlur();
      host.render();
    };
    expect(times().map((n) => [n.props['aria-label'], n.props.value, n.props.placeholder])).toEqual(
      [
        [start, '', '22:00'],
        [end, '', '08:00'],
      ],
    );
    expect(
      nodes(host.value as ReactNode).filter(
        (n) => n.type === 'input' && n.props['aria-label'] === say('quietHours'),
      ),
    ).toEqual([]);
    type(start, '21:30');
    expect(getNotificationPrefs()).toMatchObject({ quiet_hours: true, quiet_start: '21:30' });
    expect(times().map((n) => n.props.value)).toEqual(['21:30', '08:00']);
    type(end, '7:00');
    expect(getNotificationPrefs()).toMatchObject({ quiet_hours: true, quiet_end: '07:00' });
    type(end, '25:00');
    expect(getNotificationPrefs().quiet_end).toBe('07:00');
    expect(times().map((n) => n.props.value)).toEqual(['21:30', '07:00']);
    type(start, '');
    expect(getNotificationPrefs()).toMatchObject({ quiet_hours: false, quiet_start: '21:30' });
    expect(times().map((n) => [n.props.value, n.props.placeholder])).toEqual([
      ['', '21:30'],
      ['', '07:00'],
    ]);
  });

  it('says quiet hours leave only the session list markers, and sends the test from a small button', () => {
    const tree = page();
    const quiet = find(
      tree,
      (n) => typeof n.type === 'function' && n.props.settingId === 'notifications.quietHours',
    );
    expect(quiet.props.hint).toBe(say('quietHoursHint'));
    const send = find(tree, (n) => n.type === 'button' && text(n.props.children) === say('send'));
    expect(send.props.className).toBe('btn sm');
  });

  it('names the count switch after the app icon, which every system has', () => {
    const badge = find(
      page(),
      (n) => typeof n.type === 'function' && n.props.settingId === 'notifications.badge',
    );
    expect(badge.props.label).toBe(say('badge'));
    expect(labelled(page(), say('badge')).props.checked).toBe(true);
    expect(hitGroups('应用图标').map((g) => g.page)).toEqual(['notifications']);
  });

  it('changes one event and disables its sound while its system notification is off', () => {
    labelled(page(), cell('approvalRequested', 'system')).props.onChange({
      target: { checked: false },
    });
    expect(getNotificationPrefs().events.approval_requested.system).toBe(false);
    const sound = labelled(page(), cell('approvalRequested', 'sound'));
    expect(sound.props).toMatchObject({ disabled: true, checked: false });
    expect(labelled(page(), cell('merged', 'sound')).props.disabled).toBe(false);
  });
});
