import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@pantheon/domain';
import type { WorkbenchSession } from '@pantheon/protocol';
import { find, HookHost, named, nodes, mount, unmountAll } from './web-hook-host.js';
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
import { DEFAULT_LOOK, setLook } from '@/data/layout';
import { DEFAULT_SESSION_DISPLAY, setSessionDisplay } from '@/data/session-display';
import { useDrafts } from '@/data/drafts';
import { usePrefill, useQueued } from '@/screens/sessions/parts';
import { NewSession, SessionCompose } from '@/screens/sessions/SessionsScreen';
import { zh } from './i18n-setup.js';

const listed = (id: string): WorkbenchSession => ({
  id,
  created_at: '2026-01-01T00:00:00.000Z',
  title: `title of ${id}`,
  runtime: 'codex',
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
const idle = (id: string): Session => ({
  id,
  revision: 2,
  project_id: 'project-a',
  runtime: 'codex',
  state: 'open',
  turn_count: 1,
});

let command: ReturnType<typeof vi.fn>;
const box = (h: HookHost<any>) => find(h.value, (n) => n.type === 'textarea');
function type(h: HookHost<any>, input: string) {
  box(h).props.onChange({ target: { value: input } });
  h.render();
}
/** Presses Enter in the box with the given modifiers; says whether the box kept its own Enter. */
async function enter(h: HookHost<any>, mods: { metaKey?: boolean; composing?: boolean } = {}) {
  const preventDefault = vi.fn();
  box(h).props.onKeyDown({
    key: 'Enter',
    metaKey: mods.metaKey ?? false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    nativeEvent: { isComposing: mods.composing ?? false },
    preventDefault,
  });
  await h.flush();
  return preventDefault.mock.calls.length === 0;
}
const sent = () => command.mock.calls.map(([c]) => c.type);

beforeEach(() => {
  useDrafts.setState({ drafts: {}, answers: {} });
  useQueued.setState({ queued: {} });
  usePrefill.setState({ prefill: {} });
  mock.board = {
    board: { cursor: 1, projects: [] },
    events: [],
    resync: 0,
    status: { state: 'live' },
    refresh() {},
  };
  command = vi.fn(async () => ({ ok: true, value: { id: 'session-new' } }));
  vi.stubGlobal('window', {
    pantheon: {
      command,
      chooseFiles: vi.fn(async () => ({ ok: true, value: [] })),
      query: vi.fn(async () => ({ ok: true, value: [] })),
    },
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
});
afterEach(() => {
  unmountAll();
  setLook(DEFAULT_LOOK);
  setSessionDisplay(DEFAULT_SESSION_DISPLAY);
  vi.unstubAllGlobals();
});

const compose = () =>
  mount(() =>
    SessionCompose({
      session: idle('session-a'),
      listed: listed('session-a'),
      title: 'title of session-a',
    }),
  );
const newSession = () =>
  mount(() =>
    NewSession({
      projectId: 'project-a',
      defaults: undefined,
      focus: 0,
      onCreated() {},
      recent: [],
      onOpen() {},
      onClose() {},
    }),
  );

describe('the send key', () => {
  it.each([
    [
      'sends on Enter by default, but not while the input method is composing',
      compose,
      'session.send',
    ],
    [
      'creates on Enter by default, but not while the input method is composing',
      newSession,
      'session.create',
    ],
  ])('%s', async (_name, open, done) => {
    const h = open();
    type(h, 'ship it');
    expect(await enter(h, { composing: true })).toBe(true);
    expect(sent()).toEqual([]);
    expect(await enter(h)).toBe(false);
    expect(sent()).toEqual([done]);
  });

  it.each([
    ['starts a new line on Enter and sends on ⌘Enter when ⌘Enter sends', compose, 'session.send'],
    ['applies to the first message of a new session too', newSession, 'session.create'],
  ])('%s', async (_name, open, done) => {
    setLook({ send_key: 'meta-enter' });
    const h = open();
    type(h, 'ship it');
    expect(await enter(h)).toBe(true);
    expect(sent()).toEqual([]);
    expect(await enter(h, { metaKey: true, composing: true })).toBe(true);
    expect(sent()).toEqual([]);
    expect(await enter(h, { metaKey: true })).toBe(false);
    expect(sent()).toEqual([done]);
  });
});

describe('the send key while a turn runs', () => {
  const running = () =>
    mount(() =>
      SessionCompose({
        session: { ...idle('session-a'), state: 'running' },
        listed: { ...listed('session-a'), state: 'running' },
        title: 'title of session-a',
      }),
    );
  const queued = () => useQueued.getState().queued['session-a']?.map((m) => m.text) ?? [];
  const sendButton = (h: HookHost<any>) => named(h.value, 'SendButton');

  it('queues by default, and steers on ⌘Enter', async () => {
    const h = running();
    type(h, 'also check the logs');
    expect(sendButton(h).props.label).toBe(zh('sessions.composer.queue'));
    expect(await enter(h)).toBe(false);
    expect(sent()).toEqual([]);
    expect(queued()).toEqual(['also check the logs']);
    type(h, 'stop and rebase');
    expect(await enter(h, { metaKey: true })).toBe(false);
    expect(sent()).toEqual(['session.steer']);
  });

  it('steers on the send key and from the button, and queues on ⌘Enter, when set to steer', async () => {
    setSessionDisplay({ running_send: 'steer' });
    const h = running();
    type(h, 'stop and rebase');
    expect(sendButton(h).props.label).toBe(zh('sessions.composer.steer'));
    expect(await enter(h)).toBe(false);
    expect(sent()).toEqual(['session.steer']);
    expect(queued()).toEqual([]);
    type(h, 'then rerun');
    sendButton(h).props.onPress();
    await h.flush();
    expect(sent()).toEqual(['session.steer', 'session.steer']);
    type(h, 'later: tidy up');
    expect(await enter(h, { metaKey: true })).toBe(false);
    expect(queued()).toEqual(['later: tidy up']);
  });
});

describe('the context ring', () => {
  const usage = { context_tokens: 100_000, context_window: 400_000 };
  const ring = (h: HookHost<any>) =>
    nodes(h.value).some((n) => typeof n.type === 'function' && n.type.name === 'ContextRing');
  const withUsage = () =>
    mount(() =>
      SessionCompose({
        session: idle('session-a'),
        listed: listed('session-a'),
        title: 'title of session-a',
        usage,
      }),
    );

  it('sits in the composer row unless context and usage are off', () => {
    expect(ring(withUsage())).toBe(true);
    setSessionDisplay({ context_usage: false });
    expect(ring(withUsage())).toBe(false);
  });
});
