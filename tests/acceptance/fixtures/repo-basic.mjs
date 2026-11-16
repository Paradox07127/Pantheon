import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

const sha256hex = (value) => createHash('sha256').update(value).digest('hex');

const BRANCHES = ['conflict-left', 'conflict-right'];

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Fixture Author',
  GIT_AUTHOR_EMAIL: 'fixture-author@example.invalid',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00+00:00',
  GIT_COMMITTER_NAME: 'Fixture Author',
  GIT_COMMITTER_EMAIL: 'fixture-author@example.invalid',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00+00:00',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

const PACKAGE_JSON = `${JSON.stringify({ name: 'text-stats', private: true, type: 'module' }, null, 2)}\n`;

const moduleSource = (wordCountBody, slugifyBody) => String.raw`export function wordCount(text) {
${wordCountBody}
}

export function slugify(title) {
${slugifyBody}
}
`;

const WORD_COUNT_BASE = String.raw`  return text.split(/\s+/).filter(Boolean).length;`;
const WORD_COUNT_LEFT = String.raw`  return (text.match(/\S+/g) ?? []).length;`;
const WORD_COUNT_RIGHT = String.raw`  return text.trim() === '' ? 0 : text.trim().split(/\s+/).length;`;

const SLUGIFY_MISSING = `  throw new Error('slugify is not implemented');`;
const SLUGIFY_CORRECT = String.raw`  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');`;
const SLUGIFY_UNTRIMMED = String.raw`  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-');`;

const PROJECT_TEST = String.raw`import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordCount } from '../src/text-stats.mjs';

test('counts words separated by single spaces', () => {
  assert.equal(wordCount('one two three'), 3);
});

test('ignores leading, trailing and repeated spaces', () => {
  assert.equal(wordCount('  one   two  '), 2);
});

test('returns zero for blank text', () => {
  assert.equal(wordCount('   '), 0);
});
`;

const PROJECT_TEST_EXTRA_CASE = String.raw`
test('counts words separated by tabs and newlines', () => {
  assert.equal(wordCount('one\ttwo\nthree'), 3);
});
`;

const VERIFIER = String.raw`import path from 'node:path';
import { pathToFileURL } from 'node:url';

const workspace = path.resolve(process.argv[2]);
const { slugify } = await import(pathToFileURL(path.join(workspace, 'src/text-stats.mjs')).href);

const cases = [
  ['Hello World', 'hello-world'],
  ['  Trim the edges  ', 'trim-the-edges'],
  ['Mixed: punctuation, here!', 'mixed-punctuation-here'],
  ['already-a-slug', 'already-a-slug'],
  ['Version 2 Release', 'version-2-release'],
];

let failures = 0;
for (const [input, expected] of cases) {
  let actual;
  try {
    actual = slugify(input);
  } catch (error) {
    actual = 'threw: ' + error.message;
  }
  if (actual !== expected) {
    failures += 1;
    console.error('slugify(' + JSON.stringify(input) + ') = ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
  }
}
process.exitCode = failures === 0 ? 0 : 1;
`;

async function listFiles(dir, skip) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (full === skip) continue;
    if (entry.isDirectory()) files.push(...(await listFiles(full, skip)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

export async function createRepoBasic(root) {
  root = path.resolve(root);
  const repo = path.join(root, 'repo');
  const patchesDir = path.join(root, 'patches');
  const verifierDir = path.join(root, 'verifier');
  const moduleFile = path.join(repo, 'src', 'text-stats.mjs');
  const testFile = path.join(repo, 'test', 'text-stats.test.mjs');

  // Env is not inherited: an outer GIT_DIR or GIT_INDEX_FILE would redirect git to another repo.
  const git = (...args) =>
    execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], {
      cwd: repo,
      env: { PATH: process.env.PATH, ...GIT_IDENTITY },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  await mkdir(path.join(repo, 'src'), { recursive: true });
  await mkdir(path.join(repo, 'test'), { recursive: true });
  await mkdir(patchesDir);
  await mkdir(verifierDir);

  git('init', '-q');
  await writeFile(path.join(repo, 'package.json'), PACKAGE_JSON);
  await writeFile(moduleFile, moduleSource(WORD_COUNT_BASE, SLUGIFY_MISSING));
  await writeFile(testFile, PROJECT_TEST);
  git('add', '-A');
  git('commit', '-q', '-m', 'Add text stats module with an unimplemented slugify');
  const base_commit = git('rev-parse', 'HEAD').trim();

  // Patches are working-tree diffs against base, so no temporary branch or commit is ever created.
  const diffAgainstBase = async (file, content, patchName) => {
    const original = await readFile(file, 'utf8');
    await writeFile(file, content);
    const patch = git('diff', '--no-color', '--no-ext-diff');
    await writeFile(file, original);
    const patchFile = path.join(patchesDir, patchName);
    await writeFile(patchFile, patch);
    return patchFile;
  };
  const patches = {
    good: await diffAgainstBase(
      moduleFile,
      moduleSource(WORD_COUNT_BASE, SLUGIFY_CORRECT),
      'good.patch',
    ),
    bad: await diffAgainstBase(
      moduleFile,
      moduleSource(WORD_COUNT_BASE, SLUGIFY_UNTRIMMED),
      'bad.patch',
    ),
    test_edit: await diffAgainstBase(
      testFile,
      PROJECT_TEST + PROJECT_TEST_EXTRA_CASE,
      'test-edit.patch',
    ),
  };

  const branchCommits = [];
  for (const [branch, wordCountBody] of [
    [BRANCHES[0], WORD_COUNT_LEFT],
    [BRANCHES[1], WORD_COUNT_RIGHT],
  ]) {
    git('switch', '-q', '-c', branch, 'main');
    await writeFile(moduleFile, moduleSource(wordCountBody, SLUGIFY_MISSING));
    git('commit', '-q', '-a', '-m', `Rewrite wordCount on ${branch}`);
    branchCommits.push(git('rev-parse', 'HEAD').trim());
  }
  git('switch', '-q', 'main');

  const script = path.join(verifierDir, 'verify.mjs');
  await writeFile(script, VERIFIER);
  await chmod(script, 0o444);
  await chmod(verifierDir, 0o555);

  const files = [];
  for (const file of await listFiles(root, path.join(repo, '.git'))) {
    files.push({
      path: path.relative(root, file).split(path.sep).join('/'),
      sha256: sha256hex(await readFile(file)),
    });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = sha256hex(JSON.stringify({ files, base_commit, branch_commits: branchCommits }));

  return {
    repo,
    base_commit,
    branches: [...BRANCHES],
    patches,
    verifier: { dir: verifierDir, script },
    hash,
  };
}
