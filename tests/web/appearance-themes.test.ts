import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { ThemeList } from '@pantheon/protocol';
import { mount, named, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/store', () => ({
  useShell: (selector: any) => selector({ theme: 'system', setTheme() {} }),
  resolveTheme: (theme: string, dark: boolean) =>
    theme === 'system' ? (dark ? 'dark' : 'light') : theme,
}));
vi.mock('@/screens/settings/view', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSettingsView: (select: any) =>
    select({ runtime: 'codex', setRuntime() {}, page: 'appearance', setPage() {} }),
}));
import { toastManager } from '@/components/Toast';
import { useBoard } from '@/data/board';
import { failureText } from '@/data/needs-you';
import { setUserThemes } from '@/data/theme';
import { ProjectSettingsScreen } from '@/screens/settings/ProjectSettingsScreen';

const swatches = { surface0: 'rgb(1,1,1)', surface1: 'rgb(2,2,2)', accent: 'rgb(3,3,3)' };
const list: ThemeList = {
  active_theme_id: 'paper',
  themes: [
    {
      id: 'builtin-dusk',
      label: 'Dusk',
      modes: ['light', 'dark'],
      has_backdrop: false,
      built_in: true,
      created_at: 0,
      swatches,
    },
    {
      id: 'tide',
      label: '潮汐',
      modes: ['dark'],
      has_backdrop: true,
      built_in: false,
      created_at: 2,
      swatches,
    },
    {
      id: 'paper',
      label: '纸',
      modes: ['light'],
      has_backdrop: false,
      built_in: false,
      session_id: 'lead',
      created_at: 1,
      swatches,
    },
  ],
};

const command = vi.fn(async (_c: { type: string; input: unknown }) => ({ ok: true, value: {} }));
const child = (node: any) => mount(() => node.type(node.props));
const sent = () => command.mock.calls.map(([c]) => [c.type, c.input]);

beforeEach(() => {
  command.mockClear();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} });
  vi.stubGlobal('document', { styleSheets: [] });
  vi.stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false }),
    pantheon: {
      zoomFactor: async () => ({ ok: true, value: 1 }),
      query: async (method: string) =>
        method === 'theme.list'
          ? { ok: true, value: list }
          : { ok: true, value: { id: 'paper', label: '纸', css: '', modes: ['light'] } },
      command,
    },
  });
  useBoard.setState({
    board: {
      cursor: 1,
      projects: [],
      sessions: [{ id: 'lead', project_id: 'alpha', title: 'Rollout flag' }],
      session_turns: [],
    },
  } as never);
  setUserThemes({
    list,
    active: { id: 'paper', label: '纸', css: '', modes: ['light'] },
  });
});
afterEach(() => {
  unmountAll();
  setUserThemes({ list: null, active: null });
  useBoard.setState({ board: null });
  vi.unstubAllGlobals();
});

async function page() {
  const screen = mount(() => ProjectSettingsScreen());
  const app = child(named(screen.value, 'AppPage'));
  const h = child(named(app.value, 'AppearancePage'));
  await h.flush();
  return h;
}

describe('the theme cards', () => {
  it('lists the default theme, the built-in ones by name, then each saved theme with the session that made it', async () => {
    const cards = child(named((await page()).value, 'ThemeCards'));
    const shown = nodes(cards.value)
      .filter((n) => typeof n.type === 'function' && n.type.name === 'ThemeCard')
      .map((n) => [n.props.label, n.props.from, n.props.selected]);
    expect(shown).toEqual([
      [zh('settings.appearance.defaultTheme'), undefined, false],
      ['暮色', undefined, false],
      ['潮汐', undefined, false],
      ['纸', 'Rollout flag', true],
    ]);
  });

  it('applies the theme of the card pressed, and the default from its card', async () => {
    const cards = child(named((await page()).value, 'ThemeCards'));
    const card = (label: string) =>
      child(nodes(cards.value).find((n) => n.props.label === label)).value;
    expect(card('纸').props['aria-pressed']).toBe(true);
    card('潮汐').props.onClick();
    card('暮色').props.onClick();
    card(zh('settings.appearance.defaultTheme')).props.onClick();
    await cards.flush();
    expect(sent()).toEqual([
      ['theme.apply', { theme_id: 'tide' }],
      ['theme.apply', { theme_id: 'builtin-dusk' }],
      ['theme.apply', { theme_id: null }],
    ]);
  });

  it('offers no export or delete while a built-in theme is applied', async () => {
    setUserThemes({
      list: { ...list, active_theme_id: 'builtin-dusk' },
      active: { id: 'builtin-dusk', label: 'Dusk', css: '', modes: ['light', 'dark'] },
    });
    const h = await page();
    expect(
      nodes(h.value).some((n) => typeof n.type === 'function' && n.type.name === 'SavedThemeRow'),
    ).toBe(false);
  });
});

describe('the applied saved theme', () => {
  it('asks before deleting it, naming it', async () => {
    const row = child(named((await page()).value, 'SavedThemeRow'));
    const button = (name: string) =>
      nodes(row.value).find((n) => n.type === 'button' && text(n.props.children) === name)!;
    const dialog = () =>
      nodes(row.value).find((n) => n.props.open !== undefined && 'onOpenChange' in n.props)!;
    expect(dialog().props.open).toBe(false);
    button(zh('settings.appearance.deleteTheme')).props.onClick();
    row.render();
    expect(dialog().props.open).toBe(true);
    expect(text(dialog())).toContain(
      zh('settings.appearance.deleteThemeTitle').replace('{label}', '纸'),
    );
    expect(sent()).toEqual([]);
    nodes(row.value)
      .filter(
        (n) =>
          n.type === 'button' &&
          text(n.props.children) === zh('settings.appearance.deleteThemeConfirm'),
      )
      .at(-1)!
      .props.onClick();
    await row.flush();
    expect(sent()).toEqual([['theme.delete', { theme_id: 'paper' }]]);
  });
});

describe('a theme action that fails', () => {
  const error = { code: 'theme_not_found', message: 'No theme paper' };
  let add: MockInstance<typeof toastManager.add>;
  beforeEach(() => void (add = vi.spyOn(toastManager, 'add')));
  afterEach(() => {
    add.mockRestore();
    toastManager.close();
  });
  const shown = () => add.mock.calls.map(([notice]) => [notice.title, notice.type]);
  const savedRow = async () => {
    const row = child(named((await page()).value, 'SavedThemeRow'));
    // The row's Delete comes before the dialog's, which reads the same.
    const buttons = (name: string) =>
      nodes(row.value).filter((n) => n.type === 'button' && text(n.props.children) === name);
    return { row, buttons };
  };

  it('says why applying the card pressed failed', async () => {
    command.mockImplementationOnce(async () => ({ ok: false, error }) as never);
    const cards = child(named((await page()).value, 'ThemeCards'));
    child(nodes(cards.value).find((n) => n.props.label === '潮汐')).value.props.onClick();
    await cards.flush();
    expect(shown()).toEqual([[failureText(error), 'failure']]);
  });

  it('says why exporting the applied theme failed', async () => {
    const { row, buttons } = await savedRow();
    (window as unknown as { pantheon: { query: unknown } }).pantheon.query = async () => ({
      ok: false,
      error,
    });
    buttons(zh('settings.appearance.exportTheme'))[0]!.props.onClick();
    await row.flush();
    expect(shown()).toEqual([[failureText(error), 'failure']]);
  });

  it('says why deleting the applied theme failed', async () => {
    command.mockImplementationOnce(async () => ({ ok: false, error }) as never);
    const { row, buttons } = await savedRow();
    buttons(zh('settings.appearance.deleteTheme'))[0]!.props.onClick();
    row.render();
    buttons(zh('settings.appearance.deleteThemeConfirm')).at(-1)!.props.onClick();
    await row.flush();
    expect(sent()).toEqual([['theme.delete', { theme_id: 'paper' }]]);
    expect(shown()).toEqual([[failureText(error), 'failure']]);
  });
});
