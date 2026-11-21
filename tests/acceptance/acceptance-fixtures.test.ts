import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRepoBasic } from './fixtures/repo-basic.mjs';
import { createResearchDoc } from './fixtures/research-doc.mjs';

type RepoBasic = {
  repo: string;
  base_commit: string;
  branches: string[];
  patches: { good: string; bad: string; test_edit: string };
  verifier: { dir: string; script: string };
  hash: string;
};

type ResearchDoc = {
  dir: string;
  sources: { id: string; path: string }[];
  drafts: { complete: string; missing_citation: string };
  citation_pattern: string;
  hash: string;
};

const gitEnv = {
  PATH: process.env.PATH,
  GIT_AUTHOR_NAME: 'Fixture Test',
  GIT_AUTHOR_EMAIL: 'fixture-test@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture Test',
  GIT_COMMITTER_EMAIL: 'fixture-test@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

const git = (cwd: string, ...args: string[]) =>
  spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });

const projectTests = (cwd: string) =>
  spawnSync(process.execPath, ['--test'], { cwd, encoding: 'utf8' });

const verify = (fixture: RepoBasic, workspace: string) =>
  spawnSync(process.execPath, [fixture.verifier.script, workspace], { encoding: 'utf8' });

async function withRepoBasic(run: (fixture: RepoBasic, work: string) => Promise<void> | void) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'pantheon-repo-basic-'));
  const root = path.join(tmp, 'fixture');
  const work = path.join(tmp, 'work');
  mkdirSync(root);
  mkdirSync(work);
  try {
    await run((await createRepoBasic(root)) as RepoBasic, work);
  } finally {
    const verifierDir = path.join(root, 'verifier');
    if (existsSync(verifierDir)) {
      chmodSync(verifierDir, 0o755);
      for (const name of readdirSync(verifierDir)) chmodSync(path.join(verifierDir, name), 0o644);
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}

const copyRepo = (fixture: RepoBasic, work: string, name: string) => {
  const copy = path.join(work, name);
  cpSync(fixture.repo, copy, { recursive: true });
  return copy;
};

it('generates the same code repository hash and base commit twice', async () => {
  await withRepoBasic(async (first) => {
    await withRepoBasic((second) => {
      expect(second.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(second.hash).toBe(first.hash);
      expect(second.base_commit).toBe(first.base_commit);
      expect(git(second.repo, 'branch', '--format=%(refname:short)').stdout.split('\n')).toEqual([
        'conflict-left',
        'conflict-right',
        'main',
        '',
      ]);
    });
  });
});

it('passes the project tests on base while the verifier rejects base', async () => {
  await withRepoBasic((fixture) => {
    expect(git(fixture.repo, 'rev-parse', 'HEAD').stdout.trim()).toBe(fixture.base_commit);
    expect(projectTests(fixture.repo).status).toBe(0);
    expect(verify(fixture, fixture.repo).status).not.toBe(0);
  });
});

it('accepts the good patch, rejects the bad patch and keeps the test edit passing', async () => {
  await withRepoBasic((fixture, work) => {
    const good = copyRepo(fixture, work, 'good');
    expect(git(good, 'apply', fixture.patches.good).status).toBe(0);
    expect(verify(fixture, good).status).toBe(0);

    const bad = copyRepo(fixture, work, 'bad');
    expect(git(bad, 'apply', fixture.patches.bad).status).toBe(0);
    expect(verify(fixture, bad).status, 'verifier exit code after bad.patch').not.toBe(0);

    const editOnBase = copyRepo(fixture, work, 'test-edit-on-base');
    expect(git(editOnBase, 'apply', fixture.patches.test_edit).status).toBe(0);
    expect(projectTests(editOnBase).status).toBe(0);

    expect(git(good, 'apply', fixture.patches.test_edit).status).toBe(0);
    const run = projectTests(good);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('counts words separated by tabs and newlines');
  });
});

it('keeps both conflict branches green on their own but conflicting when merged', async () => {
  await withRepoBasic((fixture, work) => {
    const copy = copyRepo(fixture, work, 'merge');
    const [left, right] = fixture.branches;
    for (const branch of [left!, right!]) {
      expect(git(copy, 'switch', '-q', branch).status).toBe(0);
      expect(projectTests(copy).status).toBe(0);
    }
    const merge = git(copy, 'merge', '--no-edit', left!);
    expect(merge.status).not.toBe(0);
    expect(merge.stdout).toContain('CONFLICT');
  });
});

// Root writes into a read-only directory, so the mode cannot be observed this way.
it.skipIf(process.getuid?.() === 0)('makes the verifier directory read-only', async () => {
  await withRepoBasic((fixture) => {
    expect(() => writeFileSync(path.join(fixture.verifier.dir, 'extra.mjs'), '')).toThrow(
      expect.objectContaining({ code: 'EACCES' }),
    );
  });
});

async function withResearchDoc(run: (fixture: ResearchDoc, root: string) => Promise<void> | void) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-research-doc-'));
  try {
    await run((await createResearchDoc(root)) as ResearchDoc, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it('generates the same research document hash twice without any git directory', async () => {
  await withResearchDoc(async (first, firstRoot) => {
    await withResearchDoc((second) => {
      expect(second.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(second.hash).toBe(first.hash);
    });
    const entries = readdirSync(firstRoot, { recursive: true }) as string[];
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.filter((entry) => path.basename(entry) === '.git')).toEqual([]);
  });
});

it('finds every citation of the complete draft verbatim and misses one in the other draft', async () => {
  await withResearchDoc((fixture) => {
    const citationsFound = (draft: string) =>
      [...readFileSync(draft, 'utf8').matchAll(new RegExp(fixture.citation_pattern, 'g'))].map(
        ([, id, quote]) => {
          const source = fixture.sources.find((s) => s.id === id);
          return source !== undefined && readFileSync(source.path, 'utf8').includes(quote!);
        },
      );

    const complete = citationsFound(fixture.drafts.complete);
    expect(complete.length).toBeGreaterThan(0);
    expect(complete.every(Boolean)).toBe(true);

    const missing = citationsFound(fixture.drafts.missing_citation);
    expect(missing.length).toBe(complete.length);
    expect(missing.some((found) => !found)).toBe(true);
  });
});
