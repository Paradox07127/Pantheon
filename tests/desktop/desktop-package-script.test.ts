import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
  buildCache,
  nodeTarball,
  nodeUrl,
  parseShasums,
  pruneDeploy,
} from '../../scripts/package-desktop.mjs';

it('names the Node tarball of each target and its nodejs.org URL', () => {
  expect(nodeTarball('26.13.0', 'darwin-arm64')).toBe('node-v26.13.0-darwin-arm64.tar.xz');
  expect(nodeTarball('26.13.0', 'linux-x64')).toBe('node-v26.13.0-linux-x64.tar.xz');
  expect(nodeTarball('26.13.0', 'linux-arm64')).toBe('node-v26.13.0-linux-arm64.tar.xz');
  expect(nodeUrl('26.13.0', nodeTarball('26.13.0', 'darwin-arm64'))).toBe(
    'https://nodejs.org/dist/v26.13.0/node-v26.13.0-darwin-arm64.tar.xz',
  );
  expect(nodeUrl('26.13.0', 'SHASUMS256.txt')).toBe(
    'https://nodejs.org/dist/v26.13.0/SHASUMS256.txt',
  );
});

it('keeps the build cache in Library/Caches on macOS and in the XDG cache folder elsewhere', () => {
  expect(buildCache('darwin', { XDG_CACHE_HOME: '/xdg' }, '/home/me')).toBe(
    '/home/me/Library/Caches/pantheon-build',
  );
  expect(buildCache('linux', { XDG_CACHE_HOME: '/xdg' }, '/home/me')).toBe('/xdg/pantheon-build');
  expect(buildCache('linux', {}, '/home/me')).toBe('/home/me/.cache/pantheon-build');
  expect(buildCache('linux', { XDG_CACHE_HOME: '' }, '/home/me')).toBe(
    '/home/me/.cache/pantheon-build',
  );
});

it('reads each file sha256 from SHASUMS256.txt', () => {
  const arm = 'a'.repeat(64);
  const x64 = 'b'.repeat(64);
  const sums = parseShasums(
    `${arm}  node-v26.13.0-darwin-arm64.tar.xz\n${x64}  node-v26.13.0-darwin-x64.tar.xz\n\nnot a sum line\n`,
  );
  expect(sums.get('node-v26.13.0-darwin-arm64.tar.xz')).toBe(arm);
  expect(sums.get('node-v26.13.0-darwin-x64.tar.xz')).toBe(x64);
  expect(sums.size).toBe(2);
});

it("removes from a deployed package what Node never loads, other platforms' prebuilds and the build machine's paths", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-prune-'));
  const files = [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'src/main.ts',
    'dist/main.js',
    'dist/main.js.map',
    'dist/main.d.ts',
    'dist/.tsbuildinfo',
    'node_modules/.pnpm/@/zod/4.6.7/hash/node_modules/zod/index.js',
    'node_modules/zod/index.js',
    'node_modules/zod/index.d.cts',
    'node_modules/zod/src/index.ts',
    'node_modules/debug/src/index.js',
    'node_modules/sdk/index.mjs',
    'node_modules/sdk/index.d.mts',
    'node_modules/sdk/LICENSE.md',
    'node_modules/.modules.yaml',
    'node_modules/.pnpm-workspace-state-v1.json',
    'node_modules/node-pty/prebuilds/linux-x64/pty.node',
    'node_modules/node-pty/prebuilds/linux-arm64/pty.node',
    'node_modules/node-pty/prebuilds/darwin-arm64/pty.node',
    'node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll',
  ];
  for (const file of files) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), '');
  }
  const manifest = {
    name: '@pantheon/daemon',
    type: 'module',
    dependencies: {
      '@pantheon/control': '@pantheon/control@file:///Users/me/Pantheon/packages/control',
    },
  };
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
  pruneDeploy(root, 'linux-x64');
  const left = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort();
  expect(left).toEqual([
    'dist/main.js',
    'node_modules/debug/src/index.js',
    'node_modules/node-pty/prebuilds/linux-x64/pty.node',
    'node_modules/sdk/LICENSE.md',
    'node_modules/sdk/index.mjs',
    'node_modules/zod/index.js',
    'package.json',
  ]);
  expect(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))).toEqual({
    name: '@pantheon/daemon',
    type: 'module',
  });
  rmSync(root, { recursive: true });
});
