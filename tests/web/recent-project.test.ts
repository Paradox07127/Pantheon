import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useBoard } from '@/data/board';
import { useCurrentProject } from '@/data/current-project';
import { useRecentProject } from '@/shell/recent-project';

const projects = [
  { id: 'alpha', name: 'Alpha', roots: ['/work/alpha', '/work/alpha-docs'] },
  { id: 'beta', name: 'Beta', roots: ['/work/beta'] },
];

function desk() {
  const bridge = { addRecentProject: vi.fn(async () => ({ ok: true as const, value: null })) };
  vi.stubGlobal('window', { pantheon: bridge });
  return bridge;
}

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  useBoard.setState({ board: null });
  useCurrentProject.setState({ projectId: null });
});

describe('recent projects', () => {
  it('reports the first root of each project the main window opens', () => {
    const bridge = desk();
    useBoard.setState({ board: { cursor: 1, projects, sessions: [] } } as never);
    useCurrentProject.setState({ projectId: 'alpha' });
    const h = mount(() => useRecentProject('main'));
    expect(bridge.addRecentProject.mock.calls).toEqual([['/work/alpha']]);
    h.render();
    expect(bridge.addRecentProject).toHaveBeenCalledTimes(1);
    useCurrentProject.setState({ projectId: 'beta' });
    h.render();
    expect(bridge.addRecentProject.mock.calls).toEqual([['/work/alpha'], ['/work/beta']]);
  });

  it('reports a project once the board lists it', () => {
    const bridge = desk();
    useCurrentProject.setState({ projectId: 'beta' });
    const h = mount(() => useRecentProject('main'));
    expect(bridge.addRecentProject).not.toHaveBeenCalled();
    useBoard.setState({ board: { cursor: 1, projects, sessions: [] } } as never);
    h.render();
    expect(bridge.addRecentProject.mock.calls).toEqual([['/work/beta']]);
  });

  it('leaves a project window out', () => {
    const bridge = desk();
    useBoard.setState({ board: { cursor: 1, projects, sessions: [] } } as never);
    useCurrentProject.setState({ projectId: 'alpha' });
    mount(() => useRecentProject('project'));
    expect(bridge.addRecentProject).not.toHaveBeenCalled();
  });
});
