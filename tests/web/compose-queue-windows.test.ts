import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Session } from '@pantheon/domain';
import { mount, unmountAll } from './web-hook-host.js';

type Change = { key: string; newValue: string | null };

// Two windows share one storage; each hears the other's changes only when the test lets it.
const mock = vi.hoisted(() => {
  const state = {
    board: {} as any,
    command: (async () => ({ ok: true, value: {} })) as (...args: any[]) => Promise<unknown>,
    items: new Map<string, string>(),
    /** The window whose modules load or act now. */
    current: '',
    listeners: new Map<string, Set<(event: any) => void>>(),
    /** The storage changes each window has not heard yet. */
    unheard: new Map<string, Change[]>(),
  };
  const changed = (key: string, newValue: string | null) => {
    for (const [name, changes] of state.unheard)
      if (name !== state.current) changes.push({ key, newValue });
  };
  Object.assign(globalThis, {
    window: {
      pantheon: {
        command: (...args: any[]) => state.command(...args),
        setMenuShortcuts: async () => ({ ok: true, value: null }),
      },
      addEventListener: (type: string, listener: (event: any) => void) => {
        if (type === 'storage') state.listeners.get(state.current)?.add(listener);
      },
      removeEventListener: () => {},
    },
    localStorage: {
      get length() {
        return state.items.size;
      },
      key: (i: number) => [...state.items.keys()][i] ?? null,
      getItem: (key: string) => state.items.get(key) ?? null,
      setItem: (key: string, value: string) => {
        state.items.set(key, value);
        changed(key, value);
      },
      removeItem: (key: string) => {
        state.items.delete(key);
        changed(key, null);
      },
    },
  });
  return state;
});
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
// Loaded once before any window, so every window's hooks run in this file's hook host.
import 'react';

type Compose = typeof import('@/screens/sessions/compose');

const idle: Session = {
  id: 'session-a',
  revision: 2,
  project_id: 'project-a',
  runtime: 'claude',
  state: 'open',
  turn_count: 1,
};
const message = (text: string) => ({ text, attachments: [], skills: [] });

/** A window opens: its modules load afresh, read what storage holds and listen for changes. */
async function openWindow(name: string): Promise<Compose> {
  mock.current = name;
  mock.listeners.set(name, new Set());
  mock.unheard.set(name, []);
  vi.resetModules();
  return await import('@/screens/sessions/compose');
}

/** Runs what the window does, so the storage changes it makes are its own. */
function inWindow<T>(name: string, act: () => T): T {
  mock.current = name;
  return act();
}

/** The window hears the storage changes the other windows made since it last heard. */
function hear(name: string) {
  const changes = mock.unheard.get(name)!.splice(0);
  mock.current = name;
  for (const change of changes) for (const listener of mock.listeners.get(name)!) listener(change);
}

const texts = (compose: Compose) =>
  (compose.useQueued.getState().queued['session-a'] ?? []).map((m) => m.text);

let command: ReturnType<typeof vi.fn<(...args: any[]) => Promise<unknown>>>;
beforeEach(() => {
  mock.items.clear();
  mock.listeners.clear();
  mock.unheard.clear();
  command = vi.fn(async () => ({ ok: true, value: {} }));
  mock.command = command;
  mock.board = {
    board: { cursor: 1, projects: [], sessions: [idle] },
    events: [],
    resync: 0,
    refresh() {},
  };
});
afterEach(() => {
  unmountAll();
});

it('keeps the messages two windows queue before hearing of each other', async () => {
  const main = await openWindow('main');
  const other = await openWindow('other');
  inWindow('main', () => main.useQueued.getState().add('session-a', message('one')));
  inWindow('other', () => other.useQueued.getState().add('session-a', message('two')));
  hear('main');
  hear('other');
  // Queued at the same moment, the two have no order of their own; every window shows the same.
  expect([...texts(main)].sort()).toEqual(['one', 'two']);
  expect(texts(other)).toEqual(texts(main));
  expect(texts(await openWindow('later'))).toEqual(texts(main));
});

it('keeps a message withdrawn in one window gone while the other queues another', async () => {
  const main = await openWindow('main');
  inWindow('main', () => main.useQueued.getState().add('session-a', message('one')));
  const other = await openWindow('other');
  inWindow('other', () => other.useQueued.getState().remove('session-a', 0));
  inWindow('main', () => main.useQueued.getState().add('session-a', message('two')));
  hear('main');
  hear('other');
  expect(texts(main)).toEqual(['two']);
  expect(texts(other)).toEqual(['two']);
  expect(texts(await openWindow('later'))).toEqual(['two']);
});

it('sends a queued message once though another window queues one before hearing it went', async () => {
  const main = await openWindow('main');
  inWindow('main', () => main.useQueued.getState().add('session-a', message('one')));
  const other = await openWindow('other');
  const h = inWindow('main', () => mount(() => main.useQueueDispatch()));
  await h.flush();
  expect(command.mock.calls.map(([c]) => c.input.input)).toEqual(['one']);
  inWindow('other', () => other.useQueued.getState().add('session-a', message('two')));
  hear('main');
  hear('other');
  expect(texts(main)).toEqual(['two']);
  expect(texts(other)).toEqual(['two']);
  // The sent message's turn ran and the session is idle again.
  mock.board.board.sessions = [{ ...idle, revision: 3, turn_count: 2 }];
  inWindow('main', () => h.render());
  await h.flush();
  expect(command.mock.calls.map(([c]) => c.input.input)).toEqual(['one', 'two']);
  expect(texts(main)).toEqual([]);
});
