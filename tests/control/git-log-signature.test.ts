import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { collectFacts, type FolderFacts } from '../../packages/control/src/baseline-facts.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[], input?: string) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    input,
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Signature Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Signature Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
    encoding: 'utf8',
  }).trim();
}

it('reads the commits of a repository that shows signatures in its log', async () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'git-log-signature-'));
  roots.push(base);
  const repository = path.join(base, 'repository');
  mkdirSync(repository);
  git(repository, ['init', '--quiet', '-b', 'main']);
  writeFileSync(path.join(repository, 'a.txt'), 'a\n');
  git(repository, ['add', '.']);
  git(repository, ['commit', '--quiet', '-m', 'Plain change']);
  writeFileSync(path.join(repository, 'b.txt'), 'b\n');
  git(repository, ['add', '.']);
  const at = Math.floor(Date.now() / 1000);
  const signed = git(
    repository,
    ['hash-object', '-w', '-t', 'commit', '--stdin'],
    `tree ${git(repository, ['write-tree'])}\nparent ${git(repository, ['rev-parse', 'HEAD'])}\n` +
      `author Signature Fixture <fixture@example.invalid> ${at} +0000\n` +
      `committer Signature Fixture <fixture@example.invalid> ${at} +0000\n` +
      'gpgsig -----BEGIN PGP SIGNATURE-----\n \n c2lnbmF0dXJl\n -----END PGP SIGNATURE-----\n\nSigned change\n',
  );
  git(repository, ['update-ref', 'refs/heads/main', signed]);
  // A verifier that reports on each signature, as gpg does.
  const program = path.join(base, 'gpg-program.sh');
  writeFileSync(program, "#!/bin/sh\necho 'gpg: Good signature from Signature Fixture' >&2\n");
  chmodSync(program, 0o755);
  git(repository, ['config', 'log.showSignature', 'true']);
  git(repository, ['config', 'gpg.program', program]);
  const [facts] = (await collectFacts([{ path: repository, git: true }])).folders as [FolderFacts];
  expect(facts.recent_commits.map((entry) => entry.subject)).toEqual([
    'Signed change',
    'Plain change',
  ]);
});
