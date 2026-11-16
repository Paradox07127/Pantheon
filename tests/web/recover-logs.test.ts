import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { nodes, text, mount, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
const mock = vi.hoisted(() => ({ board: {} as any, notices: [] as any[], toasts: [] as any[] }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/components/Toast', async (actual) => ({
  ...(await actual<object>()),
  noticeResult: (options: unknown) => void mock.notices.push(options),
  toast: (options: unknown) => void mock.toasts.push(options),
}));
import { failureText } from '@/data/needs-you';
import { CrashNotice } from '@/shell/CrashNotice';
import { CrashScreen, DaemonDown } from '@/shell/RecoverScreen';

const desktop = () => ({
  logsDir: vi.fn(async () => '/data/logs'),
  revealPath: vi.fn(async () => ({ ok: true as const, value: null })),
  lastCrash: vi.fn(async () => null as { reason: string; exit_code: number } | null),
  daemonStarting: vi.fn(async () => false),
});

const mounted = async (body: () => ReactNode) => {
  const h = mount(body);
  await h.flush();
  return h;
};
const logsButtons = (tree: ReactNode) =>
  nodes(tree).filter(
    (n): n is ReactElement<any> =>
      n.type === 'button' && text(n.props.children) === zh('recover.logs'),
  );

const pages: [string, () => ReactNode][] = [
  ['the crash page', () => CrashScreen({ error: new Error('boom'), componentStack: null })],
  [
    'the daemon page',
    () => DaemonDown({ status: { state: 'offline', reason: 'connect ECONNREFUSED' } }),
  ],
  ['the daemon page while retrying', () => DaemonDown({ status: { state: 'connecting' } })],
];

beforeEach(() => {
  mock.notices = [];
  mock.toasts = [];
  mock.board = { board: null, status: { state: 'connecting' }, reconnect: vi.fn() };
  vi.stubGlobal('location', { reload: vi.fn() });
  vi.stubGlobal('document', { body: { dataset: {} } });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('recovery pages open the logs', () => {
  it.each(pages)('%s opens the logs folder', async (_name, page) => {
    const bridge = desktop();
    vi.stubGlobal('window', Object.assign(new EventTarget(), { pantheon: bridge }));
    const h = await mounted(page);
    const [logs] = logsButtons(h.value);
    expect(logs!.props.className).toBe('btn ghost');
    logs!.props.onClick();
    await h.flush();
    expect(bridge.revealPath).toHaveBeenCalledWith('/data/logs');
  });

  it('says why the logs folder could not be shown', async () => {
    const bridge = desktop();
    const error = { code: 'not_found', message: 'no such folder' };
    bridge.revealPath.mockImplementation(async () => ({ ok: false, error }) as never);
    vi.stubGlobal('window', Object.assign(new EventTarget(), { pantheon: bridge }));
    const h = await mounted(pages[1]![1]);
    logsButtons(h.value)[0]!.props.onClick();
    await vi.waitFor(() =>
      expect(mock.toasts).toEqual([{ title: failureText(error), kind: 'failure' }]),
    );
  });

  it.each(pages)('%s has no logs button outside the desktop app', async (_name, page) => {
    vi.stubGlobal('window', new EventTarget());
    const h = await mounted(page);
    expect(logsButtons(h.value)).toEqual([]);
  });
});

describe('crash notice', () => {
  it('tells once that the interface was reloaded after its renderer crashed', async () => {
    const bridge = desktop();
    let crash: { reason: string; exit_code: number } | null = { reason: 'oom', exit_code: 9 };
    bridge.lastCrash.mockImplementation(async () => {
      const last = crash;
      crash = null;
      return last;
    });
    vi.stubGlobal('window', { pantheon: bridge });
    await mounted(() => CrashNotice());
    // React runs a mount effect twice in development.
    await mounted(() => CrashNotice());
    expect(mock.notices).toHaveLength(1);
    const [notice] = mock.notices;
    expect(notice).toMatchObject({
      tone: 'failed',
      heading: zh('shell.crashNotice.title'),
      summary: 'oom',
    });
    expect(notice.actions.map((a: { label: string }) => a.label)).toEqual([zh('recover.logs')]);
    notice.actions[0].run();
    await vi.waitFor(() => expect(bridge.revealPath).toHaveBeenCalledWith('/data/logs'));
  });

  it('shows nothing outside the desktop app', async () => {
    vi.stubGlobal('window', {});
    await mounted(() => CrashNotice());
    expect(mock.notices).toEqual([]);
  });
});
