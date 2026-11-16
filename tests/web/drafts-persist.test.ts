import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Session } from '@pantheon/domain';
import type { WorkbenchSession } from '@pantheon/protocol';
import { mount, unmountAll } from './web-hook-host.js';

// The window and its storage exist before the modules load, as in the app, so the modules'
// storage listeners are in place.
const mock = vi.hoisted(() => {
  const state = {
    board: {} as any,
    command: (async () => ({ ok: true, value: {} })) as (...args: any[]) => Promise<unknown>,
    items: new Map<string, string>(),
    listeners: new Set<(event: any) => void>(),
  };
  Object.assign(globalThis, {
    window: {
      pantheon: {
        command: (...args: any[]) => state.command(...args),
        setMenuShortcuts: async () => ({ ok: true, value: null }),
      },
      addEventListener: (type: string, listener: (event: any) => void) => {
        if (type === 'storage') state.listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: (event: any) => void) =>
        void state.listeners.delete(listener),
    },
    localStorage: {
      get length() {
        return state.items.size;
      },
      key: (i: number) => [...state.items.keys()][i] ?? null,
      getItem: (key: string) => state.items.get(key) ?? null,
      setItem: (key: string, value: string) => void state.items.set(key, value),
      removeItem: (key: string) => void state.items.delete(key),
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
import { draftKey, useDrafts } from '@/data/drafts';
import { useQueueDispatch, useQueued } from '@/screens/sessions/compose';

const idle: Session = {
  id: 'session-a',
  revision: 2,
  project_id: 'project-a',
  runtime: 'claude',
  state: 'open',
  turn_count: 1,
};
const message = (text: string) => ({ text, attachments: [], skills: [] });
const skill = { name: 'review', path: '/skills/review' };
const attachment = { id: 'attachment-a', name: 'notes.txt', mime: 'text/plain' };
const KEY = draftKey('project-a', 'session-a');
const referred: WorkbenchSession = {
  id: 'session-b',
  created_at: '2026-01-01T00:00:00.000Z',
  title: 'title of session-b',
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-b',
  workspace_kind: 'linked_worktree',
  state: 'idle',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-01-01T00:00:00.000Z',
  changes: null,
  merge: null,
};

/** A new window opens: its modules load afresh and read what storage holds. */
async function openWindow() {
  vi.resetModules();
  return {
    drafts: await import('@/data/drafts'),
    compose: await import('@/screens/sessions/compose'),
  };
}

/** Another window stores the value: the storage changes and this window hears of it. */
function otherWindowWrites(key: string, value: string | null) {
  if (value === null) mock.items.delete(key);
  else mock.items.set(key, value);
  for (const listener of mock.listeners) listener({ key, newValue: value });
}

const queuedKeys = () => [...mock.items.keys()].filter((k) => k.startsWith('pantheon.queued.'));

let command: ReturnType<typeof vi.fn<(...args: any[]) => Promise<unknown>>>;
beforeEach(() => {
  mock.items.clear();
  useDrafts.setState({ drafts: {}, answers: {} });
  useQueued.setState({ queued: {}, failures: {} });
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

const dispatch = () => mount(() => useQueueDispatch());

it('keeps a draft in storage and reads it back in a new window', async () => {
  useDrafts.getState().update(KEY, () => ({ text: 'half a thought' }));
  useDrafts.getState().update(KEY, () => ({ attachments: [attachment], skills: [skill] }));
  useDrafts.getState().update(KEY, () => ({ uploading: 1 }));

  const { drafts } = await openWindow();
  expect(drafts.useDrafts).not.toBe(useDrafts);
  expect(drafts.useDrafts.getState().drafts[KEY]).toEqual({
    text: 'half a thought',
    attachments: [attachment],
    skills: [skill],
    refs: [],
    github: [],
    uploading: 0,
  });
});

it('keeps the referred sessions of a draft in storage and reads them back', async () => {
  useDrafts.getState().update(KEY, () => ({ refs: [referred] }));
  const { drafts } = await openWindow();
  expect(drafts.useDrafts.getState().drafts[KEY]?.refs).toEqual([referred]);
});

it('reads a draft stored without referred sessions as referring to none', async () => {
  mock.items.set(`pantheon.draft.${KEY}`, JSON.stringify(message('stored before')));
  const { drafts } = await openWindow();
  expect(drafts.useDrafts.getState().drafts[KEY]).toMatchObject({
    text: 'stored before',
    refs: [],
  });
});

it('keeps the referred sessions of a queued message in storage and sends them', async () => {
  useQueued.getState().add('session-a', { ...message('one'), refs: [referred] });
  const { compose } = await openWindow();
  expect(compose.useQueued.getState().queued['session-a']).toEqual([
    { ...message('one'), refs: [referred] },
  ]);
  const h = mount(() => compose.useQueueDispatch());
  await h.flush();
  expect(command.mock.calls.map(([c]) => c.input.refs)).toEqual([
    [{ kind: 'session', id: 'session-b' }],
  ]);
});

it('sends a queued message stored without referred sessions with none', async () => {
  mock.items.set('pantheon.queued.session-a', JSON.stringify([message('stored before')]));
  const { compose } = await openWindow();
  expect(compose.useQueued.getState().queued['session-a']?.[0]?.refs ?? []).toEqual([]);
  const h = mount(() => compose.useQueueDispatch());
  await h.flush();
  expect(command.mock.calls.map(([c]) => c.input)).toEqual([
    { session_id: 'session-a', input: 'stored before' },
  ]);
});

it('forgets the stored draft once its message is sent', async () => {
  useDrafts.getState().update(KEY, () => ({ text: 'send me' }));
  useDrafts.getState().sent(KEY, { text: 'send me', attachments: [], skills: [] });
  const { drafts } = await openWindow();
  expect(drafts.useDrafts.getState().drafts[KEY]).toBeUndefined();
});

it('shows the draft another window types into the same session', () => {
  otherWindowWrites(
    `pantheon.draft.${KEY}`,
    JSON.stringify({ text: 'from the other window', attachments: [], skills: [] }),
  );
  expect(useDrafts.getState().drafts[KEY]?.text).toBe('from the other window');
  otherWindowWrites(`pantheon.draft.${KEY}`, null);
  expect(useDrafts.getState().drafts[KEY]).toBeUndefined();
});

it('keeps queued messages in storage and reads them back in a new window', async () => {
  useQueued.getState().add('session-a', message('one'));
  useQueued.getState().add('session-a', message('two'));
  useQueued.getState().remove('session-a', 0);
  const { compose } = await openWindow();
  expect(compose.useQueued.getState().queued['session-a']).toEqual([message('two')]);
});

it('sends a queued message it takes from storage, and leaves storage without it', async () => {
  useQueued.getState().add('session-a', message('one'));
  await dispatch().flush();
  expect(command.mock.calls.map(([c]) => c.input.input)).toEqual(['one']);
  expect(queuedKeys()).toEqual([]);
});

it('does not send a queued message another window already took', async () => {
  useQueued.getState().add('session-a', message('one'));
  // The other window took it; this window has not heard yet.
  for (const key of queuedKeys()) mock.items.delete(key);
  await dispatch().flush();
  expect(command).not.toHaveBeenCalled();
  expect(useQueued.getState().queued['session-a'] ?? []).toEqual([]);
});

it('shows the queued messages another window adds', () => {
  otherWindowWrites(
    'pantheon.queued.message-a',
    JSON.stringify({ session: 'session-a', at: 1, message: message('from there') }),
  );
  expect(useQueued.getState().queued['session-a']).toEqual([message('from there')]);
});
