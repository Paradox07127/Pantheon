import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { Principal } from '@pantheon/domain';
import type { CommandType, RepoWorkingDiff } from '@pantheon/protocol';
import { git as boundedGit } from '../../packages/control/dist/source-git.js';
import { git, workbenchFixture } from './workbench-fixture.js';
import { user } from '../helpers.js';

const LINES = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, readFile: vi.fn(fs.readFile) };
});

/** The fixture checkout with a twenty-line file committed beside answer.txt. */
async function checkout() {
  const f = await workbenchFixture();
  const root = f.project.roots[0]!;
  writeFileSync(path.join(root, 'lines.txt'), `${LINES.join('\n')}\n`);
  writeFileSync(path.join(root, 'gone.txt'), 'soon gone\n');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'Add lines and gone');
  const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
  const write = (file: string, content: string) => writeFileSync(path.join(root, file), content);
  const send = async <T>(
    type: CommandType,
    input: Record<string, unknown>,
    principal?: Principal,
  ) => f.call<Promise<T>>(type, { project_id: f.project.id, ...input }, null, principal);
  return { f, root, read, write, send };
}

it('lists modified, added, deleted and untracked files against HEAD with untracked files as new-file diffs', async () => {
  const { f, root, write } = await checkout();
  write('answer.txt', 'base\nmore\n');
  git(root, 'rm', '--quiet', 'gone.txt');
  git(root, 'config', 'color.ui', 'always');
  git(root, 'config', 'diff.external', 'false');
  write('added.txt', 'staged addition\n');
  git(root, 'add', 'added.txt');
  write('fresh.txt', 'one\ntwo\n');
  const diff: RepoWorkingDiff = await f.control.repoWorkingDiff(user, f.project.id);
  expect(diff.head_sha).toBe(git(root, 'rev-parse', 'HEAD'));
  expect(diff.files).toEqual([
    { path: 'added.txt', status: 'added', additions: 1, deletions: 0 },
    { path: 'answer.txt', status: 'modified', additions: 1, deletions: 0 },
    { path: 'gone.txt', status: 'deleted', additions: 0, deletions: 1 },
    { path: 'fresh.txt', status: 'untracked', additions: 2, deletions: 0 },
  ]);
  expect(diff.truncated).toBe(false);
  expect(diff.patch).toContain('+staged addition');
  expect(diff.patch).toContain('+more');
  expect(diff.patch).toContain('deleted file mode');
  expect(diff.patch).toMatch(
    /new file mode \d+\n[^\n]*\n--- \/dev\/null\n\+\+\+ b\/fresh\.txt\n@@ -0,0 \+1,2 @@\n\+one\n\+two/,
  );
});

it('lists a tracked text change larger than the patch bound with the patch left out', async () => {
  const { f, write } = await checkout();
  const line = 'x'.repeat(99);
  write('lines.txt', `${Array.from({ length: 60_000 }, () => line).join('\n')}\n`);
  const diff = await f.control.repoWorkingDiff(user, f.project.id);
  expect(diff.truncated).toBe(true);
  expect(diff.patch).toBeNull();
  expect(diff.files.map((file) => [file.path, file.status])).toEqual([['lines.txt', 'modified']]);
});

it('discards tracked and untracked files back to HEAD and undoes the discard', async () => {
  const { f, root, read, write, send } = await checkout();
  write('answer.txt', 'base\nstaged\n');
  git(root, 'add', 'answer.txt');
  write('answer.txt', 'base\nstaged\nunstaged\n');
  write('fresh.txt', 'untracked\n');
  git(root, 'rm', '--quiet', 'gone.txt');
  write('gone.txt', 'replacement\n');
  const before = f.store.kindEvents(f.project.id, ['workspace.repository_changed']).length;
  const { undo_id } = await send<{ undo_id: string }>('repo.discard', {
    paths: ['answer.txt', 'fresh.txt', 'gone.txt'],
  });
  expect(read('answer.txt')).toBe('base\n');
  expect(read('gone.txt')).toBe('soon gone\n');
  expect(git(root, 'diff', '--no-color', '--no-ext-diff', '--cached', '--name-only')).toBe('');
  expect(existsSync(path.join(root, 'fresh.txt'))).toBe(false);
  expect(f.store.kindEvents(f.project.id, ['workspace.repository_changed']).length).toBe(
    before + 1,
  );
  expect(await send('repo.discard_undo', { undo_id })).toEqual({});
  expect(read('answer.txt')).toBe('base\nstaged\nunstaged\n');
  expect(read('fresh.txt')).toBe('untracked\n');
  expect(read('gone.txt')).toBe('replacement\n');
  expect(git(root, 'ls-files', '--', 'gone.txt')).toBe('');
  expect(git(root, 'show', ':answer.txt')).toBe('base\nstaged');
});

it('refuses undo after only the file permissions change', async () => {
  const { root, read, write, send } = await checkout();
  const target = path.join(root, 'answer.txt');
  write('answer.txt', 'discarded\n');
  const { undo_id } = await send<{ undo_id: string }>('repo.discard', { paths: ['answer.txt'] });
  const mode = (statSync(target).mode & 0o7777) ^ 0o020;
  chmodSync(target, mode);
  await expect(send('repo.discard_undo', { undo_id })).rejects.toMatchObject({
    code: 'invalid_state',
  });
  expect(statSync(target).mode & 0o7777).toBe(mode);
  expect(read('answer.txt')).toBe('base\n');
});

it('refuses undo after a new change is staged with the worktree back at HEAD', async () => {
  const { root, read, write, send } = await checkout();
  write('answer.txt', 'discarded\n');
  const { undo_id } = await send<{ undo_id: string }>('repo.discard', { paths: ['answer.txt'] });
  write('answer.txt', 'new staged content\n');
  await boundedGit(root, ['add', 'answer.txt']);
  write('answer.txt', 'base\n');
  await expect(send('repo.discard_undo', { undo_id })).rejects.toMatchObject({
    code: 'invalid_state',
  });
  expect(read('answer.txt')).toBe('base\n');
  expect(await boundedGit(root, ['show', ':answer.txt'])).toBe('new staged content\n');
});

it('hashes the discarded file without reading it into a single buffer', async () => {
  const { root, send } = await checkout();
  const target = path.join(root, 'answer.txt');
  const content = Buffer.alloc(256 * 1024, 0x61);
  writeFileSync(target, content);
  const { undo_id } = await send<{ undo_id: string }>('repo.discard', { paths: ['answer.txt'] });
  await send('repo.discard_undo', { undo_id });
  expect(readFileSync(target).equals(content)).toBe(true);
  expect(vi.mocked(readFile).mock.calls.map(([file]) => file)).not.toContain(target);
});

it.each([
  ['the default diff context', undefined],
  ['diff.context set to 0', '0'],
])(
  'discards only the lines a patch selects and leaves a patch that does not apply unapplied, with %s',
  async (_, context) => {
    const { f, root, read, write, send } = await checkout();
    if (context !== undefined) git(root, 'config', 'diff.context', context);
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
  },
);

it('reverses tracked and untracked binary patches and undoes them byte for byte', async () => {
  const { f, root, read, send } = await checkout();
  const content = Buffer.from([0, 0xff, 0x80]);
  const targets = ['answer.txt', 'fresh.bin'].map((file) => path.join(root, file));
  for (const target of targets) writeFileSync(target, content);
  const { patch } = await f.control.repoWorkingDiff(user, f.project.id);
  const { undo_id } = await send<{ undo_id: string }>('repo.discard_patch', { patch });
  expect(read('answer.txt')).toBe('base\n');
  expect(existsSync(targets[1]!)).toBe(false);
  await send('repo.discard_undo', { undo_id });
  for (const target of targets) expect(readFileSync(target)).toEqual(content);
});

it.each(['a removed line', 'an unchanged line'])('refuses invalid UTF-8 in %s', async (line) => {
  const { f, root, send } = await checkout();
  const target = path.join(root, 'lines.txt');
  const body = `${LINES.join('\n')}\n`;
  const before = Buffer.concat([Buffer.from([0xff, 0x0a]), Buffer.from(body)]);
  writeFileSync(target, before);
  await boundedGit(root, ['add', 'lines.txt']);
  await boundedGit(root, ['commit', '--quiet', '-m', 'Set first line']);
  const changed =
    line === 'a removed line'
      ? Buffer.from(`first\n${body}`)
      : Buffer.concat([before, Buffer.from('last\n')]);
  writeFileSync(target, changed);
  const { patch } = await f.control.repoWorkingDiff(user, f.project.id);
  await expect(send('repo.discard_patch', { patch })).rejects.toMatchObject({
    code: 'patch_failed',
    message: expect.stringContaining('UTF-8'),
  });
  expect(readFileSync(target)).toEqual(changed);
});

it('commits only the given paths as the repository user and leaves other staged files staged', async () => {
  const { root, write, send } = await checkout();
  git(root, 'config', 'commit.gpgsign', 'false');
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
  expect(git(root, 'diff', '--no-color', '--no-ext-diff', '--cached', '--name-only')).toBe(
    'other.txt',
  );
});

it('runs the repository pre-commit hook and reports its output when it fails', async () => {
  const { root, write, send } = await checkout();
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'user.name', 'Repository Owner');
  git(root, 'config', 'user.email', 'owner@example.invalid');
  git(root, 'config', 'core.hooksPath', '.git/hooks');
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
  expect(git(root, 'diff', '--no-color', '--no-ext-diff', '--cached', '--name-only')).toBe('');
});

it('refuses every local repository command and the working diff query from an agent', async () => {
  const { f, write, send } = await checkout();
  write('answer.txt', 'changed\n');
  const writer: Principal = { id: 'writer', role: 'writer', project_id: f.project.id };
  const inputs: [CommandType, Record<string, unknown>][] = [
    ['repo.discard', { paths: ['answer.txt'] }],
    ['repo.discard_patch', { patch: 'diff --git a/answer.txt b/answer.txt\n' }],
    ['repo.discard_undo', { undo_id: 'missing' }],
    ['repo.commit', { paths: ['answer.txt'], message: 'Not mine' }],
    ['repo.push', {}],
  ];
  for (const [type, input] of inputs)
    await expect(send(type, input, writer), type).rejects.toMatchObject({
      code: 'permission_denied',
    });
  await expect(f.control.repoWorkingDiff(writer, f.project.id)).rejects.toMatchObject({
    code: 'permission_denied',
  });
});

it('sets the upstream on first push and preserves the remote tip on rejection', async () => {
  const { f, root, send } = await checkout();
  const remote = path.join(f.root, 'remote.git');
  git(f.root, 'init', '--bare', '--quiet', remote);
  git(root, 'remote', 'add', 'origin', remote);
  const committed = git(root, 'rev-parse', 'HEAD');
  await send('repo.push', {});
  expect(git(root, 'rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/main');
  expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(committed);
  git(root, 'reset', '--hard', 'HEAD^');
  await expect(send('repo.push', {})).rejects.toMatchObject({
    code: 'push_rejected',
    message: expect.stringContaining('[rejected]'),
  });
  expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(committed);
});

it('keeps annotated tags local on first push and on push to the upstream', async () => {
  const { f, root, send } = await checkout();
  const remote = path.join(f.root, 'remote.git');
  await boundedGit(f.root, ['init', '--bare', '--quiet', remote]);
  await boundedGit(root, ['remote', 'add', 'origin', remote]);
  await boundedGit(root, ['config', 'push.followTags', 'true']);
  for (const tag of ['first', 'second']) {
    await boundedGit(root, ['commit', '--quiet', '--allow-empty', '-m', tag]);
    await boundedGit(root, ['tag', '-a', tag, '-m', tag]);
    await send('repo.push', {});
    expect(await boundedGit(remote, ['rev-parse', 'refs/heads/main'])).toBe(
      await boundedGit(root, ['rev-parse', 'HEAD']),
    );
    expect(await boundedGit(remote, ['tag', '--list'])).toBe('');
  }
});

it('refuses file writes, patch discard and undo through a symlinked parent', async () => {
  const { f, root, read, write, send } = await checkout();
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
  for (const [type, input] of [
    ['repo.discard', { paths: ['src/config'] }],
    ['repo.commit', { paths: ['src/config'], message: 'Outside' }],
    [
      'repo.discard_patch',
      { patch: '--- a/src/config\n+++ b/src/config\n@@ -1 +1 @@\n-base\n+precious\n' },
    ],
    ['repo.discard_undo', { undo_id }],
  ] as const)
    await expect(send(type, input)).rejects.toMatchObject({ code: 'invalid_state' });
  expect(readFileSync(path.join(outside, 'config'), 'utf8')).toBe('precious\n');
});

it('keeps what a discard saved in a backup folder and removes it when the undo expires', async () => {
  const { f, write, send } = await checkout();
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
