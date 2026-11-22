import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import type { Project, Session } from '@pantheon/domain';
import { gateFiles } from '../../packages/control/src/landing.js';
import * as validation from '../../packages/control/dist/validation-executor.js';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

afterEach(() => {
  vi.restoreAllMocks();
});

function repositoryWith(files: string[]): string {
  const repository = mkdtempSync(path.join(os.tmpdir(), 'gate-files-'));
  onTestFinished(() => rmSync(repository, { recursive: true, force: true }));
  git(repository, 'init', '--quiet');
  for (const file of files) {
    mkdirSync(path.dirname(path.join(repository, file)), { recursive: true });
    writeFileSync(path.join(repository, file), 'contents\n');
  }
  git(repository, 'add', '-A');
  git(repository, 'commit', '--quiet', '-m', 'Files');
  return repository;
}

it('protects by default the repository files the gate argv and its shell scripts name', async () => {
  const repository = repositoryWith([
    'scripts/check.sh',
    'tools/run.mjs',
    'vitest.config.ts',
    'notes.txt',
    'tests/a.test.ts',
  ]);
  const commands = [
    { name: 'Script', argv: ['sh', '-c', "sh ./scripts/check.sh && node 'tools/run.mjs'; echo"] },
    { name: 'Tests', argv: ['vitest', 'run', '--config', 'vitest.config.ts', 'tests'] },
    { name: 'Missing', argv: ['node', 'missing.mjs', '/etc/hosts', '../outside.txt'] },
  ];
  expect((await gateFiles(repository, ['HEAD'], commands)).sort()).toEqual([
    'scripts/check.sh',
    'tools/run.mjs',
    'vitest.config.ts',
  ]);
});

it.each([
  ['a name that starts with two dots', ['sh', '..checks/verify.sh'], '..checks/verify.sh'],
  [
    'the value of an option written with =',
    ['vitest', '--config=vitest.config.ts'],
    'vitest.config.ts',
  ],
  ['a script whose name holds a space', ['sh', 'scripts/my check.sh'], 'scripts/my check.sh'],
  ['a literal script name that ends in a semicolon', ['sh', 'scripts/check;'], 'scripts/check;'],
])('protects %s', async (_case, argv, file) => {
  const repository = repositoryWith([file, 'notes.txt']);
  expect(await gateFiles(repository, ['HEAD'], [{ name: 'Gate', argv }])).toEqual([file]);
});

const gateResult = (exitCode: number): validation.ValidationResult => ({
  exit_code: exitCode,
  timedOut: false,
  signal: null,
  duration_ms: 1,
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
  log: Buffer.alloc(0),
  tail: '',
  stdout_sha256: '',
  stderr_sha256: '',
  output_truncated: false,
});

/** A turn input the fixture runtime runs as these steps. */
const script = (...steps: object[]) => `fixture-script\n${JSON.stringify(steps)}`;

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);

/** Runs a turn of the session and waits until it ended and the session is open again. */
async function turn(f: Fixture, sessionId: string, input: string) {
  const before = f.turns(sessionId).length;
  await f.call('session.send', { session_id: sessionId, input }, current(f, sessionId).revision);
  await eventually(
    () =>
      f.turns(sessionId).length > before &&
      f.turns(sessionId).every((each) => !['queued', 'running'].includes(each.state)) &&
      current(f, sessionId).state === 'open',
    () => f.control.tick(),
    10000,
  );
}

/** Merges the session and waits until it landed or its merge stopped. */
async function merge(f: Fixture, sessionId: string, allowGateChange = false) {
  await f.call(
    'session.merge',
    { session_id: sessionId, ...(allowGateChange ? { allow_gate_change: true } : {}) },
    current(f, sessionId).revision,
  );
  await eventually(
    () =>
      current(f, sessionId).outcome === 'merged' ||
      current(f, sessionId).merge?.state === 'blocked',
    () => f.control.tick(),
    10000,
  );
}

it.each([
  ['changes only other files', 'answer.txt', null, undefined],
  ['changes the gate file again', 'scripts/check.cjs', ['scripts/check.cjs'], undefined],
  [
    'changes another protected file',
    'config/deploy.json',
    ['config/deploy.json', 'scripts/check.cjs'],
    undefined,
  ],
  ['makes the gate file executable', 'answer.txt', ['scripts/check.cjs'], 'executable'],
  [
    'changes only other files after a rebase onto another change to the gate file',
    'answer.txt',
    null,
    'source moved',
  ],
] as const)(
  'after the gate fails on a gate file change the user allowed, a fix that %s asks again only for a new protected change',
  async (_name, fixed, asked, twist) => {
    const f = await workbenchFixture();
    mkdirSync(path.join(f.source, 'scripts'));
    writeFileSync(path.join(f.source, 'scripts/check.cjs'), '// check\n\n\nprocess.exit(1)\n');
    git(f.source, 'add', '--', 'scripts/check.cjs');
    git(f.source, 'commit', '--quiet', '-m', 'Add the check');
    vi.spyOn(validation, 'runValidationCommand')
      .mockResolvedValue(gateResult(0))
      .mockResolvedValueOnce(gateResult(1));
    const session = await f.create();
    const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
    await eventually(
      () =>
        f.turns(session.id)[0]!.state === 'completed' && current(f, session.id).state === 'open',
      () => f.control.tick(),
    );
    await f.call<Project>(
      'project.gate.set',
      {
        project_id: f.project.id,
        root: f.source,
        commands: [{ name: 'Checks', argv: ['node', 'scripts/check.cjs'] }],
        protected_paths: ['config'],
      },
      f.store.must<Project>('projects', f.project.id).revision,
    );
    await turn(
      f,
      session.id,
      script(
        { write: { path: 'scripts/check.cjs', text: '// check\n\n\nprocess.exit(0)\n' } },
        { commit: 'Pass the check' },
      ),
    );
    if (twist === 'source moved') {
      writeFileSync(
        path.join(f.source, 'scripts/check.cjs'),
        '// the check\n\n\nprocess.exit(1)\n',
      );
      git(f.source, 'commit', '--quiet', '-am', 'Name the check');
    }
    await merge(f, session.id, true);
    expect(current(f, session.id).merge).toMatchObject({ state: 'blocked', reason: 'gate_failed' });
    await turn(
      f,
      session.id,
      script({ write: { path: fixed, text: 'fixed\n' } }, { commit: 'Fix the failure' }),
    );
    if (twist === 'executable') {
      chmodSync(path.join(workspace.path, 'scripts/check.cjs'), 0o755);
      git(workspace.path, 'add', '--', 'scripts/check.cjs');
      git(workspace.path, 'commit', '--quiet', '-m', 'Make the check executable');
    }
    const head = git(workspace.path, 'rev-parse', 'HEAD');
    const before = git(f.source, 'rev-parse', 'main');
    await merge(f, session.id);
    if (!asked) {
      expect(current(f, session.id)).toMatchObject({ outcome: 'merged' });
      if (twist === 'source moved')
        expect(git(f.source, 'show', 'main:scripts/check.cjs')).toBe(
          '// the check\n\n\nprocess.exit(0)',
        );
      else expect(git(f.source, 'rev-parse', 'main')).toBe(head);
      return;
    }
    expect(current(f, session.id).merge).toEqual({
      state: 'blocked',
      reason: 'gate_files_changed',
      conflicts: asked,
    });
    expect(git(f.source, 'rev-parse', 'main')).toBe(before);
    await f.control.prefetchWorktreeReads(user, f.project.id);
    expect(
      f.control.needsYou(user, f.project.id).items.find((item) => item.source.id === session.id),
    ).toMatchObject({ files: asked });
  },
);
