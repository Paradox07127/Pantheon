import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from './i18n-setup.js';
import { mount as mountHook, unmountAll } from './web-hook-host.js';

const mock = vi.hoisted(() => ({ board: {} as any, queued: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/screens/sessions/compose', () => ({
  useQueued: Object.assign((selector: any) => selector(mock.queued), {
    getState: () => mock.queued,
  }),
}));
import { QuitDialog } from '@/shell/QuitDialog';

let bridge: Record<string, any>;
let quitRequest: (() => void) | undefined;

const session = (id: string, state: string) => ({ id, project_id: 'alpha', state });

beforeEach(() => {
  quitRequest = undefined;
  mock.board = {
    board: { sessions: [session('a', 'open')], session_turns: [], projects: [], workspaces: [] },
  };
  mock.queued = { queued: {} };
  bridge = {
    onQuitRequest: vi.fn((listener: () => void) => {
      quitRequest = listener;
      return () => {
        quitRequest = undefined;
      };
    }),
    confirmQuit: vi.fn(async () => {}),
    askQuit: vi.fn(async () => {}),
    revealMain: vi.fn(async () => {}),
  };
  vi.stubGlobal('window', { pantheon: bridge });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const mount = () => mountHook(() => QuitDialog());

describe('quit confirmation', () => {
  it('quits at once when no session runs', () => {
    const h = mount();
    expect(h.value).toBeNull();
    expect(bridge.onQuitRequest).toHaveBeenCalledTimes(1);
    quitRequest!();
    expect(bridge.confirmQuit).toHaveBeenCalledTimes(1);
    expect(bridge.askQuit).not.toHaveBeenCalled();
  });

  it('asks the app, naming the running sessions and queued messages', () => {
    mock.board.board.sessions = [
      session('a', 'running'),
      session('b', 'running'),
      session('c', 'open'),
    ];
    mock.queued = { queued: { a: [{ text: 'one' }, { text: 'two' }], b: [] } };
    mount();
    quitRequest!();
    expect(bridge.askQuit).toHaveBeenCalledWith({
      message: '退出 Pantheon？2 个会话会留在后台继续跑',
      detail: [
        '2 个会话在跑，退出后继续跑完',
        zh('quitDialog.notifications'),
        '2 条排队消息留到下次打开再发',
      ].join('\n'),
      quit: zh('quitDialog.quit'),
      cancel: zh('quitDialog.cancel'),
    });
    expect(bridge.confirmQuit).not.toHaveBeenCalled();
    expect(bridge.revealMain).not.toHaveBeenCalled();
  });

  it('leaves the queued line out when nothing is queued', () => {
    mock.board.board.sessions = [session('a', 'running')];
    mount();
    quitRequest!();
    expect(bridge.askQuit.mock.calls[0]![0].detail).toBe(
      ['1 个会话在跑，退出后继续跑完', zh('quitDialog.notifications')].join('\n'),
    );
  });

  it('stops listening once unmounted', () => {
    const h = mount();
    h.unmount();
    expect(quitRequest).toBeUndefined();
  });
});
