import { expect, it } from 'vitest';
import path from 'node:path';
import {
  injectSourceLocations,
  sourceLocations,
} from '../../apps/desktop/src/build/source-locations.js';

const repoRoot = path.resolve('/repo');
const webFile = path.join(repoRoot, 'apps/web/src/views/panel.tsx');
const inject = (code: string, id = webFile) => injectSourceLocations(code, id, repoRoot)?.code;
const locations = (code: string) =>
  [...(inject(code) ?? '').matchAll(/<(\w+) data-pt-src="([^"]+)"/g)].map(
    ([, tag, location]) => `${tag} ${location}`,
  );

it.each([
  ['a single element', 'const a = <div />;', ['div apps/web/src/views/panel.tsx:1:11']],
  [
    'elements across lines',
    [
      'export function Panel() {',
      '  return (',
      '    <section className="panel">',
      '      <button type="button">Go</button>',
      '    </section>',
      '  );',
      '}',
    ].join('\n'),
    ['section apps/web/src/views/panel.tsx:3:5', 'button apps/web/src/views/panel.tsx:4:7'],
  ],
  [
    'an element inside a map callback',
    [
      'const list = (items: string[]) => (',
      '  <ul>',
      '    {items.map((item) => (',
      '        <li key={item}>{item}</li>',
      '    ))}',
      '  </ul>',
      ');',
    ].join('\n'),
    ['ul apps/web/src/views/panel.tsx:2:3', 'li apps/web/src/views/panel.tsx:4:9'],
  ],
  [
    'an element after non-ASCII text',
    "const label = '中文';\nconst a = <svg><path d='M0 0' /></svg>;",
    ['svg apps/web/src/views/panel.tsx:2:11', 'path apps/web/src/views/panel.tsx:2:16'],
  ],
])('marks host elements with their source location: %s', (_, code, expected) => {
  expect(locations(code)).toEqual(expected);
});

it.each([
  ['a component', 'const a = <Panel title="x" />;'],
  ['a member expression', 'const a = <Menu.Item />;'],
  ['a short fragment', 'const a = <></>;'],
  ['a named fragment', 'const a = <Fragment></Fragment>;'],
  ['an element that already has a location', 'const a = <div data-pt-src="elsewhere:1:1" />;'],
])('leaves %s alone', (_, code) => {
  expect(injectSourceLocations(code, webFile, repoRoot)).toBeNull();
});

it('marks host children of a component but not the component', () => {
  expect(locations('const a = <Panel><span /></Panel>;')).toEqual([
    'span apps/web/src/views/panel.tsx:1:18',
  ]);
  expect(inject('const a = <Panel><span /></Panel>;')).toContain('<Panel>');
});

it.each([
  ['outside the web sources', path.join(repoRoot, 'apps/desktop/src/main/window.tsx')],
  ['under node_modules', path.join(repoRoot, 'apps/web/src/node_modules/lib/index.tsx')],
  ['not a tsx file', path.join(repoRoot, 'apps/web/src/views/panel.ts')],
])('skips a file %s', (_, id) => {
  expect(injectSourceLocations('const a = <div />;', id, repoRoot)).toBeNull();
});

it('reads the path from an id that carries a query', () => {
  expect(inject('const a = <div />;', `${webFile}?v=1`)).toContain(
    'data-pt-src="apps/web/src/views/panel.tsx:1:11"',
  );
});

it('parses TypeScript syntax', () => {
  const code = [
    "import type { ReactNode } from 'react';",
    'const identity = <T,>(value: T): T => value;',
    'const options = { size: 2 } satisfies Record<string, number>;',
    'export const View = (props: { children: ReactNode }) => (',
    '  <main>{props.children as ReactNode}</main>',
    ');',
  ].join('\n');
  expect(locations(code)).toEqual(['main apps/web/src/views/panel.tsx:5:3']);
});

it('returns a source map for the rewritten code', () => {
  const result = injectSourceLocations('const a = <div />;', webFile, repoRoot)!;
  expect(result.map.sources).toEqual([webFile]);
  expect(result.map.mappings).not.toBe('');
});

it('runs only in the dev server, before the React transform', () => {
  const plugin = sourceLocations(repoRoot);
  expect(plugin.apply).toBe('serve');
  expect(plugin.enforce).toBe('pre');
});
