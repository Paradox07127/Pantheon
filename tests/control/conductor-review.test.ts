import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type {
  AgentEvent,
  AgentEventSink,
  Principal,
  Review,
  Session,
  SessionHandle,
  SessionSpec,
  UserTurn,
} from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, settle } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

const BLOCKING_TAIL = 'report_ready is refused until a later review has no open blocking findings.';

/** Holds each turn it is sent until the test emits its events. */
class HeldAdapter extends FixtureAdapter {
  starts: { spec: SessionSpec; emit: AgentEventSink; handle: SessionHandle; turn?: UserTurn }[] =
    [];
  sequence = 1;
  constructor(name: string) {
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

async function conductorFixture() {
  const f = await workbenchFixture();
  const writer = new HeldAdapter('held-writer');
  f.control.adapters.set(writer.name, writer);
  const conductor = await f.call<Promise<Session>>('session.create', {
    project_id: f.project.id,
    runtime: writer.name,
    input: 'Ship the answer',
    purpose: 'conductor',
  });
  const workspace = await awaitWorkspaceReady(f.control, conductor.workspace_id!);
  await eventually(
    () => writer.starts[0]?.turn !== undefined,
    () => f.control.tick(),
  );
  writeFileSync(path.join(workspace.path, 'answer.txt'), 'reviewed answer\n');
  git(workspace.path, 'commit', '--quiet', '-am', 'Write the answer');
  const reviewer = new HeldAdapter('cross-reviewer');
  f.control.adapters.set(reviewer.name, reviewer);
  const principal: Principal = {
    id: `session:${conductor.id}`,
    role: 'conductor',
    session_id: conductor.id,
    project_id: f.project.id,
    expires_at: f.store.now() + 60000,
  };
  const request = async (input: Record<string, unknown> = {}) =>
    f.call<Promise<{ review_id: string; runtimes: string[] }>>(
      'conductor.review',
      { runtimes: [reviewer.name], ...input },
      null,
      principal,
    );
  const refusal = async (input: Record<string, unknown> = {}) => {
    try {
      await request(input);
    } catch (error) {
      return error as { code?: string; message: string };
    }
    throw new Error('conductor.review was accepted');
  };
  const ready = async () =>
    eventually(
      () => reviewer.starts[0]?.turn !== undefined,
      () => f.control.tick(),
    );
  const settled = async (reviewId: string) =>
    eventually(
      () => f.store.must<Review>('reviews', reviewId).state !== 'running',
      () => f.control.tick(),
    );
  /** The messages Pantheon sent the conductor after its first turn. */
  const messages = () =>
    f
      .turns(conductor.id)
      .filter((turn) => turn.origin === 'tracker')
      .map((turn) => turn.input);
  const planRows = () =>
    (f.store.db.prepare('SELECT COUNT(*) AS n FROM board_plans').get() as { n: number }).n;
  /** A session the user opened, with one commit in its worktree. */
  const committedSession = async () => {
    const session = await f.create('Write the docs');
    const sessionWorkspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
    await settle(f, session);
    writeFileSync(path.join(sessionWorkspace.path, 'answer.txt'), 'spawned answer\n');
    git(sessionWorkspace.path, 'commit', '--quiet', '-am', 'Write the spawned answer');
    return { session, workspace: sessionWorkspace };
  };
  return {
    f,
    writer,
    conductor,
    workspace,
    reviewer,
    request,
    refusal,
    ready,
    settled,
    messages,
    planRows,
    committedSession,
  };
}

it("reviews a conductor's committed changes while its own turn runs", async () => {
  const { f, conductor, workspace, reviewer, request, ready } = await conductorFixture();
  expect(f.store.must<Session>('sessions', conductor.id).state).toBe('running');
  const result = await request();
  expect(result).toEqual({ review_id: expect.any(String), runtimes: [reviewer.name] });
  const review = f.store.must<Review>('reviews', result.review_id);
  expect(review).toMatchObject({
    session_id: conductor.id,
    notify_session_id: conductor.id,
    range: {
      from_sha: git(workspace.path, 'rev-parse', 'HEAD~1'),
      to_sha: git(workspace.path, 'rev-parse', 'HEAD'),
    },
  });
  expect(review).not.toHaveProperty('requester');
  await ready();
  expect(reviewer.starts[0]!.spec.role).toBe('reviewer');
  expect(reviewer.starts[0]!.turn!.input).toContain('Ship the answer');
  expect(reviewer.starts[0]!.turn!.input).toContain('reviewed answer');
});

it('returns a blocking finding to the conductor once, as a message without a plan', async () => {
  const { f, conductor, reviewer, request, ready, settled, messages, planRows } =
    await conductorFixture();
  const { review_id } = await request();
  await ready();
  reviewer.emit({
    kind: 'tool.started',
    name: 'review.finding',
    tool_call_id: 'finding',
    input: {
      blocking: true,
      location: 'answer.txt:1',
      quote: 'reviewed answer',
      evidence: 'The committed answer has no value',
      impact: 'Readers cannot use it',
      reproduction: 'cat answer.txt',
    },
  });
  reviewer.emit({ kind: 'turn.completed', status: 'completed' });
  await settled(review_id);
  expect(f.store.must<Review>('reviews', review_id).state).toBe('completed');
  await f.control.tick();
  const sent = messages();
  expect(sent).toHaveLength(1);
  expect(sent[0]!.startsWith('[Pantheon]')).toBe(true);
  expect(sent[0]).toContain(review_id);
  expect(sent[0]).toContain('answer.txt:1');
  expect(sent[0]!.trimEnd().endsWith(BLOCKING_TAIL)).toBe(true);
  expect(sent[0]!.split('[Pantheon]')).toHaveLength(2);
  expect(
    f
      .turns(conductor.id)
      .filter((turn) => turn.origin === 'tracker')
      .map((turn) => turn.state),
  ).toEqual(['queued']);
  expect(planRows()).toBe(0);
});

it('leaves the blocking sentence out of a passing review', async () => {
  const { f, reviewer, request, ready, settled, messages } = await conductorFixture();
  const { review_id } = await request();
  await ready();
  const review = f.store.must<Review>('reviews', review_id);
  f.call('review.verdict', { verdict: 'pass', summary: 'Checked answer.txt' }, null, {
    id: `session:${review.session_ids[0]}`,
    role: 'reviewer',
    session_id: review.session_ids[0],
    project_id: f.project.id,
    expires_at: f.store.now() + 60000,
  });
  reviewer.emit({ kind: 'turn.completed', status: 'completed' });
  await settled(review_id);
  const sent = messages();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain('Verdict pass: Checked answer.txt');
  expect(sent[0]).not.toContain(BLOCKING_TAIL);
});

it('keeps a passing verdict complete when tool events arrive after the reply', async () => {
  const { f, reviewer, request, ready, settled, messages } = await conductorFixture();
  const { review_id } = await request();
  await ready();
  const review = f.store.must<Review>('reviews', review_id);
  reviewer.emit({ kind: 'message.delta', text: 'Pass. Checked answer.txt.' });
  f.call('review.verdict', { verdict: 'pass', summary: 'Checked answer.txt' }, null, {
    id: `session:${review.session_ids[0]}`,
    role: 'reviewer',
    session_id: review.session_ids[0],
    project_id: f.project.id,
    expires_at: f.store.now() + 60000,
  });
  for (const call of ['first', 'second']) {
    reviewer.emit({ kind: 'tool.started', name: 'exec', tool_call_id: call, input: {} });
    reviewer.emit({ kind: 'tool.completed', tool_call_id: call, ok: true });
  }
  reviewer.emit({ kind: 'turn.completed', status: 'completed' });
  await settled(review_id);
  expect(f.store.must<Review>('reviews', review_id)).not.toHaveProperty('incomplete');
  const sent = messages();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain('Verdict pass: Checked answer.txt');
  expect(sent[0]).not.toContain('Incomplete');
});

it('tells the conductor its review failed when the reviewer turn fails', async () => {
  const { f, reviewer, request, ready, settled, messages } = await conductorFixture();
  const { review_id } = await request();
  await ready();
  reviewer.emit({ kind: 'turn.completed', status: 'failed', error: 'Reviewer unavailable' });
  await settled(review_id);
  expect(f.store.must<Review>('reviews', review_id).state).toBe('failed');
  const sent = messages();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain(`${review_id}: failed`);
  expect(sent[0]).toContain('cross-reviewer: failed');
});

it('reviews a session the conductor spawned and returns the result to the conductor', async () => {
  const { f, conductor, reviewer, request, ready, settled, messages, committedSession } =
    await conductorFixture();
  const { session, workspace } = await committedSession();
  const row = f.store.must<Session>('sessions', session.id);
  f.store.update<Session>(
    'sessions',
    { ...row, spawned_by: { session_id: conductor.id } },
    row.revision,
  );
  const { review_id } = await request({ session_id: session.id });
  expect(f.store.must<Review>('reviews', review_id)).toMatchObject({
    session_id: session.id,
    notify_session_id: conductor.id,
    range: { to_sha: git(workspace.path, 'rev-parse', 'HEAD') },
  });
  await ready();
  reviewer.emit({ kind: 'turn.completed', status: 'completed' });
  await settled(review_id);
  const sent = messages();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain(session.id);
  expect(f.turns(session.id).some((turn) => turn.input.includes(review_id))).toBe(false);
});

it("refuses a session the conductor did not spawn, uncommitted changes and the writer's runtime", async () => {
  const { f, writer, conductor, refusal, committedSession } = await conductorFixture();
  const { session } = await committedSession();
  expect((await refusal({ session_id: session.id })).code).toBe('permission_denied');
  const bare = await f.create('Write nothing');
  await settle(f, bare);
  const row = f.store.must<Session>('sessions', bare.id);
  f.store.update<Session>(
    'sessions',
    { ...row, spawned_by: { session_id: conductor.id } },
    row.revision,
  );
  const empty = await refusal({ session_id: bare.id });
  expect(empty.code).toBe('invalid_state');
  expect(empty.message).toContain('commit');
  expect((await refusal({ runtimes: [writer.name] })).code).toBe('invalid_input');
  expect(f.store.list<Review>('reviews')).toHaveLength(0);
});
