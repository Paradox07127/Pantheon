import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { RECHECK_INTERVAL_MS } from '../../packages/control/dist/git-config-cache.js';
import type { ControlContext } from '../../packages/control/dist/context.js';
import {
  autoMergeAfterTurn,
  forgetWorktreeReads,
} from '../../packages/control/dist/workbench-session.js';
import type { BoardPlan, Principal, Project, Review, Session } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, settle, user, waitOutStatusReuse } from '../helpers.js';
import { dispatchEveryTier, git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

/** Puts a git first on PATH that logs each call and sleeps a second before the slow subcommands. */
function gitWrapper(slow: string[]) {
  const real = execFileSync('/bin/sh', ['-c', 'command -v git']).toString().trim(),
    directory = mkdtempSync(path.join(os.tmpdir(), 'pantheon-git-wrapper-')),
    log = path.join(directory, 'calls.log'),
    previous = process.env.PATH;
  writeFileSync(
    path.join(directory, 'git'),
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${log}'`,
      ...(slow.length
        ? [`for arg in "$@"; do case "$arg" in ${slow.join('|')}) sleep 1; break;; esac; done`]
        : []),
      `exec '${real}' "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  process.env.PATH = `${directory}${path.delimiter}${previous}`;
  restores.push(() => {
    process.env.PATH = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  // Each runGit call's subcommand, after the -c options runGit puts first; the search index
  // reads branches with a plain git on its own timer.
  return () =>
    (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [])
      .filter((line) => line.startsWith('-c '))
      .map((line) => {
        const words = line.split(' ');
        let index = 0;
        while (words[index] === '-c') index += 2;
        return words[index]!;
      });
}

/** Whether a 50 ms timer started now fired before the returned check runs. */
function timerFired(): () => boolean {
  let fired = false;
  const timer = setTimeout(() => (fired = true), 50);
  restores.push(() => clearTimeout(timer));
  return () => fired;
}

async function idleSession(f: Fixture) {
  const session = await f.create();
  const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.turns(session.id)[0]!.state === 'completed' &&
      f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  return { session: f.store.must<Session>('sessions', session.id), workspace };
}

function commit(repository: string, name: string) {
  writeFileSync(path.join(repository, name), `${name}\n`);
  git(repository, 'add', '--', name);
  git(repository, 'commit', '--quiet', '-m', `Add ${name}`);
}

it('reads the project HEAD while the event loop runs, with status and log at once', async () => {
  const f = await workbenchFixture();
  const calls = gitWrapper(['status', 'log']);
  const fired = timerFired(),
    started = performance.now();
  expect(await f.control.projectHead(user, f.project.id)).toMatchObject({
    branch: 'main',
    uncommitted: 0,
  });
  expect(fired()).toBe(true);
  expect(performance.now() - started).toBeLessThan(1800);
  expect(calls().sort()).toEqual(['log', 'status']);
});

it('reads merge preflight while the event loop runs, with one status per repository', async () => {
  const f = await workbenchFixture();
  const { session, workspace } = await idleSession(f);
  commit(workspace.path, 'change.txt');
  // Past the recheck interval, so the first read sees the commit and reads the Git configuration again.
  const clock = performance.now.bind(performance);
  const now = vi.spyOn(performance, 'now').mockImplementation(() => clock() + RECHECK_INTERVAL_MS);
  restores.push(() => now.mockRestore());
  await f.control.sessionPreflight(user, session.id);
  // The second preflight would otherwise share the first one's status reads.
  forgetWorktreeReads(workspace.id);
  const calls = gitWrapper(['status']);
  const fired = timerFired();
  expect(await f.control.sessionPreflight(user, session.id)).toMatchObject({
    target_branch: 'main',
    commit_count: 1,
    worktree_clean: true,
    source_clean: true,
    can_merge: true,
  });
  expect(fired()).toBe(true);
  expect(calls().sort()).toEqual(['diff', 'merge-tree', 'rev-list', 'status', 'status']);
});

it('reports a detached source and an unborn worktree branch from the merged status reads', async () => {
  const f = await workbenchFixture();
  const { session, workspace } = await idleSession(f);
  commit(workspace.path, 'change.txt');
  git(f.source, 'checkout', '--quiet', '--detach');
  expect(await f.control.sessionPreflight(user, session.id)).toMatchObject({
    target_branch: null,
    conflicts: { state: 'unknown' },
    can_merge: false,
    blocked_reason: 'source_detached',
  });
  git(workspace.path, 'checkout', '--quiet', '--orphan', 'empty');
  waitOutStatusReuse();
  await expect(f.control.sessionPreflight(user, session.id)).rejects.toMatchObject({
    code: 'workspace_read_failed',
  });
});

it('lists a blocked merge without running Git and never as mergeable before its states are read', async () => {
  const f = await workbenchFixture();
  const { session, workspace } = await idleSession(f);
  commit(workspace.path, 'change.txt');
  const blocked = f.store.update<Session>(
    'sessions',
    { ...session, merge: { state: 'blocked', reason: 'rebase_conflict' } },
    session.revision,
  );
  f.store.event('session.merge_blocked', blocked, blocked.project_id, blocked.merge);
  const calls = gitWrapper([]);
  // Other background work of the fixture reads the worktree too, but never its status.
  const statuses = () =>
    calls().filter((call) => call === 'status' || call === 'symbolic-ref').length;
  const actions = () => f.control.needsYou(user, f.project.id).items[0]!.actions;
  expect(actions()).toEqual([
    { command: 'session.merge', allowed: false, disabled_reason: 'workspace_read_failed' },
  ]);
  expect(statuses()).toBe(0);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(statuses()).toBe(0);
  const changes = () => f.store.kindEvents(f.project.id, ['workspace.repository_changed']).length,
    before = changes();
  await f.control.prefetchWorktreeReads(user, f.project.id);
  expect(changes()).toBeGreaterThan(before);
  const read = statuses();
  expect(actions()).toEqual([{ command: 'session.merge', allowed: true }]);
  expect(statuses()).toBe(read);
});

it('searches files while the event loop runs and lists a folder again only when HEAD moves', async () => {
  const f = await workbenchFixture();
  const calls = gitWrapper(['ls-files']);
  const fired = timerFired();
  expect(await f.control.filesSearch(user, f.project.id, undefined, 'answer')).toEqual([
    'answer.txt',
  ]);
  expect(fired()).toBe(true);
  expect(await f.control.filesSearch(user, f.project.id, undefined, 'answer')).toEqual([
    'answer.txt',
  ]);
  const listings = () => calls().filter((call) => call === 'ls-files').length;
  expect(listings()).toBe(1);
  commit(f.source, 'later.txt');
  expect(await f.control.filesSearch(user, f.project.id, undefined, 'later')).toEqual([
    'later.txt',
  ]);
  expect(listings()).toBe(2);
});

it('lists a folder while the event loop runs, with one ignore check', async () => {
  const f = await workbenchFixture();
  const calls = gitWrapper(['check-ignore']);
  const fired = timerFired();
  expect((await f.control.filesList(user, f.project.id, undefined, undefined)).entries).toEqual([
    { name: 'answer.txt', kind: 'file', size: 5 },
  ]);
  expect(fired()).toBe(true);
  expect(calls()).toEqual(['check-ignore']);
});

it('reads the range and diff of a review request while the event loop runs', async () => {
  const f = await workbenchFixture();
  const { session, workspace } = await idleSession(f);
  commit(workspace.path, 'change.txt');
  const head = git(workspace.path, 'rev-parse', 'HEAD');
  const calls = gitWrapper(['diff']);
  const fired = timerFired();
  const review = await f.call<Review>('review.request', {
    session_id: session.id,
    runtimes: [f.adapter.name],
  });
  expect(fired()).toBe(true);
  expect(review.range).toMatchObject({ to_sha: head });
  expect(calls().filter((call) => call === 'diff')).toHaveLength(1);
});

it('queues a merge while the event loop runs, reading both repository states at once', async () => {
  const f = await workbenchFixture();
  const { session, workspace } = await idleSession(f);
  commit(workspace.path, 'change.txt');
  gitWrapper(['status']);
  const fired = timerFired(),
    started = performance.now();
  const queued = await f.call<Session | Promise<Session>>(
    'session.merge',
    { session_id: session.id },
    session.revision,
  );
  expect(queued.merge?.state).toBe('running');
  expect(fired()).toBe(true);
  expect(performance.now() - started).toBeLessThan(1800);
});

it('starts a gate run while the event loop runs', async () => {
  const f = await workbenchFixture();
  await f.call(
    'project.gate.set',
    { project_id: f.project.id, root: f.source, commands: [{ name: 'Check', argv: ['true'] }] },
    f.store.must<Project>('projects', f.project.id).revision,
  );
  const { session } = await idleSession(f);
  gitWrapper(['rev-parse']);
  const fired = timerFired();
  const started = await f.call<Session | Promise<Session>>(
    'session.gates.run',
    { session_id: session.id },
    session.revision,
  );
  expect(started.gate_run?.state).toBe('running');
  expect(fired()).toBe(true);
  await eventually(
    () => f.store.must<Session>('sessions', session.id).gate_run?.state !== 'running',
    () => f.control.tick(),
  );
});

it('forks the current files while the event loop runs, without reading the project start point', async () => {
  const f = await workbenchFixture();
  const { session } = await idleSession(f);
  const calls = gitWrapper(['write-tree']);
  const fired = timerFired();
  const branch = await f.call<Session | Promise<Session>>('session.fork', {
    session_id: session.id,
    input: 'Try another way',
  });
  expect(branch.forked_from).toEqual({ session_id: session.id });
  expect(fired()).toBe(true);
  expect(calls().filter((call) => call === 'symbolic-ref' || call === 'show-ref')).toEqual([]);
});

it('removes the ref of a fork whose command fails after its files were frozen', async () => {
  const f = await workbenchFixture();
  const { session } = await idleSession(f);
  gitWrapper(['update-ref']);
  const fired = timerFired();
  await expect(
    Promise.resolve().then(() =>
      f.call('session.fork', {
        session_id: session.id,
        input: 'Try another way',
        attachments: [randomUUID()],
      }),
    ),
  ).rejects.toMatchObject({ code: 'not_found' });
  expect(fired()).toBe(true);
  const forks = () =>
    git(f.source, 'for-each-ref', '--format=%(refname)', 'refs/pantheon/checkpoints/')
      .split('\n')
      .filter((ref) => ref.endsWith('/fork'));
  await eventually(() => forks().length === 0);
});

it('previews a session start point while the event loop runs, with one git run', async () => {
  const f = await workbenchFixture();
  // The first read of the repository also reads its Git configuration.
  await f.control.sessionCreatePreview(user, { project_id: f.project.id });
  const head = git(f.source, 'rev-parse', 'HEAD');
  const calls = gitWrapper(['rev-parse']);
  const fired = timerFired();
  expect(await f.control.sessionCreatePreview(user, { project_id: f.project.id })).toEqual({
    branch: null,
    base_sha: head,
    base_ref: 'refs/heads/main',
  });
  expect(fired()).toBe(true);
  expect(calls()).toEqual(['rev-parse']);
});

it('lists sessions without running Git', async () => {
  const f = await workbenchFixture();
  const { workspace } = await idleSession(f);
  commit(workspace.path, 'change.txt');
  const calls = gitWrapper([]);
  const before = calls();
  expect(f.control.sessionList(user, f.project.id)).toHaveLength(1);
  expect(calls()).toEqual(before);
});

it('reads the diff of a merged session once', async () => {
  const f = await workbenchFixture();
  git(f.source, 'config', 'user.name', 'Source User');
  git(f.source, 'config', 'user.email', 'source@example.invalid');
  const { session, workspace } = await idleSession(f);
  commit(workspace.path, 'change.txt');
  await f.call<Session | Promise<Session>>(
    'session.merge',
    { session_id: session.id },
    session.revision,
  );
  await eventually(
    () => f.store.must<Session>('sessions', session.id).outcome === 'merged',
    () => f.control.tick(),
    10000,
  );
  const first = await f.control.sessionDiff(user, session.id);
  expect(first.files.map((file) => file.path)).toEqual(['change.txt']);
  const calls = gitWrapper([]);
  expect(await f.control.sessionDiff(user, session.id)).toEqual(first);
  expect(calls().filter((call) => call === 'diff')).toEqual([]);
});

it('reads a session diff again once its worktree reads are forgotten', async () => {
  const f = await workbenchFixture();
  const { session, workspace } = await idleSession(f);
  commit(workspace.path, 'change.txt');
  await f.control.sessionDiff(user, session.id);
  const calls = gitWrapper([]);
  const diffs = () => calls().filter((call) => call === 'diff').length;
  await f.control.sessionDiff(user, session.id);
  expect(diffs()).toBe(0);
  forgetWorktreeReads(workspace.id);
  await f.control.sessionDiff(user, session.id);
  expect(diffs()).toBeGreaterThan(0);
});

it('merges a task session after its turn while the event loop runs', async () => {
  const f = await workbenchFixture();
  git(f.source, 'config', 'user.name', 'Source User');
  git(f.source, 'config', 'user.email', 'source@example.invalid');
  await f.call(
    'project.gate.set',
    {
      project_id: f.project.id,
      root: f.source,
      commands: [{ name: 'Check', argv: [process.execPath, '-e', 'process.exit(0)'] }],
    },
    f.store.must<Project>('projects', f.project.id).revision,
  );
  f.call(
    'project.autoMerge.set',
    { project_id: f.project.id, enabled: true },
    f.store.must<Project>('projects', f.project.id).revision,
  );
  const { session, workspace } = await idleSession(f);
  f.store.insert<BoardPlan>('board_plans', {
    id: 'lead-of-merged-task',
    revision: 1,
    project_id: f.project.id,
    headline: 'Merged work',
    lanes: [{ id: 'core', title: 'Core' }],
    tasks: [
      {
        id: 'merged-task',
        title: 'Merged task',
        goal: 'Merge on its own',
        lane: 'core',
        depends_on: [],
        source: [],
        scope: ['.'],
        acceptance: [],
      },
    ],
    risks: [],
    assumptions: [],
    plan_version: 0,
    pending_edits: [],
    inbox: [],
    notified: {},
    updated_at: Date.now(),
  });
  f.store.update<Session>(
    'sessions',
    { ...session, task: { lead_session_id: 'lead-of-merged-task', id: 'merged-task' } },
    session.revision,
  );
  commit(workspace.path, 'change.txt');
  gitWrapper(['status']);
  const fired = timerFired();
  const started = () => f.store.kindEvents(f.project.id, ['session.merge_started']).length > 0;
  autoMergeAfterTurn(
    (f.control as unknown as { ctx: ControlContext }).ctx,
    session.id,
    f.turns(session.id).at(-1)!.id,
  );
  let firedBeforeMerge: boolean | undefined;
  await eventually(() => {
    if (!started()) return false;
    firedBeforeMerge = fired();
    return true;
  });
  expect(firedBeforeMerge).toBe(true);
});

it('reads the start point of a new session with one git run', async () => {
  const f = await workbenchFixture();
  await f.control.sessionCreatePreview(user, { project_id: f.project.id });
  const calls = gitWrapper([]);
  const session = await f.create();
  expect(
    calls().filter((call) => ['symbolic-ref', 'show-ref', 'rev-parse'].includes(call)),
  ).toEqual(['rev-parse']);
  await awaitWorkspaceReady(f.control, session.workspace_id!);
});

it('creates a session while the event loop runs as it reads the start point', async () => {
  const f = await workbenchFixture();
  await f.control.sessionCreatePreview(user, { project_id: f.project.id });
  gitWrapper(['rev-parse']);
  const fired = timerFired();
  const session = await f.create();
  expect(fired()).toBe(true);
  await awaitWorkspaceReady(f.control, session.workspace_id!);
});

it('opens the session of a started task without blocking the event loop', async () => {
  const f = await workbenchFixture();
  dispatchEveryTier(f);
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  const principal: Principal = {
    id: `session:${lead.id}`,
    role: 'lead',
    project_id: f.project.id,
    session_id: lead.id,
    expires_at: f.store.now() + 60000,
  };
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [
        {
          id: 'a',
          title: 'Task a',
          goal: 'Finish task a',
          lane: 'core',
          depends_on: [],
          source: ['Plan the export feature'],
          scope: ['src/a'],
          acceptance: ['pnpm test'],
        },
      ],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    principal,
  );
  f.call('task.start', { project_id: f.project.id, task_ids: ['a'] }, null, principal);
  gitWrapper(['rev-parse']);
  // The longest time between two runs of a 10 ms interval while the tick runs.
  let last = performance.now(),
    longest = 0;
  const interval = setInterval(() => {
    longest = Math.max(longest, performance.now() - last);
    last = performance.now();
  }, 10);
  restores.push(() => clearInterval(interval));
  await f.control.tick();
  clearInterval(interval);
  longest = Math.max(longest, performance.now() - last);
  expect(
    f.store.list<Session>('sessions').filter((session) => session.task?.id === 'a'),
  ).toHaveLength(1);
  expect(longest).toBeLessThan(800);
});

it('opens a project on an existing repository while the event loop runs', async () => {
  const f = await workbenchFixture();
  const repository = path.join(f.root, 'existing-repository');
  mkdirSync(repository);
  git(repository, 'init', '--quiet');
  commit(repository, 'notes.txt');
  gitWrapper(['--verify']);
  const fired = timerFired();
  const project = await f.call<Project | Promise<Project>>('project.open', {
    name: 'Existing repository',
    roots: [repository],
  });
  expect(project.name).toBe('Existing repository');
  expect(fired()).toBe(true);
});

it('opens a project on an empty folder while the event loop runs its init and first commit', async () => {
  const f = await workbenchFixture();
  const folder = path.join(f.root, 'empty-folder');
  mkdirSync(folder);
  gitWrapper(['init', 'commit']);
  const fired = timerFired();
  const project = await f.call<Project | Promise<Project>>('project.open', {
    name: 'Empty folder',
    roots: [folder],
  });
  expect(git(folder, 'rev-parse', '--show-toplevel')).toBe(project.roots[0]);
  expect(fired()).toBe(true);
});

it('reads the status of a reviewer left reconciling while the event loop runs at daemon start', async () => {
  const f = await workbenchFixture();
  const { session: parent, workspace } = await idleSession(f);
  writeFileSync(path.join(workspace.path, 'answer.txt'), 'a change to review\n');
  git(workspace.path, 'commit', '--quiet', '-am', 'Update the answer');
  f.control.adapters.set('fixture-reviewer', f.adapter);
  const review = await f.call<Review>('review.request', {
    session_id: parent.id,
    runtimes: ['fixture-reviewer'],
  });
  const started = f.store.must<Session>('sessions', review.session_ids[0]!);
  const reviewer = f.store.update(
    'sessions',
    { ...started, state: 'reconciling' as const, process_identity: { pid: 2_000_000_000 } },
    started.revision,
  );
  f.store.event('session.write_snapshot', reviewer, f.project.id, {
    turn_id: 'reviewer-turn',
    roots: [f.source],
    status: {},
    fingerprints: {},
  });
  const file = path.join(f.source, 'answer.txt');
  writeFileSync(file, 'changed while the daemon was down\n');
  gitWrapper(['status']);
  // The state the reviewer had when a 50 ms timer fired; restart reconciles after recovery.
  let stateWhenFired: string | undefined;
  const timer = setTimeout(
    () => (stateWhenFired = f.store.must<Session>('sessions', reviewer.id).state),
    50,
  );
  restores.push(() => clearTimeout(timer));
  await f.restart(() => undefined);
  expect(stateWhenFired).toBe('reconciling');
  expect(f.store.must<Session>('sessions', reviewer.id).state).toBe('closed');
  expect(
    f.store
      .events()
      .filter(
        (event) => event.aggregate_id === reviewer.id && event.kind === 'session.write_audited',
      )
      .at(-1),
  ).toEqual(expect.objectContaining({ payload: expect.objectContaining({ paths: [file] }) }));
});
