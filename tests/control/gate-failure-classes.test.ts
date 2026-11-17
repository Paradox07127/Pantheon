import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import type {
  BoardPlan,
  LeadNote,
  Project,
  Session,
  SessionTurn,
  Workspace,
} from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, insideSandbox, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const LEAD = 'lead-of-gated-task';

async function mergeFixture() {
  const f = await workbenchFixture();
  git(f.source, 'config', 'user.name', 'Source User');
  git(f.source, 'config', 'user.email', 'source@example.invalid');
  return f;
}

/** An idle session on a board task, so the daemon merges it after its next turn. */
async function idleTaskSession(f: Fixture) {
  const sourceHead = git(f.source, 'rev-parse', 'HEAD');
  const session = await f.create();
  const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.turns(session.id)[0]!.state === 'completed' &&
      f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  f.store.transaction(() =>
    f.store.insert<BoardPlan>('board_plans', {
      id: LEAD,
      revision: 1,
      project_id: f.project.id,
      headline: 'Gated work',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [
        {
          id: 'gated-task',
          title: 'Gated task',
          goal: 'Merge through the gate',
          lane: 'core',
          depends_on: [],
          source: [],
          scope: ['answer.txt'],
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
    { ...idle, task: { lead_session_id: LEAD, id: 'gated-task' } },
    idle.revision,
  );
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
const removed = (f: Fixture, workspaceId: string) =>
  f.store.must<Workspace>('workspaces', workspaceId).removed_at !== undefined;
const blockedNotes = (f: Fixture) =>
  (payloads(f, LEAD, 'lead.note_added') as unknown as LeadNote[]).filter(
    (note) => note.kind === 'blocked',
  );
const fromTracker = (f: Fixture, sessionId: string) =>
  f.turns(sessionId).filter((turn: SessionTurn) => turn.origin === 'tracker');
const payloads = (f: Fixture, aggregateId: string, kind: string) =>
  (
    f.store.db
      .prepare('SELECT payload FROM events WHERE aggregate_id=? AND kind=? ORDER BY sequence')
      .all(aggregateId, kind) as { payload: string }[]
  ).map((row) => JSON.parse(row.payload) as Record<string, unknown>);

/** Merges the session through the gate after its next turn. */
async function gateAndMergeAutomatically(
  f: Fixture,
  commands: { name: string; argv: string[]; timeout_ms?: number }[],
) {
  await f.call(
    'project.gate.set',
    { project_id: f.project.id, root: f.source, commands },
    project(f).revision,
  );
  f.call('project.autoMerge.set', { project_id: f.project.id, enabled: true }, project(f).revision);
}

/** Leaves the reason to the lead, as once the tracker has handed it back as often as it does. */
function handedBackEnough(f: Fixture, sessionId: string, reason: string) {
  const plan = f.store.must<BoardPlan>('board_plans', LEAD);
  f.store.update<BoardPlan>(
    'board_plans',
    { ...plan, handed_back: { [sessionId]: [reason, reason, reason] } },
    plan.revision,
  );
}

/**
 * A gate that hangs on its first run in a candidate and leaves a file there; a run that finds the
 * file prints that it is the rerun, then passes or hangs again.
 */
const hangsFirst = (rerun: 'passes' | 'hangs') => ({
  name: 'Hangs on its first run',
  argv: [
    process.execPath,
    '-e',
    [
      "const fs = require('node:fs');",
      "if (!fs.existsSync('first-run-done')) {",
      "  fs.writeFileSync('first-run-done', '');",
      "  console.log('first run');",
      '  setInterval(() => {}, 1000);',
      '} else {',
      "  console.log('rerun on the same candidate');",
      rerun === 'passes' ? '  process.exit(0);' : '  setInterval(() => {}, 1000);',
      '}',
    ].join('\n'),
  ],
  timeout_ms: 3000,
});

const failing = {
  name: 'Always fails',
  argv: [process.execPath, '-e', "process.stderr.write('gate broke'); process.exit(3)"],
};

const unstartable = {
  name: 'Cannot start',
  argv: ['/nonexistent/pantheon-gate-tool'],
};

const send = (f: Fixture, sessionId: string, input = 'Keep going') =>
  f.call<SessionTurn>(
    'session.send',
    { session_id: sessionId, input },
    current(f, sessionId).revision,
  );

it.skipIf(insideSandbox)(
  'reruns a gate that timed out once on the same commit before blocking the merge',
  async () => {
    const f = await mergeFixture();
    const { session, workspace, sourceHead } = await idleTaskSession(f);
    handedBackEnough(f, session.id, 'gate_failed');
    await gateAndMergeAutomatically(f, [hangsFirst('hangs')]);
    commit(workspace.path, 'answer.txt', 'gated\n');
    send(f, session.id);
    await eventually(
      () => current(f, session.id).merge?.state === 'blocked',
      () => f.control.tick(),
      14000,
    );
    expect(current(f, session.id).merge).toMatchObject({
      state: 'blocked',
      reason: 'gate_failed',
      failure_class: 'environment',
      gate: { name: 'Hangs on its first run' },
    });
    expect(current(f, session.id).merge!.gate!.output).toContain('rerun on the same candidate');
    expect(git(f.source, 'rev-parse', 'main')).toBe(sourceHead);
  },
  20000,
);

it.skipIf(insideSandbox)(
  'merges when a flaky gate passes on its automatic rerun',
  async () => {
    const f = await mergeFixture();
    const { session, workspace } = await idleTaskSession(f);
    await gateAndMergeAutomatically(f, [hangsFirst('passes')]);
    const head = commit(workspace.path, 'answer.txt', 'flaky gate\n');
    send(f, session.id);
    await eventually(
      () => removed(f, workspace.id) || current(f, session.id).merge?.state === 'blocked',
      () => f.control.tick(),
      14000,
    );
    expect(current(f, session.id)).toMatchObject({ state: 'closed', outcome: 'merged' });
    expect(git(f.source, 'rev-parse', 'main')).toBe(head);
  },
  20000,
);

it.skipIf(insideSandbox)(
  'does not hand an environment gate failure back to the task session',
  async () => {
    const f = await mergeFixture();
    const { session, workspace } = await idleTaskSession(f);
    await gateAndMergeAutomatically(f, [hangsFirst('hangs')]);
    commit(workspace.path, 'answer.txt', 'environment\n');
    const turn = send(f, session.id);
    await eventually(
      () => current(f, session.id).merge?.state === 'blocked',
      () => f.control.tick(),
      14000,
    );
    for (let i = 0; i < 3; i++) await f.control.tick();
    expect(fromTracker(f, session.id)).toEqual([]);
    expect(f.turns(session.id).at(-1)!.id).toBe(turn.id);
    expect(current(f, session.id).merge).toMatchObject({
      state: 'blocked',
      reason: 'gate_failed',
      failure_class: 'environment',
    });
    const notes = blockedNotes(f);
    expect(notes).toMatchObject([{ session_id: session.id, kind: 'blocked' }]);
    expect(notes[0]!.text).toContain('environment');
    expect(notes[0]!.text).toContain('"Hangs on its first run"');
  },
  20000,
);

it.skipIf(insideSandbox)(
  'lists a gate that could not start in needs-you as an environment failure',
  async () => {
    const f = await mergeFixture();
    const { session, workspace } = await idleTaskSession(f);
    handedBackEnough(f, session.id, 'gate_failed');
    await gateAndMergeAutomatically(f, [unstartable]);
    commit(workspace.path, 'answer.txt', 'unstartable\n');
    send(f, session.id);
    await eventually(
      () => current(f, session.id).merge?.state === 'blocked',
      () => f.control.tick(),
      14000,
    );
    expect(current(f, session.id).merge).toMatchObject({
      reason: 'gate_failed',
      failure_class: 'environment',
    });
    expect(f.control.needsYou(user, f.project.id).items).toMatchObject([
      {
        source: { table: 'sessions', id: session.id },
        reason: 'gate_failed',
        failure_class: 'environment',
      },
    ]);
  },
  20000,
);

it.skipIf(insideSandbox)(
  'still hands a gate that exited non-zero back to the task session',
  async () => {
    const f = await mergeFixture();
    const { session, workspace } = await idleTaskSession(f);
    await gateAndMergeAutomatically(f, [failing]);
    commit(workspace.path, 'answer.txt', 'broken\n');
    send(f, session.id);
    await eventually(
      () => fromTracker(f, session.id).length > 0,
      () => f.control.tick(),
      14000,
    );
    expect(payloads(f, session.id, 'session.merge_blocked')).toMatchObject([
      { reason: 'gate_failed', failure_class: 'code', gate: { name: 'Always fails' } },
    ]);
    expect(fromTracker(f, session.id)[0]!.input).toContain('Fix the cause and commit.');
    expect(blockedNotes(f)).toEqual([]);
  },
  20000,
);
