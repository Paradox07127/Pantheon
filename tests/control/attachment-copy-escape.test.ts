import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { Session } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

// The directory to replace with a link to the outside folder right after it is created.
const swap = vi.hoisted(() => ({ directory: '', outside: '' }));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const mkdir = ((directory: string, options?: Parameters<typeof fs.mkdirSync>[1]) => {
    const made = fs.mkdirSync(directory, options);
    if (swap.directory && directory === swap.directory) {
      fs.rmSync(directory, { recursive: true, force: true });
      fs.symlinkSync(swap.outside, directory);
    }
    return made;
  }) as typeof fs.mkdirSync;
  return { ...fs, default: { ...fs, mkdirSync: mkdir }, mkdirSync: mkdir };
});

it('refuses to copy an attachment through a directory the session replaced with a link', async () => {
  const f = await workbenchFixture();
  const { writerTempDirectory } = await import('../../packages/control/dist/workspace-removal.js');
  const session = await f.create();
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  const temporary = writerTempDirectory(session.workspace_id!);
  f.temporaryDirectories.push(temporary);
  await eventually(
    () => f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  const outside = path.join(f.root, 'outside-folder');
  mkdirSync(outside, { recursive: true });
  const notes = f.control.addAttachment(
    user,
    f.project.id,
    'notes.txt',
    'text/plain',
    new TextEncoder().encode('attached\n'),
  );
  Object.assign(swap, { directory: path.join(temporary, 'attachments'), outside });

  try {
    expect(() =>
      f.call<Session>(
        'session.send',
        { session_id: session.id, input: 'Read the attachment', attachments: [notes.id] },
        f.store.must<Session>('sessions', session.id).revision,
      ),
    ).toThrow(expect.objectContaining({ code: 'sandbox_path_replaced' }));
  } finally {
    swap.directory = '';
  }
  expect(readdirSync(outside)).toEqual([]);
});

it('removes nothing in the folder a replaced attachments directory points to', async () => {
  const f = await workbenchFixture();
  const { writerTempDirectory } = await import('../../packages/control/dist/workspace-removal.js');
  const session = await f.create();
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  const temporary = writerTempDirectory(session.workspace_id!);
  f.temporaryDirectories.push(temporary);
  await eventually(
    () => f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  const outside = path.join(f.root, 'other-folder');
  mkdirSync(outside, { recursive: true });
  const notes = f.control.addAttachment(
    user,
    f.project.id,
    'notes.txt',
    'text/plain',
    new TextEncoder().encode('attached\n'),
  );
  const kept = path.join(outside, `${notes.id}-notes.txt`);
  writeFileSync(kept, "not the session's to remove\n");
  Object.assign(swap, { directory: path.join(temporary, 'attachments'), outside });
  try {
    expect(() =>
      f.call<Session>(
        'session.send',
        { session_id: session.id, input: 'Read the attachment', attachments: [notes.id] },
        f.store.must<Session>('sessions', session.id).revision,
      ),
    ).toThrow(expect.objectContaining({ code: 'sandbox_path_replaced' }));
  } finally {
    swap.directory = '';
  }
  expect(existsSync(kept)).toBe(true);
});
