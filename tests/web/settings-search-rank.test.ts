import { afterEach, describe, expect, it } from 'vitest';
import { setLocaleSync } from '@/i18n';
import { searchSettings } from '@/screens/settings/settings-search';
import { hitGroups } from '@/screens/settings/settings-jump';
import { SETTINGS_INDEX } from '@/screens/settings/settings-index';
import { SETTINGS_PAGES } from '@/screens/settings/view';
import { zhCatalog } from './i18n-setup.js';

afterEach(() => setLocaleSync('zh-CN', zhCatalog()));

const ids = (query: string) => searchSettings(query).map((hit) => hit.id);
const fold = (text: string) => text.normalize('NFKC').toLocaleLowerCase();

const languages: [string, () => void][] = [
  ['zh-CN', () => setLocaleSync('zh-CN', zhCatalog())],
  ['English', () => setLocaleSync('en', {})],
];

describe.each(languages)('settings search in %s', (_name, load) => {
  it.each([
    ['puts the theme first for dark', 'dark', 'appearance.theme'],
    ['puts the send key first for send enter', 'send enter', 'appearance.sendKey'],
  ])('%s', (_name, query, id) => {
    load();
    expect(ids(query)[0]).toBe(id);
  });

  it.each([
    ['finds zoom by its English name', 'zoom', 'appearance.zoom'],
    ['finds the project budget for budget', 'budget', 'project.budget'],
  ])('%s', (_name, query, id) => {
    load();
    expect(ids(query)).toContain(id);
  });

  it('does not find every page for one letter', () => {
    load();
    expect(hitGroups('e').length).toBeLessThan(SETTINGS_PAGES.length);
  });

  it('ranks the hooks among the first three for hook', () => {
    load();
    expect(ids('hook').slice(0, 3)).toContain('extensions.hooks');
  });

  it('lands on the browser, Hugging Face and Cloudflare rows', () => {
    load();
    const hit = (query: string) => searchSettings(query)[0];
    expect(hit('browser')).toMatchObject({ id: 'editor.browser', page: 'editor' });
    expect(hit('Hugging Face')).toMatchObject({
      id: 'connections.huggingface',
      page: 'connections',
    });
    expect(hit('Cloudflare')).toMatchObject({ id: 'connections.cloudflare', page: 'connections' });
  });

  it('lands a runtime account search on the runtimes page', () => {
    load();
    expect(searchSettings('email')[0]).toMatchObject({
      id: 'harness.account',
      page: 'harness',
    });
  });

  it('marks ranges that hold a query word in the shown label', () => {
    load();
    for (const query of ['zoom', 'send enter', 'hook', '主题', '强调']) {
      const terms = fold(query).split(' ');
      for (const hit of searchSettings(query))
        for (const [start, end] of hit.ranges) {
          expect(end).toBeGreaterThan(start);
          expect(terms).toContain(fold(hit.label.slice(start, end)));
        }
    }
  });

  it('returns nothing for an empty query and finds the parts of a project page', () => {
    load();
    expect(searchSettings('  ')).toEqual([]);
    expect(searchSettings('hook').map((h) => h.page)).toContain('extensions');
  });
});

describe('settings search in zh-CN', () => {
  it('finds the theme first for 深色 and the hooks for 钩子', () => {
    expect(ids('深色')[0]).toBe('appearance.theme');
    expect(ids('钩子').slice(0, 3)).toContain('extensions.hooks');
  });

  it('lands 邮箱 on the runtime accounts', () => {
    expect(ids('邮箱')[0]).toBe('harness.account');
  });

  it('marks the matched part of a Chinese label', () => {
    const hit = searchSettings('缩放').find((h) => h.id === 'appearance.zoom')!;
    expect(hit.ranges.map(([s, e]) => hit.label.slice(s, e))).toEqual(['缩放']);
  });

  it('jumps only to the page for a page name', () => {
    const hits = searchSettings('外观');
    expect(hits[0]).toMatchObject({ id: 'appearance.page', pageOnly: true });
    expect(new Set(hits.map((h) => h.page))).toEqual(new Set(['appearance']));
  });

  it('lands on the devices page for its name', () => {
    expect(searchSettings('设备')[0]).toMatchObject({
      id: 'devices.page',
      pageOnly: true,
    });
  });

  it('finds the brief only choice of the notifications and what a failed gate does', () => {
    expect(new Set(searchSettings('仅简报').map((h) => h.page))).toContain('notifications');
    expect(ids('门禁失败时')[0]).toBe('gates.onFail');
  });

  it.each([
    ['finds how changes open on the open with page', '应用内 diff', 'editor.changes'],
    ['finds the browser that opens links for 浏览器', '浏览器', 'editor.browser'],
  ])('%s', (_name, query, id) => {
    expect(ids(query)[0]).toBe(id);
  });
});

describe('settings index', () => {
  it('names each item once as <page>.<item>, an item of a moved page under its old page', () => {
    const all = SETTINGS_INDEX.map((r) => r.id);
    expect(new Set(all).size).toBe(all.length);
    const moved: Record<string, string> = { experience: 'general' };
    for (const r of SETTINGS_INDEX) {
      const prefix = r.id.slice(0, r.id.indexOf('.'));
      expect(moved[prefix] ?? prefix).toBe(r.page);
    }
  });
});
