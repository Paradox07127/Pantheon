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

// Tailwind's own variables, the ones Base UI sets on its parts at run time, the bar share
// components set inline, and the title bar's ends the shell sets.
const runtime = [
  /^--tw-/,
  /^--v$/,
  /^--main-x$/,
  /^--transform-origin$/,
  /^--anchor-width$/,
  /^--available-height$/,
  /^--available-width$/,
  /^--collapsible-panel-height$/,
  /^--active-tab-/,
];

it('defines in a source stylesheet every variable a stylesheet reads', () => {
  const defined = new Set(
    sheets.flatMap(({ css }) => [...css.matchAll(/(?:^|[{;\s])(--[\w-]+)\s*:/g)].map((m) => m[1])),
  );
  const missing = sheets.flatMap(({ name, css }) =>
    [...css.matchAll(/var\(\s*(--[\w-]+)/g)]
      .map((m) => m[1]!)
      .filter((v) => !defined.has(v) && !runtime.some((allowed) => allowed.test(v)))
      .map((variable) => `${name} reads ${variable}`),
  );
  expect([...new Set(missing)]).toEqual([]);
});
