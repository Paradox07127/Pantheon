import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { id, type Principal, type Session } from '@pantheon/domain';
import type { CommandType, RepoWorkingDiff } from '@pantheon/protocol';
import { git, workbenchFixture } from './workbench-fixture.js';
import { user } from '../helpers.js';

const LINES = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);

/** The fixture checkout with a twenty-line file committed beside answer.txt. */
function checkout() {
  const f = workbenchFixture();
  const root = f.project.roots[0]!;
  writeFileSync(path.join(root, 'lines.txt'), `${LINES.join('\n')}\n`);
  writeFileSync(path.join(root, 'gone.txt'), 'soon gone\n');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'Add lines and gone');
  const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
  const write = (file: string, content: string) => writeFileSync(path.join(root, file), content);
  const send = <T>(type: CommandType, input: Record<string, unknown>, principal?: Principal) =>
    f.call<Promise<T>>(type, { project_id: f.project.id, ...input }, null, principal);
  return { f, root, read, write, send };
}

it('lists modified, deleted and untracked files against HEAD with untracked files as new-file diffs', async () => {
  const { f, root, write } = checkout();
  write('answer.txt', 'base\nmore\n');
  git(root, 'rm', '--quiet', 'gone.txt');
  write('fresh.txt', 'one\ntwo\n');
  const diff: RepoWorkingDiff = await f.control.repoWorkingDiff(user, f.project.id);
  expect(diff.head_sha).toBe(git(root, 'rev-parse', 'HEAD'));
  expect(diff.files).toEqual([
    { path: 'answer.txt', status: 'modified', additions: 1, deletions: 0 },
    { path: 'gone.txt', status: 'deleted', additions: 0, deletions: 1 },
    { path: 'fresh.txt', status: 'untracked', additions: 2, deletions: 0 },
  ]);
  expect(diff.truncated).toBe(false);
  expect(diff.patch).toContain('+more');
  expect(diff.patch).toContain('deleted file mode');
  expect(diff.patch).toMatch(
    /new file mode \d+\n[^\n]*\n--- \/dev\/null\n\+\+\+ b\/fresh\.txt\n@@ -0,0 \+1,2 @@\n\+one\n\+two/,
  );
});

it('discards tracked and untracked files back to HEAD and undoes the discard', async () => {
  const { f, root, read, write, send } = checkout();
  write('answer.txt', 'base\nstaged\n');
  git(root, 'add', 'answer.txt');
  write('answer.txt', 'base\nstaged\nunstaged\n');
  write('fresh.txt', 'untracked\n');
  const before = f.store.kindEvents(f.project.id, ['workspace.repository_changed']).length;
  const { undo_id } = await send<{ undo_id: string }>('repo.discard', {
    paths: ['answer.txt', 'fresh.txt'],
  });
  expect(read('answer.txt')).toBe('base\n');
  expect(git(root, 'diff', '--cached', '--name-only')).toBe('');
  expect(existsSync(path.join(root, 'fresh.txt'))).toBe(false);
  expect(f.store.kindEvents(f.project.id, ['workspace.repository_changed']).length).toBe(
    before + 1,
  );
  expect(await send('repo.discard_undo', { undo_id })).toEqual({});
  expect(read('answer.txt')).toBe('base\nstaged\nunstaged\n');
  expect(read('fresh.txt')).toBe('untracked\n');
});

it('discards through the checkout’s own filters, as git does for the user', async () => {
  const { root, read, write, send } = checkout();
  git(root, 'config', 'filter.upper.smudge', 'tr a-z A-Z');
  git(root, 'config', 'filter.upper.clean', 'cat');
  write('.gitattributes', 'shout.txt filter=upper\n');
  write('shout.txt', 'quiet\n');
  git(root, 'add', '.gitattributes', 'shout.txt');
  git(root, 'commit', '--quiet', '-m', 'Add a filtered file');
  write('shout.txt', 'changed\n');
  await send('repo.discard', { paths: ['shout.txt'] });
  expect(read('shout.txt')).toBe('QUIET\n');
});

it('undoes a discard back to the staged version in the index and the edit in the worktree', async () => {
  const { root, read, write, send } = checkout();
  write('answer.txt', 'base\nstaged\n');
  git(root, 'add', 'answer.txt');
  write('answer.txt', 'base\nedited\n');
  const { undo_id } = await send<{ undo_id: string }>('repo.discard', { paths: ['answer.txt'] });
  expect(git(root, 'show', ':answer.txt')).toBe('base');
  await send('repo.discard_undo', { undo_id });
  expect(git(root, 'show', ':answer.txt')).toBe('base\nstaged');
  expect(read('answer.txt')).toBe('base\nedited\n');
});

it('commits and discards a rename by its old and its new path', async () => {
  const { root, read, send } = checkout();
  git(root, 'config', 'user.name', 'Repository Owner');
  git(root, 'config', 'user.email', 'owner@example.invalid');
  git(root, 'mv', 'gone.txt', 'moved.txt');
  const { undo_id } = await send<{ undo_id: string }>('repo.discard', {
    paths: ['moved.txt', 'gone.txt'],
  });
  expect(read('gone.txt')).toBe('soon gone\n');
  expect(existsSync(path.join(root, 'moved.txt'))).toBe(false);
  expect(git(root, 'status', '--porcelain')).toBe('');
  await send('repo.discard_undo', { undo_id });
  await send('repo.commit', { paths: ['moved.txt', 'gone.txt'], message: 'Move gone' });
  const tree = git(root, 'ls-tree', '--name-only', 'HEAD').split('\n');
  expect(tree).toContain('moved.txt');
  expect(tree).not.toContain('gone.txt');
  expect(git(root, 'status', '--porcelain')).toBe('');
});

it('does not list a file that the checkout’s clean filter makes equal to HEAD', async () => {
  const { f, root, write } = checkout();
  git(root, 'config', 'filter.lower.smudge', 'tr a-z A-Z');
  git(root, 'config', 'filter.lower.clean', 'tr A-Z a-z');
  write('.gitattributes', 'shout.txt filter=lower\n');
  write('shout.txt', 'QUIET\n');
  git(root, 'add', '.gitattributes', 'shout.txt');
  git(root, 'commit', '--quiet', '-m', 'Add a filtered file');
  // A later mtime makes git read the file again instead of trusting the index.
  const later = new Date(Date.now() + 60000);
  utimesSync(path.join(root, 'shout.txt'), later, later);
  const diff: RepoWorkingDiff = await f.control.repoWorkingDiff(user, f.project.id);
  expect(diff.files).toEqual([]);
});

it('builds a plain patch whatever diff output the checkout configures', async () => {
  const { f, root, write } = checkout();
  git(root, 'config', 'color.ui', 'always');
  git(root, 'config', 'diff.noprefix', 'true');
  git(root, 'config', 'diff.mnemonicPrefix', 'true');
  write('answer.txt', 'base\nmore\n');
  const diff: RepoWorkingDiff = await f.control.repoWorkingDiff(user, f.project.id);
  expect(diff.patch).not.toContain('\u001b[');
  expect(diff.patch).toContain('--- a/answer.txt\n+++ b/answer.txt');
});

it('refuses an undo after ten minutes', async () => {
  const { f, write, send } = checkout();
  write('answer.txt', 'changed\n');
  const { undo_id } = await send<{ undo_id: string }>('repo.discard', { paths: ['answer.txt'] });
  const now = Date.now();
  vi.spyOn(f.store, 'now').mockImplementation(() => now + 11 * 60 * 1000);
  await expect(send('repo.discard_undo', { undo_id })).rejects.toMatchObject({
    code: 'undo_expired',
  });
});

it('discards only the lines a patch selects and leaves a patch that does not apply unapplied', async () => {
  const { f, read, write, send } = checkout();
  const changed = LINES.map((line, index) =>
    index === 1 ? 'second changed' : index === 16 ? 'seventeenth changed' : line,
  );
  write('lines.txt', `${changed.join('\n')}\n`);
  write('answer.txt', 'base\nkept\n');
  const { patch } = await f.control.repoWorkingDiff(user, f.project.id);
  const file = patch!.slice(patch!.indexOf('diff --git a/lines.txt'));
  const hunks = file.split(/(?=^@@ )/m);
  expect(hunks).toHaveLength(3);
  const selected = `${hunks[0]}${hunks[1]}`;
  const { undo_id } = await send<{ undo_id: string }>('repo.discard_patch', { patch: selected });
  expect(read('lines.txt').split('\n')[1]).toBe('line 2');
  expect(read('lines.txt').split('\n')[16]).toBe('seventeenth changed');
  expect(read('answer.txt')).toBe('base\nkept\n');
  const afterDiscard = read('lines.txt');
  await expect(send('repo.discard_patch', { patch: selected })).rejects.toMatchObject({
    code: 'patch_failed',
    message: expect.stringContaining('patch does not apply'),
  });
  expect(read('lines.txt')).toBe(afterDiscard);
  await send('repo.discard_undo', { undo_id });
  expect(read('lines.txt')).toBe(`${changed.join('\n')}\n`);
});

it('refuses to discard lines of a file with staged changes', async () => {
  const { f, root, read, write, send } = checkout();
  const staged = LINES.map((line, index) => (index === 1 ? 'second staged' : line));
  write('lines.txt', `${staged.join('\n')}\n`);
  git(root, 'add', 'lines.txt');
  const changed = staged.map((line, index) => (index === 16 ? 'seventeenth changed' : line));
  write('lines.txt', `${changed.join('\n')}\n`);
  const { patch } = await f.control.repoWorkingDiff(user, f.project.id);
  const file = patch!.slice(patch!.indexOf('diff --git a/lines.txt'));
  await expect(send('repo.discard_patch', { patch: file })).rejects.toMatchObject({
    code: 'staged_changes',
  });
  expect(read('lines.txt')).toBe(`${changed.join('\n')}\n`);
  expect(git(root, 'show', ':lines.txt')).toBe(staged.join('\n'));
});

it('commits only the given paths as the repository user and leaves other staged files staged', async () => {
  const { root, write, send } = checkout();
  git(root, 'config', 'user.name', 'Repository Owner');
  git(root, 'config', 'user.email', 'owner@example.invalid');
  write('answer.txt', 'base\ncommitted\n');
  write('other.txt', 'staged elsewhere\n');
  git(root, 'add', 'other.txt');
  const { sha } = await send<{ sha: string }>('repo.commit', {
    paths: ['answer.txt'],
    message: 'Commit the answer',
  });
  expect(git(root, 'rev-parse', 'HEAD')).toBe(sha);
  expect(git(root, 'log', '-1', '--format=%an|%cn|%s')).toBe(
    'Repository Owner|Repository Owner|Commit the answer',
  );
  expect(git(root, 'show', '--name-only', '--format=', 'HEAD')).toBe('answer.txt');
  expect(git(root, 'diff', '--cached', '--name-only')).toBe('other.txt');
});

it('runs the repository pre-commit hook and reports its output when it fails', async () => {
  const { root, write, send } = checkout();
  git(root, 'config', 'user.name', 'Repository Owner');
  git(root, 'config', 'user.email', 'owner@example.invalid');
  const hook = path.join(root, '.git/hooks/pre-commit');
  writeFileSync(hook, '#!/bin/sh\necho "lint refused the change" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  const head = git(root, 'rev-parse', 'HEAD');
  write('answer.txt', 'base\nrefused\n');
  await expect(
    send('repo.commit', { paths: ['answer.txt'], message: 'Refused change' }),
  ).rejects.toMatchObject({
    code: 'commit_failed',
    message: expect.stringContaining('lint refused the change'),
  });
  expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
});

it('leaves the index as it was when the pre-commit hook refuses the commit', async () => {
  const { root, write, send } = checkout();
  git(root, 'config', 'user.name', 'Repository Owner');
  git(root, 'config', 'user.email', 'owner@example.invalid');
  const hook = path.join(root, '.git/hooks/pre-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  chmodSync(hook, 0o755);
  write('answer.txt', 'base\nunstaged\n');
  write('fresh.txt', 'untracked\n');
  const before = git(root, 'ls-files', '--stage');
  await expect(
    send('repo.commit', { paths: ['answer.txt', 'fresh.txt'], message: 'Refused change' }),
  ).rejects.toMatchObject({ code: 'commit_failed' });
  expect(git(root, 'ls-files', '--stage')).toBe(before);
  expect(git(root, 'diff', '--cached', '--name-only')).toBe('');
});

it('refuses every repository write from a principal other than the user and paths that leave the folder', async () => {
  const { f, write, send } = checkout();
  write('answer.txt', 'changed\n');
  const writer: Principal = { id: 'writer', role: 'writer', project_id: f.project.id };
  const inputs: [CommandType, Record<string, unknown>][] = [
    ['repo.discard', { paths: ['answer.txt'] }],
    ['repo.discard_patch', { patch: 'diff --git a/answer.txt b/answer.txt\n' }],
    ['repo.discard_undo', { undo_id: 'missing' }],
    ['repo.commit', { paths: ['answer.txt'], message: 'Not mine' }],
    ['repo.push', {}],
    ['repo.revert', { sha: 'HEAD' }],
  ];
  for (const [type, input] of inputs)
    await expect(send(type, input, writer), type).rejects.toMatchObject({
      code: 'permission_denied',
    });
  for (const [type, input] of [
    ['repo.discard', { paths: ['../x'] }],
    ['repo.commit', { paths: ['../x'], message: 'Outside' }],
    ['repo.discard', { paths: ['-x'] }],
  ] as const)
    await expect(send(type, input), type).rejects.toMatchObject({ code: 'invalid_input' });
});

/** The fixture checkout as the repository owner, with a bare remote named origin. */
function published() {
  const c = checkout();
  git(c.root, 'config', 'user.name', 'Repository Owner');
  git(c.root, 'config', 'user.email', 'owner@example.invalid');
  const remote = path.join(c.f.root, 'remote.git');
  git(c.f.root, 'init', '--quiet', '--bare', remote);
  git(c.root, 'remote', 'add', 'origin', remote);
  const commit = (file: string, content: string, message: string) => {
    c.write(file, content);
    git(c.root, 'add', file);
    git(c.root, 'commit', '--quiet', '-m', message);
    return git(c.root, 'rev-parse', 'HEAD');
  };
  /** Another clone puts a commit on the remote's main. */
  const theirs = () => {
    const other = path.join(c.f.root, 'other');
    git(c.f.root, 'clone', '--quiet', '--branch', 'main', remote, other);
    writeFileSync(path.join(other, 'theirs.txt'), 'theirs\n');
    git(other, 'add', 'theirs.txt');
    git(
      other,
      '-c',
      'user.name=Other',
      '-c',
      'user.email=other@example.invalid',
      'commit',
      '-qm',
      'Theirs',
    );
    git(other, 'push', '--quiet', 'origin', 'main');
    return git(other, 'rev-parse', 'HEAD');
  };
  return { ...c, remote, commit, theirs };
}

it('pushes the branch to its upstream and records the change', async () => {
  const { f, root, remote, send, commit } = published();
  git(root, 'push', '--quiet', '--set-upstream', 'origin', 'main');
  const sha = commit('answer.txt', 'base\npushed\n', 'Push me');
  const before = f.store.kindEvents(f.project.id, ['workspace.repository_changed']).length;
  expect(await send('repo.push', {})).toEqual({});
  expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(sha);
  expect(f.store.kindEvents(f.project.id, ['workspace.repository_changed']).length).toBe(
    before + 1,
  );
});

it('pushes a branch without an upstream to origin and makes it the upstream', async () => {
  const { root, remote, send } = published();
  await send('repo.push', {});
  expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(git(root, 'rev-parse', 'HEAD'));
  expect(git(root, 'rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/main');
});

it('refuses to push a branch without an upstream when there is no origin remote', async () => {
  const { root, send } = published();
  git(root, 'remote', 'rename', 'origin', 'backup');
  await expect(send('repo.push', {})).rejects.toMatchObject({ code: 'no_remote' });
});

it('reports a push the remote rejects as not a fast-forward and never forces it', async () => {
  const { root, remote, send, commit, theirs } = published();
  git(root, 'push', '--quiet', '--set-upstream', 'origin', 'main');
  const their = theirs();
  commit('answer.txt', 'base\nmine\n', 'Mine');
  await expect(send('repo.push', {})).rejects.toMatchObject({
    code: 'push_rejected',
    message: expect.stringContaining('[rejected]'),
  });
  expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(their);
});

it('pushes over ssh in batch mode without a terminal prompt', async () => {
  const { f, root, send } = published();
  const bin = path.join(f.root, 'bin'),
    seen = path.join(f.root, 'ssh-seen.txt');
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, 'ssh'),
    `#!/bin/sh\necho "$GIT_TERMINAL_PROMPT $*" > '${seen}'\necho 'Permission denied (publickey).' >&2\nexit 255\n`,
  );
  chmodSync(path.join(bin, 'ssh'), 0o755);
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
  vi.stubEnv('GIT_SSH_COMMAND', undefined);
  git(root, 'remote', 'set-url', 'origin', 'ssh://git@host.invalid/repo.git');
  try {
    await expect(send('repo.push', {})).rejects.toMatchObject({
      code: 'push_failed',
      message: expect.stringContaining('Permission denied'),
    });
  } finally {
    vi.unstubAllEnvs();
  }
  expect(readFileSync(seen, 'utf8')).toMatch(/^0 .*-o BatchMode=yes/);
});

it('gives the branch and how far HEAD is ahead of and behind its upstream', async () => {
  const { f, root, commit, theirs } = published();
  const diff = () => f.control.repoWorkingDiff(user, f.project.id);
  expect(await diff()).toMatchObject({ branch: 'main', upstream: null });
  git(root, 'push', '--quiet', '--set-upstream', 'origin', 'main');
  theirs();
  git(root, 'fetch', '--quiet', 'origin');
  commit('answer.txt', 'base\none\n', 'One');
  commit('answer.txt', 'base\ntwo\n', 'Two');
  expect(await diff()).toMatchObject({
    branch: 'main',
    upstream: { name: 'origin/main', ahead: 2, behind: 1 },
  });
  git(root, 'checkout', '--quiet', '--detach');
  expect(await diff()).toMatchObject({ branch: null, upstream: null });
});

it('reverts one commit in a new commit on the branch', async () => {
  const { root, read, send, commit } = published();
  const sha = commit('answer.txt', 'base\nreverted\n', 'Change the answer');
  const reverted = await send<{ sha: string }>('repo.revert', { sha });
  expect(git(root, 'rev-parse', 'HEAD')).toBe(reverted.sha);
  expect(git(root, 'rev-parse', 'HEAD^')).toBe(sha);
  expect(git(root, 'log', '-1', '--format=%s')).toBe('Revert "Change the answer"');
  expect(read('answer.txt')).toBe('base\n');
});

/** Two commits landed by a recorded merge of a titled session. */
function sessionMerge(r: ReturnType<typeof published>) {
  const from = git(r.root, 'rev-parse', 'HEAD');
  r.commit('answer.txt', 'base\nfirst\n', 'First session change');
  const to = r.commit('fresh.txt', 'fresh\n', 'Second session change');
  const session = r.f.store.insert<Session>('sessions', {
    id: id(),
    revision: 1,
    project_id: r.f.project.id,
    runtime: r.f.adapter.name,
    title: 'Raise the refund cap',
    state: 'open',
    turn_count: 0,
  });
  r.f.store.event('session.merged', session, r.f.project.id, { from_sha: from, to_sha: to });
  return { from, to };
}

it('reverts the whole range of a session merge in one commit named after the session', async () => {
  const r = published();
  const { from, to } = sessionMerge(r);
  await r.send('repo.revert', { sha: to });
  expect(git(r.root, 'rev-parse', 'HEAD^')).toBe(to);
  expect(git(r.root, 'log', '-1', '--format=%s%n%b')).toBe(
    `Revert "Raise the refund cap"\nThis reverts ${from}..${to}.`,
  );
  expect(r.read('answer.txt')).toBe('base\n');
  expect(existsSync(path.join(r.root, 'fresh.txt'))).toBe(false);
  expect(git(r.root, 'status', '--porcelain')).toBe('');
});

it('tells how many commits the session merge that ended at a commit landed', async () => {
  const r = published();
  const { from, to } = sessionMerge(r);
  const after = (sha: string) =>
    r.f.control.repoCommitAfter(user, { project_id: r.f.project.id, sha });
  expect((await after(to)).session_merge).toEqual({ from_sha: from, commits: 2 });
  expect((await after(from)).session_merge).toBeNull();
});

it('refuses to revert in a checkout with uncommitted changes to tracked files', async () => {
  const { root, write, send, commit } = published();
  const sha = commit('answer.txt', 'base\nreverted\n', 'Change the answer');
  write('untracked.txt', 'left alone\n');
  const reverted = await send<{ sha: string }>('repo.revert', { sha });
  expect(git(root, 'rev-parse', 'HEAD')).toBe(reverted.sha);
  write('lines.txt', 'edited\n');
  await expect(send('repo.revert', { sha: reverted.sha })).rejects.toMatchObject({
    code: 'dirty_checkout',
  });
  expect(git(root, 'rev-parse', 'HEAD')).toBe(reverted.sha);
});

it('gives up a revert that conflicts and names the conflicting files', async () => {
  const { root, read, send, commit } = published();
  const sha = commit('answer.txt', 'base\nfirst\n', 'First');
  const head = commit('answer.txt', 'base\nsecond\n', 'Second');
  await expect(send('repo.revert', { sha })).rejects.toMatchObject({
    code: 'revert_conflict',
    message: expect.stringContaining('answer.txt'),
  });
  expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
  expect(read('answer.txt')).toBe('base\nsecond\n');
  expect(git(root, 'status', '--porcelain')).toBe('');
  expect(existsSync(path.join(root, '.git/REVERT_HEAD'))).toBe(false);
});

it('logs the author email and the message body of each commit', async () => {
  const { f, root, write } = published();
  write('answer.txt', 'base\nbody\n');
  git(
    root,
    'commit',
    '-qam',
    'Subject line',
    '-m',
    'First paragraph\nwraps here.',
    '-m',
    'Second.',
  );
  const { commits } = await f.control.repoLog(user, {
    project_id: f.project.id,
    limit: 2,
    skip: 0,
  });
  expect(commits[0]).toMatchObject({
    author: 'Workbench Fixture',
    author_email: 'fixture@example.invalid',
    subject: 'Subject line',
    body: 'First paragraph\nwraps here.\n\nSecond.',
  });
  expect(commits[1]).toMatchObject({ subject: 'Add lines and gone', body: '' });
});

it('refuses an undo when a folder of the file was replaced by a symlink and leaves its target alone', async () => {
  const { f, root, read, write, send } = checkout();
  mkdirSync(path.join(root, 'src'));
  write('src/config', 'base config\n');
  git(root, 'add', 'src/config');
  git(root, 'commit', '--quiet', '-m', 'Add config');
  write('src/config', 'agent content\n');
  const { undo_id } = await send<{ undo_id: string }>('repo.discard', { paths: ['src/config'] });
  expect(read('src/config')).toBe('base config\n');
  const outside = path.join(f.root, 'outside');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'config'), 'precious\n');
  rmSync(path.join(root, 'src'), { recursive: true });
  symlinkSync(outside, path.join(root, 'src'));
  await expect(send('repo.discard_undo', { undo_id })).rejects.toMatchObject({
    code: 'invalid_state',
  });
  expect(readFileSync(path.join(outside, 'config'), 'utf8')).toBe('precious\n');
});

it('keeps an undo that failed so that it can be tried again', async () => {
  const { root, read, write, send } = checkout();
  write('answer.txt', 'base\nstaged\n');
  git(root, 'add', 'answer.txt');
  write('answer.txt', 'base\nstaged\nunstaged\n');
  const { undo_id } = await send<{ undo_id: string }>('repo.discard', { paths: ['answer.txt'] });
  const lock = path.join(root, '.git/index.lock');
  writeFileSync(lock, '');
  await expect(send('repo.discard_undo', { undo_id })).rejects.toMatchObject({
    code: 'workspace_read_failed',
  });
  rmSync(lock);
  expect(await send('repo.discard_undo', { undo_id })).toEqual({});
  expect(git(root, 'show', ':answer.txt')).toBe('base\nstaged');
  expect(read('answer.txt')).toBe('base\nstaged\nunstaged\n');
});

it('puts back the files a discard already changed when it stops partway', async () => {
  const { root, read, write, send } = checkout();
  git(root, 'config', 'filter.broken.clean', 'cat');
  git(root, 'config', 'filter.broken.smudge', 'false');
  git(root, 'config', 'filter.broken.required', 'true');
  write('.gitattributes', 'broken.txt filter=broken\n');
  write('broken.txt', 'broken base\n');
  git(root, 'add', '.gitattributes', 'broken.txt');
  git(root, 'commit', '--quiet', '-m', 'Add a file whose smudge filter fails');
  write('answer.txt', 'base\nkept\n');
  write('broken.txt', 'broken edited\n');
  await expect(send('repo.discard', { paths: ['answer.txt', 'broken.txt'] })).rejects.toThrow();
  expect(read('answer.txt')).toBe('base\nkept\n');
  expect(read('broken.txt')).toBe('broken edited\n');
});

it('leaves a conflicted file’s stages as they were when the commit is refused during a merge', async () => {
  const { root, write, send } = checkout();
  git(root, 'config', 'user.name', 'Repository Owner');
  git(root, 'config', 'user.email', 'owner@example.invalid');
  git(root, 'switch', '--quiet', '-c', 'other');
  write('answer.txt', 'other\n');
  git(root, 'commit', '--quiet', '-am', 'Other side');
  git(root, 'switch', '--quiet', 'main');
  write('answer.txt', 'main\n');
  git(root, 'commit', '--quiet', '-am', 'Main side');
  expect(() => git(root, 'merge', '--quiet', 'other')).toThrow();
  write('answer.txt', 'resolved\n');
  const before = git(root, 'ls-files', '--stage', 'answer.txt');
  await expect(
    send('repo.commit', { paths: ['answer.txt'], message: 'Resolve' }),
  ).rejects.toMatchObject({ code: 'commit_failed' });
  expect(git(root, 'ls-files', '--stage', 'answer.txt')).toBe(before);
});

it('undoes a discarded patch of a file whose name holds a tab', async () => {
  const { f, root, read, write, send } = checkout();
  const name = 'tab\tname.txt';
  write(name, 'one\ntwo\nthree\n');
  git(root, 'add', name);
  git(root, 'commit', '--quiet', '-m', 'Add a file with a tab in its name');
  write(name, 'one\nTWO\nthree\n');
  const { patch } = await f.control.repoWorkingDiff(user, f.project.id);
  const { undo_id } = await send<{ undo_id: string }>('repo.discard_patch', { patch });
  expect(read(name)).toBe('one\ntwo\nthree\n');
  await send('repo.discard_undo', { undo_id });
  expect(read(name)).toBe('one\nTWO\nthree\n');
});

it('lists many untracked files with a fixed number of git runs', async () => {
  const { f, root, write } = checkout();
  mkdirSync(path.join(root, 'data'));
  for (let index = 0; index < 40; index++) write(`data/${index}.txt`, `row ${index}\n`);
  const bin = path.join(f.root, 'counting-git'),
    runs = path.join(bin, 'runs');
  mkdirSync(bin);
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho run >> '${runs}'\nexec '${real}' "$@"\n`, {
    mode: 0o755,
  });
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}:${PATH}`;
  let diff: RepoWorkingDiff;
  try {
    diff = await f.control.repoWorkingDiff(user, f.project.id);
  } finally {
    process.env.PATH = PATH;
  }
  expect(diff.files).toHaveLength(40);
  expect(diff.files[0]).toEqual({
    path: 'data/0.txt',
    status: 'untracked',
    additions: 1,
    deletions: 0,
  });
  expect(diff.patch).toContain('+++ b/data/39.txt\n@@ -0,0 +1 @@\n+row 39');
  expect(readFileSync(runs, 'utf8').split('\n').length - 1).toBeLessThan(15);
});

it('reports a discarded patch that the user’s git exits on before reading it', async () => {
  const { root, send } = checkout();
  appendFileSync(path.join(root, '.git/config'), '[broken\n');
  const patch = `diff --git a/answer.txt b/answer.txt\n${'+filler line\n'.repeat(2 ** 18)}`;
  await expect(send('repo.discard_patch', { patch })).rejects.toMatchObject({
    code: 'patch_failed',
  });
});

it('keeps intents to add and the assumed-unchanged and skip-worktree marks through a discard, its undo and a discard git refuses', async () => {
  const { root, read, write, send } = checkout();
  write('intended.txt', 'intended\n');
  git(root, 'add', '--intent-to-add', 'intended.txt');
  git(root, 'update-index', '--assume-unchanged', 'answer.txt');
  git(root, 'update-index', '--skip-worktree', 'lines.txt');
  const marks = () => `${git(root, 'status', '--porcelain')}\n${git(root, 'ls-files', '-v', '-t')}`;
  const before = marks();
  const { undo_id } = await send<{ undo_id: string }>('repo.discard', {
    paths: ['intended.txt', 'answer.txt'],
  });
  await send('repo.discard_undo', { undo_id });
  expect(marks()).toBe(before);
  expect(read('intended.txt')).toBe('intended\n');
  // Git restore does not match a path that skips the worktree.
  await expect(send('repo.discard', { paths: ['lines.txt'] })).rejects.toMatchObject({
    code: 'workspace_read_failed',
  });
  expect(marks()).toBe(before);
});

it('keeps an intent to add when the pre-commit hook refuses the commit', async () => {
  const { root, write, send } = checkout();
  git(root, 'config', 'user.name', 'Repository Owner');
  git(root, 'config', 'user.email', 'owner@example.invalid');
  const hook = path.join(root, '.git/hooks/pre-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  chmodSync(hook, 0o755);
  write('intended.txt', 'intended\n');
  git(root, 'add', '--intent-to-add', 'intended.txt');
  const before = git(root, 'status', '--porcelain');
  await expect(
    send('repo.commit', { paths: ['intended.txt'], message: 'Refused change' }),
  ).rejects.toMatchObject({ code: 'commit_failed' });
  expect(git(root, 'status', '--porcelain')).toBe(before);
});

it('keeps what a discard saved in a backup folder and removes it when the undo expires', async () => {
  const { f, write, send } = checkout();
  const directory = path.join(f.root, 'state/discard-backups');
  write('answer.txt', 'saved aside\n');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    await send('repo.discard', { paths: ['answer.txt'] });
    const made = readdirSync(directory);
    expect(made).toHaveLength(1);
    const backup = path.join(directory, made[0]!);
    expect(
      readdirSync(backup).map((file) => readFileSync(path.join(backup, file), 'utf8')),
    ).toEqual(['saved aside\n']);
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(existsSync(backup)).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it('keeps the backup an undo restores from when the undo expires partway through it', async () => {
  const { f, write, read, send } = checkout();
  const directory = path.join(f.root, 'state/discard-backups');
  write('answer.txt', 'answer edited\n');
  write('gone.txt', 'gone edited\n');
  write('lines.txt', 'lines edited\n');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const { undo_id } = await send<{ undo_id: string }>('repo.discard', {
      paths: ['answer.txt', 'gone.txt', 'lines.txt'],
    });
    const backup = path.join(directory, readdirSync(directory)[0]!);
    // The copy of gone.txt becomes a pipe, so the undo waits in its copy until the pipe has a writer.
    const pipe = path.join(backup, '1');
    rmSync(pipe);
    execFileSync('mkfifo', [pipe]);
    const undoing = send('repo.discard_undo', { undo_id });
    let writer = -1;
    await vi.waitFor(
      () => {
        // Opens only once the undo has the pipe open for reading.
        writer = openSync(pipe, constants.O_WRONLY | constants.O_NONBLOCK);
      },
      { timeout: 10000, interval: 5 },
    );
    vi.advanceTimersByTime(10 * 60 * 1000);
    closeSync(writer);
    expect(await undoing).toEqual({});
    expect(read('answer.txt')).toBe('answer edited\n');
    expect(read('lines.txt')).toBe('lines edited\n');
    expect(existsSync(backup)).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it('starts a discard sent while a commit runs its pre-commit hook once the commit is done', async () => {
  const { root, read, write, send } = checkout();
  git(root, 'config', 'user.name', 'Repository Owner');
  git(root, 'config', 'user.email', 'owner@example.invalid');
  const started = path.join(root, '.git/hook-started');
  const hook = path.join(root, '.git/hooks/pre-commit');
  writeFileSync(hook, `#!/bin/sh\ntouch '${started}'\nsleep 1\n`);
  chmodSync(hook, 0o755);
  write('answer.txt', 'base\ncommitted\n');
  write('lines.txt', 'discarded\n');
  const committing = send<{ sha: string }>('repo.commit', {
    paths: ['answer.txt'],
    message: 'Commit the answer',
  });
  await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: 10000, interval: 20 });
  const discarding = send<{ undo_id: string }>('repo.discard', { paths: ['lines.txt'] });
  const [{ sha }] = await Promise.all([committing, discarding]);
  expect(git(root, 'rev-parse', 'HEAD')).toBe(sha);
  expect(git(root, 'show', '--name-only', '--format=', 'HEAD')).toBe('answer.txt');
  expect(read('lines.txt')).toBe(`${LINES.join('\n')}\n`);
});
