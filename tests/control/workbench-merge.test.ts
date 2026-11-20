import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import type {
  BoardPlan,
  Principal,
  Project,
  Session,
  SessionTurn,
  Workspace,
} from '@pantheon/domain';
import { readProcessIdentity } from '../../packages/adapters/dist/index.js';
import { transferPlan } from '../../packages/control/dist/board-plan.js';
import type { ControlContext } from '../../packages/control/src/context.js';
import { insideSandbox, awaitWorkspaceReady, eventually, heldIndexLock, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

/** A workbench whose source repository names the user who rebases onto it. */
async function mergeFixture(options: Parameters<typeof workbenchFixture>[0] = {}) {
  const f = await workbenchFixture(options);
  git(f.source, 'config', 'user.name', 'Source User');
  git(f.source, 'config', 'user.email', 'source@example.invalid');
  return f;
}

/** A session whose first turn has ended, with its ready worktree and the source HEAD it started from. */
async function idleSession(f: Fixture) {
  const sourceHead = git(f.source, 'rev-parse', 'HEAD');
  const session = await f.create();
  const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.turns(session.id)[0]!.state === 'completed' &&
      f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  return { session, workspace, sourceHead };
}

function commit(repository: string, name: string, contents: string) {
  mkdirSync(path.dirname(path.join(repository, name)), { recursive: true });
  writeFileSync(path.join(repository, name), contents);
  git(repository, 'add', '--', name);
  git(repository, 'commit', '--quiet', '-m', `Update ${name}`);
  return git(repository, 'rev-parse', 'HEAD');
}

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);

const merge = (f: Fixture, sessionId: string, principal: Principal = user) =>
  f.call<Session>(
    'session.merge',
    { session_id: sessionId },
    current(f, sessionId).revision,
    principal,
  );

const payloads = (f: Fixture, sessionId: string, kind: string) =>
  (
    f.store.db
      .prepare('SELECT payload FROM events WHERE aggregate_id=? AND kind=? ORDER BY sequence')
      .all(sessionId, kind) as { payload: string }[]
  ).map((row) => JSON.parse(row.payload) as Record<string, unknown>);

const removed = (f: Fixture, workspaceId: string) =>
  f.store.must<Workspace>('workspaces', workspaceId).removed_at !== undefined;

async function setGate(f: Fixture, commands: { name: string; argv: string[] }[]) {
  await f.call<Project>(
    'project.gate.set',
    { project_id: f.project.id, root: f.source, commands },
    f.store.must<Project>('projects', f.project.id).revision,
  );
}

it('fast-forwards the source branch to the session commit and removes the worktree', async () => {
  const f = await mergeFixture();
  const { session, workspace, sourceHead } = await idleSession(f);
  const head = commit(workspace.path, 'answer.txt', 'merged\n');
  expect((await merge(f, session.id)).merge).toEqual({ state: 'running' });
  await eventually(
    () => removed(f, workspace.id),
    () => f.control.tick(),
  );
  expect(git(f.source, 'rev-parse', 'main')).toBe(head);
  expect(current(f, session.id)).toMatchObject({ state: 'closed', outcome: 'merged' });
  expect(current(f, session.id).merge).toBeUndefined();
  expect(f.list()[0]).toMatchObject({ state: 'merged', merge: null, changes: null });
  expect(existsSync(workspace.path)).toBe(false);
  expect(git(f.source, 'worktree', 'list')).not.toContain(workspace.path);
  expect(payloads(f, session.id, 'session.merge_started')).toHaveLength(1);
  expect(payloads(f, session.id, 'session.merged')).toEqual([
    {
      branch: 'main',
      source: workspace.source,
      from_sha: sourceHead,
      to_sha: head,
      files: 1,
      additions: 1,
      deletions: 1,
      measured_kind: { domain: 'backend-logic', tier: 't1' },
    },
  ]);
});

it('fast-forwards the source once another git gives up the index lock it held', async () => {
  const f = await mergeFixture();
  const { session, workspace } = await idleSession(f);
  const head = commit(workspace.path, 'answer.txt', 'merged\n');
  const held = heldIndexLock('merge --ff-only');
  onTestFinished(held.restore);
  await merge(f, session.id);
  await eventually(
    () => removed(f, workspace.id) || current(f, session.id).merge?.state === 'blocked',
    () => f.control.tick(),
  );
  expect(current(f, session.id).merge).toBeUndefined();
  expect(git(f.source, 'rev-parse', 'main')).toBe(head);
});

it('drops and records a queued merge of a session that no longer exists', async () => {
  const f = await mergeFixture();
  const job = f.store.enqueue('session.merge', { session_id: 'retired-session' });
  await expect(f.control.tick()).resolves.toBeUndefined();
  expect(f.store.pending().map((pending) => pending.id)).not.toContain(job);
  expect(payloads(f, 'retired-session', 'session.merge_dropped')).toEqual([
    { reason: 'session_missing' },
  ]);
});

it('bases the worktree on the branch read when the session opened, though the source switched branch before provisioning', async () => {
  const f = await mergeFixture();
  const mainHead = git(f.source, 'rev-parse', 'HEAD');
  git(f.source, 'checkout', '--quiet', '-b', 'other');
  commit(f.source, 'other.txt', 'other\n');
  git(f.source, 'checkout', '--quiet', 'main');
  const session = await f.create();
  git(f.source, 'checkout', '--quiet', 'other');
  const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
  expect(workspace).toMatchObject({ source_branch: 'main', base_sha: mainHead });
});

it('rebases the session onto a newer source commit and keeps the history linear', async () => {
  const f = await mergeFixture();
  const { session, workspace } = await idleSession(f);
  commit(workspace.path, 'session.txt', 'session\n');
  const theirs = commit(f.source, 'source.txt', 'source\n');
  await merge(f, session.id);
  await eventually(
    () => removed(f, workspace.id),
    () => f.control.tick(),
  );
  expect(current(f, session.id).outcome).toBe('merged');
  expect(git(f.source, 'rev-parse', 'main^')).toBe(theirs);
  expect(git(f.source, 'rev-list', '--count', 'main')).toBe('3');
  expect(git(f.source, 'rev-list', '--merges', 'main')).toBe('');
  expect(git(f.source, 'show', 'main:session.txt')).toBe('session');
  expect(git(f.source, 'show', 'main:source.txt')).toBe('source');
  expect(payloads(f, session.id, 'session.merged')).toEqual([
    {
      branch: 'main',
      source: workspace.source,
      from_sha: theirs,
      to_sha: git(f.source, 'rev-parse', 'main'),
      files: 1,
      additions: 1,
      deletions: 0,
      measured_kind: { domain: 'backend-logic', tier: 't1' },
    },
  ]);
});

it('rebases without moving another branch that points at the session commit', async () => {
  const f = await mergeFixture();
  const { session, workspace } = await idleSession(f);
  const ours = commit(workspace.path, 'session.txt', 'session\n');
  git(f.source, 'branch', 'kept-at-session', ours);
  git(f.source, 'config', 'rebase.updateRefs', 'true');
  commit(f.source, 'source.txt', 'source\n');
  await merge(f, session.id);
  await eventually(
    () => removed(f, workspace.id),
    () => f.control.tick(),
  );
  expect(current(f, session.id).outcome).toBe('merged');
  expect(git(f.source, 'rev-parse', 'main')).not.toBe(ours);
  expect(git(f.source, 'rev-parse', 'kept-at-session')).toBe(ours);
});

it.each(['an untracked file', 'a new commit'])(
  'keeps a merged worktree that received %s after its merge',
  async (change) => {
    const f = await mergeFixture();
    const { session, workspace } = await idleSession(f);
    commit(workspace.path, 'answer.txt', 'merged\n');
    await merge(f, session.id);
    // The merge finishes without further ticks, so the removal it queues has not run yet.
    await f.control.tick();
    await eventually(() => current(f, session.id).outcome === 'merged');
    if (change === 'a new commit') commit(workspace.path, 'after-merge.txt', 'kept\n');
    else writeFileSync(path.join(workspace.path, 'after-merge.txt'), 'kept\n');
    await f.control.tick();
    await f.control.tick();
    expect(existsSync(path.join(workspace.path, 'after-merge.txt'))).toBe(true);
    expect(removed(f, workspace.id)).toBe(false);
  },
);

it('blocks a gated merge whose commit reaches a dependency folder through a symbolic link', async () => {
  const f = await mergeFixture();
  commit(f.source, '.gitignore', 'node_modules/\n');
  commit(f.source, 'packages/app/index.js', 'export {};\n');
  mkdirSync(path.join(f.source, 'packages/app/node_modules/pkg'), { recursive: true });
  writeFileSync(
    path.join(f.source, 'packages/app/node_modules/pkg/index.js'),
    'module.exports = 42;\n',
  );
  const { session, workspace, sourceHead } = await idleSession(f);
  await setGate(f, [{ name: 'Never reached', argv: [process.execPath, '-e', 'process.exit(0)'] }]);
  rmSync(path.join(workspace.path, 'packages'), { recursive: true });
  symlinkSync('elsewhere', path.join(workspace.path, 'packages'));
  git(workspace.path, 'add', '-A');
  git(workspace.path, 'commit', '--quiet', '-m', 'Link packages elsewhere');
  await merge(f, session.id);
  await eventually(
    () => current(f, session.id).merge?.state === 'blocked',
    () => f.control.tick(),
    10000,
  );
  expect(current(f, session.id).merge).toMatchObject({
    state: 'blocked',
    reason: 'dependency_folder_skipped',
  });
  expect(git(f.source, 'rev-parse', 'main')).toBe(sourceHead);
});

it('blocks a conflicting merge, keeps the worktree and clears the block on the next message', async () => {
  const f = await mergeFixture();
  const { session, workspace } = await idleSession(f);
  const ours = commit(workspace.path, 'answer.txt', 'session\n');
  const theirs = commit(f.source, 'answer.txt', 'source\n');
  await merge(f, session.id);
  await eventually(
    () => current(f, session.id).merge?.state === 'blocked',
    () => f.control.tick(),
  );
  expect(current(f, session.id).merge).toEqual({
    state: 'blocked',
    reason: 'rebase_conflict',
    conflicts: ['answer.txt'],
    conflict_commits: ['Update answer.txt'],
  });
  expect(payloads(f, session.id, 'session.merge_blocked')).toHaveLength(1);
  expect(git(f.source, 'rev-parse', 'main')).toBe(theirs);
  expect(existsSync(workspace.path)).toBe(true);
  expect(git(workspace.path, 'rev-parse', 'HEAD')).toBe(ours);
  expect(git(workspace.path, 'status', '--porcelain=v1')).toBe('');
  await f.prefetch();
  expect(f.list()[0]).toMatchObject({
    state: 'ready',
    merge: { state: 'blocked', reason: 'rebase_conflict', conflicts: ['answer.txt'] },
  });
  const turn = f.call<SessionTurn>(
    'session.send',
    { session_id: session.id, input: 'Resolve the conflict' },
    current(f, session.id).revision,
  );
  expect(current(f, session.id).merge).toBeUndefined();
  await eventually(
    () => f.store.must<SessionTurn>('session_turns', turn.id).state === 'completed',
    () => f.control.tick(),
  );
  expect(f.list()[0]!.merge).toBeNull();
});

it.skipIf(insideSandbox)(
  'blocks a merge whose project gate fails and leaves the source unchanged',
  async () => {
    const f = await mergeFixture();
    const { session, workspace, sourceHead } = await idleSession(f);
    await setGate(f, [
      {
        name: 'Always fails',
        argv: [process.execPath, '-e', "process.stderr.write('gate broke'); process.exit(3)"],
      },
    ]);
    commit(workspace.path, 'answer.txt', 'gated\n');
    await merge(f, session.id);
    await eventually(
      () => current(f, session.id).merge?.state === 'blocked',
      () => f.control.tick(),
      10000,
    );
    const blocked = current(f, session.id).merge!;
    expect(blocked).toMatchObject({ state: 'blocked', reason: 'gate_failed' });
    expect(blocked.gate?.name).toBe('Always fails');
    expect(blocked.gate?.output).toContain('gate broke');
    expect(git(f.source, 'rev-parse', 'main')).toBe(sourceHead);
    expect(payloads(f, session.id, 'session.gate_started')).toHaveLength(1);
    expect(payloads(f, session.id, 'session.gate_checked')).toHaveLength(1);
    expect(existsSync(workspace.path)).toBe(true);
    expect(current(f, session.id).outcome).toBeUndefined();
  },
);

it.skipIf(insideSandbox)(
  'gates the session commit rebased onto a source that moved, not the stale commit',
  async () => {
    const f = await mergeFixture();
    const { session, workspace } = await idleSession(f);
    // The gate passes only once the source's fix is under the session commit.
    await setGate(f, [
      {
        name: 'Needs the source fix',
        argv: [
          process.execPath,
          '-e',
          "process.exit(require('node:fs').existsSync('fix.txt') ? 0 : 3)",
        ],
      },
    ]);
    commit(workspace.path, 'answer.txt', 'made before the fix\n');
    const fixed = commit(f.source, 'fix.txt', 'fix\n');
    await merge(f, session.id);
    await settled(f, session.id);
    expect(current(f, session.id).merge?.state).not.toBe('blocked');
    expect(git(f.source, 'rev-parse', 'main~1')).toBe(fixed);
    expect(payloads(f, session.id, 'session.gate_started')).toHaveLength(1);
  },
);

it.skipIf(insideSandbox)(
  'runs gates outside temporary directories, where managed workspaces may be created',
  async () => {
    const f = await mergeFixture();
    const { session, workspace } = await idleSession(f);
    await setGate(f, [
      {
        name: 'Not in a temporary directory',
        argv: [
          process.execPath,
          '-e',
          "const cwd = require('node:fs').realpathSync(process.cwd()); process.exit(['/private/tmp/', '/private/var/folders/'].some((root) => cwd.startsWith(root)) ? 3 : 0)",
        ],
      },
    ]);
    commit(workspace.path, 'answer.txt', 'gated outside temporary directories\n');
    await merge(f, session.id);
    await settled(f, session.id);
    expect(current(f, session.id).merge?.state).not.toBe('blocked');
  },
);

it('blocks rebasing a session whose commits include a merge, whose own changes a rebase drops', async () => {
  const f = await mergeFixture();
  const { session, workspace } = await idleSession(f);
  commit(workspace.path, 'session.txt', 'session\n');
  commit(f.source, 'source.txt', 'source\n');
  git(workspace.path, 'merge', '--quiet', '--no-ff', '--no-commit', 'main');
  writeFileSync(path.join(workspace.path, 'fix.txt'), 'fix made in the merge\n');
  git(workspace.path, 'add', '--', 'fix.txt');
  git(workspace.path, 'commit', '--quiet', '-m', 'Merge the source with a fix');
  const theirs = commit(f.source, 'later.txt', 'later\n');
  await merge(f, session.id);
  await settled(f, session.id);
  expect(current(f, session.id).merge).toMatchObject({
    state: 'blocked',
    reason: 'merge_commits',
  });
  expect(git(f.source, 'rev-parse', 'main')).toBe(theirs);
  expect(existsSync(path.join(workspace.path, 'fix.txt'))).toBe(true);
});

it('blocks a session commit that changes agent configuration and never writes it into the worktree', async () => {
  const f = await mergeFixture();
  const { session, workspace } = await idleSession(f);
  // Committed through the index alone and hidden from status, so the worktree never holds it.
  const settings = path.join(f.root, 'agent-settings.json');
  writeFileSync(settings, '{"hooks":{"SessionStart":[]}}\n');
  const blob = git(workspace.path, 'hash-object', '-w', '--', settings);
  git(
    workspace.path,
    'update-index',
    '--add',
    '--cacheinfo',
    `100644,${blob},.claude/settings.json`,
  );
  git(workspace.path, 'update-index', '--skip-worktree', '--', '.claude/settings.json');
  git(workspace.path, 'commit', '--quiet', '-m', 'Add agent settings');
  const theirs = commit(f.source, 'source.txt', 'source\n');
  await merge(f, session.id);
  await settled(f, session.id);
  expect(current(f, session.id).merge).toMatchObject({
    state: 'blocked',
    reason: 'protected_paths',
    conflicts: ['.claude/settings.json'],
  });
  expect(existsSync(path.join(workspace.path, '.claude/settings.json'))).toBe(false);
  expect(git(f.source, 'rev-parse', 'main')).toBe(theirs);
});

it.skipIf(insideSandbox)(
  'fails the gate when a gate command changes tracked files of the candidate',
  async () => {
    const f = await mergeFixture();
    const { session, workspace, sourceHead } = await idleSession(f);
    await setGate(f, [
      {
        name: 'Rewrites the answer',
        argv: [
          process.execPath,
          '-e',
          "require('node:fs').writeFileSync('answer.txt', 'rewritten by the gate\\n')",
        ],
      },
      { name: 'Prints ok', argv: [process.execPath, '-e', "process.stdout.write('ok')"] },
    ]);
    commit(workspace.path, 'answer.txt', 'gated\n');
    await merge(f, session.id);
    await settled(f, session.id);
    const blocked = current(f, session.id).merge!;
    expect(blocked).toMatchObject({ state: 'blocked', reason: 'gate_failed' });
    expect(blocked.gate?.name).toBe('Rewrites the answer');
    expect(blocked.gate?.output).toContain('answer.txt');
    expect(git(f.source, 'rev-parse', 'main')).toBe(sourceHead);
  },
);

it('refuses no commits, a non-user principal and a discarded session', async () => {
  const f = await mergeFixture();
  const { session } = await idleSession(f);
  const planner: Principal = {
    id: 'planner',
    role: 'planner',
    project_id: f.project.id,
  };
  expect(() => merge(f, session.id, planner)).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
  await expect(merge(f, session.id)).rejects.toThrow(
    expect.objectContaining({ code: 'no_changes' }),
  );
  expect(current(f, session.id).merge).toBeUndefined();
  f.call<Session>('session.discard', { session_id: session.id }, current(f, session.id).revision);
  await eventually(
    () => current(f, session.id).outcome === 'discarded',
    () => f.control.tick(),
  );
  expect(() => merge(f, session.id)).toThrow(expect.objectContaining({ code: 'invalid_state' }));
});

it('refuses the uncommitted and untracked files of a task session, whose agent commits its own work', async () => {
  const f = await mergeFixture();
  const { session, workspace } = await taskSession(f, 'api');
  writeFileSync(path.join(workspace.path, 'untracked.txt'), 'new\n');
  await expect(merge(f, session.id)).rejects.toThrow(
    expect.objectContaining({ code: 'uncommitted_changes' }),
  );
  commit(workspace.path, 'committed.txt', 'kept\n');
  await expect(merge(f, session.id)).rejects.toThrow(
    expect.objectContaining({ code: 'uncommitted_changes' }),
  );
  writeFileSync(path.join(workspace.path, 'answer.txt'), 'edited\n');
  git(workspace.path, 'add', 'untracked.txt');
  git(workspace.path, 'commit', '--quiet', '-m', 'Add the untracked file');
  await expect(merge(f, session.id)).rejects.toThrow(
    expect.objectContaining({ code: 'uncommitted_changes' }),
  );
  expect(current(f, session.id).merge).toBeUndefined();
  expect(git(workspace.path, 'log', '-1', '--format=%s')).toBe('Add the untracked file');
});

it.skipIf(insideSandbox)(
  'commits the uncommitted and untracked files of a session the user opened under its title, then gates and merges that commit',
  async () => {
    const f = await mergeFixture();
    const { session, workspace, sourceHead } = await idleSession(f);
    await setGate(f, [{ name: 'Passes', argv: [process.execPath, '-e', 'process.exit(0)'] }]);
    writeFileSync(path.join(workspace.path, 'answer.txt'), 'edited\n');
    writeFileSync(path.join(workspace.path, 'untracked.txt'), 'new\n');
    expect((await merge(f, session.id)).merge).toEqual({ state: 'running' });
    const head = git(workspace.path, 'rev-parse', 'HEAD');
    expect(git(workspace.path, 'rev-parse', 'HEAD^')).toBe(sourceHead);
    expect(git(workspace.path, 'log', '-1', '--format=%s')).toBe(current(f, session.id).title);
    await settled(f, session.id);
    expect(current(f, session.id)).toMatchObject({ state: 'closed', outcome: 'merged' });
    expect(git(f.source, 'rev-parse', 'main')).toBe(head);
    expect(git(f.source, 'show', 'main:untracked.txt')).toBe('new');
    expect(git(f.source, 'show', 'main:answer.txt')).toBe('edited');
    expect(payloads(f, session.id, 'session.gate_checked').map((each) => each.commit)).toEqual([
      head,
    ]);
  },
);

it.each([
  { name: 'a session the user opened', task: false, state: 'ready' },
  { name: 'a task session', task: true, state: 'idle' },
])('lists $name with only uncommitted files as $state', async ({ task, state }) => {
  const f = await mergeFixture();
  const { session, workspace } = task ? await taskSession(f, 'api') : await idleSession(f);
  writeFileSync(path.join(workspace.path, 'untracked.txt'), 'new\n');
  await f.prefetch();
  expect(f.list().find((row) => row.id === session.id)?.state).toBe(state);
});

it('refuses to merge a session while its turn runs', async () => {
  const f = await mergeFixture({ delay: 4000 });
  const session = await f.create();
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.turns(session.id)[0]!.state === 'running',
    () => f.control.tick(),
  );
  expect(() => merge(f, session.id)).toThrow(expect.objectContaining({ code: 'resource_busy' }));
});

it.skipIf(insideSandbox)(
  'lists a merging session and refuses its messages until the gate ends',
  async () => {
    const f = await mergeFixture();
    const { session, workspace } = await idleSession(f);
    await setGate(f, [
      {
        name: 'Wait for release',
        argv: [
          process.execPath,
          '-e',
          "const fs = require('node:fs'); const timer = setInterval(() => { if (fs.existsSync('release')) clearInterval(timer); }, 10);",
        ],
      },
    ]);
    const head = commit(workspace.path, 'answer.txt', 'waited\n');
    await merge(f, session.id);
    await eventually(
      () => payloads(f, session.id, 'session.gate_started').length === 1,
      () => f.control.tick(),
      10000,
    );
    expect(f.list()[0]).toMatchObject({ state: 'merging', merge: { state: 'running' } });
    expect(() =>
      f.call(
        'session.send',
        { session_id: session.id, input: 'One more change' },
        current(f, session.id).revision,
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid_state' }));
    expect(() => merge(f, session.id)).toThrow(expect.objectContaining({ code: 'resource_busy' }));
    const candidate = payloads(f, session.id, 'session.gate_started')[0]!.candidate_path as string;
    writeFileSync(path.join(candidate, 'release'), 'release\n');
    await eventually(
      () => removed(f, workspace.id),
      () => f.control.tick(),
      10000,
    );
    expect(git(f.source, 'rev-parse', 'main')).toBe(head);
    expect(current(f, session.id).outcome).toBe('merged');
  },
);

/** Holds every close of a native process until the returned release is called. */
function holdClose(f: Fixture) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const close = f.adapter.close.bind(f.adapter);
  vi.spyOn(f.adapter, 'close').mockImplementation(async (handle, deadline) => {
    await released;
    return close(handle, deadline);
  });
  return release;
}

const hasProcess = (f: Fixture, sessionId: string) =>
  [...(f.control as unknown as { ctx: ControlContext }).ctx.handles.values()].some(
    (handle) => handle.platform_session_id === sessionId,
  );

it.skipIf(insideSandbox)(
  'refuses to discard a session while its merge gate runs and lands it once the gate passes',
  async () => {
    const f = await mergeFixture();
    const { session, workspace } = await idleSession(f);
    await setGate(f, [
      {
        name: 'Wait for release',
        argv: [
          process.execPath,
          '-e',
          "const fs = require('node:fs'); const timer = setInterval(() => { if (fs.existsSync('release')) clearInterval(timer); }, 10);",
        ],
      },
    ]);
    const head = commit(workspace.path, 'answer.txt', 'merged after a refused discard\n');
    await merge(f, session.id);
    await eventually(
      () => payloads(f, session.id, 'session.gate_started').length === 1,
      () => f.control.tick(),
      10000,
    );
    expect(() =>
      f.call<Session>(
        'session.discard',
        { session_id: session.id },
        current(f, session.id).revision,
      ),
    ).toThrow(expect.objectContaining({ code: 'merge_in_progress' }));
    expect(current(f, session.id).stop_requested).toBeUndefined();
    const candidate = payloads(f, session.id, 'session.gate_started')[0]!.candidate_path as string;
    writeFileSync(path.join(candidate, 'release'), 'release\n');
    await eventually(
      () => removed(f, workspace.id),
      () => f.control.tick(),
      10000,
    );
    expect(git(f.source, 'rev-parse', 'main')).toBe(head);
    expect(current(f, session.id)).toMatchObject({ state: 'closed', outcome: 'merged' });
  },
);

it('refuses to discard a session whose merge moved the source and still closes its process, then records the merge', async () => {
  const f = await mergeFixture();
  const { session, workspace } = await idleSession(f);
  const head = commit(workspace.path, 'answer.txt', 'merged before the discard\n');
  expect(hasProcess(f, session.id)).toBe(true);
  const release = holdClose(f);
  await merge(f, session.id);
  try {
    await eventually(
      () => current(f, session.id).merge?.landing?.stage === 'fast_forwarded',
      () => f.control.tick(),
    );
    expect(git(f.source, 'rev-parse', 'main')).toBe(head);
    expect(() =>
      f.call<Session>(
        'session.discard',
        { session_id: session.id },
        current(f, session.id).revision,
      ),
    ).toThrow(expect.objectContaining({ code: 'merge_in_progress' }));
  } finally {
    release();
  }
  await eventually(
    () => removed(f, workspace.id),
    () => f.control.tick(),
  );
  expect(current(f, session.id)).toMatchObject({ state: 'closed', outcome: 'merged' });
  expect(payloads(f, session.id, 'session.merged')).toHaveLength(1);
  expect(payloads(f, session.id, 'session.discarded')).toEqual([]);
});

it('refuses to merge a session that is being discarded', async () => {
  const f = await mergeFixture();
  const { session, workspace } = await idleSession(f);
  commit(workspace.path, 'answer.txt', 'discarded before the merge\n');
  expect(hasProcess(f, session.id)).toBe(true);
  const release = holdClose(f);
  f.call<Session>('session.discard', { session_id: session.id }, current(f, session.id).revision);
  expect(current(f, session.id).outcome).toBeUndefined();
  try {
    expect(() => merge(f, session.id)).toThrow(expect.objectContaining({ code: 'invalid_state' }));
  } finally {
    release();
  }
});

it('restarts after a crash that left a session gate process record', async () => {
  const f = await mergeFixture();
  const { session, workspace } = await idleSession(f);
  const head = commit(workspace.path, 'answer.txt', 'crashed during the gate\n');
  await merge(f, session.id);
  // A gate started before the crash; its process has since exited.
  const exited = spawnSync(process.execPath, ['-e', '']).pid!;
  f.store.transaction(() => {
    f.store.remember(`gate-process:session-${session.id}:${workspace.id}`, '', {
      pid: exited,
      started: Date.now() * 1000,
    });
  });
  await f.restart();
  expect(payloads(f, session.id, 'session.gate_process_reaped')).toMatchObject([
    { workspace_id: workspace.id, pid: exited, killed: false },
  ]);
  await eventually(
    () => removed(f, workspace.id),
    () => f.control.tick(),
    10000,
  );
  expect(git(f.source, 'rev-parse', 'main')).toBe(head);
});

it('kills a gate process left running whose record holds a whole-second start time', async () => {
  const f = await mergeFixture();
  const { session, workspace } = await idleSession(f);
  commit(workspace.path, 'answer.txt', 'gate still running at the crash\n');
  await merge(f, session.id);
  // Its parent exits at once, as a crashed daemon's would, so launchd reaps it once killed.
  // It leads its own process group, as a gate does; dash ignores set -m without a terminal.
  const pid = Number(
    spawnSync(
      process.execPath,
      [
        '-e',
        `const gate = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' }); gate.unref(); console.log(gate.pid);`,
      ],
      {
        encoding: 'utf8',
      },
    ).stdout.trim(),
  );
  try {
    const started = readProcessIdentity(pid)!.start_time_us!;
    f.store.transaction(() => {
      f.store.remember(`gate-process:session-${session.id}:${workspace.id}`, '', {
        pid,
        // Records written before start times carried microseconds hold whole seconds.
        started: Math.floor(started / 1_000_000) * 1_000_000,
      });
    });
    await f.restart();
    expect(payloads(f, session.id, 'session.gate_process_reaped')).toMatchObject([
      { workspace_id: workspace.id, pid, killed: true },
    ]);
  } finally {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
});

it('finishes a merge queued before a restart and moves the source once', async () => {
  const f = await mergeFixture();
  const { session, workspace } = await idleSession(f);
  const head = commit(workspace.path, 'answer.txt', 'restarted\n');
  await merge(f, session.id);
  await f.restart();
  await eventually(
    () => removed(f, workspace.id),
    () => f.control.tick(),
  );
  expect(git(f.source, 'rev-parse', 'main')).toBe(head);
  expect(git(f.source, 'rev-list', '--count', 'main')).toBe('2');
  expect(current(f, session.id).outcome).toBe('merged');
  expect(payloads(f, session.id, 'session.merged')).toHaveLength(1);
});

it('completes a merge rerun after a crash that already moved the source', async () => {
  const f = await mergeFixture();
  const { session, workspace } = await idleSession(f);
  const head = commit(workspace.path, 'answer.txt', 'landed before the crash\n');
  await merge(f, session.id);
  git(f.source, 'merge', '--quiet', '--ff-only', head);
  await f.restart();
  await eventually(
    () => removed(f, workspace.id),
    () => f.control.tick(),
  );
  expect(git(f.source, 'rev-parse', 'main')).toBe(head);
  expect(git(f.source, 'rev-list', '--count', 'main')).toBe('2');
  expect(current(f, session.id)).toMatchObject({ state: 'closed', outcome: 'merged' });
});

it('blocks the merge of a worktree left partway through a rebase and leaves the source as it was', async () => {
  const f = await mergeFixture();
  const { session, workspace } = await idleSession(f);
  commit(workspace.path, 'first.txt', 'first\n');
  commit(workspace.path, 'second.txt', 'second\n');
  const theirs = commit(f.source, 'source.txt', 'source\n');
  // The rebase stops after its first commit, as when the daemon dies between two of them.
  const stopped = spawnSync('git', ['rebase', '--quiet', '--exec', 'false', theirs], {
    cwd: workspace.path,
  });
  expect(stopped.status).not.toBe(0);
  const partial = git(workspace.path, 'rev-parse', 'HEAD');
  expect(git(workspace.path, 'status', '--porcelain=v1')).toBe('');
  await merge(f, session.id);
  await eventually(
    () =>
      current(f, session.id).outcome === 'merged' ||
      current(f, session.id).merge?.state === 'blocked',
    () => f.control.tick(),
  );
  expect(current(f, session.id).merge).toEqual({ state: 'blocked', reason: 'rebase_interrupted' });
  expect(git(f.source, 'rev-parse', 'main')).toBe(theirs);
  expect(git(workspace.path, 'rev-parse', 'HEAD')).toBe(partial);
  expect(
    existsSync(
      path.resolve(workspace.path, git(workspace.path, 'rev-parse', '--git-path', 'rebase-merge')),
    ),
  ).toBe(true);
});

it.skipIf(insideSandbox)(
  'records the merged range once and skips the gate when a merge reruns after a crash that followed the fast-forward',
  async () => {
    const f = await mergeFixture();
    const { session, workspace, sourceHead } = await idleSession(f);
    await setGate(f, [{ name: 'Passes', argv: [process.execPath, '-e', 'process.exit(0)'] }]);
    commit(workspace.path, 'first.txt', 'first\n');
    const head = commit(workspace.path, 'second.txt', 'second\n');
    let crashed = false;
    (f.control as unknown as { ctx: { failpoint: (name: string) => void } }).ctx.failpoint = (
      name,
    ) => {
      if (name !== 'after_fast_forward_before_receipt') return;
      crashed = true;
      throw new Error('Crashed after the fast-forward');
    };
    await merge(f, session.id);
    await eventually(
      () => crashed,
      () => f.control.tick(),
      10000,
    );
    expect(git(f.source, 'rev-parse', 'main')).toBe(head);
    expect(current(f, session.id).outcome).toBeUndefined();
    await f.restart();
    await eventually(
      () => removed(f, workspace.id),
      () => f.control.tick(),
      10000,
    );
    expect(current(f, session.id)).toMatchObject({ state: 'closed', outcome: 'merged' });
    // The same range and files a merge without the crash records.
    expect(payloads(f, session.id, 'session.merged')).toEqual([
      {
        branch: 'main',
        source: workspace.source,
        from_sha: sourceHead,
        to_sha: head,
        files: 2,
        additions: 2,
        deletions: 0,
        measured_kind: { domain: 'backend-logic', tier: 't1' },
      },
    ]);
    expect(payloads(f, session.id, 'session.gate_started')).toHaveLength(1);
  },
);

it('discards a session whose worktree is still being prepared', async () => {
  const f = await mergeFixture();
  const session = await f.create();
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
  f.call<Session>('session.discard', { session_id: session.id }, session.revision);
  expect(current(f, session.id)).toMatchObject({ state: 'closed', outcome: 'discarded' });
  expect(f.turns(session.id)).toMatchObject([{ state: 'failed', delivery: 'failed' }]);
  await eventually(
    () => removed(f, workspace.id),
    () => f.control.tick(),
  );
  expect(current(f, session.id)).toMatchObject({ state: 'closed', outcome: 'discarded' });
  expect(f.store.must<Workspace>('workspaces', workspace.id).provisioning?.state).toBe('cancelled');
  expect(f.start).not.toHaveBeenCalled();
  expect(f.list()[0]).toMatchObject({ state: 'discarded' });
  expect(existsSync(workspace.path)).toBe(false);
  expect(git(f.source, 'worktree', 'list')).not.toContain(workspace.path);
});

it('merges two sessions asked to merge at once into the same source one after the other', async () => {
  const f = await mergeFixture();
  const first = await idleSession(f),
    second = await idleSession(f);
  commit(first.workspace.path, 'add.txt', 'add\n');
  commit(second.workspace.path, 'mul.txt', 'mul\n');
  await merge(f, first.session.id);
  await merge(f, second.session.id);
  await eventually(
    () => removed(f, first.workspace.id) && removed(f, second.workspace.id),
    () => f.control.tick(),
  );
  expect(current(f, first.session.id).outcome).toBe('merged');
  expect(current(f, second.session.id).outcome).toBe('merged');
  expect(git(f.source, 'show', 'main:add.txt')).toBe('add');
  expect(git(f.source, 'show', 'main:mul.txt')).toBe('mul');
  expect(git(f.source, 'status', '--porcelain')).toBe('');
});

const leadId = 'lead-session-of-plan';

/** Writes the lead's plan with one task per entry, each limited to its scope paths. */
function setScopes(f: Fixture, scopes: Record<string, string[]>) {
  const tasks = Object.entries(scopes).map(([id, scope]) => ({
    id,
    title: `Task ${id}`,
    goal: `Finish ${id}`,
    lane: 'core',
    depends_on: [],
    source: [],
    scope,
    acceptance: [],
  }));
  f.store.transaction(() => {
    const existing = f.store.get<BoardPlan>('board_plans', leadId);
    if (existing) {
      f.store.update<BoardPlan>('board_plans', { ...existing, tasks }, existing.revision);
      return;
    }
    f.store.insert<BoardPlan>('board_plans', {
      id: leadId,
      revision: 1,
      project_id: f.project.id,
      headline: 'Scoped work',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks,
      risks: [],
      assumptions: [],
      plan_version: 0,
      pending_edits: [],
      inbox: [],
      notified: {},
      updated_at: f.store.now(),
    });
  });
}

/** An idle session opened from the board task. */
async function taskSession(f: Fixture, taskId: string) {
  const idle = await idleSession(f);
  const session = current(f, idle.session.id);
  f.store.update<Session>(
    'sessions',
    { ...session, task: { lead_session_id: leadId, id: taskId } },
    session.revision,
  );
  return idle;
}

const settled = (f: Fixture, sessionId: string) =>
  eventually(
    () =>
      current(f, sessionId).outcome === 'merged' ||
      current(f, sessionId).merge?.state === 'blocked',
    () => f.control.tick(),
    10000,
  );

it('blocks a task merge that changes files outside the task scope and lands once the scope covers them', async () => {
  const f = await mergeFixture();
  setScopes(f, { api: ['src/a'] });
  const { session, workspace, sourceHead } = await taskSession(f, 'api');
  commit(workspace.path, 'src/a/x.ts', 'export const x = 1;\n');
  const head = commit(workspace.path, 'README.md', 'Outside the scope\n');
  await merge(f, session.id);
  await settled(f, session.id);
  expect(current(f, session.id).merge).toEqual({
    state: 'blocked',
    reason: 'out_of_scope',
    conflicts: ['README.md'],
  });
  expect(git(f.source, 'rev-parse', 'main')).toBe(sourceHead);

  setScopes(f, { api: ['src/a', './README.md'] });
  await merge(f, session.id);
  await settled(f, session.id);
  expect(current(f, session.id).outcome).toBe('merged');
  expect(git(f.source, 'rev-parse', 'main')).toBe(head);
});

it.skipIf(insideSandbox).each([
  ['without a gate', false],
  ['through a gate', true],
])(
  'does not count the files of an earlier task merge against a later task rebased onto it, %s',
  async (_, gated) => {
    const f = await mergeFixture();
    if (gated)
      await setGate(f, [{ name: 'Passes', argv: [process.execPath, '-e', 'process.exit(0)'] }]);
    setScopes(f, { first: ['src/a'], second: ['src/b'] });
    const first = await taskSession(f, 'first'),
      second = await taskSession(f, 'second');
    commit(first.workspace.path, 'src/a/x.ts', 'export const x = 1;\n');
    commit(second.workspace.path, 'src/b/y.ts', 'export const y = 2;\n');
    await merge(f, first.session.id);
    await settled(f, first.session.id);
    expect(current(f, first.session.id).outcome).toBe('merged');
    await merge(f, second.session.id);
    await settled(f, second.session.id);
    expect(current(f, second.session.id).merge).toBeUndefined();
    expect(current(f, second.session.id).outcome).toBe('merged');
    expect(git(f.source, 'show', 'main:src/a/x.ts')).toBe('export const x = 1;');
    expect(git(f.source, 'show', 'main:src/b/y.ts')).toBe('export const y = 2;');
  },
);

it.each([
  {
    name: 'blocks a changed path above a scope path, which contains the scope instead of lying in it',
    scope: ['./src/a/x.ts'],
    change: (worktree: string) =>
      commit(worktree, 'src', 'A file where the scope folder would be\n'),
    conflict: 'src',
  },
  {
    name: 'blocks a task merge that renames a file in its scope to a path outside it',
    scope: ['src/a'],
    seed: 'src/a/old.ts',
    change: (worktree: string) => {
      git(worktree, 'mv', 'src/a/old.ts', 'moved.ts');
      git(worktree, 'commit', '--quiet', '-m', 'Move the file out of the scope');
    },
    conflict: 'moved.ts',
  },
  {
    name: 'blocks every file of a task with no scope paths',
    scope: [],
    change: (worktree: string) => commit(worktree, 'README.md', 'Anywhere\n'),
    conflict: 'README.md',
  },
])('$name', async ({ scope, seed, change, conflict }) => {
  const f = await mergeFixture();
  if (seed) commit(f.source, seed, 'export const old = 1;\n');
  setScopes(f, { api: scope });
  const { session, workspace, sourceHead } = await taskSession(f, 'api');
  change(workspace.path);
  await merge(f, session.id);
  await settled(f, session.id);
  expect(current(f, session.id).merge).toEqual({
    state: 'blocked',
    reason: 'out_of_scope',
    conflicts: [conflict],
  });
  expect(git(f.source, 'rev-parse', 'main')).toBe(sourceHead);
});

it.skipIf(insideSandbox)(
  'does not land a task merge whose scope narrowed while its gate ran',
  async () => {
    const f = await mergeFixture();
    setScopes(f, { api: ['src/a', 'README.md'] });
    const { session, workspace, sourceHead } = await taskSession(f, 'api');
    await setGate(f, [
      {
        name: 'Wait for release',
        argv: [
          process.execPath,
          '-e',
          "const fs = require('node:fs'); const timer = setInterval(() => { if (fs.existsSync('release')) clearInterval(timer); }, 10);",
        ],
      },
    ]);
    commit(workspace.path, 'src/a/x.ts', 'export const x = 1;\n');
    commit(workspace.path, 'README.md', 'In the scope when the gate started\n');
    await merge(f, session.id);
    await eventually(
      () => payloads(f, session.id, 'session.gate_started').length === 1,
      () => f.control.tick(),
      10000,
    );
    setScopes(f, { api: ['src/a'] });
    const candidate = payloads(f, session.id, 'session.gate_started')[0]!.candidate_path as string;
    writeFileSync(path.join(candidate, 'release'), 'release\n');
    await settled(f, session.id);
    expect(current(f, session.id).merge).toMatchObject({ state: 'blocked', reason: 'cancelled' });
    expect(git(f.source, 'rev-parse', 'main')).toBe(sourceHead);
  },
);

it('lands files outside the task scope when the user allows them, and refuses that to a session credential', async () => {
  const f = await mergeFixture();
  setScopes(f, { api: ['src/a'] });
  const { session, workspace } = await taskSession(f, 'api');
  const head = commit(workspace.path, 'README.md', 'Allowed by the user\n');
  const worker: Principal = {
    id: `session:${session.id}`,
    role: 'worker',
    project_id: f.project.id,
    session_id: session.id,
    expires_at: f.store.now() + 60000,
  };
  const allowed = (principal: Principal) =>
    f.call<Session>(
      'session.merge',
      { session_id: session.id, allow_out_of_scope: true },
      current(f, session.id).revision,
      principal,
    );
  expect(() => allowed(worker)).toThrow(expect.objectContaining({ code: 'permission_denied' }));
  expect(current(f, session.id).merge).toBeUndefined();
  await allowed(user);
  await settled(f, session.id);
  expect(current(f, session.id).outcome).toBe('merged');
  expect(git(f.source, 'rev-parse', 'main')).toBe(head);
});

it('hands a merge blocked by files outside the scope back to the task session with those files', async () => {
  const f = await mergeFixture();
  setScopes(f, { api: ['src/a'] });
  const { session } = await taskSession(f, 'api');
  f.store.event('session.merge_started', current(f, session.id), f.project.id, { auto: true }, '');
  const blocked = current(f, session.id);
  f.store.update<Session>(
    'sessions',
    {
      ...blocked,
      merge: { state: 'blocked', reason: 'out_of_scope', conflicts: ['README.md'] },
    },
    blocked.revision,
  );
  await f.control.tick();
  const handed = f.turns(session.id).filter((turn) => turn.origin === 'tracker');
  expect(handed).toHaveLength(1);
  expect(handed[0]!.input).toContain('- README.md');
  expect(handed[0]!.input).toContain('scope');
});

it('blocks the merge of a session left from a removed task whose id a new task reuses', async () => {
  const f = await mergeFixture();
  setScopes(f, { api: ['src/a'] });
  const { session, workspace, sourceHead } = await taskSession(f, 'api');
  // The lead removed task api and planned a new task under the same id.
  setScopes(f, { api: ['README.md'] });
  const plan = f.store.must<BoardPlan>('board_plans', leadId);
  f.store.update<BoardPlan>(
    'board_plans',
    { ...plan, generations: { api: { generation: 2, contract: 'reused' } }, retired: { api: 1 } },
    plan.revision,
  );
  commit(workspace.path, 'README.md', 'Done for the removed task\n');
  await merge(f, session.id);
  await settled(f, session.id);
  expect(current(f, session.id).merge).toEqual({ state: 'blocked', reason: 'task_retired' });
  expect(git(f.source, 'rev-parse', 'main')).toBe(sourceHead);
});

it('checks the task scope of the plan a new lead took over while the merge read the worktree', async () => {
  const f = await mergeFixture();
  setScopes(f, { api: ['src/a'] });
  const { session, workspace, sourceHead } = await taskSession(f, 'api');
  commit(workspace.path, 'README.md', 'Outside the scope\n');
  await merge(f, session.id);
  await f.control.tick();
  // The merge now waits for Git to read the worktree HEAD.
  await new Promise(setImmediate);
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  ctx.store.transaction(() =>
    transferPlan(ctx, ctx.store.must<BoardPlan>('board_plans', leadId), 'lead-that-took-over', ''),
  );
  await settled(f, session.id);
  expect(current(f, session.id).task?.lead_session_id).toBe('lead-that-took-over');
  expect(current(f, session.id).merge).toEqual({
    state: 'blocked',
    reason: 'out_of_scope',
    conflicts: ['README.md'],
  });
  expect(git(f.source, 'rev-parse', 'main')).toBe(sourceHead);
});

it('blocks the merge of a task session whose plan cannot be found', async () => {
  const f = await mergeFixture();
  setScopes(f, { api: ['src/a'] });
  const { session, workspace, sourceHead } = await taskSession(f, 'api');
  const plan = f.store.must<BoardPlan>('board_plans', leadId);
  f.store.remove('board_plans', plan.id, plan.revision);
  commit(workspace.path, 'README.md', 'Outside the scope\n');
  await merge(f, session.id);
  await settled(f, session.id);
  expect(current(f, session.id).merge).toEqual({ state: 'blocked', reason: 'task_plan_missing' });
  expect(git(f.source, 'rev-parse', 'main')).toBe(sourceHead);
});

it('refuses a merge after the source repository checked out another branch than the session started from', async () => {
  const f = await mergeFixture();
  const { session, workspace, sourceHead } = await idleSession(f);
  commit(workspace.path, 'answer.txt', 'meant for main\n');
  git(f.source, 'checkout', '--quiet', '-b', 'release');
  await expect(merge(f, session.id)).rejects.toThrow(
    expect.objectContaining({
      code: 'target_branch_changed',
      message: expect.stringMatching(/release.*main/),
    }),
  );
  expect(current(f, session.id).merge).toBeUndefined();
  expect(git(f.source, 'rev-parse', 'main')).toBe(sourceHead);
  expect(git(f.source, 'rev-parse', 'release')).toBe(sourceHead);
});

it('blocks a queued merge when the source repository checks out another branch before it lands', async () => {
  const f = await mergeFixture();
  const { session, workspace, sourceHead } = await idleSession(f);
  commit(workspace.path, 'answer.txt', 'meant for main\n');
  await merge(f, session.id);
  git(f.source, 'checkout', '--quiet', '-b', 'release');
  await eventually(
    () =>
      current(f, session.id).merge?.state === 'blocked' ||
      current(f, session.id).outcome === 'merged',
    () => f.control.tick(),
  );
  expect(current(f, session.id).merge).toEqual({
    state: 'blocked',
    reason: 'target_branch_changed',
  });
  expect(git(f.source, 'rev-parse', 'main')).toBe(sourceHead);
  expect(git(f.source, 'rev-parse', 'release')).toBe(sourceHead);
});

it('merges into the checked-out branch for a worktree recorded without its starting branch', async () => {
  const f = await mergeFixture();
  const { session, workspace } = await idleSession(f);
  const recorded = f.store.must<Workspace>('workspaces', workspace.id);
  const { source_branch: _, ...earlier } = recorded;
  f.store.update<Workspace>('workspaces', earlier, recorded.revision);
  const head = commit(workspace.path, 'answer.txt', 'lands on release\n');
  git(f.source, 'checkout', '--quiet', '-b', 'release');
  await merge(f, session.id);
  await eventually(
    () => removed(f, workspace.id),
    () => f.control.tick(),
  );
  expect(git(f.source, 'rev-parse', 'release')).toBe(head);
  expect(payloads(f, session.id, 'session.merged')[0]).toMatchObject({ branch: 'release' });
});

it.skipIf(insideSandbox)(
  'gates a merge rerun again when the gate changed after an earlier run gated the same commit',
  async () => {
    const f = await mergeFixture();
    const { session, workspace, sourceHead } = await idleSession(f);
    await setGate(f, [
      {
        name: 'Changed gate',
        argv: [process.execPath, '-e', "process.stderr.write('new gate'); process.exit(3)"],
      },
    ]);
    const head = commit(workspace.path, 'answer.txt', 'gated by the old gate\n');
    await merge(f, session.id);
    // An earlier run gated this commit under another gate, then the daemon stopped.
    const running = current(f, session.id);
    f.store.update<Session>(
      'sessions',
      {
        ...running,
        merge: {
          state: 'running',
          landing: {
            stage: 'gated',
            candidate: head,
            branch: 'main',
            from_sha: sourceHead,
            gate_argv: JSON.stringify([[process.execPath, '-e', 'process.exit(0)']]),
          },
        },
      },
      running.revision,
    );
    expect(f.list()[0]!.merge).toEqual({ state: 'running' });
    await settled(f, session.id);
    expect(current(f, session.id).merge).toMatchObject({
      state: 'blocked',
      reason: 'gate_failed',
      gate: { name: 'Changed gate' },
    });
    expect(git(f.source, 'rev-parse', 'main')).toBe(sourceHead);
  },
);

it.each([true, false])(
  'archives a merged session only when auto archive is %s',
  async (enabled) => {
    const f = await mergeFixture();
    Object.assign((f.control as unknown as { ctx: ControlContext }).ctx, {
      userConfigDir: path.join(f.root, 'config'),
    });
    expect(f.control.appSettings(user).auto_archive_merged).toBe(false);
    f.call('app.settings.set', { auto_archive_merged: enabled });
    const { session, workspace } = await idleSession(f);
    commit(workspace.path, 'notes.txt', 'landed\n');
    await merge(f, session.id);
    await eventually(
      () => removed(f, workspace.id),
      () => f.control.tick(),
    );
    expect(current(f, session.id).outcome).toBe('merged');
    expect(!!current(f, session.id).archived_at).toBe(enabled);
    expect(payloads(f, session.id, 'session.archived')).toHaveLength(enabled ? 1 : 0);
  },
);
