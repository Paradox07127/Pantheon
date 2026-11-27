import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { BridgeResult, DeviceListItem } from '@pantheon/protocol';
import { type HookHost, find, mount, nodes, text, unmountAll } from './web-hook-host.js';
import { FakeDocument } from './web-fake-dom.js';
import { zh, zhf } from './i18n-setup.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { DevicesSummary } from '@/components/DevicesSummary';
import { useBoard } from '@/data/board';
import { useSettingsView } from '@/screens/settings/view';
import { useShell } from '@/store';

const checkedAt = new Date().toISOString();
const thisMachine: DeviceListItem = {
  id: 'local',
  name: 'workstation',
  labels: [],
  online: true,
  checked_at: checkedAt,
  os: 'macos',
  os_version: '26.1',
  arch: 'arm64',
  cpus: 12,
  runtimes: {},
  tools: {},
  load: {
    active_sessions: [
      { id: 's1', title: 'Fix login', runtime: 'claude', started_at: checkedAt },
      { id: 's2', title: 'Tidy docs', runtime: 'codex', started_at: checkedAt },
    ],
  },
};
const unreachable: DeviceListItem = {
  id: 'pi5',
  name: 'pi5',
  ssh: 'pi5.lan',
  labels: [],
  online: false,
  error: 'ssh: connect to host pi5.lan port 22: Operation timed out',
  checked_at: checkedAt,
  runtimes: {},
  tools: {},
  config: { ssh: 'pi5.lan' },
  load: { active_sessions: [] },
};

let devices: DeviceListItem[] = [];
let failing = false;
const queries: string[] = [];
const bridge = {
  async query(method: string): Promise<BridgeResult<unknown>> {
    queries.push(method);
    if (failing) return { ok: false, error: { code: 'ipc_failed', message: 'daemon offline' } };
    return method === 'device.list'
      ? { ok: true, value: devices }
      : { ok: false, error: { code: 'unknown_route', message: method } };
  },
};
let doc: FakeDocument;

const ONLINE = zh('settings.devices.online');
const OFFLINE = zh('settings.devices.offline');
async function summary() {
  const h = mount(() => DevicesSummary());
  await h.flush();
  return h;
}
const tree = (h: HookHost<any>) => h.value as ReactNode;
const trigger = (t: ReactNode, online = 1) =>
  find(
    t,
    (n) => n.props['aria-label'] === zhf('components.devicesSummary.summary', { online, total: 2 }),
  );
const rows = (t: ReactNode) => nodes(t).filter((n) => n.type === 'li');
const status = (t: ReactNode) =>
  find(t, (n) => n.props.role === 'img').props['aria-label'] as string;
async function openPopover(h: HookHost<any>) {
  find(tree(h), (n) => typeof n.props.onOpenChange === 'function').props.onOpenChange(true);
  await h.flush();
  return tree(h);
}

beforeEach(() => {
  queries.length = 0;
  failing = false;
  useBoard.setState({ events: [], resync: 0 });
  doc = new FakeDocument();
  vi.stubGlobal('window', { pantheon: bridge });
  vi.stubGlobal('document', doc);
  useSettingsView.setState({ open: false, page: 'general' });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('title bar device summary', () => {
  it('shows nothing while this machine is the only device', async () => {
    devices = [thisMachine];
    const h = await summary();
    expect(queries).toContain('device.list');
    expect(h.value).toBeNull();
    expect(doc.documentElement.hasAttribute('data-title-devices')).toBe(false);
  });

  it('counts the online devices, and lists each with its state and sessions', async () => {
    devices = [thisMachine, unreachable];
    const h = await summary();
    expect(text(trigger(tree(h)).props.children)).toBe('1');
    expect(doc.documentElement.hasAttribute('data-title-devices')).toBe(true);
    const shown = rows(await openPopover(h));
    expect(shown).toHaveLength(2);
    expect(text(shown[0])).toContain(zh('settings.devices.thisMac'));
    expect(text(shown[0])).toContain(zhf('components.devicesSummary.sessions', { count: 2 }));
    expect(text(shown[0])).toContain('arm64');
    expect(status(shown[0])).toBe(ONLINE);
    expect(text(shown[1])).toContain('pi5');
    expect(text(shown[1])).toContain(OFFLINE);
    expect(status(shown[1])).toBe(OFFLINE);
  });

  it('opens the devices page of the settings from its link', async () => {
    devices = [thisMachine, unreachable];
    const h = await summary();
    const opened = await openPopover(h);
    find(
      opened,
      (n) =>
        n.type === 'button' && text(n.props.children) === zh('components.devicesSummary.settings'),
    ).props.onClick();
    await h.flush();
    expect(useSettingsView.getState()).toMatchObject({ open: true, page: 'devices' });
    expect(find(tree(h), (n) => 'onOpenChange' in n.props).props.open).toBe(false);
  });

  const arrive = async (h: HookHost<any>, sequence: number, kind: string) => {
    const event = { sequence, kind, event_id: `e${sequence}` } as never;
    useBoard.setState({ events: [...useBoard.getState().events, event] });
    h.render();
    await h.flush();
  };

  it('shows a device registered while the window is open, its probe once answered, and drops one removed', async () => {
    devices = [thisMachine];
    const h = await summary();
    expect(h.value).toBeNull();
    devices = [thisMachine, unreachable];
    await arrive(h, 1, 'session.turn.delivery');
    expect(h.value).toBeNull();
    await arrive(h, 2, 'device.saved');
    expect(text(trigger(tree(h)).props.children)).toBe('1');
    // The probe of the new device answers after the list was read on device.saved.
    devices = [thisMachine, { ...unreachable, online: true }];
    await arrive(h, 3, 'device.probed');
    expect(text(trigger(tree(h), 2).props.children)).toBe('2');
    devices = [thisMachine];
    await arrive(h, 4, 'device.removed');
    expect(h.value).toBeNull();
  });

  it('reads again when a session on a device opens, ends or is deleted', async () => {
    devices = [thisMachine, unreachable];
    const h = await summary();
    const reads = () => queries.filter((q) => q === 'device.list').length;
    const before = reads();
    let sequence = 0;
    for (const kind of [
      'session.opened',
      'session.renamed',
      'session.merged',
      'session.discarded',
      'session.closed',
      'session.deleted',
    ]) {
      await arrive(h, ++sequence, kind);
      expect(reads(), kind).toBe(before + sequence);
    }
  });

  it('lists up to three sessions under an online device, each opening its session', async () => {
    const openSession = vi.fn();
    const shell = useShell.getState();
    useShell.setState({ openSession });
    const session = (id: string) => ({
      id,
      title: `Session ${id}`,
      runtime: 'claude',
      started_at: checkedAt,
    });
    devices = [
      { ...thisMachine, load: { active_sessions: ['a', 'b', 'c', 'd', 'e'].map(session) } },
      { ...unreachable, load: { active_sessions: [session('far')] } },
    ];
    try {
      const h = await summary();
      const shown = rows(await openPopover(h));
      const opens = (row: ReactNode) =>
        nodes(row).filter((n) => n.type === 'button' && text(n).includes('Session '));
      expect(opens(shown[0]).map((n) => text(n))).toEqual(
        ['a', 'b', 'c'].map((id) => expect.stringContaining(`Session ${id}`)),
      );
      expect(text(opens(shown[0])[0])).toContain('Claude');
      expect(text(shown[0])).toContain(zhf('components.devicesSummary.more', { count: 2 }));
      expect(opens(shown[1])).toEqual([]);
      opens(shown[0])[1]!.props.onClick();
      await h.flush();
      expect(openSession).toHaveBeenCalledWith('b');
      expect(find(tree(h), (n) => 'onOpenChange' in n.props).props.open).toBe(false);
    } finally {
      useShell.setState(shell);
    }
  });

  it('opens a session of another project in that project, under the title the board gives it', async () => {
    const openProjectSession = vi.fn();
    const shell = useShell.getState();
    useShell.setState({ openProjectSession });
    devices = [
      {
        ...thisMachine,
        load: {
          active_sessions: [{ id: 'far', title: '', runtime: 'codex', started_at: checkedAt }],
        },
      },
      unreachable,
    ];
    useBoard.setState({
      board: {
        sessions: [{ id: 'far', project_id: 'other-project', title: 'Fix the importer' }],
        projects: [],
      } as never,
    });
    try {
      const h = await summary();
      const row = rows(await openPopover(h))[0];
      const open = find(row, (n) => n.type === 'button' && text(n).includes('Fix the importer'));
      open.props.onClick();
      await h.flush();
      expect(openProjectSession).toHaveBeenCalledWith('other-project', 'far');
    } finally {
      useShell.setState(shell);
      useBoard.setState({ board: null });
    }
  });

  it('reads again a while after a failed read, as when the daemon was still starting', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      failing = true;
      devices = [thisMachine, unreachable];
      const h = await summary();
      expect(h.value).toBeNull();
      failing = false;
      vi.advanceTimersByTime(5_000);
      await h.flush();
      expect(text(trigger(tree(h)).props.children)).toBe('1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads again after a failed read, on the next device event or resync', async () => {
    failing = true;
    devices = [thisMachine, unreachable];
    const h = await summary();
    expect(h.value).toBeNull();
    failing = false;
    await arrive(h, 1, 'device.saved');
    expect(text(trigger(tree(h)).props.children)).toBe('1');
    failing = true;
    await arrive(h, 2, 'device.removed');
    failing = false;
    useBoard.setState({ resync: 1 });
    h.render();
    await h.flush();
    expect(text(trigger(tree(h)).props.children)).toBe('1');
    expect(queries.filter((q) => q === 'device.list')).toHaveLength(4);
  });
});
