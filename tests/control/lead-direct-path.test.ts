import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import type {
  BoardPlan,
  Principal,
  Project,
  ProjectRead,
  Retrospective,
  Session,
  SessionTurn,
  WorkflowPolicy,
  Workspace,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { improvementSignals } from '../../packages/control/dist/improvement-signals.js';
import { eventually, gateFolder, insideSandbox, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
type PlanTask = BoardPlan['tasks'][number];
type PlanMilestone = { id: string; title: string; criteria: string[]; tasks: string[] };

async function mergeFixture() {
  const f = await workbenchFixture();
  git(f.source, 'config', 'user.name', 'Source User');
  git(f.source, 'config', 'user.email', 'source@example.invalid');
  return f;
}

const leadOf = (f: Fixture, sessionId: string): Principal => ({
  id: `session:${sessionId}`,
  role: 'lead',
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
  scope: [`src/${id}.ts`],
  acceptance: ['test -d src'],
  kind: { domain: 'backend-logic', tier: 't1' },
  ...fields,
});

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const planOf = (f: Fixture, leadId: string) => f.store.must<BoardPlan>('board_plans', leadId);
const worktreeOf = (f: Fixture, session: Session) =>
  f.store.must<Workspace>('workspaces', session.workspace_id!);
const project = (f: Fixture) => f.store.must<Project>('projects', f.project.id);
const payloads = (f: Fixture, aggregateId: string, kind: string) =>
  (
    f.store.db
      .prepare('SELECT payload FROM events WHERE aggregate_id=? AND kind=? ORDER BY sequence')
      .all(aggregateId, kind) as { payload: string }[]
  ).map((row) => JSON.parse(row.payload) as Record<string, unknown>);
const trackerTurns = (f: Fixture, sessionId: string) =>
  f.turns(sessionId).filter((turn) => turn.origin === 'tracker');
const boardTask = (f: Fixture, leadId: string, taskId: string) =>
  f.control.boardView(user, f.project.id, 1).tasks.find((row) => row.id === `${leadId}:${taskId}`)!;

const passing = [{ name: 'Passes', argv: [process.execPath, '-e', 'process.exit(0)'] }];
// Each run prints another line, so a hand-back never repeats the one before it.
const failing = [
  {
    name: 'Always fails',
    argv: [process.execPath, '-e', 'process.stderr.write(`broke ${Date.now()}`); process.exit(3)'],
  },
];
const slow = [{ name: 'Slow', argv: [process.execPath, '-e', 'setTimeout(() => {}, 4000)'] }];
/** Fails until the test writes the marker file; the gate itself may not write outside the worktree. */
const failsUntilFixed = (gate: ReturnType<typeof gateFolder>, marker: string) => [
  {
    name: 'Fails until fixed',
    argv: gate.argv(
      `process.exit(require('node:fs').existsSync(${JSON.stringify(marker)}) ? 0 : 3)`,
    ),
  },
];

/** Waits for the retrospective of the lead's task, which waits for the lead's wake about it. */
async function recordOf(f: Fixture, leadId: string, taskId: string) {
  const find = () =>
    f.store
      .list<Retrospective>('retrospectives')
      .find((row) => row.lead_session_id === leadId && row.task_id === taskId);
  await eventually(
    () => !!find(),
    () => f.control.tick(),
    15000,
  );
  return find()!;
}

async function setGate(f: Fixture, commands: { name: string; argv: string[] }[]) {
  await f.call<Project>(
    'project.gate.set',
    { project_id: f.project.id, root: f.source, commands },
    project(f).revision,
  );
}

const setAutoMerge = (f: Fixture, enabled: boolean) =>
  f.call<Project>(
    'project.autoMerge.set',
    { project_id: f.project.id, enabled },
    project(f).revision,
  );

const setHandbackLimit = (f: Fixture, limit: number) =>
  f.call(
    'workflow.policy.set',
    { project_id: f.project.id, handback_limit: limit },
    f.store.get<WorkflowPolicy>('workflow_policies', f.project.id)?.revision ?? null,
  );

const idle = (f: Fixture, sessionId: string) =>
  current(f, sessionId).state === 'open' &&
  current(f, sessionId).merge?.state !== 'running' &&
  f.turns(sessionId).every((turn) => !['queued', 'running'].includes(turn.state));

/** Waits until the session has no turn or merge under way, and stays so over a few ticks. */
async function settle(f: Fixture, sessionId: string) {
  for (let quiet = 0; quiet < 3;) {
    await eventually(
      () => idle(f, sessionId),
      () => f.control.tick(),
      15000,
    );
    await f.control.tick();
    quiet = idle(f, sessionId) ? quiet + 1 : 0;
  }
}

async function leadWithPlan(f: Fixture, tasks: PlanTask[], milestones: PlanMilestone[] = []) {
  const lead = await f.create('Plan the export feature');
  await settle(f, lead.id);
  updatePlan(f, lead.id, tasks, milestones);
  return lead;
}

function updatePlan(
  f: Fixture,
  leadId: string,
  tasks: PlanTask[],
  milestones: PlanMilestone[] = [],
) {
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
    leadOf(f, leadId),
  );
}

const start = (f: Fixture, leadId: string, taskId: string) =>
  f.call('task.start', { project_id: f.project.id, task_ids: [taskId] }, null, leadOf(f, leadId));

const report = (f: Fixture, leadId: string) =>
  f.call(
    'task.report',
    { project_id: f.project.id, kind: 'done', text: 'The task is done' },
    null,
    leadOf(f, leadId),
  );

function commit(worktree: string, file: string, contents: string) {
  mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true });
  writeFileSync(path.join(worktree, file), contents);
  git(worktree, 'add', '--', file);
  git(worktree, 'commit', '--quiet', '-m', `Update ${file}`);
  return git(worktree, 'rev-parse', 'HEAD');
}

/** Ends one more lead turn, as the turn in which the lead reported its task done ends. */
async function endTurn(f: Fixture, leadId: string) {
  const turn = f.call<SessionTurn>(
    'session.send',
    { session_id: leadId, input: 'Go on' },
    current(f, leadId).revision,
  );
  await settle(f, leadId);
  return turn;
}

/** A lead working on direct task a in its own worktree, with a passing gate and auto-merge on. */
async function leadOnTask(f: Fixture, tasks = [task('a'), task('b')]) {
  await setGate(f, passing);
  setAutoMerge(f, true);
  const lead = await leadWithPlan(f, tasks);
  start(f, lead.id, 'a');
  return { lead, worktree: worktreeOf(f, lead).path };
}

it.skipIf(insideSandbox)(
  'merges the reported direct task after the lead turn and keeps the lead session open',
  async () => {
    const f = await mergeFixture();
    const { lead, worktree } = await leadOnTask(f);
    const head = commit(worktree, 'src/a.ts', 'export const a = 1;\n');
    await report(f, lead.id);

    const turn = await endTurn(f, lead.id);

    expect(git(f.source, 'rev-parse', 'main')).toBe(head);
    const after = current(f, lead.id);
    expect(after.state).toBe('open');
    expect(after.outcome).toBeUndefined();
    expect(after.direct_task).toBeUndefined();
    expect(after.merge).toBeUndefined();
    expect(worktreeOf(f, lead).removed_at).toBeUndefined();
    expect(worktreeOf(f, lead).base_sha).toBe(git(f.source, 'rev-parse', 'main'));
    expect(planOf(f, lead.id).direct_merged?.a).toEqual({
      generation: 1,
      at: expect.any(Number),
      session_id: lead.id,
      from_sha: expect.any(String),
      to_sha: head,
      source: worktreeOf(f, lead).source,
    });
    expect(boardTask(f, lead.id, 'a').status).toBe('done');
    expect(boardTask(f, lead.id, 'a').state).toBe('merged');
    expect(payloads(f, lead.id, 'session.merged')).toEqual([
      expect.objectContaining({
        task_id: 'a',
        generation: 1,
        direct: true,
        to_sha: head,
        source: worktreeOf(f, lead).source,
      }),
    ]);
    expect(payloads(f, lead.id, 'session.gate_started')).toEqual([
      expect.objectContaining({ task_id: 'a' }),
    ]);
    expect(payloads(f, lead.id, 'session.gate_checked')).toEqual([
      expect.objectContaining({ task_id: 'a' }),
    ]);
    expect(payloads(f, lead.id, 'session.merge_started')).toEqual([{ auto: true }]);
    expect(f.turns(lead.id).find((each) => each.id === turn.id)!.state).toBe('completed');
  },
);

it.skipIf(insideSandbox)(
  'wakes the lead after the merge and merges its next direct task on its own',
  async () => {
    const f = await mergeFixture();
    const { lead, worktree } = await leadOnTask(f);
    commit(worktree, 'src/a.ts', 'export const a = 1;\n');
    await report(f, lead.id);
    await endTurn(f, lead.id);
    const first = git(f.source, 'rev-parse', 'main');

    const [wake] = trackerTurns(f, lead.id);
    expect(wake?.input).toContain('a');
    expect(wake?.input).toContain('source branch');

    start(f, lead.id, 'b');
    const second = commit(worktree, 'src/b.ts', 'export const b = 2;\n');
    await report(f, lead.id);
    await endTurn(f, lead.id);

    expect(git(f.source, 'rev-parse', 'main')).toBe(second);
    const merges = payloads(f, lead.id, 'session.merged');
    expect(merges).toHaveLength(2);
    expect(merges[1]).toMatchObject({ task_id: 'b', from_sha: first, to_sha: second, files: 1 });
    expect(current(f, lead.id).state).toBe('open');
    expect(planOf(f, lead.id).direct_merged?.b?.to_sha).toBe(second);
  },
);

it.skipIf(insideSandbox)(
  'does not wake the lead about the merge that finished its plan and tells it with its next message',
  async () => {
    const f = await mergeFixture();
    const { lead, worktree } = await leadOnTask(f, [task('a')]);
    commit(worktree, 'src/a.ts', 'export const a = 1;\n');
    await report(f, lead.id);
    await endTurn(f, lead.id);

    expect(payloads(f, lead.id, 'session.merged')).toHaveLength(1);
    expect(trackerTurns(f, lead.id)).toEqual([]);
    expect(planOf(f, lead.id).inbox).toEqual([
      expect.objectContaining({ kind: 'merged', task_id: 'a', session_id: lead.id }),
    ]);
    // The note wakes no one, so the record does not wait for it.
    expect(await recordOf(f, lead.id, 'a')).toMatchObject({
      outcome: 'merged',
      path: 'direct',
      lead_wakes: 0,
    });

    const next = await endTurn(f, lead.id);
    expect(f.turns(lead.id).find((each) => each.id === next.id)!.input).toContain(
      'Your direct task a merged',
    );
    expect(planOf(f, lead.id).inbox).toEqual([]);
  },
);

it.skipIf(insideSandbox)(
  'wakes the lead about the merge that finished its plan while its milestone waits for acceptance',
  async () => {
    const f = await mergeFixture();
    await setGate(f, passing);
    setAutoMerge(f, true);
    const lead = await leadWithPlan(
      f,
      [task('a', { milestone: 'export' })],
      [{ id: 'export', title: 'Export', criteria: ['Exports download'], tasks: ['a'] }],
    );
    start(f, lead.id, 'a');
    commit(worktreeOf(f, lead).path, 'src/a.ts', 'export const a = 1;\n');
    await report(f, lead.id);
    await endTurn(f, lead.id);

    expect(payloads(f, lead.id, 'session.merged')).toHaveLength(1);
    await eventually(
      () => trackerTurns(f, lead.id).length > 0,
      () => f.control.tick(),
    );
  },
);

it.skipIf(insideSandbox)(
  'keeps the lead open when the gate fails and hands the failure back up to the limit',
  async () => {
    const f = await mergeFixture();
    setHandbackLimit(f, 2);
    const { lead, worktree } = await leadOnTask(f);
    await setGate(f, failing);
    const source = git(f.source, 'rev-parse', 'main');
    commit(worktree, 'src/a.ts', 'export const a = 1;\n');
    await report(f, lead.id);

    await endTurn(f, lead.id);

    expect(git(f.source, 'rev-parse', 'main')).toBe(source);
    const handBacks = trackerTurns(f, lead.id).filter((turn) =>
      turn.input.includes('Always fails'),
    );
    expect(handBacks).toHaveLength(2);
    expect(handBacks[0]!.input).toContain('report');
    expect(current(f, lead.id).state).toBe('open');
    expect(current(f, lead.id).outcome).toBeUndefined();
    expect(current(f, lead.id).merge).toMatchObject({ state: 'blocked', reason: 'gate_failed' });
    expect(planOf(f, lead.id).handed_back?.[`${lead.id}:a`]).toEqual([
      'gate_failed',
      'gate_failed',
    ]);
    // A failed gate of the merge shows as the gate failure of the session.
    expect(f.control.needsYou(user, f.project.id).items).toContainEqual(
      expect.objectContaining({
        kind: 'session.gate_failed',
        reason: 'gate_failed',
        source: expect.objectContaining({ id: lead.id }),
      }),
    );
  },
  30000,
);

it('does not land a direct task that changes files outside its scope', async () => {
  const f = await mergeFixture();
  const { lead, worktree } = await leadOnTask(f);
  const source = git(f.source, 'rev-parse', 'main');
  commit(worktree, 'answer.txt', 'outside\n');
  await report(f, lead.id);

  await endTurn(f, lead.id);

  expect(git(f.source, 'rev-parse', 'main')).toBe(source);
  expect(payloads(f, lead.id, 'session.merge_blocked')[0]).toMatchObject({
    reason: 'out_of_scope',
    conflicts: ['answer.txt'],
  });
  expect(payloads(f, lead.id, 'session.merged')).toEqual([]);
  expect(current(f, lead.id).direct_task?.id).toBe('a');
});

it.skipIf(insideSandbox)(
  'waits for the user to merge a direct task when auto-merge is off, and keeps the lead open',
  async () => {
    const f = await mergeFixture();
    const { lead, worktree } = await leadOnTask(f);
    setAutoMerge(f, false);
    const source = git(f.source, 'rev-parse', 'main');
    const head = commit(worktree, 'src/a.ts', 'export const a = 1;\n');
    await report(f, lead.id);
    await endTurn(f, lead.id);
    expect(payloads(f, lead.id, 'session.merge_started')).toEqual([]);
    expect(git(f.source, 'rev-parse', 'main')).toBe(source);

    await f.call('session.merge', { session_id: lead.id }, current(f, lead.id).revision);
    await settle(f, lead.id);

    expect(git(f.source, 'rev-parse', 'main')).toBe(head);
    expect(current(f, lead.id).state).toBe('open');
    expect(current(f, lead.id).outcome).toBeUndefined();
    expect(current(f, lead.id).direct_task).toBeUndefined();
    expect(payloads(f, lead.id, 'session.merged')).toEqual([
      expect.objectContaining({ task_id: 'a', direct: true }),
    ]);
  },
);

it('does not merge commits made after the report and asks the lead to report again', async () => {
  const f = await mergeFixture();
  const { lead, worktree } = await leadOnTask(f);
  const source = git(f.source, 'rev-parse', 'main');
  commit(worktree, 'src/a.ts', 'export const a = 1;\n');
  await report(f, lead.id);
  commit(worktree, 'src/a.ts', 'export const a = 2;\n');

  const turn = await endTurn(f, lead.id);

  expect(git(f.source, 'rev-parse', 'main')).toBe(source);
  expect(payloads(f, lead.id, 'session.merge_skipped')[0]).toEqual({
    reason: 'head_moved',
    turn_id: turn.id,
  });
  expect(trackerTurns(f, lead.id)[0]?.input).toContain('report');
  expect(current(f, lead.id).direct_task?.id).toBe('a');
  // A hand-back that changed nothing is not repeated; the user sees the merge wait.
  expect(trackerTurns(f, lead.id)).toHaveLength(1);
  expect(f.control.needsYou(user, f.project.id).items).toContainEqual(
    expect.objectContaining({
      kind: 'session.merge_blocked',
      source: expect.objectContaining({ id: lead.id }),
    }),
  );
});

it('does not merge a worktree with uncommitted files and tells the lead', async () => {
  const f = await mergeFixture();
  const { lead, worktree } = await leadOnTask(f);
  const source = git(f.source, 'rev-parse', 'main');
  commit(worktree, 'src/a.ts', 'export const a = 1;\n');
  await report(f, lead.id);
  writeFileSync(path.join(worktree, 'src/draft.ts'), 'draft\n');

  const turn = await endTurn(f, lead.id);

  expect(git(f.source, 'rev-parse', 'main')).toBe(source);
  expect(payloads(f, lead.id, 'session.merge_skipped')[0]).toEqual({
    reason: 'uncommitted_changes',
    turn_id: turn.id,
  });
  expect(trackerTurns(f, lead.id)[0]?.input).toContain('uncommitted');
});

it.each([
  ['taken out of the plan', [task('b')]],
  ['given a new contract', [task('a', { goal: 'Finish task a another way' }), task('b')]],
])(
  'does not land a direct task %s while it merges',
  async (_, tasks) => {
    const f = await mergeFixture();
    const { lead, worktree } = await leadOnTask(f);
    await setGate(f, slow);
    const source = git(f.source, 'rev-parse', 'main');
    commit(worktree, 'src/a.ts', 'export const a = 1;\n');
    await report(f, lead.id);
    f.call('session.send', { session_id: lead.id, input: 'Go on' }, current(f, lead.id).revision);
    await eventually(
      () => payloads(f, lead.id, 'session.gate_started').length > 0,
      () => f.control.tick(),
      10000,
    );

    updatePlan(f, lead.id, tasks);
    await settle(f, lead.id);

    expect(git(f.source, 'rev-parse', 'main')).toBe(source);
    expect(payloads(f, lead.id, 'session.merged')).toEqual([]);
    expect(current(f, lead.id).merge).toMatchObject({ state: 'blocked', reason: 'task_retired' });
    expect(planOf(f, lead.id).direct_merged?.a).toBeUndefined();
  },
  30000,
);

it.skipIf(insideSandbox)(
  'merges a direct task the lead claimed again after it rewrote the goal',
  async () => {
    const f = await mergeFixture();
    const { lead, worktree } = await leadOnTask(f, [task('a')]);
    updatePlan(f, lead.id, [task('a', { goal: 'Finish task a another way' })]);
    start(f, lead.id, 'a');
    const head = commit(worktree, 'src/a.ts', 'export const a = 1;\n');
    await report(f, lead.id);

    await endTurn(f, lead.id);

    expect(git(f.source, 'rev-parse', 'main')).toBe(head);
    expect(current(f, lead.id).merge).toBeUndefined();
    expect(payloads(f, lead.id, 'session.merged')).toEqual([
      expect.objectContaining({ task_id: 'a', generation: 2, direct: true, to_sha: head }),
    ]);
  },
);

it.skipIf(insideSandbox)(
  'refuses to roll back to a turn before the merge and keeps the turns after it on the timeline',
  async () => {
    const f = await mergeFixture();
    const { lead, worktree } = await leadOnTask(f);
    commit(worktree, 'src/a.ts', 'export const a = 1;\n');
    await report(f, lead.id);
    const before = await endTurn(f, lead.id);
    const after = await endTurn(f, lead.id);
    expect(current(f, lead.id).state).toBe('open');

    expect(() =>
      f.call(
        'session.rollback',
        { session_id: lead.id, turn_id: before.id },
        current(f, lead.id).revision,
      ),
    ).toThrow(
      expect.objectContaining({ code: 'invalid_state', message: expect.stringContaining('merge') }),
    );

    const lane = f.control
      .projectTimeline(user, f.project.id)
      .sessions.find((each) => each.session_id === lead.id)!;
    const merged = lane.intervals.findIndex((interval) => interval.state === 'merging');
    expect(merged).toBeGreaterThanOrEqual(0);
    expect(lane.intervals.some((interval) => interval.state === 'merged')).toBe(false);
    expect(lane.intervals.slice(merged + 1).some((interval) => interval.state === 'running')).toBe(
      true,
    );
    expect(f.turns(lead.id).find((turn) => turn.id === after.id)!.state).toBe('completed');
  },
);

it.skipIf(insideSandbox)('refuses to start a direct task again once it merged', async () => {
  const f = await mergeFixture();
  const { lead, worktree } = await leadOnTask(f);
  commit(worktree, 'src/a.ts', 'export const a = 1;\n');
  await report(f, lead.id);
  await endTurn(f, lead.id);
  expect(planOf(f, lead.id).direct_merged?.a).toBeDefined();

  expect(() => start(f, lead.id, 'a')).toThrow(
    expect.objectContaining({ code: 'invalid_state', message: expect.stringContaining('done') }),
  );
  expect(current(f, lead.id).direct_task).toBeUndefined();
});

it.skipIf(insideSandbox)(
  'shows a merged direct task as under way again while the session the user started on it runs',
  async () => {
    const f = await mergeFixture();
    const { lead, worktree } = await leadOnTask(f);
    commit(worktree, 'src/a.ts', 'export const a = 1;\n');
    await report(f, lead.id);
    await endTurn(f, lead.id);
    expect(boardTask(f, lead.id, 'a').status).toBe('done');

    f.call('task.start', { project_id: f.project.id, lead_session_id: lead.id, task_ids: ['a'] });
    await eventually(
      () => f.store.list<Session>('sessions').some((s) => s.task?.id === 'a' && !s.outcome),
      () => f.control.tick(),
    );
    expect(boardTask(f, lead.id, 'a').status).not.toBe('done');
  },
);

it.skipIf(insideSandbox)(
  'records the merged direct task with its path, the lead session, its gate run and the lead usage',
  async () => {
    const f = await mergeFixture();
    Object.assign(f.adapter, { traceEvents: true });
    const { lead, worktree } = await leadOnTask(f);
    commit(worktree, 'src/a.ts', 'export const a = 1;\n');
    await report(f, lead.id);
    await endTurn(f, lead.id);

    const row = await recordOf(f, lead.id, 'a');

    expect(row).toMatchObject({
      outcome: 'merged',
      path: 'direct',
      session_ids: [lead.id],
      runtime: f.adapter.name,
      gate_passed_on_attempt: 1,
      handbacks: [],
      // The turn that ended between the claim and the merge, and the wake that told of the merge.
      lead_usage: { input_tokens: 20, output_tokens: 10 },
      started_at: expect.any(Number),
    });
    expect(row).not.toHaveProperty('task_usage');
    expect(row).not.toHaveProperty('gate_failures');
    expect(Object.keys(row.stage_ms ?? {}).sort()).toEqual(['execution', 'gate_and_merge']);
  },
);

const setDirectBudget = (f: Fixture, input_tokens: number) =>
  f.call(
    'workflow.policy.set',
    { project_id: f.project.id, budget: { t1: { direct: { input_tokens, wall_ms: 3_600_000 } } } },
    f.store.get<WorkflowPolicy>('workflow_policies', f.project.id)?.revision ?? null,
  );

it.skipIf(insideSandbox)(
  "uses the lead's usage for the budget ratio of a direct task",
  async () => {
    const f = await mergeFixture();
    Object.assign(f.adapter, { traceEvents: true });
    setDirectBudget(f, 10);
    const { lead, worktree } = await leadOnTask(f);
    commit(worktree, 'src/a.ts', 'export const a = 1;\n');
    await report(f, lead.id);
    await endTurn(f, lead.id);

    const row = await recordOf(f, lead.id, 'a');

    expect(row).toMatchObject({ path: 'direct', lead_usage: { input_tokens: 20 } });
    expect(row).not.toHaveProperty('task_usage');
    expect(row.budget_ratio).toBe(2);
  },
);

it.skipIf(insideSandbox)(
  'finds the cell over budget once three of its five latest direct tasks spent more than their budget, and proposes no change',
  async () => {
    const f = await mergeFixture();
    Object.assign(f.adapter, { traceEvents: true });
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const { lead, worktree } = await leadOnTask(
      f,
      ids.map((id) => task(id)),
    );
    const over = [true, false, true, false, true];
    for (const [index, id] of ids.entries()) {
      setDirectBudget(f, over[index] ? 5 : 1_000_000);
      if (index) start(f, lead.id, id);
      commit(worktree, `src/${id}.ts`, `export const ${id} = 1;\n`);
      await report(f, lead.id);
      await endTurn(f, lead.id);
      await recordOf(f, lead.id, id);
    }
    const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;

    expect(
      f.store.list<Retrospective>('retrospectives').map((row) => (row.budget_ratio ?? 0) > 1),
    ).toEqual(over);
    expect(
      improvementSignals(ctx, f.project.id).filter((row) => row.signal === 'over_budget'),
    ).toEqual([expect.objectContaining({ cell: { domain: 'backend-logic', tier: 't1' } })]);
    await f.control.tick();
    expect(f.store.db.prepare('SELECT count(*) AS n FROM improvements').get()).toEqual({ n: 0 });
  },
  60000,
);

it.skipIf(insideSandbox)(
  'times the work of a direct task up to its own report when another task reports first',
  async () => {
    const f = await mergeFixture();
    const { lead, worktree } = await leadOnTask(f);
    f.store.event('task.reported', planOf(f, lead.id), f.project.id, {
      at: f.store.now(),
      session_id: 'another-session',
      task_id: 'b',
      generation: 1,
      kind: 'done',
      text: 'The other task is done',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    commit(worktree, 'src/a.ts', 'export const a = 1;\n');
    await report(f, lead.id);
    await endTurn(f, lead.id);

    const row = await recordOf(f, lead.id, 'a');

    const events = f.store.kindEvents(f.project.id, ['task.claimed', 'task.reported']);
    const claimed = events.find((event) => event.kind === 'task.claimed')!;
    const reported = events.find(
      (event) => event.kind === 'task.reported' && (event.payload as { direct?: boolean }).direct,
    )!;
    expect(row.stage_ms?.execution).toBe(reported.created_at - claimed.created_at);
  },
);

it.skipIf(insideSandbox)(
  'records the second gate run and the hand-back of a direct task whose gate failed once',
  async () => {
    const f = await mergeFixture();
    const { lead, worktree } = await leadOnTask(f);
    const gate = gateFolder(f.root),
      fixed = path.join(gate.dir, 'fixed');
    await setGate(f, failsUntilFixed(gate, fixed));
    commit(worktree, 'src/a.ts', 'export const a = 1;\n');
    await report(f, lead.id);
    f.call('session.send', { session_id: lead.id, input: 'Go on' }, current(f, lead.id).revision);
    await eventually(
      () => payloads(f, lead.id, 'session.gate_checked').length > 0,
      () => f.control.tick(),
      10000,
    );
    writeFileSync(fixed, '');

    const row = await recordOf(f, lead.id, 'a');

    expect(row).toMatchObject({
      path: 'direct',
      gate_passed_on_attempt: 2,
      gate_failures: ['code'],
      gate_failed_checks: ['Fails until fixed'],
      handbacks: [{ reason: 'gate_failed' }],
    });
  },
  30000,
);

it('counts the direct task the lead works on as active in its milestone', async () => {
  const f = await mergeFixture();
  await setGate(f, passing);
  const lead = await leadWithPlan(
    f,
    [task('a', { milestone: 'export' }), task('b')],
    [{ id: 'export', title: 'Export', criteria: ['Exports download'], tasks: ['a'] }],
  );
  start(f, lead.id, 'a');

  const read = f.control.projectRead(user, f.project.id) as ProjectRead;

  expect(read.milestones.map((milestone) => milestone.reasons)).toEqual([['task:a:active']]);
});

it('lets go of the claim of a direct task given a new contract while it merges', async () => {
  const f = await mergeFixture();
  const { lead, worktree } = await leadOnTask(f);
  await setGate(f, slow);
  commit(worktree, 'src/a.ts', 'export const a = 1;\n');
  await report(f, lead.id);
  f.call('session.send', { session_id: lead.id, input: 'Go on' }, current(f, lead.id).revision);
  await eventually(
    () => payloads(f, lead.id, 'session.gate_started').length > 0,
    () => f.control.tick(),
    10000,
  );

  updatePlan(f, lead.id, [task('a', { goal: 'Finish task a another way' }), task('b')]);
  await settle(f, lead.id);

  expect(current(f, lead.id).merge).toMatchObject({ state: 'blocked', reason: 'task_retired' });
  expect(current(f, lead.id).direct_task).toBeUndefined();
  expect(payloads(f, lead.id, 'task.released')).toEqual([{ task_id: 'a' }]);
  start(f, lead.id, 'a');
  expect(current(f, lead.id).direct_task).toEqual({
    id: 'a',
    generation: 2,
    definition_version: 0,
  });
}, 30000);

it('sends a direct task gate failure to the user without a hand-back when the limit is zero', async () => {
  const f = await mergeFixture();
  setHandbackLimit(f, 0);
  await setGate(f, passing);
  setAutoMerge(f, true);
  const lead = await leadWithPlan(f, [task('export')]);
  start(f, lead.id, 'export');
  await setGate(f, failing);
  commit(worktreeOf(f, lead).path, 'src/export.ts', 'export const download = true;\n');
  await report(f, lead.id);
  await endTurn(f, lead.id);
  expect(trackerTurns(f, lead.id)).toEqual([]);
  expect(current(f, lead.id).merge).toMatchObject({ state: 'blocked', reason: 'gate_failed' });
  expect(f.control.needsYou(user, f.project.id).items).toContainEqual(
    expect.objectContaining({
      kind: 'session.gate_failed',
      source: expect.objectContaining({ id: lead.id }),
    }),
  );
});
