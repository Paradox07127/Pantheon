import { expect, it } from 'vitest';
import { kindOfPaths } from '../../packages/control/dist/task-kind.js';

it('calls a change only under the web app source frontend-ui', () => {
  expect(kindOfPaths(['apps/web/src/board.tsx'])?.domain).toBe('frontend-ui');
});

it('calls a change to scripts, workflows and root configuration script-infra', () => {
  expect(
    kindOfPaths(['scripts/api-doc.mjs', '.github/workflows/ci.yml', 'package.json'])?.domain,
  ).toBe('script-infra');
  expect(kindOfPaths(['.prettierrc', 'pnpm-workspace.yaml'])?.domain).toBe('script-infra');
});

it('calls a change only to markdown files docs-chore', () => {
  expect(kindOfPaths(['README.md', 'docs/api.md'])?.domain).toBe('docs-chore');
});

it('calls any other change backend-logic', () => {
  expect(kindOfPaths(['packages/control/src/index.ts', 'README.md'])?.domain).toBe('backend-logic');
  expect(kindOfPaths(['packages/web/package.json'])?.domain).toBe('backend-logic');
});

it.each([
  [
    'rates at most two files in one package t1',
    ['packages/control/src/a.ts', 'packages/control/src/b.ts'],
    't1',
  ],
  [
    'rates more than two files in one package t2',
    ['packages/control/src/a.ts', 'packages/control/src/b.ts', 'tests/control/a.test.ts'],
    't2',
  ],
  [
    'rates a change across packages t3',
    ['packages/control/src/a.ts', 'packages/protocol/src/index.ts', 'apps/daemon/src/index.ts'],
    't3',
  ],
])('%s', (_, paths, tier) => {
  expect(kindOfPaths(paths)?.tier).toBe(tier);
});

it('gives no kind to an empty change', () => {
  expect(kindOfPaths([])).toBeUndefined();
});

it('reads a path without a file extension as a directory of any number of files', () => {
  expect(kindOfPaths(['apps/web/src'])).toEqual({ domain: 'frontend-ui', tier: 't2' });
  expect(kindOfPaths(['scripts/'])).toEqual({ domain: 'script-infra', tier: 't2' });
  expect(kindOfPaths(['packages/control/src'])?.tier).toBe('t2');
  expect(kindOfPaths(['packages/control', 'packages/protocol'])?.tier).toBe('t3');
});
