import { describe, expect, it } from 'vitest';
import { codePath, linkTarget } from '../../apps/web/src/components/markdownLinks.js';

describe('linkTarget', () => {
  const file = (path: string, line?: number, column?: number) => ({
    kind: 'file',
    ref: { path, ...(line && { line }), ...(column && { column }) },
  });
  it.each<[string, [string, unknown][]]>([
    [
      'treats http, https and mailto links as web links',
      [
        ['https://example.com/a', { kind: 'web', url: 'https://example.com/a' }],
        ['http://example.com', { kind: 'web', url: 'http://example.com' }],
        ['mailto:a@example.com', { kind: 'web', url: 'mailto:a@example.com' }],
      ],
    ],
    [
      'treats paths and file URLs as files',
      [
        ['src/a.ts', file('src/a.ts')],
        ['/abs/a.ts', file('/abs/a.ts')],
        ['file:///abs/a.ts', file('file:///abs/a.ts')],
      ],
    ],
    [
      'writes the file scheme in lower case, as the desktop resolver reads it',
      [['FILE:///abs/a.ts:3', file('file:///abs/a.ts', 3)]],
    ],
    [
      'reads the line and column at the end of a file link',
      [
        ['src/a.ts:42', file('src/a.ts', 42)],
        ['src/a.ts:42:7', file('src/a.ts', 42, 7)],
        ['src/a.ts#L42', file('src/a.ts', 42)],
        ['src/a.ts#L42C3', file('src/a.ts', 42, 3)],
        ['a.ts:12', file('a.ts', 12)],
      ],
    ],
  ])('%s', (_, cases) => {
    for (const [href, target] of cases) expect(linkTarget(href), href).toEqual(target);
  });

  it('ignores anchors, empty links and other protocols', () => {
    for (const href of ['', '#section', 'javascript:alert(1)', 'vscode://file/a', 'smb://h/s'])
      expect(linkTarget(href)).toBeNull();
  });
});

describe('codePath', () => {
  it('recognizes paths in inline code', () => {
    expect(codePath('apps/web/src/index.css')).toEqual({ path: 'apps/web/src/index.css' });
    expect(codePath('src/foo.ts:42')).toEqual({ path: 'src/foo.ts', line: 42 });
    expect(codePath('/abs/a.ts:3:7')).toEqual({ path: '/abs/a.ts', line: 3, column: 7 });
    expect(codePath('foo.ts:12')).toEqual({ path: 'foo.ts', line: 12 });
  });

  it('leaves code that is not a path alone', () => {
    for (const text of ['bridge.query', 'index.css', 'npm test', 'https://example.com/a', ''])
      expect(codePath(text)).toBeNull();
  });
});
