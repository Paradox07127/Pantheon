import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { Project, Session, Workspace } from '@pantheon/domain';
import { insertLandingRecord } from '../../packages/control/src/project-landings.js';
import { user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

function commitFile(root: string, name: string, text: string) {
  writeFileSync(path.join(root, name), text);
  git(root, 'add', '--', name);
  git(root, 'commit', '-qm', `Update ${name}`);
  return git(root, 'rev-parse', 'HEAD');
}

function sessionWorktree(f: Awaited<ReturnType<typeof workbenchFixture>>, branch: string) {
  const folder = path.join(f.root, 'managed', branch);
  git(f.source, 'worktree', 'add', '-qb', branch, folder);
  const workspace = f.store.insert<Workspace>('workspaces', {
    id: branch + '-workspace',
    revision: 1,
    project_id: f.project.id,
    source: f.source,
    path: folder,
    kind: 'linked_worktree',
    owner: user.id,
    ownership_epoch: 1,
  });
  const session = f.store.insert<Session>('sessions', {
    id: branch,
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    state: 'open',
    turn_count: 0,
    workspace_id: workspace.id,
  });
  return { folder, session };
}

it('pages the commit log in order from the requested ref', async () => {
  const f = await workbenchFixture();
  const first = git(f.source, 'rev-parse', 'HEAD');
  const second = commitFile(f.source, 'answer.txt', 'second\n');
  git(f.source, 'tag', 'release');
  commitFile(f.source, 'answer.txt', 'third\n');
  const page = (skip: number) =>
    f.control.repoLog(user, { project_id: f.project.id, ref: 'release', limit: 1, skip });
  expect(await page(0)).toMatchObject({
    commits: [
      { sha: second, parents: [first], refs: ['tag: release'], subject: 'Update answer.txt' },
    ],
    has_more: true,
  });
  expect(await page(1)).toMatchObject({ commits: [{ sha: first, parents: [] }], has_more: false });
  expect(await page(2)).toEqual({ commits: [], has_more: false });
});

it('preserves indentation and trailing spaces in the commit body', async () => {
  const f = await workbenchFixture();
  const body = '    indented first line\n\tlast line  ';
  git(f.source, 'commit', '--allow-empty', '--cleanup=verbatim', '-m', 'Example', '-m', body);
  const log = await f.control.repoLog(user, { project_id: f.project.id, limit: 1, skip: 0 });
  expect(log.commits[0]!.body).toBe(body);
});

it('keeps the attribution of the landing that took a commit when a later merge takes none', async () => {
  const f = await workbenchFixture();
  const taken = commitFile(f.source, 'taken.txt', 'taken\n');
  const later = commitFile(f.source, 'later.txt', 'later\n');
  const project_id = f.project.id;
  const first = await f.create();
  const second = await f.create();
  const record = (session_id: string, landed_sha: string) => ({
    id: `record-${session_id}`,
    revision: 1,
    project_id,
    session_id,
    state: 'landed' as const,
    landed_sha,
    ended_at: f.store.now(),
    reason: null,
    gate_runs: 0,
    first_gate_passed: null,
    review_rounds: 0,
    turns: 0,
    input_tokens: 0,
    output_tokens: 0,
    wall_ms: null,
  });
  insertLandingRecord(f.control['ctx'], record(first.id, taken), [taken]);
  // The target already held the second session's tip, so its range listed no commit.
  insertLandingRecord(f.control['ctx'], record(second.id, taken), []);
  f.store.event('session.merged', second, project_id, { from_sha: later, to_sha: taken });
  const { commits } = await f.control.repoLog(user, { project_id, limit: 2, skip: 0 });
  expect(commits.map(({ sha, session_id }) => [sha, session_id])).toEqual([
    [later, undefined],
    [taken, first.id],
  ]);
});

it('diffs root and ordinary commits and compares diverging refs from their merge base', async () => {
  const f = await workbenchFixture();
  const base = git(f.source, 'rev-parse', 'HEAD');
  git(f.source, 'switch', '-qc', 'feature');
  const head = commitFile(f.source, 'feature.txt', 'branch change\n');
  git(f.source, 'switch', '-q', 'main');
  commitFile(f.source, 'main.txt', 'main change\n');
  expect(await f.control.repoCommitDiff(user, f.project.id, base)).toMatchObject({
    files: [{ path: 'answer.txt', status: 'added' }],
    hunks: [{ file: 'answer.txt', text: '+base' }],
  });
  const change = {
    from_sha: base,
    to_sha: head,
    files: [{ path: 'feature.txt', status: 'added' }],
    hunks: [{ file: 'feature.txt', text: '+branch change' }],
  };
  expect(await f.control.repoCommitDiff(user, f.project.id, head)).toMatchObject(change);
  expect(await f.control.repoCompare(user, f.project.id, 'main', 'feature')).toMatchObject({
    ...change,
    merge_base: base,
    ahead: 1,
    behind: 1,
  });
});

it('counts a rename as shared when another session edits the old path', async () => {
  const f = await workbenchFixture();
  const { folder } = sessionWorktree(f, 'editor');
  commitFile(folder, 'answer.txt', 'edited elsewhere\n');
  git(f.source, 'switch', '-qc', 'rename');
  git(f.source, 'mv', 'answer.txt', 'renamed.txt');
  git(f.source, 'commit', '-qm', 'Rename answer');
  git(f.source, 'switch', '-q', 'main');
  const compared = await f.control.repoCompare(user, f.project.id, 'main', 'rename');
  expect(compared.files).toMatchObject([{ path: 'renamed.txt', old_path: 'answer.txt' }]);
  expect(compared.single_owner_files).toBe(0);
});

it.each(['branch', 'SHA'])(
  'counts files shared with another session worktree when comparing a %s',
  async (ref) => {
    const f = await workbenchFixture();
    const feature = sessionWorktree(f, 'feature');
    const head = commitFile(feature.folder, 'feature.txt', 'feature\n');
    const compare = () =>
      f.control.repoCompare(
        user,
        f.project.id,
        'main',
        ref === 'SHA' ? head : 'refs/heads/feature',
      );
    expect((await compare()).single_owner_files).toBe(1);
    const other = sessionWorktree(f, 'other');
    git(other.folder, 'merge', '--ff-only', head);
    expect((await compare()).single_owner_files).toBe(0);
  },
);

it('counts a session worktree at the compared commit as another owner when the named branch is not checked out', async () => {
  const f = await workbenchFixture();
  const feature = sessionWorktree(f, 'feature');
  const head = commitFile(feature.folder, 'feature.txt', 'feature\n');
  git(f.source, 'branch', 'copy', head);
  const compared = await f.control.repoCompare(user, f.project.id, 'main', 'refs/heads/copy');
  expect(compared.single_owner_files).toBe(0);
});

it('finds the next commit only on the first-parent line of HEAD', async () => {
  const f = await workbenchFixture();
  const base = git(f.source, 'rev-parse', 'HEAD');
  git(f.source, 'switch', '-qc', 'side');
  const side = commitFile(f.source, 'side.txt', 'side\n');
  git(f.source, 'switch', '-q', 'main');
  const main = commitFile(f.source, 'answer.txt', 'main\n');
  git(f.source, 'merge', '--no-ff', '-m', 'Merge side', 'side');
  const merge = git(f.source, 'rev-parse', 'HEAD');
  const after = (sha: string) => f.control.repoCommitAfter(user, { project_id: f.project.id, sha });
  expect(await after(base)).toMatchObject({ next: { sha: main } });
  expect(await after(main)).toMatchObject({ next: { sha: merge, parents: [main, side] } });
  expect(await after(side)).toEqual({ next: null });
  expect(await after(merge)).toEqual({ next: null });
});

it('blames each run of lines against the requested commit', async () => {
  const f = await workbenchFixture();
  const first = git(f.source, 'rev-parse', 'HEAD');
  const second = commitFile(f.source, 'answer.txt', 'base\nsecond\nthird\n');
  commitFile(f.source, 'answer.txt', 'later\n');
  const blame = await f.control.repoBlame(user, {
    project_id: f.project.id,
    path: 'answer.txt',
    ref: second,
  });
  expect(blame).toMatchObject({
    sha: second,
    text: 'base\nsecond\nthird\n',
    truncated: false,
    chunks: [
      { start: 1, count: 1, sha: first, author: 'Workbench Fixture' },
      { start: 2, count: 2, sha: second, author: 'Workbench Fixture' },
    ],
  });
});

it('omits deleted lines from pending blame ranges and keeps surviving lines', async () => {
  const f = await workbenchFixture();
  commitFile(f.source, 'answer.txt', 'first\nkeep\nmiddle\nkeep again\nlast\n');
  const { folder, session } = sessionWorktree(f, 'editor');
  commitFile(folder, 'answer.txt', 'FIRST\nkeep\nMIDDLE\nKEEP AGAIN\nlast\n');
  commitFile(f.source, 'answer.txt', 'keep\nkeep again\nlast\n');
  const blame = await f.control.repoBlame(user, { project_id: f.project.id, path: 'answer.txt' });
  expect(blame.pending).toEqual([{ session_id: session.id, ranges: [{ start: 2, count: 1 }] }]);
});

it('maps pending blame ranges when the repository forces colored diffs', async () => {
  const f = await workbenchFixture();
  const { folder, session } = sessionWorktree(f, 'editor');
  commitFile(folder, 'answer.txt', 'session edit\n');
  commitFile(f.source, 'answer.txt', 'prefix\nbase\n');
  git(f.source, 'config', 'color.ui', 'always');
  const blame = await f.control.repoBlame(user, { project_id: f.project.id, path: 'answer.txt' });
  expect(blame.pending).toEqual([{ session_id: session.id, ranges: [{ start: 2, count: 1 }] }]);
});

it('follows file history through a rename', async () => {
  const f = await workbenchFixture();
  const original = git(f.source, 'rev-parse', 'HEAD');
  writeFileSync(path.join(f.source, 'notes.txt'), 'related change\n');
  git(f.source, 'add', 'notes.txt');
  const beforeRename = commitFile(f.source, 'answer.txt', 'updated answer\n');
  git(f.source, 'mv', 'answer.txt', 'answer[1].txt');
  git(f.source, 'commit', '-qm', 'Rename answer');
  const rename = git(f.source, 'rev-parse', 'HEAD');
  const edit = commitFile(f.source, 'answer[1].txt', 'new answer\n');
  commitFile(f.source, 'answer1.txt', 'different file\n');
  const history = await f.control.repoFileHistory(user, {
    project_id: f.project.id,
    path: 'answer[1].txt',
  });
  expect(history.changes.map(({ sha }) => sha)).toEqual([edit, rename, beforeRename, original]);
  expect(history.cochange).toEqual([{ path: 'notes.txt', together: 1 }]);
});

it('includes a merge resolution before a rename in file history and activity', async () => {
  const f = await workbenchFixture();
  const original = git(f.source, 'rev-parse', 'HEAD');
  git(f.source, 'switch', '-qc', 'side');
  const side = commitFile(f.source, 'answer.txt', 'side\n');
  git(f.source, 'switch', '-q', 'main');
  const main = commitFile(f.source, 'answer.txt', 'main\n');
  expect(() => git(f.source, 'merge', '--no-edit', 'side')).toThrow();
  writeFileSync(path.join(f.source, 'notes.txt'), 'resolution notes\n');
  git(f.source, 'add', 'notes.txt');
  const resolution = commitFile(f.source, 'answer.txt', 'resolved\n');
  git(f.source, 'mv', 'answer.txt', 'renamed.txt');
  git(f.source, 'commit', '-qm', 'Rename answer');
  const rename = git(f.source, 'rev-parse', 'HEAD');
  const history = await f.control.repoFileHistory(user, {
    project_id: f.project.id,
    path: 'renamed.txt',
  });
  expect(history.changes.slice(0, 2).map(({ sha }) => sha)).toEqual([rename, resolution]);
  expect(history.changes[1]!.parents).toEqual([main, side]);
  expect(history.changes.map(({ sha }) => sha).sort()).toEqual(
    [original, main, side, resolution, rename].sort(),
  );
  expect(history.weekly.reduce((sum, week) => sum + week.count, 0)).toBe(5);
  expect(history.cochange).toEqual([{ path: 'notes.txt', together: 1 }]);
});

it('refuses repository history to a principal of another project', async () => {
  const f = await workbenchFixture();
  const project = f.store.insert<Project>('projects', { ...f.project, id: 'other-project' });
  const session = f.store.insert<Session>('sessions', {
    id: 'other-session',
    revision: 1,
    project_id: project.id,
    runtime: f.adapter.name,
    state: 'open',
    turn_count: 0,
    project_setup: true,
  });
  const principal = {
    id: `session:${session.id}`,
    role: 'planner' as const,
    project_id: project.id,
    session_id: session.id,
    expires_at: f.store.now() + 60000,
  };
  const project_id = f.project.id;
  const file = { project_id, path: 'answer.txt' };
  for (const read of [
    () => f.control.repoLog(principal, { project_id, skip: 0, limit: 1 }),
    () => f.control.repoCommitDiff(principal, project_id, 'HEAD'),
    () => f.control.repoCompare(principal, project_id, 'HEAD', 'HEAD'),
    () => f.control.repoCommitAfter(principal, { project_id, sha: 'HEAD' }),
    () => f.control.repoBlame(principal, file),
    () => f.control.repoFileHistory(principal, file),
  ]) {
    await expect(read()).rejects.toMatchObject({
      code: 'permission_denied',
      message: 'Project principal required',
    });
  }
});
