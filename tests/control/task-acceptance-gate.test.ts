import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { BoardPlan, Project, Session, SessionTurn, Workspace } from '@pantheon/domain';
import { insideSandbox, awaitWorkspaceReady, eventually } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const leadId = 'lead-session-of-plan';

async function mergeFixture() {
  const f = await workbenchFixture();
  git(f.source, 'config', 'user.name', 'Source User');
  git(f.source, 'config', 'user.email', 'source@example.invalid');
  return f;
}

/** Writes the lead's plan with one task carrying the acceptance commands. */
function setAcceptance(f: Fixture, acceptance: string[]) {
  const task = {
    id: 'api',
    title: 'Export API',
    goal: 'Ship the export API',
    lane: 'core',
    depends_on: [],
    source: [],
    scope: ['answer.txt', 'MUST_EXIST'],
    acceptance,
  };
  const existing = f.store.get<BoardPlan>('board_plans', leadId);
  if (existing) {
    f.store.update<BoardPlan>('board_plans', { ...existing, tasks: [task] }, existing.revision);
    return;
  }
  f.store.insert<BoardPlan>('board_plans', {
    id: leadId,
    revision: 1,
    project_id: f.project.id,
    headline: 'Export',
    lanes: [{ id: 'core', title: 'Core' }],
    tasks: [task],
    risks: [],
    assumptions: [],
    plan_version: 0,
    pending_edits: [],
    inbox: [],
    notified: {},
    updated_at: f.store.now(),
  });
}

/** A task session whose first turn has ended, with its ready worktree. */
async function taskSession(f: Fixture) {
  const sourceHead = git(f.source, 'rev-parse', 'HEAD');
  const created = await f.create();
  const workspace = await awaitWorkspaceReady(f.control, created.workspace_id!);
  await eventually(
    () =>
      f.turns(created.id)[0]!.state === 'completed' &&
      f.store.must<Session>('sessions', created.id).state === 'open',
    () => f.control.tick(),
  );
  const session = current(f, created.id);
  f.store.update<Session>(
    'sessions',
    { ...session, task: { lead_session_id: leadId, id: 'api' } },
    session.revision,
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

const merge = (f: Fixture, sessionId: string) =>
  f.call<Session>('session.merge', { session_id: sessionId }, current(f, sessionId).revision);

const payloads = (f: Fixture, sessionId: string, kind: string) =>
  (
    f.store.db
      .prepare('SELECT payload FROM events WHERE aggregate_id=? AND kind=? ORDER BY sequence')
      .all(sessionId, kind) as { payload: string }[]
  ).map((row) => JSON.parse(row.payload) as Record<string, unknown>);

const removed = (f: Fixture, workspaceId: string) =>
  f.store.must<Workspace>('workspaces', workspaceId).removed_at !== undefined;

it.skipIf(insideSandbox)(
  'blocks a merge on a failing task acceptance without project gates and lands once the plan is fixed',
  async () => {
    const f = await mergeFixture();
    setAcceptance(f, ['test -f MUST_EXIST']);
    const { session, workspace, sourceHead } = await taskSession(f);
    const head = commit(workspace.path, 'answer.txt', 'accepted\n');
    merge(f, session.id);
    await eventually(
      () => current(f, session.id).merge?.state === 'blocked',
      () => f.control.tick(),
      10000,
    );
    expect(current(f, session.id).merge).toMatchObject({
      state: 'blocked',
      reason: 'gate_failed',
      gate: { name: 'test -f MUST_EXIST' },
    });
    expect(payloads(f, session.id, 'session.gate_checked')[0]!.results).toMatchObject([
      { name: 'test -f MUST_EXIST', argv: ['/bin/sh', '-c', 'test -f MUST_EXIST'], exit_code: 1 },
    ]);
    expect(git(f.source, 'rev-parse', 'main')).toBe(sourceHead);

    setAcceptance(f, ['test -f answer.txt']);
    merge(f, session.id);
    await eventually(
      () => removed(f, workspace.id),
      () => f.control.tick(),
      10000,
    );
    expect(current(f, session.id).outcome).toBe('merged');
    expect(git(f.source, 'rev-parse', 'main')).toBe(head);
    expect(payloads(f, session.id, 'session.gate_checked')[1]!.results).toMatchObject([
      { name: 'test -f answer.txt', exit_code: 0 },
    ]);
  },
);

it.skipIf(insideSandbox)(
  'does not merge on the old acceptance when the plan changes it while the gate runs',
  async () => {
    const f = await mergeFixture();
    const release = path.join(f.root, 'release-gate');
    setAcceptance(f, [`while [ ! -f '${release}' ]; do sleep 0.05; done`]);
    const { session, workspace, sourceHead } = await taskSession(f);
    commit(workspace.path, 'answer.txt', 'accepted\n');
    merge(f, session.id);
    await eventually(
      () => payloads(f, session.id, 'session.gate_started').length === 1,
      () => f.control.tick(),
      10000,
    );
    setAcceptance(f, ['test -f MUST_EXIST']);
    writeFileSync(release, '');
    await eventually(
      () => current(f, session.id).merge?.state !== 'running',
      () => f.control.tick(),
      10000,
    );
    expect(current(f, session.id).outcome).toBeUndefined();
    expect(current(f, session.id).merge).toMatchObject({ state: 'blocked', reason: 'cancelled' });
    expect(git(f.source, 'rev-parse', 'main')).toBe(sourceHead);

    const head = commit(workspace.path, 'MUST_EXIST', 'present\n');
    merge(f, session.id);
    await eventually(
      () => removed(f, workspace.id),
      () => f.control.tick(),
      10000,
    );
    expect(current(f, session.id).outcome).toBe('merged');
    expect(git(f.source, 'rev-parse', 'main')).toBe(head);
  },
);

it.skipIf(insideSandbox)(
  'runs the project gate, then the task acceptance, then the before-merge command steps',
  async () => {
    const f = await mergeFixture();
    setAcceptance(f, ['true']);
    const { session, workspace } = await taskSession(f);
    f.call('workflow.definition.set', {
      project_id: f.project.id,
      definition: {
        slots: {
          before_dispatch: [],
          before_merge: [
            {
              id: 'lint',
              title: 'Lint the answer',
              kind: { type: 'command', command: 'test -s answer.txt', timeout_seconds: 30 },
            },
          ],
          after_merge: [],
        },
        plan_review: { tiers: ['t3'] },
        review: { max_rounds: 3 },
      },
      base_version: 0,
    });
    const bound = current(f, session.id);
    f.store.update<Session>(
      'sessions',
      { ...bound, task: { ...bound.task!, definition_version: 1 } },
      bound.revision,
    );
    await f.call<Project>(
      'project.gate.set',
      {
        project_id: f.project.id,
        root: f.source,
        commands: [{ name: 'Passes', argv: [process.execPath, '-e', 'process.exit(0)'] }],
      },
      project(f).revision,
    );
    commit(workspace.path, 'answer.txt', 'gated\n');
    merge(f, session.id);
    await eventually(
      () => removed(f, workspace.id),
      () => f.control.tick(),
      10000,
    );
    expect(payloads(f, session.id, 'session.gate_checked')[0]!.results).toMatchObject([
      { name: 'Passes', exit_code: 0 },
      { name: 'true', exit_code: 0 },
      { name: 'lint: Lint the answer', exit_code: 0 },
    ]);
  },
);

it.skipIf(insideSandbox)('runs the task acceptance on what the project gate built', async () => {
  const f = await mergeFixture();
  setAcceptance(f, ['test -f built.txt']);
  const { session, workspace } = await taskSession(f);
  await f.call<Project>(
    'project.gate.set',
    {
      project_id: f.project.id,
      root: f.source,
      commands: [{ name: 'Build', argv: ['/bin/sh', '-c', 'echo ok > built.txt'] }],
    },
    project(f).revision,
  );
  const head = commit(workspace.path, 'answer.txt', 'built\n');
  merge(f, session.id);
  await eventually(
    () => removed(f, workspace.id) || current(f, session.id).merge?.state === 'blocked',
    () => f.control.tick(),
    10000,
  );
  expect(payloads(f, session.id, 'session.gate_checked')[0]!.results).toMatchObject([
    { name: 'Build', exit_code: 0 },
    { name: 'test -f built.txt', exit_code: 0 },
  ]);
  expect(current(f, session.id).outcome).toBe('merged');
  expect(git(f.source, 'rev-parse', 'main')).toBe(head);
});

it.skipIf(insideSandbox)(
  'merges automatically when the project gate is empty but the task has acceptance',
  async () => {
    const f = await mergeFixture();
    setAcceptance(f, ['test -f answer.txt']);
    const { session, workspace } = await taskSession(f);
    f.call<Project>(
      'project.autoMerge.set',
      { project_id: f.project.id, enabled: true },
      project(f).revision,
    );
    const head = commit(workspace.path, 'answer.txt', 'auto\n');
    f.call<SessionTurn>(
      'session.send',
      { session_id: session.id, input: 'Keep going' },
      current(f, session.id).revision,
    );
    await eventually(
      () => removed(f, workspace.id),
      () => f.control.tick(),
      10000,
    );
    expect(git(f.source, 'rev-parse', 'main')).toBe(head);
    expect(payloads(f, session.id, 'session.merge_started')).toEqual([{ auto: true }]);
  },
);
