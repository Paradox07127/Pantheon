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
import { workbenchFixture } from './workbench-fixture.js';

vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }));

const denied = expect.objectContaining({ code: 'permission_denied' });

/** A session whose credential reads project files: one that sets up the project, in a worktree. */
const setupSession = (f: Awaited<ReturnType<typeof workbenchFixture>>) =>
  f.call<Promise<Session>>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Set up the project',
    purpose: 'project_setup',
  });

function credentialOf(
  f: Awaited<ReturnType<typeof workbenchFixture>>,
  session: Session,
): Principal {
  return {
    id: 'project-setup-credential',
    role: 'planner',
    project_id: f.project.id,
    session_id: session.id,
    expires_at: f.store.now() + 60_000,
  };
}

it('lets a project setup session read only its own worktree, never another session or the project root', async () => {
  const f = await workbenchFixture();
  const own = await setupSession(f);
  const other = await f.create('Draw something else');
  const ownWorkspace = await awaitWorkspaceReady(f.control, own.workspace_id!);
  const otherWorkspace = await awaitWorkspaceReady(f.control, other.workspace_id!);
  writeFileSync(path.join(ownWorkspace.path, 'mine.ts'), 'function mineSymbol() {}');
  writeFileSync(path.join(otherWorkspace.path, 'theirs.ts'), 'function theirsSymbol() {}');
  const reader = credentialOf(f, own);
  expect(() => f.control.filesRead(reader, f.project.id, other.id, 'theirs.ts')).toThrow(denied);
  expect(() => f.control.filesList(reader, f.project.id, other.id, undefined)).toThrow(denied);
  expect(() => f.control.filesList(reader, f.project.id, undefined, undefined)).toThrow(denied);
  expect(() => f.control.symbolsSearch(reader, f.project.id, other.id, 'theirs')).toThrow(denied);
  expect(() => f.control.filesRead(reader, f.project.id, undefined, 'answer.txt')).toThrow(denied);
  expect(f.control.filesRead(reader, f.project.id, own.id, 'mine.ts').text).toContain('mineSymbol');
  expect(f.control.filesRead(user, f.project.id, other.id, 'theirs.ts').text).toContain(
    'theirsSymbol',
  );
});

it('lets a project setup session see only the images its own session tool calls returned', async () => {
  const f = await workbenchFixture();
  const own = await setupSession(f);
  const other = await f.create('Draw something else');
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
  const reader = credentialOf(f, own);
  expect(() => f.control.sessionToolImage(reader, other.id, hash)).toThrow(denied);
  expect(f.control.sessionToolImage(reader, own.id, hash)).toEqual(image);
  expect(f.control.sessionToolImage(user, other.id, hash)).toEqual(image);
});

it('refuses a session read of data its sandbox protects inside its own worktree', async () => {
  const f = await workbenchFixture();
  const own = await setupSession(f);
  const workspace = await awaitWorkspaceReady(f.control, own.workspace_id!);
  f.protectionPaths.backupDir = path.join(workspace.path, 'backups');
  mkdirSync(f.protectionPaths.backupDir);
  writeFileSync(path.join(f.protectionPaths.backupDir, 'saved.txt'), 'protected');
  expect(() =>
    f.control.filesRead(credentialOf(f, own), f.project.id, own.id, 'backups/saved.txt'),
  ).toThrow(denied);
  expect(() => f.control.filesList(credentialOf(f, own), f.project.id, own.id, 'backups')).toThrow(
    denied,
  );
  expect(f.control.filesRead(user, f.project.id, own.id, 'backups/saved.txt').text).toBe(
    'protected',
  );
});

it('refuses a worktree whose registered folder was replaced by a symlink to another folder', async () => {
  const f = await workbenchFixture();
  const session = await f.create();
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

it('refuses to open a checked path whose parent became a symlink out of the workspace', async () => {
  const f = await workbenchFixture();
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

it('skips a listed file deleted before its size is read', async () => {
  const f = await workbenchFixture();
  writeFileSync(path.join(f.source, 'vanishing.txt'), 'soon gone');
  const lstat = fs.lstatSync;
  vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike, options?: never) => {
    if (path.basename(String(target)) === 'vanishing.txt')
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    return lstat(target, options);
  }) as typeof fs.lstatSync);
  expect((await f.control.filesList(user, f.project.id, undefined, undefined)).entries).toEqual([
    { name: 'answer.txt', kind: 'file', size: 5 },
  ]);
});

it('lists the checked folder even when it is swapped for a link to a protected one while it is read', async () => {
  const f = await workbenchFixture();
  const own = await setupSession(f);
  const workspace = await awaitWorkspaceReady(f.control, own.workspace_id!);
  f.protectionPaths.backupDir = path.join(workspace.path, 'backups');
  mkdirSync(path.join(f.protectionPaths.backupDir, 'private-keys'), { recursive: true });
  writeFileSync(path.join(f.protectionPaths.backupDir, 'saved.txt'), 'protected');
  const folder = path.join(workspace.path, 'public');
  mkdirSync(folder);
  writeFileSync(path.join(folder, 'saved.txt'), 'public');
  // Points the checked folder at the protected one only while each read runs.
  const swapped =
    <T>(read: (...args: never[]) => T) =>
    (...args: never[]): T => {
      renameSync(folder, `${folder}-moved`);
      symlinkSync(f.protectionPaths.backupDir!, folder);
      try {
        return read(...args);
      } finally {
        fs.unlinkSync(folder);
        renameSync(`${folder}-moved`, folder);
      }
    };
  const readdirSync = swapped(fs.readdirSync) as typeof fs.readdirSync,
    lstatSync = swapped(fs.lstatSync) as typeof fs.lstatSync;
  const readdir = vi.spyOn(fs, 'readdirSync').mockImplementation(readdirSync);
  const lstat = vi.spyOn(fs, 'lstatSync').mockImplementation(lstatSync);
  try {
    expect(
      (await f.control.filesList(credentialOf(f, own), f.project.id, own.id, 'public')).entries,
    ).toEqual([{ name: 'saved.txt', kind: 'file', size: 6 }]);
  } finally {
    readdir.mockRestore();
    lstat.mockRestore();
  }
});

it('lets a project setup session search only its own worktree for file names', async () => {
  const f = await workbenchFixture();
  const own = await setupSession(f);
  const other = await f.create('Draw something else');
  await awaitWorkspaceReady(f.control, own.workspace_id!);
  const otherWorkspace = await awaitWorkspaceReady(f.control, other.workspace_id!);
  writeFileSync(path.join(otherWorkspace.path, 'theirs.ts'), 'export {};');
  const reader = credentialOf(f, own);
  await expect(f.control.filesSearch(reader, f.project.id, other.id, 'theirs')).rejects.toThrow(
    denied,
  );
  await expect(f.control.filesSearch(reader, f.project.id, undefined, 'answer')).rejects.toThrow(
    denied,
  );
  expect(await f.control.filesSearch(user, f.project.id, other.id, 'theirs')).toContain(
    'theirs.ts',
  );
});

it('refuses a protected file reached by swapping a checked folder for a link while it opens', async () => {
  const f = await workbenchFixture();
  const own = await setupSession(f);
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
      f.control.filesRead(credentialOf(f, own), f.project.id, own.id, 'public/saved.txt'),
    ).toThrow(denied);
  } finally {
    spy.mockRestore();
  }
});
