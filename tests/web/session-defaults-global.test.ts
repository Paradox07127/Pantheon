import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { find, mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  board: {} as any,
  defaults: null as unknown,
  defaultsFail: false,
}));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/data/logs', async (actual) => ({
  ...(await actual<object>()),
  useEventHistory: () => ({ events: [], error: null, reload() {} }),
}));
import { forgetQuery } from '@/data/query-cache';
import { useCurrentProject } from '@/data/current-project';
import { useShell } from '@/store';

const globalDefaults = { runtime: 'claude', permission_mode: 'auto_edit' } as const;
const ownDefaults = { runtime: 'codex', permission_mode: 'plan' } as const;

const read = (global?: object) => ({
  settings: [{ key: 'session_defaults', overrides: [], ...(global && { global }) }],
  projects: [],
  permission_rules: [],
});

function stubWindow() {
  vi.stubGlobal('window', {
    innerWidth: 1600,
    innerHeight: 900,
    pantheon: {
      command: vi.fn(async () => ({ ok: true, value: null })),
      query: vi.fn(async (method: string) =>
        method !== 'project.defaults'
          ? { ok: true, value: [] }
          : mock.defaultsFail
            ? { ok: false, error: { code: 'ipc_failed', message: 'channel closed' } }
            : { ok: true, value: mock.defaults },
      ),
    },
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false }),
  });
  vi.stubGlobal('document', { activeElement: null });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
}

const { SessionsScreen } = await import('@/screens/sessions/SessionsScreen');
const { NewSession } = await import('@/screens/sessions/NewSession');

const needs = { items: [], loading: false, error: null, reload() {} } as any;
const list = { data: [], loading: false, error: null, reload() {} };

async function composerScreen(project: object) {
  mock.board = {
    board: {
      cursor: 1,
      projects: [{ id: 'project-a', revision: 1, name: 'A', roots: ['/a'], ...project }],
      workspaces: [],
      sessions: [],
      session_turns: [],
    },
    events: [],
    resync: 0,
    status: { state: 'live' },
    refresh() {},
  };
  const h = mount(() => SessionsScreen({ projectId: 'project-a', needs, list }));
  await h.flush();
  h.render();
  return h;
}

const defaultsOf = (h: Awaited<ReturnType<typeof composerScreen>>) =>
  find(h.value, (n) => n.type === NewSession).props.defaults;

const composerDefaults = async (project: object) => defaultsOf(await composerScreen(project));

beforeEach(() => {
  stubWindow();
  forgetQuery('project.defaults', 'all');
  mock.defaultsFail = false;
  useCurrentProject.setState({ projectId: 'project-a' });
  useShell.setState({ screen: 'sessions', sessionId: null, splitId: null, followed: null });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('the new-session composer on the sessions screen', () => {
  it('starts from the global session defaults when the project sets none', async () => {
    mock.defaults = read(globalDefaults);
    expect(await composerDefaults({})).toEqual(globalDefaults);
  });

  it("starts from the project's own session defaults over the global ones", async () => {
    mock.defaults = read(globalDefaults);
    expect(await composerDefaults({ session_defaults: ownDefaults })).toEqual(ownDefaults);
  });

  it('starts from no defaults when neither the project nor the global values set any', async () => {
    mock.defaults = read();
    expect(await composerDefaults({})).toBeUndefined();
  });

  it('keeps the global session defaults when a later read of them fails', async () => {
    mock.defaults = read(globalDefaults);
    const h = await composerScreen({});
    expect(defaultsOf(h)).toEqual(globalDefaults);

    mock.defaultsFail = true;
    mock.board = { ...mock.board, changed: 2 };
    h.render();
    await h.flush();
    h.render();
    const asked = vi
      .mocked(window.pantheon!.query)
      .mock.calls.filter(([method]) => method === 'project.defaults');
    expect(asked).toHaveLength(2);
    expect(defaultsOf(h)).toEqual(globalDefaults);
  });
});
