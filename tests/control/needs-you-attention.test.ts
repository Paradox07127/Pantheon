import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import {
  hash,
  type Approval,
  type BoardPlan,
  type Principal,
  type Project,
  type ProjectBaseline,
  type Session,
  type SessionTurn,
  type Workspace,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/src/context.js';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const patch = (f: Fixture, sessionId: string, fields: Partial<Session>) => {
  const session = current(f, sessionId);
  return f.store.update<Session>('sessions', { ...session, ...fields }, session.revision);
};

async function idleSession(f: Fixture) {
  const session = await f.create();
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.turns(session.id).every((turn) => turn.state === 'completed') &&
      current(f, session.id).state === 'open',
    () => f.control.tick(),
  );
  return current(f, session.id);
}

async function setGate(f: Fixture) {
  await f.call<Project>(
    'project.gate.set',
    {
      project_id: f.project.id,
      root: f.source,
      commands: [{ name: 'Check', argv: [process.execPath, '-e', 'process.exit(1)'] }],
    },
    f.store.must<Project>('projects', f.project.id).revision,
  );
}

function gateChecked(f: Fixture, sessionId: string, exitCode: number, acceptance: string[] = []) {
  const session = current(f, sessionId);
  return f.store.event('session.gate_checked', session, session.project_id, {
    workspace_id: session.workspace_id,
    commit: 'a'.repeat(40),
    check_spec_hash: hash([
      ...acceptance.map((command) => ({ name: command, argv: ['/bin/sh', '-c', command] })),
      ...(Object.values(f.store.must<Project>('projects', f.project.id).gates ?? {})[0] ?? []),
    ]),
    results: [
      {
        name: 'Check',
        argv: ['node'],
        exit_code: exitCode,
        duration_ms: 5,
        timed_out: false,
        output: '',
      },
    ],
  });
}

function blockMerge(f: Fixture, sessionId: string) {
  const session = patch(f, sessionId, { merge: { state: 'blocked', reason: 'rebase_conflict' } });
  return f.store.event('session.merge_blocked', session, session.project_id, session.merge);
}

it('does not turn a user-cancelled merge into an attention request', async () => {
  const f = await workbenchFixture();
  const session = await idleSession(f);
  const cancelled = patch(f, session.id, { merge: { state: 'blocked', reason: 'cancelled' } });
  f.store.event('session.merge_cancelled', cancelled, session.project_id, cancelled.merge);
  expect(f.control.needsYou(user, f.project.id).items).not.toContainEqual(
    expect.objectContaining({ source: expect.objectContaining({ id: session.id }) }),
  );
});

it.each(['closed', 'failed', 'cancelled'] as const)(
  'lists a failed worktree session after %s with the failure time',
  async (failure) => {
    const f = await workbenchFixture();
    const session = await idleSession(f);
    if (failure !== 'closed') {
      const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
      f.store.update<Workspace>(
        'workspaces',
        { ...workspace, provisioning: { ...workspace.provisioning!, state: failure } },
        workspace.revision,
      );
    }
    const failed = patch(f, session.id, { state: 'closed' });
    const event = f.store.event('session.closed', failed, failed.project_id, {
      reason: failure === 'closed' ? 'reconciliation' : 'workspace_failed',
    });
    expect(f.control.needsYou(user, f.project.id).items).toEqual([
      {
        source: { table: 'sessions', id: session.id, revision: failed.revision },
        kind: 'session.failed',
        project_id: f.project.id,
        status: 'closed',
        created_at: event.created_at,
        reason: 'session_failed',
        decision: 'other',
        actions: [],
      },
    ]);
  },
);

it('lists the latest failed gate with its event time and clears it after a passing gate', async () => {
  const f = await workbenchFixture();
  const session = await idleSession(f);
  await setGate(f);
  gateChecked(f, session.id, 0);
  const event = gateChecked(f, session.id, 1);
  expect(f.control.needsYou(user, f.project.id).items).toEqual([
    {
      source: { table: 'sessions', id: session.id, revision: session.revision },
      kind: 'session.gate_failed',
      project_id: f.project.id,
      status: 'open',
      created_at: event.created_at,
      reason: 'gate_failed',
      decision: 'other',
      actions: [],
    },
  ]);
  gateChecked(f, session.id, 0);
  expect(f.control.needsYou(user).items).toEqual([]);
});

it('lists a blocked merge with its event time and the merge handler retry preconditions', async () => {
  const f = await workbenchFixture();
  const session = await idleSession(f);
  const event = blockMerge(f, session.id);
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
  const items = () => f.control.needsYou(user, f.project.id).items;
  // needsYou shows the repository states the last read ahead found; each read is kept two seconds.
  vi.useFakeTimers({ toFake: ['Date'] });
  onTestFinished(() => void vi.useRealTimers());
  const readAhead = async () => {
    vi.setSystemTime(Date.now() + 2000);
    await f.control.prefetchWorktreeReads(user, f.project.id);
  };
  await readAhead();
  expect(items()).toEqual([
    {
      source: { table: 'sessions', id: session.id, revision: current(f, session.id).revision },
      kind: 'session.merge_blocked',
      project_id: f.project.id,
      status: 'open',
      created_at: event.created_at,
      reason: 'merge_blocked',
      decision: 'other',
      primary: 'session.merge',
      actions: [{ command: 'session.merge', allowed: false, disabled_reason: 'no_changes' }],
    },
  ]);
  writeFileSync(path.join(workspace.path, 'answer.txt'), 'changed\n');
  await readAhead();
  // The merge commits the uncommitted files of a session the user opened first.
  expect(items()[0]!.actions).toEqual([{ command: 'session.merge', allowed: true }]);
  git(workspace.path, 'add', '.');
  git(workspace.path, 'commit', '--quiet', '-m', 'Change answer');
  await readAhead();
  const cursor = f.store.cursor();
  expect(items()[0]!.actions).toEqual([{ command: 'session.merge', allowed: true }]);
  expect(f.store.cursor()).toBe(cursor);
  patch(f, session.id, { state: 'running' });
  expect(items()[0]!.actions).toEqual([
    { command: 'session.merge', allowed: false, disabled_reason: 'resource_busy' },
  ]);
});

it('lists a session once, preferring failure to a failed gate and a failed gate to a blocked merge', async () => {
  const f = await workbenchFixture();
  const session = await idleSession(f);
  await setGate(f);
  const gate = gateChecked(f, session.id, 1);
  blockMerge(f, session.id);
  expect(f.control.needsYou(user).items).toMatchObject([
    { kind: 'session.gate_failed', created_at: gate.created_at },
  ]);
  const failed = patch(f, session.id, { state: 'closed' });
  const closed = f.store.event('session.closed', failed, failed.project_id, {});
  expect(f.control.needsYou(user).items).toMatchObject([
    { kind: 'session.failed', created_at: closed.created_at },
  ]);
});

it.each(['archived', 'merged', 'discarded'] as const)(
  'leaves out %s sessions even when they have failures and a blocked merge',
  async (state) => {
    const f = await workbenchFixture();
    const session = await idleSession(f);
    await setGate(f);
    gateChecked(f, session.id, 1);
    blockMerge(f, session.id);
    patch(f, session.id, {
      state: 'closed',
      ...(state === 'archived'
        ? { archived_at: new Date(f.store.now()).toISOString() }
        : { outcome: state }),
    });
    expect(f.control.needsYou(user).items).toEqual([]);
  },
);

it('leaves all new session items out for a planner', async () => {
  const f = await workbenchFixture();
  const failed = await idleSession(f),
    gated = await idleSession(f),
    blocked = await idleSession(f);
  patch(f, failed.id, { state: 'closed' });
  await setGate(f);
  gateChecked(f, gated.id, 1);
  blockMerge(f, blocked.id);
  const planner: Principal = { id: 'planner', role: 'planner', project_id: f.project.id };
  expect(f.control.needsYou(user).items).toHaveLength(3);
  expect(f.control.needsYou(planner).items).toEqual([]);
});

it('covers two projects without project_id and isolates an explicit project', async () => {
  const f = await workbenchFixture();
  const session = await idleSession(f);
  patch(f, session.id, { state: 'closed' });
  const project = f.store.insert<Project>('projects', { ...f.project, id: 'second-project' });
  const other = f.store.insert<Session>('sessions', {
    ...current(f, session.id),
    id: 'other-session',
    project_id: project.id,
  });
  expect(
    f.control
      .needsYou(user)
      .items.map((item) => item.source.id)
      .sort(),
  ).toEqual([session.id, other.id].sort());
  expect(f.control.needsYou(user, project.id).items.map((item) => item.source.id)).toEqual([
    other.id,
  ]);
});

it('lists a failed baseline assessment with its failure time, as the session list marks it failed', async () => {
  const f = await workbenchFixture();
  const baseline = f.store.insert<ProjectBaseline>('project_baselines', {
    id: 'failed-baseline',
    revision: 1,
    project_id: f.project.id,
    state: 'failed',
    session_id: 'baseline-session',
    facts_id: 'facts',
    dropped: 0,
    reason: 'baseline_window_expired',
    created_at: f.store.now(),
  });
  const session = f.store.insert<Session>('sessions', {
    id: 'baseline-session',
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    state: 'open',
    turn_count: 1,
    baseline: { baseline_id: baseline.id },
  });
  const event = f.store.event('project.baseline_failed', baseline, f.project.id, {
    reason: baseline.reason,
  });
  expect(f.list().find((row) => row.id === session.id)?.state).toBe('failed');
  expect(f.control.needsYou(user).items).toEqual([
    {
      source: { table: 'sessions', id: session.id, revision: session.revision },
      kind: 'session.failed',
      project_id: f.project.id,
      status: 'open',
      created_at: event.created_at,
      reason: 'session_failed',
      decision: 'other',
      actions: [],
    },
  ]);
});

it('lists a runtime analysis that closed without a report in a project with no other session', async () => {
  const f = await workbenchFixture();
  const session = f.store.insert<Session>('sessions', {
    id: 'analysis-failed',
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    state: 'closed',
    turn_count: 1,
    permission_mode: 'ask',
    runtime_review: { from: 0, to: 1 } as Session['runtime_review'],
  });
  const event = f.store.event('session.closed', session, f.project.id, {});
  expect(f.list().find((row) => row.id === session.id)?.state).toBe('failed');
  expect(f.control.needsYou(user).items).toEqual([
    {
      source: { table: 'sessions', id: session.id, revision: session.revision },
      kind: 'session.failed',
      project_id: f.project.id,
      status: 'closed',
      created_at: event.created_at,
      reason: 'session_failed',
      decision: 'other',
      actions: [],
    },
  ]);
});

it('leaves out the failed sessions of a removed project', async () => {
  const f = await workbenchFixture();
  const session = await idleSession(f);
  patch(f, session.id, { state: 'closed' });
  expect(f.control.needsYou(user).items).toHaveLength(1);
  const project = f.store.must<Project>('projects', f.project.id);
  f.store.update<Project>('projects', { ...project, removed_at: f.store.now() }, project.revision);
  expect(f.control.needsYou(user).items).toEqual([]);
});

/** Fails the session's latest turn the way the runtime reports it: the row and a turn.failed event. */
function failLatestTurn(f: Fixture, sessionId: string, error: string) {
  const turn = f.turns(sessionId).at(-1)!;
  const failed = f.store.update<SessionTurn>(
    'session_turns',
    { ...turn, state: 'failed' },
    turn.revision,
  );
  return f.store.event('turn.failed', failed, failed.project_id, { error });
}

/** Runs the store clock ahead of the wall clock; returns how to move it further. */
function skewedClock(f: Fixture) {
  let skew = 0;
  vi.spyOn(f.store, 'now').mockImplementation(() => Date.now() + skew);
  return (ms: number) => {
    skew += ms;
  };
}

it('lists a stop whose process is not confirmed stopped after two minutes', async () => {
  const f = await workbenchFixture();
  const session = await idleSession(f);
  const advance = skewedClock(f);
  const stopping = patch(f, session.id, {
    stop_requested: { reason: 'Discarded by the user', by: 'user', at: f.store.now() },
  });
  const items = () => f.control.needsYou(user, f.project.id).items;
  advance(60_000);
  expect(items()).toEqual([]);
  advance(61_000);
  expect(items()).toEqual([
    {
      source: { table: 'sessions', id: session.id, revision: stopping.revision },
      kind: 'session.failed',
      project_id: f.project.id,
      status: 'open',
      created_at: stopping.stop_requested!.at,
      reason: 'stop_unconfirmed',
      decision: 'other',
      actions: [],
      next_step: expect.stringContaining('retries the stop'),
    },
  ]);
});

it('lists a stop as soon as its discard failed', async () => {
  const f = await workbenchFixture();
  const session = await idleSession(f);
  const stopping = patch(f, session.id, {
    stop_requested: { reason: 'Discarded by the user', by: 'user', at: f.store.now() },
  });
  expect(f.control.needsYou(user, f.project.id).items).toEqual([]);
  f.store.event('session.discard_failed', stopping, stopping.project_id, {
    error: 'The native process did not confirm it stopped',
  });
  expect(f.control.needsYou(user, f.project.id).items.map((item) => item.reason)).toEqual([
    'stop_unconfirmed',
  ]);
});

it('lists a merge that has run for over 30 minutes without a gate process', async () => {
  const f = await workbenchFixture();
  const session = await idleSession(f);
  const advance = skewedClock(f);
  const merging = patch(f, session.id, { merge: { state: 'running' } });
  const started = f.store.event('session.merge_started', merging, merging.project_id, {});
  const items = () => f.control.needsYou(user, f.project.id).items;
  advance(29 * 60_000);
  expect(items()).toEqual([]);
  advance(2 * 60_000);
  expect(items()).toEqual([
    {
      source: { table: 'sessions', id: session.id, revision: merging.revision },
      kind: 'session.failed',
      project_id: f.project.id,
      status: 'open',
      created_at: started.created_at,
      reason: 'merge_stuck',
      decision: 'other',
      actions: [],
      next_step: expect.any(String),
    },
  ]);
});

it('counts a stuck merge from its latest gate event, not from its start', async () => {
  const f = await workbenchFixture();
  const session = await idleSession(f);
  const advance = skewedClock(f);
  const merging = patch(f, session.id, { merge: { state: 'running' } });
  const started = f.store.event('session.merge_started', merging, merging.project_id, {});
  const items = () => f.control.needsYou(user, f.project.id).items;
  advance(20 * 60_000);
  f.store.event('session.gate_started', merging, merging.project_id, {});
  advance(20 * 60_000);
  f.store.event('session.gate_checked', merging, merging.project_id, { results: [] });
  advance(20 * 60_000);
  expect(items()).toEqual([]);
  advance(11 * 60_000);
  expect(items().map((item) => [item.reason, item.created_at])).toEqual([
    ['merge_stuck', started.created_at],
  ]);
});

it('records one event when a merge becomes stuck, and another after it progresses and sticks again', async () => {
  const f = await workbenchFixture();
  const session = await idleSession(f);
  const advance = skewedClock(f);
  const merging = patch(f, session.id, { merge: { state: 'running' } });
  f.store.event('session.merge_started', merging, merging.project_id, {});
  const stuck = () =>
    f.store
      .events(0, undefined, 10000)
      .filter((event) => event.kind === 'session.merge_stuck' && event.aggregate_id === session.id);
  advance(29 * 60_000);
  await f.control.tick();
  expect(stuck()).toEqual([]);
  advance(2 * 60_000);
  await f.control.tick();
  await f.control.tick();
  expect(stuck()).toHaveLength(1);
  f.store.event('session.gate_started', merging, merging.project_id, {});
  await f.control.tick();
  expect(stuck()).toHaveLength(1);
  advance(31 * 60_000);
  await f.control.tick();
  expect(stuck()).toHaveLength(2);
});

it('escalates an unanswered permission request and records a stuck merge in a project without a plan', async () => {
  const f = await workbenchFixture();
  const session = await idleSession(f);
  const advance = skewedClock(f);
  expect(f.store.list<BoardPlan>('board_plans')).toEqual([]);
  f.store.insert<Approval>('approvals', {
    id: 'unanswered-request',
    revision: 1,
    project_id: f.project.id,
    kind: 'permission',
    session_id: session.id,
    request_id: 'unanswered-request',
    tool: 'mcp__docs__search',
    input_hash: 'a'.repeat(64),
    decider: 'user',
    state: 'pending',
    created_at: f.store.now(),
  });
  const merging = patch(f, session.id, { merge: { state: 'running' } });
  f.store.event('session.merge_started', merging, merging.project_id, {});
  const recorded = (kind: string) =>
    f.store.events(0, undefined, 10000).filter((event) => event.kind === kind);
  advance(31 * 60_000);
  await f.control.tick();
  expect(recorded('approval.escalated').map((event) => event.aggregate_id)).toEqual([
    'unanswered-request',
  ]);
  expect(recorded('session.merge_stuck').map((event) => event.aggregate_id)).toEqual([session.id]);
});

it('lists a session whose worktree provisioning a restart left reconciling without a process to check', async () => {
  const f = await workbenchFixture();
  const session = await f.create();
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
  // The daemon stopped after provisioning began and before it recorded the Git process.
  f.store.update<Workspace>(
    'workspaces',
    { ...workspace, provisioning: { ...workspace.provisioning!, state: 'running' } },
    workspace.revision,
  );
  await f.restart();
  expect(f.store.must<Workspace>('workspaces', workspace.id).provisioning?.state).toBe(
    'reconciling',
  );
  const reconciling = f.store
    .events(0, undefined, 10000)
    .filter(
      (event) => event.aggregate_id === workspace.id && event.kind === 'workspace.provisioning',
    )
    .at(-1)!;
  expect(f.control.needsYou(user, f.project.id).items).toEqual([
    {
      source: { table: 'sessions', id: session.id, revision: current(f, session.id).revision },
      kind: 'session.failed',
      project_id: f.project.id,
      status: current(f, session.id).state,
      created_at: reconciling.created_at,
      reason: 'workspace_reconciling',
      decision: 'other',
      actions: [],
      next_step: expect.stringContaining('the user reconciles'),
    },
  ]);
});

it('does not report a stale failed gate after another turn ends', async () => {
  const f = await workbenchFixture();
  const session = await idleSession(f);
  await setGate(f);
  gateChecked(f, session.id, 1);
  f.store.event('turn.completed', f.turns(session.id)[0]!, f.project.id, {});
  expect(f.list().find((row) => row.id === session.id)?.gate?.state).toBe('stale');
  expect(f.control.needsYou(user).items).toEqual([]);
});
