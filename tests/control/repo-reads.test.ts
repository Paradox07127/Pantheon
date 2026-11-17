import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { id, type Session } from '@pantheon/domain';
import { git, workbenchFixture } from './workbench-fixture.js';
import { user } from '../helpers.js';

/** Runs git through a script that logs each run's arguments, one line a run. */
async function countingGit<T>(run: () => Promise<T>): Promise<{ result: T; runs: string[] }> {
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = mkdtempSync(path.join(process.cwd(), 'node_modules/.cache/counting-git-')),
    log = path.join(bin, 'runs.log');
  writeFileSync(log, '');
  writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`,
  );
  chmodSync(path.join(bin, 'git'), 0o755);
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}:${PATH}`;
  try {
    const result = await run();
    return { result, runs: readFileSync(log, 'utf8').split('\n').filter(Boolean) };
  } finally {
    process.env.PATH = PATH;
    rmSync(bin, { recursive: true, force: true });
  }
}

it('names the sessions of a log page over 500 recorded merges with a few git runs', async () => {
  const f = await workbenchFixture();
  const parent = git(f.source, 'rev-parse', 'HEAD'),
    start = Math.floor(Date.now() / 1000) - 1000;
  execFileSync('git', ['fast-import', '--quiet'], {
    cwd: f.source,
    input: Array.from(
      { length: 501 },
      (_, index) =>
        `commit refs/heads/main\ncommitter Workbench Fixture <fixture@example.invalid> ${start + index} +0000\n` +
        `data 0\n${index === 0 ? `from ${parent}\n` : ''}\n`,
    ).join(''),
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  const shas = git(f.source, 'rev-list', '--reverse', 'HEAD').split('\n');
  const session = f.store.insert<Session>('sessions', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    state: 'open',
    turn_count: 0,
  });
  // Each merge lands one commit; the newest commit is the user's own.
  for (let index = 0; index < 500; index++)
    f.store.event('session.merged', session, f.project.id, {
      from_sha: shas[index],
      to_sha: shas[index + 1],
    });
  const { result, runs } = await countingGit(() =>
    f.control.repoLog(user, { project_id: f.project.id, limit: 50, skip: 0 }),
  );
  expect(result.commits.filter((commit) => commit.session_id === session.id)).toHaveLength(49);
  expect(result.commits[0]!.session_id).toBeUndefined();
  expect(runs.length).toBeLessThan(10);
});

it('names the newest merge landing each commit across a side branch, past merges of missing commits', async () => {
  const f = await workbenchFixture();
  const sessions = Array.from({ length: 3 }, () =>
    f.store.insert<Session>('sessions', {
      id: id(),
      revision: 1,
      project_id: f.project.id,
      runtime: f.adapter.name,
      state: 'open',
      turn_count: 0,
    }),
  );
  const commit = (message: string) => {
    git(f.source, 'commit', '--quiet', '--allow-empty', '-m', message);
    return git(f.source, 'rev-parse', 'HEAD');
  };
  const base = git(f.source, 'rev-parse', 'HEAD');
  git(f.source, 'switch', '--quiet', '-c', 'feature');
  const [first, second] = [commit('Feature one'), commit('Feature two')];
  git(f.source, 'switch', '--quiet', 'main');
  const own = commit('Own change');
  git(f.source, 'merge', '--quiet', '--no-ff', '-m', 'Merge feature', 'feature');
  const merge = git(f.source, 'rev-parse', 'HEAD');
  const missing = 'f'.repeat(40);
  const merged = (session: Session, from_sha: string, to_sha: string) =>
    f.store.event('session.merged', session, f.project.id, { from_sha, to_sha });
  merged(sessions[0]!, own, merge);
  merged(sessions[1]!, base, first);
  merged(sessions[2]!, missing, merge);
  merged(sessions[2]!, own, missing);
  const log = await f.control.repoLog(user, { project_id: f.project.id, limit: 10, skip: 0 });
  expect(Object.fromEntries(log.commits.map((commit) => [commit.sha, commit.session_id]))).toEqual({
    [merge]: sessions[0]!.id,
    [second]: sessions[0]!.id,
    [first]: sessions[1]!.id,
    [own]: undefined,
    [base]: undefined,
  });
});

it('blames the lines of the preview of a file larger than the preview', async () => {
  const f = await workbenchFixture();
  // 120 000 short lines, as a lockfile has.
  writeFileSync(
    path.join(f.source, 'lock.txt'),
    Array.from({ length: 120000 }, (_, index) => `line ${String(index).padStart(6, '0')}\n`).join(
      '',
    ),
  );
  git(f.source, 'add', 'lock.txt');
  git(f.source, 'commit', '--quiet', '-m', 'Add the lockfile');
  const sha = git(f.source, 'rev-parse', 'HEAD');
  const blamed = await f.control.repoBlame(user, { project_id: f.project.id, path: 'lock.txt' });
  expect(blamed.truncated).toBe(true);
  // 1 MiB holds 87 381 whole lines of 12 bytes and part of the next.
  expect(blamed.text!.split('\n')).toHaveLength(87382);
  expect(blamed.chunks).toEqual([expect.objectContaining({ start: 1, count: 87382, sha })]);
});

it('diffs a root commit of a SHA-256 repository against its empty tree', async () => {
  const f = await workbenchFixture();
  rmSync(path.join(f.source, '.git'), { recursive: true, force: true });
  git(f.source, 'init', '--quiet', '--object-format=sha256', '--initial-branch=main');
  git(f.source, 'add', 'answer.txt');
  git(f.source, 'commit', '--quiet', '-m', 'Initial files');
  const sha = git(f.source, 'rev-parse', 'HEAD');
  expect(await f.control.repoCommitDiff(user, f.project.id, sha)).toMatchObject({
    to_sha: sha,
    files: [{ path: 'answer.txt', status: 'added', additions: 1, deletions: 0 }],
  });
  expect(await f.control.repoCommitAfter(user, { project_id: f.project.id, sha })).toMatchObject({
    later: [],
  });
});

it('blames a file whose name holds two dots', async () => {
  const f = await workbenchFixture();
  writeFileSync(path.join(f.source, 'release..notes.md'), 'notes\n');
  git(f.source, 'add', 'release..notes.md');
  git(f.source, 'commit', '--quiet', '-m', 'Add the release notes');
  const sha = git(f.source, 'rev-parse', 'HEAD');
  const input = { project_id: f.project.id, path: 'release..notes.md' };
  expect((await f.control.repoBlame(user, input)).chunks).toEqual([
    expect.objectContaining({ start: 1, count: 1, sha }),
  ]);
  expect((await f.control.repoFileHistory(user, input)).changes).toHaveLength(1);
  await expect(
    f.control.repoBlame(user, { ...input, path: 'docs/../../outside.md' }),
  ).rejects.toMatchObject({ code: 'invalid_input' });
});

it('blames a file whose name starts with -', async () => {
  const f = await workbenchFixture();
  writeFileSync(path.join(f.source, '-draft.txt'), 'draft\n');
  git(f.source, 'add', '--', '-draft.txt');
  git(f.source, 'commit', '--quiet', '-m', 'Add the draft');
  const sha = git(f.source, 'rev-parse', 'HEAD');
  const input = { project_id: f.project.id, path: '-draft.txt' };
  expect((await f.control.repoBlame(user, input)).chunks).toEqual([
    expect.objectContaining({ start: 1, count: 1, sha }),
  ]);
  expect((await f.control.repoFileHistory(user, input)).changes).toHaveLength(1);
});

it('lists the worktrees when a locked outside worktree’s folder is gone', async () => {
  const f = await workbenchFixture();
  const outside = path.join(f.root, 'outside');
  git(f.source, 'worktree', 'add', '--quiet', '--detach', outside);
  git(f.source, 'worktree', 'lock', outside);
  renameSync(outside, path.join(f.root, 'unmounted'));
  const worktrees = await f.control.repoWorktrees(user, f.project.id);
  expect(worktrees.map((worktree) => worktree.kind)).toEqual(['checkout']);
});

it('reads commits whose subject and files whose name hold the byte 0x01', async () => {
  const f = await workbenchFixture();
  const odd = 'odd\x01name.txt';
  writeFileSync(path.join(f.source, 'answer.txt'), 'changed\n');
  writeFileSync(path.join(f.source, odd), 'odd\n');
  git(f.source, 'add', '.');
  git(f.source, 'commit', '--quiet', '-m', 'Fix \x01 thing');
  const sha = git(f.source, 'rev-parse', 'HEAD');
  const day = 24 * 60 * 60 * 1000;
  const timeline = await f.control.repoTimeline(user, {
    project_id: f.project.id,
    from: Date.now() - day,
    to: Date.now() + day,
  });
  expect(timeline.lanes.flatMap((lane) => lane.points ?? []).map((point) => point.sha)).toContain(
    sha,
  );
  const history = await f.control.repoFileHistory(user, {
    project_id: f.project.id,
    path: 'answer.txt',
  });
  expect(history.cochange).toEqual([{ path: odd, together: 1 }]);
  expect(history.scanned).toBe(2);
});

it('logs signed commits as plain commits when the repository shows signatures', async () => {
  const f = await workbenchFixture();
  const raw = git(f.source, 'cat-file', 'commit', 'HEAD');
  const signed = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
    cwd: f.source,
    input: `${raw.replace(
      /(committer [^\n]*\n)/,
      '$1gpgsig -----BEGIN PGP SIGNATURE-----\n \n stand-in\n -----END PGP SIGNATURE-----\n',
    )}\n`,
    encoding: 'utf8',
  }).trim();
  git(f.source, 'update-ref', 'HEAD', signed);
  git(f.source, 'commit', '--quiet', '--allow-empty', '-m', 'After the signed commit');
  const verifier = path.join(f.root, 'verify-signature');
  writeFileSync(
    verifier,
    `#!/bin/sh\necho 'gpg: Good signature from "Fixture"' >&2\necho '[GNUPG:] GOODSIG 0 Fixture'\n`,
  );
  chmodSync(verifier, 0o755);
  git(f.source, 'config', 'gpg.program', verifier);
  git(f.source, 'config', 'log.showSignature', 'true');
  const log = await f.control.repoLog(user, { project_id: f.project.id, limit: 10, skip: 0 });
  expect(log.commits.map((commit) => [commit.subject, commit.body])).toEqual([
    ['After the signed commit', ''],
    ['Initial files', ''],
  ]);
  const history = await f.control.repoFileHistory(user, {
    project_id: f.project.id,
    path: 'answer.txt',
  });
  expect(history.changes.map((commit) => [commit.sha, commit.body])).toEqual([[signed, '']]);
});
