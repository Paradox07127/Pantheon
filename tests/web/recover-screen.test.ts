import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement } from 'react';
import type { BridgeResult } from '@pantheon/protocol';
import { find, HookHost, named, text } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { startSync, type SyncStatus } from '@/data/sync';
import { ConnectionGate, CrashScreen, DaemonDown, RecoverBoundary } from '@/shell/RecoverScreen';

const offline: SyncStatus = { state: 'offline', reason: 'connect ECONNREFUSED 127.0.0.1:1' };
const app = createElement('i', { id: 'the-app' });

let keys: EventTarget;
beforeEach(() => {
  vi.useFakeTimers();
  keys = new EventTarget();
  vi.stubGlobal('window', keys);
  vi.stubGlobal('document', { body: { dataset: {} } });
  vi.stubGlobal('location', { reload: vi.fn() });
  vi.stubGlobal('navigator', {
    userAgent: 'Macintosh',
    clipboard: { writeText: vi.fn(async () => {}) },
  });
  mock.board = { board: null, status: { state: 'connecting' }, reconnect: vi.fn() };
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const press = (init: { key: string; metaKey?: boolean; ctrlKey?: boolean }) => {
  const e = Object.assign(new Event('keydown', { cancelable: true }), {
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...init,
  });
  keys.dispatchEvent(e);
  return e;
};
const button = (tree: ReactElement, label: string) =>
  find(tree, (n) => n.type === 'button' && text(n.props.children).includes(label));

/** The boundary after its child threw, as React leaves it once the error is caught. */
function caught(error: Error, componentStack: string) {
  const boundary = new RecoverBoundary({ children: app });
  boundary.setState = (next: any) => {
    boundary.state = { ...boundary.state, ...next };
  };
  boundary.state = { ...boundary.state, ...RecoverBoundary.getDerivedStateFromError(error) };
  boundary.componentDidCatch(error, { componentStack });
  return boundary.render() as ReactElement<any>;
}

describe('crash page', () => {
  const error = Object.assign(new TypeError("Cannot read properties of undefined (reading 'x')"), {
    stack:
      "TypeError: Cannot read properties of undefined (reading 'x')\n    at Thread (thread.tsx:4)",
  });

  it('renders its child until the child throws, then the crash page with the first error line', () => {
    expect(new RecoverBoundary({ children: app }).render()).toBe(app);
    const page = caught(error, '\n    at Thread\n    at App');
    expect(page.type).toBe(CrashScreen);
    const tree = new HookHost(() => CrashScreen(page.props)).render();
    const alert = find(tree, (n) => n.props.role === 'alert');
    expect(text(alert)).toContain(zh('recover.crash.title'));
    const line = find(alert, (n) => n.props.className === 'rc-e');
    expect(text(line)).toBe("TypeError: Cannot read properties of undefined (reading 'x')");
    expect(text(alert)).toContain(zh('recover.crash.drafts'));
  });

  it('reloads from its button and from ⌘R', () => {
    const host = new HookHost(() => CrashScreen({ error, componentStack: null }));
    const tree = host.render();
    const reload = button(tree, zh('recover.crash.reload'));
    expect(text(find(reload, (n) => n.props.className === 'kbd hk'))).toBe('⌘R');
    reload.props.onClick();
    expect(location.reload).toHaveBeenCalledTimes(1);
    press({ key: 'x', metaKey: true });
    expect(location.reload).toHaveBeenCalledTimes(1);
    const e = press({ key: 'r', metaKey: true });
    expect(location.reload).toHaveBeenCalledTimes(2);
    expect(e.defaultPrevented).toBe(true);
    host.unmount();
    press({ key: 'r', metaKey: true });
    expect(location.reload).toHaveBeenCalledTimes(2);
  });

  it('draws the crash page in place of its child when the app loaded it after repeated renderer crashes', () => {
    Object.assign(keys, { pantheon: { crashPage: { reason: 'oom', exit_code: 2 } } });
    const page = new RecoverBoundary({ children: app }).render() as ReactElement<any>;
    expect(page.type).toBe(CrashScreen);
    const tree = new HookHost(() => CrashScreen(page.props)).render();
    const alert = find(tree, (n) => n.props.role === 'alert');
    expect(text(alert)).toContain(zh('recover.crash.title'));
    expect(text(find(alert, (n) => n.props.className === 'rc-e'))).toBe(
      '界面进程 10 秒内崩溃了两次：oom（退出码 2）',
    );
    button(tree, zh('recover.crash.reload')).props.onClick();
    expect(location.reload).toHaveBeenCalledTimes(1);
    button(tree, zh('recover.crash.copy')).props.onClick();
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[0]![0]).toBe(
      '界面进程 10 秒内崩溃了两次：oom（退出码 2）',
    );
  });

  it('copies the name, message, stack and component stack', () => {
    const page = caught(error, '\n    at Thread\n    at App');
    const tree = new HookHost(() => CrashScreen(page.props)).render();
    button(tree, zh('recover.crash.copy')).props.onClick();
    const copied = vi.mocked(navigator.clipboard.writeText).mock.calls[0]![0];
    expect(copied).toContain("TypeError: Cannot read properties of undefined (reading 'x')");
    expect(copied).toContain('at Thread (thread.tsx:4)');
    expect(copied).toContain('at App');
  });
});

describe('daemon connection page', () => {
  const gate = () => new HookHost(() => ConnectionGate({ children: app }));
  const host = (tree: ReactElement) =>
    find(tree, (n) => n.type === 'div' && n.props.children === app);

  it('covers the app while offline before any board arrived', () => {
    mock.board = { ...mock.board, status: offline };
    const tree = gate().render();
    expect(host(tree).props.hidden).toBe(true);
    const page = named(tree, 'DaemonDown');
    const screen = new HookHost(() => DaemonDown(page.props)).render();
    const alert = find(screen, (n) => n.props.role === 'alert');
    expect(text(alert)).toContain(zh('recover.daemon.title'));
    expect(text(find(alert, (n) => n.props.className === 'rc-e'))).toBe(offline.reason);
    expect(button(alert, zh('recover.daemon.retry')).props.disabled).toBe(false);
  });

  it.each([
    [
      'keeps the app on screen while offline once a board arrived',
      { board: { cursor: 1 }, status: offline },
    ],
    ['keeps the app on screen while first connecting', {}],
  ])('%s', (_name, board) => {
    mock.board = { ...mock.board, ...board };
    const tree = gate().render();
    expect(host(tree).props.hidden).toBe(false);
    expect(() => named(tree, 'DaemonDown')).toThrow();
  });

  it('retries at once, counts the seconds while connecting, and gives way to the app once live', async () => {
    mock.board = { ...mock.board, status: offline };
    const outer = gate();
    outer.render();
    let status: SyncStatus = offline;
    const screen = new HookHost(() => DaemonDown({ status }));
    button(screen.render(), zh('recover.daemon.retry')).props.onClick();
    expect(mock.board.reconnect).toHaveBeenCalledTimes(1);

    status = { state: 'connecting' };
    mock.board = { ...mock.board, status };
    expect(named(outer.render(), 'DaemonDown').props.status).toBe(status);
    let tree = screen.render();
    const waiting = find(tree, (n) => n.props.role === 'status');
    expect(button(waiting, zh('recover.daemon.retry')).props.disabled).toBe(true);
    expect(text(waiting)).toContain('正在连接 daemon，已等 0 秒');
    expect(text(find(waiting, (n) => n.props.className === 'rc-e'))).toBe(offline.reason);
    await vi.advanceTimersByTimeAsync(1000);
    tree = await screen.flush();
    expect(text(tree)).toContain('正在连接 daemon，已等 1 秒');
    await vi.advanceTimersByTimeAsync(2000);
    tree = await screen.flush();
    expect(text(tree)).toContain('正在连接 daemon，已等 3 秒');

    mock.board = { ...mock.board, board: { cursor: 1 }, status: { state: 'live' } };
    const back = outer.render();
    expect(host(back).props.hidden).toBe(false);
    expect(() => named(back, 'DaemonDown')).toThrow();
  });

  it('says it is starting the daemon while the desktop app starts it, and connecting once it only connects', async () => {
    let starting = true;
    const daemonStarting = vi.fn(async () => starting);
    Object.assign(keys, { pantheon: { daemonStarting } });
    const screen = new HookHost(() => DaemonDown({ status: { state: 'connecting' } }));
    screen.render();
    let tree = await screen.flush();
    expect(daemonStarting).toHaveBeenCalled();
    expect(text(find(tree, (n) => n.props.role === 'status'))).toContain(
      '正在启动 daemon，已等 0 秒',
    );
    await vi.advanceTimersByTimeAsync(2000);
    tree = await screen.flush();
    expect(text(tree)).toContain('正在启动 daemon，已等 2 秒');
    starting = false;
    await vi.advanceTimersByTimeAsync(1000);
    tree = await screen.flush();
    expect(text(tree)).toContain('正在连接 daemon，已等 3 秒');
    screen.unmount();
  });
});

describe('sync reconnect', () => {
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  function setup() {
    const answers: ((result: BridgeResult<unknown>) => void)[] = [];
    const bridge = {
      query: () => new Promise<BridgeResult<unknown>>((resolve) => answers.push(resolve)),
      subscribe: () => () => {},
    };
    const sync = startSync(bridge, {}, () => {});
    const fail = async () => {
      answers.at(-1)!({ ok: false, error: { code: 'unavailable', message: 'no daemon' } });
      await flush();
    };
    return { answers, sync, fail };
  }

  it('drops the pending backoff, connects at once and starts the backoff over', async () => {
    const t = setup();
    await t.fail();
    await vi.advanceTimersByTimeAsync(500);
    await t.fail();
    await vi.advanceTimersByTimeAsync(1000);
    await t.fail();
    expect(t.answers).toHaveLength(3);
    t.sync.reconnect();
    expect(t.answers).toHaveLength(4);
    // The backoff that was pending would have read again at 2 s.
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.answers).toHaveLength(4);
    await t.fail();
    await vi.advanceTimersByTimeAsync(499);
    expect(t.answers).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.answers).toHaveLength(5);
    t.sync.stop();
  });
});
