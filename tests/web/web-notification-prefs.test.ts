import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ATTENTION_DELIVERY,
  type AppSettings,
  type WorkbenchSession,
} from '@pantheon/protocol';
import { mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import {
  badgeCount,
  DEFAULT_NOTIFICATIONS,
  readNotificationPrefs,
  setNotificationPrefs,
  useNotices,
} from '@/data/notifications';
import type { NeedsYouItem } from '@/data/needs-you';
import { TURN_END_HOLD_MS } from '@/data/notice-tiers';
import type { DaemonEvent } from '@/data/sync';
import { useShell } from '@/store';

const listed = (id: string, extra: Partial<WorkbenchSession> = {}): WorkbenchSession => ({
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
  ...extra,
});
const completed = (sequence: number): DaemonEvent => ({
  sequence,
  event_id: `event-${sequence}`,
  kind: 'turn.completed',
  aggregate_id: 'turn-a',
  aggregate_revision: 1,
  project_id: 'project-a',
  causation_id: '',
  created_at: sequence,
  payload: {},
});

let notify: ReturnType<typeof vi.fn>;
// The daemon's delivery rules app.settings answers with.
let rules: Partial<AppSettings['attention_delivery']>;
let keepAwake: ReturnType<typeof vi.fn>;
let focused: boolean;
const notices = (sessions: WorkbenchSession[]) => mount(() => useNotices('project-a', sessions));
// Mounts the notices, then delivers one turn end of a session no screen shows, past its hold.
function turnEnd() {
  const h = notices([listed('session-a')]);
  mock.board = { ...mock.board, events: [completed(1)] };
  h.render();
  vi.advanceTimersByTime(TURN_END_HOLD_MS);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  notify = vi.fn(async () => {});
  keepAwake = vi.fn(async () => {});
  focused = false;
  rules = {};
  vi.stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    pantheon: {
      notify,
      keepAwake,
      onNotificationClick: () => () => {},
      query: async (method: string) => ({
        ok: true,
        value:
          method === 'app.settings'
            ? { attention_delivery: { ...DEFAULT_ATTENTION_DELIVERY, ...rules } }
            : [],
      }),
    },
  });
  vi.stubGlobal('document', { hasFocus: () => focused });
  useShell.setState({ screen: 'board' });
  mock.board = {
    board: {
      cursor: 0,
      projects: [{ id: 'project-a', name: 'Alpha' }],
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('notification preferences', () => {
  it('keep each valid stored field and default the others', () => {
    expect(readNotificationPrefs(null)).toEqual(DEFAULT_NOTIFICATIONS);
    expect(
      readNotificationPrefs(
        JSON.stringify({
          sound: false,
          keep_awake: 'no',
          quiet_end: '07:30',
        }),
      ),
    ).toEqual({ ...DEFAULT_NOTIFICATIONS, sound: false });
  });

  it('sends a turn end however the sound is set', () => {
    setNotificationPrefs({ sound: false });
    turnEnd();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ silent: true }));
  });

  it('sends no baseline wait notice with permissions set to never, and one set to now', async () => {
    const baseline = { workspace_id: null };
    const wait = async () => {
      let sessions = [listed('session-b', { ...baseline, state: 'running' })];
      const h = mount(() => useNotices('project-a', sessions));
      await h.flush();
      sessions = [listed('session-b', { ...baseline, state: 'waiting' })];
      h.render();
    };
    rules = { permission: 'never' };
    await wait();
    expect(notify).not.toHaveBeenCalled();
    rules = {};
    await wait();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('sends a turn end without sound by default', () => {
    turnEnd();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ silent: true }));
  });

  it('keeps a turn end silent with the sound on', () => {
    setNotificationPrefs({ sound: true });
    turnEnd();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toMatchObject({ silent: true });
  });

  it('gives no turn end while the window is in front by default', () => {
    focused = true;
    turnEnd();
    expect(notify).not.toHaveBeenCalled();
  });

  it('clears the badge when it is turned off', () => {
    const items = [
      { project_id: 'project-b', source: { table: 'approvals' }, status: 'pending' },
    ] as unknown as NeedsYouItem[];
    expect(badgeCount(items)).toBe(1);
    setNotificationPrefs({ badge: false });
    expect(badgeCount(items)).toBe(0);
  });

  it('tells the desktop app how many sessions run and whether to keep awake', () => {
    mock.board = {
      ...mock.board,
      board: { ...mock.board.board, sessions: [{ id: 'a', state: 'running' }, { state: 'open' }] },
    };
    const h = notices([]);
    expect(keepAwake).toHaveBeenLastCalledWith({ enabled: true, running: 1 });
    setNotificationPrefs({ keep_awake: false });
    h.render();
    expect(keepAwake).toHaveBeenLastCalledWith({ enabled: false, running: 1 });
  });
});
