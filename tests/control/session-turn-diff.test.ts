import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { Session, Workspace } from '@pantheon/domain';
import { settle, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);

/** Two turns: a committed file written after the first starts, an untracked one after the second. */
async function twoTurns() {
  const f = await workbenchFixture();
  const session = await f.create('Start the export');
  await settle(f, session);
  const work = f.store.must<Workspace>('workspaces', session.workspace_id!).path;
  writeFileSync(path.join(work, 'header.txt'), 'header\n');
  git(work, 'add', 'header.txt');
  git(work, 'commit', '--quiet', '-m', 'Header added');
  f.call(
    'session.send',
    { session_id: session.id, input: 'Add a footer row' },
    current(f, session.id).revision,
  );
  await settle(f, session);
  writeFileSync(path.join(work, 'footer.txt'), 'footer\none\n');
  const [first, second] = f.turns(session.id);
  return { f, session, work, first: first!, second: second! };
}

it('lists only the files a turn changed, up to the checkpoint of the next turn', async () => {
  const { f, session, first } = await twoTurns();

  const diff = await f.control.sessionTurnDiff(user, session.id, first.id);

  expect(diff).toMatchObject({ session_id: session.id, turn_id: first.id, truncated: false });
  expect(diff.files).toEqual([
    { path: 'header.txt', additions: 1, deletions: 0, untracked: false },
  ]);
  expect(diff.patch).toContain('+header');
  expect(diff.patch).not.toContain('footer');
});

it('compares the last turn with the worktree, uncommitted new files included, and leaves the index alone', async () => {
  const { f, session, work, second } = await twoTurns();
  const status = git(work, 'status', '--porcelain');

  const diff = await f.control.sessionTurnDiff(user, session.id, second.id);

  expect(diff.files).toEqual([
    { path: 'footer.txt', additions: 2, deletions: 0, untracked: false },
  ]);
  expect(diff.patch).toContain('+footer');
  expect(diff.patch).not.toContain('+header');
  expect(git(work, 'status', '--porcelain')).toBe(status);
});

it('refuses a turn whose checkpoint ref is missing', async () => {
  const { f, session, work, first } = await twoTurns();
  git(
    work,
    'update-ref',
    '-d',
    `refs/pantheon/checkpoints/${session.workspace_id}/${session.id}/${first.id}`,
  );

  await expect(f.control.sessionTurnDiff(user, session.id, first.id)).rejects.toMatchObject({
    code: 'checkpoint_missing',
  });
  await expect(
    f.control.sessionTurnDiff(user, session.id, 'turn-without-checkpoint'),
  ).rejects.toMatchObject({ code: 'checkpoint_missing' });
});
