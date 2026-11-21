import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { NewSession } from '@/screens/sessions/SessionsScreen';
import { useShell } from '@/store';

const project = (id: string, name: string, extra: object = {}) => ({ id, name, ...extra });
const recent = {
  id: 'session-r',
  created_at: '2026-01-01T00:00:00.000Z',
  title: 'Recent work',
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-r',
  workspace_kind: 'linked_worktree',
  state: 'idle',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-01-01T00:00:00.000Z',
  changes: null,
  merge: null,
} as const;

const open = () =>
  mount(() =>
    NewSession({
      projectId: 'project-a',
      defaults: undefined,
      focus: 0,
      onCreated: () => {},
      recent: [recent],
      onOpen: () => {},
      onClose: () => {},
    }),
  );
const classed = (n: ReactElement<any>, name: string) =>
  String(n.props.className ?? '')
    .split(' ')
    .includes(name);

beforeEach(() => {
  mock.board = {
    board: {
      cursor: 1,
      projects: [
        project('project-a', 'Pantheon'),
        project('project-b', 'Atlas'),
        project('project-gone', 'Gone', { removed_at: 5 }),
      ],
    },
    events: [],
    status: { state: 'live' },
    resync: 0,
  };
  vi.stubGlobal('window', {
    pantheon: {
      query: vi.fn(async () => ({ ok: false, error: { code: 'unknown_route', message: '' } })),
      command: vi.fn(),
    },
    addEventListener() {},
    removeEventListener() {},
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

it('offers the project as a menu where the session starts, under one neutral question', () => {
  const h = open();
  const trigger = find(
    h.value,
    (n) => n.props['aria-label'] === zh('sessions.composer.newSessionProject'),
  );
  expect(text(trigger)).toContain('Pantheon');
  const headings = nodes(h.value).filter((n) => /^h[1-6]$/.test(String(n.type)));
  expect(headings.map(text)).toEqual([zh('sessions.composer.heroQuestion')]);
  expect(nodes(h.value).some((n) => classed(n, 'ss-opj') || classed(n, 'ss-head'))).toBe(false);
});

it('opens the new-session composer of the project picked in the menu', () => {
  const openProjectSession = vi.fn();
  useShell.setState({ openProjectSession });
  const h = open();
  // The first menu is the project picker; the start point menu follows it.
  const popup = find(h.value, (n) => n.props.className === 'wmenu pjm pop');
  const items = nodes(popup).filter((n) => n.props.value !== undefined && n.props.closeOnClick);
  expect(items.map((n) => n.props.value)).toEqual(['project-a', 'project-b']);
  expect(named(items[1]!, 'ProjectMonogram').props).toMatchObject({ id: 'project-b' });
  // The radio group marks the project the new session starts in.
  find(h.value, (n) => n.props.value === 'project-a' && !n.props.closeOnClick);
  items[1]!.props.onClick();
  expect(openProjectSession).toHaveBeenCalledWith('project-b', '');
});

it('ages the sessions in progress as time passes without other renders', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(Date.parse(recent.last_activity_at) + 5 * 60_000);
  try {
    const h = open();
    find(
      h.value,
      (n) => n.props['aria-label'] === zh('sessions.composer.firstMessage'),
    ).props.onChange({
      target: { value: '' },
    });
    h.render();
    await h.flush();
    const age = () => text(find(h.value, (n) => classed(n, 'cr-meta')));
    const first = age();
    vi.advanceTimersByTime(60_000);
    await h.flush();
    expect(age()).not.toBe(first);
  } finally {
    vi.useRealTimers();
  }
});

it('holds the message box and its model menu in the new-session dialog', () => {
  const h = open();
  const dialog = find(h.value, (n) => n.props['aria-label'] === zh('sessions.composer.newSession'));
  expect(
    nodes(dialog).some((n) => n.props['aria-label'] === zh('sessions.composer.firstMessage')),
  ).toBe(true);
  expect(named(dialog, 'ModelMenu').props.mode).toBe('ask');
});
