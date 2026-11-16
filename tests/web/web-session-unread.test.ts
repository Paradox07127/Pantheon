import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchSession } from '@pantheon/protocol';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';
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
import { isUnread, markUnread, useUnread } from '@/data/unread';
import { SessionListRow, SessionRowButton } from '@/screens/sessions/SessionsScreen';

const menu = (key: string) => zh(`sessions.model.menu.${key}`);

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

const session = (id: string, minute: number): WorkbenchSession => ({
  id,
  created_at: at(0),
  title: `title of ${id}`,
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: `workspace-${id}`,
  workspace_kind: 'linked_worktree',
  state: 'idle',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: at(minute),
  changes: null,
  merge: null,
});

let stored: Map<string, string>;
let focus: boolean;
let listeners: Map<string, (() => void)[]>;
const fire = (type: string) => listeners.get(type)?.forEach((run) => run());
const target = {
  addEventListener: (type: string, run: () => void) =>
    listeners.set(type, [...(listeners.get(type) ?? []), run]),
  removeEventListener: (type: string, run: () => void) =>
    listeners.set(
      type,
      (listeners.get(type) ?? []).filter((r) => r !== run),
    ),
};

beforeEach(() => {
  stored = new Map();
  focus = true;
  listeners = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  vi.stubGlobal('window', target);
  vi.stubGlobal('document', { ...target, hasFocus: () => focus, visibilityState: 'visible' });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('unread sessions', () => {
  it('marks a session unread once its activity is newer than when it was seen', () => {
    let list = [session('a', 1)];
    const h = mount(() => useUnread('project-newer', list, null));
    expect(h.value(list[0]!)).toBe(false);
    list = [session('a', 2)];
    h.render();
    expect(h.value(list[0]!)).toBe(true);
    expect(stored.get('pantheon.unread.project-newer')).toContain(at(1));
  });

  it('marks the shown session read while the window has focus', () => {
    let list = [session('a', 1)];
    let shown: string | null = null;
    focus = false;
    const h = mount(() => useUnread('project-shown', list, shown));
    list = [session('a', 2)];
    shown = 'a';
    h.render();
    expect(h.value(list[0]!)).toBe(true);
    focus = true;
    fire('focus');
    h.render();
    expect(h.value(list[0]!)).toBe(false);
    list = [session('a', 3)];
    h.render();
    expect(h.value(list[0]!)).toBe(false);
    expect(JSON.parse(stored.get('pantheon.unread.project-shown')!)).toEqual({
      a: { seen_at: at(3), manual_unread: false },
    });
  });

  it('keeps a manual unread mark until the session is opened again', () => {
    let list = [session('a', 1), session('b', 1)];
    let shown = 'a';
    const h = mount(() => useUnread('project-manual', list, shown));
    markUnread('project-manual', list[0]!);
    h.render();
    expect(h.value(list[0]!)).toBe(true);
    list = [session('a', 2), session('b', 1)];
    fire('focus');
    h.render();
    expect(h.value(list[0]!)).toBe(true);
    shown = 'b';
    h.render();
    expect(h.value(list[0]!)).toBe(true);
    shown = 'a';
    h.render();
    expect(h.value(list[0]!)).toBe(false);
  });

  it('clears a manual mark when the session is shown again after another screen', () => {
    const list = [session('a', 1)];
    let shown: string | null = 'a';
    const h = mount(() => useUnread('project-return', list, shown));
    markUnread('project-return', list[0]!);
    h.render();
    shown = null;
    h.render();
    expect(h.value(list[0]!)).toBe(true);
    shown = 'a';
    h.render();
    expect(h.value(list[0]!)).toBe(false);
  });

  it('clears a manual mark when the shown session is opened again', () => {
    mock.shell = { sessionOpened: 1, sessionId: 'a' };
    const list = [session('a', 1)];
    const h = mount(() => useUnread('project-reopen', list, 'a'));
    markUnread('project-reopen', list[0]!);
    h.render();
    expect(h.value(list[0]!)).toBe(true);
    mock.shell = { sessionOpened: 2, sessionId: 'a' };
    h.render();
    expect(h.value(list[0]!)).toBe(false);
  });

  it('keeps the mark of the other pane when a session opens in this one', () => {
    mock.shell = { sessionOpened: 1, sessionId: 'a' };
    const list = [session('a', 1), session('b', 1), session('c', 1)];
    const h = mount(() => useUnread('project-panes', list, 'b'));
    markUnread('project-panes', list[1]!);
    h.render();
    expect(h.value(list[1]!)).toBe(true);
    mock.shell = { sessionOpened: 2, sessionId: 'c' };
    h.render();
    expect(h.value(list[1]!)).toBe(true);
  });

  it('counts a session without a record as read', () => {
    expect(isUnread(undefined, session('a', 9))).toBe(false);
    const h = mount(() => useUnread('project-fresh', [session('a', 9)], null));
    expect(h.value(session('a', 9))).toBe(false);
  });

  it('counts every session read when storage cannot be read', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    let list = [session('a', 1)];
    const h = mount(() => useUnread('project-broken', list, null));
    list = [session('a', 5)];
    markUnread('project-broken', list[0]!);
    h.render();
    expect(h.value(list[0]!)).toBe(false);
  });
});

describe('unread row', () => {
  it('hands the unread mark to the avatar only on an unread row', () => {
    const row = (unread: boolean) =>
      SessionRowButton({ session: session('a', 1), on: false, unread, now: 0, onSelect() {} });
    const avatar = (tree: unknown) =>
      find(tree as any, (n) => typeof n.type === 'function' && n.type.name === 'Avatar');
    expect(avatar(row(true)).props.unread).toBe(true);
    expect(avatar(row(false)).props.unread).toBe(false);
  });
});

describe('unread menu item', () => {
  beforeEach(() => {
    mock.board = {
      board: { sessions: [{ id: 'a', revision: 5, project_id: 'project-menu' }], workspaces: [] },
      events: [],
      status: { state: 'live' },
      refresh() {},
    };
    mock.shell = { sessionId: null, followFirstSession: vi.fn() };
  });
  const item = (tree: unknown, label: string) =>
    find(tree as any, (n) => n.props.onClick && text(n) === label && n.type !== 'button');

  it('toggles between marking unread and marking read, after pin and snooze', () => {
    const listed = session('a', 1);
    const h = mount(() => SessionListRow({ session: listed, on: false, now: 0, onSelect() {} }));
    const labels = () =>
      nodes(h.value)
        .filter((n) => n.props.onClick && typeof n.type !== 'string')
        .map((n) => text(n));
    // The read mark follows pin and snooze in the menu's second group.
    const marks = () =>
      labels().slice(labels().indexOf(menu('pin')), labels().indexOf(menu('pin')) + 3);
    expect(marks()).toEqual(['pin', 'snooze', 'markUnread'].map(menu));
    item(h.value, menu('markUnread')).props.onClick();
    h.render();
    expect(marks()).toEqual(['pin', 'snooze', 'markRead'].map(menu));
    expect(JSON.parse(stored.get('pantheon.unread.project-menu')!).a.manual_unread).toBe(true);
    item(h.value, menu('markRead')).props.onClick();
    h.render();
    expect(marks()).toEqual(['pin', 'snooze', 'markUnread'].map(menu));
    expect(item(h.value, menu('markUnread')).props.keys).toBeUndefined();
    expect(item(h.value, menu('pin')).props.keys).toBeUndefined();
  });
});
