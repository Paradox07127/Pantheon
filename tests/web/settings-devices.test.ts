import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { BridgeResult, DeviceListItem, RuntimeStatus, SshHost } from '@pantheon/protocol';
import { type HookHost, deferred, find, mount, nodes, text, unmountAll } from './web-hook-host.js';
import { zh, zhf } from './i18n-setup.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useBoard } from '@/data/board';
import { DevicesPage } from '@/screens/settings/DevicesPage';
import { pageHeader } from '@/screens/settings/settings-header';
import { useSettingsView } from '@/screens/settings/view';
import { useShell } from '@/store';

type Command = { type: string; input: Record<string, unknown>; expected_revision: number | null };

const bridge = {
  answers: {} as Record<string, unknown>,
  /** Answers a query of the method once the test settles it. */
  held: {} as Record<string, Promise<BridgeResult<unknown>>>,
  commandAnswer: { ok: true, value: {} } as BridgeResult<unknown>,
  queries: [] as { method: string; params?: Record<string, string> }[],
  commands: [] as Command[],
  async query(method: string, params?: Record<string, string>): Promise<BridgeResult<unknown>> {
    bridge.queries.push({ method, params });
    if (method in bridge.held) return bridge.held[method]!;
    return method in bridge.answers
      ? { ok: true, value: bridge.answers[method] }
      : { ok: false, error: { code: 'unknown_route', message: method } };
  },
  async command(command: Command): Promise<BridgeResult<unknown>> {
    bridge.commands.push(command);
    return bridge.commandAnswer;
  },
};

const checkedAt = new Date(Date.now() - 3 * 60_000).toISOString();
const thisMachine: DeviceListItem = {
  id: 'local',
  name: 'workstation',
  labels: ['xcode'],
  resources: { display: 1 },
  max_sessions: 12,
  online: true,
  checked_at: checkedAt,
  os: 'macos',
  os_version: '26.1',
  arch: 'arm64',
  cpus: 12,
  memory_bytes: 36 * 2 ** 30,
  load_1m: 2.41,
  runtimes: {},
  tools: { git: 'git version 2.50.1 (Apple Git-155)' },
  load: { sessions: 2, uses: {}, active_sessions: [] },
};
const studioConfig = {
  ssh: 'devbox.local',
  name: 'studio',
  labels: ['xcode', 'docker'],
  resources: { simulator: 2 },
  max_sessions: 2,
};
const studio: DeviceListItem = {
  id: 'studio',
  name: 'studio',
  ssh: 'devbox.local',
  labels: ['xcode', 'docker'],
  resources: { simulator: 2 },
  max_sessions: 2,
  online: true,
  checked_at: checkedAt,
  os: 'linux',
  os_version: 'Ubuntu 24.04.2 LTS',
  arch: 'x86_64',
  cpus: 24,
  memory_bytes: 128 * 2 ** 30,
  load_1m: 0.92,
  runtimes: {
    claude: { binary: '/usr/local/bin/claude', version: '2.1.0 (Claude Code)', logged_in: false },
    codex: { binary: '/usr/local/bin/codex', version: 'codex-cli 0.50.0', logged_in: true },
  },
  tools: { node: 'v24.3.0' },
  config: studioConfig,
  load: { sessions: 1, uses: { simulator: 1 }, active_sessions: [] },
};
const unreachable: DeviceListItem = {
  id: 'pi5',
  name: 'pi5',
  ssh: 'pi5.lan',
  labels: [],
  resources: {},
  max_sessions: 1,
  online: false,
  error: 'ssh: connect to host pi5.lan port 22: Operation timed out',
  checked_at: checkedAt,
  runtimes: {},
  tools: {},
  config: { ssh: 'pi5.lan' },
  load: { sessions: 0, uses: {}, active_sessions: [] },
};
const runtime = (name: string): RuntimeStatus => ({
  runtime: name,
  enabled: true,
  installed: true,
  version: '2.1.312',
  min_version: null,
  version_ok: null,
  auth: { state: 'ok' },
  checked_at: checkedAt,
});
const sshHosts: SshHost[] = [
  { host: 'devbox.local', hostname: '10.0.0.5', user: 'builder', device_id: 'studio' },
  { host: 'GPU.Box', hostname: 'gpu.lan' },
];

const HOST = zh('settings.devices.host');
const ADD = zh('settings.devices.add');
const OFFLINE = zh('settings.devices.offline');
const ONLINE = zh('settings.devices.online');
const TESTING = zh('settings.devices.testing');
const BACK = zh('settings.devices.back');
const REPROBE_ALL = zh('settings.devices.reprobeAll');
async function page() {
  const h = mount(() => DevicesPage());
  await h.flush();
  return h;
}
const tree = (h: HookHost<any>) => h.value as ReactNode;
const labelled = (t: ReactNode, label: string) => find(t, (n) => n.props['aria-label'] === label);
const button = (t: ReactNode, label: string) =>
  find(t, (n) => n.type === 'button' && text(n.props.children) === label);
const rows = (t: ReactNode) =>
  nodes(labelled(t, zh('settings.devices.title')).props.children).filter((n) => n.type === 'li');
const row = (t: ReactNode, name: string) => rows(t).find((n) => text(n).includes(name))!;
const commands = () => bridge.commands.map((c) => [c.type, c.input]);
const deviceReads = () => bridge.queries.filter((q) => q.method.startsWith('device.'));
async function open(h: HookHost<any>, name: string) {
  find(row(tree(h), name), (n) => n.type === 'button' && text(n).includes(name)).props.onClick();
  await h.flush();
  return tree(h);
}
const status = (t: ReactElement<any> | ReactNode) =>
  find(
    t,
    (n) => n.props.role === 'img' && [ONLINE, OFFLINE, TESTING].includes(n.props['aria-label']),
  ).props['aria-label'];

beforeEach(() => {
  bridge.answers = {
    'device.list': [thisMachine, studio, unreachable],
    'device.ssh_hosts': sshHosts,
    'runtime.status': [runtime('claude')],
  };
  bridge.held = {};
  bridge.commandAnswer = { ok: true, value: {} };
  bridge.queries = [];
  bridge.commands = [];
  vi.stubGlobal('window', { pantheon: bridge });
  useBoard.setState({ board: { cursor: 1, projects: [], sessions: [] } } as never);
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  useBoard.setState({ board: null });
});

describe('devices list', () => {
  it('shows each device by name, system, architecture, cores and memory only', async () => {
    const h = await page();
    const shown = rows(tree(h));
    expect(shown).toHaveLength(3);
    expect(text(shown[0])).toContain(zh('settings.devices.thisMac'));
    const remote = text(shown[1]);
    for (const fact of [
      'studio',
      'Ubuntu 24.04.2 LTS',
      'x86_64',
      zhf('settings.devices.cores', { count: 24 }),
      zhf('settings.devices.memory', { count: 128 }),
    ])
      expect(remote).toContain(fact);
    for (const detail of ['devbox.local', 'xcode', '1 / 2', '0.92', 'codex'])
      expect(remote).not.toContain(detail);
    expect(status(shown[1])).toBe(ONLINE);
    expect(text(shown[2])).toContain(OFFLINE);
    expect(status(shown[2])).toBe(OFFLINE);
  });

  it('names when an unreachable device was last online', async () => {
    const lastOnline = new Date(Date.now() - 3 * 3_600_000 - 60_000).toISOString();
    bridge.answers['device.list'] = [thisMachine, { ...unreachable, last_online_at: lastOnline }];
    const h = await page();
    expect(text(rows(tree(h))[1])).toContain('上次在线 3 小时');
  });

  it('gives no time for an unreachable device never reached', async () => {
    const h = await page();
    const shown = text(rows(tree(h))[2]);
    expect(shown).toContain(OFFLINE);
    expect(shown).not.toContain('前');
  });

  it('tests one device, breathing while it waits, then shows whether it answered', async () => {
    const probe = deferred<BridgeResult<unknown>>();
    bridge.held['device.probe'] = probe.promise;
    const h = await page();
    const test = labelled(row(tree(h), 'pi5'), zhf('settings.devices.testOf', { name: 'pi5' }));
    test.props.onClick();
    await h.flush();
    expect(status(row(tree(h), 'pi5'))).toBe(TESTING);
    expect(status(row(tree(h), 'studio'))).toBe(ONLINE);
    expect(
      labelled(row(tree(h), 'pi5'), zhf('settings.devices.testOf', { name: 'pi5' })).props.disabled,
    ).toBe(true);
    bridge.answers['device.list'] = [thisMachine, studio, { ...unreachable, online: true }];
    probe.resolve({ ok: true, value: { ...unreachable, online: true } });
    await h.flush();
    await h.flush();
    expect(
      deviceReads()
        .filter((q) => q.method !== 'device.ssh_hosts')
        .map((q) => [q.method, q.params]),
    ).toEqual([
      ['device.list', {}],
      ['device.probe', { id: 'pi5' }],
      ['device.list', {}],
    ]);
    expect(status(row(tree(h), 'pi5'))).toBe(ONLINE);
  });

  it('probes every device again from a tool at the end of the header', async () => {
    const h = await page();
    expect(nodes(tree(h)).filter((n) => text(n.props.children) === REPROBE_ALL)).toEqual([]);
    const Tools = pageHeader('devices').tools as (props: { project: null }) => ReactNode;
    const tools = mount(() => Tools({ project: null }));
    await tools.flush();
    button(tools.value as ReactNode, REPROBE_ALL).props.onClick();
    await h.flush();
    expect(bridge.queries.filter((q) => q.method === 'device.list').map((q) => q.params)).toEqual([
      {},
      { refresh: 'true' },
    ]);
  });
});

describe('device details', () => {
  it('opens a device with each runtime, its version and sign-in, and goes back', async () => {
    const h = await page();
    const shown = await open(h, 'studio');
    expect(() => labelled(shown, zh('settings.devices.title'))).toThrow();
    const all = text(shown);
    expect(all).toContain('devbox.local');
    expect(all).toContain('2.1.0');
    expect(all).toContain('0.50.0');
    expect(all).toContain('ssh -t devbox.local claude auth login');
    expect(all).not.toContain('ssh -t devbox.local codex login');
    expect(
      labelled(shown, zhf('settings.devices.needsSignInOf', { runtime: 'Claude' })).props.role,
    ).toBe('img');
    expect(labelled(shown, zhf('settings.devices.signedIn', { runtime: 'Codex' })).props.role).toBe(
      'img',
    );
    expect(all).toContain('xcode');
    expect(all).toContain('node 24.3.0');
    button(shown, BACK).props.onClick();
    await h.flush();
    expect(rows(tree(h))).toHaveLength(3);
  });

  it('names a runtime the device lacks as not installed', async () => {
    bridge.answers['device.list'] = [
      thisMachine,
      { ...studio, runtimes: { codex: studio.runtimes.codex! } },
    ];
    const h = await page();
    const shown = await open(h, 'studio');
    expect(text(shown)).toContain(zh('settings.devices.notInstalled'));
  });

  it('shows why an unreachable device could not be reached', async () => {
    const h = await page();
    const shown = await open(h, 'pi5');
    expect(text(shown)).toContain('ssh: connect to host pi5.lan port 22: Operation timed out');
  });

  it.each([
    [
      'raises the session limit with the rest of the configuration unchanged',
      () => zhf('settings.devices.raiseMax', { name: 'studio' }),
      { max_sessions: 3 },
    ],
    [
      'removes one configured label and keeps the other fields',
      () => zhf('settings.devices.removeLabel', { name: 'studio', label: 'xcode' }),
      { labels: ['docker'] },
    ],
  ])('%s', async (_, label, change) => {
    const h = await page();
    const shown = await open(h, 'studio');
    labelled(shown, label()).props.onClick();
    await h.flush();
    expect(commands()).toEqual([['device.save', { id: 'studio', ...studioConfig, ...change }]]);
  });

  it('removes a device and goes back to the list', async () => {
    const h = await page();
    const shown = await open(h, 'studio');
    bridge.answers['device.list'] = [thisMachine, unreachable];
    button(shown, zh('settings.devices.remove')).props.onClick();
    await h.flush();
    await h.flush();
    expect(commands()).toEqual([['device.remove', { id: 'studio' }]]);
    expect(rows(tree(h))).toHaveLength(2);
  });

  it('shows this machine read-only', async () => {
    const h = await page();
    const shown = await open(h, zh('settings.devices.thisMac'));
    expect(text(shown)).toContain('display');
    expect(
      nodes(shown)
        .filter((n) => n.type === 'button')
        .map((n) => n.props['aria-label'] ?? text(n.props.children)),
    ).toEqual([BACK, zhf('settings.devices.testOf', { name: zh('settings.devices.thisMac') })]);
  });

  it('names the session count and the load figure of a device', async () => {
    const h = await page();
    const local = await open(h, zh('settings.devices.thisMac'));
    expect(text(local)).toContain(zhf('settings.devices.sessions', { count: 2 }));
    const meter = labelled(local, zhf('settings.devices.loadOf', { percent: 20, load: '2.41' }));
    expect(meter.props.role).toBe('img');
    button(local, BACK).props.onClick();
    await h.flush();
    const remote = await open(h, 'studio');
    expect(text(remote)).toContain(zhf('settings.devices.sessionsOf', { count: 1, max: 2 }));
  });

  it('names the sessions that hold a resource, and only the count where they are unknown', async () => {
    const started = new Date(Date.now() - 5 * 60_000).toISOString();
    bridge.answers['device.list'] = [
      thisMachine,
      {
        ...studio,
        load: {
          sessions: 1,
          uses: { simulator: 1 },
          active_sessions: [
            { id: 'refunds', title: 'Refund list', runtime: 'codex', started_at: started },
          ],
          resource_sessions: { simulator: ['refunds'] },
        },
      },
    ];
    const h = await page();
    const studioPanel = await open(h, 'studio');
    expect(text(studioPanel)).toContain(
      zhf('settings.devices.usedBy', {
        sessions: zhf('settings.devices.quoted', { title: 'Refund list' }),
      }),
    );
    button(studioPanel, BACK).props.onClick();
    await h.flush();
    const localPanel = await open(h, zh('settings.devices.thisMac'));
    expect(text(localPanel)).toContain('0 / 1');
  });

  it('lists the open sessions of a device and opens one in its project', async () => {
    const openProjectSession = vi.fn();
    const shell = useShell.getState();
    useShell.setState({ openProjectSession });
    useSettingsView.setState({ open: true, page: 'devices' as never });
    useBoard.setState({
      board: {
        cursor: 1,
        projects: [],
        sessions: [{ id: 'refunds', project_id: 'payments', runtime: 'codex', state: 'open' }],
      },
    } as never);
    const started = new Date(Date.now() - 12 * 60_000).toISOString();
    bridge.answers['device.list'] = [
      thisMachine,
      {
        ...studio,
        load: {
          sessions: 2,
          uses: {},
          active_sessions: [
            { id: 'refunds', title: 'Refund list', runtime: 'codex', started_at: started },
            { id: 'elsewhere', title: 'Signature review', runtime: 'claude', started_at: started },
          ],
        },
      },
    ];
    try {
      const h = await page();
      const shown = await open(h, 'studio');
      expect(text(shown)).toContain(zh('settings.devices.running'));
      expect(text(shown)).toContain('Signature review');
      expect(
        nodes(shown).filter((n) => n.type === 'button' && text(n).includes('Signature review')),
      ).toEqual([]);
      const session = find(shown, (n) => n.type === 'button' && text(n).includes('Refund list'));
      expect(text(session)).toContain('12 分钟');
      session.props.onClick();
      expect(openProjectSession).toHaveBeenCalledWith('payments', 'refunds');
      expect(useSettingsView.getState().open).toBe(false);
    } finally {
      useShell.setState(shell);
      useSettingsView.setState({ open: false, page: 'general' });
    }
  });
});

describe('adding devices', () => {
  const useHost = (t: ReactNode, host: string) =>
    labelled(t, zhf('settings.devices.useHost', { host }));

  it('lists the hosts of the SSH config with a switch that is on for the added ones', async () => {
    const h = await page();
    expect(useHost(tree(h), 'devbox.local').props.checked).toBe(true);
    expect(useHost(tree(h), 'GPU.Box').props.checked).toBe(false);
    expect(text(tree(h))).toContain('builder@10.0.0.5');
    expect(text(tree(h))).toContain('gpu.lan');
  });

  it('adds a host under an id made from its name and tests only that device', async () => {
    const h = await page();
    useHost(tree(h), 'GPU.Box').props.onChange({ target: { checked: true } });
    await h.flush();
    await h.flush();
    expect(commands()).toEqual([['device.save', { id: 'gpu-box', ssh: 'GPU.Box' }]]);
    expect(deviceReads()).toContainEqual({ method: 'device.probe', params: { id: 'gpu-box' } });
    expect(deviceReads()).not.toContainEqual({
      method: 'device.list',
      params: { refresh: 'true' },
    });
  });

  it('removes the device a host reaches when its switch goes off', async () => {
    const h = await page();
    useHost(tree(h), 'devbox.local').props.onChange({ target: { checked: false } });
    await h.flush();
    expect(commands()).toEqual([['device.remove', { id: 'studio' }]]);
  });

  it('adds a host typed by hand, then tests it', async () => {
    const h = await page();
    labelled(tree(h), HOST).props.onChange({ target: { value: 'My.Host' } });
    await h.flush();
    button(tree(h), ADD).props.onClick();
    await h.flush();
    await h.flush();
    expect(commands()).toEqual([['device.save', { id: 'my-host', ssh: 'My.Host' }]]);
    expect(deviceReads()).toContainEqual({ method: 'device.probe', params: { id: 'my-host' } });
  });

  it('sends nothing for a host name that names a device already there', async () => {
    const h = await page();
    labelled(tree(h), HOST).props.onChange({ target: { value: 'Studio' } });
    await h.flush();
    button(tree(h), ADD).props.onClick();
    await h.flush();
    expect(bridge.commands).toEqual([]);
    expect(text(tree(h))).toContain(zhf('settings.devices.duplicate', { id: 'studio' }));
  });

  it('adds nothing while the device list it checks names against has not loaded', async () => {
    delete bridge.answers['device.list'];
    const h = await page();
    labelled(tree(h), HOST).props.onChange({ target: { value: 'Studio' } });
    await h.flush();
    button(tree(h), ADD).props.onClick();
    await h.flush();
    expect(bridge.commands).toEqual([]);
    expect(button(tree(h), ADD).props.disabled).toBe(true);
    expect(labelled(tree(h), HOST).props.disabled).toBe(true);
  });
});
