import { describe, expect, it } from 'vitest';
import type { LandingDiff } from '@pantheon/protocol';
import { landingPatch } from '@/data/repo';
import { parsePatch } from '@/data/patch';

const diff = (path: string, status: string, old_path?: string): LandingDiff =>
  ({
    truncated: false,
    files: [{ path, status, additions: 1, deletions: 0, ...(old_path ? { old_path } : {}) }],
    hunks: [{ file: path, header: '@@ -0,0 +1 @@', text: '+one' }],
  }) as unknown as LandingDiff;

describe('landing patch text', () => {
  it.each([
    ['a newline', 'odd\nname.ts'],
    ['a trailing tab', 'odd name.ts\t'],
    ['a quote and a backslash', 'say "hi"\\.ts'],
  ])('keeps a file name holding %s one file with its hunk', (_what, path) => {
    for (const status of ['modified', 'added', 'deleted'])
      expect(parsePatch(landingPatch(diff(path, status))!)).toEqual([
        expect.objectContaining({
          path,
          hunks: [{ header: '@@ -0,0 +1 @@', lines: [{ kind: 'add', text: 'one' }] }],
        }),
      ]);
  });

  it('keeps a renamed file with an odd name under its new name', () => {
    const files = parsePatch(landingPatch(diff('new\nname.ts', 'renamed', 'old\tname.ts'))!);
    expect(files.map((f) => f.path)).toEqual(['new\nname.ts']);
  });

  it('writes plain names as they are', () => {
    expect(landingPatch(diff('src/app.ts', 'modified'))).toBe(
      'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -0,0 +1 @@\n+one\n',
    );
  });
});
