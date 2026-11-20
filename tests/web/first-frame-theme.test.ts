import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Theme } from '@/store';

const web = path.resolve(import.meta.dirname, '../../apps/web');
const html = readFileSync(path.join(web, 'index.html'), 'utf8');
const css = readFileSync(path.join(web, 'src/index.css'), 'utf8');
const head = html.slice(0, html.indexOf('</head>'));

/** The inline script in the page head, run against the given storage and system scheme. */
function firstFrameDark(storage: Pick<Storage, 'getItem'>, prefersDark: boolean): boolean {
  const script = /<script>([\s\S]*?)<\/script>/.exec(head)?.[1];
  expect(script).toBeTruthy();
  const classes = new Set<string>();
  runInNewContext(script!, {
    localStorage: storage,
    matchMedia: (query: string) => ({
      matches: query === '(prefers-color-scheme: dark)' && prefersDark,
    }),
    document: { documentElement: { classList: { add: (name: string) => classes.add(name) } } },
  });
  return classes.has('dark');
}

afterEach(() => vi.unstubAllGlobals());

describe('the first frame of the page', () => {
  it('is dark exactly when the shell store resolves the stored theme dark', async () => {
    const items = new Map<string, string>();
    const storage = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
    };
    vi.stubGlobal('localStorage', storage);
    const { readTheme, resolveTheme, useShell } = await import('@/store');
    const unreadable = {
      getItem: () => {
        throw new Error('storage is off');
      },
    };
    for (const theme of [null, 'light', 'dark', 'system'] as (Theme | null)[]) {
      items.clear();
      if (theme) useShell.getState().setTheme(theme);
      for (const store of [storage, unreadable])
        for (const prefersDark of [false, true])
          expect(
            firstFrameDark(store, prefersDark),
            `${store === storage ? (theme ?? 'nothing') : 'unreadable'} stored, system ${prefersDark ? 'dark' : 'light'}`,
          ).toBe(resolveTheme(readTheme(store), prefersDark) === 'dark');
    }
  });

  it('paints the saved accent colour as the app writes it, and nothing for the default', async () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(head)![1]!;
    const items = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
    });
    const written: { id: string; textContent: string }[] = [];
    vi.stubGlobal('document', {
      head: { append: (el: { id: string; textContent: string }) => written.push(el) },
      getElementById: (id: string) => written.find((el) => el.id === id) ?? null,
      createElement: () => ({ id: '', textContent: '', remove() {} }),
    });
    const { ACCENT_KEY, setAccent, setSystemAccent } = await import('@/data/layout');
    const firstFrame = () => {
      const styles: { id: string; textContent: string }[] = [];
      runInNewContext(script, {
        localStorage: { getItem: (key: string) => items.get(key) ?? null },
        matchMedia: () => ({ matches: false }),
        JSON,
        document: {
          head: { append: (el: { id: string; textContent: string }) => styles.push(el) },
          createElement: () => ({ id: '', textContent: '' }),
          documentElement: { classList: { add() {} }, dataset: {} },
        },
      });
      return styles;
    };
    setAccent('verdigris');
    expect(items.has(ACCENT_KEY)).toBe(true);
    expect(written.map((el) => el.id)).toEqual(['pt-accent']);
    expect(firstFrame()).toEqual([{ id: 'pt-accent', textContent: written[0]!.textContent }]);
    setSystemAccent('#0a84ff');
    setAccent('system');
    expect(firstFrame()).toEqual([{ id: 'pt-accent', textContent: written[0]!.textContent }]);
    expect(firstFrame()[0]!.textContent).toContain('#0a84ff');
    setAccent('default');
    setSystemAccent(null);
    expect(firstFrame()).toEqual([]);
  });

  it('runs before any stylesheet, says both schemes and paints the window in the theme background', () => {
    const script = head.indexOf('<script>');
    expect(script).toBeGreaterThan(-1);
    expect(head.slice(0, script)).not.toMatch(/<link|<style/);
    expect(head).toMatch(/<meta name="color-scheme" content="light dark"\s*\/?>/);
    const tokenBg = (block: string) =>
      new RegExp(`(?:^|\\n)${block} \\{[^}]*?--bg: (#[0-9a-f]{6});`, 'i').exec(css)?.[1];
    const inlineBg = (selector: string) =>
      new RegExp(`${selector} \\{\\s*background: (#[0-9a-f]{6});`, 'i').exec(head)?.[1];
    expect(tokenBg(':root')).toBeTruthy();
    expect(tokenBg('\\.dark')).toBeTruthy();
    expect(inlineBg('html')?.toLowerCase()).toBe(tokenBg(':root')!.toLowerCase());
    expect(inlineBg('html\\.dark')?.toLowerCase()).toBe(tokenBg('\\.dark')!.toLowerCase());
  });
});
