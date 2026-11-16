import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useBoard } from '@/data/board';
import { CategoryHeader } from '@/screens/settings/CategoryHeader';
import { GeneralPage } from '@/screens/settings/GeneralPage';
import { ProjectSettingsScreen } from '@/screens/settings/ProjectSettingsScreen';
import { SearchResults } from '@/screens/settings/SearchResults';
import { SettingsNav } from '@/screens/settings/SettingsNav';
import { SETTINGS_PAGES, useSettingsView } from '@/screens/settings/view';
import { t } from '@/i18n';
import { zh } from './i18n-setup.js';

const html = (type: never, props: object) => renderToStaticMarkup(createElement(type, props));
const visibleText = (markup: string) =>
  markup.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '');

beforeEach(() =>
  vi.stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false }),
  }),
);
afterEach(() => {
  vi.unstubAllGlobals();
  useBoard.setState({ board: null });
  useSettingsView.setState({ page: 'general', query: '' });
});

describe('settings navigation rows', () => {
  it('gives every page an icon and keeps its name as the accessible name', () => {
    const nav = html(SettingsNav as never, { page: 'appearance' });
    const rows = [...nav.matchAll(/<button type="button" class="ps-page"[^>]*>(.*?)<\/button>/g)];
    const listed = SETTINGS_PAGES.filter((p) => p.group !== 'project');
    expect(rows).toHaveLength(listed.length);
    rows.forEach(([, body], at) => {
      expect(body).toMatch(/<svg[^>]*aria-hidden="true"/);
      expect(visibleText(body!)).toBe(listed[at]!.label);
    });
  });

  it('heads the two groups with this computer and every project', () => {
    const nav = html(SettingsNav as never, { page: 'appearance' });
    expect([...nav.matchAll(/<h4[^>]*>([^<]*)<\/h4>/g)].map((m) => m[1])).toEqual([
      zh('settings.nav.app'),
      zh('settings.nav.projects'),
    ]);
  });

  it('shows a slash key cap at the end of the search field', () => {
    const nav = html(SettingsNav as never, { page: 'appearance' });
    const field = /<label[^>]*>(.*?)<\/label>/.exec(nav)?.[1] ?? '';
    expect(field).toMatch(/<input[^>]*type="search"[^>]*>.*<kbd[^>]*>\/<\/kbd>$/);
  });
});

describe('settings page header', () => {
  it('names the page in a heading and offers an icon-only close button with a name', () => {
    const header = html(CategoryHeader as never, { page: 'appearance' });
    expect(header).toContain(`<h1>${zh('settings.pages.appearance')}</h1>`);
    expect(header).toMatch(
      new RegExp(`<button[^>]*aria-label="${zh('settings.dialog.close')}"[^>]*><svg`),
    );
  });

  it("follows the projects page name with the open project's name", () => {
    const header = html(CategoryHeader as never, { page: 'projects', scope: 'Alpha app' });
    expect(header).toMatch(
      new RegExp(`<h1>${zh('settings.pages.projects')}</h1><span[^>]*>Alpha app</span>`),
    );
  });

  it('keeps one page heading, with no second title inside the page', () => {
    useBoard.setState({ board: { cursor: 0, projects: [], sessions: [] } as never });
    useSettingsView.setState({ page: 'appearance' });
    const screen = html(ProjectSettingsScreen as never, {});
    expect(screen.match(/<h[12][ >]/g)).toEqual(['<h1>']);
  });
});

describe('settings groups', () => {
  it('draws a group of settings as one frame holding one row per setting', () => {
    const page = html(GeneralPage as never, {});
    const frames = [...page.matchAll(/class="ps-grp"/g)];
    expect(frames).toHaveLength(1);
    const frame = page.slice(page.indexOf('class="ps-grp"'));
    expect(frame.match(/class="ps-row"/g)).toHaveLength(2);
  });

  it('lists the search results in the same frame and marks the matched text', () => {
    useSettingsView.setState({ query: '字号' });
    const results = html(SearchResults as never, { hasProject: true });
    expect(results).toMatch(/role="listbox" class="ps-grp[^"]*"/);
    expect(results.match(/<mark[^>]*>字号<\/mark>/g)).toHaveLength(2);
  });
});
