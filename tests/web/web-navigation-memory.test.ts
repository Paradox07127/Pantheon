import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BoardSnapshot } from '@pantheon/protocol';
import { useBoard } from '@/data/board';
import { useCurrentProject } from '@/data/current-project';
import { SHORTCUTS } from '@/lib/shortcuts';
import { useSettingsView } from '@/screens/settings/view';
import { useShell } from '@/store';
import { zh } from './i18n-setup.js';

const PLACES_KEY = 'pantheon.projectPlaces';

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

const shell = () => useShell.getState();
const project = () => useCurrentProject.getState().projectId;
const here = () => ({ project: project(), screen: shell().screen, session: shell().sessionId });

let storage: ReturnType<typeof memoryStorage>;
beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal('localStorage', storage);
  useCurrentProject.setState({ projectId: null });
  useShell.setState({
    screen: 'projects',
    sessionId: null,
    sessionRestored: false,
    sessionTask: null,
    history: [
      {
        projectId: null,
        screen: 'projects',
        sessionId: null,
        sessionTask: null,
      },
    ],
    historyIndex: 0,
  });
});
afterEach(() => vi.unstubAllGlobals());

it('restores the screen and session each project was left on', () => {
  shell().openProject('alpha');
  shell().openSession('alpha-1');
  shell().setScreen('board');
  shell().openProject('beta');
  shell().openSession('beta-1');

  shell().openProject('alpha');
  expect(here()).toEqual({ project: 'alpha', screen: 'board', session: 'alpha-1' });
  shell().openProject('beta');
  expect(here()).toEqual({ project: 'beta', screen: 'sessions', session: 'beta-1' });
  expect(JSON.parse(storage.items.get(PLACES_KEY)!)).toEqual({
    alpha: { screen: 'board', sessionId: 'alpha-1', sessionTask: null },
    beta: { screen: 'sessions', sessionId: 'beta-1', sessionTask: null },
  });
});

it('lands a project opened for the first time on its board', () => {
  shell().openProject('alpha');
  shell().setScreen('trace');
  shell().openProject('beta');
  expect(here()).toEqual({ project: 'beta', screen: 'board', session: null });
});

it('lands a project stored on the removed inbox screen on its board', () => {
  storage.setItem(
    PLACES_KEY,
    JSON.stringify({ alpha: { screen: 'activity', sessionId: 'alpha-1', sessionTask: null } }),
  );
  shell().openProject('alpha');
  expect(here()).toEqual({ project: 'alpha', screen: 'board', session: 'alpha-1' });
});

it('restores a project left with its settings open on the screen under them', () => {
  shell().openProject('alpha');
  shell().openSettings('alpha');
  shell().openProject('beta');
  shell().openProject('alpha');
  expect(shell().screen).toBe('board');
});

it("keeps the current project's place while the app settings show", () => {
  shell().openProject('alpha');
  shell().openSession('alpha-1');
  shell().openSettings(null);
  shell().openProject('beta');
  shell().openProject('alpha');
  expect(here()).toEqual({ project: 'alpha', screen: 'sessions', session: 'alpha-1' });
});

it('opens the settings on the chosen page without a step in history', () => {
  shell().openProject('alpha');
  const length = shell().history.length;
  useSettingsView.setState({ page: 'workflow' });
  shell().openSettings('alpha');
  expect(useSettingsView.getState()).toMatchObject({ open: true, page: 'workflow' });
  shell().openSettings(null);
  expect(useSettingsView.getState().page).toBe('workflow');
  expect(shell().history).toHaveLength(length);
});

it('follows the first session when the remembered one is gone, and keeps one still listed', () => {
  shell().openProject('alpha');
  shell().openSession('alpha-gone');
  shell().openProject('beta');
  shell().openProject('alpha');
  expect(shell().sessionId).toBe('alpha-gone');
  shell().checkRestoredSession(['alpha-1']);
  expect(shell().sessionId).toBeNull();

  shell().openSession('alpha-1');
  shell().openProject('beta');
  shell().openProject('alpha');
  shell().checkRestoredSession(['alpha-1']);
  expect(shell().sessionId).toBe('alpha-1');
});

it('leaves a just opened session alone while the list does not name it yet', () => {
  shell().openProject('alpha');
  shell().openSession('alpha-new');
  shell().checkRestoredSession([]);
  expect(shell().sessionId).toBe('alpha-new');
});

it('walks back and forward through places, across projects, and drops forward after a new step', () => {
  shell().openProject('alpha');
  shell().openSession('alpha-1');
  shell().setScreen('board');
  shell().openProject('beta');

  shell().back();
  expect(here()).toEqual({ project: 'alpha', screen: 'board', session: 'alpha-1' });
  shell().back();
  expect(here()).toEqual({ project: 'alpha', screen: 'sessions', session: 'alpha-1' });
  shell().forward();
  expect(here()).toEqual({ project: 'alpha', screen: 'board', session: 'alpha-1' });

  shell().openSession('alpha-2');
  const length = shell().history.length;
  shell().forward();
  expect(here()).toEqual({ project: 'alpha', screen: 'sessions', session: 'alpha-2' });
  expect(shell().history).toHaveLength(length);
  shell().back();
  expect(here()).toEqual({ project: 'alpha', screen: 'board', session: 'alpha-1' });
});

it('switches the screen at once, without a view transition', () => {
  shell().openProject('alpha');
  const startViewTransition = vi.fn(() => ({ finished: new Promise<void>(() => {}) }));
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  vi.stubGlobal('document', { startViewTransition });
  shell().openSession('alpha-1');
  expect(here()).toEqual({ project: 'alpha', screen: 'sessions', session: 'alpha-1' });
  shell().setScreen('board');
  shell().back();
  expect(here()).toEqual({ project: 'alpha', screen: 'sessions', session: 'alpha-1' });
  expect(startViewTransition).not.toHaveBeenCalled();
});

it('carries the gate run a session is opened for, and drops it on the next place', () => {
  shell().openProject('alpha');
  shell().openSession('alpha-1', 'checks', 'run-2');
  expect(shell().sessionTab).toBe('checks');
  expect(shell().sessionRun).toBe('run-2');
  shell().setScreen('board');
  expect(shell().sessionRun).toBeNull();
  shell().openSession('alpha-1', 'checks', 'run-2');
  shell().back();
  expect(shell().sessionRun).toBeNull();
  shell().forward();
  shell().openSession('alpha-1');
  expect(shell().sessionRun).toBeNull();
});

it('pushes nothing when restoring from history and keeps at most fifty places', () => {
  shell().openProject('alpha');
  shell().openSession('alpha-1');
  const length = shell().history.length;
  shell().back();
  shell().forward();
  expect(shell().history).toHaveLength(length);

  for (let i = 0; i < 60; i++) shell().openSession(`alpha-${i}`);
  expect(shell().history).toHaveLength(50);
  expect(shell().history.at(-1)!.sessionId).toBe('alpha-59');
});

it('switches projects as today when storage fails', () => {
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new Error('storage off');
    },
    setItem: () => {
      throw new Error('storage off');
    },
  });
  expect(() => {
    shell().openProject('alpha');
    shell().setScreen('board');
    shell().openProject('beta');
    shell().openProject('alpha');
  }).not.toThrow();
  expect(here()).toEqual({ project: 'alpha', screen: 'board', session: null });
});

it("leaves another project's session memory alone while its settings show", () => {
  shell().openProject('alpha');
  shell().openSession('alpha-1');
  shell().openProject('beta');
  shell().openSession('beta-1');
  shell().openProject('alpha');
  shell().openSettings('beta');
  shell().setScreen('board');

  shell().back();
  expect(here()).toEqual({ project: 'alpha', screen: 'sessions', session: 'alpha-1' });
  expect(JSON.parse(storage.items.get(PLACES_KEY)!).beta).toEqual({
    screen: 'sessions',
    sessionId: 'beta-1',
    sessionTask: null,
  });
  shell().openProject('beta');
  expect(here()).toEqual({ project: 'beta', screen: 'sessions', session: 'beta-1' });
});

it('records the only project as the place when none was chosen', () => {
  useBoard.setState({
    board: { projects: [{ id: 'solo', name: 'Solo' }] } as unknown as BoardSnapshot,
  });
  try {
    shell().setScreen('board');
    shell().openSession('solo-1');
    expect(shell().history.at(-1)!.projectId).toBe('solo');
    expect(JSON.parse(storage.items.get(PLACES_KEY)!).solo).toMatchObject({
      screen: 'sessions',
      sessionId: 'solo-1',
    });
    shell().openProject('other');
    shell().back();
    expect(here()).toEqual({ project: 'solo', screen: 'sessions', session: 'solo-1' });
  } finally {
    useBoard.setState({ board: null });
  }
});

it('keeps the board task of the new-session composer when coming back to it', () => {
  const task = { id: 'task-1', title: 'Fix login', goal: 'Login works' };
  shell().openProject('alpha');
  shell().openTaskSession(task);
  shell().setScreen('board');
  shell().back();
  expect(here()).toEqual({ project: 'alpha', screen: 'sessions', session: '' });
  expect(shell().sessionTask).toEqual(task);

  shell().openProject('beta');
  shell().openProject('alpha');
  expect(shell().sessionTask).toEqual(task);
});

it('drops the board task from the composer place once its session is created', () => {
  const task = { id: 'task-1', title: 'Fix login', goal: 'Login works' };
  shell().openProject('alpha');
  shell().openTaskSession(task);
  shell().clearSessionTask();
  shell().openSession('alpha-new');
  shell().back();
  expect(here()).toEqual({ project: 'alpha', screen: 'sessions', session: '' });
  expect(shell().sessionTask).toBeNull();
});

it('binds back and forward to ⌘[ and ⌘] app-wide', () => {
  const label = (id: string) => zh(`lib.shortcuts.label.${id}`);
  expect(SHORTCUTS.filter((s) => s.id === 'back' || s.id === 'forward')).toEqual([
    { id: 'back', keys: 'Meta+[', label: label('back'), scope: 'app' },
    { id: 'forward', keys: 'Meta+]', label: label('forward'), scope: 'app' },
  ]);
});
