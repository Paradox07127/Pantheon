import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, expect, it, vi } from 'vitest';
import type { Session, Workspace } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = ReturnType<typeof workbenchFixture>;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function idleSession(f: Fixture) {
  const session = f.create('Check the project');
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.turns(session.id).every((turn) => turn.state === 'completed') &&
      f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  return f.store.must<Session>('sessions', session.id);
}

it('counts the lines of a large untracked file without holding the event loop', async () => {
  const f = workbenchFixture();
  const session = await idleSession(f);
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
  const lines = 32 * 1024 * 1024;
  writeFileSync(path.join(workspace.path, 'large.log'), Buffer.alloc(lines, 0x0a));
  // Past the reuse window of earlier reads, so the prefetch reads the worktree and the list reuses it.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 2000);
  let longest = 0,
    last = performance.now();
  const turn = () => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  };
  const timer = setInterval(turn, 1);
  try {
    await f.control.prefetchWorktreeReads(user, f.project.id);
    // The count is the last read; it may end just before the prefetch resolves.
    turn();
  } finally {
    clearInterval(timer);
  }
  expect(f.list().find((row) => row.id === session.id)?.changes?.additions).toBe(lines);
  expect(longest).toBeLessThan(100);
});

it('counts no lines of an untracked path that is a named pipe', async () => {
  const f = workbenchFixture();
  const session = await idleSession(f);
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
  execFileSync('mkfifo', [path.join(workspace.path, 'pipe')]);
  writeFileSync(path.join(workspace.path, 'note.txt'), 'uncommitted\n');
  const gitModule = await import('../../packages/control/dist/git.js');
  const original = gitModule.runGit;
  // Git leaves a named pipe out; a file it listed can be replaced by one before it is read.
  const withPipe = <T extends { stdout: Buffer }>(result: T): T => ({
    ...result,
    stdout: Buffer.concat([result.stdout, Buffer.from('pipe\0')]),
  });
  vi.spyOn(gitModule, 'runGit').mockImplementation((cwd, args, input, asynchronous, options) => {
    const result = original(cwd, args, input, asynchronous, options);
    if (args.join(' ') !== 'ls-files --others --exclude-standard -z') return result;
    return result instanceof Promise ? result.then(withPipe) : withPipe(result);
  });
  const row = () =>
    f.control.sessionList(user, f.project.id, 'cached').find((each) => each.id === session.id);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 2000);
  expect(f.list().find((each) => each.id === session.id)?.changes).toMatchObject({
    files: 2,
    additions: 1,
  });
  vi.setSystemTime(Date.now() + 2000);
  await f.control.prefetchWorktreeReads(user, f.project.id);
  expect(row()?.changes).toMatchObject({ files: 2, additions: 1 });
});

/** An idle session with an uncommitted file, whose asynchronous Git reads each take three seconds of the clock. */
async function slowReads() {
  const f = workbenchFixture();
  const session = await idleSession(f);
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
  writeFileSync(path.join(workspace.path, 'note.txt'), 'uncommitted\n');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 2000);
  const gitModule = await import('../../packages/control/dist/git.js');
  const original = gitModule.runGit;
  let during: (() => void) | undefined;
  const runGit = vi
    .spyOn(gitModule, 'runGit')
    .mockImplementation((cwd, args, input, asynchronous, options) => {
      if (asynchronous === true) {
        vi.setSystemTime(Date.now() + 3000);
        if (during) queueMicrotask(during);
        during = undefined;
      }
      return original(cwd, args, input, asynchronous, options);
    });
  const reads = () =>
    runGit.mock.calls
      .filter((call) => call[3] === true)
      .map(([cwd, args]) => `${cwd} ${args.join(' ')}`);
  const prefetch = () => f.control.prefetchWorktreeReads(user, f.project.id);
  /** Runs action while the next asynchronous Git read runs. */
  const atNextRead = (action: () => void) => (during = action);
  return { prefetch, reads, atNextRead };
}

it('reuses the reads of a prefetch that ran past the reuse window right after it ends', async () => {
  const { prefetch, reads } = await slowReads();
  await prefetch();
  const read = reads().length;
  expect(read).toBeGreaterThan(0);
  await prefetch();
  expect(reads()).toHaveLength(read);
});

it('joins a prefetch still running past the reuse window instead of reading again', async () => {
  const { prefetch, reads, atNextRead } = await slowReads();
  let second: Promise<void> | undefined;
  atNextRead(() => (second = prefetch()));
  await prefetch();
  await second;
  expect(second).toBeDefined();
  expect(reads().length).toBeGreaterThan(0);
  expect(new Set(reads()).size).toBe(reads().length);
});

/** An idle session whose worktree a prefetch read, with the results of asynchronous Git reads held from here until release. */
async function heldReads() {
  const f = workbenchFixture();
  const session = await idleSession(f);
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
  vi.useFakeTimers({ toFake: ['Date'] });
  const prefetch = () => f.control.prefetchWorktreeReads(user, f.project.id);
  await prefetch();
  const gitModule = await import('../../packages/control/dist/git.js');
  const original = gitModule.runGit;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  vi.spyOn(gitModule, 'runGit').mockImplementation((cwd, args, input, asynchronous, options) => {
    const result = original(cwd, args, input, asynchronous, options);
    return asynchronous === true ? held.then(() => result) : result;
  });
  /** Whether the prefetch resolves while the Git reads are held. */
  const answersHeld = (prefetched: Promise<void>) =>
    Promise.race([
      prefetched.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
    ]);
  return { f, session, workspace, prefetch, release, answersHeld };
}

it('answers a prefetch without waiting for reads that only aged out, and emits when they land', async () => {
  const { f, session, workspace, prefetch, release, answersHeld } = await heldReads();
  const changed = () => f.store.kindEvents(f.project.id, ['workspace.repository_changed']).length;
  const before = changed();
  writeFileSync(path.join(workspace.path, 'note.txt'), 'uncommitted\n');
  vi.setSystemTime(Date.now() + 2001);
  expect(await answersHeld(prefetch())).toBe(true);
  release();
  await eventually(() => changed() > before);
  expect(
    f.control.sessionList(user, f.project.id, 'cached').find((row) => row.id === session.id)
      ?.changes?.files,
  ).toBe(1);
});

it('answers a prefetch only after the reads of a session with new activity', async () => {
  const { f, session, prefetch, release, answersHeld } = await heldReads();
  vi.setSystemTime(Date.now() + 1);
  f.store.event(
    'session.gate_checked',
    f.store.must<Session>('sessions', session.id),
    f.project.id,
    {
      results: [],
      check_spec_hash: 'an older gate',
      commit: 'an older commit',
    },
  );
  const prefetched = prefetch();
  expect(await answersHeld(prefetched)).toBe(false);
  release();
  await prefetched;
});

it('reads the worktrees ahead after a restart before any list', async () => {
  const f = workbenchFixture();
  const session = await idleSession(f);
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
  writeFileSync(path.join(workspace.path, 'note.txt'), 'uncommitted\n');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 2000);
  await f.restart();
  // The wait below needs a moving clock.
  vi.useRealTimers();
  const row = () =>
    f.control.sessionList(user, f.project.id, 'cached').find((each) => each.id === session.id);
  await eventually(() => row()?.changes?.files === 1);
});

it('reads the worktree again once a merge rebased it onto a source that moved', async () => {
  const f = workbenchFixture();
  git(f.source, 'config', 'user.name', 'Source User');
  git(f.source, 'config', 'user.email', 'source@example.invalid');
  const session = await idleSession(f);
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
  for (const [repository, name] of [
    [workspace.path, 'session.txt'],
    [f.source, 'source.txt'],
  ] as const) {
    writeFileSync(path.join(repository, name), `${name}\n`);
    git(repository, 'add', name);
    git(repository, 'commit', '--quiet', '-m', `Add ${name}`);
  }
  // A frozen clock keeps the list's reads inside their reuse window.
  vi.useFakeTimers({ toFake: ['Date'] });
  const row = () => f.list().find((each) => each.id === session.id);
  expect(row()).toMatchObject({ ahead: 1, behind: 1 });
  const gitModule = await import('../../packages/control/dist/git.js');
  const original = gitModule.runGit;
  let rebased: ReturnType<typeof row>;
  vi.spyOn(gitModule, 'runGit').mockImplementation((cwd, args, input, asynchronous, options) => {
    if (args[0] === 'merge' && args[1] === '--ff-only') rebased ??= row();
    return original(cwd, args, input, asynchronous, options);
  });
  f.call(
    'session.merge',
    { session_id: session.id },
    f.store.must<Session>('sessions', session.id).revision,
  );
  await eventually(
    () => rebased !== undefined,
    () => f.control.tick(),
  );
  expect(rebased).toMatchObject({ ahead: 1, behind: 0 });
});

it('expands only the runs a project gate history with a start returns', async () => {
  const f = workbenchFixture();
  const session = await idleSession(f);
  const at = Date.parse('2026-01-01T12:00:00Z');
  const now = vi.spyOn(f.store, 'now');
  const events = Array.from({ length: 50 }, (_, index) => {
    now.mockReturnValue(at + index * 100);
    return f.store.event('session.gate_checked', session, f.project.id, {
      workspace_id: session.workspace_id,
      commit: 'c'.repeat(40),
      check_spec_hash: 'spec',
      results: [{ name: 'check', argv: ['true'], exit_code: 0, duration_ms: 50, timed_out: false }],
    });
  });
  const must = vi.spyOn(f.store, 'must');

  const { runs } = f.control.projectGatesHistory(user, f.project.id, 1, at);
  expect(runs.map((run) => run.run_id)).toEqual([events.at(-1)!.event_id]);
  expect(must.mock.calls.filter(([table]) => table === 'workspaces')).toHaveLength(1);
});

it.skipIf(process.getuid?.() === 0)(
  'keeps a native history folder it cannot remove without an uncaught error',
  async () => {
    const f = workbenchFixture();
    const session = await idleSession(f);
    const history = path.join(f.root, 'state/native-sessions', f.project.id, 'fixture'),
      locked = path.join(history, 'locked');
    mkdirSync(locked, { recursive: true });
    writeFileSync(path.join(locked, 'transcript.jsonl'), '{}\n');
    chmodSync(locked, 0o555);
    f.store.update(
      'sessions',
      { ...session, native_state_dir: history },
      f.store.must<Session>('sessions', session.id).revision,
    );
    const uncaught: unknown[] = [];
    const record = (error: unknown) => uncaught.push(error);
    process.on('uncaughtException', record);
    try {
      f.call(
        'session.delete',
        { session_id: session.id },
        f.store.must<Session>('sessions', session.id).revision,
      );
      await eventually(
        () => !f.store.get<Session>('sessions', session.id),
        () => f.control.tick(),
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(uncaught).toEqual([]);
      expect(existsSync(path.join(locked, 'transcript.jsonl'))).toBe(true);
    } finally {
      process.off('uncaughtException', record);
      chmodSync(locked, 0o755);
    }
  },
);
