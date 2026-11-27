import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { Session, Workspace } from '@pantheon/domain';
import { user } from '../helpers.js';
import { git, gitRuns, workbenchFixture } from './workbench-fixture.js';

it('compares each checkout once and drops the project folder when its session is archived', async () => {
  const f = await workbenchFixture();
  const base = git(f.source, 'rev-parse', 'HEAD');
  const linked = path.join(f.root, 'managed', 'linked');
  git(f.source, 'worktree', 'add', '-b', 'linked', linked);
  const session = (id: string, folder: string) => {
    const inPlace = folder === f.source;
    const workspace = f.store.insert<Workspace>('workspaces', {
      id: id + '-workspace',
      revision: 1,
      project_id: f.project.id,
      source: f.source,
      path: folder,
      kind: inPlace ? 'in_place' : 'linked_worktree',
      base_sha: base,
      owner: user.id,
      ownership_epoch: 1,
    });
    return f.store.insert<Session>('sessions', {
      id,
      revision: 1,
      runtime: 'fixture',
      turn_count: 0,
      project_id: f.project.id,
      state: 'open',
      workspace_id: workspace.id,
      ...(inPlace ? { in_place: { base_sha: base } } : {}),
    });
  };
  const folderSession = session('folder', f.source);
  const other = session('linked', linked);
  for (const folder of [f.source, linked]) {
    writeFileSync(path.join(folder, 'answer.txt'), folder);
    writeFileSync(path.join(folder, 'new file.txt'), folder);
    writeFileSync(path.join(folder, path.basename(folder) + '.txt'), 'only here');
  }
  git(linked, 'commit', '-am', 'Change the answer');
  const read = () => f.control.projectOverlap(user, f.project.id);
  expect(await read()).toMatchObject({
    pairs: [{ session_ids: ['folder', 'linked'], paths: ['answer.txt', 'new file.txt'] }],
    refresh_events: expect.arrayContaining(['agent.tool.completed', 'session.merged']),
  });
  expect(await gitRuns(read)).toHaveLength(4);
  // Its dirty file restores the original content, undoing its committed change.
  writeFileSync(path.join(linked, 'answer.txt'), 'base\n');
  expect((await read()).pairs).toEqual([
    { session_ids: ['folder', 'linked'], paths: ['new file.txt'] },
  ]);
  const archived = f.store.update(
    'sessions',
    { ...other, archived_at: '2026-03-09T12:00:00Z' },
    other.revision,
  );
  expect((await read()).pairs).toHaveLength(1);
  const folder = f.store.update(
    'sessions',
    { ...folderSession, archived_at: '2026-03-09T12:00:00Z' },
    folderSession.revision,
  );
  for (const checkout of [f.source, linked])
    writeFileSync(path.join(checkout, 'later.txt'), 'later');
  const afterArchive = await read();
  expect(afterArchive.pairs).toEqual([]);
  expect(afterArchive.refresh_events).toEqual(
    expect.arrayContaining(['session.archived', 'session.unarchived']),
  );
  f.call('session.unarchive', { session_id: folder.id }, folder.revision);
  f.store.update('sessions', { ...archived, state: 'closed' }, archived.revision);
  expect(await gitRuns(async () => expect((await read()).pairs).toEqual([]))).toEqual([]);
  // A second session opened in the folder while the first was archived shares its checkout.
  f.store.insert<Session>('sessions', {
    ...f.store.must<Session>('sessions', folder.id),
    id: 'folder-again',
    revision: 1,
  });
  expect((await read()).pairs).toEqual([]);
});
