import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector({ board: null }), {
    getState: () => ({ board: null, refresh() {} }),
    subscribe: () => () => {},
  }),
}));
vi.mock('@/store', () => {
  const shell = {
    theme: 'system',
    setTheme(theme: string) {
      shell.theme = theme;
    },
  };
  return { useShell: Object.assign((selector: any) => selector(shell), { getState: () => shell }) };
});
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { DEFAULT_DIFF_PREFS, DIFF_PREFS_KEY, getDiffPrefs, setDiffPrefs } from '@/data/diff-prefs';
import {
  APPEARANCE_KEY,
  DEFAULT_APPEARANCE,
  DEFAULT_LAYOUT,
  DEFAULT_LOOK,
  getAccent,
  getLayout,
  LOOK_KEY,
  setAccent,
  setAppearance,
  setLayout,
  setLook,
} from '@/data/layout';
import {
  DEFAULT_NOTIFICATIONS,
  getNotificationPrefs,
  NOTIFICATIONS_KEY,
  setNotificationPrefs,
} from '@/data/notifications';
import {
  exportPersonalSettings,
  importPersonalSettings,
  personalSettings,
} from '@/data/personal-settings';
import { setBackdropOn, setUserThemes, useBackdropOn } from '@/data/theme';
import { resetShortcuts, setShortcut, SHORTCUTS_KEY, shortcutKeys } from '@/lib/shortcuts';
import { ProjectSettingsScreen } from '@/screens/settings/ProjectSettingsScreen';
import { hitGroups } from '@/screens/settings/settings-jump';
import { searchSettings } from '@/screens/settings/settings-search';
import { useSettingsView } from '@/screens/settings/view';
import { useShell } from '@/store';
import { zh } from './i18n-setup.js';

let stored: Map<string, string>;
const child = (node: any) => mount(() => node.type(node.props) as ReactNode);
const pages = (tree: ReactNode) =>
  nodes(tree)
    .filter((n) => n.props.className === 'ps-page')
    .map((n) => text(n.props.children));

function resetStores() {
  setAppearance(DEFAULT_APPEARANCE);
  setLook(DEFAULT_LOOK);
  setNotificationPrefs(DEFAULT_NOTIFICATIONS);
  setDiffPrefs(DEFAULT_DIFF_PREFS);
  resetShortcuts();
  setAccent('default');
  useShell.getState().setTheme('system');
  setBackdropOn(true);
  setLayout(DEFAULT_LAYOUT);
  setUserThemes({ list: null, active: null });
}

beforeEach(() => {
  stored = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('document', {
    getElementById: () => null,
    createElement: () => ({}),
    head: { append() {} },
  });
  useSettingsView.setState({ page: 'data', query: '' });
});
afterEach(() => {
  unmountAll();
  resetStores();
  vi.unstubAllGlobals();
});

describe('settings search', () => {
  it('finds the page of a control by the control name', () => {
    expect(hitGroups('色盲友好配色').map((g) => g.page)).toEqual(['appearance']);
    expect(hitGroups('Dock').map((g) => g.page)).toEqual(['notifications']);
    expect(hitGroups('折叠侧栏').map((g) => g.page)).toEqual(['appearance']);
    expect(hitGroups('落回门禁').map((g) => g.page)).toEqual(['gates']);
    expect(hitGroups('外观').map((g) => g.page)).toEqual(['appearance']);
    expect(hitGroups('按钮颜色').map((g) => g.page)).toEqual(['appearance']);
  });

  it('finds the rows that had no search entry', () => {
    const found = (query: string) => searchSettings(query).map((hit) => hit.id);
    expect(found(zh('settings.appearance.backdrop'))).toContain('appearance.backdrop');
    expect(found(zh('settings.appearance.savedTheme'))).toContain('appearance.savedTheme');
    expect(found(zh('settings.data.exportRow'))).toContain('data.export');
    expect(found(zh('settings.data.importRow'))).toContain('data.import');
    expect(found(zh('settings.gate.runner'))).toContain('gates.runner');
  });

  it('dims the pages without a match, shows an empty state without one and clears on Escape', () => {
    const screen = mount(() => ProjectSettingsScreen());
    const nav = child(named(screen.value, 'SettingsNav'));
    const field = () => find(nav.value, (n) => n.type === 'input' && n.props.type === 'search');
    const dimmed = () => pages(nodes(nav.value).filter((n) => n.props['data-dim'] !== undefined));
    const all = pages(nav.value);
    const appearance = zh('settings.pages.appearance');
    expect(all).toContain(appearance);
    expect(dimmed()).toEqual([]);

    field().props.onChange({ target: { value: '色盲友好配色' } });
    nav.render();
    expect(dimmed()).toEqual(all.filter((page) => page !== appearance));

    field().props.onChange({ target: { value: '没有这一项' } });
    nav.render();
    expect(dimmed()).toEqual(all);
    const results = child(named(screen.render(), 'SearchResults'));
    expect(text(results.value)).toContain(zh('settings.nav.noMatch'));

    field().props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
    nav.render();
    expect(field().props.value).toBe('');
    expect(pages(nav.value)).toEqual(all);
  });
});

describe('personal settings export and import', () => {
  const change = () => {
    setAppearance({ density: 'compact', reading_width: 960 });
    setLook({ colorblind: true, send_key: 'meta-enter' });
    setNotificationPrefs({ sound: false, badge: false });
    expect(setShortcut('palette', 'Meta+P')).toBeNull();
    setDiffPrefs({ wrap: false, collapse: true });
  };

  it('restores the same state from its own export', () => {
    change();
    const before = personalSettings();
    const file = exportPersonalSettings();
    expect(JSON.parse(file).version).toBe(1);
    resetStores();
    expect(personalSettings()).not.toEqual(before);

    expect(importPersonalSettings(file)).toBe(true);
    expect(personalSettings()).toEqual(before);
    expect(shortcutKeys('palette')).toBe('Meta+P');
    expect(JSON.parse(stored.get(APPEARANCE_KEY)!)).toEqual(before.appearance);
    expect(JSON.parse(stored.get(LOOK_KEY)!)).toEqual(before.look);
    expect(JSON.parse(stored.get(NOTIFICATIONS_KEY)!)).toEqual(before.notifications);
    expect(JSON.parse(stored.get(SHORTCUTS_KEY)!)).toEqual({ palette: 'Meta+P' });
    expect(JSON.parse(stored.get(DIFF_PREFS_KEY)!)).toEqual(before.diff);
  });

  it('carries the accent, light or dark, saved theme, backdrop, pane widths and language', async () => {
    const bridge = {
      command: vi.fn(async () => ({ ok: true, value: {} })),
      query: vi.fn(async () => ({ ok: false, error: { code: 'unknown_route', message: '' } })),
      setLocale: vi.fn(async () => ({ ok: true, value: undefined })),
    };
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {}, pantheon: bridge });
    setAccent('lapis');
    useShell.getState().setTheme('dark');
    setBackdropOn(false);
    setLayout({
      sidebar: { collapsed: false, width: 300 },
      inspector: 500,
      drawer: 600,
      collapse_sidebar_at_start: true,
    });
    setUserThemes({ list: { active_theme_id: 'dusk', themes: [] }, active: null });
    const layout = getLayout();
    const file = JSON.parse(exportPersonalSettings());
    expect(file).toMatchObject({
      accent: 'lapis',
      theme: 'dark',
      user_theme: 'dusk',
      backdrop: false,
      layout: { inspector: 500, drawer: 600, collapse_sidebar_at_start: true },
      locale: 'system',
    });
    resetStores();

    expect(importPersonalSettings(JSON.stringify(file))).toBe(true);
    await new Promise((done) => setTimeout(done));
    expect(getAccent()).toBe('lapis');
    expect(useShell.getState().theme).toBe('dark');
    expect(mount(() => useBackdropOn()).value).toBe(false);
    expect(getLayout()).toEqual(layout);
    expect(bridge.command.mock.calls.map((c) => (c as unknown as [any])[0])).toEqual([
      expect.objectContaining({ type: 'theme.apply', input: { theme_id: 'dusk' } }),
    ]);
    expect(bridge.setLocale).not.toHaveBeenCalled();

    expect(importPersonalSettings(JSON.stringify({ ...file, locale: 'en' }))).toBe(true);
    await new Promise((done) => setTimeout(done));
    expect(bridge.setLocale).toHaveBeenCalledWith('en');
  });

  it('reads a file without the newer fields and rejects one with an unknown accent', () => {
    change();
    const file = JSON.parse(exportPersonalSettings());
    for (const key of ['accent', 'theme', 'user_theme', 'backdrop', 'layout', 'locale'])
      delete file[key];
    expect(importPersonalSettings(JSON.stringify(file))).toBe(true);
    expect(importPersonalSettings(JSON.stringify({ ...file, accent: 'teal' }))).toBe(false);
  });

  it('drops unknown fields', () => {
    change();
    const before = personalSettings();
    const file = JSON.parse(exportPersonalSettings());
    file.extra = true;
    file.appearance.extra = 'x';
    file.shortcuts['no-such-entry'] = 'Meta+J';
    resetStores();
    expect(importPersonalSettings(JSON.stringify(file))).toBe(true);
    expect(personalSettings()).toEqual(before);
  });

  it('writes nothing when one store in the file is invalid', () => {
    change();
    const file = JSON.parse(exportPersonalSettings());
    file.notifications.sound = 'loud';
    resetStores();
    stored.clear();
    const before = personalSettings();
    expect(importPersonalSettings(JSON.stringify(file))).toBe(false);
    expect(personalSettings()).toEqual(before);
    expect(getNotificationPrefs()).toEqual(DEFAULT_NOTIFICATIONS);
    expect(getDiffPrefs()).toEqual(DEFAULT_DIFF_PREFS);
    expect([...stored.keys()]).toEqual([]);
    expect(importPersonalSettings('{"version":2}')).toBe(false);
    expect(importPersonalSettings('not json')).toBe(false);
  });

  it('shows an error on the data page and keeps the settings when the file is invalid', async () => {
    const screen = mount(() => ProjectSettingsScreen());
    const app = child(named(screen.value, 'AppPage'));
    const data = child(app.value as ReactElement<any>);
    const section = child(named(data.value, 'PersonalSettings'));
    const input = find(section.value, (n) => n.type === 'input' && n.props.type === 'file');
    input.props.onChange({
      target: { files: [{ text: async () => '{"version":1,"look":"teal"}' }], value: 'x.json' },
    });
    await section.flush();
    expect(text(find(section.value, (n) => n.props.role === 'alert'))).toContain(
      zh('settings.data.importInvalid'),
    );
    expect(personalSettings().look).toEqual(DEFAULT_LOOK);
  });
});
