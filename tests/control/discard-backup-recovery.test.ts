import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { workbenchFixture } from './workbench-fixture.js';

it('removes the backups of discards whose undo a daemon crash lost when the next daemon recovers', async () => {
  const f = await workbenchFixture();
  const root = f.project.roots[0]!;
  const directory = path.join(f.root, 'state/discard-backups');
  writeFileSync(path.join(root, 'answer.txt'), 'saved aside\n');
  await f.call('repo.discard', { project_id: f.project.id, paths: ['answer.txt'] });
  const made = readdirSync(directory);
  expect(made).toHaveLength(1);
  const backup = path.join(directory, made[0]!);
  await f.restart();
  expect(existsSync(backup)).toBe(false);
});

it('refuses an undo whose backup the recovery removed and keeps the file edited since', async () => {
  const f = await workbenchFixture();
  const root = f.project.roots[0]!;
  writeFileSync(path.join(root, 'answer.txt'), 'saved aside\n');
  const { undo_id } = await f.call<{ undo_id: string }>('repo.discard', {
    project_id: f.project.id,
    paths: ['answer.txt'],
  });
  await f.restart();
  writeFileSync(path.join(root, 'answer.txt'), 'edited after the restart\n');
  await expect(
    f.call('repo.discard_undo', { project_id: f.project.id, undo_id }),
  ).rejects.toMatchObject({ code: 'undo_expired' });
  expect(readFileSync(path.join(root, 'answer.txt'), 'utf8')).toBe('edited after the restart\n');
});
