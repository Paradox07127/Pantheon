import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { find, nodes, text } from './web-hook-host.js';
import { MenuItem } from '@/components/Menu';
import { CategoryHeader } from '@/screens/settings/CategoryHeader';
import { NotificationsPage } from '@/screens/settings/NotificationsPage';
import { SearchResults } from '@/screens/settings/SearchResults';
import { SettingsNav } from '@/screens/settings/SettingsNav';
import { SETTINGS_PAGES, useSettingsView, type SettingsPage } from '@/screens/settings/view';
import { zh } from './i18n-setup.js';

function render(query: string) {
  useSettingsView.setState({ query });
  return {
    nav: renderToStaticMarkup(createElement(SettingsNav, { page: 'appearance' })),
    results: renderToStaticMarkup(createElement(SearchResults)),
  };
}
const pageButtons = (html: string) => [
  ...html.matchAll(/<button type="button" class="ps-page"([^>]*)>(.*?)<\/button>/g),
];
const options = (html: string) =>
  [
    ...html.matchAll(/<div [^>]*role="option"[^>]*><span class="ps-opt-nm"><span>(.*?)<\/span>/g),
  ].map((m) => m[1]);
const field = () => find(SettingsNav({ page: 'appearance' }), (n) => n.props.type === 'search');

afterEach(() => {
  vi.unstubAllGlobals();
  useSettingsView.setState({ page: 'general', query: '' });
});

describe('settings search results', () => {
  it('lists the light and dark setting first for 深色', () => {
    expect(options(render('深色').results)[0]).toBe(zh('settings.appearance.scheme'));
  });

  it('marks the matched part of each setting name', () => {
    expect(options(render('字号').results)).toEqual([
      '界面<mark class="hit">字号</mark>',
      '代码<mark class="hit">字号</mark>',
    ]);
  });

  it('gives a setting outside any group its page alone as its path', () => {
    const { results } = render('数据目录');
    expect(results).toContain(
      `数据目录</mark></span><span class="ps-path">${zh('settings.pages.data')}</span>`,
    );
  });

  it('says so when nothing matches', () => {
    const { results } = render('没有这一项');
    expect(options(results)).toEqual([]);
    expect(results).toContain(zh('settings.nav.noMatch'));
  });
});

describe('settings navigation while searching', () => {
  it('shows every page by its icon and name alone', () => {
    const all = pageButtons(render('').nav);
    expect(all).toHaveLength(SETTINGS_PAGES.filter((p) => p.group !== 'project').length);
    for (const [, , body] of all)
      expect(body).toMatch(/^<span class="ps-ico"><svg[^>]*>.*?<\/svg><\/span>[^<]+$/);
  });

  it('dims the pages without a match and counts the hits of the others', () => {
    const all = pageButtons(render('字号').nav);
    expect(all.filter(([, attrs]) => attrs!.includes('data-dim')).length).toBe(all.length - 1);
    const lit = all.find(([, attrs]) => !attrs!.includes('data-dim'))!;
    expect(lit[2]).toMatch(
      new RegExp(`${zh('settings.pages.appearance')}<span class="ps-cnt">2 项</span>$`),
    );
  });

  it('clears the query on Escape without letting it close the window', () => {
    useSettingsView.setState({ query: '字号' });
    const stop = vi.fn();
    field().props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation: stop });
    expect(stop).toHaveBeenCalled();
    expect(useSettingsView.getState().query).toBe('');
    const passed = vi.fn();
    field().props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation: passed });
    expect(passed).not.toHaveBeenCalled();
  });

  it('moves through the results with the arrow keys and opens one with Enter', () => {
    vi.stubGlobal('requestAnimationFrame', () => 0);
    useSettingsView.setState({ page: 'general', query: '字号' });
    const key = (name: string) =>
      field().props.onKeyDown({ key: name, preventDefault() {}, stopPropagation() {} });
    key('ArrowDown');
    key('ArrowDown');
    expect(field().props['aria-activedescendant']).toBe('settings-hit-1');
    key('ArrowUp');
    key('ArrowDown');
    key('Enter');
    expect(useSettingsView.getState()).toMatchObject({ page: 'appearance', query: '' });
  });
});

describe('category header', () => {
  const jumps = (page: SettingsPage) =>
    nodes(CategoryHeader({ page }))
      .filter((n) => n.type === MenuItem)
      .map((n) => text(n.props.children));
  const sections = (page: () => ReactElement) =>
    [...renderToStaticMarkup(page()).matchAll(/<section\b[^>]*>/g)].length;

  it.each<[SettingsPage, string[], (() => number)?]>([
    [
      'notifications',
      ['settings.notifications.events', 'settings.notifications.delivery'],
      () => sections(() => createElement(NotificationsPage)),
    ],
    // Each runtime is a group of the same settings, so its settings jump to the first one.
    ['harness', ['settings.pages.runtimes', 'settings.harness.backends']],
    [
      'extensions',
      [
        'settings.extensions.mcp',
        'settings.extensions.plugins',
        'settings.extensions.skills',
        'settings.search.apps',
        'settings.extensions.hooks',
      ],
    ],
  ])('offers one jump for each group the %s page shows', (page, groups, shown) => {
    expect(jumps(page)).toEqual(groups.map((id) => zh(id)));
    if (shown) expect(shown()).toBe(groups.length);
  });

  it('offers a jump to each section of the page from its menu', () => {
    const html = renderToStaticMarkup(createElement(CategoryHeader, { page: 'appearance' }));
    expect(html).toContain(`<h1>${zh('settings.pages.appearance')}</h1>`);
    expect(html).toContain(`aria-label="${zh('settings.category.jump')}"`);
    expect(jumps('appearance')).toEqual(
      ['themeAndColour', 'text', 'layout'].map((id) => zh(`settings.appearance.${id}`)),
    );
  });

  it('scopes the projects page to every project, or to the project whose page is open', () => {
    const chip = (scope: string) =>
      `<h1>${zh('settings.pages.projects')}</h1><span class="ps-chip">${scope}</span>`;
    expect(renderToStaticMarkup(createElement(CategoryHeader, { page: 'projects' }))).toContain(
      chip(zh('settings.nav.projects')),
    );
    expect(
      renderToStaticMarkup(createElement(CategoryHeader, { page: 'projects', scope: 'Alpha app' })),
    ).toContain(chip('Alpha app'));
    expect(jumps('projects')).toEqual([]);
  });
});
