import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import {
  ATTENTION_KINDS,
  DEFAULT_ATTENTION_DELIVERY,
  type AppSettings,
  type WorkbenchSession,
} from '@pantheon/protocol';
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
  EARLIER_NOTIFICATIONS_KEY,
  getNotificationPrefs,
  NOTIFICATIONS_KEY,
  readNotificationPrefs,
  setNotificationPrefs,
  useNotices,
} from '@/data/notifications';
import type { NeedsYouItem } from '@/data/needs-you';
import { TURN_END_HOLD_MS } from '@/data/notice-tiers';
import type { DaemonEvent } from '@/data/sync';
import { NotificationsPage } from '@/screens/settings/NotificationsPage';
import { hitGroups } from '@/screens/settings/settings-jump';
import { useSettingsView } from '@/screens/settings/view';
import { useShell } from '@/store';
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
const NOW = new Date(2026, 0, 5, 12, 0).getTime();
const HOUR = 3_600_000;
const approval = (session_id = 'session-b', project_id = 'project-b'): NeedsYouItem => ({
  source: { table: 'approvals', id: `approval-of-${session_id}`, revision: 1 },
  kind: 'permission',
  decision: 'permission',
  project_id,
  session_id,
  status: 'pending',
  created_at: NOW - 60_000,
  reason: 'permission_requested',
  actions: [],
  binding: { action: 'Bash', input_summary: 'pnpm test' },
});
const asks = (session_id: string, project_id: string): NeedsYouItem => ({
  ...approval(session_id, project_id),
  source: { table: 'approvals', id: `question-of-${session_id}`, revision: 1 },
  decision: 'question',
  binding: { action: 'AskUserQuestion' },
  questions: [{ question: 'Which package manager?', header: '', options: [], multiSelect: false }],
});
const question = () => asks('session-b', 'project-b');

const settingsWith = (
  delivery: Partial<AppSettings['attention_delivery']> = {},
  quiet_hours?: AppSettings['quiet_hours'],
): AppSettings => ({
  auto_git_init: true,
  auto_archive_merged: false,
  session_recap: true,
  attention_delivery: { ...DEFAULT_ATTENTION_DELIVERY, ...delivery },
  ...(quiet_hours && { quiet_hours }),
  baseline_rounds: 5,
  baseline_visuals: true,
  baseline_range_story: true,
  personal_answers: [],
});

let notify: ReturnType<typeof vi.fn>;
let command: ReturnType<typeof vi.fn>;
let focused: boolean;
let stored: Map<string, string>;
// What the daemon answers app.settings with.
let settings: AppSettings;
// Mounts the notices with the needs-you items given, reads the daemon's rules, then delivers the events after the first look, past the hold of a turn end.
async function deliverWith(items: NeedsYouItem[] | null, ...events: DaemonEvent[]) {
  const h = mount(() => useNotices('project-a', [listed('session-a')], items));
  await h.flush();
  mock.board = { ...mock.board, events };
  h.render();
  vi.advanceTimersByTime(TURN_END_HOLD_MS);
}
const deliver = (...events: DaemonEvent[]) => deliverWith(null, ...events);
// Mounts the notices, reads the daemon's rules, then lists the needs-you items after the first read.
async function list(...items: NeedsYouItem[]) {
  let all: NeedsYouItem[] = [];
  const h = mount(() => useNotices('project-a', [listed('session-a')], all));
  await h.flush();
  all = items;
  h.render();
}
const sentBodies = () => notify.mock.calls.map(([notice]) => notice.body as string);
const saved = () =>
  command.mock.calls
    .map(([sent]) => sent)
    .filter((sent) => sent.type === 'app.settings.set')
    .map((sent) => sent.input);
const labelled = (tree: unknown, label: string) =>
  find(tree as never, (n) => n.props['aria-label'] === label);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW);
  notify = vi.fn(async () => {});
  command = vi.fn(async () => ({ ok: true, value: {} }));
  focused = false;
  stored = new Map();
  settings = settingsWith();
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
      command,
      keepAwake: async () => {},
      onNotificationClick: () => () => {},
      query: async (method: string) => ({
        ok: true,
        value: method === 'app.settings' ? settings : [],
      }),
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
    refresh() {},
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
  it('keep only the sound, the badge and keeping awake on this computer, all on', () => {
    expect(DEFAULT_NOTIFICATIONS).toEqual({ sound: true, badge: true, keep_awake: true });
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

describe('notices by kind of decision and delivery', () => {
  it('sends nothing for a kind of decision set to brief or never, and still sends the others', async () => {
    settings = settingsWith({ question: 'brief' });
    await list(question(), approval());
    expect(sentBodies()).toEqual(['pnpm test']);
    notify.mockClear();
    settings = settingsWith({ permission: 'never' });
    await list(question(), approval());
    expect(sentBodies()).toEqual(['Which package manager?']);
  });

  it('sends a notice without sound for a turn end and with it for a failure', async () => {
    await deliver(reviewable(), failed());
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[0]![0]).not.toHaveProperty('silent');
    expect(notify.mock.calls[1]![0]).toMatchObject({
      body: zh('data.notifications.turnEnded'),
      silent: true,
    });
  });

  it('sends every notice without sound with the sound off', async () => {
    setNotificationPrefs({ sound: false });
    await deliver(failed());
    await list(approval());
    expect(notify.mock.calls.map(([notice]) => notice.silent)).toEqual([true, true]);
  });

  it('sends nothing while the app is in front', async () => {
    focused = true;
    await deliver(reviewable(), failed(), merged());
    await list(approval());
    expect(notify).not.toHaveBeenCalled();
  });

  it('still notifies a question set to never once it has waited over four hours', async () => {
    settings = settingsWith({ question: 'never' }, { from: '11:00', to: '13:00' });
    await list({ ...question(), created_at: NOW - 4 * HOUR - 1 }, approval());
    expect(sentBodies()).toEqual(['Which package manager?']);
  });

  it.each([
    ['a merge by default', {}, null, merged, 0],
    ['a merge set to now', { merged: 'now' }, null, merged, 1],
    ['a turn end with other set to never', { other: 'never' }, null, reviewable, 0],
    ['a failed turn with other set to never', { other: 'never' }, null, failed, 0],
    [
      'a turn end of a session asking, with question set to never',
      { question: 'never' },
      [asks('session-a', 'project-a')],
      reviewable,
      0,
    ],
    [
      'a turn end of a session asking, with question set to now and other to never',
      { other: 'never' },
      [asks('session-a', 'project-a')],
      reviewable,
      1,
    ],
  ] as const)('counts the notices sent for %s', async (_name, delivery, items, given, count) => {
    settings = settingsWith(delivery);
    await deliverWith(items && [...items], given());
    expect(notify).toHaveBeenCalledTimes(count);
  });

  it('holds a milestone to accept for the brief by default', async () => {
    mock.board.board.milestones = [{ id: 'milestone-1', title: 'Payments' }];
    const milestone: NeedsYouItem = {
      ...approval('', 'project-a'),
      source: { table: 'milestones', id: 'milestone-1', revision: 1 },
      kind: 'milestone.ready_for_acceptance',
      decision: 'milestone_accept',
      reason: 'milestone_ready_for_acceptance',
    };
    await list(milestone);
    expect(notify).not.toHaveBeenCalled();
    settings = settingsWith({ milestone_accept: 'now' });
    await list(milestone);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe('quiet hours', () => {
  const at = (hours: number, minutes: number) =>
    vi.setSystemTime(new Date(2026, 0, 5, hours, minutes));

  it.each([
    [23, 30, 0],
    [7, 59, 0],
    [8, 0, 1],
    [12, 0, 1],
  ])('from 22:00 to 08:00 at %i:%i sends %i notices', async (hours, minutes, count) => {
    at(hours, minutes);
    settings = settingsWith({}, { from: '22:00', to: '08:00' });
    await deliver(failed());
    expect(notify).toHaveBeenCalledTimes(count);
  });

  it('send at any time while not set', async () => {
    for (const [hours, minutes] of [
      [23, 30],
      [7, 59],
    ] as const) {
      at(hours, minutes);
      notify.mockClear();
      await deliver(failed());
      expect(notify).toHaveBeenCalledTimes(1);
    }
  });
});

describe('the preferences an earlier version stored', () => {
  const earlier = {
    events: {
      approval_requested: { system: true, sound: true },
      question_asked: { system: false, sound: true },
      turn_failed: { system: false, sound: true },
      gate_failed: { system: false, sound: true },
    },
    quiet_hours: true,
    quiet_start: '21:00',
    quiet_end: '07:00',
    badge: false,
    keep_awake: false,
  };
  const load = async () => {
    const h = mount(() => useNotices('project-a', [listed('session-a')]));
    await h.flush();
  };

  it('map once into the daemon while its rules are the defaults, then leave the earlier key', async () => {
    stored.set(EARLIER_NOTIFICATIONS_KEY, JSON.stringify(earlier));
    await load();
    expect(saved()).toEqual([
      {
        attention_delivery: { permission: 'now', question: 'brief', repeated_failure: 'brief' },
        quiet_hours: { from: '21:00', to: '07:00' },
      },
    ]);
    expect(stored.has(EARLIER_NOTIFICATIONS_KEY)).toBe(false);
    expect(JSON.parse(stored.get(NOTIFICATIONS_KEY)!)).toEqual(getNotificationPrefs());
    await load();
    expect(saved()).toHaveLength(1);
  });

  it.each([
    ['a merge switched off', { merged: false }, { merged: 'brief' }],
    [
      'both turn ends and reviews switched off',
      { turn_completed: false, ready_for_review: false },
      { other: 'brief' },
    ],
    ['only turn ends switched off', { turn_completed: false, ready_for_review: true }, {}],
    ['only reviews switched off', { ready_for_review: false }, {}],
  ])('map %s', async (_name, switches, expected) => {
    stored.set(
      EARLIER_NOTIFICATIONS_KEY,
      JSON.stringify({
        events: Object.fromEntries(
          Object.entries(switches).map(([event, system]) => [event, { system, sound: false }]),
        ),
      }),
    );
    await load();
    expect(saved()).toEqual([
      {
        attention_delivery: {
          permission: 'now',
          question: 'now',
          repeated_failure: 'now',
          ...expected,
        },
      },
    ]);
  });

  it('leave rules the user already chose in the daemon as they are', async () => {
    stored.set(EARLIER_NOTIFICATIONS_KEY, JSON.stringify(earlier));
    settings = settingsWith({ budget: 'never' });
    await load();
    expect(saved()).toEqual([]);
    expect(stored.has(EARLIER_NOTIFICATIONS_KEY)).toBe(false);
  });

  it('carry the badge and keeping awake over until the current key holds them', async () => {
    stored.set(EARLIER_NOTIFICATIONS_KEY, JSON.stringify(earlier));
    (window.pantheon as any).setMenuShortcuts = () => {};
    vi.resetModules();
    const fresh = await import('@/data/notifications');
    expect(fresh.getNotificationPrefs()).toEqual({ sound: true, badge: false, keep_awake: false });
  });
});

describe('the notifications page', () => {
  const page = async () => {
    const host = mount(() => NotificationsPage());
    await host.flush();
    return host;
  };
  // A save waits on the command and then on its answer.
  const settle = async (host: { flush: () => Promise<unknown> }) => {
    await host.flush();
    await host.flush();
  };
  // The radio group each delivery choice draws.
  const groups = (tree: unknown) =>
    nodes(tree as ReactNode)
      .filter((n) => typeof n.type === 'function' && n.type.name === 'DeliveryChoice')
      .map((n) => (n.type as (props: unknown) => ReactElement<any>)(n.props));
  const group = (tree: unknown, label: string) =>
    groups(tree).find((g) => g.props['aria-label'] === label)!;

  it('lists each kind of decision and merges by name with the stored choice chosen, then the locked row', async () => {
    settings = settingsWith({ question: 'brief', budget: 'never' });
    const all = groups((await page()).value);
    expect(all.map((g) => [g.props['aria-label'], g.props.value])).toEqual([
      [say('planChange'), 'now'],
      [say('question'), 'brief'],
      [say('repeatedFailure'), 'now'],
      [say('permission'), 'now'],
      [say('milestoneAccept'), 'brief'],
      [say('agentProposal'), 'brief'],
      [say('budget'), 'never'],
      [say('improvement'), 'now'],
      [say('external'), 'now'],
      [say('other'), 'now'],
      [say('merged'), 'brief'],
      [say('overdueQuestion'), 'now'],
    ]);
    expect(all).toHaveLength(ATTENTION_KINDS.length + 1);
    expect(
      nodes(all[0]!.props.children).map((n) => [n.props.value, text(n.props.children)]),
    ).toEqual([
      ['now', say('now')],
      ['brief', say('brief')],
      ['never', say('never')],
    ]);
  });

  it('sends only the kind chosen when a choice changes', async () => {
    const host = await page();
    group(host.value, say('question')).props.onValueChange('brief');
    await settle(host);
    expect(saved()).toEqual([{ attention_delivery: { question: 'brief' } }]);
    expect(group(host.value, say('question')).props.value).toBe('brief');
    expect(group(host.value, say('permission')).props.value).toBe('now');
  });

  it('keeps the row of a question waiting over four hours on now, beyond change', async () => {
    const host = await page();
    const locked = group(host.value, say('overdueQuestion'));
    expect(locked.props).toMatchObject({
      disabled: true,
      value: 'now',
      title: say('overdueReason'),
    });
    locked.props.onValueChange('never');
    await host.flush();
    expect(saved()).toEqual([]);
  });

  it('stands every choice empty and disabled until the settings are read', () => {
    const host = mount(() => NotificationsPage());
    expect(groups(host.value).map((g) => [g.props.value, g.props.disabled])).toEqual([
      ...ATTENTION_KINDS.map(() => [null, true]),
      ['now', true],
    ]);
  });

  it('sets quiet hours with a typed time and clears them with an emptied one or the clear button', async () => {
    const host = await page();
    const [start, end] = [say('quietStart'), say('quietEnd')];
    const times = () =>
      nodes(host.value as ReactNode).filter(
        (n) => n.type === 'input' && [start, end].includes(n.props['aria-label']),
      );
    const type = async (label: string, value: string) => {
      labelled(host.value, label).props.onChange({ target: { value } });
      host.render();
      labelled(host.value, label).props.onBlur();
      await settle(host);
    };
    expect(times().map((n) => [n.props['aria-label'], n.props.value, n.props.placeholder])).toEqual(
      [
        [start, '', '22:00'],
        [end, '', '08:00'],
      ],
    );
    expect(() => labelled(host.value, say('clearQuietHours'))).toThrow();
    await type(start, '21:30');
    await type(end, '7:00');
    await type(end, '25:00');
    expect(saved()).toEqual([
      { quiet_hours: { from: '21:30', to: '08:00' } },
      { quiet_hours: { from: '21:30', to: '07:00' } },
    ]);
    expect(times().map((n) => n.props.value)).toEqual(['21:30', '07:00']);
    labelled(host.value, say('clearQuietHours')).props.onClick();
    await settle(host);
    expect(saved().at(-1)).toEqual({ quiet_hours: null });
    expect(times().map((n) => n.props.value)).toEqual(['', '']);
    settings = settingsWith({}, { from: '21:30', to: '07:00' });
    const again = await page();
    labelled(again.value, start).props.onChange({ target: { value: '' } });
    again.render();
    labelled(again.value, start).props.onBlur();
    await settle(again);
    expect(saved().at(-1)).toEqual({ quiet_hours: null });
  });

  it('gives quiet hours no hint, and sends the test from a small button', async () => {
    const tree = (await page()).value;
    const quiet = find(
      tree,
      (n) => typeof n.type === 'function' && n.props.settingId === 'notifications.quietHours',
    );
    expect(quiet.props.hint).toBeUndefined();
    const send = find(tree, (n) => n.type === 'button' && text(n.props.children) === say('send'));
    expect(send.props.className).toBe('btn sm');
  });

  it('keeps the sound on this computer', async () => {
    const host = await page();
    labelled(host.value, say('sound')).props.onChange({ target: { checked: false } });
    expect(getNotificationPrefs().sound).toBe(false);
    host.render();
    expect(labelled(host.value, say('sound')).props.checked).toBe(false);
  });

  it('names the count switch after the app icon, which every system has', async () => {
    const tree = (await page()).value;
    const badge = find(
      tree,
      (n) => typeof n.type === 'function' && n.props.settingId === 'notifications.badge',
    );
    expect(badge.props.label).toBe(say('badge'));
    expect(labelled(tree, say('badge')).props.checked).toBe(true);
    expect(hitGroups('应用图标').map((g) => g.page)).toEqual(['notifications']);
  });
});
