import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import {
  closeSync,
  constants,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { Principal, Session } from '@pantheon/domain';
import { agentEvent } from '../../packages/control/dist/agent.js';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { openInside } from '../../packages/control/dist/workspace-files.js';
import { awaitWorkspaceReady, user } from '../helpers.js';
import { boundTaskSession, workbenchFixture } from './workbench-fixture.js';

vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }));

const denied = expect.objectContaining({ code: 'permission_denied' });

function workerOf(f: ReturnType<typeof workbenchFixture>, session: Session): Principal {
  return {
    id: 'task-worker-credential',
    role: 'worker',
    project_id: f.project.id,
    session_id: session.id,
    expires_at: f.store.now() + 60_000,
  };
}

it('lets a task worker read only its own worktree, never another session or the project root', async () => {
  const f = workbenchFixture();
  const own = boundTaskSession(f, 'lead-of-the-task', 'task-under-test');
  const other = f.create('Draw something else');
  const ownWorkspace = await awaitWorkspaceReady(f.control, own.workspace_id!);
  const otherWorkspace = await awaitWorkspaceReady(f.control, other.workspace_id!);
  writeFileSync(path.join(ownWorkspace.path, 'mine.ts'), 'function mineSymbol() {}');
  writeFileSync(path.join(otherWorkspace.path, 'theirs.ts'), 'function theirsSymbol() {}');
  const worker = workerOf(f, own);
  expect(() => f.control.filesRead(worker, f.project.id, other.id, 'theirs.ts')).toThrow(denied);
  expect(() => f.control.filesList(worker, f.project.id, other.id, undefined)).toThrow(denied);
  expect(() => f.control.symbolsSearch(worker, f.project.id, other.id, 'theirs')).toThrow(denied);
  expect(() => f.control.filesRead(worker, f.project.id, undefined, 'answer.txt')).toThrow(denied);
  expect(f.control.filesRead(worker, f.project.id, own.id, 'mine.ts').text).toContain('mineSymbol');
  expect(f.control.filesRead(user, f.project.id, other.id, 'theirs.ts').text).toContain(
    'theirsSymbol',
  );
});

it('lets a task worker see only the images its own session tool calls returned', () => {
  const f = workbenchFixture();
  const own = boundTaskSession(f, 'lead-of-the-task', 'task-under-test');
  const other = f.create('Draw something else');
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 5, 6]);
  const hash = createHash('sha256').update(png).digest('hex');
  for (const session of [own, other])
    agentEvent(ctx, session.id, {
      key: `drawn-call-completed-${session.id}`,
      provider_sequence: 1,
      kind: 'tool.completed',
      tool_call_id: `drawn-call-${session.id}`,
      ok: true,
      images: [{ mime: 'image/png', data: png.toString('base64') }],
    });
  const image = { mime: 'image/png', data: png.toString('base64'), size: png.length };
  const worker = workerOf(f, own);
  expect(() => f.control.sessionToolImage(worker, other.id, hash)).toThrow(denied);
  expect(f.control.sessionToolImage(worker, own.id, hash)).toEqual(image);
  expect(f.control.sessionToolImage(user, other.id, hash)).toEqual(image);
});

it('refuses a session read of data its sandbox protects inside its own worktree', async () => {
  const f = workbenchFixture();
  const own = boundTaskSession(f, 'lead-of-the-task', 'task-under-test');
  const workspace = await awaitWorkspaceReady(f.control, own.workspace_id!);
  f.protectionPaths.backupDir = path.join(workspace.path, 'backups');
  mkdirSync(f.protectionPaths.backupDir);
  writeFileSync(path.join(f.protectionPaths.backupDir, 'saved.txt'), 'protected');
  expect(() =>
    f.control.filesRead(workerOf(f, own), f.project.id, own.id, 'backups/saved.txt'),
  ).toThrow(denied);
  expect(f.control.filesRead(user, f.project.id, own.id, 'backups/saved.txt').text).toBe(
    'protected',
  );
});

it('refuses a worktree whose registered folder was replaced by a symlink to another folder', async () => {
  const f = workbenchFixture();
  const session = f.create();
  const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
  const outside = path.join(f.root, 'outside');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'secret.txt'), 'outside secret');
  renameSync(workspace.path, `${workspace.path}-moved`);
  symlinkSync(outside, workspace.path);
  expect(() => f.control.filesRead(user, f.project.id, session.id, 'secret.txt')).toThrow(
    expect.objectContaining({ code: 'invalid_state' }),
  );
});

it('refuses to open a checked path whose parent became a symlink out of the workspace', () => {
  const f = workbenchFixture();
  const root = realpathSync(f.source);
  mkdirSync(path.join(root, 'notes'));
  writeFileSync(path.join(root, 'notes', 'plan.txt'), 'inside');
  const outside = path.join(f.root, 'outside');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'plan.txt'), 'outside secret');
  const checked = path.join(root, 'notes', 'plan.txt');
  const fd = openInside(root, checked, constants.O_RDONLY);
  expect(readFileSync(fd, 'utf8')).toBe('inside');
  closeSync(fd);
  renameSync(path.join(root, 'notes'), path.join(root, 'notes-moved'));
  symlinkSync(outside, path.join(root, 'notes'));
  expect(() => {
    const swapped = openInside(root, checked, constants.O_RDONLY);
    try {
      return readFileSync(swapped, 'utf8');
    } finally {
      closeSync(swapped);
    }
  }).toThrow(expect.objectContaining({ code: 'invalid_input' }));
});

it('skips a listed file deleted before its size is read', () => {
  const f = workbenchFixture();
  writeFileSync(path.join(f.source, 'vanishing.txt'), 'soon gone');
  const lstat = fs.lstatSync;
  vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike, options?: never) => {
    if (path.basename(String(target)) === 'vanishing.txt')
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    return lstat(target, options);
  }) as typeof fs.lstatSync);
  expect(f.control.filesList(user, f.project.id, undefined, undefined).entries).toEqual([
    { name: 'answer.txt', kind: 'file', size: 5 },
  ]);
});

it('refuses a session the repository working diff, which runs git outside its sandbox', async () => {
  const f = workbenchFixture();
  const own = boundTaskSession(f, 'lead-of-the-task', 'task-under-test');
  await awaitWorkspaceReady(f.control, own.workspace_id!);
  await expect(f.control.repoWorkingDiff(workerOf(f, own), f.project.id)).rejects.toThrow(denied);
  expect((await f.control.repoWorkingDiff(user, f.project.id)).files).toBeDefined();
});

it('refuses a session the repository reads, which span the project’s worktrees', async () => {
  const f = workbenchFixture();
  const own = boundTaskSession(f, 'lead-of-the-task', 'task-under-test');
  const workspace = await awaitWorkspaceReady(f.control, own.workspace_id!);
  const worker = workerOf(f, own);
  const project_id = f.project.id;
  const reads = (p: Principal) => [
    () => f.control.repoWorktrees(p, project_id),
    () => f.control.repoStatus(p, project_id, workspace.path),
    () => f.control.repoStatus(p, project_id, f.source),
    () => f.control.repoLog(p, { project_id, limit: 10, skip: 0 }),
    () => f.control.repoBlame(p, { project_id, path: 'answer.txt' }),
    () => f.control.repoFileHistory(p, { project_id, path: 'answer.txt' }),
  ];
  for (const read of reads(worker)) await expect(read()).rejects.toThrow(denied);
  for (const read of reads(user)) await expect(read()).resolves.toBeDefined();
});

it('lets a task worker search only its own worktree for file names', async () => {
  const f = workbenchFixture();
  const own = boundTaskSession(f, 'lead-of-the-task', 'task-under-test');
  const other = f.create('Draw something else');
  await awaitWorkspaceReady(f.control, own.workspace_id!);
  const otherWorkspace = await awaitWorkspaceReady(f.control, other.workspace_id!);
  writeFileSync(path.join(otherWorkspace.path, 'theirs.ts'), 'export {};');
  const worker = workerOf(f, own);
  await expect(f.control.filesSearch(worker, f.project.id, other.id, 'theirs')).rejects.toThrow(
    denied,
  );
  await expect(f.control.filesSearch(worker, f.project.id, undefined, 'answer')).rejects.toThrow(
    denied,
  );
  expect(await f.control.filesSearch(user, f.project.id, other.id, 'theirs')).toContain(
    'theirs.ts',
  );
});

it('refuses a protected file reached by swapping a checked folder for a link while it opens', async () => {
  const f = workbenchFixture();
  const own = boundTaskSession(f, 'lead-of-the-task', 'task-under-test');
  const workspace = await awaitWorkspaceReady(f.control, own.workspace_id!);
  f.protectionPaths.backupDir = path.join(workspace.path, 'backups');
  mkdirSync(f.protectionPaths.backupDir);
  writeFileSync(path.join(f.protectionPaths.backupDir, 'saved.txt'), 'protected');
  mkdirSync(path.join(workspace.path, 'public'));
  writeFileSync(path.join(workspace.path, 'public', 'saved.txt'), 'public');
  const open = fs.openSync;
  const spy = vi.spyOn(fs, 'openSync').mockImplementation(((
    file: fs.PathLike,
    flags?: fs.OpenMode,
    mode?: fs.Mode,
  ) => {
    if (String(file).endsWith(path.join('public', 'saved.txt'))) {
      spy.mockRestore();
      renameSync(path.join(workspace.path, 'public'), path.join(workspace.path, 'public-moved'));
      symlinkSync(f.protectionPaths.backupDir!, path.join(workspace.path, 'public'));
    }
    return open(file, flags!, mode);
  }) as typeof fs.openSync);
  try {
    expect(() =>
      f.control.filesRead(workerOf(f, own), f.project.id, own.id, 'public/saved.txt'),
    ).toThrow(denied);
  } finally {
    spy.mockRestore();
  }
});
