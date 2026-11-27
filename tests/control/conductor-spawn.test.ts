import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  id,
  type AgentEvent,
  type Approval,
  type Principal,
  type Project,
  type Review,
  type Session,
  type SessionTurn,
  type WorkflowPolicy,
  type Workspace,
} from '@pantheon/domain';
import { FixtureAdapter } from '@pantheon/adapters';
import { agentEvent } from '../../packages/control/dist/agent.js';
import { NOTICE_HOLD_MS, afterSpawnedTurn } from '../../packages/control/dist/conductor.js';
import { usesPantheonTools, type ControlContext } from '../../packages/control/dist/context.js';
import { settleReview } from '../../packages/control/dist/review.js';
import { mergesPreparing, releaseIdleConversations } from '../../packages/control/dist/session.js';
import { notifySession } from '../../packages/control/dist/session-wake.js';
import { workbenchSessionSpec } from '../../packages/control/dist/workbench-session.js';
import {
  awaitWorkspaceReady,
  eventually,
  insideSandbox,
  passTime,
  settle,
  user,
} from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const ctxOf = (f: Fixture) => (f.control as unknown as { ctx: ControlContext }).ctx;
const row = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const script = (...steps: object[]) => `fixture-script\n${JSON.stringify(steps)}`;
const REVIEW_LINE =
  'Review it with request_review, land it with report_ready, or read it in its worktree.';
const COMMITS_LINE = 'Find its branch with read_state.';

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
  f.turns(sessionId).filter((turn) => turn.origin === 'notice');

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

it('marks only the conductor as the main agent in the session list', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const { session_id } = await spawn(f, conductor.id, 'Port the parser');

  const listed = (sessionId: string) =>
    f.control.sessionList(user, f.project.id).find((s) => s.id === sessionId)!;
  expect(listed(conductor.id).conductor).toBe(true);
  expect(listed(session_id)).not.toHaveProperty('conductor');
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
  passTime(f.store, NOTICE_HOLD_MS);
  await eventually(
    () => trackerTurns(f, conductor.id).length === 1,
    () => f.control.tick(),
  );

  const text = trackerTurns(f, conductor.id)[0]!.input;
  expect(text).toMatch(/^\[completed\] \[Pantheon\] /);
  expect(text).toContain(session_id);
  expect(text).toContain(f.adapter.name);
  expect(text).toContain(COMMITS_LINE);
  expect(text).not.toContain('ahead of');
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

  f.call('session.send', { session_id, input: 'Look again' }, row(f, session_id).revision);
  await settle(f, row(f, session_id));
  passTime(f.store, NOTICE_HOLD_MS);
  await eventually(
    () => trackerTurns(f, conductor.id).length === 2,
    () => f.control.tick(),
  );
  expect(trackerTurns(f, conductor.id)[1]!.input).toContain(COMMITS_LINE);
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
  passTime(f.store, NOTICE_HOLD_MS);
  await eventually(
    () => trackerTurns(f, conductor.id).length === 1,
    () => f.control.tick(),
  );
  await settle(f, row(f, conductor.id));
  return { conductor, session_id };
}

/** Runs the notices of the spawned session's untold turns and waits for the work they start. */
async function tellAgain(f: Fixture, sessionId: string) {
  const ctx = ctxOf(f);
  const before = new Set(ctx.completions);
  afterSpawnedTurn(ctx, sessionId);
  await Promise.allSettled([...ctx.completions].filter((work) => !before.has(work)));
}

it('tells the conductor of a turn once, though a later turn was told after it', async () => {
  const f = await workbenchFixture();
  const { conductor, session_id } = await toldOnce(f);
  // A later turn's notice has gone out after the first turn's.
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

  ctxOf(f).closing = true;
  await tellAgain(f, session_id);

  expect(toldTurns(f, session_id)).not.toContain(later.id);
  expect(trackerTurns(f, conductor.id)).toHaveLength(1);
  await f.restart(() => undefined);
  await eventually(
    () => trackerTurns(f, conductor.id).length === 2,
    () => f.control.tick(),
  );
  expect(toldTurns(f, session_id)).toEqual([f.turns(session_id)[0]!.id, later.id]);
  expect(trackerTurns(f, conductor.id)[1]!.input).toContain(COMMITS_LINE);
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
  passTime(f.store, NOTICE_HOLD_MS);
  await eventually(
    () => toldTurns(f, session_id).includes(next!.id),
    () => f.control.tick(),
  );

  expect(toldTurns(f, session_id)).toEqual([first!.id, next!.id]);
});

it('tells the conductor of a steer that ran as a turn of its own', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const { session_id } = await spawn(f, conductor.id, script({ wait: 300 }, { say: 'First' }));
  await awaitWorkspaceReady(f.control, row(f, session_id).workspace_id!);
  await eventually(
    () => f.turns(session_id)[0]!.state === 'running',
    () => f.control.tick(),
  );
  f.call(
    'session.steer',
    { session_id, input: 'Cover the tests too' },
    row(f, session_id).revision,
  );

  await settle(f, row(f, session_id));
  const [first, steer] = f.turns(session_id);
  expect(steer).toMatchObject({ kind: 'steer', state: 'completed' });
  passTime(f.store, NOTICE_HOLD_MS);
  await tellAgain(f, session_id);

  expect(toldTurns(f, session_id)).toEqual([first!.id, steer!.id]);
});

it('tells the conductor of the turns that ended before a stop as discarded, and not of the turn the stop ended', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const { session_id } = await spawn(f, conductor.id, 'Port the parser');
  const merging = mergesPreparing(ctxOf(f));
  merging.add(conductor.id);
  await settle(f, row(f, session_id));
  f.call(
    'session.send',
    { session_id, input: script({ wait: 5000 }, { say: 'Done' }) },
    row(f, session_id).revision,
  );
  await eventually(
    () => f.turns(session_id)[1]?.state === 'running',
    () => f.control.tick(),
  );

  f.call('session.discard', { session_id }, row(f, session_id).revision);
  await eventually(
    () => row(f, session_id).outcome === 'discarded',
    () => f.control.tick(),
  );
  merging.delete(conductor.id);
  passTime(f.store, NOTICE_HOLD_MS);
  await tellAgain(f, session_id);

  const [first, stopped] = f.turns(session_id);
  expect(stopped!.state).toBe('failed');
  expect(toldTurns(f, session_id)).toEqual([first!.id]);
  const text = trackerTurns(f, conductor.id)[0]!.input;
  expect(text).toContain('It was discarded.');
  expect(text).not.toContain(REVIEW_LINE);
  expect(text).not.toContain(COMMITS_LINE);
});

it('tells the conductor to read the commits with read_state in every notice and never counts them', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const { session_id } = await spawn(
    f,
    conductor.id,
    script({ write: { path: 'docs.txt', text: 'docs\n' } }, { commit: 'Write the docs' }),
  );
  const merging = mergesPreparing(ctxOf(f));
  merging.add(conductor.id);
  await settle(f, row(f, session_id));
  f.call('session.send', { session_id, input: 'Look again' }, row(f, session_id).revision);
  await settle(f, row(f, session_id));

  merging.delete(conductor.id);
  passTime(f.store, NOTICE_HOLD_MS);
  await eventually(
    () => toldTurns(f, session_id).length === 2,
    () => f.control.tick(),
  );

  // Notices that reach the conductor together share one of its turns.
  const [earlier, latest] = trackerTurns(f, conductor.id).flatMap((turn) =>
    turn.input.split('\n\n'),
  );
  expect(earlier).toContain(session_id);
  for (const notice of [earlier, latest]) {
    expect(notice).toContain(COMMITS_LINE);
    expect(notice).not.toContain('ahead of');
  }
});

it('tells the conductor of a turn the user failed by closing its reconciling session', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const { session_id } = await spawn(f, conductor.id, 'Port the parser');
  await settle(f, row(f, session_id));
  passTime(f.store, NOTICE_HOLD_MS);
  await eventually(
    () => toldTurns(f, session_id).length === 1,
    () => f.control.tick(),
  );
  await settle(f, row(f, conductor.id));
  // A conductor whose idle process is still closing takes no notice.
  releaseIdleConversations(ctxOf(f), f.project.id);
  await eventually(
    () => ctxOf(f).handles.size === 0,
    () => f.control.tick(),
  );
  const interrupted = f.store.insert<SessionTurn>('session_turns', {
    ...f.turns(session_id)[0]!,
    id: id(),
    revision: 1,
    state: 'running',
  });
  const spawned = row(f, session_id);
  f.store.update<Session>(
    'sessions',
    {
      ...spawned,
      state: 'reconciling',
      process_identity: { pid: 4000001, start_time_us: 1700000000123456 },
    },
    spawned.revision,
  );

  const before = new Set(ctxOf(f).completions);
  await f.call('session.resolve', { session_id, choice: 'close' }, row(f, session_id).revision);
  expect(f.store.must<SessionTurn>('session_turns', interrupted.id).state).toBe('failed');
  await Promise.resolve();
  await Promise.allSettled([...ctxOf(f).completions].filter((work) => !before.has(work)));
  passTime(f.store, NOTICE_HOLD_MS);
  await eventually(
    () => toldTurns(f, session_id).length === 2,
    () => f.control.tick(),
  );

  expect(toldTurns(f, session_id)).toEqual([f.turns(session_id)[0]!.id, interrupted.id]);
  const closed = trackerTurns(f, conductor.id).at(-1)!.input;
  expect(closed).toContain('It was closed.');
  expect(closed).not.toContain(COMMITS_LINE);
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
  passTime(f.store, NOTICE_HOLD_MS);
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
    () => f.turns(session_id)[0]!.state === 'failed',
    () => f.control.tick(),
  );
  passTime(f.store, NOTICE_HOLD_MS);
  await eventually(
    () => trackerTurns(f, conductor.id).length === 1,
    () => f.control.tick(),
  );

  const text = trackerTurns(f, conductor.id)[0]!.input;
  expect(text).toMatch(/^\[failed\] \[Pantheon\] /);
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
  passTime(f.store, NOTICE_HOLD_MS);
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
  passTime(f.store, NOTICE_HOLD_MS);
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
  passTime(f.store, NOTICE_HOLD_MS);
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

function seedPolicy(f: Fixture, settings: Record<string, unknown>) {
  f.store.insert('workflow_policies', {
    id: f.project.id,
    revision: 1,
    project_id: f.project.id,
    policy_version: 1,
    overridden: Object.keys(settings),
    ...settings,
  });
}

it.each([
  { limit: undefined, otherCount: 0 },
  { limit: 2, otherCount: 0 },
  { limit: 3, otherCount: 2 },
  { limit: 1, otherCount: 1 },
])(
  'refuses a spawn with max_spawned $limit and $otherCount sessions from another main agent',
  async ({ limit, otherCount }) => {
    const f = await workbenchFixture();
    const conductor = await openConductor(f);
    const other = otherCount ? await openConductor(f) : conductor;
    vi.spyOn(f.store, 'now').mockReturnValue(f.store.now());
    if (limit) seedPolicy(f, { max_spawned: limit });
    const spawned: string[] = [];
    for (const input of ['Task one', 'Task two', 'Task three', 'Task four'].slice(0, limit ?? 4))
      spawned.push(
        (await spawn(f, spawned.length < otherCount ? other.id : conductor.id, input)).session_id,
      );

    const error = refusal(() => spawn(f, conductor.id, 'Task five'));
    expect(error.code).toBe('resource_busy');
    expect(error.message).toContain(`At most ${limit ?? 4} spawned session`);
    const own = spawned.slice(otherCount);
    for (const id of own) expect(error.message).toContain(id);
    if (own.length) expect(error.message).toContain('You get a message as each');
    if (otherCount) {
      expect(error.message).toMatch(
        new RegExp(`${otherCount} .*other main agents.*no message.*try again later`, 'i'),
      );
      for (const id of spawned.slice(0, otherCount)) expect(error.message).not.toContain(id);
      if (!own.length) expect(error.message).not.toContain('You get a message');
    }

    // Idle spawned sessions with no commits and no outcome no longer hold a place.
    for (const id of spawned) await settle(f, row(f, id));
    const { session_id } = await spawn(f, conductor.id, 'Task five');
    expect(row(f, session_id).spawned_by).toEqual({ session_id: conductor.id });
  },
);

it('shares the codex turn limit across project conductors and leaves claude available', async () => {
  const f = await workbenchFixture();
  const first = await openConductor(f);
  const other = await openConductor(f);
  for (const name of ['claude', 'codex']) {
    const adapter = new FixtureAdapter();
    adapter.name = name;
    f.control.adapters.set(name, adapter);
  }
  seedPolicy(f, { runtime_parallel: { codex: 1 } });
  const start = (caller: Session, runtime: string) =>
    f.call<Promise<{ session_id: string }>>(
      'conductor.spawn',
      { runtime, input: 'Review the form' },
      null,
      principalOf(f, caller.id, 'conductor'),
    );
  await start(first, 'codex');
  await expect(async () => start(other, 'codex')).rejects.toThrow(/1.*codex/);
  expect(row(f, (await start(other, 'claude')).session_id).runtime).toBe('claude');
});

const routeTime = Date.UTC(2026, 10, 27);
const kindChoices = [
  { runtime: 'codex', model: 'code-model', effort: 'high' },
  { runtime: 'claude', model: 'design-model', effort: 'medium' },
  { runtime: 'opencode', model: 'local-model', effort: 'low' },
];
const claudeChoices = [
  { runtime: 'claude', model: 'claude-opus-4-6', effort: 'high' },
  { runtime: 'claude', model: 'sonnet', effort: 'medium' },
];
const fullWindow = (window: string, resets_at?: number) => ({
  quota: { seen_at: routeTime, windows: [{ window, used_percent: 100, resets_at }] },
});

it.each([
  { scenario: 'primary', index: 0 },
  { scenario: 'first fallback', codex: { installed: false }, index: 1 },
  {
    scenario: 'second fallback after quota reset',
    codex: { installed: false },
    claude: { auth: { state: 'logged_out' as const } },
    opencode: fullWindow('day', routeTime - 1),
    index: 2,
  },
  {
    scenario: 'none available',
    codex: { installed: false },
    claude: { auth: { state: 'logged_out' as const } },
    opencode: fullWindow('day', routeTime + 1),
    error: /codex.*not installed.*claude.*signed out.*opencode.*quota/i,
  },
  { scenario: 'unknown kind', kind: 'unlisted', error: /unlisted.*frontend.*docs/ },
  { scenario: 'unsupported primary version', codex: { version_ok: false }, index: 1 },
  { scenario: 'full primary runtime', busy: true, index: 1 },
  {
    scenario: 'full runtime and unsupported fallback version',
    busy: true,
    claude: { version_ok: false },
    opencode: { installed: false },
    error: /codex: at its parallel limit.*claude: unsupported version.*opencode: not installed/,
  },
  {
    scenario: 'full project and full primary runtime',
    busy: true,
    maxSpawned: 1,
    error: /At most 1 spawned session/,
  },
  {
    scenario: 'same-runtime fallback outside the Opus quota',
    choices: claudeChoices,
    claude: fullWindow('seven_day_opus'),
    index: 1,
  },
  {
    scenario: 'unknown default during an Opus quota limit',
    choices: [{ runtime: 'claude', model: undefined, effort: 'high' }, ...claudeChoices],
    claude: fullWindow('seven_day_opus'),
    index: 0,
  },
  {
    scenario: 'default Sonnet model during a Sonnet quota limit',
    choices: [{ runtime: 'claude', model: undefined, effort: 'high' }, ...claudeChoices],
    claude: fullWindow('seven_day_sonnet'),
    defaultModel: 'claude-sonnet-4-6',
    index: 1,
  },
  {
    scenario: 'the default alias resolving to Sonnet during a Sonnet quota limit',
    choices: [{ runtime: 'claude', model: 'default', effort: 'high' }, ...claudeChoices],
    claude: fullWindow('seven_day_sonnet'),
    defaultModel: 'claude-sonnet-4-6',
    index: 1,
  },
  {
    scenario: "the project's Opus model on its default runtime during an Opus quota limit",
    choices: [{ runtime: 'claude', model: undefined, effort: 'high' }, ...claudeChoices],
    claude: fullWindow('seven_day_opus'),
    defaultModel: 'claude-sonnet-4-6',
    projectModel: 'claude-opus-4-6',
    index: 2,
  },
  {
    scenario: 'unknown kind in a full project',
    kind: 'unlisted',
    busy: true,
    maxSpawned: 1,
    error: /unlisted.*frontend.*docs/,
  },
  {
    scenario: 'account-wide overage including both Claude models',
    choices: claudeChoices,
    claude: fullWindow('seven_day_overage_included'),
    error: /claude: over quota.*claude: over quota/,
  },
])(
  'routes a task by kind with $scenario',
  async ({
    choices = kindChoices,
    codex,
    claude,
    opencode,
    kind = 'frontend',
    index = 0,
    error,
    busy,
    maxSpawned,
    defaultModel,
    projectModel,
  }) => {
    const f = await workbenchFixture();
    const conductor = await openConductor(f);
    const other = busy ? await openConductor(f) : undefined;
    const [primary, ...fallbacks] = choices;
    seedPolicy(f, {
      kind_routes: [
        { kind: 'frontend', ...primary, fallbacks },
        { kind: 'docs', runtime: 'claude' },
      ],
      ...(busy && { runtime_parallel: { codex: 1 } }),
      ...(maxSpawned && { max_spawned: maxSpawned }),
    });
    if (projectModel) {
      const project = f.store.must<Project>('projects', f.project.id);
      f.store.update(
        'projects',
        { ...project, session_defaults: { runtime: 'claude', model: projectModel } },
        project.revision,
      );
    }
    vi.spyOn(f.store, 'now').mockReturnValue(routeTime);
    for (const [runtime, status] of Object.entries({ codex, claude, opencode })) {
      const adapter = new FixtureAdapter();
      adapter.name = runtime;
      f.control.adapters.set(runtime, adapter);
      if (status) ctxOf(f).runtimeStatus.set(runtime, status);
      if (runtime === 'claude' && defaultModel) {
        const [model] = await adapter.models();
        vi.spyOn(adapter, 'models').mockResolvedValue([
          { ...model!, id: 'default', resolved: defaultModel },
        ]);
        await f.control.runtimeModels(user, f.project.id, runtime);
      }
    }
    if (other)
      await f.call(
        'conductor.spawn',
        { runtime: 'codex', input: 'Review the parser' },
        null,
        principalOf(f, other.id, 'conductor'),
      );
    const sessions = f.store.list<Session>('sessions').length;
    const principal = principalOf(f, conductor.id, 'conductor');
    const run = async () =>
      f.call<Promise<{ session_id: string }>>(
        'conductor.spawn',
        { kind, input: 'Review the form' },
        null,
        principal,
      );
    if (error) {
      await expect(run()).rejects.toThrow(error);
      expect(f.store.list<Session>('sessions')).toHaveLength(sessions);
      return;
    }
    const { runtime, model, effort } = choices[index]!;
    const { session_id } = await run();
    expect(row(f, session_id)).toMatchObject({ runtime, requested_effort: effort });
    expect(row(f, session_id).requested_model).toBe(model);
    const route = { kind, runtime, ...(model && { model }), effort, route_index: index };
    expect(
      f.store.kindEvents(f.project.id, ['session.main_agent_decided']).at(-1)?.payload,
    ).toMatchObject(route);
    const state = await f.call<Promise<{ spawned: unknown[] }>>(
      'conductor.state',
      {},
      null,
      principal,
    );
    expect(state.spawned).toMatchObject([{ session_id, ...route }]);
  },
);

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
    f.store.list<SessionTurn>('session_turns').filter((turn) => turn.origin === 'notice'),
  ).toEqual([]);
});

/** Two sessions the conductor spawned whose first turns end ten seconds apart. */
async function endedTenSecondsApart(f: Fixture, conductorId: string) {
  const first = await spawn(f, conductorId, 'Port the parser');
  await settle(f, row(f, first.session_id));
  passTime(f.store, 10_000);
  const second = await spawn(f, conductorId, 'Port the lexer');
  await settle(f, row(f, second.session_id));
  return [first.session_id, second.session_id];
}

/** Ticks a few times, as the scheduler would while the hold lasts. */
async function ticks(f: Fixture) {
  for (let i = 0; i < 3; i++) await f.control.tick();
}

/** Waits for the conductor's first notice turn to end and returns its items. */
async function toldItems(f: Fixture, conductorId: string) {
  await eventually(
    () => trackerTurns(f, conductorId).length > 0,
    () => f.control.tick(),
  );
  await settle(f, row(f, conductorId));
  expect(trackerTurns(f, conductorId)).toMatchObject([{ state: 'completed' }]);
  return trackerTurns(f, conductorId)[0]!.input.split('\n\n');
}

function expectCompletedItems(items: string[], sessionIds: string[]) {
  expect(items).toHaveLength(sessionIds.length);
  sessionIds.forEach((sessionId, index) => {
    expect(items[index]).toMatch(/^\[completed\] \[Pantheon\] /);
    expect(items[index]).toContain(sessionId);
  });
}

it('wakes an idle main agent once, after the hold, with the news of two sessions whose turns end ten seconds apart', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const spawned = await endedTenSecondsApart(f, conductor.id);
  await ticks(f);
  expect(trackerTurns(f, conductor.id)).toEqual([]);

  passTime(f.store, NOTICE_HOLD_MS - 10_000);

  expectCompletedItems(await toldItems(f, conductor.id), spawned);
});

it('keeps the held news through a clean restart and sends it in one turn after the hold', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const spawned = await endedTenSecondsApart(f, conductor.id);

  await f.control.shutdown();
  await f.restart(() => undefined, { abandon: true });
  await ticks(f);
  expect(trackerTurns(f, conductor.id)).toEqual([]);
  passTime(f.store, NOTICE_HOLD_MS);

  expectCompletedItems(await toldItems(f, conductor.id), spawned);
  for (const sessionId of [conductor.id, ...spawned])
    expect(f.turns(sessionId).map((turn) => turn.state)).not.toContain('failed');
});

it('runs a message the user sends within the hold first and the held news after it in one turn', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const spawned = await endedTenSecondsApart(f, conductor.id);

  const sent = f.call<SessionTurn>(
    'session.send',
    { session_id: conductor.id, input: 'Plan the docs next' },
    row(f, conductor.id).revision,
  );
  passTime(f.store, NOTICE_HOLD_MS);

  expectCompletedItems(await toldItems(f, conductor.id), spawned);
  const notice = trackerTurns(f, conductor.id)[0]!;
  expect(f.store.must<SessionTurn>('session_turns', sent.id)).toMatchObject({
    state: 'completed',
    input: 'Plan the docs next',
  });
  const started = f.store
    .events(0, f.project.id, 10000, ['turn.running'])
    .map((event) => event.aggregate_id)
    .filter((turnId) => turnId === sent.id || turnId === notice.id);
  expect(started).toEqual([sent.id, notice.id]);
});

it('sends the held news only once the project has budget again', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const spawned = await endedTenSecondsApart(f, conductor.id);
  f.call('workflow.policy.set', {
    project_id: f.project.id,
    project_budget: { input_tokens: 100 },
  });
  passTime(f.store, 1000);
  const spent = f.store.insert<SessionTurn>('session_turns', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    session_id: conductor.id,
    input: 'A message',
    kind: 'send',
    delivery: 'delivered',
    state: 'completed',
    usage: { input_tokens: 150, output_tokens: 0 },
  });
  f.store.event('turn.completed', spent, f.project.id, {});

  passTime(f.store, NOTICE_HOLD_MS);
  await ticks(f);
  expect(trackerTurns(f, conductor.id)).toEqual([]);
  for (const sessionId of spawned) expect(toldTurns(f, sessionId)).toEqual([]);
  f.call(
    'workflow.policy.set',
    { project_id: f.project.id, project_budget: { input_tokens: 1_000_000 } },
    f.store.must<WorkflowPolicy>('workflow_policies', f.project.id).revision,
  );

  expectCompletedItems(await toldItems(f, conductor.id), spawned);
});

it('tells the main agent once that a session it spawned waits for the user, however many requests that wait holds', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const { session_id } = await spawn(
    f,
    conductor.id,
    script({ ask: { tool: 'Bash', input: { command: 'pnpm test' } } }),
  );
  const pending = () =>
    f.store
      .list<Approval>('approvals')
      .filter((approval) => approval.session_id === session_id && approval.state === 'pending');
  await eventually(
    () => pending().length === 1,
    () => f.control.tick(),
  );
  passTime(f.store, NOTICE_HOLD_MS);
  await f.control.tick();
  await settle(f, row(f, conductor.id));
  // A second request of the same wait.
  f.store.insert<Approval>('approvals', {
    ...pending()[0]!,
    id: id(),
    revision: 1,
    request_id: 'second-request',
    created_at: f.store.now(),
  });
  await tellAgain(f, session_id);
  passTime(f.store, NOTICE_HOLD_MS);
  await ticks(f);
  await settle(f, row(f, conductor.id));

  const waits = trackerTurns(f, conductor.id)
    .flatMap((turn) => turn.input.split('\n\n'))
    .filter((item) => item.startsWith('[input_required] [Pantheon] '));
  expect(waits).toHaveLength(1);
  expect(waits[0]).toContain(session_id);
  expect(waits[0]).toContain('waits for the user to allow Bash');
});

const QUESTIONS = [
  {
    question: 'Which package manager?',
    header: 'Tooling',
    options: [{ label: 'pnpm', description: 'Workspace default' }],
    multiSelect: false,
  },
];

/** A session the conductor spawned, with a running turn whose requests ask raises. */
async function askingSession(f: Fixture, conductorId: string) {
  const { session_id } = await spawn(f, conductorId, script({ hang: true }));
  await awaitWorkspaceReady(f.control, row(f, session_id).workspace_id!);
  await eventually(
    () => f.turns(session_id).at(-1)?.state === 'running',
    () => f.control.tick(),
  );
  const turn = f.turns(session_id).at(-1)!;
  let sequence = 100;
  const ask = (tool: string, detail: unknown) => {
    sequence++;
    agentEvent(ctxOf(f), session_id, {
      key: `ask-${sequence}`,
      provider_sequence: sequence,
      turn_id: turn.id,
      kind: 'permission.requested',
      request_id: `request-${sequence}`,
      tool,
      detail,
    } as AgentEvent);
  };
  return { session_id, ask };
}

/** The items of the conductor's notice turns that say a spawned session waits for the user. */
const toldWaits = (f: Fixture, conductorId: string) =>
  trackerTurns(f, conductorId)
    .flatMap((turn) => turn.input.split('\n\n'))
    .filter((item) => item.startsWith('[input_required] [Pantheon] '));

const question = { input: { questions: QUESTIONS }, questions: QUESTIONS };

it.each([
  {
    asked: 'a question',
    tool: 'AskUserQuestion',
    detail: question,
    requests: 1,
    told: 'waits for the user to answer a question. Answer it with answer_request',
  },
  {
    asked: 'a request titled AskUserQuestion whose questions were not read',
    tool: 'AskUserQuestion',
    detail: { input: { questions: QUESTIONS } },
    requests: 1,
    told: 'waits for the user to allow AskUserQuestion. Only the user answers it',
  },
  {
    asked: 'a shell command',
    tool: 'Bash',
    detail: { input: { command: 'pnpm test' } },
    requests: 1,
    told: 'waits for the user to allow Bash. Only the user answers it',
  },
  {
    asked: 'two questions at once',
    tool: 'AskUserQuestion',
    detail: question,
    requests: 2,
    told: 'waits for the user on 2 requests. Answer those you may with answer_request',
  },
])(
  'tells the main agent whether it may answer $asked',
  async ({ tool, detail, requests, told }) => {
    const f = await workbenchFixture();
    const conductor = await openConductor(f);
    const own = await askingSession(f, conductor.id);
    for (let each = 0; each < requests; each++) own.ask(tool, detail);
    passTime(f.store, NOTICE_HOLD_MS);
    await ticks(f);
    await settle(f, row(f, conductor.id));

    expect(toldWaits(f, conductor.id)).toEqual([expect.stringContaining(told)]);
  },
);

it('tells the main agent of a question that joins a wait it heard of for a permission request', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const own = await askingSession(f, conductor.id);
  own.ask('Bash', { input: { command: 'pnpm test' } });
  passTime(f.store, NOTICE_HOLD_MS);
  await ticks(f);
  await settle(f, row(f, conductor.id));
  own.ask('AskUserQuestion', question);
  await tellAgain(f, own.session_id);
  passTime(f.store, NOTICE_HOLD_MS);
  await ticks(f);
  await settle(f, row(f, conductor.id));

  expect(toldWaits(f, conductor.id)).toEqual([
    expect.stringContaining('waits for the user to allow Bash. Only the user answers it'),
    expect.stringContaining(
      'waits for the user to answer a question. Answer it with answer_request',
    ),
  ]);
});

it('tells a running main agent in one line how many requests a session it spawned asked of the user one after another', async () => {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  const { session_id } = await spawn(
    f,
    conductor.id,
    script({ ask: { tool: 'Bash', input: { command: 'pnpm test' } } }),
  );
  const pending = () =>
    f.store
      .list<Approval>('approvals')
      .filter((approval) => approval.session_id === session_id && approval.state === 'pending');
  await eventually(
    () => pending().length === 1,
    () => f.control.tick(),
  );
  f.call(
    'session.send',
    { session_id: conductor.id, input: script({ wait: 5000 }, { say: 'Done' }) },
    row(f, conductor.id).revision,
  );
  await eventually(
    () => f.turns(conductor.id).some((turn) => turn.state === 'running'),
    () => f.control.tick(),
  );
  await tellAgain(f, session_id);
  for (let request = 0; request < 3; request++) {
    const [answered] = pending();
    f.store.update<Approval>('approvals', { ...answered!, state: 'approved' }, answered!.revision);
    f.store.insert<Approval>('approvals', {
      ...answered!,
      id: id(),
      revision: 1,
      request_id: `request-${request}`,
      state: 'pending',
      created_at: f.store.now(),
    });
    await tellAgain(f, session_id);
  }

  const waits = trackerTurns(f, conductor.id)
    .flatMap((turn) => turn.input.split('\n\n'))
    .filter((item) => item.startsWith('[input_required] [Pantheon] '));
  expect(waits).toHaveLength(1);
  expect(waits[0]).toContain(session_id);
  expect(waits[0]).toContain('waits for the user on 4 requests');
});

it.each([
  {
    who: 'a main agent at once, its text as written',
    purpose: 'conductor' as const,
    mark: '[review] ',
  },
  { who: 'a plain session unchanged', purpose: undefined, mark: '' },
])('returns the result of a review to $who', async ({ purpose, mark }) => {
  const f = await workbenchFixture();
  const session = await f.call<Promise<Session>>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Ship the export',
    ...(purpose ? { purpose } : {}),
  });
  await settle(f, session);
  const reviewId = id();

  f.store.transaction(() => {
    f.store.insert<Review>('reviews', {
      id: reviewId,
      revision: 1,
      project_id: f.project.id,
      session_id: session.id,
      notify_session_id: session.id,
      round: 1,
      runtimes: ['codex'],
      session_ids: [],
      state: 'running',
      findings: [
        {
          id: id(),
          review_id: reviewId,
          runtime: 'codex',
          round: 1,
          location: 'answer.txt:1',
          quote: 'base',
          evidence: 'The answer is a placeholder.\n\nNothing reads it.',
          impact: 'Readers get no answer',
          status: 'open',
          blocking: true,
        },
      ],
    });
    settleReview(ctxOf(f), reviewId);
  });

  const told = trackerTurns(f, session.id)[0]!;
  expect(told.input.startsWith(`${mark}[Pantheon] Review ${reviewId}: `)).toBe(true);
  expect(told.input).toContain('The answer is a placeholder.\n\nNothing reads it.');
  await settle(f, row(f, session.id));
  expect(f.store.must<SessionTurn>('session_turns', told.id).state).toBe('completed');
});

it.skipIf(insideSandbox).each([
  { state: 'landed', exit: 0, outcome: 'landed on main' },
  { state: 'blocked', exit: 3, outcome: 'did not land' },
])(
  'tells the main agent at once, state first, that a session it spawned $outcome',
  async ({ state, exit, outcome }) => {
    const f = await workbenchFixture();
    git(f.source, 'config', 'user.name', 'Source User');
    git(f.source, 'config', 'user.email', 'source@example.invalid');
    await f.call<Project>(
      'project.gate.set',
      {
        project_id: f.project.id,
        root: f.source,
        commands: [{ name: 'Gate', argv: [process.execPath, '-e', `process.exit(${exit})`] }],
      },
      f.store.must<Project>('projects', f.project.id).revision,
    );
    const conductor = await openConductor(f);
    const { session_id } = await spawn(f, conductor.id, 'Port the parser');
    await settle(f, row(f, session_id));
    passTime(f.store, NOTICE_HOLD_MS);
    await eventually(
      () => toldTurns(f, session_id).length === 1,
      () => f.control.tick(),
    );
    await settle(f, row(f, conductor.id));
    const folder = f.store.must<Workspace>('workspaces', row(f, session_id).workspace_id!).path;
    writeFileSync(path.join(folder, 'answer.txt'), 'spawned\n');
    git(folder, 'commit', '--quiet', '-am', 'Change the answer');

    await f.call('session.merge', { session_id }, row(f, session_id).revision);
    const merged = () =>
      trackerTurns(f, conductor.id).find((turn) =>
        turn.input.includes(`(${session_id}) ${outcome}`),
      );
    await eventually(
      () => merged() !== undefined,
      () => f.control.tick(),
      10000,
    );

    expect(merged()!.input).toMatch(new RegExp(`^\\[${state}\\] \\[Pantheon\\] Session `));
  },
);
