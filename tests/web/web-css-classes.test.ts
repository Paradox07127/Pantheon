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

it('defines each top-level class rule once across the stylesheets', () => {
  const rules = new Map<string, string[]>();
  for (const file of cssFiles(src))
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const name = /^(\.[\w-]+)\s*\{/.exec(line)?.[1];
        if (!name) return;
        rules.set(name, [...(rules.get(name) ?? []), `${path.relative(src, file)}:${i + 1}`]);
      });
  expect([...rules].filter(([, at]) => at.length > 1)).toEqual([]);
});

it('keeps :has() off the root and body, where any change in the page would restyle all of it', () => {
  const rooted = cssFiles(src).flatMap((file) =>
    [
      ...readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .matchAll(/([^{}]+)\{/g),
    ]
      .flatMap(([, list]) => list!.split(/,(?![^(]*\))/))
      .map((selector) => selector.trim())
      .filter((selector) => /^(:root|html|body)\b[^,]*:has\(/.test(selector))
      .map((selector) => `${path.relative(src, file)}: ${selector}`),
  );
  expect(rooted).toEqual([]);
});

it('never reuses a top-level class of another stylesheet as a modifier', () => {
  // A top-level `.x` rule also styles every `.y.x` element: modifiers need names of their own.
  const sheets = cssFiles(src).map(
    (file) => [path.relative(src, file), readFileSync(file, 'utf8')] as const,
  );
  const topLevel = new Map<string, Set<string>>();
  for (const [file, text] of sheets)
    for (const [, name] of text.matchAll(/^(\.[\w-]+)\s*[{,]/gm))
      topLevel.set(name!, (topLevel.get(name!) ?? new Set()).add(file!));
  const reused = sheets.flatMap(([file, text]) =>
    [...text.matchAll(/\.[\w-]+((?:\.[\w-]+)+)/g)].flatMap((m) =>
      m[1]!
        .split(/(?=\.)/)
        .filter((modifier) => [...(topLevel.get(modifier) ?? [])].some((at) => at !== file))
        .map((modifier) => `${file}: ${m[0]} reuses ${modifier}`),
    ),
  );
  expect(reused).toEqual([]);
});

it("never names a class in one screen's stylesheet that another screen styles at top level", () => {
  // Every screen's sheet loads app-wide, so a nested `.x` of one screen also gets the other screen's `.x` rule.
  const screens = path.join(src, 'screens');
  const sheets = cssFiles(screens).map(
    (file) =>
      [
        path.relative(screens, file).split(path.sep)[0]!,
        path.relative(src, file),
        readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''),
      ] as const,
  );
  const topLevel = new Map<string, Set<string>>();
  for (const [screen, , text] of sheets)
    for (const [, name] of text.matchAll(/^(\.[\w-]+)\s*[{,]/gm))
      topLevel.set(name!, (topLevel.get(name!) ?? new Set()).add(screen!));
  const shared = sheets.flatMap(([screen, file, text]) =>
    [...text.matchAll(/([^{}]+)\{/g)].flatMap(([, selector]) =>
      [...selector!.matchAll(/\.[\w-]+/g)]
        .filter(([name]) => [...(topLevel.get(name) ?? [])].some((other) => other !== screen))
        .map(([name]) => `${file}: ${selector!.trim()} names ${name}`),
    ),
  );
  expect(shared).toEqual([]);
});
