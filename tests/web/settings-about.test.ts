import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { RuntimeStatus, SignalIssues } from '@pantheon/protocol';
import { find, mount as host, nodes, text, unmountAll } from './web-hook-host.js';
import { zh, zhf } from './i18n-setup.js';
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

type Issue = SignalIssues['issues'][number];
const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const errorOf = (extra: Partial<Issue> = {}): Issue => ({
  id: 'e1',
  revision: 1,
  project_id: '',
  source: 'daemon_error',
  fingerprint: 'Error: disk full',
  title: 'Error: disk full',
  state: 'open',
  count: 3,
  first_seen: NOW - 3_600_000,
  last_seen: NOW - 5 * 60_000,
  opened_at: NOW - 3_600_000,
  samples: [{ at: NOW - 5 * 60_000, text: 'Error: disk full\n  at write' }],
  ...extra,
});
let errors: Issue[] = [];

const desktop = () => ({
  appInfo: vi.fn(async () => app),
  daemon: vi.fn(async () => ({ ok: true as const, value: daemon })),
  logsDir: vi.fn(async () => '/data/pantheon/logs'),
  revealPath: vi.fn(async () => ({ ok: true as const, value: null })),
  query: vi.fn(async (method: string) =>
    method === 'app.signals'
      ? { ok: true as const, value: { issues: errors } }
      : { ok: true as const, value: [claude, codex] },
  ),
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
  errors = [];
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

describe('Pantheon errors on the about page', () => {
  const group = (tree: ReactNode) =>
    nodes(tree).find((n) => n.props['aria-label'] === zh('settings.about.errors'));
  const errorRows = (tree: ReactNode) =>
    nodes(group(tree)).filter((n) => n.props['aria-expanded'] !== undefined);

  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: NOW }));
  afterEach(() => vi.useRealTimers());

  it('lists each error with its count, last time seen and state, and opens its sample', async () => {
    errors = [
      errorOf({ id: 'old', title: 'Error: old', state: 'resolved', count: 1 }),
      errorOf({ id: 'new', title: 'Error: disk full', state: 'escalated', count: 12 }),
    ];
    vi.stubGlobal('window', { pantheon: desktop() });
    const h = await mount(() => AboutPage());
    const rowOf = (title: string) =>
      nodes(group(h.value)).find((n) => n.props['aria-label'] === title)!;
    expect(errorRows(h.value).map((n) => text(n))).toEqual(['Error: disk full', 'Error: old']);
    const age = zhf('data.age.minutes', { count: 5 });
    expect(text(rowOf('Error: disk full'))).toBe(
      `Error: disk full${zhf('project.signals.count', { count: 12 })}${age}${zh('project.signals.escalated')}`,
    );
    expect(text(rowOf('Error: old'))).toContain(zh('project.signals.resolved'));
    expect(nodes(group(h.value)).find((n) => n.type === 'pre')).toBeUndefined();
    errorRows(h.value)[0]!.props.onClick();
    h.render();
    expect(errorRows(h.value)[0]!.props['aria-expanded']).toBe(true);
    expect(text(nodes(group(h.value)).find((n) => n.type === 'pre'))).toBe(
      'Error: disk full\n  at write',
    );
  });

  it('lists every resolved error, not only the newest five', async () => {
    errors = Array.from({ length: 7 }, (_, i) =>
      errorOf({ id: `e${i}`, title: `Error: ${i}`, state: 'resolved', last_seen: NOW - i }),
    );
    vi.stubGlobal('window', { pantheon: desktop() });
    const h = await mount(() => AboutPage());
    expect(errorRows(h.value)).toHaveLength(7);
  });

  it('says when there are no errors', async () => {
    vi.stubGlobal('window', { pantheon: desktop() });
    const h = await mount(() => AboutPage());
    expect(text(group(h.value))).toContain(zh('settings.about.noErrors'));
    expect(errorRows(h.value)).toEqual([]);
    expect(zh('settings.about.noErrors')).toBe('没有报错');
  });

  it('reads the errors again on refresh', async () => {
    const bridge = desktop();
    vi.stubGlobal('window', { pantheon: bridge });
    const h = await mount(() => AboutPage());
    const reads = () => bridge.query.mock.calls.filter(([method]) => method === 'app.signals');
    expect(reads()).toHaveLength(1);
    errors = [errorOf()];
    buttons(group(h.value))
      .find((n) => text(n) === zh('settings.about.refreshErrors'))!
      .props.onClick();
    await h.flush();
    expect(reads()).toHaveLength(2);
    expect(errorRows(h.value).map((n) => text(n))).toEqual(['Error: disk full']);
  });

  it('copies the unresolved errors at the end of the diagnostics, not the resolved ones', async () => {
    errors = [
      errorOf({ id: 'a', title: 'Error: disk full', count: 3 }),
      errorOf({ id: 'b', title: 'TypeError: gone', state: 'resolved', count: 9 }),
    ];
    vi.stubGlobal('window', { pantheon: desktop() });
    const h = await mount(() => AboutPage());
    buttons(anchor(h.value, 'about.diagnostics'))[0]!.props.onClick();
    await vi.waitFor(() => expect(clipboard.writeText).toHaveBeenCalled());
    const copied = String(clipboard.writeText.mock.calls[0]![0]);
    expect(copied.split('\n').at(-1)).toBe('Daemon error: Error: disk full (3 times)');
    expect(copied).not.toContain('TypeError: gone');
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

  it('ends with each unresolved error and its count, leaving out resolved ones', () => {
    expect(
      diagnosticsText({
        protocol: 1,
        errors: [
          errorOf({ title: 'Error: disk full', state: 'open', count: 3 }),
          errorOf({ title: 'Error: busy', state: 'escalated', count: 11 }),
          errorOf({ title: 'Error: old', state: 'resolved', count: 2 }),
        ],
      }).split('\n'),
    ).toEqual([
      'Protocol: 1',
      'Daemon error: Error: disk full (3 times)',
      'Daemon error: Error: busy (11 times)',
    ]);
    expect(diagnosticsText({ protocol: 1, errors: [] })).toBe('Protocol: 1');
  });

  it('keeps a multiline error title on one line', () => {
    expect(
      diagnosticsText({
        protocol: 1,
        errors: [errorOf({ title: 'Error: command failed\n  permission denied', count: 2 })],
      }).split('\n'),
    ).toEqual(['Protocol: 1', 'Daemon error: Error: command failed permission denied (2 times)']);
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
