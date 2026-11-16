import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

it("does not read configuration that a .git/commondir in the project's checkout points git at", async () => {
  const f = workbenchFixture();
  // A commit with a signature, so log.showSignature makes git run gpg.program on it.
  const signed = execFileSync('git', ['hash-object', '-w', '-t', 'commit', '--stdin'], {
    cwd: f.source,
    input:
      `tree ${git(f.source, 'rev-parse', 'HEAD^{tree}')}\nparent ${git(f.source, 'rev-parse', 'HEAD')}\n` +
      'author Workbench Fixture <fixture@example.invalid> 1700000000 +0000\n' +
      'committer Workbench Fixture <fixture@example.invalid> 1700000000 +0000\n' +
      'gpgsig -----BEGIN PGP SIGNATURE-----\n \n c2lnbmF0dXJl\n -----END PGP SIGNATURE-----\n\nSigned change\n',
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8',
  }).trim();
  git(f.source, 'update-ref', 'refs/heads/main', signed);
  // What an in-place session can write beside the protected config: a common directory with its
  // own config, sharing everything else with the checkout's .git.
  const metadata = path.join(f.source, '.git'),
    planted = path.join(metadata, 'planted'),
    marker = path.join(f.root, 'gpg-program-ran'),
    program = path.join(f.root, 'gpg-program.sh');
  writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(program, 0o755);
  mkdirSync(planted);
  for (const name of readdirSync(metadata))
    if (!['planted', 'config', 'objects', 'HEAD', 'index'].includes(name))
      symlinkSync(path.join('..', name), path.join(planted, name));
  cpSync(path.join(metadata, 'objects'), path.join(planted, 'objects'), { recursive: true });
  const config = path.join(planted, 'config');
  copyFileSync(path.join(metadata, 'config'), config);
  git(f.source, 'config', '--file', config, 'log.showSignature', 'true');
  git(f.source, 'config', '--file', config, 'gpg.program', program);
  writeFileSync(path.join(metadata, 'commondir'), 'planted\n');
  const read = await f.control.repoLog(user, { project_id: f.project.id, limit: 5, skip: 0 }).then(
    () => undefined,
    (error: Error) => error,
  );
  expect(existsSync(marker)).toBe(false);
  expect(read).toMatchObject({ code: 'sandbox_path_replaced' });
});
