import { insideSandbox, awaitWorkspaceReady } from '../helpers.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import { Control } from '@pantheon/control';
import type { Principal, Project, Session, SessionTurn } from '@pantheon/domain';
import { command, inputSchemas, type CommandType } from '@pantheon/protocol';
import { ArtifactFiles, Store } from '@pantheon/store';
import { eventually, user } from '../helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function git(cwd: string, ...args: string[]) {
  return execFileSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
    {
      cwd,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Landing Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Landing Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
}

function commit(repository: string, name = 'new.txt', contents = 'accepted\n') {
  writeFileSync(path.join(repository, name), contents);
  git(repository, 'add', '--', name);
  git(repository, 'commit', '--quiet', '-m', `Update ${name}`);
  return git(repository, 'rev-parse', 'HEAD');
}

async function gateFixture() {
  const cache = path.join(process.cwd(), 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(path.join(cache, 'pantheon-gate-')),
    source = path.join(root, 'project/source'),
    workspaceRoot = path.join(root, 'managed'),
    database = path.join(root, 'state/control.sqlite');
  mkdirSync(source, { recursive: true });
  mkdirSync(workspaceRoot);
  git(source, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(path.join(source, 'answer.txt'), 'base\n');
  git(source, 'add', '.');
  git(source, 'commit', '--quiet', '-m', 'Initial files');
  const base = git(source, 'rev-parse', 'HEAD'),
    adapter = new FixtureAdapter(5),
    files = new ArtifactFiles(path.join(root, 'state/artifacts'));
  let store = new Store(database),
    control = new Control(store, files, [adapter], undefined, { workspaceRoot });
  const releases: string[] = [];
  cleanups.push(async () => {
    for (const file of releases)
      if (existsSync(path.dirname(file))) writeFileSync(file, 'release\n');
    await control.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const call = <T = unknown>(
    type: CommandType,
    input: Record<string, unknown>,
    revision: number | null = null,
    principal: Principal = user,
  ) => control.execute(principal, command(principal.id, type, input, revision)) as T;
  const project = call<Project>('project.open', {
    name: 'Landing project',
    roots: [source],
  });
  let session: Session | undefined;
  const current = () => store.must<Session>('sessions', session!.id);
  const events = (kind: string) => store.events().filter((event) => event.kind === kind);
  const create = (input: string) =>
    call<Session>('session.create', { project_id: project.id, runtime: adapter.name, input });
  const idle = (sessionId: string) =>
    store.must<Session>('sessions', sessionId).state === 'open' &&
    store
      .list<SessionTurn>('session_turns')
      .some((turn) => turn.session_id === sessionId && turn.state === 'completed');
  return {
    releases,
    source,
    base,
    project,
    call,
    current,
    events,
    create,
    get store() {
      return store;
    },
    get control() {
      return control;
    },
    installGate(commands: { name: string; argv: string[]; timeout_ms?: number }[]) {
      const current = store.must<Project>('projects', project.id);
      store.update(
        'projects',
        { ...current, gates: { [current.roots[0]!]: commands } },
        current.revision,
      );
    },
    /** Opens the session whose worktree the gate checks and waits until its first turn ends. */
    async open() {
      session = create('Change the answer');
      const workspace = await awaitWorkspaceReady(control, session.workspace_id!);
      await eventually(
        () => idle(session!.id),
        () => control.tick(),
      );
      return workspace;
    },
    merge() {
      return call<Session>('session.merge', { session_id: session!.id }, current().revision);
    },
    async settle() {
      await eventually(
        () => current().merge?.state !== 'running',
        () => control.tick(),
        10000,
      );
    },
    async restart() {
      await control.shutdown();
      store.close();
      store = new Store(database);
      control = new Control(store, files, [adapter], undefined, { workspaceRoot });
      control.recover();
    },
  };
}

it('sets and clears a user gate with project revisions, events and unchanged authority', async () => {
  const f = await gateFixture(),
    root = f.project.roots[0]!;
  // A gate belongs to a folder that is itself a git checkout.
  git(root, 'init', '--quiet', '--initial-branch=main');
  const commands = [{ name: 'Verify answer', argv: [process.execPath, '-e', 'process.exit(0)'] }],
    sent = command(
      user.id,
      'project.gate.set',
      { project_id: f.project.id, root, commands },
      f.project.revision,
    ),
    next = f.control.execute(user, sent) as Project;
  expect(next).toMatchObject({
    gates: { [root]: commands },
    revision: f.project.revision + 1,
  });
  expect(f.control.execute(user, sent)).toEqual(next);
  expect(f.events('project.gate_set')).toMatchObject([
    { aggregate_id: f.project.id, causation_id: sent.command_id, payload: { root, commands } },
  ]);
  expect(() =>
    f.call('project.gate.set', { project_id: f.project.id, root: f.project.roots[0]!, commands }),
  ).toThrowError(expect.objectContaining({ code: 'revision_conflict' }));
  expect(() =>
    f.call(
      'project.gate.set',
      { project_id: f.project.id, root: f.project.roots[0]!, commands },
      f.project.revision,
    ),
  ).toThrowError(expect.objectContaining({ code: 'revision_conflict' }));
  const cleared = f.call<Project>(
    'project.gate.set',
    { project_id: f.project.id, root: f.project.roots[0]!, commands: [] },
    next.revision,
  );
  expect(cleared).not.toHaveProperty('gates');
  expect(f.events('project.gate_set')).toHaveLength(2);
  await f.restart();
  expect(f.store.must<Project>('projects', f.project.id)).toEqual(cleared);
});

it.each(['planner', 'writer', 'reviewer'] as const)('refuses a gate set by a %s', async (role) => {
  const f = await gateFixture();
  expect(() =>
    f.call(
      'project.gate.set',
      { project_id: f.project.id, root: f.project.roots[0]!, commands: [] },
      f.project.revision,
      {
        id: 'agent',
        role,
      },
    ),
  ).toThrowError(expect.objectContaining({ code: 'permission_denied' }));
});

it('validates gate argv, timeout bounds and strict command inputs', async () => {
  const schema = inputSchemas['project.gate.set'];
  expect(schema, 'gate command schema').toBeDefined();
  const input = {
    project_id: 'project',
    root: '/work/project',
    commands: [{ name: 'Check', argv: ['echo', 'ok'] }],
  };
  expect(schema.parse(input)).toEqual(input);
  expect(schema.safeParse({ ...input, extra: true }).success).toBe(false);
  for (const command of [
    { name: 'Check', argv: [] },
    { name: 'Check', argv: [''] },
    { name: 'Check', argv: ['echo', ''] },
    { name: 'Check', argv: ['echo', 'bad\0argument'] },
    { name: 'Check', argv: [42] },
    { name: '', argv: ['echo'] },
    ...[0, -1, 1.5, 2147483648].map((timeout_ms) => ({
      name: 'Check',
      argv: ['echo'],
      timeout_ms,
    })),
    { name: 'Check', argv: ['echo'], cwd: '/tmp' },
  ])
    expect(
      schema.safeParse({ project_id: 'project', root: '/work/project', commands: [command] })
        .success,
    ).toBe(false);
  for (const timeout_ms of [1, 2147483647])
    expect(
      schema.safeParse({
        project_id: 'project',
        root: '/work/project',
        commands: [{ ...input.commands[0], timeout_ms }],
      }).success,
    ).toBe(true);
  const f = await gateFixture();
  expect(() =>
    f.call(
      'project.gate.set',
      {
        project_id: f.project.id,
        root: f.project.roots[0]!,
        commands: [{ name: 'Bad', argv: [] }],
      },
      f.project.revision,
    ),
  ).toThrow();
  expect(f.store.must<Project>('projects', f.project.id)).toEqual(f.project);
  expect(f.events('project.gate_set')).toEqual([]);
});

it.skipIf(insideSandbox)(
  'runs passing gates in order at the session commit in a disposable candidate and merges',
  async () => {
    const f = await gateFixture(),
      clone = await f.open(),
      target = commit(clone.path),
      commands = [
        {
          name: 'Read candidate',
          argv: [
            process.execPath,
            '-e',
            "const fs = require('node:fs'); fs.writeFileSync('gate-order', 'first'); process.stdout.write(fs.readFileSync('new.txt'));",
          ],
        },
        {
          name: 'Check order',
          argv: [
            process.execPath,
            '-e',
            "const fs = require('node:fs'); if (fs.readFileSync('gate-order', 'utf8') !== 'first') process.exit(1); process.stdout.write(process.cwd());",
          ],
        },
      ];
    f.installGate(commands);
    await f.merge();
    await f.settle();
    expect(f.events('session.gate_checked')).toMatchObject([
      {
        aggregate_id: f.current().id,
        project_id: f.project.id,
        payload: {
          workspace_id: clone.id,
          commit: target,
          results: commands.map((command, index) => ({
            ...command,
            exit_code: 0,
            duration_ms: expect.any(Number),
            timed_out: false,
            output: index ? expect.stringContaining('pantheon-gate-') : 'accepted\n',
          })),
        },
      },
    ]);
    expect(f.current()).toMatchObject({ state: 'closed', outcome: 'merged' });
    expect(git(f.source, 'rev-parse', 'HEAD')).toBe(target);
    expect(existsSync(path.join(f.source, 'gate-order'))).toBe(false);
    expect(f.events('session.gate_checked')[0]!.sequence).toBeLessThan(
      f.events('session.merged')[0]!.sequence,
    );
  },
);

it.skipIf(insideSandbox)(
  'blocks on the first failed gate with combined output and leaves the source untouched',
  async () => {
    const f = await gateFixture(),
      clone = await f.open(),
      target = commit(clone.path),
      before = git(f.source, 'show-ref'),
      commands = [
        { name: 'First', argv: [process.execPath, '-e', "process.stdout.write('passed')"] },
        {
          name: 'Fail',
          argv: [
            process.execPath,
            '-e',
            "process.stdout.write('out', () => { process.stderr.write('err', () => process.exit(7)); });",
          ],
        },
        {
          name: 'Must not run',
          argv: [process.execPath, '-e', "require('node:fs').writeFileSync('unexpected', 'bad')"],
        },
      ];
    f.installGate(commands);
    await f.merge();
    await f.settle();
    expect(f.current().merge).toEqual({
      state: 'blocked',
      reason: 'gate_failed',
      gate: { name: 'Fail', output: 'outerr' },
      failure_class: 'code',
    });
    expect(existsSync(path.join(clone.path, 'unexpected'))).toBe(false);
    expect(git(f.source, 'show-ref')).toBe(before);
    expect(git(f.source, 'rev-parse', 'HEAD')).toBe(f.base);
    expect(git(f.source, 'status', '--porcelain')).toBe('');
    expect(f.events('session.gate_checked')).toMatchObject([
      {
        payload: {
          commit: target,
          results: [
            { ...commands[0], exit_code: 0, timed_out: false, output: 'passed' },
            { ...commands[1], exit_code: 7, timed_out: false, output: 'outerr' },
          ],
        },
      },
    ]);
  },
);

it.skipIf(insideSandbox)(
  'reruns a failed gate after the user fixes it and merges the session again',
  async () => {
    const f = await gateFixture(),
      clone = await f.open(),
      target = commit(clone.path);
    f.installGate([
      {
        name: 'Wait for fix',
        argv: [
          process.execPath,
          '-e',
          "const fs = require('node:fs'); fs.appendFileSync('gate-attempts', 'attempt\\n'); process.exit(fs.existsSync('fixed') ? 0 : 1);",
        ],
      },
    ]);
    await f.merge();
    await f.settle();
    expect(f.current().merge?.state).toBe('blocked');
    expect(existsSync(path.join(clone.path, 'gate-attempts'))).toBe(false);
    f.installGate([
      { name: 'User corrected gate', argv: [process.execPath, '-e', 'console.log("fixed")'] },
    ]);
    await f.merge();
    await f.settle();
    expect(f.current().outcome).toBe('merged');
    expect(f.events('session.gate_checked')).toHaveLength(2);
    expect(f.events('session.gate_checked')[1]!.payload).toMatchObject({
      results: [{ output: 'fixed\n' }],
    });
    expect(git(f.source, 'rev-parse', 'HEAD')).toBe(target);
  },
);

it.skipIf(insideSandbox)(
  'blocks timed out gates with their result instead of merging',
  async () => {
    const f = await gateFixture();
    commit((await f.open()).path);
    f.installGate([
      {
        name: 'Never finishes',
        argv: [
          process.execPath,
          '-e',
          "process.stdout.write('waiting'); setInterval(() => {}, 10)",
        ],
        // Long enough for node to start and print under a loaded full test run.
        timeout_ms: 2000,
      },
    ]);
    await f.merge();
    await f.settle();
    expect(f.current().merge).toMatchObject({ state: 'blocked', reason: 'gate_failed' });
    expect(f.events('session.gate_checked')).toMatchObject([
      { payload: { results: [{ exit_code: null, timed_out: true, output: 'waiting' }] } },
    ]);
    expect(git(f.source, 'rev-parse', 'HEAD')).toBe(f.base);
  },
);

it.skipIf(insideSandbox)(
  'keeps the last 4000 characters of combined gate output even beyond the capture limit',
  async () => {
    const f = await gateFixture();
    commit((await f.open()).path);
    f.installGate([
      {
        name: 'Verbose failure',
        argv: [
          process.execPath,
          '-e',
          "process.stdout.write('x'.repeat(2 * 1024 * 1024), () => process.stderr.write('tail', () => process.exit(1)));",
        ],
      },
    ]);
    await f.merge();
    await f.settle();
    expect(f.events('session.gate_checked')).toHaveLength(1);
    expect(f.events('session.gate_checked')[0]!.payload).toMatchObject({
      results: [{ output: 'x'.repeat(3996) + 'tail' }],
    });
  },
);

function waitingGate(f: Awaited<ReturnType<typeof gateFixture>>) {
  const candidate = () =>
    (f.events('session.gate_started').at(-1)?.payload as { candidate_path?: string } | undefined)
      ?.candidate_path;
  f.installGate([
    {
      name: 'First step',
      argv: [process.execPath, '-e', "require('node:fs').appendFileSync('steps', 'first\\n')"],
    },
    {
      name: 'Wait for release',
      argv: [
        process.execPath,
        '-e',
        "const fs = require('node:fs'); fs.appendFileSync('steps', 'waiting\\n'); const timer = setInterval(() => { if (fs.existsSync('release')) { clearInterval(timer); } }, 10);",
      ],
      timeout_ms: 10000,
    },
  ]);
  return {
    get release() {
      const file = path.join(candidate()!, 'release');
      if (!f.releases.includes(file)) f.releases.push(file);
      return file;
    },
    steps: () => {
      const root = candidate();
      if (!root) return '';
      const file = path.join(root, 'steps');
      return existsSync(file) ? readFileSync(file, 'utf8') : '';
    },
  };
}

it.skipIf(insideSandbox)(
  'keeps ticks, another session, commands and event delivery working during a long gate',
  async () => {
    const f = await gateFixture(),
      clone = await f.open(),
      waiting = waitingGate(f);
    commit(clone.path);
    await f.merge();
    const ticking = f.control.tick();
    await Promise.race([
      ticking,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Merging held the tick')), 1000),
      ),
    ]);
    expect(f.current().merge?.state).toBe('running');
    await eventually(() => waiting.steps().includes('waiting'));
    expect(f.store.pending().some((job) => job.kind === 'session.merge')).toBe(true);
    const events = vi.fn();
    f.control.on('events', events);
    const other = f.create('Keep working while the merge waits');
    await eventually(
      () =>
        f.store
          .list<SessionTurn>('session_turns')
          .some((turn) => turn.session_id === other.id && turn.state === 'completed'),
      () => f.control.tick(),
    );
    expect(events).toHaveBeenCalled();
    expect(f.store.events().at(-1)!.sequence).toBeGreaterThan(0);
    expect(f.current().merge?.state).toBe('running');
    expect(waiting.steps()).toBe('first\nwaiting\n');
    expect(git(f.source, 'rev-parse', 'HEAD')).toBe(f.base);
    writeFileSync(waiting.release, 'ready\n');
    await eventually(
      () => f.current().outcome === 'merged',
      () => f.control.tick(),
    );
    expect(f.events('session.gate_checked')).toHaveLength(1);
  },
);

it.skipIf(insideSandbox)(
  'reruns every gate step after restart and never merges an unfinished gate result',
  async () => {
    const f = await gateFixture(),
      clone = await f.open(),
      waiting = waitingGate(f),
      target = commit(clone.path);
    await f.merge();
    await f.control.tick();
    expect(f.current().merge?.state).toBe('running');
    await eventually(() => waiting.steps() === 'first\nwaiting\n');
    const closing = f.control.shutdown();
    writeFileSync(waiting.release, 'shutdown\n');
    await closing;
    expect(f.events('session.gate_checked')).toEqual([]);
    expect(f.current().merge?.state).toBe('running');
    expect(git(f.source, 'rev-parse', 'HEAD')).toBe(f.base);
    rmSync(waiting.release, { force: true });
    await f.restart();
    await f.control.tick();
    await eventually(
      () => f.events('session.gate_started').length === 2 && waiting.steps() === 'first\nwaiting\n',
    );
    expect(f.current().merge?.state).toBe('running');
    expect(git(f.source, 'rev-parse', 'HEAD')).toBe(f.base);
    writeFileSync(waiting.release, 'finish\n');
    await eventually(
      () => f.current().outcome === 'merged',
      () => f.control.tick(),
    );
    expect(f.events('session.gate_checked')).toHaveLength(1);
    expect(git(f.source, 'rev-parse', 'HEAD')).toBe(target);
  },
);
