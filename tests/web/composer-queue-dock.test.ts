import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Session } from '@pantheon/domain';
import type { WorkbenchSession } from '@pantheon/protocol';
import {
  deferred,
  find,
  HookHost,
  named,
  nodes,
  text,
  mount as host,
  unmountAll,
} from './web-hook-host.js';
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
import { useDrafts } from '@/data/drafts';
import { usePrefill, useQueued, type QueuedMessage } from '@/screens/sessions/parts';
import { QueueDock } from '@/screens/sessions/QueueDock';
import { SessionCompose } from '@/screens/sessions/SessionsScreen';
import { zh } from './i18n-setup.js';

const running: Session = {
  id: 'session-a',
  revision: 2,
  project_id: 'project-a',
  runtime: 'claude',
  state: 'running',
  turn_count: 1,
};
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
  state: 'running',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-01-01T00:00:00.000Z',
  changes: null,
  merge: null,
};
const attachment = { id: 'attachment-a', name: 'notes.txt', size: 12, mime: 'text/plain' };
const one: QueuedMessage = {
  text: 'first line\nsecond line',
  attachments: [attachment] as any,
  skills: [{ name: 'skill-a' }] as any,
};
const two: QueuedMessage = { text: 'two', attachments: [], skills: [] };
const message = (text: string): QueuedMessage => ({ text, attachments: [], skills: [] });

let session: Session;
let command: ReturnType<typeof vi.fn>;
const mount = () => host(() => QueueDock({ session }));
const rows = (h: HookHost<any>) => nodes(h.value).filter((n) => n.props.role === 'listitem');
const buttons = (h: HookHost<any>, label: string) =>
  nodes(h.value).filter((n) => n.type === 'button' && n.props['aria-label'] === label);
const alerts = (h: HookHost<any>) => nodes(h.value).filter((n) => n.props.role === 'alert');

beforeEach(() => {
  session = running;
  useQueued.setState({ queued: { 'session-a': [one, two] }, failures: {} });
  usePrefill.setState({ prefill: {} });
  useDrafts.setState({ drafts: {}, answers: {} });
  mock.board = {
    status: { state: 'live' },
    board: { cursor: 1, projects: [] },
    events: [],
    resync: 0,
    refresh() {},
  };
  command = vi.fn(async () => ({ ok: true, value: {} }));
  vi.stubGlobal('window', {
    pantheon: { command, query: vi.fn(async () => ({ ok: true, value: [] })) },
    addEventListener() {},
    removeEventListener() {},
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

it('lists each queued message on one line, oldest first, under its own name', () => {
  const h = mount();
  expect(find(h.value, (n) => n.props.role === 'list').props['aria-label']).toBe(
    zh('sessions.composer.queued'),
  );
  expect(rows(h).map((row) => text(row))).toEqual([
    expect.stringContaining('first line'),
    expect.stringContaining('two'),
  ]);
  expect(text(rows(h)[0])).not.toContain('second line');
  expect(text(find(rows(h)[0]!, (n) => n.props.className === 'ss-qn'))).toBe('1');
  for (const label of [
    zh('sessions.composer.editQueued'),
    zh('sessions.composer.steerNow'),
    zh('sessions.composer.dropQueued'),
  ])
    expect(buttons(h, label)).toHaveLength(2);
});

it('draws nothing without queued messages', () => {
  useQueued.setState({ queued: {} });
  expect(mount().value).toBeNull();
});

it('shows the newest three of five and opens the rest from the line above them', () => {
  useQueued.setState({
    queued: { 'session-a': ['m1', 'm2', 'm3', 'm4', 'm5'].map(message) },
  });
  const h = mount();
  expect(rows(h).map((row) => text(row))).toEqual(['m3', 'm4', 'm5']);
  const more = find(h.value, (n) => n.type === 'button' && text(n) === '还有 2 条排队');
  more.props.onClick();
  h.render();
  expect(rows(h).map((row) => text(row))).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
});

it('takes a queued message back', () => {
  const h = mount();
  buttons(h, zh('sessions.composer.dropQueued'))[0]!.props.onClick();
  h.render();
  expect(useQueued.getState().queued['session-a']).toEqual([two]);
});

it('puts a queued message back into the box to edit and takes it off the queue', () => {
  const h = mount();
  buttons(h, zh('sessions.composer.editQueued'))[0]!.props.onClick();
  h.render();
  expect(useQueued.getState().queued['session-a']).toEqual([two]);
  const compose = host(() => SessionCompose({ session, listed, title: 'title of session-a' }));
  // The composer takes the handed-over message in an effect; the next render shows it.
  compose.render();
  expect(find(compose.value, (n) => n.type === 'textarea').props.value).toBe(
    'first line\nsecond line',
  );
});

it('carries the stored comments of a queued message back into the box and marks them sent with it', async () => {
  useQueued.setState({
    queued: { 'session-a': [{ ...two, comments: [{ id: 'comment-a', revision: 3 }] }] },
  });
  const h = mount();
  buttons(h, zh('sessions.composer.editQueued'))[0]!.props.onClick();
  h.render();
  const idle = { ...running, state: 'open' as const };
  const compose = host(() =>
    SessionCompose({
      session: idle,
      listed: { ...listed, state: 'idle' },
      title: 'title of session-a',
    }),
  );
  compose.render();
  named(compose.value, 'SendButton').props.onPress();
  await compose.flush();
  expect(command.mock.calls.map(([c]) => [c.type, c.input, c.expected_revision])).toEqual([
    ['session.send', { session_id: 'session-a', input: 'two' }, running.revision],
    ['session.comment.resolve', { comment_id: 'comment-a', state: 'sent' }, 3],
  ]);
});

it('steers with a queued message now and drops it once delivered', async () => {
  const h = mount();
  buttons(h, zh('sessions.composer.steerNow'))[0]!.props.onClick();
  await h.flush();
  expect(command.mock.calls.map(([c]) => [c.type, c.input, c.expected_revision])).toEqual([
    [
      'session.steer',
      {
        session_id: 'session-a',
        input: 'first line\nsecond line',
        attachments: ['attachment-a'],
        skills: [{ name: 'skill-a' }],
      },
      running.revision,
    ],
  ]);
  expect(useQueued.getState().queued['session-a']).toEqual([two]);
});

it('marks the stored comments of a queued message sent once steering with it succeeds', async () => {
  useQueued.setState({
    queued: { 'session-a': [{ ...two, comments: [{ id: 'comment-a', revision: 3 }] }] },
  });
  const h = mount();
  buttons(h, zh('sessions.composer.steerNow'))[0]!.props.onClick();
  await h.flush();
  expect(command.mock.calls.map(([c]) => [c.type, c.input, c.expected_revision])).toEqual([
    ['session.steer', { session_id: 'session-a', input: 'two' }, running.revision],
    ['session.comment.resolve', { comment_id: 'comment-a', state: 'sent' }, 3],
  ]);
});

it('leaves the stored comments of a queued message open when steering with it fails', async () => {
  command.mockResolvedValue({ ok: false, error: { code: 'resource_busy', message: 'busy' } });
  useQueued.setState({
    queued: { 'session-a': [{ ...two, comments: [{ id: 'comment-a', revision: 3 }] }] },
  });
  const h = mount();
  buttons(h, zh('sessions.composer.steerNow'))[0]!.props.onClick();
  await h.flush();
  expect(command.mock.calls.map(([c]) => c.type)).toEqual(['session.steer']);
});

it('keeps a queued message and says why under its row when steering with it fails', async () => {
  command.mockResolvedValue({ ok: false, error: { code: 'resource_busy', message: 'busy' } });
  const h = mount();
  buttons(h, zh('sessions.composer.steerNow'))[1]!.props.onClick();
  await h.flush();
  expect(command.mock.calls.map(([c]) => c.input)).toEqual([
    { session_id: 'session-a', input: 'two' },
  ]);
  expect(useQueued.getState().queued['session-a']).toEqual([one, two]);
  expect(alerts(h)).toHaveLength(1);
  expect(text(alerts(h)[0])).toContain('busy');
  expect(nodes(rows(h)[1]).some((n) => n.props.role === 'alert')).toBe(true);
});

it('takes a message off the queue while steering with it and puts it back in place on failure', async () => {
  const answer = deferred<unknown>();
  command.mockReturnValueOnce(answer.promise);
  const h = mount();
  buttons(h, zh('sessions.composer.steerNow'))[0]!.props.onClick();
  await h.flush();
  // The auto-send shifts the queue head once the turn ends; the steered message is not there.
  expect(useQueued.getState().queued['session-a']).toEqual([two]);
  answer.resolve({ ok: false, error: { code: 'resource_busy', message: 'busy' } });
  await h.flush();
  expect(useQueued.getState().queued['session-a']).toEqual([one, two]);
  expect(alerts(h)).toHaveLength(1);
});

it('stores a message put back after steering with it fails, so the auto-send still finds it', async () => {
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
  useQueued.setState({ queued: {} });
  useQueued.getState().add('session-a', one);
  useQueued.getState().add('session-a', two);
  command.mockResolvedValue({
    ok: false,
    error: { code: 'revision_conflict', message: 'stale' },
  });
  const h = mount();
  buttons(h, zh('sessions.composer.steerNow'))[0]!.props.onClick();
  await h.flush();
  const kept = [...stored.values()].map((v) => JSON.parse(v)).sort((a, b) => a.at - b.at);
  expect(kept.map((m) => m.message)).toEqual([one, two]);
  expect(useQueued.getState().shift('session-a')).toBe(one);
});

it('shows why the queued send failed under the message it puts back in front', () => {
  useQueued.setState({ failures: { 'session-a': 'the session was busy' } });
  const h = mount();
  expect(nodes(rows(h)[0]).some((n) => n.props.role === 'alert')).toBe(true);
  expect(text(rows(h)[0])).toContain('the session was busy');
  expect(nodes(rows(h)[1]).some((n) => n.props.role === 'alert')).toBe(false);
});

it('offers no steer when the session cannot take one', () => {
  session = { ...running, state: 'reconciling' };
  const h = mount();
  expect(buttons(h, zh('sessions.composer.steerNow'))).toHaveLength(0);
  expect(buttons(h, zh('sessions.composer.dropQueued'))).toHaveLength(2);
});
