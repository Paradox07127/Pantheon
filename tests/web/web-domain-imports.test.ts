import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The root entry of @pantheon/domain imports node:crypto; the vite dev server throws on it and the window stays blank.
describe('web imports from the domain package', () => {
  it('takes only types from the root entry', () => {
    const valueImports = globSync('apps/web/src/**/*.{ts,tsx}').flatMap((file) =>
      [
        ...readFileSync(file, 'utf8').matchAll(
          /import\s+(?!type\s)[^;]*?from\s+'@pantheon\/domain'/g,
        ),
      ].map((m) => `${file}: ${m[0].replace(/\s+/g, ' ')}`),
    );
    expect(valueImports).toEqual([]);
  });
});
