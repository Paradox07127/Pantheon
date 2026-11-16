import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type {
  BoardPlan,
  Principal,
  Project,
  ProjectRead,
  Session,
  SessionTurn,
} from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, insideSandbox, settle, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = ReturnType<typeof workbenchFixture>;
type PlanTask = BoardPlan['tasks'][number];

const sessionOf = (f: Fixture, sessionId: string, role: 'lead' | 'worker'): Principal => ({
  id: `session:${sessionId}`,
  role,
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});

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

const writePlan = (
  f: Fixture,
  leadId: string,
  tasks: PlanTask[],
  milestones: { id: string; title: string; criteria: string[]; tasks: string[] }[] = [],
) =>
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: f.store.get<BoardPlan>('board_plans', leadId)?.plan_version ?? 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks,
      milestones,
      risks: [],
      assumptions: [],
    },
    null,
    sessionOf(f, leadId, 'lead'),
  );

const openTask = (f: Fixture, leadId: string, taskId: string) =>
  f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Build it',
    task_id: `${leadId}:${taskId}`,
  });

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const planOf = (f: Fixture, leadId: string) => f.store.must<BoardPlan>('board_plans', leadId);
const fromTracker = (f: Fixture, sessionId: string) =>
  f.turns(sessionId).filter((turn) => turn.origin === 'tracker');

/** Records that the daemon, not the user, started the session's merge. */
function startedAutomatically(f: Fixture, sessionId: string) {
  const session = current(f, sessionId);
  f.store.event('session.merge_started', session, session.project_id, { auto: true }, '');
}

function patch(f: Fixture, sessionId: string, fields: Partial<Session>) {
  const session = current(f, sessionId);
  f.store.update<Session>('sessions', { ...session, ...fields }, session.revision);
}

async function leadWithPlan(f: Fixture, tasks: PlanTask[]) {
  const lead = f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(f, lead.id, tasks);
  return lead;
}

/** Runs the store clock ahead of the wall clock; returns how to move it further. */
function skewedClock(f: Fixture) {
  let skew = 0;
  vi.spyOn(f.store, 'now').mockImplementation(() => Date.now() + skew);
  return (ms: number) => {
    skew += ms;
  };
}

const project = (f: Fixture) => f.store.must<Project>('projects', f.project.id);
const passingGate = [{ name: 'Passes', argv: [process.execPath, '-e', 'process.exit(0)'] }];

function mergeAutomatically(f: Fixture) {
  f.call(
    'project.gate.set',
    { project_id: f.project.id, root: f.source, commands: passingGate },
    project(f).revision,
  );
  f.call('project.autoMerge.set', { project_id: f.project.id, enabled: true }, project(f).revision);
}

const gateOutput = Array.from({ length: 25 }, (_, index) => `gate line ${index + 1}`).join('\n');

it.each([
  {
    reason: 'rebase_conflict',
    merge: { conflicts: ['src/a/export.ts', 'src/a/format.ts'] },
    says: [
      'rebase conflict',
      'Rebase this worktree onto',
      '- src/a/export.ts',
      '- src/a/format.ts',
    ],
  },
  {
    reason: 'gate_failed',
    merge: { gate: { name: 'Unit tests', output: gateOutput } },
    says: ['"Unit tests"', 'The last 20 lines of its output:', 'gate line 6\n', 'gate line 25'],
  },
  {
    reason: 'uncommitted_changes',
    merge: {},
    says: ['uncommitted or untracked files', 'Commit them or delete them'],
  },
])(
  'hands a merge blocked by $reason back to the task session once, then tells the lead',
  async ({ reason, merge, says }) => {
    const f = workbenchFixture();
    const lead = await leadWithPlan(f, [task('a')]);
    const worker = openTask(f, lead.id, 'a');
    await settle(f, worker);

    startedAutomatically(f, worker.id);
    patch(f, worker.id, { merge: { state: 'blocked', reason, ...merge } });
    await f.control.tick();
    const [handed] = fromTracker(f, worker.id);
    expect(fromTracker(f, worker.id)).toHaveLength(1);
    expect(handed!.input.startsWith('[Pantheon] ')).toBe(true);
    expect(handed!.causal_depth).toBe(1);
    for (const text of says) expect(handed!.input).toContain(text);
    if (reason === 'gate_failed') expect(handed!.input).not.toContain('gate line 5\n');
    expect(current(f, worker.id).merge).toBeUndefined();
    expect(fromTracker(f, lead.id)).toEqual([]);
    expect(planOf(f, lead.id).handed_back).toEqual({ [worker.id]: [reason] });
    await settle(f, worker);

    startedAutomatically(f, worker.id);
    patch(f, worker.id, { merge: { state: 'blocked', reason, ...merge } });
    await f.control.tick();
    expect(fromTracker(f, worker.id)).toHaveLength(1);
    const [wake] = fromTracker(f, lead.id);
    expect(wake!.input).toContain(
      `: blocked: The merge of the session is blocked. Reason: ${reason}`,
    );
    expect(planOf(f, lead.id).notified).toEqual({ [worker.id]: 'blocked' });
  },
);

it('tells the lead at once, without a hand-back, when a merge the user started is blocked', async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const worker = openTask(f, lead.id, 'a');
  await settle(f, worker);

  patch(f, worker.id, { merge: { state: 'blocked', reason: 'gate_failed' } });
  await f.control.tick();
  expect(fromTracker(f, worker.id)).toEqual([]);
  expect(fromTracker(f, lead.id)[0]!.input).toContain('Reason: gate_failed');
});

it('hands a turn without commits back once, then tells the lead of the second', async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  mergeAutomatically(f);
  const worker = openTask(f, lead.id, 'a');
  await eventually(
    () => fromTracker(f, lead.id).length > 0,
    () => f.control.tick(),
  );
  await settle(f, worker);
  for (let i = 0; i < 3; i++) await f.control.tick();

  const handed = fromTracker(f, worker.id);
  expect(handed).toHaveLength(1);
  expect(handed[0]!.input).toBe(
    '[Pantheon] Your turn ended without commits to merge. Commit your changes, or use report to explain why there are none.',
  );
  expect(planOf(f, lead.id).handed_back).toEqual({ [worker.id]: ['no_changes'] });
  const wakes = fromTracker(f, lead.id);
  expect(wakes).toHaveLength(1);
  expect(wakes[0]!.input).toContain(': no_changes: ');
  expect(planOf(f, lead.id).notified).toEqual({ [worker.id]: 'no_changes' });
});

it('waits for the lead instead of handing back a turn without commits that reported a requirement', async () => {
  const f = workbenchFixture({ delay: 400 });
  const lead = await leadWithPlan(f, [task('a')]);
  mergeAutomatically(f);
  const worker = openTask(f, lead.id, 'a');
  await awaitWorkspaceReady(f.control, worker.workspace_id!);
  await eventually(
    () => f.turns(worker.id)[0]?.state === 'running',
    () => f.control.tick(),
  );
  f.call(
    'task.report',
    { project_id: f.project.id, kind: 'requirement', text: 'Which delimiter should the CSV use?' },
    null,
    sessionOf(f, worker.id, 'worker'),
  );
  await settle(f, worker);
  for (let i = 0; i < 3; i++) await f.control.tick();
  expect(fromTracker(f, worker.id)).toEqual([]);

  f.call(
    'task.message',
    { project_id: f.project.id, task_id: 'a', text: 'Use a comma' },
    null,
    sessionOf(f, lead.id, 'lead'),
  );
  await settle(f, worker);
  for (let i = 0; i < 3; i++) await f.control.tick();
  const handed = fromTracker(f, worker.id);
  expect(handed).toHaveLength(1);
  expect(handed[0]!.input).toContain('Your turn ended without commits to merge.');
});

it('does not hand back a report task whose turn ends without commits', async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [
    task('r', { done_when: 'report', scope: [], acceptance: [] }),
  ]);
  mergeAutomatically(f);
  const worker = openTask(f, lead.id, 'r');
  await settle(f, worker);
  for (let i = 0; i < 3; i++) await f.control.tick();
  expect(fromTracker(f, worker.id)).toEqual([]);
  expect(fromTracker(f, lead.id)).toEqual([]);
});

it.skipIf(insideSandbox)('merges automatically once the handed back turn commits', async () => {
  const f = workbenchFixture({ delay: 1500 });
  git(f.source, 'config', 'user.name', 'Source User');
  git(f.source, 'config', 'user.email', 'source@example.invalid');
  // The merge gate runs the task's acceptance commands too.
  const lead = await leadWithPlan(f, [task('a', { acceptance: ['true'], scope: ['answer.txt'] })]);
  mergeAutomatically(f);
  const worker = openTask(f, lead.id, 'a');
  const workspace = await awaitWorkspaceReady(f.control, worker.workspace_id!);
  await eventually(
    () => fromTracker(f, worker.id).length === 1,
    () => f.control.tick(),
    10000,
  );
  writeFileSync(path.join(workspace.path, 'answer.txt'), 'fixed\n');
  git(workspace.path, 'add', '--', 'answer.txt');
  git(workspace.path, 'commit', '--quiet', '-m', 'Fix the answer');
  const head = git(workspace.path, 'rev-parse', 'HEAD');

  await eventually(
    () => current(f, worker.id).outcome === 'merged',
    () => f.control.tick(),
    20000,
  );
  expect(git(f.source, 'rev-parse', 'main')).toBe(head);
  expect(fromTracker(f, worker.id)).toHaveLength(1);
});

/** A task session whose first turn runs for longer than the test. */
async function runningWorker(f: Fixture, leadId: string) {
  (f.adapter as { delay: number }).delay = 60000;
  const worker = openTask(f, leadId, 'a');
  await awaitWorkspaceReady(f.control, worker.workspace_id!);
  await eventually(
    () => f.turns(worker.id)[0]?.state === 'running',
    () => f.control.tick(),
  );
  return { worker, turn: f.turns(worker.id)[0]! };
}

const toolEvent = (
  f: Fixture,
  worker: Session,
  turn: SessionTurn,
  kind: 'started' | 'completed',
  fields: Record<string, unknown>,
) =>
  f.store.event(`agent.tool.${kind}`, current(f, worker.id), f.project.id, {
    turn_id: turn.id,
    ...fields,
  });

it('tells the lead once when a running turn makes no progress for ten minutes', async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const advance = skewedClock(f);
  const { worker, turn } = await runningWorker(f, lead.id);

  advance(9 * 60_000);
  await f.control.tick();
  expect(fromTracker(f, lead.id)).toEqual([]);
  advance(2 * 60_000);
  // An idle lead's process is released after a while, so it takes the wake on a later tick.
  await eventually(
    () => fromTracker(f, lead.id).length > 0,
    () => f.control.tick(),
  );
  await f.control.tick();
  const wakes = fromTracker(f, lead.id);
  expect(wakes).toHaveLength(1);
  expect(wakes[0]!.input).toContain(
    ': stalled: The running turn of the session makes no progress. No progress for 11 minutes',
  );
  expect(planOf(f, lead.id).alerted).toEqual({ [turn.id]: ['stalled'] });
  expect(current(f, worker.id).state).toBe('running');
});

it('does not call a turn stalled while a tool call is under way', async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const advance = skewedClock(f);
  const { worker, turn } = await runningWorker(f, lead.id);
  toolEvent(f, worker, turn, 'started', { tool_call_id: 'build', name: 'Bash', input: {} });

  // Open past three stall windows, a call has hung.
  advance(29 * 60_000);
  await f.control.tick();
  expect(fromTracker(f, lead.id)).toEqual([]);
  expect(planOf(f, lead.id).alerted?.[turn.id]).toBeUndefined();
});

it('tells the lead once when the same tool call fails three times in a row', async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const { worker, turn } = await runningWorker(f, lead.id);
  const fail = (id: string, input: unknown) => {
    toolEvent(f, worker, turn, 'started', { tool_call_id: id, name: 'Bash', input });
    toolEvent(f, worker, turn, 'completed', { tool_call_id: id, ok: false, output: 'exit 1' });
  };

  fail('first', { command: 'pnpm test' });
  fail('second', { command: 'pnpm build' });
  fail('third', { command: 'pnpm test' });
  await f.control.tick();
  expect(fromTracker(f, lead.id)).toEqual([]);

  fail('fourth', { command: 'pnpm test' });
  await f.control.tick();
  expect(fromTracker(f, lead.id)).toEqual([]);
  fail('fifth', { command: 'pnpm test' });
  await f.control.tick();
  fail('sixth', { command: 'pnpm test' });
  await f.control.tick();
  const wakes = fromTracker(f, lead.id);
  expect(wakes).toHaveLength(1);
  expect(wakes[0]!.input).toContain(
    ': looping: The running turn of the session repeats a failing tool call. Its last 3 calls of Bash failed, each with the input {"command":"pnpm test"}.',
  );
});

it('wakes the lead once for merges within thirty seconds of the first', async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [task('a'), task('b')]);
  const first = openTask(f, lead.id, 'a'),
    second = openTask(f, lead.id, 'b');
  await settle(f, first);
  await settle(f, second);
  const advance = skewedClock(f);

  // The second session's merge runs, so the first merge waits for it.
  patch(f, second.id, { merge: { state: 'running' } });
  patch(f, first.id, { state: 'closed', outcome: 'merged' });
  await f.control.tick();
  advance(20_000);
  await f.control.tick();
  expect(fromTracker(f, lead.id)).toEqual([]);

  patch(f, second.id, { state: 'closed', outcome: 'merged', merge: undefined });
  await f.control.tick();
  advance(10_000);
  await f.control.tick();
  const wakes = fromTracker(f, lead.id);
  expect(wakes).toHaveLength(1);
  expect(wakes[0]!.input).toContain('Task a');
  expect(wakes[0]!.input).toContain('Task b');
});

it('wakes the lead at once when a merge is blocked while merges wait', async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [task('a'), task('b')]);
  const merged = openTask(f, lead.id, 'a'),
    blocked = openTask(f, lead.id, 'b');
  await settle(f, merged);
  await settle(f, blocked);
  skewedClock(f);

  // The other session's merge runs, so the merge waits for it.
  patch(f, blocked.id, { merge: { state: 'running' } });
  patch(f, merged.id, { state: 'closed', outcome: 'merged' });
  await f.control.tick();
  expect(fromTracker(f, lead.id)).toEqual([]);
  patch(f, blocked.id, { merge: { state: 'blocked', reason: 'local_changes' } });
  await f.control.tick();
  const wakes = fromTracker(f, lead.id);
  expect(wakes).toHaveLength(1);
  expect(wakes[0]!.input).toContain(': merged: ');
  expect(wakes[0]!.input).toContain(': blocked: ');
});

const acceptTask = (f: Fixture, leadId: string, taskId: string) =>
  f.call(
    'task.accept',
    { project_id: f.project.id, task_id: taskId, evidence: 'The report names the export format' },
    null,
    sessionOf(f, leadId, 'lead'),
  );

it('makes a report task done when its lead accepts the done report, so its milestone can be accepted', async () => {
  const f = workbenchFixture();
  const lead = f.create('Plan the export feature');
  await settle(f, lead);
  const research = task('r', {
    done_when: 'report',
    scope: [],
    acceptance: [],
    milestone: 'm1',
  });
  const milestones = [{ id: 'm1', title: 'Format chosen', criteria: ['A format'], tasks: ['r'] }];
  writePlan(f, lead.id, [research], milestones);
  const worker = openTask(f, lead.id, 'r');
  await settle(f, worker);
  expect(() => acceptTask(f, lead.id, 'r')).toThrow(
    expect.objectContaining({ code: 'invalid_state' }),
  );

  f.call(
    'task.report',
    { project_id: f.project.id, kind: 'done', text: 'Use CSV with a header row' },
    null,
    sessionOf(f, worker.id, 'worker'),
  );
  const [wake] = fromTracker(f, lead.id);
  expect(wake!.input).toContain(': done: Use CSV with a header row');
  await settle(f, lead);

  expect(acceptTask(f, lead.id, 'r')).toMatchObject({ id: 'r', state: 'done' });
  expect(planOf(f, lead.id).accepted).toEqual({
    r: { at: expect.any(Number), evidence: 'The report names the export format', generation: 1 },
  });
  writePlan(f, lead.id, [research], milestones);
  expect(Object.keys(planOf(f, lead.id).accepted!)).toEqual(['r']);
  const read = f.control.projectRead(user, f.project.id) as ProjectRead;
  expect(read.milestones.find((view) => view.milestone.key === 'm1')).toMatchObject({
    status: 'ready_for_acceptance',
    tasks: { done: 1, total: 1 },
    reasons: [],
  });
  expect(current(f, worker.id).outcome).toBeUndefined();
});

it('refuses to accept a task that is done when merged, even after a done report', async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const worker = openTask(f, lead.id, 'a');
  await settle(f, worker);
  f.call(
    'task.report',
    { project_id: f.project.id, kind: 'done', text: 'I think the export works' },
    null,
    sessionOf(f, worker.id, 'worker'),
  );
  // Without commits and with auto-merge off, the lead hears that nothing merges the session.
  expect(fromTracker(f, lead.id)[0]!.input).toContain('Commits since it started: 0');
  expect(() => acceptTask(f, lead.id, 'a')).toThrow(
    expect.objectContaining({ code: 'invalid_state' }),
  );
  expect(planOf(f, lead.id).accepted).toBeUndefined();
});

it('lets only report tasks leave scope and acceptance empty', async () => {
  const f = workbenchFixture();
  const lead = f.create('Plan the export feature');
  await settle(f, lead);
  expect(() => writePlan(f, lead.id, [task('a', { scope: [] })])).toThrow();
  expect(() => writePlan(f, lead.id, [task('a', { acceptance: [] })])).toThrow();
  expect(() =>
    writePlan(f, lead.id, [task('a', { done_when: 'report', scope: [], acceptance: [] })]),
  ).not.toThrow();
});
