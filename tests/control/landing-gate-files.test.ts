import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { gateFiles } from '../../packages/control/src/landing.js';
import { git } from './workbench-fixture.js';

function repositoryWith(files: string[]): string {
  const repository = mkdtempSync(path.join(os.tmpdir(), 'gate-files-'));
  onTestFinished(() => rmSync(repository, { recursive: true, force: true }));
  git(repository, 'init', '--quiet');
  for (const file of files) {
    mkdirSync(path.dirname(path.join(repository, file)), { recursive: true });
    writeFileSync(path.join(repository, file), 'contents\n');
  }
  git(repository, 'add', '-A');
  git(repository, 'commit', '--quiet', '-m', 'Files');
  return repository;
}

it('protects by default the repository files the gate argv and its shell scripts name', async () => {
  const repository = repositoryWith([
    'scripts/check.sh',
    'tools/run.mjs',
    'vitest.config.ts',
    'notes.txt',
    'tests/a.test.ts',
  ]);
  const commands = [
    { name: 'Script', argv: ['sh', '-c', "sh ./scripts/check.sh && node 'tools/run.mjs'; echo"] },
    { name: 'Tests', argv: ['vitest', 'run', '--config', 'vitest.config.ts', 'tests'] },
    { name: 'Missing', argv: ['node', 'missing.mjs', '/etc/hosts', '../outside.txt'] },
  ];
  expect((await gateFiles(repository, ['HEAD'], commands)).sort()).toEqual([
    'scripts/check.sh',
    'tools/run.mjs',
    'vitest.config.ts',
  ]);
});

it.each([
  ['a name that starts with two dots', ['sh', '..checks/verify.sh'], '..checks/verify.sh'],
  [
    'the value of an option written with =',
    ['vitest', '--config=vitest.config.ts'],
    'vitest.config.ts',
  ],
  ['a script whose name holds a space', ['sh', 'scripts/my check.sh'], 'scripts/my check.sh'],
  ['a literal script name that ends in a semicolon', ['sh', 'scripts/check;'], 'scripts/check;'],
])('protects %s', async (_case, argv, file) => {
  const repository = repositoryWith([file, 'notes.txt']);
  expect(await gateFiles(repository, ['HEAD'], [{ name: 'Gate', argv }])).toEqual([file]);
});
