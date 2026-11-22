import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { DesktopBridge } from '@pantheon/protocol';
import { deferred, find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
const toasts = vi.hoisted(() => [] as { title: string; kind?: string }[]);
vi.mock('@/components/Toast', async (actual) => ({
  ...(await actual<object>()),
  toast: (options: { title: string; kind?: string }) => {
    toasts.push(options);
    return '';
  },
}));
import { failureText } from '@/data/needs-you';
import { useVoice } from '@/data/voice';
import { GeneralPage } from '@/screens/settings/GeneralPage';
import { Select } from '@/components/Select';
import { Row, Section } from '@/screens/settings/ProjectSettingsScreen';
import { searchSettings } from '@/screens/settings/settings-search';

const BUILT_IN = zh('settings.general.voiceEngineBuiltIn');
const CHOOSE = zh('settings.general.voiceEngineChoose');
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

type ShellPrefs = Required<Parameters<DesktopBridge['setShellPrefs']>[0]>;
const ENGINE = '/Users/me/engines/whisper-engine-with-a-long-name';
const PREFS: ShellPrefs = {
  keep_running_on_close: true,
  show_tray_icon: false,
  tray_icon: 'pantheon',
  app_icon: 'pantheon-travertine',
  voice_input: true,
  voice_engine: null,
  mini_window: false,
};
const SHELL_IDS = [
  'general.keepRunning',
  'general.trayIcon',
  'general.appIcon',
  'general.voiceInput',
  'general.voiceEngine',
];

/** A desktop bridge that keeps the shell settings as the main process would. */
function desk(initial: Partial<ShellPrefs> = {}) {
  let saved: ShellPrefs = { ...PREFS, ...initial };
  const bridge = {
    shellPrefs: vi.fn(async () => ({ ok: true as const, value: saved })),
    setShellPrefs: vi.fn(async (patch: Partial<ShellPrefs>) => {
      saved = { ...saved, ...patch };
      return { ok: true as const, value: saved };
    }),
    chooseVoiceEngine: vi.fn(async (): Promise<any> => ({ ok: true as const, value: null })),
    voiceAvailable: vi.fn(async () => saved.voice_input),
    choose(path: string | null) {
      bridge.chooseVoiceEngine.mockImplementationOnce(async () => {
        if (path !== null) saved = { ...saved, voice_engine: path };
        return { ok: true as const, value: path };
      });
    },
  };
  return bridge;
}

async function shellRows(bridge: ReturnType<typeof desk>) {
  vi.stubGlobal('window', { pantheon: bridge });
  const page = mount(() => GeneralPage());
  const rows = named(page.value, 'ShellRows');
  const h = mount(() => (rows.type as (props: unknown) => ReactNode)(rows.props));
  await h.flush();
  return h;
}
const row = (tree: unknown, id: string) =>
  find(tree as never, (n) => n.type === Row && n.props.settingId === id);
const rowLabels = (tree: unknown) =>
  nodes(tree as never)
    .filter((n) => n.type === Row)
    .map((n) => n.props.label);
const toggle = (tree: unknown, id: string) =>
  find(row(tree, id), (n) => n.type === 'input') as ReactElement<any>;
const buttons = (tree: unknown) =>
  nodes(row(tree, 'general.voiceEngine')).filter((n) => n.type === 'button');
/** The radio buttons of the group named label in the row settingId. */
const radios = (tree: unknown, settingId: string, label: string) =>
  nodes(
    find(
      row(tree, settingId),
      (n) => n.props.role === 'radiogroup' && n.props['aria-label'] === label,
    ),
  ).filter((n) => n.props.role === 'radio');
const choices = (tree: unknown, settingId: string, label: string) =>
  radios(tree, settingId, label).map((b) => [b.props['aria-label'], b.props['aria-checked']]);
const pick = (tree: unknown, settingId: string, label: string, name: string) =>
  radios(tree, settingId, label)
    .find((b) => b.props['aria-label'] === name)!
    .props.onClick();
const SHAPES = 'App 图标形状';
const COLOURS = 'App 图标颜色';
const MENU_BAR = '菜单栏图标';
const engineName = (tree: unknown) =>
  find(row(tree, 'general.voiceEngine'), (n) => n.type === 'span');

describe('general settings of the desktop shell', () => {
  it('shows the five shell settings with their saved values', async () => {
    const bridge = desk();
    const h = await shellRows(bridge);
    expect(bridge.shellPrefs).toHaveBeenCalledTimes(1);
    expect(rowLabels(h.value)).toEqual([
      zh('settings.general.keepRunning'),
      zh('settings.general.trayIcon'),
      zh('settings.general.appIcon'),
      zh('settings.general.voiceInput'),
      zh('settings.general.voiceEngine'),
    ]);
    expect(
      nodes(h.value as never)
        .filter((n) => n.type === Row)
        .map((n) => n.props.settingId),
    ).toEqual(SHELL_IDS);
    expect(toggle(h.value, 'general.keepRunning').props.checked).toBe(true);
    expect(toggle(h.value, 'general.keepRunning').props['aria-label']).toBe(
      zh('settings.general.keepRunning'),
    );
    expect(toggle(h.value, 'general.trayIcon').props.checked).toBe(false);
    expect(toggle(h.value, 'general.voiceInput').props.checked).toBe(true);
    expect(text(engineName(h.value))).toBe(BUILT_IN);
    expect(buttons(h.value).map((b) => text(b))).toEqual([CHOOSE]);
  });

  it('offers three shapes and only the colours the temple comes in', async () => {
    const h = await shellRows(desk({ app_icon: 'pantheon-black' }));
    expect(choices(h.value, 'general.appIcon', SHAPES)).toEqual([
      ['万神殿', true],
      ['太一', false],
      ['西格玛', false],
    ]);
    expect(choices(h.value, 'general.appIcon', COLOURS)).toEqual([
      ['石灰华', false],
      ['黑色', true],
      ['白色', false],
    ]);
  });

  it('keeps the colour when the shape picked comes in it, and offers that shape six colours', async () => {
    const bridge = desk({ app_icon: 'pantheon-black' });
    const h = await shellRows(bridge);
    pick(h.value, 'general.appIcon', SHAPES, '太一');
    await h.flush();
    expect(bridge.setShellPrefs).toHaveBeenLastCalledWith({ app_icon: 'monad-black' });
    expect(choices(h.value, 'general.appIcon', SHAPES).map(([, checked]) => checked)).toEqual([
      false,
      true,
      false,
    ]);
    expect(choices(h.value, 'general.appIcon', COLOURS)).toEqual([
      ['石灰华', false],
      ['黑色', true],
      ['白色', false],
      ['暮色', false],
      ['陶土', false],
      ['青金', false],
    ]);
  });

  it('saves the travertine temple when the temple does not come in the colour', async () => {
    const bridge = desk({ app_icon: 'monad-dusk' });
    const h = await shellRows(bridge);
    pick(h.value, 'general.appIcon', SHAPES, '万神殿');
    await h.flush();
    expect(bridge.setShellPrefs).toHaveBeenLastCalledWith({ app_icon: 'pantheon-travertine' });
  });

  it('saves the colour picked for the shape shown', async () => {
    const bridge = desk({ app_icon: 'sigma-travertine' });
    const h = await shellRows(bridge);
    pick(h.value, 'general.appIcon', COLOURS, '青金');
    await h.flush();
    expect(bridge.setShellPrefs).toHaveBeenLastCalledWith({ app_icon: 'sigma-lapis' });
    expect(choices(h.value, 'general.appIcon', COLOURS).at(-1)).toEqual(['青金', true]);
  });

  it('shows each shape in the chosen colour, or in travertine when it does not come in it', async () => {
    const h = await shellRows(desk({ app_icon: 'monad-dusk' }));
    const images = radios(h.value, 'general.appIcon', SHAPES).map(
      (b) => String(find(b, (n) => n.type === 'img').props.src).match(/[\w-]+(?=\.png)/)?.[0],
    );
    expect(images).toEqual(['pantheon-travertine', 'monad-dusk', 'sigma-dusk']);
  });

  it('offers the menu bar icon only while the icon is shown', async () => {
    const bridge = desk();
    const h = await shellRows(bridge);
    expect(
      nodes(row(h.value, 'general.trayIcon')).filter((n) => n.props.role === 'radiogroup'),
    ).toEqual([]);
    toggle(h.value, 'general.trayIcon').props.onChange({ target: { checked: true } });
    await h.flush();
    expect(choices(h.value, 'general.trayIcon', MENU_BAR)).toHaveLength(3);
    // The shape choice follows the switch it depends on.
    expect(
      nodes(row(h.value, 'general.trayIcon'))
        .filter((n) => n.type === 'input' || n.props.role === 'radiogroup')
        .map((n) => n.type),
    ).toEqual(['input', 'span']);
  });

  it('saves the menu bar icon picked and checks the one the shell returns', async () => {
    const bridge = desk({ show_tray_icon: true });
    const h = await shellRows(bridge);
    expect(choices(h.value, 'general.trayIcon', MENU_BAR)).toEqual([
      ['万神殿', true],
      ['太一', false],
      ['西格玛', false],
    ]);
    pick(h.value, 'general.trayIcon', MENU_BAR, '西格玛');
    await h.flush();
    expect(bridge.setShellPrefs).toHaveBeenLastCalledWith({ tray_icon: 'sigma' });
    expect(choices(h.value, 'general.trayIcon', MENU_BAR).map(([, checked]) => checked)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('names a chosen engine by its file, with the whole path on hover', async () => {
    const h = await shellRows(desk({ voice_engine: ENGINE }));
    const name = engineName(h.value);
    expect(text(name)).toBe('whisper-engine-with-a-long-name');
    expect(name.props.title).toBe(ENGINE);
    expect(name.props.className).toContain('mono');
    expect(buttons(h.value).map((b) => text(b))).toEqual([
      CHOOSE,
      zh('settings.general.voiceEngineReset'),
    ]);
  });

  it('saves only the switch that changed and shows the value the shell returns', async () => {
    const bridge = desk();
    const h = await shellRows(bridge);
    toggle(h.value, 'general.trayIcon').props.onChange({ target: { checked: true } });
    await h.flush();
    expect(bridge.setShellPrefs).toHaveBeenLastCalledWith({ show_tray_icon: true });
    expect(toggle(h.value, 'general.trayIcon').props.checked).toBe(true);
    toggle(h.value, 'general.keepRunning').props.onChange({ target: { checked: false } });
    await h.flush();
    expect(bridge.setShellPrefs).toHaveBeenLastCalledWith({ keep_running_on_close: false });
    toggle(h.value, 'general.voiceInput').props.onChange({ target: { checked: false } });
    await h.flush();
    expect(bridge.setShellPrefs).toHaveBeenLastCalledWith({ voice_input: false });
    expect(toggle(h.value, 'general.voiceInput').props.checked).toBe(false);
    expect(bridge.setShellPrefs).toHaveBeenCalledTimes(3);
  });

  it('keeps the newer switch when an earlier save answers after it', async () => {
    const bridge = desk();
    const h = await shellRows(bridge);
    const first = deferred<{ ok: true; value: ShellPrefs }>();
    bridge.setShellPrefs.mockImplementationOnce(async () => first.promise);
    toggle(h.value, 'general.keepRunning').props.onChange({ target: { checked: false } });
    toggle(h.value, 'general.trayIcon').props.onChange({ target: { checked: true } });
    await h.flush();
    expect(toggle(h.value, 'general.trayIcon').props.checked).toBe(true);
    first.resolve({ ok: true, value: { ...PREFS, keep_running_on_close: false } });
    await h.flush();
    expect(toggle(h.value, 'general.trayIcon').props.checked).toBe(true);
  });

  it('lets only the shell pick an engine path, and clears it back to the built-in one', async () => {
    const bridge = desk();
    const h = await shellRows(bridge);
    bridge.choose(null);
    buttons(h.value)[0]!.props.onClick();
    await h.flush();
    expect(bridge.chooseVoiceEngine).toHaveBeenCalledTimes(1);
    expect(text(engineName(h.value))).toBe(BUILT_IN);

    bridge.choose(ENGINE);
    buttons(h.value)[0]!.props.onClick();
    await h.flush();
    expect(text(engineName(h.value))).toBe('whisper-engine-with-a-long-name');

    buttons(h.value)[1]!.props.onClick();
    await h.flush();
    expect(bridge.setShellPrefs).toHaveBeenCalledWith({ voice_engine: null });
    expect(text(engineName(h.value))).toBe(BUILT_IN);
    for (const [patch] of bridge.setShellPrefs.mock.calls)
      expect(typeof patch.voice_engine).not.toBe('string');
  });

  it('turns the engine buttons off while voice input is off', async () => {
    const h = await shellRows(desk({ voice_input: false, voice_engine: ENGINE }));
    expect(buttons(h.value).map((b) => b.props.disabled)).toEqual([true, true]);
  });

  it('leaves the shell settings out without the desktop app', () => {
    vi.stubGlobal('window', {});
    const page = mount(() => GeneralPage());
    expect(() => named(page.value, 'ShellRows')).toThrow();
    expect(rowLabels(page.value)).toEqual([
      zh('settings.appearance.language'),
      zh('settings.keepAwake.toggle'),
    ]);
  });

  it('holds its rows in one group with no caption', () => {
    vi.stubGlobal('window', {});
    const page = mount(() => GeneralPage());
    const group = find(page.value, (n) => n.type === Section) as ReactElement<any>;
    expect(group.props.title).toBeUndefined();
  });

  it('shows a failure under the row it came from', async () => {
    const bridge = desk();
    const h = await shellRows(bridge);
    bridge.setShellPrefs.mockResolvedValueOnce({
      ok: false,
      error: { code: 'write_failed', message: 'disk full' },
    } as never);
    toggle(h.value, 'general.trayIcon').props.onChange({ target: { checked: true } });
    await h.flush();
    const all = nodes(h.value as never);
    const alert = all.find((n) => n.props.role === 'alert')!;
    expect(alert.props.className).toContain('ps-err');
    expect(text(alert)).toContain('disk full');
    const at = all.indexOf(alert);
    expect(all.indexOf(row(h.value, 'general.trayIcon'))).toBeLessThan(at);
    expect(all.indexOf(row(h.value, 'general.voiceInput'))).toBeGreaterThan(at);
    expect(toggle(h.value, 'general.trayIcon').props.checked).toBe(false);

    bridge.chooseVoiceEngine.mockRejectedValueOnce(new Error('ipc closed'));
    buttons(h.value)[0]!.props.onClick();
    await h.flush();
    const after = nodes(h.value as never);
    const alerts = after.filter((n) => n.props.role === 'alert');
    expect(alerts).toHaveLength(1);
    expect(text(alerts[0])).toContain('ipc closed');
    expect(after.indexOf(row(h.value, 'general.voiceEngine'))).toBeLessThan(
      after.indexOf(alerts[0]!),
    );
  });

  it('finds each shell setting in the settings search', () => {
    const found = (query: string) => searchSettings(query).map((hit) => hit.id);
    expect(found('关闭窗口')).toContain('general.keepRunning');
    expect(found('菜单栏')).toContain('general.trayIcon');
    expect(found('托盘')).toContain('general.trayIcon');
    expect(found('语音输入')).toContain('general.voiceInput');
    expect(found('语音识别引擎')).toContain('general.voiceEngine');
    expect(found('tray icon')).toContain('general.trayIcon');
    expect(found('任务栏')).toContain('general.appIcon');
    expect(found('托盘')).toContain('general.trayIcon');
    expect(found('menu bar')).toContain('general.trayIcon');
  });

  it('finds the archive after merge switch in the settings search', () => {
    const found = searchSettings('自动归档').map((hit) => hit.id);
    expect(found).toContain('general.autoArchiveMerged');
  });

  it('makes an open composer check voice input again after the setting changes', async () => {
    const bridge = desk({ voice_input: false });
    const h = await shellRows(bridge);
    const voice = mount(() => useVoice(() => {}));
    await voice.flush();
    expect(voice.value.available).toBe(false);
    toggle(h.value, 'general.voiceInput').props.onChange({ target: { checked: true } });
    await h.flush();
    await voice.flush();
    expect(bridge.voiceAvailable).toHaveBeenCalledTimes(2);
    expect(voice.value.available).toBe(true);
    bridge.choose(ENGINE);
    buttons(h.value)[0]!.props.onClick();
    await h.flush();
    await voice.flush();
    expect(bridge.voiceAvailable).toHaveBeenCalledTimes(3);
  });
});

describe('baseline group', () => {
  it('is gone from the settings search', () => {
    const found = (query: string) => searchSettings(query).map((hit) => hit.id);
    expect(found('Follow-up rounds')).not.toContain('general.baselineRounds');
    expect(found('绘制解释图')).not.toContain('general.baselineVisuals');
  });
});

describe('language choice', () => {
  it('shows why the desktop app did not save the language', async () => {
    toasts.length = 0;
    const error = { code: 'invalid_input', message: '"xx" is not a language' };
    const setLocale = vi.fn(async () => ({ ok: false, error }));
    vi.stubGlobal('window', { pantheon: { ...desk(), setLocale } });
    const page = mount(() => GeneralPage());
    const language = find(
      page.value,
      (n) => n.type === Select && n.props['aria-label'] === zh('settings.appearance.language'),
    );
    language.props.onChange('en');
    await page.flush();
    expect(setLocale).toHaveBeenCalledWith('en');
    expect(toasts).toEqual([{ title: failureText(error), kind: 'failure' }]);
  });
});

describe('open at login switch', () => {
  const LABEL = zh('settings.general.openAtLogin');
  async function loginRow(answer: boolean | null) {
    let on = answer;
    const bridge = {
      openAtLogin: vi.fn(async () => ({ ok: true as const, value: on })),
      setOpenAtLogin: vi.fn(async (next: boolean) => {
        on = next;
        return { ok: true as const, value: next };
      }),
    };
    vi.stubGlobal('window', { pantheon: bridge });
    const page = mount(() => GeneralPage());
    const shown = named(page.value, 'OpenAtLoginRow');
    const h = mount(() => (shown.type as (props: unknown) => ReactNode)(shown.props));
    await h.flush();
    return { bridge, h };
  }
  const toggle = (tree: unknown) =>
    find(tree as never, (n) => n.type === 'input' && n.props['aria-label'] === LABEL);

  it('shows the login item the system has, and sets it from the switch', async () => {
    const { bridge, h } = await loginRow(false);
    expect(rowLabels(h.value)).toEqual([LABEL]);
    expect(toggle(h.value).props.checked).toBe(false);
    toggle(h.value).props.onChange({ target: { checked: true } });
    await h.flush();
    expect(bridge.setOpenAtLogin).toHaveBeenCalledWith(true);
    expect(toggle(h.value).props.checked).toBe(true);
  });

  it('shows no row where the system keeps no login items', async () => {
    const { h } = await loginRow(null);
    expect(rowLabels(h.value)).toEqual([]);
  });

  it('is found in the settings search', () => {
    const found = (query: string) => searchSettings(query).map((hit) => hit.id);
    expect(found('登录时打开')).toContain('general.openAtLogin');
    expect(found('开机启动')).toContain('general.openAtLogin');
    expect(found('startup')).toContain('general.openAtLogin');
  });
});

describe('archive after merge switch', () => {
  const LABEL = zh('settings.general.autoArchiveMerged');
  function app(answer: unknown = { ok: true, value: {} }) {
    const bridge = {
      ...desk(),
      query: vi.fn(async (method: string) =>
        method === 'app.settings'
          ? { ok: true as const, value: { auto_git_init: true, auto_archive_merged: true } }
          : { ok: false as const, error: { code: 'unknown_route', message: method } },
      ),
      command: vi.fn(async () => answer),
    };
    vi.stubGlobal('window', { pantheon: bridge });
    return bridge;
  }
  async function archiveRow() {
    const page = mount(() => GeneralPage());
    const shown = named(page.value, 'AutoArchiveRow');
    const h = mount(() => (shown.type as (props: unknown) => ReactNode)(shown.props));
    await h.flush();
    return h;
  }
  const toggle = (tree: unknown) =>
    find(tree as never, (n) => n.type === 'input' && n.props['aria-label'] === LABEL);
  const alerts = (tree: unknown) => nodes(tree as never).filter((n) => n.props.role === 'alert');

  it('shows the stored value and writes only that field', async () => {
    const bridge = app();
    const h = await archiveRow();
    expect(rowLabels(h.value)).toEqual([LABEL]);
    expect(toggle(h.value).props.checked).toBe(true);
    toggle(h.value).props.onChange({ target: { checked: false } });
    await h.flush();
    expect(bridge.command).toHaveBeenCalledTimes(1);
    expect((bridge.command.mock.calls[0] as unknown as [any])[0]).toMatchObject({
      type: 'app.settings.set',
      input: { auto_archive_merged: false },
      expected_revision: null,
    });
    expect(Object.keys((bridge.command.mock.calls[0] as unknown as [any])[0].input)).toEqual([
      'auto_archive_merged',
    ]);
    expect(toggle(h.value).props.checked).toBe(false);
    expect(alerts(h.value)).toEqual([]);
  });

  it('keeps the stored value and shows the failure under the row', async () => {
    app({ ok: false, error: { code: 'not_implemented', message: 'not there' } });
    const h = await archiveRow();
    toggle(h.value).props.onChange({ target: { checked: false } });
    await h.flush();
    expect(toggle(h.value).props.checked).toBe(true);
    expect(alerts(h.value).map((n) => text(n))).toEqual([
      failureText({ code: 'not_implemented', message: 'not there' }),
    ]);
  });
});

describe('session recap switch', () => {
  const LABEL = zh('settings.general.sessionRecap');
  function app(recap: boolean | undefined) {
    const bridge = {
      ...desk(),
      query: vi.fn(async (method: string) =>
        method === 'app.settings'
          ? {
              ok: true as const,
              value: { auto_git_init: true, auto_archive_merged: false, session_recap: recap },
            }
          : { ok: false as const, error: { code: 'unknown_route', message: method } },
      ),
      command: vi.fn(async () => ({ ok: true, value: {} })),
    };
    vi.stubGlobal('window', { pantheon: bridge });
    return bridge;
  }
  async function recapRow() {
    const page = mount(() => GeneralPage());
    const shown = named(page.value, 'SessionRecapRow');
    const h = mount(() => (shown.type as (props: unknown) => ReactNode)(shown.props));
    await h.flush();
    return h;
  }
  const recap = (tree: unknown) =>
    find(tree as never, (n) => n.type === 'input' && n.props['aria-label'] === LABEL);

  it('shows the stored value and writes only session_recap', async () => {
    const bridge = app(true);
    const h = await recapRow();
    expect(rowLabels(h.value)).toEqual([LABEL]);
    expect(row(h.value, 'general.sessionRecap')).toBeDefined();
    expect(recap(h.value).props.checked).toBe(true);
    recap(h.value).props.onChange({ target: { checked: false } });
    await h.flush();
    expect(bridge.command.mock.calls.map((c) => (c as unknown as [any])[0].input)).toEqual([
      { session_recap: false },
    ]);
    expect(recap(h.value).props.checked).toBe(false);
  });

  it('reads an absent value as on', async () => {
    app(undefined);
    const h = await recapRow();
    expect(recap(h.value).props.checked).toBe(true);
  });

  it('is found in the settings search', () => {
    const found = (query: string) => searchSettings(query).map((hit) => hit.id);
    expect(found('会话进度摘要')).toContain('general.sessionRecap');
    expect(found('recap')).toContain('general.sessionRecap');
  });
});
