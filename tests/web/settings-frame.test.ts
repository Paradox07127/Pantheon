import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThemeSwitch } from '@/components/ThemeSwitch';
import { t } from '@/i18n';
import { AppearancePage } from '@/screens/settings/AppearancePage';
import { CategoryHeader } from '@/screens/settings/CategoryHeader';
import { Row, Section } from '@/screens/settings/ProjectSettingsScreen';
import { SearchResults } from '@/screens/settings/SearchResults';
import { SETTINGS_INDEX } from '@/screens/settings/settings-index';
import { SettingsNav } from '@/screens/settings/SettingsNav';
import { SETTINGS_PAGES, useSettingsView } from '@/screens/settings/view';
import { zh } from './i18n-setup.js';

const THIS_COMPUTER = zh('settings.nav.app');
const GATES = zh('settings.pages.gates');
const DEFAULTS = zh('settings.pages.defaults');
const ALL_PROJECTS = zh('settings.nav.projects');
const APPEARANCE = zh('settings.pages.appearance');
const html = (type: never, props: object) => renderToStaticMarkup(createElement(type, props));

beforeEach(() =>
  vi.stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false }),
  }),
);
afterEach(() => {
  vi.unstubAllGlobals();
  useSettingsView.setState({ page: 'general', query: '' });
});

describe('settings navigation', () => {
  it("lists the pages of this computer, then the pages for every project, then a project's parts", () => {
    expect(SETTINGS_PAGES.map((p) => [p.group, p.key, p.label])).toEqual(
      [
        ['app', 'general', 'settings.pages.general'],
        ['app', 'appearance', 'settings.pages.appearance'],
        ['app', 'sessionDisplay', 'settings.pages.sessionDisplay'],
        ['app', 'diff', 'settings.pages.diff'],
        ['app', 'harness', 'settings.pages.runtimes'],
        ['app', 'editor', 'settings.pages.openWith'],
        ['app', 'connections', 'settings.pages.connections'],
        ['app', 'devices', 'settings.devices.title'],
        ['app', 'notifications', 'settings.pages.notifications'],
        ['app', 'shortcuts', 'settings.pages.shortcuts'],
        ['app', 'data', 'settings.pages.data'],
        ['app', 'about', 'settings.pages.about'],
        ['global', 'defaults', 'settings.pages.defaults'],
        ['global', 'usage', 'settings.pages.usage'],
        ['global', 'external', 'settings.pages.external'],
        ['global', 'permissions', 'settings.pages.permissions'],
        ['global', 'projects', 'settings.pages.projects'],
        ['project', 'gates', 'settings.pages.gates'],
        ['project', 'worktrees', 'settings.pages.worktrees'],
        ['project', 'extensions', 'settings.pages.extensions'],
        ['project', 'project', 'settings.pages.project'],
      ].map(([group, key, id]) => [group, key, zh(id!)]),
    );
  });

  it('opens this computer on a page that holds a setting', () => {
    const first = SETTINGS_PAGES.find((p) => p.group === 'app')!.key;
    expect(SETTINGS_INDEX.filter((r) => r.page === first).map((r) => r.id)).toContain(
      'general.keepAwake',
    );
  });

  it('heads the groups with this computer and every project, and shows an icon on each page', () => {
    const nav = html(SettingsNav as never, { page: 'appearance' });
    expect([...nav.matchAll(/<h4>([^<]*)<\/h4>/g)].map((m) => m[1])).toEqual([
      THIS_COMPUTER,
      ALL_PROJECTS,
    ]);
    const pages = [...nav.matchAll(/<button type="button" class="ps-page"[^>]*>(.*?)<\/button>/g)];
    expect(pages).toHaveLength(SETTINGS_PAGES.filter((p) => p.group !== 'project').length);
    for (const [, body] of pages) expect(body).toContain('<svg');
  });
});

describe('settings page header', () => {
  it('names an app page with this computer as its scope', () => {
    const header = html(CategoryHeader as never, { page: 'appearance' });
    expect(header).toContain(`<h1>${APPEARANCE}</h1><span class="ps-chip">${THIS_COMPUTER}</span>`);
  });

  it('says a page for every project applies to every project', () => {
    const header = html(CategoryHeader as never, { page: 'defaults' });
    expect(header).toContain(`<h1>${DEFAULTS}</h1><span class="ps-chip">${ALL_PROJECTS}</span>`);
  });

  it('names the search across all settings while a search is typed', () => {
    useSettingsView.setState({ query: '宽度' });
    const header = html(CategoryHeader as never, { page: 'gates' });
    expect(header).toContain(
      `<h1>${zh('settings.category.search')}</h1><span class="ps-chip">${zh('settings.category.scopeAll')}</span>`,
    );
    expect(header).not.toContain(GATES);
  });
});

describe('settings search results', () => {
  it('counts the results above the list and gives each its page and group', () => {
    useSettingsView.setState({ query: '字号' });
    const results = html(SearchResults as never, { hasProject: true });
    // Besides the announcement, the count shows above the list.
    const shown = results.replace(/<div[^>]*role="status"[^>]*>.*?<\/div>/, '');
    expect(shown).toMatch(
      new RegExp(
        `${t({ id: 'settings.search.resultCount', defaultMessage: '' }, { count: 2 })}.*role="listbox"`,
      ),
    );
    const paths = [...results.matchAll(/role="option"[^>]*>.*?<span class="ps-path">([^<]*)</g)];
    const path = t(
      { id: 'settings.search.path', defaultMessage: '' },
      { page: APPEARANCE, section: zh('settings.appearance.text') },
    );
    expect(paths.map((m) => m[1])).toEqual([path, path]);
  });
});

describe('setting rows', () => {
  it('puts a hint under the name when one is given', () => {
    const row = html(Row as never, { label: '抽屉宽度', hint: '检查器和详情栏', children: null });
    expect(row).toContain('抽屉宽度');
    expect(row).toContain('检查器和详情栏');
  });

  it('leaves the caption out of a group given no title', () => {
    const group = html(Section as never, { children: 'rows' });
    expect(group).not.toContain('ps-sec-hd');
    expect(group).not.toContain('<h3');
    expect(group).toContain('<div class="ps-grp"><div class="ps-sec-bd">rows</div></div>');
  });
});

describe('settings frame styles', () => {
  const css = readFileSync(
    fileURLToPath(new URL('../../apps/web/src/screens/settings/settings.css', import.meta.url)),
    'utf8',
  );
  const rule = (selector: string) => {
    const at = css.indexOf(`\n${selector} {`);
    expect(at, selector).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('}', at));
  };

  it.each([
    ['.ps-side h4', 'height', 'var(--row)'],
    ['.ps-find', 'border-radius', 'var(--r-sm)'],
    ['.ps-side .ps-page', 'border-radius', 'var(--r-sm)'],
    ['.ps-cg .tk-select', 'border-radius', 'var(--r-sm)'],
    ['.ps-cg .seg', 'border-radius', 'calc(var(--r-sm) + 2px)'],
  ])('%s sets %s to %s', (selector, property, value) => {
    expect(rule(selector)).toContain(`${property}: ${value};`);
  });
});

describe('colour mode', () => {
  it('names the light, dark and system choices in text on the appearance page', () => {
    const page = html(AppearancePage as never, {});
    const theme = new RegExp(
      `<div[^>]*role="radiogroup"[^>]*aria-label="${zh('components.themeSwitch.label')}"[^>]*>(.*?)</div>`,
    ).exec(page)?.[1];
    expect(theme).toBeDefined();
    expect(theme).not.toContain('<svg');
    expect([...theme!.matchAll(/>([^<>]+)</g)].map((m) => m[1])).toEqual([
      zh('components.themeSwitch.light'),
      zh('components.themeSwitch.dark'),
      zh('components.themeSwitch.system'),
    ]);
  });

  it('keeps the icon form elsewhere', () => {
    const icons = html(ThemeSwitch as never, { value: 'system', onValueChange() {} });
    expect(icons.match(/<svg/g)).toHaveLength(3);
    expect(icons).toContain(`aria-label="${zh('components.themeSwitch.light')}"`);
  });
});
