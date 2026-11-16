import { describe, expect, it } from 'vitest';
import {
  checkBackdrop,
  deriveTheme,
  themeCss,
  themeInputSchema,
  type ThemeInput,
} from '@pantheon/protocol/theme';

const lightOnly: ThemeInput = {
  label: 'Paper',
  light: { anchors: { 'surface-0': '#f3f3f1', 'text-primary': '#1a1a18' } },
};
const darkOnly: ThemeInput = {
  label: 'Night',
  dark: { anchors: { 'surface-0': '#0e0e0d', 'text-primary': '#ededE9' } },
};

describe('theme input schema', () => {
  it('needs a light or a dark mode', () => {
    expect(themeInputSchema.safeParse({ label: 'Empty' }).success).toBe(false);
    expect(themeInputSchema.safeParse(lightOnly).success).toBe(true);
  });

  it('rejects colours that are not six-digit hex', () => {
    const short = {
      label: 'Short',
      light: { anchors: { 'surface-0': '#fff', 'text-primary': '#000000' } },
    };
    const named = {
      label: 'Named',
      dark: { anchors: { 'surface-0': '#000000', 'text-primary': 'white' } },
    };
    expect(themeInputSchema.safeParse(short).success).toBe(false);
    expect(themeInputSchema.safeParse(named).success).toBe(false);
  });

  it('rejects keys it does not know', () => {
    expect(themeInputSchema.safeParse({ ...lightOnly, colors: {} }).success).toBe(false);
    const anchorTypo = {
      label: 'Typo',
      light: {
        anchors: { 'surface-0': '#f3f3f1', 'text-primary': '#1a1a18', background: '#ffffff' },
      },
    };
    expect(themeInputSchema.safeParse(anchorTypo).success).toBe(false);
  });
});

describe('deriving a theme', () => {
  it('fills the missing light anchors from surface-0 and text-primary', () => {
    const { modes } = deriveTheme(lightOnly);
    const light = modes.light!;
    expect(modes.dark).toBeUndefined();
    expect(light['--bg']).toBe('#f3f3f1');
    expect(light['--sf']).toBe('#fdfdfb');
    expect(light['--sf2']).toBe('#ffffff');
    expect(light['--ov']).toBe('rgba(255,255,255,0.86)');
    expect(light['--tx']).toBe('#1a1a18');
    expect(light['--tx2']).toBe('#535351');
    expect(light['--mu']).toBe('#80807e');
    expect(light['--ink']).toBe('#1a1a18');
    expect(light['--on-ink']).toBe('#ffffff');
    expect(light['color-scheme']).toBe('light');
  });

  it('fills the missing dark anchors from surface-0 and text-primary', () => {
    const { modes } = deriveTheme(darkOnly);
    const dark = modes.dark!;
    expect(modes.light).toBeUndefined();
    expect(dark['--bg']).toBe('#0e0e0d');
    expect(dark['--sf']).toBe('#181817');
    expect(dark['--sf2']).toBe('#222221');
    expect(dark['--ov']).toBe('rgba(44,44,43,0.86)');
    expect(dark['--tx']).toBe('#ededE9'.toLowerCase());
    expect(dark['--tx2']).toMatch(/^#[0-9a-f]{6}$/);
    expect(dark['--mu']).toMatch(/^#[0-9a-f]{6}$/);
    expect(dark['--on-ink']).toBe('#0e0e0d');
    expect(dark['color-scheme']).toBe('dark');
  });

  it('leaves status and identity colours alone unless a role is given', () => {
    const plain = deriveTheme(lightOnly).modes.light!;
    expect(plain).not.toHaveProperty('--run');
    expect(plain).not.toHaveProperty('--bad');
    expect(plain).not.toHaveProperty('--rt-claude');
    const withRoles = deriveTheme({
      ...lightOnly,
      roles: { accent: '#2562e9', danger: '#c2333a' },
      light: { ...lightOnly.light!, roles: { danger: '#b3392f' } },
    }).modes.light!;
    expect(withRoles['--run']).toBe('#2562e9');
    expect(withRoles['--ink']).toBe('#2562e9');
    expect(withRoles['--bad']).toBe('#b3392f');
    expect(withRoles).not.toHaveProperty('--rt-claude');
    expect(withRoles).not.toHaveProperty('--ok-bg');
  });
});

describe('theme contrast', () => {
  it('passes the app default light palette', () => {
    const { blocking } = deriveTheme({
      label: 'Default',
      roles: {
        accent: '#2562e9',
        danger: '#c2333a',
        success: '#147c3b',
        warning: '#af5109',
        review: '#7c4ddb',
      },
      light: {
        anchors: {
          'surface-0': '#f3f3f1',
          'surface-1': '#ffffff',
          'surface-2': '#f6f6f4',
          'text-primary': '#1a1a18',
          'text-secondary': '#4b4b47',
          'text-muted': '#6e6e69',
        },
      },
    });
    expect(blocking).toEqual([]);
  });

  it('blocks muted text that is too faint and says by how much', () => {
    const { blocking } = deriveTheme({
      label: 'Faint',
      dark: {
        anchors: { 'surface-0': '#0e0e0d', 'text-primary': '#ededE9', 'text-muted': '#3a3a38' },
      },
    });
    expect(blocking).toContainEqual(
      expect.stringMatching(/^dark: text-muted on surface-0 is \d+\.\d:1, needs 3:1$/),
    );
  });

  it('puts the on-ink colour that reads best on the ink', () => {
    const paleAccent = deriveTheme({ ...darkOnly, roles: { accent: '#9fd3ff' } }).modes.dark!;
    expect(paleAccent['--on-ink']).toBe('#0e0e0d');
    const deepAccent = deriveTheme({ ...darkOnly, roles: { accent: '#1f3a8a' } }).modes.dark!;
    expect(deepAccent['--on-ink']).toBe('#ffffff');
  });
});

describe('checking a backdrop', () => {
  const scene =
    '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice">' +
    '<defs><linearGradient id="g"><stop offset="0" stop-color="#123"/></linearGradient></defs>' +
    '<style>@keyframes drift{from{transform:translateX(0)}to{transform:translateX(10px)}} path{animation:drift 9s infinite alternate}</style>' +
    '<path d="M0 50 Q50 0 100 50" fill="url(#g)"/><use href="#g"/></svg>';

  it('accepts a self-contained animated SVG', () => {
    expect(checkBackdrop(scene)).toEqual([]);
  });

  it.each([
    ['a script', scene.replace('</svg>', '<script>alert(1)</script></svg>')],
    ['a foreignObject', scene.replace('</svg>', '<foreignObject><div/></foreignObject></svg>')],
    ['an event attribute', scene.replace('<path ', '<path onload="x()" ')],
    ['an outside href', scene.replace('href="#g"', 'xlink:href="https://example.com/a.svg"')],
    ['an outside url()', scene.replace('url(#g)', 'url(https://example.com/a.png)')],
    ['too many characters', scene.replace('</svg>', `<!--${'x'.repeat(131072)}--></svg>`)],
    ['no svg root', '<html><svg></svg></html>'],
    [
      'a CSS escape',
      scene.replace('path{animation', 'path{background:\\75 rl(https://x.example/a);animation'),
    ],
    [
      'a character reference',
      scene.replace('path{animation', 'path{background:&#117;rl(https://x.example/a);animation'),
    ],
  ])('rejects %s', (_name, svg) => {
    expect(checkBackdrop(svg).length).toBeGreaterThan(0);
  });
});

describe('theme css', () => {
  it('scopes each mode to the theme id', () => {
    const css = themeCss('paper-2', {
      light: { '--bg': '#f3f3f1', 'color-scheme': 'light' },
      dark: { '--bg': '#0e0e0d', 'color-scheme': 'dark' },
    });
    expect(css).toContain(
      ':root[data-user-theme="paper-2"]:not(.dark){--bg:#f3f3f1;color-scheme:light;}',
    );
    expect(css).toContain(':root[data-user-theme="paper-2"].dark{--bg:#0e0e0d;color-scheme:dark;}');
  });

  it('refuses an id outside lowercase letters, digits and dashes', () => {
    expect(() => themeCss('Paper', {})).toThrow();
    expect(() => themeCss('a"]{}', {})).toThrow();
    expect(() => themeCss('', {})).toThrow();
    expect(() => themeCss('a'.repeat(65), {})).toThrow();
  });
});
