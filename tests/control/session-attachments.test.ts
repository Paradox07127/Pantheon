import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { Project, Session, UserTurn } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = ReturnType<typeof workbenchFixture>;

const attach = (f: Fixture, name: string, text: string, mime: string, projectId = f.project.id) =>
  f.control.addAttachment(user, projectId, name, mime, new TextEncoder().encode(text));

async function temporaryDirectory(f: Fixture, workspaceId: string): Promise<string> {
  const { writerTempDirectory } = await import('../../packages/control/dist/workspace-removal.js');
  const directory = writerTempDirectory(workspaceId);
  f.temporaryDirectories.push(directory);
  return directory;
}

async function idleSession(f: Fixture): Promise<Session> {
  const session = f.create();
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await temporaryDirectory(f, session.workspace_id!);
  await eventually(
    () => f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  return f.store.must<Session>('sessions', session.id);
}

const sendWith = (f: Fixture, session: Session, extra: Record<string, unknown>) =>
  f.call<Session>(
    'session.send',
    { session_id: session.id, input: 'Read the attachment', ...extra },
    session.revision,
  );

it('delivers copies of the attachments and the skills with the first turn and a later send', async () => {
  const f = workbenchFixture();
  const send = vi.spyOn(f.adapter, 'send');
  const image = attach(f, 'screen shot.png', 'png bytes', 'image/png');
  expect(image).toEqual({ id: image.id, name: 'screen shot.png', mime: 'image/png', size: 9 });
  const skills = [{ name: 'review', path: '/skills/review/SKILL.md' }];
  const session = f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Look at the screenshot',
    attachments: [image.id],
    skills,
  });
  const temporary = await temporaryDirectory(f, session.workspace_id!);
  const copy = path.join(temporary, 'attachments', `${image.id}-screen shot.png`);
  expect(f.turns(session.id)[0]).toMatchObject({
    attachments: [{ id: image.id, name: 'screen shot.png', mime: 'image/png', path: copy }],
    skills,
  });
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => send.mock.calls.length > 0,
    () => f.control.tick(),
  );
  expect(send.mock.calls[0]![1]).toEqual({
    turn_id: f.turns(session.id)[0]!.id,
    input: 'Look at the screenshot',
    attachments: [{ id: image.id, name: 'screen shot.png', mime: 'image/png', path: copy }],
    skills,
  });
  expect(readFileSync(copy, 'utf8')).toBe('png bytes');

  await eventually(
    () => f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  const notes = attach(f, 'notes.md', '# Notes\n', 'text/markdown');
  sendWith(f, f.store.must<Session>('sessions', session.id), { attachments: [notes.id] });
  await eventually(
    () => send.mock.calls.length > 1,
    () => f.control.tick(),
  );
  const delivered = send.mock.calls[1]![1] as UserTurn;
  expect(delivered).not.toHaveProperty('skills');
  expect(delivered.attachments).toEqual([
    {
      id: notes.id,
      name: 'notes.md',
      mime: 'text/markdown',
      path: path.join(temporary, 'attachments', `${notes.id}-notes.md`),
    },
  ]);
  expect(readFileSync(delivered.attachments![0]!.path, 'utf8')).toBe('# Notes\n');
});

it('stores an upload named like its mime record in another case under a plain file name', async () => {
  const f = workbenchFixture();
  const upload = attach(f, 'META.JSON', 'hello', 'text/plain');
  expect(upload).toMatchObject({ name: 'file', mime: 'text/plain', size: 5 });
  const session = f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Read the upload',
    attachments: [upload.id],
  });
  await temporaryDirectory(f, session.workspace_id!);
  const [attached] = f.turns(session.id)[0]!.attachments!;
  expect(attached).toMatchObject({ id: upload.id, name: 'file', mime: 'text/plain' });
  expect(readFileSync(attached!.path, 'utf8')).toBe('hello');
});

it('replaces links the session planted for attachment copies instead of writing through them', async () => {
  const f = workbenchFixture();
  const session = await idleSession(f);
  const temporary = await temporaryDirectory(f, session.workspace_id!);
  const outside = path.join(f.root, 'outside-folder'),
    protectedFile = path.join(f.root, 'protected.txt');
  mkdirSync(outside, { recursive: true });
  writeFileSync(protectedFile, 'original\n');
  mkdirSync(temporary, { recursive: true });
  symlinkSync(outside, path.join(temporary, 'attachments'));
  const notes = attach(f, 'notes.txt', 'attached\n', 'text/plain');
  sendWith(f, session, { attachments: [notes.id] });
  const copy = path.join(temporary, 'attachments', `${notes.id}-notes.txt`);
  expect(readdirSync(outside)).toEqual([]);
  expect(lstatSync(path.join(temporary, 'attachments')).isDirectory()).toBe(true);
  expect(readFileSync(copy, 'utf8')).toBe('attached\n');

  await eventually(
    () => f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  rmSync(copy);
  symlinkSync(protectedFile, copy);
  sendWith(f, f.store.must<Session>('sessions', session.id), { attachments: [notes.id] });
  expect(readFileSync(protectedFile, 'utf8')).toBe('original\n');
  expect(lstatSync(copy).isSymbolicLink()).toBe(false);
  expect(readFileSync(copy, 'utf8')).toBe('attached\n');
});

it('refuses an attachment id that is unknown or belongs to another project', async () => {
  const f = workbenchFixture();
  const session = await idleSession(f);
  const otherRoot = path.join(f.root, 'project/other');
  mkdirSync(otherRoot, { recursive: true });
  writeFileSync(path.join(otherRoot, 'readme.txt'), 'other\n');
  const other = f.call<Project>('project.open', { name: 'Other project', roots: [otherRoot] });
  const foreign = attach(f, 'secret.txt', 'secret', 'text/plain', other.id);
  for (const attachment of ['missing', foreign.id, `../${other.id}/${foreign.id}`])
    expect(() => sendWith(f, session, { attachments: [attachment] }), attachment).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    );
  expect(() =>
    f.call('session.create', {
      project_id: f.project.id,
      runtime: f.adapter.name,
      input: 'Look at it',
      attachments: [foreign.id],
    }),
  ).toThrow(expect.objectContaining({ code: 'not_found' }));
});

it('refuses attachments for a session without a worktree', () => {
  const f = workbenchFixture();
  const attachment = attach(f, 'notes.txt', 'notes', 'text/plain');
  const plain = f.store.insert<Session>('sessions', {
    id: 'plain-conversation',
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    state: 'open',
    turn_count: 0,
  });
  expect(() => sendWith(f, plain, { attachments: [attachment.id] })).toThrow(
    expect.objectContaining({ code: 'invalid_state' }),
  );
});

it('ranks file name matches, then path matches, then ordered characters, shorter paths first', () => {
  const f = workbenchFixture();
  const files = [
    'src/app.ts',
    'src/apple/x.ts',
    'test/unit/app.test.ts',
    'docs/map.md',
    'docs/api-plan.md',
    'out/a.ts',
    ...Array.from({ length: 60 }, (_, index) => `many/file-${String(index).padStart(2, '0')}.txt`),
  ];
  for (const file of files) {
    mkdirSync(path.dirname(path.join(f.source, file)), { recursive: true });
    writeFileSync(path.join(f.source, file), `${file}\n`);
  }
  writeFileSync(path.join(f.source, '.gitignore'), 'out/\n');
  git(f.source, 'add', '.');
  git(f.source, 'commit', '--quiet', '-m', 'Add files');
  writeFileSync(path.join(f.source, 'notes.txt'), 'untracked\n');
  const search = (q: string) => f.control.filesSearch(user, f.project.id, undefined, q);
  expect(search('APP')).toEqual([
    'src/app.ts',
    'test/unit/app.test.ts',
    'src/apple/x.ts',
    'docs/api-plan.md',
  ]);
  expect(search('a.ts')).not.toContain('out/a.ts');
  expect(search('notes')).toEqual(['notes.txt']);
  const all = search('');
  expect(all).toHaveLength(50);
  expect(all).not.toContain('out/a.ts');
});
