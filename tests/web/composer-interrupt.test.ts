import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { Session } from '@pantheon/domain';
import type { BridgeResult, WorkbenchSession } from '@pantheon/protocol';
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
import { buildTranscript } from '@/data/transcript';
import { useDrafts } from '@/data/drafts';
import { DEFAULT_LOOK, setLook } from '@/data/layout';
import { usePrefill, useQueued } from '@/screens/sessions/parts';
import { SessionCompose } from '@/screens/sessions/SessionsScreen';
import { zh } from './i18n-setup.js';

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
const turn = buildTranscript(
  [
    {
      id: 'turn-a',
      revision: 1,
      project_id: 'project-a',
      session_id: 'session-a',
      input: 'Build it',
      kind: 'send',
      delivery: 'delivered',
      state: 'running',
    },
  ],
  [
    {
      sequence: 1,
      event_id: 'event-1',
      kind: 'agent.tool.started',
      aggregate_id: 'session-a',
      aggregate_revision: 1,
      project_id: 'project-a',
      causation_id: 'cause',
      created_at: Date.now() - 14_000,
      payload: {
        turn_id: 'turn-a',
        tool_call_id: 'call-a',
        name: 'Bash',
        input: { command: 'pnpm test' },
      },
    },
  ] as any,
).turns[0]!;

let session: Session;
let command: ReturnType<typeof vi.fn>;
const mount = (extra: { waiting?: 'approval' | 'question' | null } = {}) =>
  host(() =>
    SessionCompose({ session, listed, title: 'title of session-a', running: turn, ...extra }),
  );
const box = (h: HookHost<any>) => find(h.value, (n) => n.type === 'textarea');
function press(h: HookHost<any>, key: string, mods: { metaKey?: boolean } = {}) {
  const preventDefault = vi.fn();
  box(h).props.onKeyDown({
    key,
    metaKey: mods.metaKey ?? false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    nativeEvent: { isComposing: false },
    preventDefault,
  });
  h.render();
  return preventDefault.mock.calls.length > 0;
}
function type(h: HookHost<any>, input: string) {
  box(h).props.onChange({ target: { value: input } });
  h.render();
}
/** The status line above the box, drawn with the props the composer gave it. */
function statusLine(h: HookHost<any>) {
  const element = named(h.value, 'ComposeStatus');
  return host(() => (element.type as (props: unknown) => ReactNode)(element.props));
}
const sent = () => command.mock.calls.map(([c]) => [c.type, c.input]);
const hasStatus = (h: HookHost<any>) =>
  nodes(h.value).some((n) => typeof n.type === 'function' && n.type.name === 'ComposeStatus');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  session = running;
  useDrafts.setState({ drafts: {}, answers: {} });
  useQueued.setState({ queued: {}, failures: {} });
  usePrefill.setState({ prefill: {} });
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
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
});
afterEach(() => {
  unmountAll();
  setLook(DEFAULT_LOOK);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Esc in the composer', () => {
  it('interrupts only on a second Esc within 1.5 seconds', async () => {
    const h = mount();
    expect(press(h, 'Escape')).toBe(true);
    await h.flush();
    expect(command).not.toHaveBeenCalled();
    expect(text(statusLine(h).value)).toContain('再按一次 Esc 打断');
    vi.advanceTimersByTime(1_000);
    h.render();
    press(h, 'Escape');
    await h.flush();
    expect(sent()).toEqual([['session.interrupt', { session_id: 'session-a' }]]);
  });

  it('leaves Esc alone and offers no stop while a stop is already pending', async () => {
    session = { ...running, stop_pending: true };
    const h = mount();
    expect(press(h, 'Escape')).toBe(false);
    press(h, 'Escape');
    await h.flush();
    expect(command).not.toHaveBeenCalled();
    expect(named(h.value, 'SendButton').props.label).not.toBe(zh('sessions.composer.interrupt'));
  });

  it('starts over once 1.5 seconds pass after the first Esc', async () => {
    const h = mount();
    press(h, 'Escape');
    vi.advanceTimersByTime(1_500);
    h.render();
    expect(text(statusLine(h).value)).not.toContain('再按一次');
    press(h, 'Escape');
    await h.flush();
    expect(command).not.toHaveBeenCalled();
    press(h, 'Escape');
    await h.flush();
    expect(sent()).toEqual([['session.interrupt', { session_id: 'session-a' }]]);
  });

  it('says the turn was interrupted with its changes kept, for 4 seconds', async () => {
    const h = mount();
    press(h, 'Escape');
    press(h, 'Escape');
    await h.flush();
    session = { ...running, state: 'open' };
    h.render();
    expect(text(statusLine(h).value)).toContain(zh('sessions.compose.interrupted'));
    vi.advanceTimersByTime(4_000);
    h.render();
    expect(hasStatus(h)).toBe(false);
  });

  it('clears the interrupted note with the next send', async () => {
    const h = mount();
    press(h, 'Escape');
    press(h, 'Escape');
    await h.flush();
    session = { ...running, state: 'open' };
    type(h, 'go on');
    press(h, 'Enter');
    await h.flush();
    expect(sent().map(([type]) => type)).toEqual(['session.interrupt', 'session.send']);
    expect(hasStatus(h)).toBe(false);
  });
});

describe('Enter while a turn runs', () => {
  it('queues on Enter and leaves the turn alone', async () => {
    const h = mount();
    type(h, 'after this');
    expect(press(h, 'Enter')).toBe(true);
    await h.flush();
    expect(useQueued.getState().queued['session-a']).toEqual([
      { text: 'after this', attachments: [], skills: [] },
    ]);
    expect(box(h).props.value).toBe('');
    expect(command).not.toHaveBeenCalled();
  });

  it('steers on ⌘Enter', async () => {
    const h = mount();
    type(h, 'turn left');
    press(h, 'Enter', { metaKey: true });
    await h.flush();
    expect(sent()).toEqual([['session.steer', { session_id: 'session-a', input: 'turn left' }]]);
    expect(useQueued.getState().queued['session-a'] ?? []).toEqual([]);
  });

  it('queues on ⌘Enter when ⌘Enter sends, and keeps Enter for a new line', async () => {
    setLook({ send_key: 'meta-enter' });
    const h = mount();
    type(h, 'later');
    expect(press(h, 'Enter')).toBe(false);
    press(h, 'Enter', { metaKey: true });
    await h.flush();
    expect(useQueued.getState().queued['session-a']).toEqual([
      { text: 'later', attachments: [], skills: [] },
    ]);
    expect(command).not.toHaveBeenCalled();
  });

  it('does not queue the text a steer is still sending', async () => {
    const answer = deferred<BridgeResult<unknown>>();
    command.mockImplementationOnce(() => answer.promise);
    const h = mount();
    type(h, 'nudge');
    press(h, 'Enter', { metaKey: true });
    press(h, 'Enter');
    expect(useQueued.getState().queued['session-a'] ?? []).toEqual([]);
    answer.resolve({ ok: true, value: {} });
    await h.flush();
    expect(sent()).toEqual([['session.steer', { session_id: 'session-a', input: 'nudge' }]]);
  });
});

describe('status line and send key while a turn runs', () => {
  it('names the running step with its time and the keys that apply now', () => {
    const h = mount();
    const line = text(statusLine(h).value);
    expect(line).toContain(zh('sessions.overview.toolRun'));
    expect(line).toMatch(new RegExp(zh('data.elapsed.seconds').replace('{seconds}', '1\\d')));
    expect(line).toContain(zh('sessions.composer.steer'));
    expect(line).toContain(zh('sessions.compose.interruptKey'));
  });

  it('says the turn goes on after your approval', () => {
    const h = mount({ waiting: 'approval' });
    expect(text(statusLine(h).value)).toContain(zh('sessions.compose.approval'));
  });

  it('shows no status line while the session is idle', () => {
    session = { ...running, state: 'open' };
    const h = host(() => SessionCompose({ session, listed, title: 'title of session-a' }));
    expect(hasStatus(h)).toBe(false);
  });

  it('turns the empty send key into a square that stops the turn at once', async () => {
    const h = mount();
    const button = named(h.value, 'SendButton');
    expect(button.props.label).toBe(zh('sessions.composer.interrupt'));
    const drawn = (button.type as (props: unknown) => any)(button.props);
    expect(drawn.props['aria-label']).toBe(zh('sessions.composer.interrupt'));
    drawn.props.onClick();
    await h.flush();
    expect(sent()).toEqual([['session.interrupt', { session_id: 'session-a' }]]);
  });

  it('queues from the send button once the box has text', () => {
    const h = mount();
    type(h, 'later');
    const button = named(h.value, 'SendButton');
    expect(button.props.label).toBe(zh('sessions.composer.queue'));
    button.props.onPress();
    h.render();
    expect(useQueued.getState().queued['session-a']).toEqual([
      { text: 'later', attachments: [], skills: [] },
    ]);
  });
});
