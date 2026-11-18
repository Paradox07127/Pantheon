import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type {
  AgentEvent,
  AgentEventSink,
  BoardPlan,
  Principal,
  Project,
  Review,
  Session,
  SessionHandle,
  SessionSpec,
  UserTurn,
} from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

class HeldReviewer extends FixtureAdapter {
  starts: { spec: SessionSpec; emit: AgentEventSink; handle: SessionHandle; turn?: UserTurn }[] =
    [];
  sequence = 1;
  constructor(name = 'cross-reviewer') {
    super();
    this.name = name;
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

async function reviewFixture() {
  const f = await workbenchFixture();
  const idle = async (session: Session) => {
    const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
    await eventually(
      () =>
        f.turns(session.id)[0]?.state === 'completed' &&
        f.store.must<Session>('sessions', session.id).state === 'open',
      () => f.control.tick(),
    );
    return workspace;
  };
  const lead = await f.create('Plan and review the answer');
  await idle(lead);
  const plan: BoardPlan = {
    id: lead.id,
    revision: 1,
    project_id: f.project.id,
    headline: 'Answer',
    lanes: [{ id: 'work', title: 'Work' }],
    tasks: [
      {
        id: 'answer',
        title: 'Answer',
        goal: 'Return the correct answer',
        lane: 'work',
        source: [],
        scope: ['answer.txt'],
        acceptance: ['test -f answer.txt'],
        depends_on: [],
      },
    ],
    plan_version: 0,
    pending_edits: [],
    inbox: [],
    notified: {},
    risks: [],
    assumptions: [],
    updated_at: f.store.now(),
  };
  f.store.insert('board_plans', plan);
  const worker = await f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Implement the answer',
    task_id: `${lead.id}:answer`,
  });
  const workspace = await idle(worker);
  writeFileSync(path.join(workspace.path, 'answer.txt'), 'reviewed answer\n');
  git(workspace.path, 'commit', '--quiet', '-am', 'Write the answer');
  const reviewer = new HeldReviewer();
  f.control.adapters.set(reviewer.name, reviewer);
  const principal: Principal = {
    id: `session:${lead.id}`,
    role: 'lead',
    session_id: lead.id,
    project_id: f.project.id,
    expires_at: f.store.now() + 60000,
  };
  const request = () =>
    f.call<Review>(
      'review.request',
      { session_id: worker.id, runtimes: [reviewer.name] },
      null,
      principal,
    );
  const ready = async () =>
    eventually(
      () => reviewer.starts[0]?.turn !== undefined,
      () => f.control.tick(),
    );
  return { f, lead, worker, workspace, reviewer, principal, request, ready };
}

it('lets an owning lead request a read-only cross-review and returns evidence-bound findings once', async () => {
  const { f, lead, worker, workspace, reviewer, request, ready } = await reviewFixture();
  const review = await request();
  expect(review.requester).toEqual({ lead_session_id: lead.id, task_id: 'answer', generation: 1 });
  expect(review.range?.to_sha).toBe(git(workspace.path, 'rev-parse', 'HEAD'));
  await ready();
  expect(reviewer.starts[0]!.spec.role).toBe('reviewer');
  expect(reviewer.starts[0]!.spec.extensions).toEqual({ mode: 'none' });
  expect(reviewer.starts[0]!.turn!.input).toContain('Return the correct answer');
  expect(reviewer.starts[0]!.turn!.input).toContain('test -f answer.txt');
  reviewer.emit({
    kind: 'tool.started',
    name: 'review.finding',
    tool_call_id: 'finding',
    input: {
      blocking: false,
      location: 'answer.txt:1',
      quote: 'reviewed answer',
      evidence: 'The committed answer has no value',
      impact: 'Readers cannot use it',
    },
  });
  reviewer.emit({ kind: 'turn.completed', status: 'completed' });
  await eventually(
    () => f.store.must<Review>('reviews', review.id).state === 'completed',
    () => f.control.tick(),
  );
  expect(f.control.sessionReviews(user, worker.id)[0]!.findings[0]!.status).toBe('open');
  const notices = f.store
    .kindEvents(f.project.id, ['lead.note_added'])
    .filter((event) => (event.payload as { kind: string }).kind === 'review_completed');
  expect(notices).toHaveLength(1);
  expect(notices[0]!.payload).toMatchObject({
    task_id: 'answer',
    generation: 1,
    text: expect.stringContaining(review.id),
  });
  expect(f.turns(lead.id).some((turn) => turn.input.includes('Quote: reviewed answer'))).toBe(true);
  expect(f.store.must<Session>('sessions', worker.id).outcome).toBeUndefined();
  await f.control.tick();
  expect(
    f.store
      .kindEvents(f.project.id, ['lead.note_added'])
      .filter((event) => (event.payload as { kind: string }).kind === 'review_completed'),
  ).toHaveLength(1);
});

it.each([
  [
    "shows a reviewer's pass verdict and its summary in the lead's note",
    { verdict: 'pass', summary: 'Checked answer.txt against the goal' },
    'Reviewer cross-reviewer: completed. Verdict pass: Checked answer.txt against the goal',
  ],
  [
    "says in the lead's note that a reviewer that replied with neither findings nor a verdict gave no verdict",
    undefined,
    'Reviewer cross-reviewer: completed. No verdict given.',
  ],
] as const)('%s', async (_, given, line) => {
  const { f, reviewer, request, ready } = await reviewFixture();
  const review = await request();
  await ready();
  reviewer.emit({ kind: 'message.delta', text: 'Checked answer.txt against the goal.' });
  if (given)
    f.call('review.verdict', given, null, {
      id: `session:${review.session_ids[0]}`,
      role: 'reviewer',
      session_id: review.session_ids[0],
      project_id: f.project.id,
      expires_at: f.store.now() + 60000,
    });
  reviewer.emit({ kind: 'turn.completed', status: 'completed' });
  await eventually(
    () => f.store.must<Review>('reviews', review.id).state === 'completed',
    () => f.control.tick(),
  );
  expect(f.store.must<Review>('reviews', review.id)).not.toHaveProperty('incomplete');
  const note = f.store
    .kindEvents(f.project.id, ['lead.note_added'])
    .map((event) => event.payload as { kind: string; text: string })
    .find((note) => note.kind === 'review_completed');
  expect(note?.text.split('\n')).toContain(line);
});

it('refuses workers, another lead, old task generations, writer runtimes and duplicate running reviews', async () => {
  const { f, lead, worker, reviewer, principal, request } = await reviewFixture();
  const input = { session_id: worker.id, runtimes: [reviewer.name] };
  const workerPrincipal = {
    ...principal,
    id: `session:${worker.id}`,
    role: 'worker' as const,
    session_id: worker.id,
  };
  expect(() => f.call('review.request', input, null, workerPrincipal)).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
  const other = await f.create('Another lead');
  expect(() =>
    f.call('review.request', input, null, {
      ...principal,
      id: `session:${other.id}`,
      session_id: other.id,
    }),
  ).toThrow(expect.objectContaining({ code: 'permission_denied' }));
  expect(() =>
    f.call('review.request', { ...input, runtimes: [f.adapter.name] }, null, principal),
  ).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  await request();
  await expect(request()).rejects.toThrow(expect.objectContaining({ code: 'resource_busy' }));
  const current = f.store.must<BoardPlan>('board_plans', lead.id);
  f.store.update(
    'board_plans',
    { ...current, generations: { answer: { generation: 2, contract: 'new-contract' } } },
    current.revision,
  );
  expect(request).toThrow(expect.objectContaining({ code: 'permission_denied' }));
});

it("accepts a lead's review on the writer's runtime when no other runtime can review", async () => {
  const { f, worker, reviewer, principal } = await reviewFixture();
  f.control.adapters.delete(reviewer.name);
  const review = await f.call<Review>(
    'review.request',
    { session_id: worker.id, runtimes: [f.adapter.name] },
    null,
    principal,
  );
  expect(review.runtimes).toEqual([f.adapter.name]);
  expect(review.session_ids).not.toContain(worker.id);
});

it("opens a reviewer on the project's default runtime with its default model and effort", async () => {
  const { f, reviewer, request } = await reviewFixture();
  const project = f.store.must<Project>('projects', f.project.id);
  f.store.update<Project>(
    'projects',
    {
      ...project,
      session_defaults: {
        runtime: reviewer.name,
        permission_mode: 'auto_edit',
        model: 'review-model',
        effort: 'high',
      },
    },
    project.revision,
  );
  const review = await request();
  const session = f.store.must<Session>('sessions', review.session_ids[0]!);
  expect(session).toMatchObject({ requested_model: 'review-model', requested_effort: 'high' });
  expect(f.turns(session.id)[0]!.model).toBe('review-model');
});

it("accepts a lead's review on the default runtime when the project uses one model", async () => {
  const { f, worker, principal } = await reviewFixture();
  const project = f.store.must<Project>('projects', f.project.id);
  f.store.update<Project>(
    'projects',
    {
      ...project,
      session_defaults: {
        runtime: f.adapter.name,
        permission_mode: 'ask',
        model: 'single-model',
        effort: 'high',
        single_model: true,
      },
    },
    project.revision,
  );
  const review = await f.call<Review>(
    'review.request',
    { session_id: worker.id, runtimes: [f.adapter.name] },
    null,
    principal,
  );
  expect(review.runtimes).toEqual([f.adapter.name]);
  expect(f.store.must<Session>('sessions', review.session_ids[0]!)).toMatchObject({
    runtime: f.adapter.name,
    requested_model: 'single-model',
    requested_effort: 'high',
  });
});

it('returns failed reviewer execution to the lead without presenting it as a clean review', async () => {
  const { f, lead, reviewer, request, ready } = await reviewFixture();
  const review = await request();
  await ready();
  reviewer.emit({ kind: 'turn.completed', status: 'failed', error: 'Reviewer unavailable' });
  await eventually(
    () => f.store.must<Review>('reviews', review.id).state === 'failed',
    () => f.control.tick(),
  );
  const note = f.store
    .kindEvents(f.project.id, ['lead.note_added'])
    .map((event) => event.payload as { kind: string; text: string })
    .find((note) => note.kind === 'review_failed');
  expect(note?.text).toContain('cross-reviewer: failed');
  expect(note?.text).toContain('not a clean review');
  expect(f.turns(lead.id).some((turn) => turn.input.includes(review.id))).toBe(true);
});

it('settles a restarted review once and keeps its result available to a closed lead', async () => {
  const { f, lead, request, ready } = await reviewFixture();
  const review = await request();
  await ready();
  f.call(
    'session.discard',
    { session_id: lead.id },
    f.store.must<Session>('sessions', lead.id).revision,
  );
  await f.restart();
  await f.restart();
  expect(f.store.must<Review>('reviews', review.id).state).toBe('failed');
  expect(
    f.store
      .kindEvents(f.project.id, ['lead.note_added'])
      .filter((event) => (event.payload as { kind: string }).kind === 'review_failed'),
  ).toHaveLength(1);
  expect(
    f.store
      .must<BoardPlan>('board_plans', lead.id)
      .inbox.some((note) => note.kind === 'review_failed' && note.text.includes(review.id)),
  ).toBe(true);
  expect(f.control.sessionReviews(user, review.session_id!)[0]!.id).toBe(review.id);
});

it('projects partial reviewer failure and its evidence to session and board reads without losing successful findings', async () => {
  const { f, lead, worker, reviewer, principal } = await reviewFixture();
  const other = new HeldReviewer('unavailable-reviewer');
  f.control.adapters.set(other.name, other);
  const review = await f.call<Review>(
    'review.request',
    { session_id: worker.id, runtimes: [reviewer.name, other.name] },
    null,
    principal,
  );
  await eventually(
    () => !!reviewer.starts[0]?.turn && !!other.starts[0]?.turn,
    () => f.control.tick(),
  );
  reviewer.emit({
    kind: 'tool.started',
    name: 'review.finding',
    tool_call_id: 'partial-finding',
    input: {
      blocking: false,
      location: 'answer.txt:1',
      quote: 'reviewed answer',
      evidence: 'Missing a concrete value',
      impact: 'Cannot use the answer',
    },
  });
  reviewer.emit({ kind: 'turn.completed', status: 'completed' });
  other.emit({ kind: 'turn.completed', status: 'failed', error: 'Reviewer unavailable' });
  await eventually(
    () => f.store.must<Review>('reviews', review.id).state === 'completed',
    () => f.control.tick(),
  );
  const projected = f.control.sessionReviews(user, worker.id)[0]!;
  expect(projected.executions).toEqual([
    { runtime: reviewer.name, session_id: review.session_ids[0], state: 'completed' },
    {
      runtime: other.name,
      session_id: review.session_ids[1],
      state: 'failed',
      error: 'Reviewer unavailable',
    },
  ]);
  expect(projected.findings).toHaveLength(1);
  expect(f.store.must<Review>('reviews', review.id).executions).toBeUndefined();
  const task = f.control
    .boardView(user, f.project.id, 7)
    .tasks.find((task) => task.id === `${lead.id}:answer`)!;
  expect(task.evidence).toMatchObject({
    session_id: worker.id,
    review: { id: review.id, executions: projected.executions },
  });
  // The board opens another session for the task once its session ended.
  const ended = f.store.must<Session>('sessions', worker.id);
  f.store.update<Session>(
    'sessions',
    { ...ended, state: 'closed', outcome: 'discarded' },
    ended.revision,
  );
  const retry = await f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Retry the answer',
    task_id: `${lead.id}:answer`,
  });
  const latest = f.control
    .boardView(user, f.project.id, 7)
    .tasks.find((task) => task.id === `${lead.id}:answer`)!;
  expect(latest.evidence?.session_id).toBe(retry.id);
  expect(latest.evidence?.review).toBeUndefined();
});

it('projects missing reviewer records as unknown coverage rather than successful execution', async () => {
  const { f, worker } = await reviewFixture();
  f.store.insert<Review>('reviews', {
    id: 'missing-review',
    revision: 1,
    project_id: f.project.id,
    session_id: worker.id,
    round: 1,
    state: 'completed',
    runtimes: ['missing-reviewer'],
    session_ids: ['missing-session'],
    findings: [],
  });
  expect(f.control.sessionReviews(user, worker.id)[0]?.executions).toEqual([
    { runtime: 'missing-reviewer', session_id: 'missing-session', state: 'unknown' },
  ]);
});
