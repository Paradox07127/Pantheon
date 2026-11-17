import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { BoardPlan, Project, Review, Session, Workspace } from '@pantheon/domain';
import * as gitCommands from '../../packages/control/dist/git.js';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = ReturnType<typeof workbenchFixture>;
const DAY = 24 * 60 * 60 * 1000;
afterEach(() => vi.useRealTimers());
const task = (
  id: string,
  domain: 'backend-logic' | 'frontend-ui' = 'backend-logic',
  estimate = 3,
) => ({
  id,
  title: id,
  goal: id,
  lane: 'core',
  depends_on: [],
  source: ['Build exports'],
  scope: ['src'],
  acceptance: ['pnpm test'],
  estimate,
  kind: { domain, tier: 't1' as const },
});

async function setup(tasks: BoardPlan['tasks']) {
  const f = workbenchFixture();
  const lead = f.create('Build exports');
  await awaitWorkspaceReady(f.control, lead.workspace_id!);
  await eventually(
    () => f.turns(lead.id)[0]?.state === 'completed',
    () => f.control.tick(),
  );
  const now = new Date(2027, 2, 16, 12).getTime();
  vi.spyOn(f.store, 'now').mockReturnValue(now);
  const plan = f.store.insert<BoardPlan>('board_plans', {
    id: lead.id,
    revision: 1,
    project_id: f.project.id,
    headline: 'Exports',
    lanes: [{ id: 'core', title: 'Core' }],
    tasks,
    plan_version: 1,
    pending_edits: [],
    risks: [],
    assumptions: [],
    inbox: [],
    notified: {},
    updated_at: now,
    iterations: [
      { id: 'current', title: 'Current', starts_on: '2027-03-16', ends_on: '2027-03-17' },
      { id: 'empty', title: 'Empty', starts_on: '2027-03-16', ends_on: '2027-03-17' },
    ],
  });
  return { f, lead, plan, now };
}

function event(
  f: Fixture,
  aggregate: { id: string; revision: number },
  kind: string,
  at: number,
  payload: unknown = {},
) {
  vi.mocked(f.store.now).mockReturnValueOnce(at);
  return f.store.event(kind, aggregate, f.project.id, payload);
}

function mergedTask(f: Fixture, lead: Session, taskId: string, at: number, duration: number) {
  const original = f.store.must<Workspace>('workspaces', lead.workspace_id!),
    workspace = f.store.insert<Workspace>('workspaces', {
      ...original,
      id: `workspace-${taskId}`,
      path: path.join(f.root, `removed-${taskId}`),
      removed_at: at,
    });
  const session = f.store.insert<Session>('sessions', {
    ...lead,
    id: `worker-${taskId}`,
    workspace_id: workspace.id,
    revision: 1,
    state: 'closed',
    outcome: 'merged',
    task: { lead_session_id: lead.id, id: taskId, generation: 1 },
    turn_count: 0,
  });
  event(f, session, 'session.opened', at - duration - 1000, session);
  event(f, lead, 'task.dispatched', at - duration, { session_id: session.id, task_id: taskId });
  event(f, session, 'session.merged', at, { from_sha: 'base', to_sha: `merge-${taskId}` });
  return session;
}

it('estimates from recent merged tasks by points and uses the domain only with five samples', async () => {
  const history = Array.from({ length: 8 }, (_, i) =>
    task(`history-${i}`, i < 5 ? 'backend-logic' : 'frontend-ui'),
  );
  const { f, lead, now } = await setup([
    ...history,
    task('old'),
    task('sparse-first', 'backend-logic', 5),
    task('sparse-second', 'backend-logic', 5),
    task('sparse', 'backend-logic', 5),
    task('backend-logic'),
    task('frontend-ui', 'frontend-ui'),
    task('unknown', 'backend-logic', 8),
  ]);
  for (let i = 1; i < history.length; i++)
    mergedTask(f, lead, history[i]!.id, now - DAY, (i + 1) * 1000);
  event(f, lead, 'task.claimed', now - DAY - 1000, { task_id: 'history-0', generation: 1 });
  const current = f.store.must<BoardPlan>('board_plans', lead.id);
  event(f, current, 'board.plan_updated', now - DAY - 2000, current);
  f.store.update(
    'board_plans',
    {
      ...current,
      tasks: current.tasks.filter((task) => !history.some((sample) => sample.id === task.id)),
    },
    current.revision,
  );
  event(f, lead, 'session.merged', now - DAY, {
    direct: true,
    task_id: 'history-0',
    generation: 1,
    from_sha: 'base',
    to_sha: 'direct-merge',
  });
  mergedTask(f, lead, 'old', now - 91 * DAY, 900000);
  mergedTask(f, lead, 'sparse-first', now - DAY, 900000);
  mergedTask(f, lead, 'sparse-second', now - DAY, 900000);
  const board = f.control.boardView(user, f.project.id, 1);
  expect(board.tasks.find((row) => row.id === `${lead.id}:backend-logic`)).toHaveProperty(
    'estimate_ms',
    3000,
  );
  expect(board.tasks.find((row) => row.id === `${lead.id}:frontend-ui`)).toHaveProperty(
    'estimate_ms',
    4500,
  );
  expect(board.tasks.find((row) => row.id === `${lead.id}:unknown`)).not.toHaveProperty(
    'estimate_ms',
  );
  expect(board.tasks.find((row) => row.id === `${lead.id}:sparse`)).not.toHaveProperty(
    'estimate_ms',
  );
});

it('forecasts open iteration work with slots and clamps remaining capacity to zero', async () => {
  const { f, lead, plan, now } = await setup([
    ...Array.from({ length: 3 }, (_, i) => task(`history-${i}`)),
    { ...task('first'), iteration: 'current' },
    { ...task('second'), iteration: 'current' },
  ]);
  for (let i = 0; i < 3; i++) mergedTask(f, lead, `history-${i}`, now - DAY, DAY);
  const read = () => f.control.boardView(user, f.project.id, 1);
  const board = read(),
    limit = board.slots!.limit;
  expect(board.iterations![0]).toMatchObject({
    forecast_done_at: now + (2 * DAY) / limit,
    capacity: Math.max(0, Math.floor((1.5 * DAY * limit - 2 * DAY) / DAY)),
  });
  expect(board.iterations![1]).not.toHaveProperty('forecast_done_at');
  f.store.update(
    'board_plans',
    { ...plan, iterations: plan.iterations!.map((row) => ({ ...row, ends_on: '2027-03-16' })) },
    plan.revision,
  );
  vi.mocked(f.store.now).mockReturnValue(now + DAY);
  expect(read().iterations![0]).toHaveProperty('capacity', 0);
  const current = f.store.must<BoardPlan>('board_plans', lead.id);
  f.store.update(
    'board_plans',
    {
      ...current,
      tasks: current.tasks.map((task) => (task.id === 'second' ? { ...task, estimate: 8 } : task)),
    },
    current.revision,
  );
  expect(read().iterations![0]).not.toHaveProperty('forecast_done_at');
  expect(read().iterations![0]).not.toHaveProperty('capacity');
});

it('projects review round times from review events and the current session pull request', async () => {
  const { f, lead, now } = await setup([task('export')]);
  const worker = mergedTask(f, lead, 'export', now - 1000, 10000);
  for (const round of [1, 2]) {
    const review = f.store.insert<Review>('reviews', {
      id: `review-${round}`,
      revision: 1,
      project_id: f.project.id,
      session_id: worker.id,
      round,
      runtimes: [],
      session_ids: [],
      state: round === 1 ? 'completed' : 'running',
      findings: [],
    });
    event(f, review, 'review.requested', now - 900 + round * 100, review);
    if (round === 1) event(f, review, 'review.completed', now - 700);
  }
  event(f, worker, 'session.pr_created', now - 600, {
    number: 42,
    url: 'https://example.com/pull/42',
  });
  expect(f.control.sessionReviews(user, worker.id)).toEqual([
    expect.objectContaining({ started_at: now - 800, ended_at: now - 700 }),
    expect.objectContaining({ started_at: now - 700 }),
  ]);
  expect(f.control.sessionReviews(user, worker.id)[1]).not.toHaveProperty('ended_at');
  const row = f.control
    .boardView(user, f.project.id, 1)
    .tasks.find((row) => row.id === `${lead.id}:export`)!;
  expect(row.external_review).toMatchObject({ rounds: 2, started_at: now - 700 });
  expect(row.external_review).not.toHaveProperty('ended_at');
  expect(row.pr).toEqual({ number: 42, url: 'https://example.com/pull/42' });
  const latest = f.store.must<Review>('reviews', 'review-2');
  f.store.update('reviews', { ...latest, state: 'failed' }, latest.revision);
  event(f, latest, 'review.failed', now - 500);
  expect(f.control.sessionReviews(user, worker.id)[1]).toHaveProperty('ended_at', now - 500);
  expect(
    f.control.boardView(user, f.project.id, 1).tasks.find((row) => row.id === `${lead.id}:export`)!
      .external_review,
  ).toMatchObject({ verdict: 'failed', started_at: now - 700, ended_at: now - 500 });
});

it('counts reverted merged ranges on the target branch with one bounded git log', async () => {
  const { f, lead } = await setup([]);
  vi.mocked(f.store.now).mockImplementation(() => Date.now());
  const base = git(f.source, 'rev-parse', 'HEAD');
  const commit = (name: string) => {
    writeFileSync(path.join(f.source, name), name);
    git(f.source, 'add', name);
    git(f.source, 'commit', '--quiet', '-m', `Add ${name}`);
    return git(f.source, 'rev-parse', 'HEAD');
  };
  const first = commit('first.txt'),
    last = commit('last.txt');
  const mergedAt = Date.now() - 1000;
  event(f, lead, 'session.merged', mergedAt, { branch: 'main', from_sha: base, to_sha: last });
  git(f.source, 'revert', '--no-edit', first);
  await f.control.prefetchWorktreeReads(user, f.project.id);
  expect(f.control.boardView(user, f.project.id, 1).counts).toMatchObject({
    merged: 1,
    reverted: 1,
  });
  git(
    f.source,
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    `Duplicate revert receipt\n\nThis reverts commit ${last}.`,
  );
  const beforeUnreverted = git(f.source, 'rev-parse', 'HEAD'),
    unreverted = commit('unreverted.txt'),
    original = f.store.must<Workspace>('workspaces', lead.workspace_id!),
    workspace = f.store.insert<Workspace>('workspaces', {
      ...original,
      id: 'unreverted-workspace',
      path: path.join(f.root, 'removed-unreverted'),
      removed_at: mergedAt,
    }),
    other = f.store.insert<Session>('sessions', {
      ...lead,
      id: 'unreverted-session',
      workspace_id: workspace.id,
      revision: 1,
      state: 'closed',
      outcome: 'merged',
      turn_count: 0,
    });
  event(f, other, 'session.opened', mergedAt - 1000, other);
  event(f, other, 'session.merged', mergedAt, {
    branch: 'main',
    from_sha: beforeUnreverted,
    to_sha: unreverted,
  });
  git(f.source, 'checkout', '--quiet', '-b', 'unmerged-revert');
  git(
    f.source,
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    `Unmerged revert\n\nThis reverts commit ${unreverted}.`,
  );
  git(f.source, 'checkout', '--quiet', 'main');
  vi.useFakeTimers({ toFake: ['Date'] });
  const run = vi.spyOn(gitCommands, 'runGit');
  await f.control.prefetchWorktreeReads(user, f.project.id);
  const logs = run.mock.calls.filter(([, args]) => args.includes('--source'));
  expect(logs).toHaveLength(1);
  expect(logs[0]![1]).toContain(`^${base}`);
  run.mockClear();
  const board = f.control.boardView(user, f.project.id, 1, undefined, 'cached');
  expect(board.counts).toMatchObject({ merged: 2, reverted: 1 });
  expect(run).not.toHaveBeenCalled();
  const prior = new Date(Date.now() - DAY),
    until = `${prior.getFullYear()}-${String(prior.getMonth() + 1).padStart(2, '0')}-${String(prior.getDate()).padStart(2, '0')}`;
  expect(f.control.boardView(user, f.project.id, 1, until).counts.reverted).toBe(0);
});

it('counts a revert of a fast-forwarded commit written before the range', async () => {
  const { f, lead } = await setup([]);
  vi.mocked(f.store.now).mockImplementation(() => Date.now());
  const base = git(f.source, 'rev-parse', 'HEAD');
  const yesterday = new Date(Date.now() - DAY).toISOString();
  const commit = (name: string) => {
    writeFileSync(path.join(f.source, name), name);
    git(f.source, 'add', name);
    execFileSync('git', ['commit', '--quiet', '-m', `Add ${name}`], {
      cwd: f.source,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Workbench Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Workbench Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        GIT_AUTHOR_DATE: yesterday,
        GIT_COMMITTER_DATE: yesterday,
      },
    });
    return git(f.source, 'rev-parse', 'HEAD');
  };
  const first = commit('first.txt'),
    last = commit('last.txt');
  event(f, lead, 'session.merged', Date.now() - 1000, {
    branch: 'main',
    from_sha: base,
    to_sha: last,
  });
  git(f.source, 'revert', '--no-edit', first);
  await f.control.prefetchWorktreeReads(user, f.project.id);
  expect(f.control.boardView(user, f.project.id, 1).counts).toMatchObject({
    merged: 1,
    reverted: 1,
  });
});

it('reads reverts of each merge in the repository of the root it merged into', async () => {
  const { f, lead } = await setup([]);
  vi.mocked(f.store.now).mockImplementation(() => Date.now());
  const commit = (cwd: string, name: string) => {
    writeFileSync(path.join(cwd, name), name);
    git(cwd, 'add', name);
    git(cwd, 'commit', '--quiet', '-m', `Add ${name}`);
    return git(cwd, 'rev-parse', 'HEAD');
  };
  const base = git(f.source, 'rev-parse', 'HEAD'),
    landed = commit(f.source, 'landed.txt');
  const other = path.join(f.root, 'project/other');
  mkdirSync(other, { recursive: true });
  git(other, 'init', '--quiet', '--initial-branch=develop');
  const otherBase = commit(other, 'base.txt'),
    otherLanded = commit(other, 'landed.txt');
  const project = f.store.must<Project>('projects', f.project.id);
  f.store.update<Project>('projects', { ...project, roots: [f.source, other] }, project.revision);
  const mergedAt = Date.now() - 1000;
  event(f, lead, 'session.merged', mergedAt, { branch: 'main', from_sha: base, to_sha: landed });
  const original = f.store.must<Workspace>('workspaces', lead.workspace_id!),
    workspace = f.store.insert<Workspace>('workspaces', {
      ...original,
      id: 'other-root-workspace',
      path: path.join(f.root, 'removed-other'),
      source: other,
      removed_at: mergedAt,
    }),
    session = f.store.insert<Session>('sessions', {
      ...lead,
      id: 'other-root-session',
      workspace_id: workspace.id,
      revision: 1,
      state: 'closed',
      outcome: 'merged',
      turn_count: 0,
    });
  event(f, session, 'session.opened', mergedAt - 1000, session);
  event(f, session, 'session.merged', mergedAt, {
    branch: 'develop',
    from_sha: otherBase,
    to_sha: otherLanded,
  });
  git(other, 'revert', '--no-edit', otherLanded);
  await f.control.prefetchWorktreeReads(user, f.project.id);
  expect(f.control.boardView(user, f.project.id, 1).counts).toMatchObject({
    merged: 2,
    reverted: 1,
  });
});
