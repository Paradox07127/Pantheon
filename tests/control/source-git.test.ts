import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { git, workbenchFixture } from './workbench-fixture.js';
import { user } from '../helpers.js';

it('counts the changed lines of files whose name holds a tab', async () => {
  const f = workbenchFixture();
  const tracked = 'tab\tname.txt',
    fresh = 'new\tfile.txt';
  writeFileSync(path.join(f.source, tracked), 'one\ntwo\n');
  git(f.source, 'add', tracked);
  git(f.source, 'commit', '--quiet', '-m', 'Add a file with a tab in its name');
  writeFileSync(path.join(f.source, tracked), 'one\nTWO\nthree\n');
  writeFileSync(path.join(f.source, fresh), 'a\nb\nc\n');
  expect((await f.control.repoWorkingDiff(user, f.project.id)).files).toEqual([
    { path: tracked, status: 'modified', additions: 2, deletions: 1 },
    { path: fresh, status: 'untracked', additions: 3, deletions: 0 },
  ]);
});
