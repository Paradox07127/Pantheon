import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/screens/settings/view', async (actual) => ({
  ...(await actual<object>()),
  useSettingsView: (select: (state: unknown) => unknown) =>
    select({ page: 'extensions', runtime: 'codex', setRuntime() {} }),
}));
import type { BoardSnapshot } from '@pantheon/protocol';
import { RUNTIMES } from '@/data/extensions';
import { ExtensionsPage } from '@/screens/settings/ExtensionsPage';
import { mount } from './web-hook-host.js';

type Project = BoardSnapshot['projects'][number];

describe('the extension inventory of a project', () => {
  const query = vi.fn(async () => ({
    ok: false,
    error: { code: 'unsupported_capability', message: 'no inventory', status: 409 },
  }));
  beforeEach(() => {
    query.mockClear();
    vi.stubGlobal('window', { pantheon: { query } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is read again once the project folders change', async () => {
    let project: Project = { id: 'alpha', revision: 1, name: 'Alpha', roots: ['/work/old'] };
    const h = mount(() => ExtensionsPage({ project }));
    await h.flush();
    expect(query).toHaveBeenCalledTimes(RUNTIMES.length);

    project = { ...project, revision: 2 };
    h.render();
    await h.flush();
    expect(query).toHaveBeenCalledTimes(RUNTIMES.length);

    project = { ...project, revision: 3, roots: ['/work/new'] };
    h.render();
    await h.flush();
    expect(query).toHaveBeenCalledTimes(2 * RUNTIMES.length);
    h.unmount();
  });
});
