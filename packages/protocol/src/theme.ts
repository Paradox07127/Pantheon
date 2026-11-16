import { z } from 'zod';

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const roles = z.strictObject({
  accent: hex.optional(),
  danger: hex.optional(),
  success: hex.optional(),
  warning: hex.optional(),
  review: hex.optional(),
});
const mode = z.strictObject({
  anchors: z.strictObject({
    'surface-0': hex,
    'text-primary': hex,
    'surface-1': hex.optional(),
    'surface-2': hex.optional(),
    'surface-3': hex.optional(),
    'text-secondary': hex.optional(),
    'text-muted': hex.optional(),
  }),
  roles: roles.optional(),
});

export const themeInputSchema = z
  .strictObject({
    label: z.string().min(1).max(40),
    light: mode.optional(),
    dark: mode.optional(),
    roles: roles.optional(),
    backdrop: z
      .strictObject({
        svg: z.string().min(1).max(131072),
        glass: z
          .union([
            z.strictObject({
              blur: z.number().min(0).max(40),
              tint: hex,
              opacity: z.number().min(0).max(1),
            }),
            z.literal(false),
          ])
          .optional(),
      })
      .optional(),
  })
  .refine((input) => input.light !== undefined || input.dark !== undefined, {
    message: 'give a light mode, a dark mode or both',
  });

export type ThemeInput = z.infer<typeof themeInputSchema>;
type ThemeMode = z.infer<typeof mode>;
type ThemeRoles = z.infer<typeof roles>;
export type ThemeModes = { light?: Record<string, string>; dark?: Record<string, string> };

type Rgb = [number, number, number];

const white: Rgb = [255, 255, 255];

function parse(value: string): Rgb {
  return [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16)) as Rgb;
}

function toHex(rgb: Rgb): string {
  return `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

function rgba(rgb: Rgb, alpha: number): string {
  return `rgba(${rgb.join(',')},${alpha})`;
}

/** `amount` of `b` into `a`, per channel on gamma-encoded sRGB, as CSS `color-mix(in srgb, b amount, a)`. */
function mix(a: Rgb, b: Rgb, amount: number): Rgb {
  return a.map((c, i) => Math.round(c + (b[i]! - c) * amount)) as Rgb;
}

/** The next surface up: each sRGB channel raised by 0.04 of full scale, capped at white. */
function lighter(rgb: Rgb): Rgb {
  return rgb.map((c) => Math.min(255, Math.round(c + 0.04 * 255))) as Rgb;
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const borderAlphas: Record<string, number> = {
  '--bd': 0.14,
  '--bd2': 0.08,
  '--bd3': 0.3,
  '--bd-hover': 0.3,
  '--sel': 0.07,
  '--ac-bg': 0.07,
  '--bd-ov': 0.12,
  '--bd-top': 0.07,
  '--glass-bd': 0.12,
  '--dot': 0.11,
};

const roleTokens: Record<keyof ThemeRoles, string[]> = {
  accent: ['--run', '--e-act', '--series-1'],
  danger: ['--bad', '--del'],
  success: ['--ok', '--add', '--e-done'],
  warning: ['--wait', '--chk'],
  review: ['--ready', '--series-4'],
};

function deriveMode(
  name: 'light' | 'dark',
  given: ThemeMode,
  shared: ThemeRoles | undefined,
  blocking: string[],
  warnings: string[],
): Record<string, string> {
  const a = given.anchors;
  const s0 = parse(a['surface-0']);
  const s1 = a['surface-1'] ? parse(a['surface-1']) : lighter(s0);
  const s2 = a['surface-2'] ? parse(a['surface-2']) : lighter(s1);
  const s3 = a['surface-3'] ? parse(a['surface-3']) : lighter(s2);
  const tp = parse(a['text-primary']);
  const tx2 = a['text-secondary'] ? parse(a['text-secondary']) : mix(tp, s1, 0.25);
  const muted = a['text-muted'] ? parse(a['text-muted']) : mix(tp, s1, 0.45);
  const merged: ThemeRoles = { ...shared, ...given.roles };
  const ink = merged.accent ? parse(merged.accent) : tp;
  const onInk = contrast(white, ink) >= contrast(s0, ink) ? white : s0;
  const between = toHex(mix(s2, s3, 0.5));

  const table: Record<string, string> = {
    '--bg': toHex(s0),
    '--rail': toHex(s0),
    '--sf': toHex(s1),
    '--sf2': toHex(s2),
    '--ov': rgba(s3, 0.86),
    '--band': between,
    '--code': between,
    '--glass': between,
    '--track': between,
    '--glass-2': toHex(s1),
    '--tx': toHex(tp),
    '--tx2': toHex(tx2),
    '--mu': toHex(muted),
    '--faint': toHex(mix(tp, s1, 0.65)),
  };
  for (const [token, alpha] of Object.entries(borderAlphas)) table[token] = rgba(tp, alpha);
  for (const token of ['--ink', '--ac', '--ac2', '--focus-ring']) table[token] = toHex(ink);
  table['--on-ink'] = toHex(onInk);
  for (const role of Object.keys(roleTokens) as (keyof ThemeRoles)[]) {
    const value = merged[role];
    if (value) for (const token of roleTokens[role]) table[token] = toHex(parse(value));
  }
  for (const token of ['--idle', '--unk', '--e-str']) table[token] = toHex(muted);
  table['--e-pend'] = toHex(mix(muted, s1, 0.4));
  table['color-scheme'] = name;

  const measure = (
    fg: string,
    fgRgb: Rgb,
    bg: string,
    bgRgb: Rgb,
    block: number,
    warn?: number,
  ): void => {
    const ratio = contrast(fgRgb, bgRgb);
    const shown = (Math.floor(ratio * 10) / 10).toFixed(1);
    const say = (needs: number) => `${name}: ${fg} on ${bg} is ${shown}:1, needs ${needs}:1`;
    if (ratio < block) blocking.push(say(block));
    else if (warn !== undefined && ratio < warn) warnings.push(say(warn));
  };
  const surfaces: [string, Rgb][] = [
    ['surface-0', s0],
    ['surface-1', s1],
    ['surface-2', s2],
  ];
  for (const [bg, rgb] of surfaces) measure('text-primary', tp, bg, rgb, 4.5, 7);
  for (const [bg, rgb] of surfaces) measure('text-muted', muted, bg, rgb, 3, 4.5);
  measure('on-ink', onInk, 'ink', ink, 4.5);
  for (const role of Object.keys(roleTokens) as (keyof ThemeRoles)[]) {
    const value = merged[role];
    if (value) measure(role, parse(value), 'surface-1', s1, 3);
  }
  const order: [string, Rgb][] = [...surfaces, ['surface-3', s3]];
  for (let i = 1; i < order.length; i++) {
    if (luminance(order[i]![1]) < luminance(order[i - 1]![1]))
      warnings.push(`${name}: ${order[i]![0]} is darker than ${order[i - 1]![0]}`);
  }
  return table;
}

/** The tokens a theme overrides in each mode it gives, plus contrast problems; any blocking line means do not apply it. */
export function deriveTheme(input: ThemeInput): {
  modes: ThemeModes;
  blocking: string[];
  warnings: string[];
} {
  const blocking: string[] = [];
  const warnings: string[] = [];
  const modes: ThemeModes = {};
  if (input.light) modes.light = deriveMode('light', input.light, input.roles, blocking, warnings);
  if (input.dark) modes.dark = deriveMode('dark', input.dark, input.roles, blocking, warnings);
  return { modes, blocking, warnings };
}

const backdropLimit = 131072;

/** Problems that keep an SVG backdrop from being shown; empty means it runs no script and loads nothing. */
export function checkBackdrop(svg: string): string[] {
  const problems: string[] = [];
  if (!/^\s*(?:<\?xml[\s\S]*?\?>\s*)?<svg[\s>/]/.test(svg))
    problems.push('backdrop must start with <svg');
  if (svg.length > backdropLimit)
    problems.push(`backdrop is ${svg.length} characters, limit ${backdropLimit}`);
  for (const match of svg.matchAll(/<(script|foreignObject|iframe|image|!DOCTYPE|!ENTITY)\b/gi))
    problems.push(`backdrop contains <${match[1]}`);
  for (const match of svg.matchAll(/[\s"'/](on[a-z]+)\s*=/gi))
    problems.push(`backdrop has the event attribute ${match[1]}=`);
  for (const match of svg.matchAll(
    /\b((?:xlink:)?href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*))/gi,
  )) {
    const value = (match[2] ?? match[3] ?? match[4] ?? '').trim();
    if (!value.startsWith('#')) problems.push(`backdrop ${match[1]}="${value}" must start with #`);
  }
  for (const match of svg.matchAll(/url\(\s*["']?\s*([^)"'\s]*)/gi))
    if (!match[1]!.startsWith('#')) problems.push(`backdrop url(${match[1]}) must start with #`);
  if (/@import/i.test(svg)) problems.push('backdrop uses @import');
  // Escapes and character references can spell url( or a tag past the checks above.
  if (svg.includes('\\')) problems.push('backdrop contains a backslash escape');
  if (/&#/.test(svg)) problems.push('backdrop contains a numeric character reference');
  return problems;
}

/** CSS that applies `modes` while the root carries `data-user-theme="id"`. */
export function themeCss(id: string, modes: ThemeModes): string {
  if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new Error(`theme id "${id}" must match [a-z0-9-]{1,64}`);
  const block = (selector: string, table: Record<string, string>) =>
    `${selector}{${Object.entries(table)
      .map(([token, value]) => `${token}:${value};`)
      .join('')}}`;
  const root = `:root[data-user-theme="${id}"]`;
  const blocks: string[] = [];
  if (modes.light) blocks.push(block(`${root}:not(.dark)`, modes.light));
  if (modes.dark) blocks.push(block(`${root}.dark`, modes.dark));
  return blocks.join('\n');
}
