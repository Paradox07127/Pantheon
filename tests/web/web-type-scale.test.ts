import { expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../../apps/web/src', import.meta.url));

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(full);
    return entry.name.endsWith('.css') ? [full] : [];
  });
}

const sheets = cssFiles(src).map((file) => ({
  name: path.relative(src, file),
  css: readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''),
}));

function declarations(property: string): { name: string; value: string }[] {
  const pattern = new RegExp(`(?<![\\w-])${property}\\s*:\\s*([^;}]+)`, 'g');
  return sheets.flatMap(({ name, css }) =>
    [...css.matchAll(pattern)].map((m) => ({ name, value: m[1]!.trim() })),
  );
}

it('sets every font size from the type scale tokens', () => {
  const offScale = declarations('font-size')
    .filter(({ value }) => !/^(var\(--fs-(xs|sm|md|lg|xl)\)|inherit)$/.test(value))
    .map(({ name, value }) => `${name}: font-size:${value}`);
  expect(offScale).toEqual([]);
});

it('sizes every font shorthand from the type scale tokens or inherits', () => {
  const offScale = declarations('font')
    .filter(({ value }) => value !== 'inherit' && !/var\(--fs-(xs|sm|md|lg|xl)\)/.test(value))
    .map(({ name, value }) => `${name}: font:${value}`);
  expect(offScale).toEqual([]);
});

it('leaves no pixel font size below 12px', () => {
  const tiny = [...declarations('font-size'), ...declarations('font')]
    .filter(({ value }) => [...value.matchAll(/(\d+(?:\.\d+)?)px/g)].some((m) => Number(m[1]) < 12))
    .map(({ name, value }) => `${name}: ${value}`);
  expect(tiny).toEqual([]);
});
