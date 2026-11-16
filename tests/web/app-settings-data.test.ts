import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useBoard } from '@/data/board';
import { useAppSettings } from '@/data/app-settings';

let stored = { auto_git_init: true, auto_archive_merged: false, session_recap: true };
const query = vi.fn(async (method: string) =>
  method === 'app.settings'
    ? { ok: true as const, value: { ...stored } }
    : { ok: false as const, error: { code: 'unknown_route', message: method } },
);
let answer: unknown = { ok: true, value: {} };
const command = vi.fn(async () => answer);
const reads = () => query.mock.calls.filter(([method]) => method === 'app.settings');

const settingsSet = (sequence: number) => ({
  event_id: `event-${sequence}`,
  sequence,
  kind: 'app.settings_set',
  project_id: '',
  aggregate_id: 'app.settings',
  payload: { auto_archive_merged: true },
});

beforeEach(() => {
  stored = { auto_git_init: true, auto_archive_merged: false, session_recap: true };
  answer = { ok: true, value: {} };
  query.mockClear();
  command.mockClear();
  vi.stubGlobal('window', { pantheon: { query, command } });
  useBoard.setState({ events: [], resync: 0 });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('app settings reads', () => {
  it('reads the settings again after another window changes them', async () => {
    const h = mount(() => useAppSettings());
    await h.flush();
    expect(h.value.settings?.auto_archive_merged).toBe(false);

    stored = { ...stored, auto_archive_merged: true };
    useBoard.setState({ events: [settingsSet(7)] as never });
    h.render();
    await h.flush();
    expect(reads()).toHaveLength(2);
    expect(h.value.settings?.auto_archive_merged).toBe(true);
  });

  it('reads the settings again after a resync', async () => {
    const h = mount(() => useAppSettings());
    await h.flush();
    useBoard.setState({ resync: 1 });
    h.render();
    await h.flush();
    expect(reads()).toHaveLength(2);
  });

  it('reads the settings again after a save fails, and keeps the failure shown', async () => {
    answer = { ok: false, error: { code: 'not_implemented', message: 'not there' } };
    const h = mount(() => useAppSettings());
    await h.flush();
    await h.value.save({ auto_archive_merged: true });
    h.render();
    await h.flush();
    expect(reads()).toHaveLength(2);
    expect(h.value.error).not.toBeNull();
  });
});
