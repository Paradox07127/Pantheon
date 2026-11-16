import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import type {
  BoardPlan,
  Principal,
  Project,
  Session,
  SessionTurn,
  Workspace,
} from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, insideSandbox, settle, user } from '../helpers.js';
import { boundTaskSession, git, workbenchFixture } from './workbench-fixture.js';

type Fixture = ReturnType<typeof workbenchFixture>;
type PlanTask = BoardPlan['tasks'][number];

function mergeFixture() {
  const f = workbenchFixture();
  git(f.source, 'config', 'user.name', 'Source User');
  git(f.source, 'config', 'user.email', 'source@example.invalid');
  return f;
}

const leadPrincipal = (f: Fixture, sessionId: string): Principal => ({
  id: `session:${sessionId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const project = (f: Fixture) => f.store.must<Project>('projects', f.project.id);
const fromTracker = (f: Fixture, sessionId: string) =>
  f.turns(sessionId).filter((turn: SessionTurn) => turn.origin === 'tracker');
const idle = (f: Fixture, sessionId: string) =>
  current(f, sessionId).state === 'open' &&
  f.turns(sessionId).every((turn) => !['queued', 'running'].includes(turn.state));

/** Two tasks whose scopes both name the shared file, as a plan that splits work badly does. */
const parallelTask = (id: string): PlanTask => ({
  id,
  title: `Task ${id}`,
  goal: `Change the shared file for task ${id}`,
  lane: 'core',
  depends_on: [],
  source: ['Plan the shared file changes'],
  scope: ['shared.txt', id],
  acceptance: ['true'],
});

/** The fixture runtime writes the task's own file and its line of the shared file, then commits. */
const script = (id: string) =>
  [
    'fixture-script',
    JSON.stringify([
      { write: { path: `${id}/work.txt`, text: `work of ${id}\n` } },
      { write: { path: 'shared.txt', text: `line of ${id}\n` } },
      { commit: `Write the shared file for task ${id}` },
    ]),
  ].join('\n');

/** Opens both task sessions at once, with auto-merge on, and waits until one lands and one is handed back. */
async function parallelTasks(f: Fixture) {
  writeFileSync(path.join(f.source, 'shared.txt'), 'base\n');
  git(f.source, 'add', 'shared.txt');
  git(f.source, 'commit', '--quiet', '-m', 'Add the shared file');
  const lead = f.create('Plan the shared file changes');
  await settle(f, lead);
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Shared file changes',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [parallelTask('a'), parallelTask('b')],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    leadPrincipal(f, lead.id),
  );
  f.call('project.autoMerge.set', { project_id: f.project.id, enabled: true }, project(f).revision);
  const a = f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: script('a'),
    task_id: `${lead.id}:a`,
  });
  // The scopes overlap, so the board opens no second session while the first works; bind it before its turn runs.
  const b = boundTaskSession(f, lead.id, 'b', script('b'));
  await eventually(
    () =>
      [a!, b!].some((session) => current(f, session.id).outcome === 'merged') &&
      [a!, b!].some((session) => fromTracker(f, session.id).length > 0),
    () => f.control.tick(),
    20000,
  );
  const [earlier, later] = current(f, a!.id).outcome === 'merged' ? [a!, b!] : [b!, a!];
  return { lead, earlier, later, laterId: later.task!.id };
}

it.skipIf(insideSandbox)(
  'hands a rebase conflict between two parallel task sessions back to the later one with the conflicting file',
  async () => {
    const f = mergeFixture();
    const { lead, earlier, later } = await parallelTasks(f);
    const earlierId = earlier.task!.id;
    expect(fromTracker(f, earlier.id)).toEqual([]);
    const [handed] = fromTracker(f, later.id);
    expect(handed!.input).toContain('rebase conflict');
    expect(handed!.input).toContain('- shared.txt');
    expect(handed!.input).toContain(`Write the shared file for task ${earlierId}`);
    const blocked = f.store.db
      .prepare(
        "SELECT payload FROM events WHERE aggregate_id=? AND kind='session.merge_blocked' ORDER BY sequence LIMIT 1",
      )
      .get(later.id) as { payload: string };
    expect(JSON.parse(blocked.payload)).toEqual({
      state: 'blocked',
      reason: 'rebase_conflict',
      conflicts: ['shared.txt'],
      conflict_commits: [`Write the shared file for task ${earlierId}`],
      conflict_tasks: [`${lead.id}:${earlierId}`],
    });
    expect(readFileSync(path.join(f.source, 'shared.txt'), 'utf8')).toBe(`line of ${earlierId}\n`);
  },
  30000,
);

it.skipIf(insideSandbox)(
  'names the earlier task that merged the conflicting file to the later session and, once its hand-backs end, to the lead',
  async () => {
    const f = mergeFixture();
    const { lead, earlier, later } = await parallelTasks(f);
    const earlierId = earlier.task!.id,
      named = `task ${earlierId} "Task ${earlierId}"`;
    expect(fromTracker(f, later.id)[0]!.input).toContain(named);
    // The fixture session does not resolve the conflict, so its hand-back repeats and the lead hears of the block.
    const told = () =>
      [
        ...f.store.must<BoardPlan>('board_plans', lead.id).inbox.map((note) => note.text),
        ...f.turns(lead.id).map((turn) => turn.input),
      ].find((text) => text.includes('The merge of the session is blocked'));
    await eventually(
      () => told() !== undefined,
      () => f.control.tick(),
      20000,
    );
    expect(told()).toContain(named);
  },
  45000,
);

it.skipIf(insideSandbox)(
  'lands the later task once its session resolves the conflict, keeping both changes in the source',
  async () => {
    const f = mergeFixture();
    const { earlier, later, laterId } = await parallelTasks(f);
    const earlierId = earlier.task!.id;
    await eventually(
      () => idle(f, later.id) && current(f, later.id).merge?.state !== 'running',
      () => f.control.tick(),
      20000,
    );
    // What the session does with the hand-back: rebase onto the source and keep both lines.
    const worktree = f.store.must<Workspace>('workspaces', later.workspace_id!).path;
    expect(spawnSync('git', ['rebase', '--quiet', 'main'], { cwd: worktree }).status).not.toBe(0);
    writeFileSync(path.join(worktree, 'shared.txt'), `line of ${earlierId}\nline of ${laterId}\n`);
    git(worktree, 'add', 'shared.txt');
    git(worktree, '-c', 'core.editor=true', 'rebase', '--continue');
    f.call<SessionTurn>(
      'session.send',
      { session_id: later.id, input: 'The conflict is resolved' },
      current(f, later.id).revision,
    );
    await eventually(
      () => current(f, later.id).outcome === 'merged',
      () => f.control.tick(),
      20000,
    );
    expect(readFileSync(path.join(f.source, 'shared.txt'), 'utf8')).toBe(
      `line of ${earlierId}\nline of ${laterId}\n`,
    );
    expect(git(f.source, 'show', `main:${earlierId}/work.txt`)).toBe(`work of ${earlierId}`);
    expect(git(f.source, 'show', `main:${laterId}/work.txt`)).toBe(`work of ${laterId}`);
    expect(git(f.source, 'rev-list', '--merges', 'main')).toBe('');
  },
  45000,
);

it('aborts a failed rebase that left no conflicted files instead of leaving the worktree mid-rebase', async () => {
  const f = mergeFixture();
  const session = f.create();
  const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => idle(f, session.id),
    () => f.control.tick(),
  );
  const commit = (repository: string, name: string, contents: string) => {
    mkdirSync(path.dirname(path.join(repository, name)), { recursive: true });
    writeFileSync(path.join(repository, name), contents);
    git(repository, 'add', '--', name);
    git(repository, 'commit', '--quiet', '-m', `Add ${name}`);
    return git(repository, 'rev-parse', 'HEAD');
  };
  // A commit that adds a file, and a later one that deletes it again.
  commit(workspace.path, 'notes.txt', 'draft notes\n');
  git(workspace.path, 'rm', '--quiet', 'notes.txt');
  git(workspace.path, 'commit', '--quiet', '-m', 'Remove notes.txt');
  const ours = commit(workspace.path, 'session.txt', 'session\n');
  const theirs = commit(f.source, 'source.txt', 'source\n');
  // An untracked file the status does not show stops the rebase at the first commit, with no conflict.
  git(f.source, 'config', 'status.showUntrackedFiles', 'no');
  writeFileSync(path.join(workspace.path, 'notes.txt'), 'kept by the user\n');
  f.call<Session>('session.merge', { session_id: session.id }, current(f, session.id).revision);
  await eventually(
    () => current(f, session.id).merge?.state === 'blocked',
    () => f.control.tick(),
  );
  expect(current(f, session.id).merge!.reason).toMatch(/^git_failed: /);
  const rebaseDirectories = git(
    workspace.path,
    'rev-parse',
    '--git-path',
    'rebase-merge',
    '--git-path',
    'rebase-apply',
  )
    .split('\n')
    .map((directory) => path.resolve(workspace.path, directory));
  expect(rebaseDirectories.filter((directory) => existsSync(directory))).toEqual([]);
  expect(git(workspace.path, 'rev-parse', 'HEAD')).toBe(ours);
  expect(git(workspace.path, 'status', '--porcelain=v1', '--untracked-files=no')).toBe('');
  expect(readFileSync(path.join(workspace.path, 'notes.txt'), 'utf8')).toBe('kept by the user\n');
  expect(git(f.source, 'rev-parse', 'main')).toBe(theirs);
  expect(f.control.needsYou(user, f.project.id).items).toMatchObject([
    { source: { id: session.id }, reason: 'merge_blocked' },
  ]);
});
