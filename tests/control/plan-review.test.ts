import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type {
  AgentEvent,
  AgentEventSink,
  BoardPlan,
  LeadNote,
  Principal,
  Project,
  Review,
  Session,
  SessionHandle,
  SessionSpec,
  UserTurn,
  WorkflowPolicy,
} from '@pantheon/domain';
import { reviewerDirectory } from '../../packages/control/src/review.js';
import type { ControlContext } from '../../packages/control/src/context.js';
import { eventually, settle, user } from '../helpers.js';
import { dispatchEveryTier, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
type PlanTask = BoardPlan['tasks'][number];

class HeldReviewer extends FixtureAdapter {
  starts: { spec: SessionSpec; emit: AgentEventSink; handle: SessionHandle; turn?: UserTurn }[] =
    [];
  sequence = 1;
  constructor() {
    super();
    this.name = 'plan-reviewer';
  }
  override async start(spec: SessionSpec, emit: AgentEventSink) {
    const handle = await super.start(spec, emit);
    this.starts.push({ spec, emit, handle });
    return handle;
  }
  override async send(handle: SessionHandle, turn: UserTurn) {
    this.starts.find((entry) => entry.handle === handle)!.turn = turn;
    return { turn_id: turn.turn_id, status: 'delivered' as const };
  }
  emit(event: Record<string, unknown>, index = 0) {
    const entry = this.starts[index]!;
    entry.emit({
      key: String(++this.sequence),
      provider_sequence: this.sequence,
      turn_id: entry.turn!.turn_id,
      ...event,
    } as AgentEvent);
  }
}

const task = (id: string, tier: 't1' | 't2' | 't3', fields: Partial<PlanTask> = {}): PlanTask => ({
  id,
  title: `Task ${id}`,
  goal: `Finish task ${id}`,
  lane: 'core',
  depends_on: [],
  source: ['Plan the export feature'],
  scope: [`src/${id}`],
  acceptance: ['pnpm test'],
  kind: { domain: 'backend-logic', tier },
  ...fields,
});

const leadOf = (f: Fixture, leadId: string): Principal => ({
  id: `session:${leadId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: leadId,
  expires_at: f.store.now() + 60000,
});

function writePlan(f: Fixture, leadId: string, tasks: PlanTask[]) {
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: f.store.get<BoardPlan>('board_plans', leadId)?.plan_version ?? 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks,
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    leadOf(f, leadId),
  );
}

const planReviews = (f: Fixture) => f.store.list<Review>('reviews').filter((review) => review.plan);
const notes = (f: Fixture, kind: LeadNote['kind']) =>
  f.store
    .kindEvents(f.project.id, ['lead.note_added'])
    .map((event) => event.payload as LeadNote)
    .filter((note) => note.kind === kind);
const sessionsOf = (f: Fixture, leadId: string, taskId: string) =>
  f.store
    .list<Session>('sessions')
    .filter((session) => session.task?.lead_session_id === leadId && session.task.id === taskId);

async function planFixture(withReviewer = true) {
  const f = await workbenchFixture();
  dispatchEveryTier(f);
  const reviewer = new HeldReviewer();
  if (withReviewer) f.control.adapters.set(reviewer.name, reviewer);
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  const ready = (index = 0) =>
    eventually(
      () => reviewer.starts[index]?.turn !== undefined,
      () => f.control.tick(),
    );
  const ended = (review: Review, state: Review['state']) =>
    eventually(
      () => f.store.must<Review>('reviews', review.id).state === state,
      () => f.control.tick(),
    );
  return { f, lead, reviewer, ready, ended };
}

it('starts a read-only reviewer on another runtime when the plan has a high-risk task', async () => {
  const { f, lead, reviewer, ready } = await planFixture();
  writePlan(f, lead.id, [task('risky', 't3'), task('small', 't1')]);
  const [review] = planReviews(f);
  expect(review).toMatchObject({
    requester: { lead_session_id: lead.id },
    plan: { tasks: [{ task_id: 'risky', generation: 1 }] },
    runtimes: [reviewer.name],
    state: 'running',
  });
  expect(review!.session_id).toBeUndefined();
  await ready();
  const start = reviewer.starts[0]!;
  expect(start.spec.role).toBe('reviewer');
  expect(start.spec.sandbox?.writable_roots).toEqual([]);
  expect(start.turn!.input).toContain('Finish task risky');
  expect(start.turn!.input).toContain('scope overlap');
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const file = path.join(
    reviewerDirectory(ctx, f.project.id, review!.id, review!.session_ids[0]!),
    'plan.json',
  );
  expect(existsSync(file)).toBe(true);
  expect(JSON.parse(readFileSync(file, 'utf8')).tasks.map((each: PlanTask) => each.id)).toEqual([
    'risky',
    'small',
  ]);
});

it('does not review a plan without high-risk tasks', async () => {
  const { f, lead } = await planFixture();
  writePlan(f, lead.id, [task('small', 't1'), task('medium', 't2')]);
  expect(planReviews(f)).toEqual([]);
});

it('reviews each high-risk task generation once and again after its contract changes', async () => {
  const { f, lead, reviewer, ready, ended } = await planFixture();
  writePlan(f, lead.id, [task('risky', 't3')]);
  const [first] = planReviews(f);
  await ready();
  reviewer.emit({ kind: 'turn.completed', status: 'completed' });
  await ended(first!, 'completed');
  writePlan(f, lead.id, [task('risky', 't3', { title: 'Renamed risky task' })]);
  expect(planReviews(f)).toHaveLength(1);
  writePlan(f, lead.id, [task('risky', 't3', { goal: 'Finish task risky another way' })]);
  const reviews = planReviews(f);
  expect(reviews).toHaveLength(2);
  expect(reviews[1]!.plan!.tasks).toEqual([{ task_id: 'risky', generation: 2 }]);
});

it('holds the session of a high-risk task until its plan review ends and opens other tasks', async () => {
  const { f, lead, reviewer, ready, ended } = await planFixture();
  writePlan(f, lead.id, [task('risky', 't3'), task('small', 't1')]);
  const [review] = planReviews(f);
  await ready();
  f.call(
    'task.start',
    { project_id: f.project.id, task_ids: ['risky', 'small'] },
    null,
    leadOf(f, lead.id),
  );
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'small')).toHaveLength(1);
  expect(sessionsOf(f, lead.id, 'risky')).toHaveLength(0);
  // The lead hears of the review when it ends, not of the wait.
  expect(notes(f, 'blocked').filter((note) => note.task_id === 'risky')).toEqual([]);
  reviewer.emit({ kind: 'turn.completed', status: 'failed', error: 'Reviewer unavailable' });
  await ended(review!, 'failed');
  await eventually(
    () => sessionsOf(f, lead.id, 'risky').length === 1,
    () => f.control.tick(),
  );
});

it('returns plan review findings to the lead inbox and wakes the lead', async () => {
  const { f, lead, reviewer, ready, ended } = await planFixture();
  writePlan(f, lead.id, [task('risky', 't3')]);
  const [review] = planReviews(f);
  await ready();
  reviewer.emit({
    kind: 'tool.started',
    name: 'review.finding',
    tool_call_id: 'finding',
    input: {
      blocking: false,
      location: 'risky',
      quote: 'Finish task risky',
      evidence: 'The goal names no observable result',
      impact: 'The session cannot tell when it is done',
    },
  });
  reviewer.emit({ kind: 'turn.completed', status: 'completed' });
  await ended(review!, 'completed');
  expect(f.store.must<Review>('reviews', review!.id).findings[0]!.status).toBe('open');
  // The board lists it with the lead whose plan it reviews, as the review matrix counts it.
  expect(f.control.boardView(user, f.project.id, 1).findings).toEqual([
    expect.objectContaining({
      session_id: lead.id,
      text: 'The session cannot tell when it is done',
    }),
  ]);
  const completed = notes(f, 'plan_review_completed');
  expect(completed).toHaveLength(1);
  expect(completed[0]!.text).toContain(review!.id);
  expect(completed[0]!.text).toContain('Quote: Finish task risky');
  await eventually(
    () => f.turns(lead.id).some((turn) => turn.input.includes('Quote: Finish task risky')),
    () => f.control.tick(),
  );
  expect(f.store.must<BoardPlan>('board_plans', lead.id).tasks[0]!.goal).toBe('Finish task risky');
});

it('returns a failed plan review to the lead as failed', async () => {
  const { f, lead, reviewer, ready, ended } = await planFixture();
  writePlan(f, lead.id, [task('risky', 't3')]);
  const [review] = planReviews(f);
  await ready();
  reviewer.emit({ kind: 'turn.completed', status: 'failed', error: 'Reviewer unavailable' });
  await ended(review!, 'failed');
  expect(notes(f, 'plan_review_failed')).toHaveLength(1);
  expect(notes(f, 'review_failed')).toHaveLength(0);
});

it('rejects a plan review finding whose quote is not in the plan', async () => {
  const { f, lead, reviewer, ready } = await planFixture();
  writePlan(f, lead.id, [task('risky', 't3')]);
  const [review] = planReviews(f);
  await ready();
  reviewer.emit({
    kind: 'tool.started',
    name: 'review.finding',
    tool_call_id: 'finding',
    input: {
      blocking: false,
      location: 'risky',
      quote: 'Deploy the export to production',
      evidence: 'The plan deploys without a check',
      impact: 'A broken export reaches users',
    },
  });
  await eventually(
    () => f.store.must<Review>('reviews', review!.id).findings.length === 1,
    () => f.control.tick(),
  );
  expect(f.store.must<Review>('reviews', review!.id).findings[0]).toMatchObject({
    status: 'rejected',
    reason: 'quote_not_in_artifact',
  });
});

it("reviews the plan on the lead's runtime when no other runtime can review it", async () => {
  const { f, lead } = await planFixture(false);
  writePlan(f, lead.id, [task('risky', 't3')]);
  const [review] = planReviews(f);
  expect(review).toMatchObject({
    runtimes: [lead.runtime],
    plan: { tasks: [{ task_id: 'risky', generation: 1 }] },
  });
  expect(review!.session_ids).not.toContain(lead.id);
  expect(notes(f, 'runtime_unavailable')).toEqual([]);
});

it('reviews the plan on the default runtime with its model and effort when the project uses one model', async () => {
  const { f, lead } = await planFixture();
  const project = f.store.must<Project>('projects', f.project.id);
  f.store.update<Project>(
    'projects',
    {
      ...project,
      session_defaults: {
        runtime: lead.runtime,
        permission_mode: 'ask',
        model: 'single-model',
        effort: 'high',
        single_model: true,
      },
    },
    project.revision,
  );
  writePlan(f, lead.id, [task('risky', 't3')]);
  const [review] = planReviews(f);
  expect(review).toMatchObject({ runtimes: [lead.runtime] });
  expect(f.store.must<Session>('sessions', review!.session_ids[0]!)).toMatchObject({
    runtime: lead.runtime,
    requested_model: 'single-model',
    requested_effort: 'high',
  });
});

it('does not review or hold tasks when no runtime can review and tells the lead', async () => {
  const { f, lead } = await planFixture(false);
  f.adapter.report.capabilities.read_isolation = { status: 'unsupported', evidence: 'Not here' };
  writePlan(f, lead.id, [task('risky', 't3')]);
  expect(planReviews(f)).toEqual([]);
  const plan = f.store.must<BoardPlan>('board_plans', lead.id);
  expect(plan.inbox.some((note) => note.text.includes('did not review the plan'))).toBe(true);
  writePlan(f, lead.id, [task('risky', 't3', { title: 'Renamed risky task' })]);
  expect(
    f.store
      .kindEvents(f.project.id, ['lead.note_added'])
      .filter((event) => (event.payload as LeadNote).text.includes('did not review the plan')),
  ).toHaveLength(1);
  f.call('task.start', { project_id: f.project.id, task_ids: ['risky'] }, null, leadOf(f, lead.id));
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'risky')).toHaveLength(1);
});

it('reviews a high-risk task the lead adds with edit_board', async () => {
  const { f, lead } = await planFixture();
  writePlan(f, lead.id, [task('small', 't1')]);
  f.call(
    'board.plan.edit',
    {
      project_id: f.project.id,
      base_version: f.store.must<BoardPlan>('board_plans', lead.id).plan_version,
      ops: [{ type: 'add_task', task: task('risky', 't3') }],
    },
    null,
    leadOf(f, lead.id),
  );
  expect(planReviews(f).map((review) => review.plan!.tasks)).toEqual([
    [{ task_id: 'risky', generation: 1 }],
  ]);
});

it('reviews a high-risk task added during another plan review once that review ends', async () => {
  const { f, lead, reviewer, ready, ended } = await planFixture();
  writePlan(f, lead.id, [task('risky', 't3')]);
  const [first] = planReviews(f);
  writePlan(f, lead.id, [task('risky', 't3'), task('later', 't3')]);
  expect(planReviews(f)).toHaveLength(1);
  await ready();
  reviewer.emit({ kind: 'turn.completed', status: 'completed' });
  await ended(first!, 'completed');
  expect(planReviews(f).map((review) => review.plan!.tasks)).toEqual([
    [{ task_id: 'risky', generation: 1 }],
    [{ task_id: 'later', generation: 1 }],
  ]);
});

it('leaves a done high-risk task out of the plan review', async () => {
  const { f, lead } = await planFixture(false);
  // No runtime reviews the first plan, so its task runs to done unreviewed.
  f.adapter.report.capabilities.read_isolation = { status: 'unsupported', evidence: 'Not here' };
  writePlan(f, lead.id, [task('risky', 't3', { done_when: 'report' })]);
  f.call('task.start', { project_id: f.project.id, task_ids: ['risky'] }, null, leadOf(f, lead.id));
  await f.control.tick();
  const [session] = sessionsOf(f, lead.id, 'risky');
  await settle(f, session!);
  await f.call(
    'task.report',
    { project_id: f.project.id, kind: 'done', text: 'Task risky is answered' },
    null,
    {
      id: `session:${session!.id}`,
      role: 'worker',
      project_id: f.project.id,
      session_id: session!.id,
      expires_at: f.store.now() + 60000,
    },
  );
  await settle(f, f.store.must<Session>('sessions', lead.id));
  f.call(
    'task.accept',
    { project_id: f.project.id, task_id: 'risky', evidence: 'The report answers the goal' },
    null,
    leadOf(f, lead.id),
  );
  f.control.adapters.set('plan-reviewer', new HeldReviewer());
  writePlan(f, lead.id, [task('risky', 't3', { done_when: 'report' }), task('later', 't3')]);
  expect(planReviews(f).map((review) => review.plan!.tasks)).toEqual([
    [{ task_id: 'later', generation: 1 }],
  ]);
});

it('holds a high-risk task written during a running plan review until its own review ends', async () => {
  const { f, lead, reviewer, ready, ended } = await planFixture();
  writePlan(f, lead.id, [task('risky', 't3')]);
  const [first] = planReviews(f);
  writePlan(f, lead.id, [task('risky', 't3'), task('later', 't3')]);
  f.call('task.start', { project_id: f.project.id, task_ids: ['later'] }, null, leadOf(f, lead.id));
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'later')).toHaveLength(0);
  await ready();
  reviewer.emit({ kind: 'turn.completed', status: 'completed' });
  await ended(first!, 'completed');
  await f.control.tick();
  expect(sessionsOf(f, lead.id, 'later')).toHaveLength(0);
  const second = planReviews(f)[1]!;
  await ready(1);
  reviewer.emit({ kind: 'turn.completed', status: 'completed' }, 1);
  await ended(second, 'completed');
  await eventually(
    () => sessionsOf(f, lead.id, 'later').length === 1,
    () => f.control.tick(),
  );
});

it('refuses a lead claiming a direct high-risk task while its plan review runs', async () => {
  const { f, lead } = await planFixture();
  f.call(
    'workflow.policy.set',
    { project_id: f.project.id, path: { t3: 'direct' } },
    f.store.get<WorkflowPolicy>('workflow_policies', f.project.id)?.revision ?? null,
  );
  writePlan(f, lead.id, [task('risky', 't3')]);
  const [review] = planReviews(f);
  expect(() =>
    f.call(
      'task.start',
      { project_id: f.project.id, task_ids: ['risky'] },
      null,
      leadOf(f, lead.id),
    ),
  ).toThrow(new RegExp(`plan review ${review!.id}`));
});

it('refuses the session the user opens for a high-risk task while its plan review runs', async () => {
  const { f, lead } = await planFixture();
  writePlan(f, lead.id, [task('risky', 't3')]);
  const [review] = planReviews(f);
  expect(() =>
    f.call('session.create', {
      project_id: f.project.id,
      runtime: f.adapter.name,
      task_id: `${lead.id}:risky`,
      input: 'Work on the risky task',
    }),
  ).toThrow(new RegExp(`plan review ${review!.id}`));
  expect(sessionsOf(f, lead.id, 'risky')).toEqual([]);
});
