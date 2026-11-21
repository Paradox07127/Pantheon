import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { Principal, Session, SessionTurn, Workspace } from '@pantheon/domain';
import { usesPantheonTools, type ControlContext } from '../../packages/control/dist/context.js';
import { releaseIdleConversations } from '../../packages/control/dist/session.js';
import { workbenchSessionSpec } from '../../packages/control/dist/workbench-session.js';
import { awaitWorkspaceReady, eventually, settle, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const ctxOf = (f: Fixture) => (f.control as unknown as { ctx: ControlContext }).ctx;
const row = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const script = (...steps: object[]) => `fixture-script\n${JSON.stringify(steps)}`;
const REVIEW_LINE =
  'Review it with request_review, land it with report_ready, or read it in its worktree.';

const principalOf = (f: Fixture, sessionId: string, role: Principal['role']): Principal => ({
  id: `session:${sessionId}`,
  role,
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});

async function openConductor(f: Fixture, workspace?: 'in_place') {
  const session = await f.call<Promise<Session>>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Ship the export',
    purpose: 'conductor',
    ...(workspace ? { workspace } : {}),
  });
  await settle(f, session);
  return session;
}

const spawn = (
  f: Fixture,
  callerId: string,
  input: string,
  role: Principal['role'] = 'conductor',
) =>
  f.call<Promise<{ session_id: string }>>(
    'conductor.spawn',
    { runtime: f.adapter.name, input },
    null,
    principalOf(f, callerId, role),
  );

function refusal(fn: () => unknown): { code?: string; message?: string } {
  try {
    fn();
  } catch (error) {
    return error as { code?: string; message?: string };
  }
  throw new Error('Expected the command to fail');
}

const trackerTurns = (f: Fixture, sessionId: string) =>
  f.turns(sessionId).filter((turn) => turn.origin === 'tracker');

/** Commits one file in the folder and leaves another uncommitted; returns the commit. */
function commitAndLeaveDirty(folder: string) {
  writeFileSync(path.join(folder, 'committed.txt'), 'kept\n');
  git(folder, 'add', 'committed.txt');
  git(folder, 'commit', '--quiet', '-m', 'Add the committed file');
  writeFileSync(path.join(folder, 'uncommitted.txt'), 'left behind\n');
  return git(folder, 'rev-parse', 'HEAD');
}

async function expectPlainWorktreeFrom(
  f: Fixture,
  callerId: string,
  sessionId: string,
  head: string,
) {
  const spawned = row(f, sessionId);
  expect(spawned).toMatchObject({ runtime: f.adapter.name, spawned_by: { session_id: callerId } });
  for (const field of ['conductor', 'lead', 'task', 'project_setup'])
    expect(spawned).not.toHaveProperty(field);
  expect(f.turns(sessionId)[0]!.input).toBe('Port the parser');
  const workspace = await awaitWorkspaceReady(f.control, spawned.workspace_id!);
  expect(workspace.kind).toBe('linked_worktree');
  expect(git(workspace.path, 'rev-parse', 'HEAD')).toBe(head);
  expect(existsSync(path.join(workspace.path, 'committed.txt'))).toBe(true);
  expect(existsSync(path.join(workspace.path, 'uncommitted.txt'))).toBe(false);
  expect(usesPantheonTools(ctxOf(f), row(f, sessionId))).toBe(false);
  const spec = workbenchSessionSpec(ctxOf(f), row(f, sessionId));
  expect(spec.pantheon_mcp).toBeUndefined();
  expect(spec.user_session).toBe(true);
  expect(spec.control_instructions).toBe('');
}

it('opens a plain worktree session from the committed head of a worktree conductor', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const folder = f.store.must<Workspace>('workspaces', conductor.workspace_id!).path;
  const head = commitAndLeaveDirty(folder);

  const { session_id } = await spawn(f, conductor.id, 'Port the parser');

  await expectPlainWorktreeFrom(f, conductor.id, session_id, head);
});

it('opens a plain worktree session from the project folder head of an in-place conductor', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f, 'in_place');
  expect(row(f, conductor.id).in_place).toBeDefined();
  const head = commitAndLeaveDirty(f.source);

  const { session_id } = await spawn(f, conductor.id, 'Port the parser');

  await expectPlainWorktreeFrom(f, conductor.id, session_id, head);
});

it('tells the conductor once when a turn of the session it spawned completes', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);

  const { session_id } = await spawn(
    f,
    conductor.id,
    script({ write: { path: 'docs.txt', text: 'docs\n' } }, { commit: 'Write the docs' }),
  );
  await settle(f, row(f, session_id));
  await eventually(
    () => trackerTurns(f, conductor.id).length === 1,
    () => f.control.tick(),
  );

  const text = trackerTurns(f, conductor.id)[0]!.input;
  expect(text).toMatch(/^\[Pantheon\] /);
  expect(text).toContain(session_id);
  expect(text).toContain(f.adapter.name);
  expect(text.endsWith(REVIEW_LINE)).toBe(true);
  // Closing the idle process ends the same turn a second time.
  releaseIdleConversations(ctxOf(f), f.project.id);
  await eventually(
    () =>
      f.store
        .events(0, f.project.id, 10000, ['session.process_closed'])
        .some((event) => event.aggregate_id === session_id),
    () => f.control.tick(),
  );
  await settle(f, row(f, conductor.id));
  expect(trackerTurns(f, conductor.id)).toHaveLength(1);

  // Once the list has read the worktree, the next message says how far ahead its detached HEAD is.
  await f.prefetch();
  f.call('session.send', { session_id, input: 'Look again' }, row(f, session_id).revision);
  await settle(f, row(f, session_id));
  await eventually(
    () => trackerTurns(f, conductor.id).length === 2,
    () => f.control.tick(),
  );
  expect(trackerTurns(f, conductor.id)[1]!.input).toContain('It is 1 commits ahead of main.');
});

it('tells the conductor when a turn of the session it spawned fails', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);

  const { session_id } = await spawn(f, conductor.id, script({ fail: 'The build broke' }));
  await eventually(
    () => trackerTurns(f, conductor.id).length === 1,
    () => f.control.tick(),
  );

  const text = trackerTurns(f, conductor.id)[0]!.input;
  expect(text).toMatch(/^\[Pantheon\] /);
  expect(text).toContain(session_id);
  expect(text).toContain('failed');
  expect(text).toContain('The build broke');
  expect(text).not.toContain(REVIEW_LINE);
});

it('does not tell the conductor about a turn the user interrupted', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const { session_id } = await spawn(f, conductor.id, script({ wait: 5000 }, { say: 'Done' }));
  const first = () => f.store.must<SessionTurn>('session_turns', f.turns(session_id)[0]!.id);
  await awaitWorkspaceReady(f.control, row(f, session_id).workspace_id!);
  await eventually(
    () => first().state === 'running',
    () => f.control.tick(),
  );

  f.call('session.interrupt', { session_id }, row(f, session_id).revision);
  await settle(f, row(f, session_id));
  expect(first().state).toBe('cancelled');
  releaseIdleConversations(ctxOf(f), f.project.id);
  await settle(f, row(f, session_id));
  await settle(f, row(f, conductor.id));

  expect(trackerTurns(f, conductor.id)).toHaveLength(0);
});

it('refuses a fifth unfinished spawned session and takes one again after one closes', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const spawned: string[] = [];
  for (const input of ['Task one', 'Task two', 'Task three', 'Task four'])
    spawned.push((await spawn(f, conductor.id, input)).session_id);
  for (const id of spawned) await settle(f, row(f, id));

  const error = refusal(() => spawn(f, conductor.id, 'Task five'));
  expect(error.code).toBe('resource_busy');
  expect(error.message).toContain('4');
  for (const id of spawned) expect(error.message).toContain(id);

  const closed = row(f, spawned[0]!);
  f.store.update<Session>('sessions', { ...closed, state: 'closed' }, closed.revision);
  const { session_id } = await spawn(f, conductor.id, 'Task five');
  expect(row(f, session_id).spawned_by).toEqual({ session_id: conductor.id });
});

it('refuses the user, a lead and a worker, and tells no one about a session the user opened', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const lead = await f.create('Plan the export', user, 'lead');
  await settle(f, lead);
  const input = { runtime: f.adapter.name, input: 'Port the parser' };

  expect(refusal(() => f.call('conductor.spawn', input)).code).toBe('permission_denied');
  expect(refusal(() => spawn(f, lead.id, 'Port the parser', 'lead')).code).toBe(
    'permission_denied',
  );
  expect(refusal(() => spawn(f, lead.id, 'Port the parser', 'worker')).code).toBe(
    'permission_denied',
  );

  const plain = await f.create('Explain the answer file');
  await settle(f, plain);
  releaseIdleConversations(ctxOf(f), f.project.id);
  await settle(f, row(f, plain.id));
  await settle(f, row(f, conductor.id));
  expect(
    f.store.list<SessionTurn>('session_turns').filter((turn) => turn.origin === 'tracker'),
  ).toEqual([]);
});
