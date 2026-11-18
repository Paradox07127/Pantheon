import { afterEach, describe, expect, it } from 'vitest';
import { setLocaleSync, type Locale } from '@/i18n';
import { clockText, dayText, durationText } from '../../apps/web/src/lib/time-text.js';
import { zhCatalog } from './i18n-setup.js';

describe('durationText', () => {
  it.each([
    [0, '<1 秒'],
    [999, '<1 秒'],
    [1000, '1 秒'],
    [59_999, '59 秒'],
    [60_000, '1 分钟'],
    [65_000, '1 分 5 秒'],
    [600_000, '10 分钟'],
    [3_599_999, '59 分钟'],
    [3_600_000, '1 小时'],
    [3_900_000, '1 小时 5 分'],
    [86_400_000, '1 天'],
    [97_200_000, '1 天 3 小时'],
  ])('writes %i ms as %s', (ms, text) => {
    expect(durationText(ms)).toBe(text);
  });
});

const NOW = new Date(2026, 10, 16, 15, 0).getTime();
const TODAY = new Date(2026, 10, 16, 14, 5, 9).getTime();
const YESTERDAY = new Date(2026, 10, 15, 14, 5, 9).getTime();
const THIS_YEAR = new Date(2026, 10, 2, 14, 5, 9).getTime();
const LAST_YEAR = new Date(2025, 10, 16, 14, 5, 9).getTime();

describe('clockText', () => {
  afterEach(() => setLocaleSync('zh-CN', zhCatalog()));

  it.each([
    [false, '14:05'],
    [true, '14:05:09'],
  ])('with seconds %s writes %s', (seconds, text) => {
    expect(clockText(TODAY, { seconds })).toBe(text);
  });

  it('writes the time in the language the interface switched to', () => {
    expect(clockText(TODAY)).toBe('14:05');
    // Both interface languages write the same digits; one with its own numerals shows the switch.
    setLocaleSync('ar-EG' as Locale, {});
    expect(clockText(TODAY)).toBe('١٤:٠٥');
    setLocaleSync('zh-CN', zhCatalog());
    expect(clockText(TODAY)).toBe('14:05');
  });
});

describe('dayText', () => {
  afterEach(() => setLocaleSync('zh-CN', zhCatalog()));

  it.each([
    ['today', TODAY, false, '今天'],
    ['today', TODAY, true, '14:05'],
    ['yesterday', YESTERDAY, false, '昨天'],
    ['yesterday', YESTERDAY, true, '昨天 14:05'],
    ['this year', THIS_YEAR, false, '11月2日'],
    ['this year', THIS_YEAR, true, '11月2日 14:05'],
    ['an earlier year', LAST_YEAR, false, '2025年11月16日'],
    ['an earlier year', LAST_YEAR, true, '2025年11月16日 14:05'],
  ])('writes a time %s (%i), with the time %s, as %s', (_, at, time, text) => {
    expect(dayText(at, NOW, { time })).toBe(text);
  });

  it('writes the date in the language the interface shows', () => {
    setLocaleSync('en', {});
    expect(dayText(THIS_YEAR, NOW)).toBe('Nov 2');
    expect(dayText(LAST_YEAR, NOW)).toBe('Nov 16, 2025');
    expect(dayText(YESTERDAY, NOW, { time: true })).toBe('Yesterday 14:05');
    expect(clockText(TODAY)).toBe('14:05');
  });
});
