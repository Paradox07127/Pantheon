import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ReactNode } from 'react';
import { find, mount as host, named, nodes, text, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { DiffFiles, type DiffRead } from '@/components/DiffReview';
import { DEFAULT_DIFF_PREFS, getDiffPrefs, readDiffPrefs, setDiffPrefs } from '@/data/diff-prefs';
import {
  applyLook,
  DEFAULT_LAYOUT,
  DEFAULT_LOOK,
  getLayout,
  getLook,
  LAYOUT_KEY,
  readLayout,
  readLook,
  setLayout,
  setLook,
} from '@/data/layout';
import {
  DEFAULT_NOTIFICATIONS,
  getNotificationPrefs,
  setNotificationPrefs,
} from '@/data/notifications';
import { DEFAULT_SESSION_DISPLAY, setSessionDisplay } from '@/data/session-display';
import { DiffPage } from '@/screens/settings/DiffPage';
import { ProjectSettingsScreen } from '@/screens/settings/ProjectSettingsScreen';
import { SETTINGS_INDEX } from '@/screens/settings/settings-index';
import { useSettingsView, type SettingsPage } from '@/screens/settings/view';
import { setLocaleSync } from '@/i18n';
import { reducedMotion } from '@/lib/motion';
import { zh, zhCatalog } from './i18n-setup.js';

const settingsCss = readFileSync(
  fileURLToPath(new URL('../../apps/web/src/screens/settings/settings.css', import.meta.url)),
  'utf8',
);

let stored: Map<string, string>;
let systemReduces = false;
const LANGUAGE = zh('settings.appearance.language');
const SLEEP = zh('settings.keepAwake.toggle');
const MOTION = zh('settings.appearance.reduceMotion');
const SIDEBAR_WIDTH = zh('settings.appearance.sidebarWidth');
async function mount<T>(body: () => T) {
  const h = host(body);
  await h.flush();
  return h;
}
const child = (node: { type: unknown; props: unknown }) =>
  mount(() => (node.type as (props: unknown) => unknown)(node.props));
const labelled = (tree: unknown, label: string) =>
  find(tree as never, (n) => n.props['aria-label'] === label);
const rowLabels = (tree: unknown) =>
  nodes(tree as never)
    .filter((n) => typeof n.type === 'function' && n.type.name === 'Row')
    .map((n) => n.props.label);

const properties = () => {
  const set = new Map<string, string>();
  return {
    set,
    setProperty: (name: string, value: string) => void set.set(name, value),
    removeProperty: (name: string) => set.delete(name),
  };
};

async function appPage(page: SettingsPage, name: string) {
  useSettingsView.setState({ page });
  const screen = await mount(() => ProjectSettingsScreen());
  const app = await child(named(screen.value, 'AppPage'));
  return child(named(app.value as ReactNode, name));
}

beforeEach(() => {
  stored = new Map();
  systemReduces = false;
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
  vi.stubGlobal('window', {
    innerWidth: 1440,
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: systemReduces }),
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  setDiffPrefs(DEFAULT_DIFF_PREFS);
  setLook(DEFAULT_LOOK);
  setLayout(DEFAULT_LAYOUT);
  setNotificationPrefs(DEFAULT_NOTIFICATIONS);
  setSessionDisplay(DEFAULT_SESSION_DISPLAY);
  useSettingsView.setState({ page: 'general', query: '' });
  setLocaleSync('zh-CN', zhCatalog());
});

describe('the general page', () => {
  it('holds the language and the sleep switch', async () => {
    const general = await appPage('general', 'GeneralPage');
    expect(rowLabels(general.value)).toEqual([LANGUAGE, SLEEP]);
    expect(labelled(general.value, LANGUAGE)).toBeDefined();
    const sleep = labelled(general.value, SLEEP);
    sleep.props.onChange({ target: { checked: false } });
    expect(getNotificationPrefs().keep_awake).toBe(false);
  });

  it('files the language under the general page in the search index', () => {
    const language = SETTINGS_INDEX.find((r) => r.label.id === 'settings.appearance.language');
    expect(language?.page).toBe('general');
    expect(language?.id).toBe('general.language');
  });
});

describe('the code font', () => {
  it('sets the bundled monospace font until the system one is chosen', async () => {
    expect(readLook(null).code_family).toBe('bundled');
    const body = { dataset: {} as Record<string, string | undefined>, style: properties() };
    applyLook(getLook(), body, false);
    expect(body.dataset.codeFamily).toBe('bundled');
    const page = await appPage('appearance', 'AppearancePage');
    labelled(page.value, zh('settings.appearance.codeFamily')).props.onValueChange('system');
    expect(getLook().code_family).toBe('system');
    applyLook(getLook(), body, false);
    expect(body.dataset.codeFamily).toBe('system');
    const rule = /\.pt\[data-code-family='system'\]\s*\{([^}]*)\}/.exec(settingsCss)?.[1] ?? '';
    const stack = /--font-mono:\s*([^;]*);/.exec(rule)?.[1] ?? '';
    expect(stack.split(',')[0]!.trim()).toBe('ui-monospace');
    expect(stack).not.toContain('Geist');
  });
});

describe('the pane widths', () => {
  it('keeps an out-of-range width unsaved and shows the range in place', async () => {
    const page = await appPage('appearance', 'AppearancePage');
    const input = await child(
      find(
        page.value as never,
        (n) => n.props.label === SIDEBAR_WIDTH && n.props.min !== undefined,
      ),
    );
    const field = () => labelled(input.value, SIDEBAR_WIDTH);
    field().props.onChange({ target: { value: '900' } });
    input.render();
    field().props.onBlur();
    input.render();
    expect(getLayout().sidebar.width).toBe(248);
    expect(stored.has(LAYOUT_KEY)).toBe(false);
    const shown = text(input.value as ReactNode);
    expect(shown).toContain('200');
    expect(shown).toContain('420');
    field().props.onChange({ target: { value: '300' } });
    input.render();
    field().props.onBlur();
    input.render();
    expect(getLayout().sidebar.width).toBe(300);
    expect(JSON.parse(stored.get(LAYOUT_KEY)!).sidebar.width).toBe(300);
    expect(text(input.value as ReactNode)).not.toContain('420');
  });
});

describe('collapsing the sidebar at start', () => {
  it('stores the switch and folds the sidebar when the layout is read with it on', async () => {
    const page = await appPage('appearance', 'AppearancePage');
    labelled(page.value, zh('settings.appearance.collapseSidebarAtStart')).props.onChange({
      target: { checked: true },
    });
    expect(getLayout().collapse_sidebar_at_start).toBe(true);
    const saved = stored.get(LAYOUT_KEY)!;
    expect(JSON.parse(saved).collapse_sidebar_at_start).toBe(true);
    vi.resetModules();
    const started = await import('@/data/layout');
    expect(started.getLayout().sidebar.collapsed).toBe(true);
    expect(readLayout(saved).sidebar.collapsed).toBe(false);
    expect(readLayout(null).collapse_sidebar_at_start).toBe(false);
  });
});

describe('reduced motion', () => {
  it('offers following the system, on and off, and follows the system until one is chosen', async () => {
    expect(readLook(null).motion).toBe('system');
    const page = await appPage('appearance', 'AppearancePage');
    const motion = () => labelled(page.value, MOTION);
    expect(nodes(motion().props.children).map((n) => text(n))).toEqual(
      ['motionSystem', 'motionOn', 'motionOff'].map((key) => zh(`settings.appearance.${key}`)),
    );
    expect(motion().props.value).toBe('system');
    systemReduces = true;
    expect(reducedMotion()).toBe(true);
    motion().props.onValueChange('full');
    expect(getLook().motion).toBe('full');
    expect(reducedMotion()).toBe(false);
    systemReduces = false;
    motion().props.onValueChange('reduced');
    expect(reducedMotion()).toBe(true);
    page.render();
    expect(motion().props.value).toBe('reduced');
  });

  it('reads the old switch values as following the system and reduced', () => {
    expect(readLook(JSON.stringify({ motion: 'standard' })).motion).toBe('system');
    expect(readLook(JSON.stringify({ motion: 'reduced' })).motion).toBe('reduced');
  });
});

describe('the diff page', () => {
  const read: DiffRead = {
    data: {
      files: [{ path: 'a.ts', additions: 1, deletions: 1 }],
      patch: [
        'diff --git a/a.ts b/a.ts',
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -1,2 +1,2 @@',
        ' keep',
        '-\told',
        '+\tnew',
        '',
      ].join('\n'),
      truncated: false,
    },
    error: null,
    reload() {},
  };

  it('stores the default view and the tab width', async () => {
    expect(readDiffPrefs(null)).toMatchObject({ view: 'unified', tab_size: 4 });
    const page = await mount(() => DiffPage());
    labelled(page.value, zh('settings.diff.view')).props.onValueChange('split');
    labelled(page.value, zh('settings.diff.tabSize')).props.onValueChange(8);
    expect(getDiffPrefs()).toMatchObject({ view: 'split', tab_size: 8 });
  });

  it('sets the tab width on the diff lines and on the preview', async () => {
    setDiffPrefs({ tab_size: 8, wrap: false });
    const files = await mount(() => DiffFiles({ diff: read }));
    const lists = (tree: unknown) =>
      nodes(tree as never).filter((n) => /\bss-dl\b/.test(n.props.className ?? ''));
    expect(lists(files.value)[0]!.props.style).toMatchObject({ tabSize: 8 });
    const page = await mount(() => DiffPage());
    const preview = lists(page.value)[0]!;
    expect(preview.props.style).toMatchObject({ tabSize: 8 });
    expect(preview.props['data-nowrap']).toBe(true);
    setDiffPrefs({ tab_size: 2, wrap: true });
    page.render();
    expect(lists(page.value)[0]!.props.style).toMatchObject({ tabSize: 2 });
    expect(lists(page.value)[0]!.props['data-nowrap']).toBeUndefined();
  });
});
