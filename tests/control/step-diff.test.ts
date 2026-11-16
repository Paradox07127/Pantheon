import { expect, it } from 'vitest';
import { stepFiles } from '../../packages/control/dist/step-diff.js';

it('gives a multi-edit file one file section that holds every edit', () => {
  const [file] = stepFiles('MultiEdit', {
    file_path: 'src/app.ts',
    edits: [
      { old_string: 'a\n', new_string: 'b\n' },
      { old_string: 'c\n', new_string: 'd\n' },
    ],
  });
  expect(file?.patch?.match(/^diff --git /gm)).toHaveLength(1);
  expect(file?.patch).toBe(
    'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n' +
      '@@ -1,1 +1,1 @@\n-a\n+b\n@@ -1,1 +1,1 @@\n-c\n+d\n',
  );
});
