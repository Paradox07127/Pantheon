import {
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
import type { Session } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

it('refuses to land into a source whose .git/commondir points git at configuration a session wrote', async () => {
  const f = await workbenchFixture();
  git(f.source, 'config', 'user.name', 'Source User');
  git(f.source, 'config', 'user.email', 'source@example.invalid');
  const sourceHead = git(f.source, 'rev-parse', 'HEAD');
  const session = await f.create();
  const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.turns(session.id)[0]!.state === 'completed' &&
      f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  // What an in-place session can write beside the protected config: a common directory with its
  // own config and a copy of the objects, which lacks the session commit, so the fetch connects.
  const metadata = path.join(f.source, '.git'),
    planted = path.join(metadata, 'planted'),
    marker = path.join(f.root, 'ssh-command-ran');
  mkdirSync(planted);
  for (const name of readdirSync(metadata))
    if (!['planted', 'config', 'objects', 'HEAD', 'index'].includes(name))
      symlinkSync(path.join('..', name), path.join(planted, name));
  cpSync(path.join(metadata, 'objects'), path.join(planted, 'objects'), { recursive: true });
  const config = path.join(planted, 'config');
  copyFileSync(path.join(metadata, 'config'), config);
  git(f.source, 'config', '--file', config, 'url.ssh://planted/.insteadOf', '/');
  git(f.source, 'config', '--file', config, 'core.sshCommand', `touch '${marker}'; false`);
  writeFileSync(path.join(workspace.path, 'answer.txt'), 'merged\n');
  git(workspace.path, 'add', '--', 'answer.txt');
  git(workspace.path, 'commit', '--quiet', '-m', 'Update answer.txt');
  f.call<Session>(
    'session.merge',
    { session_id: session.id },
    f.store.must<Session>('sessions', session.id).revision,
  );
  // Written after the merge was admitted, whose own source reads would refuse the commondir.
  writeFileSync(path.join(metadata, 'commondir'), 'planted\n');
  await eventually(
    () =>
      f.store.must<Session>('sessions', session.id).outcome === 'merged' ||
      f.store.must<Session>('sessions', session.id).merge?.state === 'blocked',
    () => f.control.tick(),
  );
  expect(existsSync(marker)).toBe(false);
  expect(f.store.must<Session>('sessions', session.id).merge).toEqual({
    state: 'blocked',
    reason: 'sandbox_path_replaced',
  });
  expect(git(f.source, 'rev-parse', 'main')).toBe(sourceHead);
});
