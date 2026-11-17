import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type { BoardPlan, Project, Session, Workspace } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, user, waitOutStatusReuse } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = ReturnType<typeof workbenchFixture>;
async function settle(f: Fixture, session: Session) {
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
}

it('creates an in-place session in the project folder without provisioning a worktree', async () => {
  const f = workbenchFixture({ managedWorkspaces: false });
  const before = git(f.source, 'worktree', 'list', '--porcelain');
  const session = f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    workspace: 'in_place',
    input: 'Work here',
  });
  await settle(f, session);
  expect(f.store.must<Workspace>('workspaces', session.workspace_id!)).toMatchObject({
    kind: 'in_place',
    path: f.source,
  });
  expect(f.store.must<Workspace>('workspaces', session.workspace_id!)).not.toHaveProperty(
    'provisioning',
  );
  expect(git(f.source, 'worktree', 'list', '--porcelain')).toBe(before);
  expect(f.turns(session.id)).toMatchObject([{ state: 'completed' }]);
  expect(f.start.mock.calls[0]![0]).toMatchObject({ cwd: f.source });
  const row = f.list()[0]!;
  expect(row).not.toHaveProperty('branch');
  expect(row).not.toHaveProperty('ahead');
  expect(row).not.toHaveProperty('behind');
});

it('starts worktrees at the selected branch or the current head of the selected session', async () => {
  const f = workbenchFixture();
  git(f.source, 'branch', 'feature');
  const base = git(f.source, 'rev-parse', 'feature');
  writeFileSync(path.join(f.source, 'answer.txt'), 'main moved\n');
  git(f.source, 'commit', '--quiet', '-am', 'Move main');
  const create = (from: object) =>
    f.call<Session>('session.create', {
      project_id: f.project.id,
      runtime: f.adapter.name,
      input: 'Work from this',
      from,
    });
  const first = create({ branch: 'feature' });
  await settle(f, first);
  const work = f.store.must<Workspace>('workspaces', first.workspace_id!).path;
  expect(git(work, 'rev-parse', 'HEAD')).toBe(base);
  writeFileSync(path.join(work, 'answer.txt'), 'session moved\n');
  git(work, 'commit', '--quiet', '-am', 'Move session');
  const second = create({ session_id: first.id });
  await settle(f, second);
  expect(
    git(f.store.must<Workspace>('workspaces', second.workspace_id!).path, 'rev-parse', 'HEAD'),
  ).toBe(git(work, 'rev-parse', 'HEAD'));
});

it('previews the project and selected start points without changing files or records', async () => {
  const f = workbenchFixture();
  const source = f.create();
  await settle(f, source);
  const work = f.store.must<Workspace>('workspaces', source.workspace_id!).path;
  writeFileSync(path.join(work, 'answer.txt'), 'selected head\n');
  git(work, 'commit', '--quiet', '-am', 'Move session');
  const before = {
    trees: git(f.source, 'worktree', 'list', '--porcelain'),
    dirs: readdirSync(path.dirname(work)),
    cursor: f.store.cursor(),
    sessions: f.store.list('sessions'),
    workspaces: f.store.list('workspaces'),
  };
  const preview = (
    options: Omit<Parameters<typeof f.control.sessionCreatePreview>[1], 'project_id'> = {},
  ) => f.control.sessionCreatePreview(user, { project_id: f.project.id, ...options });
  const head = git(f.source, 'rev-parse', 'HEAD');
  expect(await preview({ workspace: 'in_place' })).toEqual({
    branch: 'main',
    base_sha: head,
    base_ref: 'refs/heads/main',
  });
  expect(await preview()).toEqual({ branch: null, base_sha: head, base_ref: 'refs/heads/main' });
  expect((await preview({ from: { branch: 'main' } })).base_sha).toBe(head);
  expect((await preview({ from: { session_id: source.id } })).base_sha).toBe(
    git(work, 'rev-parse', 'HEAD'),
  );
  expect({
    trees: git(f.source, 'worktree', 'list', '--porcelain'),
    dirs: readdirSync(path.dirname(work)),
    cursor: f.store.cursor(),
    sessions: f.store.list('sessions'),
    workspaces: f.store.list('workspaces'),
  }).toEqual(before);
});

it('reports project commit time, changed paths and upstream distance only when an upstream exists', async () => {
  const f = workbenchFixture();
  const committedAt = Number(git(f.source, 'log', '-1', '--format=%ct')) * 1000;
  const head = await f.control.projectHead(user, f.project.id);
  expect(head).toMatchObject({ committed_at: committedAt, uncommitted: 0 });
  expect(head).not.toHaveProperty('ahead_upstream');
  git(f.source, 'branch', 'upstream');
  git(f.source, 'branch', '--set-upstream-to=upstream', 'main');
  writeFileSync(path.join(f.source, 'answer.txt'), 'new head\n');
  git(f.source, 'commit', '--quiet', '-am', 'Move main');
  git(f.source, 'mv', 'answer.txt', 'renamed answer.txt');
  writeFileSync(path.join(f.source, 'new\nfile.txt'), 'untracked\n');
  waitOutStatusReuse();
  expect(await f.control.projectHead(user, f.project.id)).toMatchObject({
    ahead_upstream: 1,
    uncommitted: 2,
  });
});

it('lists branch and divergence against the source branch and omits git facts without a worktree', async () => {
  const f = workbenchFixture({ adoptable: true });
  const session = f.create();
  await settle(f, session);
  const work = f.store.must<Workspace>('workspaces', session.workspace_id!).path;
  git(work, 'checkout', '--quiet', '-b', 'session-work');
  writeFileSync(path.join(work, 'answer.txt'), 'session change\n');
  git(work, 'commit', '--quiet', '-am', 'Move session');
  writeFileSync(path.join(f.source, 'answer.txt'), 'source change\n');
  git(f.source, 'commit', '--quiet', '-am', 'Move source');
  waitOutStatusReuse();
  await f.prefetch();
  expect(f.list().find((row) => row.id === session.id)).toMatchObject({
    branch: 'session-work',
    ahead: 1,
    behind: 1,
  });
  const folder = await f.adopt();
  const row = f.list().find((row) => row.id === folder.id)!;
  for (const field of ['branch', 'ahead', 'behind']) expect(row).not.toHaveProperty(field);
  const review = f.store.insert<Session>('sessions', {
    id: 'review-without-worktree',
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    state: 'open',
    turn_count: 0,
    runtime_review: { from: 0, to: 1 } as Session['runtime_review'],
  });
  const noWorktree = f.list().find((row) => row.id === review.id)!;
  for (const field of ['branch', 'ahead', 'behind', 'goal', 'device_id'])
    expect(noWorktree).not.toHaveProperty(field);
});

it('lists a bounded first-input goal and device and uses the task goal for task sessions', async () => {
  const f = workbenchFixture();
  const text = 'Build the report. '.repeat(20);
  const lead = f.create(text);
  await settle(f, lead);
  const queued = f.store
    .kindEvents(f.project.id, ['turn.queued'])
    .find((event) => event.aggregate_id === f.turns(lead.id)[0]!.id)!;
  expect(f.list().find((row) => row.id === lead.id)).toMatchObject({
    goal: { text: text.slice(0, 200), at: new Date(queued.created_at).toISOString() },
    device_id: 'local',
  });
  f.call(
    'session.send',
    { session_id: lead.id, input: 'A later input' },
    f.store.must<Session>('sessions', lead.id).revision,
  );
  await settle(f, lead);
  const plan: BoardPlan = {
    id: lead.id,
    revision: 1,
    project_id: f.project.id,
    headline: 'Reports',
    lanes: [{ id: 'reports', title: 'Reports' }],
    tasks: [
      {
        id: 'export',
        title: 'Export',
        goal: 'Download reports',
        lane: 'reports',
        depends_on: [],
        source: [text],
        scope: ['src'],
        acceptance: ['pnpm test'],
      },
    ],
    risks: [],
    assumptions: [],
    plan_version: 0,
    pending_edits: [],
    inbox: [],
    notified: {},
    updated_at: f.store.now(),
  };
  f.store.insert('board_plans', plan);
  const worker = f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    task_id: `${lead.id}:export`,
    input: 'Do it',
  });
  expect(f.list().find((row) => row.id === worker.id)).toMatchObject({
    goal: { text: 'Download reports' },
  });
  expect(f.list().find((row) => row.id === lead.id)).toMatchObject({
    goal: { text: text.slice(0, 200) },
  });
});

it('counts results of the latest gate run and resets the counts for a running run', async () => {
  const f = workbenchFixture();
  const session = f.create();
  await settle(f, session);
  const commands = [
    { name: 'Build', argv: ['node', '-e', '0'] },
    { name: 'Test', argv: ['node', '-e', '1'] },
  ];
  f.call(
    'project.gate.set',
    { project_id: f.project.id, root: f.source, commands },
    f.store.must<Project>('projects', f.project.id).revision,
  );
  const record = (results: { exit_code: number | null; timed_out: boolean }[]) =>
    f.store.event('session.gate_checked', session, f.project.id, {
      commit: git(f.source, 'rev-parse', 'HEAD'),
      check_spec_hash: 'spec',
      results: results.map((result, index) => ({ ...commands[index], ...result, output: '' })),
    });
  record([
    { exit_code: 0, timed_out: false },
    { exit_code: 0, timed_out: false },
  ]);
  record([
    { exit_code: 0, timed_out: false },
    { exit_code: null, timed_out: true },
  ]);
  expect(f.list()[0]!.gate).toMatchObject({ passed: 1, failed: 1, running: 0 });
  const current = f.store.must<Session>('sessions', session.id);
  f.store.update(
    'sessions',
    { ...current, gate_run: { id: 'new-run', state: 'running', started_at: f.store.now() } },
    current.revision,
  );
  f.store.event('session.gate_started', session, f.project.id, { commands });
  expect(f.list()[0]!.gate).toMatchObject({ state: 'running', passed: 0, failed: 0, running: 2 });
});

it('counts the commands a failed run never reached as not run once the run ends', async () => {
  const f = workbenchFixture();
  const session = f.create();
  await settle(f, session);
  const commands = ['Test', 'Build', 'Lint'].map((name) => ({ name, argv: ['node', '-e', '0'] }));
  f.call(
    'project.gate.set',
    { project_id: f.project.id, root: f.source, commands },
    f.store.must<Project>('projects', f.project.id).revision,
  );
  f.store.event('session.gate_started', session, f.project.id, { commands });
  f.store.event('session.gate_checked', session, f.project.id, {
    commit: git(f.source, 'rev-parse', 'HEAD'),
    check_spec_hash: 'spec',
    results: [{ ...commands[0], exit_code: 1, timed_out: false, output: '' }],
  });
  expect(f.list()[0]!.gate).toMatchObject({ passed: 0, failed: 1, running: 0, not_run: 2 });
});

it('forks onto a requested runtime, model and effort and starts that runtime', async () => {
  const f = workbenchFixture();
  const source = f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    model: 'source-model',
    effort: 'low',
    input: 'Start the report',
  });
  await settle(f, source);
  const other = new FixtureAdapter();
  other.name = 'other-runtime';
  const start = vi.spyOn(other, 'start');
  f.control.adapters.set(other.name, other);
  const forked = await f.call<Session>('session.fork', {
    session_id: source.id,
    runtime: other.name,
    model: 'other-model',
    effort: 'high',
    input: 'Try this runtime',
  });
  await settle(f, forked);
  expect(forked).toMatchObject({
    runtime: other.name,
    requested_model: 'other-model',
    requested_effort: 'high',
  });
  const defaults = await f.call<Session>('session.fork', {
    session_id: source.id,
    runtime: other.name,
    input: 'Use its default model',
  });
  expect(defaults.runtime).toBe(other.name);
  expect(defaults.requested_model).toBeUndefined();
  expect(defaults.requested_effort).toBeUndefined();
  expect(start.mock.calls[0]![0]).toMatchObject({
    runtime: other.name,
    model: 'other-model',
    effort: 'high',
  });
});

it('delivers summaries of referenced sessions with the message while keeping the user input intact', async () => {
  const f = workbenchFixture();
  const source = f.create('Explain the report format');
  await settle(f, source);
  const send = vi.spyOn(f.adapter, 'send');
  const refs = [{ kind: 'session', id: source.id }];
  const target = f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Use that explanation',
    refs,
  });
  await settle(f, target);
  expect(send.mock.calls.at(-1)![1].input).toContain('Explain the report format');
  expect(f.turns(target.id)[0]!.input).toBe('Use that explanation');
  f.call(
    'session.send',
    { session_id: target.id, input: 'Use it again', refs },
    f.store.must<Session>('sessions', target.id).revision,
  );
  await settle(f, target);
  expect(send.mock.calls.at(-1)![1].input).toContain('Explain the report format');
  expect(send.mock.calls.at(-1)![1].input).toContain('Use it again');
});

it('refuses a reference or start point from another project', async () => {
  const f = workbenchFixture();
  const target = f.create();
  await settle(f, target);
  const root = path.join(f.root, 'other');
  mkdirSync(root);
  const other = f.call<Project>('project.open', { name: 'Other', roots: [root] });
  const foreign = f.store.insert<Session>('sessions', {
    ...target,
    id: 'foreign-session',
    project_id: other.id,
  });
  const refs = [{ kind: 'session', id: foreign.id }];
  expect(() =>
    f.call(
      'session.send',
      { session_id: target.id, input: 'Use it', refs },
      f.store.must<Session>('sessions', target.id).revision,
    ),
  ).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  expect(() =>
    f.call('session.create', {
      project_id: f.project.id,
      runtime: f.adapter.name,
      input: 'Use it',
      refs,
    }),
  ).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  expect(() =>
    f.call('session.create', {
      project_id: f.project.id,
      runtime: f.adapter.name,
      input: 'Start there',
      from: { session_id: foreign.id },
    }),
  ).toThrow(expect.objectContaining({ code: 'invalid_input' }));
});

it('archives and deletes a finished runtime analysis', () => {
  const f = workbenchFixture();
  const finished = (id: string, report?: object, state: Session['state'] = 'closed') =>
    f.store.insert<Session>('sessions', {
      id,
      revision: 1,
      project_id: f.project.id,
      runtime: f.adapter.name,
      state,
      turn_count: 1,
      permission_mode: 'ask',
      runtime_review: {
        from: 0,
        to: 1,
        ...(report ? { report } : {}),
      } as Session['runtime_review'],
    });
  const done = finished('analysis-done', { summary: 'Waits come from approvals' });
  const failed = finished('analysis-failed');
  const listed = (id: string) => f.list().find((row) => row.id === id);
  expect(listed(done.id)?.state).toBe('done');
  expect(listed(failed.id)?.state).toBe('failed');
  const archived = f.call<Session>('session.archive', { session_id: done.id }, done.revision);
  expect(archived.archived_at).toBeDefined();
  f.call('session.delete', { session_id: done.id }, archived.revision);
  f.call('session.delete', { session_id: failed.id }, failed.revision);
  expect(f.store.get('sessions', done.id)).toBeUndefined();
  expect(f.store.get('sessions', failed.id)).toBeUndefined();
  const running = finished('analysis-running', undefined, 'running');
  expect(() => f.call('session.delete', { session_id: running.id }, running.revision)).toThrow(
    expect.objectContaining({ code: 'resource_busy' }),
  );
});

it('uses the first user follow-up as the goal of an analysis session', async () => {
  const f = workbenchFixture();
  const now = f.store.now();
  const { session_id } = f.call<{ session_id: string }>('trace.reflect', {
    project_id: f.project.id,
    from: now - 1000,
    to: now,
  });
  await eventually(
    () => f.store.must<Session>('sessions', session_id).state === 'open',
    () => f.control.tick(),
  );
  expect(f.list().find((row) => row.id === session_id)).not.toHaveProperty('goal');
  f.call(
    'session.send',
    { session_id, input: 'Explain the waiting time' },
    f.store.must<Session>('sessions', session_id).revision,
  );
  expect(f.list().find((row) => row.id === session_id)).toMatchObject({
    goal: { text: 'Explain the waiting time' },
  });
});
