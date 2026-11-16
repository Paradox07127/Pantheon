import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  titleBarOverlay,
  WINDOW_BACKGROUND,
  windowChrome,
} from '../../apps/desktop/src/main/window.js';

const css = readFileSync(new URL('../../apps/web/src/index.css', import.meta.url), 'utf8');
/** The value of `name` in the first block that `selector` opens and that declares it. */
const token = (selector: string, name: string): string => {
  for (const [, body] of css.matchAll(new RegExp(`^${selector} \\{([^}]*)\\}`, 'gm'))) {
    const value = new RegExp(`${name}:\\s*([^;]+);`).exec(body!)?.[1];
    if (value) return value.trim();
  }
  throw new Error(`${selector} declares no ${name}`);
};

it('centres the macOS window buttons in the window title bar', () => {
  expect(windowChrome('darwin', titleBarOverlay(false))).toEqual({
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 20 },
  });
  expect(windowChrome('darwin', titleBarOverlay(true))).toEqual(
    windowChrome('darwin', titleBarOverlay(false)),
  );
});

it.each(['win32', 'linux'] as const)(
  'has the system draw the window buttons over the top bar, and no menu bar, on %s',
  (platform) => {
    const overlay = { color: '#20201e', symbolColor: '#f0f0ea', height: 44 };
    expect(windowChrome(platform, overlay)).toEqual({
      titleBarStyle: 'hidden',
      titleBarOverlay: overlay,
      autoHideMenuBar: true,
    });
  },
);

it('paints the window buttons in the top bar colours of the light and dark themes', () => {
  expect(titleBarOverlay(false)).toEqual({
    color: token(':root', '--sf'),
    symbolColor: token(':root', '--tx'),
    height: 44,
  });
  expect(titleBarOverlay(true)).toEqual({
    color: token('\\.dark', '--sf'),
    symbolColor: token('\\.dark', '--tx'),
    height: 44,
  });
  expect(token(':root', '--titlebar')).toBe('52px');
  expect(css).toMatch(/^\.tb\{[^}]*height:var\(--titlebar\)/m);
});

it('fills a window with the page background of the light and dark themes before the page draws', () => {
  expect(WINDOW_BACKGROUND).toEqual({
    light: token(':root', '--bg'),
    dark: token('\\.dark', '--bg'),
  });
});
