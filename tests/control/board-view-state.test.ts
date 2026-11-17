import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type {
  Approval,
  BoardPlan,
  Principal,
  Project,
  Session,
  SessionTurn,
  Workspace,
} from '@pantheon/domain';
import {
  awaitWorkspaceReady,
  eventually,
  gateFolder,
  insideSandbox,
  settle,
  user,
} from '../helpers.js';
import { dispatchEveryTier, git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
type PlanTask = BoardPlan['tasks'][number];

const sessionOf = (f: Fixture, sessionId: string, role: 'lead' | 'worker'): Principal => ({
  id: `session:${sessionId}`,
  role,
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});

/** A goal the fixture runtime runs as a script. */
const script = (...steps: object[]) => `fixture-script\n${JSON.stringify(steps)}`;

const task = (id: string, fields: Partial<PlanTask> = {}): PlanTask => ({
  id,
  title: `Task ${id}`,
  goal: `Finish task ${id}`,
  lane: 'core',
  depends_on: [],
  source: ['Plan the export feature'],
  scope: [`src/${id}`],
  acceptance: ['pnpm test'],
  ...fields,
});

const reportTask = (id: string) => task(id, { done_when: 'report', scope: [], acceptance: [] });

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const planOf = (f: Fixture, leadId: string) => f.store.must<BoardPlan>('board_plans', leadId);
const sessionsOf = (f: Fixture, leadId: string, taskId: string) =>
  f.store
    .list<Session>('sessions')
    .filter((session) => session.task?.lead_session_id === leadId && session.task.id === taskId);
const rowOf = (f: Fixture, leadId: string, taskId: string) =>
  f.control.boardView(user, f.project.id, 1).tasks.find((row) => row.id === `${leadId}:${taskId}`)!;
const leadOf = (f: Fixture, leadId: string) =>
  f.control.boardView(user, f.project.id, 1).leads!.find((lead) => lead.session_id === leadId)!;

function patch(f: Fixture, sessionId: string, fields: Partial<Session>) {
  const session = current(f, sessionId);
  f.store.update<Session>('sessions', { ...session, ...fields }, session.revision);
}

async function leadWithPlan(f: Fixture, tasks: PlanTask[]) {
  dispatchEveryTier(f);
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks,
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    sessionOf(f, lead.id, 'lead'),
  );
  return lead;
}

const startTasks = (f: Fixture, leadId: string, taskIds: string[]) =>
  f.call(
    'task.start',
    { project_id: f.project.id, task_ids: taskIds },
    null,
    sessionOf(f, leadId, 'lead'),
  );

/** Starts the task and waits until its session's first turn ended. */
async function settledTask(f: Fixture, leadId: string, taskId: string) {
  startTasks(f, leadId, [taskId]);
  await f.control.tick();
  const [session] = sessionsOf(f, leadId, taskId);
  await settle(f, session!);
  return session!;
}

/** Commits a file in the session's worktree. */
function commit(f: Fixture, session: Session, name: string) {
  const worktree = f.store.must<Workspace>('workspaces', session.workspace_id!).path;
  mkdirSync(path.dirname(path.join(worktree, name)), { recursive: true });
  writeFileSync(path.join(worktree, name), `${name}\n`);
  git(worktree, 'add', '--', name);
  git(worktree, 'commit', '--quiet', '-m', `Add ${name}`);
}

const quoted = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** The git runs `run` makes, through a script on PATH that logs each run's arguments. */
function gitRuns(run: () => void): string[] {
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = mkdtempSync(path.join(process.cwd(), "node_modules/.cache/counting-git-'")),
    log = path.join(bin, 'runs.log');
  writeFileSync(log, '');
  writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quoted(log)}\nexec ${quoted(real)} "$@"\n`,
  );
  chmodSync(path.join(bin, 'git'), 0o755);
  execFileSync(path.join(bin, 'git'), ['--version']);
  expect(readFileSync(log, 'utf8')).toBe('--version\n');
  writeFileSync(log, '');
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}:${PATH}`;
  try {
    run();
    return readFileSync(log, 'utf8').split('\n').filter(Boolean);
  } finally {
    process.env.PATH = PATH;
    rmSync(bin, { recursive: true, force: true });
  }
}

const merge = (f: Fixture, sessionId: string) =>
  f.call<Session>('session.merge', { session_id: sessionId }, current(f, sessionId).revision);

it('shows a task never started as todo and a started task whose upstream is not done as waiting upstream', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [
    task('a', { goal: script({ hang: true }) }),
    task('b', { depends_on: ['a'] }),
    task('c'),
  ]);
  startTasks(f, lead.id, ['a', 'b']);
  await f.control.tick();
  expect(rowOf(f, lead.id, 'c')).toMatchObject({ state: 'todo' });
  expect(rowOf(f, lead.id, 'c').dispatch_wait).toBeUndefined();
  expect(rowOf(f, lead.id, 'b')).toMatchObject({
    state: 'waiting_upstream',
    dispatch_wait: 'upstream',
  });
});

it('shows a dispatched task as claimed until its first turn runs, then as running', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a', { goal: script({ hang: true }) })]);
  startTasks(f, lead.id, ['a']);
  await f.control.tick();
  const [session] = sessionsOf(f, lead.id, 'a');
  expect(f.turns(session!.id)[0]!.state).toBe('queued');
  expect(rowOf(f, lead.id, 'a')).toMatchObject({
    state: 'claimed',
    claim: { session_id: session!.id },
  });
  await awaitWorkspaceReady(f.control, session!.workspace_id!);
  await eventually(
    () => f.turns(session!.id)[0]!.state === 'running',
    () => f.control.tick(),
  );
  expect(rowOf(f, lead.id, 'a').state).toBe('running');
});

it('shows a task whose session asks the user as waiting approval', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [
    task('a', { goal: script({ ask: { tool: 'Bash', input: { command: 'pnpm test' } } }) }),
  ]);
  startTasks(f, lead.id, ['a']);
  await f.control.tick();
  const [session] = sessionsOf(f, lead.id, 'a');
  await awaitWorkspaceReady(f.control, session!.workspace_id!);
  await eventually(
    () =>
      f.store
        .list<Approval>('approvals')
        .some((approval) => approval.session_id === session!.id && approval.state === 'pending'),
    () => f.control.tick(),
  );
  expect(rowOf(f, lead.id, 'a').state).toBe('waiting_approval');
});

it('shows a task whose merge is blocked, or whose session is reconciling, as blocked', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a'), task('b')]);
  const blocked = await settledTask(f, lead.id, 'a');
  commit(f, blocked, 'README.md');
  await merge(f, blocked.id);
  await eventually(
    () => current(f, blocked.id).merge?.state === 'blocked',
    () => f.control.tick(),
    10000,
  );
  expect(current(f, blocked.id).merge?.reason).toBe('out_of_scope');
  expect(rowOf(f, lead.id, 'a').state).toBe('blocked');

  const reconciling = await settledTask(f, lead.id, 'b');
  await f.control.prefetchWorktreeReads(user, f.project.id);
  expect(rowOf(f, lead.id, 'b').state).toBe('needs_attention');
  patch(f, reconciling.id, { state: 'reconciling' });
  expect(rowOf(f, lead.id, 'b').state).toBe('blocked');
});

it('shows a task whose turn completed and whose session is ready but not merged as awaiting merge', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const session = await settledTask(f, lead.id, 'a');
  commit(f, session, 'src/a/x.ts');
  await f.control.prefetchWorktreeReads(user, f.project.id);
  expect(rowOf(f, lead.id, 'a')).toMatchObject({ state: 'awaiting_merge', status: 'ready' });
  expect(
    f.control.boardHistory(user, f.project.id).tasks.find((row) => row.id === `${lead.id}:a`)!
      .state,
  ).toBe('awaiting_merge');
});

it('shows the history of a task without running git when no list read its worktree', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const session = await settledTask(f, lead.id, 'a');
  commit(f, session, 'src/a/x.ts');
  let history: ReturnType<Fixture['control']['boardHistory']> | undefined;
  const runs = gitRuns(() => (history = f.control.boardHistory(user, f.project.id)));
  expect(runs).toEqual([]);
  expect(history!.tasks.find((row) => row.id === `${lead.id}:a`)!.state).toBe('running');
});

it('shows a task whose turn ended with no commit, or failed, as needing attention', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [
    task('a'),
    task('b', { goal: script({ fail: 'The build broke' }) }),
  ]);
  await settledTask(f, lead.id, 'a');
  await f.control.prefetchWorktreeReads(user, f.project.id);
  expect(rowOf(f, lead.id, 'a').state).toBe('needs_attention');
  const failing = await settledTask(f, lead.id, 'b');
  expect(f.turns(failing.id).map((turn) => turn.state)).toEqual(['failed']);
  await f.control.prefetchWorktreeReads(user, f.project.id);
  expect(rowOf(f, lead.id, 'b').state).toBe('needs_attention');
});

it('shows a parallel task whose workers all ended with nothing to merge as needing attention', async () => {
  const f = await workbenchFixture();
  const part = (name: string) => ({
    title: `Part ${name}`,
    goal: `Write part ${name}`,
    scope: [`src/p/${name}`],
    acceptance: ['true'],
  });
  const lead = await leadWithPlan(f, [
    task('p', {
      path: 'parallel',
      flow_reason: 'Two independent parts',
      parallel: [part('one'), part('two')],
    }),
  ]);
  startTasks(f, lead.id, ['p']);
  await f.control.tick();
  const workers = sessionsOf(f, lead.id, 'p');
  expect(workers).toHaveLength(2);
  for (const worker of workers) await settle(f, worker);
  await f.control.prefetchWorktreeReads(user, f.project.id);
  expect(rowOf(f, lead.id, 'p').state).toBe('needs_attention');
});

it('keeps a task running, not needing attention, while its worktree cannot be read', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const session = await settledTask(f, lead.id, 'a');
  const worktree = f.store.must<Workspace>('workspaces', session.workspace_id!).path;
  writeFileSync(path.join(worktree, '.git'), 'gitdir: /nonexistent/worktree/metadata\n');
  expect(rowOf(f, lead.id, 'a').state).toBe('running');
});

it.skipIf(insideSandbox)(
  'shows a task as gating while its merge runs, then merged with its retrospective',
  async () => {
    const f = await workbenchFixture();
    const lead = await leadWithPlan(f, [task('a', { acceptance: ['true'] })]);
    const session = await settledTask(f, lead.id, 'a');
    commit(f, session, 'src/a/x.ts');
    await merge(f, session.id);
    expect(rowOf(f, lead.id, 'a').state).toBe('gating');
    expect(rowOf(f, lead.id, 'a').retrospective).toBeUndefined();
    await eventually(
      () => current(f, session.id).outcome === 'merged',
      () => f.control.tick(),
      10000,
    );
    expect(rowOf(f, lead.id, 'a')).toMatchObject({ state: 'merged', done_by: 'merged' });
    // The record waits for the lead's wake about the merge to end.
    await eventually(
      () => rowOf(f, lead.id, 'a').retrospective !== undefined,
      () => f.control.tick(),
      10000,
    );
    expect(rowOf(f, lead.id, 'a').retrospective).toEqual({
      id: expect.any(String),
      outcome: 'merged',
      recorded_at: expect.any(Number),
      gate_passed_on_attempt: 1,
      handbacks: 0,
      lead_wakes: expect.any(Number),
      tokens: expect.any(Number),
    });
  },
);

it('shows a task as failed once its sessions closed without a merge, until it is started again', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const session = await settledTask(f, lead.id, 'a');
  f.call('session.discard', { session_id: session.id }, current(f, session.id).revision);
  await eventually(() => current(f, session.id).outcome === 'discarded');
  expect(rowOf(f, lead.id, 'a').state).toBe('failed');
  expect(rowOf(f, lead.id, 'a').claim).toBeUndefined();
  startTasks(f, lead.id, ['a']);
  expect(rowOf(f, lead.id, 'a').state).toBe('todo');
});

it.skipIf(insideSandbox)(
  'shows a direct task by its lead: running once claimed, blocked once its hand-backs ran out, then done',
  async () => {
    const f = await workbenchFixture();
    git(f.source, 'config', 'user.name', 'Source User');
    git(f.source, 'config', 'user.email', 'source@example.invalid');
    // Each run prints another line, so a hand-back never repeats the one before it; it passes once the marker exists.
    const gate = gateFolder(f.root),
      fixed = path.join(gate.dir, 'fixed');
    await f.call(
      'project.gate.set',
      {
        project_id: f.project.id,
        root: f.source,
        commands: [
          {
            name: 'Check',
            argv: gate.argv(
              `process.stderr.write(\`broke \${Date.now()}\`); process.exit(require('node:fs').existsSync(${JSON.stringify(fixed)}) ? 0 : 3)`,
            ),
          },
        ],
      },
      f.store.must<Project>('projects', f.project.id).revision,
    );
    f.call(
      'project.autoMerge.set',
      { project_id: f.project.id, enabled: true },
      f.store.must<Project>('projects', f.project.id).revision,
    );
    f.call('workflow.policy.set', { project_id: f.project.id, handback_limit: 2 }, null);
    const lead = await f.create('Plan the export feature');
    await settle(f, lead);
    f.call(
      'board.plan.update',
      {
        project_id: f.project.id,
        base_version: 0,
        headline: 'Export ships this week',
        lanes: [{ id: 'core', title: 'Core' }],
        tasks: [
          task('a', {
            scope: ['src/a.ts'],
            acceptance: ['true'],
            kind: { domain: 'backend-logic', tier: 't1' },
          }),
        ],
        milestones: [],
        risks: [],
        assumptions: [],
      },
      null,
      sessionOf(f, lead.id, 'lead'),
    );
    startTasks(f, lead.id, ['a']);
    expect(current(f, lead.id).direct_task?.id).toBe('a');

    expect(rowOf(f, lead.id, 'a').status).not.toBe('todo');
    expect(rowOf(f, lead.id, 'a')).toMatchObject({
      state: 'running',
      claim: { session_id: lead.id },
    });

    commit(f, lead, 'src/a.ts');
    await f.call(
      'task.report',
      { project_id: f.project.id, kind: 'done', text: 'Task a is done' },
      null,
      sessionOf(f, lead.id, 'lead'),
    );
    f.call('session.send', { session_id: lead.id, input: 'Go on' }, current(f, lead.id).revision);
    const quiet = () =>
      current(f, lead.id).state === 'open' &&
      current(f, lead.id).merge?.state !== 'running' &&
      f.turns(lead.id).every((turn) => !['queued', 'running'].includes(turn.state));
    for (let ticks = 0; ticks < 3;) {
      await eventually(quiet, () => f.control.tick(), 15000);
      await f.control.tick();
      ticks = quiet() ? ticks + 1 : 0;
    }
    expect(current(f, lead.id).merge).toMatchObject({ state: 'blocked', reason: 'gate_failed' });
    expect(rowOf(f, lead.id, 'a')).toMatchObject({
      state: 'blocked',
      claim: { session_id: lead.id },
    });

    writeFileSync(fixed, '');
    await merge(f, lead.id);
    await eventually(
      () => planOf(f, lead.id).direct_merged?.a !== undefined,
      () => f.control.tick(),
      10000,
    );
    expect(rowOf(f, lead.id, 'a')).toMatchObject({ status: 'done', state: 'merged' });
  },
  30000,
);

it('shows an accepted report task as merged, done by its acceptance', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [reportTask('a')]);
  const worker = await settledTask(f, lead.id, 'a');
  await f.call(
    'task.report',
    { project_id: f.project.id, kind: 'done', text: 'Task a is answered' },
    null,
    sessionOf(f, worker.id, 'worker'),
  );
  await settle(f, current(f, lead.id));
  f.call(
    'task.accept',
    { project_id: f.project.id, task_id: 'a', evidence: 'The report answers the goal' },
    null,
    sessionOf(f, lead.id, 'lead'),
  );
  expect(rowOf(f, lead.id, 'a')).toMatchObject({ state: 'merged', done_by: 'accepted' });
});

it('shows a report task whose session reported done as awaiting acceptance until it runs again or is accepted', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [reportTask('a'), task('b')]);
  const worker = await settledTask(f, lead.id, 'a');
  const reportDone = (sessionId: string, text: string) =>
    f.call(
      'task.report',
      { project_id: f.project.id, kind: 'done', text },
      null,
      sessionOf(f, sessionId, 'worker'),
    );
  await reportDone(worker.id, 'Task a is answered');
  await settle(f, current(f, lead.id));
  expect(rowOf(f, lead.id, 'a').state).toBe('awaiting_acceptance');
  f.call(
    'task.message',
    { project_id: f.project.id, task_id: 'a', text: 'Add the sources' },
    null,
    sessionOf(f, lead.id, 'lead'),
  );
  expect(rowOf(f, lead.id, 'a').state).toBe('running');
  await settle(f, current(f, worker.id));
  expect(rowOf(f, lead.id, 'a').state).toBe('awaiting_acceptance');
  f.call(
    'task.accept',
    { project_id: f.project.id, task_id: 'a', evidence: 'The report answers the goal' },
    null,
    sessionOf(f, lead.id, 'lead'),
  );
  expect(rowOf(f, lead.id, 'a')).toMatchObject({ state: 'merged', done_by: 'accepted' });

  const merging = await settledTask(f, lead.id, 'b');
  await reportDone(merging.id, 'Task b is done');
  await settle(f, current(f, lead.id));
  await f.control.prefetchWorktreeReads(user, f.project.id);
  expect(rowOf(f, lead.id, 'b').state).toBe('needs_attention');
});

const DAY = 24 * 60 * 60 * 1000;

const dayKey = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Starts the report task, has its worker report done and the lead accept it. */
async function acceptedReportTask(f: Fixture, leadId: string, taskId: string) {
  const worker = await settledTask(f, leadId, taskId);
  await f.call(
    'task.report',
    { project_id: f.project.id, kind: 'done', text: `Task ${taskId} is answered` },
    null,
    sessionOf(f, worker.id, 'worker'),
  );
  await settle(f, current(f, leadId));
  f.call(
    'task.accept',
    { project_id: f.project.id, task_id: taskId, evidence: 'The report answers the goal' },
    null,
    sessionOf(f, leadId, 'lead'),
  );
  return worker;
}

it('counts a report task done on the day it was accepted after the plan removes it', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [reportTask('a'), task('b')]);
  await acceptedReportTask(f, lead.id, 'a');
  const earlier = f.store.now() - 2 * DAY;
  f.store.db.prepare('UPDATE events SET created_at=?').run(earlier);
  const plan = planOf(f, lead.id);
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: plan.plan_version,
      headline: plan.headline,
      lanes: plan.lanes,
      tasks: plan.tasks.filter((each) => each.id !== 'a'),
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    sessionOf(f, lead.id, 'lead'),
  );
  const daily = f.control.boardView(user, f.project.id, 3).task_progress.daily;
  expect(daily.find((day) => day.day === dayKey(earlier))).toMatchObject({ scope: 2, done: 1 });
});

it('leaves out an accepted report task whose worker stays open once it was accepted before the range', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [reportTask('a')]);
  const worker = await acceptedReportTask(f, lead.id, 'a');
  expect(current(f, worker.id).state).not.toBe('closed');
  const plan = planOf(f, lead.id);
  f.store.update<BoardPlan>(
    'board_plans',
    { ...plan, accepted: { a: { ...plan.accepted!.a!, at: f.store.now() - 3 * DAY } } },
    plan.revision,
  );
  const board = f.control.boardView(user, f.project.id, 1);
  expect(board.tasks.some((row) => row.id === `${lead.id}:a`)).toBe(false);
});

it('keeps a report task whose worker merged before acceptance unfinished, with its dependents unmet', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [reportTask('a'), task('b', { depends_on: ['a'] })]);
  const worker = await settledTask(f, lead.id, 'a');
  patch(f, worker.id, { state: 'closed', outcome: 'merged' });
  f.store.event('session.merged', current(f, worker.id), f.project.id, { to_sha: '0'.repeat(40) });
  const board = f.control.boardView(user, f.project.id, 1);
  expect(board.tasks.find((row) => row.id === `${lead.id}:a`)!.status).not.toBe('done');
  expect(board.edges.find((edge) => edge.from === `${lead.id}:a`)!.state).not.toBe('met');
});

it('names the scope and capacity waits of queued tasks', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [
    task('a', { goal: script({ hang: true }), scope: ['src/a'] }),
    task('b', { scope: ['src/a/b.ts'] }),
    task('c', { goal: script({ hang: true }) }),
    task('d', { goal: script({ hang: true }) }),
    task('e'),
  ]);
  startTasks(f, lead.id, ['a', 'b', 'c', 'd', 'e']);
  await f.control.tick();
  expect(rowOf(f, lead.id, 'b')).toMatchObject({ state: 'todo', dispatch_wait: 'scope' });
  expect(rowOf(f, lead.id, 'e')).toMatchObject({ state: 'todo', dispatch_wait: 'capacity' });
  expect(rowOf(f, lead.id, 'b').blockers).toContain('Queued: waiting for the scope to free up');
});

it('names the retry wait of a task whose session failed to open', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  startTasks(f, lead.id, ['a']);
  const plan = planOf(f, lead.id);
  f.store.update<BoardPlan>(
    'board_plans',
    { ...plan, tasks: plan.tasks.map((each) => ({ ...each, runtime: 'missing-runtime' })) },
    plan.revision,
  );
  await f.control.tick();
  expect(planOf(f, lead.id).dispatch!.a!.error).toBeDefined();
  expect(rowOf(f, lead.id, 'a')).toMatchObject({ state: 'todo', dispatch_wait: 'retry' });
});

it('returns what the plan chose and what the claiming session runs, even when they differ', async () => {
  const f = await workbenchFixture();
  const second = new FixtureAdapter();
  second.name = 'second';
  f.control.adapters.set(second.name, second);
  const lead = await leadWithPlan(f, [
    task('a', {
      goal: script({ hang: true }),
      runtime: second.name,
      model: 'fixture-large',
      effort: 'high',
      kind: { domain: 'review', tier: 't2' },
      route_reason: 'The review needs the larger model',
      priority: 'high',
    }),
    task('b'),
  ]);
  // The daemon fills in the kind of a task from its scope.
  expect(rowOf(f, lead.id, 'b').planned).toEqual({ kind: { domain: 'backend-logic', tier: 't2' } });
  startTasks(f, lead.id, ['a']);
  await f.control.tick();
  const [session] = sessionsOf(f, lead.id, 'a');
  patch(f, session!.id, { reported_model: 'fixture-small' });
  expect(rowOf(f, lead.id, 'a')).toMatchObject({
    planned: {
      runtime: second.name,
      model: 'fixture-large',
      effort: 'high',
      kind: { domain: 'review', tier: 't2' },
      route_reason: 'The review needs the larger model',
      priority: 'high',
    },
    claim: {
      session_id: session!.id,
      runtime: second.name,
      model: 'fixture-small',
      effort: 'high',
    },
  });
});

it('lists a user edit of a running task as pending on its lead and its task until the lead resolves it', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a', { goal: script({ hang: true }) }), task('b')]);
  startTasks(f, lead.id, ['a']);
  await f.control.tick();
  const version = planOf(f, lead.id).plan_version;
  expect(leadOf(f, lead.id)).toMatchObject({ plan_version: version, pending_edits: [] });
  expect(rowOf(f, lead.id, 'a').pending_edit).toBe(false);
  const { edit_id, applied } = f.call<{ edit_id: string; applied: boolean }>(
    'board.plan.edit',
    {
      project_id: f.project.id,
      lead_session_id: lead.id,
      base_version: version,
      ops: [{ type: 'set_task', task_id: 'a', patch: { model: 'fixture-large' } }],
    },
    null,
    user,
  );
  expect(applied).toBe(false);
  expect(leadOf(f, lead.id).pending_edits).toEqual([
    {
      id: edit_id,
      task_ids: ['a'],
      summary: 'set_task a',
      state: 'pending',
      ops: [{ type: 'set_task', task_id: 'a', patch: { model: 'fixture-large' } }],
      base_version: version,
      created_at: expect.any(Number),
    },
  ]);
  expect(rowOf(f, lead.id, 'a').pending_edit).toBe(true);
  expect(rowOf(f, lead.id, 'b').pending_edit).toBe(false);

  f.call(
    'board.plan.edit',
    {
      project_id: f.project.id,
      base_version: planOf(f, lead.id).plan_version,
      ops: [{ type: 'resolve_edit', edit_id, decision: 'reject' }],
    },
    null,
    sessionOf(f, lead.id, 'lead'),
  );
  expect(leadOf(f, lead.id).pending_edits).toEqual([]);
  expect(rowOf(f, lead.id, 'a').pending_edit).toBe(false);
});

/** A parallel task of two parts whose workers both ended their first turn, oldest first. */
async function parallelWorkers(f: Fixture) {
  const part = (name: string) => ({
    title: `Part ${name}`,
    goal: `Write part ${name}`,
    scope: [`src/p/${name}`],
    acceptance: ['true'],
  });
  const lead = await leadWithPlan(f, [
    task('p', {
      path: 'parallel',
      flow_reason: 'Two independent parts',
      parallel: [part('one'), part('two')],
    }),
  ]);
  startTasks(f, lead.id, ['p']);
  await f.control.tick();
  const workers = sessionsOf(f, lead.id, 'p');
  expect(workers).toHaveLength(2);
  for (const worker of workers) await settle(f, worker);
  return { lead, workers };
}

/** Records a merge of the session without running one. */
function markMerged(f: Fixture, sessionId: string) {
  patch(f, sessionId, { state: 'closed', outcome: 'merged' });
  f.store.event('session.merged', current(f, sessionId), f.project.id, { to_sha: 'merged-sha' });
}

it('shows a parallel task as failed once one part merged and the other closed unmerged with no retry queued', async () => {
  const f = await workbenchFixture();
  const { lead, workers } = await parallelWorkers(f);
  markMerged(f, workers[0]!.id);
  patch(f, workers[1]!.id, { state: 'closed' });
  expect(rowOf(f, lead.id, 'p').state).toBe('failed');
});

it('counts a parallel task done in the daily trend only once every part merged', async () => {
  const f = await workbenchFixture();
  const { lead, workers } = await parallelWorkers(f);
  markMerged(f, workers[0]!.id);
  const board = () => f.control.boardView(user, f.project.id, 1);
  expect(rowOf(f, lead.id, 'p').state).not.toBe('merged');
  expect(board().task_progress.daily.at(-1)).toMatchObject({ scope: 1, done: 0 });
  markMerged(f, workers[1]!.id);
  expect(rowOf(f, lead.id, 'p').state).toBe('merged');
  expect(board().task_progress.daily.at(-1)).toMatchObject({ scope: 1, done: 1 });
});

it('counts a parallel task by all its parts and keeps the blockers of a part that is not the newest', async () => {
  const f = await workbenchFixture();
  const { lead, workers } = await parallelWorkers(f);
  const turnState = (sessionId: string, state: SessionTurn['state']) => {
    const turn = f.turns(sessionId).at(-1)!;
    f.store.update<SessionTurn>('session_turns', { ...turn, state }, turn.revision);
  };
  for (const troubled of workers) {
    patch(f, troubled.id, {
      merge: { state: 'blocked', reason: 'conflict', conflicts: ['src/p/x.ts'] },
    });
    turnState(troubled.id, 'failed');
    const board = f.control.boardView(user, f.project.id, 1),
      row = board.tasks.find((each) => each.id === `${lead.id}:p`)!;
    expect(row.status, troubled.id).toBe('failed');
    expect(board.task_progress.totals, troubled.id).toMatchObject({ failed: 1, idle: 0 });
    expect(
      row.blocker_codes!.map((code) => code.code),
      troubled.id,
    ).toEqual(['merge_blocked', 'turn_failed']);
    patch(f, troubled.id, { merge: undefined });
    turnState(troubled.id, 'completed');
  }
});
