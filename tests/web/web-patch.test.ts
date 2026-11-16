import { describe, expect, it } from 'vitest';
import { parsePatch } from '@/data/patch';

const patch = [
  'diff --git a/notes.txt b/notes.txt',
  'index 1111111..2222222 100644',
  '--- a/notes.txt',
  '+++ b/notes.txt',
  '@@ -1,3 +1,3 @@',
  ' line 1',
  '-line 2',
  '+changed 2',
  ' line 3',
  '@@ -16,3 +16,4 @@ section',
  ' line 16',
  '-line 17',
  '+changed 17',
  ' line 18',
  '+line 19',
  'diff --git a/added.txt b/added.txt',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/added.txt',
  '@@ -0,0 +1,2 @@',
  '+-- a dashed line',
  '+one',
  '\\ No newline at end of file',
  'diff --git a/logo.bin b/logo.bin',
  'index 4444444..5555555 100644',
  'Binary files a/logo.bin and b/logo.bin differ',
  'diff --git a/old name.txt b/new name.txt',
  'similarity index 90%',
  'rename from old name.txt',
  'rename to new name.txt',
  'index 6666666..7777777 100644',
  '--- a/old name.txt',
  '+++ b/new name.txt',
  '@@ -1,2 +1,2 @@',
  ' kept',
  '-before',
  '+after',
  'diff --git a/removed.txt b/removed.txt',
  'deleted file mode 100644',
  'index 8888888..0000000',
  '--- a/removed.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-gone',
  'diff --git "a/\\344\\270\\255.txt" "b/\\344\\270\\255.txt"',
  'similarity index 100%',
  'rename from "\\344\\270\\255.txt"',
  'rename to "\\346\\226\\207.txt"',
  '',
].join('\n');

describe('patch parsing', () => {
  const files = parsePatch(patch);

  it('splits files at diff headers and hunks at @@', () => {
    expect(files.map((f) => f.path)).toEqual([
      'notes.txt',
      'added.txt',
      'logo.bin',
      'new name.txt',
      'removed.txt',
      '文.txt',
    ]);
    expect(files[0]!.hunks.map((h) => h.header)).toEqual([
      '@@ -1,3 +1,3 @@',
      '@@ -16,3 +16,4 @@ section',
    ]);
    expect(files[0]!.hunks[1]!.lines).toEqual([
      { kind: 'ctx', text: 'line 16' },
      { kind: 'del', text: 'line 17' },
      { kind: 'add', text: 'changed 17' },
      { kind: 'ctx', text: 'line 18' },
      { kind: 'add', text: 'line 19' },
    ]);
  });

  it('keeps hunk lines that look like headers and marks the line the no-newline marker follows', () => {
    expect(files[1]!.hunks).toEqual([
      {
        header: '@@ -0,0 +1,2 @@',
        lines: [
          { kind: 'add', text: '-- a dashed line' },
          { kind: 'add', text: 'one', noNewline: true },
        ],
      },
    ]);
  });

  it('tells a change of only the final newline apart from identical lines', () => {
    const [file] = parsePatch(
      [
        'diff --git a/end.txt b/end.txt',
        '--- a/end.txt',
        '+++ b/end.txt',
        '@@ -1 +1 @@',
        '-last',
        '\\ No newline at end of file',
        '+last',
        '',
      ].join('\n'),
    );
    expect(file!.hunks[0]!.lines).toEqual([
      { kind: 'del', text: 'last', noNewline: true },
      { kind: 'add', text: 'last' },
    ]);
  });

  it('gives binary files and pure renames no hunks', () => {
    expect(files[2]!.hunks).toEqual([]);
    expect(files[5]!.hunks).toEqual([]);
  });

  it('names renamed files by their new path and deleted files by their old path', () => {
    expect(files[3]!.hunks[0]!.lines.map((l) => l.kind)).toEqual(['ctx', 'del', 'add']);
    expect(files[4]).toEqual({
      path: 'removed.txt',
      status: 'D',
      hunks: [{ header: '@@ -1 +0,0 @@', lines: [{ kind: 'del', text: 'gone' }] }],
    });
  });

  it.each([
    [
      'names a file by a quoted new path after an unquoted old path',
      'diff --git a/plain.bin "b/with space.bin"',
      'with space.bin',
    ],
    [
      'ends a quoted old path at its closing quote, not at an escaped quote before a space',
      'diff --git "a/say \\"hi\\" now\\t.bin" b/plain.bin',
      'plain.bin',
    ],
  ])('%s', (_name, header, path) => {
    expect(parsePatch([header, 'Binary files differ', ''].join('\n')).map((f) => f.path)).toEqual([
      path,
    ]);
  });

  it('keeps trailing spaces in names and drops the tab git puts after names with a space', () => {
    const named = parsePatch(
      [
        'diff --git a/trailing  b/trailing ',
        'index 1111111..2222222 100644',
        '--- a/trailing \t',
        '+++ b/trailing \t',
        '@@ -1 +1 @@',
        '-x',
        '+y',
        'diff --git a/gone file b/gone file',
        'deleted file mode 100644',
        'index 3333333..0000000',
        '--- a/gone file\t',
        '+++ /dev/null\t',
        '@@ -1 +0,0 @@',
        '-g',
        '',
      ].join('\n'),
    );
    expect(named.map((f) => [f.path, f.status])).toEqual([
      ['trailing ', undefined],
      ['gone file', 'D'],
    ]);
  });

  it.each([
    [
      'decodes a quoted name holding characters outside the basic plane',
      [
        'diff --git a/old.txt "b/\u{1F600}\\t.txt"',
        'similarity index 100%',
        'rename from old.txt',
        'rename to "\u{1F600}\\t.txt"',
      ],
      '\u{1F600}\t.txt',
    ],
    [
      'keeps a quoted path that ends in a lone backslash as written',
      ['diff --git a/x b/x', 'similarity index 100%', 'rename to "broken\\"'],
      '"broken\\"',
    ],
  ])('%s', (_name, lines, path) => {
    const [file] = parsePatch([...lines, ''].join('\n'));
    expect(file!.path).toBe(path);
  });

  it('names an empty added file whose directory ends in " b"', () => {
    const [file] = parsePatch(
      [
        'diff --git a/dir b/empty b/dir b/empty',
        'new file mode 100644',
        'index 0000000..e69de29',
        '',
      ].join('\n'),
    );
    expect(file).toEqual({ path: 'dir b/empty', status: 'A', hunks: [] });
  });

  it('returns no files for an empty patch', () => {
    expect(parsePatch('')).toEqual([]);
  });
});
