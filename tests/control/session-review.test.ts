import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type {
  AgentEvent,
  AgentEventSink,
  Review,
  Session,
  SessionHandle,
  SessionSpec,
  UserTurn,
} from '@pantheon/domain';
import { REVIEWER_BASE, type ControlContext } from '../../packages/control/dist/context.js';
import { reviewerRuntime } from '../../packages/control/dist/review.js';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

class ReviewerAdapter extends FixtureAdapter {
  starts: { spec: SessionSpec; emit: AgentEventSink; handle: SessionHandle; turn?: UserTurn }[] =
    [];
  sequence = 0;
  constructor(name: string) {
    super();
    this.name = name;
  }
  override async start(spec: SessionSpec, emit: AgentEventSink) {
    const handle = {
      platform_session_id: spec.platform_session_id,
      native_session_id: `native-${spec.platform_session_id}`,
      adapter_version: '1',
      device_id: 'local',
    };
    this.starts.push({ spec, emit, handle });
    return handle;
  }
  override async send(handle: SessionHandle, turn: UserTurn) {
    this.starts.find((s) => s.handle === handle)!.turn = turn;
    return { turn_id: turn.turn_id, status: 'delivered' as const };
  }
  emit(event: Omit<AgentEvent, 'key' | 'provider_sequence' | 'turn_id'>) {
    const session = this.starts.at(-1)!;
    session.emit({
      key: String(++this.sequence),
      provider_sequence: this.sequence,
      turn_id: session.turn!.turn_id,
      ...event,
    } as AgentEvent);
  }
}

it('reviews a workbench session from its diff and lists the findings for that session', async () => {
  const w = await workbenchFixture();
  const reviewer = new ReviewerAdapter('session-reviewer');
  w.control.adapters.set(reviewer.name, reviewer);
  const session = await w.create();
  const workspace = await awaitWorkspaceReady(w.control, session.workspace_id!);
  await eventually(
    () =>
      w.turns(session.id)[0]!.state === 'completed' &&
      w.store.must<Session>('sessions', session.id).state === 'open',
    () => w.control.tick(),
  );
  writeFileSync(path.join(workspace.path, 'answer.txt'), 'reviewed answer\n');
  git(workspace.path, 'commit', '--quiet', '-am', 'Update the answer');

  const review = await w.call<Review & { review_id: string }>('review.request', {
    session_id: session.id,
    runtimes: [reviewer.name],
  });
  expect(review).toMatchObject({
    session_id: session.id,
    state: 'running',
    runtimes: [reviewer.name],
  });
  expect(review.input_hash).toMatch(/^[a-f0-9]{64}$/);

  await eventually(
    () => reviewer.starts[0]?.turn !== undefined,
    () => w.control.tick(),
  );
  const { spec, turn } = reviewer.starts[0]!;
  expect(spec.role).toBe('reviewer');
  expect(turn!.input).toContain(session.title);
  expect(turn!.input).toContain('Rename the answer file and explain why');
  expect(turn!.input).toContain('+reviewed answer');

  reviewer.emit({
    kind: 'tool.started',
    name: 'review.finding',
    tool_call_id: 'finding-1',
    input: {
      blocking: false,
      location: 'answer.txt:1',
      quote: 'reviewed answer',
      evidence: 'The file no longer says base',
      impact: 'Readers lose the base answer',
    },
  } as AgentEvent);
  reviewer.emit({ kind: 'turn.completed', status: 'completed' } as AgentEvent);
  await eventually(
    () => w.store.must<Review>('reviews', review.id).state === 'completed',
    () => w.control.tick(),
  );

  const listed = w.control.sessionReviews(user, session.id);
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({ id: review.id, session_id: session.id, state: 'completed' });
  expect(listed[0]!.findings).toEqual([
    expect.objectContaining({
      runtime: reviewer.name,
      location: 'answer.txt:1',
      quote: 'reviewed answer',
      status: 'open',
    }),
  ]);
});

it('gives the reviewer its guide as instructions and only the job and the artifact as its first message', async () => {
  const w = await workbenchFixture();
  const reviewer = new ReviewerAdapter('session-reviewer');
  w.control.adapters.set(reviewer.name, reviewer);
  const session = await w.create();
  const workspace = await awaitWorkspaceReady(w.control, session.workspace_id!);
  await eventually(
    () =>
      w.turns(session.id)[0]!.state === 'completed' &&
      w.store.must<Session>('sessions', session.id).state === 'open',
    () => w.control.tick(),
  );
  writeFileSync(path.join(workspace.path, 'answer.txt'), 'reviewed answer\n');
  git(workspace.path, 'commit', '--quiet', '-am', 'Update the answer');
  await w.call('review.request', { session_id: session.id, runtimes: [reviewer.name] });
  await eventually(
    () => reviewer.starts[0]?.turn !== undefined,
    () => w.control.tick(),
  );
  const { spec, turn } = reviewer.starts[0]!;
  expect(spec.control_instructions).toContain('You are a reviewer in a read-only session.');
  expect(spec.control_instructions).toContain(REVIEWER_BASE);
  expect(turn!.input).toMatch(
    /^Review these changes against the task goal\. Record each problem with review_finding; quote the diff exactly; record one only for a problem in the change\. The project's gate runs the commands the goal lists under "Done when" once the change lands, so judge from the code and tests whether the change meets each item; do not fail or block for lack of run results\. End the review with one review_verdict call, pass or fail, with a summary of what you checked\.\n\nTask goal:\n/,
  );
});

/** A workbench session with a committed change and a running review by two reviewer runtimes. */
async function runningSessionReview() {
  const w = await workbenchFixture();
  const reviewers = [new ReviewerAdapter('reviewer-one'), new ReviewerAdapter('reviewer-two')];
  for (const adapter of reviewers) w.control.adapters.set(adapter.name, adapter);
  const session = await w.create();
  const workspace = await awaitWorkspaceReady(w.control, session.workspace_id!);
  await eventually(
    () =>
      w.turns(session.id)[0]!.state === 'completed' &&
      w.store.must<Session>('sessions', session.id).state === 'open',
    () => w.control.tick(),
  );
  writeFileSync(path.join(workspace.path, 'answer.txt'), 'reviewed answer\n');
  git(workspace.path, 'commit', '--quiet', '-am', 'Update the answer');
  const review = await w.call<Review>('review.request', {
    session_id: session.id,
    runtimes: reviewers.map((adapter) => adapter.name),
  });
  await eventually(
    () => reviewers.every((adapter) => adapter.starts[0]?.turn !== undefined),
    () => w.control.tick(),
  );
  const row = () => w.store.must<Review>('reviews', review.id);
  const directories = reviewers.map((adapter) => adapter.starts[0]!.spec.cwd);
  const reviewerSessions = () =>
    w.store.list<Session>('sessions').filter((s) => s.review_id === review.id);
  return { w, reviewers, review, row, directories, reviewerSessions };
}

it.each(['completed', 'failed'] as const)(
  'removes the directories of a %s session review on the next tick and retains its findings',
  async (status) => {
    const { w, reviewers, review, row, directories, reviewerSessions } =
      await runningSessionReview();
    expect(directories.every((directory) => existsSync(path.join(directory, 'changes.diff')))).toBe(
      true,
    );
    reviewers[0]!.emit({
      kind: 'tool.started',
      name: 'review.finding',
      tool_call_id: 'finding-1',
      input: {
        blocking: false,
        location: 'answer.txt:1',
        quote: 'reviewed answer',
        evidence: 'The file no longer says base',
        impact: 'Readers lose the base answer',
      },
    } as AgentEvent);
    for (const adapter of reviewers) adapter.emit({ kind: 'turn.completed', status } as AgentEvent);
    await eventually(() => row().state === status);
    const settled = row();
    const sessions = reviewerSessions();
    expect(settled.findings).toMatchObject([{ status: 'open', quote: 'reviewed answer' }]);
    expect(directories.every((directory) => existsSync(directory))).toBe(true);
    await w.control.tick();
    expect(directories.some((directory) => existsSync(directory))).toBe(false);
    const parent = path.dirname(directories[0]!);
    expect(path.basename(parent)).toBe(review.id);
    expect(existsSync(parent)).toBe(false);
    expect(row()).toEqual(settled);
    expect(reviewerSessions()).toEqual(sessions);
    expect(w.store.events().filter((event) => event.kind === 'review.directories_removed')).toEqual(
      [
        expect.objectContaining({
          aggregate_id: review.id,
          project_id: w.project.id,
          payload: { paths: [...directories, parent] },
        }),
      ],
    );
    expect(w.store.db.prepare("SELECT state FROM outbox WHERE kind='review.remove'").all()).toEqual(
      [{ state: 'done' }],
    );
  },
);

it('keeps the review folders another project left on disk out of a reviewer session', async () => {
  const w = await workbenchFixture();
  const reviewer = new ReviewerAdapter('session-reviewer');
  w.control.adapters.set(reviewer.name, reviewer);
  const elsewhere = path.join(w.root, 'managed', 'removed-project', 'reviews', 'old-review');
  mkdirSync(elsewhere, { recursive: true });
  const session = await w.create();
  const workspace = await awaitWorkspaceReady(w.control, session.workspace_id!);
  await eventually(
    () =>
      w.turns(session.id)[0]!.state === 'completed' &&
      w.store.must<Session>('sessions', session.id).state === 'open',
    () => w.control.tick(),
  );
  writeFileSync(path.join(workspace.path, 'answer.txt'), 'reviewed answer\n');
  git(workspace.path, 'commit', '--quiet', '-am', 'Update the answer');

  await w.call('review.request', { session_id: session.id, runtimes: [reviewer.name] });
  await eventually(
    () => reviewer.starts[0] !== undefined,
    () => w.control.tick(),
  );
  expect(reviewer.starts[0]!.spec.sandbox?.protected_entries).toContainEqual({
    path: realpathSync(elsewhere),
    deny: 'read_write',
  });
});

it('keeps the review folders of other projects out of a planner session', async () => {
  const w = await workbenchFixture();
  const elsewhere = path.join(w.root, 'managed', 'removed-project', 'reviews');
  mkdirSync(elsewhere, { recursive: true });
  // A baseline, the planner session here, skips a project with fewer than three files.
  for (const file of ['README.md', 'index.ts'])
    writeFileSync(path.join(w.source, file), `${file}\n`);
  git(w.source, 'add', '.');
  git(w.source, 'commit', '--quiet', '-m', 'Add the project files');

  await w.call('project.baseline.start', { project_id: w.project.id });
  await eventually(
    () => w.start.mock.calls.some(([spec]) => spec.role === 'planner'),
    () => w.control.tick(),
  );
  const [spec] = w.start.mock.calls.find(([candidate]) => candidate.role === 'planner')!;
  expect(spec.sandbox?.protected_entries).toContainEqual({
    path: realpathSync(elsewhere),
    deny: 'read_write',
  });
});

it('waits for every reviewer after one fails and completes with the findings of the others', async () => {
  const { w, reviewers, row, directories, reviewerSessions } = await runningSessionReview();
  const turnOf = (adapter: ReviewerAdapter) =>
    w.turns(reviewerSessions().find((s) => s.runtime === adapter.name)!.id)[0]!;
  const removals = () =>
    w.store.db.prepare("SELECT state FROM outbox WHERE kind='review.remove'").all();
  reviewers[0]!.emit({ kind: 'turn.completed', status: 'failed' } as AgentEvent);
  await eventually(() => turnOf(reviewers[0]!).state === 'failed');
  await w.control.tick();
  expect(row().state).toBe('running');
  expect(removals()).toEqual([]);
  expect(directories.every((directory) => existsSync(directory))).toBe(true);

  reviewers[1]!.emit({
    kind: 'tool.started',
    name: 'review.finding',
    tool_call_id: 'finding-1',
    input: {
      blocking: false,
      location: 'answer.txt:1',
      quote: 'reviewed answer',
      evidence: 'The file no longer says base',
      impact: 'Readers lose the base answer',
    },
  } as AgentEvent);
  reviewers[1]!.emit({ kind: 'turn.completed', status: 'completed' } as AgentEvent);
  await eventually(() => row().state === 'completed');
  expect(row().findings).toMatchObject([
    { runtime: reviewers[1]!.name, status: 'open', quote: 'reviewed answer' },
  ]);
  expect(removals()).toEqual([{ state: 'pending' }]);
  await w.control.tick();
  expect(directories.some((directory) => existsSync(directory))).toBe(false);
});

it('leaves the directories behind a reviews symlink alone when removing orphans at startup', async () => {
  const w = await workbenchFixture();
  const project = path.join(w.root, 'managed', w.project.id),
    kept = path.join(project, 'elsewhere', 'kept');
  mkdirSync(kept, { recursive: true });
  symlinkSync(path.join(project, 'elsewhere'), path.join(project, 'reviews'));
  await w.control.recover();
  expect(existsSync(kept)).toBe(true);
  expect(w.store.events().some((event) => event.kind === 'review.orphans_removed')).toBe(false);
});

it('keeps the directories of a running session review and finishes a premature removal job', async () => {
  const { w, review, row, directories } = await runningSessionReview();
  const jobId = w.store.enqueue('review.remove', { review_id: review.id });
  await w.control.tick();
  expect(row().state).toBe('running');
  expect(directories.every((directory) => existsSync(directory))).toBe(true);
  expect(w.store.db.prepare('SELECT state FROM outbox WHERE id=?').get(jobId)).toEqual({
    state: 'done',
  });
  expect(w.store.events().some((event) => event.kind === 'review.directories_removed')).toBe(false);
});

it('picks an installed reviewer runtime over one whose version could not be read', async () => {
  const w = await workbenchFixture();
  const missing = new FixtureAdapter(0);
  missing.name = 'missing-reviewer';
  missing.report = { ...missing.report, version: 'unprobed' };
  const installed = new FixtureAdapter(0);
  installed.name = 'installed-reviewer';
  w.control.adapters.set(missing.name, missing);
  w.control.adapters.set(installed.name, installed);
  const ctx = (w.control as unknown as { ctx: ControlContext }).ctx;
  expect(reviewerRuntime(ctx, w.project.id, w.adapter.name)).toBe(installed.name);
});
