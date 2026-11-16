import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Session } from '@pantheon/domain';
import type { BridgeResult, WorkbenchSession } from '@pantheon/protocol';
import {
  deferred,
  find,
  type HookHost,
  mount,
  named,
  nodes,
  text,
  unmountAll,
} from './web-hook-host.js';
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
import { buildTranscript } from '@/data/transcript';
import { draftKey, useDrafts } from '@/data/drafts';
import { usePrefill, useQueueDispatch, useQueued } from '@/screens/sessions/parts';
import { QueueDock } from '@/screens/sessions/QueueDock';
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
  state: 'running',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-01-01T00:00:00.000Z',
  changes: null,
  merge: null,
};
const running: Session = {
  id: 'session-a',
  revision: 2,
  project_id: 'project-a',
  runtime: 'claude',
  state: 'running',
  turn_count: 1,
};

let session: Session;
let command: ReturnType<typeof vi.fn>;
// The app's queue dispatcher renders along, as App mounts it beside the composer.
const compose = () =>
  mount(() => {
    useQueueDispatch();
    return SessionCompose({ session, listed, title: 'title of session-a' });
  });
const mountDispatch = () => mount(() => useQueueDispatch());
const box = (h: HookHost<any>) => find(h.value, (n) => n.type === 'textarea');
const key = (extra: object) => ({
  key: 'Enter',
  shiftKey: false,
  altKey: false,
  nativeEvent: { isComposing: false },
  preventDefault() {},
  ...extra,
});
function queue(h: HookHost<any>, input: string) {
  box(h).props.onChange({ target: { value: input } });
  h.render();
  box(h).props.onKeyDown(key({}));
  h.render();
}
const entry = (text: string) => ({ text, attachments: [], skills: [] });
const dockAlerts = () =>
  nodes(mount(() => QueueDock({ session })).value).filter((n) => n.props.role === 'alert');
const sent = () => command.mock.calls.map(([c]) => [c.type, c.input.input]);

beforeEach(() => {
  session = running;
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
    pantheon: { command, query: vi.fn(async () => ({ ok: true, value: [] })) },
    addEventListener() {},
    removeEventListener() {},
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

it('queues the input on Enter while a turn runs and clears the box', async () => {
  const h = compose();
  queue(h, 'first line\nsecond line');
  expect(useQueued.getState().queued['session-a']).toEqual([entry('first line\nsecond line')]);
  expect(box(h).props.value).toBe('');
  expect(text(h.value)).not.toContain('first line');
  await h.flush();
  expect(command).not.toHaveBeenCalled();
});

it('queues a message once when Enter is pressed again while its files upload', async () => {
  useDrafts.getState().update(draftKey('project-a', 'session-a'), () => ({ uploading: 1 }));
  const h = compose();
  box(h).props.onChange({ target: { value: 'with a file' } });
  h.render();
  box(h).props.onKeyDown(key({}));
  box(h).props.onKeyDown(key({}));
  useDrafts.getState().update(draftKey('project-a', 'session-a'), () => ({ uploading: 0 }));
  await h.flush();
  expect(useQueued.getState().queued['session-a']).toEqual([entry('with a file')]);
});

it('turns the send button into a stop while a turn runs and the box is empty', async () => {
  const h = compose();
  const button = () => named(h.value, 'SendButton');
  expect(button().props.label).toBe(zh('sessions.composer.interrupt'));
  button().props.onPress();
  await h.flush();
  expect(command.mock.calls.map(([c]) => [c.type, c.input])).toEqual([
    ['session.interrupt', { session_id: 'session-a' }],
  ]);
  box(h).props.onChange({ target: { value: 'turn left' } });
  h.render();
  expect(button().props.label).toBe(zh('sessions.composer.queue'));
});

it('keeps the send label when the session is idle and the box is empty', () => {
  session = { ...running, state: 'open' };
  const h = compose();
  expect(named(h.value, 'SendButton').props.label).toBe(zh('sessions.composer.send'));
});

it('sends only the first queued message once the session is idle', async () => {
  const h = compose();
  queue(h, 'one');
  queue(h, 'two');
  session = { ...running, state: 'open' };
  h.render();
  await h.flush();
  h.render();
  await h.flush();
  expect(sent()).toEqual([['session.send', 'one']]);
  expect(useQueued.getState().queued['session-a']).toEqual([entry('two')]);
});

it('puts the message back in front when its send fails', async () => {
  command.mockResolvedValue({ ok: false, error: { code: 'resource_busy', message: 'busy' } });
  const h = compose();
  queue(h, 'one');
  queue(h, 'two');
  session = { ...running, state: 'open' };
  h.render();
  await h.flush();
  h.render();
  await h.flush();
  expect(sent()).toEqual([['session.send', 'one']]);
  expect(useQueued.getState().queued['session-a']).toEqual([entry('one'), entry('two')]);
  expect(dockAlerts()).toHaveLength(1);
});

it('retries a failed queued message once at the next session revision', async () => {
  const first = deferred<BridgeResult<unknown>>();
  command.mockReturnValueOnce(first.promise);
  const h = compose();
  queue(h, 'one');
  queue(h, 'two');
  session = { ...running, state: 'open' };
  h.render();
  await h.flush();
  h.render();
  expect(sent()).toEqual([['session.send', 'one']]);
  expect(useQueued.getState().queued['session-a']).toEqual([entry('two')]);

  first.resolve({ ok: false, error: { code: 'revision_conflict', message: 'stale revision' } });
  await h.flush();
  h.render();
  await h.flush();
  expect(sent()).toEqual([['session.send', 'one']]);
  expect(useQueued.getState().queued['session-a']).toEqual([entry('one'), entry('two')]);

  session = { ...session, revision: session.revision + 1 };
  h.render();
  await h.flush();
  h.render();
  await h.flush();
  expect(sent()).toEqual([
    ['session.send', 'one'],
    ['session.send', 'one'],
  ]);
  expect(command.mock.calls.map(([c]) => c.expected_revision)).toEqual([
    running.revision,
    session.revision,
  ]);
  expect(useQueued.getState().queued['session-a']).toEqual([entry('two')]);
});

it('sends the next queued message at the same revision once the failed one is taken off', async () => {
  command.mockResolvedValueOnce({ ok: false, error: { code: 'resource_busy', message: 'busy' } });
  session = { ...running, state: 'open' };
  const h = mountDispatch();
  useQueued.getState().add('session-a', entry('one'));
  useQueued.getState().add('session-a', entry('two'));
  h.render();
  await h.flush();
  expect(useQueued.getState().queued['session-a']).toEqual([entry('one'), entry('two')]);

  useQueued.getState().remove('session-a', 0);
  h.render();
  await h.flush();
  expect(sent()).toEqual([
    ['session.send', 'one'],
    ['session.send', 'two'],
  ]);
  expect(command.mock.calls.map(([c]) => c.expected_revision)).toEqual([
    running.revision,
    running.revision,
  ]);
  expect(useQueued.getState().queued['session-a']).toEqual([]);
});

it('sends a queued message whose answer was lost again as the same command', async () => {
  command.mockResolvedValueOnce({
    ok: false,
    error: { code: 'command_timeout', message: 'no answer' },
  });
  session = { ...running, state: 'open' };
  const h = mountDispatch();
  useQueued.getState().add('session-a', entry('one'));
  useQueued.getState().add('session-a', entry('two'));
  h.render();
  await h.flush();
  expect(useQueued.getState().queued['session-a']).toEqual([entry('one'), entry('two')]);

  // The lost send committed: its turn ran and the session is idle again.
  session = { ...session, revision: session.revision + 2, turn_count: session.turn_count + 1 };
  h.render();
  await h.flush();
  const [first, again] = command.mock.calls.map(([c]) => c);
  expect(again.idempotency_key).toBe(first.idempotency_key);
  expect(again.expected_revision).toBe(running.revision);
  expect(useQueued.getState().queued['session-a']).toEqual([entry('two')]);
});

it('sends a lost queued message anew once the daemon refuses the same command', async () => {
  command
    .mockResolvedValueOnce({ ok: false, error: { code: 'ipc_failed', message: 'gone' } })
    .mockResolvedValueOnce({
      ok: false,
      error: { code: 'revision_conflict', message: 'stale revision' },
    });
  session = { ...running, state: 'open' };
  const h = mountDispatch();
  useQueued.getState().add('session-a', entry('one'));
  h.render();
  await h.flush();

  session = { ...session, revision: session.revision + 1 };
  h.render();
  await h.flush();
  const [first, again, fresh] = command.mock.calls.map(([c]) => c);
  expect(again.idempotency_key).toBe(first.idempotency_key);
  expect(fresh.idempotency_key).not.toBe(first.idempotency_key);
  expect(fresh.expected_revision).toBe(session.revision);
  expect(fresh.input.input).toBe('one');
  expect(useQueued.getState().queued['session-a']).toEqual([]);
});

it('sends a queued message once its session is idle while no composer of it is shown', async () => {
  const h = mountDispatch();
  useQueued.getState().add('session-a', entry('one'));
  h.render();
  await h.flush();
  expect(command).not.toHaveBeenCalled();
  session = { ...running, state: 'open' };
  h.render();
  await h.flush();
  expect(sent()).toEqual([['session.send', 'one']]);
  expect(useQueued.getState().queued['session-a']).toEqual([]);
});

it('shows a queued send that failed while the session was not shown once its queue is drawn', async () => {
  command.mockResolvedValue({ ok: false, error: { code: 'resource_busy', message: 'busy' } });
  session = { ...running, state: 'open' };
  const dispatch = mountDispatch();
  useQueued.getState().add('session-a', entry('one'));
  dispatch.render();
  await dispatch.flush();
  expect(sent()).toEqual([['session.send', 'one']]);
  expect(useQueued.getState().queued['session-a']).toEqual([entry('one')]);
  expect(dockAlerts()).toHaveLength(1);
});

it('sends at once on Enter while the session is idle', async () => {
  session = { ...running, state: 'open' };
  const h = compose();
  queue(h, 'now');
  await h.flush();
  expect(sent()).toEqual([['session.send', 'now']]);
  expect(useQueued.getState().queued['session-a'] ?? []).toEqual([]);
});

it('leaves the todo list of the running turn out of the composer', () => {
  const todos = (current: string) => [
    { content: 'Read the spec', status: 'completed' },
    { content: current, status: 'in_progress' },
  ];
  const started = (sequence: number, id: string, name: string, input: unknown) => ({
    sequence,
    event_id: `event-${sequence}`,
    kind: 'agent.tool.started',
    aggregate_id: 'session-a',
    aggregate_revision: 1,
    project_id: 'project-a',
    causation_id: 'cause',
    created_at: 1_000 + sequence,
    payload: { turn_id: 'turn-a', tool_call_id: id, name, input },
  });
  const turn = {
    id: 'turn-a',
    revision: 1,
    project_id: 'project-a',
    session_id: 'session-a',
    input: 'Build it',
    kind: 'send',
    delivery: 'delivered',
    state: 'running',
  } as const;
  const view = buildTranscript(
    [turn],
    [
      started(1, 'call-a', 'TodoWrite', { todos: todos('Write tests') }),
      started(2, 'call-b', 'Bash', { command: 'ls' }),
      started(3, 'call-c', 'TodoWrite', { todos: todos('Ship it') }),
    ],
  ).turns[0]!;
  const h = mount(() =>
    SessionCompose({ session, listed, title: 'title of session-a', running: view }),
  );
  const shown = nodes(h.value).map(text).join('\n');
  expect(shown).not.toContain('Ship it');
  expect(shown).not.toContain(zh('data.toolCalls.todos'));
});

it('puts a rewritten turn input into the box', () => {
  usePrefill.getState().set('session-a', entry('Tighten the notes'));
  const h = compose();
  h.render();
  expect(box(h).props.value).toBe('Tighten the notes');
  expect(usePrefill.getState().take('session-a')).toBeUndefined();
});
