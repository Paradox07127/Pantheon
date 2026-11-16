import { expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../../apps/web/src', import.meta.url));
const sheets = readdirSync(src, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.css'))
  .map((file) => ({ file, css: readFileSync(path.join(src, file), 'utf8') }));

const rules = sheets.flatMap(({ file, css }) =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    file,
    selector: m[1]!.trim().replace(/\s+/g, ' '),
    body: m[2]!.replace(/\s/g, ''),
  })),
);

it('gives the hand cursor only to a link in content', () => {
  expect(
    rules.filter((rule) => rule.body.includes('cursor:pointer')).map((rule) => rule.selector),
  ).toEqual(['.md .md-path']);
});

it('keeps images and links from being dragged out of the window', () => {
  expect(rules.find((rule) => rule.body.includes('-webkit-user-drag:none'))?.selector).toBe(
    '.pt :is(img,a):not([draggable=true])',
  );
});
