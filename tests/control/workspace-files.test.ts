import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { Project, Session } from '@pantheon/domain';
import { agentEvent } from '../../packages/control/dist/agent.js';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { awaitWorkspaceReady, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

it('searches the project folder for a resident session without a workspace', async () => {
  const f = await workbenchFixture();
  const resident = f.call<Session>('resident.open', {
    project_id: f.project.id,
    kind: 'assistant',
  });
  expect(await f.control.filesSearch(user, f.project.id, resident.id, 'answer')).toEqual([
    'answer.txt',
  ]);
});

it('reads text, empty and binary files and truncates UTF-8 at a character boundary', async () => {
  const f = await workbenchFixture();
  const read = (file: string) => f.control.filesRead(user, f.project.id, undefined, file);
  expect(read('answer.txt')).toEqual({
    path: 'answer.txt',
    text: 'base\n',
    size: 5,
    truncated: false,
  });
  writeFileSync(path.join(f.source, 'empty.txt'), '');
  expect(read('empty.txt')).toMatchObject({ text: '', size: 0, truncated: false });
  const limit = 256 * 1024;
  writeFileSync(path.join(f.source, 'exact.txt'), 'x'.repeat(limit));
  expect(read('exact.txt')).toMatchObject({ text: 'x'.repeat(limit), truncated: false });
  writeFileSync(path.join(f.source, 'unicode.txt'), 'x'.repeat(limit - 1) + '😀tail');
  expect(read('unicode.txt')).toEqual({
    path: 'unicode.txt',
    text: 'x'.repeat(limit - 1),
    size: limit + 7,
    truncated: true,
  });
  writeFileSync(
    path.join(f.source, 'binary.bin'),
    Buffer.concat([Buffer.alloc(8191, 65), Buffer.from([0, 65])]),
  );
  expect(read('binary.bin')).toEqual({
    path: 'binary.bin',
    binary: true,
    size: 8193,
    truncated: false,
  });
  writeFileSync(
    path.join(f.source, 'late-nul.txt'),
    Buffer.concat([Buffer.alloc(8192, 65), Buffer.from([0])]),
  );
  expect(read('late-nul.txt')).toHaveProperty('text');
});

it('reads images and PDFs whole as base64 with their type, and past the preview limit only their size', async () => {
  const f = await workbenchFixture();
  const read = (file: string) => f.control.filesRead(user, f.project.id, undefined, file);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  writeFileSync(path.join(f.source, 'chart.png'), png);
  expect(read('chart.png')).toEqual({
    path: 'chart.png',
    mime: 'image/png',
    data: png.toString('base64'),
    size: png.length,
    truncated: false,
  });
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  writeFileSync(path.join(f.source, 'logo.SVG'), svg);
  expect(read('logo.SVG')).toMatchObject({
    mime: 'image/svg+xml',
    data: Buffer.from(svg).toString('base64'),
  });
  expect(read('logo.SVG')).not.toHaveProperty('text');
  const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(300 * 1024, 1)]);
  writeFileSync(path.join(f.source, 'report.pdf'), pdf);
  expect(read('report.pdf')).toMatchObject({
    mime: 'application/pdf',
    data: pdf.toString('base64'),
    truncated: false,
  });
  writeFileSync(path.join(f.source, 'huge.jpg'), Buffer.alloc(8 * 1024 * 1024 + 1));
  expect(read('huge.jpg')).toEqual({
    path: 'huge.jpg',
    mime: 'image/jpeg',
    size: 8 * 1024 * 1024 + 1,
    truncated: true,
  });
});

it('uses the session worktree for all queries and enforces project access and ownership', async () => {
  const f = await workbenchFixture();
  const session = await f.create();
  const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
  writeFileSync(path.join(f.source, 'source-only.ts'), 'function sourceOnly() {}');
  writeFileSync(path.join(workspace.path, 'local.ts'), 'function localSymbol() {}');
  expect(f.control.filesRead(user, f.project.id, session.id, 'local.ts').text).toContain(
    'localSymbol',
  );
  expect(await f.control.symbolsSearch(user, f.project.id, session.id, 'local')).toEqual({
    symbols: [{ name: 'localSymbol', kind: 'function', path: 'local.ts', line: 1 }],
  });
  const otherRoot = path.join(f.root, 'other');
  mkdirSync(otherRoot);
  const other = await f.call<Project>('project.open', { name: 'Other', roots: [otherRoot] });
  const queries = [
    (project: string, sessionId: string | undefined, principal = user) =>
      f.control.filesRead(principal, project, sessionId, 'answer.txt'),
    (project: string, sessionId: string | undefined, principal = user) =>
      f.control.symbolsSearch(principal, project, sessionId, ''),
  ];
  const plain = f.store.insert<Session>('sessions', {
    id: 'plain-conversation',
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    state: 'open',
    turn_count: 0,
  });
  // A session without a workspace reads the project folder.
  expect(f.control.filesRead(user, f.project.id, plain.id, 'source-only.ts').text).toContain(
    'sourceOnly',
  );
  for (const query of queries) {
    expect(() => query(other.id, session.id)).toThrow(
      expect.objectContaining({ code: 'permission_denied' }),
    );
    expect(() => query(f.project.id, undefined, { id: 'foreign', role: 'writer' })).toThrow(
      expect.objectContaining({ code: 'permission_denied' }),
    );
  }
});

it('rejects parent traversal, absolute paths and symlinks escaping the workspace', async () => {
  const f = await workbenchFixture();
  const outside = path.join(f.root, 'outside');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'secret.ts'), 'function secretSymbol() {}');
  symlinkSync(outside, path.join(f.source, 'escape'));
  symlinkSync(path.join(outside, 'secret.ts'), path.join(f.source, 'escape.ts'));
  for (const file of [
    '../outside/secret.ts',
    path.join(outside, 'secret.ts'),
    'escape/secret.ts',
    'escape.ts',
  ])
    expect(() => f.control.filesRead(user, f.project.id, undefined, file)).toThrow(
      expect.objectContaining({ code: 'invalid_input' }),
    );
  await expect(f.control.symbolsSearch(user, f.project.id, undefined, 'secret')).rejects.toThrow(
    expect.objectContaining({ code: 'invalid_input' }),
  );
});

it('refuses a named pipe without waiting for a writer', async () => {
  const f = await workbenchFixture();
  const pipe = path.join(f.source, 'agent.fifo');
  execFileSync('mkfifo', [pipe]);
  // Opens the pipe for writing later, so a read that waits for a writer still returns.
  const writer = spawn('/bin/sh', ['-c', 'sleep 2; : > "$0"', pipe], { stdio: 'ignore' });
  const exited = new Promise((resolve) => writer.once('exit', resolve));
  const started = Date.now();
  try {
    expect(() => f.control.filesRead(user, f.project.id, undefined, 'agent.fifo')).toThrow(
      expect.objectContaining({ code: 'invalid_input' }),
    );
    expect(Date.now() - started).toBeLessThan(1000);
  } finally {
    const reader = openSync(pipe, constants.O_RDONLY | constants.O_NONBLOCK);
    await exited;
    closeSync(reader);
  }
});

it('searches declarations across supported languages, including untracked files, with a fifty symbol limit', async () => {
  const f = await workbenchFixture();
  const sources = {
    'types.ts':
      'export function findThing() {}\nexport class FindClass {}\nexport interface FindInterface {}\nexport type FindType = string;\nconst FindValue = "not a declaration";',
    'script.js': 'async function findScript() {}\nclass FindScript {}',
    'module.py': 'async def find_python():\n    pass\nclass FindPython:\n    pass',
    'main.go':
      'func findGo() {}\nfunc (r *Receiver) findMethod() {}\ntype FindStruct struct {}\ntype FindContract interface {}',
    'lib.rs':
      'pub async fn find_rust() {}\npub struct FindRust {}\npub enum FindEnum {}\npub trait FindTrait {}\npub type FindAlias = u32;',
    'App.swift':
      'public func findSwift() {}\nclass FindSwift {}\nstruct FindRecord {}\nenum FindChoice {}\nprotocol FindProtocol {}\ntypealias FindAlias = String',
  };
  for (const [file, text] of Object.entries(sources))
    writeFileSync(path.join(f.source, file), text);
  git(f.source, 'add', 'types.ts');
  writeFileSync(path.join(f.source, '.gitignore'), 'ignored.ts\n');
  writeFileSync(path.join(f.source, 'ignored.ts'), 'function findIgnored() {}');
  const { symbols } = await f.control.symbolsSearch(user, f.project.id, undefined, 'FIND');
  expect(symbols).toHaveLength(23);
  for (const [file, text] of Object.entries(sources)) {
    for (const [index, line] of text.split('\n').entries()) {
      if (line.includes('pass') || line.includes('FindValue')) continue;
      expect(symbols).toContainEqual(expect.objectContaining({ path: file, line: index + 1 }));
    }
  }
  expect(symbols).toContainEqual({
    name: 'FindInterface',
    kind: 'interface',
    path: 'types.ts',
    line: 3,
  });
  expect(symbols).toContainEqual({
    name: 'findMethod',
    kind: 'function',
    path: 'main.go',
    line: 2,
  });
  expect(await f.control.symbolsSearch(user, f.project.id, undefined, 'absent')).toEqual({
    symbols: [],
  });
  writeFileSync(
    path.join(f.source, 'many.ts'),
    Array.from({ length: 60 }, (_, index) => `function found${index}() {}`).join('\n'),
  );
  expect(
    (await f.control.symbolsSearch(user, f.project.id, undefined, 'found')).symbols,
  ).toHaveLength(50);
});

it('skips a source file too large to search', async () => {
  const f = await workbenchFixture();
  writeFileSync(path.join(f.source, 'small.ts'), 'function findSmall() {}');
  writeFileSync(
    path.join(f.source, 'generated.ts'),
    'function findGenerated() {}\n' + '//'.repeat(1024 * 1024),
  );
  expect(await f.control.symbolsSearch(user, f.project.id, undefined, 'find')).toEqual({
    symbols: [{ name: 'findSmall', kind: 'function', path: 'small.ts', line: 1 }],
  });
});

it('records a returned image by the hash of its stored bytes and reads it back only for its own session', async () => {
  const f = await workbenchFixture();
  const session = await f.create();
  const other = await f.create('Draw something else');
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const hash = createHash('sha256').update(png).digest('hex');
  agentEvent(ctx, session.id, {
    key: 'drawn-call-completed',
    provider_sequence: 1,
    kind: 'tool.completed',
    tool_call_id: 'drawn-call',
    ok: true,
    images: [{ mime: 'image/png', data: png.toString('base64') }],
  });
  const recorded = f.store
    .kindEvents(f.project.id, ['agent.tool.completed'])
    .find((event) => (event.payload as { tool_call_id?: string }).tool_call_id === 'drawn-call');
  expect((recorded!.payload as { images: unknown }).images).toEqual([
    { mime: 'image/png', hash, size: png.length },
  ]);
  const image = { mime: 'image/png', data: png.toString('base64'), size: png.length };
  expect(f.control.sessionToolImage(user, session.id, hash)).toEqual(image);
  expect(() => f.control.sessionToolImage(user, other.id, hash)).toThrow(
    expect.objectContaining({ code: 'not_found' }),
  );
  expect(() => f.control.sessionToolImage(user, session.id, 'a'.repeat(64))).toThrow(
    expect.objectContaining({ code: 'not_found' }),
  );
  expect(() =>
    f.control.sessionToolImage({ id: 'foreign', role: 'writer' }, session.id, hash),
  ).toThrow(expect.objectContaining({ code: 'permission_denied' }));
  // The restart collects the stored files no row names; the image's event names it.
  const orphan = ctx.files.put(Buffer.from('named by no row')).uri;
  await f.restart();
  expect(existsSync(orphan)).toBe(false);
  expect(f.control.sessionToolImage(user, session.id, hash)).toEqual(image);
});
