import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { Landing, Principal, Project, Session, Workspace } from '@pantheon/domain';
import { projectChanges } from '../../packages/control/dist/changes.js';
import type { ControlContext } from '../../packages/control/dist/context.js';
import * as validation from '../../packages/control/dist/validation-executor.js';
import { awaitWorkspaceReady, eventually, insideSandbox, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
type Gate = { name: string; argv: string[] };

const passes: Gate = {
  name: 'Passes',
  argv: [process.execPath, '-e', "process.stdout.write('ok')"],
};

async function setGate(f: Fixture, commands: Gate[]) {
  await f.call<Project>(
    'project.gate.set',
    { project_id: f.project.id, root: f.source, commands },
    f.store.must<Project>('projects', f.project.id).revision,
  );
}

/** A project whose source repository names the user who rebases and commits onto it. */
async function landFixture(gates: Gate[] = [passes]) {
  const f = await workbenchFixture();
  git(f.source, 'config', 'user.name', 'Source User');
  git(f.source, 'config', 'user.email', 'source@example.invalid');
  if (gates.length) await setGate(f, gates);
  return f;
}

function commit(repository: string, name: string, contents: string) {
  mkdirSync(path.dirname(path.join(repository, name)), { recursive: true });
  writeFileSync(path.join(repository, name), contents);
  git(repository, 'add', '--', name);
  git(repository, 'commit', '--quiet', '-m', `Update ${name}`);
  return git(repository, 'rev-parse', 'HEAD');
}

/** Makes the branch from `from` with one commit per file, returns its tip and checks main out again. */
function branch(f: Fixture, name: string, files: [string, string][], from = 'main') {
  git(f.source, 'checkout', '--quiet', '-b', name, from);
  for (const [file, contents] of files) commit(f.source, file, contents);
  git(f.source, 'checkout', '--quiet', 'main');
  return git(f.source, 'rev-parse', name);
}

const land = (f: Fixture, input: Record<string, unknown> = {}, principal: Principal = user) =>
  (async () =>
    f.call<Promise<Landing>>(
      'project.land',
      { root: f.source, branch: 'feature', ...input },
      null,
      principal,
    ))();

const row = (f: Fixture, id: string) => f.store.must<Landing>('landings', id);

async function ended(f: Fixture, id: string): Promise<Landing> {
  await eventually(
    () => ['landed', 'no_changes', 'blocked'].includes(row(f, id).state),
    () => f.control.tick(),
    20000,
  );
  return row(f, id);
}

const removalsQueued = (f: Fixture) =>
  (
    f.store.db.prepare("SELECT payload FROM outbox WHERE kind='workspace.remove'").all() as {
      payload: string;
    }[]
  ).map((job) => (JSON.parse(job.payload) as { workspace_id: string }).workspace_id);

it.skipIf(insideSandbox)(
  'lands a branch no session owns through the gate and fast-forwards the checked-out branch',
  async () => {
    const f = await landFixture();
    const base = git(f.source, 'rev-parse', 'main');
    const tip = branch(f, 'feature', [['feature.txt', 'feature\n']]);
    const started = await land(f);
    expect(started).toMatchObject({ state: 'queued', branch: 'feature', target_branch: 'main' });
    const done = await ended(f, started.id);
    expect(done).toMatchObject({
      state: 'landed',
      from_sha: base,
      to_sha: tip,
      gate_results: [expect.objectContaining({ name: 'Passes', exit_code: 0 })],
    });
    expect(done.gate_started_at).toBeGreaterThanOrEqual(done.started_at!);
    expect(done.gate_started_at).toBeLessThanOrEqual(done.finished_at!);
    expect(done.gate_finished_at).toBeGreaterThanOrEqual(done.gate_started_at!);
    expect(done.gate_finished_at).toBeLessThanOrEqual(done.finished_at!);
    expect(done.landing).toBeUndefined();
    expect(git(f.source, 'rev-parse', 'main')).toBe(tip);
    expect(git(f.source, 'rev-parse', 'feature')).toBe(tip);
    expect(git(f.source, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(removalsQueued(f)).toContain(done.workspace_id);
    expect(f.control.landingRead(user, started.id)).toEqual(row(f, started.id));
  },
);

it.skipIf(insideSandbox)(
  'blocks a branch whose gate fails with the failing output and leaves the root as it was',
  async () => {
    const f = await landFixture([
      {
        name: 'Always fails',
        argv: [process.execPath, '-e', "process.stderr.write('gate broke'); process.exit(3)"],
      },
    ]);
    const base = git(f.source, 'rev-parse', 'main');
    branch(f, 'feature', [['feature.txt', 'feature\n']]);
    const done = await ended(f, (await land(f)).id);
    expect(done).toMatchObject({ state: 'blocked', reason: 'gate_failed' });
    expect(done.gate_results).toEqual([
      expect.objectContaining({ name: 'Always fails', exit_code: 3 }),
    ]);
    expect(done.gate_results![0]!.output).toContain('gate broke');
    expect(git(f.source, 'rev-parse', 'main')).toBe(base);
    expect(git(f.source, 'status', '--porcelain')).toBe('');
  },
);

it.skipIf(insideSandbox)(
  'rebases a branch onto a target that moved on and keeps the history linear',
  async () => {
    const f = await landFixture();
    branch(f, 'feature', [['feature.txt', 'feature\n']]);
    const moved = commit(f.source, 'other.txt', 'other\n');
    const done = await ended(f, (await land(f)).id);
    expect(done).toMatchObject({ state: 'landed', from_sha: moved });
    expect(git(f.source, 'rev-parse', 'main')).toBe(done.to_sha);
    expect(git(f.source, 'rev-parse', 'main~1')).toBe(moved);
    expect(git(f.source, 'rev-list', '--merges', 'main')).toBe('');
    expect(git(f.source, 'show', 'main:feature.txt')).toBe('feature');
    expect(git(f.source, 'show', 'main:other.txt')).toBe('other');
  },
);

it.skipIf(insideSandbox)('blocks a branch that conflicts with the target', async () => {
  const f = await landFixture();
  branch(f, 'feature', [['answer.txt', 'feature side\n']]);
  const moved = commit(f.source, 'answer.txt', 'main side\n');
  const done = await ended(f, (await land(f)).id);
  expect(done).toMatchObject({
    state: 'blocked',
    reason: 'rebase_conflict',
    conflicts: ['answer.txt'],
    conflict_commits: ['Update answer.txt'],
  });
  expect(git(f.source, 'rev-parse', 'main')).toBe(moved);
});

it('reports no changes for a branch the target already holds', async () => {
  const f = await landFixture();
  const tip = branch(f, 'feature', [['feature.txt', 'feature\n']]);
  git(f.source, 'merge', '--quiet', '--ff-only', 'feature');
  const done = await ended(f, (await land(f)).id);
  expect(done).toMatchObject({ state: 'no_changes' });
  expect(git(f.source, 'rev-parse', 'main')).toBe(tip);
});

it('blocks a branch that changes agent configuration', async () => {
  const f = await landFixture();
  const base = git(f.source, 'rev-parse', 'main');
  branch(f, 'feature', [['.claude/settings.json', '{}\n']]);
  const done = await ended(f, (await land(f)).id);
  expect(done).toMatchObject({
    state: 'blocked',
    reason: 'protected_paths',
    conflicts: ['.claude/settings.json'],
  });
  expect(git(f.source, 'rev-parse', 'main')).toBe(base);
});

it.skipIf(insideSandbox).each([
  ['the gate argv names', 'scripts/check.cjs', undefined],
  ['the project protects by glob', 'config/gate.json', ['config/*.json']],
])(
  'blocks a branch that changes a file %s without running the gate, and lands it when allowed',
  async (_name, file, protectedPaths) => {
    const f = await landFixture([]);
    commit(f.source, 'scripts/check.cjs', 'process.exit(0)\n');
    commit(f.source, 'config/gate.json', '{}\n');
    await f.call<Project>(
      'project.gate.set',
      {
        project_id: f.project.id,
        root: f.source,
        commands: [{ name: 'Checks', argv: [process.execPath, 'scripts/check.cjs'] }],
        ...(protectedPaths ? { protected_paths: protectedPaths } : {}),
      },
      f.store.must<Project>('projects', f.project.id).revision,
    );
    const base = git(f.source, 'rev-parse', 'main');
    const tip = branch(f, 'feature', [[file, '"changed"\n']]);
    const done = await ended(f, (await land(f)).id);
    expect(done).toMatchObject({
      state: 'blocked',
      reason: 'gate_files_changed',
      conflicts: [file],
    });
    expect(done.gate_results).toBeUndefined();
    expect(git(f.source, 'rev-parse', 'main')).toBe(base);
    const allowed = await ended(f, (await land(f, { allow_gate_change: true })).id);
    expect(allowed).toMatchObject({ state: 'landed', to_sha: tip });
    expect(git(f.source, 'rev-parse', 'main')).toBe(tip);
  },
);

it.each([
  ['passes fewer tests', { passed: 9, failed: 0, skipped: 0 }, 'passed 10→9, skipped 0→0'],
  ['skips more tests', { passed: 10, failed: 0, skipped: 1 }, 'passed 10→10, skipped 0→1'],
])(
  'holds a branch whose gate %s than the last landing on the target, and lands it when allowed',
  async (_name, tests, counts) => {
    const f = await landFixture();
    const runs = [{ passed: 10, failed: 0, skipped: 0 }, tests, tests];
    vi.spyOn(validation, 'runValidationCommand').mockImplementation(async () => ({
      ...passedGate(),
      tests: runs.shift(),
    }));
    branch(f, 'feature', [['feature.txt', 'feature\n']]);
    expect(await ended(f, (await land(f)).id)).toMatchObject({ state: 'landed' });
    const landed = git(f.source, 'rev-parse', 'main');
    const tip = branch(f, 'second', [['second.txt', 'second\n']]);
    const done = await ended(f, (await land(f, { branch: 'second' })).id);
    expect(done).toMatchObject({ state: 'blocked', reason: `tests_dropped: Passes: ${counts}` });
    expect(git(f.source, 'rev-parse', 'main')).toBe(landed);
    const allowed = await ended(
      f,
      (await land(f, { branch: 'second', allow_gate_change: true })).id,
    );
    expect(allowed).toMatchObject({ state: 'landed', to_sha: tip });
    expect(git(f.source, 'rev-parse', 'main')).toBe(tip);
  },
);

it('blocks a landing whose root checked out another branch after the request', async () => {
  const f = await landFixture();
  const base = git(f.source, 'rev-parse', 'main');
  const tip = branch(f, 'feature', [['feature.txt', 'feature\n']]);
  const started = await land(f);
  git(f.source, 'checkout', '--quiet', '-b', 'elsewhere');
  const done = await ended(f, started.id);
  expect(done).toMatchObject({ state: 'blocked', reason: 'target_branch_changed' });
  expect(git(f.source, 'rev-parse', 'main')).toBe(base);
  expect(git(f.source, 'rev-parse', 'elsewhere')).toBe(base);
  expect(git(f.source, 'rev-parse', 'feature')).toBe(tip);
});

it.skipIf(insideSandbox)(
  'lands the commits as one commit with the message, though the branch merged the target in',
  async () => {
    const f = await landFixture();
    branch(f, 'feature', [
      ['feature.txt', 'feature\n'],
      ['second.txt', 'second\n'],
    ]);
    commit(f.source, 'other.txt', 'other\n');
    git(f.source, 'checkout', '--quiet', 'feature');
    git(f.source, 'merge', '--quiet', '--no-edit', '--no-ff', 'main');
    git(f.source, 'checkout', '--quiet', 'main');
    const moved = commit(f.source, 'third.txt', 'third\n');
    const tip = git(f.source, 'rev-parse', 'feature');
    const expected = git(f.source, 'merge-tree', '--write-tree', 'main', 'feature');
    const done = await ended(f, (await land(f, { message: 'Land the feature' })).id);
    expect(done).toMatchObject({ state: 'landed', from_sha: moved });
    expect(git(f.source, 'rev-list', '--count', `${moved}..main`)).toBe('1');
    expect(git(f.source, 'rev-parse', 'main~1')).toBe(moved);
    expect(git(f.source, 'log', '-1', '--format=%B', 'main')).toBe('Land the feature');
    expect(git(f.source, 'rev-parse', 'main^{tree}')).toBe(expected);
    expect(git(f.source, 'rev-parse', 'feature')).toBe(tip);
  },
);

it.skipIf(insideSandbox)(
  'reports no changes for a branch whose commits already landed as one commit',
  async () => {
    const f = await landFixture();
    branch(f, 'feature', [
      ['feature.txt', 'feature\n'],
      ['second.txt', 'second\n'],
    ]);
    await ended(f, (await land(f, { message: 'Land the feature' })).id);
    const landed = git(f.source, 'rev-parse', 'main');
    expect(await ended(f, (await land(f)).id)).toMatchObject({ state: 'no_changes' });
    expect(git(f.source, 'rev-parse', 'main')).toBe(landed);
  },
);

it.skipIf(insideSandbox).each([
  ['its own commits', undefined, 'Update stacked.txt'],
  ['its own commits as one commit', 'Land the second branch', 'Land the second branch'],
])(
  'lands %s onto the target, for a branch cut from a branch that landed as one commit',
  async (_name, message, subject) => {
    const f = await landFixture();
    branch(f, 'feature', [
      ['stacked.txt', 'first\n'],
      ['stacked.txt', 'second\n'],
    ]);
    const tip = branch(f, 'second', [['stacked.txt', 'third\n']], 'feature');
    expect(await ended(f, (await land(f, { message: 'Land the feature' })).id)).toMatchObject({
      state: 'landed',
    });
    const squashed = git(f.source, 'rev-parse', 'main');
    const done = await ended(
      f,
      (await land(f, { branch: 'second', ...(message === undefined ? {} : { message }) })).id,
    );
    expect(done).toMatchObject({ state: 'landed', from_sha: squashed });
    expect(git(f.source, 'rev-parse', 'main~1')).toBe(squashed);
    expect(git(f.source, 'log', '-1', '--format=%B', 'main')).toBe(subject);
    expect(git(f.source, 'show', 'main:stacked.txt')).toBe('third');
    expect(git(f.source, 'rev-parse', 'second')).toBe(tip);
  },
);

it.skipIf(insideSandbox)(
  'rebases only its own commit, for a branch cut from a branch that landed with its commits',
  async () => {
    const f = await landFixture();
    const kept = branch(f, 'feature', [
      ['stacked.txt', 'first\n'],
      ['stacked.txt', 'second\n'],
    ]);
    branch(f, 'second', [['stacked.txt', 'third\n']], 'feature');
    expect(await ended(f, (await land(f)).id)).toMatchObject({ state: 'landed', to_sha: kept });
    const moved = commit(f.source, 'other.txt', 'other\n');
    const done = await ended(f, (await land(f, { branch: 'second' })).id);
    expect(done).toMatchObject({ state: 'landed', from_sha: moved });
    expect(git(f.source, 'rev-list', '--count', `${moved}..main`)).toBe('1');
    expect(git(f.source, 'show', 'main:stacked.txt')).toBe('third');
  },
);

it.skipIf(insideSandbox)(
  'rebases a branch cut from the target as before, after another branch landed as one commit',
  async () => {
    const f = await landFixture();
    branch(f, 'feature', [
      ['stacked.txt', 'first\n'],
      ['stacked.txt', 'second\n'],
    ]);
    branch(f, 'other', [['other.txt', 'other\n']]);
    await ended(f, (await land(f, { message: 'Land the feature' })).id);
    const squashed = git(f.source, 'rev-parse', 'main');
    const done = await ended(f, (await land(f, { branch: 'other' })).id);
    expect(done).toMatchObject({ state: 'landed', from_sha: squashed });
    expect(git(f.source, 'rev-parse', 'main~1')).toBe(squashed);
    expect(git(f.source, 'show', 'main:stacked.txt')).toBe('second');
    expect(git(f.source, 'show', 'main:other.txt')).toBe('other');
  },
);

it.skipIf(insideSandbox)(
  'lands only its own commit, for a branch cut before the branch it came from got more commits and landed as one commit',
  async () => {
    const f = await landFixture();
    branch(f, 'feature', [
      ['stacked.txt', 'first\n'],
      ['stacked.txt', 'second\n'],
    ]);
    branch(f, 'second', [['own.txt', 'own\n']], 'feature~1');
    expect(await ended(f, (await land(f, { message: 'Land the feature' })).id)).toMatchObject({
      state: 'landed',
    });
    const squashed = git(f.source, 'rev-parse', 'main');
    const done = await ended(f, (await land(f, { branch: 'second' })).id);
    expect(done).toMatchObject({ state: 'landed', from_sha: squashed });
    expect(git(f.source, 'rev-list', '--count', `${squashed}..main`)).toBe('1');
    expect(git(f.source, 'show', 'main:stacked.txt')).toBe('second');
    expect(git(f.source, 'show', 'main:own.txt')).toBe('own');
  },
);

it.skipIf(insideSandbox)(
  'rebases from the nearest commit that landed as one commit, for a branch cut from a chain of such branches',
  async () => {
    const f = await landFixture();
    branch(f, 'feature', [['stacked.txt', 'first\n']]);
    branch(f, 'second', [['added.txt', 'second\n']], 'feature');
    branch(f, 'third', [['own.txt', 'own\n']], 'second');
    git(f.source, 'checkout', '--quiet', 'feature');
    commit(f.source, 'later.txt', 'later\n');
    git(f.source, 'checkout', '--quiet', 'main');
    expect(
      await ended(f, (await land(f, { branch: 'second', message: 'Land the second' })).id),
    ).toMatchObject({ state: 'landed' });
    expect(await ended(f, (await land(f, { message: 'Land the feature' })).id)).toMatchObject({
      state: 'landed',
    });
    const moved = commit(f.source, 'added.txt', 'moved\n');
    const done = await ended(f, (await land(f, { branch: 'third' })).id);
    expect(done).toMatchObject({ state: 'landed', from_sha: moved });
    expect(git(f.source, 'rev-list', '--count', `${moved}..main`)).toBe('1');
    expect(git(f.source, 'show', 'main:own.txt')).toBe('own');
    expect(git(f.source, 'show', 'main:added.txt')).toBe('moved');
    expect(git(f.source, 'show', 'main:later.txt')).toBe('later');
  },
);

it.skipIf(insideSandbox)(
  'keeps the commits of the branch it was cut from, after the target lost their squashed commit',
  async () => {
    const f = await landFixture();
    const base = git(f.source, 'rev-parse', 'main');
    branch(f, 'feature', [
      ['stacked.txt', 'first\n'],
      ['stacked.txt', 'second\n'],
    ]);
    branch(f, 'second', [['own.txt', 'own\n']], 'feature');
    expect(await ended(f, (await land(f, { message: 'Land the feature' })).id)).toMatchObject({
      state: 'landed',
    });
    git(f.source, 'reset', '--quiet', '--hard', base);
    const moved = commit(f.source, 'other.txt', 'other\n');
    const done = await ended(f, (await land(f, { branch: 'second' })).id);
    expect(done).toMatchObject({ state: 'landed', from_sha: moved });
    expect(git(f.source, 'show', 'main:stacked.txt')).toBe('second');
    expect(git(f.source, 'show', 'main:own.txt')).toBe('own');
    expect(git(f.source, 'show', 'main:other.txt')).toBe('other');
  },
);

it.skipIf(insideSandbox).each<[string, string, string, Partial<Landing>]>([
  ['lands without leave a branch that', 'own.txt', 'own\n', { state: 'landed' }],
  [
    'blocks a branch that changes the gate file back and',
    'scripts/check.cjs',
    'process.exit(0)\n',
    { state: 'blocked', reason: 'gate_files_changed', conflicts: ['scripts/check.cjs'] },
  ],
])(
  '%s was cut from a branch whose gate file change landed as one commit with leave',
  async (_name, file, contents, expected) => {
    const f = await landFixture([]);
    commit(f.source, 'scripts/check.cjs', 'process.exit(0)\n');
    await setGate(f, [{ name: 'Checks', argv: [process.execPath, 'scripts/check.cjs'] }]);
    branch(f, 'feature', [['scripts/check.cjs', '"changed"\n']]);
    branch(f, 'second', [[file, contents]], 'feature');
    expect(
      await ended(f, (await land(f, { message: 'Land the feature', allow_gate_change: true })).id),
    ).toMatchObject({ state: 'landed' });
    const squashed = git(f.source, 'rev-parse', 'main');
    const done = await ended(f, (await land(f, { branch: 'second' })).id);
    expect(done).toMatchObject(expected);
    if (expected.state === 'blocked') expect(git(f.source, 'rev-parse', 'main')).toBe(squashed);
    else expect(git(f.source, 'show', `main:${file}`)).toBe(contents.trim());
  },
);

it('reports no changes for a branch with a message whose commits undo each other', async () => {
  const f = await landFixture();
  const base = git(f.source, 'rev-parse', 'main');
  branch(f, 'feature', [['feature.txt', 'feature\n']]);
  git(f.source, 'checkout', '--quiet', 'feature');
  git(f.source, 'revert', '--no-edit', 'HEAD');
  git(f.source, 'checkout', '--quiet', 'main');
  const done = await ended(f, (await land(f, { message: 'Land the feature' })).id);
  expect(done).toMatchObject({ state: 'no_changes' });
  expect(git(f.source, 'rev-parse', 'main')).toBe(base);
});

it('blocks a queued landing whose root lost its gate commands before it ran', async () => {
  const f = await landFixture();
  const base = git(f.source, 'rev-parse', 'main');
  branch(f, 'feature', [['feature.txt', 'feature\n']]);
  const started = await land(f);
  await setGate(f, []);
  const done = await ended(f, started.id);
  expect(done).toMatchObject({ state: 'blocked', reason: 'no_gate_commands' });
  expect(git(f.source, 'rev-parse', 'main')).toBe(base);
});

const writer: Principal = { id: 'some-writer', role: 'writer' };

it.each<[string, (f: Fixture) => Promise<unknown>, string]>([
  [
    'a root that is not a project root',
    (f) => land(f, { root: path.dirname(f.source) }),
    'not_found',
  ],
  ['a branch that does not exist', (f) => land(f, { branch: 'no-such-branch' }), 'invalid_input'],
  [
    'a branch that looks like an option',
    (f) => land(f, { branch: `--output=${path.join(f.root, 'leaked')}` }),
    'invalid_input',
  ],
  [
    'a root without gate commands',
    async (f) => {
      await setGate(f, []);
      return land(f);
    },
    'no_gate_commands',
  ],
  [
    'a root with a detached HEAD',
    (f) => {
      git(f.source, 'checkout', '--quiet', '--detach', 'main');
      return land(f);
    },
    'invalid_state',
  ],
  ['a principal other than the user', (f) => land(f, {}, writer), 'permission_denied'],
  [
    'a branch already landing',
    async (f) => {
      await land(f);
      return land(f);
    },
    'resource_busy',
  ],
])('refuses %s and queues no other landing', async (_name, run, code) => {
  const f = await landFixture();
  branch(f, 'feature', [['feature.txt', 'feature\n']]);
  const error = await run(f).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toMatchObject({ code });
  if (code === 'no_gate_commands')
    expect(error).toMatchObject({ details: { project_id: f.project.id } });
  expect(f.store.list<Landing>('landings')).toHaveLength(code === 'resource_busy' ? 1 : 0);
  expect(f.store.list<Workspace>('workspaces')).toHaveLength(code === 'resource_busy' ? 1 : 0);
});

function passedGate(): validation.ValidationResult {
  return {
    exit_code: 0,
    signal: null,
    duration_ms: 5,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    log: Buffer.alloc(0),
    tail: 'ok',
    timedOut: false,
    stdout_sha256: '',
    stderr_sha256: '',
    output_truncated: false,
  };
}

it('starts the gate of a branch landing only after a session merge of the same root ends', async () => {
  const f = await landFixture();
  const session = await f.create();
  const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.turns(session.id)[0]!.state === 'completed' &&
      f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  commit(workspace.path, 'answer.txt', 'merged by the session\n');
  branch(f, 'feature', [['feature.txt', 'feature\n']]);
  const order: string[] = [];
  vi.spyOn(validation, 'runValidationCommand').mockImplementation(async (input) => {
    const owner = input.key.split(':')[1]!.split('-')[0]!;
    order.push(`${owner} started`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    order.push(`${owner} ended`);
    return passedGate();
  });
  await f.call(
    'session.merge',
    { session_id: session.id },
    f.store.must<Session>('sessions', session.id).revision,
  );
  await eventually(
    () => order.length > 0,
    () => f.control.tick(),
    10000,
  );
  const done = await ended(f, (await land(f)).id);
  expect(done.state).toBe('landed');
  expect(order).toEqual(['session started', 'session ended', 'land started', 'land ended']);
  expect(git(f.source, 'show', 'main:answer.txt')).toBe('merged by the session');
  expect(git(f.source, 'show', 'main:feature.txt')).toBe('feature');
});

it.skipIf(insideSandbox)(
  'reruns a branch landing gate from the start after shutdown interrupts its command',
  async () => {
    const f = await landFixture([]);
    const runs = path.join(f.root, 'gate-runs');
    const started = path.join(f.root, 'checking');
    await setGate(f, [
      { name: 'Prepare', argv: ['sh', '-c', 'echo prepare >> "$1"', 'sh', runs] },
      {
        name: 'Check',
        argv: [
          'sh',
          '-c',
          'echo check >> "$1"; if [ ! -e "$2" ]; then touch "$2"; exec tail -f /dev/null; fi',
          'sh',
          runs,
          started,
        ],
      },
    ]);
    const tip = branch(f, 'feature', [['feature.txt', 'feature\n']]);
    const { id } = await land(f);
    await eventually(
      () => existsSync(started),
      () => f.control.tick(),
    );
    await f.control.shutdown();
    expect(row(f, id)).toMatchObject({
      state: 'running',
      gate_results: [{ name: 'Prepare', state: 'passed' }],
    });
    await f.restart(undefined, { abandon: true });
    expect(await ended(f, id)).toMatchObject({
      state: 'landed',
      to_sha: tip,
      gate_results: [
        { name: 'Prepare', state: 'passed' },
        { name: 'Check', state: 'passed' },
      ],
    });
    expect(readFileSync(runs, 'utf8')).toBe('prepare\ncheck\nprepare\ncheck\n');
    expect(git(f.source, 'rev-parse', 'main')).toBe(tip);
  },
);

it('leaves the commits of a landing that waited for the root unsquashed when the daemon stops', async () => {
  const f = await landFixture();
  branch(f, 'feature', [['feature.txt', 'feature\n']]);
  branch(f, 'other', [
    ['other.txt', 'other\n'],
    ['more.txt', 'more\n'],
  ]);
  let release: () => void = () => {};
  const gate = vi.spyOn(validation, 'runValidationCommand').mockImplementation(async () => {
    await new Promise<void>((resolve) => (release = resolve));
    return passedGate();
  });
  const first = await land(f);
  await eventually(
    () => gate.mock.calls.length === 1,
    () => f.control.tick(),
    10000,
  );
  const waiting = await land(f, { branch: 'other', message: 'Land the other branch' });
  await eventually(
    () => row(f, waiting.id).state === 'running',
    () => f.control.tick(),
    10000,
  );
  expect(gate.mock.calls[0]![0].key).toContain(first.id);
  const stopping = f.control.shutdown();
  release();
  await stopping;
  const worktree = f.store.must<Workspace>('workspaces', row(f, waiting.id).workspace_id).path;
  expect(git(worktree, 'rev-list', '--count', `${git(f.source, 'rev-parse', 'main')}..HEAD`)).toBe(
    '2',
  );
  expect(gate).toHaveBeenCalledTimes(1);
});

const cancel = (f: Fixture, landingId: string) =>
  f.call<Landing>('project.landing.cancel', { landing_id: landingId });

it('ends a landing cancelled before it runs as cancelled, without its gate, and lands the branch again', async () => {
  const f = await landFixture();
  const base = git(f.source, 'rev-parse', 'main');
  branch(f, 'feature', [['feature.txt', 'feature\n']]);
  const gate = vi.spyOn(validation, 'runValidationCommand');
  const started = await land(f);
  expect(cancel(f, started.id)).toMatchObject({ state: 'queued', cancel_requested: true });
  const done = await ended(f, started.id);
  expect(done).toMatchObject({ state: 'blocked', reason: 'cancelled' });
  expect(gate).not.toHaveBeenCalled();
  expect(removalsQueued(f)).toContain(done.workspace_id);
  expect(git(f.source, 'rev-parse', 'main')).toBe(base);
  expect(await land(f)).toMatchObject({ state: 'queued', branch: 'feature' });
});

it('ends a landing cancelled while its gate runs as cancelled and leaves the target where it was', async () => {
  const f = await landFixture();
  const base = git(f.source, 'rev-parse', 'main');
  branch(f, 'feature', [['feature.txt', 'feature\n']]);
  let release: () => void = () => {};
  const gate = vi.spyOn(validation, 'runValidationCommand').mockImplementation(async () => {
    await new Promise<void>((resolve) => (release = resolve));
    return passedGate();
  });
  const started = await land(f);
  await eventually(
    () => gate.mock.calls.length === 1,
    () => f.control.tick(),
    10000,
  );
  cancel(f, started.id);
  release();
  const done = await ended(f, started.id);
  expect(done).toMatchObject({ state: 'blocked', reason: 'cancelled' });
  expect(git(f.source, 'rev-parse', 'main')).toBe(base);
});

it('ends at once a landing cancelled while another landing holds the root, and lands the branch again', async () => {
  const f = await landFixture();
  branch(f, 'feature', [['feature.txt', 'feature\n']]);
  branch(f, 'other', [['other.txt', 'other\n']]);
  let release: () => void = () => {};
  const gate = vi
    .spyOn(validation, 'runValidationCommand')
    .mockResolvedValue(passedGate())
    .mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return passedGate();
    });
  const first = await land(f);
  await eventually(
    () => gate.mock.calls.length === 1,
    () => f.control.tick(),
    10000,
  );
  const waiting = await land(f, { branch: 'other' });
  await eventually(
    () => row(f, waiting.id).state === 'running',
    () => f.control.tick(),
    10000,
  );
  cancel(f, waiting.id);
  await eventually(
    () => row(f, waiting.id).state === 'blocked',
    () => f.control.tick(),
    10000,
  );
  expect(row(f, waiting.id)).toMatchObject({ reason: 'cancelled' });
  expect(row(f, first.id).state).toBe('running');
  const again = await land(f, { branch: 'other' });
  expect(again).toMatchObject({ state: 'queued', branch: 'other' });
  release();
  expect(await ended(f, first.id)).toMatchObject({ state: 'landed' });
  expect(await ended(f, again.id)).toMatchObject({ state: 'landed' });
});

it('refuses to cancel a landing that passed its gate', async () => {
  const f = await landFixture();
  branch(f, 'feature', [['feature.txt', 'feature\n']]);
  const started = await land(f);
  const current = row(f, started.id);
  f.store.update<Landing>(
    'landings',
    {
      ...current,
      state: 'running',
      landing: { stage: 'gated', candidate: 'c', branch: 'main', from_sha: 'f' },
    },
    current.revision,
  );
  expect(() => cancel(f, started.id)).toThrow(expect.objectContaining({ code: 'invalid_state' }));
  expect(row(f, started.id).cancel_requested).toBeUndefined();
});

it('refuses to cancel a landing that already landed', async () => {
  const f = await landFixture();
  branch(f, 'feature', [['feature.txt', 'feature\n']]);
  const done = await ended(f, (await land(f)).id);
  expect(done.state).toBe('landed');
  expect(() => cancel(f, done.id)).toThrow(expect.objectContaining({ code: 'invalid_state' }));
  expect(row(f, done.id).cancel_requested).toBeUndefined();
});

it('lists a finished landing in the change list for one day, and a queued one until it ends', async () => {
  const f = await landFixture();
  const now = f.store.now(),
    hour = 60 * 60_000;
  const insert = (name: string, state: Landing['state'], finished?: number) =>
    f.store.insert<Landing>('landings', {
      id: `landing-${name}`,
      revision: 1,
      project_id: f.project.id,
      root: f.source,
      branch: name,
      target_branch: 'main',
      workspace_id: `workspace-${name}`,
      state,
      ...(finished === undefined ? {} : { reason: 'gate_failed', finished_at: finished }),
    });
  insert('old', 'blocked', now - 25 * hour);
  insert('recent', 'blocked', now - hour);
  insert('waiting', 'queued');
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const rows = projectChanges(ctx, user, f.project.id, []).filter((each) => each.kind === 'branch');
  expect(rows.map((each) => each.id).sort()).toEqual([
    'landing:landing-recent',
    'landing:landing-waiting',
  ]);
});
