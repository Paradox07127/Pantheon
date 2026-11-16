import { afterEach, describe, expect, it, vi } from 'vitest';

const PLACES_KEY = 'pantheon.projectPlaces';
const CURRENT_PROJECT_KEY = 'pantheon.currentProject';

interface Start {
  project?: string | null;
  places?: Record<string, unknown>;
  // The answer of the session list read; null fails the read.
  sessions?: { id: string; archived_at?: string | null }[] | null;
  kind?: 'main' | 'project' | 'session';
  theme?: string;
}

/** Imports the shell store afresh, as a window opening with this storage and daemon does. */
async function open({
  project = 'alpha',
  places = {},
  sessions = [],
  kind = 'main',
  theme,
}: Start) {
  vi.resetModules();
  const items = new Map<string, string>([[PLACES_KEY, JSON.stringify(places)]]);
  if (project) items.set(CURRENT_PROJECT_KEY, project);
  if (theme) items.set('pantheon.theme', theme);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  });
  const query = vi.fn(async () =>
    sessions
      ? { ok: true, value: sessions }
      : { ok: false, error: { code: 'daemon_unreachable', message: 'down' } },
  );
  const target = new EventTarget();
  vi.stubGlobal(
    'window',
    Object.assign(target, {
      pantheon: {
        windowContext: () => ({ kind, project_id: kind === 'main' ? undefined : project }),
        query,
      },
    }),
  );
  const { useShell } = await import('@/store');
  const { cachedQuery } = await import('@/data/query-cache');
  const s = useShell.getState();
  return {
    query,
    target,
    useShell,
    cachedQuery,
    here: { screen: s.screen, session: s.sessionId },
    first: s.history[0],
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('the main window opening', () => {
  const left = { alpha: { screen: 'sessions', sessionId: 'alpha-1', sessionTask: null } };

  it('opens on the session it was left on once the list still has it', async () => {
    const { here, first, query, cachedQuery } = await open({
      places: left,
      sessions: [{ id: 'alpha-1', archived_at: null }],
    });
    expect(here).toEqual({ screen: 'sessions', session: 'alpha-1' });
    expect(first).toEqual({
      projectId: 'alpha',
      screen: 'sessions',
      sessionId: 'alpha-1',
      sessionTask: null,
    });
    expect(query).toHaveBeenCalledWith('session.list', { project_id: 'alpha' });
    // The sessions page draws the list already read instead of reading it again first.
    expect(cachedQuery('session.list', 'alpha')?.data).toEqual([
      { id: 'alpha-1', archived_at: null },
    ]);
  });

  it.each<[string, Start['sessions']]>([
    [
      "lands on the project's board when the session it was left on was deleted",
      [{ id: 'alpha-2' }],
    ],
    [
      "lands on the project's board when the session it was left on was archived",
      [{ id: 'alpha-1', archived_at: '2026-11-01T00:00:00Z' }],
    ],
    ["lands on the project's board when the list cannot be read", null],
  ])('%s', async (_, sessions) => {
    const { here } = await open({ places: left, sessions });
    expect(here).toEqual({ screen: 'board', session: null });
  });

  it('opens on the other page it was left on without reading the list', async () => {
    const { here, query, useShell } = await open({
      places: { alpha: { screen: 'trace', sessionId: 'alpha-1', sessionTask: null } },
    });
    expect(here).toEqual({ screen: 'trace', session: 'alpha-1' });
    expect(useShell.getState().sessionRestored).toBe(true);
    expect(query).not.toHaveBeenCalled();
  });

  it('opens on the board of a project with no place, and on the projects without a project', async () => {
    expect((await open({})).here).toEqual({ screen: 'board', session: null });
    expect((await open({ project: null, places: left })).here).toEqual({
      screen: 'projects',
      session: null,
    });
  });

  it("leaves a project window's start on its board", async () => {
    const { here, query } = await open({ kind: 'project', places: left });
    expect(here).toEqual({ screen: 'board', session: null });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('the theme', () => {
  it('follows a theme another window stored, without a reload', async () => {
    const { target, useShell } = await open({ theme: 'light' });
    expect(useShell.getState().theme).toBe('light');
    const stored = (key: string, newValue: string | null) =>
      target.dispatchEvent(Object.assign(new Event('storage'), { key, newValue }));
    stored('pantheon.theme', 'dark');
    expect(useShell.getState().theme).toBe('dark');
    stored('pantheon.layout', 'light');
    expect(useShell.getState().theme).toBe('dark');
    stored('pantheon.theme', null);
    expect(useShell.getState().theme).toBe('system');
  });
});
