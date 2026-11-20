import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import {
  hash,
  type BoardPlan,
  type Principal,
  type Project,
  type ProjectBaseline,
  type Session,
  type SessionTurn,
  type Workspace,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/src/context.js';
import { continueSession } from '../../packages/control/dist/continuation.js';
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
        blocks: 0,
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
      blocks: 0,
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
      blocks: 0,
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
      blocks: 0,
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
      blocks: 0,
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

const leadOf = (f: Fixture, sessionId: string): Principal => ({
  id: `session:${sessionId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});

async function leadWithPlan(f: Fixture) {
  const lead = await f.create('Plan the export feature');
  await awaitWorkspaceReady(f.control, lead.workspace_id!);
  await eventually(
    () =>
      f.turns(lead.id).every((turn) => turn.state === 'completed') &&
      current(f, lead.id).state === 'open',
    () => f.control.tick(),
  );
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [
        {
          id: 'a',
          title: 'Serve exports over HTTP',
          goal: 'Exports download',
          lane: 'core',
          depends_on: [],
          source: ['Plan the export feature'],
          scope: ['src/export'],
          acceptance: ['pnpm test'],
        },
      ],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    leadOf(f, lead.id),
  );
  return current(f, lead.id);
}

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

const planOf = (f: Fixture, leadId: string) => f.store.must<BoardPlan>('board_plans', leadId);

it('lists a failed lead turn until the lead gets another turn, and queues none itself', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f);
  const failed = failLatestTurn(f, lead.id, 'provider overloaded');
  const turns = f.turns(lead.id).length;
  await f.control.tick();
  await f.control.tick();
  expect(f.turns(lead.id)).toHaveLength(turns);
  expect(f.control.needsYou(user, f.project.id).items).toEqual([
    {
      source: { table: 'sessions', id: lead.id, revision: current(f, lead.id).revision },
      kind: 'session.failed',
      project_id: f.project.id,
      status: 'open',
      created_at: failed.created_at,
      reason: 'lead_turn_failed',
      decision: 'other',
      blocks: 0,
      primary: 'session.send',
      actions: [{ command: 'session.send', allowed: true }],
      next_step: expect.any(String),
    },
  ]);
  f.call(
    'session.send',
    { session_id: lead.id, input: 'Try the plan again' },
    current(f, lead.id).revision,
  );
  expect(f.control.needsYou(user, f.project.id).items).toEqual([]);
});

it('keeps a failed lead turn listed after a steer delivered into it', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f);
  const failed = failLatestTurn(f, lead.id, 'provider overloaded');
  f.store.insert<SessionTurn>('session_turns', {
    ...f.turns(lead.id).at(-1)!,
    id: 'steer-into-failed-turn',
    revision: 1,
    input: 'Also look at the import path',
    kind: 'steer',
    delivery: 'delivered',
    state: 'completed',
  });
  expect(
    f.control.needsYou(user, f.project.id).items.map((item) => [item.reason, item.created_at]),
  ).toEqual([['lead_turn_failed', failed.created_at]]);
});

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
      blocks: 0,
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

it('keeps a wake the closed lead refused on its plan and lists it until a later wake succeeds', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f);
  patch(f, lead.id, { state: 'closed' });
  const plan = planOf(f, lead.id);
  f.store.update<BoardPlan>(
    'board_plans',
    {
      ...plan,
      inbox: [
        {
          at: f.store.now(),
          session_id: 'ended-task-session',
          task_id: 'a',
          kind: 'failed',
          text: 'The session ended without a merge.',
        },
      ],
    },
    plan.revision,
  );
  await f.control.tick();
  const refused = planOf(f, lead.id).wake_failed!;
  expect(refused).toEqual({ reason: 'lead_closed', at: expect.any(Number) });
  expect(
    f.control.needsYou(user, f.project.id).items.filter((item) => item.reason === 'lead_closed'),
  ).toEqual([
    {
      source: { table: 'board_plans', id: lead.id, revision: planOf(f, lead.id).revision },
      kind: 'session.failed',
      project_id: f.project.id,
      session_id: lead.id,
      status: 'closed',
      created_at: refused.at,
      reason: 'lead_closed',
      decision: 'other',
      blocks: 0,
      primary: 'board.sync',
      actions: [{ command: 'board.sync', allowed: true }],
      next_step: expect.any(String),
    },
  ]);

  patch(f, lead.id, { state: 'open' });
  await f.control.tick();
  expect(planOf(f, lead.id).wake_failed).toBeUndefined();
  expect(planOf(f, lead.id).inbox).toEqual([]);
  expect(
    f.control.needsYou(user, f.project.id).items.filter((item) => item.reason === 'lead_closed'),
  ).toEqual([]);
});

it('leaves the blocked merges and failed gates of a task session to its lead, except a change to protected paths', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f);
  const worker = await idleSession(f),
    own = await idleSession(f);
  patch(f, worker.id, { task: { lead_session_id: lead.id, id: 'a', generation: 1 } });
  const block = (sessionId: string, reason: string) => {
    const blocked = patch(f, sessionId, {
      merge: { state: 'blocked', reason, conflicts: ['README.md'] },
    });
    f.store.event('session.merge_blocked', blocked, blocked.project_id, blocked.merge);
  };
  const listed = (sessionId: string) =>
    f.control
      .needsYou(user, f.project.id)
      .items.filter((item) => item.source.id === sessionId)
      .map((item) => item.kind);
  await setGate(f);
  gateChecked(f, worker.id, 1, ['pnpm test']);
  expect(listed(worker.id)).toEqual([]);
  gateChecked(f, worker.id, 0, ['pnpm test']);
  block(worker.id, 'out_of_scope');
  block(own.id, 'out_of_scope');
  expect(listed(worker.id)).toEqual([]);
  expect(listed(own.id)).toEqual(['session.merge_blocked']);
  block(worker.id, 'protected_paths');
  expect(listed(worker.id)).toEqual(['session.merge_blocked']);
  block(worker.id, 'out_of_scope');
  patch(f, lead.id, { state: 'closed' });
  expect(listed(worker.id)).toEqual(['session.merge_blocked']);
});

it('lists a merge blocked because the task of the session was removed', async () => {
  const f = await workbenchFixture();
  const session = await idleSession(f);
  const blocked = patch(f, session.id, {
    task: { lead_session_id: 'lead-of-removed-task', id: 'api' },
    merge: { state: 'blocked', reason: 'task_retired' },
  });
  const event = f.store.event('session.merge_blocked', blocked, blocked.project_id, blocked.merge);
  expect(f.control.needsYou(user, f.project.id).items).toEqual([
    {
      source: { table: 'sessions', id: session.id, revision: blocked.revision },
      kind: 'session.failed',
      project_id: f.project.id,
      status: 'open',
      created_at: event.created_at,
      reason: 'task_retired',
      decision: 'other',
      blocks: 0,
      actions: [],
      next_step: expect.any(String),
    },
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
      blocks: 0,
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

it('records why a continuation is skipped and lists a session past the continuation limit', async () => {
  const f = await workbenchFixture();
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const lead = await leadWithPlan(f);
  for (const id of ['first', 'second', 'third'])
    f.store.event('turn.queued', { id: `${id}-continuation`, revision: 1 }, f.project.id, {
      session_id: lead.id,
      origin: 'continuation',
    });
  expect(continueSession(ctx, current(f, lead.id), 'Continue', '')).toBeUndefined();
  const person = await idleSession(f);
  expect(continueSession(ctx, person, 'Continue', '')).toBeUndefined();
  const skipped = f.store
    .events(0, undefined, 10000)
    .filter((event) => event.kind === 'session.continuation_skipped');
  expect(skipped.map((event) => [event.aggregate_id, event.payload])).toEqual([
    [lead.id, { reason: 'limit_reached' }],
    [person.id, { reason: 'not_daemon_driven' }],
  ]);
  expect(f.control.needsYou(user, f.project.id).items).toEqual([
    {
      source: { table: 'sessions', id: lead.id, revision: current(f, lead.id).revision },
      kind: 'session.failed',
      project_id: f.project.id,
      status: 'open',
      created_at: skipped[0]!.created_at,
      reason: 'continuation_limit_reached',
      decision: 'other',
      blocks: 0,
      primary: 'session.send',
      actions: [{ command: 'session.send', allowed: true }],
      next_step: expect.any(String),
    },
  ]);
  f.call(
    'session.send',
    { session_id: lead.id, input: 'Pick the work up again' },
    current(f, lead.id).revision,
  );
  expect(f.control.needsYou(user, f.project.id).items).toEqual([]);
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
      blocks: 0,
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
