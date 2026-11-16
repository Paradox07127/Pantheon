import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../apps/web/src/${path}`, import.meta.url)), 'utf8');
const css = source('index.css');

type Rgb = [number, number, number];

// The theme token block is the one that sets color-scheme.
function tokens(selector: string): Map<string, string> {
  const block = css.match(new RegExp(`^${selector}\\s*\\{[^}]*color-scheme[^}]*\\}`, 'm'));
  if (!block) throw new Error(`no token block for ${selector}`);
  return new Map(
    [...block[0].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]),
  );
}

function resolve(theme: Map<string, string>, value: string): Rgb {
  const ref = value.match(/^var\((--[\w-]+)\)$/);
  if (ref) return token(theme, ref[1]!);
  const hex = value.match(/^#([0-9a-fA-F]{6})$/);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)) as Rgb;
  const mixed = value.match(/^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*(.+)\)$/);
  if (mixed) return mix(resolve(theme, mixed[1]!), resolve(theme, mixed[3]!), +mixed[2]! / 100);
  throw new Error(`cannot resolve colour ${value}`);
}

function token(theme: Map<string, string>, name: string): Rgb {
  const value = theme.get(name);
  if (value === undefined) throw new Error(`${name} is not defined`);
  return resolve(theme, value);
}

function mix(a: Rgb, b: Rgb, share: number): Rgb {
  return a.map((v, i) => v * share + b[i]! * (1 - share)) as Rgb;
}

// WCAG 2 relative luminance of an sRGB colour.
function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function distance(a: Rgb, b: Rgb): number {
  return Math.hypot(...a.map((v, i) => v - b[i]!));
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const themes = [
  { name: 'light', theme: tokens(':root'), statusShare: 0.1 },
  { name: 'dark', theme: tokens('\\.dark'), statusShare: 0.16 },
];

const textTokens = ['--tx', '--tx2', '--mu'];
const statusTokens = [
  '--run',
  '--wait',
  '--ready',
  '--ok',
  '--bad',
  '--idle',
  '--rt-claude',
  '--rt-codex',
  '--rt-agy',
  '--rt-grok',
  '--chg',
];
const seriesTokens = [1, 2, 3, 4, 5, 6].map((n) => `--series-${n}`);

function below(pairs: [string, Rgb, string, Rgb][], min: number): string[] {
  return pairs
    .map(([fg, a, bg, b]) => ({ pair: `${fg} on ${bg}`, ratio: contrast(a, b) }))
    .filter(({ ratio }) => ratio < min)
    .map(({ pair, ratio }) => `${pair}: ${ratio.toFixed(2)}`);
}

describe.each(themes)('$name theme contrast', ({ theme, statusShare }) => {
  it('keeps body, secondary and muted text at 4.5:1 on every surface', () => {
    const pairs = textTokens.flatMap((fg) =>
      ['--bg', '--sf', '--sf2'].map(
        (bg) => [fg, token(theme, fg), bg, token(theme, bg)] as [string, Rgb, string, Rgb],
      ),
    );
    expect(below(pairs, 4.5)).toEqual([]);
  });

  it('keeps status and runtime colours readable as text on panels, wells and their own tint', () => {
    const pairs = statusTokens.flatMap((fg) => {
      const colour = token(theme, fg);
      const tint = mix(colour, token(theme, '--sf'), statusShare);
      return [
        [fg, colour, '--sf', token(theme, '--sf')],
        [fg, colour, '--sf2', token(theme, '--sf2')],
        [fg, colour, `its ${statusShare * 100}% tint`, tint],
      ] as [string, Rgb, string, Rgb][];
    });
    expect(below(pairs, 4.5)).toEqual([]);
  });

  it('keeps chart series colours at 3:1 on panels', () => {
    const pairs = seriesTokens.map(
      (fg) => [fg, token(theme, fg), '--sf', token(theme, '--sf')] as [string, Rgb, string, Rgb],
    );
    expect(below(pairs, 3)).toEqual([]);
  });

  it('keeps an empty track, such as an off switch or an unfilled meter, at 3:1 on panels', () => {
    expect(below([['--track', token(theme, '--track'), '--sf', token(theme, '--sf')]], 3)).toEqual(
      [],
    );
  });

  it('keeps a grey fill apart from the empty track it is drawn on', () => {
    // Status hues separate from the grey track by hue; grey fills only by lightness.
    const fill = (sheet: string, rule: string) => {
      const body = source(sheet).match(new RegExp(`^${rule} \\{([^}]*)\\}`, 'm'))?.[1] ?? '';
      return /background:\s*([^;]+);/.exec(body)?.[1]?.trim() ?? `no background in ${rule}`;
    };
    const meter = css.match(/^\.meter>i\{[^}]*background:var\(--c,(var\(--[\w-]+\))\)/m)?.[1];
    const pairs: [string, string][] = [
      [meter ?? 'no meter fill', 'var(--track)'],
      ...[
        ['screens/sessions/header.css', ".sh-seg > i\\[data-tone='skip'\\]", 'none'],
        ['screens/sessions/panel.css', ".ss-pseg > i\\[data-tone='idle'\\]", 'none'],
      ].map(
        ([sheet, rule, empty]) =>
          [fill(sheet!, rule!), fill(sheet!, rule!.replace(/'\w+'/, `'${empty}'`))] as [
            string,
            string,
          ],
      ),
    ];
    expect(
      below(
        pairs.map(([fg, bg]) => [fg, resolve(theme, fg), bg, resolve(theme, bg)]),
        2,
      ),
    ).toEqual([]);
  });

  it('keeps each runtime colour apart from the others and from the muted colour', () => {
    const names = ['--rt-claude', '--rt-codex', '--rt-agy', '--rt-grok', '--mu'];
    const near = names.flatMap((a, i) =>
      names
        .slice(i + 1)
        .filter((b) => distance(token(theme, a), token(theme, b)) < 60)
        .map((b) => `${a} near ${b}`),
    );
    expect(near).toEqual([]);
  });

  it('keeps the project monogram letter at 4.5:1 on each of the six series colours', () => {
    const rule = css.match(/^\.pmono\{[^}]*\}/m)?.[0] ?? '';
    const letter = /[{;]color:([^;}]+)/.exec(rule)?.[1] ?? '';
    // Without a background of its own the monogram shows its series colour as given.
    const fill = /[{;]background:([^;}]+)/.exec(rule)?.[1] ?? 'var(--pmono)';
    const pairs = seriesTokens.map(
      (series) =>
        [
          letter,
          resolve(theme, letter),
          series,
          resolve(theme, fill.replace('var(--pmono)', `var(${series})`)),
        ] as [string, Rgb, string, Rgb],
    );
    expect(below(pairs, 4.5)).toEqual([]);
  });
});

describe('primary button', () => {
  it('fills with the ink in both themes, its text readable', () => {
    expect(css).not.toMatch(/^\.dark \.btn\.pri/m);
    const rule = css.match(/^\.btn\.pri\{([^}]*)\}/m);
    expect(rule?.[1]).toContain('background:var(--ink)');
    expect(rule?.[1]).toContain('color:var(--on-ink)');
    for (const { name, theme } of themes)
      expect(
        contrast(token(theme, '--on-ink'), token(theme, '--ink')),
        name,
      ).toBeGreaterThanOrEqual(4.5);
  });
});
