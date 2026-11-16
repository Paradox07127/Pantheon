import { it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../../apps/web/src', import.meta.url));
const css = readFileSync(path.join(src, 'index.css'), 'utf8');

// The theme token block is the one that sets color-scheme.
function tokenBlock(selector: string): string {
  const block = css.match(new RegExp(`^${selector}\\s*\\{[^}]*color-scheme[^}]*\\}`, 'm'));
  if (!block) throw new Error(`no token block for ${selector}`);
  return block[0];
}

function declaredNames(block: string): string[] {
  return [...block.matchAll(/(--[\w-]+|color-scheme)\s*:/g)].map((m) => m[1]!).sort();
}

const themeTokens = [
  ...['--bg', '--rail', '--sf', '--sf2', '--sf3', '--band', '--code', '--bd', '--bd2'],
  ...['--tx', '--tx2', '--mu', '--ink', '--on-ink', '--ac', '--ac-bg', '--ac2'],
  ...['--run', '--wait', '--wait-bg', '--ready', '--ok', '--ok-bg', '--bad', '--bad-bg', '--idle'],
  ...['--unk', '--unk-bg', '--chk', '--chk-bg', '--chg', '--chg-bg', '--rt-claude', '--rt-codex'],
  ...['--e-done', '--e-act', '--e-pend', '--e-str', '--term', '--term-tx'],
  ...['--glass', '--glass-2', '--glass-bd', '--ov', '--bd-ov', '--bd-top', '--dot'],
  ...['--tint-a', '--tint-b', '--focus-ring', '--rt-agy', '--rt-grok', '--rt-dsh', '--rt-muse'],
  ...['opencode', 'cursor', 'copilot', 'gemini', 'kilo', 'cline', 'qwen', 'kimi', 'goose'].map(
    (runtime) => `--rt-${runtime}`,
  ),
  ...['openhands', 'kiro', 'junie', 'devin', 'vibe', 'hermes', 'codebuddy', 'qoder'].map(
    (runtime) => `--rt-${runtime}`,
  ),
  ...[1, 2, 3, 4, 5, 6].map((n) => `--series-${n}`),
  ...['--cb-run', '--cb-wait', '--cb-ok', '--cb-bad', '--bd-hover'],
  ...['--track', '--sel', '--faint', '--bd3', '--add', '--del'],
  ...['bronze', 'lapis', 'terracotta', 'verdigris', 'porphyry'].map((name) => `--accent-${name}`),
  '--on-accent',
  ...['travertine', 'black', 'white', 'dusk', 'terracotta', 'lapis'].map(
    (name) => `--icon-${name}`,
  ),
  'color-scheme',
];

it('defines the same 100 theme variables plus color-scheme for light and dark', () => {
  const light = declaredNames(tokenBlock(':root'));
  const dark = declaredNames(tokenBlock('\\.dark'));
  expect(new Set(light).size).toBe(light.length);
  expect(light.filter((name) => name.startsWith('--'))).toHaveLength(100);
  expect(light).toEqual(themeTokens.toSorted());
  expect(light).toContain('color-scheme');
  expect(light).toContain('--focus-ring');
  expect(light).not.toContain('--ring');
  expect(dark).toEqual(light);
});

it('keeps hex colors out of the renderer source except in the two token blocks', () => {
  // Vendor marks keep the vendors' own colours.
  const files = readdirSync(src, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => file !== path.join(src, 'components', 'BrandMark.tsx'));
  const found: string[] = [];
  for (const file of files) {
    let text = readFileSync(file, 'utf8');
    if (file === path.join(src, 'index.css'))
      text = text.replace(tokenBlock(':root'), '').replace(tokenBlock('\\.dark'), '');
    for (const m of text.matchAll(/#[0-9a-fA-F]{3,8}\b/g))
      found.push(`${path.relative(src, file)}: ${m[0]}`);
  }
  expect(found).toEqual([]);
});

const themes = [
  ['light', tokenValues(tokenBlock(':root'))],
  ['dark', tokenValues(tokenBlock('\\.dark'))],
] as const;

function tokenValues(block: string): Record<string, string> {
  return Object.fromEntries(
    [...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]),
  );
}

// An rgba() colour is first laid over the background it is drawn on.
function rgb(value: string, under?: number[]): number[] {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16));
  const m = /^rgba\(([\d.]+),([\d.]+),([\d.]+),([\d.]+)\)$/.exec(value.replace(/\s/g, ''));
  if (!m || !under) throw new Error(`not a colour: ${value}`);
  const alpha = Number(m[4]);
  return [1, 2, 3].map((i, k) => Number(m[i]) * alpha + under[k]! * (1 - alpha));
}

function luminance([r, g, b]: number[]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
}

/** The WCAG 2 contrast ratio of a colour drawn on a background. */
function contrast(fg: string, bg: string): number {
  const under = rgb(bg);
  const [a, b] = [luminance(rgb(fg, under)), luminance(under)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

it('draws the focus ring at 3:1 or more on the canvas and every surface, in both themes', () => {
  const low: string[] = [];
  for (const [theme, t] of themes)
    for (const bg of ['--bg', '--sf', '--sf2']) {
      const ratio = contrast(t['--focus-ring']!, t[bg]!);
      if (ratio < 3) low.push(`${theme} on ${bg}: ${ratio.toFixed(2)}`);
    }
  expect(low).toEqual([]);
});

it('has no accent colour: the accent tokens are the ink and the selection fill', () => {
  expect(css).not.toMatch(/data-accent/);
  for (const [theme, t] of themes) {
    expect(t['--ac'], theme).toBe(t['--ink']);
    expect(t['--ac2'], theme).toBe(t['--ink']);
    expect(t['--ac-bg'], theme).toBe(t['--sel']);
    expect(t['--focus-ring'], theme).toBe(t['--ink']);
    expect(t['--rail'], theme).toBe(t['--bg']);
  }
});

it('dims only the name of a turned-off row, to 4.5:1 or more', () => {
  const off = [...css.matchAll(/^\.ps-ri:has\(\.ps-sw:not\(:checked\)\)([^{]*)\{([^}]*)\}/gm)];
  expect(off.filter((m) => /opacity/.test(m[2]!)).map((m) => m[0])).toEqual([]);
  const name = off.find((m) => m[1]!.trim() === '.ps-nm b');
  const token = /color:var\((--[\w-]+)\)/.exec(name?.[2] ?? '')?.[1];
  expect(token).toBeDefined();
  for (const [theme, t] of themes)
    for (const bg of ['--bg', '--sf'])
      expect(contrast(t[token!]!, t[bg]!), `${theme} on ${bg}`).toBeGreaterThanOrEqual(4.5);
});

it('sets the content on one rounded, hairline-edged surface over the canvas, with no line beside the sidebar', () => {
  const rule = (selector: string) =>
    new RegExp(`^${selector.replace(/[.]/g, '\\.')}\\{([^}]*)\\}`, 'm').exec(css)?.[1] ?? '';
  expect(rule('.app')).toContain('background:var(--bg)');
  const pane = rule('.app-main');
  for (const part of [
    'margin:var(--titlebar) var(--sp-2) var(--sp-2) 0',
    'background:var(--sf)',
    'border:var(--hair) solid var(--bd)',
    'border-radius:var(--r-xl)',
    'overflow:hidden',
  ])
    expect(pane).toContain(part);
  expect(rule('.app.sb-off .app-main')).toBe('margin-left:var(--sp-2)');
  expect(rule('.sb')).toContain('background:var(--bg)');
  expect(rule('.sb')).not.toMatch(/border/);
});

function ruleOf(selector: string): string {
  return new RegExp(`^${selector.replace(/[.]/g, '\\.')}\\{([^}]*)\\}`, 'm').exec(css)?.[1] ?? '';
}

it('draws one focus ring, 1.5px wide and 1.5px out', () => {
  expect(ruleOf('.pt :where\\(:focus-visible\\)')).toBe(
    'outline:1.5px solid var(--focus-ring);outline-offset:1.5px',
  );
  const others = [...css.matchAll(/([^{}]*:focus[^{}]*)\{([^}]*)\}/g)].flatMap((m) =>
    [...m[2]!.matchAll(/outline:([\d.]+px)/g)]
      .filter((o) => o[1] !== '1.5px')
      .map((o) => `${m[1]!.trim()} ${o[1]}`),
  );
  expect(others).toEqual([]);
});

it('has the 20px and 32px spacing steps and a 16px icon size', () => {
  const scale = tokenValues(/^:root\s*\{[^}]*--fs-xs:[^}]*\}/m.exec(css)?.[0] ?? '');
  expect(scale['--sp-5']).toBe('20px');
  expect(scale['--sp-8']).toBe('32px');
  expect(scale['--icon']).toBe('16px');
});

it('sets buttons in the 13px interface size at weight 500', () => {
  const btn = ruleOf('.btn');
  expect(btn).toContain('font-size:var(--fs-sm)');
  expect(btn).toContain('font-weight:500');
  expect(btn).toContain('padding:0 10px');
  expect(ruleOf('.btn:active')).toBe('transform:scale(.97)');
});

it('draws a 28px input with a hairline edge on the surface', () => {
  const scale = tokenValues(/^:root\s*\{[^}]*--fs-xs:[^}]*\}/m.exec(css)?.[0] ?? '');
  expect(scale['--ctl']).toBe('28px');
  const inp = ruleOf('.inp');
  expect(inp).toContain('height:var(--ctl)');
  expect(inp).toContain('border:var(--hair) solid var(--bd)');
  expect(inp).toContain('background:var(--sf)');
});

it('turns a switch on in the ink colour, not a status colour', () => {
  expect(css).toMatch(/^\.ps-sw:checked\{background:var\(--ink\);border-color:var\(--ink\)\}/m);
  expect(css).toMatch(/^\.ps-sw:checked::after\{[^}]*border-color:var\(--ink\)/m);
});

it('dots each status chip in the colour of its own status', () => {
  const dots = [...css.matchAll(/\.tr-st\.(\w+)\{--dot:var\((--[\w-]+)\)\}/g)].map((m) => [
    m[1],
    m[2],
  ]);
  expect(dots.map(([state]) => state)).toContain('run');
  expect(dots).toEqual(dots.map(([state]) => [state, `--${state}`]));
});

it('swaps status, edge and diff colours for blue and orange in the colour-blind palette', () => {
  const rule = /^\.pt\[data-palette=colorblind\]\{([^}]*)\}/m.exec(css)?.[1] ?? '';
  for (const [token, from] of [
    ['--run', '--cb-run'],
    ['--wait', '--cb-wait'],
    ['--ok', '--cb-ok'],
    ['--bad', '--cb-bad'],
    ['--e-done', '--cb-ok'],
    ['--e-act', '--cb-run'],
  ])
    expect(rule).toContain(`${token}:var(${from})`);
  const hue = (hex: string) => {
    const [r, g, b] = rgb(hex).map((c) => c / 255) as [number, number, number];
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  for (const [theme, t] of themes) {
    const cb = ['--cb-run', '--cb-wait', '--cb-ok', '--cb-bad'].map((k) => t[k]!);
    expect(new Set(cb).size, theme).toBe(4);
    expect(hue(t['--cb-ok']!), `${theme} added`).toBeGreaterThan(195);
    expect(hue(t['--cb-ok']!), `${theme} added`).toBeLessThan(235);
    expect(hue(t['--cb-bad']!), `${theme} removed`).toBeGreaterThan(15);
    expect(hue(t['--cb-bad']!), `${theme} removed`).toBeLessThan(40);
    for (const k of ['--cb-run', '--cb-wait', '--cb-ok', '--cb-bad'])
      expect(contrast(t[k]!, t['--sf']!), `${theme} ${k}`).toBeGreaterThanOrEqual(4.5);
  }
});
