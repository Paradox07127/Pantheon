import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type {
  BoardPlan,
  Principal,
  Project,
  Session,
  SessionTurn,
  Workspace,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { autoMergeAfterTurn } from '../../packages/control/dist/workbench-session.js';
import { insideSandbox, awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

async function mergeFixture() {
  const f = await workbenchFixture();
  git(f.source, 'config', 'user.name', 'Source User');
  git(f.source, 'config', 'user.email', 'source@example.invalid');
  return f;
}

/** An idle session working on a board task; only task sessions merge automatically. */
async function idleSession(f: Fixture, onTask = true) {
  const sourceHead = git(f.source, 'rev-parse', 'HEAD');
  const session = await f.create();
  const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.turns(session.id)[0]!.state === 'completed' &&
      f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  if (onTask) {
    f.store.transaction(() =>
      f.store.insert<BoardPlan>('board_plans', {
        id: 'lead-of-auto-merged-task',
        revision: 1,
        project_id: f.project.id,
        headline: 'Auto-merged work',
        lanes: [{ id: 'core', title: 'Core' }],
        tasks: [
          {
            id: 'auto-merged-task',
            title: 'Auto-merged task',
            goal: 'Merge on its own',
            lane: 'core',
            depends_on: [],
            source: [],
            // The whole repository, since a task without scope paths may merge no file.
            scope: ['.'],
            acceptance: [],
          },
        ],
        risks: [],
        assumptions: [],
        plan_version: 0,
        pending_edits: [],
        inbox: [],
        notified: {},
        updated_at: Date.now(),
      }),
    );
    const idle = f.store.must<Session>('sessions', session.id);
    f.store.update<Session>(
      'sessions',
      { ...idle, task: { lead_session_id: 'lead-of-auto-merged-task', id: 'auto-merged-task' } },
      idle.revision,
    );
  }
  return { session, workspace, sourceHead };
}

function commit(repository: string, name: string, contents: string) {
  writeFileSync(path.join(repository, name), contents);
  git(repository, 'add', '--', name);
  git(repository, 'commit', '--quiet', '-m', `Update ${name}`);
  return git(repository, 'rev-parse', 'HEAD');
}

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const project = (f: Fixture) => f.store.must<Project>('projects', f.project.id);

const send = (f: Fixture, sessionId: string, input = 'Keep going') =>
  f.call<SessionTurn>(
    'session.send',
    { session_id: sessionId, input },
    current(f, sessionId).revision,
  );

const setAutoMerge = (f: Fixture, enabled: boolean, principal: Principal = user) =>
  f.call<Project>(
    'project.autoMerge.set',
    { project_id: f.project.id, enabled },
    project(f).revision,
    principal,
  );

const payloads = (f: Fixture, sessionId: string, kind: string) =>
  (
    f.store.db
      .prepare('SELECT payload FROM events WHERE aggregate_id=? AND kind=? ORDER BY sequence')
      .all(sessionId, kind) as { payload: string }[]
  ).map((row) => JSON.parse(row.payload) as Record<string, unknown>);

const removed = (f: Fixture, workspaceId: string) =>
  f.store.must<Workspace>('workspaces', workspaceId).removed_at !== undefined;

/** Leaves the reason to the lead, as once the tracker has handed it back to the session as often as it does. */
function handedBackEnough(f: Fixture, sessionId: string, reason: string) {
  const plan = f.store.must<BoardPlan>('board_plans', 'lead-of-auto-merged-task');
  f.store.update<BoardPlan>(
    'board_plans',
    { ...plan, handed_back: { [sessionId]: [reason, reason, reason] } },
    plan.revision,
  );
}

async function setGate(f: Fixture, commands: { name: string; argv: string[] }[]) {
  await f.call<Project>(
    'project.gate.set',
    { project_id: f.project.id, root: f.source, commands },
    project(f).revision,
  );
}

const passing = [{ name: 'Passes', argv: [process.execPath, '-e', 'process.exit(0)'] }];
const failing = [
  {
    name: 'Always fails',
    argv: [process.execPath, '-e', "process.stderr.write('gate broke'); process.exit(3)"],
  },
];

/** Waits until the turn has ended and the session is no longer running, then ticks a few times. */
async function settle(f: Fixture, sessionId: string, turnId: string, state = 'completed') {
  await eventually(
    () =>
      f.store.must<SessionTurn>('session_turns', turnId).state === state &&
      current(f, sessionId).state !== 'running',
    () => f.control.tick(),
  );
  for (let i = 0; i < 3; i++) await f.control.tick();
}

it.skipIf(insideSandbox)(
  'merges a clean worktree with new commits when a turn completes',
  async () => {
    const f = await mergeFixture();
    const { session, workspace } = await idleSession(f);
    await setGate(f, passing);
    setAutoMerge(f, true);
    const head = commit(workspace.path, 'answer.txt', 'merged\n');
    send(f, session.id);
    await eventually(
      () => removed(f, workspace.id),
      () => f.control.tick(),
      10000,
    );
    expect(git(f.source, 'rev-parse', 'main')).toBe(head);
    expect(current(f, session.id)).toMatchObject({ state: 'closed', outcome: 'merged' });
    expect(payloads(f, session.id, 'session.merge_started')).toEqual([{ auto: true }]);
  },
);

it('does not merge when a compaction the user asked for completes', async () => {
  const f = await mergeFixture();
  const { session, workspace, sourceHead } = await idleSession(f);
  await setGate(f, passing);
  setAutoMerge(f, true);
  commit(workspace.path, 'answer.txt', 'not merged by a compaction\n');
  const turn = f.call<SessionTurn>(
    'session.compact',
    { session_id: session.id },
    current(f, session.id).revision,
  );
  await settle(f, session.id, turn.id);
  expect(payloads(f, session.id, 'session.merge_started')).toEqual([]);
  expect(git(f.source, 'rev-parse', 'main')).toBe(sourceHead);
  expect(current(f, session.id).outcome).toBeUndefined();
});

it.each([
  {
    name: 'does not merge a session the user opened, only sessions on a board task',
    onTask: false,
    gated: true,
    auto: true,
    uncommitted: false,
  },
  {
    name: 'does not commit or merge the uncommitted files of a session the user opened',
    onTask: false,
    gated: true,
    auto: true,
    uncommitted: true,
  },
  {
    name: 'does not merge when the project has auto-merge off',
    onTask: true,
    gated: true,
    auto: false,
    uncommitted: false,
  },
  {
    name: 'does not merge when the project has no gate commands',
    onTask: true,
    gated: false,
    auto: true,
    uncommitted: false,
  },
])('$name', async ({ onTask, gated, auto, uncommitted }) => {
  const f = await mergeFixture();
  const { session, workspace, sourceHead } = await idleSession(f, onTask);
  if (gated) await setGate(f, passing);
  if (auto) setAutoMerge(f, true);
  const head = commit(workspace.path, 'answer.txt', 'kept\n');
  if (uncommitted) writeFileSync(path.join(workspace.path, 'draft.txt'), 'draft\n');
  const turn = send(f, session.id);
  await settle(f, session.id, turn.id);
  expect(git(workspace.path, 'rev-parse', 'HEAD')).toBe(head);
  expect(git(workspace.path, 'status', '--porcelain')).toBe(uncommitted ? '?? draft.txt' : '');
  expect(payloads(f, session.id, 'session.merge_started')).toEqual([]);
  expect(current(f, session.id).merge).toBeUndefined();
  expect(current(f, session.id).outcome).toBeUndefined();
  expect(git(f.source, 'rev-parse', 'main')).toBe(sourceHead);
});

it('does not merge a session that leads a board plan when its turn completes', async () => {
  const f = await mergeFixture();
  const { session, workspace, sourceHead } = await idleSession(f);
  await setGate(f, passing);
  setAutoMerge(f, true);
  f.store.transaction(() =>
    f.store.insert<BoardPlan>('board_plans', {
      id: session.id,
      revision: 1,
      project_id: f.project.id,
      headline: 'Planned work',
      lanes: [],
      tasks: [],
      risks: [],
      assumptions: [],
      plan_version: 0,
      pending_edits: [],
      inbox: [],
      notified: {},
      updated_at: Date.now(),
    }),
  );
  commit(workspace.path, 'answer.txt', 'planned\n');
  const turn = send(f, session.id);
  await settle(f, session.id, turn.id);
  expect(payloads(f, session.id, 'session.merge_started')).toEqual([]);
  expect(current(f, session.id).merge).toBeUndefined();
  expect(current(f, session.id).outcome).toBeUndefined();
  expect(git(f.source, 'rev-parse', 'main')).toBe(sourceHead);
});

it('does not merge after the source repository checked out another branch than the session started from', async () => {
  const f = await mergeFixture();
  const { session, workspace, sourceHead } = await idleSession(f);
  await setGate(f, passing);
  setAutoMerge(f, true);
  commit(workspace.path, 'answer.txt', 'meant for main\n');
  git(f.source, 'checkout', '--quiet', '-b', 'release');
  const turn = send(f, session.id);
  await settle(f, session.id, turn.id);
  expect(payloads(f, session.id, 'session.merge_started')).toEqual([]);
  expect(current(f, session.id).merge).toEqual({
    state: 'blocked',
    reason: 'target_branch_changed',
  });
  expect(git(f.source, 'rev-parse', 'main')).toBe(sourceHead);
  expect(git(f.source, 'rev-parse', 'release')).toBe(sourceHead);
});

it('blocks the merge for the user when the source repository has edited tracked files', async () => {
  const f = await mergeFixture();
  const { session, workspace, sourceHead } = await idleSession(f);
  await setGate(f, passing);
  setAutoMerge(f, true);
  commit(workspace.path, 'answer.txt', 'ready to merge\n');
  writeFileSync(path.join(f.source, 'answer.txt'), 'edited in the source\n');
  const turn = send(f, session.id);
  await settle(f, session.id, turn.id);
  expect(payloads(f, session.id, 'session.merge_started')).toEqual([]);
  expect(current(f, session.id).merge).toEqual({ state: 'blocked', reason: 'source_dirty' });
  expect(payloads(f, session.id, 'session.merge_blocked')).toEqual([
    { state: 'blocked', reason: 'source_dirty' },
  ]);
  expect(f.control.needsYou(user, f.project.id).items).toMatchObject([
    {
      source: { table: 'sessions', id: session.id },
      reason: 'merge_blocked',
      actions: [{ command: 'session.merge', allowed: false }],
    },
  ]);
  expect(f.turns(session.id).filter((entry) => entry.origin === 'tracker')).toEqual([]);
  expect(git(f.source, 'rev-parse', 'main')).toBe(sourceHead);
});

it('does not merge a worktree with uncommitted files', async () => {
  const f = await mergeFixture();
  const { session, workspace, sourceHead } = await idleSession(f);
  handedBackEnough(f, session.id, 'uncommitted_changes');
  await setGate(f, passing);
  setAutoMerge(f, true);
  commit(workspace.path, 'answer.txt', 'committed\n');
  writeFileSync(path.join(workspace.path, 'draft.txt'), 'draft\n');
  const turn = send(f, session.id);
  await settle(f, session.id, turn.id);
  expect(payloads(f, session.id, 'session.merge_started')).toEqual([]);
  expect(current(f, session.id).merge).toBeUndefined();
  expect(current(f, session.id).state).toBe('open');
  expect(git(f.source, 'rev-parse', 'main')).toBe(sourceHead);
});

it.skipIf(insideSandbox)(
  'stops at a blocked merge when the gate fails and does not retry',
  async () => {
    const f = await mergeFixture();
    const { session, workspace, sourceHead } = await idleSession(f);
    handedBackEnough(f, session.id, 'gate_failed');
    await setGate(f, failing);
    setAutoMerge(f, true);
    commit(workspace.path, 'answer.txt', 'gated\n');
    send(f, session.id);
    await eventually(
      () => current(f, session.id).merge?.state === 'blocked',
      () => f.control.tick(),
      10000,
    );
    expect(current(f, session.id).merge).toMatchObject({ state: 'blocked', reason: 'gate_failed' });
    for (let i = 0; i < 5; i++) await f.control.tick();
    expect(payloads(f, session.id, 'session.merge_started')).toEqual([{ auto: true }]);
    expect(current(f, session.id).merge?.state).toBe('blocked');
    expect(git(f.source, 'rev-parse', 'main')).toBe(sourceHead);
  },
);

it.skipIf(insideSandbox)(
  'merges once the gate run the user started during the turn end has finished',
  async () => {
    const f = await mergeFixture();
    const { session, workspace } = await idleSession(f);
    await setGate(f, passing);
    setAutoMerge(f, true);
    const head = commit(workspace.path, 'answer.txt', 'merged after the gate run\n');
    await f.call('session.gates.run', { session_id: session.id }, current(f, session.id).revision);
    autoMergeAfterTurn(
      (f.control as unknown as { ctx: ControlContext }).ctx,
      session.id,
      f.turns(session.id).at(-1)!.id,
    );
    expect(payloads(f, session.id, 'session.merge_started')).toEqual([]);
    await eventually(
      () => removed(f, workspace.id),
      () => f.control.tick(),
      10000,
    );
    expect(payloads(f, session.id, 'session.merge_started')).toEqual([{ auto: true }]);
    expect(git(f.source, 'rev-parse', 'main')).toBe(head);
  },
);

it('does not merge after a failed turn', async () => {
  const f = await mergeFixture();
  const { session, workspace } = await idleSession(f);
  await setGate(f, passing);
  setAutoMerge(f, true);
  commit(workspace.path, 'answer.txt', 'failed\n');
  vi.spyOn(f.adapter, 'send').mockImplementationOnce(async (_handle, turn) => ({
    turn_id: turn.turn_id,
    status: 'unsupported',
    reason: 'Refused by the test',
  }));
  const turn = send(f, session.id);
  await settle(f, session.id, turn.id, 'failed');
  expect(payloads(f, session.id, 'session.merge_started')).toEqual([]);
  expect(current(f, session.id).merge).toBeUndefined();
  expect(current(f, session.id).outcome).toBeUndefined();
});

it('does not merge after an interrupted turn', async () => {
  const f = await mergeFixture();
  const { session, workspace } = await idleSession(f);
  await setGate(f, passing);
  setAutoMerge(f, true);
  commit(workspace.path, 'answer.txt', 'interrupted\n');
  // The next turn outlasts the test unless it is interrupted.
  (f.adapter as { delay: number }).delay = 30000;
  const turn = send(f, session.id);
  await eventually(
    () => f.store.must<SessionTurn>('session_turns', turn.id).state === 'running',
    () => f.control.tick(),
  );
  f.call('session.interrupt', { session_id: session.id }, current(f, session.id).revision);
  await settle(f, session.id, turn.id, 'cancelled');
  expect(payloads(f, session.id, 'session.merge_started')).toEqual([]);
  expect(current(f, session.id).merge).toBeUndefined();
});

it.skipIf(insideSandbox)(
  'does not merge an idle session when auto-merge is turned on, only after its next turn',
  async () => {
    const f = await mergeFixture();
    const { session, workspace } = await idleSession(f);
    await setGate(f, passing);
    const head = commit(workspace.path, 'answer.txt', 'later\n');
    setAutoMerge(f, true);
    for (let i = 0; i < 3; i++) await f.control.tick();
    expect(payloads(f, session.id, 'session.merge_started')).toEqual([]);
    expect(current(f, session.id).merge).toBeUndefined();
    send(f, session.id);
    await eventually(
      () => removed(f, workspace.id),
      () => f.control.tick(),
      10000,
    );
    expect(git(f.source, 'rev-parse', 'main')).toBe(head);
    expect(payloads(f, session.id, 'session.merge_started')).toEqual([{ auto: true }]);
  },
);

it.skipIf(insideSandbox)('rebases onto a newer source commit before it merges', async () => {
  const f = await mergeFixture();
  const { session, workspace } = await idleSession(f);
  await setGate(f, passing);
  setAutoMerge(f, true);
  commit(workspace.path, 'session.txt', 'session\n');
  const theirs = commit(f.source, 'source.txt', 'source\n');
  send(f, session.id);
  await eventually(
    () => removed(f, workspace.id),
    () => f.control.tick(),
    10000,
  );
  expect(current(f, session.id).outcome).toBe('merged');
  expect(git(f.source, 'rev-parse', 'main^')).toBe(theirs);
  expect(git(f.source, 'rev-list', '--merges', 'main')).toBe('');
  expect(git(f.source, 'show', 'main:session.txt')).toBe('session');
  expect(git(f.source, 'show', 'main:source.txt')).toBe('source');
});

it('stores auto-merge on the project at its revision and records each change', async () => {
  const f = await workbenchFixture();
  const events = () =>
    f.store.db
      .prepare("SELECT payload FROM events WHERE kind='project.auto_merge_set' ORDER BY sequence")
      .all()
      .map((row) => JSON.parse((row as { payload: string }).payload) as unknown);
  const before = project(f);
  expect(() =>
    f.call('project.autoMerge.set', { project_id: f.project.id, enabled: true }, before.revision, {
      id: 'agent',
      role: 'planner',
    }),
  ).toThrow(expect.objectContaining({ code: 'permission_denied' }));
  expect(() =>
    f.call(
      'project.autoMerge.set',
      { project_id: f.project.id, enabled: true },
      before.revision - 1,
    ),
  ).toThrow(expect.objectContaining({ code: 'revision_conflict' }));
  expect(project(f)).toEqual(before);
  const on = setAutoMerge(f, true);
  expect(on).toMatchObject({ auto_merge: true, revision: before.revision + 1 });
  expect(project(f)).toEqual(on);
  const off = setAutoMerge(f, false);
  expect(off.revision).toBe(before.revision + 2);
  expect(off).toMatchObject({ auto_merge: false });
  expect(project(f)).toEqual(off);
  expect(events()).toEqual([{ enabled: true }, { enabled: false }]);
});
