import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { LandingDiff } from '@pantheon/protocol';
import { renderStoryBrief } from '../../packages/control/src/change-story-brief.js';
import { git, workbenchFixture } from './workbench-fixture.js';
import { user } from '../helpers.js';

it('splits a commit into hunks whatever color the checkout configures', async () => {
  const f = await workbenchFixture();
  const root = f.project.roots[0]!;
  git(root, 'config', 'color.ui', 'always');
  writeFileSync(path.join(root, 'answer.txt'), 'base\nsecond\n');
  git(root, 'commit', '--quiet', '-am', 'Second');
  const diff = await f.control.repoCommitDiff(user, f.project.id, git(root, 'rev-parse', 'HEAD'));
  expect(diff.hunks).toHaveLength(1);
  expect(diff.hunks[0]!.text).toContain('+second');
});

function commitFiles(root: string, files: Record<string, string>) {
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), contents);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'Change files');
  return git(root, 'rev-parse', 'HEAD');
}

const marks = (diff: LandingDiff) => diff.hunks.map((hunk) => [hunk.file, hunk.noise]);

it('marks only indentation and blank lines as whitespace, not a split line or space inside one', async () => {
  const f = await workbenchFixture();
  const root = f.project.roots[0]!;
  commitFiles(root, {
    'layout.js': 'function g() {\nreturn 1;\n}\n',
    'literal.js': 'const s = "a b";\n',
    'returned.js': 'function f() {\n  return value;\n}\n',
    'run.sh': 'echo cleanup rm -rf "$TARGET"\n',
  });
  const sha = commitFiles(root, {
    'layout.js': 'function g() {\n\n  return 1;\n}\n',
    'literal.js': 'const s = "a  b";\n',
    'returned.js': 'function f() {\n  return\n  value;\n}\n',
    'run.sh': 'echo cleanup\nrm -rf "$TARGET"\n',
  });
  expect(marks(await f.control.repoCommitDiff(user, f.project.id, sha))).toEqual([
    ['layout.js', 'whitespace'],
    ['literal.js', undefined],
    ['returned.js', undefined],
    ['run.sh', undefined],
  ]);
});

it('marks build output as generated only beside a change to other files', async () => {
  const f = await workbenchFixture();
  const root = f.project.roots[0]!;
  commitFiles(root, { 'dist/index.js': 'run(1);\n', 'src/index.js': 'run(1);\n' });
  const alone = commitFiles(root, { 'dist/index.js': 'run(2);\n' });
  const beside = commitFiles(root, { 'dist/index.js': 'run(3);\n', 'src/index.js': 'run(3);\n' });
  expect(marks(await f.control.repoCommitDiff(user, f.project.id, alone))).toEqual([
    ['dist/index.js', undefined],
  ]);
  expect(marks(await f.control.repoCommitDiff(user, f.project.id, beside))).toEqual([
    ['dist/index.js', 'generated'],
    ['src/index.js', undefined],
  ]);
});

it('asks the story to tell a moved block that may run differently in a card', async () => {
  const f = await workbenchFixture();
  const root = f.project.roots[0]!;
  const calls = 'sendEmail(user);\nchargeCard(user);\nlogAudit(user);\n';
  commitFiles(root, { 'a.js': `start();\n${calls}end();\n` });
  const sha = commitFiles(root, { 'a.js': 'start();\nend();\n', 'unused.js': calls });
  const diff = await f.control.repoCommitDiff(user, f.project.id, sha);
  expect(marks(diff)).toEqual([
    ['a.js', 'moved'],
    ['unused.js', 'moved'],
  ]);
  const brief = renderStoryBrief({ goal: 'Tidy the module', acceptance: [] }, diff, []);
  expect(brief).not.toContain('change no behavior');
  expect(brief).toContain(
    'put them in `noise` only when the lines still run at the same points, else in a card',
  );
});
