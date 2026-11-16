import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Session } from '@pantheon/domain';
import type { WorkbenchSession } from '@pantheon/protocol';
import { deferred, find, type HookHost, mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any, toasts: [] as any[] }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/components/Toast', async (actual) => ({
  ...(await actual<object>()),
  toast: (options: unknown) => {
    mock.toasts.push(options);
    return 'toast';
  },
}));
import { draftKey, useDrafts } from '@/data/drafts';
import { useFeedback } from '@/data/feedback';
import { failureText } from '@/data/needs-you';
import { useQueueDispatch, useQueued } from '@/screens/sessions/parts';
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
const idle: Session = {
  id: 'session-a',
  revision: 2,
  project_id: 'project-a',
  runtime: 'claude',
  state: 'open',
  turn_count: 1,
};
const compactable = [
  {
    runtime: 'claude',
    enabled: true,
    installed: true,
    auth: { state: 'logged_in' },
    capabilities: {
      manual_compaction: { status: 'supported' },
      compaction_instructions: { status: 'supported' },
    },
  },
];

let session: Session;
let command: ReturnType<typeof vi.fn>;
let stored: Map<string, string>;
let storable: boolean;
const mountDispatch = () => mount(() => useQueueDispatch());
const entry = (text: string) => ({ text, attachments: [], skills: [] });
const sent = () => command.mock.calls.map(([c]) => [c.type, c.input.input]);
const resolveRefused = { ok: false, error: { code: 'revision_conflict', message: 'stale' } };

beforeEach(() => {
  session = idle;
  mock.toasts = [];
  useDrafts.setState({ drafts: {}, answers: {} });
  useQueued.setState({ queued: {}, failures: {} });
  mock.board = {
    status: { state: 'live' },
    board: {
      cursor: 1,
      projects: [],
      get sessions() {
        return [session];
      },
    },
    events: [],
    resync: 0,
    refresh() {},
  };
  command = vi.fn(async () => ({ ok: true, value: {} }));
  vi.stubGlobal('window', {
    pantheon: {
      command,
      query: vi.fn(async (method: string) =>
        method === 'runtime.status' ? { ok: true, value: compactable } : { ok: true, value: [] },
      ),
    },
    addEventListener() {},
    removeEventListener() {},
  });
  stored = new Map();
  storable = true;
  vi.stubGlobal('localStorage', {
    get length() {
      return stored.size;
    },
    key: (i: number) => [...stored.keys()][i] ?? null,
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (!storable) throw new Error('QuotaExceededError');
      stored.set(k, v);
    },
    removeItem: (k: string) => {
      if (!storable) throw new Error('QuotaExceededError');
      stored.delete(k);
    },
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

it('compacts the session with a queued /compact instead of sending it as a message', async () => {
  const h = mountDispatch();
  await h.flush();
  useQueued.getState().add('session-a', entry('/compact keep the API notes'));
  h.render();
  await h.flush();
  expect(command.mock.calls.map(([c]) => [c.type, c.input])).toEqual([
    ['session.compact', { session_id: 'session-a', instructions: 'keep the API notes' }],
  ]);
  expect(useQueued.getState().queued['session-a']).toEqual([]);
});

it('holds a queued /compact until the runtime status says whether the runtime compacts', async () => {
  const status = deferred<unknown>();
  window.pantheon!.query = vi.fn(async (method: string) =>
    method === 'runtime.status' ? status.promise : { ok: true, value: [] },
  ) as never;
  useQueued.getState().add('session-a', entry('/compact keep the API notes'));
  const h = mountDispatch();
  await h.flush();
  expect(command).not.toHaveBeenCalled();
  status.resolve({ ok: true, value: compactable });
  await h.flush();
  expect(command.mock.calls.map(([c]) => [c.type, c.input])).toEqual([
    ['session.compact', { session_id: 'session-a', instructions: 'keep the API notes' }],
  ]);
});

it('sends a queued message the window could not store', async () => {
  storable = false;
  const h = mountDispatch();
  useQueued.getState().add('session-a', entry('one'));
  h.render();
  await h.flush();
  expect(sent()).toEqual([['session.send', 'one']]);
  expect(useQueued.getState().queued['session-a']).toEqual([]);
});

it('tries a failed queued message again once the board is live again', async () => {
  command.mockResolvedValueOnce({
    ok: false,
    error: { code: 'daemon_unavailable', message: 'gone' },
  });
  mock.board.status = { state: 'live' };
  const h = mountDispatch();
  useQueued.getState().add('session-a', entry('one'));
  h.render();
  await h.flush();
  h.render();
  await h.flush();
  expect(sent()).toEqual([['session.send', 'one']]);

  mock.board.status = { state: 'offline', reason: 'closed' };
  h.render();
  await h.flush();
  mock.board.status = { state: 'live' };
  h.render();
  await h.flush();
  expect(sent()).toEqual([
    ['session.send', 'one'],
    ['session.send', 'one'],
  ]);
  expect(useQueued.getState().queued['session-a']).toEqual([]);
});

it('sends the next queued message after a lost send is answered from its receipt', async () => {
  command.mockResolvedValueOnce({
    ok: false,
    error: { code: 'command_timeout', message: 'no answer' },
  });
  const h = mountDispatch();
  useQueued.getState().add('session-a', entry('one'));
  useQueued.getState().add('session-a', entry('two'));
  h.render();
  await h.flush();
  // The lost send committed: its turn ran and the session is idle again.
  session = { ...session, revision: session.revision + 2, turn_count: session.turn_count + 1 };
  h.render();
  await h.flush();
  h.render();
  await h.flush();
  expect(sent()).toEqual([
    ['session.send', 'one'],
    ['session.send', 'one'],
    ['session.send', 'two'],
  ]);
  expect(useQueued.getState().queued['session-a']).toEqual([]);
});

it('keeps each of two equal queued messages its own object', () => {
  const first = entry('continue');
  const middle = entry('another task');
  const last = entry('continue');
  stored.set('pantheon.queued.session-a', JSON.stringify([first, middle, last]));
  useQueued.setState({ queued: { 'session-a': [first, middle, last] } });
  expect(useQueued.getState().shift('session-a')).toBe(first);
  const [, again] = useQueued.getState().queued['session-a']!;
  expect(again).toBe(last);
});

it('shows a failure when a queued message is sent but its comment is not marked sent', async () => {
  command.mockImplementation(async (c: { type: string }) =>
    c.type === 'session.comment.resolve' ? resolveRefused : { ok: true, value: {} },
  );
  const h = mountDispatch();
  useQueued.getState().add('session-a', {
    ...entry('see the comment'),
    comments: [{ id: 'comment-a', revision: 3 }],
  });
  h.render();
  await h.flush();
  expect(command.mock.calls.map(([c]) => c.type)).toEqual([
    'session.send',
    'session.comment.resolve',
  ]);
  expect(mock.toasts).toEqual([{ title: failureText(resolveRefused.error), kind: 'failure' }]);
});

it('shows a failure when a sent message’s comment is not marked sent', async () => {
  command.mockImplementation(async (c: { type: string }) =>
    c.type === 'session.comment.resolve' ? resolveRefused : { ok: true, value: {} },
  );
  useDrafts.getState().update(draftKey('project-a', 'session-a'), () => ({
    text: 'see the comment',
    comments: [{ id: 'comment-a', revision: 3 }],
  }));
  const h: HookHost<any> = mount(() =>
    SessionCompose({ session, listed, title: 'title of session-a' }),
  );
  await h.flush();
  find(h.value, (n) => n.type === 'textarea').props.onKeyDown({
    key: 'Enter',
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    nativeEvent: { isComposing: false },
    preventDefault() {},
  });
  await h.flush();
  expect(command.mock.calls.map(([c]) => c.type)).toEqual([
    'session.send',
    'session.comment.resolve',
  ]);
  expect(mock.toasts).toEqual([{ title: failureText(resolveRefused.error), kind: 'failure' }]);
});

it('marks a comment the draft and the attached items both carry once', async () => {
  useDrafts.getState().update(draftKey('project-a', 'session-a'), () => ({
    text: 'see the comment',
    comments: [{ id: 'comment-a', revision: 3 }],
  }));
  useFeedback.getState().add('session-a', {
    id: 'comment:comment-a',
    kind: 'comment',
    label: 'a.ts:3',
    text: 'rename this',
    comment: { id: 'comment-a', revision: 3 },
  });
  const h: HookHost<any> = mount(() =>
    SessionCompose({ session, listed, title: 'title of session-a' }),
  );
  await h.flush();
  find(h.value, (n) => n.type === 'textarea').props.onKeyDown({
    key: 'Enter',
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    nativeEvent: { isComposing: false },
    preventDefault() {},
  });
  await h.flush();
  expect(command.mock.calls.map(([c]) => c.type)).toEqual([
    'session.send',
    'session.comment.resolve',
  ]);
});
