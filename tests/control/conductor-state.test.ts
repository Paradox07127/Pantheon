import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
  id,
  type Landing,
  type Principal,
  type Project,
  type Review,
  type ReviewFinding,
  type Session,
  type Workspace,
} from '@pantheon/domain';
import { command } from '@pantheon/protocol';
import {
  awaitWorkspaceReady,
  eventually,
  insideSandbox,
  user,
  waitOutStatusReuse,
} from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

interface ChangeRow {
  id: string;
  kind: 'session' | 'branch';
  title: string;
  status: string;
  self?: true;
  landed?: true;
  review?: { id: string; blocking_open: number };
  gate?: { state: string; failed?: string[] };
}
interface ConductorState {
  changes: ChangeRow[];
  todo: { reason: string; session_id?: string; created_at: number }[];
}

const credential = (session: Session, role: Principal['role']): Principal => ({
  id: `session:${session.id}`,
  role,
  project_id: session.project_id,
  session_id: session.id,
  expires_at: Date.now() + 60000,
});

const refusal = async (f: Fixture, p: Principal) => {
  try {
    await f.control.execute(p, command(p.id, 'conductor.state', {}));
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return 'accepted';
};

async function idle(f: Fixture, session: Session) {
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.turns(session.id).every((turn) => turn.state === 'completed') &&
      f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  return session;
}

function commitIn(f: Fixture, session: Session, message: string) {
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
  git(workspace.path, 'commit', '--quiet', '--allow-empty', '-m', message);
}

const finding = (
  reviewId: string,
  blocking: boolean,
  resolved = false,
  status: ReviewFinding['status'] = 'open',
): ReviewFinding => ({
  id: id(),
  review_id: reviewId,
  runtime: 'reviewer',
  round: 1,
  location: 'answer.txt:1',
  quote: 'base',
  evidence: 'The answer is wrong',
  impact: 'It breaks',
  status,
  blocking,
  ...(resolved
    ? { resolution: { outcome: 'intentional' as const, resolved_at: 1, resolved_by: 'local-user' } }
    : {}),
});

const landing = (f: Fixture, projectId: string, state: Landing['state'], branch: string) =>
  f.store.insert<Landing>('landings', {
    id: id(),
    revision: 1,
    project_id: projectId,
    root: f.source,
    branch,
    target_branch: 'main',
    workspace_id: id(),
    state,
    ...(state === 'blocked'
      ? {
          reason: 'gate_failed',
          gate_results: [
            {
              state: 'failed' as const,
              name: 'Always fails',
              argv: ['false'],
              exit_code: 1,
              duration_ms: 5,
              timed_out: false,
              output: 'gate broke',
            },
          ],
        }
      : {}),
    started_at: f.store.now(),
    finished_at: f.store.now(),
  });

it("lists the project's changes, their review and to-dos to a conductor session and refuses every other role", async () => {
  const f = await workbenchFixture();
  const conductor = await idle(
    f,
    await f.call<Promise<Session>>('session.create', {
      project_id: f.project.id,
      runtime: f.adapter.name,
      input: 'Ship the export',
      purpose: 'conductor',
    }),
  );
  const running = await idle(f, await f.create('Write the parser'));
  const ahead = await idle(f, await f.create('Write the docs'));
  const quiet = await idle(f, await f.create('Read the code'));
  const stopping = await idle(f, await f.create('Stop the stuck run'));
  commitIn(f, conductor, 'Conductor work');
  commitIn(f, ahead, 'Docs');
  f.store.update(
    'sessions',
    { ...f.store.must<Session>('sessions', running.id), state: 'running' },
    f.store.must<Session>('sessions', running.id).revision,
  );
  // A stop the runtime never confirmed is an item waiting for the user.
  f.store.update(
    'sessions',
    {
      ...f.store.must<Session>('sessions', stopping.id),
      stop_requested: { reason: 'stuck', at: 0, by: 'user' },
    },
    f.store.must<Session>('sessions', stopping.id).revision,
  );
  const reviewId = id();
  f.store.insert<Review>('reviews', {
    id: reviewId,
    revision: 1,
    project_id: f.project.id,
    session_id: ahead.id,
    range: { source: 'main', from_sha: 'a'.repeat(40), to_sha: 'b'.repeat(40) },
    round: 1,
    runtimes: ['reviewer'],
    state: 'completed',
    findings: [
      finding(reviewId, true),
      finding(reviewId, true),
      finding(reviewId, true, true),
      finding(reviewId, false),
      finding(reviewId, true, false, 'stale'),
      finding(reviewId, true, true, 'stale'),
      finding(reviewId, true, false, 'rejected'),
    ],
    verdicts: [{ runtime: 'reviewer', verdict: 'fail', summary: 'Two bugs', at: 1 }],
    session_ids: [],
  });
  const blocked = landing(f, f.project.id, 'blocked', 'feature');

  const otherRoot = path.join(f.root, 'other');
  mkdirSync(otherRoot);
  const other = await f.call<Promise<Project>>('project.open', {
    name: 'Other',
    roots: [otherRoot],
  });
  const foreign = f.store.insert<Session>('sessions', {
    id: id(),
    revision: 1,
    project_id: other.id,
    runtime: f.adapter.name,
    state: 'running',
    turn_count: 0,
  });
  const foreignLanding = landing(f, other.id, 'queued', 'elsewhere');

  waitOutStatusReuse();
  await f.prefetch();
  const state = (await f.control.execute(
    credential(conductor, 'conductor'),
    command(`session:${conductor.id}`, 'conductor.state', {}),
  )) as ConductorState;
  const rows = new Map(state.changes.map((row) => [row.id, row]));

  expect(rows.get(`session:${conductor.id}`)).toMatchObject({
    kind: 'session',
    status: 'ready',
    self: true,
  });
  expect(rows.get(`session:${running.id}`)).toMatchObject({ status: 'running' });
  expect(rows.get(`session:${running.id}`)).not.toHaveProperty('self');
  expect(rows.get(`session:${ahead.id}`)).toMatchObject({
    status: 'ready',
    ahead: 1,
    review: {
      id: reviewId,
      state: 'completed',
      blocking_open: 3,
      to_sha: 'b'.repeat(40),
      verdicts: [{ runtime: 'reviewer', verdict: 'fail' }],
    },
  });
  expect(rows.get(`landing:${blocked.id}`)).toMatchObject({
    kind: 'branch',
    title: 'feature',
    branch: 'feature',
    status: 'failed',
    gate: { state: 'failed', failed: ['Always fails'] },
  });
  expect(rows.has(`session:${quiet.id}`)).toBe(false);
  expect(rows.get(`session:${stopping.id}`)).toMatchObject({ status: 'needs_you' });
  expect(state.todo).toContainEqual({
    reason: 'stop_unconfirmed',
    session_id: stopping.id,
    created_at: expect.any(Number),
  });
  expect(rows.has(`session:${foreign.id}`)).toBe(false);
  expect(rows.has(`landing:${foreignLanding.id}`)).toBe(false);

  for (const principal of [user, credential(quiet, 'planner'), credential(running, 'writer')])
    expect(await refusal(f, principal), principal.role).toBe('permission_denied');
});

it('lists the work a conductor landed as merged while it stays open', async () => {
  const f = await workbenchFixture();
  const conductor = await idle(
    f,
    await f.call<Promise<Session>>('session.create', {
      project_id: f.project.id,
      runtime: f.adapter.name,
      input: 'Ship the export',
      purpose: 'conductor',
    }),
  );
  commitIn(f, conductor, 'Conductor work');
  await f.call(
    'session.merge',
    { session_id: conductor.id },
    f.store.must<Session>('sessions', conductor.id).revision,
  );
  await eventually(
    () =>
      f.store
        .kindEvents(f.project.id, ['session.merged'])
        .some((event) => event.aggregate_id === conductor.id),
    () => f.control.tick(),
    10000,
  );
  await idle(f, conductor);
  expect(f.store.must<Session>('sessions', conductor.id).state).not.toBe('closed');

  waitOutStatusReuse();
  await f.prefetch();
  const state = (await f.control.execute(
    credential(conductor, 'conductor'),
    command(`session:${conductor.id}`, 'conductor.state', {}),
  )) as ConductorState;
  expect(state.changes.find((row) => row.id === `session:${conductor.id}`)).toMatchObject({
    status: 'merged',
    self: true,
  });
});

it('tells a conductor its work landed while it runs a turn, until it changes files again', async () => {
  const f = await workbenchFixture();
  const conductor = await idle(
    f,
    await f.call<Promise<Session>>('session.create', {
      project_id: f.project.id,
      runtime: f.adapter.name,
      input: 'Ship the export',
      purpose: 'conductor',
    }),
  );
  commitIn(f, conductor, 'Conductor work');
  await f.call(
    'session.merge',
    { session_id: conductor.id },
    f.store.must<Session>('sessions', conductor.id).revision,
  );
  await eventually(
    () =>
      f.store
        .kindEvents(f.project.id, ['session.merged'])
        .some((event) => event.aggregate_id === conductor.id),
    () => f.control.tick(),
    10000,
  );
  await idle(f, conductor);
  f.store.update(
    'sessions',
    { ...f.store.must<Session>('sessions', conductor.id), state: 'running' },
    f.store.must<Session>('sessions', conductor.id).revision,
  );
  const ownRow = async () => {
    waitOutStatusReuse();
    await f.prefetch();
    const state = (await f.control.execute(
      credential(conductor, 'conductor'),
      command(`session:${conductor.id}`, 'conductor.state', {}),
    )) as ConductorState;
    return state.changes.find((row) => row.id === `session:${conductor.id}`);
  };

  expect(await ownRow()).toMatchObject({ status: 'running', landed: true, self: true });

  const workspace = f.store.must<Workspace>('workspaces', conductor.workspace_id!);
  writeFileSync(path.join(workspace.path, 'next.txt'), 'next\n');
  git(workspace.path, 'add', 'next.txt');
  git(workspace.path, 'commit', '--quiet', '-m', 'Next conductor work');
  const changed = await ownRow();
  expect(changed).toMatchObject({ status: 'running', self: true });
  expect(changed).not.toHaveProperty('landed');
});

it.each([
  {
    name: 'nothing changed since it landed',
    edit: () => {},
    listed: false,
    landed: true,
  },
  {
    name: 'a new commit and an uncommitted edit that undoes it',
    edit: (folder: string) => {
      writeFileSync(path.join(folder, 'next.txt'), 'next\n');
      git(folder, 'add', 'next.txt');
      git(folder, 'commit', '--quiet', '-m', 'Next conductor work');
      git(folder, 'rm', '--quiet', 'next.txt');
    },
    listed: true,
    landed: false,
  },
  {
    name: 'a new file the repository hides from status',
    edit: (folder: string) => {
      git(folder, 'config', 'status.showUntrackedFiles', 'no');
      writeFileSync(path.join(folder, 'next.txt'), 'next\n');
    },
    listed: false,
    landed: false,
  },
])(
  'reads from git whether a running conductor is at the commit it landed: $name',
  async ({ edit, listed, landed }) => {
    const f = await workbenchFixture();
    const conductor = await idle(
      f,
      await f.call<Promise<Session>>('session.create', {
        project_id: f.project.id,
        runtime: f.adapter.name,
        input: 'Ship the export',
        purpose: 'conductor',
      }),
    );
    commitIn(f, conductor, 'Conductor work');
    await f.call(
      'session.merge',
      { session_id: conductor.id },
      f.store.must<Session>('sessions', conductor.id).revision,
    );
    await eventually(
      () =>
        f.store
          .kindEvents(f.project.id, ['session.merged'])
          .some((event) => event.aggregate_id === conductor.id),
      () => f.control.tick(),
      10000,
    );
    await idle(f, conductor);
    f.store.update(
      'sessions',
      { ...f.store.must<Session>('sessions', conductor.id), state: 'running' },
      f.store.must<Session>('sessions', conductor.id).revision,
    );
    edit(f.store.must<Workspace>('workspaces', conductor.workspace_id!).path);
    // The list reads files changed against the landed base, which hides a commit undone on disk.
    if (listed) {
      waitOutStatusReuse();
      await f.prefetch();
    }

    const state = (await f.control.execute(
      credential(conductor, 'conductor'),
      command(`session:${conductor.id}`, 'conductor.state', {}),
    )) as ConductorState;
    const own = state.changes.find((row) => row.id === `session:${conductor.id}`);
    expect(own).toMatchObject({ status: 'running', self: true });
    expect(own?.landed).toBe(landed ? true : undefined);
  },
);

it.skipIf(insideSandbox)(
  'shows a stale gate on the change row as the session list does',
  async () => {
    const f = await workbenchFixture();
    git(f.source, 'config', 'user.name', 'Source User');
    git(f.source, 'config', 'user.email', 'source@example.invalid');
    await f.call<Project>(
      'project.gate.set',
      {
        project_id: f.project.id,
        root: f.source,
        commands: [{ name: 'Passes', argv: [process.execPath, '-e', 'process.exit(0)'] }],
      },
      f.store.must<Project>('projects', f.project.id).revision,
    );
    const conductor = await idle(
      f,
      await f.call<Promise<Session>>('session.create', {
        project_id: f.project.id,
        runtime: f.adapter.name,
        input: 'Ship the export',
        purpose: 'conductor',
      }),
    );
    commitIn(f, conductor, 'Conductor work');
    await f.call(
      'session.merge',
      { session_id: conductor.id },
      f.store.must<Session>('sessions', conductor.id).revision,
    );
    await eventually(
      () =>
        f.store
          .kindEvents(f.project.id, ['session.merged'])
          .some((event) => event.aggregate_id === conductor.id),
      () => f.control.tick(),
      10000,
    );
    await idle(f, conductor);
    commitIn(f, conductor, 'More conductor work');

    waitOutStatusReuse();
    await f.prefetch();
    expect(f.list().find((row) => row.id === conductor.id)?.gate?.state).toBe('stale');
    const state = (await f.control.execute(
      credential(conductor, 'conductor'),
      command(`session:${conductor.id}`, 'conductor.state', {}),
    )) as ConductorState;
    expect(state.changes.find((row) => row.id === `session:${conductor.id}`)?.gate).toEqual({
      state: 'stale',
    });
  },
);
