import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Session } from '@pantheon/domain';
import { mount, unmountAll } from './web-hook-host.js';
// The window modules see on import, so the keys another window stores reach this one.
const storage = vi.hoisted(() => {
  const listeners: ((e: { key: string | null; newValue: string | null }) => void)[] = [];
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: (typeof listeners)[number]) =>
      type === 'storage' && listeners.push(fn),
    removeEventListener() {},
  });
  return { listeners };
});
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
import { rebindable, resetShortcuts, setShortcut, SHORTCUTS_KEY } from '@/lib/shortcuts';
import { useQueued, type QueuedMessage } from '@/screens/sessions/parts';
import { QueueDock } from '@/screens/sessions/QueueDock';

const running: Session = {
  id: 'session-a',
  revision: 2,
  project_id: 'project-a',
  runtime: 'claude',
  state: 'running',
  turn_count: 1,
};
const message = (text: string): QueuedMessage => ({ text, attachments: [], skills: [] });

type Listener = (e: KeyboardEvent) => void;
let keydown: Listener[] = [];
let command: ReturnType<typeof vi.fn>;
const dock = (session: Session = running) => mount(() => QueueDock({ session }));
const press = (key: string, mods: Partial<KeyboardEvent> = {}) => {
  const e = {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target: { tagName: 'BODY' },
    preventDefault: vi.fn(),
    ...mods,
  } as unknown as KeyboardEvent;
  for (const listener of [...keydown]) listener(e);
};

beforeEach(() => {
  useQueued.setState({ queued: { 'session-a': [message('one'), message('two')] }, failures: {} });
  mock.board = { board: { cursor: 1, projects: [] }, events: [], resync: 0, refresh() {} };
  command = vi.fn(async () => ({ ok: true, value: {} }));
  keydown = [];
  vi.stubGlobal('window', {
    pantheon: { command, query: vi.fn(async () => ({ ok: true, value: [] })) },
    addEventListener: (type: string, fn: Listener) => type === 'keydown' && keydown.push(fn),
    removeEventListener: (type: string, fn: Listener) => {
      if (type === 'keydown') keydown = keydown.filter((l) => l !== fn);
    },
  });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
});
afterEach(() => {
  unmountAll();
  resetShortcuts();
  vi.unstubAllGlobals();
});

const steered = () =>
  command.mock.calls.filter(([c]) => c.type === 'session.steer').map(([c]) => c.input.input);

it('lets the user record keys for steering with a queued message now', () => {
  expect(rebindable('steer-now')).toBe(true);
  expect(setShortcut('steer-now', 'Meta+Shift+S')).toBeNull();
});

it('steers with the oldest queued message on the recorded keys', async () => {
  setShortcut('steer-now', 'Meta+Shift+S');
  const h = dock();
  press('S', { metaKey: true, shiftKey: true });
  await h.flush();
  expect(steered()).toEqual(['one']);
  expect(useQueued.getState().queued['session-a']).toEqual([message('two')]);
});

it('steers on no keys until some are recorded, and not when the session cannot take one', async () => {
  const h = dock();
  press('S', { metaKey: true, shiftKey: true });
  setShortcut('steer-now', 'Meta+Shift+S');
  const idle = dock({ ...running, state: 'reconciling' });
  press('S', { metaKey: true, shiftKey: true });
  await h.flush();
  await idle.flush();
  expect(steered()).toEqual([]);
});

it('follows keys another window records, without a reload', async () => {
  storage.listeners.forEach((listener) =>
    listener({ key: SHORTCUTS_KEY, newValue: JSON.stringify({ 'steer-now': 'Meta+Alt+S' }) }),
  );
  const h = dock();
  press('ß', { metaKey: true, altKey: true, code: 'KeyS' });
  await h.flush();
  expect(steered()).toEqual(['one']);
});
