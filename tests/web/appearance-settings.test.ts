import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ReactNode } from 'react';
import { mount, named, nodes, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
import { t } from '@/i18n';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector({ board: null }), {
    getState: () => ({ board: null }),
    subscribe: () => () => {},
  }),
}));
vi.mock('@/store', () => ({
  useShell: (selector: any) => selector({ theme: 'system', setTheme() {} }),
}));
vi.mock('@/screens/settings/view', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSettingsView: (select: any) =>
    select({ runtime: 'codex', setRuntime() {}, page: 'appearance', setPage() {} }),
}));
import {
  ACCENT_KEY,
  accentCss,
  APPEARANCE_KEY,
  applyLook,
  applyText,
  DEFAULT_APPEARANCE,
  DEFAULT_LOOK,
  getAccent,
  getAppearance,
  getLook,
  getSystemAccent,
  LOOK_KEY,
  onInk,
  readAccent,
  readAppearance,
  readLook,
  setAccent,
  setAppearance,
  setLook,
  setSystemAccent,
  watchSystemAccent,
} from '@/data/layout';
import { ProjectSettingsScreen, Section } from '@/screens/settings/ProjectSettingsScreen';

const css = readFileSync(
  fileURLToPath(new URL('../../apps/web/src/index.css', import.meta.url)),
  'utf8',
);
let stored: Map<string, string>;
const appearance = (key: string) => zh(`settings.appearance.${key}`);
const child = (node: any) => mount(() => node.type(node.props));
const element = () => {
  const style = new Map<string, string>();
  return {
    dataset: {} as Record<string, string | undefined>,
    style: {
      setProperty: (name: string, value: string) => void style.set(name, value),
      removeProperty: (name: string) => style.delete(name),
    },
    properties: style,
  };
};

beforeEach(() => {
  stored = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
  vi.stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false }),
    pantheon: { zoomFactor: vi.fn(async () => ({ ok: true, value: 1 })) },
  });
});
afterEach(() => {
  unmountAll();
  setLook(DEFAULT_LOOK);
  setAppearance(DEFAULT_APPEARANCE);
  vi.unstubAllGlobals();
});

describe('colour-blind palette, code text size, fonts and motion', () => {
  it('defaults to the standard palette, 12px bundled code, the default font and the system motion', () => {
    expect(readLook(null)).toEqual({
      colorblind: false,
      code_font: 12,
      code_family: 'bundled',
      code_font_name: '',
      ui_family: 'default',
      ui_font_name: '',
      motion: 'system',
      transcript: 'folded',
      send_key: 'enter',
    });
    expect(readLook('{bad')).toEqual(DEFAULT_LOOK);
    expect(
      readLook(
        JSON.stringify({
          colorblind: 'yes',
          code_font: 9,
          code_family: 'serif',
          code_font_name: 3,
          ui_family: 'serif',
          ui_font_name: null,
          motion: 'none',
          transcript: 'all',
          send_key: 'space',
        }),
      ),
    ).toEqual(DEFAULT_LOOK);
  });

  it('takes any whole code size from 10 to 24px, the old choices included', () => {
    const size = (code_font: unknown) => readLook(JSON.stringify({ code_font })).code_font;
    expect([10, 12, 13, 14, 24].map(size)).toEqual([10, 12, 13, 14, 24]);
    expect([9, 25, 12.5, '14'].map(size)).toEqual([12, 12, 12, 12]);
  });

  it('stores each choice and sets it on the body', () => {
    const body = element();
    applyLook(getLook(), body, false);
    expect(body.dataset).toEqual({
      palette: 'standard',
      codeFamily: 'bundled',
      uiFamily: 'default',
      motion: 'full',
    });
    expect(Object.fromEntries(body.properties)).toEqual({ '--fs-code': '12px' });
    const chosen = {
      colorblind: true,
      code_font: 17,
      code_family: 'custom',
      code_font_name: 'Fira "Code"',
      ui_family: 'custom',
      ui_font_name: 'Inter',
      motion: 'full',
      transcript: 'expanded',
      send_key: 'meta-enter',
    } as const;
    setLook(chosen);
    expect(readLook(stored.get(LOOK_KEY)!)).toEqual(chosen);
    applyLook(getLook(), body, false);
    expect(body.dataset).toEqual({
      palette: 'colorblind',
      codeFamily: 'custom',
      uiFamily: 'custom',
      motion: 'full',
    });
    expect(Object.fromEntries(body.properties)).toEqual({
      '--fs-code': '17px',
      '--font-mono': '"Fira \\"Code\\"", monospace',
      '--font-sans': '"Inter", sans-serif',
    });
    setLook({ code_family: 'system', ui_family: 'mono' });
    applyLook(getLook(), body, false);
    expect(Object.fromEntries(body.properties)).toEqual({ '--fs-code': '17px' });
  });

  it('styles every value the body can carry', () => {
    expect(css).toMatch(/^\.pt\[data-palette=colorblind\]\{/m);
    expect(css).toMatch(/^\.pt\[data-ui-family=mono\]\{--font-sans:var\(--font-mono\)\}/m);
  });

  it('sets tool output, terminal blocks and diffs in the code text size', () => {
    const blocks = /^\.pt :is\(([^)]*)\)\{--fs-xs:var\(--fs-code\)\}/m.exec(css)?.[1]?.split(',');
    expect(blocks).toEqual(['.tr-pre', '.ps-term', '.df-hunks', '.ss-tio pre', '.ss-dl']);
    for (const selector of ['.tr-pre', '.ps-term', '.df-hunks'])
      expect(
        new RegExp(`^\\${selector}\\{[^}]*font-size:var\\(--fs-xs\\)`, 'm').test(css),
        selector,
      ).toBe(true);
  });

  it('stops movement but keeps fades when motion is reduced', () => {
    const rule = /^\.pt\[data-motion=reduced\] \*,[^{]*\{([^}]*)\}/m.exec(css)?.[1] ?? '';
    expect(rule).toContain('animation:none!important');
    expect(rule).toContain(
      'transition-property:opacity,color,background-color,border-color!important',
    );
  });

  it.each([
    ['system', false, 'full'],
    ['system', true, 'reduced'],
    ['reduced', false, 'reduced'],
    ['full', true, 'full'],
  ] as const)(
    'marks the body for motion %s with the system reducing motion %s as %s',
    (motion, systemReduced, marked) => {
      const body = element();
      applyLook({ ...DEFAULT_LOOK, motion }, body, systemReduced);
      expect(body.dataset.motion).toBe(marked);
    },
  );
});

describe('the interface text size and line height', () => {
  const root = /^:root \{[^}]*--fs-xs:[^}]*\}/m.exec(css)?.[0] ?? '';
  const token = (name: string) => new RegExp(`${name}:\\s*([^;]*);`).exec(root)?.[1];

  it('makes every step of the type scale follow the interface size', () => {
    for (const name of ['--fs-xs', '--fs-sm', '--fs-md', '--fs-lg', '--fs-xl'])
      expect(token(name), name).toMatch(/var\(--fs-(ui|lg)\)/);
    for (const name of ['--lh-xs', '--lh-sm', '--lh-md', '--lh-lg'])
      expect(token(name), name).toMatch(/var\(--fs-ui\).*var\(--lh-add\)/);
    expect(token('--fs-code')).not.toMatch(/--fs-/);
  });

  it('sets the size and the line height on the element it is given', () => {
    const root = element();
    applyText(getAppearance(), root.style);
    expect(Object.fromEntries(root.properties)).toEqual({ '--fs-ui': '13px', '--lh-add': '0px' });
    setAppearance({ chat_font: 18, line_height: 'relaxed' });
    expect(readAppearance(stored.get(APPEARANCE_KEY)!)).toMatchObject({
      chat_font: 18,
      line_height: 'relaxed',
    });
    applyText(getAppearance(), root.style);
    expect(root.properties.get('--fs-ui')).toBe('18px');
    setAppearance({ line_height: 'compact' });
    applyText(getAppearance(), root.style);
    expect(root.properties.get('--lh-add')).not.toBe('0px');
  });

  it('takes any whole size from 11 to 20px', () => {
    const size = (chat_font: unknown) => readAppearance(JSON.stringify({ chat_font })).chat_font;
    expect([11, 13, 16, 20].map(size)).toEqual([11, 13, 16, 20]);
    expect([10, 21, 13.5, 'huge', 'constructor', 'small', null].map(size)).toEqual([
      13, 13, 13, 13, 13, 13, 13,
    ]);
    expect(readAppearance(JSON.stringify({ line_height: 'tall' })).line_height).toBe('standard');
  });
});

describe('the Appearance page', () => {
  async function page() {
    const screen = mount(() => ProjectSettingsScreen());
    const app = child(named(screen.value, 'AppPage'));
    const h = child(named(app.value, 'AppearancePage'));
    await h.flush();
    return h;
  }

  it('groups the settings into at most three bordered frames, one setting per row', async () => {
    const h = await page();
    const frames = nodes(h.value).filter(
      (n) => n.type === Section || /\bps-sec\b/.test(n.props.className ?? ''),
    );
    expect(frames.map((n) => n.props.title)).toEqual([
      undefined,
      appearance('text'),
      appearance('layout'),
    ]);
    const rows = nodes(h.value).filter(
      (n) => typeof n.type === 'function' && n.type.name === 'Row',
    );
    expect(rows.map((n) => n.props.label)).toEqual(
      [
        'scheme',
        'accent',
        'colorblind',
        'textSize',
        'uiFamily',
        'lineHeight',
        'codeFamily',
        'codeFont',
        'density',
        'readingWidth',
        'zoom',
        'inspectorOpening',
        'sendKey',
        'reduceMotion',
        'sidebarWidth',
        'collapseSidebarAtStart',
        'inspectorWidth',
        'drawerWidth',
      ].map(appearance),
    );
  });

  it('says what density and the drawer width change', async () => {
    const h = await page();
    const hint = (settingId: string) =>
      nodes(h.value).find((n) => n.props.settingId === settingId)!.props.hint;
    expect(hint('appearance.density')).toBe(appearance('densityHint'));
    expect(hint('appearance.drawerWidth')).toBe(appearance('drawerWidthHint'));
  });

  it('sets each text size from a slider or a whole px value in its range', async () => {
    const h = await page();
    const size = (key: string) => {
      const node = nodes(h.value).find(
        (n) =>
          typeof n.type === 'function' &&
          n.type.name === 'SizeInput' &&
          n.props.label === appearance(key),
      )!;
      return mount(() => (node.type as (props: unknown) => ReactNode)(node.props));
    };
    const slider = (key: string) =>
      nodes(size(key).value).find((n) => n.props['aria-label'] === appearance(key))!;
    expect(slider('textSize').props).toMatchObject({ type: 'range', min: 11, max: 20, step: 1 });
    expect(slider('codeFont').props).toMatchObject({ type: 'range', min: 10, max: 24, step: 1 });
    slider('textSize').props.onChange({ target: { value: '17' } });
    slider('codeFont').props.onChange({ target: { value: '20' } });
    expect(getAppearance().chat_font).toBe(17);
    expect(getLook().code_font).toBe(20);

    const typed = nodes(size('textSize').value).find(
      (n) => typeof n.type === 'function' && n.type.name === 'PxInput',
    )!;
    const label = t(
      { id: 'settings.appearance.sizeInPx', defaultMessage: '' },
      { name: appearance('textSize') },
    );
    expect(typed.props.label).toBe(label);
    const field = mount(() => (typed.type as (props: unknown) => ReactNode)(typed.props));
    const input = () => nodes(field.value).find((n) => n.props['aria-label'] === label)!;
    input().props.onChange({ target: { value: '25' } });
    field.render();
    input().props.onBlur();
    field.render();
    expect(input().props['aria-invalid']).toBe(true);
    expect(getAppearance().chat_font).toBe(17);
    input().props.onChange({ target: { value: '12' } });
    field.render();
    input().props.onBlur();
    expect(getAppearance().chat_font).toBe(12);
  });

  it('asks for a font name only while a custom font is chosen', async () => {
    const h = await page();
    const control = (key: string) =>
      nodes(h.value).find((n) => n.props['aria-label'] === appearance(key))!;
    const fontName = (key: string) =>
      nodes(h.value).find(
        (n) =>
          typeof n.type === 'function' &&
          n.type.name === 'FontName' &&
          n.props.label === appearance(key),
      );
    expect(fontName('uiFontName')).toBeUndefined();
    expect(fontName('codeFontName')).toBeUndefined();
    control('uiFamily').props.onValueChange('custom');
    control('codeFamily').props.onValueChange('custom');
    h.render();
    for (const [key, name] of [
      ['uiFontName', 'Inter'],
      ['codeFontName', 'Iosevka'],
    ] as const) {
      const node = fontName(key)!;
      const field = mount(() => (node.type as (props: unknown) => ReactNode)(node.props));
      nodes(field.value)
        .find((n) => n.props['aria-label'] === appearance(key))!
        .props.onChange({ target: { value: name } });
    }
    expect(getLook()).toMatchObject({
      ui_family: 'custom',
      ui_font_name: 'Inter',
      code_family: 'custom',
      code_font_name: 'Iosevka',
    });
    control('lineHeight').props.onValueChange('relaxed');
    expect(getAppearance().line_height).toBe('relaxed');
  });

  it('keeps the names of the existing controls', async () => {
    const h = await page();
    const names = nodes(h.value)
      .map((n) => n.props['aria-label'])
      .filter(Boolean);
    for (const key of ['density', 'readingWidth', 'zoom', 'inspectorOpening'])
      expect(names).toContain(appearance(key));
    expect(
      nodes(h.value).some((n) => typeof n.type === 'function' && n.type.name === 'ThemeSwitch'),
    ).toBe(true);
  });

  it('changes the palette, code font, interface font and motion from their controls', async () => {
    const h = await page();
    const control = (key: string) =>
      nodes(h.value).find((n) => n.props['aria-label'] === appearance(key))!;
    control('colorblind').props.onChange({ target: { checked: true } });
    control('codeFamily').props.onValueChange('system');
    control('uiFamily').props.onValueChange('mono');
    control('reduceMotion').props.onValueChange('reduced');
    control('sendKey').props.onValueChange('meta-enter');
    expect(getLook()).toEqual({
      ...DEFAULT_LOOK,
      colorblind: true,
      code_family: 'system',
      ui_family: 'mono',
      motion: 'reduced',
      send_key: 'meta-enter',
    });
  });

  it('offers each accent colour by name, saves the one chosen and writes its style, which the default takes away', async () => {
    const head: { id: string; textContent: string; remove(): void }[] = [];
    vi.stubGlobal('document', {
      head: { append: (el: (typeof head)[number]) => void head.push(el) },
      getElementById: (id: string) => head.find((el) => el.id === id) ?? null,
      createElement: () => {
        const el = { id: '', textContent: '', remove: () => void head.splice(head.indexOf(el), 1) };
        return el;
      },
    });
    const h = await page();
    const group = nodes(h.value).find((n) => n.props['aria-label'] === '强调色')!;
    expect(
      nodes(group.props.children)
        .map((n) => n.props['aria-label'])
        .filter(Boolean),
    ).toEqual(['默认', '青铜', '青金', '陶土', '铜绿', '斑岩']);
    expect(group.props.value).toBe('default');
    group.props.onValueChange('bronze');
    group.props.onValueChange('lapis');
    expect(getAccent()).toBe('lapis');
    expect(readAccent(stored.get(ACCENT_KEY)!)).toBe('lapis');
    expect(head.map((el) => el.id)).toEqual(['pt-accent']);
    group.props.onValueChange('default');
    expect(readAccent(stored.get(ACCENT_KEY)!)).toBe('default');
    expect(head).toEqual([]);
  });

  describe('the system accent colour', () => {
    let head: { id: string; textContent: string; remove(): void }[];
    beforeEach(() => {
      head = [];
      vi.stubGlobal('document', {
        head: { append: (el: (typeof head)[number]) => void head.push(el) },
        getElementById: (id: string) => head.find((el) => el.id === id) ?? null,
        createElement: () => {
          const el = {
            id: '',
            textContent: '',
            remove: () => void head.splice(head.indexOf(el), 1),
          };
          return el;
        },
      });
    });
    afterEach(() => {
      setAccent('default');
      setSystemAccent(null);
    });
    const names = async () => {
      const h = await page();
      const group = nodes(h.value).find((n) => n.props['aria-label'] === '强调色')!;
      return nodes(group.props.children)
        .map((n) => n.props['aria-label'])
        .filter(Boolean);
    };

    it('is offered after Default only while the desktop app reports one', async () => {
      setSystemAccent('#0a84ff');
      expect(await names()).toEqual(['默认', '跟随系统', '青铜', '青金', '陶土', '铜绿', '斑岩']);
      setSystemAccent(null);
      expect(await names()).not.toContain('跟随系统');
    });

    it.each([
      ['#2f4ba8', 'rgb(255 255 255)'],
      ['#0a84ff', 'rgb(255 255 255)'],
      ['#000000', 'rgb(255 255 255)'],
      ['#ffd60a', 'rgb(20 20 19)'],
      ['#ffffff', 'rgb(20 20 19)'],
    ])('puts white text on %s while it reads at 3:1, else dark: %s', (colour, text) => {
      expect(onInk(colour)).toBe(text);
    });

    it('follows the colour the desktop app reports, and repaints when it changes', async () => {
      let report: (accent: string | null) => void = () => {};
      const stop = vi.fn();
      const bridge = {
        systemAccent: vi.fn(async () => '#0a84ff'),
        onSystemAccent: vi.fn((listener: typeof report) => {
          report = listener;
          return stop;
        }),
      };
      vi.stubGlobal('window', { pantheon: bridge, addEventListener() {} });
      const unwatch = watchSystemAccent();
      await Promise.resolve();
      expect(getSystemAccent()).toBe('#0a84ff');
      setAccent('system');
      const style = () => head.find((el) => el.id === 'pt-accent')?.textContent;
      expect(style()).toBe(accentCss('system', '#0a84ff'));
      expect(JSON.parse(stored.get(ACCENT_KEY)!)).toEqual({
        accent: 'system',
        css: accentCss('system', '#0a84ff'),
      });
      report('#ffd60a');
      expect(style()).toBe(accentCss('system', '#ffd60a'));
      expect(JSON.parse(stored.get(ACCENT_KEY)!).css).toBe(accentCss('system', '#ffd60a'));
      expect(accentCss('system', '#ffd60a')).not.toBe(accentCss('system', '#0a84ff'));
      report(null);
      expect(style()).toBeUndefined();
      unwatch();
      expect(stop).toHaveBeenCalledTimes(1);
    });

    it('is not followed without the desktop app', () => {
      vi.stubGlobal('window', {});
      watchSystemAccent()();
      expect(getSystemAccent()).toBeNull();
    });
  });
});
