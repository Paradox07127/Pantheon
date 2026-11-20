import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { numstatFiles } from '../../packages/control/dist/source-git.js';
import { git, workbenchFixture } from './workbench-fixture.js';

it('counts the changed lines of files whose name holds a tab', async () => {
  const f = await workbenchFixture();
  const tracked = 'tab\tname.txt',
    fresh = 'new\tfile.txt';
  writeFileSync(path.join(f.source, tracked), 'one\ntwo\n');
  git(f.source, 'add', tracked);
  git(f.source, 'commit', '--quiet', '-m', 'Add a file with a tab in its name');
  writeFileSync(path.join(f.source, tracked), 'one\nTWO\nthree\n');
  writeFileSync(path.join(f.source, fresh), 'a\nb\nc\n');
  // diff --no-index exits 1 when the files differ.
  const numstat = (...args: string[]) =>
    spawnSync('git', ['diff', '--numstat', '-z', ...args], { cwd: f.source }).stdout;
  expect([
    ...numstatFiles(numstat('HEAD', '--')),
    ...numstatFiles(numstat('--no-index', '--', '/dev/null', fresh)),
  ]).toEqual([
    { path: tracked, additions: 2, deletions: 1 },
    { path: fresh, additions: 3, deletions: 0 },
  ]);
});
