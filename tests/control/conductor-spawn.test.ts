import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  id,
  type Principal,
  type Project,
  type Session,
  type SessionTurn,
  type Workspace,
} from '@pantheon/domain';
import { afterSpawnedTurn } from '../../packages/control/dist/conductor.js';
import { usesPantheonTools, type ControlContext } from '../../packages/control/dist/context.js';
import { mergesPreparing, releaseIdleConversations } from '../../packages/control/dist/session.js';
import { notifySession } from '../../packages/control/dist/session-wake.js';
import {
  forgetWorktreeReads,
  workbenchSessionSpec,
} from '../../packages/control/dist/workbench-session.js';
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

/** The turns of the spawned session its caller was told of, in the order they were told. */
const toldTurns = (f: Fixture, sessionId: string) =>
  f.store
    .events(0, f.project.id, 10000, ['session.spawner_notified'])
    .filter((event) => event.aggregate_id === sessionId)
    .map((event) => (event.payload as { turn_id: string }).turn_id);

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
  expect(text).toContain('It is 1 commit ahead of main.');
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
  expect(trackerTurns(f, conductor.id)[1]!.input).toContain('It is 1 commit ahead of main.');
});

it('counts the commits of a later turn though the list read the worktree before it', async () => {
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
  await settle(f, row(f, conductor.id));
  await f.prefetch();

  f.call(
    'session.send',
    {
      session_id,
      input: script({ write: { path: 'notes.txt', text: 'notes\n' } }, { commit: 'Add notes' }),
    },
    row(f, session_id).revision,
  );
  await settle(f, row(f, session_id));
  await eventually(
    () => trackerTurns(f, conductor.id).length === 2,
    () => f.control.tick(),
  );

  expect(trackerTurns(f, conductor.id)[1]!.input).toContain('It is 2 commits ahead of main.');
});

/** A conductor told of the first turn of a spawned session that committed once. */
async function toldOnce(f: Fixture) {
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
  await settle(f, row(f, conductor.id));
  // The next notice counts the commits in git, since the list has not read the worktree.
  forgetWorktreeReads(row(f, session_id).workspace_id!);
  return { conductor, session_id };
}

/** Runs the notice of the spawned session's latest turn and waits for the count it reads. */
async function tellAgain(f: Fixture, sessionId: string, during?: () => void) {
  const ctx = ctxOf(f);
  const before = new Set(ctx.completions);
  afterSpawnedTurn(ctx, sessionId);
  during?.();
  await Promise.allSettled([...ctx.completions].filter((work) => !before.has(work)));
}

it('tells the conductor of a turn once, though a later turn was told after it', async () => {
  const f = await workbenchFixture();
  const { conductor, session_id } = await toldOnce(f);
  // A later turn's notice lands while a second count of the first turn is still read.
  f.store.event('session.spawner_notified', row(f, session_id), f.project.id, {
    turn_id: id(),
    session_id: conductor.id,
  });

  await tellAgain(f, session_id);

  expect(trackerTurns(f, conductor.id)).toHaveLength(1);
});

it('tells the conductor on the next start of a turn that ended while the daemon starts closing', async () => {
  const f = await workbenchFixture();
  const { conductor, session_id } = await toldOnce(f);
  const later = f.store.insert<SessionTurn>('session_turns', {
    ...f.turns(session_id).at(-1)!,
    id: id(),
    revision: 1,
  });

  const ctx = ctxOf(f);
  await tellAgain(f, session_id, () => (ctx.closing = true));

  expect(toldTurns(f, session_id)).not.toContain(later.id);
  expect(trackerTurns(f, conductor.id)).toHaveLength(1);
  await f.restart(() => undefined);
  await eventually(
    () => trackerTurns(f, conductor.id).length === 2,
    () => f.control.tick(),
  );
  expect(toldTurns(f, session_id)).toEqual([f.turns(session_id)[0]!.id, later.id]);
  expect(trackerTurns(f, conductor.id)[1]!.input).toContain('It is 1 commit ahead of main.');
});

it('tells the conductor of a turn that ended with the next turn of its session already queued', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const { session_id } = await spawn(f, conductor.id, script({ wait: 300 }, { say: 'First' }));
  await awaitWorkspaceReady(f.control, row(f, session_id).workspace_id!);
  await eventually(
    () => f.turns(session_id)[0]!.state === 'running',
    () => f.control.tick(),
  );
  notifySession(ctxOf(f), session_id, 'The review found two issues.', 'review-cause');

  await settle(f, row(f, session_id));
  const [first, next] = f.turns(session_id);
  await eventually(
    () => toldTurns(f, session_id).includes(next!.id),
    () => f.control.tick(),
  );

  expect(toldTurns(f, session_id)).toEqual([first!.id, next!.id]);
});

it('tells the conductor once it takes input again', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const { session_id } = await spawn(f, conductor.id, 'Port the parser');
  const merging = mergesPreparing(ctxOf(f));
  merging.add(conductor.id);
  await settle(f, row(f, session_id));
  await tellAgain(f, session_id);

  expect(toldTurns(f, session_id)).toEqual([]);
  merging.delete(conductor.id);
  await eventually(
    () => trackerTurns(f, conductor.id).length === 1,
    () => f.control.tick(),
  );
  expect(toldTurns(f, session_id)).toEqual([f.turns(session_id)[0]!.id]);
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

it('tells the conductor when the worktree of the session it spawned fails to prepare', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  f.call(
    'project.worktree.set',
    {
      project_id: f.project.id,
      copy_paths: [],
      command: { argv: [process.execPath, '-e', 'process.exit(7)'], timeout_ms: 5000 },
    },
    f.store.must<Project>('projects', f.project.id).revision,
  );

  const { session_id } = await spawn(f, conductor.id, 'Port the parser');
  await eventually(
    () => row(f, session_id).state === 'closed',
    () => f.control.tick(),
  );
  await eventually(
    () => trackerTurns(f, conductor.id).length === 1,
    () => f.control.tick(),
  );

  const text = trackerTurns(f, conductor.id)[0]!.input;
  expect(text).toContain(session_id);
  expect(text).toContain('failed its turn');
});

it('tells the conductor after a restart when the daemon stopped while the worktree of the session it spawned was being prepared', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  f.call(
    'project.worktree.set',
    {
      project_id: f.project.id,
      copy_paths: [],
      command: {
        argv: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'],
        timeout_ms: 120000,
      },
    },
    f.store.must<Project>('projects', f.project.id).revision,
  );
  const { session_id } = await spawn(f, conductor.id, 'Port the parser');
  const workspaceId = row(f, session_id).workspace_id!;
  await eventually(
    () => f.store.must<Workspace>('workspaces', workspaceId).provisioning?.phase === 'prepare',
    () => f.control.tick(),
  );

  await f.control.shutdown();
  expect(trackerTurns(f, conductor.id)).toHaveLength(0);
  await f.restart(() => undefined, { abandon: true });
  await eventually(
    () => trackerTurns(f, conductor.id).length === 1,
    () => f.control.tick(),
  );

  const text = trackerTurns(f, conductor.id)[0]!.input;
  expect(text).toContain(session_id);
  expect(text).toContain('failed its turn');
});

it('tells the conductor when a restart fails the turn of the session it spawned', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  vi.spyOn(f.adapter, 'send').mockImplementationOnce(async (handle, turn) => {
    handle.process_identity = { pid: 4000001, start_time_us: 1700000000123456 };
    return { turn_id: turn.turn_id, status: 'delivered' };
  });
  const { session_id } = await spawn(f, conductor.id, 'Port the parser');
  await awaitWorkspaceReady(f.control, row(f, session_id).workspace_id!);
  await eventually(
    () => row(f, session_id).process_identity !== undefined,
    () => f.control.tick(),
  );

  await f.restart(() => undefined);
  expect(f.turns(session_id)).toMatchObject([
    { state: 'failed', delivery_reason: 'Interrupted by a daemon restart' },
  ]);
  await eventually(
    () => trackerTurns(f, conductor.id).length === 1,
    () => f.control.tick(),
  );
  expect(trackerTurns(f, conductor.id)[0]!.input).toContain(
    'failed its turn: Interrupted by a daemon restart',
  );
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

it('refuses a fifth spawned session while four have a turn to take and takes one again once their turns end', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const spawned: string[] = [];
  for (const input of ['Task one', 'Task two', 'Task three', 'Task four'])
    spawned.push((await spawn(f, conductor.id, input)).session_id);

  const error = refusal(() => spawn(f, conductor.id, 'Task five'));
  expect(error.code).toBe('resource_busy');
  expect(error.message).toContain('4');
  for (const id of spawned) expect(error.message).toContain(id);

  // Idle spawned sessions with no commits and no outcome no longer hold a place.
  for (const id of spawned) await settle(f, row(f, id));
  const { session_id } = await spawn(f, conductor.id, 'Task five');
  expect(row(f, session_id).spawned_by).toEqual({ session_id: conductor.id });
});

it('refuses the user, a planner and a writer, and tells no one about a session the user opened', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const caller = await f.create('Plan the export');
  await settle(f, caller);
  const input = { runtime: f.adapter.name, input: 'Port the parser' };

  expect(refusal(() => f.call('conductor.spawn', input)).code).toBe('permission_denied');
  expect(refusal(() => spawn(f, caller.id, 'Port the parser', 'planner')).code).toBe(
    'permission_denied',
  );
  expect(refusal(() => spawn(f, caller.id, 'Port the parser', 'writer')).code).toBe(
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
