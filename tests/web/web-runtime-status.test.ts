import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeStatus } from '@pantheon/protocol';
import { deferred, mount, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import {
  offeredRuntimes,
  unavailableReason,
  useConnectionsStatus,
  useRuntimeStatus,
} from '@/data/runtime-status';
import { zh, zhf } from './i18n-setup.js';

const rs = (id: string) => zh(`data.runtimeStatus.${id}`);

const status = (extra: Partial<RuntimeStatus> = {}): RuntimeStatus => ({
  runtime: 'claude',
  enabled: true,
  installed: true,
  version: '2.1.312',
  min_version: '2.1.312',
  version_ok: true,
  auth: { state: 'ok' },
  checked_at: '2026-11-11T00:00:00.000Z',
  ...extra,
});

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('runtime unavailable reason', () => {
  it.each([
    [
      'not installed',
      status({ installed: false, version: null, version_ok: null }),
      rs('notInstalled'),
    ],
    [
      'too old',
      status({ version: '2.0.0', version_ok: false }),
      zhf('data.runtimeStatus.versionBelow', { version: '2.1.312' }),
    ],
    ['logged out', status({ auth: { state: 'logged_out' } }), rs('loggedOut')],
    [
      'on another channel',
      status({ auth: { state: 'unsupported_channel' } }),
      rs('notSubscription'),
    ],
  ])('names why a runtime %s cannot start a session', (_, given, reason) => {
    expect(unavailableReason(given)).toBe(reason);
  });

  it('leaves a runtime whose login check could not tell usable', () => {
    expect(unavailableReason(status({ auth: { state: 'unknown' } }))).toBeNull();
    expect(unavailableReason(status({ version_ok: null }))).toBeNull();
    expect(unavailableReason(status())).toBeNull();
  });
});

describe('runtime status read', () => {
  it('reads on mount, again every five minutes, and checks again on refresh', async () => {
    vi.useFakeTimers();
    const query = vi.fn(async () => ({
      ok: true as const,
      value: [
        status({ runtime: 'claude', installed: false, version: null, version_ok: null }),
        status({ runtime: 'codex' }),
      ],
    }));
    vi.stubGlobal('window', { pantheon: { query } });
    const h = mount(() => useRuntimeStatus());
    await h.flush();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenLastCalledWith('runtime.status', {});
    expect(h.value.unavailable).toEqual({ claude: rs('notInstalled') });

    vi.advanceTimersByTime(5 * 60_000);
    await h.flush();
    expect(query).toHaveBeenCalledTimes(2);

    h.value.refresh();
    await h.flush();
    expect(query).toHaveBeenCalledTimes(3);
    expect(query).toHaveBeenLastCalledWith('runtime.status', { refresh: 'true' });

    h.unmount();
    vi.advanceTimersByTime(10 * 60_000);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('greys out nothing when the daemon cannot answer', async () => {
    const query = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'not_implemented', message: 'runtime.status' },
    }));
    vi.stubGlobal('window', { pantheon: { query } });
    const h = mount(() => useRuntimeStatus());
    await h.flush();
    expect(h.value.read.state).toBe('failed');
    expect(h.value.unavailable).toEqual({});
  });

  it('shows a check made in one reader, such as the settings page, in every mounted reader', async () => {
    let enabled = false;
    const query = vi.fn(async () => ({
      ok: true as const,
      value: [status({ runtime: 'codex', enabled })],
    }));
    vi.stubGlobal('window', { pantheon: { query } });
    const composer = mount(() => useRuntimeStatus('writer'));
    const settings = mount(() => useRuntimeStatus());
    await composer.flush();
    await settings.flush();
    expect(composer.value.unavailable).toEqual({ codex: rs('disabled') });

    enabled = true;
    settings.value.refresh();
    await settings.flush();
    await composer.flush();
    expect(settings.value.unavailable).toEqual({});
    expect(composer.value.unavailable).toEqual({});
  });

  it('keeps a recheck in flight when another reader mounts on the cached answer', async () => {
    const recheck = deferred<{ ok: true; value: RuntimeStatus[] }>();
    const query = vi.fn(async (_name: string, params: Record<string, string>) =>
      params.refresh
        ? recheck.promise
        : { ok: true as const, value: [status({ runtime: 'codex', enabled: false })] },
    );
    vi.stubGlobal('window', { pantheon: { query } });
    const settings = mount(() => useRuntimeStatus());
    await settings.flush();
    settings.value.refresh();
    const composer = mount(() => useRuntimeStatus());
    await composer.flush();
    recheck.resolve({ ok: true, value: [status({ runtime: 'codex' })] });
    await settings.flush();
    await composer.flush();
    expect(settings.value.unavailable).toEqual({});
    expect(composer.value.unavailable).toEqual({});
  });

  it('lists the runtimes of the newest answer while a later picker loads, not of an older answer that came last', async () => {
    const older = deferred<{ ok: true; value: RuntimeStatus[] }>();
    const answers = [
      older.promise,
      Promise.resolve({
        ok: true as const,
        value: [status({ runtime: 'claude' }), status({ runtime: 'codex' })],
      }),
    ];
    vi.stubGlobal('window', { pantheon: { query: vi.fn(() => answers.shift()) } });
    const first = mount(() => useRuntimeStatus());
    const second = mount(() => useRuntimeStatus());
    await second.flush();
    older.resolve({ ok: true, value: [status({ runtime: 'claude' })] });
    await first.flush();
    expect(offeredRuntimes({ state: 'loading' }, [])).toEqual(['claude', 'codex']);
  });
});

describe('connections status read', () => {
  it('shows a sign-in checked in one reader in every mounted reader', async () => {
    let state = 'signed_out';
    const query = vi.fn(async () => ({
      ok: true as const,
      value: { github: { state, installed: true } },
    }));
    vi.stubGlobal('window', { pantheon: { query } });
    const composer = mount(() => useConnectionsStatus());
    const settings = mount(() => useConnectionsStatus());
    await composer.flush();
    await settings.flush();
    const github = (h: typeof composer) =>
      h.value.read.state === 'ready' ? h.value.read.github.state : h.value.read.state;
    expect(github(composer)).toBe('signed_out');

    state = 'signed_in';
    settings.value.refresh();
    await settings.flush();
    await composer.flush();
    expect(github(settings)).toBe('signed_in');
    expect(github(composer)).toBe('signed_in');
    expect(settings.value.checking).toBe(false);
  });

  it('keeps a sign-in recheck in flight when another reader mounts on the cached answer', async () => {
    const recheck = deferred<{ ok: true; value: { github: { state: string; installed: true } } }>();
    const query = vi.fn(async (_name: string, params: Record<string, string>) =>
      params.refresh
        ? recheck.promise
        : { ok: true as const, value: { github: { state: 'signed_out', installed: true } } },
    );
    vi.stubGlobal('window', { pantheon: { query } });
    const settings = mount(() => useConnectionsStatus());
    await settings.flush();
    settings.value.refresh();
    await settings.flush();
    const composer = mount(() => useConnectionsStatus());
    await composer.flush();
    await settings.flush();
    expect(settings.value.checking).toBe(true);

    recheck.resolve({ ok: true, value: { github: { state: 'signed_in', installed: true } } });
    await settings.flush();
    await composer.flush();
    const github = (h: typeof composer) =>
      h.value.read.state === 'ready' ? h.value.read.github.state : h.value.read.state;
    expect(github(settings)).toBe('signed_in');
    expect(github(composer)).toBe('signed_in');
    expect(settings.value.checking).toBe(false);
  });
});
