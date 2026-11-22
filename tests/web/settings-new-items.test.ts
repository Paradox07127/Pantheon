import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeResult } from '@pantheon/protocol';
import { find, mount as host, text, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useBoard } from '@/data/board';
import { DEFAULT_DIFF_PREFS, DIFF_PREFS_KEY, getDiffPrefs, setDiffPrefs } from '@/data/diff-prefs';
import { DEFAULT_APPEARANCE, DEFAULT_LOOK, setAppearance, setLook } from '@/data/layout';
import { DEFAULT_NOTIFICATIONS, setNotificationPrefs } from '@/data/notifications';
import { DiffPage } from '@/screens/settings/DiffPage';
import { RemoveProject } from '@/screens/settings/ProjectSettingsScreen';
import { searchSettings } from '@/screens/settings/settings-search';
import { useSettingsView } from '@/screens/settings/view';
import { setLocaleSync } from '@/i18n';
import { zh, zhCatalog } from './i18n-setup.js';

type Command = { type: string; input: Record<string, unknown>; expected_revision: number | null };

const project = { id: 'alpha', revision: 3, name: 'Alpha app', roots: ['/work/alpha'] };
const commands: Command[] = [];
let stored: Map<string, string>;
async function mount<T>(body: () => T) {
  const h = host(body);
  await h.flush();
  return h;
}
const labelled = (tree: unknown, label: string) =>
  find(tree as never, (n) => n.props['aria-label'] === label);
const button = (tree: unknown, label: string) =>
  find(tree as never, (n) => n.type === 'button' && text(n.props.children) === label);

beforeEach(() => {
  commands.length = 0;
  stored = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
  vi.stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    pantheon: {
      async command(command: Command): Promise<BridgeResult<unknown>> {
        commands.push(command);
        return { ok: true, value: {} };
      },
    },
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  setDiffPrefs(DEFAULT_DIFF_PREFS);
  setLook(DEFAULT_LOOK);
  setAppearance(DEFAULT_APPEARANCE);
  setNotificationPrefs(DEFAULT_NOTIFICATIONS);
  useBoard.setState({ board: null });
  useSettingsView.setState({ page: 'general', open: false });
  setLocaleSync('zh-CN', zhCatalog());
});

describe('the diff page', () => {
  it('changes the choices the diff toolbar reads', async () => {
    const h = await mount(() => DiffPage());
    labelled(h.value, zh('components.diff.wrap')).props.onChange({ target: { checked: false } });
    labelled(h.value, zh('components.diff.ignoreWhitespace')).props.onChange({
      target: { checked: true },
    });
    labelled(h.value, zh('components.diff.collapse')).props.onChange({
      target: { checked: true },
    });
    const expected = {
      wrap: false,
      ignore_whitespace: true,
      collapse: true,
      view: 'unified',
      tab_size: 4,
      changes_viewer: 'app',
    };
    expect(getDiffPrefs()).toEqual(expected);
    expect(JSON.parse(stored.get(DIFF_PREFS_KEY)!)).toEqual(expected);
  });
});

describe('search finds the new settings', () => {
  const ids = (query: string) => searchSettings(query).map((h) => h.id);

  it.each([
    ['finds the diff page in zh-CN', 'zh-CN', '差异'],
    ['finds it by its English name', 'en', 'diff'],
  ] as const)('%s', (_name, locale, diff) => {
    if (locale === 'en') setLocaleSync('en', {});
    expect(ids(diff)).toContain('diff.page');
  });
});

describe('removing the project from settings', () => {
  it('removes it only once confirmed, then closes the settings', async () => {
    useSettingsView.setState({ open: true });
    const h = await mount(() => RemoveProject({ project: project as never }));
    button(h.value, zh('settings.general.remove')).props.onClick();
    await h.flush();
    expect(commands).toEqual([]);
    button(h.value, zh('projects.remove.confirm')).props.onClick();
    await h.flush();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: 'project.remove',
      input: { project_id: 'alpha' },
      expected_revision: 3,
    });
    expect(useSettingsView.getState().open).toBe(false);
  });
});
