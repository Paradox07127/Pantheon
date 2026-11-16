import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { HookHost, deferred, find, nodes, text } from './web-hook-host.js';

const mock = vi.hoisted(() => {
  const state = {
    board: {} as any,
    bridge: undefined as Record<string, any> | undefined,
    focused: true,
    listeners: new Map<string, Set<() => void>>(),
  };
  Object.assign(globalThis, {
    window: {
      get pantheon() {
        return state.bridge;
      },
      addEventListener: (type: string, listener: () => void) => {
        if (!state.listeners.has(type)) state.listeners.set(type, new Set());
        state.listeners.get(type)!.add(listener);
      },
      removeEventListener: (type: string, listener: () => void) =>
        void state.listeners.get(type)?.delete(listener),
    },
    document: { body: { dataset: {} }, hasFocus: () => state.focused },
  });
  return state;
});
vi.mock('react', async (actual) => {
  const { hooks } = await import('./web-hook-host.js');
  return { ...(await actual<object>()), ...hooks, useLayoutEffect: () => {} };
});
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/data/workbench-sessions', async (actual) => ({
  ...(await actual<object>()),
  useSessionList: () => ({ data: [], loading: false, error: null, reload() {} }),
}));
vi.mock('@/data/needs-you', async (actual) => ({
  ...(await actual<object>()),
  useNeedsYou: () => ({ items: [], error: null, reload() {} }),
}));
vi.mock('@/data/logs', async (actual) => ({
  ...(await actual<object>()),
  useEventHistory: () => ({ events: [], error: null, reload() {} }),
}));
import { failureText } from '@/data/needs-you';
import { WATCH_CHANNEL } from '@/data/notice-tiers';
import { SessionWindow } from '@/shell/SessionWindow';
import { zh } from './i18n-setup.js';

type Answer = { ok: true; value: null } | { ok: false; error: { code: string; message: string } };

/** A broadcast channel of this page alone, which keeps what each channel of the watch name posts. */
class LocalChannel {
  static posted: unknown[] = [];
  constructor(readonly name: string) {}
  postMessage(data: unknown) {
    if (this.name === WATCH_CHANNEL) LocalChannel.posted.push(data);
  }
  close() {}
}

const hosts: HookHost<any>[] = [];
function mount() {
  const h = new HookHost(() => SessionWindow({ project_id: 'alpha', session_id: 'refund-1' }));
  hosts.push(h);
  h.render();
  return h;
}
const fire = (type: string) => mock.listeners.get(type)?.forEach((listener) => listener());
const alerts = (tree: ReactElement) => nodes(tree).filter((n) => n.props.role === 'alert');

beforeEach(() => {
  mock.focused = true;
  mock.listeners.clear();
  LocalChannel.posted = [];
  vi.stubGlobal('BroadcastChannel', LocalChannel);
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  mock.board = {
    board: {
      projects: [{ id: 'alpha', name: 'Alpha', roots: [] }],
      sessions: [{ id: 'refund-1', project_id: 'alpha', title: 'Refund idempotency' }],
      session_turns: [],
      workspaces: [],
    },
    status: { state: 'live' },
    events: [],
  };
  mock.bridge = {
    setAlwaysOnTop: vi.fn(async (): Promise<Answer> => ({ ok: true, value: null })),
    showInMainWindow: vi.fn(async (): Promise<Answer> => ({ ok: true, value: null })),
    ready: vi.fn(),
  };
});
afterEach(() => {
  hosts.splice(0).forEach((h) => h.unmount());
  vi.unstubAllGlobals();
});

describe('the session window bar', () => {
  it('presses the pin only once the desktop app keeps the window on top, and tells a refusal beside it', async () => {
    const h = mount();
    const pin = () =>
      find(h.value, (n) => n.props['aria-label'] === zh('shell.sessionWindow.keepOnTop'));
    const answer = deferred<Answer>();
    mock.bridge!.setAlwaysOnTop.mockReturnValueOnce(answer.promise);
    pin().props.onClick();
    await h.flush();
    expect(mock.bridge!.setAlwaysOnTop).toHaveBeenLastCalledWith(true);
    expect(pin().props['aria-pressed']).toBe(false);
    answer.resolve({ ok: true, value: null });
    await h.flush();
    expect(pin().props['aria-pressed']).toBe(true);
    const error = { code: 'forbidden', message: 'not this window' };
    mock.bridge!.setAlwaysOnTop.mockResolvedValueOnce({ ok: false, error });
    pin().props.onClick();
    await h.flush();
    expect(mock.bridge!.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
    expect(pin().props['aria-pressed']).toBe(true);
    const bar = find(h.value, (n) => n.props.className === 'sw-end');
    expect(alerts(bar).map((n) => text(n))).toEqual([failureText(error)]);
    pin().props.onClick();
    await h.flush();
    expect(pin().props['aria-pressed']).toBe(false);
    expect(alerts(h.value)).toEqual([]);
  });

  it('tells beside the buttons when the main window cannot show the session', async () => {
    const h = mount();
    const error = { code: 'invalid_input', message: 'place must name a project' };
    mock.bridge!.showInMainWindow.mockResolvedValueOnce({ ok: false, error });
    find(
      h.value,
      (n) => n.type === 'button' && text(n.props.children) === zh('shell.sessionWindow.showInMain'),
    ).props.onClick();
    await h.flush();
    expect(mock.bridge!.showInMainWindow).toHaveBeenCalledWith({
      project_id: 'alpha',
      session_id: 'refund-1',
    });
    const bar = find(h.value, (n) => n.props.className === 'sw-end');
    expect(alerts(bar).map((n) => text(n))).toEqual([failureText(error)]);
  });
});

describe('the session window on the watch channel', () => {
  it('tells the other windows its session while it has focus, and none once it loses focus or closes', () => {
    const h = mount();
    fire('blur');
    fire('focus');
    fire('pagehide');
    h.unmount();
    const sessions = LocalChannel.posted.map(
      (word) => (word as { session_id: string | null }).session_id,
    );
    expect(sessions).toEqual(['refund-1', null, 'refund-1', null, null]);
    const windows = new Set(LocalChannel.posted.map((word) => (word as { window: string }).window));
    expect(windows.size).toBe(1);
    hosts.length = 0;
  });

  it('tells no session when it opens behind another window', () => {
    mock.focused = false;
    mount();
    expect(LocalChannel.posted).toEqual([{ window: expect.any(String), session_id: null }]);
  });
});
