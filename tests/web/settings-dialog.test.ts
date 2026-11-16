import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { find, mount, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import type { BoardSnapshot } from '@pantheon/protocol';
import { useBoard } from '@/data/board';
import { useCurrentProject } from '@/data/current-project';
import { MenuActions } from '@/lib/menu-actions';
import { SettingsDialog } from '@/screens/settings/SettingsDialog';
import { useSettingsView } from '@/screens/settings/view';
import { useShell } from '@/store';

const PLACES_KEY = 'pantheon.projectPlaces';

type Listener = (e: KeyboardEvent) => void;
let listeners: Listener[] = [];
let items: Map<string, string>;

const shell = () => useShell.getState();
const pressSettingsKeys = () => {
  const e = {
    key: ',',
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target: null,
    preventDefault: () => {},
  } as unknown as KeyboardEvent;
  for (const listener of [...listeners]) listener(e);
};

beforeEach(() => {
  items = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  });
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: Listener) => type === 'keydown' && listeners.push(fn),
    removeEventListener: (type: string, fn: Listener) => {
      if (type === 'keydown') listeners = listeners.filter((l) => l !== fn);
    },
    matchMedia: () => ({ matches: false }),
  });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
  listeners = [];
  useBoard.setState({
    board: { projects: [{ id: 'alpha', name: 'Alpha app' }] } as unknown as BoardSnapshot,
  });
  useCurrentProject.setState({ projectId: 'alpha' });
  useShell.setState({
    screen: 'board',
    sessionId: null,
    sessionTask: null,
    history: [{ projectId: 'alpha', screen: 'board', sessionId: null, sessionTask: null }],
    historyIndex: 0,
  });
  useSettingsView.setState({ open: false, page: 'general' });
});
afterEach(() => {
  unmountAll();
  useBoard.setState({ board: null });
  vi.unstubAllGlobals();
});

it('opens the settings over the current screen without a step in history', () => {
  shell().openSettings('alpha');
  expect(shell().screen).toBe('board');
  expect(shell().history).toHaveLength(1);
  expect(useSettingsView.getState()).toMatchObject({ open: true, page: 'general', detail: null });
  shell().openSettings(null);
  expect(useSettingsView.getState()).toMatchObject({ open: true, page: 'general', detail: null });
  expect(shell().history).toHaveLength(1);
  useSettingsView.getState().close();
  expect(useSettingsView.getState().open).toBe(false);
  expect(shell().screen).toBe('board');
});

it('opens the settings on the settings keys and closes them on the next press', () => {
  mount(() => MenuActions());
  pressSettingsKeys();
  expect(useSettingsView.getState()).toMatchObject({ open: true, detail: null });
  pressSettingsKeys();
  expect(useSettingsView.getState().open).toBe(false);
  expect(shell().screen).toBe('board');
});

it('reads a project left on the old settings screen back as its sessions', () => {
  items.set(
    PLACES_KEY,
    JSON.stringify({ alpha: { screen: 'settings', sessionId: 'alpha-1', sessionTask: null } }),
  );
  shell().openProject('alpha');
  expect(shell()).toMatchObject({ screen: 'sessions', sessionId: 'alpha-1' });
});

it('moves focus to the settings search on a slash typed outside a text field', () => {
  useSettingsView.setState({ open: true });
  const frame = find(mount(() => SettingsDialog()).value, (n) => n.props.className === 'ps-frame');
  const focus = vi.fn();
  const press = (editable: boolean) => {
    const prevent = vi.fn();
    frame.props.onKeyDown({
      key: '/',
      target: { closest: () => (editable ? {} : null) },
      currentTarget: {
        querySelector: (selector: string) =>
          selector === 'input[type="search"]' ? { focus } : null,
      },
      preventDefault: prevent,
    });
    return prevent;
  };
  expect(press(true)).not.toHaveBeenCalled();
  expect(focus).not.toHaveBeenCalled();
  expect(press(false)).toHaveBeenCalled();
  expect(focus).toHaveBeenCalledOnce();
});
