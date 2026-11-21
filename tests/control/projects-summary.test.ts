import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { Approval, Principal, Project, Session, Workspace } from '@pantheon/domain';
import { briefItemsKey, type SeenCursor } from '../../packages/control/dist/project-brief.js';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

async function idleSession(f: Awaited<ReturnType<typeof workbenchFixture>>, input?: string) {
  const session = await f.create(input);
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.turns(session.id).every((turn) => turn.state === 'completed') &&
      f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  return session;
}

const patch = (
  f: Awaited<ReturnType<typeof workbenchFixture>>,
  sessionId: string,
  fields: Partial<Session>,
) => {
  const session = f.store.must<Session>('sessions', sessionId);
  return f.store.update<Session>('sessions', { ...session, ...fields }, session.revision);
};

const countsOf = (f: Awaited<ReturnType<typeof workbenchFixture>>) =>
  f.control.projectsSummary(user).projects.find((project) => project.project_id === f.project.id)
    ?.counts;

it('counts a merging session and a reconciling session as running', async () => {
  const f = await workbenchFixture();
  const merging = await idleSession(f),
    reconciling = await idleSession(f);
  patch(f, merging.id, { merge: { state: 'running' } });
  patch(f, reconciling.id, { state: 'reconciling' });
  expect(f.list().find((row) => row.id === merging.id)?.state).toBe('merging');
  expect(countsOf(f)).toEqual({ running: 2, waiting: 0, ready: 0, failed: 0 });
});

it('leaves archived sessions out of the counts and removed projects out of the summary', async () => {
  const f = await workbenchFixture();
  const session = await idleSession(f);
  patch(f, session.id, { state: 'closed' });
  expect(countsOf(f)).toEqual({ running: 0, waiting: 0, ready: 0, failed: 1 });
  patch(f, session.id, { archived_at: new Date(f.store.now()).toISOString() });
  expect(countsOf(f)).toEqual({ running: 0, waiting: 0, ready: 0, failed: 0 });
  const project = f.store.must<Project>('projects', f.project.id);
  f.store.update<Project>('projects', { ...project, removed_at: f.store.now() }, project.revision);
  expect(f.control.projectsSummary(user).projects).toEqual([]);
});

it('summarizes two projects and limits a planner to its own project', async () => {
  const f = await workbenchFixture();
  const first = await f.create('Run the first session'),
    second = await f.create('Run the second session'),
    waiting = await f.create('Wait for permission'),
    ready = await f.create('Prepare a change'),
    failed = await f.create('Fail the session');
  const otherProject = f.store.insert<Project>('projects', {
    ...f.project,
    id: 'other-project',
    name: 'Other project',
  });
  const otherWaiting = await f.call<Session>('session.create', {
    project_id: otherProject.id,
    runtime: f.adapter.name,
    input: 'Wait for the other project permission',
  });
  const sessions = [first, second, waiting, ready, failed, otherWaiting];
  for (const session of sessions) await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      sessions.every(
        (session) =>
          f.turns(session.id).every((turn) => turn.state === 'completed') &&
          f.store.must<Session>('sessions', session.id).state === 'open',
      ),
    () => f.control.tick(),
  );
  for (const [session, state] of [
    [first, 'running'],
    [second, 'running'],
    [failed, 'closed'],
  ] as const) {
    const current = f.store.must<Session>('sessions', session.id);
    f.store.update<Session>('sessions', { ...current, state }, current.revision);
  }
  for (const session of [waiting, otherWaiting])
    f.store.insert<Approval>('approvals', {
      id: `approval-${session.id}`,
      revision: 1,
      project_id: session.project_id,
      session_id: session.id,
      kind: 'permission',
      input_hash: 'permission-input',
      decider: 'user',
      state: 'pending',
      created_at: f.store.now(),
    });
  const workspace = f.store.must<Workspace>('workspaces', ready.workspace_id!);
  writeFileSync(path.join(workspace.path, 'answer.txt'), 'ready to merge\n');
  git(workspace.path, 'add', 'answer.txt');
  git(workspace.path, 'commit', '--quiet', '-m', 'Add the answer');
  const lastActivity = f.store.now() + 1000;
  f.store.db
    .prepare('UPDATE events SET created_at=? WHERE aggregate_id=?')
    .run(lastActivity, first.id);

  await f.control.prefetchWorktreeReads(user);
  const cursor = f.store.cursor();
  const { projects } = f.control.projectsSummary(user);
  expect(projects).toHaveLength(2);
  expect(projects.find((project) => project.project_id === f.project.id)).toMatchObject({
    project_id: f.project.id,
    name: f.project.name,
    counts: { running: 2, waiting: 1, ready: 1, failed: 1 },
    needs_you: 2,
    last_activity_at: new Date(lastActivity).toISOString(),
  });
  expect(projects.find((project) => project.project_id === otherProject.id)).toMatchObject({
    project_id: otherProject.id,
    name: otherProject.name,
    counts: { running: 0, waiting: 1, ready: 0, failed: 0 },
    needs_you: 1,
  });
  expect(f.store.cursor()).toBe(cursor);

  const plannerSession = f.store.insert<Session>('sessions', {
    id: 'planner-session',
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    state: 'open',
    turn_count: 0,
  });
  const planner: Principal = {
    id: `session:${plannerSession.id}`,
    role: 'planner',
    project_id: f.project.id,
    session_id: plannerSession.id,
    expires_at: f.store.now() + 60000,
  };
  const { waiting: _waiting, ...own } = projects.find(
    (project) => project.project_id === f.project.id,
  )!;
  expect(f.control.projectsSummary(planner).projects).toEqual([{ ...own, needs_you: 0 }]);
});

it("gives each project its waiting decisions by kind, the longest wait and its brief's first sentence", async () => {
  const f = await workbenchFixture();
  const lead = await idleSession(f, 'Ship exports');
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Ship exports',
      lanes: [{ id: 'exports', title: 'Exports' }],
      tasks: ['api', 'docs'].map((id) => ({
        id,
        title: id,
        goal: 'Build exports',
        lane: 'exports',
        depends_on: [],
        source: ['Ship exports'],
        scope: [`src/${id}`],
        acceptance: ['pnpm test'],
      })),
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    {
      id: `session:${lead.id}`,
      role: 'lead',
      project_id: f.project.id,
      session_id: lead.id,
      expires_at: f.store.now() + 60000,
    },
  );
  const now = f.store.now();
  vi.spyOn(f.store, 'now').mockReturnValue(now);
  f.store.insert<Approval>('approvals', {
    id: 'lead-permission',
    revision: 1,
    project_id: f.project.id,
    session_id: lead.id,
    kind: 'permission',
    input_hash: 'permission-input',
    decider: 'user',
    state: 'pending',
    created_at: now - 5000,
  });
  const otherProject = f.store.insert<Project>('projects', {
    ...f.project,
    id: 'other-project',
    name: 'Other project',
  });
  const brief = f.control.projectBrief(user, f.project.id);
  const prose = (projectId: string, itemsKey: string) =>
    f.store.insert<SeenCursor>('seen_cursors', {
      id: JSON.stringify([user.id, projectId]),
      revision: 1,
      user_id: user.id,
      project_id: projectId,
      at: 0,
      prose: {
        sentences: [
          { text: 'A permission waits for the lead.', refs: [] },
          { text: 'Nothing else waits.', refs: [] },
        ],
        at: now,
        since: 0,
        items_key: itemsKey,
      },
    });
  prose(f.project.id, briefItemsKey(brief.items));
  // Prose written for other items is stale and gives no brief.
  prose(otherProject.id, 'other-items');

  const { projects } = f.control.projectsSummary(user);
  expect(projects.find((project) => project.project_id === f.project.id)).toMatchObject({
    needs_you: 1,
    brief: 'A permission waits for the lead.',
    waiting: {
      by_decision: { permission: 1 },
      longest_wait_ms: 5000,
      blocked_tasks: 0,
    },
  });
  const other = projects.find((project) => project.project_id === otherProject.id)!;
  expect(other.brief).toBeUndefined();
  expect(other.waiting).toBeUndefined();
});

it('reads each worktree once per summary', async () => {
  const f = await workbenchFixture();
  const session = await idleSession(f);
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
  writeFileSync(path.join(workspace.path, 'note.txt'), 'uncommitted\n');
  const gitModule = await import('../../packages/control/dist/git.js');
  const runGit = vi.spyOn(gitModule, 'runGit');
  await f.control.prefetchWorktreeReads(user);
  f.control.projectsSummary(user);
  const diffs = runGit.mock.calls.filter(
    ([cwd, args]) => cwd === workspace.path && args[0] === 'diff',
  );
  runGit.mockRestore();
  expect(diffs).toHaveLength(1);
});

it('counts merged sessions since local midnight using the board clock', async () => {
  const f = await workbenchFixture();
  const session = await idleSession(f);
  const now = new Date(2027, 2, 16, 12).getTime();
  vi.spyOn(f.store, 'now').mockReturnValue(now);
  const midnight = new Date(2027, 2, 16).getTime();
  for (const [id, at, project_id] of [
    ['before-midnight', midnight - 1, f.project.id],
    ['at-midnight', midnight, f.project.id],
    ['after-midnight', midnight + 1, f.project.id],
    ['other-project-merge', midnight + 1, 'other-project'],
  ] as const) {
    const merged = f.store.insert<Session>('sessions', {
      ...session,
      id,
      revision: 1,
      project_id,
      state: 'closed',
      outcome: 'merged',
    });
    const event = f.store.event('session.merged', merged, project_id, { to_sha: 'merged-head' });
    f.store.db.prepare('UPDATE events SET created_at=? WHERE sequence=?').run(at, event.sequence);
  }
  const summary = f.control.projectsSummary(user).projects[0]!;
  expect(summary.merged_today).toBe(2);
});
