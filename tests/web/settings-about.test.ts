import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { RuntimeStatus } from '@pantheon/protocol';
import { find, mount as host, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
const mock = vi.hoisted(() => ({ notices: [] as unknown[] }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/components/Toast', async (actual) => ({
  ...(await actual<object>()),
  noticeResult: (options: unknown) => void mock.notices.push(options),
}));
import { useBoard } from '@/data/board';
import { runMenuAction } from '@/lib/menu-actions';
import { AboutPage } from '@/screens/settings/AboutPage';
import { diagnosticsText } from '@/screens/settings/diagnostics';
import { searchSettings } from '@/screens/settings/settings-search';
import { SETTINGS_PAGES, useSettingsView } from '@/screens/settings/view';

const app = {
  version: '0.9.2',
  electron: '38.1.0',
  os: 'macos' as const,
  os_version: '15.1',
  arch: 'arm64',
};
const daemon = {
  url: 'http://127.0.0.1:1',
  version: '0.9.3',
  protocol_version: 1,
  started_here: true,
  data_dir: '/data/pantheon',
};
const claude: RuntimeStatus = {
  runtime: 'claude',
  enabled: true,
  installed: true,
  version: '2.1.312',
  min_version: null,
  version_ok: null,
  auth: { state: 'ok', email: 'dev@example.com', plan: 'max' },
  checked_at: '2026-01-01T00:00:00.000Z',
};
const codex: RuntimeStatus = {
  ...claude,
  runtime: 'codex',
  version: '0.50.0',
  auth: { state: 'logged_out' },
};

const desktop = () => ({
  appInfo: vi.fn(async () => app),
  daemon: vi.fn(async () => ({ ok: true as const, value: daemon })),
  logsDir: vi.fn(async () => '/data/pantheon/logs'),
  revealPath: vi.fn(async () => ({ ok: true as const, value: null })),
  query: vi.fn(async () => ({ ok: true as const, value: [claude, codex] })),
});
let clipboard: { writeText: ReturnType<typeof vi.fn> };

async function mount(body: () => ReactNode) {
  const h = host(body);
  await h.flush();
  return h;
}
const cells = (tree: ReactNode) =>
  nodes(tree).filter((n): n is ReactElement<any> => n.props.className === 'cell');
const anchor = (tree: ReactNode, id: string) =>
  nodes(tree).find((n) => n.props['data-setting-id'] === id);
const buttons = (tree: ReactNode) => nodes(tree).filter((n) => n.type === 'button');

beforeEach(() => {
  mock.notices = [];
  clipboard = { writeText: vi.fn(async () => {}) };
  vi.stubGlobal('navigator', { userAgent: 'Macintosh', clipboard });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  useBoard.setState({
    board: { cursor: 1, projects: [], sessions: [] },
    status: { state: 'live' },
  } as never);
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  useBoard.setState({ board: null });
  useSettingsView.setState({ open: false, page: 'general', query: '' });
});

describe('about page', () => {
  it('comes last among the pages for this computer', () => {
    const app = SETTINGS_PAGES.filter((p) => p.group === 'app').map((p) => p.key);
    expect(app.at(-1)).toBe('about');
  });

  it('shows the app, daemon and protocol versions, with whether the daemon runs', async () => {
    vi.stubGlobal('window', { pantheon: desktop() });
    const h = await mount(() => AboutPage());
    const shown = cells(h.value);
    expect(shown.map((c) => text(c))).toEqual([
      `${zh('settings.about.app')}0.9.2`,
      `${zh('settings.about.daemon')}0.9.3`,
      `${zh('settings.about.protocol')}1`,
    ]);
    const dot = find(shown[1], (n) => n.props.role === 'img');
    expect(dot.props['data-s']).toBe('ok');
    expect(dot.props['aria-label']).toBe(zh('settings.about.running'));

    useBoard.setState({ status: { state: 'offline', reason: 'down' } } as never);
    h.render();
    const down = find(cells(h.value)[1], (n) => n.props.role === 'img');
    expect(down.props['data-s']).toBe('idle');
    expect(down.props['aria-label']).toBe(zh('settings.about.notConnected'));
  });

  it('shows the data and logs folders, each with a button that shows it', async () => {
    const bridge = desktop();
    vi.stubGlobal('window', { pantheon: bridge });
    const h = await mount(() => AboutPage());
    const data = anchor(h.value, 'about.dataFolder')!;
    expect(text(data)).toBe(`${zh('settings.data.title')}/data/pantheon${zh('lib.reveal.finder')}`);
    expect(find(data, (n) => n.props.title === '/data/pantheon').props.children).toBe(
      '/data/pantheon',
    );
    buttons(data)[0]!.props.onClick();
    expect(bridge.revealPath).toHaveBeenLastCalledWith('/data/pantheon');

    const logs = anchor(h.value, 'about.logs')!;
    expect(text(logs)).toBe(
      `${zh('settings.about.logs')}/data/pantheon/logs${zh('settings.about.openLogs')}`,
    );
    buttons(logs)[0]!.props.onClick();
    expect(bridge.revealPath).toHaveBeenLastCalledWith('/data/pantheon/logs');
  });

  it('copies the diagnostics and says so on the button', async () => {
    vi.stubGlobal('window', { pantheon: desktop() });
    const h = await mount(() => AboutPage());
    const row = () => anchor(h.value, 'about.diagnostics')!;
    expect(text(row())).toBe(
      `${zh('settings.about.diagnostics')}${zh('settings.about.copyDiagnostics')}`,
    );
    buttons(row())[0]!.props.onClick();
    await vi.waitFor(async () =>
      expect((await h.flush(), text(row()))).toBe(
        `${zh('settings.about.diagnostics')}${zh('settings.about.copied')}`,
      ),
    );
    expect(clipboard.writeText).toHaveBeenCalledWith(
      [
        'App: 0.9.2',
        'Electron: 38.1.0',
        'OS: macOS 15.1',
        'Architecture: arm64',
        'Daemon: 0.9.3',
        'Protocol: 1',
        'Data folder: /data/pantheon',
        'Logs folder: /data/pantheon/logs',
        'Runtime claude: 2.1.312, signed in: ok',
        'Runtime codex: 0.50.0, signed in: logged_out',
      ].join('\n'),
    );
  });

  it('without the desktop app shows the daemon and protocol only, and still copies', async () => {
    vi.stubGlobal('window', {});
    const h = await mount(() => AboutPage());
    expect(cells(h.value).map((c) => text(c).replace(/[^\p{L}\d]+$/u, ''))).toEqual([
      zh('settings.about.daemon'),
      `${zh('settings.about.protocol')}1`,
    ]);
    expect(anchor(h.value, 'about.logs')).toBeUndefined();
    expect(buttons(anchor(h.value, 'about.dataFolder'))).toEqual([]);
    buttons(anchor(h.value, 'about.diagnostics'))[0]!.props.onClick();
    await h.flush();
    expect(clipboard.writeText).toHaveBeenCalledWith('Protocol: 1');
  });
});

describe('diagnostics text', () => {
  it('names versions, folders and sign-in states, one per line, without account names', () => {
    const lines = diagnosticsText({
      app,
      daemon,
      protocol: 1,
      logs_dir: '/logs',
      runtimes: [claude, { ...codex, installed: false, version: null }],
    }).split('\n');
    expect(lines).toEqual([
      'App: 0.9.2',
      'Electron: 38.1.0',
      'OS: macOS 15.1',
      'Architecture: arm64',
      'Daemon: 0.9.3',
      'Protocol: 1',
      'Data folder: /data/pantheon',
      'Logs folder: /logs',
      'Runtime claude: 2.1.312, signed in: ok',
      'Runtime codex: not installed, signed in: logged_out',
    ]);
    expect(lines.join('\n')).not.toContain('dev@example.com');
    expect(lines.join('\n')).not.toContain('max');
  });

  it('leaves out what is not known', () => {
    expect(diagnosticsText({ protocol: 1 })).toBe('Protocol: 1');
  });
});

describe('about menu actions', () => {
  it('copies the diagnostics and shows a result card', async () => {
    vi.stubGlobal('window', { pantheon: desktop() });
    runMenuAction('copy-diagnostics');
    await vi.waitFor(() => expect(mock.notices).toHaveLength(1));
    expect(clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('App: 0.9.2'));
    expect(mock.notices[0]).toMatchObject({
      tone: 'done',
      heading: zh('settings.about.diagnosticsCopied'),
    });
  });
});

describe('about search', () => {
  it.each(['版本', '日志', 'version', 'logs'])('lands on the about page for %s', (query) => {
    expect(searchSettings(query)[0]?.page).toBe('about');
  });
});
