import { expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../../apps/web/src', import.meta.url));
const glyphs = /[▾▸✓✗✕×⋯⏱–]|🖼|📄|📎/u;

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(full);
    return entry.name.endsWith('.tsx') ? [full] : [];
  });
}

it('draws icons with lucide instead of text glyphs', () => {
  const found: string[] = [];
  for (const file of tsxFiles(src)) {
    // Comments are blanked line for line so the reported line numbers stay right.
    const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, (c) =>
      c.replace(/[^\n]/g, ''),
    );
    code.split('\n').forEach((line, i) => {
      if (glyphs.test(line)) found.push(`${path.relative(src, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  expect(found).toEqual([]);
});
