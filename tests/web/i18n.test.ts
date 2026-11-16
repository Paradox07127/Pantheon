import { afterEach, describe, expect, it } from 'vitest';
import { currentLocale, resolveLocale, setLocaleSync, t } from '@/i18n';
import { zh, zhCatalog } from './i18n-setup.js';

afterEach(() => setLocaleSync('zh-CN', zhCatalog()));

describe('interface language', () => {
  it.each([['zh-Hans-CN'], ['zh-Hans'], ['zh-CN'], ['zh']])(
    'shows Simplified Chinese on a %s system',
    (tag) => {
      expect(resolveLocale('system', [tag])).toBe('zh-CN');
    },
  );

  it.each<[string, [Parameters<typeof resolveLocale>[0], string[], string][]]>([
    ['shows English when nothing is chosen on an English system', [['system', ['en-US'], 'en']]],
    [
      'shows English on a system language without a catalog',
      [
        ['system', ['fr-FR'], 'en'],
        ['system', [], 'en'],
      ],
    ],
    [
      'takes the first preferred language that has a catalog',
      [['system', ['fr-FR', 'zh-Hant-TW', 'zh-Hans-CN', 'en-US'], 'zh-CN']],
    ],
    [
      'keeps a chosen language whatever the system prefers',
      [
        ['en', ['zh-Hans-CN'], 'en'],
        ['zh-CN', ['en-US'], 'zh-CN'],
      ],
    ],
  ])('%s', (_name, cases) => {
    for (const [chosen, system, shown] of cases) expect(resolveLocale(chosen, system)).toBe(shown);
  });
});

describe('message text', () => {
  const greeting = { id: 'sample.greeting.hello', defaultMessage: 'Hello, {name}' };
  const files = {
    id: 'sample.files.count',
    defaultMessage: '{count, plural, one {# file} other {# files}}',
  };

  it.each([
    ['is the English text in English', 'en', {}, 'Hello, Ada'],
    [
      'is the catalog text in Simplified Chinese',
      'zh-CN',
      { 'sample.greeting.hello': '你好，{name}' },
      '你好，Ada',
    ],
    ['falls back to the English text for a key the catalog lacks', 'zh-CN', {}, 'Hello, Ada'],
  ] as const)('%s', (_name, locale, catalog, shown) => {
    setLocaleSync(locale, catalog);
    expect(currentLocale()).toBe(locale);
    expect(t(greeting, { name: 'Ada' })).toBe(shown);
  });

  it('picks the plural form by the count', () => {
    setLocaleSync('en', {});
    expect(t(files, { count: 1 })).toBe('1 file');
    expect(t(files, { count: 3 })).toBe('3 files');
    setLocaleSync('zh-CN', { 'sample.files.count': '{count, plural, other {# 个文件}}' });
    expect(t(files, { count: 1 })).toBe('1 个文件');
    expect(t(files, { count: 3 })).toBe('3 个文件');
  });

  it('shows the converted screen names from the zh-CN catalog under the test setup', () => {
    expect(t({ id: 'app.screenName.settings', defaultMessage: 'Settings' })).toBe(
      zh('app.screenName.settings'),
    );
  });
});
