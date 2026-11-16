import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Session } from '@pantheon/domain';
import type { WorkbenchSession } from '@pantheon/protocol';
import { find, type HookHost, mount, named, unmountAll } from './web-hook-host.js';

// The window and its storage exist before the modules load, as in the app, so a new window's
// modules read what the last one stored.
const mock = vi.hoisted(() => {
  const state = {
    board: {} as any,
    commands: [] as any[],
    items: new Map<string, string>(),
  };
  Object.assign(globalThis, {
    window: {
      pantheon: {
        command: async (c: unknown) => {
          state.commands.push(c);
          return { ok: true, value: {} };
        },
        query: async (method: string) =>
          method === 'files.search'
            ? { ok: true, value: ['apps/a.ts', 'apps/b.ts'] }
            : { ok: true, value: [] },
        setMenuShortcuts: async () => ({ ok: true, value: null }),
      },
      addEventListener() {},
      removeEventListener() {},
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
import { draftKey } from '@/data/drafts';
import { SessionCompose } from '@/screens/sessions/SessionsScreen';

const listed: WorkbenchSession = {
  id: 'session-a',
  created_at: '2026-01-01T00:00:00.000Z',
  title: 'title of session-a',
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-a',
  workspace_kind: 'linked_worktree',
  state: 'idle',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-01-01T00:00:00.000Z',
  changes: null,
  merge: null,
};
const session: Session = {
  id: 'session-a',
  revision: 2,
  project_id: 'project-a',
  runtime: 'claude',
  state: 'open',
  turn_count: 1,
};
const KEY = draftKey('project-a', 'session-a');

/** A new window opens: its modules load afresh and read what storage holds. */
async function openWindow() {
  vi.resetModules();
  return {
    drafts: await import('@/data/drafts'),
    screen: await import('@/screens/sessions/SessionsScreen'),
  };
}

const box = (h: HookHost<any>) => find(h.value, (n) => n.type === 'textarea');
const press = (h: HookHost<any>, key: string) => {
  box(h).props.onKeyDown({
    key,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    nativeEvent: { isComposing: false },
    preventDefault() {},
  });
  h.render();
};
const type = (h: HookHost<any>, value: string) => {
  box(h).props.onChange({ target: { value, selectionStart: value.length } });
  h.render();
};
const chips = (h: HookHost<any>) =>
  (named(h.value, 'AttachmentStrip').props.feedback ?? []).map((i: { label: string }) => i.label);

beforeEach(() => {
  vi.useFakeTimers();
  mock.items.clear();
  mock.commands = [];
  mock.board = {
    board: { cursor: 1, projects: [{ id: 'project-a', name: 'Project A' }], session_turns: [] },
    events: [],
    status: { state: 'live' },
    resync: 0,
    refresh() {},
  };
});
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
});

it('keeps a picked file reference with the draft in a new window and sends it there', async () => {
  const first = mount(() => SessionCompose({ session, listed, title: 'title of session-a' }));
  await first.flush();
  type(first, '看 @ap');
  vi.advanceTimersByTime(150);
  await first.flush();
  press(first, 'ArrowDown');
  press(first, 'Enter');
  await first.flush();
  expect(chips(first)).toEqual(['apps/b.ts']);

  const { drafts, screen } = await openWindow();
  expect(drafts.useDrafts.getState().drafts[KEY]?.mentions?.map((m) => m.label)).toEqual([
    'apps/b.ts',
  ]);
  const next = mount(() => screen.SessionCompose({ session, listed, title: 'title of session-a' }));
  await next.flush();
  expect(chips(next)).toEqual(['apps/b.ts']);
  type(next, '看这个');
  press(next, 'Enter');
  await next.flush();
  expect(mock.commands.map((c) => c.input)).toEqual([
    { session_id: 'session-a', input: '看这个\n\n@apps/b.ts' },
  ]);
  expect(drafts.useDrafts.getState().drafts[KEY]).toBeUndefined();
});
