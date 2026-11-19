import { describe, expect, it, vi } from 'vitest';
import type { BoardSnapshot } from '@pantheon/protocol';
import {
  currentProject,
  readCurrentProjectId,
  useCurrentProject,
  writeCurrentProjectId,
} from '@/data/current-project';
import { SCREEN_NAMES } from '@/screens';
import { readTheme, resolveTheme, startScreen, useShell } from '@/store';

const project = (id: string, name: string) =>
  ({ id, revision: 1, name, roots: [`/work/${id}`] }) as never;

const board = (projects: BoardSnapshot['projects']): BoardSnapshot =>
  ({ cursor: 0, projects }) as unknown as BoardSnapshot;

const twoProjects = board([project('alpha', 'Alpha app'), project('beta', 'Beta service')]);

describe('shell', () => {
  it('starts on the board of the remembered project, else on the project picker', () => {
    expect(startScreen('alpha')).toBe('board');
    expect(startScreen(null)).toBe('projects');
  });

  it('has the sessions, board, insights, repo, runtime, flow, trace, memory, automations, projects, personal and settings screens only', () => {
    expect(Object.keys(SCREEN_NAMES)).toEqual([
      'sessions',
      'board',
      'insights',
      'repo',
      'runtime',
      'flow',
      'trace',
      'memory',
      'automations',
      'projects',
      'personal',
      'settings',
    ]);
  });

  it('opens one session on the sessions screen, and the list again without one', () => {
    useShell.getState().openSession('session-a');
    expect(useShell.getState()).toMatchObject({ screen: 'sessions', sessionId: 'session-a' });
    useShell.getState().setScreen('board');
    useShell.getState().openSessions();
    expect(useShell.getState()).toMatchObject({ screen: 'sessions', sessionId: null });
  });

  it('drops the runs tab session once another project opens', () => {
    useShell.getState().openProject('alpha');
    useShell.getState().showRuns('alpha-1');
    expect(useShell.getState()).toMatchObject({ traceTab: 'runs', runsSession: 'alpha-1' });
    useShell.getState().openProject('beta');
    expect(useShell.getState().runsSession).toBeNull();
    useShell.getState().showRuns('beta-1');
    useShell.getState().setScreen('board');
    expect(useShell.getState().runsSession).toBe('beta-1');
  });

  it('drops the runs tab session and the second pane when another project is chosen outside the shell', () => {
    useShell.getState().openProject('alpha');
    useShell.getState().showRuns('alpha-1');
    useShell.setState({ splitId: 'alpha-2', splitPane: 'right' });
    useCurrentProject.getState().choose('beta');
    useShell.getState().setScreen('trace');
    expect(useShell.getState()).toMatchObject({
      runsSession: null,
      splitId: null,
      splitPane: 'left',
    });
  });
});

describe('currentProject', () => {
  it.each([
    ['uses the stored project while the snapshot has it', twoProjects, 'alpha'],
    [
      'falls back to the only project once the stored one is gone',
      board([project('alpha', 'Alpha app')]),
      'removed',
    ],
    [
      'falls back once the stored project is removed',
      board([twoProjects.projects[0]!, { ...twoProjects.projects[1]!, removed_at: 9 }]),
      'beta',
    ],
  ])('%s', (_name, snapshot, stored) => {
    expect(currentProject(snapshot, stored)?.id).toBe('alpha');
  });

  it('has none in a window of one project once that project is gone', () => {
    vi.stubGlobal('window', {
      pantheon: { windowContext: () => ({ kind: 'project', project_id: 'removed' }) },
    });
    try {
      expect(currentProject(board([project('alpha', 'Alpha app')]), 'removed')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('has none with several projects and nothing stored', () => {
    expect(currentProject(twoProjects, null)).toBeNull();
    expect(currentProject(twoProjects, 'removed')).toBeNull();
    expect(currentProject(null, 'alpha')).toBeNull();
  });
});

describe('stored current project', () => {
  const failing = {
    getItem: () => {
      throw new Error('storage disabled');
    },
    setItem: () => {
      throw new Error('storage disabled');
    },
  };

  it('reads and writes the remembered id', () => {
    const kept = new Map<string, string>();
    const storage = {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.set(key, value),
    };
    expect(readCurrentProjectId(storage)).toBeNull();
    writeCurrentProjectId('beta', storage);
    expect(readCurrentProjectId(storage)).toBe('beta');
  });

  it('reads nothing and still switches when storage throws', () => {
    expect(readCurrentProjectId(failing)).toBeNull();
    expect(() => writeCurrentProjectId('beta', failing)).not.toThrow();
    vi.stubGlobal('localStorage', failing);
    try {
      useCurrentProject.getState().choose('beta');
      expect(useCurrentProject.getState().projectId).toBe('beta');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('theme', () => {
  const stored = (value: string | null) => ({ getItem: () => value });

  it('reads light, dark and system as stored, and anything else as system', () => {
    expect(readTheme(stored('light'))).toBe('light');
    expect(readTheme(stored('dark'))).toBe('dark');
    expect(readTheme(stored('system'))).toBe('system');
    expect(readTheme(stored('blue'))).toBe('system');
    expect(readTheme(stored(null))).toBe('system');
  });

  it('follows the system only when the theme is system', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});
