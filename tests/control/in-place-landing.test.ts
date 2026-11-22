import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import {
  credentialRole,
  type Project,
  type Session,
  type SessionSpec,
  type Workspace,
} from '@pantheon/domain';
import * as validation from '../../packages/control/dist/validation-executor.js';
import { eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const passed = (): validation.ValidationResult => ({
  exit_code: 0,
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
const writeAndCommit = script(
  { write: { path: 'notes.txt', text: 'notes\n' } },
  { commit: 'Add notes' },
);

const refusal = async (run: () => unknown) => {
  try {
    await run();
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error('Expected a refusal');
};

const current = (f: Fixture, id: string) => f.store.must<Session>('sessions', id);
const head = (f: Fixture) => git(f.source, 'rev-parse', 'HEAD').trim();

async function folderSession(f: Fixture, input = writeAndCommit, workspace = 'auto') {
  const session = await f.call<Promise<Session>>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input,
    workspace,
  });
  await eventually(
    () => f.turns(session.id).every((turn) => !['queued', 'running'].includes(turn.state)),
    () => f.control.tick(),
  );
  return current(f, session.id);
}

async function withGate(f: Fixture) {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(passed());
  await f.call(
    'project.gate.set',
    { project_id: f.project.id, root: f.source, commands: [{ name: 'check', argv: ['check'] }] },
    f.store.must<Project>('projects', f.project.id).revision,
  );
}

async function runGates(f: Fixture, id: string) {
  await f.call('session.gates.run', { session_id: id }, current(f, id).revision);
  await eventually(
    () => !f.control.sessionGates(user, id).running,
    () => f.control.tick(),
  );
}

const land = (f: Fixture, id: string) =>
  f.call<Promise<Session>>('session.merge', { session_id: id }, current(f, id).revision);

it('records the folder HEAD a new folder session opens on and keeps its commit in the diff', async () => {
  const f = await workbenchFixture();
  const before = head(f);
  const session = await folderSession(f);
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
  expect(workspace).toMatchObject({ kind: 'in_place', path: realpathSync(f.source) });
  expect(session.in_place).toEqual({ base_sha: before });
  expect(head(f)).not.toBe(before);
  const diff = await f.control.sessionDiff(user, session.id);
  expect(diff.base_sha).toBe(before);
  expect(diff.files.map((file) => file.path)).toEqual(['notes.txt']);
  await f.prefetch();
  expect(f.list().find((row) => row.id === session.id)).toMatchObject({
    lands: true,
    holds_folder: true,
    state: 'ready',
    changes: { files: 1 },
  });
});

it('runs a new folder session the user opened without Pantheon tools, text or memory', async () => {
  const f = await workbenchFixture();
  Object.assign(f.adapter, { questionTool: 'ask_human' });
  Object.assign(f.control['ctx'], {
    issueSessionCredential: () => ({
      token_file: path.join(f.root, 'token'),
      daemon_url: 'http://127.0.0.1:1',
    }),
  });
  const draft = f.call<{ id: string; revision: number }>('memory.propose', {
    project_id: f.project.id,
    key: 'language',
    kind: 'decision',
    text: 'Use precise terminology',
  });
  f.call('memory.commit', { memory_id: draft.id }, draft.revision);
  const send = vi.spyOn(f.adapter, 'send');
  const session = await folderSession(f, 'Look around');
  const spec = f.start.mock.calls.at(-1)![0] as SessionSpec;
  expect(spec.pantheon_mcp).toBeUndefined();
  expect(spec.control_instructions ?? '').toBe('');
  expect(send.mock.calls[0]![1].input).not.toContain('[Pantheon current project memory]');
});

it('runs the gates of a new folder session and lands it on the current branch once they pass', async () => {
  const f = await workbenchFixture();
  await withGate(f);
  const session = await folderSession(f);
  expect(f.list().find((row) => row.id === session.id)?.gate).toBeUndefined();
  expect((await refusal(() => land(f, session.id))).code).toBe('gate_required');
  await runGates(f, session.id);
  expect(f.control.sessionGates(user, session.id).last?.commit).toBe(head(f));
  const preflight = await f.control.sessionPreflight(user, session.id);
  expect(preflight).toMatchObject({
    target_branch: 'main',
    commit_count: 1,
    files_changed: 1,
    gate: { last: 'passed' },
    can_merge: true,
  });
  const landed = head(f);
  await land(f, session.id);
  expect(current(f, session.id)).toMatchObject({ outcome: 'merged', state: 'closed' });
  expect(head(f)).toBe(landed);
  expect(git(f.source, 'branch', '--show-current').trim()).toBe('main');
});

it('holds a folder session that changed a gate file for the user, and lands it once allowed', async () => {
  const f = await workbenchFixture();
  mkdirSync(path.join(f.source, 'scripts'));
  writeFileSync(path.join(f.source, 'scripts/check.cjs'), 'process.exit(1)\n');
  git(f.source, 'add', 'scripts/check.cjs');
  git(f.source, 'commit', '--quiet', '-m', 'Add the check');
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(passed());
  await f.call(
    'project.gate.set',
    {
      project_id: f.project.id,
      root: f.source,
      commands: [{ name: 'check', argv: ['node', 'scripts/check.cjs'] }],
    },
    f.store.must<Project>('projects', f.project.id).revision,
  );
  const session = await folderSession(
    f,
    script(
      { write: { path: 'scripts/check.cjs', text: 'process.exit(0)\n' } },
      { commit: 'Pass the check' },
    ),
  );
  await runGates(f, session.id);
  await land(f, session.id);
  expect(current(f, session.id)).toMatchObject({
    state: 'open',
    merge: { state: 'blocked', reason: 'gate_files_changed', conflicts: ['scripts/check.cjs'] },
  });
  await f.call<Session>(
    'session.merge',
    { session_id: session.id, allow_gate_change: true },
    current(f, session.id).revision,
  );
  expect(current(f, session.id)).toMatchObject({ outcome: 'merged', state: 'closed' });
});

it.each([
  ['passes fewer tests', { passed: 9, failed: 0, skipped: 0 }, 'passed 10→9, skipped 0→0'],
  ['skips more tests', { passed: 10, failed: 0, skipped: 1 }, 'passed 10→10, skipped 0→1'],
])(
  'holds a folder session whose gate %s than the last landing on the branch, and lands it once allowed',
  async (_name, tests, counts) => {
    const f = await workbenchFixture();
    await withGate(f);
    const runs = [{ passed: 10, failed: 0, skipped: 0 }, tests];
    vi.mocked(validation.runValidationCommand).mockImplementation(async () => ({
      ...passed(),
      tests: runs.shift(),
    }));
    const first = await folderSession(f);
    await runGates(f, first.id);
    await land(f, first.id);
    expect(current(f, first.id)).toMatchObject({ outcome: 'merged' });
    const session = await folderSession(
      f,
      script({ write: { path: 'more.txt', text: 'more\n' } }, { commit: 'Add more' }),
    );
    await runGates(f, session.id);
    await land(f, session.id);
    expect(current(f, session.id)).toMatchObject({
      state: 'open',
      merge: { state: 'blocked', reason: `tests_dropped: check: ${counts}` },
    });
    await f.call<Session>(
      'session.merge',
      { session_id: session.id, allow_gate_change: true },
      current(f, session.id).revision,
    );
    expect(current(f, session.id)).toMatchObject({ outcome: 'merged', state: 'closed' });
  },
);

it('lands a folder session whose gate the user removed, though its earlier run passed fewer tests', async () => {
  const f = await workbenchFixture();
  await withGate(f);
  const runs = [
    { passed: 10, failed: 0, skipped: 0 },
    { passed: 9, failed: 0, skipped: 0 },
  ];
  vi.mocked(validation.runValidationCommand).mockImplementation(async () => ({
    ...passed(),
    tests: runs.shift(),
  }));
  const first = await folderSession(f);
  await runGates(f, first.id);
  await land(f, first.id);
  expect(current(f, first.id)).toMatchObject({ outcome: 'merged' });
  const session = await folderSession(
    f,
    script({ write: { path: 'more.txt', text: 'more\n' } }, { commit: 'Add more' }),
  );
  await runGates(f, session.id);
  await f.call(
    'project.gate.set',
    { project_id: f.project.id, root: f.source, commands: [] },
    f.store.must<Project>('projects', f.project.id).revision,
  );
  await land(f, session.id);
  expect(current(f, session.id)).toMatchObject({ outcome: 'merged', state: 'closed' });
});

/** A folder session over a committed gate script, its gates passed on the folder HEAD after change ran. */
async function gatedFolderSession(f: Fixture, change: () => void) {
  mkdirSync(path.join(f.source, 'scripts'));
  writeFileSync(path.join(f.source, 'scripts/check.cjs'), 'process.exit(1)\n');
  git(f.source, 'add', 'scripts/check.cjs');
  git(f.source, 'commit', '--quiet', '-m', 'Add the check');
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(passed());
  await f.call(
    'project.gate.set',
    {
      project_id: f.project.id,
      root: f.source,
      commands: [{ name: 'check', argv: ['node', 'scripts/check.cjs'] }],
    },
    f.store.must<Project>('projects', f.project.id).revision,
  );
  const session = await folderSession(f);
  change();
  await runGates(f, session.id);
  return session;
}

it('holds a folder session that moved a gate file away for the user', async () => {
  const f = await workbenchFixture();
  const session = await gatedFolderSession(f, () => {
    git(f.source, 'mv', 'scripts/check.cjs', 'moved.cjs');
    git(f.source, 'commit', '--quiet', '-m', 'Move the check');
  });
  await land(f, session.id);
  expect(current(f, session.id)).toMatchObject({
    state: 'open',
    merge: { state: 'blocked', reason: 'gate_files_changed', conflicts: ['scripts/check.cjs'] },
  });
});

it('holds a folder session whose changed files cannot be read', async () => {
  const f = await workbenchFixture();
  const session = await gatedFolderSession(f, () => {
    writeFileSync(path.join(f.source, 'scripts/check.cjs'), 'process.exit(0)\n');
    git(f.source, 'commit', '--quiet', '-am', 'Pass the check');
  });
  // A git first on PATH that fails every diff between the session base and the folder HEAD.
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const bin = path.join(f.root, 'failing-git');
  mkdirSync(bin);
  const trigger = `${current(f, session.id).in_place!.base_sha} ${head(f)}`;
  writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/sh\ncase "$*" in *"${trigger}"*) exit 128;; esac\nexec '${real}' "$@"\n`,
  );
  chmodSync(path.join(bin, 'git'), 0o755);
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}:${PATH}`;
  onTestFinished(() => {
    process.env.PATH = PATH;
  });
  await land(f, session.id);
  expect(current(f, session.id)).toMatchObject({
    state: 'open',
    merge: { state: 'blocked', reason: expect.stringMatching(/^git_failed:/) },
  });
});

it('commits the uncommitted files of a folder session under its title before it lands', async () => {
  const f = await workbenchFixture();
  await withGate(f);
  const session = await folderSession(f, script({ write: { path: 'draft.txt', text: 'draft\n' } }));
  const before = head(f);
  await land(f, session.id);
  expect(git(f.source, 'status', '--porcelain').trim()).toBe('');
  expect(git(f.source, 'log', '-1', '--format=%s').trim()).toBe(session.title);
  expect(head(f)).not.toBe(before);
  // The commit moved HEAD off what the gates checked, so they run again before it lands.
  expect(current(f, session.id)).toMatchObject({
    merge: { state: 'blocked', reason: 'gate_required' },
  });
  expect(current(f, session.id).outcome).toBeUndefined();
  await runGates(f, session.id);
  await land(f, session.id);
  expect(current(f, session.id).outcome).toBe('merged');
});

it('lands the uncommitted files of a folder session at once when the project has no gate', async () => {
  const f = await workbenchFixture();
  const session = await folderSession(f, script({ write: { path: 'draft.txt', text: 'draft\n' } }));
  await land(f, session.id);
  expect(git(f.source, 'status', '--porcelain').trim()).toBe('');
  expect(current(f, session.id)).toMatchObject({ outcome: 'merged', state: 'closed' });
});

it('lists a folder session with uncommitted files as ready and counts them in its preflight', async () => {
  const f = await workbenchFixture();
  const session = await folderSession(f, script({ write: { path: 'draft.txt', text: 'draft\n' } }));
  await f.prefetch();
  expect(f.list().find((row) => row.id === session.id)?.state).toBe('ready');
  expect(await f.control.sessionPreflight(user, session.id)).toMatchObject({
    files_changed: 1,
    can_merge: true,
  });
});

it('leaves files the global ignore rules of the user ignore out of the changes of a folder session', async () => {
  const f = await workbenchFixture();
  const session = await folderSession(f);
  const home = path.join(f.root, 'git-home'),
    saved = {
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    };
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, 'global-ignore'), '.DS_Store\n');
  writeFileSync(
    path.join(home, '.gitconfig'),
    `[core]\n\texcludesFile = ${path.join(home, 'global-ignore')}\n`,
  );
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.GIT_CONFIG_GLOBAL;
  onTestFinished(() => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  writeFileSync(path.join(f.source, '.DS_Store'), 'finder\n');
  await f.prefetch();
  expect(f.list().find((row) => row.id === session.id)?.changes).toMatchObject({ files: 1 });
  const diff = await f.control.sessionDiff(user, session.id);
  expect(diff.files.map((file) => file.path)).toEqual(['notes.txt']);
});

it('does not list a folder session whose index holds unresolved conflicts as ready', async () => {
  const f = await workbenchFixture();
  const session = await folderSession(f);
  git(f.source, 'checkout', '--quiet', '-b', 'side', 'HEAD~1');
  writeFileSync(path.join(f.source, 'answer.txt'), 'side\n');
  git(f.source, 'commit', '--quiet', '-am', 'Side answer');
  git(f.source, 'checkout', '--quiet', 'main');
  writeFileSync(path.join(f.source, 'answer.txt'), 'main\n');
  git(f.source, 'commit', '--quiet', '-am', 'Main answer');
  expect(() => git(f.source, 'merge', '--quiet', 'side')).toThrow();
  expect(git(f.source, 'ls-files', '--unmerged')).toContain('answer.txt');
  await f.prefetch();
  expect(f.list().find((row) => row.id === session.id)?.state).not.toBe('ready');
  expect(await f.control.sessionPreflight(user, session.id)).toMatchObject({
    can_merge: false,
    blocked_reason: 'unresolved_conflicts',
  });
});

it('keeps a folder session open when its commit leaves files uncommitted and the project has no gate', async () => {
  const f = await workbenchFixture();
  const session = await folderSession(f, script({ write: { path: 'draft.txt', text: 'draft\n' } }));
  writeFileSync(
    path.join(f.source, '.git/hooks/pre-commit'),
    "#!/bin/sh\nprintf 'left\\n' > leftover.txt\n",
    { mode: 0o755 },
  );
  await land(f, session.id);
  expect(git(f.source, 'log', '-1', '--format=%s').trim()).toBe(session.title);
  expect(git(f.source, 'status', '--porcelain').trim()).toBe('?? leftover.txt');
  expect(current(f, session.id)).toMatchObject({
    state: 'open',
    merge: { state: 'blocked', reason: 'uncommitted_changes' },
  });
  expect(current(f, session.id).outcome).toBeUndefined();
});

it('discards a new folder session without touching its files', async () => {
  const f = await workbenchFixture();
  const session = await folderSession(f, script({ write: { path: 'kept.txt', text: 'kept\n' } }));
  await f.call('session.discard', { session_id: session.id }, session.revision);
  await eventually(
    () => current(f, session.id).outcome === 'discarded',
    () => f.control.tick(),
  );
  expect(existsSync(path.join(f.source, 'kept.txt'))).toBe(true);
  expect(f.store.must<Workspace>('workspaces', session.workspace_id!).removed_at).toBeUndefined();
  expect(f.store.pending().filter((job) => job.kind === 'workspace.remove')).toEqual([]);
});

it('opens a worktree for the next session while one writes in the folder, and frees the folder once it lands', async () => {
  const f = await workbenchFixture();
  await withGate(f);
  const writer = await folderSession(f);
  const second = await folderSession(f, 'Another change');
  expect(f.store.must<Workspace>('workspaces', second.workspace_id!).kind).toBe('linked_worktree');
  expect(second.worktree_reason).toEqual({ holder_session_id: writer.id });
  expect(f.list().find((row) => row.id === second.id)?.worktree_reason).toEqual({
    holder_session_id: writer.id,
    holder_title: writer.title,
  });
  const busy = await refusal(() => folderSession(f, 'Here', 'in_place'));
  expect(busy.code).toBe('resource_busy');
  expect(busy.message).toContain(writer.id);
  await runGates(f, writer.id);
  await land(f, writer.id);
  const third = await folderSession(f, 'After the land');
  expect(f.store.must<Workspace>('workspaces', third.workspace_id!).kind).toBe('in_place');
  expect(third.worktree_reason).toBeUndefined();
});

it('keeps an adopted session out of gates and landing while it holds the folder', async () => {
  const f = await workbenchFixture({ adoptable: true });
  const adopted = await f.adopt();
  expect(credentialRole(adopted)).toBeUndefined();
  expect(
    (await refusal(() => f.call('session.gates.run', { session_id: adopted.id }, adopted.revision)))
      .message,
  ).toBe('A session in the user folder has no merge gate');
  const next = await folderSession(f, 'Beside it');
  expect(next.worktree_reason).toEqual({ holder_session_id: adopted.id });
});
