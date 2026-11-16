import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { UserConfig } from '@pantheon/protocol';
import {
  autoGitInit,
  runtimeConfig,
  writeUserConfig,
} from '../../packages/control/dist/user-config.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function configDir() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-user-config-'));
  roots.push(root);
  return {
    root,
    dir: path.join(root, '.pantheon'),
    file: path.join(root, '.pantheon/config.json'),
  };
}

it('starts a missing configuration at version 1 and writes it readable by the owner only', () => {
  const f = configDir();
  expect(autoGitInit(f.dir)).toBe(true);
  expect(runtimeConfig(f.dir, 'claude')).toEqual({});
  writeUserConfig(f.dir, { auto_git_init: false });
  expect(JSON.parse(readFileSync(f.file, 'utf8'))).toEqual({ version: 1, auto_git_init: false });
  expect(statSync(f.file).mode & 0o777).toBe(0o600);
  expect(autoGitInit(f.dir)).toBe(false);
});

it("keeps the user's other keys in their order and reads the runtime settings back", () => {
  const f = configDir();
  writeUserConfig(f.dir, {});
  const existing = {
    model_families: { 'house-': 'claude' },
    runtimes: { codex: { binary: '/opt/codex/bin/codex', args: ['-c', 'model_verbosity=low'] } },
    version: 1,
    auto_git_init: true,
  };
  writeFileSync(f.file, JSON.stringify(existing), { mode: 0o644 });
  writeUserConfig(f.dir, { auto_git_init: false });
  const text = readFileSync(f.file, 'utf8');
  expect(Object.keys(JSON.parse(text) as object)).toEqual([
    'model_families',
    'runtimes',
    'version',
    'auto_git_init',
  ]);
  expect(JSON.parse(text)).toEqual({ ...existing, auto_git_init: false });
  expect(statSync(f.file).mode & 0o777).toBe(0o600);
  expect(runtimeConfig(f.dir, 'codex')).toEqual(existing.runtimes.codex);
  expect(runtimeConfig(f.dir, 'claude')).toEqual({});
});

it('writes nothing when the merged configuration fails the schema or the file is not JSON', () => {
  const f = configDir();
  writeUserConfig(f.dir, { auto_git_init: true });
  const before = readFileSync(f.file, 'utf8');
  expect(() =>
    writeUserConfig(f.dir, { runtimes: { claude: { binary: 7 } } } as unknown as UserConfig),
  ).toThrowError(expect.objectContaining({ code: 'invalid_user_config' }));
  expect(readFileSync(f.file, 'utf8')).toBe(before);
  writeFileSync(f.file, '{ not json');
  expect(() => writeUserConfig(f.dir, { auto_git_init: false })).toThrowError(
    expect.objectContaining({ code: 'invalid_user_config' }),
  );
  expect(readFileSync(f.file, 'utf8')).toBe('{ not json');
  expect(readdirSync(f.dir)).toEqual(['config.json']);
});
