import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { id, type Project, type Review, type Session, type Workspace } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, user, waitOutStatusReuse } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

async function readyWithCommit(f: Fixture, input: string) {
  const session = await f.create(input);
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.turns(session.id).every((turn) => turn.state === 'completed') &&
      f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
  git(workspace.path, 'commit', '--quiet', '--allow-empty', '-m', input);
  return session;
}

const changeOf = async (f: Fixture, sessionId: string) => {
  waitOutStatusReuse();
  await f.prefetch();
  return f.control
    .projectChanges(user, f.project.id)
    .changes.find((row) => row.id === `session:${sessionId}`);
};

it('marks a completed review that lacks a full result from a reviewer as incomplete', async () => {
  const f = await workbenchFixture();
  const session = await readyWithCommit(f, 'Write the docs');
  const review = (incomplete?: string) =>
    f.store.insert<Review>('reviews', {
      id: id(),
      revision: 1,
      project_id: f.project.id,
      session_id: session.id,
      round: 1,
      runtimes: ['reviewer', 'second'],
      state: 'completed',
      ...(incomplete ? { incomplete } : {}),
      findings: [],
      verdicts: [{ runtime: 'reviewer', verdict: 'pass', summary: 'Fine', at: 1 }],
      session_ids: [],
    });

  review('reviewer second failed');
  expect((await changeOf(f, session.id))?.review).toMatchObject({
    state: 'completed',
    incomplete: true,
    verdicts: [{ runtime: 'reviewer', verdict: 'pass' }],
  });

  review();
  expect((await changeOf(f, session.id))?.review).not.toHaveProperty('incomplete');
});

it('lists a gate that is running or being cancelled as running', async () => {
  const f = await workbenchFixture();
  const project = f.store.must<Project>('projects', f.project.id);
  await f.call(
    'project.gate.set',
    {
      project_id: f.project.id,
      root: project.roots[0]!,
      commands: [{ name: 'test', argv: ['node', '-e', '0'] }],
    },
    project.revision,
  );
  const session = await readyWithCommit(f, 'Write the parser');
  for (const state of ['running', 'cancelling'] as const) {
    const current = f.store.must<Session>('sessions', session.id);
    f.store.update(
      'sessions',
      { ...current, gate_run: { id: `gate-${state}`, state, started_at: f.store.now() } },
      current.revision,
    );
    expect((await changeOf(f, session.id))?.gate, state).toEqual({ state: 'running' });
  }
});

it.each([
  ['a worktree with a committed line', false, { files: 1, additions: 1, deletions: 0 }],
  ['a session that landed and closed its worktree', true, undefined],
] as const)(
  'gives the row the worktree changes not landed yet: %s',
  async (_case, closed, changes) => {
    const f = await workbenchFixture();
    const session = await f.create('Write the notes');
    await awaitWorkspaceReady(f.control, session.workspace_id!);
    await eventually(
      () => f.store.must<Session>('sessions', session.id).state === 'open',
      () => f.control.tick(),
    );
    const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
    writeFileSync(path.join(workspace.path, 'notes.txt'), 'notes\n');
    git(workspace.path, 'add', 'notes.txt');
    git(workspace.path, 'commit', '--quiet', '-m', 'Notes');
    if (closed) {
      const current = f.store.must<Session>('sessions', session.id);
      f.store.update(
        'sessions',
        { ...current, state: 'closed', outcome: 'merged' },
        current.revision,
      );
    }

    const row = await changeOf(f, session.id);

    expect(row?.status).toBe(closed ? 'merged' : 'ready');
    if (changes) expect(row?.changes).toEqual(changes);
    else expect(row).not.toHaveProperty('changes');
  },
);
